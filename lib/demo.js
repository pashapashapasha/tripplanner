// Synthetic payloads shaped exactly like 511.org and BART API responses.
// Used by DEMO=1 (UI preview without API access) and by the tests.
import { PLACES } from './config.js';

const iso = (t) => new Date(t).toISOString();
const MIN = 60000;

const STOPS = [
  { id: '14001', name: 'Church St & 24th St', place: 'churchAnd24th', dir: 'IB' },
  { id: '14002', name: 'Church St & 24th St', place: 'churchAnd24th', dir: 'OB', dLat: 0.0003 },
  { id: '16995', name: 'Powell Station Inbound', place: 'powellMuni', dir: 'IB' },
  { id: '17876', name: 'Union Square/Market Street Station', place: 'unionSquare', dir: 'OB' },
  { id: '17360', name: 'UCSF/Chase Center', place: 'ucsfChase', dir: 'OB' },
  { id: '99999', name: 'Somewhere far away', lat: 37.7, lon: -122.5 },
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

function visit(stopId, stopName, line, dir, tripId, t, dest) {
  return {
    MonitoringRef: stopId,
    MonitoredVehicleJourney: {
      LineRef: line,
      DirectionRef: dir,
      FramedVehicleJourneyRef: { DataFrameRef: '2026-10-06', DatedVehicleJourneyRef: tripId },
      DestinationName: dest,
      VehicleRef: `${line}-${tripId.slice(-3)}`,
      Occupancy: 'seatsAvailable',
      MonitoredCall: {
        StopPointRef: stopId,
        StopPointName: stopName,
        VehicleAtStop: '',
        DestinationDisplay: dest,
        AimedArrivalTime: iso(t - MIN),
        ExpectedArrivalTime: iso(t),
        AimedDepartureTime: iso(t - MIN),
        ExpectedDepartureTime: iso(t),
      },
    },
  };
}

export function demoStopMonitoring(now = Date.now()) {
  const visits = [];
  // J inbound every 9 min; Powell prediction only for the first 4 trips (later ones estimated).
  for (let i = 0; i < 7; i++) {
    const t = now + (3 + i * 9) * MIN;
    const id = `J-IB-${100 + i}`;
    visits.push(visit('14001', 'Church St & 24th St', 'J', 'IB', id, t, 'Embarcadero'));
    if (i < 4) visits.push(visit('16995', 'Powell Station Inbound', 'J', 'IB', id, t + (16 + (i % 2)) * MIN, 'Embarcadero'));
  }
  // J outbound at the other platform (must be ignored).
  for (let i = 0; i < 3; i++) {
    const id = `J-OB-${200 + i}`;
    visits.push(visit('16995', 'Powell Station Inbound', 'J', 'OB', id, now + (i * 9 - 20) * MIN, 'Balboa Park'));
    visits.push(visit('14002', 'Church St & 24th St', 'J', 'OB', id, now + (5 + i * 9) * MIN, 'Balboa Park'));
  }
  // T toward Sunnydale every 8 min from Union Square, 11 min to UCSF/Chase Center.
  for (let i = 0; i < 9; i++) {
    const t = now + (4 + i * 8) * MIN;
    const id = `T-OB-${300 + i}`;
    visits.push(visit('17876', 'Union Square/Market Street Station', 'T', 'OB', id, t, 'Sunnydale'));
    visits.push(visit('17360', 'UCSF/Chase Center', 'T', 'OB', id, t + 11 * MIN, 'Sunnydale'));
  }
  // A J bus-substitution run (no buses allowed — must be ignored).
  visits.push(visit('14001', 'Church St & 24th St', 'JBUS', 'IB', 'JBUS-1', now + 2 * MIN, 'Embarcadero'));
  return { ServiceDelivery: { StopMonitoringDelivery: { MonitoredStopVisit: visits } } };
}

export function demoEtd() {
  const est = (minutes, direction, color, hexcolor, length) => ({
    minutes: String(minutes), platform: direction === 'North' ? '2' : '1', direction, length: String(length),
    color, hexcolor, bikeflag: '1', delay: '0',
  });
  return {
    root: {
      station: [{
        name: '24th St. Mission',
        abbr: '24TH',
        etd: [
          { destination: 'Antioch', abbreviation: 'ANTC', estimate: [est('Leaving', 'North', 'YELLOW', '#ffff33', 10), est(16, 'North', 'YELLOW', '#ffff33', 8)] },
          { destination: 'Richmond', abbreviation: 'RICH', estimate: [est(8, 'North', 'RED', '#ff0000', 8), est(28, 'North', 'RED', '#ff0000', 8)] },
          { destination: 'Berryessa', abbreviation: 'BERY', estimate: [est(24, 'North', 'GREEN', '#339933', 10)] },
          { destination: 'Millbrae', abbreviation: 'MLBR', estimate: [est(5, 'South', 'RED', '#ff0000', 8)] },
        ],
      }],
    },
  };
}

export function demoSchedule() {
  return { root: { schedule: { request: { trip: [{ '@tripTime': '8' }, { '@tripTime': '9' }, { '@tripTime': '8' }] } } } };
}
