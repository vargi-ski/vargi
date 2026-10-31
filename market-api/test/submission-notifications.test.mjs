import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSubmissionOutbox } from '../submission-notifications.js';

const id = index => `2026-10-31T10-00-00-000Z_${String(index).padStart(8, '0')}`;
const submission = (index, extra = {}) => ({ id: id(index), status: 'pending', title: 'Synthetic private submission', telegramNotification: { version: 1 }, ...extra });

async function until(check) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail('Submission outbox did not reach the expected state');
}

async function fixture(t, initial = []) {
  const directory = await mkdtemp(join(tmpdir(), 'vargi-submission-outbox-'));
  const items = new Map(initial.map(item => [item.id, item]));
  const boxes = [];
  t.after(async () => { for (const box of boxes) await box.close(); await rm(directory, { recursive: true, force: true }); });
  return {
    directory,
    items,
    async create(send, log = () => {}) {
      const box = await createSubmissionOutbox({
        directory,
        async listSubmissions() { return [...items.values()]; },
        async loadSubmission(id) {
          if (!items.has(id)) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
          return items.get(id);
        },
        send,
        log,
        pollMs: 5,
        retryBaseMs: 15
      });
      boxes.push(box);
      return box;
    },
    async records() {
      return Promise.all((await readdir(directory)).filter(name => name.endsWith('.json')).map(name => readFile(join(directory, name), 'utf8').then(JSON.parse)));
    }
  };
}

test('reconciliation recovers the save/enqueue crash gap without backfilling historical submissions', async t => {
  const marked = submission(1);
  const old = submission(2, { telegramNotification: undefined });
  const trashed = submission(3, { status: 'trash' });
  const f = await fixture(t, [marked, old, trashed]);
  const sent = [];
  const box = await f.create(async item => { sent.push(item.id); return { message_id: 123, chat: { id: 'not-stored' } }; });
  box.start();
  await until(async () => (await box.status()).sent === 1);
  await box.close();
  assert.deepEqual(sent, [marked.id]);
  const [record] = await f.records();
  assert.equal(record.messageId, 123);
  assert(!JSON.stringify(record).includes('private'));
  assert(!JSON.stringify(record).includes('not-stored'));
  assert.equal((await box.status()).lastMessageId, 123);
  assert.deepEqual(f.items.get(marked.id), marked, 'outbox must never rewrite submission/admin data');
});

test('simultaneous enqueue and completed delivery survive restart without extra sends', async t => {
  const item = submission(1);
  const f = await fixture(t, [item]);
  let sends = 0;
  const send = async () => { sends++; return { message_id: 124 }; };
  const first = await f.create(send);
  const queued = await Promise.all(Array.from({ length: 10 }, () => first.enqueue(item.id)));
  assert.equal(queued.filter(result => !result.duplicate).length, 1);
  assert.equal(sends, 0, 'enqueue must persist before delivery starts');
  assert.equal((await f.records())[0].status, 'pending');
  first.start();
  await until(async () => (await first.status()).sent === 1);
  await first.close();
  const restarted = await f.create(send);
  restarted.start();
  assert.equal((await restarted.enqueue(item.id)).duplicate, true);
  f.items.set(id(2), submission(2));
  await until(async () => (await restarted.status()).sent === 2);
  await restarted.close();
  assert.equal(sends, 2);
});

test('pending delivery resumes after restart and provider failure retries without leaking error text', async t => {
  const item = submission(1);
  const f = await fixture(t, [item]);
  const initial = await f.create(async () => assert.fail('not started'));
  await initial.enqueue(item.id);
  await initial.close();
  const logs = [];
  let attempts = 0;
  const resumed = await f.create(async () => {
    if (++attempts === 1) throw new Error('https://api.telegram.org/botSECRET/sendMessage');
    return { message_id: 125 };
  }, (...args) => logs.push(args));
  resumed.start();
  await until(async () => (await resumed.status()).sent === 1);
  await resumed.close();
  const [record] = await f.records();
  assert.equal(record.attempts, 2);
  assert.equal(record.messageId, 125);
  assert.equal(record.nextAttemptAt, null);
  assert(logs.some(row => row[0] === 'submission_telegram_retry'));
  assert(logs.some(row => row[0] === 'submission_telegram_sent' && row[2].messageId === 125));
  assert(!JSON.stringify(logs).includes('SECRET'));
});

test('false or missing Telegram acknowledgment remains queued instead of reporting success', async t => {
  const f = await fixture(t, [submission(1)]);
  let attempts = 0;
  const box = await f.create(async () => {
    attempts++;
    if (attempts === 1) return false;
    if (attempts === 2) return undefined;
    return { message_id: 126 };
  });
  box.start();
  await until(async () => (await box.status()).sent === 1);
  await box.close();
  assert.equal(attempts, 3);
  assert.equal((await f.records())[0].messageId, 126);
});

test('queued submission moved to trash or removed is skipped without sending', async t => {
  const f = await fixture(t, [submission(1), submission(2)]);
  const box = await f.create(async () => assert.fail('deleted work must not send'));
  await box.enqueue(id(1));
  await box.enqueue(id(2));
  f.items.set(id(1), submission(1, { status: 'trash' }));
  f.items.delete(id(2));
  box.start();
  await until(async () => (await box.status()).skipped === 2);
  await box.close();
  assert.deepEqual((await f.records()).map(record => record.skipReason).sort(), ['missing', 'trash']);
});

test('slow Telegram does not block persistence of another submission and invalid IDs cannot become paths', async t => {
  const f = await fixture(t, [submission(1), submission(2)]);
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  let sending = false;
  const box = await f.create(async () => { sending = true; await blocked; return { message_id: 127 }; });
  await assert.rejects(() => box.enqueue('../admin-auth.json'), /invalid_submission_id/);
  await box.enqueue(id(1));
  box.start();
  try {
    await until(() => sending);
    const persisted = await Promise.race([
      box.enqueue(id(2)),
      new Promise((_, reject) => setTimeout(() => reject(new Error('enqueue blocked on Telegram')), 500))
    ]);
    assert(persisted.key);
    assert.equal((await f.records()).length, 2);
  } finally { release(); }
});
