// Local dev server: serves public/ and routes /api/* to the Vercel function.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import handler from './api/index.js';

const PORT = Number(process.env.PORT || 3000);
const PUBLIC = path.resolve('./public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.json': 'application/json' };

http.createServer((req, res) => {
  // Mimic the two Vercel response helpers the handler uses.
  res.status = (code) => { res.statusCode = code; return res; };
  const url = new URL(req.url, 'http://x');
  if (url.pathname.startsWith('/api/')) return handler(req, res);
  const file = path.join(PUBLIC, path.normalize('/' + (url.pathname === '/' ? 'index.html' : url.pathname)));
  if (!file.startsWith(PUBLIC) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.statusCode = 404; return res.end('Not found'); }
  res.setHeader('content-type', MIME[path.extname(file)] || 'application/octet-stream');
  fs.createReadStream(file).pipe(res);
}).listen(PORT, () => console.log(`Sip Squad dev server at http://localhost:${PORT}`));
