#!/usr/bin/env node
// Contrast check for the map styles in web/styles.js:
//
//   npm run check:styles
//
// Every style repaints both the basemap and the scope, and the two are one
// system — an ink that clears its bar on one style's land can vanish on the
// next style's water. This measures each style's effective inks (its
// overrides on top of the base palette) against the colours that style
// actually puts on the map, and fails on anything under its bar:
//
//   4.5:1  aircraft (every altitude band), overhead amber, trails, own
//          position, airports, place names against their halo, and data-block
//          text against the block's own panel
//   3:1    guides — range rings, leader lines, block borders (WCAG 1.4.11)
//
// "On the map" means water, land and built-up: the fields an aircraft
// actually sits on. Roads and the coast hairline are too thin to count.
// CLASSIC is skipped — its inks were measured against the rendered tiles
// directly, which is the stricter test, and its values are in the comments.
'use strict';

const S = require('../web/styles.js');

// Blocks sit on a translucent panel; over the darkest field underneath is the
// case that decides legibility, but the panel is ≥ 0.92 opaque, so its own
// colour is what text is read against.
const solid = (c) => {
  const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(c);
  return m ? '#' + m.slice(1, 4).map((v) => (+v).toString(16).padStart(2, '0')).join('') : c;
};

let failed = 0;
for (const style of S.STYLES) {
  if (style.classic) continue;
  for (const theme of ['dark', 'light']) {
    const half = style[theme];
    const m = half.map;
    const inks = { ...S.BASE_INKS[theme], ...half.inks };
    const fields = m.ramp
      ? { water: m.water, land: m.land }
      : { water: m.water, land: m.land, 'built-up': m.urban };
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
    onMap('trail', inks.trail, 4.5);
    onMap('home', inks.home, 4.5);
    onMap('airport', inks.airport, 4.5);
    onMap('ring', inks.ring, 3);
    onMap('leader', inks.leader, 3);
    onMap('blockEdge', inks.blockEdge, 3);
    onMap('amberEdge', inks.amberEdge, 3);
    const bg = solid(inks.blockBg);
    inks.textNormal.slice(0, 2).forEach((c, i) =>
      rows.push([`text${i}`, c, S.contrast(c, bg), 4.5, 'on block']));
    rows.push(['ringText', inks.ringText, S.contrast(inks.ringText, solid(inks.ringLabelBg)), 4.5, 'on ring label']);
    rows.push(['labels', m.label, S.contrast(m.label, m.halo || m.land), 4.5, 'on halo']);

    const bad = rows.filter((r) => r[2] < r[3]);
    failed += bad.length;
    console.log(`\n${style.label} · ${theme}${bad.length ? `  — ${bad.length} under bar` : ''}`);
    for (const [name, color, ratio, bar, where] of rows) {
      const flag = ratio < bar ? 'FAIL' : 'ok  ';
      console.log(`  ${flag} ${name.padEnd(10)} ${color}  ${ratio.toFixed(2).padStart(5)}:1  (bar ${bar}, ${where})`);
    }
  }
}
console.log(failed ? `\n${failed} ink(s) under their bar.` : '\nEvery style clears its bars.');
process.exit(failed ? 1 : 0);
