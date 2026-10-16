#!/usr/bin/env node
// PARITY CRITICAL (S54): compiles HrSourcePolicy.java, a decoder cut by text from GattHrDevice.java and
// scripts/jvm/HrSourcePolicyTest.java with plain JDK 21, runs the shared vectors, then reruns against mutated
// copies, each of which must FAIL. Also holds the HrEngine wiring text checks W1 to W8, each with a text mutant
// that must FAIL it (HrEngine does not compile on plain JDK; it is read with comments and strings blanked), and E1:
// the onHr try/catch block cut from HrEngine and run against a policy that throws.
// Run: node scripts/jvm/run-hr-source-test.cjs   (exit 0 = real run passes AND every mutant fails). About 10 s.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const SRC = path.join(ROOT, 'mobile', 'android-overlay', 'app', 'src', 'main', 'java', 'com', 'nakauri', 'hrmonitor');
const VEC = path.join(ROOT, 'scripts', 'fixtures', 'hr-source-vectors.txt');
const GOLD = path.join(ROOT, 'scripts', 'fixtures', 'hr-source-golden.txt');
const BASE = '4a37e40';
const JDK = process.env.JAVA_HOME || 'C:\\Program Files\\Eclipse Adoptium\\jdk-21.0.10.7-hotspot';
const bin = (n) => path.join(JDK, 'bin', n + (process.platform === 'win32' ? '.exe' : ''));
const read = (f) => fs.readFileSync(f, 'utf8').replace(/\r\n/g, '\n');

// Brace-matched text starting at the first match of sigRe (comments and strings skipped).
function cutBlock(src, sigRe) {
  const code = codeView(src);
  const m = new RegExp(sigRe).exec(code);
  if (!m) return null;
  const open = code.indexOf('{', m.index);
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    if (code[i] === '{') depth++;
    else if (code[i] === '}' && --depth === 0) return { start: m.index, open, end: i, text: src.slice(m.index, i + 1) };
  }
  return null;
}
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

function decoderSource(gatt) {
  const cls = cutBlock(gatt, 'private static class HrParse \\{');
  const fn = cutBlock(gatt, 'private static HrParse parseHrPacket\\(byte\\[\\] b\\) \\{');
  if (!cls || !fn) return null;
  return 'package com.nakauri.hrmonitor;\n\nimport java.util.ArrayList;\nimport java.util.List;\n\n' +
    '// Cut by run-hr-source-test.cjs from GattHrDevice.java; do not edit.\npublic final class HrDecode {\n    ' +
    cls.text + '\n\n    ' + fn.text + '\n\n' +
    '    public static int decodeHr(byte[] b) { return parseHrPacket(b).hr; }\n' +
    '    public static int[] decodeRr(byte[] b) { int[] r = parseHrPacket(b).rrMs; return r == null ? new int[0] : r; }\n}\n';
}

