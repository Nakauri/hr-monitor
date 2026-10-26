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
  const series = () => ({ hrSeries: [{ t: 0.5, v: 88 }], rmssdSeries: [{ t: 0.5, v: 40 }], sdnnMatchSeries: [], sdnn5minSeries: [], sdnnFullSeries: [],
    warnings: [], ectopicEvents: [], connectionEvents: [], postureLog: [], events: [] });
  const ctx = { NOTE_MAX: Number(noteMax), state: Object.assign({ startTime: t0, events: [], full: series() }, series()) };
  vm.createContext(ctx);
  vm.runInContext(fnSrc.join('\n'), ctx);
  const note = ctx.sanitizeNote('drank water,\r\nsat down, felt odd');
  check('Note sanitiser: commas and line breaks become spaces', note.text === 'drank water sat down felt odd' && !note.rejected, JSON.stringify(note));
  check('Note sanitiser: 80 characters at most', ctx.sanitizeNote('y'.repeat(200)).text.length === Number(noteMax) && Number(noteMax) === 80);
  const rejected = ['sym:dizzy', 'SYM:x', ' Ctx:water', 'ctx:'].filter((t) => ctx.sanitizeNote(t).rejected);
  check('Note sanitiser rejects a leading sym: or ctx: in any case', rejected.length === 4, rejected.join('|'));
  check('Note sanitiser keeps sym: inside the text', !ctx.sanitizeNote('ran out of sym: meds').rejected);
  ctx.state.full.events = [{ t: 1, label: symConst }, { t: 2, label: note.text }, { t: 3, label: 'ctx:water' }];
  const out = ctx.buildSessionCSV().csv.split('\n');
  const head = out[0].split(',');
  const ev = head.indexOf('event');
  const rows = out.slice(1).map((l) => l.split(','));
  check('web CSV rows keep 12 fields with marks in them', head.length === 12 && rows.every((r) => r.length === 12), rows.map((r) => r.length).join(','));
  const cells = rows.map((r) => r[ev]).filter(Boolean);
  check('legacy event cells read sym:symptom, the note, ctx:water', cells.join('|') === 'sym:symptom|drank water sat down felt odd|ctx:water', cells.join('|'));
  check('the sym:symptom row carries its epoch', rows.some((r) => r[ev] === 'sym:symptom' && Number(r[1]) === t0 + 60000));
}
// A long web session keeps its start: the chart's series stop at 5000 points, but the saved file is built from the
// session's full record (2026-10-25 re-grade: past about 83 min at 1 Hz the file lost its first rows, and the live
// palpitation list keeps only 10 min, so older palpitations never reached the file at all).
const longSrc = ['freshFullRecord', 'track', 'buildSessionCSV'].map((n) => jsFunction(monitor, n));
const fullCap = (monitor.match(/const FULL_CAP = (\d+);/) || [])[1];
check('track, freshFullRecord and FULL_CAP found', longSrc.every(Boolean) && !!fullCap);
if (longSrc.every(Boolean) && fullCap) {
  const t0 = 1760000000000;
  const lctx = { FULL_CAP: Number(fullCap), state: { startTime: t0, events: [], hrSeries: [], rmssdSeries: [], sdnnMatchSeries: [], sdnn5minSeries: [],
    sdnnFullSeries: [], warnings: [], ectopicEvents: [], connectionEvents: [], postureLog: [] } };
  vm.createContext(lctx);
  vm.runInContext(longSrc.join('\n') + '\nstate.full = freshFullRecord();', lctx);
  for (let i = 0; i < 6000; i++) lctx.track('hrSeries', { t: i / 60, v: 70 + (i % 9) }, 5000);
  lctx.track('ectopicEvents', { t: 1, rr: 600, dev: 0.3 }, 1000);
  // The live palpitation list keeps 10 min; the trim never touches the full record.
  lctx.state.ectopicEvents = lctx.state.ectopicEvents.filter((e) => e.t >= 90);
  const out = lctx.buildSessionCSV().csv.split('\n');
  const head = out[0].split(',');
  const rows = out.slice(1).map((l) => l.split(','));
  const hrCol = head.indexOf('hr_bpm'), palpCol = head.indexOf('palpitation');
  check('a 6000-sample web session saves its first sample and its last',
    rows.length >= 6000 && rows[0][0] === '0.0000' && rows[0][hrCol] === '70' && Number(rows[rows.length - 1][0]) > 99.9,
    rows.length + ' rows, first ' + (rows[0] || []).slice(0, 3).join(','));
  check('the chart series still stops at 5000 points', lctx.state.hrSeries.length === 5000 && lctx.state.full.hrSeries.length === 6000);
  check('a palpitation older than the live list\'s 10 min still reaches the file', rows.some((r) => r[0] === '1.0000' && r[palpCol] === '1'));
}
const add = jsFunction(monitor, 'addMarker') || '';
check('addMarker sends kind symptom for a sym: label, marker otherwise',
  /logNativeFact\(\s*\/\^sym:\/i\.test\(label\)\s*\?\s*'symptom'\s*:\s*'marker'/.test(add));
// S9: a native Undo removes its own mark from the Marks list (the row stays in the segment; a rev hides it).
const undo = jsFunction(monitor, 'undoNativeMark') || '';
// The whole-session file is paced as it grows (review 2026-10-25: a 48 h file rebuilt every 10 s took half a
// second each time, and uploaded whole once a minute came to about 10 GB), and the stop waits for the last upload.
const paceSrc = jsFunction(monitor, 'drivePaceMs');
const saveBig = (monitor.match(/const SAVE_BIG = (\d+) \* 1024;/) || [])[1];
if (paceSrc && saveBig) {
  const pctx = { SAVE_BIG: Number(saveBig) * 1024 };
  vm.createContext(pctx); vm.runInContext(paceSrc, pctx);
  const MB = 1048576;
  check('Drive pace: small files every save, then a minute per MB, at most 10 min',
    pctx.drivePaceMs(100 * 1024) === 0 && pctx.drivePaceMs(600 * 1024) === 60000 && pctx.drivePaceMs(2 * MB) === 120000 && pctx.drivePaceMs(20 * MB) === 600000);
} else check('drivePaceMs and SAVE_BIG found', false);
const was = jsFunction(monitor, 'writeAutoSave') || '';
const stopNow = jsFunction(monitor, 'stopSessionNow') || '';
const stopSave = jsFunction(monitor, 'stopSessionAutoSave') || '';
check('a big file is rebuilt at most once a minute, the final save always',
  /if \(!final && !force && autoSaveBytes > SAVE_BIG && Date\.now\(\) - autoSaveBuiltAt < 60000\) return;/.test(was) && /if \(final\) return await driveUploadSession\(filename, csv, true, gen\);/.test(was));
const RACE = 'const save = ended.finalSave = stopSessionAutoSave();';
check('the stop reads its facts, then awaits the final save before the after-stop panel, once per session',
  stopNow.indexOf('const ended = afterStopFacts();') >= 0 && stopNow.indexOf('const ended = afterStopFacts();') < stopNow.indexOf(RACE)
  && stopNow.indexOf(RACE) >= 0 && /await Promise\.race\(\[save\.then/.test(stopNow) && stopNow.indexOf(RACE) < stopNow.indexOf('showAfterStop(ended)')
  && /if \(autoSaveFinal\) return autoSaveFinal;/.test(stopSave) && /return job;/.test(jsFunction(monitor, 'driveUploadSession') || ''));
// Confirm 2026-10-25: the panel polled a status the save itself then overwrote (every folder+Drive stop read "not
// confirmed"), and a final save settling after the next Start cleared that session's folder file and Drive id.
const upload = jsFunction(monitor, 'driveUploadSession') || '';
const after = jsFunction(monitor, 'showAfterStop') || '';
check('the after-stop panel shows the final save\'s own result',
  /ended\.driveOk = r\.ok;/.test(stopNow) && /else if \(f\.driveOk === true\) set\('Saved to Drive'\);/.test(after) && /else if \(f\.driveOk === false\) set\('Drive upload failed', 'error'\);/.test(after));
check('an old session\'s save never touches the new session',
  /autoSaveGen\+\+;/.test(jsFunction(monitor, 'startSessionAutoSave') || '') && /if \(gen === autoSaveGen\) \{\s*autoSaveFileHandle = null;/.test(stopSave)
  && /if \(gen === autoSaveGen\) driveFileIdForSession = data\.id;/.test(upload) && (upload.match(/gen === autoSaveGen && typeof setAutoSaveStatus/g) || []).length === 2);
check('a page close writes a flushed mark past the rebuild pace', /writeAutoSave\(false, true\)/.test(monitor) && /if \(!final && !force && autoSaveBytes > SAVE_BIG/.test(was));
// The Marks list and the session's full record (the saved file) move together: one insert, one undo, no other writer.
check('addMarker is the only writer of the marks; undoNativeMark removes one from each list',
  /for \(const \[list, cap\] of \[\[state\.events, 500\], \[state\.full\.events, FULL_CAP\]\]\)/.test(add) && /list\.splice\(i, 0, ev\)/.test(add)
  && (monitor.match(/state\.events\.(push|splice|unshift)\(/g) || []).length === 1 && (monitor.match(/state\.full\.events\.(push|splice|unshift)\(/g) || []).length === 1
  && /state\.events\.splice\(i, 1\)/.test(undo) && /state\.full\.events\.splice\(j, 1\)/.test(undo) && !/\.(push|unshift)\(|splice\([^)]*,[^)]*,/.test(undo));
check('the free-text marker input is gone', !/id="marker-label"|id="add-marker"/.test(monitor));

// Confirm round 2: an old session's final waits on a running upload, Start happens meanwhile; it must upload nothing
// and leave the new session's Drive file id alone. Run on the real driveUploadSession.
async function oldFinalAfterStart() {
  let release;
  const calls = [];
  const u = { driveSyncOn: () => true, driveAccessToken: 'tok', driveFolderId: 'f', driveFileIdForSession: null, autoSaveGen: 1,
    driveUploadAt: 0, drivePaceMs: () => 0, driveAuthHeader: async () => 'Bearer x', setAutoSaveStatus() {}, console: { error() {} },
    window: { aortiAuth: { refreshIfNeeded: async () => {} } },
    fetch: async (url, init) => { calls.push(init.method); return { ok: true, status: 200, json: async () => ({ id: 'old-file' }) }; } };
  u.driveUploadInFlight = new Promise((r) => { release = r; });
  vm.createContext(u);
  const usrc = jsFunction(monitor, 'driveUploadSession');
  vm.runInContext(/^async /.test(usrc) ? usrc : 'async ' + usrc, u);
  const pending = u.driveUploadSession('old.csv', 'csv', true, 1);
  u.autoSaveGen = 2; u.driveFileIdForSession = null; // Start
  u.driveUploadInFlight = null; release();
  const ok = await pending;
  return { ok, calls: calls.length, id: u.driveFileIdForSession };
}
const bounded = (p) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('stalled')), 5000))]);
bounded(oldFinalAfterStart()).then((r) => {
  check('an old final that waited past a new Start uploads nothing', r.ok === false && r.calls === 0 && r.id === null, r);
}, (e) => check('an old final that waited past a new Start uploads nothing', false, String(e))).then(() => {
  if (failures) {
    console.log(failures + ' check(s) failed');
    process.exit(1);
  }
  console.log('All CSV format checks passed');
  process.exitCode = 0;
});
process.exitCode = 1; // a promise that never settles must not read as a pass
