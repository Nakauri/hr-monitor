// Guards: a session showing 70:38:35 with 3 minutes of chart at 8:21 AM because the viewer trusted a stale
// time_min column (AUDIT-NOTES 2026-10-11 item 31, Khal 2026-10-12; step S35). Files: hrv_viewer.html
// rowElapsedMinFn, summarizeCSV, loadFullSession, the cached-index re-read. Runtime: about 5 s; run when
// hrv_viewer.html parsing or summary code changes.
// Checks: the synthetic stale fixture summarizes to about 3 min with a 9:46 AM axis origin; demo files and a
// synthetic native segment summarize deep-equal to the --ref build (default e8d9311); the evidence file, when
// present locally, prints its duration. --mutants bypasses the helper and must FAIL.
// Usage: node scripts/session-time.mjs [--ref <commit>] [--mutants]
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { staleTimeMinCsv, S35_FIXTURE_NAME } from './fixtures/s35-stale-timemin.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const MUTANTS = args.includes('--mutants');
const refI = args.indexOf('--ref');
const REF = refI >= 0 ? args[refI + 1] : 'e8d9311';
const EVIDENCE = path.join(ROOT, '..', 'HR Monitor', 'ux-audit', 'redesign', 'build-shots', 'evidence-stale-timemin-2026-10-05.csv');
const EVIDENCE_ALT = 'C:/Users/Khal/Desktop/Mine/HR Monitor/ux-audit/redesign/build-shots/evidence-stale-timemin-2026-10-05.csv';

function grabFrom(text, name) {
  // A declaration at the start of a line: the S29 worker builder holds a getHrShiftSettings stub inside a string.
  const i = text.search(new RegExp('^[ \\t]*(?:async\\s+)?function ' + name + '\\s*\\(', 'm'));
  if (i < 0) throw new Error('function not found: ' + name);
  const j = text.indexOf('{', text.indexOf(')', i));
  let d = 0;
  for (let k = j; k < text.length; k++) {
    if (text[k] === '{') d++;
    if (text[k] === '}') { d--; if (!d) return text.slice(i, k + 1); }
  }
  throw new Error('unbalanced: ' + name);
}
function grabConstFrom(text, name) {
  const m = text.match(new RegExp('^\\s*(?:const|let) ' + name + ' = [^\\n]*;', 'm'));
  if (!m) throw new Error('const not found: ' + name);
  return m[0];
}
// Evaluates named functions in a fresh context, pulling missing functions and one-line consts on demand.
function loadPage(text, names, globals, run) {
  let code = names.map(n => grabFrom(text, n)).join('\n');
  const loaded = new Set(names);
  for (let attempt = 0; attempt < 120; attempt++) {
    const ctx = vm.createContext(Object.assign({ console: { log() {}, warn() {}, info() {}, error() {} }, Map, Set, Date, Math, JSON,
      Promise, setTimeout, clearTimeout, parseFloat, parseInt, isNaN, isFinite, Number, String, Array, Object, Infinity, NaN,
      encodeURIComponent, Intl,
      localStorage: { getItem() { return null; }, setItem() {} },
      document: { getElementById() { return null; }, documentElement: {}, body: { classList: { contains() { return false; } } } },
      window: {}, getComputedStyle: () => ({ getPropertyValue: () => '' }) }, globals || {}));
    try {
      vm.runInContext(code + '\n;globalThis.__run = (' + run.toString() + ');', ctx);
      ctx.__run();
      return ctx;
    } catch (e) {
      const m = e && e.message ? String(e.message).match(/^(\w+) is not defined$/) : null;
      if (!m || loaded.has(m[1])) throw e;
      loaded.add(m[1]);
      try { code = grabFrom(text, m[1]) + '\n' + code; }
      catch (_) { code = grabConstFrom(text, m[1]) + '\n' + code; }
    }
  }
  throw new Error('dependency resolution did not settle');
}

// Fixed clock so the future-epoch guard and any "now" reads agree between builds.
const NOW = Date.UTC(2026, 9, 12, 12, 0, 0);
class FixedDate extends Date {
  constructor(...a) { if (a.length) super(...a); else super(NOW); }
  static now() { return NOW; }
}

async function summarizeAll(src, inputs) {
  const ctx = loadPage(src, ['summarizeCSV', 'parseSegmentV2', 'v2SessionCsv', 'computeUptimePct', 'loadFullSession', 'isV2SessionKey'],
    { Date: FixedDate, __in: inputs, marksPage: null, virtualSessions: {}, _sessionCache: new Map(), _sessionCacheTouch: (f, v) => v,
      readSessionText: async (fn) => (inputs.find(x => x.name === fn) || {}).text },
    function () {
      globalThis.__out = __in.map(x => {
        if (x.segment) {
          const seg = parseSegmentV2(x.segment, x.segName);
          return summarizeCSV(x.name, v2SessionCsv(x.sid, seg.rows));
        }
        return summarizeCSV(x.name, x.text);
      });
      globalThis.__up = globalThis.__out.map(s => (s ? computeUptimePct(s) : null));
      globalThis.__full = Promise.all(__in.map(x => (x.text ? loadFullSession(x.name) : null)));
    });
  return { sums: ctx.__out, up: ctx.__up, full: ctx.__full };
}

