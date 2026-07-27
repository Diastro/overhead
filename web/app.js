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
  const HOME = [config.home.lat, config.home.lon];

  // Shared constants — keep at the top: init code below runs immediately and
  // consts are not hoisted (a TDZ crash here bricks the whole app).
  const NM_PER_MI = 0.868976;
  const TRAIL_FADE_MS = (config.trail_fade_seconds ?? 30) * 1000;
  const TRAIL_FADE_NM = (config.trail_fade_miles ?? 2) * NM_PER_MI;
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

  L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
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
  function onViewChanged() {
    const b = map.getBounds();
    const c = map.getCenter();
    const east = b.getEast();
    const north = b.getNorth();
    const halfW = distNm(c.lat, c.lng, c.lat, east) / NM_PER_MI;
    const halfH = distNm(c.lat, c.lng, north, c.lng) / NM_PER_MI;
    currentViewMiles = Math.min(halfW, halfH);
    // farthest visible corner from home
    const corners = [
      [b.getNorth(), b.getEast()], [b.getNorth(), b.getWest()],
      [b.getSouth(), b.getEast()], [b.getSouth(), b.getWest()],
    ];
    const maxMi = Math.max(...corners.map(([la, lo]) => distNm(HOME[0], HOME[1], la, lo))) / NM_PER_MI;
    banner.classList.toggle('show', maxMi > MAX_VIEW_MI);
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
  function renderList() {
    if (!listPanel.classList.contains('open')) return;
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

  // Bandwidth used by the live feed (reported by the server per poll)
  const bwEl = document.getElementById('bw');
  let bwPrev = null;
  function updateBandwidth(feedBytes) {
    if (feedBytes == null) return;
    const now = Date.now();
    let rate = '';
    if (bwPrev && feedBytes > bwPrev.bytes) {
      const kbs = (feedBytes - bwPrev.bytes) / 1024 / ((now - bwPrev.at) / 1000);
      rate = ` · ${kbs.toFixed(1)} KB/s`;
    }
    bwPrev = { bytes: feedBytes, at: now };
    const mb = feedBytes / 1048576;
    bwEl.textContent = `FEED DATA: ${mb < 1 ? (feedBytes / 1024).toFixed(0) + ' KB' : mb.toFixed(1) + ' MB'}${rate}`;
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

  const COLORS = {
    icon: '#8fd4ff', trail: '#57b8ff', leader: '#3d5a74',
    blockBg: 'rgba(12,24,38,0.92)', blockEdge: '#2c465e',
    line1: '#7fd4ff', line2: '#d6e6f5', line3: '#f0c674', line4: '#93a7bc',
    amber: '#ffd166', amberEdge: '#c9962e', amberBg: 'rgba(26,20,8,0.94)',
    mil: '#ff6a55', milEdge: '#c94a38', milBg: 'rgba(30,10,8,0.93)',
    dim: '#6c7f93',
    ring: '#2b5c52', ringText: '#3f7a6e', home: '#e8f0f7',
  };

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
      ctx.fillStyle = '#140f04';
      ctx.font = '700 11px ui-monospace, "SF Mono", Menlo, monospace';
      ctx.textBaseline = 'middle';
      const tag = mil && overhead ? 'M I L · O V E R H E A D' : mil ? 'M I L I T A R Y' : 'O V E R H E A D';
      ctx.fillText(tag, bx + padX, by + 10.5);
      ty += tagH;
    }

    const palette = mil
      ? ['#ff9c8c', '#f3d6d0', '#f0b3a6', '#c09a92']
      : overhead
        ? [COLORS.amber, '#f3e3bd', COLORS.line3, '#bfae87']
        : [COLORS.line1, COLORS.line2, COLORS.line3, COLORS.line4];
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

      // trail: fades with age (30 s) and distance behind the aircraft (2 mi),
      // whichever limit bites first
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
            const distF = 1 - distNm(p.lat, p.lon, t.shown.lat, t.shown.lon) / TRAIL_FADE_NM;
            const a = Math.max(0, Math.min(ageF, distF)) * 0.5;
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
      if (t.meta.heli) {
        drawHeli(ctx);
      } else {
        ctx.rotate((t.shown.track * Math.PI) / 180);
        ctx.fill(PLANE);
      }
      ctx.restore();

      // Data block: at wide view (>10 mi) only overhead targets keep their
      // block, and aircraft that aren't moving never show one on their own —
      // anything hidden shows a block for 7 s after a click/tap.
      const stationary = f.gs < 3;
      let showBlock = !stationary && (overhead || currentViewMiles <= DETAIL_VIEW_MI);
      let blockAlpha = 1;
      if (!showBlock && t.detailUntil) {
        const left = t.detailUntil - nowMs;
        if (left > 0) {
          showBlock = true;
          blockAlpha = Math.min(1, left / 600); // fade out over the last 0.6 s
        }
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
    el.feed.textContent = cls === 'bad' || cls === 'warn'
      ? `FEED STALE ${Math.round(stale / 1000)}s`
      : `FEED: ${feedState.source.toUpperCase()}`;
  }
  setInterval(() => {
    el.clock.textContent = new Date().toLocaleTimeString('en-US', { hour12: false });
  }, 250);
})();
