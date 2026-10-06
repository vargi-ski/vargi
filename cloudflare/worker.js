const PREFIX = '/api/market';
const DEFAULT_ORIGIN = 'https://market-api-production-d9ab.up.railway.app';

function cacheTtl(pathname) {
  if (pathname === '/listings') return 60;
  return 0;
}

export default {
  async fetch(request, env, ctx) {
    const incoming = new URL(request.url);
    if (incoming.pathname !== PREFIX && !incoming.pathname.startsWith(PREFIX + '/')) {
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

    const ttl = request.method === 'GET' && !headers.has('authorization') && !headers.has('cookie')
      ? cacheTtl(upstreamPath) : 0;
    if (ttl > 0) {
      init.cf = {
        cacheEverything: true,
        cacheTtlByStatus: {
          '200': ttl,
          '201-599': -1
        }
      };
    } else {
      // Cards and photos must reflect moderation changes immediately.
      init.cache = 'no-store';
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
    // Browser caches must never retain contacts or photos after removal.
    // Only the anonymous catalogue may have an edge TTL of up to 60 seconds.
    outgoing.headers.set('cache-control', 'no-store');
    return outgoing;
  }
};
