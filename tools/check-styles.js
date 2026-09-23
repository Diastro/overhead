#!/usr/bin/env node
// Contrast and meaning check for the map styles in web/styles.js:
//
//   npm run check:styles
//
// Every style repaints both the basemap and the scope, and the two are one
// system — an ink that clears its bar on one style's land can vanish on the
// next style's water. This measures each style's effective inks (its
// overrides on top of the base palette, via styles.inksFor — the same
// function the app paints from) against the colours that style actually puts
// on the map, and fails on anything under its bar.
//
// CONTRAST (luminance ratio):
//   4.5:1  aircraft (every altitude band), overhead amber, military, police,
//          trails, own position, airports, place names on their halo, and
//          data-block text on the block's own panel
//   3:1    guides — range rings, leader lines, block borders (WCAG 1.4.11)
//
// "On the map" means every broad field a target can sit on: water, land,
// built-up — and, where a style adds them, its shoal bands, the relief shadow
// at half depth, and the dusk wash at its strongest. The first version of
// this check measured only water/land/built-up and passed styles whose
// shadows and shoals took targets under 2:1.
//
// MEANING (CIE ΔE — how different two colours look; contrast cannot see
// that two reds at 1.07:1 are the same red):
//   ΔE ≥ 20  between overhead, military and police, and between each of them
//            and every altitude band — a status that looks like traffic is
//            not a status. Two review lenses found military painted in the
//            same red as low civil traffic, and the same white as FL300+.
//   ΔE ≥ 20  between the chrome accent and each status colour, since the lists
//            colour ordinary rows with the accent and status rows with these
//   flash    the 7700 flash partner: 3:1 on every map field, ΔE ≥ 20 from
//            every band and the overhead amber, ΔE ≥ 40 from military red
//   hue      military stays red (330–30°) and police blue (200–260°): the
//            meaning is fixed, only the lightness may move per style
//
// BLOCKS AND CHROME: every line of the normal, overhead and military data
// blocks at 4.5:1 on its own panel, and the bar's text at 4.5:1 (bright 7:1).
// The first versions measured only the normal block's top two lines, and an
// adversarial pass set the overhead callsign equal to its own panel and still
// got a pass.
//
// GUARD DRIFT: styles.js nudges block text and chrome text until they clear
// their bars, so what is painted is legible even when the palette is not. A
// nudge is for a colour that is nearly right; one that has to travel ΔE > 30
// means the palette says something the app will not show, and fails here so
// it gets fixed at the source rather than silently repaired.
//
// Deliberately NOT measured: roads and the coast hairline (too thin to carry
// a target), and full-depth relief shadow (a slope, not a field).
//   ramp     altitude bands monotonic in lightness, neighbours ΔE ≥ 6, ends
//            ≥ 2:1 apart — five bands nobody can tell apart are no ramp
//
// CLASSIC is skipped — its inks were measured against the rendered tiles
// directly, and its values are in the comments.
'use strict';

const S = require('../web/styles.js');

const solid = (c) => {
  const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(c);
  return m ? '#' + m.slice(1, 4).map((v) => (+v).toString(16).padStart(2, '0')).join('') : c;
};
// Multiply blend, and "over" at an opacity — how relief and wash land on a field.
const multiply = (a, b, op) => {
  const h = (x) => [1, 3, 5].map((i) => parseInt(x.slice(i, i + 2), 16));
  const [ra, ga, ba] = h(a), [rb, gb, bb] = h(b);
  const m = [ra * rb / 255, ga * gb / 255, ba * bb / 255];
  return S.mix(a, '#' + m.map((v) => Math.round(v).toString(16).padStart(2, '0')).join(''), op);
};

const hue = (c) => { const [, a, b] = S.lab(c); return (Math.atan2(b, a) * 180 / Math.PI + 360) % 360; };
const inRange = (h, lo, hi) => (lo < hi ? h >= lo && h <= hi : h >= lo || h <= hi);
// LAB hue angles (not HSL): red ≈ 30-40°, blue ≈ 280-300°.
const MIL_HUE = [0, 60], POLICE_HUE = [260, 305];

