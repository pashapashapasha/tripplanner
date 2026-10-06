// Local dev server (deliberately not named server.js: Vercel would deploy that as the
// whole app). On Vercel, public/ is served statically and api/commute.js runs instead.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { commute, DEMO, KEY_511 } from './lib/commute.js';

const PORT = Number(process.env.PORT || 3000);
const ROOT = fileURLToPath(new URL('.', import.meta.url));

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };

http
  .createServer(async (req, res) => {
    const { pathname } = new URL(req.url, 'http://x');
    try {
      if (pathname === '/api/commute') {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        return res.end(JSON.stringify(await commute()));
      }
      const rel = join('public', pathname === '/' ? 'index.html' : pathname);
      const file = normalize(join(ROOT, rel));
      if (!file.startsWith(ROOT)) throw Object.assign(new Error('forbidden'), { code: 'ENOENT' });
      const body = await readFile(file);
      res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream' });
      res.end(body);
    } catch (e) {
      res.writeHead(e.code === 'ENOENT' || e.code === 'EISDIR' ? 404 : 500, { 'Content-Type': 'text/plain' });
      res.end(e.code === 'ENOENT' ? 'Not found' : String(e.message));
    }
  })
  .listen(PORT, () => {
    console.log(`Commute planner on http://localhost:${PORT}${DEMO ? ' (DEMO data)' : ''}`);
    if (!DEMO && !KEY_511) console.warn('API_511_KEY is not set: Muni (J/T) data will be unavailable.');
  });
