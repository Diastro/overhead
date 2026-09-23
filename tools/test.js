#!/usr/bin/env node
// Unit tests for the logic two review passes found bugs in:
//
//   npm test
//
// node:test, no dependencies. The server is one file with no exports, so the
// sections under test are lifted out by their section-header comments and
// run with small mocks — the same code the server runs, not a copy. If a
// header is renamed, the extraction fails loudly rather than testing nothing.
//
// Covered: the day log (dedupe, overhead rule, midnight rollover, a clock
// that steps backwards, corrupt/malformed today.json and history.json),
// route CSV parsing, route plausibility and the leg being flown, the
// airline-code guard, and from the web app the sun elevation behind the auto
// theme and the descent-aware arrival estimate.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SERVER = fs.readFileSync(path.join(__dirname, '..', 'server', 'index.js'), 'utf8');
const APP = fs.readFileSync(path.join(__dirname, '..', 'web', 'app.js'), 'utf8');

function section(src, startMarker, endMarker) {
  const a = src.indexOf(startMarker), b = src.indexOf(endMarker, a + 1);
  assert.ok(a >= 0 && b > a, `section not found: ${startMarker}`);
  return src.slice(a, b);
}
const ROUTES = section(SERVER, '// ------------------------------------------------------------------ routes',
  "// ----------------------------------------------------------- today's sky");
const TODAY = section(SERVER, "// ----------------------------------------------------------- today's sky",
  'setInterval(saveUsage, 60000);');

const dayKey = (ts) => {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};
const HOME = { lat: 47.45, lon: -122.31 };

// Loads the today/history section against a temp data dir and a movable clock.
function loadToday(files = {}, startAt = new Date(2026, 8, 22, 12, 0).getTime()) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'overhead-test-'));
  fs.mkdirSync(path.join(root, 'data'));
  for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(root, 'data', name), body);
  let now = startAt;
  class FakeDate extends Date {
    constructor(...a) { super(...(a.length ? a : [now])); }
    static now() { return now; }
  }
  const writeJsonAtomic = (p, v) => fs.writeFileSync(p, JSON.stringify(v));
  const fn = new Function('fs', 'path', 'ROOT', 'dayKey', 'config', 'writeJsonAtomic', 'Date', 'setImmediate',
    `${TODAY}; return { noteSky, todaySummary, get history() { return history; }, get today() { return today; } };`);
  const immediates = [];
  const m = fn(fs, path, root, dayKey, { home: HOME, overhead_nm: 3, overhead_max_ft: 18000 },
    writeJsonAtomic, FakeDate, (f) => immediates.push(f));
  immediates.forEach((f) => f());
  return { m, root, setNow: (t) => { now = t; } };
}

test('day log counts each aircraft once and applies the overhead rule', () => {
  const { m } = loadToday();
  m.noteSky([
    { hex: 'a', type: 'B738', lat: 47.46, lon: -122.30, alt: 3000 },   // overhead
    { hex: 'b', type: 'B738', lat: 47.46, lon: -122.30, alt: 30000 },  // over but too high
    { hex: 'c', type: 'B738', lat: 47.451, lon: -122.31, alt: 0, onGround: true },
    { hex: 'd', type: 'C17', lat: 47.9, lon: -122.3, alt: 18000, mil: true },
  ]);
  m.noteSky([{ hex: 'a', type: 'B738', lat: 47.9, lon: -122.3, alt: 9000 }]);
  const s = m.todaySummary();
  assert.equal(s.aircraft, 4);
  assert.equal(s.overhead, 1);
  assert.equal(s.military, 1);
  assert.deepEqual(s.topType, ['B738', 3]);
});

