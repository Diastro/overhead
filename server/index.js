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
  // config.json is committed and should fail loud. config.local.json is a
  // legacy/manual override (no longer written by the app — settings live in
  // the browser); a corrupted one must never brick boot.
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
let homeExplicitAt = 0; // wall-clock of the last explicit SET this lifetime

// ------------------------------------------------------------------ sources
// Feed sources, in failover order. All three answer with the same readsb-style
// aircraft records (hex, lat, lon, alt_baro, dst, …); they differ only in the
// URL shape and the name of the list.
//
// airplanes.live now refuses unregistered projects outright — a 403 asking the
// operator to get in touch — so it is last, and a 403 parks a source for
// PARK_MS instead of the failover walking back into it every minute. If the
// project is ever registered, it rejoins on its own when the park lapses.
const SOURCES = [
  { name: 'adsb.lol', list: 'ac', url: (lat, lon, nm) => `https://api.adsb.lol/v2/point/${lat}/${lon}/${nm}` },
  { name: 'adsb.fi', list: 'aircraft', url: (lat, lon, nm) => `https://opendata.adsb.fi/api/v2/lat/${lat}/lon/${lon}/dist/${nm}` },
  { name: 'airplanes.live', list: 'ac', url: (lat, lon, nm) => `https://api.airplanes.live/v2/point/${lat}/${lon}/${nm}` },
];
const PARK_MS = 6 * 60 * 60 * 1000;

// The source after `from`: the next one not parked, or — when every one is —
// whichever comes back soonest.
function nextSource(from, now = Date.now()) {
  for (let k = 1; k <= SOURCES.length; k++) {
    const i = (from + k) % SOURCES.length;
    if (!(SOURCES[i].parkedUntil > now)) return i;
  }
  let best = from;
  for (let i = 0; i < SOURCES.length; i++) {
    if ((SOURCES[i].parkedUntil || 0) < (SOURCES[best].parkedUntil || 0)) best = i;
  }
  return best;
}

// Whether an empty answer should get a second opinion before the display
// draws an empty sky. A feed having a bad moment answers 200 with no aircraft
// — adsb.lol spent an afternoon doing exactly that for every point on Earth —
// and that is indistinguishable, from one answer, from a quiet night. So: if
// the last sky had SUSPECT_MIN or more aircraft, ask the next source; once
// every usable source has said "empty" (strikes), believe it.
const SUSPECT_MIN = 10;
function suspectEmpty(count, lastCount, strikes, now = Date.now()) {
  const usable = SOURCES.filter((s) => !(s.parkedUntil > now)).length;
  return count === 0 && lastCount >= SUSPECT_MIN && strikes < usable - 1;
}

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
  'H64', 'AH1', 'H500', // ICAO designators: Apache, Cobra, MD 500
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
    const heli = isHeli(ac);
    // Coast Guard: named owner, or a USCG callsign (their ownOp is often
    // blank in the community db). Conventions seen live: CGNR####, CG####,
    // and C#### — the last only counts on an already-military airframe so a
    // civilian callsign can't trip it (e.g. C6065 = MH-60 Jayhawk 6065).
    const milBase = !!(ac.dbFlags & 1) || /^ae/i.test(ac.hex || '');
    const cg = opRaw.includes('COAST GUARD') || opRaw.includes('USCG') ||
      // CGNR needs trailing digits: Canadian regs broadcast as callsigns
      // (C-GNRA -> "CGNRA") and must not match
      /^CGNR ?\d{1,4}$/.test(callsign || '') ||
      /^CG ?\d{3,4}$/.test(callsign || '') ||
      (milBase && /^C\d{4}$/.test(callsign || ''));
    // Police: named law-enforcement operator, or a civic-owned helicopter —
    // a city/county that owns a helicopter is running an air-support unit
    // (e.g. "CITY OF OAKLAND" = Oakland PD) unless the name says otherwise
    const civicOwner = /\b(CITY|COUNTY|BOROUGH|PARISH) OF\b/.test(opRaw) ||
      /,\s*(CITY|COUNTY|BOROUGH|PARISH)\b/.test(opRaw);
    const civicNonLE = /(FIRE|MEDIC|EMS|AMBULANCE|HEALTH|HOSPITAL|WATER|POWER|UTILIT|TRANSIT|AIRPORT|PORT OF|PUBLIC WORKS|PARKS|SCHOOL|UNIVERSITY)/.test(opRaw);
    const police = !opRaw.includes('CIVIL AIR PATROL') &&
      (POLICE_RE.test(opRaw) || (heli && civicOwner && !civicNonLE));
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
      // track only for motion — heading points the nose, not the motion
      // (crab angle); extrapolating along heading drifts targets downwind
      track: ac.track ?? null,
      // nose heading: surface targets usually stop broadcasting track below
      // taxi speed but keep sending true_heading — used for icon orientation
      hdg: ac.true_heading ?? null,
      // null, not 0. A missing vertical rate is not level flight, and the
      // display draws a "→" for zero — see the groundspeed note below, which
      // is the same mistake this used to make.
      vr: ac.baro_rate ?? ac.geom_rate ?? null,
      category: ac.category || null,
      heli,
      // dbFlags bit 1 = military per readsb db; ae-prefix hex = US military
      // ICAO block; Coast Guard is treated as military per display policy
      mil: milBase || cg,
      cg, // striped icon; otherwise military treatment
      police,
      squawk: ac.squawk ?? null,
      // 7500 hijack / 7600 radio failure / 7700 emergency — the most
      // important traffic on the scope
      emerg: ac.squawk === '7500' || ac.squawk === '7600' || ac.squawk === '7700',
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
// ------------------------------------------------------------------ routes
// Where a flight is going, from the Virtual Radar Server standing data: one
// public CSV per airline (Callsign,Code,Number,AirlineCode,AirportCodes),
// keyless and plain files on GitHub. Scheduled airline callsigns only
// (ASA312, SKW3281) — a tail number has no published route. Each airline's
// file is fetched the first time one of its flights appears, cached under
// data/routes/ for a week, and never more than one request every 2 s; a
// failed airline is left alone for an hour. The data is published schedules,
// so a diverted or repositioning flight will show its planned route.
const ROUTES_DIR = path.join(ROOT, 'data', 'routes');
const ROUTE_URL = (code) =>
  `https://raw.githubusercontent.com/vradarserver/standing-data/main/routes/schema-01/${code[0]}/${code}-all.csv`;