let failed = 0;
for (const style of S.STYLES) {
  if (style.classic) continue;
  for (const theme of ['dark', 'light']) {
    const half = style[theme];
    const m = half && half.map;
    // A malformed style is a failure to report, not a crash to debug.
    const missing = !half ? ['the whole half'] : ['water', 'land', 'label'].filter((k) => !m || !m[k])
      .concat(!half.chrome ? ['chrome'] : []).concat(m && !m.ramp && !m.urban ? ['urban (or ramp)'] : []);
    if (missing.length) {
      console.log(`\n${style.label} · ${theme}  — FAIL malformed: missing ${missing.join(', ')}`);
      failed++;
      continue;
    }
    const inks = S.inksFor(style, theme);
    const fields = m.ramp
      ? { water: m.water, land: m.land, 'bright ground': S.sample(m.ramp, 0.9) }
      : { water: m.water, land: m.land, 'built-up': m.urban };
    (m.shoal || []).forEach(([c], i) => { fields[`shoal${i}`] = c; });
    if (m.relief) {
      // Half-depth shadow: the table maps hillshade 0.45 → mix(shadow, white, .5).
      fields['relief shadow'] = multiply(m.land, S.mix(m.relief.shadow, '#ffffff', 0.5), m.relief.op);
    }
    if (half.fx?.wash) {
      const [, bottom, op] = half.fx.wash;
      for (const k of Object.keys(fields)) fields[`${k}+wash`] = S.mix(fields[k], bottom, op);
    }
    const rows = [];
    const onMap = (name, color, bar) => {
      let worst = Infinity, where = '';
      for (const [f, c] of Object.entries(fields)) {
        const r = S.contrast(color, c);
        if (r < worst) { worst = r; where = f; }
      }
      rows.push([name, color, worst, bar, `on ${where}`]);
    };
    inks.altBands.forEach((c, i) => onMap(`altBand${i}`, c, 4.5));
    onMap('amber', inks.amber, 4.5);
    onMap('mil', inks.mil, 4.5);
    onMap('police', inks.police, 4.5);
    onMap('trail', inks.trail, 4.5);
    onMap('home', inks.home, 4.5);
    onMap('airport', inks.airport, 4.5);
    onMap('ring', inks.ring, 3);
    onMap('leader', inks.leader, 3);
    onMap('blockEdge', inks.blockEdge, 3);
    onMap('amberEdge', inks.amberEdge, 3);
    for (const [set, bgKey] of [['textNormal', 'blockBg'], ['textOverhead', 'amberBg'], ['textMil', 'milBg']]) {
      const bg = solid(inks[bgKey]);
      inks[set].forEach((c, i) => rows.push([`${set}${i}`, c, S.contrast(c, bg), 4.5, `on ${bgKey}`]));
    }
    rows.push(['ringText', inks.ringText, S.contrast(inks.ringText, solid(inks.ringLabelBg)), 4.5, 'on ring label']);
    rows.push(['labels', m.label, S.contrast(m.label, m.halo || m.land), 4.5, 'on halo']);

    // Meaning: status colours must not look like traffic, or like each other.
    const status = { amber: inks.amber, mil: inks.mil, police: inks.police };
    const dE = [];
    for (const [n, c] of Object.entries(status)) {
      inks.altBands.forEach((b, i) => dE.push([`${n}~altBand${i}`, S.deltaE(c, b), 20]));
    }
    dE.push(['amber~mil', S.deltaE(inks.amber, inks.mil), 20],
      ['amber~police', S.deltaE(inks.amber, inks.police), 20],
      ['mil~police', S.deltaE(inks.mil, inks.police), 20],
      ['speedLine~amber', S.deltaE(inks.textNormal[2], inks.amber), 20],
      ['speedLine~ovhdText', S.deltaE(inks.textNormal[2], inks.textOverhead[0]), 20]);
    const chrome = S.chromeVars(half, inks);
    for (const [n, v] of [['warn', '--warn'], ['mil', '--mil'], ['police', '--police']]) {
      dE.push([`accent~${n}`, S.deltaE(chrome['--accent'], chrome[v]), 20]);
    }
    for (const [name, v, bar] of dE) rows.push([name, '', v, bar, 'ΔE']);
    const flash = inks.emergFlash || inks.policeWhite;
    rows.push(['emergFlash~mil', flash, S.deltaE(flash, inks.mil), 40, 'ΔE to military red']);
    onMap('emergFlash', flash, 3);
    inks.altBands.concat(inks.amber).forEach((b, i) => rows.push([`emergFlash~${i < 5 ? 'altBand' + i : 'amber'}`, flash, S.deltaE(flash, b), 20, 'ΔE']));
    rows.push(['milHue', inks.mil, inRange(hue(inks.mil), ...MIL_HUE) ? 1 : 0, 1, 'military stays red']);
    rows.push(['policeHue', inks.police, inRange(hue(inks.police), ...POLICE_HUE) ? 1 : 0, 1, 'police stays blue']);
    const authored = { ...S.BASE_INKS[theme], ...half.inks };
    for (const set of ['textNormal', 'textOverhead', 'textMil']) {
      authored[set].forEach((c, i) => {
        // textNormal[2] is swapped outright when it looks like overhead amber —
        // a rule in inksFor, not a guard nudge — so its distance means nothing.
        if (set === 'textNormal' && i === 2) return;
        rows.push([`${set}${i}Drift`, c, 30 - S.deltaE(c, inks[set][i]), 0, 'guard moved it ΔE (30 − shown)']);
      });
    }
    for (const [k, v] of [['ink', '--bar-ink'], ['bright', '--bar-bright'], ['muted', '--muted'], ['accent', '--accent'], ['border', '--panel-border']]) {
      rows.push([`${k}Drift`, half.chrome[k], 30 - S.deltaE(half.chrome[k], chrome[v]), 0, 'guard moved it ΔE (30 − shown)']);
    }
    rows.push(['barInk', chrome['--bar-ink'], S.contrast(chrome['--bar-ink'], half.chrome.bar), 4.5, 'on bar']);
    rows.push(['barBright', chrome['--bar-bright'], S.contrast(chrome['--bar-bright'], half.chrome.bar), 7, 'on bar']);
    rows.push(['warnText', chrome['--warn-text'], S.contrast(chrome['--warn-text'], half.chrome.bar), 4.5, 'on bar']);
    rows.push(['muted', chrome['--muted'], S.contrast(chrome['--muted'], half.chrome.bar), 4.5, 'on bar']);

    // The ramp must still be a ramp.
    const Ls = inks.altBands.map((c) => S.lab(c)[0]);
    const dir = Math.sign(Ls[4] - Ls[0]);
    const mono = Ls.every((v, i) => i === 0 || Math.sign(v - Ls[i - 1]) === dir);
    rows.push(['rampOrder', '', mono ? 1 : 0, 1, 'lightness monotonic']);
    let minStep = Infinity;
    for (let i = 1; i < 5; i++) minStep = Math.min(minStep, S.deltaE(inks.altBands[i], inks.altBands[i - 1]));
    rows.push(['rampStep', '', minStep, 6, 'ΔE between neighbours']);
    rows.push(['rampSpan', '', S.contrast(inks.altBands[0], inks.altBands[4]), 2, 'lowest vs highest']);

    const bad = rows.filter((r) => r[2] < r[3]);
    failed += bad.length;
    if (process.argv.includes('-v') || bad.length) {
      console.log(`\n${style.label} · ${theme}${bad.length ? `  — ${bad.length} under bar` : ''}`);
      for (const [name, color, ratio, bar, where] of process.argv.includes('-v') ? rows : bad) {
        const flag = ratio < bar ? 'FAIL' : 'ok  ';
        console.log(`  ${flag} ${name.padEnd(18)} ${String(color).padEnd(9)} ${ratio.toFixed(2).padStart(6)}  (bar ${bar}, ${where})`);
      }
    } else {
      console.log(`${style.label} · ${theme}: ok`);
    }
  }
}
console.log(failed ? `\n${failed} check(s) under their bar.` : '\nEvery style clears its bars.');
process.exit(failed ? 1 : 0);
