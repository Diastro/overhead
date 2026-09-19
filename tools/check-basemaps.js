#!/usr/bin/env node
// Smoke test for the basemap providers in web/basemaps.js:
//
//   npm run check:basemaps
//
// Fetches one real tile per provider, per theme, per layer, at a low, a middle
// and a high zoom, and fails if any of them is not an image. That catches the
// ordinary ways a tile service goes away — a renamed path, a revoked service,
// a 403, a zoom level the provider does not actually cover.
//
// It also catches one flavour of the 200-that-is-not-a-map: a provider that
// answers levels beyond its real data with a placeholder. Those placeholders
// are the same picture every time, so a tile whose bytes are identical to a
// tile at a different zoom — or to the same zoom in the other theme — is not
// map data. Esri's Canvas does exactly this above z16, and an earlier version
// of this script reported it as "ok, jpeg 2521B".
//
// What it still cannot catch: a provider that paints something over otherwise
// real tiles. That is how CARTO withdrew its keyless basemaps in Aug 2026 —
// the tiles kept arriving, with "API KEY REQUIRED" across them, every one
// different. No status code betrays that; only a person looking at the screen
// does. It is why the display can switch providers from the LAYERS panel
// instead of needing a code change.
'use strict';

const crypto = require('crypto');
const BASEMAPS = require('../web/basemaps.js');

// Somewhere with coastline, freeways and labels at every zoom, so a provider
// that has quietly lost a layer shows up as a tiny or missing tile.
// Two adjacent high zooms on purpose: a provider that has run out of data
// serves the SAME placeholder at every level above its limit, so the pair is
// what exposes it. A single high probe would just look like a small tile.
const PROBE = { lat: 47.6062, lon: -122.3321, zooms: [4, 11, 16, 18, 19] };

function tileXY(lat, lon, z) {
  const n = 2 ** z;
  const rad = (lat * Math.PI) / 180;
  return {
    x: Math.floor(((lon + 180) / 360) * n),
    y: Math.floor(((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n),
  };
}

function expand(tmpl, z, x, y) {
  return tmpl.replace('{z}', z).replace('{x}', x).replace('{y}', y).replace('{s}', 'a').replace('{r}', '');
}

async function probe(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      // Same identifying shape the feed and Nominatim calls use — the OSM tile
      // policy requires a UA that names the application, and a handful of
      // requests from a named checker is easier for an operator to read than
      // an anonymous one.
      headers: { 'User-Agent': 'overhead-basemap-check (github.com/Diastro/overhead)' },
    });
    const buf = Buffer.from(await res.arrayBuffer());
    const type = res.headers.get('content-type') || '';
    if (!res.ok) return { ok: false, why: `HTTP ${res.status}`, bytes: buf.length };
    if (!type.startsWith('image/')) return { ok: false, why: `content-type ${type}`, bytes: buf.length };
    if (buf.length < 100) return { ok: false, why: `${buf.length} bytes — not a tile`, bytes: buf.length };
    return {
      ok: true,
      why: `${type.replace('image/', '')} ${buf.length}B`,
      bytes: buf.length,
      hash: crypto.createHash('sha1').update(buf).digest('hex').slice(0, 10),
    };
  } catch (err) {
    return { ok: false, why: err.name === 'AbortError' ? 'timed out' : err.message, bytes: 0 };
  } finally {
    clearTimeout(timer);
  }
}

(async () => {
  // A key would only add the optional CARTO entry; the point of this check is
  // that the keyless set works on its own.
  const providers = BASEMAPS.providers(null);
  let failed = 0;
  for (const p of providers) {
    console.log(`\n${p.label}  (${p.id})`);
    const native = p.maxNativeZoom ?? p.maxZoom;
    for (const theme of BASEMAPS.THEMES) {
      const spec = p[theme];
      if (!spec) continue;
      // A composite theme carries `layers` instead of a single url, and the
      // first version of this loop read only `spec.url` — so a provider built
      // that way would have been skipped in silence, which is the same way the
      // placeholder tiles got through the first time.
      const parts = (spec.layers || [{ url: spec.url }])
        .map((l, i) => [spec.layers ? `layer${i}` : 'base', l.url]);
      parts.push(['labels', spec.labels]);
      for (const [layer, tmpl] of parts) {
        if (!tmpl) continue;
        // Scoped to this one URL template: the comparison is "does this
        // service draw something different at a different scale". Comparing
        // across templates gives false alarms — OSM serves one URL for both
        // themes by design, and a label tile over open water is blank in
        // every theme at once.
        const seen = new Map(); // hash -> the zoom we first saw it at
        for (const z of PROBE.zooms) {
          const { x, y } = tileXY(PROBE.lat, PROBE.lon, z);
          const r = await probe(expand(tmpl, z, x, y));
          const where = `${theme}/${layer} z${z}`;
          let note = r.why;
          let bad = !r.ok;
          if (r.ok && z > native) {
            note += ' — beyond maxNativeZoom, the app never requests this';
          } else if (r.ok) {
            const first = seen.get(r.hash);
            if (first !== undefined) {
              bad = true;
              note = `${r.why} — byte-identical to z${first}: a placeholder, not map data. ` +
                     `Lower this provider's maxNativeZoom.`;
            } else {
              seen.set(r.hash, z);
            }
          }
          if (bad) failed++;
          console.log(`  ${bad ? 'FAIL' : 'ok  '} ${where.padEnd(18)} ${note}`);
        }
      }
    }
  }
  console.log(failed ? `\n${failed} tile request(s) failed.` : '\nAll basemap tiles reachable.');
  process.exit(failed ? 1 : 0);
})();
