#!/usr/bin/env node
// Guards: a row's absolute time rebuilt by several copies of the epoch_ms-else-file-start rule that drift apart, so
// the same row lands on a different minute or day in the summary, the session chart and the day sparkline (A-MINUS
// Block 4: four copies in summarizeCSV, v2SeriesFromRows, loadFullSession, drawDaySparkline). Every caller must give
// the same epoch per row as its pre-rowEpochFn source (77d068a), with and without epoch_ms, with empty and junk cells,
// on a web UTC and a native local-time file name; a mutated rowEpochFn must fail. Files: viewer-parse.js rowEpochFn
// and the hrv_viewer.html callers. Runtime: under 2 s (needs git for the old source).
// Run: node scripts/row-epoch.test.cjs   (exit 0 = OK)
process.env.TZ = 'America/Denver';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { execFileSync } = require('child_process');
const { readViewerParts } = require('./viewer-src.cjs');

const ROOT = path.join(__dirname, '..');
const BASE_REV = '77d068a';
const norm = (s) => s.replace(/\r\n/g, '\n');
const parts = readViewerParts();
const cur = parts.html + '\n' + parts.mod; // the page plus viewer-parse.js, the parse Worker's file
// The Worker runs viewer-parse.js whole, so its functions are the Worker's code.
const MOD_NAMES = [...parts.mod.matchAll(/^ {2}function (\w+)\(/gm)].map((m) => m[1]);
let old = null;
try { old = norm(execFileSync('git', ['show', BASE_REV + ':hrv_viewer.html'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 << 20 })); } catch (e) {}

let failures = 0;
function check(name, ok, detail) {
  console.log((ok ? 'OK    ' : 'FAIL  ') + name + (detail && !ok ? '  ' + detail : ''));
  if (!ok) failures++;
}
// Naive brace match from `function name(`; enough for these functions.
function jsFunction(src, name) {
  const start = src.search(new RegExp('(?:async\\s+)?function\\s+' + name + '\\s*\\('));
  if (start < 0) return null;
  const open = src.indexOf('{', src.indexOf(')', start));
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
  }
  return null;
}
const constOf = (src, name) => (src.match(new RegExp('const ' + name + ' = ([^;]+);')) || [])[1];
const workerNames = (src) => {
  const m = src.match(/const fns = \[([^\]]+)\];/);
  if (m) return m[1].split(',').map((s) => s.trim()).filter(Boolean);
  return /= AortiViewerParse;/.test(src) && MOD_NAMES.length ? MOD_NAMES : null;
};

// Loads every caller of one source into a context. The summary runs from exactly the Worker's function list.
function load(src) {
  const names = workerNames(src);
  const extra = ['v2SeriesFromRows', 'toFixedNum', 'loadFullSession', 'drawDaySparkline'];
  if (src.includes('function rowEpochFn')) extra.push('rowEpochFn');
  if (src.includes('function sparkBuckets')) extra.push('sparkBuckets');
  const fns = [...new Set([...(names || []), ...extra])].map((n) => [n, jsFunction(src, n)]);
  const missing = fns.filter(([, f]) => !f).map(([n]) => n);
  if (!names || missing.length) return { error: 'missing ' + (names ? missing.join(', ') : 'Worker fns list') };
  const consts = ['ELAPSED_MAX_START_MIN', 'ELAPSED_MAX_DRIFT_MIN', 'DATA_JUMP_GAP_MIN', 'DAY_START_HOUR', 'SUMMARY_SCHEMA_V', 'HR_SHIFT_DEFAULT']
    .filter((n) => constOf(src, n) != null).map((n) => 'const ' + n + ' = ' + constOf(src, n) + ';').join('\n');
  const ctx = { console, Intl, files: {}, charts: [] };
  vm.createContext(ctx);
  vm.runInContext([
    consts,
    'let QUADRANT_THRESH = {}, _hrShift = { threshold: 30, windowMin: 10 }, _dayKeyLast = { start: 0, end: 0, key: "" };',
    'function getHrShiftSettings() { return _hrShift; }',
    'const window = {}, virtualSessions = {}, _sessionCache = new Map(), STAGE_COLORS = { 1: "#000000" };',
    'const _sessionCacheTouch = (k, v) => v, isV2SessionKey = () => false, getHRStage = () => 1;',
    'const readSessionText = async (fn) => files[fn];',
    'const freshChart = (canvas, cfg) => charts.push(cfg.data.datasets[0].data);',
    'const paintSpark = (canvas, points) => charts.push(points);',
    'const sparkBucketsAsync = async (fn, text) => sparkBuckets(fn, text);',
    // Same per-row SDNN slots for both sources; v2SeriesFromRows reads only .match and .fiveMin.
    'const sdnnFromRr = (rows) => rows.map(() => ({ match: null, fiveMin: null }));',
    ...fns.map(([, f]) => f),
    'this.api = { summarizeCSV, v2SeriesFromRows, loadFullSession, drawDaySparkline };',
  ].join('\n'), ctx);
  return ctx;
}

