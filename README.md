# overhead — wall-mounted flight tracker

## Start

Requires Node 18+. No dependencies, no API keys.

```sh
npm start
# open http://localhost:8080
```

To keep it running detached from a terminal:

```sh
nohup node server/index.js >> data/server.log 2>&1 &
```

## Code organization

```
config.json          Defaults (home, radius, rings, cadence). Copy overrides
config.local.json    into config.local.json (gitignored) — the app also writes
                     home/bandwidth changes here.

server/
  index.js           The whole service: polls community ADS-B feeds with
                     failover, enriches targets (airline/heli/military/police),
                     streams snapshots to clients over SSE (/events), serves
                     the static app, and exposes small JSON endpoints
                     (/config, /usage, /airports, /geocode, POST /home,
                     POST /view, POST /bwmode). Persists usage counters and
                     settings with atomic writes.
  airlines.js        ICAO callsign prefix → airline name table.

web/
  index.html         Page shell: header bar, map, canvas, control panels.
  app.js             The display app: Leaflet basemap + one canvas overlay
                     drawing everything (icons, trails, data blocks, rings,
                     scale, airports). Dead-reckons aircraft between feed
                     snapshots (turn-rate/accel projection with smooth fix
                     correction). All UI wiring: sliders, panels, themes,
                     hover/click details, usage charts.
  style.css          Theme tokens (dark default, light override) + chrome.
  vendor/            Vendored Leaflet (no CDN at runtime).

data/                Machine-written, gitignored: usage.json (bandwidth
                     counters), airports.csv (OurAirports cache), server.log.
```

Personal settings (home location, bandwidth mode, theme, layers) live in the
browser's localStorage — nothing personal is written to disk or committed.

## License & data credits

Code is MIT licensed (see `LICENSE`). Bundled/consumed third parties:

- [Leaflet](https://leafletjs.com) — BSD-2-Clause (vendored; see
  `web/vendor/LEAFLET-LICENSE.txt`)
- Basemaps © [OpenStreetMap](https://www.openstreetmap.org/copyright)
  contributors, © [CARTO](https://carto.com/attributions) — attribution must
  stay visible in the app
- Live aircraft data: [airplanes.live](https://airplanes.live) /
  [adsb.lol](https://adsb.lol) community feeds — non-commercial use
- Geocoding: [Nominatim](https://nominatim.org) (OpenStreetMap) — rate-limited
  per their usage policy
- Airports: [OurAirports](https://ourairports.com/data/) — public domain
- Airspace: FAA open data — US Government work, public domain
