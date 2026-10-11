#!/usr/bin/env node
// Guards: CSV column drift and a second writer of state.events. Files: hr_monitor.html buildSessionCSV, addMarker. Runtime: under 1 s.
// CSV row-shape test for the native writer (NativeCsvWriter.java).
// Reads the Java source as text, so a column added to the header but not to
// the row format strings (or the reverse) fails here before a build.
// Also checks that a missing RMSSD is written as an empty field, not 0.00,
// and the web monitor's legacy event cell for Log row marks (S4b).
// Run: node scripts/csv-format.test.cjs (exit 0 = OK).

const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'mobile', 'android-overlay', 'app', 'src', 'main',
  'java', 'com', 'nakauri', 'hrmonitor', 'NativeCsvWriter.java');
const java = fs.readFileSync(SRC, 'utf8');

let failures = 0;
function check(name, ok, detail) {
  console.log((ok ? 'OK    ' : 'FAIL  ') + name + (detail ? '  ' + detail : ''));
  if (!ok) failures++;
}

// Body of a Java method, from its signature to the matching closing brace.
function methodBody(name) {
  const start = java.search(new RegExp('void\\s+' + name + '\\s*\\('));
  if (start < 0) return null;
  const open = java.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < java.length; i++) {
    if (java[i] === '{') depth++;
    else if (java[i] === '}' && --depth === 0) return java.slice(open, i + 1);
  }
  return null;
}

// The row format string passed to writer.write(String.format(Locale.US, "...", ...)).
function rowFormat(body) {
  const m = body && body.match(/writer\.write\(String\.format\(Locale\.US,\s*"([^"]*)"/);
  return m ? m[1] : null;
}

// Minimal java.util.Formatter for the specifiers the writer uses.
function jformat(fmt, args) {
  let i = 0;
  return fmt.replace(/%(\.\d+)?([dfs%])/g, (all, prec, conv) => {
    if (conv === '%') return '%';
    const v = args[i++];
    if (conv === 'd') return String(Math.trunc(v));
    if (conv === 's') return String(v);
    return Number(v).toFixed(prec ? Number(prec.slice(1)) : 6);
  });
}

const headerMatch = java.match(/HEADER\s*=\s*"([^"]+)"/);
check('HEADER found', !!headerMatch);
const header = headerMatch ? headerMatch[1].split(',') : [];
check('HEADER has 12 columns', header.length === 12, 'got ' + header.length);
check('rmssd_ms is column 4', header[3] === 'rmssd_ms', 'got ' + header[3]);

const hrBody = methodBody('appendHrRow');
const hrFmt = rowFormat(hrBody);
check('appendHrRow format found', !!hrFmt);
const connFmt = rowFormat(methodBody('appendConnectionRow'));
check('appendConnectionRow format found', !!connFmt);

