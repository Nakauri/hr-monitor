#!/usr/bin/env node
// Day boundaries in hrv_viewer.html go through one helper module (dayWindow, dayKeyOf, localDateLabel) [K6, L2, L3].
// Guards: a stray midnight ('T00:00:00', setHours(0) outside the module, which drifts from the day start
// (B6 class: UTC vs local), and label and data keys swapping callers. A line that only builds a display label
// carries '// date-label'. Day start is midnight (decision 2026-10-09).
// Run: node scripts/day-boundary.test.cjs [path/to/hrv_viewer.html]   (exit 0 = OK; HEAD before B-b1 must FAIL)

const fs = require('fs');
const path = require('path');

const file = process.argv[2] || path.join(__dirname, '..', 'hrv_viewer.html');
const src = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
let failures = 0;
function check(name, ok, detail) {
  console.log((ok ? 'OK    ' : 'FAIL  ') + name + (detail ? '  ' + detail : ''));
  if (!ok) failures++;
}

const BEGIN = '// ===== Day helper module BEGIN =====';
const END = '// ===== Day helper module END =====';
const b = src.indexOf(BEGIN), e = src.indexOf(END);
const hasModule = b >= 0 && e > b;
check('day helper module present', hasModule);
const modStart = hasModule ? b : -1, modEnd = hasModule ? e + END.length : -1;
const inModule = (i) => i >= modStart && i < modEnd;
const lineOf = (i) => src.slice(0, i).split('\n').length;
const lineText = (i) => src.slice(src.lastIndexOf('\n', i) + 1, (src.indexOf('\n', i) + 1 || src.length + 1) - 1);

// Midnight literals outside the module.
const hits = [];
for (const re of [/T00:00:00/g, /setHours\(0\b/g]) {
  let m;
  while ((m = re.exec(src))) {
    if (inModule(m.index)) continue;
    if (/\/\/ date-label\b/.test(lineText(m.index))) continue;
    hits.push(lineOf(m.index) + ': ' + lineText(m.index).trim().slice(0, 90));
  }
}
check('no T00:00:00 or setHours(0 outside the module except // date-label lines', hits.length === 0, hits.length + ' hit(s)' + (hits.length ? '\n        ' + hits.join('\n        ') : ''));

// A UTC date as a day key ('today' turns into tomorrow west of UTC in the evening).
const isoHits = [];
{
  const re = /toISOString\(\)\.slice\(0,\s*10\)/g;
  let m;
  while ((m = re.exec(src))) if (!inModule(m.index)) isoHits.push(lineOf(m.index) + ': ' + lineText(m.index).trim().slice(0, 90));
}
check('no toISOString().slice(0, 10) day key outside the module', isoHits.length === 0, isoHits.join(' | '));

// Innermost named function around an offset (naive brace match, as harness-V/lib.cjs grabs functions).
const fns = [];
{
  const re = /function\s+(\w+)\s*\(/g;
  let m;
  while ((m = re.exec(src))) {
    const open = src.indexOf('{', src.indexOf(')', m.index));
    let d = 0, k = open;
    for (; k < src.length; k++) {
      if (src[k] === '{') d++;
      else if (src[k] === '}' && --d === 0) break;
    }
    fns.push({ name: m[1], a: open, b: k });
  }
}
function enclosing(i) {
  let best = null;
  for (const f of fns) if (f.a < i && i < f.b && (!best || f.b - f.a < best.b - best.a)) best = f;
  return best ? best.name : '(top level)';
}
function callers(name) {
  const out = [];
  const re = new RegExp('(?<![\\w.])' + name + '\\(', 'g');
  let m;
  while ((m = re.exec(src))) {
    if (inModule(m.index)) continue;
    if (/function\s+$/.test(src.slice(Math.max(0, m.index - 12), m.index))) continue;
    out.push(enclosing(m.index));
  }
  return out;
}
const sameSet = (got, want) => {
  const g = Array.from(new Set(got)).sort(), w = want.slice().sort();
  return { ok: got.length > 0 && JSON.stringify(g) === JSON.stringify(w), detail: 'callers: ' + (got.length ? Array.from(new Set(got)).sort().join(', ') : 'none') };
};

// Data epochs (a sample, a session start, now) take dayKeyOf.
let r = sameSet(callers('dayKeyOf'), ['sessionLocalDateKey', 'localDateKeyToday', 'summarizeCSV', 'loadSessions', 'rebuildSessionsByDate']);
check('dayKeyOf only at the data-epoch sites', r.ok, r.detail);
// Calendar cursors and week bounds take localDateLabel.
r = sameSet(callers('localDateLabel'), ['rangeCutoffISO', 'renderWeek', 'bucketKey']);
check('localDateLabel only at the label sites', r.ok, r.detail);
// Every day window comes from dayWindow, including the virtual day: key [L3].
r = sameSet(callers('dayWindow'), ['parseSessionFilename', 'sessionDayPortion', 'buildDaySession', 'eventsInDayRange', 'renderWeek', 'bucketKey', 'dayUnionDuration']);
check('dayWindow at every window site', r.ok, r.detail);
const leftover = callers('localDateKeyFromEpoch');
check('localDateKeyFromEpoch has no caller outside the module', hasModule && leftover.length === 0, leftover.join(', '));
const dsh = (src.match(/const DAY_START_HOUR = (\d+);/) || [])[1];
check('day start is midnight (DAY_START_HOUR = 0)', dsh === '0', 'DAY_START_HOUR=' + dsh);

if (failures) { console.log('\n' + failures + ' check(s) failed'); process.exit(1); }
console.log('\nAll day-boundary checks passed');
