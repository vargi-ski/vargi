import http from 'node:http';

http.createServer(async (req, res) => {
  try {
    let bytes = 0;
    for await (const chunk of req) bytes += chunk.length;
    res.writeHead(req.url === '/failure' ? 503 : 200, {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=3600',
      'CDN-Cache-Control': 'public, max-age=3600'
    });
    res.end(JSON.stringify({ method: req.method, url: req.url, bytes, host: req.headers.host,
      forwarded: req.headers.forwarded || null, forwardedFor: req.headers['x-forwarded-for'] }));
  } catch {
    res.writeHead(413);
    res.end();
  }
}).listen(3000, '0.0.0.0');
