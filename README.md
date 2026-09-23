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

## Stop / restart

Overhead, watchlist and edge-loader all run the same `node server/index.js`,
so `pkill -f "node server/index.js"` takes **all three** down. Always target
one app at a time, using its supervisor.

**On the Mac** (launchd job `local.overhead`, defined in
`~/Library/LaunchAgents/local.overhead.plist`). The job sets `KeepAlive`, so
`kill` is *not* a shutdown — launchd respawns it within `ThrottleInterval`
(5s). Use `bootout` when you actually want it to stay down:

```sh
# restart only overhead
launchctl kickstart -k gui/$(id -u)/local.overhead

# shut down only overhead, and keep it down
launchctl bootout gui/$(id -u)/local.overhead

# start it again afterwards (bootstrap only loads the job — kickstart runs it)
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/local.overhead.plist
launchctl kickstart gui/$(id -u)/local.overhead

# confirm (PID in col 1, or '-' when stopped)
launchctl list | grep local.overhead
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:8080/config   # 200
```

**On the Pi** it's a systemd unit, already scoped to this app alone:

```sh
sudo systemctl restart overhead
sudo systemctl stop overhead          # stays down; `disable` to survive reboot
systemctl status overhead --no-pager
```

**Running it by hand** (no supervisor — bootout the launchd job first, or the
two fight over port 8080):

```sh
nohup node server/index.js >> data/server.log 2>&1 &
kill $(lsof -ti tcp:8080 -sTCP:LISTEN)     # targets only what holds 8080
```

Open the app and set your location with the **HOME** button. To follow a
specific flight, use **⌖ FIND** (top left) to search by callsign, tail
number, or hex — or long-press any aircraft on the map. The camera tracks
the flight until you press STOP in the ⌖ panel (dragging the map pauses the
follow for a few seconds so you can look around). All personal
settings (home, theme, bandwidth mode, layers, density) live in your
browser's localStorage — nothing personal is written to disk or committed.
Physical-install settings (coverage radius, rings, poll cadence, port) live
in `config.json`; edit + restart for those.

Deploying on a Raspberry Pi wall display: see [docs/pi.md](docs/pi.md).

## Basemaps

The map tiles come from a list of **keyless** providers in `web/basemaps.js`,
switchable from the **◧ LAYERS** panel:

| Provider | Style | Notes |
|---|---|---|
| **Esri Canvas** (default) | Dark Gray / Light Gray + place names | Closest to the basemap Overhead used to ship. ~8 KB a tile. Its data stops at zoom 16 — past that the last real tile is upscaled, so very close zooms go soft rather than blank. |
| **OpenStreetMap** | Standard; the dark theme is derived in CSS | ~30 KB a tile and busier, but it is the one provider with a published policy that permits this use. |
| **Terrain** | Esri hillshade under the canvas | Landform relief; roughly double the tiles. |
| **Esri Imagery** | Satellite photography | The heaviest tiles here (10-40 KB each). Built for the ORBITAL style. |

Repeated tile errors switch providers on their own and say so on the glass.
That switch is not persisted — an outage should not overwrite a choice you
made — so a reload goes back to your pick and re-tests it.

`npm run check:basemaps` fetches real tiles from every provider across five
zoom levels and fails if two of them come back byte-identical — which is what
a provider serves when it has run out of map data and is answering with a
placeholder. Run it if the map looks wrong.

**Why this is a list.** Overhead used CARTO's basemaps, which were keyless for
years. On 28 Aug 2026 CARTO began stamping anonymous requests with an "API KEY
REQUIRED" watermark — served with **HTTP 200**, so nothing errored and the
display quietly turned to garbage until somebody looked at it. Nothing catches
that automatically; what a list buys you is that fixing it costs one click.

If you want CARTO's Dark Matter / Voyager pair back, their key is free. Put it
in `config.local.json` — which is gitignored — and a third option appears:

```json
{ "carto_key": "your-key-here" }
```

Never put it in `config.json`: that file is committed.

## Map styles

**◧ LAYERS → STYLE** picks the whole look — basemap colours, aircraft inks,
chrome — and the ☾/☀ button picks its dark or light half. Styles live in
`web/styles.js`.