const routeTables = new Map();  // airline → Map(callsign → "KSEA-KLAX")
const routeFailedAt = new Map(); // airline → ms of the last failure
const routeQueue = new Set();
const routeInflight = new Set(); // being fetched now — never queue it twice
let routeBusy = false;
function airlineOf(callsign) {
  const m = /^([A-Z]{3})\d{1,4}[A-Z]?$/.exec(callsign || '');
  return m ? m[1] : null;
}
function parseRoutes(text) {
  const map = new Map();
  for (const line of text.split('\n').slice(1)) {
    const c = line.split(',');
    if (c.length >= 5 && c[0] && c[4]) map.set(c[0].trim(), c[4].trim());
  }
  return map;
}
async function loadAirlineRoutes(code) {
  const file = path.join(ROUTES_DIR, `${code}.csv`);
  try {
    const st = fs.statSync(file);
    if (Date.now() - st.mtimeMs < 7 * 864e5) {
      routeTables.set(code, parseRoutes(fs.readFileSync(file, 'utf8')));
      return;
    }
  } catch { /* not cached yet */ }
  const res = await fetch(ROUTE_URL(code), {
    signal: AbortSignal.timeout(20000),
    headers: { 'User-Agent': 'overhead (github.com/Diastro/overhead)' },
  });
  // 404 = the dataset has no file for this airline: cache an empty table so
  // it is not asked again this week.
  const text = res.status === 404 ? 'Callsign\n' : res.ok ? await res.text() : null;
  if (text == null) throw new Error(`HTTP ${res.status}`);
  fs.mkdirSync(ROUTES_DIR, { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
  routeTables.set(code, parseRoutes(text));
}
async function drainRouteQueue() {
  if (routeBusy) return;
  routeBusy = true;
  try {
    for (const code of routeQueue) {
      routeQueue.delete(code);
      routeInflight.add(code);
      try {
        await loadAirlineRoutes(code);
      } catch (err) {
        routeFailedAt.set(code, Date.now());
        console.error(`[routes] ${code} failed (${err.message})`);
      } finally {
        routeInflight.delete(code);
      }
      await sleep(2000);
    }
  } finally {
    routeBusy = false;
  }
}
// Sync lookup for the poll path; unknown airlines are queued, not awaited.
function routeFor(callsign) {
  const code = airlineOf(callsign);
  if (!code) return null;
  const table = routeTables.get(code);
  if (table) return table.get(callsign) || null;
  if (!routeInflight.has(code) && Date.now() - (routeFailedAt.get(code) || 0) > 3600e3) {
    routeQueue.add(code);
    drainRouteQueue();
  }
  return null;
}
// Published schedules are not always this flight: Southwest reuses a
// number across legs, so SWA2449 over Seattle came back as LGA → BNA. A route
// is only shown when the aircraft is within ROUTE_SLACK_NM of it, measured
// along each leg's great circle — which needs airport coordinates, so routes
// wait until the OurAirports table is loaded (the airports layer uses the
// same cached file).
const ROUTE_SLACK_NM = 150;
let airportIndex = null; // ident → { lat, lon, iata }
function airportAt(ident) {
  if (!airportIndex) {
    if (!airportsData) { ensureAirports().catch(() => {}); return undefined; }
    airportIndex = new Map(airportsData.map((a) => [a.ident, a]));
  }
  return airportIndex.get(ident) || null;
}
// The leg of a multi-stop route this aircraft is flying: the nearest leg
// within ROUTE_SLACK_NM, where a leg whose destination lies behind the
// aircraft (more than 100° off its track) counts as 200 NM further away —
// that separates the two legs of a round trip through one airport. -1 when
// no leg is near. Labelling by leg (DEN → SEA → OAK over Seattle, southbound,
// is "SEA → OAK") is also what lets the board see SEA as a middle stop.
function currentLeg(lat, lon, track, stops) {
  let best = -1, bestScore = Infinity;
  for (let i = 1; i < stops.length; i++) {
    const d = legDistance(lat, lon, stops[i - 1], stops[i]);
    if (d > ROUTE_SLACK_NM) continue;
    let score = d;
    if (Number.isFinite(track)) {
      const b = stops[i];
      const r = Math.PI / 180;
      const brg = (Math.atan2(Math.sin((b.lon - lon) * r) * Math.cos(b.lat * r),
        Math.cos(lat * r) * Math.sin(b.lat * r) - Math.sin(lat * r) * Math.cos(b.lat * r) * Math.cos((b.lon - lon) * r)) / r + 360) % 360;
      const off = Math.abs(((brg - track + 540) % 360) - 180);
      if (off > 100) score += 200;
    }
    if (score < bestScore) { bestScore = score; best = i; }
  }
  return best;
}
// Closest approach, in NM, of a point to one great-circle leg (sampled).
function legDistance(lat, lon, a, b) {
  const r = Math.PI / 180;
  let min = Infinity;
  const [p1, l1, p2, l2] = [a.lat * r, a.lon * r, b.lat * r, b.lon * r];
  const d = 2 * Math.asin(Math.sqrt(Math.sin((p2 - p1) / 2) ** 2 +
    Math.cos(p1) * Math.cos(p2) * Math.sin((l2 - l1) / 2) ** 2));
  const n = Math.max(2, Math.ceil((d * 3440) / 50)); // a sample every ~50 NM
  for (let k = 0; k <= n; k++) {
    const f = k / n;
    let pLat, pLon;
    if (d < 1e-9) { pLat = a.lat; pLon = a.lon; } else {
      const A = Math.sin((1 - f) * d) / Math.sin(d), B = Math.sin(f * d) / Math.sin(d);
      const x = A * Math.cos(p1) * Math.cos(l1) + B * Math.cos(p2) * Math.cos(l2);
      const y = A * Math.cos(p1) * Math.sin(l1) + B * Math.cos(p2) * Math.sin(l2);
      const z = A * Math.sin(p1) + B * Math.sin(p2);
      pLat = Math.atan2(z, Math.hypot(x, y)) / r;
      pLon = Math.atan2(y, x) / r;
    }
    min = Math.min(min, nmBetween(lat, lon, pLat, pLon));
  }
  return min;
}
// "KSEA-KLAX" → "SEA → LAX", by IATA code where the airport has one (EGLL →
// LHR), else the ICAO ident — for the leg being flown. Null when unverifiable
// or implausible.
function routeLabel(codes, ac) {
  if (!codes) return null;
  const idents = codes.split('-');
  const stops = idents.map(airportAt);
  if (stops.some((s) => s === undefined || s === null)) return null;
  const leg = currentLeg(ac.lat, ac.lon, ac.track, stops);
  if (leg < 0) return null;
  return [leg - 1, leg].map((i) => stops[i].iata || idents[i]).join(' → ');
}

// ----------------------------------------------------------- today's sky
// Every aircraft the feed showed today, once each: what it was, and whether
// it came overhead, was military or squawked an emergency. Kept here rather
// than in a browser because the server is the one thing that watches all day
// — a kiosk reload or a second screen must not reset "today". Same cadence
// and atomic write as the usage counters; rolls over at LOCAL midnight.
const TODAY_PATH = path.join(ROOT, 'data', 'today.json');
const freshDay = (day) => ({ day, seen: {}, hours: Array(24).fill(0) });
let today = freshDay(dayKey(Date.now()));
let todayDirty = false;
// Past days, one summary each, newest last — the week's shape without
// keeping every hex forever. 30 days is ~6 KB.
const HISTORY_PATH = path.join(ROOT, 'data', 'history.json');
// Both files are read defensively and cleaned entry by entry. An earlier
// version let any truthy JSON through: a history.json of {} made archiveDay
// throw at midnight, and since noteSky runs inside the feed poll, every poll
// after it counted as a feed failure — the wall froze on its last aircraft.
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
let history = [];
try {
  const h = JSON.parse(fs.readFileSync(HISTORY_PATH, 'utf8'));
  history = Array.isArray(h) ? h.filter((d) => d && DAY_RE.test(d.day) && Number.isFinite(d.aircraft)) : [];
} catch {}
function cleanDay(t) {
  if (!t || !DAY_RE.test(t.day) || !t.seen || typeof t.seen !== 'object' || Array.isArray(t.seen)) return null;
  const seen = {};
  for (const [hex, v] of Object.entries(t.seen)) {
    if (v && typeof v === 'object') seen[hex] = { t: typeof v.t === 'string' ? v.t : '', f: Number.isInteger(v.f) ? v.f : 0 };
  }
  const hours = Array.from({ length: 24 }, (_, i) => (Array.isArray(t.hours) && Number.isFinite(t.hours[i]) ? t.hours[i] : 0));
  return { day: t.day, seen, hours };
}
function archiveDay(day) {
  if (!Object.keys(day.seen).length || history.some((h) => h.day === day.day)) return;
  const { hours, onlyOnce, ...rest } = summarize(day);
  history.push({ ...rest, hours });
  history = history.slice(-30);
  try { writeJsonAtomic(HISTORY_PATH, history, false); } catch (err) {
    console.error(`[history] save failed: ${err.message}`);
  }
}
try {
  const t = cleanDay(JSON.parse(fs.readFileSync(TODAY_PATH, 'utf8')));
  // A server that was down over midnight still owes yesterday to history.
  // A saved day LATER than the clock means the clock is wrong (a Pi boots
  // on fake-hwclock's last save until NTP answers): keep counting into it
  // rather than archive a day that has not finished.
  if (t) {
    if (t.day >= today.day) today = t;
    else setImmediate(() => archiveDay(t));
  }
} catch {}
const F_OVERHEAD = 1, F_MIL = 2, F_EMERG = 4, F_POLICE = 8;
function nmBetween(lat1, lon1, lat2, lon2) {
  const r = Math.PI / 180;
  const a = Math.sin(((lat2 - lat1) * r) / 2) ** 2 +
    Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(((lon2 - lon1) * r) / 2) ** 2;
  return 2 * 3440.065 * Math.asin(Math.sqrt(a));
}
function noteSky(aircraft) {
  const now = new Date();
  const day = dayKey(now.getTime());
  // Only ever forward: a clock that steps back (NTP correcting a bad boot
  // time) must not archive the day in progress.
  if (day > today.day) { archiveDay(today); today = freshDay(day); }
  const hour = now.getHours();
  for (const ac of aircraft) {
    if (!ac.hex) continue;
    let rec = today.seen[ac.hex];
    if (!rec) {
      rec = today.seen[ac.hex] = { t: ac.type || '', f: 0 };
      today.hours[hour]++;
    }
    if (ac.type && !rec.t) rec.t = ac.type;
    let f = rec.f;
    if (ac.mil) f |= F_MIL;
    if (ac.emerg) f |= F_EMERG;
    if (ac.police) f |= F_POLICE;
    if (!ac.onGround && (ac.alt == null || ac.alt <= (config.overhead_max_ft ?? 18000)) &&
        nmBetween(config.home.lat, config.home.lon, ac.lat, ac.lon) <= (config.overhead_nm ?? 3)) {
      f |= F_OVERHEAD;
    }
    rec.f = f;
  }
  todayDirty = true;
}
// Wide-bodies and oddities first when naming what showed up only once today.
const NOTABLE = /^(A38|A35|A34|A33|B74|B77|B78|B76|C17|C5|C130|C30J|K35|KC|E3|E6|P8|B52|B1|B2|F\d|AN|IL|CONC|DC10|MD11|A400|BLCF|BELF|H47|V22)/;
function todaySummary() { return summarize(today); }
function summarize(day) {
  const recs = Object.values(day.seen);
  const count = (bit) => recs.filter((r) => r.f & bit).length;
  const types = {};
  for (const r of recs) if (r.t) types[r.t] = (types[r.t] || 0) + 1;
  const ranked = Object.entries(types).sort((a, b) => b[1] - a[1]);
  const once = ranked.filter(([, n]) => n === 1).map(([t]) => t)
    .sort((a, b) => (NOTABLE.test(b) - NOTABLE.test(a)) || a.localeCompare(b));
  const busiest = day.hours.reduce((best, n, h) => (n > day.hours[best] ? h : best), 0);
  return {
    day: day.day,
    aircraft: recs.length,
    overhead: count(F_OVERHEAD),
    military: count(F_MIL),
    emergencies: count(F_EMERG),
    police: count(F_POLICE),
    busiestHour: day.hours[busiest] ? busiest : null,
    hours: day.hours,
    topType: ranked[0] || null,
    onlyOnce: once.slice(0, 4),
    types: ranked.length,
  };
}
function saveToday() {
  if (!todayDirty) return;
  try {
    writeJsonAtomic(TODAY_PATH, today, false);
    todayDirty = false;
  } catch (err) {
    console.error(`[today] save failed: ${err.message}`);
  }
}

setInterval(saveUsage, 60000);
setInterval(saveToday, 60000);
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { saveUsage(); saveToday(); process.exit(0); });
}

