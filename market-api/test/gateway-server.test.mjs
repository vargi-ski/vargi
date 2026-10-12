import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import sharp from 'sharp';
import { gatewaySignature } from '../gateway-transport.mjs';
import { gatewayPhotoSlot, gatewayJpeg } from '../gateway-photo.mjs';

const SECRET = '22'.repeat(32); // Synthetic fixture, not deployment configuration.
let nonce = 0;
function signed(body, contentType, ip = '192.0.2.4') {
  const proof = { timestamp: String(Math.floor(Date.now() / 1000)), nonce: (++nonce).toString(16).padStart(32, '0'), clientIp: ip,
    contentType, size: String(body.length), digest: createHash('sha256').update(body).digest('hex') };
  return { 'Content-Type': contentType, 'X-Vargi-Gateway-Time': proof.timestamp, 'X-Vargi-Gateway-Nonce': proof.nonce,
    'X-Vargi-Gateway-Ip': proof.clientIp, 'X-Vargi-Gateway-Size': proof.size, 'X-Vargi-Gateway-Sha256': proof.digest,
    'X-Vargi-Gateway-Signature': gatewaySignature(Buffer.from(SECRET, 'hex'), proof) };
}
async function serverFixture(t, enabled = true) {
  const root = await mkdtemp(path.join(tmpdir(), 'vargi-gateway-test-'));
  const reserve = http.createServer().listen(0, '127.0.0.1'); await once(reserve, 'listening');
  const port = reserve.address().port; await new Promise(resolve => reserve.close(resolve));
  const env = { PATH: process.env.PATH, PORT: String(port), DATA_ROOT: root, SITE_ORIGIN: 'https://example.invalid' };
  if (enabled) env.GATEWAY_SUBMIT_SECRET = SECRET;
  const child = spawn(process.execPath, ['server.js'], { cwd: new URL('../', import.meta.url), env, stdio: ['ignore', 'pipe', 'pipe'] });
  const closed = once(child, 'close'); let output = '';
  child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', () => {});
  t.after(async () => { child.kill(); await closed; await rm(root, { recursive: true, force: true }); });
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Synthetic API startup timed out')), 5000);
    const timer = setInterval(() => { if (output.includes('listening')) { clearTimeout(timeout); clearInterval(timer); resolve(); } }, 10);
    closed.then(() => { clearTimeout(timeout); clearInterval(timer); reject(new Error('Synthetic API exited')); });
  });
  return { root, url: `http://127.0.0.1:${port}` };
}
async function submissionBody(photo, requestId = randomUUID()) {
  const form = new FormData();
  const fields = { title: 'Synthetic fixture', city: 'Fixture city', contactName: 'Fixture name', publicContact: 'fixture-contact',
    description: 'Synthetic test only', categoryKey: 'boots', priceValue: '1000', condition: 'Б/у',
    consent: 'true', consentVersion: 'board-submit-2026-10-05', requestId };
  for (const [key, val] of Object.entries(fields)) form.append(key, val);
  form.append('photos', new Blob([photo], { type: 'image/jpeg' }), 'fixture.jpg');
  const request = new Request('https://example.invalid', { method: 'POST', body: form });
  return { body: Buffer.from(await request.arrayBuffer()), type: request.headers.get('content-type'), fields, requestId };
}

