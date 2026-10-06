// SF Muni data from 511.org: SIRI StopMonitoring (live) and StopTimetable (scheduled).
import { PLACES, LINES, MUNI_LEGS } from './config.js';

const BASE = 'https://api.511.org/transit';

async function get511(path, params) {
  const url = new URL(`${BASE}/${path}`);
  for (const [k, v] of Object.entries({ ...params, format: 'json' })) url.searchParams.set(k, v);
  const res = await fetch(url, { headers: { 'Accept-Encoding': 'gzip' } });
  if (res.status === 429) throw new Error('511.org rate limit hit (60 requests/hour per key)');
  if (res.status === 401) throw new Error('511.org rejected the API key (set API_511_KEY)');
  if (!res.ok) throw Object.assign(new Error(`511.org ${path} returned HTTP ${res.status}`), { status: res.status });
  // 511 prefixes its JSON with a byte-order mark.
  return JSON.parse((await res.text()).replace(/^﻿/, ''));
}

export const fetchStops = (apiKey) => get511('stops', { api_key: apiKey, operator_id: 'SF' });
export const fetchStopMonitoring = (apiKey) => get511('StopMonitoring', { api_key: apiKey, agency: 'SF' });

/** Scheduled visits at one stop within [start, end] (ISO strings). */
export async function fetchStopTimetable(apiKey, stopId, start, end) {
  const params = { api_key: apiKey, OperatorRef: 'SF', MonitoringRef: stopId };
  try {
    return await get511('stoptimetable', { ...params, StartTime: start, EndTime: end });
  } catch (e) {
    // If the window is rejected, fall back to the API's default window (today).
    if (e.status === 400) return get511('stoptimetable', params);
    throw e;
  }
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
  const arr = (live && ms(call.ExpectedArrivalTime)) || ms(call.AimedArrivalTime);
  const dep = (live && ms(call.ExpectedDepartureTime)) || ms(call.AimedDepartureTime);
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
    live: live && Boolean(call.ExpectedArrivalTime || call.ExpectedDepartureTime),
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
    ...matched.map(([v, a]) => ({ ...legBase(v), arr: a.arr, arrLive: a.live, arrStop: a.stopName })),
    ...unmatched.filter(sameWay).map((v) => ({
      ...legBase(v),
      arr: v.dep + typicalRideMin * 60000,
      arrLive: false,
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
    depStop: v.stopName,
    atStop: v.atStop,
    occupancy: v.occupancy,
  };
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
