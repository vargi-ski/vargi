import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';

export const GATEWAY_BODY_LIMIT = 2_000_000;
export const GATEWAY_SUBMIT_PATH = '/gateway/submit';
const HEX64 = /^[a-f0-9]{64}$/;
const NONCE = /^[a-f0-9]{32}$/;
const MULTIPART = /^multipart\/form-data;\s*boundary=(?:"[A-Za-z0-9'()+_,\-./:=? ]{1,70}"|[A-Za-z0-9'()+_,\-./:=?]{1,70})$/i;

export function gatewaySecret(value) {
  return typeof value === 'string' && HEX64.test(value) ? Buffer.from(value, 'hex') : null;
}

export function gatewaySignature(secret, proof) {
  return createHmac('sha256', secret).update(JSON.stringify([
    'vargi-gateway-v1', 'POST', GATEWAY_SUBMIT_PATH, proof.timestamp,
    proof.nonce, proof.clientIp, proof.contentType, proof.size, proof.digest
  ])).digest('hex');
}

function proofFrom(req, secret, now) {
  const header = name => String(req.get(name) || '');
  const proof = {
    timestamp: header('x-vargi-gateway-time'),
    nonce: header('x-vargi-gateway-nonce'),
    clientIp: header('x-vargi-gateway-ip'),
    contentType: header('content-type'),
    size: header('x-vargi-gateway-size'),
    digest: header('x-vargi-gateway-sha256')
  };
  const signature = header('x-vargi-gateway-signature');
  if (req.method !== 'POST' || req.originalUrl !== GATEWAY_SUBMIT_PATH ||
      !/^\d{10}$/.test(proof.timestamp) || !NONCE.test(proof.nonce) ||
      !isIP(proof.clientIp) || !MULTIPART.test(proof.contentType) ||
      !/^[1-9]\d{0,6}$/.test(proof.size) || Number(proof.size) > GATEWAY_BODY_LIMIT ||
      !HEX64.test(proof.digest) || !HEX64.test(signature)) throw { status: 400 };
  const age = now - Number(proof.timestamp) * 1000;
  if (age > 60_000 || age < -15_000 ||
      !timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(gatewaySignature(secret, proof), 'hex'))) {
    throw { status: 401 };
  }
  return proof;
}

function watchBody(req) {
  const hash = createHash('sha256');
  let size = 0;
  let settled = false;
  let resolveBody, rejectBody;
  const completion = new Promise((resolve, reject) => { resolveBody = resolve; rejectBody = reject; });
  const fail = status => { if (!settled) { settled = true; rejectBody({ status }); } };
  const data = chunk => {
    size += chunk.length;
    if (size > GATEWAY_BODY_LIMIT) return fail(413);
    if (!settled) hash.update(chunk);
  };
  const end = () => {
    if (!settled) { settled = true; resolveBody({ size, digest: hash.digest('hex') }); }
  };
  const aborted = () => fail(400);
  const close = () => { if (!req.complete) fail(400); };
  req.on('data', data);
  req.once('end', end);
  req.once('aborted', aborted);
  req.once('error', aborted);
  req.once('close', close);
  return {
    completion,
    cleanup() {
      req.off('data', data); req.off('end', end); req.off('aborted', aborted);
      req.off('error', aborted); req.off('close', close);
    }
  };
}

function reply(res, status) {
  if (res.headersSent || res.destroyed) return;
  const error = status === 503 ? 'Дополнительный канал отправки пока не настроен.'
    : status === 413 ? 'Подготовленные фото слишком большие для отправки. Уменьшите их размер.'
    : 'Не удалось проверить запрос. Повторите отправку из формы объявления.';
  res.status(status).json({ ok: false, error });
}

// The tee only hashes the stream. Multer remains the sole multipart parser.
// The proof is checked before parsing, and the actual bytes before any effect.
export function createGatewaySubmit({ secret: value, upload, limiter, handler, now = Date.now }) {
  const secret = gatewaySecret(value);
  const seen = new Map(); // Single-process replay guard; requestId survives restarts.
  return async function gatewaySubmit(req, res) {
    let watched;
    try {
      if (!secret) throw { status: 503 };
      const time = now();
      const proof = proofFrom(req, secret, time);
      for (const [nonce, expiry] of seen) if (expiry < time) seen.delete(nonce);
      if (seen.has(proof.nonce)) throw { status: 401 };
      if (seen.size >= 10_000) throw { status: 503 };
      watched = watchBody(req);
      const parsed = new Promise((resolve, reject) => {
        upload(req, res, error => error ? reject({ status: 400 }) : resolve());
      });
      const [body] = await Promise.all([watched.completion, parsed]);
      if (body.size !== Number(proof.size) || body.digest !== proof.digest) throw { status: 401 };
      const age = now() - Number(proof.timestamp) * 1000;
      if (age > 60_000 || age < -15_000) throw { status: 401 };
      // A parallel replay may have completed while this request was being read.
      if (seen.has(proof.nonce)) throw { status: 401 };
      if (seen.size >= 10_000) throw { status: 503 };
      seen.set(proof.nonce, Number(proof.timestamp) * 1000 + 60_001);
      req.verifiedGatewayIp = proof.clientIp;
      limiter(req, res, () => handler(req, res));
    } catch (error) {
      req.unpipe();
      req.resume();
      reply(res, Number(error?.status) || 400);
    } finally {
      watched?.cleanup();
    }
  };
}
