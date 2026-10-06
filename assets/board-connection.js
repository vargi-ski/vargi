(function () {
  'use strict';
  const endpoint = 'https://market-api-production-d9ab.up.railway.app';
  const version = '2026-10-06';
  async function health(timeoutMs = 8000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(endpoint + '/health', { mode: 'cors', credentials: 'omit', cache: 'no-store', signal: controller.signal });
      const result = await response.json();
      return response.ok && result.ok === true;
    } catch (_) { return false; }
    finally { clearTimeout(timer); }
  }
  async function send(data, timeoutMs = 120000) {
    if (navigator.onLine === false) throw Object.assign(new Error('Нет подключения к интернету. Подключитесь и повторите отправку.'), { code: 'OFFLINE' });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      response = await fetch(endpoint + '/submit', { method: 'POST', body: data, mode: 'cors', credentials: 'omit', signal: controller.signal });
      let result;
      try { result = await response.json(); }
      catch (_) { throw Object.assign(new Error('Сервер прислал неполный ответ. Повторите отправку — повторная заявка не создастся.'), { code: 'RESPONSE', status: response.status }); }
      if (response.status === 429) {
        const seconds = Number(result.retryAfter || response.headers.get('Retry-After')) || 900;
        throw Object.assign(new Error('Слишком много попыток. Повторите через ' + Math.ceil(seconds / 60) + ' мин.'), { code: 'RATE_LIMIT', status: 429 });
      }
      if (!response.ok || !result.ok || !result.id) throw Object.assign(new Error(result.error || 'Сервер не подтвердил сохранение. Повторите отправку.'), { code: 'SERVER', status: response.status });
      return result;
    } catch (error) {
      if (error.name === 'AbortError') throw Object.assign(new Error('Сервер не успел ответить. Повторите отправку — повторная заявка не создастся.'), { code: 'TIMEOUT' });
      if (error instanceof TypeError) throw Object.assign(new Error('Браузер не смог соединиться с сервером объявлений. Попробуйте другую сеть или откройте сайт в обычном браузере. Можно передать объявление через кнопку Telegram.'), { code: 'NETWORK' });
      error.trace = response?.headers.get('X-Request-Id') || '';
      throw error;
    } finally { clearTimeout(timer); }
  }
  window.VargiConnection = { health, send, version };
})();