const MUTANTS = {
  'no-hysteresis': ['policy', [['static final int EXIT_BPM = 5;', 'static final int EXIT_BPM = 12;'], ['static final long EXIT_HOLD_MS = 10000L;', 'static final long EXIT_HOLD_MS = 0L;']]],
  'no-hold': ['policy', [['static final long ENTER_HOLD_MS = 5000L;', 'static final long ENTER_HOLD_MS = 0L;']]],
  'no-start-hold': ['policy', [['static final long START_HOLD_MS = 2000L;', 'static final long START_HOLD_MS = 5000L;']]],
  'no-split': ['policy', [['static final int MULT_MAX = 4;', 'static final int MULT_MAX = 1;']]],
  'no-stale': ['policy', [['static final long STALE_MS = 5000L;', 'static final long STALE_MS = Long.MAX_VALUE / 4;']]],
  'no-gap-run': ['policy', [['static final long RUN_GAP_MS = 10000L;', 'static final long RUN_GAP_MS = Long.MAX_VALUE / 4;']]],
  'link-ignored': ['policy', [['public synchronized void linkLive() { pending = true; }', 'public synchronized void linkLive() { }']]],
  'reset-ignored': ['policy', [['public synchronized void reset() { pending = true; lastTs = NONE; }', 'public synchronized void reset() { }']]],
  'window-8s': ['policy', [['static final long WINDOW_MS = 5000L;', 'static final long WINDOW_MS = 8000L;']]],
  'truncate': ['policy', [['(int) Math.round(has ? est : lastGood)', '(int) (has ? est : lastGood)']]],
  'min-kept-2': ['policy', [['static final int MIN_KEPT = 4;', 'static final int MIN_KEPT = 2;']]],
  'no-prerun-drop': ['policy', [['times[j] < runStart ? EMPTY : repair(rrMs[j], modeRef(hist))', 'repair(rrMs[j], modeRef(hist))']]],
  'no-start-gate': ['policy', [['static final double START_CLEAN_SHARE = 0.75;', 'static final double START_CLEAN_SHARE = 0.0;']]],
  'no-steady-gate': ['policy', [['static final double STEADY_PLAIN_SHARE = 0.8;', 'static final double STEADY_PLAIN_SHARE = 0.0;']]],
  'no-half-block': ['policy', [['static final double HALF_TOL = 0.1;', 'static final double HALF_TOL = -1.0;']]],
  'steady-gate-counts-splits': ['policy', [['(inStart ? kept : plain)', 'kept']]],
  'start-gate-plain': ['policy', [['(inStart ? kept : plain)', 'plain']]],
  'writes-rr': ['policy', [['hist.addLast(rrMs[j]);', 'hist.addLast(rrMs[j]); rrMs[j] = 1000;']]],
  'no-switched-in': ['policy', [['{ beat = true; underSince = NONE; switched = 1; }', '{ beat = true; underSince = NONE; }']]],
  'no-switched-out': ['policy', [['if (ts - underSince >= EXIT_HOLD_MS) { beat = false; overSince = NONE; switched = -1; }', 'if (ts - underSince >= EXIT_HOLD_MS) { beat = false; overSince = NONE; }']]],
  'newrun-false': ['policy', [['return new Result(shown, beat, switched, est, newRun);', 'return new Result(shown, beat, switched, est, false);']]],
  'decode-int': ['decoder', [['raw * 1000.0 / 1024.0', 'raw * 1000 / 1024']]],
};

