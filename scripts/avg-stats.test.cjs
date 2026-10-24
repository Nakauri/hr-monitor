#!/usr/bin/env node
// Monitor stats over a series with dropout gaps, and Uptime after a Reset while connected.
// Guards: Avg HRV counted gap markers ({ v: null }) as zero and read low after every dropout;
// Reset while connected cleared the connection log, so Uptime read 0% for the rest of the session.
// Run: node scripts/avg-stats.test.cjs [path/to/hr_monitor.html]   (exit 0 = OK; main before grade-a must FAIL)
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
check('Avg HRV goes through seriesStats', /seriesStats\(state\.rmssdSeries\)/.test(upd));
check('Avg HR goes through seriesStats', /seriesStats\(state\.hrSeries\)/.test(upd));
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

// 2. Uptime after Reset while connected.
const reset = grab('resetSession') || '';
const at = reset.indexOf('state.startTime = ');
const log = reset.indexOf("logConnectionEvent('connect')");
check('resetSession logs a connect after restarting the clock', at >= 0 && log > at);
const up = grab('updateUptimeStat');
check('updateUptimeStat exists', !!up);
if (up) {
  let shown;
  const ctx = { state: { startTime: 1, connectionEvents: [{ t: 0, type: 'connect' }] }, $: () => ({}), UI: { setKpi: (el, v) => { shown = v; } }, Math };
  vm.runInNewContext(up + '; updateUptimeStat(10)', ctx);
  check('a session that has been connected since reset reads 100% uptime', shown != null && Math.round(parseFloat(shown)) === 100, String(shown));
}

if (failures) { console.log('\n' + failures + ' check(s) failed'); process.exit(1); }
console.log('\nAll avg-stats checks passed');
