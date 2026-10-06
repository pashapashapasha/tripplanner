// Fetches, caches and combines Muni + BART data for server.js, which runs both
// locally and as the Vercel function.
import {
  BART, DEFAULT_SETTINGS, DESTINATION, MUNI_CACHE_MS, BART_CACHE_MS, STOPS_CACHE_MS, TIMETABLE_CACHE_MS,
} from './config.js';
import * as muni from './muni.js';
import * as bart from './bart.js';
import * as demo from './demo.js';
import { parseSf, sfDate } from '../public/time.js';

export const DEMO = process.env.DEMO === '1';
export const KEY_511 = process.env.API_511_KEY;
const KEY_BART = process.env.BART_API_KEY || BART.defaultKey;
const DIRECTIONS = ['work', 'home'];
const MIN = 60000;

/** Caches an async fetch; concurrent callers share one request, failures keep stale data. */
function cached(ttl, load) {
  let value, at = 0, error = null, pending = null;
  return async () => {
    const age = Date.now() - at;
    if (at && age < (error ? Math.min(ttl, 60000) : ttl)) return { value, at, error };
    pending ||= load()
      .then((v) => { value = v; error = null; })
      .catch((e) => {
        const cause = e.cause && (e.cause.message || e.cause.code);
        error = cause ? `${e.message} (${cause})` : e.message;
      })
      .finally(() => { at = Date.now(); pending = null; });
    await pending;
    return { value, at, error };
  };
}

/** A small keyed set of `cached` loaders (oldest evicted first). */
function cachedByKey(ttl, load, max = 24) {
  const entries = new Map();
  return (key) => {
    if (!entries.has(key)) {
      if (entries.size >= max) entries.delete(entries.keys().next().value);
      entries.set(key, cached(ttl, () => load(key)));
    }
    return entries.get(key)();
  };
}

function require511() {
  if (!DEMO && !KEY_511) throw new Error('No 511.org API key: set API_511_KEY (free at https://511.org/open-data/token)');
}

const getPlaces = cached(STOPS_CACHE_MS, async () => {
  require511();
  const payload = DEMO ? demo.demoStops() : await muni.fetchStops(KEY_511);
  return muni.resolvePlaces(muni.parseStops(payload));
});

async function places() {
  const { value, error } = await getPlaces();
  if (!value) throw new Error(`Could not load Muni stop list: ${error}`);
  return value;
}

const getMuni = cached(MUNI_CACHE_MS, async () => {
  require511();
  const p = await places();
  const visits = muni.parseVisits(DEMO ? demo.demoStopMonitoring() : await muni.fetchStopMonitoring(KEY_511));
  const allIds = Object.fromEntries(Object.entries(p).map(([k, stops]) => [k, stops.map((s) => s.id)]));
  // Remember which stops J/T actually serve, so timetables are fetched only for those.
  return { legs: muni.muniLegs(visits, allIds), stopIds: muni.stopIdsByPlace(visits, p) };
});

const getBartRide = cachedByKey(60 * MIN, async (dir) =>
  bart.parseRideMinutes(DEMO ? demo.demoDepart(BART[dir]) : await bart.fetchDepart(KEY_BART, BART[dir])));

const getBartLive = cachedByKey(BART_CACHE_MS, async (dir) => {
  const route = BART[dir];
  const ride = (await getBartRide(dir)).value ?? BART.typicalRideMin;
  const fetchedAt = Date.now();
  return bart.parseEtd(DEMO ? demo.demoEtd(route) : await bart.fetchEtd(KEY_BART, route), fetchedAt, route, ride);
});

const source = (r) => ({ ok: !r.error, fetchedAt: r.at, error: r.error, stale: Boolean(r.error && r.value) });
const uniq = (xs) => [...new Set(xs.filter(Boolean))];

