// Overhead tracker service: polls community ADS-B feeds (no API keys),
// enriches targets, and pushes them to the display app over SSE.
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const AIRLINES = require('./airlines');

const ROOT = path.join(__dirname, '..');
const WEB = path.join(ROOT, 'web');

function loadConfig() {
  // config.json is committed and should fail loud; config.local.json is
  // machine-written, so a corrupted file (power cut mid-write) must never
  // brick the kiosk at boot — fall back to base config and complain.
  const base = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
  const localPath = path.join(ROOT, 'config.local.json');
  if (fs.existsSync(localPath)) {
    try {
      const local = JSON.parse(fs.readFileSync(localPath, 'utf8'));
      return { ...base, ...local, home: { ...base.home, ...(local.home || {}) } };
    } catch (err) {
      console.error(`[config] config.local.json unreadable (${err.message}) — using defaults`);
    }
  }
  return base;
}

// Atomic JSON write: temp file + rename so a power cut never leaves a
// half-written file behind.
function writeJsonAtomic(p, value, pretty) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, pretty ? JSON.stringify(value, null, 2) + '\n' : JSON.stringify(value));
  fs.renameSync(tmp, p);
}

const config = loadConfig();

// Feed sources, in failover order. Same /v2/point/{lat}/{lon}/{radius} shape.
const SOURCES = [
  { name: 'airplanes.live', base: 'https://api.airplanes.live/v2/point' },
  { name: 'adsb.lol', base: 'https://api.adsb.lol/v2/point' },
];

// ---------------------------------------------------------------- enrichment

const COMPANY_TOKENS = /\b(LLC|INC|CORP|CORPORATION|LTD|CO|COMPANY|AIRLINES?|AIRWAYS|AVIATION|AIR|LEASING|BANK|TRUST|TRUSTEE|UNIVERSITY|COLLEGE|CITY|COUNTY|STATE|DEPT|DEPARTMENT|POLICE|SHERIFF|PATROL|FLIGHT|FLYING|CLUB|SERVICES?|CHARTER|HELICOPTERS?|AERO|GROUP|PARTNERS|HOLDINGS|ENTERPRISES|EXPRESS|CARGO|MEDIA|NEWS|HOSPITAL|MEDICAL|RENTAL|SALES|SCHOOL|ACADEMY|CENTER|CENTRE|FOUNDATION|ASSOCIATION|ASSN|USAF|NAVY|ARMY|COAST GUARD|GOVERNMENT)\b/;
const NAME_SUFFIX = /\s+(INC|LLC|CO|CORP|CORPORATION|LTD)\.?$/;

