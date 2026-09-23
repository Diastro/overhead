// Map styles — shared by the display (<script src>) and by
// tools/check-styles.js (require), so the contrast check reads exactly the
// palettes the app paints.
//
// A style is a whole look: the basemap's colours, the scope's inks, the
// chrome, and an optional effect layer (scanlines, a radar sweep, a grid).
// Each has a dark and a light half; the ☾/☀ toggle picks the half, the STYLE
// picker in the LAYERS panel picks the style.
//
// CLASSIC is the look Overhead shipped with and is left exactly as it was: it
// runs on the hand-tuned per-provider CSS filters in basemaps.js.
//
// Every other style runs on a GRADIENT MAP instead of a filter chain, because
// a chain of brightness/saturate/hue-rotate can only nudge a provider's own
// colours around, and these styles need to put specific colours in specific
// places (yellow towns on tan land, chalk coastline on Prussian blue). A
// gradient map does that in two steps, both inside one SVG filter per layer:
//
//   1. normalise — collapse the provider's tile to one "canonical" grey,
//      where the same grey means the same thing whichever provider drew it:
//
//        0.20 water   0.40 coast edge   0.50 built-up   0.62 land   0.85 roads
//
//      Water is a plateau up to 0.30, not a point: the same Esri water
//      arrives a few levels lighter at some zooms (JPEG), and with its stop
//      at exactly 0.20 open water drifted into the coast colour.
//      The coefficients per source were measured off real tiles (Sep 2026):
//      Esri's Light Gray canvas is water #d0c8d0 (L .80), buildings #e0e0e0
//      (.88), land #e8e8e8 (.91), roads #f8f8f8 (.97). OSM separates water
//      from land by hue far more than by value — its water (#aad3df) and its
//      forests (#add19e) are the same brightness — so its recipe is led by
//      R−B instead.
//
//   2. ramp — feComponentTransfer tables turn that canonical grey into the
//      style's own colours. Anti-aliased coast pixels pass through the
//      `coast` stop on their way from water to land, so every coastline
//      picks up a hairline of the coast colour for free.
//
// On top of the ramp, a style can ask for a drawn coastline (a soft band
// straddling the land edge, made from a blurred land mask) and for shoal
// bands (tinted water near shore, like a nautical chart). Both come from the
// same land mask, so they follow any provider's coast.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.MAPSTYLES = api;
})(typeof self !== 'undefined' ? self : this, function () {
  // ---------------------------------------------------------------- colour
  const hex = (h) => {
    const s = h.replace('#', '');
    return [0, 2, 4].map((i) => parseInt(s.slice(i, i + 2), 16) / 255);
  };
  const toHex = (c) => '#' + c.map((v) => Math.round(Math.max(0, Math.min(1, v)) * 255)
    .toString(16).padStart(2, '0')).join('');
  const mix = (a, b, t) => { const A = hex(a), B = hex(b); return toHex(A.map((v, i) => v + (B[i] - v) * t)); };
  const lin = (v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  const luminance = (h) => { const [r, g, b] = hex(h).map(lin); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
  const contrast = (a, b) => {
    const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
    return (x + 0.05) / (y + 0.05);
  };
  // CIE76 ΔE in L*a*b*: how different two colours LOOK, which contrast ratio
  // does not measure — two reds at 1.07:1 and two reds at 4:1 are both "red".
  const lab = (h) => {
    const [r, g, b] = hex(h).map(lin);
    const xyz = [(0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.9505, 0.2126 * r + 0.7152 * g + 0.0722 * b,
      (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.089];
    const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
    const [fx, fy, fz] = xyz.map(f);
    return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
  };
  const deltaE = (a, b) => { const A = lab(a), B = lab(b); return Math.hypot(A[0] - B[0], A[1] - B[1], A[2] - B[2]); };
  // Nudge `c` toward `toward` until it clears `min`:1 against `bg`.
  const ensure = (c, bg, min, toward) => {
    for (let t = 0; t <= 1; t += 0.02) {
      const x = mix(c, toward, t);
      if (contrast(x, bg) >= min) return x;
    }
    return toward;
  };
  const rgba = (h, a) => { const [r, g, b] = hex(h).map((v) => Math.round(v * 255)); return `rgba(${r},${g},${b},${a})`; };

  // ------------------------------------------------------ canonical sources
  // Luminance-to-canonical coefficients, as [R, G, B, offset] of one output
  // grey. See the header for what the canonical scale means.
  const L = [0.2126, 0.7152, 0.0722];
  const lumRow = (gain, offset) => [...L.map((k) => k * gain), offset];
  const SOURCES = {
    // Esri Canvas Light Gray: water .80 → .20, land .91 → .62, roads .97 → .85.
    esriCanvas: lumRow(3.68, -2.73),
    // OSM standard: t = 0.636·L + 0.069·(G − B) + 1.338·(R − B) − 0.026,
    // solved on four of its colours (land .62, water .20, forest .56,
    // motorway .75). Water is the only class in OSM that is bluer than it is
    // red, so R − B carries almost all of it. A luminance-led first version
    // put forest at .38, under the land threshold — every wood got a coast
    // outline and shoal bands. Now: buildings .58, parks .55, farmland .71,
    // primary roads .99, admin boundaries .35 (thin, drawn in coast colour).
    osm: [1.4727, 0.5238, -1.3605, -0.0255],
    // Esri World Imagery: a plain stretch; the sea is its darkest thing.
    imagery: lumRow(1.15, 0.1),
  };
  // Esri's hillshade is flat at L≈.95 and darkens on slopes facing away from
  // the light. Stretched so flat stays white (→ no change under multiply).
  const RELIEF_SRC = lumRow(3, -1.9);
  // Esri's reference (labels) layers: dark = light glyph on a dark halo,
  // light = dark glyph on a white halo. Stretched so glyph→1 or 0, halo the other.
  const LABEL_SRC = { dark: lumRow(1.89, -0.47), light: lumRow(1.28, -0.24) };

  // ------------------------------------------------------------ base inks
  // The scope palette every style starts from. Moved here from app.js so the
  // contrast check can read it; app.js takes it as THEMES.
  // Palette rules: a hue means the same thing in both themes (cyan=aircraft,
  // gold=overhead, red=military, blue=police, green=climb). Dark uses vivid
  // high-chroma inks against the near-black map; light uses deep saturated
  // inks (not pastels) that hold 4.5:1+ contrast on the cream basemap.
  const BASE_INKS = {
    dark: {
      // Re-derived after the dark basemap was lifted for coastline contrast.
      // Raising the land from #181820 to #333848 cost roughly 1.2 stops of
      // headroom, and eight of these inks quietly dropped under their bar — a
      // reminder that the palette and the basemap filter are one system, not
      // two settings.
      icon: '#38bdff', trail: '#56aaeb', leader: '#5b89ac',
      // Altitude ramp, low → high. One cool hue family so the scope stays calm;
      // brightness carries the altitude. Dark theme: higher is brighter.
      //
      // Same whole-ramp treatment as the light theme, mirrored: here the
      // DARKEST band is what the contrast limit binds, so it sits at the floor
      // and the rest space evenly in L* up to near-white. The old ramp started
      // at #1c6ea8, which measured 2.14:1 on the lifted land — a lowest-band
      // target you could not pick out from the map behind it.
      // Contrasts 4.62 / 5.78 / 7.12 / 8.73 / 10.57, monotonic, min step 7.1 L*.
      altBands: ['#2aadee', '#6ac0f0', '#9cd1f2', '#c6e3f6', '#ecf5fc'],
      iconHalo: 'rgba(4,10,18,0.85)',
      // The *Edge values are not interior chrome: drawBlock() fills the block
      // and then strokes it, so half the stroke width lands on bare map, and a
      // tagged block's leader line is drawn in `edge` across open map. They
      // have to clear contrast against the basemap like any other on-map ink.
      // blockEdge is the widest exposure of all — it borders every ordinary
      // aircraft — and it measured 2.39:1.
      blockBg: 'rgba(12,24,38,0.92)', blockEdge: '#86a6c7',
      amber: '#ffbe2e', amberEdge: '#d99b17', amberBg: 'rgba(26,20,8,0.94)',
      mil: '#ff7b6a', milEdge: '#e8897d', milBg: 'rgba(30,10,8,0.93)',
      dim: '#77879a',
      // Neutral slate, not radar-green: the rings are a measuring grid, and
      // saturated green reads as decoration and competes with the targets.
      // Lightened just past the 3:1 graphical floor — it measured 1.95:1 on
      // the Esri dark map, which is a grid you cannot actually read a range
      // off. Hue and saturation are unchanged, so it stays a quiet slate
      // rather than becoming another thing competing for attention.
      ring: '#6f86a0', ringText: '#8fa2b5', ringLabelBg: 'rgba(8,14,22,0.82)',
      home: '#e8f0f7',
      airport: '#84a9cc',
      textNormal: ['#4cc7ff', '#eaf4fd', '#ffc95e', '#a9bed2'],
      textOverhead: ['#ffbe2e', '#f9ecca', '#ffd166', '#cfb87e'],
      textMil: ['#ff7d66', '#fadfd9', '#ffb09e', '#cfa094'],
      tagText: '#140f04',
      chartMuted: '#5a6c7e',
      chartLow: '#2e6f9c', chartHigh: '#38bdff', chartPeak: '#ffbe2e',
      vsUp: '#22df82', vsDown: '#ff5540', vsFlat: '#8b9cae',
      police: '#7aa1ff', policeEdge: '#87a0f1', policeBg: 'rgba(10,14,34,0.93)',
      policeFlash: '#cfe0ff',
      policeWhite: '#eef4ff', // stripe partner for the police livery
      textPolice: ['#93b1ff', '#e4ebff', '#b9c8f5', '#96a7e4'],
      hiMix: 0.55, // how far the selected-block border lightens toward white
    },
    light: {
      // Every value here that lands ON the map was re-derived against the
      // actual rendered light basemap (#e5ebe8 — the paler of the two, so the
      // stricter one), not against the cream chrome. The old set was tuned by
      // eye and most of it failed AA badly: the trail at 2.31:1, the overhead
      // amber at 1.89:1. Each was darkened along L with its hue and saturation
      // held, so a colour still means what it meant.
      icon: '#0764ab', trail: '#14669f', leader: '#8a8774',
      // Light theme inverts the ramp: on cream, higher reads as *deeper* ink,
      // so prominence still grows with altitude instead of washing out.
      //
      // The ramp could not be fixed band by band. Pushing each one to 4.5:1
      // individually collapsed the lowest three onto the same luminance and
      // destroyed the altitude encoding — five bands, three of them identical.
      // It has to be designed as a whole: the LIGHTEST band is what the 4.5:1
      // limit binds, so it sits there, and the rest are spaced evenly in L*
      // down to near-black. Contrasts 4.54 / 6.03 / 7.92 / 10.23 / 12.71,
      // monotonic, min step 7.5 L*.
      altBands: ['#116daf', '#0e5a90', '#0b4874', '#093758', '#06273e'],
      iconHalo: 'rgba(255,255,255,0.92)',
      blockBg: 'rgba(253,250,243,0.94)', blockEdge: '#6e6142',
      // The overhead marker is the most important thing on the scope and was
      // the worst offender at 1.89:1. amberEdge is worse than it looks: it is
      // both the overhead block's border AND the leader line drawn from the
      // target across open map, so it was failing at 2.21:1 in the one place
      // it most needed not to. Only the *Bg values are genuinely interior.
      amber: '#8c5500', amberEdge: '#925300', amberBg: 'rgba(253,246,227,0.96)',
      mil: '#bc281b', milEdge: '#ba2b1d', milBg: 'rgba(250,235,231,0.96)',
      dim: '#7d8980',
      // Rings and leader lines are guides, so 3:1 is the bar, not 4.5.
      ring: '#8f856a', ringText: '#6d7a86', ringLabelBg: 'rgba(253,250,243,0.86)',
      home: '#34435a',
      airport: '#4a6b8a',
      textNormal: ['#0a72c4', '#2b3640', '#d97706', '#57646f'],
      textOverhead: ['#d97706', '#4a3a0c', '#d97706', '#8a7440'],
      textMil: ['#d0301f', '#4a201a', '#b8402e', '#8a5f56'],
      tagText: '#402f08',
      chartMuted: '#9aa1a8',
      chartLow: '#7db8dd', chartHigh: '#0a7fd9', chartPeak: '#f59500',
      // These sit on the data block's own panel, not on the map, so they are
      // measured against blockBg. vsDown used to be byte-identical to `mil`
      // (#e03526) — every descending airliner's trend arrow was painted the
      // exact colour reserved for "military or flagged", which dilutes the one
      // red that is supposed to mean something. Now distinct, and both clear
      // 4.5:1 on the panel (was 4.28 and 3.14).
      vsUp: '#0e7c46', vsDown: '#b8391f', vsFlat: '#7f8a95',
      police: '#2c52e6', policeEdge: '#2c52e6', policeBg: 'rgba(233,238,252,0.96)',
      policeFlash: '#7fa0f0',
      policeWhite: '#ffffff', // stripe partner for the police livery
      textPolice: ['#1a37a8', '#252f45', '#31479c', '#4b5b8c'],
      hiMix: 0.3, // lighter mix on the cream background so the border stays visible
    },
  };

  // ----------------------------------------------------------------- styles
  // map: water/coast/urban/land/road sit at the canonical stops; `ramp`
  //      replaces them outright where a style needs a different curve.
  //      label/halo recolour the provider's place names.
  //      coastLine {color, width, opacity}, shoal [[color, px], …] widest first,
  //      relief {shadow, op} tints the hillshade on composite providers.
  // fx:  overlay effects — scan (opacity), vignette (opacity), sweep (colour),
  //      grid {color, op, size}, grain {op, blend}, halftone {color, op},
  //      wash [top, bottom, opacity].
  // chrome: bar/ink/bright/muted/accent/border; the rest is derived.
  // inks: overrides for the canvas palette in app.js (THEMES.dark/light).
  //      Anything not listed keeps that theme's value. Military red and police
  //      blue keep their HUE in every style — they mean the same thing
  //      everywhere — but a style may shift their lightness to clear its own
  //      map (tools/check-styles.js holds them to 4.5:1 like any target).

  const STYLES = [
    {
      id: 'classic', label: 'CLASSIC', classic: true,
      note: 'The original look: slate navy / warm ivory, tuned per provider.',
    },

    {
      id: 'phosphor', label: 'RADAR PHOSPHOR',
      note: 'Green radar glass with a slow sweep. Aircraft go mint-to-white; overhead stays amber.',
      dark: {
        map: { water: '#020a05', coast: '#1f6b3a', urban: '#0e2a18', land: '#0a2013', road: '#1b4a30',
          label: '#5fbf82', halo: '#03100a', coastLine: { color: '#2a8a4e', width: 0.9, opacity: 0.6 } },
        fx: { scan: 0.28, vignette: 0.5, sweep: '#3cff7a' },
        chrome: { bar: '#010502', ink: '#5fd68a', bright: '#c9ffd9', muted: '#4a9a68', accent: '#7dffa8', border: '#1c5a33' },
        inks: {
          altBands: ['#2cb865', '#5bd188', '#8ae2aa', '#bbf0cd', '#ecfff2'], icon: '#6fe399',
          trail: '#3fbf6e', leader: '#3f9a62', iconHalo: 'rgba(1,8,4,0.85)',
          blockBg: 'rgba(2,14,7,0.92)', blockEdge: '#4caf72',
          amber: '#ffb000', amberEdge: '#d99400', amberBg: 'rgba(24,18,2,0.94)',
          ring: '#34905a', ringText: '#6fd894', ringLabelBg: 'rgba(1,10,5,0.85)',
          home: '#e6ffee', airport: '#6fc48e', dim: '#4d7a5c',
          textNormal: ['#7dffa8', '#e2ffe9', '#ffc95e', '#8fcfa4'],
        },
      },
      light: {
        map: { water: '#cddcc6', coast: '#5c7b51', urban: '#d6dfc6', land: '#e4ebd6', road: '#f4f7ec',
          label: '#3d5234', halo: '#eef2e6', coastLine: { color: '#5c7b51', width: 0.9, opacity: 0.85 } },
        fx: { vignette: 0.12 },
        chrome: { bar: '#eef2e4', ink: '#3a4a33', bright: '#16230f', muted: '#5a6a52', accent: '#2f7a3a', border: '#b9c7ad' },
        inks: { police: '#2a4edb', mil: '#b3261a', amberEdge: '#855100', amber: '#855100',
          altBands: ['#176231', '#125226', '#0e421d', '#093214', '#05220c'], icon: '#176231',
          trail: '#1f6a38', leader: '#5f7050', blockBg: 'rgba(246,249,240,0.95)', blockEdge: '#56694a',
          ring: '#5d7d4e', ringText: '#3a5a30', ringLabelBg: 'rgba(246,249,240,0.88)',
          home: '#1c2c16', airport: '#3c6637', dim: '#7d8a74',
          textNormal: ['#176231', '#23301d', '#b36200', '#56644c'],
        },
      },
    },

    {
      id: 'sectional', label: 'VFR SECTIONAL', prefers: 'terrain',
      note: 'Pilot’s chart: tan land, yellow towns, chart-blue water. Rings stay neutral — dashed magenta means airspace on a chart. Night is cockpit red, and military turns white so it still stands out.',
      dark: {
        map: { water: '#070203', coast: '#5a1a18', urban: '#1f0a0a', land: '#150707', road: '#2e0f0d',
          label: '#b0635a', halo: '#0a0303', relief: { shadow: '#000000', op: 0.55 },
          coastLine: { color: '#8a2c26', width: 1, opacity: 0.9 } },
        chrome: { bar: '#040101', ink: '#c85e52', bright: '#ffb3a3', muted: '#9a4a40', accent: '#ff5a48', border: '#4a1612' },
        inks: {
          altBands: ['#d94c40', '#e4695b', '#ee8577', '#f5a193', '#f9b8ab'], icon: '#ec7a6a',
          trail: '#ca5b4f', leader: '#9a4a40', iconHalo: 'rgba(8,2,2,0.85)',
          blockBg: 'rgba(14,3,3,0.93)', blockEdge: '#b55a4e',
          amber: '#ffc46b', amberEdge: '#d9a050', amberBg: 'rgba(24,14,4,0.94)',
          textOverhead: ['#ffc46b', '#ffe8c8', '#ffd08a', '#d0a878'],
          mil: '#ffffff', milEdge: '#e6e6e6', milBg: 'rgba(24,20,20,0.94)', policeWhite: '#ff2a1a',
          textMil: ['#ffffff', '#f0e0dc', '#e8d0c8', '#c8aca4'],
          ring: '#b54a42', ringText: '#d8766a', ringLabelBg: 'rgba(10,2,2,0.85)',
          home: '#ffd8cc', airport: '#d0766a', dim: '#7a4a44',
          textNormal: ['#ff8e7c', '#ffd8cc', '#ffc46b', '#c88a80'],
        },
      },
      light: {
        map: { water: '#b9dcec', coast: '#3a7fb0', urban: '#f2d67c', land: '#eee3c4', road: '#e2c89a',
          label: '#3b3b3b', halo: '#f4ecd4', relief: { shadow: '#8a7a5a', op: 0.38 },
          coastLine: { color: '#2f6f9f', width: 1, opacity: 0.9 } },
        chrome: { bar: '#f7f1e1', ink: '#4a4230', bright: '#1f1a10', muted: '#6f6650', accent: '#a3317f', border: '#d8cca8' },
        inks: { police: '#2748ca', mil: '#a72418',
          altBands: ['#0f4f8a', '#0c4273', '#0a365e', '#072a49', '#051e35'], icon: '#0f4f8a',
          trail: '#1a5a94', leader: '#7f7053', blockBg: 'rgba(250,245,230,0.95)', blockEdge: '#6e6142',
          amber: '#7a4600', amberEdge: '#7a4600',
          ring: '#6b6552', ringText: '#4f4a3c', ringLabelBg: 'rgba(250,245,230,0.88)',
          home: '#1f1a10', airport: '#8c2a6c',
          textNormal: ['#0f4f8a', '#2b2a22', '#9a5a00', '#5f5a48'],
        },
      },
    },

    {
      id: 'cyanotype', label: 'CYANOTYPE',
      note: 'Drafting-table blueprint. The map takes the blue, so traffic goes white by night, graphite by day — red stays military.',
      dark: {
        map: { water: '#0a2846', coast: '#cfe2f7', urban: '#16436f', land: '#113860', road: '#2d5c8a',
          label: '#d4e4f4', halo: '#0d3052', coastLine: { color: '#e8f1ff', width: 1.1, opacity: 0.95 } },
        fx: { grid: { color: '#9cc0e6', op: 0.13, size: 48 } },
        chrome: { bar: '#081f38', ink: '#c7dbf0', bright: '#ffffff', muted: '#86a6c8', accent: '#e8f1ff', border: '#2d5a86' },
        inks: { police: '#8aacff', mil: '#ff8f80',
          altBands: ['#9fb4c8', '#bccbd9', '#d4dee8', '#e8eef4', '#ffffff'], icon: '#d4dee8',
          trail: '#bcd0e4', leader: '#7fa3c8', iconHalo: 'rgba(4,18,34,0.85)',
          blockBg: 'rgba(6,26,48,0.93)', blockEdge: '#8fb4dc',
          amber: '#ffb347', amberEdge: '#e09a30',
          ring: '#8fb4dc', ringText: '#dce9f8', ringLabelBg: 'rgba(6,26,48,0.85)',
          home: '#ffffff', airport: '#cfe2f7', dim: '#6f8cab',
          textNormal: ['#ffffff', '#e0ebf6', '#ffc97a', '#a9c1da'],
        },
      },
      light: {
        map: { water: '#e4edf3', coast: '#1d4f91', urban: '#eef0ec', land: '#f8f6ef', road: '#ffffff',
          label: '#1d4f91', halo: '#f8f6ef', coastLine: { color: '#1d4f91', width: 1.1, opacity: 0.9 } },
        fx: { grid: { color: '#1d4f91', op: 0.07, size: 48 } },
        chrome: { bar: '#f4f1e8', ink: '#1d4f91', bright: '#0f2b52', muted: '#5a73a0', accent: '#1d4f91', border: '#c3cfe0' },
        inks: {
          altBands: ['#4f5560', '#3e434d', '#2e323a', '#1e2127', '#0e1014'], icon: '#4f5560',
          trail: '#3e434d', leader: '#5a73a0', blockBg: 'rgba(250,248,242,0.95)', blockEdge: '#1d4f91',
          amber: '#8a6200', amberEdge: '#8a6200', amberBg: 'rgba(250,245,228,0.96)',
          textOverhead: ['#8a6200', '#3a2c08', '#8a6200', '#6f5a2a'],
          ring: '#1d4f91', ringText: '#1d4f91', ringLabelBg: 'rgba(248,246,239,0.9)',
          home: '#0f2b52', airport: '#1d4f91', dim: '#8a93a3',
          textNormal: ['#2e323a', '#1b2433', '#8a6200', '#4d5a70'],
        },
      },
    },

    {
      id: 'ecdis', label: 'ECDIS NAUTICAL',
      note: 'Ship’s chart display, after the IHO S-52 Day and Night palettes: buff land, shoal bands along every coast.',
      dark: {
        map: { water: '#04070b', coast: '#3f3b26', urban: '#221f13', land: '#1c1a10', road: '#2c2918',
          label: '#8a8458', halo: '#0a0a06', shoal: [['#070f1a', 22], ['#0b1728', 8]],
          coastLine: { color: '#57523a', width: 0.8, opacity: 0.9 } },
        chrome: { bar: '#020304', ink: '#8490aa', bright: '#b8c2d6', muted: '#5f6a80', accent: '#5fb0a8', border: '#1e2638' },
        inks: {
          altBands: ['#4a8bcc', '#6a9fd6', '#8ab3e0', '#aac7ea', '#cadcf4'], icon: '#6a9fd6',
          trail: '#608ac1', leader: '#586c96', iconHalo: 'rgba(2,3,5,0.85)',
          blockBg: 'rgba(4,7,11,0.93)', blockEdge: '#5a6f98',
          amber: '#d09a38', amberEdge: '#a07424', amberBg: 'rgba(20,14,4,0.94)',
          textOverhead: ['#d09a38', '#e0d0b0', '#d0a050', '#a89070'],
          ring: '#5268a0', ringText: '#8a9ccc', ringLabelBg: 'rgba(3,5,8,0.85)',
          home: '#b8c6dc', airport: '#7a90bc', dim: '#5a6070',
          textNormal: ['#7fa6dc', '#b8c6dc', '#d0a050', '#7f8ca0'],
        },
      },
      light: {
        map: { water: '#ffffff', coast: '#4d4d4d', urban: '#d4c285', land: '#e3d49e', road: '#efe4c0',
          label: '#2f2f2f', halo: '#ece0b4', shoal: [['#d4e8f8', 22], ['#a6cff0', 8]],
          coastLine: { color: '#3f3f3f', width: 0.8, opacity: 0.9 } },
        chrome: { bar: '#f1f1ef', ink: '#46505c', bright: '#141a22', muted: '#5f6873', accent: '#0f766e', border: '#cfcfca' },
        inks: { police: '#2442ba', mil: '#9a2116',
          altBands: ['#0b5186', '#08426f', '#063358', '#032541', '#01172b'], icon: '#0b5186',
          trail: '#175185', leader: '#6e6856', blockEdge: '#5a5440',
          amber: '#744400', amberEdge: '#744400',
          ring: '#3d57a8', ringText: '#2f4790', ringLabelBg: 'rgba(250,250,248,0.88)',
          airport: '#2f4790',
          textNormal: ['#0b5186', '#2b3640', '#9a5a00', '#57646f'],
        },
      },
    },

    {
      id: 'relief', label: 'SWISS RELIEF', prefers: 'terrain',
      note: 'Shaded relief in the Imhof tradition: parchment with violet shadows by day, moonlit ridges by night.',
      dark: {
        map: { water: '#0a131f', coast: '#5f7a94', urban: '#202c3a', land: '#1a2532', road: '#2e3c4c',
          label: '#a2b0c0', halo: '#121b26', relief: { shadow: '#000000', op: 0.75 },
          coastLine: { color: '#7890a8', width: 0.9, opacity: 0.85 } },
        chrome: { bar: '#070b11', ink: '#9fb2c6', bright: '#eef4fa', muted: '#6f849a', accent: '#8fc4ee', border: '#2a3a4c' },
        inks: { airport: '#9ab8d6' },
      },
      light: {
        map: { water: '#b3cdd8', coast: '#6f8e9e', urban: '#e0d3b6', land: '#ece4cd', road: '#f7f2e4',
          label: '#4f4434', halo: '#f3ecdb', relief: { shadow: '#5b4d82', op: 0.36 },
          coastLine: { color: '#5f7f90', width: 0.9, opacity: 0.8 } },
        chrome: { bar: '#f6f1e4', ink: '#5f5646', bright: '#221c12', muted: '#6f6656', accent: '#2d6f9e', border: '#d8ccb2' },
        inks: { police: '#2546c4', mil: '#a02217',
          altBands: ['#0b5389', '#094676', '#07395f', '#042a46', '#021a2c'], icon: '#0b5389', trail: '#195684', leader: '#756c5c', blockEdge: '#6e6142',
          amber: '#7a4800', amberEdge: '#7a4800',
          ring: '#3e6f8c', ringText: '#2d5670', airport: '#2d5670',
          textNormal: ['#0b5389', '#2b3640', '#9a5a00', '#57646f'],
        },
      },
    },

    {
      id: 'hour', label: 'GOLDEN / BLUE HOUR',
      note: 'The sky’s two best moments: honey and teal by day, indigo dusk by night.',
      dark: {
        map: { water: '#0e1536', coast: '#5c66aa', urban: '#2b3166', land: '#222958', road: '#3a4280',
          label: '#aeaede', halo: '#1a2048', coastLine: { color: '#6a74b8', width: 0.9, opacity: 0.85 } },
        fx: { wash: ['#0e1536', '#ff7aa8', 0.08] },
        chrome: { bar: '#0a0f28', ink: '#a9aee0', bright: '#f0f1ff', muted: '#7a80b8', accent: '#ff9ec0', border: '#2e3670' },
        inks: { police: '#82a7ff', mil: '#ff8676',
          altBands: ['#52b6e2', '#80cbec', '#a9dcf2', '#d0edf9', '#f2fbff'], icon: '#8ad3ef',
          trail: '#99a5eb', leader: '#7e85bf', iconHalo: 'rgba(8,10,30,0.85)',
          blockBg: 'rgba(12,16,44,0.93)', blockEdge: '#8a92d0',
          amber: '#ffae42', amberEdge: '#e0922a',
          ring: '#7a84ca', ringText: '#aab3f2', ringLabelBg: 'rgba(10,14,40,0.85)',
          home: '#f0f1ff', airport: '#b0b8f0', dim: '#6a6f98',
          textNormal: ['#8ad3ef', '#eef0ff', '#ffc46b', '#a0a8d8'],
        },
      },
      light: {
        map: { water: '#a6cdc9', coast: '#a8733a', urban: '#eec68a', land: '#f2d7a4', road: '#fbe9c8',
          label: '#5e3a18', halo: '#f6e0b6', coastLine: { color: '#a8733a', width: 0.9, opacity: 0.8 } },
        fx: { wash: ['#fff2c8', '#ff9e5a', 0.08] },
        chrome: { bar: '#fbeed5', ink: '#6b4524', bright: '#2b1a0c', muted: '#7f5e3e', accent: '#2a6a5f', border: '#e6cfa6' },
        inks: { police: '#2443bd', mil: '#9a2116',
          altBands: ['#1c536c', '#16455a', '#113748', '#0b2936', '#051a24'], icon: '#1c536c',
          trail: '#1c4e66', leader: '#795d3f', blockBg: 'rgba(253,244,226,0.95)', blockEdge: '#7a5a38',
          amber: '#6b3f00', amberEdge: '#6b3f00',
          ring: '#a2472a', ringText: '#86361a', ringLabelBg: 'rgba(253,244,226,0.88)',
          home: '#2b1a0c', airport: '#67401d',
          textNormal: ['#1c536c', '#2b2218', '#8a5200', '#6b5a48'],
        },
      },
    },

    {
      id: 'jetage', label: 'JET-AGE ROUTE MAP',
      note: 'A 1960s airline route poster: cream paper and teal sea, or gold coastlines on midnight navy.',
      dark: {
        map: { water: '#0a1530', coast: '#c49a44', urban: '#1b2b56', land: '#15234a', road: '#27386c',
          label: '#dcc488', halo: '#101c3c', coastLine: { color: '#c49a44', width: 1.1, opacity: 0.9 } },
        chrome: { bar: '#070f22', ink: '#cdb57a', bright: '#f6eed9', muted: '#8a8060', accent: '#d4a84a', border: '#2a3868' },
        inks: {
          altBands: ['#b8a47c', '#cbb994', '#ddcdb0', '#eee3cf', '#fffaf0'], icon: '#cbb994',
          trail: '#d9c9a3', leader: '#a08a5a', iconHalo: 'rgba(6,12,30,0.85)',
          blockBg: 'rgba(8,16,38,0.93)', blockEdge: '#b8a070',
          ring: '#8a93b8', ringText: '#c4cae4', ringLabelBg: 'rgba(8,16,38,0.85)',
          home: '#fffaf0', airport: '#e8cf8a', dim: '#6a7090',
          textNormal: ['#f5eedc', '#e6dcc4', '#ffc95e', '#b8a88a'],
        },
      },
      light: {
        map: { water: '#a3cbc6', coast: '#4d6d69', urban: '#e8d8b4', land: '#f2e6cc', road: '#fbf4e4',
          label: '#4a3d2f', halo: '#f5ecd8', coastLine: { color: '#4d6d69', width: 1, opacity: 0.9 } },
        fx: { grain: { op: 0.08, blend: 'multiply' } },
        chrome: { bar: '#f7eedb', ink: '#5a4a36', bright: '#1d2e4a', muted: '#7a6a52', accent: '#27406a', border: '#e2d3b0' },
        inks: { police: '#2443bd', mil: '#9a2116',
          altBands: ['#2b4a78', '#223c63', '#1a2f4e', '#12223a', '#0a1526'], icon: '#2b4a78',
          trail: '#932819', leader: '#746651', blockBg: 'rgba(250,244,230,0.95)', blockEdge: '#6e6142',
          amber: '#734400', amberEdge: '#734400',
          ring: '#ba3e2b', ringText: '#a3321f', ringLabelBg: 'rgba(250,244,230,0.88)',
          home: '#1d2e4a', airport: '#8f2c1b',
          textNormal: ['#2b4a78', '#2a2418', '#8a5200', '#6a5e4a'],
        },
      },
    },

    {
      id: 'riso', label: 'RISOGRAPH',
      note: 'Two fluorescent inks, halftone and grain. The loudest style here: a poster first, a scope second.',
      dark: {
        map: { water: '#16183a', coast: '#ff48b0', urban: '#2a1530', land: '#1c1220', road: '#3a2040',
          label: '#6cc0ff', halo: '#120c16', coastLine: { color: '#ff48b0', width: 1.2, opacity: 0.7 } },
        fx: { halftone: { color: '#2f7fe0', op: 0.12 }, grain: { op: 0.12, blend: 'screen' } },
        chrome: { bar: '#0c0a0e', ink: '#6cc0ff', bright: '#ffffff', muted: '#8a7a98', accent: '#ff48b0', border: '#3a2440' },
        inks: {
          altBands: ['#9a9aae', '#b6b6c8', '#d0d0de', '#e8e8f2', '#ffffff'], icon: '#e0e0ee',
          trail: '#6cc0ff', leader: '#a080a8', iconHalo: 'rgba(10,6,12,0.85)',
          blockBg: 'rgba(14,10,18,0.93)', blockEdge: '#c0a0c8',
          amber: '#ffe800', amberEdge: '#d8c400', amberBg: 'rgba(24,22,4,0.94)',
          textOverhead: ['#ffe800', '#fff8c0', '#ffe800', '#d8cc70'],
          ring: '#ff48b0', ringText: '#ff7cc6', ringLabelBg: 'rgba(14,10,18,0.85)',
          home: '#ffffff', airport: '#6cc0ff', dim: '#6a6078',
          textNormal: ['#ffffff', '#e6e0ee', '#ffe800', '#b8a8c8'],
        },
      },
      light: {
        map: { water: '#c9daf0', coast: '#ff48b0', urban: '#f3cadb', land: '#f7e1e8', road: '#fbf2ea',
          label: '#005f99', halo: '#f7e8ea', coastLine: { color: '#ff48b0', width: 1.2, opacity: 0.65 } },
        fx: { halftone: { color: '#0078bf', op: 0.1 }, grain: { op: 0.14, blend: 'multiply' } },
        chrome: { bar: '#f5f1e6', ink: '#0068a8', bright: '#111111', muted: '#5a6a80', accent: '#e0309a', border: '#e0d8c8' },
        inks: { police: '#294cd6', mil: '#af2519',
          altBands: ['#5a5a5a', '#454545', '#303030', '#1c1c1c', '#080808'], icon: '#454545',
          trail: '#005f99', leader: '#6a6a6a', blockBg: 'rgba(248,244,234,0.95)', blockEdge: '#3a3a3a',
          amber: '#6f5400', amberEdge: '#6f5400', amberBg: 'rgba(252,246,228,0.96)',
          textOverhead: ['#6f5400', '#2e2408', '#6f5400', '#6a5a30'],
          ring: '#d42a90', ringText: '#b8207a', ringLabelBg: 'rgba(248,244,234,0.88)',
          home: '#111111', airport: '#005f99',
          textNormal: ['#111111', '#2a2a2a', '#9c3200', '#5a5a5a'],
        },
      },
    },

    {
      id: 'orbital', label: 'ORBITAL', prefers: 'imagery',
      note: 'Satellite imagery, graded: the night side with glowing cities, or bleached daylight. Heaviest tiles of any style.',
      dark: {
        map: { ramp: [[0, '#020409'], [0.2, '#04080e'], [0.4, '#0c1318'], [0.62, '#1a2226'], [0.8, '#24221f'], [1, '#3e3b36']],
          water: '#04080e', land: '#1a2226', label: '#9aa4ae', halo: '#070b10' },
        fx: { vignette: 0.35 },
        chrome: { bar: '#05080c', ink: '#95a7b8', bright: '#eef5fb', muted: '#6d8094', accent: '#38bdff', border: '#24313e' },
        inks: {},
      },
      light: {
        map: { ramp: [[0, '#7f9aa6'], [0.2, '#afc3cb'], [0.4, '#b9c2bd'], [0.62, '#d2d0c4'], [0.85, '#ebe7da'], [1, '#f7f4ea']],
          water: '#afc3cb', land: '#d2d0c4', label: '#2a3034', halo: '#e8e6de' },
        chrome: { bar: '#f1efe9', ink: '#565d63', bright: '#15191c', muted: '#6a7076', accent: '#0a6fc0', border: '#d6d2c6' },
        inks: { police: '#2341b6', mil: '#962016',
          altBands: ['#14507f', '#0f4168', '#0b3352', '#07253c', '#041726'], icon: '#14507f',
          trail: '#0a4674', leader: '#5d5d54', blockEdge: '#5a5a50',
          amber: '#633a00', amberEdge: '#633a00',
          ring: '#2d5f86', ringText: '#1f4f73', airport: '#1c4768',
          textNormal: ['#14507f', '#2b3640', '#8a5200', '#57646f'],
        },
      },
    },

    {
      id: 'eink', label: 'E-INK',
      note: 'The map goes grey and only the data keeps its colour. The gentlest style for a screen that is always on.',
      dark: {
        map: { water: '#111213', coast: '#505356', urban: '#242527', land: '#1e1f20', road: '#2e2f31',
          label: '#8a8d91', halo: '#151617', coastLine: { color: '#5a5d61', width: 0.9, opacity: 0.85 } },
        chrome: { bar: '#0c0c0d', ink: '#9a9da1', bright: '#f2f2f2', muted: '#75787c', accent: '#38bdff', border: '#34363a' },
        inks: { ring: '#6f7276', ringText: '#8e9195', airport: '#9a9da1' },
      },
      light: {
        map: { water: '#dcdcd8', coast: '#6a6a66', urban: '#e6e6e1', land: '#f2f2ee', road: '#ffffff',
          label: '#45453f', halo: '#f2f2ee', coastLine: { color: '#6a6a66', width: 0.9, opacity: 0.85 } },
        fx: { halftone: { color: '#6a6a66', op: 0.07 }, grain: { op: 0.06, blend: 'multiply' } },
        chrome: { bar: '#f7f7f4', ink: '#4a4a47', bright: '#141414', muted: '#6a6a66', accent: '#0a7fd9', border: '#d8d8d2' },
        inks: { police: '#2b50e1', mil: '#b8271a', leader: '#7c7a68', trail: '#13639a', amberEdge: '#895300', amber: '#895300',
          altBands: ['#0c5f9c', '#0b5087', '#094272', '#07345c', '#052646'], icon: '#0c5f9c',
          ring: '#77776f', ringText: '#55554f', airport: '#4a5a6a',
          textNormal: ['#0c5f9c', '#2b3640', '#b36200', '#57646f'],
        },
      },
    },
  ];

  // ------------------------------------------------------------ builders
  // The canonical stops every non-custom ramp is drawn through.
  function rampOf(m) {
    if (m.ramp) return m.ramp;
    return [[0, m.water], [0.3, m.water], [0.4, m.coast], [0.5, m.urban], [0.62, m.land], [0.85, m.road], [1, m.road]];
  }
  function sample(ramp, t) {
    for (let i = 1; i < ramp.length; i++) {
      if (t <= ramp[i][0]) {
        const [p0, c0] = ramp[i - 1], [p1, c1] = ramp[i];
        return mix(c0, c1, p1 === p0 ? 1 : (t - p0) / (p1 - p0));
      }
    }
    return ramp[ramp.length - 1][1];
  }
  // feComponentTransfer tables, one per channel, from a colour ramp.
  function tables(ramp, n = 33) {
    const cols = Array.from({ length: n }, (_, i) => hex(sample(ramp, i / (n - 1))));
    return ['R', 'G', 'B'].map((ch, k) =>
      `<feFunc${ch} type="table" tableValues="${cols.map((c) => c[k].toFixed(3)).join(' ')}"/>`).join('');
  }
  // One grey out of a source row, into all three channels; alpha untouched.
  // Left open so the caller can add `result=`.
  const matrix = (row) => {
    const [r, g, b, o] = row.map((v) => +v.toFixed(4));
    const line = `${r} ${g} ${b} 0 ${o}`;
    return `<feColorMatrix type="matrix" values="${line} ${line} ${line} 0 0 0 1 0"`;
  };
  // A region big enough for any tile container. Leaflet's layer divs have no
  // size of their own — their tiles are absolutely positioned children — so
  // the default bounding-box region would be empty and paint nothing.
  //
  // It has to be far larger than a screen, not just "big": Leaflet keeps
  // translating tiles further from the container's origin as you pan at one
  // zoom, and ±20000 px ran out after ~26 screens of panning — a panel
  // following a flight east went blank. Chrome only rasterises the visible
  // part of the region, so its size costs nothing.
  const REGION = 'filterUnits="userSpaceOnUse" primitiveUnits="userSpaceOnUse" x="-4000000" y="-4000000" width="8000000" height="8000000" color-interpolation-filters="sRGB"';

  function baseFilter(id, src, m) {
    const parts = [`<filter id="${id}" ${REGION}>`, `${matrix(SOURCES[src])} result="t"/>`,
      `<feComponentTransfer in="t" result="c">${tables(rampOf(m))}</feComponentTransfer>`];
    let top = 'c';
    const edges = (m.shoal && m.shoal.length) || m.coastLine;
    if (edges) {
      // Land as alpha, anti-aliased: canonical .30 → 0, .50 → 1 — the top of
      // the water plateau to the built-up stop.
      parts.push('<feColorMatrix in="t" type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 5 0 0 0 -1.5" result="raw"/>',
        // Only real shorelines may draw a coast. The raw mask also "sees" a
        // coast along every thin thing darker or lighter than its field: the
        // 1 px seams Leaflet leaves between tiles at fractional zoom, the
        // grey place names baked into Esri's base canvas, road casings, county
        // lines across the water. Close (fill thin water-coloured lines inside
        // land) then open (drop thin land-coloured lines over water) — 2 px
        // each way removes all of those and keeps any inlet wider than ~4 px.
        '<feMorphology in="raw" operator="dilate" radius="2" result="m1"/>',
        '<feMorphology in="m1" operator="erode" radius="2" result="m2"/>',
        '<feMorphology in="m2" operator="erode" radius="2" result="m3"/>',
        '<feMorphology in="m3" operator="dilate" radius="2" result="la"/>');
    }
    (m.shoal || []).forEach(([color, px], i) => {
      parts.push(`<feGaussianBlur in="la" stdDeviation="${px / 2}" result="sb${i}"/>`,
        `<feComponentTransfer in="sb${i}" result="sm${i}"><feFuncA type="linear" slope="7" intercept="0"/></feComponentTransfer>`,
        `<feFlood flood-color="${color}"/>`, `<feComposite in2="sm${i}" operator="in" result="sf${i}"/>`,
        `<feComposite in="sf${i}" in2="${top}" operator="over" result="so${i}"/>`);
      top = `so${i}`;
    });
    if (m.shoal && m.shoal.length) {
      parts.push('<feComposite in="c" in2="la" operator="in" result="lc"/>',
        `<feComposite in="lc" in2="${top}" operator="over" result="ls"/>`);
      top = 'ls';
    }
    if (m.coastLine) {
      const { color, width = 1, opacity = 0.9 } = m.coastLine;
      parts.push(`<feGaussianBlur in="la" stdDeviation="${width}" result="cb"/>`,
        // Peaks where the blurred edge crosses half: a soft line centred on the coast.
        '<feComponentTransfer in="cb" result="cm"><feFuncA type="table" tableValues="0 0.25 1 0.25 0"/></feComponentTransfer>',
        `<feFlood flood-color="${color}" flood-opacity="${opacity}"/>`, '<feComposite in2="cm" operator="in" result="cl"/>',
        `<feComposite in="cl" in2="${top}" operator="over"/>`);
    }
    parts.push('</filter>');
    return parts.join('');
  }

  function reliefFilter(id, m) {
    const r = m.relief || { shadow: mix(m.land, '#000000', 0.55), op: 0.6 };
    const ramp = [[0, r.shadow], [0.45, mix(r.shadow, '#ffffff', 0.5)], [0.9, '#ffffff'], [1, '#ffffff']];
    return `<filter id="${id}" ${REGION}>${matrix(RELIEF_SRC)}/><feComponentTransfer>${tables(ramp, 17)}</feComponentTransfer></filter>`;
  }

  // Labels: which of Esri's two reference layers to recolour depends on
  // whether this style wants light-on-dark names or dark-on-light ones —
  // glyph and halo keep their roles, only their colours change.
  function labelKind(m) {
    const halo = m.halo || m.land;
    return luminance(m.label) > luminance(halo) ? 'dark' : 'light';
  }
  function labelFilter(id, m) {
    const kind = labelKind(m);
    const halo = m.halo || m.land;
    const ramp = kind === 'dark' ? [[0, halo], [1, m.label]] : [[0, m.label], [1, halo]];
    const op = m.labelOpacity ?? 0.92;
    return `<filter id="${id}" ${REGION}>${matrix(LABEL_SRC[kind])}/><feComponentTransfer>${tables(ramp, 9)}<feFuncA type="linear" slope="${op}"/></feComponentTransfer></filter>`;
  }

  // Everything one style+theme needs, as markup for a hidden <svg><defs>.
  // ids: `${prefix}-base-${src}`, `${prefix}-relief`, `${prefix}-labels`.
  function filterDefs(style, theme, prefix = 'ms') {
    const half = style[theme];
    if (!half) return '';
    const m = half.map;
    return Object.keys(SOURCES).map((src) => baseFilter(`${prefix}-base-${src}`, src, m)).join('') +
      reliefFilter(`${prefix}-relief`, m) + labelFilter(`${prefix}-labels`, m);
  }

  // A style's effective scope palette: the base theme with its overrides.
  // One rule is applied rather than trusted to each style: the speed line of
  // an ordinary data block (textNormal[2]) must not look like the overhead
  // amber. Several styles inherited a gold speed line, which put "overhead"
  // on every block on the scope and diluted the one colour that means it.
  //
  // Two more, found by an adversarial pass: block text a style inherits was
  // tuned for CLASSIC's panels (the light overhead callsign measured 2.95:1
  // on its own block), so every block line is nudged to 4.5:1 on its panel;
  // and the 7700 flash needs a partner colour that stands off THIS map and
  // THESE altitude bands — CLASSIC's white vanished on every light ground.
  function inksFor(style, theme) {
    const half = style[theme];
    const inks = { ...BASE_INKS[theme], ...(half && half.inks) };
    if (style.classic) return inks;
    const solidOf = (c) => {
      const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(c);
      return m ? '#' + m.slice(1, 4).map((v) => (+v).toString(16).padStart(2, '0')).join('') : c;
    };
    const guard = (lines, bg) => lines.map((c) => ensure(c, solidOf(bg), 4.5, luminance(solidOf(bg)) < 0.2 ? '#ffffff' : '#000000'));
    inks.textNormal = guard(inks.textNormal, inks.blockBg);
    inks.textOverhead = guard(inks.textOverhead, inks.amberBg);
    inks.textMil = guard(inks.textMil, inks.milBg);
    if (deltaE(inks.textNormal[2], inks.amber) < 20 || deltaE(inks.textNormal[2], inks.textOverhead[0]) < 20) {
      inks.textNormal[2] = inks.textNormal[3];
    }
    const m = half.map;
    const fields = [m.water, m.land, m.urban || m.land];
    const stands = (c) => Math.min(...fields.map((x) => contrast(c, x))) >= 3 &&
      [...inks.altBands, inks.amber].every((b) => deltaE(c, b) >= 20) && deltaE(c, inks.mil) >= 40;
    inks.emergFlash = ['#ffffff', '#000000', '#ffe600', '#00e5ff', '#ff4dff', '#5b1a8c', '#004d40'].find(stands) || inks.policeWhite;
    return inks;
  }

  // CSS custom properties for the chrome, from the six a style names plus the
  // style's own status inks. The status tokens (--warn overhead, --mil
  // military, --police) used to stay at CLASSIC's values, so the list and
  // header spoke a different colour language from the scope beside them.
  // Guards keep the derived values legible on the style's bar: muted text
  // 4.6:1, accent 3:1, borders 1.8:1 — a style's hand-picked values only move
  // if they fall short.
  function chromeVars(half, inks) {
    const c = half.chrome, m = half.map;
    const toward = luminance(c.bar) < 0.2 ? '#ffffff' : '#000000';
    const border = ensure(c.border, c.bar, 1.8, toward);
    return {
      '--stage-bg': m.water,
      '--bar-bg': c.bar,
      '--bar-ink': ensure(c.ink, c.bar, 4.5, toward),
      '--bar-bright': ensure(c.bright, c.bar, 7, toward),
      '--muted': ensure(c.muted, c.bar, 4.6, toward),
      '--accent': ensure(c.accent, c.bar, 3, toward),
      '--panel-bg': rgba(c.bar, 0.9),
      '--panel-border': border,
      '--panel-line': mix(c.bar, border, 0.45),
      '--hover-bg': mix(c.bar, border, 0.25),
      '--input-bg': c.bar,
      '--input-border': border,
      '--btn-bg': mix(c.bar, border, 0.35),
      '--warn': inks.amber,
      // Text on the bar (the header's "N OVERHEAD") needs 4.5:1, which an ink
      // tuned for the map may not have against the chrome.
      '--warn-text': ensure(inks.amber, c.bar, 4.5, toward),
      // Military rows in the lists. Not --bad: that is the app's error red
      // (a dead feed), which does not change meaning when the style does.
      '--mil': inks.mil,
      '--police': inks.police,
    };
  }

  const CHROME_VARS = ['--stage-bg', '--bar-bg', '--bar-ink', '--bar-bright', '--muted', '--accent', '--panel-bg',
    '--panel-border', '--panel-line', '--hover-bg', '--input-bg', '--input-border', '--btn-bg',
    '--warn', '--warn-text', '--mil', '--police'];

  const byId = (id) => STYLES.find((s) => s.id === id) || STYLES[0];
  return { STYLES, BASE_INKS, CHROME_VARS, byId, inksFor, filterDefs, chromeVars, labelKind, rampOf, sample, contrast, luminance, mix, deltaE, lab };
});
