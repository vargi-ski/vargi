// Caddy's isolated CI virtual host is localhost. Node fetch ignores a manually
// supplied Host header, so the hostname must be present in the URL itself.
export function createEdgeRequest(port) {
  const origin = `http://localhost:${port}`;
  return (pathname, options = {}) => {
    const headers = new Headers(options.headers);
    if (headers.has('host')) throw new Error('Set the virtual host in the URL, not a fetch Host header');
    return fetch(origin + pathname, {
      ...options, headers, signal: options.signal || AbortSignal.timeout(15000)
    });
  };
}
