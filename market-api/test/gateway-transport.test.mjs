import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import http from 'node:http';
import { Readable } from 'node:stream';
import express from 'express';
import multer from 'multer';
import { rateLimit, ipKeyGenerator } from 'express-rate-limit';
import { createGatewaySubmit, gatewaySignature, GATEWAY_BODY_LIMIT } from '../gateway-transport.mjs';
import { createSubmitHandler } from '../../yandex/function/submit.mjs';

const SECRET = '11'.repeat(32); // Synthetic fixture; never used outside tests.
const TIME = 1_760_000_000_000;
const TYPE = 'multipart/form-data; boundary=fixture';
const binary = Buffer.from([0, 255, 128, 13, 10, 1]);
function multipart(bytes = binary) {
  return Buffer.concat([Buffer.from('--fixture\r\nContent-Disposition: form-data; name="photos"; filename="fixture.jpg"\r\nContent-Type: image/jpeg\r\n\r\n'), bytes, Buffer.from('\r\n--fixture--\r\n')]);
}
let nonceCounter = 0;
function headersFor(body, { ip = '192.0.2.1', nonce = (++nonceCounter).toString(16).padStart(32, '0'), size = String(body.length), timestamp = String(TIME / 1000), type = TYPE } = {}) {
  const proof = { timestamp, nonce, clientIp: ip, contentType: type, size, digest: createHash('sha256').update(body).digest('hex') };
  return { 'Content-Type': type, 'X-Vargi-Gateway-Time': timestamp, 'X-Vargi-Gateway-Nonce': nonce, 'X-Vargi-Gateway-Ip': ip,
    'X-Vargi-Gateway-Size': size, 'X-Vargi-Gateway-Sha256': proof.digest,
    'X-Vargi-Gateway-Signature': gatewaySignature(Buffer.from(SECRET, 'hex'), proof) };
}
async function harness(t, secret = SECRET, now = () => TIME) {
  const app = express(); let calls = 0;
  const limiter = rateLimit({ windowMs: 900_000, limit: 6, keyGenerator: req => ipKeyGenerator(req.verifiedGatewayIp), validate: false });
  app.post('/gateway/submit', createGatewaySubmit({ secret, now,
    upload: multer({ storage: multer.memoryStorage() }).array('photos', 6), limiter,
    handler(req, res) { calls++; res.status(201).json({ ok: true, id: 'fixture', bytes: [...req.files[0].buffer] }); }
  }));
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const url = `http://127.0.0.1:${server.address().port}`;
  return { url, calls: () => calls, send: (body, headers = headersFor(body), path = '/gateway/submit') => fetch(url + path, { method: 'POST', body, headers }) };
}

