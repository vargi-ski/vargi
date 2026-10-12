import { createHash, createHmac, randomBytes } from 'node:crypto';
import { isIP } from 'node:net';

const UPSTREAM = 'https://market-api-production-d9ab.up.railway.app/gateway/submit';
const BODY_LIMIT = 2_000_000;
const RESPONSE_LIMIT = 64_000;
const MULTIPART = /^multipart\/form-data;\s*boundary=(?:"[A-Za-z0-9'()+_,\-./:=? ]{1,70}"|[A-Za-z0-9'()+_,\-./:=?]{1,70})$/i;

function answer(statusCode, error) {
  return { statusCode, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
    isBase64Encoded: false, body: JSON.stringify({ ok: false, error }) };
}

async function responseBytes(response) {
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body || []) {
    size += chunk.length;
    if (size > RESPONSE_LIMIT) throw new Error('upstream_response_size');
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

// The function must stay private: only the Gateway service account may invoke it.
// Pin payload_format_version: '2.0'; never infer the client IP from headers.
export function createSubmitHandler({ secret: value, fetchImpl = fetch, now = Date.now,
  nonce = () => randomBytes(16).toString('hex') } = {}) {
  const secret = typeof value === 'string' && /^[a-f0-9]{64}$/.test(value) ? Buffer.from(value, 'hex') : null;
  return async function submit(event) {
    if (!secret) return answer(503, 'Дополнительный канал отправки пока не настроен.');
    const http = event?.requestContext?.http;
    const contentType = Object.entries(event?.headers || {}).find(([key]) => key.toLowerCase() === 'content-type')?.[1];
    if (event?.version !== '2.0' || event.rawPath !== '/submit' || event.rawQueryString ||
        http?.method !== 'POST' || http.path !== '/submit' || typeof http.sourceIp !== 'string' || !isIP(http.sourceIp) ||
        typeof contentType !== 'string' || !MULTIPART.test(contentType) ||
        event.isBase64Encoded !== true || typeof event.body !== 'string') {
      return answer(400, 'Не удалось проверить запрос. Повторите отправку из формы объявления.');
    }
    if (event.body.length > Math.ceil(BODY_LIMIT / 3) * 4) return answer(413, 'Подготовленные фото слишком большие для отправки.');
    if (event.body.length % 4 || /[^A-Za-z0-9+/=]/.test(event.body)) return answer(400, 'Не удалось проверить запрос.');
    const body = Buffer.from(event.body, 'base64');
    if (body.toString('base64') !== event.body) return answer(400, 'Не удалось проверить запрос.');
    if (!body.length || body.length > BODY_LIMIT) return answer(413, 'Подготовленные фото слишком большие для отправки.');
    const timestamp = String(Math.floor(now() / 1000));
    const requestNonce = nonce();
    const size = String(body.length);
    const digest = createHash('sha256').update(body).digest('hex');
    const signature = createHmac('sha256', secret).update(JSON.stringify([
      'vargi-gateway-v1', 'POST', '/gateway/submit', timestamp,
      requestNonce, http.sourceIp, contentType, size, digest
    ])).digest('hex');
    // Do not copy Host, Authorization, X-Forwarded-For, or caller proof headers.
    const headers = {
      'Content-Type': contentType,
      'X-Vargi-Gateway-Time': timestamp, 'X-Vargi-Gateway-Nonce': requestNonce,
      'X-Vargi-Gateway-Ip': http.sourceIp, 'X-Vargi-Gateway-Size': size,
      'X-Vargi-Gateway-Sha256': digest, 'X-Vargi-Gateway-Signature': signature
    };
    const origin = Object.entries(event.headers).find(([key]) => key.toLowerCase() === 'origin')?.[1];
    if (typeof origin === 'string' && origin.length < 256 && !/[\r\n]/.test(origin)) headers.Origin = origin;
    try {
      // A timeout has an uncertain outcome; the browser retries the same requestId.
      const response = await fetchImpl(UPSTREAM, {
        method: 'POST', body, headers, redirect: 'error', signal: AbortSignal.timeout(105_000)
      });
      const result = await responseBytes(response);
      if (!/^application\/json(?:;|$)/i.test(response.headers.get('content-type') || '')) throw new Error('upstream_format');
      const parsed = JSON.parse(result);
      if (typeof parsed?.ok !== 'boolean' || !Number.isInteger(response.status) || response.status < 200 || response.status > 599) throw new Error('upstream_format');
      const replyHeaders = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };
      for (const name of ['retry-after', 'access-control-allow-origin', 'access-control-expose-headers', 'vary']) {
        const val = response.headers.get(name);
        if (val && val.length < 1024 && !/[\r\n]/.test(val)) replyHeaders[name] = val;
      }
      const trace = response.headers.get('x-request-id');
      if (trace && trace.length <= 128 && !/[\r\n]/.test(trace)) replyHeaders['X-Request-Id'] = trace;
      return { statusCode: response.status, headers: replyHeaders, isBase64Encoded: false, body: result };
    } catch {
      return answer(502, 'Сервер не подтвердил сохранение. Данные и фото остались в вашей вкладке — повторите отправку.');
    }
  };
}

export const handler = createSubmitHandler({ secret: process.env.GATEWAY_SUBMIT_SECRET });