let sourceIdx = 0;
let emptyStrikes = 0; // sources in a row that answered an unexpectedly empty sky
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
// When the last SSE client attached or detached. The upstream is only worth
// polling while somebody can see the result — this stamp is what lets the
// scheduler stop billing the WAN for an empty room.
let lastClientAt = Date.now();
const pollBaseMs = Math.max(2, config.poll_seconds) * 1000;
const STARTED_AT = Date.now();
const INNER_NM = config.low_bw_inner_nm || 10;
const clients = new Set();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Upstream backoff. Both feeds are community-run, keyless and free, and both
// answer a client that will not stop with 429 or 403. Retrying a rate-limit
// every 3 s is how a polite client becomes a blocked one — and the failover
// below made it worse, alternating between two sources at full cadence while
// both were refusing. So a failing upstream gets room: double the wait each
// time, cap it, honour Retry-After when the server names a number, and count
// the streak ACROSS sources so switching does not reset the pressure.
const BACKOFF_CAP_MS = 5 * 60 * 1000;
let failStreak = 0;
let backoffUntil = 0;
// A deliberate user action — moving home, changing bandwidth mode — is not a
// retry loop, and must not be swallowed by a wait that an upstream's rate
// limit imposed. One extra request is not what gets a client blocked; a 403
// carrying Retry-After: 300 silently eating a SET HOME for five minutes while
// the panel reports success is a much worse trade.
function clearFeedBackoff() {
  failStreak = 0;
  backoffUntil = 0;
}
function noteFeedFailure(retryAfterMs) {
  failStreak++;
  const stepped = pollBaseMs * 2 ** Math.min(failStreak, 7);
  const wait = Math.max(retryAfterMs || 0, Math.min(stepped, BACKOFF_CAP_MS));
  // Jitter, so two Overheads on the same street do not resynchronise onto the
  // same upstream second every time they are both throttled.
  backoffUntil = Date.now() + Math.round(wait * (0.85 + Math.random() * 0.3));
  return backoffUntil - Date.now();
}

