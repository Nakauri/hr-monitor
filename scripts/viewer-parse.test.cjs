// viewer-parse.js: the session summary moved out of hrv_viewer.html must give the summaries 6554b5b gave.
// Bug it exists for: the parse Worker was assembled from a hand-kept list of page functions (S29), so a helper added
// to summarizeCSV but not to the list failed only in the Worker; moving the code could also change a summary unseen.
// Checks: summarizeCSV(fn, text, opts) deep-equals 6554b5b's Worker build (git show) on every demo CSV, the S35
// synthetic file, guarded-label and midnight-crossing fixtures and the local CSV Dates/ recordings when present, under
// the default and two other quadrant/HR shift settings; a real worker thread on the same file replies the same as the
// main thread; the page loads the file, starts its Worker on './viewer-parse.js?v=' + SUMMARY_SCHEMA_V, refuses a reply
// from another schema and says in diagnostics where summaries run; DAY_START_HOUR and _dayKeyLast live only in the
// module. Then mutants of the module must fail. Usage: node scripts/viewer-parse.test.cjs. Runtime: about 30 s.
process.env.TZ = 'America/Denver';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { execFileSync } = require('child_process');
const { Worker } = require('worker_threads');

const ROOT = path.join(__dirname, '..');
const BASE_REV = '6554b5b';
const norm = (s) => s.replace(/\r\n/g, '\n');
const page = norm(fs.readFileSync(path.join(ROOT, 'hrv_viewer.html'), 'utf8'));
const modPath = path.join(ROOT, 'viewer-parse.js');
const MOD = fs.existsSync(modPath) ? norm(fs.readFileSync(modPath, 'utf8')) : '';
let old = null;
try { old = norm(execFileSync('git', ['show', BASE_REV + ':hrv_viewer.html'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 << 20 })); } catch (e) {}

let failures = 0;
function check(name, ok, detail) {
  console.log((ok ? 'OK    ' : 'FAIL  ') + name + (detail ? '  ' + detail : ''));
  if (!ok) failures++;
}
function jsFunction(src, name) {
  const m = new RegExp('^[ \\t]*(?:async\\s+)?function\\s+' + name + '\\s*\\(', 'm').exec(src);
  if (!m) return null;
  const open = src.indexOf('{', src.indexOf(')', m.index));
  let d = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') d++;
    else if (src[i] === '}' && --d === 0) return src.slice(m.index, i + 1);
  }
  return null;
}

// Value-exact text of a summary: sorted keys, NaN, Infinity, undefined and -0 kept apart.
function canon(v) {
  if (v === undefined) return 'u';
  if (typeof v === 'number') return Number.isNaN(v) ? 'NaN' : Object.is(v, -0) ? '-0' : String(v);
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']';
  if (v instanceof Date || Object.prototype.toString.call(v) === '[object Date]') return 'D' + v.getTime();
  // originEpoch postdates the base build; its own check is below.
  return '{' + Object.keys(v).filter((k) => k !== 'originEpoch').sort().map((k) => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}';
}

