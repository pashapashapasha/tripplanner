import { buildItineraries } from './itinerary.js';

const REFRESH_MS = 30000;
const $ = (id) => document.getElementById(id);
const fmt = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/Los_Angeles' });
const time = (t) => fmt.format(t);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

let data = null;
let lastFetch = 0;
let mode = load('mode') || 'all';
let settings = null;
const openDetails = new Set(); // trips whose Details panel is expanded, kept across re-renders

function load(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } }
function save(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} }

function minsUntil(t, now) {
  const m = Math.floor((t - now) / 60000);
  if (m <= 0) return 'now';
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}

async function refresh() {
  try {
    const res = await fetch('/api/commute');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    data = await res.json();
    lastFetch = Date.now();
    if (!settings) {
      settings = { ...data.defaults, ...(load('settings') || {}) };
      fillSettings();
    }
  } catch (e) {
    $('status').textContent = `Couldn't reach the server (${e.message}). Retrying…`;
  }
  render();
}

function render() {
  if (!data) return;
  // Device clock, not data.now: the API response may come from Vercel's CDN cache.
  const now = Date.now();
  renderStatus(now);
  renderTrips(now);
  renderBoards(now);
}

function renderStatus(now) {
  const { muni, bart } = data.sources;
  const age = (s) => (s.fetchedAt ? `${Math.max(0, Math.round((now - s.fetchedAt) / 1000))}s ago` : '—');
  $('status').innerHTML =
    `<span class="dot ${muni.ok ? 'ok' : 'bad'}"></span>Muni ${age(muni)} ` +
    `<span class="dot ${bart.ok ? 'ok' : 'bad'}"></span>BART ${age(bart)}` +
    (data.demo ? ' <span class="demo">DEMO DATA</span>' : '');
  const problems = [muni.error && `Muni: ${muni.error}`, bart.error && `BART: ${bart.error}`].filter(Boolean);
  $('banner').hidden = !problems.length;
  $('banner').innerHTML = problems.map((p) => `<div>${esc(p)}</div>`).join('') +
    (muni.stale || bart.stale ? '<div>Showing the last good data.</div>' : '');
}

function renderTrips(now) {
  const legs = {
    j: mode === 'BART' ? [] : data.legs.j,
    bart: mode === 'J' ? [] : data.legs.bart,
    t: data.legs.t,
  };
  const trips = buildItineraries(legs, settings, now, { limit: 8 });
  if (!trips.length) {
    const why = !data.legs.t.length
      ? 'No live T Third predictions at Union Square right now.'
      : 'No connections found in the live prediction window.';
    $('trips').innerHTML = `<li class="empty">${why}</li>`;
    return;
  }
  const fastest = Math.min(...trips.map((t) => t.arriveAt));
  $('trips').innerHTML = trips.map((tr) => tripCard(tr, now, tr.arriveAt === fastest)).join('');
}

