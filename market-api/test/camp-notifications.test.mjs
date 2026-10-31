import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CAMP_FORM_ID, CAMP_ID, createCampOutbox, validateCampPayload } from '../camp-notifications.js';
import { createHash } from 'node:crypto';

const payload = () => ({ form_id: CAMP_FORM_ID, response_id: 'response-123', camp: CAMP_ID });
async function until(check) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail('Outbox did not reach the expected state');
}
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'vargi-camp-outbox-'));
  const outboxes = [];
  t.after(async () => { for (const box of outboxes) await box.close(); await rm(directory, { recursive: true, force: true }); });
  return {
    directory,
    async create(send) {
      const box = await createCampOutbox({ directory, send, pollMs: 5, retryBaseMs: 15 });
      outboxes.push(box);
      return box;
    },
    async records() {
      const names = (await readdir(directory)).filter(name => name.endsWith('.json'));
      return Promise.all(names.map(name => readFile(join(directory, name), 'utf8').then(JSON.parse)));
    }
  };
}

test('webhook schema accepts only routing metadata and bounded immutable response IDs', () => {
  assert.equal(validateCampPayload(payload()), true);
  assert.equal(validateCampPayload({ ...payload(), camp: '' }), true);
  for (const body of [null, [], {}, { ...payload(), name: 'do-not-store' }, { ...payload(), message: 'do-not-store' }, { ...payload(), form_id: 'another-form' }, { ...payload(), response_id: '../private' }, { ...payload(), response_id: 123 }, { ...payload(), response_id: '' }, { ...payload(), response_id: 'x'.repeat(129) }, { ...payload(), camp: 'x'.repeat(65) }]) {
    assert.equal(validateCampPayload(body), false);
  }
});

test('accepted delivery is persisted before sending; concurrent duplicates send once', async t => {
  const f = await fixture(t);
  let sends = 0;
  const box = await f.create(async () => ({ message_id: ++sends }));
  const results = await Promise.all([box.enqueue('response-123'), box.enqueue('response-123')]);
  assert.deepEqual(results.map(r => r.duplicate).sort(), [false, true]);
  assert.equal(results[0].key, results[1].key);
  assert.equal(sends, 0);
  const [pending] = await f.records();
  assert.equal(pending.status, 'pending');
  assert.deepEqual(Object.keys(pending).sort(), ['attempts', 'createdAt', 'formId', 'key', 'nextAttemptAt', 'responseId', 'sentAt', 'status', 'version'].sort());
  box.start();
  await until(async () => (await f.records())[0].status === 'sent');
  assert.equal(sends, 1);
  assert.equal((await box.enqueue('response-123')).duplicate, true);
  await box.close();
  const restarted = await f.create(async () => ({ message_id: ++sends }));
  restarted.start();
  assert.equal((await restarted.enqueue('response-123')).duplicate, true);
  await restarted.enqueue('response-456');
  await until(async () => (await f.records()).every(r => r.status === 'sent'));
  assert.equal(sends, 2, 'already-sent response must not resend after restart');
});

test('restart recovers accepted pending work; failed Telegram calls remain queued and retry', async t => {
  const f = await fixture(t);
  const initial = await f.create(async () => { throw new Error('must not send before start'); });
  await initial.enqueue('response-restart');
  await initial.close();
  let attempts = 0;
  const resumed = await f.create(async () => { if (++attempts === 1) throw new Error('temporary delivery failure'); return { message_id: 101 }; });
  resumed.start();
  await until(async () => (await f.records())[0].status === 'sent');
  const [record] = await f.records();
  assert.equal(attempts, 2);
  assert.equal(record.attempts, 2);
  assert.ok(record.sentAt);
  assert.equal(record.nextAttemptAt, null);
});

test('slow delivery never holds up durable webhook acceptance', async t => {
  const f = await fixture(t);
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  let started = false;
  const box = await f.create(async () => { started = true; await blocked; return { message_id: 102 }; });
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

test('camp and contact namespaces preserve legacy keys and retain only Telegram receipt IDs', async t => {
  const base = await mkdtemp(join(tmpdir(), 'vargi-contact-outbox-'));
  const logs = [];
  const camp = await createCampOutbox({ directory: join(base, 'camp'), send: async () => ({ message_id: 811, chat: { id: 'private' } }), pollMs: 5 });
  const contact = await createCampOutbox({ directory: join(base, 'contact'), namespace: CAMP_FORM_ID + ':contact', logPrefix: 'contact', send: async () => ({ message_id: 812 }), log: (...args) => logs.push(args), pollMs: 5 });
  t.after(async () => { await camp.close(); await contact.close(); await rm(base, { recursive: true, force: true }); });
  const campDelivery = await camp.enqueue('same-response');
  const contactDelivery = await contact.enqueue('same-response');
  assert.equal(campDelivery.key, createHash('sha256').update(CAMP_FORM_ID + ':same-response').digest('hex'));
  assert.notEqual(contactDelivery.key, campDelivery.key);
  camp.start(); contact.start();
  await until(async () => (await camp.status()).sent === 1 && (await contact.status()).sent === 1);
  assert.equal((await camp.status()).lastMessageId, 811);
  assert.equal((await contact.status()).lastMessageId, 812);
  const record = await readFile(join(base, 'camp', campDelivery.key + '.json'), 'utf8');
  assert(!record.includes('private'));
  assert(logs.some(row => row[0] === 'contact_telegram_sent' && row[2].messageId === 812));
});

test('camp requires a positive integer Telegram receipt before confirming delivery', async t => {
  const f = await fixture(t);
  const invalidReceipts = [undefined, false, {}, { message_id: 0 }, { message_id: -1 }, { message_id: 1.5 }, { message_id: '12' }];
  let attempts = 0;
  const box = await f.create(async () => attempts++ < invalidReceipts.length ? invalidReceipts[attempts - 1] : { message_id: 103 });
  await box.enqueue('strict-receipt');
  box.start();
  await until(async () => (await box.status()).sent === 1);
  await box.close();
  const [record] = await f.records();
  assert.equal(record.attempts, invalidReceipts.length + 1);
  assert.equal(record.messageId, 103);
  assert.equal((await box.status()).pending, 0);
});

test('production Docker COPY includes every local module imported by the server', async () => {
  const base = new URL('../', import.meta.url);
  const dockerfile = await readFile(new URL('Dockerfile', base), 'utf8');
  const copies = [...dockerfile.matchAll(/^COPY\s+(.+)\s+\.\/\s*$/gm)].flatMap(match => match[1].trim().split(/\s+/));
  const server = await readFile(new URL('server.js', base), 'utf8');
  const localImports = [...server.matchAll(/from\s+['"]\.\/([^'"]+)['"]/g)].map(match => match[1]);
  for (const module of ['server.js', ...localImports]) {
    assert(copies.includes(module), `Production image is missing ${module}`);
    await readFile(new URL(module, base));
  }
});
