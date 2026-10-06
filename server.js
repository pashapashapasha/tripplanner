// App entry point, locally (`npm start`) and on Vercel, which detects server.js and runs
// it as a function. (Keep it the only file named server/app/index.js: Vercel picks such
// files as the entry point, even inside public/.) On Vercel, public/ is served by the CDN; the
// static handling below is the fallback, and what serves them locally.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const PORT = Number(process.env.PORT || 3000);
// process.cwd() rather than import.meta.url, which may be unset when Vercel bundles this file.
const PUBLIC = join(process.cwd(), 'public');
const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/planner-ui.js': ['planner-ui.js', 'text/javascript; charset=utf-8'],
  '/itinerary.js': ['itinerary.js', 'text/javascript; charset=utf-8'],
  '/styles.css': ['styles.css', 'text/css; charset=utf-8'],
};

function send(res, status, type, body, cacheControl = 'no-store') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': cacheControl });
  res.end(body);
}

async function handle(req, res) {
  const { pathname } = new URL(req.url, 'http://localhost');
  if (pathname === '/api/commute') {
    // Imported lazily so even a load-time failure is reported as JSON, not a crash.
    const { commute } = await import('./lib/commute.js');
    // Let Vercel's CDN share one response across viewers for a short while, which keeps
    // us well under 511.org's 60 requests/hour even with several tabs open.
    return send(res, 200, 'application/json', JSON.stringify(await commute()),
      'public, max-age=0, s-maxage=30, stale-while-revalidate=30');
  }
  const file = STATIC[pathname];
  if (!file) return send(res, 404, 'text/plain', 'Not found');
  send(res, 200, file[1], await readFile(join(PUBLIC, file[0])), 'public, max-age=60');
}

http
  .createServer((req, res) => {
    handle(req, res).catch((e) => {
      console.error(e);
      if (!res.headersSent) send(res, 500, 'application/json', JSON.stringify({ error: `${e.name}: ${e.message}` }));
      else res.end();
    });
  })
  .listen(PORT, () => {
    console.log(`Commute planner on http://localhost:${PORT}${process.env.DEMO === '1' ? ' (DEMO data)' : ''}`);
    if (process.env.DEMO !== '1' && !process.env.API_511_KEY) {
      console.warn('API_511_KEY is not set: Muni (J/T) data will be unavailable.');
    }
  });
