#!/usr/bin/env node
// Rendered contrast check for the map styles:
//
//   npm run check:render            (needs Chrome or Chromium installed;
//                                    CHROME=/path/to/chrome to choose one)
//
// check:styles measures inks against the colours a style DECLARES for water,
// land and built-up. What reaches the glass is those colours after real tiles
// have gone through the SVG gradient maps — with roads, labels baked into the
// canvas, anti-aliased coasts, and whatever the imagery happens to contain.
// This check measures that instead: it fetches a handful of real tiles per
// styled source, runs each through the app's own filters (styles.filterDefs)
// in headless Chrome, and reports, per style and ink, the share of map area
// where the ink would fall under its contrast bar.
//
// "Area under bar" rather than a worst pixel, because a map always has SOME
// pixel an ink cannot clear (a white road under a white target): targets
// carry a halo for exactly that. A fill ink failing on more than 8% of the
// map is failing on the map itself, not on its hairlines.
//
// Coverage: base layers only. Labels, hillshade and the fx overlay are not
// composited — check:styles covers relief and wash analytically.
'use strict';

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const S = require('../web/styles.js');
const BASEMAPS = require('../web/basemaps.js');

const MAX_AREA = 0.08;
// --only=ecdis:dark,riso:light — re-measure a few halves while tuning.
const ONLY = (process.argv.find((a) => a.startsWith('--only=')) || '').slice(7).split(',').filter(Boolean);
// Everything measured here is a GRAPHIC on the map — an icon with a dark
// halo, a ring — so the bar is WCAG 1.4.11's 3:1, not text's 4.5:1. (Text
// sits on the data block's own panel and check:styles holds it to 4.5.)
// At 4.5 the failures were almost all roads: to clear it, a style's roads
// would have to be as dark as its land, i.e. no roads.
const INKS = [['altBand0', 3], ['amber', 3], ['mil', 3], ['ring', 3]];
// Seattle: coast, water, city and terrain in a few tiles. z12 is the scale the
// display usually sits at; z10 adds the wider view.
const TILES = [[10, 163, 357], [12, 655, 1430], [12, 656, 1430], [12, 655, 1431]];

