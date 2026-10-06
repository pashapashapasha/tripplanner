// Builds two-leg trips: (J or BART) + T Third to work, T Third + (J or BART) home.
// Pure and dependency-free: the server tests it and the browser imports it directly,
// so changing settings, direction or time in the UI re-plans instantly.

const MIN = 60000;

// `first`/`second` name the leg lists; the rest name walking/transfer settings (minutes).
export const ROUTES = {
  work: [
    { mode: 'J', first: 'j', second: 't', walkStart: 'walkToJ', transfer: 'transferJ', walkEnd: 'walkFromT' },
    { mode: 'BART', first: 'bart', second: 't', walkStart: 'walkToBart', transfer: 'transferBart', walkEnd: 'walkFromT' },
  ],
  home: [
    { mode: 'J', first: 't', second: 'j', walkStart: 'walkFromT', transfer: 'transferJ', walkEnd: 'walkToJ' },
    { mode: 'BART', first: 't', second: 'bart', walkStart: 'walkFromT', transfer: 'transferBart', walkEnd: 'walkToBart' },
  ],
};

/**
 * @param legs {j, bart, t}: arrays of {tripId, dep, arr, ...} with epoch-ms times
 * @param settings {walkToJ, walkToBart, transferJ, transferBart, walkFromT} in minutes
 * @param opts.when 'now' | 'depart' | 'arrive'; opts.at is the target time for the latter two
 */
export function buildItineraries(legs, settings, opts = {}) {
  const { direction = 'work', now = Date.now(), when = 'now', at = now, modes = ['J', 'BART'], limit = 8 } = opts;
  const trips = [];
  for (const route of ROUTES[direction]) {
    if (!modes.includes(route.mode)) continue;
    const seconds = [...(legs[route.second] || [])].sort((a, b) => a.dep - b.dep);
    for (const a of legs[route.first] || []) {
      const leaveBy = a.dep - settings[route.walkStart] * MIN;
      const readyAt = a.arr + settings[route.transfer] * MIN;
      const b = seconds.find((x) => x.dep >= readyAt);
      if (!b) continue; // nothing to connect to (yet)
      const arriveAt = b.arr + settings[route.walkEnd] * MIN;
      trips.push({
        mode: route.mode,
        route,
        legs: [a, b],
        leaveBy,
        atTransfer: a.arr,
        readyAt,
        transferMin: settings[route.transfer],
        waitMin: Math.round((b.dep - readyAt) / MIN),
        arriveAt,
        totalMin: Math.round((arriveAt - leaveBy) / MIN),
        estimated: Boolean(a.arrEstimated || b.arrEstimated),
        scheduled: Boolean(a.scheduled || b.scheduled),
      });
    }
  }

  const makeable = trips.filter((tr) => tr.leaveBy >= now - 30000);
  const wanted = makeable.filter((tr) =>
    when === 'depart' ? tr.leaveBy >= at : when === 'arrive' ? tr.arriveAt <= at : true);

  // Several first legs can feed the same second leg (e.g. two J trains reaching Powell in
  // time for the same T). Leaving earlier only means waiting longer, so keep the one
  // that leaves latest.
  const best = new Map();
  for (const tr of wanted) {
    const key = tr.legs[1].tripId;
    if (!best.has(key) || tr.leaveBy > best.get(key).leaveBy) best.set(key, tr);
  }
  const options = [...best.values()].sort((a, b) => a.arriveAt - b.arriveAt || b.leaveBy - a.leaveBy);
  // For "arrive by", the options that get you there closest to (but not after) the target.
  return when === 'arrive' ? options.slice(-limit) : options.slice(0, limit);
}

/**
 * Live legs, extended with scheduled legs beyond the live prediction horizon.
 * Used for "depart at"/"arrive by" so the next hour reflects real-time predictions.
 */
export function mergeLegs(live = [], scheduled = []) {
  if (!live.length) return scheduled;
  const lastLive = Math.max(...live.map((l) => l.dep));
  const liveIds = new Set(live.map((l) => l.tripId));
  return [...live, ...scheduled.filter((s) => !liveIds.has(s.tripId) && s.dep > lastLive + MIN)]
    .sort((a, b) => a.dep - b.dep);
}
