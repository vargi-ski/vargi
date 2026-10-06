// Run only with a local Docker daemon. Uses loopback HTTP solely for isolated CI;
// production preflight rejects HTTP SITE_HOST values and requires public HTTPS.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const image = process.argv[2];
if (!image) throw new Error('Usage: node deploy/vps/test/edge-smoke.mjs IMAGE');
const suffix = `${process.pid}-${Date.now()}`;
const network = `vargi-edge-test-${suffix}`;
const backend = `vargi-api-test-${suffix}`;
const edge = `vargi-site-test-${suffix}`;
const mock = fileURLToPath(new URL('./mock-api.mjs', import.meta.url));
function docker(...args) {
  const result = spawnSync('docker', args, { encoding: 'utf8', timeout: 120000 });
  if (result.error || result.status) throw new Error(`docker ${args[0]} failed: ${result.error?.message || result.stderr}`);
  return result.stdout.trim();
}
const cleanup = () => {
  for (const name of [edge, backend]) spawnSync('docker', ['rm', '-f', name], { stdio: 'ignore' });
  spawnSync('docker', ['network', 'rm', network], { stdio: 'ignore' });
};
try {
  docker('network', 'create', network);
  docker('run', '-d', '--name', backend, '--network', network, '--network-alias', 'market-api',
    '--mount', `type=bind,source=${mock},target=/mock.mjs,readonly`, 'node:22-alpine', 'node', '/mock.mjs');
  docker('run', '-d', '--name', edge, '--network', network, '-e', 'SITE_HOST=http://localhost:8080',
    '-p', '127.0.0.1::8080', image);
  const port = docker('port', edge, '8080/tcp').split(':').at(-1);
  const origin = `http://127.0.0.1:${port}`;
  const request = (pathname, options = {}) => fetch(origin + pathname, {
    ...options, headers: { Host: 'localhost:8080', ...options.headers }, signal: AbortSignal.timeout(15000)
  });
  let ready = false;
  for (let attempt = 0; attempt < 40; attempt++) {
    try { if ((await request('/')).ok) { ready = true; break; } } catch {}
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  assert.ok(ready, 'edge must serve the website');
  const runtime = await request('/assets/board-runtime.js');
  assert.equal(runtime.headers.get('cache-control'), 'no-store');
  assert.match(await runtime.text(), /same-origin/);
  assert.equal((await request('/board/')).headers.get('cache-control'), 'no-store');
  const proxied = await request('/api/market/listings?test=1', {
    headers: { 'X-Forwarded-For': '203.0.113.1', Forwarded: 'for=203.0.113.1' }
  });
  assert.equal(proxied.headers.get('cache-control'), 'no-store');
  assert.equal(proxied.headers.get('cdn-cache-control'), 'no-store');
  const body = await proxied.json();
  assert.equal(body.url, '/listings?test=1');
  assert.equal(body.forwarded, null);
  assert.notEqual(body.forwardedFor, '203.0.113.1', 'client supplied proxy IP must not be trusted');
  const submitted = await request('/api/market/submit', { method: 'POST', body: 'submission-test' });
  assert.deepEqual(await submitted.json().then(({ method, url, bytes }) => ({ method, url, bytes })),
    { method: 'POST', url: '/submit', bytes: 15 });
  // Backend administration lives below this path; the static private-path guard
  // must not block legitimate authenticated API routes.
  assert.equal((await request('/api/market/admin/submissions')).status, 200);
  const rejected = await request('/api/market/failure');
  assert.equal(rejected.status, 503);
  assert.equal(rejected.headers.get('cache-control'), 'no-store');
  for (const pathname of ['/api/unknown', '/api/market-other/listings', '/market-api/server.js', '/deploy/vps/compose.yml', '/.env', '/data/submissions/customer.json', '/assets/admin-auth.json']) {
    assert.equal((await request(pathname)).status, 404, pathname);
  }
  const tooLarge = await request('/api/market/submit', { method: 'POST', body: new Uint8Array(32000001) });
  assert.equal(tooLarge.status, 413, '32 MB public upload boundary must be enforced');
  assert.equal(tooLarge.headers.get('cache-control'), 'no-store');
  docker('stop', backend);
  const unavailable = await request('/api/market/health');
  assert.ok(unavailable.status >= 500);
  assert.equal(unavailable.headers.get('cache-control'), 'no-store');
  assert.equal((await request('/')).status, 200, 'main page must stay available while API is down');
  console.log('Edge smoke OK: same origin, privacy boundary, body limit, cache and API outage isolation');
} catch (error) {
  for (const name of [edge, backend]) {
    const logs = spawnSync('docker', ['logs', name], { encoding: 'utf8' });
    if (logs.stdout || logs.stderr) console.error(`${name}: ${logs.stdout || ''}${logs.stderr || ''}`);
  }
  throw error;
} finally {
  cleanup();
}
