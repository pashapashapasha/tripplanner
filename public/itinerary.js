// Combines first-leg departures (J or BART) with T Third departures from Union Square.
// Pure and dependency-free: the server tests it and the browser imports it directly,
// so changing walk/transfer settings in the UI re-plans instantly.

const MIN = 60000;

/**
 * @param legs {j, bart, t}: arrays of {tripId, dep, arr, ...} with epoch-ms times
 * @param settings {walkToJ, walkToBart, transferJ, transferBart, walkFromT} in minutes
 */
export function buildItineraries(legs, settings, now = Date.now(), { limit = 10 } = {}) {
  const t = [...(legs.t || [])].sort((a, b) => a.dep - b.dep);
  const firsts = [
    ...(legs.j || []).map((l) => ({ mode: 'J', leg: l, walk: settings.walkToJ, transfer: settings.transferJ })),
    ...(legs.bart || []).map((l) => ({ mode: 'BART', leg: l, walk: settings.walkToBart, transfer: settings.transferBart })),
  ];

  const trips = [];
  for (const f of firsts) {
    const leaveBy = f.leg.dep - f.walk * MIN;
    if (leaveBy < now - 30000) continue; // can't make it anymore
    const atPowell = f.leg.arr;
    const readyAt = atPowell + f.transfer * MIN;
    const tLeg = t.find((x) => x.dep >= readyAt);
    if (!tLeg) continue; // no T prediction far enough out yet
    const arriveAt = tLeg.arr + settings.walkFromT * MIN;
    trips.push({
      mode: f.mode,
      leaveBy,
      first: f.leg,
      atPowell,
      readyAt,
      transferMin: f.transfer,
      waitMin: Math.round((tLeg.dep - readyAt) / MIN),
      t: tLeg,
      arriveAt,
      totalMin: Math.round((arriveAt - leaveBy) / MIN),
      estimated: !f.leg.arrLive || !tLeg.arrLive,
    });
  }

  // Several first legs can feed the same T; the one leaving latest is the smart pick.
  const latestPerT = new Map();
  for (const tr of trips) {
    const best = latestPerT.get(tr.t.tripId);
    if (!best || tr.leaveBy > best.leaveBy) latestPerT.set(tr.t.tripId, tr);
  }
  for (const tr of trips) tr.superseded = latestPerT.get(tr.t.tripId) !== tr;

  trips.sort((a, b) => a.arriveAt - b.arriveAt || b.leaveBy - a.leaveBy);
  return trips.slice(0, limit);
}