// 6554b5b's summary, built the way its parseWorkerSource built the Worker: its function list and constants.
function oldSummarizer(src) {
  const fns = ((src.match(/const fns = \[([^\]]+)\];/) || [])[1] || '').split(',').map((s) => s.trim()).filter(Boolean);
  const consts = ((src.match(/const consts = \{ ([^}]+) \};/) || [])[1] || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!fns.length || !consts.length) throw new Error(BASE_REV + ' Worker list not found');
  const code = ["'use strict';",
    ...consts.map((n) => 'const ' + n + ' = ' + src.match(new RegExp('const ' + n + ' = ([^;]+);'))[1] + ';'),
    "let QUADRANT_THRESH = {}, _hrShift = null, _dayKeyLast = { start: 0, end: 0, key: '' };",
    'function getHrShiftSettings() { return _hrShift; }',
    ...fns.map((n) => { const f = jsFunction(src, n); if (!f) throw new Error(BASE_REV + ' missing ' + n); return f; }),
    'globalThis.run = (fn, text, quad, shift) => { QUADRANT_THRESH = quad; _hrShift = shift; return summarizeCSV(fn, text); };'].join('\n');
  const ctx = vm.createContext({ console: { warn() {}, log() {} }, Intl });
  vm.runInContext(code, ctx);
  return (fn, text, o) => ctx.run(fn, text, o.quad, o.shift);
}
// The module as the page loads it: a classic script with self = window.
function newSummarizer(src) {
  const win = { console: { warn() {}, log() {} }, Intl };
  win.self = win;
  const ctx = vm.createContext(win);
  vm.runInContext(src, ctx);
  const P = ctx.AortiViewerParse;
  return (fn, text, o) => (o.none ? P.summarizeCSV(fn, text) : P.summarizeCSV(fn, text, { quad: o.quad, shift: o.shift }));
}
// The module in a real worker thread, the way the browser runs it: importScripts exists, no document.
function startWorker(src) {
  const boot = `const { parentPort, workerData } = require('worker_threads');
globalThis.self = globalThis;
globalThis.importScripts = () => {};
globalThis.postMessage = (m) => parentPort.postMessage(m);
require('vm').runInThisContext(workerData);
parentPort.on('message', (d) => self.onmessage({ data: d }));`;
  const w = new Worker(boot, { eval: true, workerData: src, env: { TZ: process.env.TZ } });
  let seq = 0;
  const waiting = new Map();
  w.on('message', (m) => { const p = waiting.get(m.id); if (p) { waiting.delete(m.id); p(m); } });
  return {
    ask: (fn, text, o) => new Promise((res) => { const id = ++seq; waiting.set(id, res); w.postMessage({ id, fn, text, quad: o.quad, shift: o.shift }); }),
    stop: () => w.terminate(),
  };
}

// Settings: the page's default (Typical quadrant, HR shift 30 bpm over 10 min), POTS with a tighter shift, a custom
// set, and no opts at all (node tests call summarizeCSV(fn, text); 6554b5b then had {} and the shift default).
const SETS = {
  default: { quad: { hrLow: 65, hrHigh: 85, hrvLow: 30, hrvHigh: 50 }, shift: { threshold: 30, windowMin: 10 } },
  pots: { quad: { hrLow: 80, hrHigh: 100, hrvLow: 20, hrvHigh: 35 }, shift: { threshold: 20, windowMin: 5 } },
  custom: { quad: { hrLow: 70, hrHigh: 95, hrvLow: 25, hrvHigh: 45 }, shift: { threshold: 45, windowMin: 15 } },
  none: { quad: {}, shift: { threshold: 30, windowMin: 10 }, none: true },
};

