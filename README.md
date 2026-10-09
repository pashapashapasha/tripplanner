# Commute: 24th & Church → Uber HQ

A small web app that plans the trip from 24th & Church to Uber HQ (1725 3rd St) using live data, on this route only:

1. **J Church** from Church & 24th, **or** walk to **24th St Mission BART** and take any northbound train
2. Get off at **Powell**, walk through the concourse to **Union Square/Market St**
3. **T Third** southbound to **UCSF/Chase Center**, then walk to Uber HQ

No buses: the JBUS/TBUS bus substitutions are filtered out.

The **To home** toggle plans the reverse trip: T Third north from UCSF/Chase Center to Union Square, then the J outbound or BART south from Powell, then walk home.

For each trip it shows when to leave, door-to-door time, arrival time, the wait at Powell, and each leg with its times. It also shows live departure boards for the three boarding points in the chosen direction. If several first legs feed into the same second train, only the one that leaves latest is shown: leaving earlier would just mean a longer wait at Powell.

**Now / Depart at / Arrive by:** "Now" uses live predictions. A chosen date and time uses published schedules, with live predictions replacing them for anything within the live window (roughly the next hour).

## Deploy to Vercel

1. On vercel.com: **Add New → Project**, then import this GitHub repo. No build settings are needed: Vercel detects `server.js` and runs it as a function, and serves `public/` from its CDN.
2. Under **Environment Variables**, add `API_511_KEY` with your 511.org token (and optionally `BART_API_KEY`).
3. Deploy.

If you add or change an environment variable later, redeploy so it takes effect.

## Run locally

```sh
API_511_KEY=your-511-token npm start      # http://localhost:3000
```

* **511.org key (required for J/T):** free at <https://511.org/open-data/token>.
* **BART key (optional):** `BART_API_KEY`. Defaults to BART's public key.
* `npm run demo` serves synthetic data so you can preview the UI without keys.
* `npm test` runs the parser and planner tests.

Node 18+ is required. There are no dependencies.

## How it works

* **Muni (J, T):** a single agency-wide 511 SIRI `StopMonitoring` call per refresh. A J run's departure from Church & 24th is matched to its own arrival at Powell by trip ID, and a T run's departure from Union Square to its arrival at UCSF/Chase Center. When the downstream prediction isn't published yet, the arrival is estimated from typical ride time and marked **est.**, and the train is only kept if its direction, destination and platform agree with confirmed trips (destinations confirmed for the opposite direction, like Balboa Park for an inbound J, are rejected).
* **BART:** real-time `etd` at 24th St (northbound) and Powell (southbound). Ride times come from BART's schedule API, which also provides planned trips for a chosen time.
* **Schedules:** Muni timetables come from 511's `stoptimetable` API for the J/T platforms only (about 8 requests), cached. If 511 rejects the date window (it has answered HTTP 412), the app remembers that after one probe request and uses 511's default timetable, applying it to other days of the same kind (weekday, Saturday, Sunday) with a note on the page. `/api/schedule?date=YYYY-MM-DD&time=HH:MM` returns scheduled legs for both directions.
* **Rate limits:** 511 allows 60 requests per hour per key. The server caches Muni for 80 s (`MUNI_CACHE_SECONDS`) and BART for 30 s. On Vercel, the live response is also CDN-cached for 30 s, schedule responses for an hour, and the page stops polling while its tab is hidden.
* **Stops** are found by proximity to known coordinates using 511's stop list. When that list is unavailable (it has had outages), J/T stops are matched by name in the live data instead, and the list is retried every 15 minutes. If one is ever wrong, pin the 511 stop codes with `STOPS_J_ORIGIN`, `STOPS_J_POWELL`, `STOPS_T_ORIGIN`, `STOPS_T_DEST` (comma-separated).
* Walking and transfer times (defaults: 1 min to the J, 19 min walk to BART, 6/7 min Powell transfer, 4 min from the T to the office) can be edited in the app. They are saved in your browser.
