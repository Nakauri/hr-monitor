#!/usr/bin/env node
// Schema v2 segment format test. Reads the Java as text, no JVM (behaviour is scripts/jvm/run-segment-test.cjs).
// Guards: header drift (B7), a kind's field count drifting from BLOCK-B-SPEC.md section 2, null RMSSD as 0 (A7),
// time_min coming back (S18), the file-name regex drifting from the viewer's, TeeSink getters reading the
// segment (K1), and a segment open failure leaving the engine with no sink (K2).
// Run: node scripts/segment-format.test.cjs                              (exit 0 = OK)
//      node scripts/segment-format.test.cjs --target NativeCsvWriter.java   (negative control; must FAIL)

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DIR = path.join(ROOT, 'mobile', 'android-overlay', 'app', 'src', 'main', 'java', 'com', 'nakauri', 'hrmonitor');
const ti = process.argv.indexOf('--target');
const TARGET = ti > 0 ? process.argv[ti + 1] : 'SegmentWriter.java';

let failures = 0;
function check(name, ok, detail) {
  console.log((ok ? 'OK    ' : 'FAIL  ') + name + (detail ? '  ' + detail : ''));
  if (!ok) failures++;
}
const read = (f) => { const p = path.join(DIR, f); return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : ''; };

// Comments and string contents blanked (same length), so code tokens are matched only in code.
function codeView(src) {
  const out = src.split('');
  const n = src.length;
  const blank = (a, b) => { for (let k = a; k < b; k++) if (out[k] !== '\n') out[k] = ' '; };
  let i = 0;
  while (i < n) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') { let j = src.indexOf('\n', i); if (j < 0) j = n; blank(i, j); i = j; continue; }
    if (c === '/' && src[i + 1] === '*') { let j = src.indexOf('*/', i + 2); j = j < 0 ? n : j + 2; blank(i, j); i = j; continue; }
    if (c === '"' || c === "'") { let j = i + 1; while (j < n && src[j] !== c) j += src[j] === '\\' ? 2 : 1; blank(i + 1, j); i = j + 1; continue; }
    i++;
  }
  return out.join('');
}

// Raw body of the first method whose signature matches sigRe, brace to brace.
function body(src, sigRe) {
  const code = codeView(src);
  const m = new RegExp(sigRe).exec(code);
  if (!m) return null;
  const open = code.indexOf('{', m.index);
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    if (code[i] === '{') depth++;
    else if (code[i] === '}' && --depth === 0) return src.slice(open, i + 1);
  }
  return null;
}

// Unescape a Java string literal body.
const jstr = (s) => s.replace(/\\\\/g, '\u0000').replace(/\\"/g, '"').replace(/\u0000/g, '\\');

// Spec section 2: kind -> field names after t.
const SPEC_KINDS = {
  h: 3, c: 1, g: 2, e: 1, p: 2, s: 1, w: 2, x: 0, z: 1, k: 1,
};
const SPEC_NAME_REGEX = '^hrm_(\\d{8})T(\\d{2})Z_([a-z0-9]{6})\\.csv$';

console.log('Target: ' + TARGET + '\n');
const w = read(TARGET);
check(TARGET + ' exists', w.length > 0);
const wcode = codeView(w);

// ---- Header (line 1) -------------------------------------------------------
const hm = w.match(/HEADER_FORMAT\s*=\s*"([^"]+)"/);
check('HEADER_FORMAT found', !!hm);
const hdr = hm ? hm[1] : '';
const hdrKeys = hdr.split(',').slice(1).map(p => p.split('=')[0]);
check('header starts #hrm,v=2', hdr.startsWith('#hrm,v=2,'), hdr);
check('header fields v, base, tz, app, dev, flavour in order',
  JSON.stringify(hdrKeys) === JSON.stringify(['v', 'base', 'tz', 'app', 'dev', 'flavour']), hdrKeys.join(','));
