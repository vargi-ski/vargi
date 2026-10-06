import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { createServer as createHttpServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scryptSync } from 'node:crypto';

const origin = 'https://preview.example.test';
const root = new URL('../', import.meta.url);
const id = '2026-10-06T00-00-00-000Z_12345678';
const trashId = '2026-01-01T00-00-00-000Z_abcdef01';

async function launch(t, variables = {}) {
  const data = await mkdtemp(join(tmpdir(), 'vargi-migration-test-'));
  await mkdir(join(data, 'submissions', id), { recursive: true });
  const listing = { id, status: 'published', title: 'Синтетический тест', city: 'Тест', contact: '@test_only', photos: [{ filename: 'photo-01.jpg', mimeType: 'image/jpeg' }] };
  await writeFile(join(data, 'submissions', id, 'submission.json'), JSON.stringify(listing));
  await writeFile(join(data, 'submissions', id, 'photo-01.jpg'), Buffer.from([255,216,255,217]));
  await mkdir(join(data, 'submissions', trashId));
  await writeFile(join(data, 'submissions', trashId, 'submission.json'), JSON.stringify({ id: trashId, status: 'trash', deletedAt: '2026-01-01T00:00:00Z', photos: [] }));
  const salt = Buffer.alloc(16, 7);
  await writeFile(join(data, 'admin-auth.json'), JSON.stringify({ salt: salt.toString('base64'), hash: scryptSync('synthetic-test-password', salt, 64).toString('base64') }));
  const probe = createServer();
  probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  const child = spawn(process.execPath, ['server.js'], { cwd: root, env: { PATH: process.env.PATH, PORT: String(port), DATA_ROOT: data, SITE_ORIGIN: origin, ADMIN_SESSION_SECRET: 'synthetic-session-secret-32-characters', AUTO_MAINTENANCE_DISABLED: '1', ...variables }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  t.after(async () => { if (child.exitCode === null) { const done = once(child, 'exit'); child.kill('SIGTERM'); await done; } await rm(data, { recursive: true, force: true }); });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error('Startup timeout: ' + output)); }, 10000);
    child.once('exit', code => { clearTimeout(timer); reject(new Error('Startup failed: ' + code + ' ' + output)); });
    child.stdout.on('data', () => { if (output.includes('listening on')) { clearTimeout(timer); resolve(); } });
  });
  return { data, url: `http://127.0.0.1:${port}` };
}

test('VPS emits photos under the configured same-origin API prefix, regardless of Host', async t => {
  const app = await launch(t, { PUBLIC_API_PREFIX: '/api/market' });
  const response = await fetch(app.url + '/listings', { headers: { Host: 'untrusted.example.test' } });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.listings.length, 1);
  assert.equal(body.listings[0].photos[0].url, `${origin}/api/market/listings/${id}/photos/photo-01.jpg`);
  const image = await fetch(app.url + `/listings/${id}/photos/photo-01.jpg`);
  assert.equal(image.status, 200);
  assert.equal(image.headers.get('cache-control'), 'no-store');
  const health = await (await fetch(app.url + '/health')).json();
  assert.equal(health.mode, 'read-write');
  assert.equal(health.storageCheck, 'read-write');
});

test('migration freeze blocks uploads and moderation, permits login, and never purges copied trash', { timeout: 30000 }, async t => {
  const app = await launch(t, { MIGRATION_READ_ONLY: '1', AUTO_MAINTENANCE_DISABLED: '0' });
  const authBefore = await readFile(join(app.data, 'admin-auth.json'), 'utf8');
  for (const [method, route] of [['POST','/submit'], ['POST','/admin/setup'], ['POST','/admin/recover'], ['POST',`/admin/submissions/${id}/sold`], ['DELETE',`/admin/submissions/${id}`], ['PUT',`/admin/submissions/${id}`], ['POST','/admin/telegram/connect'], ['POST','/admin/backup']]) {
    const response = await fetch(app.url + route, { method, headers: { Origin: origin } });
    assert.equal(response.status, 503, route);
    assert.equal((await response.json()).code, 'MIGRATION_READ_ONLY');
  }
  const login = await fetch(app.url + '/admin/login', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'synthetic-test-password' }) });
  assert.equal(login.status, 200);
  assert.ok((await login.json()).token);
  const health = await (await fetch(app.url + '/health')).json();
  assert.equal(health.mode, 'read-only');
  assert.equal(health.storageCheck, 'read-only');
  assert.deepEqual((await readdir(join(app.data, 'submissions'))).sort(), [id, trashId].sort());
  // The old server starts maintenance after 15 seconds. A frozen clone must not do so.
  await new Promise(resolve => setTimeout(resolve, 16000));
  assert.equal(await readFile(join(app.data, 'admin-auth.json'), 'utf8'), authBefore);
  assert.equal(JSON.parse(await readFile(join(app.data, 'submissions', trashId, 'submission.json'))).status, 'trash');
});

test('failed configured backup keeps expired trash instead of deleting it', { timeout: 30000 }, async t => {
  let requests = 0;
  const storage = createHttpServer((req, res) => {
    requests++;
    req.resume();
    res.writeHead(403, { 'Content-Type': 'application/xml' });
    res.end('<Error><Code>AccessDenied</Code><Message>Synthetic backup failure</Message></Error>');
  });
  storage.listen(0, '127.0.0.1');
  await once(storage, 'listening');
  t.after(() => new Promise(resolve => storage.close(resolve)));
  const app = await launch(t, {
    AUTO_MAINTENANCE_DISABLED: '0',
    BACKUP_S3_ENDPOINT: `http://127.0.0.1:${storage.address().port}`,
    BACKUP_S3_REGION: 'test-region',
    BACKUP_S3_BUCKET: 'synthetic-backup',
    BACKUP_S3_ACCESS_KEY_ID: 'synthetic-key',
    BACKUP_S3_SECRET_ACCESS_KEY: 'synthetic-secret'
  });
  await new Promise(resolve => setTimeout(resolve, 16500));
  assert.ok(requests >= 2, 'maintenance and pre-purge backup both reached isolated storage');
  assert.equal(JSON.parse(await readFile(join(app.data, 'submissions', trashId, 'submission.json'))).status, 'trash');
});