// Fixtures. Rows every 5 s with HR swings big enough to cross every quadrant and HR shift setting.
const HEADER = 'time_min,epoch_ms,hr_bpm,rmssd_ms,sdnn_match_ms,sdnn_5min_ms,sdnn_full_ms,palpitation,event,warning,connection,posture';
function csv(ep0, n, cells) {
  const out = [HEADER];
  for (let i = 0; i < n; i++) {
    const hr = Math.round(78 + 22 * Math.sin(i / 40) + (i % 300 < 25 ? 30 : 0));
    const rm = (34 + 14 * Math.cos(i / 55)).toFixed(2);
    const c = [(i * 5 / 60).toFixed(4), String(ep0 + i * 5000), String(hr), rm, '', '', '', i % 97 === 5 ? '1' : '', '', '', i === 0 ? 'connect' : '', i === 1 ? 'sitting' : ''];
    if (cells) cells(i, c);
    out.push(c.join(','));
  }
  return out.join('\n') + '\n';
}
const GUARDED = ["'=SUM(A1)", "'-dizzy", "''=x", "'tis", '5\'10" note', "'+1 more", "'@home", '-'];
const localNative = new Date('2026-04-17T23:40:00.123').getTime();
const FIXTURES = [
  { name: 'guarded event and warning labels', fn: 'hrv_session_2026-04-18T16-00-00.csv',
    text: csv(Date.UTC(2026, 3, 18, 16, 0, 0) + 2000, 900, (i, c) => { if (i % 60 === 7) c[8] = GUARDED[(i / 60 | 0) % GUARDED.length]; if (i % 120 === 13) c[9] = 'warn-high'; }) },
  { name: 'native local name crossing local midnight', fn: 'hrv_session_2026-04-17T23-40-00.123.csv', text: csv(localNative + 4000, 1200, (i, c) => { if (i === 300) c[8] = 'stood'; }) },
  { name: 'web UTC name crossing local midnight', fn: 'hrv_session_2026-04-19T05-30-00.csv', text: csv(Date.UTC(2026, 3, 19, 5, 30, 0) + 1000, 1100) },
  { name: 'header only (mid-upload stub)', fn: 'hrv_session_2026-04-20T08-00-00.csv', text: HEADER + '\n' },
  { name: 'daily file name', fn: 'hrv_daily_2026-04-21.csv', text: csv(new Date(2026, 3, 21, 0, 0, 30).getTime(), 700) },
];
function inputs() {
  const out = [];
  const man = JSON.parse(fs.readFileSync(path.join(ROOT, 'demo', 'manifest.json'), 'utf8'));
  for (const n of man.files) out.push({ name: 'demo ' + n, fn: n, text: fs.readFileSync(path.join(ROOT, 'demo', n), 'utf8') });
  const s35 = fs.readFileSync(path.join(__dirname, 'fixtures', 's35-stale-timemin.mjs'), 'utf8');
  const fnName = s35.match(/S35_FIXTURE_NAME = '([^']+)'/)[1];
  const make = vm.runInNewContext('(' + s35.match(/export function staleTimeMinCsv\(\) \{[\s\S]*?\n\}/)[0].replace('export function', 'function') + ')');
  out.push({ name: 'S35 stale time_min synthetic', fn: fnName, text: make() });
  return out.concat(FIXTURES);
}
// The local recordings (gitignored): this checkout's CSV Dates/, else the main checkout's.
function localCsvs() {
  const dirs = [path.join(ROOT, 'CSV Dates')];
  try { dirs.push(path.join(path.dirname(path.resolve(ROOT, execFileSync('git', ['rev-parse', '--git-common-dir'], { cwd: ROOT, encoding: 'utf8' }).trim())), 'CSV Dates')); } catch (e) {}
  const dir = dirs.find((d) => fs.existsSync(d));
  if (!dir) return [];
  const out = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (e.name.endsWith('.csv')) out.push({ name: 'local', fn: e.name, text: fs.readFileSync(p, 'utf8') }); } };
  walk(dir);
  return out;
}

