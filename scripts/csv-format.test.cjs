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

// SDNN is passed through sdnnCell, which writes NaN (not enough data yet) as an empty field.
check('SDNN slots are %s', !!hrFmt && hrFmt.split(',').slice(4, 7).every((s) => s === '%s'), hrFmt || '');
check('NaN SDNN maps to empty string',
  /Double\.isNaN\(v\)\s*\?\s*""\s*:\s*String\.format\(Locale\.US,\s*"%\.2f",\s*v\)/.test(java)
  && /sdnnCell\(sdnnMatch\),\s*sdnnCell\(sdnn5min\),\s*sdnnCell\(sdnnFull\)/.test(hrBody || ''));
const engineSrc = fs.readFileSync(path.join(path.dirname(SRC), 'HrEngine.java'), 'utf8');
check('HrEngine passes NaN, never 0.0, for a missing SDNN',
  /sdnnMatch != null \? sdnnMatch : Double\.NaN/.test(engineSrc) && !/sdnn\w* != null \? sdnn\w* : 0\.0/.test(engineSrc));
const sdnnCell = (v) => (Number.isNaN(v) ? '' : jformat('%.2f', [v]));

function emulateHrRow(rmssd, sdnn) {
  const rmssdField = rmssd == null ? '' : jformat('%.2f', [rmssd]);
  const s = sdnn || [41.5, 52.25, 60];
  return jformat(hrFmt, [1.25, 1760000000000, 88, rmssdField, ...s.map(sdnnCell)]);
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
  const noSdnn = emulateHrRow(42.123, [NaN, NaN, NaN]).split(',');
  check('missing SDNN written empty, 12 fields kept', noSdnn.length === header.length && noSdnn.slice(4, 7).join('|') === '||',
    noSdnn.slice(4, 7).join('|'));
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
const fnSrc = ['buildSessionCSV', 'sanitizeNote', 'csvCell'].map((n) => jsFunction(monitor, n));
check('buildSessionCSV, sanitizeNote and csvCell found', fnSrc.every(Boolean));
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
const longSrc = ['freshFullRecord', 'track', 'buildSessionCSV', 'csvCell'].map((n) => jsFunction(monitor, n));
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
// The save itself is recorder.js, tested scenario by scenario in scripts/recorder.test.cjs. The page pins: the Stop
// awaits the Recording's final before the after-stop panel, and Start stops the old Recording before the id moves.
const stopNow = jsFunction(monitor, 'stopSessionNow') || '';
const connectSrc = jsFunction(monitor, 'connectWeb') || '';
check('the stop awaits the Recording\'s final, capped, before the after-stop panel',
  stopNow.indexOf('ended.entry = endRecording(false);') >= 0
  && stopNow.indexOf('ended.entry = endRecording(false);') < stopNow.indexOf('await Promise.race([ended.entry.rec.final')
  && stopNow.indexOf('await Promise.race([ended.entry.rec.final') < stopNow.indexOf('showAfterStop(ended)'));
check('Start stops the old Recording before the session id moves (rule 19)',
  /endRecording\(true\);\s*sessionSeq\+\+;\s*resetLiveDataBuffers\(\);/.test(connectSrc) && connectSrc.indexOf('sessionSeq++') < connectSrc.indexOf('startRecording();'));
check('an old Recording never builds new data', /buildCsv: \(id\) => \(id === sessionSeq \? buildSessionCSV\(\)\.csv : null\)/.test(monitor));
check('a page close flushes marks, then the recorder writes',
  /function onPageHide\(\) \{\s*try \{ flushHeldMarks\(\); \} catch \(e\) \{\}\s*if \(recorder\) recorder\.closing\(\);/.test(monitor));
check('leaving the tab commits held marks before the hidden save',
  /try \{ commitHeldMarks\(\); \} catch \(e\) \{\}\s*if \(recorder\) recorder\.hidden\(\);/.test(monitor));
check('every committed mark tells the recorder (rule 21)', /if \(recorder\) recorder\.entered\(\);/.test(jsFunction(monitor, 'addMarker') || '')
  && (monitor.match(/recorder\.entered\(\)/g) || []).length === 1);
// Page review 2026-10-28: a reconnect with no Recording starts one; Stop never takes an older session's Recording;
// a session with no data keeps no Export and no guard.
check('a reconnect that brings a session live starts its Recording',
  (monitor.match(/resetReconnectBackoff\(\);\s*ensureRecording\(\);/g) || []).length === 2
  && /function ensureRecording\(\) \{[\s\S]{0,120}if \(!c \|\| c\.id !== sessionSeq\) startRecording\(\);/.test(monitor));
check('a reconnect landing after Stop drops the link before it can revive the session',
  (monitor.match(/await attachConnection\(\);\s*if \(stopReconnectAfterStop\(\)\) return;/g) || []).length === 2
  && /function stopReconnectAfterStop\(\) \{\s*if \(state\.autoReconnect\) return false;/.test(monitor));
check('a Stop still waiting keeps its entry off the notice lines', /e\.screen !== 'await' \|\| stopInFlight/.test(jsFunction(monitor, 'hideAfterStop') || ''));
check('Stop never takes an older session\'s Recording', /if \(!was \|\| was\.id !== sessionSeq\) return null;/.test(jsFunction(monitor, 'endRecording') || ''));
check('a session with no data keeps no Export and no guard',
  /function exportOn\(entry\) \{ return hasData\(entry\) &&/.test(monitor) && /function keptStill\(entry\) \{ return hasData\(entry\) &&/.test(monitor));
// One owner for the save (A- plan Block 3): the page keeps no save state of its own, and recorder.js keeps only `cur`.
const SAVE_STATE = ['autoSaveGen', 'autoSaveFinal', 'autoSaveFileHandle', 'autoSaveInterval', 'autoSaveBytes', 'autoSaveBuiltAt',
  'finalLocalOk', 'driveFileIdForSession', 'driveUploadInFlight', 'driveUploadAt', 'autoSaveFailStreak', 'afterStopCsv', 'afterStopSeq'];
const leftover = SAVE_STATE.filter((n) => new RegExp('\\b' + n + '\\b').test(monitor));
check('the page holds none of the old save state', leftover.length === 0, leftover.join(', '));
const recSrc = fs.readFileSync(path.join(__dirname, '..', 'recorder.js'), 'utf8').replace(/\r\n/g, '\n');
const recBody = (recSrc.match(/function create\(env\) \{([\s\S]*)\n  \}\n\n  const api/) || [])[1] || '';
const recLets = (recBody.match(/^    let \w+/gm) || []).map((l) => l.trim());
check('recorder.js keeps one mutable binding, the current Recording', recLets.length === 1 && recLets[0] === 'let cur', recLets.join(', '));
// The Marks list and the session's full record (the saved file) move together: one insert, one undo, no other writer.
check('addMarker is the only writer of the marks; undoNativeMark removes one from each list',
  /for \(const \[list, cap\] of \[\[state\.events, 500\], \[state\.full\.events, FULL_CAP\]\]\)/.test(add) && /list\.splice\(i, 0, ev\)/.test(add)
  && (monitor.match(/state\.events\.(push|splice|unshift)\(/g) || []).length === 1 && (monitor.match(/state\.full\.events\.(push|splice|unshift)\(/g) || []).length === 1
  && /state\.events\.splice\(i, 1\)/.test(undo) && /state\.full\.events\.splice\(j, 1\)/.test(undo) && !/\.(push|unshift)\(|splice\([^)]*,[^)]*,/.test(undo));
check('the free-text marker input is gone', !/id="marker-label"|id="add-marker"/.test(monitor));

const stopNow2 = jsFunction(monitor, 'stopSessionNow') || '';
const after2 = jsFunction(monitor, 'showAfterStop') || '';
check('a mark or note during "Saving" is refused, not lost',
  /if \(!state\.startTime \|\| stopInFlight \|\| recordingEnded\(\) \|\|/.test(jsFunction(monitor, 'logMark') || '') && /if \(!state\.startTime \|\| stopInFlight \|\| noteComposer\) return;/.test(jsFunction(monitor, 'openNoteComposer') || ''));
// Round 5: an open note is committed through logMark, which refuses once stopInFlight is set, so the flush comes first.
check('a note open at Stop is flushed before marks are refused',
  stopNow2.indexOf('flushHeldMarks();') >= 0 && stopNow2.indexOf('flushHeldMarks();') < stopNow2.indexOf('stopInFlight = true;')
  && stopNow2.indexOf('if (stopInFlight) return;') < stopNow2.indexOf('flushHeldMarks();'));
// A note typed as =cmd|... must not open as a formula when the file is opened in a spreadsheet (security audit L3).
const cellSrc = jsFunction(monitor, 'csvCell');
if (cellSrc) {
  const cctx = {}; vm.createContext(cctx); vm.runInContext(cellSrc, cctx);
  check('a text cell that starts like a formula is quoted', cctx.csvCell('=1+1') === "'=1+1" && cctx.csvCell('+a') === "'+a" && cctx.csvCell('-a') === "'-a" && cctx.csvCell('@a') === "'@a" && cctx.csvCell('sym:dizzy') === 'sym:dizzy');
} else check('csvCell found', false);
check('the event column goes through csvCell', /csvCell\(evMap\.get\(k\) \?\? ''\)/.test(monitor));
Promise.resolve().then(() => {
  if (failures) {
    console.log(failures + ' check(s) failed');
    process.exit(1);
  }
  console.log('All CSV format checks passed');
  process.exitCode = 0;
});
process.exitCode = 1; // a promise that never settles must not read as a pass
