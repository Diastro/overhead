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
  const usageSeed = await fetch('/usage').then((r) => r.json()).catch(() => null);

  // Home lives in the browser's storage; the server only holds it in memory.
  // On connect we adopt the stored home and re-assert it server-side.
  let HOME = [config.home.lat, config.home.lon];
  try {
    const storedHome = JSON.parse(localStorage.getItem('overhead-home'));
    if (storedHome && Number.isFinite(storedHome.lat) && Number.isFinite(storedHome.lon)) {
      HOME = [storedHome.lat, storedHome.lon];
      fetch('/home', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lat: HOME[0], lon: HOME[1] }),
      }).catch(() => {});
    } else {
      // first run: adopt whatever the server has (legacy local config or default)
      localStorage.setItem('overhead-home', JSON.stringify({ lat: HOME[0], lon: HOME[1] }));
    }
  } catch { /* keep server default */ }

  // Shared constants — keep at the top: init code below runs immediately and
  // consts are not hoisted (a TDZ crash here bricks the whole app).
  const NM_PER_MI = 0.868976;
  const REDUCED_MOTION = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  // Embedded in the edge-loader kiosk shell: the shell draws the chrome, so
  // this app hides its own header and takes commands over postMessage.
  const EMBED = new URLSearchParams(location.search).get('embed') === '1';
  const TRAIL_FADE_MS = (config.trail_fade_seconds ?? 60) * 1000;
  const DETAIL_MS = (config.detail_click_seconds ?? 7) * 1000;
  const MAX_VIEW_MI = 100;
  const OVERHEAD_MAX_FT = config.overhead_max_ft ?? 18000;
  const PROJECT_CAP_S = 60; // must exceed LOW mode's 45 s full-sweep interval

  // ------------------------------------------------------------------- map
  const map = L.map('map', {
    center: HOME,
    zoom: 11,
    zoomControl: false,
    attributionControl: true,
    // continuous zoom so the view slider changes scale per mile — integer
    // snapping collapses ~10 mile values onto one zoom level
    zoomSnap: 0,
    zoomDelta: 1, // keyboard/buttons step a full level
    // Leaflet's wheel handler animates a discrete step per notch, which queues
    // and feels laggy — replaced below with a smooth glide toward a target.
    scrollWheelZoom: false,
  });

  // Smooth scroll zoom: accumulate wheel input into a target zoom and ease
  // toward it every frame, anchored at the cursor.
  const mapEl = document.getElementById('map');
  let wheelTarget = null;
  let wheelAnchor = null;
  let wheelRaf = null;
  function wheelStep() {
    wheelRaf = null;
    const cur = map.getZoom();
    const diff = wheelTarget - cur;
    if (Math.abs(diff) < 0.01) {
      map.setZoomAround(wheelAnchor, wheelTarget, { animate: false });
      wheelTarget = null;
      return;
    }
    map.setZoomAround(wheelAnchor, cur + diff * 0.3, { animate: false });
    wheelRaf = requestAnimationFrame(wheelStep);
  }
  mapEl.addEventListener('wheel', (e) => {
    e.preventDefault();
    const dy = e.deltaMode === 1 ? e.deltaY * 20 : e.deltaY; // line-mode wheels
    wheelTarget = Math.max(map.getMinZoom(), Math.min(map.getMaxZoom(),
      (wheelTarget ?? map.getZoom()) - dy * 0.0035));
    wheelAnchor = map.mouseEventToContainerPoint(e);
    if (!wheelRaf) wheelRaf = requestAnimationFrame(wheelStep);
  }, { passive: false });

  const TILE_URLS = {
    dark: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
    light: 'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png',
  };
  const TILE_OPTS = {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>',
    subdomains: 'abcd',
    maxZoom: 19,
  };
  let tiles = L.tileLayer(TILE_URLS.dark, TILE_OPTS).addTo(map);
  let tilesUrl = TILE_URLS.dark;
  // Swap by replacing the layer: setUrl() at fractional zoom (zoomSnap 0.1)
  // leaves the redrawn tiles untransformed — invisible until the map moves.
  function setTiles(url) {
    if (url === tilesUrl) return;
    tilesUrl = url;
    const old = tiles;
    tiles = L.tileLayer(url, TILE_OPTS).addTo(map);
    setTimeout(() => old.remove(), 400); // let the new layer paint first
  }

  if (EMBED) document.body.classList.add('embed');

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
  // Project a fix forward: follows the aircraft's estimated turn arc and
  // speed trend (midpoint approximation) rather than a straight line.
  function projectState(f, age) {
    if (!(f.gs > 1) || f.onGround) return [f.lat, f.lon];
    const a = Math.min(age, PROJECT_CAP_S);
    const gsAvg = Math.max(0, f.gs + ((f.accel || 0) * a) / 2);
    const hdg = f.track + ((f.turnRate || 0) * a) / 2;
    return project(f.lat, f.lon, hdg, (gsAvg * a) / 3600);
  }

  // View-range slider (top right): fits the map so ~N statute miles are visible
  // around home. 1 mi = 0.868976 nm.
  const rangeInput = document.getElementById('range');
  const rangeVal = document.getElementById('range-val');
  const vm = config.view_miles || { min: 4, max: 40, default: 15 };
  rangeInput.min = vm.min;
  rangeInput.max = vm.max;
  const savedMiles = Number(localStorage.getItem('overhead-view-miles'));
  rangeInput.value = savedMiles >= vm.min && savedMiles <= vm.max ? savedMiles : vm.default;
  function applyRange(miles, animate = true) {
    rangeVal.textContent = miles;
    const nm = miles * 0.868976;
    const north = project(HOME[0], HOME[1], 0, nm);
    const south = project(HOME[0], HOME[1], 180, nm);
    const east = project(HOME[0], HOME[1], 90, nm);
    const west = project(HOME[0], HOME[1], 270, nm);
    map.fitBounds(L.latLngBounds([north, south, east, west]), { animate });
  }
  // While dragging, redraw instantly at every mile step — no animation queue.
  // The zoom→slider sync pauses during a drag so it can't fight the thumb.
  let draggingRange = false;
  rangeInput.addEventListener('pointerdown', () => { draggingRange = true; });
  window.addEventListener('pointerup', () => { draggingRange = false; });
  rangeInput.addEventListener('input', () => {
    localStorage.setItem('overhead-view-miles', rangeInput.value);
    applyRange(Number(rangeInput.value), false);
  });
  applyRange(Number(rangeInput.value));

  // Effective view radius in miles (tracks slider AND manual pan/zoom) and the
  // too-wide banner: the feed only covers MAX_VIEW_MI around home.
  let currentViewMiles = vm.default;
  let suppressRangeSync = false; // set during scripted zooms (military fly-by)
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

    // Keep the top-right slider in sync with mouse-wheel/pinch zoom: the
    // label shows the true view miles, the thumb clamps to slider range.
    if (!suppressRangeSync && !draggingRange) {
      const trueMi = Math.round(currentViewMiles);
      const clamped = Math.max(vm.min, Math.min(vm.max, trueMi));
      if (Number(rangeInput.value) !== clamped) {
        rangeInput.value = clamped;
        localStorage.setItem('overhead-view-miles', String(clamped));
      }
      rangeVal.textContent = trueMi;
    }

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
      lastDesiredView = desired;
      fetch('/view', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(desired),
      }).catch(() => { lastSentView = undefined; });
    }, 500);
  }
  map.on('zoomend moveend resize', onViewChanged);
  onViewChanged();

  // Re-assert an active view region every 2 min — the server expires regions
  // after 5 min so a vanished browser can't leave it double-polling forever.
  let lastDesiredView = null;
  setInterval(() => {
    if (lastDesiredView) {
      fetch('/view', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(lastDesiredView),
      }).catch(() => {});
    }
  }, 120000);

  // Click/tap an aircraft to show its data block for a few seconds. On a
  // touch display there is no hover, so a tap that misses every aircraft
  // falls through to the airport markers and shows their info card instead.
  let airportTap = null; // { a, until }
  map.on('click', (e) => {
    let best = null;
    let bestD = 30; // px hit radius
    for (const t of targets.values()) {
      const p = map.latLngToContainerPoint([t.shown.lat, t.shown.lon]);
      const d = Math.hypot(p.x - e.containerPoint.x, p.y - e.containerPoint.y);
      if (d < bestD) { bestD = d; best = t; }
    }
    if (best) { best.detailUntil = Date.now() + DETAIL_MS; return; }
    airportTap = null;
    if (layers.airports) {
      const showSmall = currentViewMiles <= 20;
      let aD = 24;
      for (const a of airports) {
        if (a.type === 'small_airport' && !showSmall) continue;
        const p = map.latLngToContainerPoint([a.lat, a.lon]);
        const d = Math.hypot(p.x - e.containerPoint.x, p.y - e.containerPoint.y);
        if (d < aD) { aD = d; airportTap = { a, until: Date.now() + DETAIL_MS }; }
      }
    }
  });

  // Hovering on/near an aircraft shows its block; it hides on hover-away
  // unless clicked (the 7 s click rule is unchanged).
  let hoveredHex = null;
  let hoveredAirport = null;
  map.on('mousemove', (e) => {
    let best = null;
    let bestD = 26; // px hover radius
    for (const t of targets.values()) {
      const p = map.latLngToContainerPoint([t.shown.lat, t.shown.lon]);
      const d = Math.hypot(p.x - e.containerPoint.x, p.y - e.containerPoint.y);
      if (d < bestD) { bestD = d; best = t; }
    }
    hoveredHex = best ? best.meta.hex : null;
    // Airports second — an aircraft over the field wins the hover. Only match
    // markers actually drawn (small fields hide beyond the 20 mi view).
    hoveredAirport = null;
    if (!best && layers.airports) {
      const showSmall = currentViewMiles <= 20;
      let aD = 18;
      for (const a of airports) {
        if (a.type === 'small_airport' && !showSmall) continue;
        const p = map.latLngToContainerPoint([a.lat, a.lon]);
        const d = Math.hypot(p.x - e.containerPoint.x, p.y - e.containerPoint.y);
        if (d < aD) { aD = d; hoveredAirport = a; }
      }
    }
    mapEl.style.cursor = best || hoveredAirport ? 'pointer' : '';
  });
  map.on('mouseout', () => {
    hoveredHex = null;
    hoveredAirport = null;
    mapEl.style.cursor = '';
  });

  // Military fly-by: when a military aircraft newly appears inside coverage,
  // zoom to ~3 mi around it for 15 s, then return to the home view. At most
  // one such zoom per minute.
  const milZoom = { lastAt: 0, active: false };
  const milAlerted = new Map(); // hex -> last zoom time: a patrolling aircraft
  // flickering at coverage edge must not re-yank the display every minute
  function maybeMilZoom(ac) {
    const now = Date.now();
    if (document.hidden) return; // rAF is frozen — flyTo would strand mid-flight
    if (milZoom.active || now - milZoom.lastAt < 60000) return;
    if ((milAlerted.get(ac.hex) || 0) > now - 1800000) return; // 30 min per airframe
    if (distNm(HOME[0], HOME[1], ac.lat, ac.lon) > MAX_VIEW_MI * NM_PER_MI) return;
    milZoom.active = true;
    milZoom.lastAt = now;
    milAlerted.set(ac.hex, now);
    const returnMiles = Number(rangeInput.value); // view to restore afterwards
    suppressRangeSync = true;
    const nm = 3 * NM_PER_MI;
    map.flyToBounds(L.latLngBounds([
      project(ac.lat, ac.lon, 0, nm), project(ac.lat, ac.lon, 180, nm),
      project(ac.lat, ac.lon, 90, nm), project(ac.lat, ac.lon, 270, nm),
    ]), { duration: 1.6 });
    setTimeout(() => {
      rangeInput.value = returnMiles;
      applyRange(returnMiles); // back to the home view
      suppressRangeSync = false;
      milZoom.active = false;
    }, 15000);
  }

  // Data-block mode: OVERHEAD (default — full blocks only near home when
  // zoomed out) vs ALL (every airborne aircraft carries its block).
  const dataToggle = document.getElementById('data-toggle');
  let dataMode = localStorage.getItem('overhead-data-mode') === 'all' ? 'all' : 'auto';
  function renderDataToggle() {
    dataToggle.textContent = dataMode === 'all' ? '▤ DATA: ALL' : '▤ DATA: OVERHEAD';
    dataToggle.classList.toggle('open', dataMode === 'all');
  }
  dataToggle.addEventListener('click', () => {
    dataMode = dataMode === 'all' ? 'auto' : 'all';
    localStorage.setItem('overhead-data-mode', dataMode);
    renderDataToggle();
  });
  renderDataToggle();

  // Layer visibility (bottom-right ◧ LAYERS panel), persisted per browser
  const layersToggle = document.getElementById('layers-toggle');
  const layersPanel = document.getElementById('layers-panel');
  const LAYER_DEFAULTS = { aircraft: true, trails: true, blocks: true, airports: false, airspace: false, rings: true, scale: true };
  let layers = { ...LAYER_DEFAULTS };
  try {
    layers = { ...LAYER_DEFAULTS, ...JSON.parse(localStorage.getItem('overhead-layers') || '{}') };
  } catch { /* defaults */ }
  if (localStorage.getItem('overhead-airports') === '1') layers.airports = true; // migrate old key

  let airports = [];
  async function loadAirports() {
    try {
      const r = await fetch(`/airports?lat=${HOME[0]}&lon=${HOME[1]}&radius_nm=${config.radius_nm || 43}`);
      if (r.ok) airports = (await r.json()).airports || [];
    } catch { /* markers just stay absent */ }
  }

  // Airspace outlines: FAA Class B/C/D polygons drawn in sectional-chart
  // conventions — solid blue B, solid magenta C, dashed blue D. US-only data.
  let airspaceLayer = null;
  const AIRSPACE_STYLE = {
    B: { color: '#4a8fd4', dash: null },
    C: { color: '#b45fae', dash: null },
    D: { color: '#4a8fd4', dash: '6 5' },
  };
  async function loadAirspace() {
    try {
      const r = await fetch(`/airspace?lat=${HOME[0]}&lon=${HOME[1]}&radius_nm=${config.radius_nm || 43}`);
      if (!r.ok) return;
      const g = await r.json();
      if (airspaceLayer) map.removeLayer(airspaceLayer);
      airspaceLayer = L.geoJSON(g, {
        style: (f) => {
          const s = AIRSPACE_STYLE[f.properties?.CLASS] || { color: '#7a8a99', dash: '3 5' };
          return { color: s.color, weight: 1.3, dashArray: s.dash, fill: false, opacity: 0.75 };
        },
      });
      if (layers.airspace) airspaceLayer.addTo(map);
    } catch { /* outlines just stay absent */ }
  }

  const layerBoxes = [...layersPanel.querySelectorAll('input')];
  // Single entry point for layer changes: the checkboxes call it, and so does
  // the kiosk shell's overlay (see the message handler at the bottom).
  function setLayer(name, on) {
    const next = on === undefined ? !layers[name] : !!on;
    layers[name] = next;
    const box = layerBoxes.find((b) => b.dataset.layer === name);
    if (box) box.checked = next;
    localStorage.setItem('overhead-layers', JSON.stringify(layers));
    if (name === 'airports' && next && !airports.length) loadAirports();
    if (name === 'airspace') {
      if (next) {
        if (airspaceLayer) airspaceLayer.addTo(map);
        else loadAirspace();
      } else if (airspaceLayer) {
        map.removeLayer(airspaceLayer);
      }
    }
  }
  layerBoxes.forEach((box) => {
    box.checked = !!layers[box.dataset.layer];
    box.addEventListener('change', () => setLayer(box.dataset.layer, box.checked));
  });
  layersToggle.addEventListener('click', () => {
    const open = layersPanel.classList.toggle('open');
    layersToggle.classList.toggle('open', open);
    localStorage.setItem('overhead-panel-layers', open ? '1' : '0');
  });
  if (localStorage.getItem('overhead-panel-layers') === '1') {
    layersPanel.classList.add('open');
    layersToggle.classList.add('open');
  }
  if (layers.airports) loadAirports();
  if (layers.airspace) loadAirspace();

  // Collapsible list of aircraft currently inside the visible map area
  const listToggle = document.getElementById('list-toggle');
  const listPanel = document.getElementById('list-panel');
  const listEl = document.getElementById('ac-list');
  listToggle.addEventListener('click', () => {
    const open = listPanel.classList.toggle('open');
    listToggle.classList.toggle('open', open);
    localStorage.setItem('overhead-panel-list', open ? '1' : '0');
    if (open) renderList();
  });
  if (localStorage.getItem('overhead-panel-list') === '1') {
    listPanel.classList.add('open');
    listToggle.classList.add('open');
  }

  // Ground traffic is off the list by default — taxiing/parked aircraft at a
  // big airport would swamp the nearest rows. The map still draws them grey.
  const groundToggle = document.getElementById('ground-toggle');
  let listGround = localStorage.getItem('overhead-list-ground') === '1';
  groundToggle.checked = listGround;
  groundToggle.addEventListener('change', () => {
    listGround = groundToggle.checked;
    localStorage.setItem('overhead-list-ground', listGround ? '1' : '0');
    renderList(true);
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

  function renderList(force) {
    if (!listPanel.classList.contains('open')) return;
    // keep rows stable under the cursor — except when the ground toggle just
    // changed (the pointer is necessarily inside the panel then)
    if (listHovered && !force) return;
    const bounds = map.getBounds();
    const rows = [];
    for (const t of targets.values()) {
      if (!listGround && t.fix.onGround) continue;
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
      else if (m.police) li.classList.add('police');
      else if (t.fix.onGround) li.classList.add('ground'); // grey, like the map
      else if (d <= (config.overhead_nm || 5)) li.classList.add('overhead');
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
      b.addEventListener('click', () => {
        applyHome(entry.lat, entry.lon, entry.label).catch((err) => {
          homeMsg.textContent = String(err.message || err).toUpperCase();
        });
      });
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
    localStorage.setItem('overhead-home', JSON.stringify({ lat, lon, label }));
    targets.clear(); // old area's aircraft vanish; next poll brings the new sky
    airports = [];
    if (layers.airports) loadAirports();
    if (airspaceLayer) {
      map.removeLayer(airspaceLayer);
      airspaceLayer = null;
    }
    if (layers.airspace) loadAirspace();
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
  const bwLabel = document.getElementById('bw-label');
  let nextScan = null; // epoch ms of the next scheduled feed scan
  const bwChart = document.getElementById('bw-chart');
  const bwCanvas = document.getElementById('bw-canvas');
  const bwCtx = bwCanvas.getContext('2d');
  const bwCur = document.getElementById('bw-cur');
  const bwHistory = []; // {at, kbs}
  let bwPrev = null;
  let bwHover = null; // hovered sample index or null

  // Settings panel always starts closed — open state is not persisted
  bwEl.addEventListener('click', () => {
    bwChart.classList.toggle('open');
    drawBwChart();
    drawBwBars();
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

  const bwStats = document.getElementById('bw-stats');
  const bwMinCanvas = document.getElementById('bw-min-canvas');
  const bwMinCtx = bwMinCanvas.getContext('2d');
  const bwMinPeak = document.getElementById('bw-min-peak');
  const bwMinutes = []; // {min: epoch-minute, bytes}
  if (usageSeed && Array.isArray(usageSeed.minutes)) {
    bwMinutes.push(...usageSeed.minutes.slice(-31)); // survive reload/restart
  }

  // Three-way bandwidth mode control
  const bwModeBtns = [...document.querySelectorAll('#bwmode-row .seg button')];
  const bwModeNote = document.getElementById('bwmode-note');
  const BW_NOTES = {
    high: 'Full 50 mi area polled every 3 s',
    medium: 'Inner 10 nm ~6 s · full sweep every 15 s (~70% less data)',
    low: 'Inner 10 nm ~12 s · full sweep every 45 s (~90% less data)',
  };
  let bwMode = 'high';
  function renderBwMode() {
    bwModeBtns.forEach((b) => b.classList.toggle('active', b.dataset.mode === bwMode));
    bwModeNote.textContent = BW_NOTES[bwMode];
  }
  function postBwMode(mode) {
    return fetch('/bwmode', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode }),
    });
  }
  bwModeBtns.forEach((b) => b.addEventListener('click', () => {
    const prev = bwMode;
    bwMode = b.dataset.mode;
    localStorage.setItem('overhead-bwmode', bwMode);
    renderBwMode();
    postBwMode(bwMode).catch(() => { bwMode = prev; renderBwMode(); });
  }));
  // Browser storage owns the mode; re-assert it on connect (server holds it
  // in memory only).
  {
    const stored = localStorage.getItem('overhead-bwmode');
    if (stored && BW_NOTES[stored]) {
      bwMode = stored;
      postBwMode(stored).catch(() => {});
    }
  }
  renderBwMode();

  function hexA(hex, a) {
    const n = parseInt(hex.slice(1), 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
  }
  function lerpHex(h1, h2, t) {
    const a = parseInt(h1.slice(1), 16);
    const b = parseInt(h2.slice(1), 16);
    const ch = (sh) => Math.round(((a >> sh) & 255) + (((b >> sh) & 255) - ((a >> sh) & 255)) * t);
    return `rgb(${ch(16)},${ch(8)},${ch(0)})`;
  }

  function fmtBytes(b) {
    if (b >= 1073741824) return (b / 1073741824).toFixed(2) + ' GB';
    if (b >= 1048576) return (b / 1048576).toFixed(1) + ' MB';
    return (b / 1024).toFixed(0) + ' KB';
  }

  function updateBandwidth(payload) {
    if (payload.nextScanAt) nextScan = payload.nextScanAt;
    const feedBytes = payload.feedBytes;
    if (feedBytes == null) return;
    if (payload.bandwidthMode && payload.bandwidthMode !== bwMode) {
      bwMode = payload.bandwidthMode; // server is authoritative (persisted setting)
      renderBwMode();
    }
    const now = Date.now();
    let rate = '';
    if (bwPrev && feedBytes > bwPrev.bytes) {
      const delta = feedBytes - bwPrev.bytes;
      const kbs = delta / 1024 / ((now - bwPrev.at) / 1000);
      rate = ` · ${kbs.toFixed(1)} KB/s`;
      bwHistory.push({ at: now, kbs });
      while (bwHistory.length && now - bwHistory[0].at > 60000) bwHistory.shift();
      const mn = Math.floor(now / 60000);
      const last = bwMinutes[bwMinutes.length - 1];
      if (last && last.min === mn) last.bytes += delta;
      else bwMinutes.push({ min: mn, bytes: delta });
      while (bwMinutes.length > 31) bwMinutes.shift();
    }
    bwPrev = { bytes: feedBytes, at: now };
    bwLabel.textContent = `⚙ SETTINGS · ${fmtBytes(feedBytes)}${rate}`;

    if (bwChart.classList.contains('open')) {
      const elapsed = payload.startedAt ? (now - payload.startedAt) / 1000 : null;
      const avg = elapsed && elapsed > 30 ? feedBytes / elapsed : null;
      bwStats.replaceChildren(
        statRow('SESSION', `${fmtBytes(feedBytes)}${avg ? ` · avg ${(avg / 1024).toFixed(1)} KB/s` : ''}`),
        statRow('TODAY', fmtBytes(payload.todayBytes ?? 0)),
        statRow('ALL-TIME', fmtBytes(payload.totalBytes ?? feedBytes)),
        statRow('EST / DAY', avg ? fmtBytes(avg * 86400) : 'measuring…'),
        statRow('MODE', bwMode.toUpperCase()),
      );
    }
    drawBwChart();
    drawBwBars();
  }
  function statRow(k, v) {
    const d = document.createElement('div');
    const b = document.createElement('b');
    b.textContent = v;
    d.append(k + ': ', b);
    return d;
  }

  // Per-minute bars, last 30 minutes
  function drawBwBars() {
    if (!bwChart.classList.contains('open') || !bwMinutes.length) return;
    const dpr = window.devicePixelRatio || 1;
    const W = 306, H = 56;
    if (bwMinCanvas.width !== W * dpr) {
      bwMinCanvas.width = W * dpr;
      bwMinCanvas.height = H * dpr;
      bwMinCanvas.style.width = W + 'px';
      bwMinCanvas.style.height = H + 'px';
    }
    bwMinCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    bwMinCtx.clearRect(0, 0, W, H);
    const nowMin = Math.floor(Date.now() / 60000);
    const byMin = new Map(bwMinutes.map((m) => [m.min, m.bytes]));
    const max = Math.max(1, ...bwMinutes.map((m) => m.bytes));
    const slot = W / 30;
    for (let i = 0; i < 30; i++) {
      const mn = nowMin - 29 + i;
      const bytes = byMin.get(mn) || 0;
      if (!bytes) continue;
      const t = bytes / max;
      const h = Math.max(2, t * (H - 6));
      bwMinCtx.globalAlpha = mn === nowMin ? 0.55 : 0.95; // current minute is partial
      // sequential ramp by magnitude; the peak minute gets the accent gold
      bwMinCtx.fillStyle = bytes === max && mn !== nowMin
        ? COLORS.chartPeak
        : lerpHex(COLORS.chartLow, COLORS.chartHigh, t);
      bwMinCtx.beginPath();
      bwMinCtx.roundRect(i * slot + 1, H - h, slot - 2, h, 2);
      bwMinCtx.fill();
    }
    bwMinCtx.globalAlpha = 1;
    bwMinPeak.textContent = `PEAK ${fmtBytes(max)}/min`;
  }

  function drawBwChart() {
    if (!bwChart.classList.contains('open')) return;
    const dpr = window.devicePixelRatio || 1;
    const W = 306, H = 84;
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
      // gradient area + 2px line, endpoint emphasized
      bwCtx.beginPath();
      bwHistory.forEach((s, i) => {
        i === 0 ? bwCtx.moveTo(x(s.at), y(s.kbs)) : bwCtx.lineTo(x(s.at), y(s.kbs));
      });
      const lastPt = bwHistory[bwHistory.length - 1];
      bwCtx.strokeStyle = COLORS.chartHigh;
      bwCtx.lineWidth = 2;
      bwCtx.stroke();
      bwCtx.lineTo(x(lastPt.at), H - padB);
      bwCtx.lineTo(x(bwHistory[0].at), H - padB);
      bwCtx.closePath();
      const grad = bwCtx.createLinearGradient(0, padT, 0, H - padB);
      grad.addColorStop(0, hexA(COLORS.chartHigh, 0.4));
      grad.addColorStop(1, hexA(COLORS.chartLow, 0.05));
      bwCtx.fillStyle = grad;
      bwCtx.fill();
      const dot = bwHover != null ? bwHistory[bwHover] : lastPt;
      bwCtx.beginPath();
      bwCtx.arc(x(dot.at), y(dot.kbs), 3.5, 0, Math.PI * 2);
      bwCtx.fillStyle = bwHover != null ? COLORS.chartPeak : COLORS.chartHigh;
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
  let milSeeded = false; // first snapshot's military targets must not auto-zoom

  // The stream is opened through a function so an embedded copy can drop the
  // connection while it is off screen and pick it up again on return.
  let es = null;
  function connectFeed() {
    if (es) return;
    es = new EventSource('/events');
    es.onmessage = onFeedMessage;
  }
  function disconnectFeed() {
    if (!es) return;
    es.close();
    es = null;
  }
  function onFeedMessage(e) {
    const payload = JSON.parse(e.data);
    feedState.source = payload.source;
    updateBandwidth(payload);
    if (!payload.ok || !payload.aircraft) { feedState.ok = false; return; }
    feedState.ok = true;
    feedState.lastOkAt = Date.now();

    const seen = new Set();
    let milCandidate = null;
    for (const ac of payload.aircraft) {
      seen.add(ac.hex);
      const existing = targets.get(ac.hex);
      if (ac.mil && !(existing && existing.meta && existing.meta.mil) && !milCandidate) {
        milCandidate = ac; // newly appeared military target
      }
      const fix = {
        lat: ac.lat, lon: ac.lon,
        gs: ac.gs || 0,
        track: ac.track ?? 0,
        alt: ac.alt, vr: ac.vr, onGround: ac.onGround,
        at: Date.now() - (ac.seenPos ? ac.seenPos * 1000 : 0),
        turnRate: 0, accel: 0,
      };
      const prevFix = existing && existing.fix;
      const samePos = prevFix && prevFix.lat === fix.lat && prevFix.lon === fix.lon;
      if (samePos) {
        // Rebroadcast of a cached fix (low-bw outer targets): keep the original
        // clock and kinematics so extrapolation continues instead of restarting.
        fix.at = Math.min(prevFix.at, fix.at);
        fix.turnRate = prevFix.turnRate;
        fix.accel = prevFix.accel;
      } else if (prevFix) {
        // Estimate turn rate and acceleration from successive fixes so the
        // projection follows arcs and speed changes, not straight lines.
        const dtFix = (fix.at - prevFix.at) / 1000;
        if (dtFix > 1.5 && dtFix < 60) {
          fix.turnRate = Math.max(-6, Math.min(6, shortestArc(prevFix.track, fix.track) / dtFix));
          fix.accel = Math.max(-3, Math.min(3, (fix.gs - prevFix.gs) / dtFix));
        } else {
          fix.turnRate = prevFix.turnRate;
          fix.accel = prevFix.accel;
        }
      }
      let t = targets.get(ac.hex);
      if (!t) {
        t = { shown: { lat: ac.lat, lon: ac.lon, track: fix.track }, trail: [], corr: null };
        targets.set(ac.hex, t);
      } else if (!samePos) {
        // Absorb the fix discontinuity: remember where the plane is drawn vs.
        // where the new projection says it should be, and decay that offset —
        // screen motion stays continuous instead of chasing a jump. Two
        // exceptions snap instead: a hidden tab (rAF is frozen, so shown is
        // stale and the offset would replay as a cross-screen slide on
        // refocus) and jumps too large to plausibly animate.
        const age0 = (Date.now() - fix.at) / 1000;
        const [nLat, nLon] = projectState(fix, age0);
        t.corr = document.hidden || distNm(t.shown.lat, t.shown.lon, nLat, nLon) > 2
          ? null
          : { dLat: t.shown.lat - nLat, dLon: t.shown.lon - nLon, at: Date.now() };
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
    if (milCandidate && milSeeded) maybeMilZoom(milCandidate);
    milSeeded = true; // aircraft in the startup snapshot were already there
  }
  connectFeed();

  // Coming back after the tab/display was hidden: rAF was frozen the whole
  // time, so drawn positions are stale. Snap every target to current truth
  // (no catch-up slides), drop ones the feed has surely lost (the threshold
  // scales with bandwidth mode, like the stall alarm), and fade the overlay
  // back in so the rearranged sky doesn't teleport in front of the viewer.
  let hiddenAt = 0;
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { hiddenAt = Date.now(); return; }
    resumeFromHidden();
  });
  function resumeFromHidden() {
    if (!hiddenAt || Date.now() - hiddenAt < 5000) return;
    hiddenAt = 0;
    const staleLimit = (STALE_MS[bwMode] || STALE_MS.high)[1];
    for (const [hex, t] of targets) {
      t.corr = null;
      if (Date.now() - t.lastSeen > staleLimit) targets.delete(hex);
    }
    if (!REDUCED_MOTION) {
      canvas.style.transition = 'none';
      canvas.style.opacity = '0';
      void canvas.offsetWidth; // commit the hidden state before transitioning
      canvas.style.transition = 'opacity 0.7s ease';
      canvas.style.opacity = '1';
    }
  }

  // ------------------------------------------------------------------ icons
  // Jet/airliner: swept wings
  const PLANE_JET = new Path2D('M 0,-15 C 1.6,-15 2.2,-11 2.2,-8 L 2.2,-3 15,3.5 15,6.5 2.2,3.2 2.2,8.5 5.5,11.5 5.5,13.5 0,12 -5.5,13.5 -5.5,11.5 -2.2,8.5 -2.2,3.2 -15,6.5 -15,3.5 -2.2,-3 -2.2,-8 C -2.2,-11 -1.6,-15 0,-15 Z');
  // Light piston/GA: straight wings, stubby fuselage
  const PLANE_PROP = new Path2D('M 0,-11 C 1.1,-11 1.7,-8 1.7,-6 L 1.7,-3.5 13,-2.5 13,0.5 1.7,1 1.7,6.5 5,8 5,10 0,9 -5,10 -5,8 -1.7,6.5 -1.7,1 -13,0.5 -13,-2.5 -1.7,-3.5 -1.7,-6 C -1.7,-8 -1.1,-11 0,-11 Z');
  // Turboprop/regional: straight wings, longer span and fuselage
  const PLANE_TPROP = new Path2D('M 0,-14 C 1.3,-14 2,-10 2,-7 L 2,-3.5 15,-2.5 15,0.8 2,1.2 2,7.5 5.5,9.5 5.5,11.5 0,10.5 -5.5,11.5 -5.5,9.5 -2,7.5 -2,1.2 -15,0.8 -15,-2.5 -2,-3.5 -2,-7 C -2,-10 -1.3,-14 0,-14 Z');

  const TPROP_TYPES = /^(DH8|AT4|AT7|SF3|SW[34]|C130|C30J|B190|B350|BE20|BE99|D228|D328|F50|PC12|TBM|C208|E110)/;
  // Cessna singles are 4-char (C172) — a bare C17 is the Globemaster
  const LIGHT_TYPES = /^(C1\d\d|C2\d\d|P28|PA[1-4]|SR2|BE3[35]|BE5[058]|BE76|DA4|DA6|DV2|M20|RV|AA5|CH7|BL8|J3)/;

  function planeIconFor(m) {
    const t = (m.type || '').toUpperCase();
    if (TPROP_TYPES.test(t)) return PLANE_TPROP;
    if (m.category === 'A3' || m.category === 'A4' || m.category === 'A5') return PLANE_JET;
    if (LIGHT_TYPES.test(t) || m.category === 'A1') return PLANE_PROP;
    return PLANE_JET;
  }
  function iconScaleFor(m) {
    switch (m.category) {
      case 'A5': return 1.45; // heavy
      case 'A4': case 'A3': return 1.2;
      case 'A1': return 0.95;
      default: return 1.05;
    }
  }

  function drawHeli(ctx, color, halo) {
    // halo pass first — outlines body and rotors so bright fills pop
    ctx.strokeStyle = halo;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.ellipse(0, 0, 4.5, 7.5, 0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.lineWidth = 3.6;
    ctx.beginPath();
    ctx.moveTo(-11, -9); ctx.lineTo(11, 9);
    ctx.moveTo(11, -9); ctx.lineTo(-11, 9);
    ctx.stroke();
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.ellipse(0, 0, 4.5, 7.5, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillRect(-1.1, 6, 2.2, 9);
    ctx.fillRect(-4, 14, 8, 1.8);
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(-11, -9); ctx.lineTo(11, 9);
    ctx.moveTo(11, -9); ctx.lineTo(-11, 9);
    ctx.stroke();
  }

  // Diagonal stripe fills for the data-block tag bands: Coast Guard
  // (red/blue), police (blue/white). Cache per theme (cleared in applyTheme).
  let stripeCache = {};
  function stripePattern(key, base, stripe) {
    if (stripeCache[key]) return stripeCache[key];
    const pc = document.createElement('canvas');
    pc.width = pc.height = 8;
    const g = pc.getContext('2d');
    g.fillStyle = base;
    g.fillRect(0, 0, 8, 8);
    g.strokeStyle = stripe;
    g.lineWidth = 2.8;
    for (const o of [-8, 0, 8]) {
      g.beginPath();
      g.moveTo(o - 2, 10);
      g.lineTo(o + 10, -2);
      g.stroke();
    }
    return (stripeCache[key] = ctx.createPattern(pc, 'repeat'));
  }

  // ------------------------------------------------------------------ render
  const MONO = '13px ui-monospace, "SF Mono", Menlo, Consolas, monospace';
  const MONO_BOLD = '700 13px ui-monospace, "SF Mono", Menlo, Consolas, monospace';
  const TAG_FONT = '700 11px ui-monospace, "SF Mono", Menlo, monospace';

  // Palette rules: a hue means the same thing in both themes (cyan=aircraft,
  // gold=overhead, red=military, blue=police, green=climb). Dark uses vivid
  // high-chroma inks against the near-black map; light uses deep saturated
  // inks (not pastels) that hold 4.5:1+ contrast on the cream basemap.
  const THEMES = {
    dark: {
      icon: '#38bdff', trail: '#2f96e6', leader: '#48708f',
      iconHalo: 'rgba(4,10,18,0.85)',
      blockBg: 'rgba(12,24,38,0.92)', blockEdge: '#38587a',
      amber: '#ffbe2e', amberEdge: '#d99b17', amberBg: 'rgba(26,20,8,0.94)',
      mil: '#ff4b33', milEdge: '#d63b26', milBg: 'rgba(30,10,8,0.93)',
      dim: '#77879a',
      ring: '#2e7a63', ringText: '#53a184', home: '#e8f0f7',
      airport: '#84a9cc',
      textNormal: ['#4cc7ff', '#eaf4fd', '#ffc95e', '#a9bed2'],
      textOverhead: ['#ffbe2e', '#f9ecca', '#ffd166', '#cfb87e'],
      textMil: ['#ff7d66', '#fadfd9', '#ffb09e', '#cfa094'],
      tagText: '#140f04',
      chartMuted: '#5a6c7e',
      chartLow: '#2e6f9c', chartHigh: '#38bdff', chartPeak: '#ffbe2e',
      vsUp: '#22df82', vsDown: '#ff5540', vsFlat: '#8b9cae',
      police: '#4d82ff', policeEdge: '#3a63e8', policeBg: 'rgba(10,14,34,0.93)',
      policeFlash: '#cfe0ff',
      policeWhite: '#eef4ff', // stripe partner for the police livery
      textPolice: ['#93b1ff', '#e4ebff', '#b9c8f5', '#96a7e4'],
      hiMix: 0.55, // how far the selected-block border lightens toward white
    },
    light: {
      icon: '#0a7fd9', trail: '#3fa2e6', leader: '#8b8875',
      iconHalo: 'rgba(255,255,255,0.92)',
      blockBg: 'rgba(253,250,243,0.94)', blockEdge: '#b3a481',
      amber: '#f59500', amberEdge: '#e07f00', amberBg: 'rgba(253,246,227,0.96)',
      mil: '#e03526', milEdge: '#c42d1f', milBg: 'rgba(250,235,231,0.96)',
      dim: '#9aa39c',
      ring: '#1fa578', ringText: '#189a6e', home: '#34435a',
      airport: '#4a6b8a',
      textNormal: ['#0a72c4', '#2b3640', '#d97706', '#57646f'],
      textOverhead: ['#d97706', '#4a3a0c', '#d97706', '#8a7440'],
      textMil: ['#d0301f', '#4a201a', '#b8402e', '#8a5f56'],
      tagText: '#402f08',
      chartMuted: '#9aa1a8',
      chartLow: '#7db8dd', chartHigh: '#0a7fd9', chartPeak: '#f59500',
      vsUp: '#12a35c', vsDown: '#e03526', vsFlat: '#7f8a95',
      police: '#2f55e6', policeEdge: '#2f55e6', policeBg: 'rgba(233,238,252,0.96)',
      policeFlash: '#7fa0f0',
      policeWhite: '#ffffff', // stripe partner for the police livery
      textPolice: ['#1a37a8', '#252f45', '#31479c', '#4b5b8c'],
      hiMix: 0.3, // lighter mix on the cream background so the border stays visible
    },
  };
  let COLORS = THEMES.dark;

  const themeToggle = document.getElementById('theme-toggle');
  function applyTheme(name) {
    COLORS = THEMES[name] || THEMES.dark;
    document.body.classList.toggle('light', name === 'light');
    setTiles(TILE_URLS[name] || TILE_URLS.dark);
    themeToggle.textContent = name === 'light' ? '☀' : '☾';
    stripeCache = {}; // livery patterns bake theme colors — rebuild lazily
    localStorage.setItem('overhead-theme', name);
  }
  themeToggle.addEventListener('click', () => {
    applyTheme(document.body.classList.contains('light') ? 'dark' : 'light');
  });
  applyTheme(localStorage.getItem('overhead-theme') || 'dark');

  function blockLines(t) {
    const m = t.meta;
    const id = m.callsign && m.reg && m.callsign !== m.reg
      ? `${m.callsign} · ${m.reg}`
      : (m.callsign || m.reg || m.hex.toUpperCase() + ' · —');
    const model = m.model ? (m.type ? `${m.type} ${m.model}` : m.model) : (m.type || 'Type n/a');
    const op = m.operator || (m.model ? '—' : 'blocked / n/a');
    const kt = ` · ${Math.round(t.fix.gs)} kt`;
    let state;
    if (t.fix.onGround) state = 'GROUND' + kt;
    else if (t.fix.alt == null) state = 'ALT N/A' + kt;
    else {
      // structured so the trend arrow can carry its own color
      const vs = t.fix.vr > 250 ? 'up' : t.fix.vr < -250 ? 'down' : 'flat';
      state = {
        pre: t.fix.alt.toLocaleString() + ' ft ',
        arrow: vs === 'up' ? '↑' : vs === 'down' ? '↓' : '→',
        vs,
        post: kt,
      };
    }
    return [id, model, op, state];
  }

  // measureText is expensive at 60 fps × 4 lines × N blocks — cache per
  // target until the block's text actually changes.
  function blockWidth(t, lines) {
    const key = lines.map((s) => (typeof s === 'object' ? s.pre + s.arrow + s.post : s)).join('|');
    if (t.bwKey === key) return t.bwPx;
    ctx.font = MONO;
    let w = 0;
    for (const s of lines) {
      const text = typeof s === 'object' ? s.pre + s.arrow + s.post : s;
      w = Math.max(w, ctx.measureText(text).width);
    }
    t.bwKey = key;
    t.bwPx = w + 24; // padX * 2
    return t.bwPx;
  }

  function drawBlock(x, y, side, lines, opts) {
    const { overhead, dimmed, mil, police, cg, highlight, alpha = 1 } = opts;
    const padX = 12, lineH = 19, padTop = 8;
    const tagged = overhead || mil || police;
    const tagH = tagged ? 20 : 0;
    const tag = !tagged ? null
      : cg && overhead ? 'C G · O V E R H E A D' : cg ? 'C O A S T · G U A R D'
      : mil && overhead ? 'M I L · O V E R H E A D' : mil ? 'M I L I T A R Y'
      : police && overhead ? 'P O L I C E · O V E R H E A D' : police ? 'P O L I C E'
      : 'O V E R H E A D';
    let w = opts.width;
    if (tag) {
      // the band label can out-measure the data lines (COAST·GUARD over a
      // callsign-only block) — widen so the label pill never overflows
      ctx.font = TAG_FONT;
      w = Math.max(w, Math.ceil(ctx.measureText(tag).width) + padX * 2);
    }
    ctx.font = MONO;
    const h = padTop * 2 + lineH * lines.length + tagH - 4;

    const bx = side === 'right' ? x + 26 : x - 26 - w;
    const by = y - h / 2;

    const edge = mil ? COLORS.milEdge : police ? COLORS.policeEdge
      : overhead ? COLORS.amberEdge : COLORS.blockEdge;
    const bg = mil ? COLORS.milBg : police ? COLORS.policeBg
      : overhead ? COLORS.amberBg : COLORS.blockBg;
    // clicked or list-highlighted: lighter, heavier border (tag band keeps
    // its normal color so MIL/POLICE bands don't wash out)
    const borderEdge = highlight ? lerpHex(edge, '#ffffff', COLORS.hiMix) : edge;

    ctx.globalAlpha = alpha * (dimmed ? 0.55 : 1);

    // leader line to nearest block corner
    ctx.strokeStyle = highlight ? borderEdge : tagged ? edge : COLORS.leader;
    ctx.lineWidth = highlight ? 1.8 : 1.2;
    ctx.beginPath();
    ctx.moveTo(x + (side === 'right' ? 12 : -12), y);
    ctx.lineTo(side === 'right' ? bx : bx + w, by + h / 2);
    ctx.stroke();

    ctx.fillStyle = bg;
    ctx.strokeStyle = borderEdge;
    ctx.lineWidth = highlight ? 2.2 : tagged ? 1.4 : 1;
    ctx.beginPath();
    ctx.roundRect(bx, by, w, h, 3);
    ctx.fill();
    ctx.stroke();

    let ty = by + padTop;
    if (tagged) {
      // Coast Guard band: red/yellow diagonal stripes; police: blue/white
      ctx.fillStyle = cg ? stripePattern('cgBand', COLORS.mil, COLORS.amber)
        : police ? stripePattern('policeBand', COLORS.police, COLORS.policeWhite)
        : edge;
      ctx.beginPath();
      ctx.roundRect(bx, by, w, 20, [3, 3, 0, 0]);
      ctx.fill();
      ctx.font = TAG_FONT;
      ctx.textBaseline = 'middle';
      if (cg || police) {
        // solid dark pill under the label — a halo alone washes out on the
        // light stripes
        const tw = ctx.measureText(tag).width;
        ctx.fillStyle = 'rgba(4,7,12,0.78)';
        ctx.beginPath();
        ctx.roundRect(bx + padX - 5, by + 3, tw + 10, 14, 7);
        ctx.fill();
        ctx.fillStyle = '#f5f7fa';
        ctx.fillText(tag, bx + padX, by + 10.5);
      } else {
        ctx.fillStyle = COLORS.tagText;
        ctx.fillText(tag, bx + padX, by + 10.5);
      }
      ty += tagH;
    }

    const palette = mil ? COLORS.textMil : police ? COLORS.textPolice
      : overhead ? COLORS.textOverhead : COLORS.textNormal;
    ctx.textBaseline = 'top';
    lines.forEach((s, i) => {
      ctx.font = i === 0 ? MONO_BOLD : MONO;
      const color = dimmed ? COLORS.dim : palette[i];
      if (typeof s === 'object') {
        // altitude · colored trend arrow · speed
        let tx = bx + padX;
        ctx.fillStyle = color;
        ctx.fillText(s.pre, tx, ty + 2);
        tx += ctx.measureText(s.pre).width;
        ctx.font = MONO_BOLD;
        ctx.fillStyle = dimmed ? COLORS.dim
          : s.vs === 'up' ? COLORS.vsUp : s.vs === 'down' ? COLORS.vsDown : COLORS.vsFlat;
        ctx.fillText(s.arrow, tx, ty + 2);
        tx += ctx.measureText(s.arrow).width;
        ctx.font = MONO;
        ctx.fillStyle = color;
        ctx.fillText(s.post, tx, ty + 2);
      } else {
        ctx.fillStyle = color;
        ctx.fillText(s, bx + padX, ty + 2);
      }
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
  }

  // Home marker draws regardless of the rings layer
  function drawHome() {
    const homePt = map.latLngToContainerPoint(HOME);
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

  // Vertical distance scale (nm), centered on the right edge
  function drawScale() {
    const W = canvas.clientWidth;
    const H = canvas.clientHeight;
    const c = map.getCenter();
    const p1 = map.latLngToContainerPoint([c.lat, c.lng]);
    const p2 = map.latLngToContainerPoint(project(c.lat, c.lng, 0, 1)); // 1 nm north
    const pxPerNm = Math.abs(p1.y - p2.y);
    if (!pxPerNm) return;
    const nice = [1, 2, 5, 10, 15, 20, 25, 30, 40, 50];
    let total = nice[0];
    for (const n of nice) if (n * pxPerNm <= H * 0.4) total = n;
    const step = total / 5;
    const len = total * pxPerNm;
    const x = W - 24;
    const yBottom = H / 2 + len / 2;

    ctx.strokeStyle = COLORS.ring;
    ctx.fillStyle = COLORS.ringText;
    ctx.lineWidth = 1.4;
    ctx.font = '11px ui-monospace, "SF Mono", Menlo, monospace';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    ctx.beginPath();
    ctx.moveTo(x, yBottom);
    ctx.lineTo(x, yBottom - len);
    ctx.stroke();
    for (let i = 0; i <= 5; i++) {
      const y = yBottom - i * step * pxPerNm;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x - (i % 5 === 0 ? 8 : 5), y);
      ctx.stroke();
      if (i === 0 || i === 5 || total >= 10) {
        const label = i === 5 ? `${total} NM` : String(i * step);
        ctx.fillText(label, x - 11, y);
      }
    }
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
  }

  // Airport markers: diamond + code. Small airports hide beyond 20 mi view.
  function drawAirports() {
    const showSmall = currentViewMiles <= 20;
    const W = canvas.clientWidth;
    const H = canvas.clientHeight;
    ctx.font = '10px ui-monospace, "SF Mono", Menlo, monospace';
    ctx.textBaseline = 'middle';
    for (const a of airports) {
      if (a.type === 'small_airport' && !showSmall) continue;
      const p = map.latLngToContainerPoint([a.lat, a.lon]);
      if (p.x < -30 || p.y < -30 || p.x > W + 30 || p.y > H + 30) continue;
      ctx.strokeStyle = COLORS.airport;
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(p.x, p.y - 5);
      ctx.lineTo(p.x + 5, p.y);
      ctx.lineTo(p.x, p.y + 5);
      ctx.lineTo(p.x - 5, p.y);
      ctx.closePath();
      ctx.stroke();
      ctx.fillStyle = COLORS.airport;
      ctx.fillText(a.iata || a.ident, p.x + 9, p.y);
    }
    ctx.textBaseline = 'alphabetic';
  }

  // Hovering an airport marker shows a small info card (name, elevation, …)
  function drawAirportTip(a) {
    const pt = map.latLngToContainerPoint([a.lat, a.lon]);
    const kind = a.type.replace('_airport', '').toUpperCase();
    const distMi = distNm(HOME[0], HOME[1], a.lat, a.lon) / NM_PER_MI;
    const lines = [
      a.iata && a.iata !== a.ident ? `${a.ident} · ${a.iata}` : a.ident,
      a.name,
      [a.muni, `${kind} AIRPORT`].filter(Boolean).join(' · '),
      `${a.elev != null ? `ELEV ${Math.round(a.elev).toLocaleString()} FT` : 'ELEV —'} · ${distMi.toFixed(1)} MI FROM HOME`,
    ];
    ctx.font = MONO;
    const padX = 12, lineH = 19, padTop = 8;
    let w = 0;
    for (const s of lines) w = Math.max(w, ctx.measureText(s).width);
    w += padX * 2;
    const h = padTop * 2 + lineH * lines.length - 4;
    const side = pt.x < canvas.clientWidth / 2 ? 'right' : 'left';
    const bx = side === 'right' ? pt.x + 18 : pt.x - 18 - w;
    const by = pt.y - h / 2;

    ctx.strokeStyle = COLORS.airport;
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(pt.x + (side === 'right' ? 7 : -7), pt.y);
    ctx.lineTo(side === 'right' ? bx : bx + w, by + h / 2);
    ctx.stroke();

    ctx.fillStyle = COLORS.blockBg;
    ctx.beginPath();
    ctx.roundRect(bx, by, w, h, 3);
    ctx.fill();
    ctx.stroke();

    ctx.textBaseline = 'top';
    let ty = by + padTop;
    lines.forEach((s, i) => {
      ctx.font = i === 0 ? MONO_BOLD : MONO;
      ctx.fillStyle = i === 0 ? COLORS.textNormal[0] : i === 1 ? COLORS.textNormal[1] : COLORS.textNormal[3];
      ctx.fillText(s, bx + padX, ty + 2);
      ty += lineH;
    });
    ctx.textBaseline = 'alphabetic';
  }

  let lastFrame = performance.now();
  function frame(now) {
    const dtF = Math.min((now - lastFrame) / 1000, 0.25);
    lastFrame = now;
    ctx.clearRect(0, 0, canvas.clientWidth, canvas.clientHeight);

    if (layers.rings) drawRings();
    drawHome();
    if (layers.scale) drawScale();
    if (layers.airports && airports.length) drawAirports();

    let overheadCount = 0;
    const blockQueue = []; // blocks draw after every icon, so details sit on top

    if (layers.aircraft) for (const t of targets.values()) {
      const f = t.fix;
      // kinematic projection (arc + accel) plus a decaying correction offset —
      // no spring chase, so no lurch when sparse fixes arrive
      const age = (Date.now() - f.at) / 1000;
      let [sLat, sLon] = projectState(f, age);
      if (t.corr) {
        const cAge = (Date.now() - t.corr.at) / 1000;
        const d = 1 - cAge / 3.5;
        if (d <= 0) {
          t.corr = null;
        } else {
          const w = d * d * (3 - 2 * d); // smoothstep: full offset now, gone in 3.5 s
          sLat += t.corr.dLat * w;
          sLon += t.corr.dLon * w;
        }
      }
      t.shown.lat = sLat;
      t.shown.lon = sLon;
      const targetTrack = f.track + (f.turnRate || 0) * Math.min(age, PROJECT_CAP_S);
      t.shown.track += shortestArc(t.shown.track, targetTrack) * (1 - Math.exp(-dtF * 3));

      const pt = map.latLngToContainerPoint([t.shown.lat, t.shown.lon]);
      if (pt.x < -200 || pt.y < -200 || pt.x > canvas.clientWidth + 200 || pt.y > canvas.clientHeight + 200) continue;

      const dHome = distNm(HOME[0], HOME[1], t.shown.lat, t.shown.lon);
      // "Overhead" = laterally close AND low enough to matter — a jet at
      // FL350 crossing the ring is an overflight, not an event.
      const overhead = !f.onGround && dHome <= (config.overhead_nm || 5) &&
        (f.alt == null || f.alt <= OVERHEAD_MAX_FT);
      if (overhead) overheadCount++;
      const dimmed = f.onGround;
      const mil = !!t.meta.mil;
      const police = !!t.meta.police && !mil;
      const nowMs = Date.now();

      // trail: purely time-based fade — fully gone at trail_fade_seconds (60 s)
      while (t.trail.length && nowMs - t.trail[0].at > TRAIL_FADE_MS) t.trail.shift();
      if (layers.trails && t.trail.length && !dimmed) {
        const base = mil ? COLORS.mil : police ? COLORS.police : overhead ? COLORS.amber : COLORS.trail;
        ctx.strokeStyle = base;
        ctx.lineWidth = 1.6;
        let prev = null, prevAt = 0;
        for (let i = 0; i <= t.trail.length; i++) {
          const p = i < t.trail.length
            ? t.trail[i]
            : { lat: t.shown.lat, lon: t.shown.lon, at: nowMs };
          const cp = map.latLngToContainerPoint([p.lat, p.lon]);
          // don't connect across a suspension gap (tab hidden / laptop asleep,
          // no fixes recorded) — 90 s clears LOW mode's legit 45 s cadence
          if (prev && p.at - prevAt < 90000) {
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
          prevAt = p.at;
        }
        ctx.globalAlpha = 1;
      }

      // icon — Coast Guard flashes red/yellow, police red/blue (steady
      // yellow/blue under prefers-reduced-motion); other military solid red.
      // Stripes live on the data block's tag band, not the airframe.
      ctx.save();
      ctx.translate(pt.x, pt.y);
      const flashOn = !REDUCED_MOTION && Math.floor(nowMs / 400) % 2 === 1;
      const iconColor =
        t.meta.cg ? (flashOn ? COLORS.mil : COLORS.amber)
        : mil ? COLORS.mil
        : police ? (flashOn ? COLORS.mil : COLORS.police)
        : dimmed ? COLORS.dim : overhead ? COLORS.amber : COLORS.icon;
      ctx.rotate((t.shown.track * Math.PI) / 180);
      if (t.meta.heli) {
        drawHeli(ctx, iconColor, COLORS.iconHalo);
      } else {
        const s = iconScaleFor(t.meta);
        ctx.scale(s, s);
        const path = planeIconFor(t.meta);
        // halo pass: bright fills stay visible on any basemap because the
        // outline provides the separation, not a darkened pigment
        ctx.strokeStyle = COLORS.iconHalo;
        ctx.lineWidth = 2.6;
        ctx.lineJoin = 'round';
        ctx.stroke(path);
        ctx.fillStyle = iconColor;
        ctx.fill(path);
      }
      ctx.restore();

      // Data block: the top-left toggle decides — OVERHEAD shows blocks only
      // for aircraft inside the overhead ring, ALL for every airborne one.
      // Ground aircraft never show a block on their own (click for 7 s), but
      // airborne-and-slow is a hovering helicopter, not a parked plane.
      // Military targets always carry their block (any mode, even on ground);
      // Coast Guard is the exception — it follows the normal display rules
      let showBlock = layers.blocks &&
        ((mil && !t.meta.cg) || (!f.onGround && (dataMode === 'all' || overhead)));
      let blockAlpha = 1;
      if (!showBlock && t.detailUntil) {
        const left = t.detailUntil - nowMs;
        if (left > 0) {
          showBlock = true;
          blockAlpha = Math.min(1, left / 600); // fade out over the last 0.6 s
        }
      }
      // Map hover: the pointed-at aircraft always shows its block
      if (hoveredHex && t.meta.hex === hoveredHex) {
        showBlock = true;
        blockAlpha = 1;
      }
      // List hover-isolate overrides everything: only the hovered aircraft
      // keeps its block while the pointer is on the list.
      if (focusedHex) {
        showBlock = t.meta.hex === focusedHex;
        blockAlpha = 1;
      }
      if (showBlock) {
        const side = pt.x < canvas.clientWidth / 2 ? 'right' : 'left';
        const lines = blockLines(t);
        const highlight = (t.detailUntil || 0) > nowMs || t.meta.hex === focusedHex;
        blockQueue.push([pt.x, pt.y, side, lines, {
          overhead, dimmed, mil, police, cg: !!t.meta.cg, highlight,
          alpha: blockAlpha, width: blockWidth(t, lines),
        }]);
      }
    }
    for (const args of blockQueue) drawBlock(...args);
    if (layers.airports) {
      if (airportTap && airportTap.until < Date.now()) airportTap = null;
      const tipAirport = hoveredAirport || (airportTap && airportTap.a);
      if (tipAirport) drawAirportTip(tipAirport);
    }

    updateBar(overheadCount);
    if (!paused) requestAnimationFrame(frame);
  }
  let paused = false; // set by the kiosk shell below; declared before the loop starts
  requestAnimationFrame(frame);

  // ------------------------------------------------- kiosk shell (embed mode)
  // The edge-loader shell hides this app in a display:none iframe when another
  // view is on screen. Hidden iframes never fire visibilitychange, so the shell
  // tells us directly: stop the draw loop and drop the feed, then pick both up
  // on the way back. An off-screen copy costs nothing.
  function setPaused(next) {
    if (paused === next) return;
    paused = next;
    document.body.classList.toggle('paused', paused); // observable state, handy for debugging
    if (paused) {
      hiddenAt = Date.now();
      disconnectFeed();
      return;
    }
    connectFeed();
    lastFrame = performance.now(); // don't bill the pause to the first frame
    requestAnimationFrame(frame);
    resumeFromHidden();
  }

  // Overlay buttons in the shell map onto the controls this app already has.
  const SHELL_COMMANDS = {
    home: () => map.panTo(HOME),          // recenter on home
    setHome: () => homeToggle.click(),    // open the "set home" panel
    zoomIn: () => map.zoomIn(1),
    zoomOut: () => map.zoomOut(1),
    trails: (on) => setLayer('trails', on),
    blocks: (on) => setLayer('blocks', on),
    airports: (on) => setLayer('airports', on),
    airspace: (on) => setLayer('airspace', on),
    list: () => listToggle.click(),
    settings: () => bwEl.click(),
  };
  window.addEventListener('message', (e) => {
    const msg = e.data;
    if (!msg || msg.source !== 'edge-loader') return;
    if (msg.type === 'visibility') { setPaused(!msg.visible); return; }
    if (msg.type === 'command') SHELL_COMMANDS[msg.cmd]?.(msg.on);
  });
  // Announce readiness so the shell can re-assert visibility to a slow loader.
  if (EMBED && window.parent !== window) {
    window.parent.postMessage({ source: 'edge-app', type: 'ready', app: 'overhead' }, '*');
  }

  // ------------------------------------------------------------- status bar
  const el = {
    bar: document.getElementById('bar'),
    clock: document.getElementById('clock'),
    count: document.getElementById('count'),
    overhead: document.getElementById('overhead-count'),
    dot: document.getElementById('feed-dot'),
    feed: document.getElementById('feed-name'),
    nextScan: document.getElementById('next-scan'),
  };
  // Healthy broadcast cadence differs per bandwidth mode — the stall alarm
  // must not cry wolf between LOW mode's scheduled 12 s gaps.
  const STALE_MS = { high: [10000, 30000], medium: [15000, 40000], low: [25000, 60000] };
  const cached = {}; // skip identical DOM writes — this runs every frame
  function setText(node, key, value) {
    if (cached[key] !== value) {
      cached[key] = value;
      node.textContent = value;
    }
  }
  function updateBar(overheadCount) {
    setText(el.count, 'count', String(targets.size));
    setText(el.overhead, 'overhead', String(overheadCount));
    const stale = Date.now() - feedState.lastOkAt;
    const [warnMs, badMs] = STALE_MS[bwMode] || STALE_MS.high;
    const cls = feedState.lastOkAt === 0 ? '' : stale < warnMs ? 'ok' : stale < badMs ? 'warn' : 'bad';
    if (cached.dot !== cls) {
      cached.dot = cls;
      el.dot.className = 'dot ' + cls;
    }
    const stalled = cls === 'warn' || cls === 'bad';
    if (cached.stalled !== stalled) {
      cached.stalled = stalled;
      el.bar.classList.toggle('stalled', stalled);
    }
    setText(el.feed, 'feed', stalled
      ? `FEED STALE ${Math.round(stale / 1000)}s`
      : `FEED: ${feedState.source.toUpperCase()}`);
  }
  setInterval(() => {
    el.clock.textContent = new Date().toLocaleTimeString('en-US', { hour12: false });
    if (nextScan) {
      const s = Math.ceil((nextScan - Date.now()) / 1000);
      setText(el.nextScan, 'nextScan', s > 0 ? `· NEXT SCAN ${s}s` : '· SCANNING…');
    }
  }, 250);
})();
