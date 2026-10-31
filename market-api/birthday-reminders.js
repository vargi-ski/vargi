import { mkdir, open, readFile, readdir, rename, stat, unlink } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';

export const BIRTHDAY_TIME_ZONE = 'Europe/Moscow';
export const BIRTHDAY_REMINDER_HOUR = 9;
const RECORD_NAME = /^[a-f0-9]{64}\.json$/;
const localFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: BIRTHDAY_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', hourCycle: 'h23'
});

function dateParts(instant) {
  const date = new Date(instant);
  if (!Number.isFinite(date.getTime())) throw new Error('invalid_birthday_clock');
  return Object.fromEntries(localFormatter.formatToParts(date)
    .filter(part => ['year', 'month', 'day', 'hour'].includes(part.type))
    .map(part => [part.type, Number(part.value)]));
}

function localDateKey({ year, month, day }) {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function validDayMonth(day, month) {
  if (!Number.isInteger(day) || !Number.isInteger(month) || month < 1 || month > 12 || day < 1) return false;
  // A leap year admits February 29, which is observed only in leap years.
  const date = new Date(Date.UTC(2000, month - 1, day));
  return date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

export function validateBirthdays(records) {
  if (!Array.isArray(records) || !records.length) throw new Error('invalid_birthday_list');
  const seen = new Set();
  return records.map(record => {
    if (!record || typeof record.name !== 'string' || !record.name.trim()
      || !validDayMonth(record.day, record.month)
      || (record.status !== undefined && record.status !== 'Подтверждено')
      || typeof record.source !== 'string' || !/^https:\/\//.test(record.source)) {
      throw new Error('unverified_or_invalid_birthday');
    }
    const name = record.name.normalize('NFC').trim().replace(/\s+/g, ' ');
    if (seen.has(name.toLocaleLowerCase('ru-RU'))) throw new Error('duplicate_birthday_person');
    seen.add(name.toLocaleLowerCase('ru-RU'));
    return Object.freeze({ name, day: record.day, month: record.month, source: record.source });
  });
}

// A reminder belongs to the local date on which it is sent. We do not replay
// earlier calendar days after an outage. February 29 is not shifted to another day.
export function dueBirthdayReminders(records, instant = new Date()) {
  const birthdays = validateBirthdays(records);
  const today = dateParts(instant);
  if (today.hour < BIRTHDAY_REMINDER_HOUR) return [];
  const next = new Date(Date.UTC(today.year, today.month - 1, today.day + 1));
  const tomorrow = { year: next.getUTCFullYear(), month: next.getUTCMonth() + 1, day: next.getUTCDate() };
  const scheduledDate = localDateKey(today);
  const reminders = [];
  for (const [daysBefore, date] of [[0, today], [1, tomorrow]]) {
    for (const person of birthdays) {
      if (person.day !== date.day || person.month !== date.month) continue;
      const birthdayDate = localDateKey(date);
      const key = createHash('sha256')
        .update(`birthday:v1:${scheduledDate}:${daysBefore}:${person.name}:${person.month}:${person.day}`)
        .digest('hex');
      const dateLabel = `${String(person.day).padStart(2, '0')}.${String(person.month).padStart(2, '0')}`;
      const text = daysBefore === 0
        ? `🎂 День рождения в стае ВАРГИ\n\nСегодня, ${dateLabel}: ${person.name}.\nПора поздравить!`
        : `🐺 Напоминание ВАРГИ\n\nЗавтра, ${dateLabel}: день рождения — ${person.name}.`;
      reminders.push({ key, name: person.name, day: person.day, month: person.month,
        scheduledDate, birthdayDate, daysBefore, text });
    }
  }
  return reminders;
}

async function durableJson(file, value) {
  const temporary = file + '.tmp-' + randomUUID();
  let handle;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(JSON.stringify(value), 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(temporary, file);
    const directory = await open(path.dirname(file), 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  } finally {
    await handle?.close();
    await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}

async function readRecord(file, key) {
  const record = JSON.parse(await readFile(file, 'utf8'));
  if (record.version !== 1 || record.key !== key
    || !['pending', 'sent', 'expired'].includes(record.status)
    || !/^\d{4}-\d{2}-\d{2}$/.test(record.scheduledDate)
    || !Number.isInteger(record.attempts) || record.attempts < 0) {
    throw new Error('invalid_birthday_record');
  }
  return record;
}

/**
 * Persistent daily reminder outbox for the existing single-replica API service.
 * send(reminder) must return Telegram's successful result with message_id, and
 * must have a bounded network timeout (the existing telegramApi uses 7 seconds).
 *
 * Sent receipts suppress retries after normal restarts. The lock prevents two
 * workers from claiming the same outbox during ordinary overlapping ticks.
 * Telegram has no idempotency key: if it accepts a message but its response is
 * lost, or a process dies before the receipt is synced, a retry may duplicate it.
 */
export async function createBirthdayReminders({
  directory, birthdays, send, log = () => {}, now = () => new Date(),
  pollMs = 60000, retryBaseMs = 60000, lockStaleMs = 5 * 60000
}) {
  const records = validateBirthdays(birthdays);
  if (typeof send !== 'function') throw new Error('birthday_send_required');
  if (pollMs < 1 || retryBaseMs < 1 || lockStaleMs < 1000) throw new Error('invalid_birthday_intervals');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const lockFile = path.join(directory, 'worker.lock');
  let started = false;
  let closed = false;
  let timer;
  let running = null;

  async function acquireLock() {
    const owner = randomUUID();
    let handle;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        handle = await open(lockFile, 'wx', 0o600);
        await handle.writeFile(JSON.stringify({ owner }), 'utf8');
        await handle.sync();
        break;
      } catch (error) {
        if (handle) { await handle.close(); throw error; }
        if (error.code !== 'EEXIST') throw error;
        try {
          const info = await stat(lockFile);
          if (Date.now() - info.mtimeMs <= lockStaleMs) return null;
          await unlink(lockFile);
          log('birthday_lock_recovered');
        } catch (readError) { if (readError.code !== 'ENOENT') throw readError; }
      }
    }
    if (!handle) return null;
    let compromised = false;
    const heartbeat = setInterval(() => {
      const time = new Date();
      handle.utimes(time, time).catch(() => { compromised = true; });
    }, Math.max(250, Math.floor(lockStaleMs / 3)));
    heartbeat.unref?.();
    return {
      async valid() {
        if (compromised) return false;
        try { return JSON.parse(await readFile(lockFile, 'utf8')).owner === owner; }
        catch { return false; }
      },
      async release() {
        clearInterval(heartbeat);
        try {
          if (JSON.parse(await readFile(lockFile, 'utf8')).owner === owner) await unlink(lockFile);
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
        finally { await handle.close(); }
      }
    };
  }

  async function runTick() {
    const instant = new Date(now());
    const currentDate = localDateKey(dateParts(instant));
    const due = dueBirthdayReminders(records, instant);
    const result = { date: currentDate, due: due.length, queued: 0, sent: 0, retrying: 0, locked: false };
    const lock = await acquireLock();
    if (!lock) return { ...result, locked: true };
    try {
      for (const filename of await readdir(directory)) {
        if (!RECORD_NAME.test(filename)) continue;
        const file = path.join(directory, filename);
        let item;
        try { item = await readRecord(file, filename.slice(0, -5)); }
        catch { log('birthday_outbox_read_error'); continue; }
        if (item.status === 'pending' && item.scheduledDate < currentDate) {
          item.status = 'expired';
          item.expiredAt = instant.toISOString();
          item.nextAttemptAt = null;
          await durableJson(file, item);
          log('birthday_outbox_expired', item.key);
        }
      }
      for (const reminder of due) {
        if (closed || !(await lock.valid())) break;
        const file = path.join(directory, reminder.key + '.json');
        let item;
        try { item = await readRecord(file, reminder.key); }
        catch (error) {
          if (error.code !== 'ENOENT') { log('birthday_outbox_read_error', reminder.key); continue; }
          item = { version: 1, ...reminder, status: 'pending', createdAt: instant.toISOString(),
            attempts: 0, nextAttemptAt: 0, sentAt: null, telegramMessageId: null };
          await durableJson(file, item);
          result.queued++;
          log('birthday_outbox_queued', item.key);
        }
        if (item.status !== 'pending' || item.nextAttemptAt > instant.getTime()) continue;
        // Persist a delayed retry before sending, including a crash during send.
        item.attempts++;
        item.nextAttemptAt = instant.getTime() + Math.min(60 * 60000,
          retryBaseMs * (2 ** Math.min(item.attempts - 1, 10)));
        await durableJson(file, item);
        if (!(await lock.valid())) break;
        if (localDateKey(dateParts(now())) !== currentDate) {
          // A slow batch must not finish yesterday's reminders after midnight.
          item.status = 'expired';
          item.expiredAt = new Date(now()).toISOString();
          item.nextAttemptAt = null;
          await durableJson(file, item);
          break;
        }
        let receipt;
        try {
          receipt = await send({ ...reminder, attempt: item.attempts });
          if (!Number.isSafeInteger(receipt?.message_id) || receipt.message_id <= 0) {
            throw new Error('birthday_delivery_unconfirmed');
          }
        } catch {
          result.retrying++;
          // Raw provider errors may contain a URL including the bot token.
          log('birthday_telegram_retry', item.key);
          continue;
        }
        item.status = 'sent';
        item.sentAt = new Date(now()).toISOString();
        item.telegramMessageId = receipt.message_id;
        item.nextAttemptAt = null;
        await durableJson(file, item);
        result.sent++;
        log('birthday_telegram_sent', item.key, { messageId: receipt.message_id });
      }
      return result;
    } finally { await lock.release(); }
  }

  function tick() {
    if (closed) return Promise.reject(new Error('birthday_reminders_closed'));
    if (running) return running;
    running = runTick().finally(() => { running = null; });
    return running;
  }

  function schedule(delay = 0) {
    if (!started || closed) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      tick().catch(() => log('birthday_outbox_scan_error')).finally(() => schedule(pollMs));
    }, delay);
    timer.unref?.();
  }

  return {
    tick,
    async status() {
      const currentDate = localDateKey(dateParts(now()));
      const summary = { timeZone: BIRTHDAY_TIME_ZONE, hour: BIRTHDAY_REMINDER_HOUR,
        verifiedBirthdays: records.length, currentDate, pending: 0, sent: 0,
        expired: 0, unreadable: 0, lastSentAt: null, today: [] };
      for (const filename of await readdir(directory)) {
        if (!RECORD_NAME.test(filename)) continue;
        let item;
        try { item = await readRecord(path.join(directory, filename), filename.slice(0, -5)); }
        catch { summary.unreadable++; continue; }
        summary[item.status]++;
        if (item.sentAt && (!summary.lastSentAt || item.sentAt > summary.lastSentAt)) summary.lastSentAt = item.sentAt;
        if (item.scheduledDate === currentDate) summary.today.push({
          key: item.key, name: item.name, birthdayDate: item.birthdayDate,
          daysBefore: item.daysBefore, status: item.status, attempts: item.attempts,
          telegramMessageId: item.telegramMessageId
        });
      }
      return summary;
    },
    start() { if (!closed && !started) { started = true; schedule(); } },
    async close() { closed = true; clearTimeout(timer); await running; }
  };
}
