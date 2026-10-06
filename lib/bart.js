// BART real-time departures from the BART legacy API (api.bart.gov).
import { BART } from './config.js';

const BASE = 'https://api.bart.gov/api';

async function getBart(path, params) {
  const url = new URL(`${BASE}/${path}`);
  for (const [k, v] of Object.entries({ ...params, json: 'y' })) url.searchParams.set(k, v);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`BART ${path} returned HTTP ${res.status}`);
  return res.json();
}

export const fetchEtd = (key) => getBart('etd.aspx', { cmd: 'etd', orig: BART.origin, key });
export const fetchSchedule = (key) =>
  getBart('sched.aspx', { cmd: 'depart', orig: BART.origin, dest: BART.dest, date: 'now', b: 0, a: 4, key });

/** Median scheduled ride time 24th St -> Powell, in minutes. */
export function parseRideMinutes(payload) {
  const trips = payload?.root?.schedule?.request?.trip;
  const times = (Array.isArray(trips) ? trips : trips ? [trips] : [])
    .map((t) => Number(t['@tripTime']))
    .filter((n) => n > 0 && n < 60)
    .sort((a, b) => a - b);
  return times.length ? times[Math.floor(times.length / 2)] : BART.typicalRideMin;
}

/** Northbound departures from 24th St Mission with estimated arrival at Powell. */
export function parseEtd(payload, fetchedAt, rideMin = BART.typicalRideMin) {
  const station = payload?.root?.station?.[0];
  const out = [];
  for (const etd of station?.etd || []) {
    for (const e of etd.estimate || []) {
      if (e.direction !== BART.direction) continue;
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
        depStop: '24th St Mission',
        arr: dep + rideMin * 60000,
        arrLive: false,
        arrStop: 'Powell St',
      });
    }
  }
  return out.sort((a, b) => a.dep - b.dep);
}