function titleCase(s) {
  return s.replace(/[A-Z][A-Z0-9'&-]+/g, (w) =>
    /\d/.test(w) || w.length <= 2 ? w : w[0] + w.slice(1).toLowerCase()
  );
}

// Owner display: airline > company name > "Private owner" for individuals.
function ownerFor(ac, airline) {
  if (airline) return airline;
  const raw = (ac.ownOp || '').trim();
  if (!raw) return null;
  if (!COMPANY_TOKENS.test(raw.toUpperCase())) return 'Private owner';
  return titleCase(raw.replace(NAME_SUFFIX, ''));
}

function airlineFor(callsign) {
  if (!/^[A-Z]{3}\d/.test(callsign)) return null;
  return AIRLINES[callsign.slice(0, 3)] || null;
}

function modelFor(ac) {
  if (ac.desc) return titleCase(ac.desc.trim());
  return null;
}

// Common rotorcraft ICAO type designators. The emitter "A7" category is
// unreliable (fixed-wing GA sometimes broadcasts it), so the type code wins
// and category only decides when no type is known.
const HELI_TYPES = new Set([
  'R22', 'R44', 'R66', 'B06', 'B47G', 'B105', 'B212', 'B407', 'B412', 'B429',
  'B430', 'B505', 'S61', 'S64', 'S76', 'S92', 'H46', 'H47', 'H53', 'H60',
  'UH1', 'AH64', 'EC20', 'EC25', 'EC30', 'EC35', 'EC45', 'EC55', 'EC75',
  'H125', 'H130', 'H135', 'H145', 'H155', 'H160', 'H175', 'AS32', 'AS3B',
  'AS50', 'AS55', 'AS65', 'A109', 'A119', 'A139', 'A149', 'A169', 'A189',
  'MD52', 'MD60', 'EXPL', 'MI8', 'MI17', 'KA32', 'LYNX', 'V22',
]);

function isHeli(ac) {
  if (ac.t) return HELI_TYPES.has(ac.t.toUpperCase());
  return ac.category === 'A7';
}

// Law-enforcement operators (US + Canada); "Civil Air Patrol" is excluded
// separately — it matches PATROL but isn't police.
const POLICE_RE = /(POLICE|SHERIFF|PATROL|RCMP|SURETE|SÛRETÉ|GENDARMERIE|CONSTABULARY|PUBLIC SAFETY|LAW ENFORCEMENT)/;

function normalize(raw) {
  const out = [];
  for (const ac of raw) {
    // No hex = no stable identity (some TIS-B targets); skipping avoids
    // merging them all into one ghost track client-side.
    if (ac.lat == null || ac.lon == null || !ac.hex) continue;
    const onGround = ac.alt_baro === 'ground';
    if (onGround && !config.show_ground_traffic) continue;
    const callsign = (ac.flight || '').trim().toUpperCase() || null;
    const airline = callsign ? airlineFor(callsign) : null;
    const opRaw = (ac.ownOp || '').toUpperCase();
    out.push({
      hex: ac.hex,
      callsign,
      reg: ac.r || null,
      type: ac.t || null,
      model: modelFor(ac),
      operator: ownerFor(ac, airline),
      isAirline: !!airline,
      lat: ac.lat,
      lon: ac.lon,
      alt: onGround ? 0 : (typeof ac.alt_baro === 'number' ? ac.alt_baro : null),
      onGround,
      gs: ac.gs ?? null,
      // track only — heading points the nose, not the motion (crab angle);
      // extrapolating along heading drifts targets downwind
      track: ac.track ?? null,
      vr: ac.baro_rate ?? ac.geom_rate ?? 0,
      category: ac.category || null,
      heli: isHeli(ac),
      // dbFlags bit 1 = military per readsb db; ae-prefix hex = US military
      // ICAO block; Coast Guard is treated as military per display policy
      mil: !!(ac.dbFlags & 1) || /^ae/i.test(ac.hex || '') || opRaw.includes('COAST GUARD'),
      police: POLICE_RE.test(opRaw) && !opRaw.includes('CIVIL AIR PATROL'),
      dst: ac.dst ?? null, // nm from home, computed by the API
      seenPos: ac.seen_pos ?? null,
    });
  }
  return out;
}

// ------------------------------------------------------------------- poller

// ------------------------------------------------- persistent usage counters
// Survives restarts. Written at most once a minute (plus on shutdown) to be
// gentle on the Pi's SD card.
const USAGE_PATH = path.join(ROOT, 'data', 'usage.json');
let usage = { totalBytes: 0, days: {}, minutes: [] };
let usageDirty = false;
try { usage = { ...usage, ...JSON.parse(fs.readFileSync(USAGE_PATH, 'utf8')) }; } catch {}

function dayKey(ts) {
  // Local calendar day — "TODAY" on a wall display must not roll over at UTC
  // midnight (4-5 PM on the US west coast).
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function addUsage(bytes) {
  const now = Date.now();
  usage.totalBytes += bytes;
  const day = dayKey(now);
  usage.days[day] = (usage.days[day] || 0) + bytes;
  const dayKeys = Object.keys(usage.days).sort();
  while (dayKeys.length > 35) delete usage.days[dayKeys.shift()];
  const mn = Math.floor(now / 60000);
  const last = usage.minutes[usage.minutes.length - 1];
  if (last && last.min === mn) last.bytes += bytes;
  else usage.minutes.push({ min: mn, bytes });
  while (usage.minutes.length > 61) usage.minutes.shift();
  usageDirty = true;
}
function saveUsage() {
  if (!usageDirty) return;
  try {
    writeJsonAtomic(USAGE_PATH, usage, false);
    usageDirty = false;
  } catch (err) {
    console.error(`[usage] save failed: ${err.message}`);
  }
}
setInterval(saveUsage, 60000);
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { saveUsage(); process.exit(0); });
}

let sourceIdx = 0;
let lastPayload = null;
let lastSuccessAt = 0;
let consecutiveFailures = 0;
let feedBytes = 0; // cumulative internet bytes pulled from the feed
let viewArea = null; // {lat, lon, radius_nm} — extra region when the map pans away from home
let viewAreaAt = 0; // last time a client asserted it (TTL'd in scheduledPoll)
let pollInFlight = false;
const BW_MODES = new Set(['high', 'medium', 'low']);
let bwMode = BW_MODES.has(config.bandwidth_mode)
  ? config.bandwidth_mode
  : (config.low_bandwidth ? 'medium' : 'high'); // back-compat with the old flag
