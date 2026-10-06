import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseStops, resolvePlaces, parseVisits, parseTimetable, muniLegs, stopIdsByPlace } from '../lib/muni.js';
import { parseEtd, parseRideMinutes, parseScheduledTrips, bartTime, bartQuery } from '../lib/bart.js';
import { buildItineraries, mergeLegs } from '../public/itinerary.js';
import { parseSf, sfDate, sfClock } from '../public/time.js';
import { BART, DEFAULT_SETTINGS } from '../lib/config.js';
import { demoStops, demoStopMonitoring, demoTimetable, demoEtd, demoDepart } from '../lib/demo.js';

const NOW = Date.parse('2026-10-06T15:30:00Z'); // 8:30 AM in SF
const MIN = 60000;
const places = resolvePlaces(parseStops(demoStops()), {});
const allIds = Object.fromEntries(Object.entries(places).map(([k, v]) => [k, v.map((s) => s.id)]));
const live = muniLegs(parseVisits(demoStopMonitoring(NOW)), allIds);

test('stops are resolved by proximity, nearest first, both platforms included', () => {
  assert.deepEqual(places.churchAnd24th.map((s) => s.id), ['14001', '14002']);
  assert.deepEqual(places.ucsfChase.map((s) => s.id), ['17360', '17361']);
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

test('live J to work: inbound only, no buses, predicted Powell arrival, else estimated', () => {
  const { j } = live.work;
  assert.equal(j.length, 7);
  assert.ok(j.every((l) => l.line === 'J' && l.tripId.startsWith('J-IB')));
  assert.equal(j[0].arr - j[0].dep, 16 * MIN);
  assert.ok(j[0].arrLive && !j[0].arrEstimated);
  assert.ok(j[6].arrEstimated);
  assert.equal(j[6].arr - j[6].dep, 17 * MIN);
});

test('live legs home run the other way: T northbound, J outbound', () => {
  assert.equal(live.home.t.length, 9);
  assert.ok(live.home.t.every((l) => l.tripId.startsWith('T-IB') && l.arr - l.dep === 11 * MIN));
  assert.equal(live.home.j.length, 7);
  assert.ok(live.home.j.every((l) => l.tripId.startsWith('J-OB') && l.arr - l.dep === 17 * MIN));
  assert.ok(live.work.t.every((l) => l.tripId.startsWith('T-OB')));
});

test('timetable stops: only J/T platforms once seen live, else the nearest few', () => {
  const ids = stopIdsByPlace(parseVisits(demoStopMonitoring(NOW)), places);
  assert.deepEqual(ids.powellMuni.sort(), ['16995', '16996']); // not the Market St bus stop
  assert.equal(stopIdsByPlace([], places).powellMuni.length, 3);
});

test('scheduled Muni legs from StopTimetable, both directions', () => {
  const date = '2026-10-07';
  const visits = ['14001', '14002', '16995', '16996', '17876', '17877', '17360', '17361']
    .flatMap((id) => parseTimetable(demoTimetable(id, date)));
  const legs = muniLegs(visits, allIds);
  for (const d of ['work', 'home']) {
    for (const k of ['j', 't']) {
      assert.ok(legs[d][k].length > 100, `${d}.${k}`);
      assert.ok(legs[d][k].every((l) => !l.arrEstimated && l.arr > l.dep));
    }
  }
  assert.equal(sfClock(legs.work.j[0].dep), '05:03');
  assert.equal(legs.work.t[0].arr - legs.work.t[0].dep, 11 * MIN);
});

test('BART live departures per direction', () => {
  const north = parseEtd(demoEtd(BART.work), NOW, BART.work, 8);
  assert.equal(north.length, 5);
  assert.equal(north[0].dep, NOW); // "Leaving"
  assert.equal(north[0].arr, NOW + 8 * MIN);
  const south = parseEtd(demoEtd(BART.home), NOW, BART.home, 8);
  assert.equal(south.length, 6);
  assert.ok(south.every((l) => l.depStop === 'Powell St' && l.destination !== 'Antioch'));
  assert.equal(parseRideMinutes(demoDepart(BART.work, NOW)), 8);
});

test('BART schedule times are read as San Francisco time', () => {
  assert.equal(bartTime('10/07/2026 ', '8:24 AM'), Date.parse('2026-10-07T15:24:00Z'));
  assert.equal(bartTime('10/07/2026', '12:05 AM'), Date.parse('2026-10-07T07:05:00Z'));
  assert.equal(bartTime('10/07/2026', '12:05 PM'), Date.parse('2026-10-07T19:05:00Z'));
  assert.deepEqual(bartQuery(Date.parse('2026-10-07T03:30:00Z')), { date: '10/06/2026', time: '8:30pm' });
  const trips = parseScheduledTrips(demoDepart(BART.home, NOW), BART.home);
  assert.equal(trips.length, 8);
  assert.ok(trips.every((t) => t.scheduled && t.arr - t.dep === 8 * MIN && t.destination === 'Millbrae'));
});

test('San Francisco time helpers handle DST', () => {
  assert.equal(parseSf('2026-10-07', '08:30'), Date.parse('2026-10-07T15:30:00Z'));
  assert.equal(parseSf('2026-12-07', '08:30'), Date.parse('2026-12-07T16:30:00Z'));
  assert.equal(parseSf('2026-03-08', '03:30'), Date.parse('2026-03-08T10:30:00Z'));
  assert.equal(sfDate(Date.parse('2026-10-07T06:59:00Z')), '2026-10-06');
  assert.equal(sfClock(Date.parse('2026-10-07T06:59:00Z')), '23:59');
});

const liveWork = { ...live.work, bart: parseEtd(demoEtd(BART.work), NOW, BART.work, 8) };
const liveHome = { ...live.home, bart: parseEtd(demoEtd(BART.home), NOW, BART.home, 8) };

function checkTrips(trips, now) {
  assert.ok(trips.length > 0);
  for (const tr of trips) {
    const [a, b] = tr.legs;
    assert.ok(b.dep >= a.arr + tr.transferMin * MIN, 'second leg must leave after the transfer');
    assert.ok(tr.leaveBy >= now - 30000, 'must still be makeable');
  }
  const seconds = trips.map((tr) => tr.legs[1].tripId);
  assert.equal(new Set(seconds).size, seconds.length, 'one option per second leg');
  for (const tr of trips) {
    const rival = trips.find((o) => o !== tr && o.legs[1].tripId === tr.legs[1].tripId);
    assert.ok(!rival, 'no option that only leaves earlier for the same connection');
  }
}

test('to work now: first catchable T, sorted by arrival, impossible BART excluded', () => {
  const trips = buildItineraries(liveWork, DEFAULT_SETTINGS, { now: NOW, limit: 50 });
  checkTrips(trips, NOW);
  for (const tr of trips) {
    assert.ok(!liveWork.t.some((x) => x.dep >= tr.readyAt && x.dep < tr.legs[1].dep), 'must pick the first catchable T');
  }
  assert.ok(!trips.some((tr) => tr.mode === 'BART' && tr.legs[0].dep === NOW)); // 19 min walk
  assert.deepEqual(trips.map((x) => x.arriveAt), [...trips.map((x) => x.arriveAt)].sort((a, b) => a - b));
});

test('to home now: T first, then J or BART', () => {
  const trips = buildItineraries(liveHome, DEFAULT_SETTINGS, { direction: 'home', now: NOW, limit: 50 });
  checkTrips(trips, NOW);
  assert.ok(trips.every((tr) => tr.legs[0].tripId.startsWith('T-IB')));
  assert.ok(trips.some((tr) => tr.mode === 'J') && trips.some((tr) => tr.mode === 'BART'));
  const tr = trips[0];
  assert.equal(tr.leaveBy, tr.legs[0].dep - DEFAULT_SETTINGS.walkFromT * MIN);
  const walkHome = tr.mode === 'J' ? DEFAULT_SETTINGS.walkToJ : DEFAULT_SETTINGS.walkToBart;
  assert.equal(tr.arriveAt, tr.legs[1].arr + walkHome * MIN);
});

test('depart at / arrive by use scheduled legs for a future time', () => {
  const date = '2026-10-07';
  const visits = ['14001', '14002', '16995', '16996', '17876', '17877', '17360', '17361']
    .flatMap((id) => parseTimetable(demoTimetable(id, date)));
  const sched = muniLegs(visits, allIds);
  const at = parseSf(date, '08:30');
  const legs = { ...sched.work, bart: parseScheduledTrips(demoDepart(BART.work, at), BART.work) };
  for (const k of ['j', 't']) for (const l of legs[k]) l.scheduled = true;

  const departing = buildItineraries(legs, DEFAULT_SETTINGS, { now: NOW, when: 'depart', at });
  checkTrips(departing, NOW);
  assert.ok(departing.every((tr) => tr.leaveBy >= at && tr.scheduled));
  const bartOnly = buildItineraries(legs, DEFAULT_SETTINGS, { now: NOW, when: 'depart', at, modes: ['BART'] });
  checkTrips(bartOnly, NOW);
  assert.ok(bartOnly.every((tr) => tr.mode === 'BART'));

  const target = parseSf(date, '09:00');
  const arriving = buildItineraries(legs, DEFAULT_SETTINGS, { now: NOW, when: 'arrive', at: target });
  checkTrips(arriving, NOW);
  assert.ok(arriving.every((tr) => tr.arriveAt <= target));
  assert.ok(Math.max(...arriving.map((tr) => tr.arriveAt)) > parseSf(date, '08:45'), 'closest to the target');
});

test('mergeLegs keeps live predictions and fills in schedule beyond them', () => {
  const liveLegs = [{ tripId: 'a', dep: 10 * MIN }, { tripId: 'b', dep: 20 * MIN }];
  const scheduled = [{ tripId: 'a', dep: 9 * MIN }, { tripId: 'x', dep: 15 * MIN }, { tripId: 'y', dep: 30 * MIN }];
  assert.deepEqual(mergeLegs(liveLegs, scheduled).map((l) => l.tripId), ['a', 'b', 'y']);
  assert.deepEqual(mergeLegs([], scheduled), scheduled);
});

test('an unconfirmed train going the other way is not listed (shared stop code)', () => {
  const payload = demoStopMonitoring(NOW);
  const wrongWay = (dir) => ({
    MonitoringRef: '14001',
    MonitoredVehicleJourney: {
      LineRef: 'J',
      ...(dir ? { DirectionRef: dir } : {}),
      FramedVehicleJourneyRef: { DatedVehicleJourneyRef: `J-WRONG-${dir}` },
      MonitoredCall: {
        StopPointRef: '14001', // same code as the inbound platform
        DestinationDisplay: 'Balboa Park',
        ExpectedDepartureTime: new Date(NOW + 12 * MIN).toISOString(),
      },
    },
  });
  for (const dir of ['OB', undefined]) {
    const visits = parseVisits(payload).concat(parseVisits({
      ServiceDelivery: { StopMonitoringDelivery: { MonitoredStopVisit: [wrongWay(dir)] } },
    }));
    const legs = muniLegs(visits, allIds);
    assert.ok(!legs.work.j.some((l) => l.tripId.startsWith('J-WRONG')), `direction ${dir}`);
    assert.equal(legs.work.j.length, 7);
  }
});

test('an unconfirmed train inside the predicted window is dropped, whatever its labels', () => {
  // Labeled like an inbound J, but no Powell prediction even though Powell predictions
  // already extend past when it would arrive: it is not heading to Powell.
  const ghost = {
    MonitoringRef: '14001',
    MonitoredVehicleJourney: {
      LineRef: 'J',
      DirectionRef: 'IB',
      FramedVehicleJourneyRef: { DatedVehicleJourneyRef: 'J-GHOST' },
      MonitoredCall: {
        StopPointRef: '14001',
        DestinationDisplay: 'Embarcadero',
        ExpectedDepartureTime: new Date(NOW + 5 * MIN).toISOString(),
      },
    },
  };
  const visits = parseVisits(demoStopMonitoring(NOW)).concat(parseVisits({
    ServiceDelivery: { StopMonitoringDelivery: { MonitoredStopVisit: [ghost] } },
  }));
  const { j } = muniLegs(visits, allIds).work;
  assert.ok(!j.some((l) => l.tripId === 'J-GHOST'));
  assert.equal(j.length, 7); // later trips beyond the predicted window are still estimated
  assert.ok(j[6].arrEstimated);
});

test('a predicted arrival beats the scheduled departure (delays are not hidden)', () => {
  const at = (m) => new Date(NOW + m * MIN).toISOString();
  const call = (stop, aimed, expected) => ({
    StopPointRef: stop,
    AimedArrivalTime: at(aimed),
    AimedDepartureTime: at(aimed),
    ExpectedArrivalTime: at(expected), // 511 often omits ExpectedDepartureTime for Muni
    ExpectedDepartureTime: null,
  });
  const visit = (stop, aimed, expected) => ({
    MonitoringRef: stop,
    MonitoredVehicleJourney: {
      LineRef: 'J', DirectionRef: 'IB', VehicleRef: '2072', DestinationName: 'Embarcadero Station',
      FramedVehicleJourneyRef: { DatedVehicleJourneyRef: 'J-LATE' },
      MonitoredCall: call(stop, aimed, expected),
    },
  });
  const visits = parseVisits({ ServiceDelivery: { StopMonitoringDelivery: { MonitoredStopVisit: [
    visit('14001', 22, 25), visit('16995', 42, 43),
  ] } } });
  const [leg] = muniLegs(visits, allIds).work.j;
  assert.equal(leg.dep, NOW + 25 * MIN);
  assert.equal(leg.depAimed, NOW + 22 * MIN); // scheduled time kept for display
  assert.equal(leg.arrAimed, NOW + 42 * MIN);
  assert.equal(leg.arr, NOW + 43 * MIN);
  assert.ok(leg.depLive && leg.arrLive);
});
