import { buildItineraries, mergeLegs } from './itinerary.js';
import { TZ, sfDate, sfClock, sfParts, parseSf } from './time.js';

const REFRESH_MS = 30000;
const MIN = 60000;
const $ = (id) => document.getElementById(id);
const fmt = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', timeZone: TZ });
const dayFmt = new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: TZ });
const time = (t) => fmt.format(t);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

// Station names and labels for each leg, per direction.
const LEGS = {
  work: {
    j: { from: 'Church & 24th', to: 'Powell', board: 'Church & 24th → Powell' },
    bart: { from: '24th St Mission', to: 'Powell St', board: '24th St Mission → Powell' },
    t: { from: 'Union Square/Market St', to: 'UCSF/Chase Center', board: 'Union Square → UCSF/Chase Center' },
  },
  home: {
    t: { from: 'UCSF/Chase Center', to: 'Union Square/Market St', board: 'UCSF/Chase Center → Union Square' },
    j: { from: 'Powell', to: 'Church & 24th', board: 'Powell → Church & 24th' },
    bart: { from: 'Powell St', to: '24th St Mission', board: 'Powell → 24th St Mission' },
  },
};
const ENDS = {
  work: { start: 'home', end: 'Uber HQ', title: '24th &amp; Church <span class="arrow">→</span> Uber HQ', via: 'J Church or BART to Powell, then T Third. No buses.' },
  home: { start: 'Uber HQ', end: 'home', title: 'Uber HQ <span class="arrow">→</span> 24th &amp; Church', via: 'T Third to Union Square, then J Church or BART from Powell. No buses.' },
};
const BOARD_ORDER = { work: ['j', 'bart', 't'], home: ['t', 'j', 'bart'] };
const PILL = { j: '<span class="pill j">J</span>', t: '<span class="pill t">T</span>' };

let live = null;
let lastFetch = 0;
let loadedVersion = null;
let settings = null;
const schedules = new Map(); // 'date time' -> response | {error} | 'loading'
const openDetails = new Set(); // trips whose Details panel is expanded, kept across re-renders
const state = {
  direction: sfParts(Date.now()).hour < 13 ? 'work' : 'home',
  when: 'now',
  at: null, // epoch ms for depart/arrive
  modes: load('mode') || 'all',
};

function load(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } }
function save(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} }

function minsUntil(t, now) {
  const m = Math.floor((t - now) / MIN);
  if (m <= 0) return 'now';
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}

const pill = (kind, leg) => kind === 'bart'
  ? `<span class="pill bart" style="--bartline:${esc(leg?.color || '#0099d8')}">BART</span>`
  : PILL[kind];