/** Live legs for both directions. */
export async function commute() {
  const [m, bw, bh] = await Promise.all([getMuni(), getBartLive('work'), getBartLive('home')]);
  const now = Date.now();
  const fresh = (legs) => (legs || []).filter((l) => l.dep > now - MIN);
  const bartLive = { work: bw, home: bh };
  const legs = {};
  for (const d of DIRECTIONS) {
    legs[d] = { j: fresh(m.value?.legs[d].j), t: fresh(m.value?.legs[d].t), bart: fresh(bartLive[d].value) };
  }
  const bartErr = bw.error || bh.error;
  return {
    now,
    // Lets an open page notice a new deployment and reload itself.
    version: process.env.VERCEL_GIT_COMMIT_SHA || null,
    demo: DEMO,
    destination: DESTINATION,
    defaults: DEFAULT_SETTINGS,
    sources: {
      muni: source(m),
      bart: {
        ok: !bartErr,
        fetchedAt: Math.min(bw.at, bh.at),
        error: bartErr,
        stale: Boolean(bartErr && (bw.value || bh.value)),
      },
    },
    stops: m.value && {
      j: uniq(DIRECTIONS.flatMap((d) => m.value.legs[d].j.flatMap((l) => [l.depStop, l.arrStop]))),
      t: uniq(DIRECTIONS.flatMap((d) => m.value.legs[d].t.flatMap((l) => [l.depStop, l.arrStop]))),
    },
    legs,
  };
}

// --- Scheduled trips (for "depart at" / "arrive by") ---

const getTimetable = cachedByKey(TIMETABLE_CACHE_MS, async (date) => {
  require511();
  const p = await places();
  const ids = (await getMuni()).value?.stopIds || muni.stopIdsByPlace([], p);
  const names = new Map(Object.values(p).flat().map((s) => [s.id, s.name]));
  const dayStart = parseSf(date, '00:00');
  const dayEnd = dayStart + 28 * 60 * MIN; // service runs past midnight
  // A window wide enough whether 511 reads these as local or UTC times.
  const start = `${date}T00:00:00`;
  const end = `${sfDate(dayStart + 36 * 60 * MIN)}T12:00:00`;
  const stopIds = uniq(Object.values(ids).flat());
  const payloads = await Promise.all(stopIds.map((id) =>
    DEMO ? demo.demoTimetable(id, date) : muni.fetchStopTimetable(KEY_511, id, start, end)));
  const visits = payloads
    .flatMap(muni.parseTimetable)
    .filter((v) => v.dep >= dayStart && v.dep < dayEnd)
    .map((v) => ({ ...v, stopName: v.stopName || names.get(v.stopId) }));
  if (!visits.some((v) => v.line === 'J' || v.line === 'T')) {
    throw new Error(`511.org returned no scheduled J/T trips for ${date}`);
  }
  const legs = muni.muniLegs(visits, ids);
  for (const d of DIRECTIONS) for (const k of ['j', 't']) for (const l of legs[d][k]) l.scheduled = true;
  return legs;
});

const getBartSchedule = cachedByKey(TIMETABLE_CACHE_MS, async (key) => {
  const [dir, date, clock] = key.split(' ');
  const route = BART[dir];
  const t = parseSf(date, clock);
  // Each call returns up to 4 trips either side of its time; three calls cover ~±100 min.
  const payloads = await Promise.all([-60, 0, 60].map((offset) => {
    const q = bart.bartQuery(t + offset * MIN);
    return DEMO ? demo.demoDepart(route, t + offset * MIN) : bart.fetchDepart(KEY_BART, route, { ...q, before: 4, after: 4 });
  }));
  const byDep = new Map();
  for (const p of payloads) for (const l of bart.parseScheduledTrips(p, route)) byDep.set(l.dep, l);
  return [...byDep.values()].sort((a, b) => a.dep - b.dep);
});

/** Scheduled legs for both directions around `date` (YYYY-MM-DD) `clock` (HH:MM), SF time. */
export async function schedule(date, clock) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '') || !/^\d{2}:\d{2}$/.test(clock || '')) {
    throw Object.assign(new Error('Expected ?date=YYYY-MM-DD&time=HH:MM'), { status: 400 });
  }
  const [m, bw, bh] = await Promise.all([
    getTimetable(date), getBartSchedule(`work ${date} ${clock}`), getBartSchedule(`home ${date} ${clock}`),
  ]);
  const bartLegs = { work: bw.value || [], home: bh.value || [] };
  const legs = {};
  for (const d of DIRECTIONS) legs[d] = { j: m.value?.[d].j || [], t: m.value?.[d].t || [], bart: bartLegs[d] };
  const bartErr = bw.error || bh.error;
  return {
    date,
    time: clock,
    sources: { muni: source(m), bart: { ok: !bartErr, error: bartErr } },
    legs,
  };
}
