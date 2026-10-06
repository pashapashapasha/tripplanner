# Commute: 24th & Church → Uber HQ

A small web app that plans the trip from 24th & Church to Uber HQ (1725 3rd St) using live data, on this route only:

1. **J Church** from Church & 24th, **or** walk to **24th St Mission BART** and take any northbound train
2. Get off at **Powell**, walk through the concourse to **Union Square/Market St**
3. **T Third** southbound to **UCSF/Chase Center**, then walk to Uber HQ

No buses: the JBUS/TBUS bus substitutions are filtered out.

For each upcoming trip it shows when to leave, door-to-door time, arrival time, the wait at Powell, and each leg with its times. It also shows live departure boards for all three boarding points. If several first legs feed into the same T, the earlier ones are dimmed ("same T as a later option") because you can leave later and still get there at the same time.

## Run it

```sh
API_511_KEY=your-511-token npm start      # http://localhost:3000
```

* **511.org key (required for J/T):** free at <https://511.org/open-data/token>.
* **BART key (optional):** `BART_API_KEY`. Defaults to BART's public key.
* `npm run demo` serves synthetic data so you can preview the UI without keys.
* `npm test` runs the parser and planner tests.

Node 18+ is required. There are no dependencies.

## How it works

* **Muni (J, T):** a single agency-wide 511 SIRI `StopMonitoring` call per refresh. A J run's departure from Church & 24th is matched to its own arrival at Powell by trip ID, and a T run's departure from Union Square to its arrival at UCSF/Chase Center. When the downstream prediction isn't published yet, the arrival is estimated from typical ride time and marked **est.**
* **BART:** real-time `etd` for 24th St, northbound only. Ride time to Powell comes from BART's schedule API.
* **Rate limits:** 511 allows 60 requests per hour per key. The server caches Muni for 80 s (`MUNI_CACHE_SECONDS`) and BART for 30 s, so any number of open tabs share those requests.
* **Stops** are found by proximity to known coordinates using 511's stop list. If one is ever wrong, pin the 511 stop codes with `STOPS_J_ORIGIN`, `STOPS_J_POWELL`, `STOPS_T_ORIGIN`, `STOPS_T_DEST` (comma-separated).
* Walking and transfer times (defaults: 1 min to the J, 19 min walk to BART, 6/7 min Powell transfer, 4 min from the T to the office) can be edited in the app. They are saved in your browser.