function tripCard(tr, now, isFastest) {
  const f = tr.first;
  const isJ = tr.mode === 'J';
  const leaveIn = tr.leaveBy - now;
  const urgency = leaveIn < 2 * 60000 ? 'urgent' : leaveIn < 6 * 60000 ? 'soon' : '';
  const firstPill = isJ
    ? '<span class="pill j">J</span>'
    : `<span class="pill bart" style="--bartline:${esc(f.color || '#0099d8')}">BART</span>`;
  const firstDetail = isJ
    ? `J Church to ${esc(f.destination || 'downtown')}${f.vehicle ? ` · car ${esc(f.vehicle)}` : ''}`
    : `${esc(f.destination)} train${f.cars ? ` · ${f.cars} cars` : ''}${f.delaySec > 60 ? ` · ${Math.round(f.delaySec / 60)} min late` : ''}`;
  const est = (live) => (live ? '' : ' <abbr class="est" title="Estimated from typical ride time">est.</abbr>');
  const walkFirst = isJ ? settings.walkToJ : settings.walkToBart;
  const tags = [
    isFastest && '<span class="tag best">Earliest arrival</span>',
    tr.superseded && '<span class="tag">Same T as a later option</span>',
    tr.waitMin >= 8 && `<span class="tag warn">${tr.waitMin} min wait for T</span>`,
  ].filter(Boolean).join('');

  const key = `${tr.mode}:${f.tripId}`;
  return `<li class="trip ${tr.superseded ? 'dim' : ''}">
    <div class="trip-top">
      <div class="leave ${urgency}">
        <div class="big">${leaveIn <= 60000 ? 'Leave now' : `Leave in ${minsUntil(tr.leaveBy, now)}`}</div>
        <div class="sub">by ${time(tr.leaveBy)}</div>
      </div>
      <div class="chain">${firstPill}<span class="sep">›</span><span class="pill t">T</span></div>
      <div class="arrive">
        <div class="big">${time(tr.arriveAt)}</div>
        <div class="sub">${tr.totalMin} min door to door${est(!tr.estimated)}</div>
      </div>
    </div>
    ${tags ? `<div class="tags">${tags}</div>` : ''}
    <details data-key="${esc(key)}"${openDetails.has(key) ? ' open' : ''}>
      <summary>Details</summary>
      <ol class="steps">
        <li><span class="when">${time(tr.leaveBy)}</span> Walk ${walkFirst} min to ${isJ ? 'Church &amp; 24th' : '24th St Mission BART'}</li>
        <li><span class="when">${time(f.dep)}</span> ${firstPill} ${firstDetail}${est(f.depLive)}</li>
        <li><span class="when">${time(tr.atPowell)}</span> Arrive Powell St${est(f.arrLive)}; ${tr.transferMin} min transfer to Union Square/Market St</li>
        <li><span class="when">${time(tr.t.dep)}</span> <span class="pill t">T</span> T Third to ${esc(tr.t.destination || 'Sunnydale')} · ${tr.waitMin} min wait${tr.t.vehicle ? ` · car ${esc(tr.t.vehicle)}` : ''}</li>
        <li><span class="when">${time(tr.t.arr)}</span> Arrive UCSF/Chase Center${est(tr.t.arrLive)}</li>
        <li><span class="when">${time(tr.arriveAt)}</span> Walk ${settings.walkFromT} min to Uber HQ, ${esc(data.destination.address)}</li>
      </ol>
    </details>
  </li>`;
}

function boardRows(legs, now, label) {
  const rows = legs.filter((l) => l.dep > now - 30000).slice(0, 6);
  if (!rows.length) return '<li class="empty">No live departures</li>';
  return rows.map((l) => `<li><span class="mins">${minsUntil(l.dep, now)}</span><span class="what">${label(l)}</span><span class="clock">${time(l.dep)}</span></li>`).join('');
}

function renderBoards(now) {
  $('board-j').innerHTML = boardRows(data.legs.j, now, (l) => `to ${esc(l.destination || 'downtown')} · Powell ${time(l.arr)}${l.arrLive ? '' : ' est.'}`);
  $('board-bart').innerHTML = boardRows(data.legs.bart, now, (l) =>
    `<i class="swatch" style="background:${esc(l.color)}"></i>${esc(l.destination)}${l.cars ? ` · ${l.cars} cars` : ''}`);
  $('board-t').innerHTML = boardRows(data.legs.t, now, (l) => `to ${esc(l.destination || 'Sunnydale')} · UCSF ${time(l.arr)}${l.arrLive ? '' : ' est.'}`);
  if (data.stops) {
    $('stops').textContent = `Stops in use — J: ${data.stops.jOrigin.join(', ') || 'none found'} → ${data.stops.jPowell.join(', ') || 'none found'}; ` +
      `T: ${data.stops.tOrigin.join(', ') || 'none found'} → ${data.stops.tDest.join(', ') || 'none found'}.`;
  }
}

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
  settings = { ...data.defaults };
  save('settings', null);
  fillSettings();
  render();
});
for (const b of document.querySelectorAll('.filters button')) {
  b.classList.toggle('on', b.dataset.mode === mode);
  b.addEventListener('click', () => {
    mode = b.dataset.mode;
    save('mode', mode);
    document.querySelectorAll('.filters button').forEach((x) => x.classList.toggle('on', x === b));
    render();
  });
}

refresh();
setInterval(() => { if (!document.hidden) refresh(); }, REFRESH_MS);
setInterval(render, 1000);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && Date.now() - lastFetch > 10000) refresh();
});
