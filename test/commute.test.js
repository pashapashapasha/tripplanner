import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseStops, resolvePlaces, parseVisits, muniLegs } from '../lib/muni.js';
import { parseEtd, parseRideMinutes } from '../lib/bart.js';
import { buildItineraries } from '../public/itinerary.js';
import { DEFAULT_SETTINGS } from '../lib/config.js';
import { demoStops, demoStopMonitoring, demoEtd, demoSchedule } from '../lib/demo.js';

const NOW = Date.parse('2026-10-06T15:30:00Z');
const MIN = 60000;
const places = resolvePlaces(parseStops(demoStops()), {});

test('stops are resolved by proximity, both Church & 24th platforms included', () => {
  assert.deepEqual(places.churchAnd24th.map((s) => s.id).sort(), ['14001', '14002']);
  assert.deepEqual(places.ucsfChase.map((s) => s.id), ['17360']);
  assert.ok(!Object.values(places).flat().some((s) => s.id === '99999'));
});

test('stop codes can be pinned via env', () => {
  const pinned = resolvePlaces(parseStops(demoStops()), { STOPS_J_ORIGIN: '14001' });
  assert.deepEqual(pinned.churchAnd24th.map((s) => s.id), ['14001']);
});

test('StopMonitoringDelivery parses as object or array', () => {
  const payload = demoStopMonitoring(NOW);
  const asArray = { ServiceDelivery: { StopMonitoringDelivery: [payload.ServiceDelivery.StopMonitoringDelivery] } };
  assert.equal(parseVisits(payload).length, parseVisits(asArray).length);
});

test('J legs: inbound only, no buses, live Powell arrival when predicted, else estimated', () => {
  const { j } = muniLegs(demoStopMonitoring(NOW), places);
  assert.equal(j.length, 7);
  assert.ok(j.every((l) => l.line === 'J' && l.tripId.startsWith('J-IB')));
  assert.equal(j[0].arr - j[0].dep, 16 * MIN);
  assert.ok(j[0].arrLive);
  assert.ok(!j[6].arrLive);
  assert.equal(j[6].arr - j[6].dep, 17 * MIN);
});

test('T legs are matched Union Square -> UCSF/Chase Center', () => {
  const { t } = muniLegs(demoStopMonitoring(NOW), places);
  assert.equal(t.length, 9);
  assert.ok(t.every((l) => l.arrLive && l.arr - l.dep === 11 * MIN));
});

test('BART ETD keeps northbound only and converts minutes to times', () => {
  const legs = parseEtd(demoEtd(), NOW, parseRideMinutes(demoSchedule()));
  assert.equal(legs.length, 5);
  assert.equal(legs[0].dep, NOW); // "Leaving"
  assert.equal(legs[0].arr, NOW + 8 * MIN);
  assert.ok(legs.every((l) => l.destination !== 'Millbrae'));
});

test('itineraries connect each first leg to the first catchable T', () => {
  const { j, t } = muniLegs(demoStopMonitoring(NOW), places);
  const bart = parseEtd(demoEtd(), NOW, 8);
  const trips = buildItineraries({ j, t, bart }, DEFAULT_SETTINGS, NOW, { limit: 50 });
  assert.ok(trips.length > 0);
  for (const tr of trips) {
    const transfer = tr.mode === 'J' ? DEFAULT_SETTINGS.transferJ : DEFAULT_SETTINGS.transferBart;
    assert.ok(tr.t.dep >= tr.atPowell + transfer * MIN, 'T must leave after the transfer');
    assert.ok(!t.some((x) => x.dep >= tr.readyAt && x.dep < tr.t.dep), 'must pick the first catchable T');
    assert.ok(tr.leaveBy >= NOW - 30000, 'must still be makeable');
  }
  // BART "Leaving" now needs a 19 min walk: impossible, so excluded.
  assert.ok(!trips.some((tr) => tr.mode === 'BART' && tr.first.dep === NOW));
  // Sorted by arrival.
  assert.deepEqual(trips.map((x) => x.arriveAt), [...trips.map((x) => x.arriveAt)].sort((a, b) => a - b));
  // Exactly one non-superseded option per T trip.
  const perT = new Map();
  for (const tr of trips) if (!tr.superseded) perT.set(tr.t.tripId, (perT.get(tr.t.tripId) || 0) + 1);
  assert.ok([...perT.values()].every((n) => n === 1));
});
