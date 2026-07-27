# Overhead — wall-mounted flight tracker

Live aircraft over your house on a dark map, ATC-style: every target carries its
data block (callsign · registration / model / owner or airline / altitude · speed)
on a leader line as it moves. No API keys, no accounts.

Data: [airplanes.live](https://airplanes.live/api-guide/) community ADS-B feed
(keyless, polled every 3 s), with adsb.lol as automatic failover.

## Run (laptop or Pi)

Requires Node 18+. No `npm install` needed — there are zero dependencies.

```sh
npm start
# open http://localhost:8080
```

## Configure

Edit `config.json`:

| Key | Meaning |
| --- | --- |
| `home.lat` / `home.lon` | Center of the display — set to your house (placeholder ships with downtown Seattle) |
| `radius_nm` | How far out to track aircraft (nautical miles) |
| `rings_nm` | Range rings drawn around home |
| `overhead_nm` | Aircraft closer than this get the amber OVERHEAD treatment |
| `poll_seconds` | Feed poll interval (keep ≥ 2; the API allows 1 req/s) |
| `show_ground_traffic` | Show aircraft on the ground at nearby airports (dimmed) |

To keep your real coordinates out of git, copy `config.json` to
`config.local.json` (gitignored) and edit that — it overrides `config.json`.

## Layout

- `server/` — Node service: static file server, `/events` SSE stream, feed poller
- `web/` — the display app (Leaflet map + canvas ATC overlay)
- `web/vendor/` — vendored Leaflet (no CDN dependency at runtime)

## Pi kiosk deploy

Phase 3 — systemd units and Chromium kiosk setup will land in `deploy/`.