check('header base and tz are integers (%d)', /base=%d,tz=%d/.test(hdr), hdr);
check('header is written with a bare LF', /HEADER_FORMAT[\s\S]{0,200}?w\.write\('\\n'\)/.test(w));

// ---- Kinds and field counts ------------------------------------------------
const kindsBlock = (w.match(/KINDS\s*=\s*\{([\s\S]*?)\};/) || [])[1] || '';
const kinds = {};
for (const row of kindsBlock.matchAll(/\{([^{}]*)\}/g)) {
  const names = [...row[1].matchAll(/"([^"]*)"/g)].map(m => m[1]);
  if (names.length) kinds[names[0]] = names.slice(1);
}
check('KINDS table found', Object.keys(kinds).length > 0);
for (const [k, n] of Object.entries(SPEC_KINDS)) {
  check('kind ' + k + ' has ' + n + ' field(s) after t', kinds[k] && kinds[k].length === n,
    kinds[k] ? kinds[k].join(',') : 'missing');
}
check('no kind beyond the spec table', Object.keys(kinds).every(k => k in SPEC_KINDS), Object.keys(kinds).join(''));
check('h fields are hr, rmssd, rr', kinds.h && kinds.h.join(',') === 'hr,rmssd,rr', kinds.h && kinds.h.join(','));
const factKinds = (w.match(/FACT_KINDS\s*=\s*"([^"]*)"/) || [])[1];
check('appendFact accepts e p s w x only', factKinds === 'epswx', String(factKinds));

// Every literal-kind row call passes ts plus exactly the spec's field count.
function splitArgs(s) {
  const out = []; let depth = 0, cur = '';
  for (const ch of s) {
    if ('([{'.includes(ch)) depth++;
    if (')]}'.includes(ch)) depth--;
    if (ch === ',' && depth === 0) { out.push(cur); cur = ''; } else cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out;
}
const calls = [];
const callRe = /\b(rawRow|writeRow)\(\s*"(\w)"\s*,/g;
let cm;
while ((cm = callRe.exec(w))) {
  let depth = 1, i = cm.index + cm[0].length;
  const start = cm.index + cm[1].length + 1;
  for (; i < w.length && depth; i++) { if (w[i] === '(') depth++; else if (w[i] === ')') depth--; }
  const args = splitArgs(w.slice(start, i - 1));
  calls.push({ kind: cm[2], fields: args.length - 2, at: w.slice(0, cm.index).split('\n').length });
}
check('row call sites found', calls.length >= 5, calls.length + ' found');
const badCalls = calls.filter(c => SPEC_KINDS[c.kind] !== c.fields);
check('every row call writes its kind\'s field count', calls.length > 0 && badCalls.length === 0,
  badCalls.map(c => c.kind + '@:' + c.at + '=' + c.fields).join(' '));
check('writer enforces the count at runtime', /fields\.length\s*!=\s*fieldCount\(kind\)/.test(wcode));

// ---- h row ----------------------------------------------------------------
const hr = body(w, 'void\\s+appendHr\\s*\\(') || '';
check('appendHr takes int[] rrMs', /appendHr\s*\(\s*int\s+hr\s*,\s*Double\s+rmssd\s*,\s*double\s+sdnnMatch\s*,\s*double\s+sdnn5min\s*,\s*double\s+sdnnFull\s*,\s*int\[\]\s+rrMs\s*,\s*long\s+tsMs\s*\)/.test(w));
check('null RMSSD written as empty field',
  /rmssd\s*==\s*null\s*\?\s*""\s*:\s*String\.format\(Locale\.US,\s*"%\.2f",\s*rmssd\)/.test(hr));
check('rr joined by ;', /append\(';'\)/.test(hr));
check('h row ignores SDNN', !/sdnn/i.test(codeView(hr).replace(/appendHr\s*\([^)]*\)/, '')));
check('no time_min', !/time_min/.test(w));
check('rows end with LF, not newLine()', /append\('\\n'\)/.test(w) && !/newLine\(\)/.test(wcode));

// ---- File name ------------------------------------------------------------
const nr = w.match(/NAME_REGEX\s*=\s*"((?:[^"\\]|\\.)*)"/);
const javaRegex = nr ? jstr(nr[1]) : null;
check('Java NAME_REGEX equals the spec regex', javaRegex === SPEC_NAME_REGEX, String(javaRegex));
check('names are UTC hours: yyyyMMdd\'T\'HH in UTC plus Z_<iid>',
  /"yyyyMMdd'T'HH"/.test(w) && /TimeZone\.getTimeZone\("UTC"\)/.test(w) && /"Z_"\s*\+\s*iid/.test(w));
