// SF Muni real-time data from the 511.org SIRI StopMonitoring API.
import { PLACES, LINES } from './config.js';

const BASE = 'https://api.511.org/transit';

async function get511(path, params) {
  const url = new URL(`${BASE}/${path}`);
  for (const [k, v] of Object.entries({ ...params, format: 'json' })) url.searchParams.set(k, v);
  const res = await fetch(url, { headers: { 'Accept-Encoding': 'gzip' } });
  if (res.status === 429) throw new Error('511.org rate limit hit (60 requests/hour per key)');
  if (res.status === 401) throw new Error('511.org rejected the API key (set API_511_KEY)');
  if (!res.ok) throw new Error(`511.org ${path} returned HTTP ${res.status}`);
  // 511 prefixes its JSON with a byte-order mark.
  return JSON.parse((await res.text()).replace(/^﻿/, ''));
}

export const fetchStops = (apiKey) => get511('stops', { api_key: apiKey, operator_id: 'SF' });
export const fetchStopMonitoring = (apiKey) => get511('StopMonitoring', { api_key: apiKey, agency: 'SF' });

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

/** Resolve each named place to the 511 stop codes near it (or pinned via env var). */
export function resolvePlaces(stops, env = process.env) {
  const out = {};
  for (const [key, place] of Object.entries(PLACES)) {
    const pinned = env[place.env];
    if (pinned) {
      const ids = pinned.split(',').map((s) => s.trim()).filter(Boolean);
      out[key] = ids.map((id) => stops.find((s) => s.id === id) || { id, name: id });
      continue;
    }
    out[key] = stops.filter((s) => metersBetween(place, s) <= place.radius);
  }
  return out;
}

const ms = (iso) => (iso ? Date.parse(iso) : NaN);

/** Flatten a StopMonitoring payload into simple visit records. */
export function parseVisits(payload) {
  const deliveries = asArray(payload?.ServiceDelivery?.StopMonitoringDelivery);
  const visits = [];
  for (const d of deliveries) {
    for (const v of asArray(d.MonitoredStopVisit)) {
      const j = v.MonitoredVehicleJourney || {};
      const call = j.MonitoredCall || {};
      const arr = ms(call.ExpectedArrivalTime) || ms(call.AimedArrivalTime);
      const dep = ms(call.ExpectedDepartureTime) || ms(call.AimedDepartureTime);
      const live = Boolean(call.ExpectedArrivalTime || call.ExpectedDepartureTime);
      const tripId = j.FramedVehicleJourneyRef?.DatedVehicleJourneyRef || j.VehicleRef;
      if (!tripId || !(arr || dep)) continue;
      visits.push({
        stopId: String(call.StopPointRef ?? v.MonitoringRef),
        stopName: call.StopPointName,
        line: j.LineRef,
        direction: j.DirectionRef,
        tripId: String(tripId),
        vehicle: j.VehicleRef || null,
        destination: call.DestinationDisplay || j.DestinationName || null,
        arr: arr || dep,
        dep: dep || arr,
        live,
        atStop: call.VehicleAtStop === true || call.VehicleAtStop === 'true',
        occupancy: j.Occupancy || null,
      });
    }
  }
  return visits;
}

/**
 * Departures of `lineRefs` from `fromIds` with their arrival at `toIds`, matched by trip.
 * Trips seen at both ends get a live arrival; trips only seen at the origin are kept if
 * they run the same direction as matched trips (or the configured hint) and get an
 * arrival estimated from the typical ride time.
 */
export function matchTrips(visits, { lineRefs, fromIds, toIds, directionHint, typicalRideMin }) {
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
  const goodDirs = new Set(matched.map(([v]) => v.direction).filter(Boolean));
  const goodStops = new Set(matched.map(([v]) => v.stopId));
  const sameWay = (v) =>
    goodDirs.size ? goodDirs.has(v.direction) || goodStops.has(v.stopId) : v.direction === directionHint;

  const legs = [
    ...matched.map(([v, a]) => ({ ...legBase(v), arr: a.arr, arrLive: a.live, arrStop: a.stopName })),
    ...unmatched.filter(sameWay).map((v) => ({
      ...legBase(v),
      arr: v.dep + typicalRideMin * 60000,
      arrLive: false,
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

/** Build the J and T legs from a StopMonitoring payload and resolved places. */
export function muniLegs(smPayload, places) {
  const visits = parseVisits(smPayload);
  const ids = (k) => places[k].map((s) => s.id);
  return {
    j: matchTrips(visits, { ...LINES.J, fromIds: ids('churchAnd24th'), toIds: ids('powellMuni') }),
    t: matchTrips(visits, { ...LINES.T, fromIds: ids('unionSquare'), toIds: ids('ucsfChase') }),
  };
}