// Fixtures. hrAt varies per row so a shifted epoch changes the sparkline's 5 min averages.
const HEADER = 'time_min,epoch_ms,hr_bpm,rmssd_ms,sdnn_match_ms,sdnn_5min_ms,sdnn_full_ms,palpitation,event,warning,connection,posture';
const NO_EPOCH_HEADER = 'time_min,hr_bpm,rmssd_ms,palpitation,event,warning,connection,posture';
const hrAt = (i) => 60 + (i * 7) % 50;
function csv(n, opts) {
  const lines = [opts.noEpoch ? NO_EPOCH_HEADER : HEADER];
  for (let i = 0; i < n; i++) {
    const t = ((opts.tShift || 0) + i * 0.5).toFixed(4);
    let e = String(opts.ep0 + i * 30000);
    if (opts.cell) e = opts.cell(i, e);
    const ev = i === 3 ? 'stood' : '';
    if (opts.noEpoch) lines.push([t, hrAt(i), 40 + i % 9, i === 5 ? 1 : 0, ev, '', '', ''].join(','));
    else lines.push([t, e, hrAt(i), 40 + i % 9, '', '', '', i === 5 ? 1 : 0, ev, '', '', ''].join(','));
  }
  return lines.join('\n') + '\n';
}
const WEB = 'hrv_session_2026-04-17T14-32-00.csv';            // UTC
const NATIVE = 'hrv_session_2026-04-17T23-58-00.123.csv';     // device local time, crosses local midnight
const webStart = Date.UTC(2026, 3, 17, 14, 32, 0);
const nativeStart = new Date('2026-04-17T23:58:00.123').getTime();
const fixtures = [
  { name: 'web name, epoch_ms on every row (37 s past the name)', fn: WEB, text: csv(40, { ep0: webStart + 37000 }) },
  { name: 'web name, empty and junk epoch cells', fn: WEB, text: csv(40, { ep0: webStart + 37000, cell: (i, e) => (i % 4 === 1 ? '' : i % 7 === 2 ? 'x' : e) }) },
  { name: 'web name, no epoch_ms column', fn: WEB, text: csv(40, { noEpoch: true }) },
  { name: 'native local name, epoch_ms on every row', fn: NATIVE, text: csv(40, { ep0: nativeStart + 5000 }) },
  { name: 'native local name, empty epoch cells across midnight', fn: NATIVE, text: csv(40, { ep0: nativeStart + 5000, cell: (i, e) => (i % 3 ? '' : e) }) },
  { name: 'native local name, no epoch_ms column', fn: NATIVE, text: csv(40, { noEpoch: true }) },
  { name: 'stale time_min (elapsed rule rebuilds it), some empty cells', fn: WEB, text: csv(40, { ep0: webStart + 37000, tShift: 4235, cell: (i, e) => (i === 6 ? '' : e) }) },
];
const pad = (n) => String(n).padStart(2, '0');
const isoOf = (ms) => { const d = new Date(ms); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); };

