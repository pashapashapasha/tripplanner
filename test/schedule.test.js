// End-to-end schedule flow against a fake 511 that, like the real one, rejects the
// StartTime/EndTime window (HTTP 412) and otherwise only returns today's timetable.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { demoStops, demoStopMonitoring, demoTimetable, demoEtd, demoDepart } from '../lib/demo.js';
import { bartTime } from '../lib/bart.js';
import { BART, DEFAULT_SETTINGS } from '../lib/config.js';
import { buildItineraries } from '../public/itinerary.js';
import { sfDate, addDays, parseSf } from '../public/time.js';
import { dayType } from '../lib/muni.js';

process.env.API_511_KEY = 'test-key';
const TODAY = sfDate(Date.now());
const calls = [];
const json = (body, status = 200) => new Response(JSON.stringify(body), { status });

globalThis.fetch = async (input) => {
  const url = new URL(input);
  const q = url.searchParams;
  calls.push(url);
  if (url.pathname.endsWith('/stops')) return json(demoStops());
  if (url.pathname.endsWith('/StopMonitoring')) return json(demoStopMonitoring(Date.now()));
  if (url.pathname.endsWith('/stoptimetable')) {
    if (q.has('StartTime')) return new Response('Precondition Failed', { status: 412 });
    return json(demoTimetable(q.get('MonitoringRef'), TODAY));
  }
  const route = q.get('orig') === '24TH' ? BART.work : BART.home;
  if (url.pathname.endsWith('/etd.aspx')) return json(demoEtd(route));
  if (url.pathname.endsWith('/sched.aspx')) {
    const t = q.get('time') ? bartTime(q.get('date'), q.get('time').replace(/(am|pm)$/, ' $1').toUpperCase()) : Date.now();
    return json(demoDepart(route, t));
  }
  return new Response('not found', { status: 404 });
};

const { schedule } = await import('../lib/commute.js');
const timetableCalls = () => calls.filter((u) => u.pathname.endsWith('/stoptimetable'));

test('a rejected window falls back to the default timetable, projected onto the same kind of day', async () => {
  const date = addDays(TODAY, 7); // same weekday next week
  const res = await schedule(date, '07:15');
  assert.equal(res.sources.muni.ok, true, res.sources.muni.error);
  assert.match(res.sources.muni.note, /timetable/);
  const { j, t, bart } = res.legs.work;
  assert.ok(j.length > 100 && t.length > 100 && bart.length > 0);
  assert.ok(j.every((l) => muniDate(l.dep) === date && l.tripId.endsWith(`@${date}`)));

  // One probe with the window, then the default window once per stop.
  const tt = timetableCalls();
  assert.equal(tt.filter((u) => u.searchParams.has('StartTime')).length, 1);
  assert.equal(tt.filter((u) => !u.searchParams.has('StartTime')).length, 8);

  const at = parseSf(date, '07:15');
  const trips = buildItineraries(res.legs.work, DEFAULT_SETTINGS, { now: Date.now(), when: 'depart', at });
  assert.ok(trips.length > 0);
  assert.ok(trips.every((tr) => tr.leaveBy >= at && tr.leaveBy < at + 60 * 60000));
});

test('later dates reuse the cached default timetable without new requests', async () => {
  const before = timetableCalls().length;
  const res = await schedule(addDays(TODAY, 14), '17:30');
  assert.equal(res.sources.muni.ok, true);
  assert.ok(res.legs.home.j.length > 100);
  assert.equal(timetableCalls().length, before);
});

test('a different kind of day explains why there are no Muni times', async () => {
  const other = [1, 2, 3, 4, 5, 6].map((n) => addDays(TODAY, n)).find((d) => dayType(d) !== dayType(TODAY));
  const res = await schedule(other, '09:00');
  assert.equal(res.sources.muni.ok, false);
  assert.match(res.sources.muni.error, /different/);
  assert.ok(res.legs.work.bart.length > 0, 'BART schedules still work');
});

function muniDate(t) {
  return sfDate(t - 3 * 60 * 60000);
}
