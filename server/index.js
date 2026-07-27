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
  const base = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
  const localPath = path.join(ROOT, 'config.local.json');
  if (fs.existsSync(localPath)) {
    const local = JSON.parse(fs.readFileSync(localPath, 'utf8'));
    return { ...base, ...local, home: { ...base.home, ...(local.home || {}) } };
  }
  return base;
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

function normalize(raw) {
  const out = [];
  for (const ac of raw) {
    if (ac.lat == null || ac.lon == null) continue;
    const onGround = ac.alt_baro === 'ground';
    if (onGround && !config.show_ground_traffic) continue;
    const callsign = (ac.flight || '').trim().toUpperCase() || null;
    const airline = callsign ? airlineFor(callsign) : null;
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
      track: ac.track ?? ac.true_heading ?? null,
      vr: ac.baro_rate ?? ac.geom_rate ?? 0,
      category: ac.category || null,
      heli: ac.category === 'A7',
      // dbFlags bit 1 = military per readsb db; ae-prefix hex = US military ICAO block
      mil: !!(ac.dbFlags & 1) || /^ae/i.test(ac.hex || ''),
      dst: ac.dst ?? null, // nm from home, computed by the API
      seenPos: ac.seen_pos ?? null,
    });
  }
  return out;
}

// ------------------------------------------------------------------- poller

let sourceIdx = 0;
let lastPayload = null;
let lastSuccessAt = 0;
let consecutiveFailures = 0;
let feedBytes = 0; // cumulative internet bytes pulled from the feed
const clients = new Set();

// The display promises coverage up to 50 statute miles around home — clamp the
// feed query to that (in nm) no matter what config says.
const RADIUS_NM = Math.min(config.radius_nm, Math.round(50 * 0.868976));

async function poll() {
  const src = SOURCES[sourceIdx];
  const url = `${src.base}/${config.home.lat}/${config.home.lon}/${RADIUS_NM}`;
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(8000),
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    feedBytes += Buffer.byteLength(text);
    const body = JSON.parse(text);
    const aircraft = normalize(body.ac || []);
    lastSuccessAt = Date.now();
    consecutiveFailures = 0;
    lastPayload = {
      now: lastSuccessAt,
      source: src.name,
      ok: true,
      feedBytes,
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
      aircraft: null, // client keeps coasting on its last targets
    });
  }
}

function broadcast(payload) {
  const frame = `data: ${JSON.stringify(payload)}\n\n`;
  for (const res of clients) res.write(frame);
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

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');

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

server.listen(config.port, () => {
  console.log(`Overhead tracker on http://localhost:${config.port}`);
  console.log(`Home ${config.home.lat}, ${config.home.lon} · radius ${RADIUS_NM} nm · poll ${config.poll_seconds}s`);
  poll();
  setInterval(poll, Math.max(2, config.poll_seconds) * 1000);
});