test('midnight archives the day and starts a fresh one', () => {
  const { m, setNow } = loadToday();
  m.noteSky([{ hex: 'a', type: 'B738', lat: 47.9, lon: -122.3, alt: 9000 }]);
  setNow(new Date(2026, 8, 23, 0, 1).getTime());
  m.noteSky([{ hex: 'b', type: 'A320', lat: 47.9, lon: -122.3, alt: 9000 }]);
  assert.equal(m.todaySummary().day, '2026-09-23');
  assert.equal(m.todaySummary().aircraft, 1);
  assert.deepEqual(m.history.map((h) => [h.day, h.aircraft]), [['2026-09-22', 1]]);
});

test('a clock that steps backwards does not archive the day in progress', () => {
  const { m, setNow } = loadToday();
  m.noteSky([{ hex: 'a', lat: 47.9, lon: -122.3, alt: 9000 }]);
  setNow(new Date(2026, 8, 21, 23, 0).getTime()); // NTP correcting a bad boot clock the other way
  m.noteSky([{ hex: 'b', lat: 47.9, lon: -122.3, alt: 9000 }]);
  assert.equal(m.todaySummary().day, '2026-09-22');
  assert.equal(m.todaySummary().aircraft, 2);
  assert.equal(m.history.length, 0);
});

test('a stale today.json is archived at boot; a future-dated one keeps counting', () => {
  const stale = JSON.stringify({ day: '2026-09-21', seen: { x: { t: 'B738', f: 1 } }, hours: Array(24).fill(0) });
  assert.deepEqual(loadToday({ 'today.json': stale }).m.history.map((h) => h.day), ['2026-09-21']);
  const ahead = JSON.stringify({ day: '2026-09-23', seen: { x: { t: 'B738', f: 0 } }, hours: Array(24).fill(0) });
  const { m } = loadToday({ 'today.json': ahead });
  assert.equal(m.today.day, '2026-09-23');
  assert.equal(m.history.length, 0);
});

test('corrupt or malformed files never break the log', () => {
  for (const bad of ['{}', '5', '"x"', 'null', '{not json']) {
    const { m, setNow } = loadToday({ 'history.json': bad });
    m.noteSky([{ hex: 'a', lat: 47.9, lon: -122.3, alt: 9000 }]);
    setNow(new Date(2026, 8, 23, 0, 1).getTime());
    assert.doesNotThrow(() => m.noteSky([{ hex: 'b', lat: 47.9, lon: -122.3, alt: 9000 }]), `history.json = ${bad}`);
  }
  for (const seen of ['5', '"x"', 'true', '[1,2]', '{"x":null,"y":{"t":5,"f":"z"}}']) {
    const body = `{"day":"2026-09-22","seen":${seen},"hours":[1,2]}`;
    const { m } = loadToday({ 'today.json': body });
    assert.doesNotThrow(() => m.noteSky([{ hex: 'a', lat: 47.9, lon: -122.3, alt: 9000 }]), `seen = ${seen}`);
    assert.doesNotThrow(() => m.todaySummary(), `seen = ${seen}`);
    assert.equal(m.todaySummary().hours.length, 24);
  }
});