// RMSSD is passed as a pre-formatted string so null can become "".
check('RMSSD slot is %s', !!hrFmt && hrFmt.split(',')[3] === '%s', hrFmt || '');
check('RMSSD param is a nullable Double', /appendHrRow\(\s*int\s+hr,\s*Double\s+rmssd/.test(java));
check('null RMSSD maps to empty string',
  /rmssd\s*==\s*null\s*\?\s*""\s*:\s*String\.format\(Locale\.US,\s*"%\.2f",\s*rmssd\)/.test(hrBody || ''));

function emulateHrRow(rmssd) {
  const rmssdField = rmssd == null ? '' : jformat('%.2f', [rmssd]);
  return jformat(hrFmt, [1.25, 1760000000000, 88, rmssdField, 41.5, 52.25, 60]);
}

if (hrFmt) {
  const withValue = emulateHrRow(42.123).split(',');
  const missing = emulateHrRow(null).split(',');
  check('HR row has 12 fields', withValue.length === header.length, 'got ' + withValue.length);
  check('HR row with missing RMSSD has 12 fields', missing.length === header.length, 'got ' + missing.length);
  check('RMSSD value written as %.2f', withValue[3] === '42.12', 'got ' + withValue[3]);
  check('missing RMSSD written empty', missing[3] === '', 'got "' + missing[3] + '"');
  check('hr_bpm intact on missing RMSSD row', missing[2] === '88', 'got ' + missing[2]);
  check('SDNN columns unchanged', missing.slice(4, 7).join('|') === '41.50|52.25|60.00', missing.slice(4, 7).join('|'));
}
if (connFmt) {
  const conn = jformat(connFmt, [1.25, 1760000000000, 'connected']).split(',');
  check('connection row has 12 fields', conn.length === header.length, 'got ' + conn.length);
  check('connection state in connection column', conn[header.indexOf('connection')] === 'connected');
}

// ---- Web monitor legacy event cell (S4b) -----------------------------------
// The web monitor writes its own legacy CSV (buildSessionCSV). Symptom puts sym:symptom in the event
// column; a Note is sanitised so it never splits the row and never starts with sym: or ctx:.
const vm = require('vm');
const monitor = fs.readFileSync(path.join(__dirname, '..', 'hr_monitor.html'), 'utf8');
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
const symConst = (monitor.match(/const SYMPTOM_LABEL = '([^']*)';/) || [])[1];
check('web Symptom label is sym:symptom', symConst === 'sym:symptom', String(symConst));
const noteMax = (monitor.match(/const NOTE_MAX = (\d+);/) || [])[1];
const fnSrc = ['buildSessionCSV', 'sanitizeNote'].map((n) => jsFunction(monitor, n));
check('buildSessionCSV and sanitizeNote found', fnSrc.every(Boolean));
if (fnSrc.every(Boolean) && noteMax) {
  const t0 = 1760000000000;
  const ctx = { NOTE_MAX: Number(noteMax), state: {
    startTime: t0, hrSeries: [{ t: 0.5, v: 88 }], rmssdSeries: [{ t: 0.5, v: 40 }], sdnnMatchSeries: [], sdnn5minSeries: [], sdnnFullSeries: [],
    events: [], warnings: [], ectopicEvents: [], connectionEvents: [], postureLog: [] } };
  vm.createContext(ctx);
  vm.runInContext(fnSrc.join('\n'), ctx);
  const note = ctx.sanitizeNote('drank water,\r\nsat down, felt odd');
  check('Note sanitiser: commas and line breaks become spaces', note.text === 'drank water sat down felt odd' && !note.rejected, JSON.stringify(note));
  check('Note sanitiser: 80 characters at most', ctx.sanitizeNote('y'.repeat(200)).text.length === Number(noteMax) && Number(noteMax) === 80);
  const rejected = ['sym:dizzy', 'SYM:x', ' Ctx:water', 'ctx:'].filter((t) => ctx.sanitizeNote(t).rejected);
  check('Note sanitiser rejects a leading sym: or ctx: in any case', rejected.length === 4, rejected.join('|'));
  check('Note sanitiser keeps sym: inside the text', !ctx.sanitizeNote('ran out of sym: meds').rejected);
  ctx.state.events.push({ t: 1, label: symConst }, { t: 2, label: note.text }, { t: 3, label: 'ctx:water' });
  const out = ctx.buildSessionCSV().csv.split('\n');
  const head = out[0].split(',');
  const ev = head.indexOf('event');
  const rows = out.slice(1).map((l) => l.split(','));
  check('web CSV rows keep 12 fields with marks in them', head.length === 12 && rows.every((r) => r.length === 12), rows.map((r) => r.length).join(','));
  const cells = rows.map((r) => r[ev]).filter(Boolean);
  check('legacy event cells read sym:symptom, the note, ctx:water', cells.join('|') === 'sym:symptom|drank water sat down felt odd|ctx:water', cells.join('|'));
  check('the sym:symptom row carries its epoch', rows.some((r) => r[ev] === 'sym:symptom' && Number(r[1]) === t0 + 60000));
}
const add = jsFunction(monitor, 'addMarker') || '';
check('addMarker sends kind symptom for a sym: label, marker otherwise',
  /logNativeFact\(\s*\/\^sym:\/i\.test\(label\)\s*\?\s*'symptom'\s*:\s*'marker'/.test(add));
// S9: a native Undo removes its own mark from the Marks list (the row stays in the segment; a rev hides it).
const undo = jsFunction(monitor, 'undoNativeMark') || '';
check('addMarker is the only writer of state.events; undoNativeMark only removes one',
  (monitor.match(/state\.events\.(push|splice|unshift)\(/g) || []).length === 2 && /state\.events\.splice\(i, 0, ev\)/.test(add)
  && /state\.events\.splice\(i, 1\)/.test(undo) && !/state\.events\.(push|unshift)\(|splice\([^)]*,[^)]*,/.test(undo));
check('the free-text marker input is gone', !/id="marker-label"|id="add-marker"/.test(monitor));

if (failures) {
  console.log(failures + ' check(s) failed');
  process.exit(1);
}
console.log('All CSV format checks passed');
