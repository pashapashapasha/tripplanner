// Synthetic payloads shaped exactly like 511.org and BART API responses.
// Used by DEMO=1 (UI preview without API access) and by the tests.
import { PLACES } from './config.js';
import { parseSf, sfParts } from '../public/time.js';

const iso = (t) => new Date(t).toISOString();
const MIN = 60000;

const STOPS = [
  { id: '14001', name: 'Church St & 24th St', place: 'churchAnd24th' },
  { id: '14002', name: 'Church St & 24th St', place: 'churchAnd24th', dLat: 0.0003 },
  { id: '16995', name: 'Powell Station Inbound', place: 'powellMuni' },
  { id: '16996', name: 'Powell Station Outbound', place: 'powellMuni', dLat: 0.0002 },
  { id: '17876', name: 'Union Square/Market Street Station', place: 'unionSquare' },
  { id: '17877', name: 'Union Square/Market Street Station', place: 'unionSquare', dLat: 0.0002 },
  { id: '17360', name: 'UCSF/Chase Center', place: 'ucsfChase' },
  { id: '17361', name: 'UCSF/Chase Center', place: 'ucsfChase', dLat: 0.0002 },
  { id: '15555', name: 'Market St & Powell St', place: 'powellMuni', dLat: 0.0008 }, // bus stop
  { id: '99999', name: 'Somewhere far away', lat: 37.7, lon: -122.5 },
];

// Trip patterns: stops with minutes from the first stop. `livePredicted` limits how many
// upcoming trips have a prediction at the last stop (later ones exercise estimation).
const PATTERNS = [
  { line: 'J', dir: 'IB', dest: 'Embarcadero', stops: [['14001', 0], ['16995', 16]], headway: 9, offset: 3, count: 7, livePredicted: 4 },
  { line: 'J', dir: 'OB', dest: 'Balboa Park', stops: [['16996', 0], ['14002', 17]], headway: 9, offset: 5, count: 7 },
  { line: 'T', dir: 'OB', dest: 'Sunnydale', stops: [['17876', 0], ['17360', 11]], headway: 8, offset: 4, count: 9 },
  { line: 'T', dir: 'IB', dest: 'Chinatown', stops: [['17361', 0], ['17877', 11]], headway: 8, offset: 2, count: 9 },
];

export function demoStops() {
  return {
    Contents: {
      dataObjects: {
        ScheduledStopPoint: STOPS.map((s) => ({
          id: s.id,
          Name: s.name,
          Location: {
            Latitude: String(s.lat ?? PLACES[s.place].lat + (s.dLat || 0)),
            Longitude: String(s.lon ?? PLACES[s.place].lon),
          },
        })),
      },
    },
  };
}

const stopName = (id) => STOPS.find((s) => s.id === id)?.name;

function journey(p, tripId, stopId, t, live, delay = 1) {
  const call = {
    StopPointRef: stopId,
    StopPointName: stopName(stopId),
    DestinationDisplay: p.dest,
    AimedArrivalTime: iso(t - (live ? delay * MIN : 0)),
    AimedDepartureTime: iso(t - (live ? delay * MIN : 0)),
    ...(live ? { ExpectedArrivalTime: iso(t), ExpectedDepartureTime: iso(t), VehicleAtStop: '' } : {}),
  };
  return {
    LineRef: p.line,
    DirectionRef: p.dir,
    FramedVehicleJourneyRef: { DataFrameRef: '2026-10-06', DatedVehicleJourneyRef: tripId },
    DestinationName: p.dest,
    ...(live ? { VehicleRef: `${p.line}-${tripId.slice(-3)}`, Occupancy: 'seatsAvailable' } : {}),
    [live ? 'MonitoredCall' : 'TargetedCall']: call,
  };
}

export function demoStopMonitoring(now = Date.now()) {
  const visits = [];
  for (const p of PATTERNS) {
    for (let i = 0; i < p.count; i++) {
      const start = now + (p.offset + i * p.headway) * MIN;
      const tripId = `${p.line}-${p.dir}-${100 + i}`;
      p.stops.forEach(([stopId, mins], k) => {
        const last = k === p.stops.length - 1;
        if (last && p.livePredicted != null && i >= p.livePredicted) return;
        const delay = [0, 3, 1, 0, -1][i % 5]; // on time, late and early runs
        visits.push({ MonitoringRef: stopId, MonitoredVehicleJourney: journey(p, tripId, stopId, start + mins * MIN, true, delay) });
      });
    }
  }
  // A J bus-substitution run (no buses allowed — must be ignored).
  const bus = { ...PATTERNS[0], line: 'JBUS' };
  visits.push({ MonitoringRef: '14001', MonitoredVehicleJourney: journey(bus, 'JBUS-1', '14001', now + 2 * MIN, true) });
  return { ServiceDelivery: { StopMonitoringDelivery: { MonitoredStopVisit: visits } } };
}