// Page checks: the script tag, no Worker builder, the module owns the day start, and the Worker plumbing run for real.
async function pageChecks(html) {
  check('hrv_viewer.html loads ./viewer-parse.js as a script', /<script src="\.\/viewer-parse\.js"><\/script>/.test(html));
  check('hrv_viewer.html has no hand-kept Worker list (const fns = [, parseWorkerSource)', !/const fns = \[/.test(html) && !/parseWorkerSource/.test(html));
  check('DAY_START_HOUR and _dayKeyLast live only in viewer-parse.js', !/DAY_START_HOUR|_dayKeyLast/.test(html) && /const DAY_START_HOUR = /.test(MOD) && /let _dayKeyLast = /.test(MOD));
  const a = html.indexOf('  let _parseWorker = null'), b = html.indexOf('  window.__hrmParse = ');
  check('found the page Worker plumbing', a > 0 && b > a);
  if (!(a > 0 && b > a)) return;
  const plumbing = html.slice(a, b);
  const run = async (reply) => {
    const made = [];
    const win = {};
    class FakeWorker {
      constructor(url) { made.push(url); this.sent = []; }
      postMessage(m) { this.sent.push(m); setTimeout(() => this.onmessage({ data: reply(m) }), 0); }
      terminate() { this.dead = true; }
    }
    const ctx = vm.createContext({ window: win, Worker: FakeWorker, console: { warn() {} }, setTimeout, clearTimeout, Map, Promise,
      SUMMARY_SCHEMA_V: 16, QUADRANT_THRESH: { hrLow: 1 }, getHrShiftSettings: () => ({ threshold: 9, windowMin: 2 }),
      summarizeCSV: (fn, text, o) => ({ from: 'main', o }) });
    vm.runInContext(plumbing + '\nglobalThis.go = summarizeCSVAsync;', ctx);
    const r = await ctx.go('hrv_session_2026-04-18T16-00-00.csv', 'x');
    return { r, made, mode: win.__hrmParseMode };
  };
  const good = await run((m) => ({ id: m.id, __schemaV: 16, summary: { from: 'worker', quad: m.quad, shift: m.shift } }));
  check("the Worker starts on './viewer-parse.js?v=' + SUMMARY_SCHEMA_V", good.made.length === 1 && good.made[0] === './viewer-parse.js?v=16', good.made.join(', '));
  check('a reply with the page schema is used, with the page settings sent along', good.r.from === 'worker' && good.r.quad.hrLow === 1 && good.r.shift.threshold === 9, JSON.stringify(good.r));
  check('diagnostics marker reads worker after a good reply', good.mode === 'worker', good.mode);
  const stale = await run((m) => ({ id: m.id, __schemaV: 15, summary: { from: 'worker' } }));
  check('a reply from another schema is refused: the main thread summarizes, with the page settings', stale.r.from === 'main' && stale.r.o.quad.hrLow === 1 && stale.r.o.shift.threshold === 9, JSON.stringify(stale.r));
  check('diagnostics marker names the main thread and why', /^main thread: worker schema 15/.test(stale.mode || ''), stale.mode);
  const diag = norm(fs.readFileSync(path.join(ROOT, 'diagnostics.js'), 'utf8'));
  check('diagnostics.js shows the parse mode', /window\.__hrmParseMode/.test(diag) && /rows\('Viewer parsing'/.test(diag));
}

// Old against new on every input and settings set; returns the cases that differ.
function diffCases(newSum, oldSum, list, sets) {
  const bad = [];
  for (const x of list) for (const k of sets) {
    let a, b;
    try { a = canon(newSum(x.fn, x.text, SETS[k])); } catch (e) { a = 'threw ' + e.message; }
    try { b = canon(oldSum(x.fn, x.text, SETS[k])); } catch (e) { b = 'threw ' + e.message; }
    if (a !== b) bad.push(x.name + ' / ' + k);
  }
  return bad;
}
async function workerCases(src, list, sets) {
  const main = newSummarizer(src), w = startWorker(src), bad = [];
  try {
    for (const x of list) for (const k of sets) {
      const rep = await w.ask(x.fn, x.text, SETS[k]);
      let m;
      try { m = canon(main(x.fn, x.text, SETS[k])); } catch (e) { m = 'threw ' + e.message; }
      const got = rep.error ? 'threw ' + rep.error : canon(rep.summary);
      if (got !== m || rep.__schemaV !== 16) bad.push(x.name + ' / ' + k);
    }
  } finally { await w.stop(); }
  return bad;
}

(async () => {
  check('viewer-parse.js present', !!MOD);
  check('6554b5b source from git show', !!old);
  if (!MOD || !old) process.exit(1);
  await pageChecks(page);
  const oldSum = oldSummarizer(old), newSum = newSummarizer(MOD);
  const list = inputs();
  // The settings must matter, or the non-default sets prove nothing.
  const sens = list.filter((x) => canon(oldSum(x.fn, x.text, SETS.default)) !== canon(oldSum(x.fn, x.text, SETS.pots)));
  check('the quadrant and HR shift sets change at least 5 summaries', sens.length >= 5, sens.length + ' of ' + list.length);
  const kinds = list.map((x) => x.name);
  check('inputs include every demo file, guarded labels and a midnight crossing', kinds.filter((n) => n.startsWith('demo ')).length === 12 && kinds.includes('guarded event and warning labels') && kinds.includes('native local name crossing local midnight'));
  const fx = (n) => list.find((x) => x.name === n);
  const night = newSum(fx('native local name crossing local midnight').fn, fx('native local name crossing local midnight').text, SETS.default);
  check('the midnight fixtures span two viewer days', Object.keys(night.byDay || {}).length === 2, Object.keys(night.byDay || {}).join(', '));
  const g = newSum(fx('guarded event and warning labels').fn, fx('guarded event and warning labels').text, SETS.default);
  check('the guarded labels reach the summary as written (unguarding is display only)', GUARDED.every((l) => g.events.some((e) => e.label === l)), g.events.map((e) => e.label).slice(0, 8).join(' | '));
  // Guards: 2026-11-01 review, marks placed on a session chart saved about 4 s late because x = 0 was taken as the first beat.
  const off = list.filter((x) => x.name.startsWith('demo ')).map((x) => {
    const r = newSum(x.fn, x.text, SETS.default);
    return r.startEpoch - r.originEpoch;
  });
  check('originEpoch is the time of chart x = 0, before the first beat', off.length === 12 && off.every((ms) => ms > 0 && ms < 600000), off.join(', '));
  const bad = diffCases(newSum, oldSum, list, Object.keys(SETS));
  check(`summarizeCSV deep-equals ${BASE_REV} on ${list.length} files x ${Object.keys(SETS).length} settings`, bad.length === 0, bad.slice(0, 6).join('; '));
  const local = localCsvs();
  if (local.length) {
    const lb = diffCases(newSum, oldSum, local, ['default', 'pots']);
    check(`local CSV Dates/: ${local.length} recordings deep-equal ${BASE_REV} (default and POTS)`, lb.length === 0, lb.length + ' differ');
  } else console.log('NOTE  no local CSV Dates/ folder: the private recordings were not compared (CI has none)');
  const wb = await workerCases(MOD, list, Object.keys(SETS));
  check(`worker thread replies equal the main thread on ${list.length} files x ${Object.keys(SETS).length} settings`, wb.length === 0, wb.slice(0, 6).join('; '));

  // Negative controls: each mutant of viewer-parse.js must fail old-against-new or Worker-against-main.
  const MUTANTS = [
    ['summary ignores the HR shift setting', 'shift = (opts && opts.shift) || HR_SHIFT_DEFAULT;', 'shift = HR_SHIFT_DEFAULT;', 'main'],
    ['summary ignores the quadrant setting', 'const quad = (opts && opts.quad) || {}', 'const quad = {}', 'main'],
    ['Worker drops the page settings', 'summarizeCSV(d.fn, d.text, { quad: d.quad, shift: d.shift })', 'summarizeCSV(d.fn, d.text)', 'worker'],
    ['day starts at 1 am', 'const DAY_START_HOUR = 0;', 'const DAY_START_HOUR = 1;', 'main'],
    ['event label drops its epoch', 'events.push({ t, label: r[idx.event], ep });', 'events.push({ t, label: r[idx.event] });', 'main'],
  ];
  let caught = 0;
  for (const [name, a, b, kind] of MUTANTS) {
    if (!MOD.includes(a)) { check(`mutant "${name}" applies`, false, 'anchor moved; update the mutant'); continue; }
    const m = MOD.replace(a, b);
    const sets = Object.keys(SETS);
    const got = kind === 'worker' ? await workerCases(m, list.slice(0, 4), sets) : diffCases(newSummarizer(m), oldSum, list, sets);
    check(`mutant "${name}" caught`, got.length > 0);
    if (got.length) caught++;
  }
  if (caught === MUTANTS.length) console.log(`all ${caught} mutants caught`);
  if (failures) { console.log(failures + ' viewer parse check(s) FAILED.'); process.exit(1); }
  console.log('All viewer parse checks passed.');
})().catch((e) => { console.error(e); process.exit(1); });
