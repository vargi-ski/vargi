import { mkdir, open, readFile, readdir, rename, unlink } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';

export const CAMP_FORM_ID = '6aacf2a849af472ed76c9d3d';
export const CAMP_ID = 'first-snow-2026';
export const CAMP_ANSWERS_URL = `https://forms.yandex.ru/admin/${CAMP_FORM_ID}/answers`;
export const CAMP_ALERT_TEXT = 'Новая заявка на кемп ВАРГИ — ВКАТКА 2026';

export function validateCampPayload(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
  const keys = Object.keys(body);
  if (keys.length !== 3 || keys.some(key => !['form_id', 'response_id', 'camp'].includes(key))) return false;
  return body.form_id === CAMP_FORM_ID
    && typeof body.response_id === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(body.response_id)
    && typeof body.camp === 'string' && /^[a-zA-Z0-9_-]{0,64}$/.test(body.camp);
}

// fsync the file and directory before acknowledging the webhook. The volume is
// persistent; an accepted job must survive a process restart before it is sent.
async function durableJson(file, value) {
  const tmp = file + '.tmp-' + randomUUID();
  let handle;
  try {
    handle = await open(tmp, 'wx', 0o600);
    await handle.writeFile(JSON.stringify(value), 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(tmp, file);
    const directory = await open(path.dirname(file), 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  } finally {
    await handle?.close();
    await unlink(tmp).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}

export async function createCampOutbox({ directory, send, log = () => {}, pollMs = 15000, retryBaseMs = 30000 }) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const locks = new Map();
  let started = false;
  let closed = false;
  let timer;
  let running = null;

  function schedule(delay = 0) {
    if (!started || closed || running) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      running = drain().catch(() => log('camp_outbox_scan_error')).finally(() => {
        running = null;
        schedule(pollMs);
      });
    }, delay);
    timer.unref?.();
  }

  async function drain() {
    for (const filename of await readdir(directory)) {
      if (closed) break;
      if (!/^[a-f0-9]{64}\.json$/.test(filename)) continue;
      const file = path.join(directory, filename);
      let item;
      try { item = JSON.parse(await readFile(file, 'utf8')); }
      catch { log('camp_outbox_read_error'); continue; }
      if (item.status !== 'pending' || item.nextAttemptAt > Date.now()) continue;
      // Keep a retry scheduled on disk even if the process exits during send.
      item.attempts += 1;
      const retryMs = Math.min(60 * 60 * 1000, retryBaseMs * (2 ** Math.min(item.attempts - 1, 10)));
      item.nextAttemptAt = Date.now() + retryMs;
      await durableJson(file, item);
      try {
        await send();
        item.status = 'sent';
        item.sentAt = new Date().toISOString();
        item.nextAttemptAt = null;
        await durableJson(file, item);
        log('camp_telegram_sent', item.key);
      } catch {
        // Do not log provider errors: they may contain a URL with a bot token.
        log('camp_telegram_retry', item.key);
      }
    }
  }

  return {
    async enqueue(responseId) {
      if (closed) throw new Error('camp_outbox_closed');
      if (typeof responseId !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(responseId)) throw new Error('invalid_response_id');
      const key = createHash('sha256').update(CAMP_FORM_ID + ':' + responseId).digest('hex');
      while (locks.has(key)) await locks.get(key);
      let release;
      locks.set(key, new Promise(resolve => { release = resolve; }));
      try {
        const file = path.join(directory, key + '.json');
        try {
          const previous = JSON.parse(await readFile(file, 'utf8'));
          if (previous.key !== key || previous.responseId !== responseId || !['pending', 'sent'].includes(previous.status)) throw new Error('invalid_outbox_record');
          return { key, duplicate: true };
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
        const item = { version: 1, key, formId: CAMP_FORM_ID, responseId, status: 'pending', createdAt: new Date().toISOString(), attempts: 0, nextAttemptAt: 0, sentAt: null };
        await durableJson(file, item);
        log('camp_outbox_queued', key);
        schedule();
        return { key, duplicate: false };
      } finally { locks.delete(key); release(); }
    },
    start() { if (!closed) { started = true; schedule(); } },
    async close() { closed = true; clearTimeout(timer); await running; },
  };
}
