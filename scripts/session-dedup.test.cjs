// The viewer's duplicate-session rule (hrv_viewer.html dedupHideSet), run on the real function.
// Bug it exists for: a mid-session export (named by the moment of export, shorter than the
// auto-save) showed as a second overlapping session.
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(process.argv[2] || path.join(__dirname, '..', 'hrv_viewer.html'), 'utf8');
const head = 'function dedupHideSet(index) {';
const at = src.indexOf(head);
if (at < 0) { console.log('FAIL  dedupHideSet not found in hrv_viewer.html'); process.exit(1); }
let depth = 0, end = -1;
for (let i = at + head.length - 1; i < src.length; i++) {
  if (src[i] === '{') depth++;
  else if (src[i] === '}' && --depth === 0) { end = i + 1; break; }
}
const dedupHideSet = new Function(src.slice(at, end) + '\nreturn dedupHideSet;')();

let failures = 0;
function check(name, ok, detail) {
  console.log((ok ? 'OK    ' : 'FAIL  ') + name + (detail ? '  ' + detail : ''));
  if (!ok) failures++;
}
const T = Date.UTC(2026, 9, 28, 14, 3, 17);
const hidden = (index) => [...dedupHideSet(index)].sort().join(',');

check('dual save, same start and duration: the smaller copy is hidden',
  hidden({ a: { startEpoch: T, duration: 60, hrCount: 3600 }, b: { startEpoch: T + 400, duration: 60, hrCount: 3500 } }) === 'b');
check('mid-session export, same start second, shorter: the export is hidden',
  hidden({ full: { startEpoch: T, duration: 90, hrCount: 5400 }, exp: { startEpoch: T + 200, duration: 30, hrCount: 1800 } }) === 'exp');
check('export kept when it is the only copy',
  hidden({ exp: { startEpoch: T, duration: 30, hrCount: 1800 } }) === '');
check('two real sessions started seconds apart in one minute: both kept',
  hidden({ a: { startEpoch: T, duration: 0.3, hrCount: 18 }, b: { startEpoch: T + 20000, duration: 45, hrCount: 2700 } }) === '');
check('sessions on different days: both kept',
  hidden({ a: { startEpoch: T, duration: 60, hrCount: 3600 }, b: { startEpoch: T + 86400000, duration: 60, hrCount: 3600 } }) === '');
check('entries without a start are ignored',
  hidden({ a: { duration: 60 }, b: null, c: { startEpoch: T, duration: 60, hrCount: 1 } }) === '');

if (failures) { console.log(failures + ' session dedup check(s) FAILED.'); process.exit(1); }
console.log('All session dedup checks passed.');
