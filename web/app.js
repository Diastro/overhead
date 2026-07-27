// Overhead display app: Leaflet dark basemap + one canvas overlay drawing all
// targets ATC-style. Positions are dead-reckoned every frame from the last fix
// so motion is continuous between 3-second feed updates.
'use strict';

// Surface fatal errors in the status bar — a kiosk has no devtools open.
function showFatal(msg) {
  const el = document.getElementById('feed-name');
  if (el) el.textContent = 'APP ERROR: ' + msg;
  const dot = document.getElementById('feed-dot');
  if (dot) dot.className = 'dot bad';
}
window.addEventListener('error', (e) => showFatal(e.message));
window.addEventListener('unhandledrejection', (e) => showFatal(e.reason?.message || String(e.reason)));

(async function main() {
  const config = await (await fetch('/config')).json();
  let HOME = [config.home.lat, config.home.lon];

  // Shared constants — keep at the top: init code below runs immediately and
  // consts are not hoisted (a TDZ crash here bricks the whole app).
  const NM_PER_MI = 0.868976;
  const TRAIL_FADE_MS = (config.trail_fade_seconds ?? 60) * 1000;
  const DETAIL_MS = (config.detail_click_seconds ?? 7) * 1000;
  const DETAIL_VIEW_MI = config.detail_always_below_view_miles ?? 10;
  const MAX_VIEW_MI = 50;

  // ------------------------------------------------------------------- map
  const map = L.map('map', {
    center: HOME,
    zoom: 11,
    zoomControl: false,
    attributionControl: true,
  });

  const TILE_URLS = {
    dark: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
    light: 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png',
  };
  const tiles = L.tileLayer(TILE_URLS.dark, {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>',
    subdomains: 'abcd',
    maxZoom: 19,
  }).addTo(map);

  const canvas = document.getElementById('scope');
  const ctx = canvas.getContext('2d');
  const stage = document.getElementById('stage');

  function resize() {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = stage.clientWidth * dpr;
    canvas.height = stage.clientHeight * dpr;
    canvas.style.width = stage.clientWidth + 'px';
    canvas.style.height = stage.clientHeight + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  window.addEventListener('resize', resize);
  resize();

  // ------------------------------------------------------------ geo helpers
  const NM_PER_DEG_LAT = 60;
  function project(lat, lon, bearingDeg, distNm) {
    const b = (bearingDeg * Math.PI) / 180;
    const dLat = (distNm * Math.cos(b)) / NM_PER_DEG_LAT;
    const dLon = (distNm * Math.sin(b)) / (NM_PER_DEG_LAT * Math.cos((lat * Math.PI) / 180));
    return [lat + dLat, lon + dLon];
  }
  function distNm(lat1, lon1, lat2, lon2) {
    const dLat = (lat2 - lat1) * NM_PER_DEG_LAT;
    const dLon = (lon2 - lon1) * NM_PER_DEG_LAT * Math.cos(((lat1 + lat2) / 2) * Math.PI / 180);
    return Math.hypot(dLat, dLon);
  }
  function shortestArc(from, to) {
    let d = (to - from) % 360;
    if (d > 180) d -= 360;
    if (d < -180) d += 360;
    return d;
  }

  // View-range slider (top right): fits the map so ~N statute miles are visible
  // around home. 1 mi = 0.868976 nm.
  const rangeInput = document.getElementById('range');
  const rangeVal = document.getElementById('range-val');
  const vm = config.view_miles || { min: 4, max: 40, default: 15 };
  rangeInput.min = vm.min;
  rangeInput.max = vm.max;
  rangeInput.value = vm.default;
  function applyRange(miles) {
    rangeVal.textContent = miles;
    const nm = miles * 0.868976;
    const north = project(HOME[0], HOME[1], 0, nm);
    const south = project(HOME[0], HOME[1], 180, nm);
    const east = project(HOME[0], HOME[1], 90, nm);
    const west = project(HOME[0], HOME[1], 270, nm);
    map.fitBounds(L.latLngBounds([north, south, east, west]), { animate: true });
  }
  rangeInput.addEventListener('input', () => applyRange(Number(rangeInput.value)));
  applyRange(Number(rangeInput.value));

  // Effective view radius in miles (tracks slider AND manual pan/zoom) and the
  // too-wide banner: the feed only covers 50 mi around home.
  let currentViewMiles = vm.default;
  const banner = document.getElementById('wide-banner');
  let lastSentView;
  let viewTimer = null;
  function onViewChanged() {
    const b = map.getBounds();
    const c = map.getCenter();
    const east = b.getEast();
    const north = b.getNorth();
    const halfW = distNm(c.lat, c.lng, c.lat, east) / NM_PER_MI;
    const halfH = distNm(c.lat, c.lng, north, c.lng) / NM_PER_MI;
    currentViewMiles = Math.min(halfW, halfH);

    const corners = [
      [b.getNorth(), b.getEast()], [b.getNorth(), b.getWest()],
      [b.getSouth(), b.getEast()], [b.getSouth(), b.getWest()],
    ];
    // radius needed to cover the whole view from its center, and whether the
    // home region already covers everything visible
    const needNm = Math.max(...corners.map(([la, lo]) => distNm(c.lat, c.lng, la, lo)));
    const maxFromHomeNm = Math.max(...corners.map(([la, lo]) => distNm(HOME[0], HOME[1], la, lo)));
    const coverageNm = config.radius_nm;
    banner.classList.toggle('show', needNm > coverageNm);

    // When panned/zoomed beyond home coverage, ask the server to also poll a
    // region around the view center so aircraft here appear too.
    const desired = maxFromHomeNm <= coverageNm
      ? null
      : { lat: c.lat, lon: c.lng, radius_nm: Math.min(Math.ceil(needNm + 2), coverageNm) };
    const key = desired ? `${desired.lat.toFixed(2)},${desired.lon.toFixed(2)},${desired.radius_nm}` : 'null';
    if (key === lastSentView) return;
    clearTimeout(viewTimer);
    viewTimer = setTimeout(() => {
      lastSentView = key;
      fetch('/view', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(desired),
      }).catch(() => { lastSentView = undefined; });
    }, 500);
  }
  map.on('zoomend moveend resize', onViewChanged);
  onViewChanged();

  // Click/tap an aircraft to show its data block for a few seconds
  map.on('click', (e) => {
    let best = null;
    let bestD = 30; // px hit radius
    for (const t of targets.values()) {
      const p = map.latLngToContainerPoint([t.shown.lat, t.shown.lon]);
      const d = Math.hypot(p.x - e.containerPoint.x, p.y - e.containerPoint.y);
      if (d < bestD) { bestD = d; best = t; }
    }
    if (best) best.detailUntil = Date.now() + DETAIL_MS;
  });

  // Collapsible list of aircraft currently inside the visible map area
  const listToggle = document.getElementById('list-toggle');
  const listPanel = document.getElementById('list-panel');
  const listEl = document.getElementById('ac-list');
  listToggle.addEventListener('click', () => {
    const open = listPanel.classList.toggle('open');
    listToggle.classList.toggle('open', open);
    if (open) renderList();
  });

  // Hovering a row isolates that aircraft: every other data block on the map
  // hides until the pointer leaves the list.
  let focusedHex = null;
  let listHovered = false;
  listPanel.addEventListener('mouseenter', () => { listHovered = true; });
  listPanel.addEventListener('mouseleave', () => { listHovered = false; focusedHex = null; });
  listEl.addEventListener('mouseover', (e) => {
    const li = e.target.closest('li');
    if (li) focusedHex = li.dataset.hex;
  });

  function renderList() {
    if (!listPanel.classList.contains('open')) return;
    if (listHovered) return; // keep rows stable under the cursor
    const bounds = map.getBounds();
    const rows = [];
    for (const t of targets.values()) {
      if (!bounds.contains([t.shown.lat, t.shown.lon])) continue;
      rows.push([distNm(HOME[0], HOME[1], t.shown.lat, t.shown.lon), t]);
    }
    rows.sort((a, b) => a[0] - b[0]);
    listEl.replaceChildren(...rows.map(([d, t]) => {
      const m = t.meta;
      const li = document.createElement('li');
      const dMi = d / NM_PER_MI;
      li.dataset.hex = m.hex;
      if (m.mil) li.classList.add('mil');
      else if (!t.fix.onGround && d <= (config.overhead_nm || 5)) li.classList.add('overhead');
      const l1 = document.createElement('div');
      l1.className = 'l1';
      l1.textContent = m.callsign || m.reg || m.hex.toUpperCase();
      const dist = document.createElement('span');
      dist.className = 'dist';
      dist.textContent = `${dMi.toFixed(1)} mi`;
      l1.appendChild(dist);
      const l2 = document.createElement('div');
      l2.className = 'l2';
      const alt = t.fix.onGround ? 'ground' : t.fix.alt != null ? `${t.fix.alt.toLocaleString()} ft` : 'alt n/a';
      l2.textContent = [m.type || '—', alt, m.operator || ''].filter(Boolean).join(' · ');
      li.append(l1, l2);
      li.addEventListener('click', () => { t.detailUntil = Date.now() + DETAIL_MS; });
      return li;
    }));
  }
  setInterval(renderList, 1000);

  // Relocatable home: address (geocoded server-side via Nominatim, keyless)
  // or raw "lat,lon". Saved to config.local.json; map flies out and back in.
  const homeToggle = document.getElementById('home-toggle');
  const homePanel = document.getElementById('home-panel');
  const homeInput = document.getElementById('home-input');
  const homeSetBtn = document.getElementById('home-set');
  const homeMsg = document.getElementById('home-msg');
  const homeRecent = document.getElementById('home-recent');
  homeToggle.addEventListener('click', () => {
    if (homePanel.classList.toggle('open')) {
      renderHomeHistory();
      homeInput.focus();
    }
  });

  // Last 3 valid home entries, persisted per browser
  function loadHomeHistory() {
    try { return JSON.parse(localStorage.getItem('overhead-home-history')) || []; }
    catch { return []; }
  }
  function renderHomeHistory() {
    const h = loadHomeHistory();
    homeRecent.replaceChildren(...h.map((entry) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'recent';
      b.textContent = entry.label;
      b.title = entry.label;
      b.addEventListener('click', () => applyHome(entry.lat, entry.lon, entry.label));
      return b;
    }));
    homeRecent.style.display = h.length ? 'flex' : 'none';
  }
  function rememberHome(entry) {
    const h = [entry, ...loadHomeHistory().filter((e) => e.label !== entry.label)].slice(0, 3);
    localStorage.setItem('overhead-home-history', JSON.stringify(h));
    renderHomeHistory();
  }

  async function applyHome(lat, lon, label) {
    const save = await fetch('/home', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lat, lon }),
    });
    if (!save.ok) throw new Error('could not save home');
    HOME = [lat, lon];
    targets.clear(); // old area's aircraft vanish; next poll brings the new sky
    rememberHome({ lat, lon, label });
    homeMsg.textContent = ('→ ' + label).slice(0, 36);
    map.flyTo(HOME, map.getZoom(), { duration: 2.2 }); // arcs out, then back in
    setTimeout(() => {
      homePanel.classList.remove('open');
      homeMsg.textContent = '';
    }, 2600);
  }

  async function setHome() {
    const q = homeInput.value.trim();
    if (!q) return;
    homeMsg.textContent = 'LOOKING UP…';
    try {
      const m = q.match(/^(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)$/);
      if (m) {
        await applyHome(Number(m[1]), Number(m[2]), q);
      } else {
        const r = await fetch('/geocode?q=' + encodeURIComponent(q));
        if (!r.ok) throw new Error('address not found');
        const g = await r.json();
        await applyHome(g.lat, g.lon, q); // remember what the user typed
      }
    } catch (err) {
      homeMsg.textContent = String(err.message || err).toUpperCase();
    }
  }
  homeSetBtn.addEventListener('click', setHome);
  homeInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') setHome(); });

  // Bandwidth used by the live feed (reported by the server per poll).
  // Clicking the readout opens a sparkline of the last 60 s of feed rate.
  const bwEl = document.getElementById('bw');
  const bwChart = document.getElementById('bw-chart');
  const bwCanvas = document.getElementById('bw-canvas');
  const bwCtx = bwCanvas.getContext('2d');
  const bwCur = document.getElementById('bw-cur');
  const bwHistory = []; // {at, kbs}
  let bwPrev = null;
  let bwHover = null; // hovered sample index or null

  bwEl.addEventListener('click', () => {
    bwChart.classList.toggle('open');
    drawBwChart();
  });
  bwCanvas.addEventListener('mousemove', (e) => {
    if (!bwHistory.length) return;
    const rect = bwCanvas.getBoundingClientRect();
    const frac = (e.clientX - rect.left) / rect.width;
    const at = Date.now() - 60000 + frac * 60000;
    let best = 0;
    for (let i = 1; i < bwHistory.length; i++) {
      if (Math.abs(bwHistory[i].at - at) < Math.abs(bwHistory[best].at - at)) best = i;
    }
    bwHover = best;
    drawBwChart();
  });
  bwCanvas.addEventListener('mouseleave', () => { bwHover = null; drawBwChart(); });

  function updateBandwidth(feedBytes) {
    if (feedBytes == null) return;
    const now = Date.now();
    let rate = '';
    if (bwPrev && feedBytes > bwPrev.bytes) {
      const kbs = (feedBytes - bwPrev.bytes) / 1024 / ((now - bwPrev.at) / 1000);
      rate = ` · ${kbs.toFixed(1)} KB/s`;
      bwHistory.push({ at: now, kbs });
      while (bwHistory.length && now - bwHistory[0].at > 60000) bwHistory.shift();
    }
    bwPrev = { bytes: feedBytes, at: now };
    const mb = feedBytes / 1048576;
    bwEl.textContent = `FEED DATA: ${mb < 1 ? (feedBytes / 1024).toFixed(0) + ' KB' : mb.toFixed(1) + ' MB'}${rate}`;
    drawBwChart();
  }

  function drawBwChart() {
    if (!bwChart.classList.contains('open')) return;
    const dpr = window.devicePixelRatio || 1;
    const W = 264, H = 84;
    if (bwCanvas.width !== W * dpr) {
      bwCanvas.width = W * dpr;
      bwCanvas.height = H * dpr;
      bwCanvas.style.width = W + 'px';
      bwCanvas.style.height = H + 'px';
    }
    bwCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    bwCtx.clearRect(0, 0, W, H);

    const now = Date.now();
    const padT = 14, padB = 4;
    const plotH = H - padT - padB;
    const max = Math.max(1, ...bwHistory.map((s) => s.kbs));
    const x = (at) => ((at - (now - 60000)) / 60000) * W;
    const y = (kbs) => padT + plotH * (1 - kbs / max);

    // faint max gridline + label (text in muted ink, not series color)
    bwCtx.strokeStyle = COLORS.chartMuted;
    bwCtx.globalAlpha = 0.35;
    bwCtx.setLineDash([3, 4]);
    bwCtx.beginPath();
    bwCtx.moveTo(0, padT);
    bwCtx.lineTo(W, padT);
    bwCtx.stroke();
    bwCtx.setLineDash([]);
    bwCtx.globalAlpha = 1;
    bwCtx.fillStyle = COLORS.chartMuted;
    bwCtx.font = '10px ui-monospace, "SF Mono", Menlo, monospace';
    bwCtx.textBaseline = 'bottom';
    bwCtx.fillText(`${max.toFixed(1)} KB/s`, 2, padT - 2);

    if (bwHistory.length > 1) {
      // area fill + 2px line, endpoint emphasized
      bwCtx.beginPath();
      bwHistory.forEach((s, i) => {
        i === 0 ? bwCtx.moveTo(x(s.at), y(s.kbs)) : bwCtx.lineTo(x(s.at), y(s.kbs));
      });
      const lastPt = bwHistory[bwHistory.length - 1];
      bwCtx.strokeStyle = COLORS.icon;
      bwCtx.lineWidth = 2;
      bwCtx.stroke();
      bwCtx.lineTo(x(lastPt.at), H - padB);
      bwCtx.lineTo(x(bwHistory[0].at), H - padB);
      bwCtx.closePath();
      bwCtx.globalAlpha = 0.14;
      bwCtx.fillStyle = COLORS.icon;
      bwCtx.fill();
      bwCtx.globalAlpha = 1;
      const dot = bwHover != null ? bwHistory[bwHover] : lastPt;
      bwCtx.beginPath();
      bwCtx.arc(x(dot.at), y(dot.kbs), 3, 0, Math.PI * 2);
      bwCtx.fillStyle = COLORS.icon;
      bwCtx.fill();
    }

    const shown = bwHover != null ? bwHistory[bwHover] : bwHistory[bwHistory.length - 1];
    bwCur.textContent = shown
      ? `${shown.kbs.toFixed(1)} KB/s${bwHover != null ? ` · ${Math.round((now - shown.at) / 1000)}s ago` : ''}`
      : '—';
  }

  // ---------------------------------------------------------------- targets
  // hex -> { fix, shown: {lat, lon, track}, trail: [[lat,lon],...], meta, lastSeen }
  const targets = new Map();
  let feedState = { ok: false, source: '…', lastOkAt: 0 };

  const es = new EventSource('/events');
  es.onmessage = (e) => {
    const payload = JSON.parse(e.data);
    feedState.source = payload.source;
    updateBandwidth(payload.feedBytes);
    if (!payload.ok || !payload.aircraft) { feedState.ok = false; return; }
    feedState.ok = true;
    feedState.lastOkAt = Date.now();

    const seen = new Set();
    for (const ac of payload.aircraft) {
      seen.add(ac.hex);
      const fix = {
        lat: ac.lat, lon: ac.lon,
        gs: ac.gs || 0,
        track: ac.track ?? 0,
        alt: ac.alt, vr: ac.vr, onGround: ac.onGround,
        at: Date.now() - (ac.seenPos ? ac.seenPos * 1000 : 0),
      };
      let t = targets.get(ac.hex);
      if (!t) {
        t = { shown: { lat: ac.lat, lon: ac.lon, track: fix.track }, trail: [] };
        targets.set(ac.hex, t);
      }
      t.fix = fix;
      t.meta = ac;
      t.lastSeen = Date.now();
      const last = t.trail[t.trail.length - 1];
      if (!last || distNm(last.lat, last.lon, ac.lat, ac.lon) > 0.05) {
        t.trail.push({ lat: ac.lat, lon: ac.lon, at: Date.now() });
        if (t.trail.length > (config.trail_length || 40)) t.trail.shift();
      }
    }
    // drop targets that left the feed (after a grace period for feed jitter)
    for (const [hex, t] of targets) {
      if (!seen.has(hex) && Date.now() - t.lastSeen > 15000) targets.delete(hex);
    }
  };

  // ------------------------------------------------------------------ icons
  const PLANE = new Path2D('M 0,-15 C 1.6,-15 2.2,-11 2.2,-8 L 2.2,-3 15,3.5 15,6.5 2.2,3.2 2.2,8.5 5.5,11.5 5.5,13.5 0,12 -5.5,13.5 -5.5,11.5 -2.2,8.5 -2.2,3.2 -15,6.5 -15,3.5 -2.2,-3 -2.2,-8 C -2.2,-11 -1.6,-15 0,-15 Z');

  function drawHeli(ctx) {
    ctx.beginPath();
    ctx.ellipse(0, 0, 4.5, 7.5, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillRect(-1.1, 6, 2.2, 9);
    ctx.fillRect(-4, 14, 8, 1.8);
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(-11, -9); ctx.lineTo(11, 9);
    ctx.moveTo(11, -9); ctx.lineTo(-11, 9);
    ctx.stroke();
  }

  // ------------------------------------------------------------------ render
  const MONO = '13px ui-monospace, "SF Mono", Menlo, Consolas, monospace';
  const MONO_BOLD = '700 13px ui-monospace, "SF Mono", Menlo, Consolas, monospace';

  const THEMES = {
    dark: {
      icon: '#8fd4ff', trail: '#57b8ff', leader: '#3d5a74',
      blockBg: 'rgba(12,24,38,0.92)', blockEdge: '#2c465e',
      amber: '#ffd166', amberEdge: '#c9962e', amberBg: 'rgba(26,20,8,0.94)',
      mil: '#ff6a55', milEdge: '#c94a38', milBg: 'rgba(30,10,8,0.93)',
      dim: '#6c7f93',
      ring: '#2b5c52', ringText: '#3f7a6e', home: '#e8f0f7',
      textNormal: ['#7fd4ff', '#d6e6f5', '#f0c674', '#93a7bc'],
      textOverhead: ['#ffd166', '#f3e3bd', '#f0c674', '#bfae87'],
      textMil: ['#ff9c8c', '#f3d6d0', '#f0b3a6', '#c09a92'],
      tagText: '#140f04',
      chartMuted: '#5a6c7e',
    },
    light: {
      icon: '#1273b8', trail: '#2a7fc0', leader: '#7d94a8',
      blockBg: 'rgba(252,254,255,0.93)', blockEdge: '#a8bccc',
      amber: '#a86e08', amberEdge: '#c9962e', amberBg: 'rgba(255,248,230,0.95)',
      mil: '#c0342a', milEdge: '#c0342a', milBg: 'rgba(255,238,235,0.95)',
      dim: '#8fa0ae',
      ring: '#3f8a77', ringText: '#2e6b5f', home: '#16222e',
      textNormal: ['#0b5f96', '#22303c', '#8a6210', '#4c5c68'],
      textOverhead: ['#7a5a06', '#4c3c10', '#8a6210', '#6b5a30'],
      textMil: ['#a02418', '#4c2018', '#8a3a2c', '#7a544e'],
      tagText: '#fdf8ef',
      chartMuted: '#7a8a99',
    },
  };
  let COLORS = THEMES.dark;

  const themeToggle = document.getElementById('theme-toggle');
  function applyTheme(name) {
    COLORS = THEMES[name] || THEMES.dark;
    document.body.classList.toggle('light', name === 'light');
    tiles.setUrl(TILE_URLS[name] || TILE_URLS.dark);
    themeToggle.textContent = name === 'light' ? '☀' : '☾';
    localStorage.setItem('overhead-theme', name);
  }
  themeToggle.addEventListener('click', () => {
    applyTheme(document.body.classList.contains('light') ? 'dark' : 'light');
  });
  applyTheme(localStorage.getItem('overhead-theme') || 'dark');

  function fmtAlt(t) {
    if (t.fix.onGround) return 'GROUND';
    if (t.fix.alt == null) return 'ALT N/A';
    const arrow = t.fix.vr > 250 ? ' ↑' : t.fix.vr < -250 ? ' ↓' : ' →';
    return t.fix.alt.toLocaleString() + ' ft' + arrow;
  }

  function blockLines(t) {
    const m = t.meta;
    const id = m.callsign && m.reg && m.callsign !== m.reg
      ? `${m.callsign} · ${m.reg}`
      : (m.callsign || m.reg || m.hex.toUpperCase() + ' · —');
    const model = m.model ? (m.type ? `${m.type} ${m.model}` : m.model) : (m.type || 'Type n/a');
    const op = m.operator || (m.model ? '—' : 'blocked / n/a');
    const state = `${fmtAlt(t)} · ${Math.round(t.fix.gs)} kt`;
    return [id, model, op, state];
  }

  function drawBlock(x, y, side, lines, opts) {
    const { overhead, dimmed, mil, alpha = 1 } = opts;
    ctx.font = MONO;
    const padX = 12, lineH = 19, padTop = 8;
    let w = 0;
    for (const s of lines) w = Math.max(w, ctx.measureText(s).width);
    w += padX * 2;
    const tagged = overhead || mil;
    const tagH = tagged ? 20 : 0;
    const h = padTop * 2 + lineH * lines.length + tagH - 4;

    const bx = side === 'right' ? x + 26 : x - 26 - w;
    const by = y - h / 2;

    const edge = mil ? COLORS.milEdge : overhead ? COLORS.amberEdge : COLORS.blockEdge;
    const bg = mil ? COLORS.milBg : overhead ? COLORS.amberBg : COLORS.blockBg;

    ctx.globalAlpha = alpha * (dimmed ? 0.55 : 1);

    // leader line to nearest block corner
    ctx.strokeStyle = tagged ? edge : COLORS.leader;
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(x + (side === 'right' ? 12 : -12), y);
    ctx.lineTo(side === 'right' ? bx : bx + w, by + h / 2);
    ctx.stroke();

    ctx.fillStyle = bg;
    ctx.strokeStyle = edge;
    ctx.lineWidth = tagged ? 1.4 : 1;
    ctx.beginPath();
    ctx.roundRect(bx, by, w, h, 3);
    ctx.fill();
    ctx.stroke();

    let ty = by + padTop;
    if (tagged) {
      ctx.fillStyle = edge;
      ctx.beginPath();
      ctx.roundRect(bx, by, w, 20, [3, 3, 0, 0]);
      ctx.fill();
      ctx.fillStyle = COLORS.tagText;
      ctx.font = '700 11px ui-monospace, "SF Mono", Menlo, monospace';
      ctx.textBaseline = 'middle';
      const tag = mil && overhead ? 'M I L · O V E R H E A D' : mil ? 'M I L I T A R Y' : 'O V E R H E A D';
      ctx.fillText(tag, bx + padX, by + 10.5);
      ty += tagH;
    }

    const palette = mil ? COLORS.textMil : overhead ? COLORS.textOverhead : COLORS.textNormal;
    ctx.textBaseline = 'top';
    lines.forEach((s, i) => {
      ctx.font = i === 0 ? MONO_BOLD : MONO;
      ctx.fillStyle = dimmed ? COLORS.dim : palette[i];
      ctx.fillText(s, bx + padX, ty + 2);
      ty += lineH;
    });
    ctx.globalAlpha = 1;
  }

  function drawRings() {
    const homePt = map.latLngToContainerPoint(HOME);
    for (const rNm of config.rings_nm || []) {
      const edge = map.latLngToContainerPoint(project(HOME[0], HOME[1], 0, rNm));
      const rPx = Math.hypot(edge.x - homePt.x, edge.y - homePt.y);
      ctx.strokeStyle = COLORS.ring;
      ctx.setLineDash([5, 7]);
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.arc(homePt.x, homePt.y, rPx, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = COLORS.ringText;
      ctx.font = '12px ui-monospace, "SF Mono", Menlo, monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      ctx.fillText(`${rNm} NM`, homePt.x, homePt.y - rPx - 5);
      ctx.textAlign = 'left';
    }
    // outer limit of feed coverage: 50 mi around home
    {
      const edge = map.latLngToContainerPoint(project(HOME[0], HOME[1], 0, MAX_VIEW_MI * NM_PER_MI));
      const rPx = Math.hypot(edge.x - homePt.x, edge.y - homePt.y);
      ctx.strokeStyle = COLORS.ring;
      ctx.globalAlpha = 0.6;
      ctx.setLineDash([2, 10]);
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.arc(homePt.x, homePt.y, rPx, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = COLORS.ringText;
      ctx.font = '12px ui-monospace, "SF Mono", Menlo, monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      ctx.fillText(`${MAX_VIEW_MI} MI COVERAGE LIMIT`, homePt.x, homePt.y - rPx - 5);
      ctx.textAlign = 'left';
      ctx.globalAlpha = 1;
    }
    // home marker
    ctx.fillStyle = COLORS.home;
    ctx.save();
    ctx.translate(homePt.x, homePt.y);
    ctx.beginPath();
    ctx.moveTo(0, -9); ctx.lineTo(8, -1); ctx.lineTo(5, -1); ctx.lineTo(5, 7);
    ctx.lineTo(-5, 7); ctx.lineTo(-5, -1); ctx.lineTo(-8, -1);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  let lastFrame = performance.now();
  function frame(now) {
    const dtF = Math.min((now - lastFrame) / 1000, 0.25);
    lastFrame = now;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    drawRings();

    let overheadCount = 0;
    const homePt = map.latLngToContainerPoint(HOME);

    for (const t of targets.values()) {
      const f = t.fix;
      // dead-reckon from the fix, ease the shown position toward it
      const age = (Date.now() - f.at) / 1000;
      const [pLat, pLon] = f.gs > 1 && !f.onGround
        ? project(f.lat, f.lon, f.track, (f.gs * Math.min(age, 20)) / 3600)
        : [f.lat, f.lon];
      const k = 1 - Math.exp(-dtF * 2.2);
      t.shown.lat += (pLat - t.shown.lat) * k;
      t.shown.lon += (pLon - t.shown.lon) * k;
      t.shown.track += shortestArc(t.shown.track, f.track) * k;

      const pt = map.latLngToContainerPoint([t.shown.lat, t.shown.lon]);
      if (pt.x < -200 || pt.y < -200 || pt.x > canvas.clientWidth + 200 || pt.y > canvas.clientHeight + 200) continue;

      const dHome = distNm(HOME[0], HOME[1], t.shown.lat, t.shown.lon);
      const overhead = !f.onGround && dHome <= (config.overhead_nm || 5);
      if (overhead) overheadCount++;
      const dimmed = f.onGround;
      const mil = !!t.meta.mil;
      const nowMs = Date.now();

      // trail: purely time-based fade — fully gone at trail_fade_seconds (60 s)
      while (t.trail.length && nowMs - t.trail[0].at > TRAIL_FADE_MS) t.trail.shift();
      if (t.trail.length && !dimmed) {
        const base = mil ? COLORS.mil : overhead ? COLORS.amber : COLORS.trail;
        ctx.strokeStyle = base;
        ctx.lineWidth = 1.6;
        let prev = null;
        for (let i = 0; i <= t.trail.length; i++) {
          const p = i < t.trail.length
            ? t.trail[i]
            : { lat: t.shown.lat, lon: t.shown.lon, at: nowMs };
          const cp = map.latLngToContainerPoint([p.lat, p.lon]);
          if (prev) {
            const ageF = 1 - (nowMs - p.at) / TRAIL_FADE_MS;
            const a = Math.max(0, ageF) * 0.5;
            if (a > 0.02) {
              ctx.globalAlpha = a;
              ctx.beginPath();
              ctx.moveTo(prev.x, prev.y);
              ctx.lineTo(cp.x, cp.y);
              ctx.stroke();
            }
          }
          prev = cp;
        }
        ctx.globalAlpha = 1;
      }

      // icon — military is always red, wherever it is
      ctx.save();
      ctx.translate(pt.x, pt.y);
      ctx.fillStyle = ctx.strokeStyle =
        mil ? COLORS.mil : dimmed ? COLORS.dim : overhead ? COLORS.amber : COLORS.icon;
      ctx.rotate((t.shown.track * Math.PI) / 180);
      if (t.meta.heli) {
        drawHeli(ctx);
      } else {
        ctx.fill(PLANE);
      }
      ctx.restore();

      // Data block: at wide view (>10 mi) only overhead targets keep their
      // block, and aircraft on the ground or not moving never show one on
      // their own — anything hidden shows a block for 7 s after a click/tap.
      const stationary = f.gs < 3;
      let showBlock = !stationary && !f.onGround && (overhead || currentViewMiles <= DETAIL_VIEW_MI);
      let blockAlpha = 1;
      if (!showBlock && t.detailUntil) {
        const left = t.detailUntil - nowMs;
        if (left > 0) {
          showBlock = true;
          blockAlpha = Math.min(1, left / 600); // fade out over the last 0.6 s
        }
      }
      // List hover-isolate overrides everything: only the hovered aircraft
      // keeps its block while the pointer is on the list.
      if (focusedHex) {
        showBlock = t.meta.hex === focusedHex;
        blockAlpha = 1;
      }
      if (showBlock) {
        const side = pt.x < canvas.clientWidth / 2 ? 'right' : 'left';
        drawBlock(pt.x, pt.y, side, blockLines(t), { overhead, dimmed, mil, alpha: blockAlpha });
      }
    }

    updateBar(overheadCount);
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  // ------------------------------------------------------------- status bar
  const el = {
    clock: document.getElementById('clock'),
    count: document.getElementById('count'),
    overhead: document.getElementById('overhead-count'),
    dot: document.getElementById('feed-dot'),
    feed: document.getElementById('feed-name'),
  };
  function updateBar(overheadCount) {
    el.count.textContent = targets.size;
    el.overhead.textContent = overheadCount;
    const stale = Date.now() - feedState.lastOkAt;
    const cls = feedState.lastOkAt === 0 ? '' : stale < 10000 ? 'ok' : stale < 30000 ? 'warn' : 'bad';
    el.dot.className = 'dot ' + cls;
    document.getElementById('bar').classList.toggle('stalled', cls === 'warn' || cls === 'bad');
    el.feed.textContent = cls === 'bad' || cls === 'warn'
      ? `FEED STALE ${Math.round(stale / 1000)}s`
      : `FEED: ${feedState.source.toUpperCase()}`;
  }
  setInterval(() => {
    el.clock.textContent = new Date().toLocaleTimeString('en-US', { hour12: false });
  }, 250);
})();