test('actual API preserves requestId deduplication across gateway retries and legacy transport; no admin privilege', async t => {
  const { root, url } = await serverFixture(t);
  const photo = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#abcdef' } }).jpeg().toBuffer();
  const prepared = await submissionBody(photo);
  const send = () => fetch(url + '/gateway/submit', { method: 'POST', body: prepared.body, headers: signed(prepared.body, prepared.type) });
  const first = await send(); assert.equal(first.status, 201);
  assert.match(first.headers.get('x-request-id'), /^[a-f0-9-]{36}$/); const saved = await first.json();
  const second = await send(); assert.equal(second.status, 200); assert.deepEqual(await second.json(), { ok: true, id: saved.id, duplicate: true });
  const legacy = await fetch(url + '/submit', { method: 'POST', body: prepared.body, headers: { 'Content-Type': prepared.type } });
  assert.equal(legacy.status, 200); assert.equal((await legacy.json()).id, saved.id);
  const dirs = (await readdir(path.join(root, 'submissions'))).filter(name => !name.startsWith('.'));
  assert.deepEqual(dirs, [saved.id]);
  const changed = await submissionBody(photo, prepared.requestId);
  changed.body[changed.body.indexOf('Synthetic fixture')] = 88;
  assert.equal((await fetch(url + '/gateway/submit', { method: 'POST', body: changed.body, headers: signed(changed.body, changed.type) })).status, 409);
  assert.equal((await fetch(url + '/admin/submissions', { headers: signed(prepared.body, prepared.type) })).status, 401);
});
test('both gateway routes are disabled without opt-in secret; legacy published photos keep working', async t => {
  const { root, url } = await serverFixture(t, false);
  const id = '2026-10-07T01-00-00-000Z_abcdef01';
  const dir = path.join(root, 'submissions', id); await mkdir(dir, { recursive: true });
  const photo = await sharp({ create: { width: 8, height: 8, channels: 3, background: 'red' } }).jpeg().toBuffer();
  await writeFile(path.join(dir, 'photo-01.jpg'), photo);
  await writeFile(path.join(dir, 'submission.json'), JSON.stringify({ id, status: 'published', photos: [{ filename: 'photo-01.jpg', mimeType: 'image/jpeg' }] }));
  assert.equal((await fetch(url + '/gateway/submit', { method: 'POST' })).status, 503);
  assert.equal((await fetch(url + `/gateway/photos/${id}/photo-01.jpg`)).status, 503);
  assert.deepEqual(Buffer.from(await (await fetch(url + `/listings/${id}/photos/photo-01.jpg`)).arrayBuffer()), photo);
});
test('gateway photo is bounded JPEG; originals unchanged and pending/archive/trash/photos paths stay private', async t => {
  const { root, url } = await serverFixture(t);
  const original = await sharp(randomBytes(2200 * 2200 * 3), { raw: { width: 2200, height: 2200, channels: 3 } }).jpeg({ quality: 100 }).toBuffer();
  assert.ok(original.length > 2_500_000);
  const ids = [];
  for (const [i, status] of ['published', 'pending', 'archived', 'trash'].entries()) {
    const id = `2026-10-07T01-00-00-000Z_abcdef0${i}`; ids.push(id);
    const dir = path.join(root, 'submissions', id); await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'photo-01.jpg'), original);
    await writeFile(path.join(dir, 'submission.json'), JSON.stringify({ id, status, photos: [{ filename: 'photo-01.jpg', mimeType: 'image/jpeg' }] }));
  }
  const response = await fetch(url + `/gateway/photos/${ids[0]}/photo-01.jpg`);
  assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('content-type'), 'image/jpeg');
  const result = Buffer.from(await response.arrayBuffer()); assert.ok(result.length <= 2_000_000);
  assert.equal((await sharp(result).metadata()).format, 'jpeg');
  assert.deepEqual(await readFile(path.join(root, 'submissions', ids[0], 'photo-01.jpg')), original);
  for (const id of ids.slice(1)) assert.equal((await fetch(url + `/gateway/photos/${id}/photo-01.jpg`)).status, 404);
  assert.equal((await fetch(url + `/gateway/photos/${ids[0]}/submission.json`)).status, 404);
  await writeFile(path.join(root, 'submissions', ids[0], 'submission.json'), JSON.stringify({ id: ids[0], status: 'archived', photos: [{ filename: 'photo-01.jpg' }] }));
  assert.equal((await fetch(url + `/gateway/photos/${ids[0]}/photo-01.jpg`)).status, 404);
});
test('photo transform concurrency stays bounded and slots release on failure', async () => {
  let release;
  const waiting = new Promise(resolve => { release = resolve; });
  const a = gatewayPhotoSlot(() => waiting); const b = gatewayPhotoSlot(() => waiting);
  await assert.rejects(gatewayPhotoSlot(() => 'unexpected'), error => error.status === 503);
  release('done'); assert.deepEqual(await Promise.all([a, b]), ['done', 'done']);
  await assert.rejects(gatewayPhotoSlot(() => { throw new Error('fixture'); }));
  assert.equal(await gatewayPhotoSlot(() => 'released'), 'released');
  const oversizedSharp = () => ({ rotate() { return this; }, resize() { return this; }, jpeg() { return this; }, async toBuffer() { return Buffer.alloc(2_000_001); } });
  await assert.rejects(gatewayJpeg(oversizedSharp, Buffer.alloc(1)), /gateway_photo_size/);
});
test('documented CJS index.handler loads the standalone ESM signer', async () => {
  const require = createRequire(import.meta.url);
  const { handler } = require('../../yandex/function/index.js');
  assert.equal((await handler({})).statusCode, 503);
});
