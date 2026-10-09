// SF Muni data from 511.org: SIRI StopMonitoring (live) and StopTimetable (scheduled).
import { PLACES, LINES, MUNI_LEGS } from './config.js';
import { parseSf, sfDate, sfClock, addDays } from '../public/time.js';

const BASE = 'https://api.511.org/transit';

async function get511(path, params) {
  const url = new URL(`${BASE}/${path}`);
  for (const [k, v] of Object.entries({ ...params, format: 'json' })) url.searchParams.set(k, v);
  const res = await fetch(url, { headers: { 'Accept-Encoding': 'gzip' } });
  const fail = (message) => Object.assign(new Error(message), { status: res.status });
  if (res.status === 429) throw fail('511.org rate limit hit (60 requests/hour per key)');
  if (res.status === 401) throw fail('511.org rejected the API key (set API_511_KEY)');
  if (!res.ok) {
    // 511 explains rejected requests in the body; keep a short excerpt.
    let detail = (await res.text().catch(() => '')).replace(/^\uFEFF/, '').replace(/\s+/g, ' ').trim().slice(0, 160);
    if (detail.startsWith('<')) detail = ''; // an HTML error page says nothing useful
    const outage = res.status >= 500 ? ' (a problem on 511.org\'s side; retrying shortly)' : '';
    throw fail(`511.org ${path} returned HTTP ${res.status}${detail ? `: ${detail}` : ''}${outage}`);
  }
  // 511 prefixes its JSON with a byte-order mark.
  return JSON.parse((await res.text()).replace(/^﻿/, ''));
}

export const fetchStops = (apiKey) => get511('stops', { api_key: apiKey, operator_id: 'SF' });
export const fetchStopMonitoring = (apiKey) => get511('StopMonitoring', { api_key: apiKey, agency: 'SF' });

/** Scheduled visits at one stop, within `window` {start, end} or 511's default window. */
export function fetchStopTimetable(apiKey, stopId, window) {
  return get511('stoptimetable', {
    api_key: apiKey, OperatorRef: 'SF', MonitoringRef: stopId,
    ...(window ? { StartTime: window.start, EndTime: window.end } : {}),
  });
}

/** 511 refused the request itself (bad parameters), as opposed to auth, rate limit or outage. */
export const isRejected = (e) => e.status >= 400 && e.status < 500 && e.status !== 401 && e.status !== 429;

/** Service day of a time: trips after midnight (until 3 AM) belong to the previous day. */
export const serviceDate = (t) => sfDate(t - 3 * 60 * 60000);

/** 'weekday', 'saturday' or 'sunday' for a YYYY-MM-DD date (Muni runs one schedule for each). */
export function dayType(date) {
  const day = new Date(`${date}T12:00:00Z`).getUTCDay();
  return day === 0 ? 'sunday' : day === 6 ? 'saturday' : 'weekday';
}

/** Move visits from one service day onto another, keeping their San Francisco clock times. */
export function shiftVisits(visits, fromDate, toDate) {
  const days = Math.round((parseSf(toDate, '12:00') - parseSf(fromDate, '12:00')) / 86400000);
  const move = (t) => (t ? parseSf(addDays(sfDate(t), days), sfClock(t)) + (t % 60000) : t);
  return visits.map((v) => ({
    ...v,
    tripId: `${v.tripId}@${toDate}`,
    arr: move(v.arr), dep: move(v.dep), aimedArr: move(v.aimedArr), aimedDep: move(v.aimedDep),
  }));
}

const asArray = (x) => (x == null ? [] : Array.isArray(x) ? x : [x]);

export function parseStops(payload) {
  const points = asArray(payload?.Contents?.dataObjects?.ScheduledStopPoint);
  return points
    .map((p) => ({
      id: String(p.id),
      name: p.Name,
      lat: Number(p.Location?.Latitude),
      lon: Number(p.Location?.Longitude),
    }))
    .filter((s) => Number.isFinite(s.lat) && Number.isFinite(s.lon));
}

function metersBetween(a, b) {
  const rad = Math.PI / 180;
  const x = (b.lon - a.lon) * rad * Math.cos(((a.lat + b.lat) / 2) * rad);
  const y = (b.lat - a.lat) * rad;
  return Math.sqrt(x * x + y * y) * 6371000;
}

