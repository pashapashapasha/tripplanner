// 511's stop list endpoint has outages (HTTP 500 with an HTML page). Live J/T data must
// keep working by matching stops by name, without hammering the failing endpoint.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { demoStopMonitoring, demoTimetable, demoEtd, demoDepart } from '../lib/demo.js';
import { BART } from '../lib/config.js';
import { sfDate, addDays } from '../public/time.js';

process.env.API_511_KEY = 'test-key';
const TODAY = sfDate(Date.now());
const calls = [];
const json = (body) => new Response(JSON.stringify(body));

globalThis.fetch = async (input) => {
  const url = new URL(input);
  calls.push(url.pathname);
  if (url.pathname.endsWith('/stops')) {
    return new Response('<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Strict//EN"><html><head>', { status: 500 });
  }
  if (url.pathname.endsWith('/StopMonitoring')) return json(demoStopMonitoring(Date.now()));
  if (url.pathname.endsWith('/stoptimetable')) return json(demoTimetable(url.searchParams.get('MonitoringRef'), TODAY));
  const route = url.searchParams.get('orig') === '24TH' ? BART.work : BART.home;
  if (url.pathname.endsWith('/etd.aspx')) return json(demoEtd(route));
  return json(demoDepart(route));
};

const { commute, schedule } = await import('../lib/commute.js');

test('live J and T still work when the stop list is down', async () => {
  const res = await commute();
  assert.equal(res.sources.muni.ok, true, res.sources.muni.error);
  for (const d of ['work', 'home']) {
    assert.ok(res.legs[d].j.length > 0, `${d} J`);
    assert.ok(res.legs[d].t.length > 0, `${d} T`);
  }
  assert.ok(res.legs.work.j.every((l) => l.tripId.startsWith('J-IB')));
  assert.ok(res.legs.work.t.every((l) => l.tripId.startsWith('T-OB') && l.arrLive));
});

test('scheduled trips also work without the stop list', async () => {
  const res = await schedule(addDays(TODAY, 7), '08:00');
  assert.equal(res.sources.muni.ok, true, res.sources.muni.error);
  assert.ok(res.legs.work.t.length > 100 && res.legs.home.j.length > 100);
  // Only the J/T platforms found by name: 2 at each of the 4 places.
  assert.equal(calls.filter((p) => p.endsWith('/stoptimetable')).length, 8);
});

test('the failing stop list is not retried on every refresh', () => {
  assert.equal(calls.filter((p) => p.endsWith('/stops')).length, 1);
});

test('a 511 server error page becomes a short message', async () => {
  const { fetchStops } = await import('../lib/muni.js');
  await assert.rejects(fetchStops('test-key'), (e) => {
    assert.equal(e.message, "511.org stops returned HTTP 500 (a problem on 511.org's side; retrying shortly)");
    return true;
  });
});
