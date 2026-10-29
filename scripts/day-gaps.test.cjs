#!/usr/bin/env node
// Guards: a day's gap hatch drawn over HR another recording has (2026-10-28: a web monitor left waiting all day while
// the phone recorded showed "1 gap · 24 h missing" and slashes across the whole zone strip). Files: viewer-parse.js
// gapsOutsideData, mergeGaps; hrv_viewer.html buildDaySession. Runtime: under 1 s.
// Run: node scripts/day-gaps.test.cjs   (exit 0 = OK)
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const { readViewerParts } = require('./viewer-src.cjs');

// The gap helpers live in viewer-parse.js; buildDaySession stays in the page.
const parts = readViewerParts();
const viewer = parts.html + '\n' + parts.mod;
let failures = 0;
function check(name, ok, detail) {
  console.log((ok ? 'OK    ' : 'FAIL  ') + name + (detail && !ok ? '  ' + detail : ''));
  if (!ok) failures++;
}
check('the gap helpers live in viewer-parse.js, not the page',
  ['gapsOutsideData', 'mergeGaps'].every((n) => jsFunction(parts.mod, n) && !jsFunction(parts.html, n)) && /const DATA_JUMP_GAP_MIN = /.test(parts.mod) && !/const DATA_JUMP_GAP_MIN = /.test(parts.html));
function jsFunction(src, name) {
  const start = src.search(new RegExp('function\\s+' + name + '\\s*\\('));
  if (start < 0) return null;
  const open = src.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
  }
  return null;
}

function load(src) {
  const jump = (src.match(/const DATA_JUMP_GAP_MIN = ([\d.]+);/) || [])[1];
  const fns = ['gapsOutsideData', 'mergeGaps'].map((n) => jsFunction(src, n));
  if (!jump || fns.some((f) => !f)) return null;
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext('const DATA_JUMP_GAP_MIN = ' + jump + ';\n' + fns.join('\n') + '\nthis.f = gapsOutsideData; this.m = mergeGaps;', ctx);
  return ctx;
}
// One sample a second over [a, b] minutes.
const samples = (a, b) => { const out = []; for (let x = a; x <= b + 1e-9; x += 1 / 60) out.push({ x, y: 80 }); return out; };
const fmt = (gs) => gs.map((g) => '[' + g.start.toFixed(2) + ',' + g.end.toFixed(2) + ']').join(' ');
const same = (gs, want) => gs.length === want.length && gs.every((g, i) => Math.abs(g.start - want[i][0]) < 0.02 && Math.abs(g.end - want[i][1]) < 0.02);

function cases(ctx) {
  const rows = [];
  if (!ctx) return [['gapsOutsideData, mergeGaps and DATA_JUMP_GAP_MIN found', false]];
  // The screenshot: a whole-day gap from one recording, HR from another from 60 to 1430 min.
  let g = ctx.f(ctx.m([{ start: 0, end: 1440 }]), samples(60, 1430));
  rows.push(['a whole-day gap with HR from 60 to 1430 min leaves only the two ends', same(g, [[0, 60], [1430, 1440]]), fmt(g)]);
  // HR with a 30 min hole inside the gap: the hole stays a gap.
  g = ctx.f([{ start: 0, end: 600 }], samples(0, 200).concat(samples(230, 600)));
  rows.push(['a real hole inside a covered gap stays a gap', same(g, [[200, 230]]), fmt(g)]);
  // No HR anywhere in the gap: unchanged.
  g = ctx.f([{ start: 100, end: 160 }], samples(0, 100).concat(samples(160, 300)));
  rows.push(['a gap with no HR in it is kept whole', same(g, [[100, 160]]), fmt(g)]);
  // A sliver under half a minute is dropped, not hatched.
  g = ctx.f([{ start: 99.9, end: 200 }], samples(0, 200));
  rows.push(['a gap fully covered by HR is gone', g.length === 0, fmt(g)]);
  // Gaps in order across several covered stretches.
  g = ctx.f([{ start: 0, end: 50 }, { start: 100, end: 300 }], samples(10, 40).concat(samples(150, 250)));
  rows.push(['several gaps and stretches are cut in order', same(g, [[0, 10], [40, 50], [100, 150], [250, 300]]), fmt(g)]);
  return rows;
}

for (const [n, ok, d] of cases(load(viewer))) check(n, ok, d);
const day = jsFunction(viewer, 'buildDaySession') || '';
check('the day view cuts its gaps by the day\'s HR, for the gaps note and the strip alike',
  /const recGaps = gapsOutsideData\(mergeGaps\(connGaps\), hr\);/.test(day)
  && /connGaps\.splice\(0, connGaps\.length, \.\.\.gapsOutsideData\(mergeGaps\(connGaps\), hr\)\);/.test(day));

// Negative control: a gapsOutsideData that returns the gaps unchanged must fail the cases.
const neg = viewer.replace(/function gapsOutsideData\(gaps, pts\) \{/, 'function gapsOutsideData(gaps, pts) { return gaps;');
const negCaught = cases(load(neg)).some((r) => !r[1]);
check('negative control: gaps left uncut fail the cases', negCaught);

if (failures) { console.log(failures + ' check(s) failed'); process.exit(1); }
console.log('All day gap checks passed');
