// Fetches, caches and combines Muni + BART data for server.js, which runs both
// locally and as the Vercel function.
import {
  BART, DEFAULT_SETTINGS, DESTINATION, MUNI_CACHE_MS, BART_CACHE_MS, STOPS_CACHE_MS, TIMETABLE_CACHE_MS,
} from './config.js';
import * as muni from './muni.js';
import * as bart from './bart.js';
import * as demo from './demo.js';
import { TZ, parseSf, sfDate, addDays } from '../public/time.js';

export const DEMO = process.env.DEMO === '1';
export const KEY_511 = process.env.API_511_KEY;
const KEY_BART = process.env.BART_API_KEY || BART.defaultKey;
const DIRECTIONS = ['work', 'home'];
const MIN = 60000;

/**
 * Caches an async fetch; concurrent callers share one request, failures keep stale data.
 * Failures are retried after `errorTtl`.
 */
function cached(ttl, load, errorTtl = Math.min(ttl, 60000)) {
  let value, at = 0, error = null, pending = null;
  return async () => {
    const age = Date.now() - at;
    if (at && age < (error ? errorTtl : ttl)) return { value, at, error };
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
function cachedByKey(ttl, load, { max = 24, errorTtl } = {}) {
  const entries = new Map();
  return (key) => {
    if (!entries.has(key)) {
      if (entries.size >= max) entries.delete(entries.keys().next().value);
      entries.set(key, cached(ttl, () => load(key), errorTtl));
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

// Set once 511 rejects StartTime/EndTime, so later requests skip straight to its default
// window instead of spending requests from the hourly budget on the rejected format.
let windowRejected = null;

async function timetableStops() {
  const p = await places();
  const ids = (await getMuni()).value?.stopIds || muni.stopIdsByPlace([], p);
  return { p, ids, stopIds: uniq(Object.values(ids).flat()) };
}

const fetchTimetable = (id, window, date) =>
  DEMO ? demo.demoTimetable(id, date || sfDate(Date.now())) : muni.fetchStopTimetable(KEY_511, id, window);

/** Timetables for 511's default window (typically today), shared by every requested date. */
const getDefaultTimetables = cached(60 * MIN, async () => {
  const { stopIds } = await timetableStops();
  return Promise.all(stopIds.map((id) => fetchTimetable(id)));
}, 10 * MIN);

/** Raw timetable payloads covering `date`, or 511's default window if it rejects ours. */
async function timetablePayloads(date, stopIds) {
  if (!windowRejected) {
    // A window wide enough whether 511 reads these as local or UTC times.
    const window = { start: `${date}T00:00:00`, end: `${addDays(date, 1)}T12:00:00` };
    try {
      // Probe with one stop first: if the format is rejected, that costs one request, not eight.
      const first = await fetchTimetable(stopIds[0], window, date);
      return [first, ...await Promise.all(stopIds.slice(1).map((id) => fetchTimetable(id, window, date)))];
    } catch (e) {
      if (!muni.isRejected(e)) throw e;
      windowRejected = e.message;
      console.warn(`511 rejected the timetable window; using its default window instead. ${e.message}`);
    }
  }
  const { value, error } = await getDefaultTimetables();
  if (!value) throw new Error(error);
  return value;
}

const clockLabel = (t) => new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', timeZone: TZ }).format(t);
const dayLabel = (date) => new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: TZ })
  .format(parseSf(date, '12:00'));

const getTimetable = cachedByKey(TIMETABLE_CACHE_MS, async (date) => {
  require511();
  const { p, ids, stopIds } = await timetableStops();
  const names = new Map(Object.values(p).flat().map((s) => [s.id, s.name]));
  const all = (await timetablePayloads(date, stopIds))
    .flatMap(muni.parseTimetable)
    .map((v) => ({ ...v, stopName: v.stopName || names.get(v.stopId) }));
  const isJT = (v) => v.line === 'J' || v.line === 'T';

  let visits = all.filter((v) => muni.serviceDate(v.dep) === date);
  let note = null;
  if (!visits.some(isJT)) {
    // 511 gave us a different day (its default window). Muni runs one timetable per kind
    // of day, so another weekday's timetable stands in for this one.
    const counts = new Map();
    for (const v of all.filter(isJT)) counts.set(muni.serviceDate(v.dep), (counts.get(muni.serviceDate(v.dep)) || 0) + 1);
    const source = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0];
    if (!source) throw new Error(`511.org returned no scheduled J/T trips${windowRejected ? ` (${windowRejected})` : ''}`);
    if (muni.dayType(source) !== muni.dayType(date)) {
      throw new Error(`511.org only provides ${dayLabel(source)}'s timetable, and ${dayLabel(date)} runs a different (${muni.dayType(date)}) schedule`);
    }
    visits = muni.shiftVisits(all.filter((v) => muni.serviceDate(v.dep) === source), source, date);
    note = `Muni times are from ${dayLabel(source)}'s timetable (511 only provides that day's; ${muni.dayType(date)}s run the same schedule).`;
  }
  const jt = visits.filter(isJT).map((v) => v.dep);
  const legs = muni.muniLegs(visits, ids);
  for (const d of DIRECTIONS) for (const k of ['j', 't']) for (const l of legs[d][k]) l.scheduled = true;
  return { legs, note, covers: [Math.min(...jt), Math.max(...jt)] };
}, { errorTtl: 10 * MIN });

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
  for (const d of DIRECTIONS) legs[d] = { j: m.value?.legs[d].j || [], t: m.value?.legs[d].t || [], bart: bartLegs[d] };
  const bartErr = bw.error || bh.error;
  const notes = [m.value?.note];
  const t = parseSf(date, clock);
  const [from, to] = m.value?.covers || [];
  if (m.value && (t < from - 2 * 60 * MIN || t > to + 2 * 60 * MIN)) {
    notes.push(`511's Muni timetable only covers ${clockLabel(from)}–${clockLabel(to)} for this day.`);
  }
  return {
    date,
    time: clock,
    sources: { muni: { ...source(m), note: notes.filter(Boolean).join(' ') || null }, bart: { ok: !bartErr, error: bartErr } },
    legs,
  };
}
