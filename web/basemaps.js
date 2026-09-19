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
  const KEYLESS = [
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
        // Esri's "dark" canvas is a mid-grey, roughly twice as bright as the
        // near-black CARTO shipped, so this is the mirror image of the old
        // recipe: dim it to push the land back under the scope, then let
        // contrast and saturation bring the coastline and the freeway network
        // back out of it.
        filter: 'brightness(.62) contrast(1.15) saturate(1.4)',
      },
      light: {
        url: esri('Canvas/World_Light_Gray_Base'),
        labels: esri('Canvas/World_Light_Gray_Reference'),
        filter: 'contrast(1.06) saturate(1.1)',
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
        filter: 'invert(1) hue-rotate(180deg) saturate(.2) brightness(.55) contrast(1.2)',
      },
      light: {
        url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
        filter: 'saturate(.45) brightness(1.06) contrast(.96)',
      },
    },
  ];

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
    const list = KEYLESS.map((p) => ({ ...p }));
    if (key) list.push(carto(key));
    return list;
  }

  return { providers, THEMES: ['dark', 'light'] };
});
