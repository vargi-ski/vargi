import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBirthdayReminders, dueBirthdayReminders, validateBirthdays } from '../birthday-reminders.js';

const verified = JSON.parse(await readFile(new URL('../birthdays.json', import.meta.url), 'utf8'));
const person = (name, day, month) => ({ name, day, month, source: 'https://example.org/verified' });
const oneBirthday = [person('Проверенный участник', 5, 11)];

async function fixture(t, birthdays = oneBirthday, initial = '2026-11-05T06:00:00.000Z') {
  const directory = await mkdtemp(join(tmpdir(), 'vargi-birthday-outbox-'));
  const workers = [];
  let time = new Date(initial);
  t.after(async () => {
    for (const worker of workers) await worker.close();
    await rm(directory, { recursive: true, force: true });
  });
  return {
    directory,
    setTime(value) { time = new Date(value); },
    async create(send, options = {}) {
      const worker = await createBirthdayReminders({ directory, birthdays, send,
        now: () => time, pollMs: 5, retryBaseMs: 1000, ...options });
      workers.push(worker);
      return worker;
    },
    async records() {
      const files = (await readdir(directory)).filter(name => /^[a-f0-9]{64}\.json$/.test(name));
      return Promise.all(files.map(file => readFile(join(directory, file), 'utf8').then(JSON.parse)));
    }
  };
}

test('production data contains exactly 18 confirmed birthdays and no candidate dates or birth years', () => {
  const data = validateBirthdays(verified);
  assert.equal(data.length, 18);
  const absent = ['Павел Сарин', 'Кирилл Гречников', 'Валерия Максименко', 'Лариса Иванова',
    'Андрей Лисов', 'Даниил Махов', 'Виталий Ильин', 'Алексей Марков', 'Алексей Карасев'];
  for (const name of absent) assert(!data.some(row => row.name === name));
  for (const row of verified) assert.deepEqual(Object.keys(row).sort(), ['day', 'month', 'name', 'source']);
  assert.deepEqual(data.find(row => row.name === 'Артем Грязев'), {
    name: 'Артем Грязев', day: 5, month: 11, source: 'https://flgr-results.ru/athletes/111595/'
  });
  assert.throws(() => validateBirthdays([{ ...person('Не подтвержден', 12, 7), status: 'Уточнить' }]));
  assert.throws(() => validateBirthdays([{ ...person('Не найден', 1, 1), status: 'Не найдено' }]));
  for (const [day, month] of [[null, 5], [31, 4], [0, 1], [2, 13], ['5', 11]]) {
    assert.throws(() => validateBirthdays([person('Ошибка даты', day, month)]));
  }
});

test('09:00 Moscow gate, same-day catch-up and UTC midnight boundary', () => {
  assert.deepEqual(dueBirthdayReminders(verified, '2026-11-05T05:59:59.999Z'), []);
  const due = dueBirthdayReminders(verified, '2026-11-05T06:00:00.000Z');
  assert.deepEqual(due.map(row => [row.name, row.daysBefore]), [['Артем Грязев', 0], ['Людмила Шамшина', 1]]);
  assert(due.every(row => row.scheduledDate === '2026-11-05'));
  assert.deepEqual(dueBirthdayReminders(verified, '2026-11-05T20:59:59Z').map(row => row.key), due.map(row => row.key));
  assert.deepEqual(dueBirthdayReminders(verified, '2026-11-05T21:00:00Z'), []);
  const next = dueBirthdayReminders(verified, '2026-11-06T06:00:00Z');
  assert.deepEqual(next.map(row => [row.name, row.daysBefore]), [['Людмила Шамшина', 0]]);
  assert.notEqual(next[0].key, due[1].key);
});

test('two birthdays on January 31 remain distinct, with February 1 pre-reminder', () => {
  const before = dueBirthdayReminders(verified, '2027-01-30T06:00:00Z');
  assert.deepEqual(before.map(row => row.name), ['Екатерина Бурянина', 'Василий Соснин']);
  assert.equal(new Set(before.map(row => row.key)).size, 2);
  const day = dueBirthdayReminders(verified, '2027-01-31T06:00:00Z');
  assert.deepEqual(day.map(row => [row.name, row.daysBefore]), [
    ['Екатерина Бурянина', 0], ['Василий Соснин', 0], ['Алексей Мошкин', 1]
  ]);
});

test('December 31 pre-reminder uses next year; leap days are never invented or shifted', () => {
  const january = [person('Первое января', 1, 1)];
  const before = dueBirthdayReminders(january, '2026-12-31T06:00:00Z')[0];
  assert.equal(before.scheduledDate, '2026-12-31');
  assert.equal(before.birthdayDate, '2027-01-01');
  assert.equal(before.daysBefore, 1);
  const day = dueBirthdayReminders(january, '2027-01-01T06:00:00Z')[0];
  assert.notEqual(before.key, day.key);
  const leap = [person('Двадцать девятое февраля', 29, 2)];
  assert.deepEqual(dueBirthdayReminders(leap, '2027-02-28T06:00:00Z'), []);
  assert.deepEqual(dueBirthdayReminders(leap, '2027-03-01T06:00:00Z'), []);
  assert.equal(dueBirthdayReminders(leap, '2028-02-28T06:00:00Z')[0].daysBefore, 1);
  assert.equal(dueBirthdayReminders(leap, '2028-02-29T06:00:00Z')[0].daysBefore, 0);
});