// Home is a house. The feeds only need "within N nm of a point" — N being 87
// — so handing a third party seven decimal places of it every few seconds is
// sub-metre precision nobody asked for and nobody needs. Three decimals is
// ~110 m, which cannot move a single aircraft in or out of an 87 nm circle.
const coarse = (deg) => Math.round(deg * 1000) / 1000;

// The display promises coverage up to 100 statute miles around home — clamp
// the feed query to that (in nm) no matter what config says. /config serves
// this EFFECTIVE value so client coverage math can never diverge from it.
const RADIUS_NM = Math.min(config.radius_nm, Math.round(100 * 0.868976));

async function fetchRegion(src, lat, lon, radiusNm) {
  const res = await fetch(src.url(coarse(lat), coarse(lon), radiusNm), {
    signal: AbortSignal.timeout(8000),
    headers: { Accept: 'application/json', 'User-Agent': 'overhead-tracker (github.com/Diastro/overhead)' },
  });
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status}`);
    const after = Number(res.headers.get('retry-after'));
    if (Number.isFinite(after) && after > 0) err.retryAfterMs = Math.min(after * 1000, BACKOFF_CAP_MS);
    throw err;
  }
  const text = await res.text();
  // Prefer Content-Length: that's compressed wire bytes (the feed gzips);
  // fall back to decompressed size when the header is absent.
  const clen = Number(res.headers.get('content-length'));
  const wireBytes = Number.isFinite(clen) && clen > 0 ? clen : Buffer.byteLength(text);
  feedBytes += wireBytes;
  addUsage(wireBytes);
  // The same guard usableAirspace() applies to ArcGIS, for the same reason: a
  // 200 is not proof the server answered the question. `.ac || []` turned any
  // 200 without an aircraft array — an error body, an HTML captive portal, a
  // changed schema — into a confident empty sky, which the display draws as
  // "QUIET SKY" and nobody can tell from a real one. An empty `ac: []` is a
  // legitimate answer and still passes.
  const body = JSON.parse(text);
  const list = body[src.list];
  if (!Array.isArray(list)) throw new Error('HTTP 200 without an aircraft array');
  return list;
}

async function poll(kind = 'full') {
  if (pollInFlight) return;
  // Every caller goes through here — the scheduler, a client attaching, a new
  // home — so this is the one place the backoff has to hold. A kiosk that
  // reloads in a loop must not walk straight past it.
  if (Date.now() < backoffUntil) return;
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
  // While backing off, the next scan is when the backoff lifts, not when the
  // tick pattern next fires — otherwise the display counts down to a scan
  // that poll() is going to refuse, and keeps doing it.
  return Math.max(lastTickAt + k * pollBaseMs, backoffUntil);
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
  // Nobody watching → nothing fetched. This was measured at ~1.7 GB/day of
  // upstream traffic spent painting frames for an empty client set. The 60 s
  // grace covers a reloading kiosk, and /events triggers an immediate full
  // sweep on attach, so a returning viewer never sees a blanked sky for more
  // than one round trip.
  if (clients.size === 0 && Date.now() - lastClientAt > 60000) return;
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
      // Pin the region before yielding: a client that pans back home POSTs
      // /view null, and that used to land during the sleep below, leaving the
      // dereference to throw "Cannot read properties of null (reading 'lat')"
      // and silently drop the extra region on every such poll.
      const area = viewArea;
      if (area) {
        await sleep(1100); // stay under the API's 1 req/s limit
        try {
          const extra = await fetchRegion(src, area.lat, area.lon, area.radius_nm);
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
    const lastCount = lastPayload && Array.isArray(lastPayload.aircraft) ? lastPayload.aircraft.length : 0;
    if (suspectEmpty(aircraft.length, lastCount, emptyStrikes)) {
      emptyStrikes++;
      const next = nextSource(sourceIdx);
      console.error(`[feed] ${src.name} reported an empty sky right after ${lastCount} aircraft — asking ${SOURCES[next].name}`);
      sourceIdx = next;
      consecutiveFailures = 0;
      return; // clients keep coasting on the last targets until the other source answers
    }
    emptyStrikes = 0;
    for (const a of aircraft) a.route = routeLabel(routeFor(a.callsign), a);
    // Bookkeeping must never cost the display its aircraft.
    try { noteSky(aircraft); } catch (err) { console.error(`[today] ${err.message}`); }
    lastSuccessAt = Date.now();
    consecutiveFailures = 0;
    failStreak = 0;
    backoffUntil = 0;
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
    if (/HTTP 403/.test(err.message)) {
      // A refusal, not a rate limit: retrying cannot fix it, and the source
      // after it is not to blame, so no backoff — park it and move on.
      src.parkedUntil = Date.now() + PARK_MS;
      sourceIdx = nextSource(sourceIdx);
      consecutiveFailures = 0;
      console.error(`[feed] ${src.name} refused (${err.message}); parked for ${PARK_MS / 3600000} h, switching to ${SOURCES[sourceIdx].name}`);
    } else {
      consecutiveFailures++;
      const waitMs = noteFeedFailure(err.retryAfterMs);
      console.error(
        `[feed] ${src.name} failed (${err.message}), failures=${consecutiveFailures}, ` +
        `next attempt in ${Math.round(waitMs / 1000)}s`
      );
      if (consecutiveFailures >= 2) {
        sourceIdx = nextSource(sourceIdx);
        console.error(`[feed] switching to ${SOURCES[sourceIdx].name}`);
        consecutiveFailures = 0;
      }
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
    // A socket that died without a clean close must never crash the kiosk;
    // a socket that stopped draining must not buffer frames forever either.
    try {
      if (res.writableLength > 1_000_000) { res.destroy(); clients.delete(res); continue; }
      res.write(frame);
    } catch { clients.delete(res); }
  }
}

// Read a small JSON body safely: hard size cap, connection-error tolerant.
// Calls cb(value) on success; answers 400/413 itself on failure.
function readJsonBody(req, res, cb) {
  let body = '';
  let done = false;
  req.on('data', (c) => {
    if (done) return;
    body += c;
    if (body.length > 4096) {
      done = true;
      res.writeHead(413, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'body too large' }));
      req.destroy();
    }
  });
  req.on('error', () => { done = true; }); // reset mid-body must not crash the kiosk
  req.on('end', () => {
    if (done) return;
    let value;
    try { value = JSON.parse(body || 'null'); } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid JSON' }));
      return;
    }
    cb(value);
  });
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

// Personal settings (home, bandwidth mode) are held in memory only — the
// browser owns them (localStorage) and re-asserts them on connect, so nothing
// personal is ever written to disk on the server side.

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
        elev: header.indexOf('elevation_ft'),
        muni: header.indexOf('municipality'),
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
        const elev = r[ci.elev] === '' ? NaN : Number(r[ci.elev]);
        out.push({
          ident: r[ci.ident], type: r[ci.type], name: r[ci.name], lat, lon,
          iata: r[ci.iata] || null,
          elev: Number.isFinite(elev) ? elev : null,
          muni: r[ci.muni] || null,
        });
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

// ----------------------------------------------------------------- airspace
// FAA Class Airspace open-data service (keyless, US National Airspace only).
// Fetched once per area, cached on disk.
const airspaceMem = new Map();
const airspaceStr = new Map();   // key → serialized body; bounded, see /airspace

// ArcGIS answers a throttled or malformed query with HTTP 200 and an
// {"error":{...}} body, and an out-of-coverage area with a legitimately empty
// FeatureCollection. Only the latter is worth keeping: caching an error body
// used to poison the area permanently, so the airspace layer stayed dark
// forever even after the rate limit cleared.
function usableAirspace(g) {
  return !!g && !g.error && g.type === 'FeatureCollection' && Array.isArray(g.features);
}

async function fetchAirspace(lat, lon, radiusNm) {
  const key = `${lat.toFixed(1)}_${lon.toFixed(1)}_${Math.round(radiusNm)}`;
  if (airspaceMem.has(key)) return airspaceMem.get(key);
  const file = path.join(ROOT, 'data', `airspace-${key}.json`);
  if (fs.existsSync(file)) {
    try {
      const g = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (usableAirspace(g)) {
        airspaceMem.set(key, g);
        return g;
      }
      // A cache file written by an older build (or a half-written one) that
      // holds an error payload: drop it and refetch rather than serve it.
      console.warn(`[airspace] discarding unusable cache for ${key}`);
      fs.unlinkSync(file);
    } catch { /* refetch */ }
  }
  const dLat = radiusNm / 60;
  const dLon = radiusNm / (60 * Math.cos((lat * Math.PI) / 180));
  const params = new URLSearchParams({
    where: "CLASS IN ('B','C','D')",
    geometry: `${lon - dLon},${lat - dLat},${lon + dLon},${lat + dLat}`,
    geometryType: 'esriGeometryEnvelope',
    inSR: '4326',
    spatialRel: 'esriSpatialRelIntersects',
    outFields: 'NAME,CLASS,LOWER_VAL,UPPER_VAL',
    outSR: '4326',
    f: 'geojson',
  });
  const res = await fetch(
    'https://services6.arcgis.com/ssFJjBXIUyZDrSYZ/arcgis/rest/services/Class_Airspace/FeatureServer/0/query?' + params,
    { signal: AbortSignal.timeout(30000) }
  );
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const g = await res.json();
  if (!usableAirspace(g)) {
    // Surface the upstream's own words — "API calls quota exceeded" is worth
    // seeing on the glass, and a retry in a minute usually succeeds.
    throw new Error(g?.error?.message || 'upstream returned no feature collection');
  }
  writeJsonAtomic(file, g, false);
  airspaceMem.set(key, g);
  console.log(`[airspace] ${g.features.length} B/C/D polygons cached for ${key}`);
  return g;
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
    readJsonBody(req, res, (v) => {
      try {
        const { mode } = v || {};
        if (!BW_MODES.has(mode)) throw new Error('bad mode');
        bwMode = mode;
        console.log(`[feed] bandwidth mode: ${mode}`);
        if (mode === 'high') { clearFeedBackoff(); poll('full'); }
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
    readJsonBody(req, res, (v) => {
      try {
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
        // Only a *changed* region warrants an immediate out-of-schedule fetch.
        // Clients re-assert an identical region every 2 minutes as a keepalive,
        // and each of those was buying a full extra upstream sweep.
        const sig = viewArea ? `${viewArea.lat},${viewArea.lon},${viewArea.radius_nm}` : '';
        if (sig !== (scheduledPoll.lastViewSig ?? '')) poll();
        scheduledPoll.lastViewSig = sig;
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
    readJsonBody(req, res, (v) => {
      try {
        const { lat, lon, explicit } = v || {};
        if (typeof lat !== 'number' || typeof lon !== 'number' ||
            Math.abs(lat) > 90 || Math.abs(lon) > 180) throw new Error('bad coords');
        // Two devices with different stored homes must not duel: background
        // re-asserts only land while no device has explicitly SET a home
        // this server lifetime. An explicit SET always wins.
        const same = config.home.lat === lat && config.home.lon === lon;
        if (explicit) homeExplicitAt = Date.now();
        if (!same && (explicit || !homeExplicitAt)) {
          config.home.lat = lat;
          config.home.lon = lon;
          console.log(`[home] moved (${explicit ? 'explicit' : 'reassert'}, in-memory only)`);
          clearFeedBackoff(); // the sky around the OLD home is now simply wrong
          poll(); // refresh the sky around the new home right away
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, applied: same || explicit || !homeExplicitAt }));
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'expected JSON {lat, lon, explicit?}' }));
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
    // If the scheduler has been idling with no clients, the replayed payload
    // above is stale — kick a full sweep so the sky is current within a poll.
    const wasIdle = clients.size === 0 && Date.now() - lastClientAt > 60000;
    clients.add(res);
    lastClientAt = Date.now();
    if (wasIdle) poll('full');
    req.on('close', () => { clients.delete(res); lastClientAt = Date.now(); });
    res.on('error', () => { clients.delete(res); lastClientAt = Date.now(); });
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

  if (url.pathname === '/airspace') {
    const lat = Number(url.searchParams.get('lat'));
    const lon = Number(url.searchParams.get('lon'));
    const radius = Math.min(Number(url.searchParams.get('radius_nm')) || RADIUS_NM, 250);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) { res.writeHead(400).end(); return; }
    try {
      const g = await fetchAirspace(lat, lon, radius);
      // Serialize once per area, not per request: the LA cache file is 7.2 MB,
      // and stringifying that on the event loop stalled every SSE broadcast
      // behind it for the duration. Keyed the same way as fetchAirspace's memo.
      const key = `${lat.toFixed(1)}_${lon.toFixed(1)}_${Math.round(radius)}`;
      let body = airspaceStr.get(key);
      if (!body) {
        body = JSON.stringify(g);
        if (airspaceStr.size >= 6) airspaceStr.delete(airspaceStr.keys().next().value);
        airspaceStr.set(key, body);
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(body);
    } catch (err) {
      console.error(`[airspace] ${err.message}`);
      res.writeHead(502, { 'Content-Type': 'application/json' });
      // Pass the reason through: the client puts it on the alert banner so a
      // dark airspace layer is never silently dark.
      res.end(JSON.stringify({ error: err.message || 'airspace data unavailable' }));
    }
    return;
  }

  if (url.pathname === '/history' || url.pathname === '/today') {
    // Stats are a nicety: a failure here is a 500, never a dead process.
    let body;
    try { body = JSON.stringify(url.pathname === '/today' ? todaySummary() : history); } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(body);
    return;
  }

  if (url.pathname === '/usage') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ...usage, sessionBytes: feedBytes, startedAt: STARTED_AT }));
    return;
  }

  if (url.pathname === '/config') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ...config, radius_nm: RADIUS_NM }));
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
  fs.stat(full, (serr, st) => {
    if (serr) {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('not found');
      return;
    }
    // no-cache means revalidate, not refetch — with a validator to revalidate
    // against, a kiosk reload answers 304 and leaflet.js (147 KB) comes from
    // browser cache instead of the SD card.
    const lastMod = st.mtime.toUTCString();
    if (req.headers['if-modified-since'] === lastMod) {
      res.writeHead(304, { 'Cache-Control': 'no-cache', 'Last-Modified': lastMod }).end();
      return;
    }
    fs.readFile(full, (err, data) => {
      if (err) {
        res.writeHead(404, { 'Content-Type': 'text/plain' }).end('not found');
        return;
      }
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(full)] || 'application/octet-stream',
        'Cache-Control': 'no-cache',
        'Last-Modified': lastMod,
      });
      res.end(data);
    });
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
