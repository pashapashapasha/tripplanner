import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BART, DEFAULT_SETTINGS, DESTINATION, MUNI_CACHE_MS, BART_CACHE_MS, STOPS_CACHE_MS } from './lib/config.js';
import * as muni from './lib/muni.js';
import * as bart from './lib/bart.js';
import * as demo from './lib/demo.js';

const PORT = Number(process.env.PORT || 3000);
const DEMO = process.env.DEMO === '1';
const KEY_511 = process.env.API_511_KEY;
const KEY_BART = process.env.BART_API_KEY || BART.defaultKey;
const ROOT = fileURLToPath(new URL('.', import.meta.url));

/** Caches an async fetch; concurrent callers share one request, failures keep stale data. */
function cached(ttl, load) {
  let value, at = 0, error = null, pending = null;
  return async () => {
    const age = Date.now() - at;
    if (at && age < (error ? Math.min(ttl, 60000) : ttl)) return { value, at, error };
    pending ||= load()
      .then((v) => { value = v; error = null; })
      .catch((e) => { error = e.message; })
      .finally(() => { at = Date.now(); pending = null; });
    await pending;
    return { value, at, error };
  };
}

const getPlaces = cached(STOPS_CACHE_MS, async () => {
  const payload = DEMO ? demo.demoStops() : await muni.fetchStops(KEY_511);
  return muni.resolvePlaces(muni.parseStops(payload));
});
const getMuni = cached(MUNI_CACHE_MS, async () => {
  if (!DEMO && !KEY_511) throw new Error('No 511.org API key: set API_511_KEY (free at https://511.org/open-data/token)');
  const places = (await getPlaces()).value;
  if (!places) throw new Error('Could not load Muni stop list from 511.org');
  const payload = DEMO ? demo.demoStopMonitoring() : await muni.fetchStopMonitoring(KEY_511);
  return { ...muni.muniLegs(payload, places), places };
});
const getBartRide = cached(60 * 60 * 1000, async () =>
  bart.parseRideMinutes(DEMO ? demo.demoSchedule() : await bart.fetchSchedule(KEY_BART)));
const getBart = cached(BART_CACHE_MS, async () => {
  const ride = (await getBartRide()).value ?? BART.typicalRideMin;
  const fetchedAt = Date.now();
  return bart.parseEtd(DEMO ? demo.demoEtd() : await bart.fetchEtd(KEY_BART), fetchedAt, ride);
});

async function commute() {
  const [m, b] = await Promise.all([getMuni(), getBart()]);
  const now = Date.now();
  const fresh = (legs) => (legs || []).filter((l) => l.dep > now - 60000);
  const names = (legs, key) => [...new Set((legs || []).map((l) => l[key]).filter(Boolean))];
  return {
    now,
    demo: DEMO,
    destination: DESTINATION,
    defaults: DEFAULT_SETTINGS,
    sources: {
      muni: { ok: !m.error, fetchedAt: m.at, error: m.error, stale: Boolean(m.error && m.value) },
      bart: { ok: !b.error, fetchedAt: b.at, error: b.error, stale: Boolean(b.error && b.value) },
    },
    stops: m.value && {
      jOrigin: names(m.value.j, 'depStop'),
      jPowell: names(m.value.j, 'arrStop'),
      tOrigin: names(m.value.t, 'depStop'),
      tDest: names(m.value.t, 'arrStop'),
    },
    legs: { j: fresh(m.value?.j), t: fresh(m.value?.t), bart: fresh(b.value) },
  };
}

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
// The browser imports the shared itinerary module straight from lib/.
const SHARED = new Set(['/lib/itinerary.js']);

http
  .createServer(async (req, res) => {
    const { pathname } = new URL(req.url, 'http://x');
    try {
      if (pathname === '/api/commute') {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        return res.end(JSON.stringify(await commute()));
      }
      const rel = SHARED.has(pathname) ? pathname : join('public', pathname === '/' ? 'index.html' : pathname);
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
