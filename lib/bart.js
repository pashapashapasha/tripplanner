// BART real-time departures and schedules from the BART legacy API (api.bart.gov).
import { BART } from './config.js';
import { sfTime, sfParts } from '../public/time.js';

const BASE = 'https://api.bart.gov/api';

async function getBart(path, params) {
  const url = new URL(`${BASE}/${path}`);
  for (const [k, v] of Object.entries({ ...params, json: 'y' })) url.searchParams.set(k, v);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`BART ${path} returned HTTP ${res.status}`);
  return res.json();
}

const HEADS = {
  ANTC: 'Antioch', RICH: 'Richmond', BERY: 'Berryessa', MLBR: 'Millbrae', SFIA: 'SFO',
  DALY: 'Daly City', DUBL: 'Dublin/Pleasanton', PITT: 'Pittsburg/Bay Point', WARM: 'Warm Springs',
  MLPT: 'Milpitas', PCTR: 'Pittsburg Center', WDUB: 'West Dublin', OAKL: 'Oakland Airport',
};
// Route numbers come in pairs (one per direction) sharing a line color.
const ROUTE_COLORS = { 1: '#ffff33', 2: '#ffff33', 3: '#ff9933', 4: '#ff9933', 5: '#339933', 6: '#339933', 7: '#ff0000', 8: '#ff0000', 11: '#0099cc', 12: '#0099cc' };

export const fetchEtd = (key, route) => getBart('etd.aspx', { cmd: 'etd', orig: route.orig, key });

/** Scheduled trips around a time. `date` is 'mm/dd/yyyy' or 'now', `time` like '8:30am'. */
export const fetchDepart = (key, route, { date = 'now', time, before = 0, after = 4 } = {}) =>
  getBart('sched.aspx', {
    cmd: 'depart', orig: route.orig, dest: route.dest, date, b: before, a: after, key,
    ...(time ? { time } : {}),
  });

const tripsOf = (payload) => {
  const trips = payload?.root?.schedule?.request?.trip;
  return Array.isArray(trips) ? trips : trips ? [trips] : [];
};

/** Median scheduled ride time between the route's stations, in minutes. */
export function parseRideMinutes(payload) {
  const times = tripsOf(payload)
    .map((t) => Number(t['@tripTime']))
    .filter((n) => n > 0 && n < 60)
    .sort((a, b) => a - b);
  return times.length ? times[Math.floor(times.length / 2)] : BART.typicalRideMin;
}

/** Live departures for the route's direction, with estimated arrival at its destination. */
export function parseEtd(payload, fetchedAt, route, rideMin = BART.typicalRideMin) {
  const station = payload?.root?.station?.[0];
  const out = [];
  for (const etd of station?.etd || []) {
    for (const e of etd.estimate || []) {
      if (e.direction !== route.direction) continue;
      const mins = e.minutes === 'Leaving' ? 0 : Number(e.minutes);
      if (!Number.isFinite(mins)) continue;
      const dep = fetchedAt + mins * 60000;
      out.push({
        tripId: `bart-${etd.abbreviation}-${dep}`,
        line: e.color,
        color: e.hexcolor,
        destination: etd.destination,
        cars: Number(e.length) || null,
        platform: e.platform,
        delaySec: Number(e.delay) || 0,
        dep,
        depLive: true,
        depStop: route.from,
        arr: dep + rideMin * 60000,
        arrLive: false,
        arrEstimated: true,
        arrStop: route.to,
      });
    }
  }
  return out.sort((a, b) => a.dep - b.dep);
}

/** '10/07/2026' + '8:24 AM' -> epoch ms (San Francisco time). */
export function bartTime(date, clock) {
  const [m, d, y] = String(date).trim().split('/').map(Number);
  const match = /^(\d{1,2}):(\d{2})\s*([AP]M)$/i.exec(String(clock).trim());
  if (!match || !y) return NaN;
  let h = Number(match[1]) % 12;
  if (match[3].toUpperCase() === 'PM') h += 12;
  return sfTime(y, m, d, h, Number(match[2]));
}

/** Scheduled direct trips from a `depart` response, as legs. */
export function parseScheduledTrips(payload, route) {
  const out = [];
  for (const t of tripsOf(payload)) {
    const legs = Array.isArray(t.leg) ? t.leg : t.leg ? [t.leg] : [];
    if (legs.length > 1) continue; // our stations are always a direct ride
    const dep = bartTime(t['@origTimeDate'], t['@origTimeMin']);
    const arr = bartTime(t['@destTimeDate'], t['@destTimeMin']);
    if (!Number.isFinite(dep) || !Number.isFinite(arr)) continue;
    const head = legs[0]?.['@trainHeadStation'];
    const routeNum = Number(String(legs[0]?.['@line'] || '').replace(/\D/g, ''));
    out.push({
      tripId: `bart-sched-${dep}`,
      line: legs[0]?.['@line'] || null,
      color: ROUTE_COLORS[routeNum] || null,
      destination: HEADS[head] || head || null,
      cars: null,
      dep,
      depLive: false,
      depStop: route.from,
      arr,
      arrLive: false,
      arrStop: route.to,
      scheduled: true,
    });
  }
  return out;
}

/** 'mm/dd/yyyy' and 'h:mmam' for BART's schedule API, from epoch ms. */
export function bartQuery(t) {
  const p = sfParts(t);
  const h12 = p.hour % 12 || 12;
  return {
    date: `${String(p.month).padStart(2, '0')}/${String(p.day).padStart(2, '0')}/${p.year}`,
    time: `${h12}:${String(p.minute).padStart(2, '0')}${p.hour < 12 ? 'am' : 'pm'}`,
  };
}
