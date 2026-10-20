import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SHOP_FORM_ID, createShopOutbox, validateShopPayload } from '../shop-notifications.js';

const payload = () => ({ form_id: SHOP_FORM_ID, response_id: 'response-123' });
async function until(check) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail('Shop outbox did not reach the expected state');
}
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'vargi-shop-outbox-'));
  const outboxes = [];
  t.after(async () => { for (const box of outboxes) await box.close(); await rm(directory, { recursive: true, force: true }); });
  return {
    directory,
    async create(send, log) {
      const box = await createShopOutbox({ directory, send, log, pollMs: 5, retryBaseMs: 15 });
      outboxes.push(box);
      return box;
    },
    async records() {
      const names = (await readdir(directory)).filter(name => name.endsWith('.json'));
      return Promise.all(names.map(name => readFile(join(directory, name), 'utf8').then(JSON.parse)));
    }
  };
}

test('shop schema accepts only its form ID and bounded immutable response ID', () => {
  assert.equal(validateShopPayload(payload()), true);
  for (const body of [null, [], {}, { ...payload(), name: 'private' }, { ...payload(), message: 'private' }, { ...payload(), camp: '' }, { ...payload(), form_id: '6aacf2a849af472ed76c9d3d' }, { ...payload(), response_id: '../private' }, { ...payload(), response_id: 123 }, { ...payload(), response_id: '' }, { ...payload(), response_id: 'x'.repeat(129) }]) {
    assert.equal(validateShopPayload(body), false);
  }
});

test('shop delivery is persisted first; concurrent duplicates and restarts do not resend', async t => {
  const f = await fixture(t);
  let sends = 0;
  const box = await f.create(async () => { sends++; });
  const results = await Promise.all([box.enqueue('response-123'), box.enqueue('response-123')]);
  assert.deepEqual(results.map(r => r.duplicate).sort(), [false, true]);
  assert.equal(results[0].key, results[1].key);
  assert.equal(sends, 0);
  assert.deepEqual(await box.status(), { pending: 1, sent: 0, unreadable: 0, lastSentAt: null });
  const [pending] = await f.records();
  assert.equal(pending.formId, SHOP_FORM_ID);
  assert.equal(pending.status, 'pending');
  box.start();
  await until(async () => (await box.status()).sent === 1);
  assert.equal(sends, 1);
  await box.close();
  const restarted = await f.create(async () => { sends++; });
  restarted.start();
  assert.equal((await restarted.enqueue('response-123')).duplicate, true);
  await restarted.enqueue('response-456');
  await until(async () => (await restarted.status()).sent === 2);
  assert.equal(sends, 2);
  const status = await restarted.status();
  assert.equal(status.pending, 0);
  assert.ok(status.lastSentAt);
  assert(!JSON.stringify(status).includes('response-'));
});

test('shop recovers pending work and retries without logging provider secrets', async t => {
  const f = await fixture(t);
  const initial = await f.create(async () => { throw new Error('must not send before start'); });
  await initial.enqueue('response-restart');
  await initial.close();
  let attempts = 0;
  const logs = [];
  const resumed = await f.create(async () => { if (++attempts === 1) throw new Error('https://provider/secret-token'); }, (...args) => logs.push(args));
  resumed.start();
  await until(async () => (await resumed.status()).sent === 1);
  await resumed.close();
  assert.equal(attempts, 2);
  const [record] = await f.records();
  assert.equal(record.attempts, 2);
  assert.equal(record.nextAttemptAt, null);
  assert.deepEqual(logs.map(row => row[0]), ['shop_telegram_retry', 'shop_telegram_sent']);
  assert(!JSON.stringify(logs).includes('secret-token'));
  assert(!JSON.stringify(logs).includes('response-restart'));
});

test('slow Telegram send does not block acceptance of another shop response', async t => {
  const f = await fixture(t);
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  let started = false;
  const box = await f.create(async () => { started = true; await blocked; });
  try {
    box.start();
    await box.enqueue('slow-first');
    await until(() => started);
    const queued = await Promise.race([
      box.enqueue('slow-second'),
      new Promise((_, reject) => setTimeout(() => reject(new Error('enqueue waited for Telegram')), 500))
    ]);
    assert.equal(queued.duplicate, false);
    assert.equal((await f.records()).length, 2);
  } finally { release(); }
});
