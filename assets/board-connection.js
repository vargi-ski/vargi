(function () {
  'use strict';

  const siteOrigin = (window.location && window.location.origin)
    ? window.location.origin
    : 'https://xn----7sbbfg4a6clj5k.xn--p1ai';

  const proxyEndpoint = siteOrigin + '/api/market';
  const primaryEndpoint = 'https://market.xn----7sbbfg4a6clj5k.xn--p1ai';
  const fallbackEndpoint = 'https://market-api-production-d9ab.up.railway.app';
  const deployment = window.VARGI_MARKET_CONFIG || {};
  const gatewayMode = deployment.transport === 'gateway';
  let configurationInvalid = deployment.transport !== undefined && !['gateway', 'railway'].includes(deployment.transport);
  let gatewayEndpoint = '';
  if (gatewayMode) {
    try {
      const url = new URL(deployment.gatewayEndpoint);
      const raw = String(deployment.gatewayEndpoint || '');
      if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash ||
          (raw !== url.origin && raw !== url.origin + '/')) throw new Error('invalid_gateway_origin');
      gatewayEndpoint = url.origin;
    } catch (_) { configurationInvalid = true; }
  }
  const legacyEndpoints = [proxyEndpoint, primaryEndpoint, fallbackEndpoint];
  const endpoints = gatewayMode ? (gatewayEndpoint ? [gatewayEndpoint] : []) : legacyEndpoints;
  const assetEndpoints = [...new Set([...legacyEndpoints, gatewayEndpoint].filter(Boolean))];
  const maxSubmissionBytes = gatewayMode ? 2000000 : null;
  const version = '2026-10-07.7';
  let activeEndpoint = gatewayMode ? gatewayEndpoint : proxyEndpoint;

  function checkConfiguration() {
    if (configurationInvalid) throw Object.assign(new Error('Настройка подключения к серверу некорректна. Повторите позже.'), { code: 'CONFIG' });
  }

  function orderedEndpoints() {
    return [activeEndpoint, ...endpoints.filter(endpoint => endpoint !== activeEndpoint)];
  }

  function isNetworkFailure(error) {
    return Boolean(error) && (error.name === 'AbortError' || error instanceof TypeError);
  }

  function shouldFailOver(base, response, safeRetry) {
    if (!safeRetry) return false;
    if (response.status >= 500) return true;
    if (base === proxyEndpoint && [404, 405, 410, 501].includes(response.status)) return true;
    return false;
  }

  function isUnavailableProxyRoute(base, response) {
    const contentType = (response.headers.get('Content-Type') || '').split(';')[0].trim().toLowerCase();
    return base === proxyEndpoint &&
      [404, 405, 410, 501].includes(response.status) && contentType === 'text/html';
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
    checkConfiguration();
    if (navigator.onLine === false) {
      throw Object.assign(new Error('Нет подключения к интернету.'), { code: 'OFFLINE' });
    }

    const method = String(options.method || 'GET').toUpperCase();
    const safeMethod = method === 'GET' || method === 'HEAD' || method === 'OPTIONS';
    const safeRetry = config.safeRetry === undefined ? safeMethod : Boolean(config.safeRetry);
    const timeoutMs = Math.max(1000, Number(config.timeoutMs) || 6000);
    const bases = safeRetry ? orderedEndpoints() : [activeEndpoint];
    let lastError = null;
    let lastResponse = null;

    for (let i = 0; i < bases.length; i += 1) {
      const base = bases[i];
      try {
        const response = await fetchOnce(base, path, options, timeoutMs);
        // GitHub Pages returns an HTML error while the optional proxy is absent.
        // Skip it even when it is last: it must not conceal the real API failure.
        if (!gatewayMode && safeRetry && isUnavailableProxyRoute(base, response)) continue;
        if (shouldFailOver(base, response, safeRetry) && i < bases.length - 1) {
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
        ? 'Сервер объявлений не ответил вовремя.'
        : 'Не удалось соединиться с сервером объявлений по доступным каналам.'),
      { code: timedOut ? 'TIMEOUT' : 'NETWORK', cause: lastError }
    );
  }

  function endpointSuffix(value, endpoint) {
    if (value === endpoint) return '';
    if (value.startsWith(endpoint) && ['/', '?', '#'].includes(value[endpoint.length])) return value.slice(endpoint.length);
    return null;
  }

  function assetUrl(url) {
    const value = String(url || '');
    for (const endpoint of assetEndpoints) {
      const suffix = endpointSuffix(value, endpoint);
      if (suffix !== null) return activeEndpoint + suffix;
    }
    return value;
  }

  function alternateUrl(url) {
    if (gatewayMode) return '';
    const value = String(url || '');
    for (let i = 0; i < endpoints.length; i += 1) {
      const endpoint = endpoints[i];
      const suffix = endpointSuffix(value, endpoint);
      if (suffix !== null) {
        const next = endpoints[(i + 1) % endpoints.length];
        return next + suffix;
      }
    }
    return '';
  }

  async function health(timeoutMs = 8000) {
    try {
      const response = await request(
        '/health',
        { mode: 'cors', credentials: 'omit', cache: 'no-store' },
        { timeoutMs: Math.max(1800, Math.floor(timeoutMs / Math.max(1, endpoints.length))), safeRetry: true }
      );
      const result = await response.json();
      return response.ok && result.ok === true;
    } catch (_) {
      return false;
    }
  }

  async function send(data, timeoutMs = 120000) {
    checkConfiguration();
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
      const options = { method: 'POST', body: data, mode: 'cors', credentials: 'omit' };
      if (gatewayMode) {
        if (!data || typeof data.get !== 'function' || typeof data.entries !== 'function') {
          throw Object.assign(new Error('Не удалось подготовить заявку. Вернитесь к редактированию и повторите.'), { code: 'PAYLOAD' });
        }
        // Measure the exact multipart that will be transmitted, including UTF-8
        // fields, filenames, boundaries and headers. Never recompress on retry.
        const serialized = new Request(gatewayEndpoint + '/submit', { method: 'POST', body: data });
        const contentType = serialized.headers.get('Content-Type') || '';
        if (!contentType.toLowerCase().startsWith('multipart/form-data; boundary=')) {
          throw Object.assign(new Error('Не удалось подготовить заявку. Вернитесь к редактированию и повторите.'), { code: 'PAYLOAD' });
        }
        const body = await serialized.blob();
        if (body.size > maxSubmissionBytes) {
          throw Object.assign(new Error('Заявка вместе с фотографиями превышает 2 МБ. Уберите часть фото или выберите меньшие файлы. Данные остались в этой вкладке.'), { code: 'PAYLOAD_LIMIT', status: 413 });
        }
        options.body = body;
        options.headers = { 'Content-Type': contentType };
      }
      response = await request(
        '/submit',
        options,
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
          new Error(gatewayMode
            ? 'Сервер не успел ответить. Повторите отправку — повторная заявка не создастся.'
            : 'Сервер не успел ответить. Запрос проверен через основной и резервные каналы. Повторите отправку — повторная заявка не создастся.'),
          { code: 'TIMEOUT' }
        );
      }
      if (error.code === 'NETWORK') {
        throw Object.assign(
          new Error('Браузер не смог соединиться с сервером объявлений. Попробуйте другую сеть или обычный браузер.'),
          { code: 'NETWORK' }
        );
      }
      if (error.name === 'AbortError') {
        throw Object.assign(new Error('Сервер не успел ответить.'), { code: 'TIMEOUT' });
      }
      if (error instanceof TypeError) {
        throw Object.assign(new Error('Браузер не смог соединиться с сервером объявлений.'), { code: 'NETWORK' });
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
    transport: gatewayMode ? 'gateway' : 'railway',
    maxSubmissionBytes,
    endpoints: [...endpoints],
    get base() { return activeEndpoint; },
    get active() { return activeEndpoint; }
  };
})();