if (javaRegex) {
  const re = new RegExp(javaRegex);
  check('regex accepts hrm_20261009T07Z_abc123.csv', re.test('hrm_20261009T07Z_abc123.csv'));
  check('regex rejects legacy and daily names', !re.test('hrv_session_2026-10-09T07-00-00.000.csv') && !re.test('hrv_daily_2026-10-09.csv'));
}
const viewer = fs.readFileSync(path.join(ROOT, 'hrv_viewer.html'), 'utf8');
const vm = viewer.match(/\/\^hrm_[^\n]*?\.csv\$\//);
check('viewer defines isRecordingName over SEG_NAME_RE',
  /function isRecordingName\(/.test(viewer) && /const SEG_NAME_RE = \/\^hrm_/.test(viewer));
check('viewer v2 name regex equals Java', !!vm && vm[0].slice(1, -1) === javaRegex, vm ? vm[0] : 'missing');

// ---- Pure Java ------------------------------------------------------------
for (const f of ['SegmentWriter.java', 'TeeSink.java', 'HrSink.java', 'Clock.java', 'TzSource.java', 'LifecycleLog.java']) {
  const src = read(f);
  check(f + ' imports no android.*', src.length > 0 && !/import\s+android\./.test(src) && !/\bandroid\.\w/.test(codeView(src)));
}

// ---- Tee (K1, K2) ---------------------------------------------------------
const tee = read('TeeSink.java');
for (const g of ['getFile', 'getFilename', 'getSessionStartMs', 'getConsecutiveFailures', 'getTotalFailures']) {
  const b = body(tee, '\\b' + g + '\\s*\\(\\s*\\)\\s*\\{') || '';
  check('TeeSink.' + g + ' names only the legacy writer', /\blegacy\./.test(b) && !/segment|seg\b|opener/.test(b), b.replace(/\s+/g, ' '));
}
check('TeeSink requires a legacy writer', /legacy\s*==\s*null\)\s*throw/.test(tee));

const eng = read('HrEngine.java');
const openTee = body(eng, 'TeeSink\\s+openTee\\s*\\(') || '';
check('HrEngine.openTee found', openTee.length > 0);
check('openTee never touches sink', openTee.length > 0 && !/\bsink\b/.test(codeView(openTee)));
check('openTee catches the segment open and still builds the tee',
  /try\s*\{\s*seg\s*=\s*openSegmentWriter\(\)\s*;\s*\}\s*catch\s*\(\s*Throwable/.test(openTee)
  && /segment_open_fail reason=/.test(openTee)
  && /return\s+new\s+TeeSink\(\s*legacy\s*,\s*seg\s*,/.test(openTee));
const start = body(eng, '\\bJSONObject\\s+startSessionInternal\\s*\\(') || '';
const legacyAt = start.indexOf('new NativeCsvWriter(');
const teeAt = start.search(/HrSink\s+next\s*=\s*legacy\s*!=\s*null\s*\?\s*openTee\(legacy\)\s*:\s*null\s*;/);
check('legacy opens first, then the tee; sink is null only when legacy failed', legacyAt >= 0 && teeAt > legacyAt);
const gStartAt = start.search(/next\.appendSession\(\s*sessionStartMs\s*,\s*resuming\s*\?\s*"resume"\s*:\s*"start"/);
const publishAt = start.search(/\bsink\s*=\s*next\s*;/);
check('g start/resume is written before the tee is published to sink [no h before g]',
  teeAt >= 0 && gStartAt > teeAt && publishAt > gStartAt);

// Stop/start handoff: the old session's g,stop and close finish before a new start opens.
function lockBlocks(src, lock) {
  const out = [];
  const code = codeView(src);
  const re = new RegExp('synchronized\\s*\\(\\s*' + lock + '\\s*\\)\\s*\\{', 'g');
  let m;
  while ((m = re.exec(code))) {
    const open = m.index + m[0].length - 1;
    let depth = 0;
    for (let i = open; i < code.length; i++) {
      if (code[i] === '{') depth++;
      else if (code[i] === '}' && --depth === 0) { out.push(src.slice(open, i + 1)); break; }
    }
  }
  return out;
}
const startLocked = lockBlocks(start, 'sinkHandoffLock');
check('start opens legacy, tee and publishes sink inside sinkHandoffLock',
  startLocked.some(b => /new NativeCsvWriter\(/.test(b) && /openTee\(legacy\)/.test(b) && /\bsink\s*=\s*next/.test(b)));
check('engine passes rrMs to appendHr', /\.appendHr\([^;]*?\brrMs,\s*now\);/.test(eng));
check('engine writes flavour=personal', /SEGMENT_FLAVOUR\s*=\s*"personal"/.test(eng));
const stop = body(eng, '\\bCountDownLatch\\s+stopSessionInternal\\s*\\(\\s*\\)') || '';
check('stop writes g,stop before close', /appendSession\([^;]*"stop"[\s\S]*?snap\.close\(\)/.test(stop));
const stopLocked = lockBlocks(stop, 'sinkHandoffLock');
check('stop snapshots sink, writes g,stop and closes inside sinkHandoffLock',
  stopLocked.some(b => /sink\s*=\s*null/.test(b) && /"stop"/.test(b) && /snap\.close\(\)/.test(b)));
check('stop closes the sink only inside the lock', (codeView(stop).match(/snap\.close\(\)/g) || []).length === 1);
check('stop flushes the pending fact log counts', /flushFactLogs\(\)/.test(stop));

// Facts: clamped timestamps, per-minute log counts for x and w.
const logFact = body(eng, '\\bString\\s+logFact\\s*\\(') || '';
check('logFact clamps the fact time with SegmentWriter.clampFactTs', /SegmentWriter\.clampFactTs\(/.test(logFact));
check('x and w facts log a per-minute count', /"x"\.equals\(letter\)\s*\|\|\s*"w"\.equals\(letter\)[\s\S]*?countFactLog\(/.test(logFact));
check('clamp window is 15 min back, 5 s ahead',
  /FACT_PAST_MS\s*=\s*15L\s*\*\s*60_000L/.test(w) && /FACT_FUTURE_MS\s*=\s*5_000L/.test(w));

// Roll and offset checks run on the engine's own segment thread, from the timer, the heartbeat and the wake alarm.
const tick = body(eng, '\\bvoid\\s+postSegmentTick\\s*\\(') || '';
check('segment tick runs on segmentTicker, not ioExecutor',
  /segmentTicker\.execute\(/.test(tick) && !/ioExecutor/.test(tick) && /checkOffset\(/.test(tick) && /rollIfDue\(/.test(tick));
check('segmentTicker is its own single thread', /segmentTicker\s*=\s*Executors\.newSingleThreadExecutor\([\s\S]{0,80}"hrm-segment-tick"/.test(eng));
const nonTick = codeView(eng).replace(codeView(tick), '');
check('no rollIfDue or checkOffset call outside the tick', !/\.(rollIfDue|checkOffset)\(/.test(nonTick));
const hb = (eng.match(/heartbeatRunnable\s*=\s*new\s+Runnable\(\)\s*\{[\s\S]*?\n    \};/) || [''])[0];
check('heartbeat queues a segment tick', /postSegmentTick\(\)/.test(hb));
// Engine step 2 [S13]: the alarm starts the Service with origin=alarm and the engine's onWake ticks once.
const wake = body(eng, 'public\\s+void\\s+onWake\\s*\\(') || '';
check('wake alarm queues a segment tick (alarm origin -> onWake -> segmentTickFromAlarm)',
  /ORIGIN_ALARM/.test(read('HrServiceHeartbeatReceiver.java')) && /ORIGIN_ALARM[\s\S]{0,40}segmentTickFromAlarm\(\)/.test(wake));

// Close is final on both writers.
check('SegmentWriter.close is final (ensureHour refuses after close)', /if\s*\(\s*closed\s*\)\s*return\s+false/.test(w)
  && /closed\s*=\s*true/.test(body(w, 'public\\s+synchronized\\s+void\\s+close\\s*\\(') || ''));
check('TeeSink.close is final (no segment reopen after close)', /if\s*\(\s*closed\s*\)\s*return\s+null/.test(tee)
  && /closed\s*=\s*true/.test(body(tee, 'public\\s+synchronized\\s+void\\s+close\\s*\\(') || ''));

// ---- Plugin logFact settles on every path ------------------------------------
const plug = read('NativeHrSessionPlugin.java');
const lf = body(plug, 'public\\s+void\\s+logFact\\s*\\(\\s*PluginCall') || '';
check('plugin logFact found', lf.length > 0);
check('logFact catches Throwable and rejects with a string', /catch\s*\(\s*Throwable\s+\w+\s*\)\s*\{\s*call\.reject\("[^"]*"\s*\+/.test(lf));
check('logFact rejects bad_kind and no_session, resolves written',
  /"bad_kind"/.test(lf) && /"no_session"/.test(lf) && /call\.reject\(r\)/.test(lf) && /put\("written"/.test(lf));

// ---- s row: the symptom mark (S4b) -------------------------------------------
// The phone's Log row Symptom (and later the notification Symptom) writes s,<t>,sym:<kind>; Note writes e.
check('logFact maps symptom to an s row with the text as its one field',
  /"symptom"\.equals\(kind\)\)\s*\{\s*letter\s*=\s*"s";\s*fields\s*=\s*new\s+String\[\]\s*\{\s*text\s*==\s*null\s*\?\s*""\s*:\s*text\s*\};/.test(logFact));
check('logFact maps marker to an e row', /"marker"\.equals\(kind\)\)\s*\{\s*letter\s*=\s*"e";/.test(logFact));
check('fact fields: commas and line breaks to spaces, 80 characters',
  /s\.replace\(',',\s*' '\)\.replace\('\\r',\s*' '\)\.replace\('\\n',\s*' '\)/.test(w) && /FACT_FIELD_MAX\s*=\s*80/.test(w));
const mon = fs.readFileSync(path.join(ROOT, 'hr_monitor.html'), 'utf8');
const symLabel = (mon.match(/const SYMPTOM_LABEL = '([^']*)';/) || [])[1];
check('monitor Symptom label is sym:symptom', symLabel === 'sym:symptom', String(symLabel));
check('monitor sends a sym: label as kind symptom', /logNativeFact\(\s*\/\^sym:\/i\.test\(label\)\s*\?\s*'symptom'/.test(mon));
if (symLabel) {
  const row = ['s', '1234', symLabel.replace(/,/g, ' ').replace(/[\r\n]/g, ' ')].join(',');
  const parts = row.split(',');
  check('s row reads back as kind s with one field sym:symptom', parts.length === 2 + SPEC_KINDS.s && parts[0] === 's' && parts[2] === 'sym:symptom', row);
}

if (failures) {
  console.log('\n' + failures + ' check(s) failed');
  process.exit(1);
}
console.log('\nAll segment format checks passed');