function findChrome() {
  const candidates = [process.env.CHROME,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome'];
  return candidates.find((c) => c && fs.existsSync(c));
}

// The page: builds each style's filters with the app's own filterDefs, draws
// each tile through them, and returns per-ink area-under-bar fractions.
const PAGE = `<!doctype html><meta charset="utf-8"><body>
<svg id="defs" width="0" height="0" style="position:absolute"><defs></defs></svg>
<script src="/styles.js"></script>
<script>
async function img(url) {
  const i = new Image(); i.crossOrigin = 'anonymous'; i.src = url;
  await i.decode(); return i;
}
function lum(r, g, b) {
  const f = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}
window.run = async (jobs, tiles, inks) => {
  const out = [];
  const cache = {};
  for (const job of jobs) {
    const st = MAPSTYLES.byId(job.style);
    document.querySelector('#defs defs').innerHTML = MAPSTYLES.filterDefs(st, job.theme, 'rc');
    const inkSet = MAPSTYLES.inksFor(st, job.theme);
    const inkLum = inks.map(([k, bar]) => [k, bar, (() => { const h = k === "altBand0" ? inkSet.altBands[0] : inkSet[k]; const n = parseInt(h.slice(1), 16);
      return lum(n >> 16, (n >> 8) & 255, n & 255); })()]);
    const under = Object.fromEntries(inks.map(([k]) => [k, 0]));
    const culprits = {}; // quantised colour → pixels failing the first ink
    let total = 0;
    for (const [z, x, y] of tiles) {
      const url = job.url.replace('{z}', z).replace('{x}', x).replace('{y}', y);
      let im;
      try { im = cache[url] || (cache[url] = await img(url)); } catch { continue; }
      const c = document.createElement('canvas'); c.width = c.height = 256;
      const ctx = c.getContext('2d', { willReadFrequently: true });
      ctx.filter = 'url(#rc-base-' + job.src + ')';
      ctx.drawImage(im, 0, 0);
      const d = ctx.getImageData(0, 0, 256, 256).data;
      for (let i = 0; i < d.length; i += 16) { // every 4th pixel is plenty
        const L = lum(d[i], d[i + 1], d[i + 2]);
        total++;
        for (const [k, bar, li] of inkLum) {
          const r = (Math.max(L, li) + 0.05) / (Math.min(L, li) + 0.05);
          if (r < bar) {
            under[k]++;
            if (k === inks[0][0]) {
              const q = '#' + [d[i], d[i + 1], d[i + 2]].map((v) => ((v >> 3) << 3).toString(16).padStart(2, '0')).join('');
              culprits[q] = (culprits[q] || 0) + 1;
            }
          }
        }
      }
    }
    const top = Object.entries(culprits).sort((a, b) => b[1] - a[1]).slice(0, 4)
      .map(([c, n]) => c + ' ' + (100 * n / Math.max(1, total)).toFixed(1) + '%');
    out.push({ ...job, total, top, under: Object.fromEntries(Object.entries(under).map(([k, n]) => [k, total ? n / total : null])) });
  }
  return out;
};
</script>`;

async function main() {
  const chrome = findChrome();
  if (!chrome) {
    console.error('check:render needs Chrome or Chromium — set CHROME=/path/to/chrome.');
    process.exit(2);
  }
  // Tiny server: the page and the real web/styles.js, same origin.
  const server = http.createServer((req, res) => {
    if (req.url === '/') { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end(PAGE); }
    if (req.url === '/styles.js') {
      res.writeHead(200, { 'Content-Type': 'text/javascript' });
      return res.end(fs.readFileSync(path.join(__dirname, '..', 'web', 'styles.js')));
    }
    res.writeHead(404); res.end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'overhead-render-'));
  const debugPort = 20000 + Math.floor(Math.random() * 20000);
  const proc = spawn(chrome, ['--headless=new', `--remote-debugging-port=${debugPort}`, `--user-data-dir=${prof}`,
    '--no-first-run', 'about:blank'], { stdio: 'ignore' });
  // Chrome keeps writing its profile until it has actually exited.
  const exited = new Promise((r) => proc.on('exit', r));
  const cleanup = async () => {
    try { proc.kill(); } catch {}
    server.close();
    await Promise.race([exited, new Promise((r) => setTimeout(r, 3000))]);
    fs.rmSync(prof, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  };
  try {
    let ws;
    for (let i = 0; i < 60 && !ws; i++) {
      try {
        const list = await (await fetch(`http://127.0.0.1:${debugPort}/json`)).json();
        const page = list.find((t) => t.type === 'page');
        if (page) ws = new WebSocket(page.webSocketDebuggerUrl);
      } catch {}
      if (!ws) await new Promise((r) => setTimeout(r, 250));
    }
    if (!ws) throw new Error('Chrome did not open a debugging page');
    await new Promise((r) => ws.addEventListener('open', r));
    let id = 0; const pending = new Map();
    ws.addEventListener('message', (e) => {
      const m = JSON.parse(e.data);
      if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    });
    const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
    await send('Page.enable');
    await send('Page.navigate', { url: `http://127.0.0.1:${port}/` });
    await new Promise((r) => setTimeout(r, 1500));

    // One job per style × theme × styled source.
    const sources = {};
    for (const p of BASEMAPS.providers(null)) {
      for (const l of (p.styled && p.styled.layers) || []) if (l.src && !sources[l.src]) sources[l.src] = l.url;
    }
    const jobs = [];
    for (const st of S.STYLES) {
      if (st.classic) continue;
      for (const theme of ['dark', 'light']) {
        for (const [src, url] of Object.entries(sources)) {
          // Only the sources the app will actually draw this style on.
          if (!S.supports(st, src)) continue;
          if (ONLY.length && !ONLY.includes(`${st.id}:${theme}`)) continue;
          jobs.push({ style: st.id, label: st.label, theme, src, url });
        }
      }
    }
    const r = await send('Runtime.evaluate', {
      expression: `run(${JSON.stringify(jobs)}, ${JSON.stringify(TILES)}, ${JSON.stringify(INKS)})`,
      awaitPromise: true, returnByValue: true,
    });
    if (r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || 'page error');
    const results = r.result.result.value;

    let failed = 0, skipped = 0;
    for (const res of results) {
      if (!res.total) { skipped++; console.log(`  skip ${res.label} · ${res.theme} · ${res.src}: no tiles loaded`); continue; }
      const bad = Object.entries(res.under).filter(([, f]) => f > MAX_AREA);
      failed += bad.length;
      const cells = Object.entries(res.under).map(([k, f]) => `${k} ${(f * 100).toFixed(1).padStart(5)}%`).join('  ');
      console.log(`${bad.length ? 'FAIL' : 'ok  '} ${`${res.label} · ${res.theme}`.padEnd(30)} ${res.src.padEnd(10)} ${cells}`);
      // -v: which rendered colours the first ink fails on — what to retune.
      if (bad.length && process.argv.includes('-v')) console.log(`       under ${INKS[0][0]}: ${res.top.join(', ')}`);
    }
    console.log(`\nShare of map area under each ink's bar (fail above ${MAX_AREA * 100}%).`);
    if (skipped) console.log(`${skipped} job(s) skipped — tiles did not load (offline?). That is not a pass.`);
    console.log(failed ? `${failed} ink/style/source combination(s) over the limit.` : skipped ? 'No failures in what ran.' : 'Every style clears its bars on real tiles.');
    await cleanup();
    process.exit(failed || skipped ? 1 : 0);
  } catch (err) {
    await cleanup();
    console.error(`check:render could not run: ${err.message}`);
    process.exit(2);
  }
}
main();
