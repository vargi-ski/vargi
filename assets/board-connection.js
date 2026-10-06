(function () {
  'use strict';

  const primaryEndpoint = 'https://market.xn----7sbbfg4a6clj5k.xn--p1ai';
  const fallbackEndpoint = 'https://market-api-production-d9ab.up.railway.app';
  const endpoints = [primaryEndpoint, fallbackEndpoint];
  const version = '2026-10-06.3';
  let activeEndpoint = primaryEndpoint;

  function orderedEndpoints() {
    return [activeEndpoint, ...endpoints.filter(endpoint => endpoint !== activeEndpoint)];
  }

  function isNetworkFailure(error) {
    return Boolean(error) && (error.name === 'AbortError' || error instanceof TypeError);
  }

  async function fetchOnce(base, path, options, timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(base + path, { ...options, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  async function request(path, options = {}, config = {}) {
    if (navigator.onLine === false) {
      throw Object.assign(new Error('Нет подключения к интернету.'), { code: 'OFFLINE' });
    }

    const method = String(options.method || 'GET').toUpperCase();
    const safeMethod = method === 'GET' || method === 'HEAD' || method === 'OPTIONS';
    const safeRetry = config.safeRetry === undefined ? safeMethod : Boolean(config.safeRetry);
    const timeoutMs = Math.max(1000, Number(config.timeoutMs) || 10000);
    const bases = safeRetry ? orderedEndpoints() : [activeEndpoint];
    let lastError = null;
    let lastResponse = null;

    for (let i = 0; i < bases.length; i += 1) {
      const base = bases[i];
      try {
        const response = await fetchOnce(base, path, options, timeoutMs);
        if (response.status >= 500 && safeRetry && i < bases.length - 1) {
          lastResponse = response;
          continue;
        }
        activeEndpoint = base;
        return response;
      } catch (error) {
        if (!isNetworkFailure(error)) throw error;
        lastError = error;
        if (!safeRetry || i === bases.length - 1) break;
      }
    }

    if (lastResponse) return lastResponse;

    const timedOut = lastError?.name === 'AbortError';
    throw Object.assign(
      new Error(timedOut
        ? 'Сервер объявлений не ответил вовремя. Попробуйте ещё раз.'
        : 'Не удалось соединиться с сервером объявлений ни по основному, ни по резервному адресу.'),
      { code: timedOut ? 'TIMEOUT' : 'NETWORK', cause: lastError }
    );
  }

  function assetUrl(url) {
    const value = String(url || '');
    for (const endpoint of endpoints) {
      if (value.startsWith(endpoint)) return activeEndpoint + value.slice(endpoint.length);
    }
    return value;
  }

  function alternateUrl(url) {
    const value = String(url || '');
    if (value.startsWith(primaryEndpoint)) return fallbackEndpoint + value.slice(primaryEndpoint.length);
    if (value.startsWith(fallbackEndpoint)) return primaryEndpoint + value.slice(fallbackEndpoint.length);
    return '';
  }

  async function health(timeoutMs = 8000) {
    try {
      const response = await request(
        '/health',
        { mode: 'cors', credentials: 'omit', cache: 'no-store' },
        { timeoutMs: Math.max(2500, Math.floor(timeoutMs / endpoints.length)), safeRetry: true }
      );
      const result = await response.json();
      return response.ok && result.ok === true;
    } catch (_) {
      return false;
    }
  }

  async function send(data, timeoutMs = 120000) {
    if (navigator.onLine === false) {
      throw Object.assign(new Error('Нет подключения к интернету. Подключитесь и повторите отправку.'), { code: 'OFFLINE' });
    }

    const hasRequestId = Boolean(
      data && typeof data.get === 'function' && String(data.get('requestId') || '').trim()
    );
    const attempts = hasRequestId ? endpoints.length : 1;
    const perAttemptTimeout = Math.max(10000, Math.floor(timeoutMs / attempts));
    let response;

    try {
      response = await request(
        '/submit',
        { method: 'POST', body: data, mode: 'cors', credentials: 'omit' },
        { timeoutMs: perAttemptTimeout, safeRetry: hasRequestId }
      );

      let result;
      try {
        result = await response.json();
      } catch (_) {
        throw Object.assign(
          new Error('Сервер прислал неполный ответ. Повторите отправку — повторная заявка не создастся.'),
          { code: 'RESPONSE', status: response.status }
        );
      }

      if (response.status === 429) {
        const seconds = Number(result.retryAfter || response.headers.get('Retry-After')) || 900;
        throw Object.assign(
          new Error('Слишком много попыток. Повторите через ' + Math.ceil(seconds / 60) + ' мин.'),
          { code: 'RATE_LIMIT', status: 429 }
        );
      }

      if (!response.ok || !result.ok || !result.id) {
        throw Object.assign(
          new Error(result.error || 'Сервер не подтвердил сохранение. Повторите отправку.'),
          { code: 'SERVER', status: response.status }
        );
      }

      return result;
    } catch (error) {
      if (error.code === 'OFFLINE') throw error;
      if (error.code === 'TIMEOUT') {
        throw Object.assign(
          new Error('Сервер не успел ответить. Основной и резервный каналы проверены. Повторите отправку — повторная заявка не создастся.'),
          { code: 'TIMEOUT' }
        );
      }
      if (error.code === 'NETWORK') {
        throw Object.assign(
          new Error('Браузер не смог соединиться с сервером объявлений. Основной и резервный адреса недоступны из этой сети. Попробуйте другую сеть или обычный браузер.'),
          { code: 'NETWORK' }
        );
      }
      if (error.name === 'AbortError') {
        throw Object.assign(
          new Error('Сервер не успел ответить. Повторите отправку — повторная заявка не создастся.'),
          { code: 'TIMEOUT' }
        );
      }
      if (error instanceof TypeError) {
        throw Object.assign(
          new Error('Браузер не смог соединиться с сервером объявлений. Попробуйте другую сеть или откройте сайт в обычном браузере.'),
          { code: 'NETWORK' }
        );
      }
      error.trace = response?.headers.get('X-Request-Id') || '';
      throw error;
    }
  }

  window.VargiConnection = {
    health,
    send,
    request,
    assetUrl,
    alternateUrl,
    version,
    endpoints: [...endpoints],
    get base() { return activeEndpoint; },
    get active() { return activeEndpoint; }
  };
})();