test('valid raw binary multipart is preserved through multer; unsigned route stays disabled', async t => {
  const h = await harness(t); const response = await h.send(multipart());
  assert.equal(response.status, 201); assert.deepEqual((await response.json()).bytes, [...binary]);
  const disabled = await harness(t, null); assert.equal((await disabled.send(multipart())).status, 503);
});
test('tampered body, signed headers, timestamp, path and query never reach handler', async t => {
  const h = await harness(t); const body = multipart();
  const changedPhoto = Buffer.from(body); changedPhoto[body.indexOf(binary)] = 99;
  assert.equal((await h.send(changedPhoto, headersFor(body))).status, 401);
  assert.equal((await h.send(body, headersFor(body, { size: String(body.length - 1) }))).status, 401);
  const variants = [
    { header: ['X-Vargi-Gateway-Ip', '192.0.2.2'] }, { header: ['X-Vargi-Gateway-Size', String(body.length + 1)] },
    { header: ['Content-Type', 'multipart/form-data; boundary=changed'] },
    { header: ['X-Vargi-Gateway-Sha256', '00'.repeat(32)] },
    { header: ['X-Vargi-Gateway-Signature', 'not-hex'] },
    { timestamp: String(TIME / 1000 - 61) }, { timestamp: String(TIME / 1000 + 16) },
    { path: '/gateway/submit?admin=true' }, { path: '/gateway/submit/' }
  ];
  for (const variant of variants) {
    const headers = headersFor(body, variant.timestamp ? { timestamp: variant.timestamp } : {});
    if (variant.header) headers[variant.header[0]] = variant.header[1];
    assert.ok([400, 401].includes((await h.send(variant.body || body, headers, variant.path)).status));
  }
  assert.equal(h.calls(), 0);
});
test('actual body cap applies even with a signed smaller claimed size', async t => {
  const h = await harness(t); const body = multipart(Buffer.alloc(GATEWAY_BODY_LIMIT));
  const response = await h.send(body, headersFor(body, { size: String(GATEWAY_BODY_LIMIT) }));
  assert.equal(response.status, 413); assert.equal(h.calls(), 0);
});
test('same nonce replay and concurrent replay only reach handler once', async t => {
  const h = await harness(t); const body = multipart(); const headers = headersFor(body);
  const responses = await Promise.all([h.send(body, headers), h.send(body, headers)]);
  assert.deepEqual(responses.map(r => r.status).sort(), [201, 401]);
  assert.equal((await h.send(body, headers)).status, 401); assert.equal(h.calls(), 1);
});
test('verified client IP separates clients and groups the same IPv6 /56', async t => {
  const h = await harness(t); const body = multipart();
  for (let i = 0; i < 6; i++) assert.equal((await h.send(body, headersFor(body))).status, 201);
  assert.equal((await h.send(body, headersFor(body))).status, 429);
  assert.equal((await h.send(body, headersFor(body, { ip: '192.0.2.2' }))).status, 201);
  for (let i = 0; i < 6; i++) assert.equal((await h.send(body, headersFor(body, { ip: '2001:db8:1234:5600::1' }))).status, 201);
  assert.equal((await h.send(body, headersFor(body, { ip: '2001:db8:1234:56ff::2' }))).status, 429);
});
test('aborted stream does not reach handler', async t => {
  const h = await harness(t); const body = multipart();
  const request = http.request(h.url + '/gateway/submit', { method: 'POST', headers: { ...headersFor(body), 'Content-Length': body.length } });
  request.on('error', () => {}); request.write(body.subarray(0, 60));
  await new Promise(resolve => setTimeout(resolve, 20)); request.destroy();
  await new Promise(resolve => setTimeout(resolve, 20)); assert.equal(h.calls(), 0);
});
test('slow body cannot finish after the signed timestamp window', async t => {
  let current = TIME; const h = await harness(t, SECRET, () => current); const body = multipart();
  const request = http.request(h.url + '/gateway/submit', { method: 'POST', headers: { ...headersFor(body), 'Content-Length': body.length } });
  const received = once(request, 'response'); request.write(body.subarray(0, body.length - 1));
  await new Promise(resolve => setTimeout(resolve, 20)); current += 61_000; request.end(body.subarray(-1));
  const [response] = await received; response.resume(); assert.equal(response.statusCode, 401); assert.equal(h.calls(), 0);
});
test('nonce replay state remains bounded and refuses new requests when full', async () => {
  const body = multipart(); let calls = 0;
  const guard = createGatewaySubmit({ secret: SECRET, now: () => TIME,
    upload(req, res, next) { req.once('end', () => next()); req.resume(); },
    limiter(req, res, next) { next(); }, handler() { calls++; }
  });
  for (let i = 0; i <= 10_000; i++) {
    const headers = Object.fromEntries(Object.entries(headersFor(body)).map(([k, v]) => [k.toLowerCase(), v]));
    const req = Readable.from([body]); Object.assign(req, { method: 'POST', originalUrl: '/gateway/submit', complete: true, get: key => headers[key.toLowerCase()] });
    const res = { statusCode: 200, status(value) { this.statusCode = value; return this; }, json() {} };
    await guard(req, res);
    assert.equal(res.statusCode, i < 10_000 ? 200 : 503);
  }
  assert.equal(calls, 10_000);
});