/** Resolve each named place to the 511 stops near it, nearest first (or pinned via env var). */
export function resolvePlaces(stops, env = process.env) {
  const out = {};
  for (const [key, place] of Object.entries(PLACES)) {
    const pinned = env[place.env];
    if (pinned) {
      const ids = pinned.split(',').map((s) => s.trim()).filter(Boolean);
      out[key] = ids.map((id) => stops.find((s) => s.id === id) || { id, name: id });
      continue;
    }
    out[key] = stops
      .map((s) => ({ ...s, dist: metersBetween(place, s) }))
      .filter((s) => s.dist <= place.radius)
      .sort((a, b) => a.dist - b.dist);
  }
  return out;
}

const ms = (iso) => (iso ? Date.parse(iso) : NaN);

function toVisit(v, j, call, live) {
  // Any predicted time beats any scheduled one: 511 often gives Muni stops only a
  // predicted arrival, and falling back to the scheduled departure would hide delays.
  const expArr = live ? ms(call.ExpectedArrivalTime) : NaN;
  const expDep = live ? ms(call.ExpectedDepartureTime) : NaN;
  const aimedDep = ms(call.AimedDepartureTime) || ms(call.AimedArrivalTime);
  const aimedArr = ms(call.AimedArrivalTime) || ms(call.AimedDepartureTime);
  const arr = expArr || expDep || aimedArr;
  const dep = expDep || expArr || aimedDep;
  const tripId = j.FramedVehicleJourneyRef?.DatedVehicleJourneyRef || j.VehicleRef;
  if (!tripId || !(arr || dep)) return null;
  return {
    stopId: String(call.StopPointRef ?? v.MonitoringRef),
    stopName: call.StopPointName,
    line: j.LineRef,
    direction: j.DirectionRef,
    tripId: String(tripId),
    vehicle: j.VehicleRef || null,
    destination: call.DestinationDisplay || j.DestinationName || null,
    arr: arr || dep,
    dep: dep || arr,
    live: Boolean(expArr || expDep),
    // Scheduled times, shown next to live predictions.
    aimedDep: aimedDep || null,
    aimedArr: aimedArr || null,
    atStop: call.VehicleAtStop === true || call.VehicleAtStop === 'true',
    occupancy: j.Occupancy || null,
  };
}

const serviceDelivery = (payload) => payload?.Siri?.ServiceDelivery || payload?.ServiceDelivery;

/** Flatten a StopMonitoring payload into simple visit records. */
export function parseVisits(payload) {
  const visits = [];
  for (const d of asArray(serviceDelivery(payload)?.StopMonitoringDelivery)) {
    for (const v of asArray(d.MonitoredStopVisit)) {
      const j = v.MonitoredVehicleJourney || {};
      const visit = toVisit(v, j, j.MonitoredCall || {}, true);
      if (visit) visits.push(visit);
    }
  }
  return visits;
}

/** Flatten a StopTimetable payload into the same visit records (scheduled times only). */
export function parseTimetable(payload) {
  const visits = [];
  for (const d of asArray(serviceDelivery(payload)?.StopTimetableDelivery)) {
    for (const v of asArray(d.TimetabledStopVisit)) {
      const j = v.TargetedVehicleJourney || v.MonitoredVehicleJourney || {};
      const visit = toVisit(v, j, j.TargetedCall || j.MonitoredCall || {}, false);
      if (visit) visits.push(visit);
    }
  }
  return visits;
}

/** Split visits at `fromIds` into trips confirmed at `toIds` later, and the rest. */
function classify(visits, { lineRefs, fromIds, toIds }) {
  const from = new Set(fromIds);
  const to = new Set(toIds);
  const onLine = visits.filter((v) => lineRefs.includes(v.line));
  const arrivals = new Map();
  for (const v of onLine) {
    if (!to.has(v.stopId)) continue;
    const prev = arrivals.get(v.tripId);
    if (!prev || v.arr < prev.arr) arrivals.set(v.tripId, v);
  }
  const matched = [];
  const unmatched = [];
  for (const v of onLine) {
    if (!from.has(v.stopId)) continue;
    const a = arrivals.get(v.tripId);
    if (a && a.arr > v.dep) matched.push([v, a]);
    else unmatched.push(v);
  }
  return { matched, unmatched };
}

const setOf = (pairs, key) => new Set(pairs.map(([v]) => v[key]).filter(Boolean));