// Routes -------------------------------------------------------------------
const AIRPORTS = [
  { ident: 'KSEA', lat: 47.449, lon: -122.309, iata: 'SEA' }, { ident: 'KDEN', lat: 39.856, lon: -104.674, iata: 'DEN' },
  { ident: 'KOAK', lat: 37.721, lon: -122.221, iata: 'OAK' }, { ident: 'KLAS', lat: 36.08, lon: -115.152, iata: 'LAS' },
  { ident: 'KOMA', lat: 41.303, lon: -95.894, iata: 'OMA' }, { ident: 'KLGA', lat: 40.777, lon: -73.873, iata: 'LGA' },
  { ident: 'KBNA', lat: 36.124, lon: -86.678, iata: 'BNA' }, { ident: 'EGLL', lat: 51.47, lon: -0.454, iata: 'LHR' },
];
function nmBetween(lat1, lon1, lat2, lon2) {
  const r = Math.PI / 180;
  const q = Math.sin(((lat2 - lat1) * r) / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(((lon2 - lon1) * r) / 2) ** 2;
  return 2 * 3440.065 * Math.asin(Math.sqrt(q));
}
const R = new Function('fs', 'path', 'ROOT', 'sleep', 'airportsData', 'ensureAirports', 'nmBetween',
  `${ROUTES}; return { routeLabel, parseRoutes, airlineOf };`)(fs, path, '/nonexistent', async () => {},
  AIRPORTS, async () => {}, nmBetween);

test('route CSV parsing skips the BOM header and reads rows', () => {
  const t = R.parseRoutes('﻿Callsign,Code,Number,AirlineCode,AirportCodes\nASA1,ASA,1,ASA,KDCA-KSEA\nbad\n');
  assert.equal(t.get('ASA1'), 'KDCA-KSEA');
  assert.equal(t.size, 1);
});

test('airline codes are exactly three letters then a flight number', () => {
  assert.equal(R.airlineOf('ASA312'), 'ASA');
  assert.equal(R.airlineOf('UAL103C'), 'UAL');
  for (const bad of ['N512KM', '../../x', 'ABC', '', null, 'AS312']) assert.equal(R.airlineOf(bad), null);
});

test('an implausible route is not shown', () => {
  const overSeattle = { lat: 47.55, lon: -122.25 };
  assert.equal(R.routeLabel('KLGA-KBNA', overSeattle), null); // reused flight number
  assert.equal(R.routeLabel('KSEA-XXXX', overSeattle), null); // unknown airport
  assert.equal(R.routeLabel('KSEA-EGLL', { lat: 20, lon: -100 }), null);
  assert.equal(R.routeLabel('KSEA-EGLL', { lat: 65, lon: -45 }), 'SEA → LHR');
});

test('a multi-stop route is labelled by the leg being flown', () => {
  assert.equal(R.routeLabel('KDEN-KSEA-KOAK-KLAS', { lat: 47.2, lon: -122.0, track: 320 }), 'DEN → SEA');
  assert.equal(R.routeLabel('KDEN-KSEA-KOAK-KLAS', { lat: 47.2, lon: -122.35, track: 180 }), 'SEA → OAK');
  assert.equal(R.routeLabel('KSEA-KOMA-KSEA', { lat: 47.5, lon: -122.1, track: 95 }), 'SEA → OMA');
  assert.equal(R.routeLabel('KSEA-KOMA-KSEA', { lat: 47.5, lon: -121.9, track: 275 }), 'OMA → SEA');
});

// Web app ------------------------------------------------------------------
function appFunction(name) {
  const start = APP.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `web/app.js has no function ${name}`);
  let depth = 0, i = APP.indexOf('{', start);
  for (; i < APP.length; i++) {
    if (APP[i] === '{') depth++;
    else if (APP[i] === '}' && --depth === 0) break;
  }
  return new Function(`${APP.slice(start, i + 1)}; return ${name};`)();
}

test('sun elevation matches a reference ephemeris', () => {
  const sun = appFunction('sunElevation');
  // Seattle, 2026-06-21 20:10 UTC (local solar noon): 65.8° (NOAA calculator).
  assert.ok(Math.abs(sun(47.6062, -122.3321, new Date(Date.UTC(2026, 5, 21, 20, 10))) - 65.8) < 0.3);
  // Same day, 09:00 UTC (02:00 local): well below the horizon.
  assert.ok(sun(47.6062, -122.3321, new Date(Date.UTC(2026, 5, 21, 9, 0))) < -10);
});

test('arrival estimate allows for the descent', () => {
  const etaMin = appFunction('etaMin');
  // A jet at FL240 seven miles out cannot land in a minute.
  assert.ok(etaMin(7, { fix: { gs: 412, alt: 24000 } }) >= 15);
  // Low and slow on final: distance governs.
  assert.equal(etaMin(6, { fix: { gs: 150, alt: 1500 } }), 2);
  assert.equal(etaMin(6, { fix: { gs: null, alt: 1500 } }), null);
});
