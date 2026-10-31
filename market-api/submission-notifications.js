import { mkdir, open, readFile, readdir, rename, unlink } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';

const validId = id => typeof id === 'string' && /^[0-9TZ_-]{20,80}_[a-f0-9]{8}$/.test(id);

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

// Run one outbox worker per persistent volume, as in the market-api deployment.
// Delivery is at least once: if Telegram accepted a request but its reply was
// lost, a later retry can duplicate the message. Its API has no idempotency key.
export async function createSubmissionOutbox({
  directory,
  loadSubmission,
  listSubmissions,
  send,
  log = () => {},
  pollMs = 15000,
  retryBaseMs = 30000
}) {
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
      running = drain().catch(() => log('submission_outbox_scan_error')).finally(() => {
        running = null;
        schedule(pollMs);
      });
    }, delay);
    timer.unref?.();
  }

  async function enqueue(submissionId) {
    if (closed) throw new Error('submission_outbox_closed');
    if (!validId(submissionId)) throw new Error('invalid_submission_id');
    const key = createHash('sha256').update('submission:' + submissionId).digest('hex');
    while (locks.has(key)) await locks.get(key);
    let release;
    locks.set(key, new Promise(resolve => { release = resolve; }));
    try {
      const file = path.join(directory, key + '.json');
      try {
        const previous = JSON.parse(await readFile(file, 'utf8'));
        if (previous.key !== key || previous.submissionId !== submissionId || !['pending', 'sent', 'skipped'].includes(previous.status)) throw new Error('invalid_outbox_record');
        return { key, duplicate: true };
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      const item = {
        version: 1,
        key,
        submissionId,
        status: 'pending',
        createdAt: new Date().toISOString(),
        attempts: 0,
        nextAttemptAt: 0,
        sentAt: null,
        messageId: null
      };
      await durableJson(file, item);
      log('submission_outbox_queued', submissionId);
      schedule();
      return { key, duplicate: false };
    } finally { locks.delete(key); release(); }
  }

  async function reconcile() {
    // The marker is committed together with the original submission. Therefore a
    // crash between its save and enqueue does not lose the notification. Existing
    // records without the marker are deliberately left untouched.
    for (const item of await listSubmissions()) {
      if (closed) return;
      if (item.telegramNotification?.version !== 1 || item.status === 'trash') continue;
      try { await enqueue(item.id); }
      catch { log('submission_outbox_reconcile_error'); }
    }
  }

  async function drain() {
    await reconcile();
    for (const filename of await readdir(directory)) {
      if (closed) break;
      if (!/^[a-f0-9]{64}\.json$/.test(filename)) continue;
      const file = path.join(directory, filename);
      let item;
      try {
        item = JSON.parse(await readFile(file, 'utf8'));
        if (!validId(item.submissionId) || item.key + '.json' !== filename) throw new Error('invalid_outbox_record');
      } catch { log('submission_outbox_read_error'); continue; }
      if (item.status !== 'pending' || item.nextAttemptAt > Date.now()) continue;
      let submission;
      try { submission = await loadSubmission(item.submissionId); }
      catch (error) {
        if (error.code !== 'ENOENT') {
          log('submission_outbox_load_error', item.submissionId);
          continue;
        }
      }
      if (!submission || submission.status === 'trash') {
        item.status = 'skipped';
        item.skippedAt = new Date().toISOString();
        item.skipReason = submission ? 'trash' : 'missing';
        item.nextAttemptAt = null;
        await durableJson(file, item);
        log('submission_telegram_skipped', item.submissionId);
        continue;
      }
      item.attempts += 1;
      const retryMs = Math.min(60 * 60 * 1000, retryBaseMs * (2 ** Math.min(item.attempts - 1, 10)));
      item.nextAttemptAt = Date.now() + retryMs;
      await durableJson(file, item);
      try {
        const receipt = await send(submission);
        if (!Number.isSafeInteger(receipt?.message_id) || receipt.message_id <= 0) throw new Error('telegram_receipt_missing');
        item.status = 'sent';
        item.sentAt = new Date().toISOString();
        item.messageId = receipt.message_id;
        item.nextAttemptAt = null;
        await durableJson(file, item);
        log('submission_telegram_sent', item.submissionId, { messageId: item.messageId });
      } catch {
        // Provider errors may include a bot-token URL. Only fixed event names,
        // opaque submission IDs and the Telegram receipt are written to logs.
        log('submission_telegram_retry', item.submissionId);
      }
    }
  }

  return {
    enqueue,
    async status() {
      const summary = { pending: 0, sent: 0, skipped: 0, unreadable: 0, lastSentAt: null, lastMessageId: null };
      for (const filename of await readdir(directory)) {
        if (!/^[a-f0-9]{64}\.json$/.test(filename)) continue;
        let item;
        try { item = JSON.parse(await readFile(path.join(directory, filename), 'utf8')); }
        catch { summary.unreadable++; continue; }
        if (item.status === 'pending') summary.pending++;
        else if (item.status === 'skipped') summary.skipped++;
        else if (item.status === 'sent') {
          summary.sent++;
          if (item.sentAt && (!summary.lastSentAt || item.sentAt > summary.lastSentAt)) {
            summary.lastSentAt = item.sentAt;
            summary.lastMessageId = Number.isSafeInteger(item.messageId) ? item.messageId : null;
          }
        } else summary.unreadable++;
      }
      return summary;
    },
    start() { if (!closed) { started = true; schedule(); } },
    async close() { closed = true; clearTimeout(timer); await running; }
  };
}