/** Scheduled visits at one stop for a service day: 5:00 AM to 12:30 AM. */
export function demoTimetable(stopId, date) {
  const visits = [];
  const first = parseSf(date, '05:00');
  const last = parseSf(date, '00:30') + 24 * 60 * MIN;
  for (const p of PATTERNS) {
    const at = p.stops.find(([id]) => id === stopId);
    if (!at) continue;
    for (let i = 0, t = first + p.offset * MIN; t <= last; i++, t += p.headway * MIN) {
      const tripId = `${p.line}-${p.dir}-${date}-${i}`;
      visits.push({ MonitoringRef: stopId, TargetedVehicleJourney: journey(p, tripId, stopId, t + at[1] * MIN, false) });
    }
  }
  return { Siri: { ServiceDelivery: { StopTimetableDelivery: { TimetabledStopVisit: visits } } } };
}

export function demoEtd(route) {
  const est = (minutes, direction, color, hexcolor, length) => ({
    minutes: String(minutes), platform: direction === 'North' ? '2' : '1', direction, length: String(length),
    color, hexcolor, bikeflag: '1', delay: minutes === 16 || minutes === 11 ? '120' : '0',
  });
  const north = route.direction === 'North';
  return {
    root: {
      station: [{
        abbr: route.orig,
        etd: north
          ? [
            { destination: 'Antioch', abbreviation: 'ANTC', estimate: [est('Leaving', 'North', 'YELLOW', '#ffff33', 10), est(16, 'North', 'YELLOW', '#ffff33', 8)] },
            { destination: 'Richmond', abbreviation: 'RICH', estimate: [est(8, 'North', 'RED', '#ff0000', 8), est(28, 'North', 'RED', '#ff0000', 8)] },
            { destination: 'Berryessa', abbreviation: 'BERY', estimate: [est(24, 'North', 'GREEN', '#339933', 10)] },
            { destination: 'Millbrae', abbreviation: 'MLBR', estimate: [est(5, 'South', 'RED', '#ff0000', 8)] },
          ]
          : [
            { destination: 'SFO/Millbrae', abbreviation: 'MLBR', estimate: [est(3, 'South', 'YELLOW', '#ffff33', 10), est(18, 'South', 'YELLOW', '#ffff33', 10), est(33, 'South', 'YELLOW', '#ffff33', 10)] },
            { destination: 'Daly City', abbreviation: 'DALY', estimate: [est(11, 'South', 'BLUE', '#0099cc', 8), est(26, 'South', 'GREEN', '#339933', 8), est(41, 'South', 'BLUE', '#0099cc', 8)] },
            { destination: 'Antioch', abbreviation: 'ANTC', estimate: [est(6, 'North', 'YELLOW', '#ffff33', 10)] },
          ],
      }],
    },
  };
}

/** A BART `depart` response: trips every 10 minutes around `t`, 8 minutes each. */
export function demoDepart(route, t = Date.now()) {
  const fmt = (x) => {
    const p = sfParts(x);
    const h = p.hour % 12 || 12;
    return {
      min: `${h}:${String(p.minute).padStart(2, '0')} ${p.hour < 12 ? 'AM' : 'PM'}`,
      date: `${String(p.month).padStart(2, '0')}/${String(p.day).padStart(2, '0')}/${p.year} `,
    };
  };
  const base = Math.floor(t / (10 * MIN)) * 10 * MIN + 2 * MIN;
  const trip = [];
  for (let k = -4; k < 4; k++) {
    const dep = base + k * 10 * MIN;
    const a = fmt(dep);
    const b = fmt(dep + 8 * MIN);
    trip.push({
      '@origin': route.orig, '@destination': route.dest, '@tripTime': '8',
      '@origTimeMin': a.min, '@origTimeDate': a.date, '@destTimeMin': b.min, '@destTimeDate': b.date,
      leg: [{ '@order': '1', '@origin': route.orig, '@destination': route.dest, '@line': k % 2 ? 'ROUTE 1' : 'ROUTE 7', '@trainHeadStation': route.direction === 'North' ? 'ANTC' : 'MLBR' }],
    });
  }
  return { root: { schedule: { request: { trip } } } };
}
