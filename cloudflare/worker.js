const PREFIX = '/api/market';
const DEFAULT_ORIGIN = 'https://market-api-production-d9ab.up.railway.app';

function cacheTtl(pathname) {
  if (pathname === '/health') return 0;
  if (pathname === '/listings') return 60;
  if (/^\/listings\/[^/]+\/photos\//.test(pathname)) return 60 * 60 * 24 * 30;
  if (/^\/listings\/[^/]+$/.test(pathname)) return 300;
  return 0;
}

export default {
  async fetch(request, env, ctx) {
    const incoming = new URL(request.url);
    if (!incoming.pathname.startsWith(PREFIX)) {
      return new Response('Not found', { status: 404 });
    }

    const upstreamPath = incoming.pathname.slice(PREFIX.length) || '/';
    const upstreamBase = new URL(env.MARKET_ORIGIN || DEFAULT_ORIGIN);
    const target = new URL(upstreamBase.toString());
    target.pathname = upstreamPath;
    target.search = incoming.search;

    const headers = new Headers(request.headers);
    headers.delete('host');
    headers.set('x-vargi-edge-proxy', 'cloudflare');

    const init = {
      method: request.method,
      headers,
      redirect: 'manual'
    };

    if (request.method !== 'GET' && request.method !== 'HEAD') {
      init.body = request.body;
    }

    const ttl = request.method === 'GET' ? cacheTtl(upstreamPath) : 0;
    if (ttl > 0) {
      init.cf = {
        cacheEverything: true,
        cacheTtl: ttl,
        cacheTtlByStatus: {
          '200-299': ttl,
          '404': 5,
          '500-599': 0
        }
      };
    }

    let response;
    try {
      response = await fetch(target.toString(), init);
    } catch (error) {
      return new Response(JSON.stringify({
        ok: false,
        error: 'edge_upstream_unreachable'
      }), {
        status: 502,
        headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
      });
    }

    const outgoing = new Response(response.body, response);
    outgoing.headers.set('x-vargi-edge', 'cloudflare');
    if (ttl > 0 && response.ok) {
      outgoing.headers.set('cache-control', 'public, max-age=' + ttl);
    } else if (upstreamPath.startsWith('/admin') || upstreamPath === '/submit' || upstreamPath === '/health') {
      outgoing.headers.set('cache-control', 'no-store');
    }
    return outgoing;
  }
};