// Synthetic native segment, same row shapes the recorder writes.
function syntheticSegment() {
  const BASE = Date.UTC(2026, 9, 6, 15, 0, 0), SID = BASE + 5000;
  const lines = ['#hrm,v=2,base=' + BASE + ',tz=-360,app=1.0,dev=test,flavour=personal', 'g,5000,' + SID + ',start', 'c,5200,connected'];
  for (let t = 6000; t < 20 * 60000; t += 1000) lines.push(`h,${t},${80 + (t % 7)},30.00,750;760`);
  lines.push('g,1200000,' + SID + ',stop');
  return { name: 'v2:s35-segment', segment: lines.join('\n') + '\n', segName: 'hrm_20261006T15Z_s35abc.csv', sid: SID };
}

let srcAfter = fs.readFileSync(path.join(ROOT, 'hrv_viewer.html'), 'utf8').replace(/\r\n/g, '\n');
if (MUTANTS) {
  const before = srcAfter;
  srcAfter = srcAfter.replace('function rowElapsedMinFn(rows, idx) {', 'function rowElapsedMinFn(rows, idx) { return (r) => parseFloat(r[idx.time_min]);');
  if (srcAfter === before) { console.log('FAIL mutant could not be applied'); process.exit(1); }
  console.log('[mutant] rowElapsedMinFn bypassed: time_min read raw');
}
const srcBefore = execFileSync('git', ['-C', ROOT, 'show', REF + ':hrv_viewer.html'], { encoding: 'utf8', maxBuffer: 64 << 20 }).replace(/\r\n/g, '\n');

const results = [];
const check = (name, ok, detail) => { results.push(ok); console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? '  (' + detail + ')' : '')); };
const hms = (min) => { const s = Math.round(min * 60); return Math.floor(s / 3600) + ':' + String(Math.floor(s / 60) % 60).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0'); };
const clock = (ep) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Edmonton', hour: 'numeric', minute: '2-digit', hour12: true }).format(new Date(ep));

// 1. Synthetic stale fixture.
const fxIn = { name: S35_FIXTURE_NAME, text: staleTimeMinCsv() };
const A = await summarizeAll(srcAfter, [fxIn]);
const s = A.sums[0];
check('fixture summarizes', !!s, s ? '' : 'null summary');
if (s) {
  const secs = Math.round(s.duration * 60);
  check('fixture duration 0:03:08 to 0:03:10', secs >= 188 && secs <= 190, hms(s.duration));
  // Session view: tick label = summary.startEpoch + x minutes (makeTimeTickFormatter), x from loadFullSession.
  const full = (await A.full)[0];
  const xs = full.hr.map(p => p.x);
  const startClock = clock(s.startEpoch + xs[0] * 60000), endClock = clock(s.startEpoch + xs[xs.length - 1] * 60000);
  check('session axis starts 9:46 AM Edmonton', /^9:46/.test(startClock), startClock);
  check('session axis ends 9:49 AM Edmonton', /^9:49/.test(endClock), endClock);
  check('session view x runs 0 to the duration', xs[0] === 0 && xs[xs.length - 1] === s.duration, xs[0] + ' to ' + xs[xs.length - 1]);
  const gaps = full.hr.filter(p => p.y == null).length;
  check('no gap markers in a gapless 1 Hz file', gaps === 0, gaps + ' gaps');
  const up = A.up[0];
  check('uptime is 0 to 100 percent', up == null || (up >= 0 && up <= 100), String(up));
  check('max and min HR times inside the session', [s.hrMax, s.hrMin].every(p => p.t >= 0 && p.t <= s.duration), `max@${s.hrMax.t} min@${s.hrMin.t}`);
}

// 2. Parity: demo files plus a synthetic native segment, before and after.
const demoDir = path.join(ROOT, 'demo');
const manifest = JSON.parse(fs.readFileSync(path.join(demoDir, 'manifest.json'), 'utf8'));
const names = Array.from(new Set(manifest.files.concat(fs.readdirSync(demoDir).filter(n => n.endsWith('.csv'))))).sort();
const inputs = names.map(n => ({ name: n, text: fs.readFileSync(path.join(demoDir, n), 'utf8') })).concat([syntheticSegment()]);
const B = await summarizeAll(srcBefore, inputs);
const C = await summarizeAll(srcAfter, inputs);
let same = 0;
const diffs = [];
inputs.forEach((x, i) => {
  if (B.sums[i] && JSON.stringify(B.sums[i]) === JSON.stringify(C.sums[i])) same++;
  else diffs.push(x.name);
});
check(`parity: ${inputs.length} summaries (${names.length} demo + 1 native segment) deep-equal to ${REF}`, same === inputs.length && same > 1, diffs.length ? 'differ: ' + diffs.join(', ') : same + ' equal');

// 3. Evidence file, local only, never copied.
const ev = [EVIDENCE, EVIDENCE_ALT].find(p => fs.existsSync(p));
if (!ev) console.log('SKIP evidence file absent');
else {
  const E = await summarizeAll(srcAfter, [{ name: 'hrv_session_2026-10-05T15-49-52.csv', text: fs.readFileSync(ev, 'utf8') }]);
  const es = E.sums[0];
  const secs = es ? Math.round(es.duration * 60) : -1;
  check('evidence file duration about 3 min (local only)', secs >= 180 && secs <= 200, es ? hms(es.duration) + ', starts ' + clock(es.startEpoch) : 'null');
}

const failed = results.filter(r => !r).length;
console.log(failed ? `FAIL ${failed} of ${results.length}` : `PASS ${results.length} of ${results.length}`);
process.exit(failed ? 1 : 0);
