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
  // The settings panel is closed by default and embed mode hides the header —
  // a kiosk must fail on its own glass, so fatal errors own the alert banner.
  const alert = document.getElementById('alert-banner');
  if (alert) { alert.textContent = 'APP ERROR: ' + msg; alert.classList.add('show', 'bad'); }
}
window.addEventListener('error', (e) => showFatal(e.message));
window.addEventListener('unhandledrejection', (e) => showFatal(e.reason?.message || String(e.reason)));

(async function main() {
  const config = await (await fetch('/config')).json();
  const usageSeed = await fetch('/usage').then((r) => r.json()).catch(() => null);

  // Home lives in the browser's storage; the server only holds it in memory.
  // On connect we adopt the stored home and re-assert it server-side.
  let HOME = [config.home.lat, config.home.lon];
  // The committed placeholder (SEA airport). A device must never lock this in
  // as "its" home — otherwise a screen opened right after a server restart
  // adopts SEA forever and shows arrivals there as OVERHEAD.
  const isPlaceholderHome = (la, lo) => Math.abs(la - 47.4502) < 1e-6 && Math.abs(lo - -122.3088) < 1e-6;
  try {
    const storedHome = JSON.parse(localStorage.getItem('overhead-home'));
    if (storedHome && Number.isFinite(storedHome.lat) && Number.isFinite(storedHome.lon) &&
        !isPlaceholderHome(storedHome.lat, storedHome.lon)) {
      HOME = [storedHome.lat, storedHome.lon];
      fetch('/home', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lat: HOME[0], lon: HOME[1] }),
      }).catch(() => {});
    }
    // No stored home: follow the server's current home (which tracks the last
    // one any device asserted) without persisting it — only an explicit SET
    // in the HOME panel writes this device's own copy.
  } catch { /* keep server default */ }

  // Shared constants — keep at the top: init code below runs immediately and
  // consts are not hoisted (a TDZ crash here bricks the whole app).
  const NM_PER_MI = 0.868976;
  const REDUCED_MOTION = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  // Embedded in the edge-loader kiosk shell: the shell draws the chrome, so
  // this app hides its own header and takes commands over postMessage.
  const EMBED = new URLSearchParams(location.search).get('embed') === '1';
  const TRAIL_FADE_MS = (config.trail_fade_seconds ?? 60) * 1000;
  // Backstop for a followed aircraft's held trail (see the trail cap below).
  // ~3 hours of fixes at the fastest cadence; a wall panel runs for weeks.
  const TRAIL_MAX = 4000;
  const DETAIL_MS = (config.detail_click_seconds ?? 7) * 1000;
  const MAX_VIEW_NM = 87; // feed coverage limit, expressed in NM like the rest of the scope
  const OVERHEAD_MAX_FT = config.overhead_max_ft ?? 18000;
  const PROJECT_CAP_S = 60; // must exceed LOW mode's 45 s full-sweep interval

  // Altitude bands, in feet, matching COLORS.altBands. Controllers read height
  // off a scope by shade; before this every target was the same cyan whether it
  // was on short final or at FL380.
  const ALT_BANDS = [2500, 10000, 20000, 30000];
  function altBandIndex(ft) {
    if (!Number.isFinite(ft)) return 2; // unknown: sit in the middle of the ramp
    let i = 0;
    while (i < ALT_BANDS.length && ft >= ALT_BANDS[i]) i++;
    return i;
  }

  // One glyph for "the feed did not give us this", everywhere. Rendering a
  // missing groundspeed as "0 kt" (Math.round(null)) claimed a moving target
  // was stopped — on a scope, a wrong number is worse than a blank.
  const NO_DATA = '—';

  // US convention: flight levels at and above 18,000 ft, feet below it.
  function fmtAlt(ft) {
    if (!Number.isFinite(ft)) return null;
    return ft >= 18000
      ? 'FL' + String(Math.round(ft / 100)).padStart(3, '0')
      : ft.toLocaleString() + ' ft';
  }

  // On-glass alert state. Declared up here with the other shared state because
  // loadAirspace() and the fly-by both write it from init-time paths — leaving
  // it at its old spot near updateBar() put it in the TDZ for those callers.
  let alertNote = { text: '', until: 0 };
  function flashAlert(text, ms = 8000) {
    alertNote = { text, until: Date.now() + ms };
  }

  // Flight tracking (⌖ FIND, top left): declared with the shared state because
  // the wheel handler, applyRange, maybeMilZoom and the click handler all read
  // it from init-time paths — the panel wiring itself lives further down.
  let tracked = null;            // { hex, label } of the followed aircraft
  let trackPeekUntil = 0;        // a user drag pauses the follow until this time
  let trackPanX = 0, trackPanY = 0; // sub-pixel pan remainder (panBy rounds)
  let suppressNextClick = false; // a long-press must not also fire the tap action
  function trackedCenter() {
    if (!tracked) return null; // guard first: `targets` doesn't exist yet at init
    const t = targets.get(tracked.hex);
    return t ? [t.shown.lat, t.shown.lon] : null;
  }

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
    // While following a flight, zoom around the flight — anchoring at the
    // cursor would shift the center and the follow would yank it back.
    const tc = tracked && Date.now() > trackPeekUntil ? targets.get(tracked.hex) : null;
    wheelAnchor = tc && tc.px ? L.point(tc.px.x, tc.px.y) : map.mouseEventToContainerPoint(e);
    if (!wheelRaf) wheelRaf = requestAnimationFrame(wheelStep);
  }, { passive: false });

  // ------------------------------------------------------------- basemap
  // The provider list lives in web/basemaps.js (shared with the smoke test).
  // `carto_key` is optional and only ever comes from config.local.json; with
  // no key the app is entirely keyless, which is the point.
  // A basemap is decoration; the scope is the product. If basemaps.js fails
  // to load, fall back to a hardcoded OSM entry rather than throwing on line
  // one and taking the aircraft display down with it.
  const basemapList = (typeof BASEMAPS === 'object' && BASEMAPS)
    ? BASEMAPS.providers(config.carto_key)
    : [{
        id: 'osm', label: 'OPENSTREETMAP', note: 'fallback — basemaps.js did not load',
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
        maxZoom: 19, maxNativeZoom: 19,
        dark: { url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
                filter: 'invert(1) hue-rotate(180deg) saturate(.2) brightness(.55) contrast(1.2)' },
        light: { url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
                 filter: 'saturate(.45) brightness(1.06) contrast(.96)' },
      }];
  let basemapId = localStorage.getItem('overhead-basemap');
  if (!basemapList.some((p) => p.id === basemapId)) basemapId = basemapList[0].id;
  let themeName = 'dark';
  // Map style (web/styles.js): CLASSIC runs on the per-provider filters
  // above; every other style recolours a provider's `styled` source through
  // SVG gradient-map filters that live in #style-filters.
  const STYLE_LIST = MAPSTYLES.STYLES;
  // A browser's own pick wins; until it makes one, `style` in the config
  // (config.local.json on a wall panel) sets it. A kiosk has no keyboard and
  // no way in from outside, so this is how its look is changed remotely.
  let styleId = localStorage.getItem('overhead-style') || config.style;
  if (!STYLE_LIST.some((s) => s.id === styleId)) styleId = STYLE_LIST[0].id;
  // The half of the current style for the current theme — or null, meaning
  // "draw CLASSIC", for CLASSIC itself and for a provider with no `styled`
  // source (the keyed CARTO entry). A style is inks, chrome and tiles as one
  // measured set; painting its inks over tiles it was never measured on is
  // how an ink quietly drops under its bar.
  function styleHalf() {
    const st = MAPSTYLES.byId(styleId);
    if (st.classic || !currentBasemap().styled) return null;
    return st[themeName];
  }
  // Filter ids are versioned per look (ms1-, ms2-, …). The outgoing layers
  // keep pointing at the previous look's filters through applyBasemap's
  // 400 ms crossfade, so those have to outlive it: with one reused id the
  // old tiles either lost their filter mid-fade (styled → CLASSIC flashed the
  // raw grey canvas across the wall) or jumped to the new colours at once.
  let lookGen = 0;
  let lookPrefix = 'ms0';
  let tileLayers = [];            // [base] or [base, labels]
  // Providers an automatic failover found dead, with when. Forgotten after
  // ten minutes: an outage is weather, and a provider that failed once at
  // 3 a.m. must not stay ruled out for every style change until a reload.
  const basemapTried = new Map();
  const TRIED_MS = 10 * 60 * 1000;
  const recentlyFailed = (pid) => Date.now() - (basemapTried.get(pid) ?? -Infinity) < TRIED_MS;

  function currentBasemap() {
    return basemapList.find((p) => p.id === basemapId) || basemapList[0];
  }

  // Swap by replacing the layer rather than setUrl(): at fractional zoom
  // (zoomSnap 0.1) setUrl leaves the redrawn tiles untransformed, so they are
  // invisible until the map next moves.
  function applyBasemap() {
    const provider = currentBasemap();
    const half = styleHalf();
    // A styled look needs a source the gradient maps were calibrated on. A
    // provider without one (the keyed CARTO entry) keeps its classic recipe
    // rather than being run through coefficients measured on someone else's
    // tiles.
    const spec = half && provider.styled
      ? {
          layers: provider.styled.layers.map((l) => (l.relief
            ? { url: l.url, filter: `url(#${lookPrefix}-relief)`, blend: 'multiply', opacity: half.map.relief?.op ?? 0.6 }
            : { url: l.url, filter: `url(#${lookPrefix}-base-${l.src})` })),
          labels: provider.styled.labels?.[MAPSTYLES.labelKind(half.map)],
          labelsFilter: `url(#${lookPrefix}-labels)`,
        }
      : provider[themeName] || provider.dark;
    const opts = {
      maxZoom: provider.maxZoom,
      // Beyond a provider's real data, Leaflet upscales its last good tile
      // rather than requesting levels the service answers with a placeholder.
      maxNativeZoom: provider.maxNativeZoom ?? provider.maxZoom,
      attribution: provider.attribution,
    };
    // A theme is either one tile layer (url + filter) or a stack of them.
    // TERRAIN needs the stack: hillshade carries the landform but not the
    // water, so the canvas is composited over it for coast, roads and labels.
    const stack = spec.layers || [{ url: spec.url, filter: spec.filter }];
    const next = stack.map((l, i) => L.tileLayer(l.url, i === 0 ? opts : { ...opts, attribution: '' }));
    const styles = stack.slice();
    // Esri ships its place names as a separate transparent layer. That is a
    // second tile request per view, which a Pi on rural Wi-Fi feels, so it is
    // a switch rather than an assumption — but it defaults on, because a map
    // with no city names is a map of nowhere.
    if (spec.labels && layers.maplabels) {
      next.push(L.tileLayer(spec.labels, { ...opts, attribution: '' }));
      styles.push({ filter: spec.labelsFilter || 'none' });
    }
    // The filter goes on each layer's own container, not on the shared tile
    // pane. On the pane it also hit the outgoing layer during the deliberate
    // 400 ms crossfade below, so every switch flashed the OLD provider's
    // tiles through the NEW provider's recipe — briefly inverting the whole
    // wall to white on the way into the OSM theme. Per-container is also what
    // makes a composite possible at all: each layer needs its own recipe, and
    // the upper ones need their own blend mode against the ones below.
    next.forEach((l, i) => {
      l.addTo(map);
      const el = l.getContainer();
      if (!el) return;
      const st = styles[i] || {};
      el.style.filter = st.filter || 'none';
      el.style.mixBlendMode = st.blend || 'normal';
      el.style.opacity = st.opacity != null ? String(st.opacity) : '';
    });
    watchBasemap(next[0], provider);
    const old = tileLayers;
    tileLayers = next;
    setTimeout(() => old.forEach((l) => l.remove()), 400); // let the new layer paint first
    const sel = document.getElementById('basemap-select');
    if (sel) sel.value = provider.id;
    const labelBox = layerBoxes.find((b) => b.dataset.layer === 'maplabels');
    if (labelBox) {
      labelBox.disabled = !spec.labels;
      labelBox.closest('label').title = spec.labels
        ? 'Place names as a separate tile layer — off halves this basemap\'s tile requests'
        : `${provider.label} bakes its labels into the basemap — nothing to toggle`;
    }
  }

  function setBasemap(id, persist = true) {
    if (!basemapList.some((p) => p.id === id)) return;
    basemapId = id;
    if (persist) {
      localStorage.setItem('overhead-basemap', id);
      // What YOU picked, as distinct from what a style moved you to — see
      // setStyle(), which returns here when you leave that style.
      localStorage.setItem('overhead-basemap-user', id);
      localStorage.removeItem('overhead-basemap-auto');
      basemapTried.clear(); // a deliberate choice re-arms automatic failover
    }
    // The whole look, not just the tiles: moving to a provider with no styled
    // source (or back) changes which inks and chrome apply.
    applyLook();
  }

  // A provider that starts refusing tiles should cost a glance, not a debug
  // session. This catches the honest failures — 403, 404, DNS, a withdrawn
  // service. It cannot catch a provider that keeps answering 200 with a
  // different picture, which is exactly how CARTO withdrew its keyless
  // basemaps in Aug 2026: the tiles kept arriving with "API KEY REQUIRED"
  // painted across them and nothing errored. That one needs the eye, and the
  // picker below is how you fix it in a second.
  function watchBasemap(layer, provider) {
    // A window, not a running total. The count used to live for the life of
    // the layer, so six dropped tiles spread over days — ordinary weather on
    // a 24/7 panel — eventually declared a provider that was working fine
    // "UNREACHABLE". An outage delivers its errors together.
    const ERR_WINDOW_MS = 30000;
    let errorsAt = [];
    layer.on('tileerror', () => {
      const now = Date.now();
      errorsAt.push(now);
      errorsAt = errorsAt.filter((t) => now - t < ERR_WINDOW_MS);
      if (errorsAt.length !== 6) return; // one dropped tile is weather, not a policy change
      basemapTried.set(provider.id, Date.now());
      const next = basemapList.find((p) => !recentlyFailed(p.id));
      if (!next) {
        flashAlert('NO BASEMAP REACHABLE — SCOPE IS LIVE, MAP IS NOT');
        return;
      }
      flashAlert(`${provider.label} BASEMAP UNREACHABLE — SWITCHED TO ${next.label}`);
      setBasemap(next.id, false); // an outage must not overwrite a deliberate choice
    });
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

  // ---------------------------------------------------- fast map projection
  // map.latLngToContainerPoint() runs the full Mercator + transformation chain
  // per call. A busy sky costs one call per target plus one per trail point —
  // ~4k per frame, ~250k/s at 60 fps, which a Pi 4 feels. The map's zoom and
  // pane offset are constant within a frame, so hoist them once and inline the
  // projection. This reduces to Leaflet's own math exactly (verified against
  // its SphericalMercator + Transformation to ~1e-8 px), so screen positions
  // are identical to what latLngToContainerPoint would return.
  const MERC_MAX_LAT = 85.0511287798;
  let pxScale = 0, pxOffX = 0, pxOffY = 0;
  function syncProjection() {
    pxScale = 256 * Math.pow(2, map.getZoom());
    const origin = map.getPixelOrigin();
    // layerPoint(0,0) in container space is the map pane's current offset;
    // container = world - pixelOrigin + panePos
    const pane = map.layerPointToContainerPoint(L.point(0, 0));
    pxOffX = pane.x - origin.x;
    pxOffY = pane.y - origin.y;
  }
  // Scratch point reused by the hot loops — allocating 4k objects per frame is
  // its own cost. Callers must consume .x/.y before the next call.
  const projScratch = { x: 0, y: 0 };
  function toPx(lat, lon, out = projScratch) {
    const la = lat > MERC_MAX_LAT ? MERC_MAX_LAT : lat < -MERC_MAX_LAT ? -MERC_MAX_LAT : lat;
    const s = Math.sin(la * (Math.PI / 180));
    out.x = pxScale * (lon + 180) / 360 + pxOffX;
    out.y = pxScale * (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) + pxOffY;
    return out;
  }

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

  // View-range slider (top right): fits the map so ~N nautical miles are
  // visible around home. The whole scope reads in NM — rings, scale bar,
  // coverage limit and this slider — because mixing statute and nautical on
  // one aviation display invites a misread.
  const rangeInput = document.getElementById('range');
  const rangeVal = document.getElementById('range-val');
  const vmMi = config.view_miles || { min: 4, max: 40, default: 15 };
  const vm = {
    min: Math.max(1, Math.round(vmMi.min * NM_PER_MI)),
    max: Math.round(vmMi.max * NM_PER_MI),
    default: Math.round(vmMi.default * NM_PER_MI),
  };
  rangeInput.min = vm.min;
  rangeInput.max = vm.max;
  const savedNm = Number(localStorage.getItem('overhead-view-nm'));
  rangeInput.value = savedNm >= vm.min && savedNm <= vm.max ? savedNm : vm.default;
  function applyRange(nm, animate = true) {
    rangeVal.textContent = nm;
    // While following a flight the slider sets scale around the flight, not
    // around home — recentering on home would abandon the track visually.
    const [cLat, cLon] = trackedCenter() || HOME;
    const north = project(cLat, cLon, 0, nm);
    const south = project(cLat, cLon, 180, nm);
    const east = project(cLat, cLon, 90, nm);
    const west = project(cLat, cLon, 270, nm);
    map.fitBounds(L.latLngBounds([north, south, east, west]), { animate });
  }
  // While dragging, redraw instantly at every mile step — no animation queue.
  // The zoom→slider sync pauses during a drag so it can't fight the thumb.
  let draggingRange = false;
  rangeInput.addEventListener('pointerdown', () => { draggingRange = true; });
  window.addEventListener('pointerup', () => { draggingRange = false; });
  rangeInput.addEventListener('input', () => {
    localStorage.setItem('overhead-view-nm', rangeInput.value);
    applyRange(Number(rangeInput.value), false);
  });
  applyRange(Number(rangeInput.value));

  // Effective view radius in NM (tracks slider AND manual pan/zoom) and the
  // too-wide banner: the feed only covers MAX_VIEW_NM around home.
  let currentViewNm = vm.default;
  let suppressRangeSync = false; // set during scripted zooms (military fly-by)
  const banner = document.getElementById('wide-banner');
  let lastSentView;
  let viewTimer = null;
  let pendingViewKey = null; // key the currently-armed debounce timer will send
  function onViewChanged() {
    const b = map.getBounds();
    const c = map.getCenter();
    const east = b.getEast();
    const north = b.getNorth();
    const halfW = distNm(c.lat, c.lng, c.lat, east);
    const halfH = distNm(c.lat, c.lng, north, c.lng);
    currentViewNm = Math.min(halfW, halfH);

    // Keep the top-right slider in sync with mouse-wheel/pinch zoom: the
    // label shows the true view miles, the thumb clamps to slider range.
    if (!suppressRangeSync && !draggingRange) {
      const trueNm = Math.round(currentViewNm);
      const clamped = Math.max(vm.min, Math.min(vm.max, trueNm));
      if (Number(rangeInput.value) !== clamped) {
        rangeInput.value = clamped;
        localStorage.setItem('overhead-view-nm', String(clamped));
      }
      // guard the write: this runs per moveend, which the tracking camera
      // fires many times a second
      if (rangeVal.textContent !== String(trueNm)) rangeVal.textContent = trueNm;
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
    // An unchanged pending key must let the timer FIRE, not reset it: the
    // tracking camera fires moveend every frame, and resetting per frame
    // starved this debounce forever — the server was never told to poll the
    // region and the tracked flight died a spurious TRACK LOST.
    if (key === pendingViewKey) return;
    pendingViewKey = key;
    clearTimeout(viewTimer);
    viewTimer = setTimeout(() => {
      pendingViewKey = null;
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

  function postView(v) {
    fetch('/view', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(v),
    }).catch(() => {});
  }

  // Re-assert an active view region every 2 min — the server expires regions
  // after 5 min so a vanished browser can't leave it double-polling forever.
  let lastDesiredView = null;
  setInterval(() => {
    if (paused) return; // hidden embed: no keepalives at all
    if (lastDesiredView) {
      fetch('/view', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(lastDesiredView),
      }).catch(() => {});
    }
    // Re-assert home too: a restarted server falls back to the placeholder
    // until a client reminds it (it holds home in memory only).
    if (!isPlaceholderHome(HOME[0], HOME[1])) {
      fetch('/home', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lat: HOME[0], lon: HOME[1] }),
      }).catch(() => {});
    }
  }, 120000);

  // Click/tap an aircraft to show its data block for a few seconds. On a
  // touch display there is no hover, so a tap that misses every aircraft
  // falls through to the airport markers and shows their info card instead.
  let airportTap = null; // { a, until }
  // Blocks placed by the last frame, best-rank-first (set in frame()).
  let blockRects = [];

  // Pointer hits reuse the screen positions the last frame already computed
  // (t.px) instead of re-projecting every target per event. That also keeps
  // the hit target exactly where the icon was drawn, dead reckoning included.
  function targetAt(cx, cy, radius) {
    // a data block is a much bigger target than a 15 px icon — check those
    // first, in paint order, so clicking a block selects its aircraft
    for (const b of blockRects) {
      if (cx >= b.bx && cx <= b.bx + b.w && cy >= b.by && cy <= b.by + b.h) {
        const t = targets.get(b.hex);
        if (t) return t;
      }
    }
    let best = null;
    let bestD = radius;
    for (const t of targets.values()) {
      if (!t.onScreen || !t.px) continue;
      const d = Math.hypot(t.px.x - cx, t.px.y - cy);
      if (d < bestD) { bestD = d; best = t; }
    }
    return best;
  }

  map.on('click', (e) => {
    if (suppressNextClick) { suppressNextClick = false; return; }
    const best = targetAt(e.containerPoint.x, e.containerPoint.y, 30);
    focusedHex = null; // touch has no reliable mouseleave — a map tap releases list isolation
    if (best) {
      /* A tap toggles the data block, full stop. It used to be a three-state
         walk — tap for 7 s, tap again to pin, tap a pinned one to clear — so
         dismissing a block you had only just opened meant tapping twice or
         waiting the timer out. Showing is now sticky (no timer to sit through)
         and one tap takes it away again.

         The tracked flight is included: following an aircraft and reading its
         block are separate wants, and a tap here hides the block WITHOUT
         releasing the track. detailHidden is what outranks the pin that
         startTracking sets; it is cleared whenever tracking starts or stops so
         a fresh follow always opens with its details up. */
      // blockShown is what the renderer last actually drew, so this toggles
      // against reality — including blocks the display rules put up on their
      // own (MILITARY, OVERHEAD, DATA:ALL), which a pin-only test would miss.
      const showing = best.blockShown || best.pinned || (best.detailUntil || 0) > Date.now();
      if (showing) {
        best.pinned = false;
        best.detailUntil = 0;
        best.detailHidden = true;
      } else {
        best.pinned = true;
        best.detailUntil = 0;
        best.detailHidden = false;
      }
      return;
    }
    airportTap = null;
    if (layers.airports) {
      syncProjection(); // pointer events fire between frames
      const showSmall = currentViewNm <= 17;
      let aD = 24;
      for (const a of airports) {
        if (a.type === 'small_airport' && !showSmall) continue;
        const p = toPx(a.lat, a.lon);
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
    const best = targetAt(e.containerPoint.x, e.containerPoint.y, 26);
    hoveredHex = best ? best.meta.hex : null;
    // Airports second — an aircraft over the field wins the hover. Only match
    // markers actually drawn (small fields hide beyond the 20 mi view).
    hoveredAirport = null;
    if (!best && layers.airports) {
      syncProjection(); // pointer events fire between frames
      const showSmall = currentViewNm <= 17;
      let aD = 18;
      for (const a of airports) {
        if (a.type === 'small_airport' && !showSmall) continue;
        const p = toPx(a.lat, a.lon);
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
    if (tracked) return; // an explicit track owns the camera — no scripted zooms
    if (!layers.milzoom) return; // scripted camera moves are opt-out (layers panel)
    if (document.hidden) return; // rAF is frozen — flyTo would strand mid-flight
    if (milZoom.active || now - milZoom.lastAt < 60000) return;
    if ((milAlerted.get(ac.hex) || 0) > now - 1800000) return; // 30 min per airframe
    if (distNm(HOME[0], HOME[1], ac.lat, ac.lon) > MAX_VIEW_NM) return;
    milZoom.active = true;
    milZoom.lastAt = now;
    milAlerted.set(ac.hex, now);
    const returnMiles = Number(rangeInput.value); // view to restore afterwards
    /* Where the camera actually was, not just how far out it was zoomed.
       The restore below used to call applyRange, which recenters on HOME — so
       a passing military contact would yank someone who had panned off to
       another field all the way back home and leave them there. */
    const returnCenter = map.getCenter();
    const returnZoom = map.getZoom();
    suppressRangeSync = true;
    const nm = 3;
    alertNote = {
      text: `${ac.emerg ? 'EMERGENCY SQUAWK' : 'MILITARY CONTACT'} · ${ac.callsign || ac.reg || ac.hex.toUpperCase()} — TAP MAP TO DISMISS`,
      until: now + 15000,
    };
    map.flyToBounds(L.latLngBounds([
      project(ac.lat, ac.lon, 0, nm), project(ac.lat, ac.lon, 180, nm),
      project(ac.lat, ac.lon, 90, nm), project(ac.lat, ac.lon, 270, nm),
    ]), { duration: 1.6 });
    milZoom.timer = setTimeout(() => {
      rangeInput.value = returnMiles;
      rangeVal.textContent = returnMiles;
      if (tracked) {
        // a follow started during the fly-by owns the camera: hand it the scale
        // and let it centre itself, rather than flying back to a stale spot
        applyRange(returnMiles);
      } else {
        map.flyTo(returnCenter, returnZoom, { duration: 1.2 });
      }
      suppressRangeSync = false;
      milZoom.active = false;
    }, 15000);
  }
  // Any user touch during the fly-by hands the camera back immediately.
  map.getContainer().addEventListener('pointerdown', () => {
    if (!milZoom.active) return;
    clearTimeout(milZoom.timer);
    milZoom.active = false;
    suppressRangeSync = false;
    alertNote = { text: '', until: 0 };
  });

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
  // `icao` is a label-format switch rather than a visibility one, but it lives
  // with the layers because that is where the AIRPORTS switch is — and it only
  // means anything when airports are drawn. ICAO is the default: it is what
  // charts and controllers use, and it is the only system every field has.
  const LAYER_DEFAULTS = { aircraft: true, trails: true, blocks: true, airports: false, airspace: false, rings: true, scale: true, milzoom: true, icao: true, maplabels: true, vectors: true, conflict: true };
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
  let airspaceLoading = false;
  async function loadAirspace() {
    if (airspaceLoading) return;
    airspaceLoading = true;
    try {
      const r = await fetch(`/airspace?lat=${HOME[0]}&lon=${HOME[1]}&radius_nm=${config.radius_nm || 43}`);
      const g = await r.json().catch(() => null);
      // A dark layer with no explanation is indistinguishable from a broken
      // toggle — say why, on the glass, since a kiosk has no console.
      if (!r.ok || !g || g.error) {
        flashAlert('AIRSPACE UNAVAILABLE — ' + (g?.error || `HTTP ${r.status}`));
        return;
      }
      if (!g.features || !g.features.length) {
        flashAlert('NO CLASS B/C/D AIRSPACE IN RANGE (US COVERAGE ONLY)');
        return;
      }
      if (airspaceLayer) map.removeLayer(airspaceLayer);
      airspaceLayer = L.geoJSON(g, {
        style: (f) => {
          const s = AIRSPACE_STYLE[f.properties?.CLASS] || { color: '#7a8a99', dash: '3 5' };
          return { color: s.color, weight: 1.3, dashArray: s.dash, fill: false, opacity: 0.75 };
        },
      });
      if (layers.airspace) airspaceLayer.addTo(map);
    } catch (err) {
      flashAlert('AIRSPACE UNAVAILABLE — ' + (err.message || 'network error'));
    } finally {
      airspaceLoading = false;
    }
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
    if (name === 'maplabels') applyBasemap();
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
  // Basemap picker. It sits with the layers because that is where every
  // other "what is drawn" switch lives.
  const basemapSelect = document.getElementById('basemap-select');
  basemapList.forEach((p) => {
    const opt = document.createElement('option');
    opt.value = p.id;
    opt.textContent = p.label;
    opt.title = p.note;
    basemapSelect.appendChild(opt);
  });
  basemapSelect.value = currentBasemap().id;
  basemapSelect.addEventListener('change', () => setBasemap(basemapSelect.value));

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
    if (paused) return;   // display:none iframes still run their intervals
    const bounds = map.getBounds();
    const inView = [];
    for (const t of targets.values()) {
      if (!listGround && t.fix.onGround) continue;
      if (!bounds.contains([t.shown.lat, t.shown.lon])) continue;
      inView.push(t);
    }
    const countLabel = `\u2708 IN VIEW \u00b7 ${inView.length}`;
    if (listToggle.textContent !== countLabel) listToggle.textContent = countLabel;
    if (!listPanel.classList.contains('open')) return;
    // Distances and ordering are only spent on an open panel — with it closed
    // (the kiosk's normal state) the count above is all this tick owes.
    const rows = inView.map((t) => [distNm(HOME[0], HOME[1], t.shown.lat, t.shown.lon), t]);
    rows.sort((a, b) => a[0] - b[0]);
    // keep rows stable under the cursor — except when the ground toggle just
    // changed (the pointer is necessarily inside the panel then)
    if (listHovered && !force) return;
    if (!rows.length) {
      const li = document.createElement('li');
      li.className = 'empty';
      li.textContent = feedState.ok ? 'NO AIRCRAFT IN VIEW \u2014 QUIET SKY' : 'NO DATA \u2014 FEED DOWN';
      listEl.replaceChildren(li);
      return;
    }
    listEl.replaceChildren(...rows.map(([d, t]) => {
      const m = t.meta;
      const li = document.createElement('li');
      const dNmShown = d;
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
      dist.textContent = `${dNmShown.toFixed(1)} nm`;
      l1.appendChild(dist);
      const l2 = document.createElement('div');
      l2.className = 'l2';
      // same vocabulary as the data blocks: flight levels up high, one glyph
      // for missing data
      const alt = t.fix.onGround ? 'GROUND' : (fmtAlt(t.fix.alt) || `ALT ${NO_DATA}`);
      l2.textContent = [m.type || NO_DATA, alt, m.operator || ''].filter(Boolean).join(' · ');
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
    const open = homePanel.classList.toggle('open');
    // the other three toggles already mirror their panel state; this one did
    // not, so HOME was the only button that never looked active
    homeToggle.classList.toggle('open', open);
    if (open) {
      renderHomeHistory();
      homeInput.focus();
    }
  });

  // First run on this device with no real home anywhere: open the panel and
  // say why, instead of confidently rendering someone else's sky (SEA).
  if (isPlaceholderHome(HOME[0], HOME[1])) {
    homePanel.classList.add('open');
    homeToggle.classList.add('open');
    homeMsg.textContent = 'SET YOUR LOCATION TO BEGIN';
  }

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
      body: JSON.stringify({ lat, lon, explicit: true }),
    });
    if (!save.ok) throw new Error('could not save home');
    HOME = [lat, lon];
    localStorage.setItem('overhead-home', JSON.stringify({ lat, lon, label }));
    stopTracking(); // the tracked flight belongs to the old sky
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

  // ------------------------------------------------------- find & track flight
  // ⌖ FIND (top left): search the live targets by callsign / tail / hex and
  // follow the pick. Long-pressing an aircraft on the map (or its data block)
  // tracks it directly. The camera keeps the flight centered; a manual drag
  // "peeks" away for a few seconds, then the follow resumes. Release via the
  // panel's STOP button or by long-pressing the tracked aircraft again.
  const findToggle = document.getElementById('find-toggle');
  const findPanel = document.getElementById('find-panel');
  const findInput = document.getElementById('find-input');
  const findResults = document.getElementById('find-results');
  const trackCard = document.getElementById('track-card');
  const trackWho = document.getElementById('track-who');
  const trackInfo = document.getElementById('track-info');
  const trackStop = document.getElementById('track-stop');
  const FIND_LABEL = '⌖ FIND';

  function closeFindPanel() {
    findPanel.classList.remove('open');
    findToggle.classList.remove('open');
  }
  // The three top-left panels (FIND, IN VIEW, HOME) share one spot on the
  // glass — opening one must put the others away or they stack unreadably
  // (HOME even auto-opens on first run and would paint over FIND).
  function closeSiblingPanels() {
    homePanel.classList.remove('open');
    homeToggle.classList.remove('open');
    if (listPanel.classList.contains('open')) {
      listPanel.classList.remove('open');
      listToggle.classList.remove('open');
      localStorage.setItem('overhead-panel-list', '0');
    }
  }
  listToggle.addEventListener('click', () => {
    if (listPanel.classList.contains('open')) {
      closeFindPanel();
      homePanel.classList.remove('open');
      homeToggle.classList.remove('open');
    }
  });
  homeToggle.addEventListener('click', () => {
    if (homePanel.classList.contains('open')) {
      closeFindPanel();
      if (listPanel.classList.contains('open')) {
        listPanel.classList.remove('open');
        listToggle.classList.remove('open');
        localStorage.setItem('overhead-panel-list', '0');
      }
    }
  });
  // The wall display has no keyboard: never steal focus into a box that
  // can't be typed in (and the empty-query nearest list below keeps the
  // panel fully usable by touch alone).
  const coarsePointer = window.matchMedia('(pointer: coarse)').matches;
  findToggle.addEventListener('click', () => {
    if (findBtnHeld) { findBtnHeld = false; return; } // the hold already released the track
    const open = findPanel.classList.toggle('open');
    findToggle.classList.toggle('open', open);
    if (open) {
      closeSiblingPanels();
      renderFind();
      updateTrackStatus();
      if (!tracked && !coarsePointer) findInput.focus();
    }
  });

  // Search: compare compacted alphanumerics so "N 123AB" matches N123AB.
  // Exact > prefix > substring; an operator-name hit and a flight-number-only
  // hit (AS350 → callsign ASA350, digits equal) rank behind those.
  function findMatches(qRaw) {
    const q = qRaw.toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (!q) return [];
    const opQ = qRaw.trim().toUpperCase();
    const qDigits = (q.match(/\d+/) || [null])[0];
    const scored = [];
    for (const t of targets.values()) {
      const m = t.meta;
      let score = null;
      for (const c of [m.callsign, m.reg, m.hex.toUpperCase()]) {
        if (!c) continue;
        const cc = c.replace(/[^A-Z0-9]/g, '');
        if (cc === q) score = 0;
        else if (cc.startsWith(q)) score = Math.min(score ?? 9, 1);
        else if (cc.includes(q)) score = Math.min(score ?? 9, 2);
      }
      if (score == null && opQ.length >= 3 && m.operator &&
          m.operator.toUpperCase().includes(opQ)) score = 3;
      if (score == null && qDigits && q !== qDigits && m.callsign) {
        const cd = (m.callsign.match(/\d+/) || [])[0];
        if (cd === qDigits) score = 4; // IATA-style "AS350" vs callsign "ASA350"
      }
      if (score != null) {
        scored.push([score, distNm(HOME[0], HOME[1], t.shown.lat, t.shown.lon), t]);
      }
    }
    scored.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    return scored.slice(0, 8);
  }

  // Empty query: the nearest airborne flights, so the panel works with no
  // keyboard at all (the wall display) — open, then tap a row.
  function nearestAirborne() {
    const rows = [];
    for (const t of targets.values()) {
      if (t.fix.onGround) continue;
      rows.push([0, distNm(HOME[0], HOME[1], t.shown.lat, t.shown.lon), t]);
    }
    rows.sort((a, b) => a[1] - b[1]);
    return rows.slice(0, 8);
  }

  function findRowText(t) {
    const m = t.meta;
    const alt = t.fix.onGround ? 'GROUND' : (fmtAlt(t.fix.alt) || `ALT ${NO_DATA}`);
    return [m.type || NO_DATA, alt, m.operator || ''].filter(Boolean).join(' · ');
  }
  // Membership and ORDER freeze once rendered; only the live numbers update
  // in place (refreshFind below). Re-sorting under an approaching finger made
  // a tap land on the wrong flight — worst possible misfire, the camera
  // immediately flies to it.
  function renderFind() {
    if (!findPanel.classList.contains('open')) return;
    const matches = findInput.value.trim()
      ? findMatches(findInput.value)
      : nearestAirborne();
    if (!matches.length) {
      const li = document.createElement('li');
      li.className = 'empty';
      li.textContent = !feedState.ok ? 'NO DATA — FEED DOWN'
        : findInput.value.trim() ? 'NO MATCH AMONG LIVE AIRCRAFT IN COVERAGE'
        : 'QUIET SKY — NO AIRBORNE AIRCRAFT IN COVERAGE';
      findResults.replaceChildren(li);
      return;
    }
    findResults.replaceChildren(...matches.map(([, d, t]) => {
      const m = t.meta;
      const li = document.createElement('li');
      li.dataset.hex = m.hex;
      if (m.mil) li.classList.add('mil');
      else if (m.police) li.classList.add('police');
      const l1 = document.createElement('div');
      l1.className = 'l1';
      l1.textContent = m.callsign && m.reg && m.callsign !== m.reg
        ? `${m.callsign} · ${m.reg}` : (m.callsign || m.reg || m.hex.toUpperCase());
      const dist = document.createElement('span');
      dist.className = 'dist';
      dist.textContent = `${d.toFixed(1)} nm`;
      l1.appendChild(dist);
      const l2 = document.createElement('div');
      l2.className = 'l2';
      l2.textContent = findRowText(t);
      li.append(l1, l2);
      // resolve at tap time — the row may outlive the target
      li.addEventListener('click', () => {
        const live = targets.get(m.hex);
        if (live) startTracking(live);
      });
      return li;
    }));
  }
  // In-place refresh: update distances/altitudes on the frozen rows, dim rows
  // whose target left the feed. Only an empty list rebuilds (aircraft may
  // have arrived since the panel opened).
  function refreshFind() {
    if (!findPanel.classList.contains('open')) return;
    const rows = findResults.querySelectorAll('li[data-hex]');
    if (!rows.length) { renderFind(); return; }
    for (const li of rows) {
      const t = targets.get(li.dataset.hex);
      if (!t) { li.classList.add('gone'); continue; }
      li.classList.remove('gone');
      const d = distNm(HOME[0], HOME[1], t.shown.lat, t.shown.lon);
      li.querySelector('.dist').textContent = `${d.toFixed(1)} nm`;
      li.querySelector('.l2').textContent = findRowText(t);
    }
  }
  findInput.addEventListener('input', renderFind);
  findInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const m = findInput.value.trim() ? findMatches(findInput.value) : nearestAirborne();
      if (m.length) startTracking(m[0][2]);
    } else if (e.key === 'Escape') {
      closeFindPanel();
    }
  });
  setInterval(() => { if (!paused) refreshFind(); }, 1000);

  let trackStartAt = 0; // a drag mid-long-press must not instantly pause the new track
  function startTracking(t) {
    const label = t.meta.callsign || t.meta.reg || t.meta.hex.toUpperCase();
    if (tracked && tracked.hex === t.meta.hex) {
      // Re-picking the flight you already track means "take me back to it",
      // not "release it" — release lives on long-press and the STOP button.
      trackPeekUntil = 0;
      closeFindPanel();
      flashAlert(`⌖ ALREADY TRACKING ${label}`, 3000);
      return;
    }
    if (tracked) { // switching targets: unpin the old one
      const prev = targets.get(tracked.hex);
      if (prev) prev.pinned = false;
    }
    // An in-flight military fly-by must hand the camera over completely,
    // including its delayed "return to home view" timer.
    if (milZoom.active) {
      clearTimeout(milZoom.timer);
      milZoom.active = false;
      suppressRangeSync = false;
      alertNote = { text: '', until: 0 };
    }
    tracked = { hex: t.meta.hex, label };
    trackPeekUntil = 0;
    trackPanX = trackPanY = 0;
    trackStartAt = Date.now();
    t.pinned = true; // the tracked flight opens with its data block up
    t.detailHidden = false; // a new follow starts fresh, whatever the last one ended as
    findToggle.classList.add('tracking');
    closeFindPanel();
    flashAlert(`⌖ TRACKING ${label} — HOLD ⌖ (TOP LEFT) TO RELEASE`, 6000);
    updateTrackStatus();
    wakeFrame();
  }
  function stopTracking(msg, ms = 5000) {
    if (!tracked) return;
    const t = targets.get(tracked.hex);
    if (t) { t.pinned = false; t.detailUntil = 0; t.detailHidden = false; }
    tracked = null;
    findToggle.classList.remove('tracking');
    if (msg) flashAlert(msg, ms);
    updateTrackStatus();
  }
  trackStop.addEventListener('click', () => {
    stopTracking(`TRACKING RELEASED — ${tracked ? tracked.label : ''}`);
    renderFind();
    applyRange(Number(rangeInput.value)); // glide the stranded camera home
  });
  // Hold the amber button to release instantly — the same muscle memory as
  // long-pressing an aircraft, no panel round-trip.
  let findBtnHeld = false; // consumed by the click handler above
  let findBtnTimer = null;
  findToggle.addEventListener('pointerdown', () => {
    findBtnHeld = false;
    if (!tracked) return;
    findBtnTimer = setTimeout(() => {
      findBtnHeld = true;
      stopTracking(`TRACKING RELEASED — ${tracked ? tracked.label : ''}`);
      applyRange(Number(rangeInput.value));
    }, 550);
  });
  const cancelFindBtnHold = () => { clearTimeout(findBtnTimer); findBtnTimer = null; };
  findToggle.addEventListener('pointerup', cancelFindBtnHold);
  findToggle.addEventListener('pointerleave', cancelFindBtnHold);
  findToggle.addEventListener('contextmenu', (e) => e.preventDefault());

  // The top-left button doubles as the live status readout while tracking.
  function updateTrackStatus() {
    trackCard.classList.toggle('show', !!tracked);
    if (!tracked) {
      if (findToggle.textContent !== FIND_LABEL) findToggle.textContent = FIND_LABEL;
      return;
    }
    const t = targets.get(tracked.hex);
    if (!t) return; // the frame loop declares the loss
    const d = distNm(HOME[0], HOME[1], t.shown.lat, t.shown.lon);
    // figure-space pad: 9.8 → 10.2 NM must not reflow the whole control row
    findToggle.textContent = `⌖ ${tracked.label} · ${d.toFixed(1).padStart(5, ' ')} NM`;
    if (!findPanel.classList.contains('open')) return;
    const m = t.meta;
    trackWho.textContent = `⌖ ${tracked.label}${m.operator ? ' · ' + m.operator : ''}`;
    const alt = t.fix.onGround ? 'GROUND' : (fmtAlt(t.fix.alt) || `ALT ${NO_DATA}`);
    const gs = Number.isFinite(t.fix.gs) ? `${Math.round(t.fix.gs)} kt` : `${NO_DATA} kt`;
    trackInfo.textContent = [m.type || NO_DATA, alt, gs, `${d.toFixed(1)} NM FROM HOME`].join(' · ');
  }
  setInterval(() => { if (!paused) updateTrackStatus(); }, 1000);

  // A manual drag while following means "let me look around": pause the
  // follow instead of fighting the gesture. The countdown restarts on every
  // drag tick, so it effectively runs from release, and a drag that lands
  // within the first moments of a fresh track (finger still down from the
  // long-press) doesn't instantly pause what it just started.
  map.on('dragstart', () => {
    cancelLongPress(); // a real drag is never a long-press
    if (!tracked || Date.now() - trackStartAt < 700) return;
    trackPeekUntil = Date.now() + 5000;
    flashAlert('FOLLOW PAUSED — RESUMES 5 S AFTER RELEASE', 2500);
  });
  map.on('drag', () => {
    if (tracked && trackPeekUntil > Date.now()) trackPeekUntil = Date.now() + 5000;
  });
  // pinch-zoom fires zoom, not drag — extend an active peek there too
  map.on('zoom', () => {
    if (tracked && trackPeekUntil > Date.now()) trackPeekUntil = Date.now() + 5000;
  });

  // Long-press an aircraft (map icon or its data block) to track it. Pointer
  // events cover mouse and touch; real movement cancels so a map drag that
  // happens to start on a target never triggers a track. The slop is wider
  // for touch — a finger held 550 ms on a wall panel wobbles more than 8 px.
  const LONG_PRESS_MS = 550;
  let lp = null;
  const mapContainer = map.getContainer();
  mapContainer.addEventListener('pointerdown', (e) => {
    suppressNextClick = false; // stale suppression must not eat this tap
    if (e.button !== 0) return;
    const rect = mapContainer.getBoundingClientRect();
    const t = targetAt(e.clientX - rect.left, e.clientY - rect.top, 30);
    if (!t) return;
    // A resting finger near a busy airport must not lock onto a parked
    // airframe; flagged traffic (military/police/emergency) stays trackable.
    const flagged = t.meta.mil || t.meta.police || t.meta.emerg || t.meta.cg;
    if (t.fix.onGround && !flagged) return;
    if (lp) clearTimeout(lp.timer);
    const hex = t.meta.hex;
    lp = {
      sx: e.clientX,
      sy: e.clientY,
      slop: e.pointerType === 'touch' ? 14 : 8,
      timer: setTimeout(() => {
        lp = null;
        const live = targets.get(hex); // may have been pruned during the hold
        if (!live) return;
        suppressNextClick = true; // the pointerup's click is part of this gesture
        if (tracked && tracked.hex === hex) {
          stopTracking(`TRACKING RELEASED — ${tracked.label}`);
        } else {
          startTracking(live);
        }
      }, LONG_PRESS_MS),
    };
  });
  const cancelLongPress = () => {
    if (!lp) return;
    clearTimeout(lp.timer);
    lp = null;
  };
  mapContainer.addEventListener('pointermove', (e) => {
    if (lp && Math.hypot(e.clientX - lp.sx, e.clientY - lp.sy) > lp.slop) cancelLongPress();
  });
  mapContainer.addEventListener('pointerup', cancelLongPress);
  mapContainer.addEventListener('pointercancel', cancelLongPress);
  mapContainer.addEventListener('touchstart', (e) => {
    if (e.touches.length >= 2) cancelLongPress(); // a pinch is never a long-press
  }, { passive: true });
  // a touch long-press must feed the gesture, not the browser context menu
  mapContainer.addEventListener('contextmenu', (e) => e.preventDefault());

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

  // TODAY: the server's log of the day's sky (/today) — every aircraft once,
  // how many came overhead, military, emergencies, and the busy hours. The
  // server keeps it, so a kiosk reload or a second screen shows the same day.
  let todayData = null;
  const todayCanvas = document.getElementById('today-canvas');
  const todayCtx = todayCanvas.getContext('2d');
  const todaySum = document.getElementById('today-sum');
  const todayStats = document.getElementById('today-stats');
  async function loadToday() {
    try {
      const r = await fetch('/today');
      if (r.ok) todayData = await r.json();
    } catch { /* keep the last one */ }
    renderToday();
  }
  function renderToday() {
    const d = todayData;
    if (!d) return;
    todaySum.textContent = `${d.aircraft.toLocaleString()} SEEN`;
    const parts = [
      `<span class="ovhd"><b>${d.overhead}</b> OVERHEAD</span>`,
      d.military ? `<span class="mil"><b>${d.military}</b> MILITARY</span>` : '',
      d.emergencies ? `<span class="mil"><b>${d.emergencies}</b> EMERGENCY</span>` : '',
      d.busiestHour != null ? `BUSIEST <b>${String(d.busiestHour).padStart(2, '0')}:00</b>` : '',
    ].filter(Boolean);
    const lines = [parts.join(' · ')];
    if (d.topType) lines.push(`MOST SEEN <b>${d.topType[0]}</b> ×${d.topType[1]} · ${d.types} TYPES`);
    if (d.onlyOnce.length) lines.push(`ONLY ONCE <b>${d.onlyOnce.join(', ')}</b>`);
    todayStats.innerHTML = lines.join('<br>');
    if (!bwChart.classList.contains('open')) return;
    const dpr = window.devicePixelRatio || 1;
    const W = 306, H = 44;
    if (todayCanvas.width !== W * dpr) {
      todayCanvas.width = W * dpr;
      todayCanvas.height = H * dpr;
      todayCanvas.style.width = W + 'px';
      todayCanvas.style.height = H + 'px';
    }
    todayCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    todayCtx.clearRect(0, 0, W, H);
    const max = Math.max(1, ...d.hours);
    const nowH = new Date().getHours();
    const slot = W / 24;
    for (let i = 0; i < 24; i++) {
      const n = d.hours[i];
      todayCtx.globalAlpha = i > nowH ? 0.2 : 1; // hours still to come
      todayCtx.fillStyle = COLORS.chartMuted;
      todayCtx.fillRect(i * slot + 1, H - 1, slot - 2, 1);
      if (!n) continue;
      const t = n / max;
      todayCtx.globalAlpha = i === nowH ? 0.6 : 0.95; // this hour is still filling
      todayCtx.fillStyle = n === max ? COLORS.chartPeak : lerpHex(COLORS.chartLow, COLORS.chartHigh, t);
      const h = Math.max(2, t * (H - 4));
      todayCtx.beginPath();
      todayCtx.roundRect(i * slot + 1, H - h, slot - 2, h, 2);
      todayCtx.fill();
    }
    todayCtx.globalAlpha = 1;
  }
  loadToday();
  setInterval(() => { if (!paused) loadToday(); }, 60000);

  // Settings panel always starts closed — open state is not persisted
  bwEl.addEventListener('click', () => {
    bwChart.classList.toggle('open');
    drawBwChart();
    drawBwBars();
    if (bwChart.classList.contains('open')) loadToday();
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
    high: 'Full 100 mi area polled every 3 s',
    medium: 'Inner 10 nm ~6 s · full sweep every 15 s (~70% less data)',
    low: 'Inner 10 nm ~12 s · full sweep every 45 s (~90% less data)',
  };
  let bwMode = 'high';
  let bwModePendingUntil = 0; // ignore stale broadcasts briefly after a local tap
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
    bwModePendingUntil = Date.now() + 5000;
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
    if (payload.bandwidthMode && payload.bandwidthMode !== bwMode &&
        Date.now() > bwModePendingUntil) { // a just-tapped mode must not snap back
      bwMode = payload.bandwidthMode; // server is authoritative otherwise
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
      if ((ac.mil || ac.emerg) &&
          !(existing && existing.meta && (existing.meta.mil || existing.meta.emerg)) && !milCandidate) {
        milCandidate = ac; // newly appeared military or emergency target
      }
      const prevFix = existing && existing.fix;
      const fix = {
        lat: ac.lat, lon: ac.lon,
        // Keep "no groundspeed" distinguishable from "stopped". The old
        // `ac.gs || 0` collapsed the two, and the data block then printed
        // "0 kt" under a target that was plainly moving across the scope.
        gs: Number.isFinite(ac.gs) ? ac.gs : null,
        // motion uses real track only — heading points the nose, not the
        // path (crab angle), so it must never feed the projection. hdg is a
        // display-only fallback applied at icon-rotation time.
        track: ac.track ?? (prevFix ? prevFix.track : ac.hdg ?? 0),
        hasTrack: ac.track != null,
        hdg: ac.hdg ?? null,
        alt: ac.alt, vr: ac.vr, onGround: ac.onGround,
        at: Date.now() - (ac.seenPos ? ac.seenPos * 1000 : 0),
        turnRate: 0, accel: 0,
      };
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
        // turn rate only from two REAL tracks — a track->heading source flip
        // reads the crab angle as a phantom turn
        if (dtFix > 1.5 && dtFix < 60 && fix.hasTrack && prevFix.hasTrack) {
          fix.turnRate = Math.max(-6, Math.min(6, shortestArc(prevFix.track, fix.track) / dtFix));
          // Both speeds must be real: null - null is NaN, and a NaN accel
          // propagates into projectState and freezes the target.
          fix.accel = Number.isFinite(fix.gs) && Number.isFinite(prevFix.gs)
            ? Math.max(-3, Math.min(3, (fix.gs - prevFix.gs) / dtFix))
            : 0;
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
        // A followed aircraft keeps its whole track: the point of following one
        // is watching where it has been, and the normal cap threw that away
        // after trail_length fixes. TRAIL_MAX is only a memory backstop for a
        // panel that runs for weeks — hours of following stay well under it.
        const cap = tracked && tracked.hex === ac.hex ? TRAIL_MAX : (config.trail_length || 40);
        while (t.trail.length > cap) t.trail.shift();
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
  // (red/yellow), police (blue/white). Cache per theme (cleared in applyTheme).
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
  // Density-aware canvas metrics: COMPACT shrinks the data blocks, tag bands,
  // airport cards, and icons along with the DOM chrome. Assigned before first
  // use via refreshDensityMetrics (never leave these to TDZ ordering).
  let MONO, MONO_BOLD, TAG_FONT, RING_FONT;
  let BLOCK_PADX, BLOCK_LINE_H, BLOCK_PAD_TOP, TAG_H, ICON_K;
  const tagWidthCache = new Map();   // band label → px at the current TAG_FONT
  function refreshDensityMetrics(mode) {
    const wall = mode === 'wall', compact = mode === 'compact';
    const px = compact ? 11.5 : wall ? 17 : 13;
    MONO = `${px}px ui-monospace, "SF Mono", Menlo, Consolas, monospace`;
    MONO_BOLD = `700 ${px}px ui-monospace, "SF Mono", Menlo, Consolas, monospace`;
    TAG_FONT = `700 ${compact ? 10 : wall ? 13.5 : 11}px ui-monospace, "SF Mono", Menlo, monospace`;
    RING_FONT = `${compact ? 9.5 : wall ? 12.5 : 10.5}px ui-monospace, "SF Mono", Menlo, monospace`;
    BLOCK_PADX = compact ? 9 : wall ? 15 : 12;
    BLOCK_LINE_H = compact ? 16 : wall ? 24 : 19;
    BLOCK_PAD_TOP = compact ? 6 : wall ? 10 : 8;
    TAG_H = compact ? 17 : wall ? 25 : 20;
    ICON_K = compact ? 0.88 : wall ? 1.2 : 1;
    tagWidthCache.clear();                            // widths were for the old font
    for (const t of targets.values()) t.bwKey = null; // fonts changed — remeasure blocks
  }
  refreshDensityMetrics('comfortable');

  // UI density (macOS Settings style): COMFY default, COMPACT tightens both
  // the DOM chrome (body.compact CSS) and the canvas content above.
  const densityBtns = [...document.querySelectorAll('#density-row .seg button')];
  function applyDensity(mode) {
    document.body.classList.toggle('compact', mode === 'compact');
    document.body.classList.toggle('wall', mode === 'wall');
    refreshDensityMetrics(mode);
    densityBtns.forEach((b) => b.classList.toggle('active', b.dataset.density === mode));
    localStorage.setItem('overhead-density', mode);
    map.invalidateSize(); // the header height changed, so the stage did too
    resize();
  }
  densityBtns.forEach((b) => b.addEventListener('click', () => applyDensity(b.dataset.density)));
  {
    const m = localStorage.getItem('overhead-density');
    applyDensity(m === 'compact' || m === 'wall' ? m : 'comfortable');
  }

  // Base palettes live in web/styles.js (BASE_INKS) with the map styles, so
  // tools/check-styles.js measures the same inks the scope paints. A style
  // overrides some of them per theme; see currentInks().
  const THEMES = MAPSTYLES.BASE_INKS;
  let COLORS = THEMES.dark;
  let styleFx = {};   // the live style's effects; the sweep is drawn per frame

  // The ramp swatches are the key to the altitude shading, so they have to be
  // repainted from whichever palette is live.
  const legendSwatches = [...document.querySelectorAll('#alt-legend .ramp i')];
  function paintAltLegend() {
    legendSwatches.forEach((el, i) => { el.style.background = COLORS.altBands[i]; });
  }

  // Style + theme → everything that paints: the scope's inks, the chrome's
  // custom properties, the SVG filters the tiles run through, the effect
  // layer, and the tiles themselves. One entry point, because they are one
  // system — tools/check-styles.js measures the inks against the map colours
  // they will actually sit on.
  const styleDefs = document.querySelector('#style-filters defs');
  const fxLayers = document.querySelector('#map-fx .fx-layers');
  const fxGrain = document.querySelector('#map-fx .fx-grain');
  const { CHROME_VARS } = MAPSTYLES;
  function paintFx(fx) {
    const bg = [];
    if (fx.scan) bg.push(`repeating-linear-gradient(to bottom, rgba(0,0,0,${fx.scan}) 0 1px, transparent 1px 3px)`);
    if (fx.vignette) bg.push(`radial-gradient(ellipse at 50% 50%, transparent 55%, rgba(0,0,0,${fx.vignette}) 100%)`);
    if (fx.wash) bg.push(`linear-gradient(to bottom, ${hexA(fx.wash[0], 0)}, ${hexA(fx.wash[1], fx.wash[2])})`);
    if (fx.grid) {
      const c = hexA(fx.grid.color, fx.grid.op), z = fx.grid.size;
      bg.push(`repeating-linear-gradient(to right, ${c} 0 1px, transparent 1px ${z}px)`,
        `repeating-linear-gradient(to bottom, ${c} 0 1px, transparent 1px ${z}px)`);
    }
    fxLayers.style.background = bg.join(', ');
    // Halftone is a tiled dot, so it needs its own size; it rides on the
    // grain element's background stack (below the noise) to keep one blend.
    const g = [];
    if (fx.grain) {
      g.push(`url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='180' height='180'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='.85' numOctaves='2' stitchTiles='stitch'/><feColorMatrix type='saturate' values='0'/></filter><rect width='100%25' height='100%25' filter='url(%23n)' opacity='${fx.grain.op * 4}'/></svg>")`);
    }
    if (fx.halftone) g.push(`radial-gradient(${hexA(fx.halftone.color, fx.halftone.op * 3)} 0.9px, transparent 1.4px) 0 0 / 5px 5px`);
    fxGrain.style.background = g.join(', ');
    fxGrain.style.mixBlendMode = fx.grain?.blend || 'normal';
    fxGrain.style.opacity = fx.grain ? '0.25' : '0.33';
  }
  function applyLook() {
    const half = styleHalf();
    const st = MAPSTYLES.byId(styleId);
    COLORS = half ? MAPSTYLES.inksFor(st, themeName) : THEMES[themeName];
    paintAltLegend();
    stripeCache = {}; // livery patterns bake theme colors — rebuild lazily
    const prev = lookPrefix;
    lookPrefix = `ms${++lookGen}`;
    if (half) styleDefs.insertAdjacentHTML('beforeend', MAPSTYLES.filterDefs(st, themeName, lookPrefix));
    // Outlive the crossfade (400 ms) before the previous look's filters go.
    setTimeout(() => styleDefs.querySelectorAll(`[id^="${prev}-"]`).forEach((n) => n.remove()), 600);
    const vars = half ? MAPSTYLES.chromeVars(half, COLORS) : {};
    if (typeof paintSwatches === 'function' && swatchBox) paintSwatches();
    for (const k of CHROME_VARS) {
      if (vars[k]) document.body.style.setProperty(k, vars[k]);
      else document.body.style.removeProperty(k);
    }
    styleFx = half?.fx || {};
    paintFx(styleFx);
    applyBasemap();
  }

  // Sun elevation at home, in degrees — the standard low-precision solar
  // position (good to ~0.1°, far inside what a theme switch needs).
  function sunElevation(lat, lon, date = new Date()) {
    const r = Math.PI / 180;
    const d = (date.getTime() - Date.UTC(2000, 0, 1, 12)) / 864e5;
    const g = (357.529 + 0.98560028 * d) * r;
    const q = 280.459 + 0.98564736 * d;
    const L = (q + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * r;
    const e = (23.439 - 0.00000036 * d) * r;
    const ra = Math.atan2(Math.cos(e) * Math.sin(L), Math.cos(L));
    const dec = Math.asin(Math.sin(e) * Math.sin(L));
    const gmst = (18.697374558 + 24.06570982441908 * d) % 24;
    const H = (gmst * 15 + lon) * r - ra;
    return Math.asin(Math.sin(lat * r) * Math.sin(dec) + Math.cos(lat * r) * Math.cos(dec) * Math.cos(H)) / r;
  }
  // AUTO follows the sun at home: light from civil dawn (sun above −4°) to
  // civil dusk, dark otherwise. GOLDEN / BLUE HOUR was drawn for exactly
  // this — its two halves are the two ends of the day.
  const THEME_GLYPH = { dark: '☾', light: '☀', auto: '◐' };
  const THEME_TITLE = { dark: 'Dark theme — tap for light', light: 'Light theme — tap for auto', auto: 'Auto theme follows the sun at home — tap for dark' };
  let themeMode = 'dark';
  const resolveTheme = (mode) => (mode === 'auto' ? (sunElevation(HOME[0], HOME[1]) > -4 ? 'light' : 'dark') : mode);
  const themeToggle = document.getElementById('theme-toggle');
  function applyTheme(mode) {
    themeMode = THEME_GLYPH[mode] ? mode : 'dark';
    const name = resolveTheme(themeMode);
    document.body.classList.toggle('light', name === 'light');
    themeName = name;
    themeToggle.textContent = THEME_GLYPH[themeMode];
    themeToggle.title = THEME_TITLE[themeMode];
    localStorage.setItem('overhead-theme', themeMode);
    applyLook();
  }
  themeToggle.addEventListener('click', () => {
    applyTheme(themeMode === 'dark' ? 'light' : themeMode === 'light' ? 'auto' : 'dark');
  });
  // Re-check once a minute; only repaint when dusk or dawn actually passes.
  setInterval(() => {
    if (themeMode === 'auto' && resolveTheme('auto') !== themeName) applyTheme('auto');
  }, 60000);

  // Style picker, beside the basemap one in the LAYERS panel. A style that is
  // built for a particular source (SWISS RELIEF needs the hillshade, ORBITAL
  // the imagery) moves the basemap there when it is picked; the basemap
  // picker still overrides it afterwards. Leaving that style goes back to the
  // basemap you chose yourself — otherwise one look at ORBITAL would leave the
  // wall pulling imagery-weight tiles under every style after it.
  const styleSelect = document.getElementById('style-select');
  STYLE_LIST.forEach((st) => {
    const opt = document.createElement('option');
    opt.value = st.id;
    opt.textContent = st.label;
    opt.title = st.note;
    styleSelect.appendChild(opt);
  });
  const styleNote = document.getElementById('style-note');
  // Which basemap a style should sit on: its own preference, else the one
  // you picked, else whatever is up — never one a failover has already found
  // dead (picking a style during an outage used to send the wall straight
  // back to the provider that was down).
  //
  // Falls back to the list's first healthy provider, NOT to whatever is on
  // screen: what is on screen may be the previous style's preference, and
  // keeping it meant one look at ORBITAL left every later style pulling
  // satellite tiles.
  function resolveBasemap(st, announce) {
    const ok = (pid) => pid && basemapList.some((p) => p.id === pid) && !recentlyFailed(pid);
    const userPick = localStorage.getItem('overhead-basemap-user');
    const target = ok(st.prefers) ? st.prefers : ok(userPick) ? userPick
      : (basemapList.find((p) => !recentlyFailed(p.id)) || basemapList[0]).id;
    if (target === basemapId) return;
    basemapId = target;
    localStorage.setItem('overhead-basemap', target);
    // Marks the stored basemap as the style's doing, so the boot migration
    // below never mistakes it for a choice you made.
    localStorage.setItem('overhead-basemap-auto', '1');
    // Say it: the basemap moving under you is otherwise a silent side effect.
    if (announce) flashAlert(`${st.label} · BASEMAP → ${currentBasemap().label}`, 5000);
  }
  // Swatches: every style as a tappable chip — its water, land and lowest
  // altitude band for the current theme — so choosing is seeing, on a touch
  // panel where a native dropdown shows eleven names and no pictures.
  const swatchBox = document.getElementById('style-swatches');
  const CLASSIC_CHIP = { dark: ['#131c26', '#2c3742', '#38bdff'], light: ['#b8c6c8', '#f0ece3', '#0a7fd9'] };
  function paintSwatches() {
    swatchBox.textContent = '';
    for (const st of STYLE_LIST) {
      const half = st[themeName];
      const [w, l, b] = st.classic ? CLASSIC_CHIP[themeName]
        : [half.map.water, half.map.land, MAPSTYLES.inksFor(st, themeName).altBands[0]];
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'swatch';
      btn.setAttribute('role', 'radio');
      btn.setAttribute('aria-checked', String(st.id === styleId));
      btn.setAttribute('aria-label', st.label);
      btn.title = st.label;
      btn.style.background = `linear-gradient(135deg, ${w} 0 48%, ${l} 48% 78%, ${b} 78%)`;
      btn.addEventListener('click', () => setStyle(st.id));
      swatchBox.appendChild(btn);
    }
  }
  function showStyle(st) {
    styleSelect.value = st.id;
    styleSelect.title = st.note;
    // Touch screens never show a title tooltip, so the description is text.
    styleNote.textContent = st.note;
  }
  function setStyle(id) {
    if (!STYLE_LIST.some((st) => st.id === id)) return;
    styleId = id;
    localStorage.setItem('overhead-style', id);
    const st = MAPSTYLES.byId(id);
    showStyle(st);
    resolveBasemap(st, true);
    applyLook();
    // A provider with no styled source (the keyed CARTO entry) draws CLASSIC
    // whatever is picked — say so rather than appear to ignore the choice.
    if (!st.classic && !currentBasemap().styled) {
      flashAlert(`${st.label} NEEDS A KEYLESS BASEMAP — ${currentBasemap().label} STAYS CLASSIC`, 6000);
    }
  }
  styleSelect.addEventListener('change', () => setStyle(styleSelect.value));
  // Boot. A basemap chosen before styles existed only ever lived in
  // 'overhead-basemap'; adopt it as the user's pick, or the first style
  // change would replace it for good. Then give the starting style its
  // preferred source — a panel set up through config.style never calls
  // setStyle, and SWISS RELIEF without the hillshade is just beige.
  if (!localStorage.getItem('overhead-basemap-user') && localStorage.getItem('overhead-basemap') &&
      !localStorage.getItem('overhead-basemap-auto')) {
    localStorage.setItem('overhead-basemap-user', localStorage.getItem('overhead-basemap'));
  }
  showStyle(MAPSTYLES.byId(styleId));
  resolveBasemap(MAPSTYLES.byId(styleId), false);
  applyTheme(localStorage.getItem('overhead-theme') || 'dark');

  // ATC full data block, top to bottom: who / how high / how fast + what.
  // Altitude is the field a controller reads first, so it owns line 2 —
  // it used to trail model and operator on line 4.
  function blockLines(t) {
    const m = t.meta;
    const id = m.callsign && m.reg && m.callsign !== m.reg
      ? `${m.callsign} · ${m.reg}`
      : (m.callsign || m.reg || m.hex.toUpperCase());

    const gs = Number.isFinite(t.fix.gs) ? `${Math.round(t.fix.gs)} kt` : `${NO_DATA} kt`;
    const type = m.type || NO_DATA;
    // Squawk 1200 is the US VFR code: nobody is talking to that aircraft, and
    // a controller reads it differently from an IFR target at the same spot.
    const speedType = `${gs} · ${type}${m.squawk === '1200' ? ' · VFR' : ''}`;
    // The ICAO designator above is compact but unreadable unless you know the
    // codes, so the airframe description gets its own line ("B38M" over
    // "Boeing 737 Max 8"). Skipped when the feed has no description, which
    // keeps the block short rather than padding it with a dash.
    const model = m.model && m.model !== m.type ? m.model : null;

    let alt;
    if (t.fix.onGround) alt = 'GROUND';
    else {
      const shown = fmtAlt(t.fix.alt);
      if (shown == null) alt = `ALT ${NO_DATA}`;
      else {
        // structured so the trend arrow can carry its own color.
        // A missing vertical rate gets no arrow at all. The feed simply does
        // not always carry one, and "→" is a claim — it says the aircraft
        // is holding its altitude. This is the same distinction the fix above
        // draws for groundspeed: an absent field must never be rendered as a
        // confirmed zero.
        const vs = !Number.isFinite(t.fix.vr) ? 'unknown'
          : t.fix.vr > 250 ? 'up' : t.fix.vr < -250 ? 'down' : 'flat';
        alt = {
          pre: shown + (vs === 'unknown' ? '' : '  '),
          arrow: vs === 'up' ? '↑' : vs === 'down' ? '↓' : vs === 'flat' ? '→' : '',
          vs,
          post: '',
        };
      }
    }
    // Trailing detail lines are optional: a block only grows for aircraft the
    // feed actually knows something about.
    const lines = [id, alt, speedType];
    if (model) lines.push(model);
    if (m.operator) lines.push(m.operator);
    return lines;
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
    t.bwPx = w + BLOCK_PADX * 2;
    return t.bwPx;
  }

  function blockTag(opts) {
    const { overhead, mil, police, cg, emerg, squawk } = opts;
    if (!(overhead || mil || police || emerg)) return null;
    return emerg ? `E M E R G E N C Y${squawk ? ' · ' + squawk : ''}`
      : cg && overhead ? 'C G · O V E R H E A D' : cg ? 'C O A S T · G U A R D'
      : mil && overhead ? 'M I L · O V E R H E A D' : mil ? 'M I L I T A R Y'
      : police && overhead ? 'P O L I C E · O V E R H E A D' : police ? 'P O L I C E'
      : 'O V E R H E A D';
  }

  // Outer size of a block, so placement can reason about rectangles before
  // anything is drawn. Must stay in step with drawBlock's own geometry.
  function blockSize(lines, opts) {
    const tag = blockTag(opts);
    const tagH = tag ? TAG_H : 0;
    let w = opts.width;
    if (tag) {
      // the band label can out-measure the data lines (COAST·GUARD over a
      // callsign-only block) — widen so the label pill never overflows.
      // Measured once per distinct tag, not per frame: measureText on every
      // tagged block every frame was a steady cost for strings that never change.
      let tw = tagWidthCache.get(tag);
      if (tw === undefined) {
        ctx.font = TAG_FONT;
        tw = Math.ceil(ctx.measureText(tag).width);
        tagWidthCache.set(tag, tw);
      }
      w = Math.max(w, tw + BLOCK_PADX * 2);
    }
    return { w, h: BLOCK_PAD_TOP * 2 + BLOCK_LINE_H * lines.length + tagH - 4 };
  }

  // Leader-line deconfliction. A real scope offsets a block rather than letting
  // it bury a neighbour, so each one gets a ranked list of candidate positions
  // around its target and takes the first that lands clear. Emergency and
  // selected targets are placed first, so they keep the preferred slot and
  // everyone else routes around them.
  const PLACE_GAP = 26; // horizontal standoff from the icon
  // Which side each block last landed on, keyed by hex, and how far past centre
  // a target must travel before that side is allowed to change. Without this
  // the preferred side is a bare `x < centre` test, so a target sitting on the
  // centre line — exactly where camera-follow pins the tracked flight — crosses
  // the midpoint every frame on sub-pixel drift and its block strobes between
  // the two sides of the icon. The on-glass bounds check below still overrides
  // a sticky side that would run the block off the edge.
  const blockSide = new Map(); // hex -> 'r' | 'l'
  const SIDE_HYST = 60;        // px past centre before the preferred side flips
  function placeBlocks(queue) {
    queue.sort((a, b) => a.rank - b.rank);
    const placed = [];
    const overlaps = (a, b) =>
      a.bx < b.bx + b.w + 4 && a.bx + a.w + 4 > b.bx &&
      a.by < b.by + b.h + 4 && a.by + a.h + 4 > b.by;

    for (const item of queue) {
      const { w, h } = blockSize(item.lines, item.opts);
      item.w = w;
      item.h = h;
      // prefer the side with more room, then step vertically before flipping;
      // inside the deadband hold whichever side this block used last frame
      const mid = canvas.clientWidth / 2;
      const prev = blockSide.get(item.hex);
      const preferRight = item.x < mid - SIDE_HYST ? true
        : item.x > mid + SIDE_HYST ? false
        : prev ? prev === 'r' : item.x < mid;
      const xs = preferRight ? [item.x + PLACE_GAP, item.x - PLACE_GAP - w]
        : [item.x - PLACE_GAP - w, item.x + PLACE_GAP];
      const dys = [0, -h - 12, h + 12, -(h + 12) * 2, (h + 12) * 2];
      let best = null;
      for (const dy of dys) {
        for (const bx of xs) {
          const cand = { bx, by: item.y - h / 2 + dy, w, h };
          // keep the block on the glass
          if (cand.bx < 2 || cand.bx + w > canvas.clientWidth - 2) continue;
          if (cand.by < 2 || cand.by + h > canvas.clientHeight - 2) continue;
          if (placed.some((p) => overlaps(cand, p))) continue;
          best = cand;
          break;
        }
        if (best) break;
      }
      // every candidate collided: fall back to the preferred spot so the block
      // is still drawn (a missing block is worse than a crowded one)
      if (!best) best = { bx: xs[0], by: item.y - h / 2, w, h };
      item.bx = best.bx;
      item.by = best.by;
      // remember where it actually landed, not what it preferred: if crowding
      // pushed the block across the icon it should stay there rather than fight
      // its way back the moment the neighbour clears.
      blockSide.set(item.hex, best.bx >= item.x ? 'r' : 'l');
      placed.push(best);
    }
    // drop sides for aircraft that no longer draw a block, so the map tracks
    // what is on the glass instead of every hex seen since load
    if (blockSide.size > queue.length) {
      const live = new Set(queue.map((i) => i.hex));
      for (const hex of blockSide.keys()) if (!live.has(hex)) blockSide.delete(hex);
    }
  }

  function drawBlock(x, y, bx, by, lines, opts) {
    const { dimmed, mil, police, cg, emerg, overhead, highlight, alpha = 1 } = opts;
    const padX = BLOCK_PADX, lineH = BLOCK_LINE_H, padTop = BLOCK_PAD_TOP;
    const tag = blockTag(opts);
    const tagged = !!tag;
    const tagH = tagged ? TAG_H : 0;
    const { w, h } = blockSize(lines, opts);
    ctx.font = MONO;
    // leader attaches on whichever side of the block faces the target
    const side = bx >= x ? 'right' : 'left';

    const edge = (mil || emerg) ? COLORS.milEdge : police ? COLORS.policeEdge
      : overhead ? COLORS.amberEdge : COLORS.blockEdge;
    const bg = (mil || emerg) ? COLORS.milBg : police ? COLORS.policeBg
      : overhead ? COLORS.amberBg : COLORS.blockBg;
    // clicked or list-highlighted: lighter, heavier border (tag band keeps
    // its normal color so MIL/POLICE bands don't wash out)
    const borderEdge = highlight ? lerpHex(edge, '#ffffff', COLORS.hiMix) : edge;

    ctx.globalAlpha = alpha * (dimmed ? 0.55 : 1);

    // Leader line from the target to the facing edge of the block. Deconflicted
    // blocks sit above or below their target, so the attach point slides along
    // that edge instead of always leaving from its midpoint.
    const attachX = side === 'right' ? bx : bx + w;
    const attachY = Math.max(by + 6, Math.min(by + h - 6, y));
    ctx.strokeStyle = highlight ? borderEdge : tagged ? edge : COLORS.leader;
    ctx.lineWidth = highlight ? 1.8 : 1.2;
    ctx.beginPath();
    ctx.moveTo(x + (side === 'right' ? 12 : -12), y);
    ctx.lineTo(attachX, attachY);
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
      ctx.roundRect(bx, by, w, tagH, [3, 3, 0, 0]);
      ctx.fill();
      ctx.font = TAG_FONT;
      ctx.textBaseline = 'middle';
      if (cg || police) {
        // solid dark pill under the label — a halo alone washes out on the
        // light stripes
        const tw = ctx.measureText(tag).width;
        ctx.fillStyle = 'rgba(4,7,12,0.78)';
        ctx.beginPath();
        ctx.roundRect(bx + padX - 5, by + 3, tw + 10, tagH - 6, (tagH - 6) / 2);
        ctx.fill();
        ctx.fillStyle = '#f5f7fa';
        ctx.fillText(tag, bx + padX, by + tagH / 2 + 0.5);
      } else {
        ctx.fillStyle = COLORS.tagText;
        ctx.fillText(tag, bx + padX, by + tagH / 2 + 0.5);
      }
      ty += tagH;
    }

    // An emergency reads in the alert palette too — it used to get ordinary
    // traffic text inside a red EMERGENCY frame.
    const palette = (mil || emerg) ? COLORS.textMil : police ? COLORS.textPolice
      : overhead ? COLORS.textOverhead : COLORS.textNormal;
    ctx.textBaseline = 'top';
    lines.forEach((s, i) => {
      ctx.font = i === 0 ? MONO_BOLD : MONO;
      // Blocks can now run to five lines; the palettes hold four, so the last
      // colour carries the trailing detail lines instead of leaving fillStyle
      // undefined (which silently reuses whatever colour drew previously).
      const color = dimmed ? COLORS.dim : palette[Math.min(i, palette.length - 1)];
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
    const homePt = toPx(HOME[0], HOME[1], { x: 0, y: 0 });
    for (const rNm of config.rings_nm || []) {
      const [eLat, eLon] = project(HOME[0], HOME[1], 0, rNm);
      const edge = toPx(eLat, eLon);
      const rPx = Math.hypot(edge.x - homePt.x, edge.y - homePt.y);
      ctx.strokeStyle = COLORS.ring;
      ctx.setLineDash([2, 6]);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(homePt.x, homePt.y, rPx, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
      // Labels ride the lower-right diagonal rather than stacking at 12
      // o'clock, where they used to form a column over the map's own place
      // names. A short backing bar keeps them legible over any basemap.
      const a = Math.PI / 4;
      const lx = homePt.x + Math.cos(a) * rPx;
      const ly = homePt.y + Math.sin(a) * rPx;
      const label = `${rNm} NM`;
      ctx.font = RING_FONT;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const lw = ctx.measureText(label).width + 10;
      ctx.fillStyle = COLORS.ringLabelBg;
      ctx.beginPath();
      ctx.roundRect(lx - lw / 2, ly - 8, lw, 16, 8);
      ctx.fill();
      ctx.fillStyle = COLORS.ringText;
      ctx.fillText(label, lx, ly + 0.5);
      ctx.textAlign = 'left';
      ctx.textBaseline = 'alphabetic';
    }
    // outer limit of feed coverage: MAX_VIEW_NM around home
    {
      const [cLat, cLon] = project(HOME[0], HOME[1], 0, MAX_VIEW_NM);
      const edge = toPx(cLat, cLon);
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
      ctx.fillText(`${MAX_VIEW_NM} NM COVERAGE LIMIT`, homePt.x, homePt.y - rPx - 5);
      ctx.textAlign = 'left';
      ctx.globalAlpha = 1;
    }
  }

  // RADAR PHOSPHOR's sweep: a beam turning about home once every six
  // seconds with a fading afterglow behind it. Pure decoration, so reduced
  // motion removes it outright — a frozen wedge reads as a stuck display.
  const SWEEP_PERIOD_MS = 6000;
  const sweepAngle = (now) => ((now % SWEEP_PERIOD_MS) / SWEEP_PERIOD_MS) * Math.PI * 2 - Math.PI / 2;
  function drawSweep(now) {
    if (REDUCED_MOTION || typeof ctx.createConicGradient !== 'function') return;
    const p = toPx(HOME[0], HOME[1], { x: 0, y: 0 });
    const a = sweepAngle(now);
    // Canvas conic angles and the beam's cos/sin share one convention (0 =
    // east, clockwise), so the gradient starts AT the beam: its end stop
    // (1.0) is the leading edge and the afterglow fades out behind it. An
    // earlier −π/2 here — the CSS "0 = north" habit — put the glow a quarter
    // turn behind the line.
    const g = ctx.createConicGradient(a, p.x, p.y);
    const c = styleFx.sweep;
    g.addColorStop(0, hexA(c, 0));
    g.addColorStop(0.72, hexA(c, 0));
    g.addColorStop(0.995, hexA(c, 0.2));
    g.addColorStop(1, hexA(c, 0));
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, canvas.clientWidth, canvas.clientHeight);
    const r = Math.hypot(canvas.clientWidth, canvas.clientHeight);
    ctx.strokeStyle = hexA(c, 0.45);
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
    ctx.lineTo(p.x + Math.cos(a) * r, p.y + Math.sin(a) * r);
    ctx.stroke();
  }

  // Home marker draws regardless of the rings layer
  function drawHome() {
    const homePt = toPx(HOME[0], HOME[1]);
    ctx.save();
    ctx.translate(homePt.x, homePt.y);
    ctx.beginPath();
    ctx.moveTo(0, -9); ctx.lineTo(8, -1); ctx.lineTo(5, -1); ctx.lineTo(5, 7);
    ctx.lineTo(-5, 7); ctx.lineTo(-5, -1); ctx.lineTo(-8, -1);
    ctx.closePath();
    // Halo first, like every other symbol on the scope. Own-position used to
    // be a bare fill and disappeared into pale urban tiles — the one marker
    // that must never be hard to find.
    ctx.strokeStyle = COLORS.iconHalo;
    ctx.lineWidth = 3;
    ctx.lineJoin = 'round';
    ctx.stroke();
    ctx.fillStyle = COLORS.home;
    ctx.fill();
    ctx.restore();
  }

  // Vertical distance scale (nm), centered on the right edge
  function drawScale() {
    const W = canvas.clientWidth;
    const H = canvas.clientHeight;
    const c = map.getCenter();
    const p1 = toPx(c.lat, c.lng, { x: 0, y: 0 });
    const [nLat, nLon] = project(c.lat, c.lng, 0, 1); // 1 nm north
    const p2 = toPx(nLat, nLon);
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
    const showSmall = currentViewNm <= 17;
    const W = canvas.clientWidth;
    const H = canvas.clientHeight;
    ctx.font = '10px ui-monospace, "SF Mono", Menlo, monospace';
    ctx.textBaseline = 'middle';
    for (const a of airports) {
      if (a.type === 'small_airport' && !showSmall) continue;
      const p = toPx(a.lat, a.lon);
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
      // ICAO keeps one identifier system on the scope; the old `a.iata ||
      // a.ident` mixed two (BFI and PAE next to 00WA) so nothing read
      // consistently. IATA is available for the friendlier familiar codes,
      // and still falls back to the ident at fields that have no IATA code.
      ctx.fillText(layers.icao ? a.ident : (a.iata || a.ident), p.x + 9, p.y);
    }
    ctx.textBaseline = 'alphabetic';
  }

  // Hovering an airport marker shows a small info card (name, elevation, …)
  function drawAirportTip(a) {
    const pt = toPx(a.lat, a.lon, { x: 0, y: 0 });
    const kind = a.type.replace('_airport', '').toUpperCase();
    const distFromHomeNm = distNm(HOME[0], HOME[1], a.lat, a.lon);
    const lines = [
      a.iata && a.iata !== a.ident ? `${a.ident} · ${a.iata}` : a.ident,
      a.name,
      [a.muni, `${kind} AIRPORT`].filter(Boolean).join(' · '),
      `${a.elev != null ? `ELEV ${Math.round(a.elev).toLocaleString()} FT` : `ELEV ${NO_DATA}`} · ${distFromHomeNm.toFixed(1)} NM FROM HOME`,
    ];
    ctx.font = MONO;
    const padX = BLOCK_PADX, lineH = BLOCK_LINE_H, padTop = BLOCK_PAD_TOP;
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

  const trailBuckets = [[], [], [], [], [], []]; // reused per aircraft per frame
  // Predicted track: how far ahead each vector reaches. One minute is what a
  // terminal scope shows by default — far enough to see who is converging,
  // short enough not to paint the sky in lines.
  const VECTOR_MIN = config.vector_minutes ?? 1;
  // Conflict alert: two airborne aircraft inside this box. Real STARS
  // separation is 3 NM / 1,000 ft; the floor keeps it out of approach and
  // pattern traffic, where parallel finals sit 0.15 NM apart by design and
  // would alarm all day.
  const CA_NM = config.conflict_nm ?? 3;
  const CA_FT = config.conflict_ft ?? 1000;
  const CA_FLOOR_FT = config.conflict_floor_ft ?? 5000;
  let conflicts = [];             // [[hexA, hexB], …], refreshed twice a second
  let conflictAt = 0;
  const conflictSeen = new Set(); // pairs already announced on the banner
  function findConflicts() {
    const air = [];
    for (const t of targets.values()) {
      const f = t.fix;
      if (!t.onScreen || f.onGround || !Number.isFinite(f.alt) || f.alt < CA_FLOOR_FT) continue;
      air.push(t);
    }
    const out = [];
    for (let i = 0; i < air.length; i++) {
      for (let j = i + 1; j < air.length; j++) {
        const a = air[i], b = air[j];
        if (Math.abs(a.fix.alt - b.fix.alt) >= CA_FT) continue;
        if (distNm(a.shown.lat, a.shown.lon, b.shown.lat, b.shown.lon) >= CA_NM) continue;
        out.push([a.meta.hex, b.meta.hex]);
      }
    }
    const live = new Set(out.map((p) => p.join('|')));
    for (const [a, b] of out) {
      const key = `${a}|${b}`;
      if (conflictSeen.has(key)) continue;
      conflictSeen.add(key);
      const name = (hex) => { const m = targets.get(hex)?.meta; return m?.callsign || m?.reg || hex.toUpperCase(); };
      flashAlert(`CONFLICT ALERT · ${name(a)} / ${name(b)}`, 8000);
    }
    for (const k of conflictSeen) if (!live.has(k)) conflictSeen.delete(k);
    return out;
  }
  function drawConflicts(nowMs) {
    const on = REDUCED_MOTION || Math.floor(nowMs / 500) % 2 === 0;
    ctx.save();
    ctx.lineWidth = 1.6;
    ctx.font = TAG_FONT;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const [ha, hb] of conflicts) {
      const a = targets.get(ha), b = targets.get(hb);
      if (!a?.px || !b?.px || !a.onScreen || !b.onScreen) continue;
      ctx.strokeStyle = COLORS.mil;
      ctx.setLineDash([5, 4]);
      ctx.beginPath();
      ctx.moveTo(a.px.x, a.px.y);
      ctx.lineTo(b.px.x, b.px.y);
      ctx.stroke();
      ctx.setLineDash([]);
      if (on) {
        for (const t of [a, b]) {
          ctx.beginPath();
          ctx.arc(t.px.x, t.px.y, 17 * ICON_K, 0, Math.PI * 2);
          ctx.stroke();
        }
      }
      const mx = (a.px.x + b.px.x) / 2, my = (a.px.y + b.px.y) / 2;
      ctx.fillStyle = COLORS.mil;
      ctx.beginPath();
      ctx.roundRect(mx - 14, my - 9, 28, 18, 4);
      ctx.fill();
      ctx.fillStyle = luminanceOf(COLORS.mil) > 0.4 ? '#140f04' : '#ffffff';
      ctx.fillText('CA', mx, my + 0.5);
    }
    ctx.restore();
  }
  function luminanceOf(hex) {
    const n = parseInt(hex.slice(1), 16);
    const c = [n >> 16, (n >> 8) & 255, n & 255].map((v) => {
      v /= 255;
      return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  }

  let lastFrame = performance.now();
  function frame(now) {
    const dtF = Math.min((now - lastFrame) / 1000, 0.25);
    lastFrame = now;
    ctx.clearRect(0, 0, canvas.clientWidth, canvas.clientHeight);

    // Camera follow: glide the map so the tracked flight stays centered.
    // Runs BEFORE the projection sync so everything drawn this frame shares
    // the panned frame (a mid-frame pan would shear icons from their blocks).
    // Uses last frame's shown position — off by one frame, sub-pixel. The
    // exponential ease is framerate-independent and absorbs both the initial
    // jump to a far-away pick and the steady drift of a moving target; a user
    // drag pauses the follow via trackPeekUntil instead of fighting it.
    if (tracked) {
      const t = targets.get(tracked.hex);
      if (!t) {
        stopTracking(`⌖ SIGNAL LOST — ${tracked.label}`, 15000);
      } else if (Date.now() > trackPeekUntil && !draggingRange) {
        // With the AIRCRAFT layer off nothing updates t.shown — dead-reckon
        // here so the camera doesn't silently freeze on a stale position.
        if (!layers.aircraft) {
          const age = (Date.now() - t.fix.at) / 1000;
          const [la, lo] = projectState(t.fix, age);
          t.shown.lat = la;
          t.shown.lon = lo;
        }
        const p = map.latLngToContainerPoint([t.shown.lat, t.shown.lon]);
        const dx = p.x - canvas.clientWidth / 2;
        const dy = p.y - canvas.clientHeight / 2;
        const d = Math.hypot(dx, dy);
        const k = d > 2000 ? 1 : 1 - Math.exp(-dtF * 4);
        // Leaflet rounds panBy to whole pixels (and fires moveend even on a
        // zero pan) — accumulate sub-pixel motion and only pan when a real
        // pixel is due, otherwise the flight rides ~8 px off-center in 1 px
        // steps while zero-pans spam moveend every frame.
        trackPanX += dx * k;
        trackPanY += dy * k;
        const ix = Math.round(trackPanX);
        const iy = Math.round(trackPanY);
        if (ix || iy) {
          trackPanX -= ix;
          trackPanY -= iy;
          map.panBy([ix, iy], { animate: false });
        }
      }
    }
    syncProjection(); // one read of map state for every projection this frame

    if (styleFx.sweep) drawSweep(now);
    // Where the phosphor beam is this frame, so targets can light up as it
    // passes over them (see the icon pass below).
    const beamOn = !!styleFx.sweep && !REDUCED_MOTION;
    const beamA = beamOn ? sweepAngle(now) : 0;
    const homePx = beamOn ? { ...toPx(HOME[0], HOME[1]) } : null;
    if (layers.rings) drawRings();
    drawHome();
    if (layers.scale) drawScale();
    if (layers.airports && airports.length) drawAirports();

    let overheadCount = 0;
    let barOverhead = null; // the target named in the header while overhead
    let barNext = null;     // { t, sec } — the next one predicted to pass over
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
      const targetTrack = f.hasTrack
        ? f.track + (f.turnRate || 0) * Math.min(age, PROJECT_CAP_S)
        : (f.hdg ?? f.track); // no track broadcast (taxi/idle): orient to the nose
      t.shown.track += shortestArc(t.shown.track, targetTrack) * (1 - Math.exp(-dtF * 3));

      // own copy, not the scratch: this position is cached on the target for
      // hit-testing and must survive the trail loop's projections below
      const pt = toPx(t.shown.lat, t.shown.lon, t.px || (t.px = { x: 0, y: 0 }));
      if (pt.x < -200 || pt.y < -200 || pt.x > canvas.clientWidth + 200 || pt.y > canvas.clientHeight + 200) {
        t.onScreen = false;
        continue;
      }
      t.onScreen = true;

      const dHome = distNm(HOME[0], HOME[1], t.shown.lat, t.shown.lon);
      // "Overhead" = laterally close AND low enough to matter — a jet at
      // FL350 crossing the ring is an overflight, not an event.
      const overhead = !f.onGround && dHome <= (config.overhead_nm || 5) &&
        (f.alt == null || f.alt <= OVERHEAD_MAX_FT);
      if (overhead) {
        overheadCount++;
        // The one to name in the header: the lowest, since that is the one
        // you can hear.
        if (!barOverhead || (f.alt ?? 0) < (barOverhead.fix.alt ?? 0)) barOverhead = t;
      } else if (!f.onGround && Number.isFinite(f.gs) && f.gs > 40 &&
                 (f.alt == null || f.alt <= OVERHEAD_MAX_FT)) {
        // Next overhead: closest point of approach to home on the current
        // track and speed (flat earth is fine inside a few NM). An aircraft
        // that will pass inside the overhead ring within five minutes is
        // announced with its countdown.
        const k = Math.cos(HOME[0] * Math.PI / 180);
        const dx = (t.shown.lon - HOME[1]) * 60 * k, dy = (t.shown.lat - HOME[0]) * 60;
        const tr = t.shown.track * Math.PI / 180;
        const vx = (f.gs * Math.sin(tr)) / 3600, vy = (f.gs * Math.cos(tr)) / 3600;
        const tc = -(dx * vx + dy * vy) / (vx * vx + vy * vy);
        if (tc > 0 && tc < 300 && Math.hypot(dx + vx * tc, dy + vy * tc) <= (config.overhead_nm || 5) &&
            (!barNext || tc < barNext.sec)) {
          barNext = { t, sec: tc };
        }
      }
      const dimmed = f.onGround;
      const mil = !!t.meta.mil;
      const police = !!t.meta.police && !mil;
      const nowMs = Date.now();

      // trail: purely time-based fade — fully gone at trail_fade_seconds (60 s).
      // The followed aircraft is exempt: its track holds until the follow ends,
      // then the ordinary fade resumes and eats the backlog on later frames.
      const holdTrail = !!tracked && tracked.hex === t.meta.hex;
      if (!holdTrail) {
        while (t.trail.length && nowMs - t.trail[0].at > TRAIL_FADE_MS) t.trail.shift();
      }
      if (layers.trails && t.trail.length && !dimmed) {
        // trail carries the same altitude shade as its target, so a descending
        // arrival visibly cools off along its own track
        const base = mil ? COLORS.mil : police ? COLORS.police : overhead ? COLORS.amber
          : COLORS.altBands[altBandIndex(f.alt)];
        ctx.strokeStyle = base;
        ctx.lineWidth = 1.6;
        // Segments batch into 6 alpha buckets — one stroke() per bucket, not
        // per segment; a Pi 4 cannot afford 16k strokes/frame in a busy sky
        for (const b of trailBuckets) b.length = 0;
        let prev = false, prevX = 0, prevY = 0, prevAt = 0;
        for (let i = 0; i <= t.trail.length; i++) {
          const p = i < t.trail.length
            ? t.trail[i]
            : { lat: t.shown.lat, lon: t.shown.lon, at: nowMs };
          const cp = toPx(p.lat, p.lon);
          // don't connect across a suspension gap (tab hidden / laptop asleep,
          // no fixes recorded) — 90 s clears LOW mode's legit 45 s cadence
          if (prev && p.at - prevAt < 90000) {
            /* A held track must stay VISIBLE for its whole length. Fading it by
               age the normal way would keep every point and then draw the old
               ones at alpha 0 — retained, invisible, and pointless. So the
               followed aircraft grades from a legible floor up to full: you can
               still tell new track from old, but none of it disappears. */
            const age = nowMs - p.at;
            const a = holdTrail
              ? 0.5 * (0.55 + 0.45 * Math.max(0, 1 - age / TRAIL_FADE_MS))
              : Math.max(0, 1 - age / TRAIL_FADE_MS) * 0.5;
            if (a > 0.02) trailBuckets[Math.min(5, (a * 12) | 0)].push(prevX, prevY, cp.x, cp.y);
          }
          // cp is the shared scratch — copy the scalars before it is reused
          prev = true;
          prevX = cp.x;
          prevY = cp.y;
          prevAt = p.at;
        }
        for (let bi = 0; bi < 6; bi++) {
          const seg = trailBuckets[bi];
          if (!seg.length) continue;
          ctx.globalAlpha = (bi + 0.5) / 12;
          ctx.beginPath();
          for (let j = 0; j < seg.length; j += 4) {
            ctx.moveTo(seg[j], seg[j + 1]);
            ctx.lineTo(seg[j + 2], seg[j + 3]);
          }
          ctx.stroke();
        }
        ctx.globalAlpha = 1;
      }

      // Predicted track: a straight line to where this aircraft will be in
      // VECTOR_MIN minutes at its current groundspeed and track.
      if (layers.vectors && !f.onGround && Number.isFinite(f.gs) && f.gs > 40) {
        const [vLat, vLon] = project(t.shown.lat, t.shown.lon, t.shown.track, (f.gs * VECTOR_MIN) / 60);
        const vp = toPx(vLat, vLon);
        ctx.save();
        ctx.strokeStyle = mil ? COLORS.mil : police ? COLORS.police : overhead ? COLORS.amber
          : COLORS.altBands[altBandIndex(f.alt)];
        ctx.globalAlpha = 0.75;
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.moveTo(pt.x, pt.y);
        ctx.lineTo(vp.x, vp.y);
        ctx.stroke();
        ctx.restore();
      }

      // Phosphor paint: a target glows as the beam crosses it and fades over
      // the next 1.5 s, the way a real PPI's afterglow shows a return. The
      // positions still move on the feed, not the beam — this is the look,
      // honestly labelled as such in the style's note.
      if (beamOn) {
        const bearing = Math.atan2(pt.y - homePx.y, pt.x - homePx.x);
        const behind = (((beamA - bearing) % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
        const sinceMs = (behind / (Math.PI * 2)) * SWEEP_PERIOD_MS;
        const glow = Math.max(0, 1 - sinceMs / 1500);
        if (glow > 0.01) {
          ctx.save();
          ctx.globalAlpha = glow * 0.55;
          ctx.fillStyle = styleFx.sweep;
          ctx.beginPath();
          ctx.arc(pt.x, pt.y, 16 * ICON_K, 0, Math.PI * 2);
          ctx.fill();
          ctx.restore();
        }
      }

      // icon — Coast Guard flashes red/yellow, police red/blue (steady
      // yellow/blue under prefers-reduced-motion); other military solid red.
      // Stripes live on the data block's tag band, not the airframe.
      ctx.save();
      ctx.translate(pt.x, pt.y);
      const flashOn = !REDUCED_MOTION && Math.floor(nowMs / 800) % 2 === 1;
      // Status colors (emergency / military / police / overhead) always win —
      // they mean "look here". Everything else is shaded by altitude band.
      const iconColor =
        // 7500/7600/7700: red and a partner. CLASSIC flashes red/white; a
        // style picks a partner that stands off its own map and its own
        // altitude bands (white vanished on every light style's ground).
        t.meta.emerg ? (flashOn ? (COLORS.emergFlash || COLORS.policeWhite) : COLORS.mil)
        : t.meta.cg ? (flashOn ? COLORS.mil : COLORS.amber)
        : mil ? COLORS.mil
        : police ? (flashOn ? COLORS.mil : COLORS.police)
        : dimmed ? COLORS.dim : overhead ? COLORS.amber
        : COLORS.altBands[altBandIndex(f.alt)];

      // Declutter: parked and taxiing traffic at a big airport piles into an
      // unreadable blob once the view is wide. Ordinary ground targets keep a
      // presence as a small dot and only earn their full silhouette up close.
      // Anything flagged (military, police, emergency) always draws in full —
      // decluttering must never hide the targets worth noticing.
      const flagged = mil || police || t.meta.emerg || t.meta.cg;
      const asDot = dimmed && !flagged && currentViewNm > 8;
      if (asDot) {
        ctx.fillStyle = COLORS.dim;
        ctx.beginPath();
        ctx.arc(0, 0, 2.2 * ICON_K, 0, Math.PI * 2);
        ctx.fill();
      } else {
        ctx.rotate((t.shown.track * Math.PI) / 180);
        if (ICON_K !== 1) ctx.scale(ICON_K, ICON_K);
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
      }
      ctx.restore();

      // Selection ring on the scope itself. Picking a target used to change
      // only its data-block border — and once blocks are deconflicted the
      // block can sit well away from the icon, so the selection was easy to
      // lose. Pinned reads solid; a timed 7 s pick reads dashed.
      const isTracked = !!tracked && t.meta.hex === tracked.hex;
      const pinned = !!t.pinned;
      const picked = pinned || (t.detailUntil || 0) > nowMs;
      if (isTracked) {
        // Tracking reticle: amber ring with four ticks — unmistakably
        // different from the plain selection ring.
        ctx.save();
        ctx.strokeStyle = COLORS.amber;
        ctx.lineWidth = 1.8;
        const r = 22 * ICON_K;
        ctx.beginPath();
        ctx.arc(pt.x, pt.y, r, 0, Math.PI * 2);
        ctx.stroke();
        ctx.beginPath();
        for (let q = 0; q < 4; q++) {
          const a = (q * Math.PI) / 2;
          ctx.moveTo(pt.x + Math.cos(a) * (r - 4), pt.y + Math.sin(a) * (r - 4));
          ctx.lineTo(pt.x + Math.cos(a) * (r + 5), pt.y + Math.sin(a) * (r + 5));
        }
        ctx.stroke();
        ctx.restore();
      } else if (picked) {
        ctx.save();
        ctx.strokeStyle = iconColor;
        ctx.lineWidth = pinned ? 1.8 : 1.2;
        if (!pinned) ctx.setLineDash([3, 4]);
        ctx.beginPath();
        ctx.arc(pt.x, pt.y, 18 * ICON_K, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      }

      // Data block: the top-left toggle decides — OVERHEAD shows blocks only
      // for aircraft inside the overhead ring, ALL for every airborne one.
      // Ground aircraft never show a block on their own (tap to toggle), but
      // airborne-and-slow is a hovering helicopter, not a parked plane.
      // Military targets always carry their block (any mode, even on ground);
      // Coast Guard is the exception — it follows the normal display rules
      let showBlock = layers.blocks &&
        (t.pinned || t.meta.emerg ||
         (mil && !t.meta.cg) || (!f.onGround && (dataMode === 'all' || overhead)));
      /* Tapped away by hand. Outranks the display rules above — including the
         pin a follow puts on its target — so you can track an aircraft without
         its block on screen. An EMERGENCY is never silenced this way. Hover
         and list-isolate below still reveal it on demand, which is what makes
         this safe to be sticky. */
      if (t.detailHidden && !t.meta.emerg) showBlock = false;
      let blockAlpha = 1;
      if (!showBlock && t.detailUntil) {
        const left = t.detailUntil - nowMs;
        if (left > 0) {
          showBlock = true;
          blockAlpha = Math.min(1, left / 600); // fade out over the last 0.6 s
        }
      }
      /* What a tap toggles against. A block can be up for reasons the click
         handler cannot see — MILITARY, OVERHEAD and DATA:ALL all raise one with
         no pin, and the aircraft list raises one for a few seconds — so testing
         the pin alone made the first tap on any of those do nothing visible.
         Recorded after those, but BEFORE the hover and list-isolate overrides
         below: a tap should toggle what is stickily on screen, not whatever the
         pointer is transiently revealing under itself. */
      t.blockShown = showBlock;
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
        const lines = blockLines(t);
        const highlight = t.pinned || (t.detailUntil || 0) > nowMs || t.meta.hex === focusedHex;
        const opts = {
          overhead, dimmed, mil, police, cg: !!t.meta.cg, emerg: !!t.meta.emerg,
          squawk: t.meta.squawk, highlight,
          alpha: blockAlpha, width: blockWidth(t, lines),
        };
        // rank decides who gets its preferred spot when blocks compete
        const rank = t.meta.emerg ? 0 : highlight ? 1 : mil || police ? 2 : overhead ? 3 : 4;
        blockQueue.push({ x: pt.x, y: pt.y, lines, opts, rank, hex: t.meta.hex });
      }
    }
    if (layers.conflict) {
      const nowC = Date.now();
      if (nowC - conflictAt > 500) { conflictAt = nowC; conflicts = findConflicts(); }
      if (conflicts.length) drawConflicts(nowC);
    } else if (conflicts.length) conflicts = [];
    placeBlocks(blockQueue);
    // placeBlocks leaves the queue sorted best-rank-first; paint in reverse so
    // the important blocks land on top if a fallback placement did overlap.
    for (let i = blockQueue.length - 1; i >= 0; i--) {
      const b = blockQueue[i];
      drawBlock(b.x, b.y, b.bx, b.by, b.lines, b.opts);
    }
    // Hand the placed rectangles to the pointer handlers: a data block is the
    // biggest thing on screen for a target, so it should be clickable too.
    // Best-rank-first order means the topmost block wins an overlap.
    blockRects = blockQueue;
    if (layers.airports) {
      if (airportTap && airportTap.until < Date.now()) airportTap = null;
      const tipAirport = hoveredAirport || (airportTap && airportTap.a);
      if (tipAirport) drawAirportTip(tipAirport);
    }

    updateBar(overheadCount, barOverhead, barNext);
    // Power: with an empty sky and an idle camera every frame is pixel-identical
    // — rings, home and scale only move with the map. Dropping to 4 fps there
    // takes the panel's steady-state GPU compositing down by ~93% for the hours
    // a 24/7 wall display spends showing nobody. Any map gesture, hover, or the
    // first aircraft in a fix (≤250 ms away) restores full rate.
    const idle = targets.size === 0 && !mapBusy && !milZoom.active &&
      !hoveredAirport && !airportTap &&
      // A turning sweep is motion; at the 4 fps idle rate it jumped ~15° a tick.
      !(styleFx.sweep && !REDUCED_MOTION);
    if (paused) rafId = null;
    else if (idle) {
      rafId = null;
      idleTimer = setTimeout(() => {
        idleTimer = null;
        if (!paused && rafId == null) rafId = requestAnimationFrame(frame);
      }, 250);
    } else rafId = requestAnimationFrame(frame);
  }
  let paused = false; // set by the kiosk shell below; declared before the loop starts
  let idleTimer = null;   // pending low-rate tick while the scene is static
  let mapBusy = false;    // any camera motion in flight
  // A gesture must land on a full-rate loop, not wait out an idle tick.
  const wakeFrame = () => {
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
      if (!paused && rafId == null) rafId = requestAnimationFrame(frame);
    }
  };
  map.on('movestart', () => { mapBusy = true; wakeFrame(); });
  map.on('zoomstart', () => { mapBusy = true; wakeFrame(); });
  map.on('moveend zoomend', () => { mapBusy = false; });
  canvas.addEventListener('pointermove', wakeFrame, { passive: true });
  canvas.addEventListener('pointerdown', wakeFrame, { passive: true });
  let rafId = requestAnimationFrame(frame);

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
      if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }  // no low-rate tick while hidden
      disconnectFeed();
      if (lastDesiredView) postView(null); // release the region: no double-poll for a hidden iframe
      return;
    }
    connectFeed();
    if (lastDesiredView) postView(lastDesiredView); // hand the panned region back
    lastFrame = performance.now(); // don't bill the pause to the first frame
    if (rafId == null) rafId = requestAnimationFrame(frame); // never double the loop
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
    icao: (on) => setLayer('icao', on),
    maplabels: (on) => setLayer('maplabels', on),
    basemap: (id) => setBasemap(id),
    style: (id) => setStyle(id),
    vectors: (on) => setLayer('vectors', on),
    conflict: (on) => setLayer('conflict', on),
    list: () => listToggle.click(),
    settings: () => bwEl.click(),
  };
  window.addEventListener('message', (e) => {
    const msg = e.data;
    if (!msg || msg.source !== 'edge-loader') return;
    if (msg.type === 'visibility') { setPaused(!msg.visible); return; }
    // Own properties only: 'constructor' or '__proto__' from a confused shell
    // used to resolve to Object's own methods and throw "APP ERROR" on glass.
    if (msg.type === 'command' && typeof msg.cmd === 'string' && Object.hasOwn(SHELL_COMMANDS, msg.cmd)) {
      SHELL_COMMANDS[msg.cmd](msg.on);
    }
  });
  // Panels tidy themselves on a kiosk. Someone taps LAYERS on the wall,
  // changes a switch and walks away; the panel then covered a third of the
  // map for days. Embedded, open panels close after two minutes without a
  // touch (panel_autoclose_seconds; 0 turns it off). Closing goes through each
  // panel's own toggle, so the closed state persists like a manual close.
  if (EMBED) {
    const idleMs = (config.panel_autoclose_seconds ?? 120) * 1000;
    let lastTouch = Date.now();
    for (const ev of ['pointerdown', 'keydown', 'wheel']) {
      window.addEventListener(ev, () => { lastTouch = Date.now(); }, { passive: true, capture: true });
    }
    const panels = [['layers-panel', 'layers-toggle'], ['list-panel', 'list-toggle'],
      ['home-panel', 'home-toggle'], ['find-panel', 'find-toggle']];
    if (idleMs > 0) setInterval(() => {
      if (Date.now() - lastTouch < idleMs) return;
      for (const [p, t] of panels) {
        if (document.getElementById(p)?.classList.contains('open')) document.getElementById(t)?.click();
      }
    }, 5000);
  }

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
    overheadStat: document.getElementById('overhead-stat'),
    detail: document.getElementById('bar-detail'),
    chip: document.getElementById('overhead-chip'),
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
  // Header detail beside the counts: name the aircraft overhead, or count
  // down to the next one. Read from across a room, "SWA2291 · B38M" beats
  // "1 OVERHEAD", and a countdown turns the wall into something you glance
  // at before stepping outside to look up.
  const nameOf = (m) => m.callsign || m.reg || m.hex.toUpperCase();
  function barDetail(ov, next) {
    if (ov) {
      const m = ov.meta;
      const alt = ov.fix.onGround ? 'GND' : fmtAlt(ov.fix.alt);
      return [nameOf(m), m.type, alt && alt.toUpperCase()].filter(Boolean).join(' · ');
    }
    if (next) {
      const s = Math.max(0, Math.round(next.sec));
      return `NEXT ${nameOf(next.t.meta)} IN ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
    }
    return '';
  }
  function updateBar(overheadCount, ov, next) {
    const detail = barDetail(ov, next);
    setText(el.detail, 'detail', detail ? ` · ${detail}` : '');
    // With nothing overhead or on the way, the wall chip shows the day so far.
    const quiet = !detail && todayData
      ? `TODAY · ${todayData.aircraft.toLocaleString()} AIRCRAFT · ${todayData.overhead} OVERHEAD` : '';
    setText(el.chip, 'chip', ov ? `OVERHEAD · ${detail}` : detail || quiet);
    if (cached.detailOv !== !!ov) {
      cached.detailOv = !!ov;
      el.detail.classList.toggle('now', !!ov);
      el.chip.classList.toggle('now', !!ov);
    }
    if (cached.chipOn !== !!(detail || quiet)) {
      cached.chipOn = !!(detail || quiet);
      el.chip.classList.toggle('show', cached.chipOn);
    }
    setText(el.count, 'count', String(targets.size));
    setText(el.overhead, 'overhead', String(overheadCount));
    // "Something is overhead right now" is the whole point of the product, and
    // it used to be styled exactly like the total-aircraft count beside it —
    // indistinguishable from four metres away, which is the only distance this
    // display is ever read from. Amber is already the app's word for overhead
    // (the data blocks use it), so the header now speaks the same language.
    const anyOverhead = overheadCount > 0;
    if (cached.overheadOn !== anyOverhead) {
      cached.overheadOn = anyOverhead;
      el.overheadStat.classList.toggle('active', anyOverhead);
    }
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
    // On-glass alert banner: stale feed and fly-by notes show even with every
    // panel closed (and in embed mode, which hides the header bar entirely).
    const note = cls === 'bad' ? `FEED STALE ${Math.round(stale / 1000)}s — SHOWING LAST KNOWN POSITIONS`
      : (alertNote.until > Date.now() ? alertNote.text : '');
    if (cached.alert !== note) {
      cached.alert = note;
      alertEl.textContent = note;
      alertEl.classList.toggle('show', !!note);
      alertEl.classList.toggle('bad', cls === 'bad');
    }
  }
  const alertEl = document.getElementById('alert-banner');
  // One formatter for the life of the page: toLocaleTimeString constructs a
  // fresh Intl.DateTimeFormat per call (~0.5 ms on an A76), and this fires 4×/s.
  const clockFmt = new Intl.DateTimeFormat('en-US',
    { hour12: false, hour: 'numeric', minute: 'numeric', second: 'numeric' });
  setInterval(() => {
    if (paused) return;   // nothing visible to keep current
    setText(el.clock, 'clock', clockFmt.format(new Date()));
    if (nextScan) {
      const s = Math.ceil((nextScan - Date.now()) / 1000);
      setText(el.nextScan, 'nextScan', s > 0 ? `· NEXT SCAN ${s}s` : '· SCANNING…');
    }
  }, 250);
})();