| Style | Dark | Light |
|---|---|---|
| **Classic** (default) | Slate navy | Warm ivory |
| **Radar Phosphor** | Green radar glass, scanlines, a slow sweep | Sage "daylight scope" |
| **VFR Sectional** | Cockpit red — military turns white to stay distinct | Tan land, yellow towns, magenta rings |
| **Cyanotype** | Chalk coastlines on Prussian blue, drafting grid | Whiteprint; traffic goes coral |
| **ECDIS Nautical** | IHO S-52 Night, shoal bands along the coast | S-52 Day: buff land, white deep water |
| **Swiss Relief** | Moonlit ridges | Parchment with violet shadows |
| **Golden / Blue Hour** | Indigo dusk | Honey land, teal water |
| **Jet-Age Route Map** | Gold coastlines on midnight navy | Cream paper, teal sea, poster-red routes |
| **Risograph** | Fluoro pink and blue on black, halftone | Pink and blue on newsprint |
| **Orbital** | Satellite imagery, night side with city lights | Bleached daylight imagery |
| **E-ink** | Grey map, colour only on data | Greyscale newsprint |

A browser that has never picked a style uses `"style"` from the config — set
it in `config.local.json` (e.g. `{ "style": "relief" }`) to change a wall
panel's look remotely; the ids are in `web/styles.js`.

Swiss Relief switches the basemap to Terrain when you pick it, and Orbital
switches to Esri Imagery. You can change the basemap afterwards. Every
style except Classic recolours the tiles through SVG gradient-map filters
calibrated per provider (the keyed CARTO entry keeps its classic look).

`npm run check:styles` measures every style's inks against the map colours
that style paints: 4.5:1 for aircraft, overhead, trails and text, 3:1 for
rings and leader lines. Run it after changing a palette.

## Why not FlightRadar24 on a tablet?

- No account, no subscription, no ads, no nag screens — ever
- Community feeds are unfiltered: military and blocked aircraft that the
  commercial trackers hide are on your scope (and trigger an auto-zoom
  fly-by — toggle it in LAYERS)
- Emergency squawks (7500/7600/7700) get the loudest treatment on screen
- Bandwidth is metered and tunable (HIGH/MED/LOW) for LTE or rural links
- It runs on your LAN and keeps working when the internet products change
  their minds

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
                basemaps.js holds the keyless tile providers; styles.js
                the map styles and the scope's base palettes.
tools/          check-basemaps.js — fetches a real tile from every provider
                so a withdrawn service is caught by `npm run check:basemaps`
                rather than by looking at the wall. check-styles.js —
                contrast of every style's inks on its own map.
data/           Machine-written caches and counters (gitignored).
```

## Contributing

Small project, deliberate constraints: zero npm dependencies, no build step,
no API keys, wall-display-first. PRs that respect those are welcome (bug
fixes, aircraft/operator classification, rendering performance). Things that
won't be merged: frameworks/bundlers, accounts or cloud services, features
that need paid APIs.

## License & data credits

Code is MIT licensed (see `LICENSE`). Bundled/consumed third parties:

- [Leaflet](https://leafletjs.com) — BSD-2-Clause (vendored; see
  `web/vendor/LEAFLET-LICENSE.txt`)
- Basemaps: [Esri](https://www.esri.com) Dark/Light Gray Canvas (Esri, HERE,
  Garmin, © OpenStreetMap contributors), World Hillshade, World Imagery
  (Esri, Maxar, Earthstar Geographics, and the GIS User Community) and the
  [OpenStreetMap](https://www.openstreetmap.org/copyright) standard layer —
  attribution must stay visible in the app
- Live aircraft data: [airplanes.live](https://airplanes.live) /
  [adsb.lol](https://adsb.lol) community feeds — non-commercial use
- Geocoding: [Nominatim](https://nominatim.org) (OpenStreetMap) — rate-limited
  per their usage policy
- Airports: [OurAirports](https://ourairports.com/data/) — public domain
- Airspace: FAA open data — US Government work, public domain