/**
 * Departures of `lineRefs` from `fromIds` with their arrival at `toIds`, matched by trip.
 * Trips seen at both ends get the predicted/scheduled arrival. Trips only seen at the
 * origin (no downstream prediction yet) get an arrival estimated from the typical ride
 * time, but only if every available signal says they run this way:
 * - it would arrive after the latest confirmed arrival. Downstream predictions already
 *   cover that window, so a train going this way would have one;
 * - its destination and direction are not ones confirmed for the opposite leg (`opposite`);
 * - its direction matches confirmed trips, else its platform does, else the configured hint.
 */
export function matchTrips(visits, cfg, opposite = { matched: [] }) {
  const { directionHint, typicalRideMin } = cfg;
  const { matched, unmatched } = classify(visits, cfg);
  const goodDirs = setOf(matched, 'direction');
  const goodDests = setOf(matched, 'destination');
  const goodStops = setOf(matched, 'stopId');
  const badDirs = new Set([...setOf(opposite.matched, 'direction')].filter((d) => !goodDirs.has(d)));
  const badDests = new Set([...setOf(opposite.matched, 'destination')].filter((d) => !goodDests.has(d)));
  const horizon = Math.max(-Infinity, ...matched.map(([, a]) => a.arr));
  const sameWay = (v) => {
    if (v.dep + typicalRideMin * 60000 <= horizon) return false;
    if (v.destination && badDests.has(v.destination)) return false;
    if (v.direction && badDirs.has(v.direction)) return false;
    if (goodDirs.size && v.direction) return goodDirs.has(v.direction);
    if (goodStops.size) return goodStops.has(v.stopId);
    return v.direction === directionHint;
  };

  const legs = [
    ...matched.map(([v, a]) => ({
      ...legBase(v), arr: a.arr, arrLive: a.live, arrAimed: a.aimedArr, arrStop: a.stopName,
    })),
    ...unmatched.filter(sameWay).map((v) => ({
      ...legBase(v),
      arr: v.dep + typicalRideMin * 60000,
      arrLive: false,
      arrAimed: null,
      arrEstimated: true,
      arrStop: null,
    })),
  ];
  const byTrip = new Map();
  for (const l of legs) if (!byTrip.has(l.tripId) || l.dep < byTrip.get(l.tripId).dep) byTrip.set(l.tripId, l);
  return [...byTrip.values()].sort((a, b) => a.dep - b.dep);
}

function legBase(v) {
  return {
    tripId: v.tripId,
    line: v.line,
    vehicle: v.vehicle,
    destination: v.destination,
    dep: v.dep,
    depLive: v.live,
    depAimed: v.aimedDep,
    depStop: v.stopName,
    atStop: v.atStop,
    occupancy: v.occupancy,
  };
}

/** Stops per place found by name among J/T visits, for when 511's stop list is unavailable. */
export function placesFromNames(visits) {
  const lines = new Set(Object.values(LINES).flatMap((l) => l.lineRefs));
  const out = {};
  for (const [key, place] of Object.entries(PLACES)) {
    const found = new Map();
    for (const v of visits) {
      if (lines.has(v.line) && v.stopName && place.match.test(v.stopName)) found.set(v.stopId, { id: v.stopId, name: v.stopName });
    }
    out[key] = [...found.values()];
  }
  return out;
}

/** Stop ids per place: the ones where J/T trips were actually seen, else the nearest few. */
export function stopIdsByPlace(visits, places, fallbackCount = 3) {
  const lines = new Set(Object.values(LINES).flatMap((l) => l.lineRefs));
  const serving = new Set(visits.filter((v) => lines.has(v.line)).map((v) => v.stopId));
  const out = {};
  for (const [key, stops] of Object.entries(places)) {
    const seen = stops.filter((s) => serving.has(s.id)).map((s) => s.id);
    out[key] = seen.length ? seen : stops.slice(0, fallbackCount).map((s) => s.id);
  }
  return out;
}

/** J and T legs for both directions, from visits at the given stop ids per place. */
export function muniLegs(visits, idsByPlace) {
  const cfgFor = (leg) => ({
    ...LINES[leg.line],
    directionHint: leg.dir,
    fromIds: idsByPlace[leg.from] || [],
    toIds: idsByPlace[leg.to] || [],
  });
  const out = {};
  for (const [direction, legs] of Object.entries(MUNI_LEGS)) {
    out[direction] = {};
    for (const [key, leg] of Object.entries(legs)) {
      // The same line the other way round, e.g. J outbound when this is J inbound.
      const reverse = cfgFor({ ...leg, from: leg.to, to: leg.from });
      out[direction][key] = matchTrips(visits, cfgFor(leg), classify(visits, reverse));
    }
  }
  return out;
}
