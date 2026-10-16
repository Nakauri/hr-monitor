// PARITY CRITICAL: hr-source.js (JS twin) against HrSourcePolicy.java and the golden vectors (S54).
// J1 constants equal, J2 parseHR decodes every vector packet, J3 golden and assertions, J4 RR arrays untouched,
// J5 the twin runs only on the Web Bluetooth path of processHRData, J6 switched and newRun agree with source changes and marks,
// M1 the JS and JVM mutant tables carry the same names.
// Guards: the strap's HR byte lagging the beats at session start (10-15: strap 80 to 101 while RR said ~155) and Java/JS drift (April 2026 HRV 133 vs 86).
// Golden row: <case> <idx> <shown> <S|B> <switched> <newRun 1|0> <estimate x100 rounded, or ->. Runtime about 2 s.
// Run: node scripts/hr-source-parity.test.cjs [--write | --mutants]   (must exit 0)
// --write rewrites hr-source-golden.txt from the twin; only after a deliberate change, noted in the step's progress.
// .cjs because the repo package.json is "type":"module"; the twin is a browser script loaded through a window global.
const vm = require('vm');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const TWIN = path.join(ROOT, 'hr-source.js');
const JAVA = path.join(ROOT, 'mobile/android-overlay/app/src/main/java/com/nakauri/hrmonitor/HrSourcePolicy.java');
const PAGE = path.join(ROOT, 'hr_monitor.html');
const VEC = path.join(__dirname, 'fixtures', 'hr-source-vectors.txt');
const GOLD = path.join(__dirname, 'fixtures', 'hr-source-golden.txt');
const BASE = '4a37e40';
const args = process.argv.slice(2);

let failures = 0;
function check(name, cond, detail) {
  console.log((cond ? '  PASS  ' : '  FAIL  ') + name + (detail && !cond ? ' (' + detail + ')' : ''));
  if (!cond) failures++;
}
const load = (src) => { const ctx = { window: {} }; vm.createContext(ctx); vm.runInContext(src, ctx, { filename: TWIN }); return ctx.window.HrSource; };

function readVectors() {
  const cases = [];
  let c = null;
  for (const line of fs.readFileSync(VEC, 'utf8').split('\n')) {
    if (!line || line.startsWith('#')) continue;
    const f = line.trim().split(/\s+/);
    if (f[0] === 'case') { c = { name: f[1], steps: [], asserts: [], n: 0 }; cases.push(c); }
    else if (f[0] === 'reset' || f[0] === 'link') c.steps.push({ mark: f[0] });
    else if (f[0] === 'p') c.steps.push({ idx: c.n++, t: +f[1], hex: f[2], hr: +f[3], rr: f[4] === '-' ? [] : f[4].split(';').map(Number) });
    else if (f[0] === 'a') c.asserts.push(f.slice(1));
  }
  return cases;
}
const CASES = readVectors();

