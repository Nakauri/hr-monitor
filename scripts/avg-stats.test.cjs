#!/usr/bin/env node
// Monitor stats over a series with dropout gaps.
// Guards: Avg HRV counted gap markers ({ v: null }) as zero and read low after every dropout
// (replay 2026-10-24: 103 of 984 recordings shown 1 to 3 ms low).
// Runtime: under 1 s. Run: node scripts/avg-stats.test.cjs [path/to/hr_monitor.html]   (exit 0 = OK; main before grade-a must FAIL)
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const file = process.argv[2] || path.join(__dirname, '..', 'hr_monitor.html');
const src = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
let failures = 0;
function check(name, ok, detail) {
  console.log((ok ? 'OK    ' : 'FAIL  ') + name + (detail ? '  ' + detail : ''));
  if (!ok) failures++;
}
function grab(name) {
  const m = new RegExp('^[ \\t]*function ' + name + '\\(', 'm').exec(src);
  if (!m) return null;
  const i = m.index, j = src.indexOf('{', src.indexOf(')', i));
  let d = 0;
  for (let k = j; k < src.length; k++) {
    if (src[k] === '{') d++;
    else if (src[k] === '}' && --d === 0) return src.slice(i, k + 1);
  }
  return null;
}

// 1. Every series average skips gap markers, HR and HRV alike.
const stats = grab('seriesStats');
check('seriesStats exists', !!stats);
const upd = grab('updateStats') || '';
// Over the session's full record, not the chart's capped series (a long session's averages lost their start).
check('Avg HRV goes through seriesStats over the full record', /seriesStats\(state\.full\.rmssdSeries\)/.test(upd));
check('Avg HR goes through seriesStats over the full record', /seriesStats\(state\.full\.hrSeries\)/.test(upd));
check('the Palps and Warnings counts read the full record', /state\.full\.ectopicEvents\.length/.test(upd) && /state\.full\.warnings\.length/.test(upd));
check('no average divides by a raw series length', !/\/\s*\w+\.length\)/.test(upd.replace(/\/\/.*$/gm, '')));
if (stats) {
  const s = vm.runInNewContext(stats + '; seriesStats', {});
  const gap = [{ v: 40 }, { v: null }, { v: 60 }, { v: null }, { v: 50 }];
  const r = s(gap);
  check('a series with gaps averages its readings only', r.n === 3 && r.sum / r.n === 50, JSON.stringify(r));
  check('max and min ignore gaps', r.max === 60 && r.min === 40);
  const e = s([{ v: null }]);
  check('an all-gap series has no readings', e.n === 0);
}

if (failures) { console.log('\n' + failures + ' check(s) failed'); process.exit(1); }
console.log('\nAll avg-stats checks passed');