test('receipt is durable, concurrent ticks coalesce and a restart does not resend', async t => {
  const f = await fixture(t);
  let sends = 0;
  const worker = await f.create(async reminder => {
    sends++;
    const [record] = await f.records();
    assert.equal(record.key, reminder.key);
    assert.equal(record.status, 'pending');
    assert.equal(record.attempts, 1);
    assert(record.nextAttemptAt > Date.parse('2026-11-05T06:00:00Z'));
    return { message_id: 12345 };
  });
  const ticks = await Promise.all([worker.tick(), worker.tick(), worker.tick()]);
  assert(ticks.every(value => value.sent === 1));
  assert.equal(sends, 1);
  const [record] = await f.records();
  assert.equal(record.status, 'sent');
  assert.equal(record.telegramMessageId, 12345);
  assert.equal(record.nextAttemptAt, null);
  await worker.close();
  const resumed = await f.create(async () => { sends++; return { message_id: 67890 }; });
  assert.equal((await resumed.tick()).sent, 0);
  assert.equal(sends, 1);
  const status = await resumed.status();
  assert.equal(status.sent, 1);
  assert.equal(status.pending, 0);
  assert.equal(status.today[0].telegramMessageId, 12345);
});

test('separate workers sharing the volume do not send concurrently', async t => {
  const f = await fixture(t);
  let sends = 0;
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  let entered;
  const sending = new Promise(resolve => { entered = resolve; });
  const first = await f.create(async () => { sends++; entered(); await blocked; return { message_id: 100 }; });
  const second = await f.create(async () => { sends++; return { message_id: 200 }; });
  const firstTick = first.tick();
  await sending;
  try {
    const other = await second.tick();
    assert.equal(other.locked, true);
    assert.equal(sends, 1);
  } finally { release(); }
  await firstTick;
  await second.tick();
  assert.equal(sends, 1);
});

test('failed sends retry after persisted backoff and restart without leaking provider errors', async t => {
  const f = await fixture(t);
  const logs = [];
  let attempts = 0;
  const first = await f.create(async () => { attempts++; throw new Error('https://api.telegram.org/botSECRET/sendMessage'); },
    { log: (...args) => logs.push(args) });
  assert.equal((await first.tick()).retrying, 1);
  assert.equal((await first.status()).pending, 1);
  await first.close();
  const resumed = await f.create(async () => { attempts++; return { message_id: 301 }; },
    { log: (...args) => logs.push(args) });
  await resumed.tick();
  assert.equal(attempts, 1);
  f.setTime('2026-11-05T06:00:01.001Z');
  assert.equal((await resumed.tick()).sent, 1);
  assert.equal(attempts, 2);
  assert.equal((await f.records())[0].attempts, 2);
  assert(!JSON.stringify(logs).includes('SECRET'));
  assert(!JSON.stringify(logs).includes('telegram.org'));
});

test('unconfirmed provider response is retried; previous-day pending work expires', async t => {
  const f = await fixture(t);
  let sends = 0;
  const worker = await f.create(async () => { sends++; return {}; });
  assert.equal((await worker.tick()).retrying, 1);
  f.setTime('2026-11-06T06:00:00Z');
  await worker.tick();
  assert.equal(sends, 1);
  const summary = await worker.status();
  assert.equal(summary.expired, 1);
  assert.equal(summary.pending, 0);
  assert.equal(summary.sent, 0);
});

test('fresh process lock delays work; stale crash lock is reclaimed', async t => {
  const f = await fixture(t);
  let sends = 0;
  const worker = await f.create(async () => { sends++; return { message_id: 402 }; }, { lockStaleMs: 1000 });
  const lock = join(f.directory, 'worker.lock');
  await writeFile(lock, JSON.stringify({ owner: 'previous-process' }));
  assert.equal((await worker.tick()).locked, true);
  const stale = new Date(Date.now() - 5000);
  await utimes(lock, stale, stale);
  assert.equal((await worker.tick()).sent, 1);
  assert.equal(sends, 1);
});

test('scheduler starts once and close waits for an in-flight delivery', async t => {
  const f = await fixture(t);
  let entered;
  const sending = new Promise(resolve => { entered = resolve; });
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  let sends = 0;
  const worker = await f.create(async () => { sends++; entered(); await blocked; return { message_id: 501 }; });
  worker.start();
  worker.start();
  // Keep the test alive while the production scheduler intentionally uses unref().
  const keepAlive = setTimeout(() => {}, 2000);
  try {
    await sending;
    let finished = false;
    const closing = worker.close().then(() => { finished = true; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(finished, false);
    release();
    await closing;
    assert.equal(sends, 1);
    assert.equal((await worker.status()).sent, 1);
    await assert.rejects(worker.tick(), /closed/);
  } finally { clearTimeout(keepAlive); release(); }
});