// Everything each caller derives from row epochs.
async function outputs(ctx, fx) {
  const api = ctx.api;
  ctx.files = { [fx.fn]: fx.text };
  const s = api.summarizeCSV(fx.fn, fx.text);
  const pick = (arr) => (arr || []).filter((p) => p.ep != null).map((p) => [p.t ?? p.x, p.ep]);
  // The whole summary: startEpoch, event ep, byDay slices and spans all come from row epochs.
  const sum = s && JSON.parse(JSON.stringify(s));
  const full = await api.loadFullSession(fx.fn);
  const fullOut = { hr: pick(full.hr), rmssd: pick(full.rmssd) };
  // v2: rows built from the file's own epochs (NaN where the cell is empty), sid at the file start.
  const fileStart = new Date(fx.fn === WEB ? webStart : nativeStart).getTime();
  const lines = fx.text.trim().split('\n'), cols = lines[0].split(','), eI = cols.indexOf('epoch_ms');
  const rows = lines.slice(1).map((l, i) => { const c = l.split(','); return { k: 'h', ep: eI >= 0 && c[eI] !== '' ? parseFloat(c[eI]) : fileStart + i * 30000, f: [c[cols.indexOf('hr_bpm')], c[cols.indexOf('rmssd_ms')], '800'] }; });
  rows.push({ k: 'h', ep: NaN, f: ['70', '40', '800'] });
  const v2 = api.v2SeriesFromRows(fileStart, rows, fileStart);
  const v2Out = { hr: pick(v2.hr), rmssd: pick(v2.rmssd) };
  const spark = [];
  const day0 = isoOf(sum ? sum.startEpoch : fileStart);
  const day1 = isoOf(new Date(day0 + 'T12:00:00').getTime() + 86400000);
  for (const iso of [day0, day1]) {
    ctx.charts.length = 0;
    await api.drawDaySparkline({}, [fx.fn], 70, iso);
    spark.push({ iso, points: JSON.parse(JSON.stringify(ctx.charts[0] || null)) });
  }
  return { sum, full: fullOut, v2: v2Out, spark };
}

async function compare(label, ctxNew, ctxOld) {
  let allSame = true;
  for (const fx of fixtures) {
    const a = await outputs(ctxNew, fx), b = await outputs(ctxOld, fx);
    for (const k of ['sum', 'full', 'v2', 'spark']) {
      const same = JSON.stringify(a[k]) === JSON.stringify(b[k]);
      if (label) check(label + ': ' + k + ' matches ' + BASE_REV + ' on ' + fx.name, same);
      if (!same) allSame = false;
    }
  }
  return allSame;
}

(async () => {
  if (!old) { check('old source from git show ' + BASE_REV, false, 'git show failed'); process.exit(1); }
  check('rowEpochFn lives in viewer-parse.js, the file the parse Worker runs', MOD_NAMES.includes('rowEpochFn') && !/^[ \t]*function rowEpochFn\(/m.test(parts.html));
  // One copy of the rule: no other file-start-plus-elapsed rebuild left outside rowEpochFn.
  const body = jsFunction(cur, 'rowEpochFn') || '';
  const rest = cur.replace(body, '');
  const stray = (rest.match(/[Ff]ile[Ss]tart(?:Epoch)?\s*\+\s*t\s*\*\s*60000/g) || []).length;
  check('no file-start-plus-elapsed rebuild outside rowEpochFn', body && stray === 0, stray + ' left');
  const ctxNew = load(cur), ctxOld = load(old);
  check('callers load from the current source', !ctxNew.error, ctxNew.error);
  check('callers load from ' + BASE_REV, !ctxOld.error, ctxOld.error);
  if (ctxNew.error || ctxOld.error) process.exit(1);
  // Sanity: the fixtures reach both branches of the rule.
  const o = await outputs(ctxNew, fixtures[1]);
  check('fixtures exercise the epoch cell and the file-start fallback', o.full.hr.some(([t, ep]) => ep === webStart + t * 60000) && o.full.hr.some(([t, ep]) => ep !== webStart + t * 60000));
  const n = await outputs(ctxNew, fixtures[4]);
  check('a native fixture spans two local days in the summary', n.sum && Object.keys(n.sum.byDay || {}).length === 2, JSON.stringify(n.sum && n.sum.byDay));
  await compare('parity', ctxNew, ctxOld);

  // Negative control: each mutant of rowEpochFn must break parity somewhere.
  const mutants = [
    ['epoch cell ignored', (f) => f.replace('if (c !== \'\') {', 'if (false) {')],
    ['fallback in seconds', (f) => f.replace('t * 60000', 't * 1000')],
    ['cell one minute late', (f) => f.replace('if (!isNaN(e)) return e;', 'if (!isNaN(e)) return e + 60000;')],
  ];
  for (const [name, mut] of mutants) {
    const m = mut(body);
    if (m === body) { check('mutant "' + name + '" applies', false, 'anchor missing'); continue; }
    const ctxMut = load(cur.replace(body, m));
    const same = !ctxMut.error && await compare(null, ctxMut, ctxOld);
    check('negative control: mutant "' + name + '" breaks parity', !same);
  }
  console.log(failures ? '\n' + failures + ' FAILED' : '\nall OK');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