// Runs a twin over every case. Returns per-case results and J4 violations.
function runAll(H) {
  const out = {}, mutated = [];
  for (const c of CASES) {
    const p = H.create(), res = [];
    let mark = false;
    for (const s of c.steps) {
      if (s.mark === 'reset') { p.reset(); mark = true; continue; }
      if (s.mark === 'link') { p.linkLive(); mark = true; continue; }
      const rr = s.rr.slice();
      const r = p.onPacket(s.hr, rr, s.t);
      if (rr.length !== s.rr.length || rr.some((v, j) => v !== s.rr[j])) mutated.push(c.name + ' ' + s.idx);
      res.push({ shown: r.shown, src: r.beat ? 'B' : 'S', switched: r.switched, newRun: r.newRun ? 1 : 0, est: r.est == null ? '-' : String(Math.round(r.est * 100)), mark });
      mark = false;
    }
    out[c.name] = res;
  }
  return { out, mutated };
}
function assertFails(c, res) {
  const fails = [];
  for (const a of c.asserts) {
    if (a[0] === 'switches') {
      let sw = 0;
      res.forEach((r, i) => { if (r.src === 'B' && (i === 0 || res[i - 1].src !== 'B')) sw++; });
      if (sw > +a[1]) fails.push(c.name + ' switches ' + sw + ' > ' + a[1]);
      continue;
    }
    const from = +a[0], to = +a[1];
    for (let i = from; i <= to; i++) {
      const r = res[i];
      if (!r) { fails.push(c.name + ' ' + i + ' missing'); break; }
      if (a[2] === 'src' && r.src !== a[3]) { fails.push(c.name + ' ' + i + ' src ' + r.src + ' want ' + a[3]); break; }
      if (a[2] === 'shown' && (r.shown < +a[3] || r.shown > +a[4])) { fails.push(c.name + ' ' + i + ' shown ' + r.shown + ' want ' + a[3] + '..' + a[4]); break; }
    }
  }
  return fails;
}
const goldRow = (r) => r.shown + ' ' + r.src + ' ' + r.switched + ' ' + r.newRun + ' ' + r.est;
// J6: switched is +1 on a strap-to-beats change, -1 on beats-to-strap inside a run, else 0; newRun on the first packet and after reset or link.
function consistencyFails(name, res) {
  const fails = [];
  res.forEach((r, i) => {
    const prev = i > 0 && res[i - 1].src === 'B', now = r.src === 'B';
    const want = now && !prev ? 1 : !now && prev && !r.newRun ? -1 : 0;
    if (r.switched !== want) fails.push(name + ' ' + i + ' J6 switched ' + r.switched + ' want ' + want);
    if ((i === 0 || r.mark) && !r.newRun) fails.push(name + ' ' + i + ' J6 newRun 0 at a run start');
  });
  return fails.slice(0, 1);
}
function readGolden() {
  const g = {};
  for (const raw of fs.readFileSync(GOLD, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const f = line.split(' ');
    (g[f[0]] = g[f[0]] || [])[+f[1]] = f.slice(2).join(' ');
  }
  return g;
}
function goldenFails(out, gold) {
  const fails = [];
  for (const c of CASES) {
    const g = gold[c.name] || [], r = out[c.name];
    if (g.length !== r.length) { fails.push(c.name + ' golden has ' + g.length + ' rows, twin ' + r.length); continue; }
    for (let i = 0; i < r.length; i++) if (g[i] !== goldRow(r[i])) { fails.push(c.name + ' ' + i + ' twin ' + goldRow(r[i]) + ' golden ' + (g[i] || '-')); break; }
  }
  return fails;
}
// Every failure of a twin text: golden, assertions, J4.
function twinFails(src, gold) {
  let H;
  try { H = load(src); } catch (e) { return ['load: ' + e.message]; }
  const { out, mutated } = runAll(H);
  const f = goldenFails(out, gold);
  for (const c of CASES) f.push(...assertFails(c, out[c.name]), ...consistencyFails(c.name, out[c.name]));
  if (mutated.length) f.push('J4 rr changed at ' + mutated[0]);
  return f;
}

const twinSrc = fs.readFileSync(TWIN, 'utf8');

if (args.includes('--write')) {
  const { out } = runAll(load(twinSrc));
  const lines = [];
  for (const c of CASES) out[c.name].forEach((r, i) => lines.push(c.name + ' ' + i + ' ' + goldRow(r)));
  fs.writeFileSync(GOLD, lines.join('\n') + '\n');
  console.log('wrote ' + GOLD + ': ' + lines.length + ' rows');
  process.exit(0);
}

// ---- J1 constants ---------------------------------------------------------
const javaSrc = fs.readFileSync(JAVA, 'utf8');
const H = load(twinSrc);
const jc = {};
for (const m of javaSrc.matchAll(/^\s*static final (?:int|long|double) ([A-Z_]+) = ([-0-9._]+L?);/gm)) jc[m[1]] = Number(m[2].replace(/_/g, '').replace(/L$/, ''));
const jsNames = Object.keys(H.C).sort(), jNames = Object.keys(jc).sort();
check('J1 constant names equal (' + jNames.length + ')', JSON.stringify(jsNames) === JSON.stringify(jNames), 'java ' + jNames.join(',') + ' js ' + jsNames.join(','));
const diffs = jNames.filter((n) => H.C[n] !== jc[n]);
check('J1 constant values equal', diffs.length === 0, diffs.map((n) => n + ' java ' + jc[n] + ' js ' + H.C[n]).join('; '));
check('J1 NONE stays private and outside the comparison', /private static final long NONE = Long\.MIN_VALUE;/.test(javaSrc) && !('NONE' in jc));

// ---- J2 decode with the page's parseHR ------------------------------------
const page = fs.readFileSync(PAGE, 'utf8');
function blockEnd(src, open) {
  let depth = 0, q = null;
  for (let i = open; i < src.length; i++) {
    const c = src[i], n = src[i + 1];
    if (q) { if (c === '\\') { i++; continue; } if (c === q) q = null; continue; }
    if (c === '/' && n === '/') { i = src.indexOf('\n', i); continue; }
    if (c === '/' && n === '*') { i = src.indexOf('*/', i + 2) + 1; continue; }
    if (c === "'" || c === '"' || c === '`') { q = c; continue; }
    if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return i;
  }
  return -1;
}
function funcText(src, name) {
  const re = new RegExp('(?:async\\s+)?function\\s+' + name + '\\s*\\(', 'g');
  const all = [...src.matchAll(re)];
  if (all.length !== 1) return null;
  const o = src.indexOf('{', all[0].index);
  return { start: all[0].index, open: o, end: blockEnd(src, o), text: src.slice(all[0].index, blockEnd(src, o) + 1) };
}
const ph = funcText(page, 'parseHR');
check('J2 parseHR found once in hr_monitor.html', !!ph);
if (ph) {
  const parseHR = new Function('debugBLE', ph.text + '\nreturn parseHR;')(false);
  let bad = null, n = 0;
  for (const c of CASES) for (const s of c.steps) {
    if (s.mark) continue;
    const bytes = Uint8Array.from(s.hex.match(/../g).map((h) => parseInt(h, 16)));
    const d = parseHR(new DataView(bytes.buffer));
    n++;
    if (d.hr !== s.hr || d.rrs.length !== s.rr.length || d.rrs.some((v, j) => v !== s.rr[j])) { bad = c.name + ' ' + s.idx + ' decoded ' + d.hr + ' ' + d.rrs.join(';'); break; }
  }
  check('J2 parseHR decodes every vector packet to its hr and rr (' + n + ')', !bad, bad);
}

// ---- J3 golden and assertions, J4 immutability ----------------------------
const gold = readGolden();
const { out, mutated } = runAll(H);
const gf = goldenFails(out, gold);
check('J3 twin equals hr-source-golden.txt on every packet', gf.length === 0, gf.slice(0, 3).join('; '));
let na = 0; const af = [];
for (const c of CASES) { na += c.asserts.length; af.push(...assertFails(c, out[c.name])); }
check('J3 every assertion line holds (' + na + ' over ' + CASES.length + ' cases)', af.length === 0, af.slice(0, 5).join('; '));
check('J4 no RR array changes inside onPacket', mutated.length === 0, mutated.slice(0, 3).join('; '));
const cf = CASES.flatMap((c) => consistencyFails(c.name, out[c.name]));
check('J6 switched and newRun agree with source changes, reset and link', cf.length === 0, cf.slice(0, 3).join('; '));

// ---- J5 wiring in hr_monitor.html -----------------------------------------
const CALL = 'hr = webHrSource.policy.onPacket(hr, rrs, Date.now()).shown;';
const GATE = 'if (engineRmssd === undefined && webHrSource.policy) {';
let base = null;
try { base = execFileSync('git', ['-C', ROOT, 'show', BASE + ':hr_monitor.html'], { encoding: 'utf8', maxBuffer: 64 << 20 }); } catch (e) { base = null; }
// Runs the gate block with a policy that throws: the strap byte stays, one hr_source error line per 60 s.
function fallbackFails(gateText) {
  const log = [], f = [];
  let clock = 5000000, fn;
  try { fn = new Function('webHrSource', 'state', 'window', 'Date', 'hr', 'rrs', 'engineRmssd', gateText + '\nreturn hr;'); } catch (e) { return ['gate block does not compile: ' + e.message]; }
  const w = { policy: { reset() {}, onPacket() { throw new TypeError('boom'); } }, start: 1, errAt: 0 };
  const step = (hr) => fn(w, { startTime: 1 }, { HRMLog: { event: (t, d) => log.push(t + ' ' + d) } }, { now: () => clock }, hr, [600], undefined);
  try {
    for (let i = 0; i < 60; i++, clock += 1000) if (step(97) !== 97) { f.push('a throw does not show the strap byte'); break; }
    if (log.length !== 1 || log[0] !== 'hr_source error TypeError') f.push('60 throws inside 60 s logged ' + log.length + ' line(s), first ' + log[0]);
    step(98);
    if (log.length !== 2) f.push('no second hr_source error line once 60 s passed');
  } catch (e) { f.push('a throw escapes processHRData: ' + e.message); }
  return f;
}
function j5Fails(src) {
  const f = [];
  const pd = funcText(src, 'processHRData');
  if (!pd) return ['processHRData not found once'];
  const body = pd.text;
  const calls = body.split('webHrSource.policy.onPacket(hr, rrs, Date.now())').length - 1;
  if (calls !== 1 || (src.split('.onPacket(').length - 1) !== 1) f.push('onPacket call count ' + calls);
  const gi = body.indexOf(GATE), ci = body.indexOf(CALL), si = body.indexOf('state.currentHR = hr;');
  if (gi < 0) f.push('gate missing');
  else { const ge = blockEnd(body, body.indexOf('{', gi)); if (!(ci > gi && ci < ge)) f.push('call outside the gate'); }
  if (ci < 0) f.push('shown value not assigned to hr');
  if (!body.includes('try { ' + CALL + ' } catch (e) {')) f.push('no strap fallback: the call is not wrapped in try');
  else if (gi >= 0) f.push(...fallbackFails(body.slice(gi, blockEnd(body, body.indexOf('{', gi)) + 1)));
  if (!/const webHrSource = [^\n]*\n\s*if \(!webHrSource\.policy\) \{[^\n]*window\.HRMLog\.event\('hr_source missing'/.test(src)) f.push('no hr_source missing line when window.HrSource is absent');
  if (!(si > ci)) f.push('call not before state.currentHR = hr;');
  if (/(^|[^\w$.])rrs\s*=(?!=)/.test(body)) f.push('rrs assigned in processHRData');
  if (base) {
    for (const needle of ['computeRMSSD(state.rrBuffer.map(r => r.rr))', 'detectEctopics(rrs, now)']) {
      const ln = (s) => s.split('\n').filter((l) => l.includes(needle)).map((l) => l.trim()).join('\n');
      if (!ln(body) || ln(body) !== ln(funcText(base, 'processHRData').text)) f.push(needle + ' changed from base');
    }
  } else f.push('base ' + BASE + ' not readable');
  const ac = funcText(src, 'attachConnection');
  if (!ac) f.push('attachConnection not found once');
  else {
    const li = ac.text.indexOf('webHrSource.policy.linkLive()'), ei = ac.text.indexOf("addEventListener('characteristicvaluechanged'");
    if (li < 0 || ei < 0 || li > ei) f.push('linkLive not before the notification listener');
  }
  const tag = src.indexOf('<script src="./hr-source.js"></script>'), main = src.indexOf('const webHrSource =');
  if (tag < 0 || main < 0 || tag > main) f.push('hr-source.js tag does not precede the main script');
  return f;
}
const jf = j5Fails(page);
check('J5 processHRData runs the twin only when engineRmssd is undefined, before currentHR; RR untouched; a throw keeps the strap byte and logs once a minute; missing twin logged; linkLive; script tag', jf.length === 0, jf.join('; '));

const MUT = {
  'no-hysteresis': [['EXIT_BPM: 5,', 'EXIT_BPM: 12,'], ['EXIT_HOLD_MS: 10000,', 'EXIT_HOLD_MS: 0,']],
  'no-hold': [['ENTER_HOLD_MS: 5000,', 'ENTER_HOLD_MS: 0,']],
  'no-start-hold': [['START_HOLD_MS: 2000,', 'START_HOLD_MS: 5000,']],
  'no-split': [['MULT_MAX: 4,', 'MULT_MAX: 1,']],
  'no-stale': [['STALE_MS: 5000,', 'STALE_MS: Number.MAX_SAFE_INTEGER / 4,']],
  'no-gap-run': [['RUN_GAP_MS: 10000,', 'RUN_GAP_MS: Number.MAX_SAFE_INTEGER / 4,']],
  'link-ignored': [['linkLive() { pending = true; },', 'linkLive() { },']],
  'reset-ignored': [['reset() { pending = true; lastTs = null; },', 'reset() { },']],
  'window-8s': [['WINDOW_MS: 5000,', 'WINDOW_MS: 8000,']],
  'truncate': [['Math.round(est != null ? est : lastGood)', 'Math.trunc(est != null ? est : lastGood)']],
  'min-kept-2': [['MIN_KEPT: 4,', 'MIN_KEPT: 2,']],
  'no-prerun-drop': [['const out = times[j] < runStart ? [] : repair(', 'const out = repair(']],
  'no-start-gate': [['START_CLEAN_SHARE: 0.75,', 'START_CLEAN_SHARE: 0,']],
  'no-steady-gate': [['STEADY_PLAIN_SHARE: 0.8,', 'STEADY_PLAIN_SHARE: 0,']],
  'no-half-block': [['HALF_TOL: 0.1,', 'HALF_TOL: -1,']],
  'steady-gate-counts-splits': [['(inStart ? kept : plain) / win.length', 'kept / win.length']],
  'start-gate-plain': [['(inStart ? kept : plain) / win.length', 'plain / win.length']],
  'writes-rr': [['hist.push(rrs[j]);', 'hist.push(rrs[j]); rrs[j] = 1000;']],
  'no-switched-in': [['{ beat = true; under = null; switched = 1; }', '{ beat = true; under = null; }']],
  'no-switched-out': [['if (ts - under >= C.EXIT_HOLD_MS) { beat = false; over = null; switched = -1; }', 'if (ts - under >= C.EXIT_HOLD_MS) { beat = false; over = null; }']],
  'newrun-false': [['beat, switched, est, newRun };', 'beat, switched, est, newRun: false };']],
};
// M1: MUT and the JVM runner's policy MUTANTS carry the same names (decoder mutants are Java only).
const RUNNER = path.join(__dirname, 'jvm', 'run-hr-source-test.cjs');
function mutantNameDiff(runnerSrc) {
  const i = runnerSrc.indexOf('const MUTANTS = {'), e = runnerSrc.indexOf('\n};', i);
  if (i < 0 || e < 0) return 'MUTANTS table not found in run-hr-source-test.cjs';
  const java = [...runnerSrc.slice(i, e).matchAll(/^\s*'([\w-]+)': \['policy',/gm)].map((m) => m[1]);
  const js = Object.keys(MUT);
  const d = [...java.filter((x) => !js.includes(x)).map((x) => 'java only ' + x), ...js.filter((x) => !java.includes(x)).map((x) => 'js only ' + x)];
  return d.length ? d.join(', ') : null;
}
const runnerSrc = fs.readFileSync(RUNNER, 'utf8').replace(/\r\n/g, '\n');
const md = mutantNameDiff(runnerSrc);
check('M1 JS mutant names equal the JVM policy mutant names (' + Object.keys(MUT).length + ')', !md, md);
const mdNeg = mutantNameDiff(runnerSrc.replace(/^\s*'no-hold': \['policy',[^\n]*\n/m, ''));
check('M1 negative control: a policy mutant dropped from the runner is reported', mdNeg === 'js only no-hold', mdNeg);

// ---- Mutants ----------------------------------------------------------------
if (args.includes('--mutants')) {
  console.log('\nMutants (each must FAIL):');
  let survived = 0, n = 0;
  for (const [name, edits] of Object.entries(MUT)) {
    n++;
    let src = twinSrc, miss = null;
    for (const [from, to] of edits) { if (src.split(from).length !== 2) miss = from; src = src.replace(from, to); }
    if (miss) { console.log('  FAIL  mutant ' + name + ': anchor not found: ' + miss); survived++; continue; }
    const f = twinFails(src, gold).filter((x) => !x.includes('golden'));
    const where = [...new Set(f.map((x) => x.split(' ')[0]))];
    console.log((f.length ? '  PASS  mutant ' + name + ' FAILED in ' + where.join(', ') : '  FAIL  mutant ' + name + ' SURVIVED'));
    if (!f.length) survived++;
  }
  const blockText = (s) => { const i = s.indexOf(GATE); return s.slice(s.lastIndexOf('\n', i) + 1, blockEnd(s, s.indexOf('{', i)) + 2); };
  const J5M = {
    'j5-no-fallback': (s) => s.replace('try { ' + CALL + ' } catch (e) {', '{ ' + CALL + ' } if (0) {'),
    'j5-catch-drops-hr': (s) => s.replace('const since = Date.now() - webHrSource.errAt;', 'hr = 0; const since = Date.now() - webHrSource.errAt;'),
    'j5-no-limit': (s) => s.replace('if (since < 0 || since >= 60000) {', 'if (true) {'),
    'j5-no-missing-line': (s) => s.replace("window.HRMLog.event('hr_source missing'", "window.HRMLog.event('hr_source'"),
    'j5-native-too': (s) => s.replace('engineRmssd === undefined && webHrSource.policy', 'webHrSource.policy'),
    'j5-after-currentHR': (s) => { const b = blockText(s); const t = s.replace(b, ''); return t.replace(/( {4}state\.currentHR = hr;\r?\n)/, (m) => m + b); },
  };
  for (const [name, fn] of Object.entries(J5M)) {
    n++;
    const m = fn(page);
    const f = m === page ? ['mutation did not apply'] : j5Fails(m);
    const ok = f.length && m !== page;
    console.log((ok ? '  PASS  mutant ' + name + ' FAILED: ' + f[0] : '  FAIL  mutant ' + name + (m === page ? ' did not apply' : ' SURVIVED')));
    if (!ok) survived++;
  }
  check('every mutant FAILS (' + n + ')', survived === 0, survived + ' survived');
}

console.log(failures ? '\n' + failures + ' check(s) failed' : '\nhr-source parity: all checks pass');
process.exit(failures ? 1 : 0);
