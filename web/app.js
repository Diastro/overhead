// Overhead display app: Leaflet dark basemap + one canvas overlay drawing all
// targets ATC-style. Positions are dead-reckoned every frame from the last fix
// so motion is continuous between 3-second feed updates.
'use strict';

(async function main() {
  const config = await (await fetch('/config')).json();
  const HOME = [config.home.lat, config.home.lon];

  // ------------------------------------------------------------------- map
  const map = L.map('map', {
    center: HOME,
    zoom: 11,
    zoomControl: false,
    attributionControl: true,
  });

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

  // ---------------------------------------------------------------- targets
  // hex -> { fix, shown: {lat, lon, track}, trail: [[lat,lon],...], meta, lastSeen }
  const targets = new Map();
  let feedState = { ok: false, source: '…', lastOkAt: 0 };

  const es = new EventSource('/events');
  es.onmessage = (e) => {
    const payload = JSON.parse(e.data);
    feedState.source = payload.source;
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
      if (!last || distNm(last[0], last[1], ac.lat, ac.lon) > 0.05) {
        t.trail.push([ac.lat, ac.lon]);
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

  function drawBlock(x, y, side, lines, overhead, dimmed) {
    ctx.font = MONO;
    const padX = 12, lineH = 19, padTop = 8;
    let w = 0;
    for (const s of lines) w = Math.max(w, ctx.measureText(s).width);
    w += padX * 2;
    const tagH = overhead ? 20 : 0;
    const h = padTop * 2 + lineH * lines.length + tagH - 4;

    const bx = side === 'right' ? x + 26 : x - 26 - w;
    const by = y - h / 2;

    // leader line to nearest block corner
    ctx.strokeStyle = overhead ? COLORS.amberEdge : COLORS.leader;
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(x + (side === 'right' ? 12 : -12), y);
    ctx.lineTo(side === 'right' ? bx : bx + w, by + h / 2);
    ctx.stroke();

    ctx.globalAlpha = dimmed ? 0.55 : 1;
    ctx.fillStyle = overhead ? COLORS.amberBg : COLORS.blockBg;
    ctx.strokeStyle = overhead ? COLORS.amberEdge : COLORS.blockEdge;
    ctx.lineWidth = overhead ? 1.4 : 1;
    ctx.beginPath();
    ctx.roundRect(bx, by, w, h, 3);
    ctx.fill();
    ctx.stroke();

    let ty = by + padTop;
    if (overhead) {
      ctx.fillStyle = COLORS.amberEdge;
      ctx.beginPath();
      ctx.roundRect(bx, by, w, 20, [3, 3, 0, 0]);
      ctx.fill();
      ctx.fillStyle = '#140f04';
      ctx.font = '700 11px ui-monospace, "SF Mono", Menlo, monospace';
      ctx.textBaseline = 'middle';
      ctx.fillText('O V E R H E A D', bx + padX, by + 10.5);
      ty += tagH;
    }

    const palette = overhead
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

      // trail
      if (t.trail.length > 1 && !dimmed) {
        ctx.strokeStyle = overhead ? COLORS.amber : COLORS.trail;
        ctx.globalAlpha = 0.35;
        ctx.lineWidth = 1.6;
        ctx.beginPath();
        t.trail.forEach((ll, i) => {
          const p = map.latLngToContainerPoint(ll);
          i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y);
        });
        ctx.lineTo(pt.x, pt.y);
        ctx.stroke();
        ctx.globalAlpha = 1;
      }

      // icon
      ctx.save();
      ctx.translate(pt.x, pt.y);
      ctx.fillStyle = ctx.strokeStyle = dimmed ? COLORS.dim : overhead ? COLORS.amber : COLORS.icon;
      if (t.meta.heli) {
        drawHeli(ctx);
      } else {
        ctx.rotate((t.shown.track * Math.PI) / 180);
        ctx.fill(PLANE);
      }
      ctx.restore();

      // data block on the side facing away from screen center
      const side = pt.x < canvas.clientWidth / 2 ? 'right' : 'left';
      drawBlock(pt.x, pt.y, side, blockLines(t), overhead, dimmed);
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