function eventFor(body = multipart()) {
  return { version: '2.0', rawPath: '/submit', rawQueryString: '',
    requestContext: { http: { method: 'POST', path: '/submit', sourceIp: '192.0.2.3' } },
    headers: { 'content-type': TYPE, 'x-forwarded-for': '203.0.113.3', authorization: 'fixture', cookie: 'fixture', 'x-vargi-gateway-ip': '203.0.113.4' },
    isBase64Encoded: true, body: body.toString('base64') };
}
function functionFixture(fetchImpl) {
  return createSubmitHandler({ secret: SECRET, now: () => TIME, nonce: () => (++nonceCounter).toString(16).padStart(32, '0'), fetchImpl });
}
test('private function signs only documented sourceIp, keeps bytes and fixed upstream; end-to-end proof works', async t => {
  const h = await harness(t); let fetches = 0;
  const fn = functionFixture(async (url, options) => {
    fetches++; assert.equal(url, 'https://market-api-production-d9ab.up.railway.app/gateway/submit');
    assert.equal(options.redirect, 'error'); assert.deepEqual(options.body, multipart());
    assert.equal(options.headers['X-Vargi-Gateway-Ip'], '192.0.2.3');
    assert.ok(!('authorization' in options.headers)); assert.ok(!('cookie' in options.headers)); assert.ok(!('x-forwarded-for' in options.headers));
    const upstream = await h.send(options.body, options.headers);
    return new Response(await upstream.arrayBuffer(), { status: upstream.status,
      headers: { 'Content-Type': 'application/json', 'X-Request-Id': 'synthetic-server-trace' } });
  });
  const result = await fn(eventFor()); assert.equal(result.statusCode, 201); assert.equal(fetches, 1);
  assert.equal(result.headers['X-Request-Id'], 'synthetic-server-trace');
});
test('function fails closed for unknown event formats, paths, IPs and base64; rejects size before fetch', async () => {
  let fetches = 0; const fn = functionFixture(async () => { fetches++; throw new Error('unexpected'); });
  const changes = [{ version: '1.0' }, { rawPath: '/admin/login' }, { rawQueryString: 'upstream=elsewhere' },
    { isBase64Encoded: false }, { body: 'invalid===' },
    { requestContext: { http: { method: 'POST', path: '/submit', sourceIp: 'spoof' } } },
    { requestContext: { http: { method: 'POST', path: '/submit', sourceIp: 123 } } }];
  for (const change of changes) assert.equal((await fn({ ...eventFor(), ...change })).statusCode, 400);
  assert.equal((await fn(eventFor(Buffer.alloc(GATEWAY_BODY_LIMIT + 1)))).statusCode, 413);
  assert.equal((await createSubmitHandler({})(eventFor())).statusCode, 503); assert.equal(fetches, 0);
});
test('function does not retry timeouts/redirects; bounded streamed response and mixed content fail closed', async () => {
  let fetches = 0; const failing = functionFixture(async () => { fetches++; throw new Error('timeout or redirect'); });
  assert.equal((await failing(eventFor())).statusCode, 502); assert.equal(fetches, 1);
  let chunksRead = 0;
  const large = functionFixture(async () => new Response(new ReadableStream({ pull(controller) { chunksRead++; controller.enqueue(new Uint8Array(40_000)); } }), { headers: { 'content-type': 'application/json' } }));
  assert.equal((await large(eventFor())).statusCode, 502); assert.ok(chunksRead <= 3);
  for (const body of ['<html>wrong server</html>', '{"unexpected":true}']) {
    const bad = functionFixture(async () => new Response(body, { headers: { 'content-type': body[0] === '<' ? 'text/html' : 'application/json' } }));
    assert.equal((await bad(eventFor())).statusCode, 502);
  }
});