function run(mutant) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'hrsrcjvm-'));
  try {
    const pkg = path.join(work, 'src', 'com', 'nakauri', 'hrmonitor');
    const outDir = path.join(work, 'out');
    fs.mkdirSync(pkg, { recursive: true });
    fs.mkdirSync(outDir);
    const files = { policy: read(path.join(SRC, 'HrSourcePolicy.java')), decoder: decoderSource(read(path.join(SRC, 'GattHrDevice.java'))) };
    if (!files.decoder) return { ok: false, out: 'decoder cut failed: HrParse or parseHrPacket not found in GattHrDevice.java', anchorMissing: true };
    if (mutant) {
      const [which, edits] = mutant;
      for (const [from, to] of edits) {
        if (files[which].split(from).length !== 2) return { ok: false, out: 'mutation anchor not found once: ' + from, anchorMissing: true };
        files[which] = files[which].replace(from, to);
      }
    }
    fs.writeFileSync(path.join(pkg, 'HrSourcePolicy.java'), files.policy);
    fs.writeFileSync(path.join(pkg, 'HrDecode.java'), files.decoder);
    const c = spawnSync(bin('javac'), ['-encoding', 'UTF-8', '-nowarn', '-d', outDir, path.join(pkg, 'HrSourcePolicy.java'), path.join(pkg, 'HrDecode.java'), path.join(__dirname, 'HrSourcePolicyTest.java')], { encoding: 'utf8' });
    if (c.status !== 0) return { ok: false, out: 'javac failed:\n' + c.stdout + c.stderr, compileFail: true };
    const r = spawnSync(bin('java'), ['-cp', outDir, 'HrSourcePolicyTest', VEC, GOLD], { encoding: 'utf8', timeout: 60000 });
    return { ok: r.status === 0, out: (r.stdout || '') + (r.stderr || '') };
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

let bad = 0;
const real = run(null);
process.stdout.write(real.out);
console.log('REAL  ' + (real.ok ? 'PASS' : 'FAIL'));
if (!real.ok) bad++;
for (const [name, m] of Object.entries(MUTANTS)) {
  const r = run(m);
  const fails = r.out.split('\n').filter((l) => l.startsWith('FAIL')).map((l) => l.trim());
  const caught = !r.ok && !r.anchorMissing && !r.compileFail;
  const named = fails.filter((l) => !l.includes(' golden '));
  const where = [...new Set(named.map((l) => (/ J[246] /.test(l) ? l.match(/ (J[246]) /)[1] : l.split(' ')[1])))];
  console.log('MUTANT ' + name + ': ' + (caught ? 'FAILED as required' : 'NOT CAUGHT') +
    (caught ? '  (' + (where.length ? 'fails ' + where.join(', ') : 'golden only') + ')' : '  ' + r.out.split('\n')[0]));
  if (!caught) bad++;
}

// ---- HrEngine wiring text checks -------------------------------------------
const engineRaw = read(path.join(SRC, 'HrEngine.java'));
const policyRaw = read(path.join(SRC, 'HrSourcePolicy.java'));
let baseEngine = null;
try { baseEngine = execFileSync('git', ['-C', ROOT, 'show', BASE + ':mobile/android-overlay/app/src/main/java/com/nakauri/hrmonitor/HrEngine.java'], { encoding: 'utf8', maxBuffer: 64 << 20 }).replace(/\r\n/g, '\n'); } catch (e) { baseEngine = null; }
const method = (src, name) => cutBlock(src, 'public (?:synchronized )?(?:void|boolean|\\w+) ' + name + '\\s*\\(');
const methodCode = (src, name) => { const m = method(src, name); return m ? codeView(m.text) : null; };
const count = (s, needle) => s.split(needle).length - 1;

const W = {
  W1(e) {
    const f = [];
    const code = codeView(e), onHr = methodCode(e, 'onHr');
    if (!onHr) return ['onHr not found'];
    if (count(code, 'hrSource.onPacket(') !== 1) f.push('hrSource.onPacket( occurs ' + count(code, 'hrSource.onPacket(') + ' times in the file');
    const ci = onHr.indexOf('hrSource.onPacket('), li = onHr.indexOf('lastHrValue = hr;'), si = onHr.indexOf('hr = pick.shownHr;');
    if (ci < 0) f.push('onPacket not inside onHr');
    if (li < 0 || ci > li) f.push('onPacket not before lastHrValue = hr;');
    if (si < 0 || si < ci || si > li) f.push('hr = pick.shownHr; does not follow the call');
    return f;
  },
  W2(e) {
    const f = [];
    const s = methodCode(e, 'startSessionInternal'), l = methodCode(e, 'onStreamsLive'), code = codeView(e);
    if (!s || !s.includes('hrSource.reset();')) f.push('hrSource.reset(); not inside startSessionInternal');
    if (!l || !l.includes('hrSource.linkLive();')) f.push('hrSource.linkLive(); not inside onStreamsLive');
    if (count(code, 'hrSource.reset();') !== 1 || count(code, 'hrSource.linkLive();') !== 1) f.push('reset or linkLive called elsewhere');
    return f;
  },
  W3(e) {
    const f = [];
    const onHr = methodCode(e, 'onHr');
    if (!onHr) return ['onHr not found'];
    if (/(^|[^\w$.])rrMs\s*=(?!=)/.test(onHr)) f.push('rrMs assigned in onHr');
    const loops = [...onHr.matchAll(/for \(int rr : (\w+)\)/g)].map((m) => m[1]);
    if (loops.some((n) => n !== 'rrMs')) f.push('an RR loop iterates ' + loops.find((n) => n !== 'rrMs'));
    for (const needle of ['for (int rr : rrMs) rrWindow.addLast(', 'for (int rr : rrMs) rrWindow5min.addLast(']) if (!onHr.includes(needle)) f.push('missing ' + needle);
    const wi = onHr.indexOf('sdnnFullCount++');
    if (wi < 0 || onHr.lastIndexOf('for (int rr : rrMs) {', wi) < 0) f.push('Welford loop does not iterate rrMs');
    const lb = onHr.indexOf('synchronized (liveBuffer)'), la = onHr.indexOf('liveBuffer.addLast(');
    if (lb < 0 || la < 0 || !onHr.slice(lb, la).includes('for (int rr : rrMs)')) f.push('liveBuffer loop does not iterate rrMs');
    if (baseEngine) {
      const lines = (s) => s.split('\n').filter((x) => x.includes('computeRmssd(rrWindow)') || x.includes('computeSdnn(')).map((x) => x.trim()).join('\n');
      const b = methodCode(baseEngine, 'onHr');
      if (!lines(onHr) || lines(onHr) !== lines(b)) f.push('computeRmssd or computeSdnn calls changed from base');
    } else f.push('base ' + BASE + ' not readable');
    return f;
  },
  W5(e) {
    const onHr = methodCode(e, 'onHr');
    if (!onHr) return ['onHr not found'];
    const a = onHr.indexOf('writer.appendHr('), s = onHr.indexOf('if (pick.beat) writer.appendStrapHr(strapHr, now);');
    const f = [];
    if (s < 0) f.push('appendStrapHr not guarded by pick.beat');
    if (a < 0 || s < a) f.push('appendStrapHr does not follow appendHr');
    if (count(onHr, 'appendStrapHr(') !== 1) f.push('appendStrapHr called ' + count(onHr, 'appendStrapHr(') + ' times');
    const lk = onHr.indexOf('synchronized (writer) {');
    const lb = lk < 0 ? null : cutBlock(onHr.slice(lk), 'synchronized \\(writer\\) \\{');
    const le = lb ? lk + lb.end : -1;
    if (lk < 0 || !(a > lk && a < le && s > lk && s < le)) f.push('appendHr and appendStrapHr are not under one synchronized (writer) hold');
    return f;
  },
  W6(e, p) {
    const f = [];
    const code = codeView(p);
    if (/import\s+android\./.test(code) || /\bandroid\./.test(code)) f.push('HrSourcePolicy references android.');
    for (const m of code.matchAll(/^\s*((?:public|protected|static|final|synchronized|\s)*)(int\[\]|(?:java\.util\.)?List<[^>]*>|(?:java\.util\.)?(?:Collection|Deque|ArrayDeque|Iterable)<[^>]*>)\s+(\w+)\s*\(/gm)) {
      if (!/private/.test(m[1])) f.push('method ' + m[3] + ' returns ' + m[2]);
    }
    const res = cutBlock(p, 'public static final class Result \\{');
    if (!res) f.push('Result not found');
    else {
      const fields = [...codeView(res.text).matchAll(/^\s*(?:public|protected|private)?\s*(?:final\s+)?[\w\[\]<>]+\s+(\w+)\s*;/gm)].map((m) => m[1]).sort();
      if (JSON.stringify(fields) !== JSON.stringify(['beat', 'beatHr', 'newRun', 'shownHr', 'switched'])) f.push('Result fields ' + fields.join(','));
    }
    return f;
  },
  W7(e) {
    const onHr = methodCode(e, 'onHr');
    if (!onHr) return ['onHr not found'];
    const f = [];
    const n = (onHr.match(/\bstrapHr\b/g) || []).length;
    if (n !== 6) f.push('strapHr occurs ' + n + ' times in onHr');
    for (const needle of ['final int strapHr = hr;', 'hrSource.onPacket(strapHr', 'HrSourcePolicy.Result.strap(strapHr)', 'appendStrapHr(strapHr, now)']) if (!onHr.includes(needle)) f.push('missing ' + needle);
    if ((onHr.match(/\+ strapHr \+/g) || []).length !== 2) f.push('strapHr is not in both hr_source log lines');
    const surfaces = [/publishTick\(hr,/, /overlay\.onHrUpdate\(hr,/, /trendHrBuffer\.addLast\(new double\[\] \{ now, hr \}\)/, /writer\.appendHr\(\s*hr,/, /putSafe\(new JSONObject\(\), "\s*", hr\)/];
    for (const re of surfaces) if (!re.test(onHr)) f.push('surface call does not pass hr: ' + re.source);
    return f;
  },
  W8(e) {
    const onHr = methodCode(e, 'onHr');
    if (!onHr) return ['onHr not found'];
    const f = [];
    const tr = onHr.indexOf('try {'), ci = onHr.indexOf('pick = hrSource.onPacket(strapHr, rrMs, now);'), ca = onHr.indexOf('} catch (Throwable t) {');
    if (tr < 0 || ci < tr || ca < ci) f.push('onPacket is not inside try with a catch (Throwable t)');
    const body = ca < 0 ? '' : onHr.slice(ca, onHr.indexOf('hr = pick.shownHr;'));
    if (!body.includes('pick = HrSourcePolicy.Result.strap(strapHr);')) f.push('the catch does not fall back to the strap byte');
    if (!/if \(hrSource\.errorLogDue\(now\)\) NativeHrService\.logLifecycle\(appCtx,/.test(body)) f.push('the error line is not rate-limited by errorLogDue');
    const wb = onHr.indexOf('wasBeat = hrSource.isBeat();');
    if (!/if \(pick\.newRun && wasBeat\) NativeHrService\.logLifecycle\(appCtx,/.test(onHr) || wb < 0 || wb > ci) f.push('a run restart on beats logs no to=strap line');
    return f;
  },
};
const WMUT = {
  W1: ['engine', '        hr = pick.shownHr;\n', ''],
  W2: ['engine', '            hrSource.reset();\n', ''],
  W3: ['engine', 'for (int rr : rrMs) rrWindow.addLast', 'for (int rr : rrMsShown) rrWindow.addLast'],
  W5: ['engine', 'if (pick.beat) writer.appendStrapHr(strapHr, now);', 'writer.appendStrapHr(strapHr, now);'],
  W6: ['policy', '        public final boolean newRun; // this packet started a run\n', '        public final boolean newRun; // this packet started a run\n        public int[] rr;\n'],
  W7: ['engine', 'publishTick(hr,', 'publishTick(strapHr,'],
  W8: ['engine', '            pick = HrSourcePolicy.Result.strap(strapHr);\n', '            throw t;\n'],
};
// W5 has a second mutant: the two rows written outside one hold.
const W5_UNLOCKED = ['            synchronized (writer) {\n', '            {\n'];
console.log('\nHrEngine wiring (comments and strings blanked):');
for (const [name, fn] of Object.entries(W)) {
  const real = fn(engineRaw, policyRaw);
  console.log((real.length ? 'FAIL ' : 'PASS ') + name + (real.length ? ': ' + real.join('; ') : ''));
  if (real.length) bad++;
  const [which, from, to] = WMUT[name];
  const src = which === 'engine' ? engineRaw : policyRaw;
  if (count(src, from) !== 1) { console.log('MUTANT ' + name + ': NOT CAUGHT  anchor not found once: ' + from.trim()); bad++; continue; }
  const m = src.replace(from, to);
  const mf = which === 'engine' ? fn(m, policyRaw) : fn(engineRaw, m);
  console.log('MUTANT ' + name + ': ' + (mf.length ? 'FAILED as required  (' + mf[0] + ')' : 'NOT CAUGHT'));
  if (!mf.length) bad++;
}

{
  const m = engineRaw.replace(W5_UNLOCKED[0], W5_UNLOCKED[1]);
  const mf = count(engineRaw, W5_UNLOCKED[0]) === 1 ? W.W5(m, policyRaw) : [];
  console.log('MUTANT W5-unlocked: ' + (mf.length ? 'FAILED as required  (' + mf[0] + ')' : 'NOT CAUGHT'));
  if (!mf.length) bad++;
}

// ---- E1: the onHr fallback, run for real with a policy that throws ----------------
// The try/catch block is cut from HrEngine.onHr and compiled into a harness with a throwing stand-in policy.
function fallbackRun(engineText) {
  const onHr = method(engineText, 'onHr');
  if (!onHr) return { ok: false, out: 'onHr not found' };
  const t = onHr.text, a = t.indexOf('boolean wasBeat = false;'), c = t.indexOf('} catch (Throwable t) {');
  if (a < 0 || c < 0) return { ok: false, out: 'fallback block not found' };
  const cb = cutBlock(t.slice(c + 2), 'catch \\(Throwable t\\) \\{');
  if (!cb) return { ok: false, out: 'catch block not found' };
  const block = t.slice(a, c + 2 + cb.end + 1);
  const src = [
    'package com.nakauri.hrmonitor;',
    'import java.util.ArrayList;',
    'import java.util.List;',
    'final class NativeHrService { static final List<String> LOG = new ArrayList<>(); static void logLifecycle(Object ctx, String e) { LOG.add(e); } }',
    'public final class FallbackHarness {',
    '  interface Pol { boolean isBeat(); HrSourcePolicy.Result onPacket(int s, int[] rr, long t); boolean errorLogDue(long t); }',
    '  static final Object appCtx = new Object();',
    '  static HrSourcePolicy.Result step(Pol hrSource, int strapHr, int[] rrMs, long now) {',
    block,
    '    return pick;',
    '  }',
    '  static int fails = 0;',
    '  static void check(String n, boolean ok) { System.out.println((ok ? "OK    " : "FAIL  ") + n); if (!ok) fails++; }',
    '  public static void main(String[] a) {',
    '    final HrSourcePolicy limiter = new HrSourcePolicy();',
    '    Pol thrower = new Pol() { public boolean isBeat() { return false; } public HrSourcePolicy.Result onPacket(int s, int[] rr, long t) { throw new IllegalStateException("boom"); } public boolean errorLogDue(long t) { return limiter.errorLogDue(t); } };',
    '    HrSourcePolicy.Result r = step(thrower, 97, new int[] { 600 }, 1000L);',
    '    check("E1 a throwing policy shows the strap byte", r.shownHr == 97 && !r.beat && r.switched == 0 && Double.isNaN(r.beatHr) && !r.newRun);',
    '    check("E1 one hr_source error line", NativeHrService.LOG.size() == 1 && NativeHrService.LOG.get(0).equals("hr_source error IllegalStateException"));',
    '    for (long t = 2000L; t < 61000L; t += 1000L) step(thrower, 98, null, t);',
    '    check("E1 rate-limited: still one line after 59 more throws inside 60 s", NativeHrService.LOG.size() == 1);',
    '    r = step(thrower, 99, null, 61000L);',
    '    check("E1 a second line once 60 s have passed", NativeHrService.LOG.size() == 2 && r.shownHr == 99);',
    '    final HrSourcePolicy real = new HrSourcePolicy();',
    '    Pol ok = new Pol() { public boolean isBeat() { return real.isBeat(); } public HrSourcePolicy.Result onPacket(int s, int[] rr, long t) { return real.onPacket(s, rr, t); } public boolean errorLogDue(long t) { return real.errorLogDue(t); } };',
    '    r = step(ok, 80, new int[] { 750 }, 100000L);',
    '    check("E1 a working policy passes its result through", r.shownHr == 80 && r.newRun && NativeHrService.LOG.size() == 2);',
    '    System.exit(fails == 0 ? 0 : 1);',
    '  }',
    '}',
  ].join('\n') + '\n';
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'hrsrcfb-'));
  try {
    const pkg = path.join(work, 'src', 'com', 'nakauri', 'hrmonitor'), out = path.join(work, 'out');
    fs.mkdirSync(pkg, { recursive: true }); fs.mkdirSync(out);
    fs.writeFileSync(path.join(pkg, 'HrSourcePolicy.java'), policyRaw);
    fs.writeFileSync(path.join(pkg, 'FallbackHarness.java'), src);
    const cc = spawnSync(bin('javac'), ['-encoding', 'UTF-8', '-nowarn', '-d', out, path.join(pkg, 'HrSourcePolicy.java'), path.join(pkg, 'FallbackHarness.java')], { encoding: 'utf8' });
    if (cc.status !== 0) return { ok: false, out: 'javac failed: ' + (cc.stdout + cc.stderr).split('\n').slice(0, 3).join(' | ') };
    const r = spawnSync(bin('java'), ['-cp', out, 'com.nakauri.hrmonitor.FallbackHarness'], { encoding: 'utf8', timeout: 30000 });
    return { ok: r.status === 0, out: (r.stdout || '') + (r.stderr || '') };
  } finally { fs.rmSync(work, { recursive: true, force: true }); }
}
console.log('\nE1 fallback (onHr try/catch cut from HrEngine, policy that throws):');
{
  const r = fallbackRun(engineRaw);
  process.stdout.write(r.out.endsWith('\n') ? r.out : r.out + '\n');
  console.log('E1 ' + (r.ok ? 'PASS' : 'FAIL'));
  if (!r.ok) bad++;
  const E1MUT = {
    'E1-rethrow': ['            pick = HrSourcePolicy.Result.strap(strapHr);\n', '            if (t != null) throw new RuntimeException(t);\n            pick = HrSourcePolicy.Result.strap(strapHr);\n'],
    'E1-no-limit': ['if (hrSource.errorLogDue(now)) NativeHrService', 'NativeHrService'],
  };
  for (const [n, [from, to]] of Object.entries(E1MUT)) {
    if (count(engineRaw, from) !== 1) { console.log('MUTANT ' + n + ': NOT CAUGHT  anchor not found once'); bad++; continue; }
    const m = fallbackRun(engineRaw.replace(from, to));
    const fl = m.out.split('\n').filter((l) => l.startsWith('FAIL') || l.includes('Exception'));
    console.log('MUTANT ' + n + ': ' + (!m.ok ? 'FAILED as required  (' + (fl[0] || m.out.split('\n')[0]).trim() + ')' : 'NOT CAUGHT'));
    if (m.ok) bad++;
  }
}

if (bad) {
  console.error('\n' + bad + ' problem(s): the real run and wiring checks must pass and every mutant must fail.');
  process.exit(1);
}
console.log('\nHrSourcePolicyTest and wiring checks pass; all ' + (Object.keys(MUTANTS).length + Object.keys(WMUT).length + 3) + ' negative controls fail.');
