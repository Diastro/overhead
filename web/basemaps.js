// Basemap registry — shared by the display (<script src>) and by
// tools/check-basemaps.js (require), so the smoke test can never drift from
// the URLs the app actually requests.
//
// Why this is a list and not a constant: CARTO served these tiles keylessly
// for years, and on 28 Aug 2026 began stamping anonymous requests with an
// "API KEY REQUIRED" watermark. It ships that watermark with HTTP 200, so
// nothing in the app errored — the wall display just quietly turned to
// garbage. One provider is a single point of failure. This is a list, the
// display switches between them from the LAYERS panel, and repeated tile
// errors move it on by itself.
//
// Every entry here is keyless. Each theme carries its own CSS filter, because
// the correction belongs to the provider's cartography rather than to the
// app: CARTO's dark tiles sat almost entirely below mid-grey and had to be
// lifted, Esri's "dark" canvas is a mid-grey that has to be pushed down, and
// OSM has no dark tiles at all, so its dark theme is derived here.
//
// The correction also has to land the map in the app's own hue family. The
// chrome is slate navy throughout — --stage-bg 209°, --panel-border 208°,
// the accent cyan 199° — and a basemap that is a different blue from the
// chrome reads as two systems sharing a screen rather than one display. A
// provider's own bias is not a starting point to preserve; it is the thing
// being corrected, the same as its brightness.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BASEMAPS = api;
})(typeof self !== 'undefined' ? self : this, function () {
  const OSM_ATTR =
    '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';
  const ESRI_ATTR =
    'Tiles &copy; <a href="https://www.esri.com/">Esri</a> — Esri, HERE, Garmin, ' + OSM_ATTR;
  const CARTO_ATTR =
    OSM_ATTR + ', &copy; <a href="https://carto.com/attributions">CARTO</a>';

  const esri = (service) =>
    `https://services.arcgisonline.com/ArcGIS/rest/services/${service}/MapServer/tile/{z}/{y}/{x}`;

  // The keyless set, in preference order — the first is the default, and an
  // automatic failover walks the list in this order.
  const KEYLESS_BASE = [
    {
      id: 'esri',
      label: 'ESRI CANVAS',
      note: 'Dark/Light Gray Canvas — the closest keyless match to the basemap Overhead used to ship, and the lightest on the wire (~8 KB/tile)',
      attribution: ESRI_ATTR,
      maxZoom: 19,
      // Esri's tiling scheme advertises levels up to 23, but the Canvas DATA
      // stops at 16: from 17 up every request returns one byte-identical
      // "Map data not yet available" placeholder — as HTTP 200, verified the
      // same in Seattle, New York and London. Trusting the advertised maxLOD
      // put a second watermark on the wall at high zoom, which is precisely
      // the failure this file exists to prevent. maxNativeZoom makes Leaflet
      // upscale the last real tile instead: blurry, but a map.
      maxNativeZoom: 16,
      dark: {
        url: esri('Canvas/World_Dark_Gray_Base'),
        labels: esri('Canvas/World_Dark_Gray_Reference'),
        // Esri's dark canvas separates land from water by barely a value step
        // (measured 1.5:1), so the coast read as a smudge. The obvious fix —
        // more contrast — is wrong twice over: contrast() pivots on mid-grey
        // and these tiles live at luma 35-77, so it crushes them to black; and
        // any recipe that wins separation by LIFTING the land pays for it in
        // ink contrast, because the cyan and amber are drawn on that land.
        // Saturation buys the same separation on the hue axis instead: Esri's
        // water already carries a blue cast, and amplifying it leaves
        // luminance — and so every ink's contrast — untouched.
        // Then pushed further on request, because "the coast is separated"
        // and "I can see the coast from the sofa" are different bars. Centre
        // the range, stretch it hard, put it back: the land lifts to a slate
        // and the water drops to navy, so the shoreline is a real edge rather
        // than a change of shade. Measured land #333848, p50 61 (was 29),
        // land/water dE 36.4 (was 18.8 — nearly double), and every ink still
        // clears its bar on the lighter land (aircraft 5.5:1).
        //
        // What saturate() amplifies, though, is Esri's hue and not ours: its
        // greys carry a faint violet bias (raw land #4e4e50, water #232227),
        // so a 6.5x stretch landed the map at 227°/237° — an indigo next to
        // an app that is slate navy everywhere else. The tail rotation is
        // what fixes that, and at -34° it costs nothing: a hue rotation at
        // constant luminance moved all seventeen on-map inks by =<0.03 (icon
        // 5.01 -> 4.99, ring 2.83 -> 2.82), land luma 54 -> 53 so the lift
        // above survives, and land/water dE 27.3 against 28.2. Measured land
        // #2c3742 at 210°, against --stage-bg's 209°.
        filter: 'brightness(1.7) contrast(1.6) brightness(.46) saturate(6.5) hue-rotate(-34deg)',
        // Esri ships the reference layer as plain artwork, and unfiltered it
        // put place names on the wall as neutral white at luma 201 — brighter
        // than every map ink except the overhead block, for text that is
        // context rather than data. Tinted into the same slate as the ring
        // labels and knocked back: #c8c9cb (220°, sat 1%, L 201) becomes
        // #9fb2c2 (207°, sat 18%, L 175), still 4.85:1 on the brightest land
        // this provider draws and 5.55:1 on its usual land.
        labelsFilter: 'sepia(.7) hue-rotate(180deg) saturate(1.2) brightness(.76)',
      },
      light: {
        url: esri('Canvas/World_Light_Gray_Base'),
        labels: esri('Canvas/World_Light_Gray_Reference'),
        // The mirror problem: a light basemap sits near luma 0.80, so raising
        // contrast pushes it to flat white. Centre the range first, stretch,
        // then put it back. Measured land/water dE 22.8 (was 15.4).
        //
        // The light theme needed the opposite tool from the dark one. Esri's
        // light land comes out chroma-zero (#ebebeb), and saturate() cannot
        // tint that at all — multiplying zero chroma leaves zero. It takes
        // sepia() to put a hue there, and the hue to put there is the ivory
        // the chrome is built from (--bar-bg 40°, --panel-line 39°), not the
        // neutral of a generic map. The rotation is for the water, which was
        // a lilac #c4c1ce at 254°; it lands at 188°, the cool blue-grey of
        // --stage-bg. Measured land #f0ece3 (42°, L 236 against 235 before,
        // so no ink lost ground — every one gained ~0.06), water #b8c6c8,
        // land/water dE 16.9 (was 16.0).
        filter: 'brightness(.62) contrast(1.8) brightness(1.46) hue-rotate(-55deg) saturate(3) sepia(.14)',
      },
    },
    {
      id: 'osm',
      label: 'OPENSTREETMAP',
      note: 'Standard OSM tiles from the OSM Foundation — heavier (~30 KB/tile) and busier, but the one provider with a published policy that permits this',
      attribution: OSM_ATTR,
      maxZoom: 19,
      maxNativeZoom: 19, // real, distinct tiles all the way up — checked
      dark: {
        url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
        // There is no keyless dark raster equivalent of OSM standard, so the
        // dark theme is made here: invert, rotate the hues back to where they
        // started (otherwise water turns orange), then drain most of the
        // saturation, because standard OSM is drawn to be read on its own and
        // this one has a scope on top of it that has to win.
        //
        // The first version over-corrected: brightness(.55) after the invert
        // crushed the map to a median luma of 2 out of 255 — a black rectangle
        // separating land from water by 1.74:1 and showing almost nothing.
        // Lifting it costs no ink contrast, because the inks were already at
        // 9-10:1 against pure black with headroom to spare.
        // Measured: p50 20 (was 2), land/water 3.57:1 (was 1.74), aircraft ink
        // 9.71:1 (was 9.89).
        //
        // This one is deliberately NOT rotated into the app's blue, unlike
        // every Esri theme here. OSM separates land from water by hue and
        // barely by value — raw land and water measure luma 200 and 203 — and
        // after the invert the two sit about 170° apart, so any rotation that
        // carries the land to 209° carries the water to about 19° and paints
        // the Sound brown. Draining the colour first and tinting the result
        // is worse still: every duotone tried collapsed land against water to
        // dE ~2.5, which erases the coastline through exactly the urban areas
        // the display is pointed at. A neutral land that keeps its shoreline
        // beats a family-coloured one that loses it.
        filter: 'invert(1) hue-rotate(180deg) saturate(.22) brightness(.85) contrast(1.15)',
      },
      light: {
        url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
        // Drain most of the colour, then centre-stretch-restore as above so
        // the coast still reads. Measured land/water 5.32:1 (was 3.26).
        filter: 'saturate(.6) brightness(.7) contrast(1.5) brightness(1.42) sepia(.14)',
      },
    },
  ];

  // Relief. Hillshade alone is not a basemap — water and flat land shade
  // identically, so Puget Sound comes out as blank as a parking lot — and the
  // terrain services that DO carry water (World_Terrain_Base, Shaded_Relief)
  // stop at zoom 12, which is inside the range this display actually uses.
  // So this composites: hillshade underneath for the landform, the same Canvas
  // that the default provider uses screened over the top for water, roads and
  // coastline. Both halves are the ones already proven to reach zoom 16.
  //
  // Contours were the other option (OpenTopoMap has real ones) and were not
  // taken: at 30-40 KB a tile it is four times the weight for cartography that
  // is far busier under a data layer, and it leans on a volunteer tile server.
  const TERRAIN = {
    id: 'terrain',
    label: 'TERRAIN',
    note: 'Esri hillshade with the canvas over it — landform relief, same zoom range and roughly double the tiles',
    attribution: ESRI_ATTR,
    maxZoom: 19,
    maxNativeZoom: 16,
    dark: {
      layers: [
        { url: esri('Elevation/World_Hillshade'), filter: 'invert(1) brightness(.5) contrast(1.1)' },
        { url: esri('Canvas/World_Dark_Gray_Base'),
          // Same cartography as the default provider, so the same violet bias
          // and the same -34° correction; screening it over the hillshade
          // does not change which hue is being amplified.
          filter: 'brightness(.9) contrast(1.3) saturate(6) hue-rotate(-34deg)',
          blend: 'screen', opacity: 0.85 },
      ],
      labels: esri('Canvas/World_Dark_Gray_Reference'),
      labelsFilter: 'sepia(.7) hue-rotate(180deg) saturate(1.2) brightness(.76)',
    },
    light: {
      layers: [
        { url: esri('Canvas/World_Light_Gray_Base'),
          filter: 'brightness(.62) contrast(1.8) brightness(1.46) hue-rotate(-55deg) saturate(3) sepia(.14)' },
        { url: esri('Elevation/World_Hillshade'), filter: 'contrast(1.3)',
          blend: 'multiply', opacity: 0.6 },
      ],
      labels: esri('Canvas/World_Light_Gray_Reference'),
    },
  };

  // CARTO's Positron/Dark Matter pair, for anyone who wants the exact look
  // Overhead used to have back. Overhead never requires a key: set
  // `carto_key` in config.local.json — which is gitignored — and this appears
  // in the LAYERS picker. Never put it in config.json; that file is committed.
  function carto(key) {
    const url = (style) =>
      `https://basemaps.cartocdn.com/rastertiles/${style}/{z}/{x}/{y}.png?key=${encodeURIComponent(key)}`;
    return {
      id: 'carto',
      label: 'CARTO (KEYED)',
      note: 'Dark Matter / Voyager — needs a free CARTO key in config.local.json',
      attribution: CARTO_ATTR,
      maxZoom: 19,
      maxNativeZoom: 19,
      dark: {
        url: url('dark_all'),
        // The recipe from when CARTO was the only basemap: these tiles sit
        // almost entirely below mid-grey, and contrast() pivots on mid-grey,
        // so raising it crushes the coastline instead of revealing it. Lift
        // the shadows instead — brightness up, contrast slightly down.
        filter: 'brightness(2) contrast(.9) saturate(1.25)',
      },
      light: { url: url('voyager'), filter: 'none' },
    };
  }

  // `key` is optional. Without one the app is entirely keyless.
  function providers(key) {
    const list = [...KEYLESS_BASE, TERRAIN].map((p) => ({ ...p }));
    if (key) list.push(carto(key));
    return list;
  }

  return { providers, THEMES: ['dark', 'light'] };
});
