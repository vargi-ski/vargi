import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createEdgeRequest } from './edge-request.mjs';

test('edge requests reach the localhost virtual host rather than a blank unmatched route', async t => {
  const server = http.createServer((req, res) => {
    if (!req.headers.host.startsWith('localhost:')) return res.end('');
    res.writeHead(200, { 'Content-Type': 'application/javascript', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ host: req.headers.host, url: req.url, method: req.method }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const port = server.address().port;
  const request = createEdgeRequest(port);
  const response = await request('/assets/board-runtime.js');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await response.json(), {
    host: `localhost:${port}`, url: '/assets/board-runtime.js', method: 'GET'
  });
  assert.throws(() => request('/', { headers: { Host: 'localhost:8080' } }), /not a fetch Host header/);
});