let lastOuter = []; // aircraft beyond the inner ring, cached between full sweeps in low-bw mode
let lastOuterAt = 0; // when that cache was fetched — rebroadcasts age seen_pos from this
let tick = 0;
let lastTickAt = Date.now();
const pollBaseMs = Math.max(2, config.poll_seconds) * 1000;
const STARTED_AT = Date.now();
const INNER_NM = config.low_bw_inner_nm || 10;
const clients = new Set();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The display promises coverage up to 50 statute miles around home — clamp the
// feed query to that (in nm) no matter what config says.
const RADIUS_NM = Math.min(config.radius_nm, Math.round(50 * 0.868976));

async function fetchRegion(src, lat, lon, radiusNm) {
  const res = await fetch(`${src.base}/${lat}/${lon}/${radiusNm}`, {
    signal: AbortSignal.timeout(8000),
    headers: { Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const text = await res.text();
  // Prefer Content-Length: that's compressed wire bytes (the feed gzips);
  // fall back to decompressed size when the header is absent.
  const clen = Number(res.headers.get('content-length'));
  const wireBytes = Number.isFinite(clen) && clen > 0 ? clen : Buffer.byteLength(text);
  feedBytes += wireBytes;
  addUsage(wireBytes);
  return JSON.parse(text).ac || [];
}

async function poll(kind = 'full') {
  if (pollInFlight) return;
  pollInFlight = true;
  try {
    await pollOnce(kind);
  } finally {
    pollInFlight = false;
  }
}

// Bandwidth modes (3 s tick base):
//   high   — full radius every tick
//   medium — inner ring ~6 s, full sweep every 15 s
//   low    — inner ring ~12 s, full sweep every 45 s
// Outer aircraft are carried over from the last full sweep between sweeps.
// When the next scheduled scan will fire, given the mode's tick pattern.
function nextScanAt() {
  let k = 1;
  if (bwMode !== 'high') {
    for (k = 1; k <= 15; k++) {
      const t = tick + k;
      const fires = bwMode === 'medium'
        ? (t % 5 === 0 || t % 2 === 1)
        : (t % 15 === 0 || t % 4 === 2);
      if (fires) break;
    }
  }
  return lastTickAt + k * pollBaseMs;
}

function scheduledPoll() {
  tick++;
  lastTickAt = Date.now();
  // A view region left behind by a vanished browser must not double our
  // bandwidth forever — clients re-assert theirs every 2 minutes.
  if (viewArea && Date.now() - viewAreaAt > 300000) {
    viewArea = null;
    console.log('[feed] view region expired');
  }
  if (bwMode === 'high') return poll('full');
  if (bwMode === 'medium') {
    if (tick % 5 === 0) return poll('full');
    if (tick % 2 === 1) return poll('inner');
    return;
  }
  // low
  if (tick % 15 === 0) return poll('full');
  if (tick % 4 === 2) return poll('inner');
}

async function pollOnce(kind) {
  const src = SOURCES[sourceIdx];
  try {
    let ac;
    if (kind === 'inner') {
      const inner = await fetchRegion(src, config.home.lat, config.home.lon, INNER_NM);
      const seen = new Set(inner.map((a) => a.hex));
      // Rebroadcast cached outer aircraft with seen_pos aged by cache time, so
      // clients know the fix is old instead of re-extrapolating it as fresh.
      const cacheAgeS = lastOuterAt ? (Date.now() - lastOuterAt) / 1000 : 0;
      ac = inner.concat(
        lastOuter
          .filter((a) => !seen.has(a.hex))
          .map((a) => ({ ...a, seen_pos: (a.seen_pos || 0) + cacheAgeS }))
      );
    } else {
      ac = await fetchRegion(src, config.home.lat, config.home.lon, RADIUS_NM);
      if (viewArea) {
        await sleep(1100); // stay under the API's 1 req/s limit
        try {
          const extra = await fetchRegion(src, viewArea.lat, viewArea.lon, viewArea.radius_nm);
          const seen = new Set(ac.map((a) => a.hex));
          for (const a of extra) if (!seen.has(a.hex)) ac.push(a);
        } catch (err) {
          // view region is best-effort; home data still goes out
          console.error(`[feed] view region failed (${err.message})`);
        }
      }
      lastOuter = ac.filter((a) => (a.dst ?? 999) > INNER_NM * 0.9);
      lastOuterAt = Date.now();
    }
    const aircraft = normalize(ac);
    lastSuccessAt = Date.now();
    consecutiveFailures = 0;
    lastPayload = {
      now: lastSuccessAt,
      source: src.name,
      ok: true,
      feedBytes,
      totalBytes: usage.totalBytes,
      todayBytes: usage.days[dayKey(Date.now())] || 0,
      startedAt: STARTED_AT,
      bandwidthMode: bwMode,
      nextScanAt: nextScanAt(),
      aircraft,
    };
    broadcast(lastPayload);
  } catch (err) {
    consecutiveFailures++;
    console.error(`[feed] ${src.name} failed (${err.message}), failures=${consecutiveFailures}`);
    if (consecutiveFailures >= 2) {
      sourceIdx = (sourceIdx + 1) % SOURCES.length;
      console.error(`[feed] switching to ${SOURCES[sourceIdx].name}`);
      consecutiveFailures = 0;
    }
    broadcast({
      now: Date.now(),
      source: src.name,
      ok: false,
      staleSeconds: lastSuccessAt ? Math.round((Date.now() - lastSuccessAt) / 1000) : null,
      nextScanAt: nextScanAt(),
      aircraft: null, // client keeps coasting on its last targets
    });
  }
}

function broadcast(payload) {
  const frame = `data: ${JSON.stringify(payload)}\n\n`;
  for (const res of clients) {
    // A socket that died without a clean close must never crash the kiosk.
    try { res.write(frame); } catch { clients.delete(res); }
  }
}

// ------------------------------------------------------------------- server

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

// Persist settings to config.local.json (gitignored) — the user's real
// coordinates and preferences never land in the committed config.
function updateLocalConfig(patch) {
  const p = path.join(ROOT, 'config.local.json');
  let local = {};
  try { local = JSON.parse(fs.readFileSync(p, 'utf8')); } catch {}
  Object.assign(local, patch);
  try {
    writeJsonAtomic(p, local, true);
  } catch (err) {
    console.error(`[config] save failed: ${err.message}`);
  }
}

function persistHome() {
  updateLocalConfig({ home: { lat: config.home.lat, lon: config.home.lon } });
}

let lastGeocodeAt = 0;

// ----------------------------------------------------------------- airports
// OurAirports public-domain database — downloaded once (~9 MB), cached in
// data/, parsed lazily on first request.
let airportsData = null;
let airportsLoading = null;

function parseCsvLine(line) {
  const out = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQ) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; } else inQ = false;
      } else cur += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ',') { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

async function ensureAirports() {
  if (airportsData) return airportsData;
  if (!airportsLoading) {
    airportsLoading = (async () => {
      const p = path.join(ROOT, 'data', 'airports.csv');
      let text;
      if (fs.existsSync(p)) {
        text = fs.readFileSync(p, 'utf8');
      } else {
        const res = await fetch('https://davidmegginson.github.io/ourairports-data/airports.csv', {
          signal: AbortSignal.timeout(60000),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        text = await res.text();
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, text);
        console.log('[airports] downloaded OurAirports database');
      }
      const lines = text.split('\n');
      const header = parseCsvLine(lines[0]);
      const ci = {
        ident: header.indexOf('ident'),
        type: header.indexOf('type'),
        name: header.indexOf('name'),
        lat: header.indexOf('latitude_deg'),
        lon: header.indexOf('longitude_deg'),
        iata: header.indexOf('iata_code'),
      };
      const keep = new Set(['large_airport', 'medium_airport', 'small_airport']);
      const out = [];
      for (let i = 1; i < lines.length; i++) {
        if (!lines[i]) continue;
        const r = parseCsvLine(lines[i]);
        if (!keep.has(r[ci.type])) continue;
        const lat = Number(r[ci.lat]);
        const lon = Number(r[ci.lon]);
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
        out.push({ ident: r[ci.ident], type: r[ci.type], name: r[ci.name], lat, lon, iata: r[ci.iata] || null });
      }
      airportsData = out;
      console.log(`[airports] ${out.length} airports indexed`);
      return out;
    })().catch((err) => {
      airportsLoading = null; // allow retry
      throw err;
    });
  }
  return airportsLoading;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (url.pathname === '/geocode') {
    const q = (url.searchParams.get('q') || '').trim();
    if (!q) { res.writeHead(400).end(); return; }
    // Respect Nominatim's 1 req/s policy even if the key is being mashed
    if (Date.now() - lastGeocodeAt < 1100) {
      res.writeHead(429, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'one lookup per second — try again' }));
      return;
    }
    lastGeocodeAt = Date.now();
    try {
      const r = await fetch(
        'https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q=' + encodeURIComponent(q),
        {
          headers: { 'User-Agent': 'overhead-wall-tracker/0.1 (personal hobby display)' },
          signal: AbortSignal.timeout(8000),
        }
      );
      const results = await r.json();
      if (!Array.isArray(results) || results.length === 0) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'address not found' }));
        return;
      }
      const { lat, lon, display_name } = results[0];
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ lat: Number(lat), lon: Number(lon), label: display_name }));
    } catch (err) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'geocoder unreachable' }));
    }
    return;
  }

  if (url.pathname === '/bwmode' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      try {
        const { mode } = JSON.parse(body);
        if (!BW_MODES.has(mode)) throw new Error('bad mode');
        bwMode = mode;
        updateLocalConfig({ bandwidth_mode: mode });
        console.log(`[feed] bandwidth mode: ${mode}`);
        if (mode === 'high') poll('full');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, bandwidthMode: bwMode }));
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'expected JSON {mode: "high"|"medium"|"low"}' }));
      }
    });
    return;
  }

  if (url.pathname === '/view' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      try {
        const v = JSON.parse(body || 'null');
        viewAreaAt = Date.now();
        if (v === null) {
          viewArea = null;
        } else {
          const { lat, lon, radius_nm } = v;
          if (typeof lat !== 'number' || typeof lon !== 'number' ||
              typeof radius_nm !== 'number' || radius_nm <= 0 ||
              Math.abs(lat) > 90 || Math.abs(lon) > 180) throw new Error('bad view');
          viewArea = { lat, lon, radius_nm: Math.min(radius_nm, RADIUS_NM) };
        }
        poll(); // pick up the new region right away
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'expected JSON {lat, lon, radius_nm} or null' }));
      }
    });
    return;
  }

  if (url.pathname === '/home' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      try {
        const { lat, lon } = JSON.parse(body);
        if (typeof lat !== 'number' || typeof lon !== 'number' ||
            Math.abs(lat) > 90 || Math.abs(lon) > 180) throw new Error('bad coords');
        config.home.lat = lat;
        config.home.lon = lon;
        persistHome();
        console.log(`[home] moved to ${lat}, ${lon}`);
        poll(); // refresh the sky around the new home right away
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'expected JSON {lat, lon}' }));
      }
    });
    return;
  }

  if (url.pathname === '/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write('retry: 3000\n\n');
    if (lastPayload) res.write(`data: ${JSON.stringify(lastPayload)}\n\n`);
    clients.add(res);
    req.on('close', () => clients.delete(res));
    res.on('error', () => clients.delete(res));
    return;
  }

  if (url.pathname === '/airports') {
    const lat = Number(url.searchParams.get('lat'));
    const lon = Number(url.searchParams.get('lon'));
    const radius = Math.min(Number(url.searchParams.get('radius_nm')) || RADIUS_NM, 250);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) { res.writeHead(400).end(); return; }
    try {
      const all = await ensureAirports();
      const nearby = [];
      for (const a of all) {
        const dLat = (a.lat - lat) * 60;
        const dLon = (a.lon - lon) * 60 * Math.cos((lat * Math.PI) / 180);
        if (Math.hypot(dLat, dLon) <= radius) nearby.push(a);
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ airports: nearby.slice(0, 400) }));
    } catch (err) {
      console.error(`[airports] ${err.message}`);
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'airport database unavailable' }));
    }
    return;
  }

  if (url.pathname === '/usage') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ...usage, sessionBytes: feedBytes, startedAt: STARTED_AT }));
    return;
  }

  if (url.pathname === '/config') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(config));
    return;
  }

  // static files from web/
  let file = url.pathname === '/' ? '/index.html' : url.pathname;
  file = path.normalize(file).replace(/^(\.\.[/\\])+/, '');
  const full = path.join(WEB, file);
  if (!full.startsWith(WEB)) {
    res.writeHead(403).end();
    return;
  }
  fs.readFile(full, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream' });
    res.end(data);
  });
});

// lan: true (default) serves other devices on your network — they can also
// change home/bandwidth settings. Set "lan": false in config to bind
// localhost only (kiosk-private).
const host = config.lan === false ? '127.0.0.1' : undefined;
server.listen(config.port, host, () => {
  console.log(`Overhead tracker on http://localhost:${config.port}${host ? ' (localhost only)' : ''}`);
  console.log(`Home ${config.home.lat}, ${config.home.lon} · radius ${RADIUS_NM} nm · poll ${config.poll_seconds}s`);
  poll('full');
  setInterval(scheduledPoll, pollBaseMs);
});
