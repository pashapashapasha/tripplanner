// Route definition: 24th & Church -> (J Church | BART) -> Powell -> T Third -> Uber HQ.
// Stops are located by proximity to these coordinates (511 stop codes can be pinned
// with the env vars noted below if the lookup ever picks the wrong platform).

export const PLACES = {
  // Muni J Church stop at Church St & 24th St (both platforms; direction is inferred).
  churchAnd24th: { lat: 37.75163, lon: -122.42770, radius: 120, env: 'STOPS_J_ORIGIN' },
  // Muni Metro Powell St Station (Market St subway).
  powellMuni: { lat: 37.78446, lon: -122.40782, radius: 200, env: 'STOPS_J_POWELL' },
  // Central Subway Union Square/Market St Station, connected to Powell by a concourse.
  unionSquare: { lat: 37.78640, lon: -122.40660, radius: 260, env: 'STOPS_T_ORIGIN' },
  // T Third stop at UCSF/Chase Center (3rd St & 16th St), closest to Uber HQ.
  ucsfChase: { lat: 37.76665, lon: -122.38920, radius: 230, env: 'STOPS_T_DEST' },
};

export const LINES = {
  // No buses: JBUS / TBUS bus bridges are deliberately excluded.
  J: { lineRefs: ['J'], directionHint: 'IB', typicalRideMin: 17 },
  T: { lineRefs: ['T', 'KT'], directionHint: 'OB', typicalRideMin: 11 },
};

export const BART = {
  origin: '24TH',
  dest: 'POWL',
  direction: 'North', // every northbound train from 24th St Mission stops at Powell
  typicalRideMin: 8,
  // BART's public demo key; get your own at https://api.bart.gov/api/register.aspx
  defaultKey: 'MW9S-E7SL-26DU-VV8V',
};

export const DESTINATION = {
  name: 'Uber HQ',
  address: '1725 3rd St, San Francisco, CA',
  lat: 37.76770,
  lon: -122.38890,
};

// Default walking/transfer minutes. Users can override these in the UI.
export const DEFAULT_SETTINGS = {
  walkToJ: 1, // home -> Church & 24th platform
  walkToBart: 19, // 24th & Church -> 24th St Mission BART (~0.9 mi, walk only)
  transferJ: 6, // Muni Metro platform at Powell -> Union Square/Market St T platform
  transferBart: 7, // BART platform at Powell -> Union Square/Market St T platform
  walkFromT: 4, // UCSF/Chase Center -> 1725 3rd St
};

// 511.org allows 60 requests/hour per key by default. One agency-wide StopMonitoring
// call per refresh keeps us under that (default 80s => 45/hr, plus 1 stops call/day).
export const MUNI_CACHE_MS = Number(process.env.MUNI_CACHE_SECONDS || 80) * 1000;
export const BART_CACHE_MS = Number(process.env.BART_CACHE_SECONDS || 30) * 1000;
export const STOPS_CACHE_MS = 24 * 60 * 60 * 1000;
