# Overhead

A wall-mounted flight tracker: live aircraft over your area on a dark
ATC-style map, with data blocks (callsign, model, operator, altitude, speed)
attached to each target. Built for a Raspberry Pi driving an always-on
display; runs anywhere with Node 18+. No npm dependencies, no API keys, no
accounts.

<img width="2067" height="1300" alt="Screenshot 2026-07-29 at 4 21 29 PM" src="https://github.com/user-attachments/assets/f552fdea-b98b-4509-94b8-166e1360e7a7" />

## Run

```sh
npm start
# open http://localhost:8080
```

To keep it running after the terminal closes:

```sh
nohup node server/index.js >> data/server.log 2>&1 &
```

Open the app and set your location with the **HOME** button. All personal
settings (home, theme, bandwidth mode, layers, density) live in your
browser's localStorage — nothing personal is written to disk or committed.

## Layout

```
config.json     Generic defaults (radius, rings, cadence, ports).
server/         Single-file service: polls community ADS-B feeds with
                failover, enriches targets (airline / heli / military /
                police / coast guard), streams snapshots over SSE, serves
                the web app and small JSON endpoints.
web/            The display: Leaflet basemap + one canvas overlay drawing
                everything (icons, trails, data blocks, rings, airports,
                airspace). Dead-reckons aircraft between feed snapshots for
                smooth motion. Vendored Leaflet — no CDN at runtime.
data/           Machine-written caches and counters (gitignored).
```

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
