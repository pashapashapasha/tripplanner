// San Francisco wall-clock helpers, shared by the server and the browser.
export const TZ = 'America/Los_Angeles';

const partsFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
});

/** {year, month, day, hour, minute} of epoch ms `t` in San Francisco. */
export function sfParts(t) {
  const p = Object.fromEntries(partsFmt.formatToParts(t).map((x) => [x.type, Number(x.value)]));
  return { year: p.year, month: p.month, day: p.day, hour: p.hour % 24, minute: p.minute, second: p.second };
}

const offsetMs = (t) => {
  const p = sfParts(t);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(t / 1000) * 1000;
};

/** Epoch ms for a San Francisco wall-clock time (month is 1-based). */
export function sfTime(year, month, day, hour = 0, minute = 0) {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  let t = guess - offsetMs(guess);
  const again = guess - offsetMs(t); // correct when the guess straddles a DST change
  if (again !== t) t = again;
  return t;
}

const pad = (n) => String(n).padStart(2, '0');

/** 'YYYY-MM-DD' of `t` in San Francisco. */
export function sfDate(t) {
  const p = sfParts(t);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

/** 'HH:MM' (24h) of `t` in San Francisco. */
export function sfClock(t) {
  const p = sfParts(t);
  return `${pad(p.hour)}:${pad(p.minute)}`;
}

/** Parse 'YYYY-MM-DD' + 'HH:MM' as San Francisco time. */
export function parseSf(date, clock = '00:00') {
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mm] = clock.split(':').map(Number);
  return sfTime(y, m, d, hh, mm);
}

/** 'YYYY-MM-DD' `days` after `date`. */
export function addDays(date, days) {
  return sfDate(parseSf(date, '12:00') + days * 86400000);
}