async function getJson(url) {
  const res = await fetch(url);
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch {}
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${body?.error || text.slice(0, 300)}`);
  return body;
}

async function refresh() {
  try {
    live = await getJson('/api/commute');
    lastFetch = Date.now();
    // A tab left open would otherwise keep running the code it was loaded with.
    loadedVersion ??= live.version;
    if (live.version && live.version !== loadedVersion) return location.reload();
    if (!settings) {
      settings = { ...live.defaults, ...(load('settings') || {}) };
      fillSettings();
    }
    live.fetchError = null;
  } catch (e) {
    if (!live) live = { fetchError: e.message };
    else live.fetchError = e.message;
  }
  render();
}

// Schedules are requested per 15-minute slot so responses cache well.
function scheduleKey() {
  const slot = Math.floor(state.at / (15 * MIN)) * 15 * MIN;
  return `${sfDate(slot)} ${sfClock(slot)}`;
}

async function loadSchedule() {
  if (state.when === 'now' || !state.at) return;
  const key = scheduleKey();
  const existing = schedules.get(key);
  if (existing && !existing.error) return; // loaded or loading; errors are retried
  schedules.set(key, 'loading');
  render();
  const [date, clock] = key.split(' ');
  try {
    schedules.set(key, await getJson(`/api/schedule?date=${date}&time=${clock}`));
  } catch (e) {
    schedules.set(key, { error: e.message });
  }
  render();
}

function currentSchedule() {
  return state.when === 'now' || !state.at ? null : schedules.get(scheduleKey());
}

function render() {
  const d = state.direction;
  $('title').innerHTML = ENDS[d].title;
  $('via').textContent = ENDS[d].via;
  document.title = d === 'work' ? 'Commute to Uber HQ' : 'Commute home';
  syncControls();
  renderStatus();
  if (!live?.legs || !settings) {
    $('trips').innerHTML = live?.fetchError ? '' : '<li class="empty">Loading…</li>';
    return;
  }
  renderTrips();
  renderBoards();
}

function renderStatus() {
  const now = Date.now();
  const problems = [];
  if (live?.fetchError) problems.push(`Server error: ${live.fetchError}`);
  if (live?.sources) {
    const { muni, bart } = live.sources;
    const age = (s) => (s.fetchedAt ? `${Math.max(0, Math.round((now - s.fetchedAt) / 1000))}s ago` : '—');
    $('status').innerHTML =
      `<span class="dot ${muni.ok ? 'ok' : 'bad'}"></span>Muni ${age(muni)} ` +
      `<span class="dot ${bart.ok ? 'ok' : 'bad'}"></span>BART ${age(bart)}` +
      (live.demo ? ' <span class="demo">DEMO DATA</span>' : '');
    if (muni.error) problems.push(`Muni: ${muni.error}`);
    if (bart.error) problems.push(`BART: ${bart.error}`);
    if (muni.stale || bart.stale) problems.push('Showing the last good live data.');
  } else if (live?.fetchError) {
    $('status').textContent = 'Live data unavailable. Retrying…';
  }
  const sched = currentSchedule();
  if (sched?.error) problems.push(`Schedule: ${sched.error}`);
  if (sched?.sources?.muni.error) problems.push(`Muni schedule: ${sched.sources.muni.error}`);
  if (sched?.sources?.bart.error) problems.push(`BART schedule: ${sched.sources.bart.error}`);
  $('banner').hidden = !problems.length;
  $('banner').innerHTML = problems.map((p) => `<div>${esc(p)}</div>`).join('');
}

function planningLegs() {
  const liveLegs = live.legs[state.direction];
  const sched = currentSchedule();
  if (state.when === 'now' || !sched?.legs) return liveLegs;
  const s = sched.legs[state.direction];
  return { j: mergeLegs(liveLegs.j, s.j), t: mergeLegs(liveLegs.t, s.t), bart: mergeLegs(liveLegs.bart, s.bart) };
}

function renderTrips() {
  const now = Date.now();
  const { when, at, direction } = state;
  $('trips-title').textContent = when === 'now' ? 'Next trips'
    : `${when === 'depart' ? 'Leaving after' : 'Arriving by'} ${time(at)}${sfDate(at) === sfDate(now) ? '' : `, ${dayFmt.format(at)}`}`;
  const note = when === 'now' ? null : currentSchedule()?.sources?.muni.note;
  $('trips-note').hidden = !note;
  $('trips-note').textContent = note || '';
  if (when !== 'now' && currentSchedule() === 'loading') {
    $('trips').innerHTML = '<li class="empty">Loading schedule…</li>';
    return;
  }
  const modes = state.modes === 'all' ? ['J', 'BART'] : [state.modes];
  const trips = buildItineraries(planningLegs(), settings, { direction, now, when, at, modes, limit: 8 });
  if (!trips.length) {
    const why = when === 'now'
      ? 'No connections found in the live prediction window.'
      : at < now ? 'That time has already passed.' : 'No connections found around that time.';
    $('trips').innerHTML = `<li class="empty">${why}</li>`;
    return;
  }
  const best = when === 'arrive'
    ? Math.max(...trips.map((t) => t.leaveBy))
    : Math.min(...trips.map((t) => t.arriveAt));
  $('trips').innerHTML = trips
    .map((tr) => tripCard(tr, now, (when === 'arrive' ? tr.leaveBy : tr.arriveAt) === best))
    .join('');
}

function legKind(tr, i) {
  return i === 0 ? tr.route.first : tr.route.second;
}

/**
 * A time, with the schedule next to live predictions: the predicted time, plus the
 * struck-through scheduled time and how far off it is, or "on time".
 */
function clock(t, aimed, live) {
  if (!live || !aimed) return time(t);
  const diff = Math.round((t - aimed) / MIN);
  if (diff === 0) return `${time(t)}<small class="ontime">on time</small>`;
  const label = `${Math.abs(diff)} min ${diff > 0 ? 'late' : 'early'}`;
  return `<span class="${diff > 0 ? 'late' : 'early'}">${time(t)}</span>` +
    `<small><s aria-label="scheduled ${time(aimed)}">${time(aimed)}</s> ${label}</small>`;
}

function legText(kind, leg) {
  if (kind === 'j') return `J Church to ${esc(leg.destination || (state.direction === 'work' ? 'downtown' : 'Balboa Park'))}${leg.vehicle ? ` · car ${esc(leg.vehicle)}` : ''}`;
  if (kind === 't') return `T Third to ${esc(leg.destination || (state.direction === 'work' ? 'Sunnydale' : 'Chinatown'))}${leg.vehicle ? ` · car ${esc(leg.vehicle)}` : ''}`;
  return `${esc(leg.destination || 'BART')} train${leg.cars ? ` · ${leg.cars} cars` : ''}`;
}

const est = (leg) => (leg.arrEstimated ? ' <abbr class="est" title="Estimated from typical ride time">est.</abbr>' : '');
const sched = (leg) => (leg.scheduled ? ' <abbr class="sched" title="From the published schedule, not a live prediction">sched.</abbr>' : '');

function tripCard(tr, now, isBest) {
  const d = state.direction;
  const [a, b] = tr.legs;
  const [ka, kb] = [legKind(tr, 0), legKind(tr, 1)];
  const info = LEGS[d];
  const leaveIn = tr.leaveBy - now;
  const soon = leaveIn < 90 * MIN;
  const urgency = leaveIn < 2 * MIN ? 'urgent' : leaveIn < 6 * MIN ? 'soon' : '';
  const otherDay = sfDate(tr.leaveBy) !== sfDate(now);
  const leaveBig = !soon ? `Leave ${time(tr.leaveBy)}` : leaveIn <= MIN ? 'Leave now' : `Leave in ${minsUntil(tr.leaveBy, now)}`;
  const leaveSub = !soon ? (otherDay ? dayFmt.format(tr.leaveBy) : `in ${minsUntil(tr.leaveBy, now)}`) : `by ${time(tr.leaveBy)}`;
  const tags = [
    isBest && `<span class="tag best">${state.when === 'arrive' ? 'Latest departure' : 'Earliest arrival'}</span>`,
    tr.waitMin >= 8 && `<span class="tag warn">${tr.waitMin} min wait at Powell</span>`,
    tr.scheduled && '<span class="tag">Scheduled times</span>',
  ].filter(Boolean).join('');
  const key = `${d}:${tr.mode}:${a.tripId}`;
  const walkStart = settings[tr.route.walkStart];
  const walkEnd = settings[tr.route.walkEnd];
  const endText = d === 'work' ? `Uber HQ, ${esc(live.destination.address)}` : 'home (24th &amp; Church)';

  return `<li class="trip">
    <div class="trip-top">
      <div class="leave ${soon ? urgency : ''}">
        <div class="big">${leaveBig}</div>
        <div class="sub">${leaveSub}</div>
      </div>
      <div class="chain">${pill(ka, a)}<span class="sep">›</span>${pill(kb, b)}</div>
      <div class="arrive">
        <div class="big">${time(tr.arriveAt)}</div>
        <div class="sub">${tr.totalMin} min door to door${tr.estimated ? ' <abbr class="est" title="Includes an estimated arrival">est.</abbr>' : ''}</div>
      </div>
    </div>
    ${tags ? `<div class="tags">${tags}</div>` : ''}
    <details data-key="${esc(key)}"${openDetails.has(key) ? ' open' : ''}>
      <summary>Details</summary>
      <ol class="steps">
        <li><span class="when">${time(tr.leaveBy)}</span><span>Walk ${walkStart} min from ${ENDS[d].start} to ${esc(info[ka].from)}</span></li>
        <li><span class="when">${clock(a.dep, a.depAimed, a.depLive)}</span><span>${pill(ka, a)} ${legText(ka, a)}${sched(a)}</span></li>
        <li><span class="when">${clock(tr.atTransfer, a.arrAimed, a.arrLive)}</span><span>Arrive ${esc(info[ka].to)}${est(a)}; ${tr.transferMin} min transfer to ${esc(info[kb].from)}</span></li>
        <li><span class="when">${clock(b.dep, b.depAimed, b.depLive)}</span><span>${pill(kb, b)} ${legText(kb, b)} · ${tr.waitMin} min wait${sched(b)}</span></li>
        <li><span class="when">${clock(b.arr, b.arrAimed, b.arrLive)}</span><span>Arrive ${esc(info[kb].to)}${est(b)}</span></li>
        <li><span class="when">${time(tr.arriveAt)}</span><span>Walk ${walkEnd} min to ${endText}</span></li>
      </ol>
    </details>
  </li>`;
}

function renderBoards() {
  const now = Date.now();
  const d = state.direction;
  const legs = live.legs[d];
  const train = {
    j: (l) => `J to ${esc(l.destination || '—')}`,
    t: (l) => `T to ${esc(l.destination || '—')}`,
    bart: (l) => `<i class="swatch" style="background:${esc(l.color)}"></i>${esc(l.destination)}${l.cars ? ` · ${l.cars} cars` : ''}`,
  };
  $('boards').innerHTML = BOARD_ORDER[d].map((kind) => {
    const { to, board } = LEGS[d][kind];
    const rows = legs[kind].filter((l) => l.dep > now - 30000).slice(0, 6);
    const body = rows.length
      ? rows.map((l) => `<li>
          <span class="mins">${minsUntil(l.dep, now)}</span>
          <span class="what">${train[kind](l)}<small>reaches ${esc(to)} ${l.arrEstimated ? '~' : ''}${time(l.arr)}</small></span>
          <span class="clock">${clock(l.dep, l.depAimed, l.depLive)}</span>
        </li>`).join('')
      : '<li class="empty">No live departures</li>';
    return `<div class="board"><h3>${pill(kind)} ${esc(board)}</h3><ul>${body}</ul></div>`;
  }).join('');
  if (live.stops) {
    $('stops').textContent = `Stops in use — J: ${live.stops.j.join(', ') || 'none found'}; T: ${live.stops.t.join(', ') || 'none found'}.`;
  }
}

// --- Controls ---

function syncControls() {
  for (const [id, value] of [['direction', state.direction], ['when', state.when], ['modes', state.modes]]) {
    for (const b of $(id).querySelectorAll('button')) b.classList.toggle('on', b.dataset.value === value);
  }
  $('at').hidden = state.when === 'now';
}

function defaultAt() {
  // Next quarter hour, at least 15 minutes from now.
  return Math.ceil((Date.now() + 15 * MIN) / (15 * MIN)) * 15 * MIN;
}

function onSeg(id, fn) {
  $(id).addEventListener('click', (e) => {
    const value = e.target.closest('button')?.dataset.value;
    if (value) fn(value);
  });
}

onSeg('direction', (v) => { state.direction = v; render(); });
onSeg('modes', (v) => { state.modes = v; save('mode', v); render(); });
onSeg('when', (v) => {
  state.when = v;
  if (v !== 'now') {
    if (!state.at || state.at < Date.now()) state.at = defaultAt();
    $('at').value = `${sfDate(state.at)}T${sfClock(state.at)}`;
  }
  render();
  loadSchedule();
});
$('at').addEventListener('change', () => {
  const [date, clock] = $('at').value.split('T');
  if (!date || !clock) return;
  state.at = parseSf(date, clock.slice(0, 5));
  render();
  loadSchedule();
});

function fillSettings() {
  for (const [k, v] of Object.entries(settings)) {
    const input = $('settings').elements[k];
    if (input) input.value = v;
  }
}

$('trips').addEventListener('toggle', (e) => {
  const key = e.target.dataset?.key;
  if (key) e.target.open ? openDetails.add(key) : openDetails.delete(key);
}, true);
$('settings').addEventListener('input', (e) => {
  const v = Number(e.target.value);
  if (!e.target.name || !Number.isFinite(v) || v < 0) return;
  settings[e.target.name] = v;
  save('settings', settings);
  render();
});
$('reset').addEventListener('click', () => {
  settings = { ...live.defaults };
  save('settings', null);
  fillSettings();
  render();
});

render();
refresh();
setInterval(() => { if (!document.hidden) refresh(); }, REFRESH_MS);
setInterval(render, 1000);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && Date.now() - lastFetch > 10000) refresh();
});
