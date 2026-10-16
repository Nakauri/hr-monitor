#!/usr/bin/env node
// Guards: services, receivers or the PDF path reaching engine state they must not touch. Files: HrEngine and its callers, SymptomReceiver, PdfPrinter. Runtime: under 1 s.
// [S56] also guards: the restore overlay shown on a resume with no stop, which the page never hides (stuck "Restoring session" after a short screen-off, 2026-10-15 21:49). Files: MainActivity, lifecycle-state.js. Negative controls: overlay-resume-mutants.cjs.
// Engine boundary test: reads the native Java as text, no JVM.
// Guards three bugs: the C3 orphan neutralize on Activity recreate, a
// sessionActive seeded outside start/stop (skips strap reconnection after a
// real process death), and markBrokenForRestart run on attach (breaks a live
// resumable upload).
// Engine step 2 adds: a coherence check (the Service resume set lands whole or not at all), then,
// once that set is present, the resume, lock, notification-text and test-switch checks.
// Run: node scripts/engine-boundary.test.cjs                 (exit 0 = OK)
//      node scripts/engine-boundary.test.cjs --legacy        (reads 7aae996; must FAIL)
//      node scripts/engine-boundary.test.cjs --rev=<sha>     (reads that commit)
//      node scripts/engine-boundary.test.cjs --root=<dir>    (reads a copied tree: <dir>/<repo path>)
//      add --force-present to enforce the step 2 checks whatever coherence reads

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const REL = 'mobile/android-overlay/app/src/main/java/com/nakauri/hrmonitor/';
const argVal = (k) => { const a = process.argv.find(x => x.startsWith(k + '=')); return a ? a.slice(k.length + 1) : null; };
const LEGACY = process.argv.includes('--legacy');
const LEGACY_REV = '7aae996';
const REV = LEGACY ? LEGACY_REV : argVal('--rev');
const TREE = argVal('--root');
const FORCE_PRESENT = process.argv.includes('--force-present');

let failures = 0;
function check(name, ok, detail) {
  console.log((ok ? 'OK    ' : 'FAIL  ') + name + (detail ? '  ' + detail : ''));
  if (!ok) failures++;
}

// Any repo file, from the working tree, a commit, or a copied tree.
function readRepo(rel) {
  if (REV) {
    try {
      return execSync('git show ' + REV + ':' + rel,
        { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 });
    } catch (e) {
      return null;
    }
  }
  const p = path.join(TREE ? path.resolve(TREE) : ROOT, rel);
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
}

function readSource(file) { return readRepo(REL + file); }

// Same-length copy with comments and string/char literals blanked, so braces
// and identifiers inside them never count. Offsets match the raw text.
function codeView(src) {
  const out = src.split('');
  let i = 0;
  const n = src.length;
  const blank = (a, b) => { for (let k = a; k < b; k++) if (out[k] !== '\n') out[k] = ' '; };
  while (i < n) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') {
      let j = src.indexOf('\n', i); if (j < 0) j = n;
      blank(i, j); i = j; continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      let j = src.indexOf('*/', i + 2); j = j < 0 ? n : j + 2;
      blank(i, j); i = j; continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n && src[j] !== c) j += src[j] === '\\' ? 2 : 1;
      blank(i + 1, j); i = j + 1; continue;
    }
    i++;
  }
  return out.join('');
}

// Span [open, close] of the brace block starting at the first '{' at or after `from`.
function blockFrom(code, from) {
  const open = code.indexOf('{', from);
  if (open < 0) return null;
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    if (code[i] === '{') depth++;
    else if (code[i] === '}' && --depth === 0) return [open, i];
  }
  return null;
}

// Body spans of every method whose signature matches `sigRe` (a regex source ending before '(').
function methodSpans(code, sigRe) {
  const re = new RegExp(sigRe + '\\s*\\([^)]*\\)[^{;]*\\{', 'g');
  const spans = [];
  let m;
  while ((m = re.exec(code))) {
    const b = blockFrom(code, m.index + m[0].length - 1);
    if (b) spans.push(b);
  }
  return spans;
}

function indexesOf(code, needle) {
  const out = [];
  let i = code.indexOf(needle);
  while (i >= 0) { out.push(i); i = code.indexOf(needle, i + 1); }
  return out;
}

function lineOf(src, idx) { return src.slice(0, idx).split('\n').length; }

const inside = (idx, spans) => spans.some(([a, b]) => idx > a && idx < b);

// ---- Load sources -------------------------------------------------------
if (REV) console.log('Reading commit ' + REV + '\n');
else if (TREE) console.log('Reading tree ' + path.resolve(TREE) + '\n');
const ENGINE_FILES = ['HrEngine.java', 'HrDevice.java', 'HrSink.java', 'GattHrDevice.java', 'BleScanner.java'];
const src = {};
for (const f of ENGINE_FILES.concat(['NativeHrSessionPlugin.java'])) {
  src[f] = readSource(f);
  check(f + ' exists', src[f] != null);
}

// ---- Engine side has no Capacitor types ---------------------------------
for (const f of ENGINE_FILES) {
  if (src[f] == null) continue;
  const code = codeView(src[f]);
  check(f + ' has no com.getcapacitor', !code.includes('com.getcapacitor'));
  check(f + ' has no PluginCall', !/\bPluginCall\b/.test(code));
}

// ---- Plugin is a thin bridge --------------------------------------------
const plugin = src['NativeHrSessionPlugin.java'];
if (plugin != null) {
  const pcode = codeView(plugin);
  for (const banned of ['BluetoothGatt', 'WebSocket', 'NativeCsvWriter', 'neutralizeOrphan']) {
    const at = plugin.indexOf(banned);
    check('plugin has no ' + banned, at < 0, at >= 0 ? 'present at :' + lineOf(plugin, at) : '');
  }

  const load = methodSpans(pcode, 'public\\s+void\\s+load')[0];
  check('plugin load() found', !!load);
  if (load) {
    const body = pcode.slice(load[0], load[1]);
    check('load() obtains the engine with HrEngine.obtain', /HrEngine\.obtain\s*\(/.test(body));
    check('load() installs the listener', /\.setListener\s*\(/.test(body));
    const mb = body.indexOf('markBrokenForRestart');
    check('load() never marks the resumable upload broken', mb < 0,
      mb >= 0 ? 'markBrokenForRestart at :' + lineOf(plugin, load[0] + mb) : '');
    check('load() never neutralizes', !/neutraliz/i.test(body));
  }
  check('plugin never calls markBrokenForRestart', !pcode.includes('markBrokenForRestart'));

  const destroy = methodSpans(pcode, 'void\\s+handleOnDestroy')[0];
  check('plugin handleOnDestroy() found', !!destroy);
  if (destroy) {
    const body = pcode.slice(destroy[0] + 1, destroy[1]);
    const receivers = ['engine'];
    let m;
    const aliasRe = /HrEngine\s+(\w+)\s*=\s*engine\s*;/g;
    while ((m = aliasRe.exec(body))) receivers.push(m[1]);
    const engineCalls = [];
    const callRe = new RegExp('\\b(' + receivers.join('|') + ')\\s*\\.\\s*(\\w+)\\s*\\(', 'g');
    while ((m = callRe.exec(body))) engineCalls.push(m[2]);
    check('handleOnDestroy calls exactly one engine method, clearListener',
      engineCalls.length === 1 && engineCalls[0] === 'clearListener', 'calls: [' + engineCalls.join(', ') + ']');
    check('handleOnDestroy null-checks the engine',
      new RegExp('\\b(' + receivers.join('|') + ')\\s*[!=]=\\s*null').test(body));
    check('handleOnDestroy names no HrEngine static', !/HrEngine\s*\./.test(body));
    const allowed = new Set(['clearListener', 'logLifecycle', 'getContext', 'shutdown', 'handleOnDestroy',
      'if', 'synchronized', 'catch']);
    const others = [];
    const anyCall = /\b(\w+)\s*\(/g;
    while ((m = anyCall.exec(body))) if (!allowed.has(m[1])) others.push(m[1]);
    check('handleOnDestroy touches nothing else', others.length === 0, others.length ? 'calls: ' + others.join(', ') : '');
    // The one allowed static write: releasing this plugin's own `instance` hold.
    const rawBody = plugin.slice(destroy[0] + 1, destroy[1]);
    const instLines = rawBody.split('\n').map(l => l.trim()).filter(l => /\binstance\b/.test(codeView(l)));
    check('handleOnDestroy touches instance only as `if (instance == this) instance = null;`',
      instLines.every(l => l === 'if (instance == this) instance = null;'), instLines.join(' | '));
    const fields = (body.match(/\b\w*[Ee]xecutor\b/g) || []).filter(x => x !== 'authExecutor' && x !== 'exportExecutor');
    check('handleOnDestroy shuts down only the auth and export executors', fields.length === 0, fields.join(', '));
  }

  // R2: every delegating wrapper rejects engine_unavailable when the engine is null.
  const guard = methodSpans(pcode, 'HrEngine\\s+engineOrReject')[0];
  const guardOk = !!guard && plugin.slice(guard[0], guard[1]).includes('"engine_unavailable"');
  check('engineOrReject rejects engine_unavailable', guardOk);
  const pmRe = /@PluginMethod[\s\S]*?public\s+void\s+(\w+)\s*\(\s*PluginCall\s+\w+\s*\)\s*\{/g;
  let pm;
  const unguarded = [];
  let delegating = 0;
  while ((pm = pmRe.exec(pcode))) {
    const b = blockFrom(pcode, pm.index + pm[0].length - 1);
    const code = pcode.slice(b[0], b[1]);
    const raw = plugin.slice(b[0], b[1]);
    if (!/\bengine\b|engineOrReject/.test(code)) continue;
    delegating++;
    if (!/engineOrReject\s*\(/.test(code) && !raw.includes('"engine_unavailable"')) unguarded.push(pm[1]);
  }
  check('every delegating @PluginMethod guards a null engine', delegating > 0 && unguarded.length === 0,
    delegating + ' delegating' + (unguarded.length ? '; unguarded: ' + unguarded.join(', ') : ''));
}

// ---- Engine session invariants -------------------------------------------
const engine = src['HrEngine.java'];
if (engine != null) {
  const ecode = codeView(engine);
  const startSpans = methodSpans(ecode, '\\bstartSessionInternal');
  const stopSpans = methodSpans(ecode, '\\bstopSessionInternal');
  check('HrEngine startSessionInternal and stopSessionInternal found', startSpans.length === 1 && stopSpans.length === 1);
  const writes = indexesOf(ecode, 'sessionActive.set(').concat(indexesOf(ecode, 'sessionActive.compareAndSet('));
  const stray = writes.filter(i => !inside(i, startSpans.concat(stopSpans)));
  check('sessionActive is written only in startSessionInternal / stopSessionInternal', writes.length > 0 && stray.length === 0,
    stray.map(i => ':' + lineOf(engine, i)).join(' '));

  // A second start never tears down a live session: the active check throws before any state changes.
  if (startSpans.length === 1) {
    const sbody = ecode.slice(startSpans[0][0], startSpans[0][1]);
    const guardAt = sbody.search(/if\s*\(\s*sessionActive\.get\(\)\s*\)/);
    const throwAt = sbody.indexOf('throw new AlreadyActiveException');
    const firstWrite = Math.min(...['sessionGeneration.incrementAndGet', 'closeRelaySocket', 'broadcastKey =', 'sink =']
      .map(s => { const i = sbody.indexOf(s); return i < 0 ? Infinity : i; }));
    check('startSessionInternal rejects an active session before touching state',
      guardAt >= 0 && throwAt > guardAt && throwAt < firstWrite);
  }
  if (plugin != null) {
    const ss = methodSpans(codeView(plugin), 'public\\s+void\\s+startSession')[0];
    check('plugin startSession rejects already_active',
      !!ss && /catch\s*\(\s*HrEngine\.AlreadyActiveException/.test(plugin.slice(ss[0], ss[1]))
        && plugin.slice(ss[0], ss[1]).includes('"already_active"'));
  }

  const ctor = methodSpans(ecode, 'private\\s+HrEngine')[0];
  check('HrEngine constructor found', !!ctor);
  const marks = indexesOf(ecode, 'markBrokenForRestart');
  let marksOk = marks.length > 0 && !!ctor;
  for (const i of marks) {
    if (!ctor || !inside(i, [ctor])) { marksOk = false; continue; }
    // Innermost `if (...)` whose block holds this call must test the live atomic.
    const before = ecode.slice(ctor[0], i);
    let guarded = false;
    const ifRe = /\bif\s*\(/g;
    let m;
    while ((m = ifRe.exec(before))) {
      const condStart = ctor[0] + m.index + m[0].length - 1;
      let depth = 0, condEnd = -1;
      for (let k = condStart; k < ecode.length; k++) {
        if (ecode[k] === '(') depth++;
        else if (ecode[k] === ')' && --depth === 0) { condEnd = k; break; }
      }
      const cond = ecode.slice(condStart, condEnd + 1);
      const after = ecode.slice(condEnd + 1).match(/^\s*/)[0].length + condEnd + 1;
      let span;
      if (ecode[after] === '{') span = blockFrom(ecode, after);
      else span = [after - 1, ecode.indexOf(';', after)];
      if (span && i > span[0] && i < span[1] && /!\s*sessionActive\.get\(\)/.test(cond)) guarded = true;
    }
    if (!guarded) marksOk = false;
  }
  check('markBrokenForRestart only in the constructor, under if (... !sessionActive.get() ...)', marksOk,
    marks.map(i => ':' + lineOf(engine, i)).join(' '));

  const emitSpans = methodSpans(ecode, 'void\\s+emit');
  const calls = indexesOf(ecode, '.onEvent(');
  const strayEv = calls.filter(i => !inside(i, emitSpans));
  check('listener onEvent is called only inside emit()', calls.length === 1 && strayEv.length === 0,
    calls.length + ' call(s)' + (strayEv.length ? ' stray at ' + strayEv.map(i => ':' + lineOf(engine, i)).join(' ') : ''));

  const obtain = methodSpans(ecode, 'static\\s+synchronized\\s+Obtained\\s+obtain')[0];
  check('HrEngine.obtain never reads prefs', !!obtain && !/getSharedPreferences/.test(ecode.slice(obtain[0], obtain[1])));
}

// ---- Engine step 2 -------------------------------------------------------

// Every `if (cond) {block}` (or single statement) in code: {cond: [a, b], end, text}.
function ifStatements(code) {
  const out = [];
  const re = /\bif\s*\(/g;
  let m;
  while ((m = re.exec(code))) {
    const a = m.index + m[0].length - 1;
    let depth = 0, b = -1;
    for (let k = a; k < code.length; k++) {
      if (code[k] === '(') depth++;
      else if (code[k] === ')' && --depth === 0) { b = k; break; }
    }
    if (b < 0) continue;
    const after = b + 1 + code.slice(b + 1).match(/^\s*/)[0].length;
    let end;
    if (code[after] === '{') { const blk = blockFrom(code, after); end = blk ? blk[1] : after; }
    else end = code.indexOf(';', after);
    out.push({ cond: [a, b], end, text: code.slice(a, b + 1) });
  }
  return out;
}

// `synchronized (<expr ending in name>) {...}` block spans.
function syncSpans(code, lockName) {
  const re = new RegExp('synchronized\\s*\\(\\s*(?:[\\w.]+\\.)?' + lockName + '\\s*\\)\\s*\\{', 'g');
  const spans = [];
  let m;
  while ((m = re.exec(code))) {
    const b = blockFrom(code, m.index + m[0].length - 1);
    if (b) spans.push(b);
  }
  return spans;
}

function step2Checks() {
  console.log('\n-- engine step 2 --');
  const S = readSource('NativeHrService.java');
  const R = readSource('HrServiceHeartbeatReceiver.java');
  const W = readSource('SessionResurrectionWorker.java');
  const E = readSource('HrEngine.java');
  const P = readSource('NativeHrSessionPlugin.java');
  const RCV = readSource('SessionRestartReceiver.java');
  const manifests = (readRepo('mobile/scripts/inject-manifest.js') || '')
    + (readRepo('mobile/android-overlay/app/src/main/AndroidManifest.xml') || '');
  const yml = readRepo('.github/workflows/build-android.yml') || '';
  const hooksGradle = readRepo('mobile/android-overlay/app/test-hooks.gradle');

  // Always enforced: the build switch and the event path, both of which land before any step 2 code.
  check('test-hooks.gradle defines TEST_HOOKS from HRM_TEST_HOOKS == "1"',
    !!hooksGradle && /buildConfigField\s+"boolean",\s*"TEST_HOOKS"/.test(hooksGradle)
      && /System\.getenv\("HRM_TEST_HOOKS"\)\s*==\s*"1"/.test(hooksGradle) && /buildConfig\s+true/.test(hooksGradle));
  check('build-android.yml pins HRM_TEST_HOOKS: "0"', /\bHRM_TEST_HOOKS:\s*"0"/.test(yml));
  {
    const lines = yml.split('\n');
    const at = lines.findIndex(l => /test-hooks\.gradle\s*>>\s*mobile\/android\/app\/build\.gradle/.test(l));
    let conditional = true;
    if (at >= 0) {
      let s = at; while (s > 0 && !/^\s*- name:/.test(lines[s])) s--;
      let e = at + 1; while (e < lines.length && !/^\s*- name:/.test(lines[e])) e++;
      conditional = lines.slice(s, e).some(l => /^\s*if:/.test(l));
    }
    check('build-android.yml appends test-hooks.gradle unconditionally', at >= 0 && !conditional,
      at < 0 ? 'no append line' : (conditional ? 'the step has an if:' : ''));
  }
  for (const [f, s] of [['NativeHrService.java', S], ['HrEngine.java', E]]) {
    if (s == null) continue;
    const at = codeView(s).indexOf('BuildConfig.DEBUG');
    check(f + ' never gates on BuildConfig.DEBUG', at < 0, at >= 0 ? 'at :' + lineOf(s, at) : '');
  }
  if (E != null) {
    const ec = codeView(E);
    const emitSpan = methodSpans(ec, 'void\\s+emit')[0];
    let drops = [];
    if (emitSpan) {
      const body = ec.slice(emitSpan[0], emitSpan[1]);
      drops = ifStatements(body).filter(i => /\bname\b/.test(i.text)).map(i => i.text);
      if (/switch\s*\(\s*name\b/.test(body) || /\bname\s*\.\s*equals/.test(body)) drops.push('name compared');
    }
    check('emit() never drops an event by name', !!emitSpan && drops.length === 0, drops.join(' | '));
  }

  // Coherence: the Service resume set is all present or all absent.
  const marks = {
    'EXTRA_ORIGIN in HrServiceHeartbeatReceiver': R != null && codeView(R).includes('EXTRA_ORIGIN'),
    'EXTRA_ORIGIN in SessionResurrectionWorker': W != null && codeView(W).includes('EXTRA_ORIGIN'),
    'SessionRestartReceiver.java': RCV != null,
    'SessionRestartReceiver manifest entry': /android:name="com\.nakauri\.hrmonitor\.SessionRestartReceiver"/.test(manifests)
      && /android\.intent\.action\.MY_PACKAGE_REPLACED/.test(manifests),
    'resumeFromPrefs( in NativeHrService': S != null && codeView(S).includes('resumeFromPrefs('),
  };
  const present = Object.keys(marks).filter(k => marks[k]);
  const absent = Object.keys(marks).filter(k => !marks[k]);
  const coherent = present.length === 0 || absent.length === 0;
  check('coherence: the Service resume set is all present or all absent', coherent,
    coherent ? (present.length ? 'present' : 'absent') : 'present: [' + present.join('; ') + '] absent: [' + absent.join('; ') + ']');
  if (!FORCE_PRESENT && present.length === 0) {
    console.log('INFO  step 2 resume set absent; resume checks not enforced (use --force-present)');
    return;
  }
  if (FORCE_PRESENT) console.log('INFO  --force-present: enforcing the step 2 resume checks');

  // Service start: startForeground first, then obtain and resume; never builds or marks.
  if (S == null) { check('NativeHrService.java exists', false); }
  else {
    const sc = codeView(S);
    const osc = methodSpans(sc, 'public\\s+int\\s+onStartCommand')[0];
    check('NativeHrService.onStartCommand found', !!osc);
    if (osc) {
      const body = sc.slice(osc[0], osc[1]);
      const sf = body.search(/\bstartForeground\s*\(/);
      const ob = body.search(/\bobtain\s*\(/);
      const rs = body.search(/\bresumeFromPrefs\s*\(/);
      const ret = body.search(/\breturn\b/);
      check('onStartCommand: startForeground( precedes obtain( and resumeFromPrefs(',
        sf >= 0 && ob > sf && rs > sf,
        'startForeground ' + (sf >= 0 ? ':' + lineOf(S, osc[0] + sf) : 'missing') + ', obtain '
          + (ob >= 0 ? ':' + lineOf(S, osc[0] + ob) : 'missing') + ', resumeFromPrefs ' + (rs >= 0 ? ':' + lineOf(S, osc[0] + rs) : 'missing'));
      check('onStartCommand: no return before startForeground(', sf >= 0 && (ret < 0 || ret > sf),
        ret >= 0 && ret < sf ? 'return at :' + lineOf(S, osc[0] + ret) : '');
    }
    const nh = sc.search(/new\s+HrEngine\s*\(/);
    check('NativeHrService names no `new HrEngine`', nh < 0, nh >= 0 ? 'at :' + lineOf(S, nh) : '');
    const mb = sc.indexOf('markBrokenForRestart');
    check('NativeHrService never calls markBrokenForRestart', mb < 0, mb >= 0 ? 'at :' + lineOf(S, mb) : '');
    // The stale branch decides under START_LOCK: a synchronized block, or the argument list of
    // HrEngine.GATE.stop(...), whose body runs the probes and branches inside synchronized (lock).
    const locks = syncSpans(sc, 'START_LOCK');
    {
      const re = /\bGATE\s*\.\s*stop\s*\(/g;
      let m;
      while ((m = re.exec(sc))) {
        const open = m.index + m[0].length - 1;
        let depth = 0;
        for (let k = open; k < sc.length; k++) {
          if (sc[k] === '(') depth++;
          else if (sc[k] === ')' && --depth === 0) { locks.push([open, k]); break; }
        }
      }
    }
    const staleCalls = indexesOf(sc, 'commitStaleStopIfCurrent(').filter(i => !/void\s+$/.test(sc.slice(Math.max(0, i - 20), i)));
    const liveReads = indexesOf(sc, 'isSessionActive(');
    const stopStart = sc.search(/ACTION_STOP\s*\.\s*equals\s*\(\s*action\s*\)/);
    const stopReads = stopStart >= 0 ? liveReads.filter(i => i > stopStart && osc && i < osc[1]) : [];
    check('NativeHrService stale branch (live read + commitStaleStopIfCurrent) sits inside synchronized (...START_LOCK)',
      staleCalls.length > 0 && staleCalls.every(i => inside(i, locks)) && stopReads.length > 0 && stopReads.every(i => inside(i, locks)),
      staleCalls.concat(stopReads).filter(i => !inside(i, locks)).map(i => 'outside at :' + lineOf(S, i)).join(' ')
        || (staleCalls.length ? '' : 'no commitStaleStopIfCurrent call'));
  }

  if (E == null) { check('HrEngine.java exists', false); }
  else {
    const ec = codeView(E);
    check('HrEngine declares static final Object START_LOCK', /static\s+final\s+Object\s+START_LOCK\b/.test(ec));
    const resumeSpans = methodSpans(ec, '(?:public|private)\\s+(?:static\\s+)?[\\w<>\\[\\]]+\\s+resume\\w*');
    check('HrEngine.resumeFromPrefs found', /\bresumeFromPrefs\s*\(\s*(?:final\s+)?String\s+\w+\s*\)/.test(ec));
    let bad = [];
    for (const [a, b] of resumeSpans) {
      const body = ec.slice(a, b);
      if (body.includes('markBrokenForRestart')) bad.push('markBrokenForRestart at :' + lineOf(E, a + body.indexOf('markBrokenForRestart')));
      if (body.includes('sessionActive.set(')) bad.push('sessionActive.set( at :' + lineOf(E, a + body.indexOf('sessionActive.set(')));
    }
    check('resume methods never mark broken and never set sessionActive', resumeSpans.length > 0 && bad.length === 0, bad.join(' '));
    const locks = syncSpans(ec, 'START_LOCK');
    const start = methodSpans(ec, '\\bstartSessionInternal')[0];
    if (start) {
      const body = ec.slice(start[0], start[1]);
      const setAt = start[0] + body.indexOf('sessionActive.set(true)');
      const guardAt = start[0] + body.search(/if\s*\(\s*sessionActive\.get\(\)\s*\)/);
      check('startSessionInternal claims (active check + set(true)) inside synchronized (START_LOCK)',
        body.includes('sessionActive.set(true)') && inside(setAt, locks) && guardAt >= start[0] && inside(guardAt, locks));
      const rawBody = E.slice(start[0], start[1]);
      const live = rawBody.indexOf('.putBoolean("sessionActive", true)');
      const commit = live >= 0 ? rawBody.indexOf('.commit()', live) : -1;
      const between = live >= 0 && commit > live ? rawBody.slice(live, commit) : '';
      const fgs = body.search(/\bstartNativeForegroundService\s*\(/);
      check('startSessionInternal commits sessionActive, senderId and broadcastKey in ONE .commit()',
        commit > live && between.includes('"senderId"') && between.includes('"broadcastKey"') && !between.includes('.apply()'));
      check('startSessionInternal starts the FGS after the prefs .commit()', fgs >= 0 && commit >= 0 && fgs > commit,
        'fgs ' + (fgs >= 0 ? ':' + lineOf(E, start[0] + fgs) : 'missing') + ', commit ' + (commit >= 0 ? ':' + lineOf(E, start[0] + commit) : 'missing'));
    }
    const stop = methodSpans(ec, '\\bstopSessionInternal')[0];
    if (stop) {
      const body = ec.slice(stop[0], stop[1]);
      const cas = stop[0] + body.indexOf('sessionActive.compareAndSet(');
      check('stopSessionInternal claims inside synchronized (START_LOCK)', body.includes('sessionActive.compareAndSet(') && inside(cas, locks));
      const raw = E.slice(stop[0], stop[1]);
      const missing = ['test_no_sticky_session', 'test_auto_end_ms', 'test_auto_end_session']
        .filter(k => !new RegExp('\\.remove\\s*\\(\\s*"' + k + '"\\s*\\)').test(raw));
      check('stopSessionInternal clears the three test prefs', missing.length === 0, missing.join(', '));
    }
    const st = methodSpans(ec, 'public\\s+JSONObject\\s+statusJson')[0];
    check('statusJson reads sessionActive under START_LOCK', !!st
      && indexesOf(ec, 'sessionActive.get()').filter(i => i > st[0] && i < st[1]).some(i => inside(i, locks)));
    const gate = /\bGATE\s*=\s*new\s+SessionGate\s*\(\s*START_LOCK\s*\)/.test(ec);
    check('HrEngine builds its SessionGate on START_LOCK', gate);
    const rf = methodSpans(ec, 'public\\s+JSONObject\\s+resumeFromPrefs')[0];
    check('resumeFromPrefs claims through GATE.resume', !!rf && /\bGATE\s*\.\s*resume\s*\(/.test(ec.slice(rf[0], rf[1])));
  }
  const SG = readSource('SessionGate.java');
  for (const meth of ['resume', 'stop']) {
    check('SessionGate.' + meth + ' runs inside synchronized (lock)', !!SG
      && (() => { const c = codeView(SG); const r = methodSpans(c, 'public\\s+(?:<T>\\s+T|StopPath)\\s+' + meth)[0]; return !!r && /synchronized\s*\(\s*lock\s*\)/.test(c.slice(r[0], r[1])); })());
  }

  // Notification text has one home.
  const javaFiles = (() => {
    if (REV) {
      try {
        return execSync('git ls-tree --name-only ' + REV + ' ' + REL, { cwd: ROOT, encoding: 'utf8' })
          .split('\n').filter(n => n.endsWith('.java')).map(n => path.basename(n));
      } catch (e) { return []; }
    }
    const dir = path.join(TREE ? path.resolve(TREE) : ROOT, REL);
    return fs.existsSync(dir) ? fs.readdirSync(dir).filter(n => n.endsWith('.java')) : [];
  })();
  const extra = [];
  for (const f of javaFiles) {
    const s = readSource(f);
    if (s && /(?<!Intent\.)\bEXTRA_(BODY|TITLE)\b/.test(codeView(s))) extra.push(f);
  }
  check('no EXTRA_BODY / EXTRA_TITLE in any overlay class', extra.length === 0, extra.join(', '));
  const literal = [];
  for (const [f, s] of [['HrEngine.java', E], ['HrServiceHeartbeatReceiver.java', R], ['SessionResurrectionWorker.java', W]]) {
    if (s == null) continue;
    for (const lit of ['"Recording', '"Reconnecting']) {
      const at = s.indexOf(lit);
      if (at >= 0) literal.push(f + ':' + lineOf(s, at) + ' ' + lit);
    }
  }
  check('no "Recording / "Reconnecting literal in HrEngine, the receiver or the worker', literal.length === 0, literal.join(' | '));

  if (W != null) {
    const wc = codeView(W);
    const ifs = ifStatements(wc);
    const fgs = [...wc.matchAll(/\bstartForegroundService\s*\(/g)].map(m => m.index);
    const ungated = fgs.filter(i => !ifs.some(f => i > f.cond[1] && i < f.end
      && /SDK_INT\s*<\s*(31|Build\.VERSION_CODES\.S\b)/.test(f.text)));
    check('worker calls startForegroundService only under SDK_INT < 31', ungated.length === 0,
      ungated.map(i => ':' + lineOf(W, i)).join(' '));
  }
  if (R != null) {
    const at = codeView(R).indexOf('segmentTickFromAlarm');
    check('alarm receiver never calls segmentTickFromAlarm (onWake owns it)', at < 0, at >= 0 ? 'at :' + lineOf(R, at) : '');
  }
  if (P != null) {
    const pc = codeView(P);
    const rs = methodSpans(pc, 'public\\s+void\\s+resumeSession')[0];
    check('plugin resumeSession catches Throwable', !!rs && /catch\s*\(\s*Throwable\b/.test(pc.slice(rs[0], rs[1])));
  }

  // Review batch 2026-10-10: the policies are wired at their real call sites.
  if (E != null) {
    const ec = codeView(E);
    const ld = methodSpans(ec, 'public\\s+void\\s+onLinkDown')[0];
    const ldBody = ld ? ec.slice(ld[0], ld[1]) : '';
    check('[1] onLinkDown in NOT_FOUND retries; it never decides or stops',
      !!ld && /retryWakeAttempt\s*\(/.test(ldBody) && !/onWake(WindowEnd|AttemptFailed)|liveStop/.test(ldBody));
    const wake = methodSpans(ec, 'public\\s+void\\s+onWake')[0];
    const wakeBody = wake ? ec.slice(wake[0], wake[1]) : '';
    check('[1] onWake posts the window-end decision for every attempt',
      /postDelayed\s*\(\s*\(\)\s*->\s*onWakeWindowEnd\s*\(/.test(wakeBody) && /WAKE_ATTEMPT_MS/.test(wakeBody));
    const we = methodSpans(ec, 'private\\s+void\\s+onWakeWindowEnd')[0];
    check('[1] only the window end calls liveStop (through onAttemptWindowEnd)',
      !!we && /onAttemptWindowEnd\s*\(/.test(ec.slice(we[0], we[1]))
        && indexesOf(ec, '.liveStop(').every(i => inside(i, [we])));
    check('[6] onWake arms the auto-end only through autoEndBoundFor(origin, ...)',
      /autoEndBoundFor\s*\(\s*origin\s*,/.test(wakeBody));
    const pr = methodSpans(ec, 'private\\s+void\\s+postResolveAndConnect')[0];
    const prBody = pr ? ec.slice(pr[0], pr[1]) : '';
    const afterConnect = prBody.slice(Math.max(0, prBody.search(/device\.connect\s*\(/)));
    check('[5] a resolve that returns after a Stop closes its link',
      /if\s*\(\s*!\s*sessionActive\.get\(\)\s*\)\s*\{[^}]*disconnectDevice\s*\(/.test(afterConnect));
    const ra = methodSpans(ec, 'private\\s+JSONObject\\s+resumeLocked')[0];
    const raRaw = ra ? E.slice(ra[0], ra[1]) : '';
    check('[nit] resume_abandon clears the three test prefs',
      ['test_no_sticky_session', 'test_auto_end_ms', 'test_auto_end_session'].every(k => raRaw.includes('.remove("' + k + '")')));
  }
  const GD = readSource('GattHrDevice.java');
  check('[5] GattHrDevice.currentGatt is volatile', !!GD && /private\s+volatile\s+BluetoothGatt\s+currentGatt\b/.test(GD));
  if (S != null) {
    const sc = codeView(S);
    const osc = methodSpans(sc, 'public\\s+int\\s+onStartCommand')[0];
    const body = osc ? sc.slice(osc[0], osc[1]) : '';
    const sf = body.search(/\bstartForeground\s*\(/);
    check('[2] onStartCommand picks the notification state through notificationState(stopInFlight || teardown, ...)',
      /notificationState\s*\(/.test(body.slice(0, sf)) && /stopInFlight\s*\|\|\s*HrEngine\.isStopTeardownInProgress\s*\(\s*\)/.test(body.slice(0, sf)));
    const ls = methodSpans(sc, 'private\\s+void\\s+startLiveStop')[0];
    const lsBody = ls ? sc.slice(ls[0], ls[1]) : '';
    // Both stop paths (notification Stop via startLiveStop, in-app Stop via the plugin) reach
    // stopSessionInternal, so STOPPING is posted there, right after the claim wins.
    if (E != null) {
      const ec2 = codeView(E);
      const st = methodSpans(ec2, '\\bstopSessionInternal')[0];
      const stBody = st ? ec2.slice(st[0], st[1]) : '';
      const claimAt = stBody.search(/if\s*\(\s*!\s*claimed\s*\)/);
      const postAt = stBody.search(/\bpostStoppingNotification\s*\(\s*\)/);
      check('[2] both stop paths show STOPPING: stopSessionInternal posts it after the claim wins',
        claimAt >= 0 && postAt > claimAt && /stopSessionInternalIfCurrent\s*\(/.test(lsBody));
      const ps = methodSpans(ec2, 'private\\s+void\\s+postStoppingNotification')[0];
      const psRaw = ps ? E.slice(ps[0], ps[1]) : '';
      check('[2] the engine posts the STOPPING text by state, never a literal', /State\.STOPPING/.test(psRaw) && !/"Saving/.test(psRaw));
    }
    const pl = readSource('NativeHrSessionPlugin.java');
    const plStop = pl ? methodSpans(codeView(pl), 'public\\s+void\\s+stopSession')[0] : null;
    check('[2] the in-app Stop goes through stopSessionInternal', !!plStop && /stopSessionInternal\s*\(/.test(codeView(pl).slice(plStop[0], plStop[1])));
    check('[4] the live-Stop tail releases through releaseAfterLiveStop and cancels through cancelAlarmAfterLiveStop',
      /if\s*\(\s*ServiceStartPolicy\.releaseAfterLiveStop\s*\(\s*stopped\s*,\s*newerLive\s*,\s*HrEngine\.isStopTeardownInProgress\s*\(\s*\)\s*\)\s*\)\s*\{[^}]*releaseWakeLock\s*\(/.test(lsBody)
        && /cancelAlarmAfterLiveStop\s*\([^)]*\)\s*\)\s*HrServiceHeartbeatReceiver\.cancel/.test(lsBody)
        && !/if\s*\(\s*stopped\s*&&\s*!newerLive\s*\)/.test(lsBody));
    const stale = body.indexOf('StopPath.STALE');
    const staleBlock = stale >= 0 ? body.slice(stale, body.indexOf('return START_NOT_STICKY', stale)) : '';
    check('[3] the stale branch cancels the alarm only through staleStopCancelsAlarm(prefs re-read)',
      /if\s*\(\s*ServiceStartPolicy\.staleStopCancelsAlarm\s*\([^)]*\)\s*\)\s*HrServiceHeartbeatReceiver\.cancel/.test(staleBlock)
        && (staleBlock.match(/HrServiceHeartbeatReceiver\.cancel/g) || []).length === 1);
    const cs = methodSpans(sc, 'private\\s+void\\s+commitStaleStopIfCurrent')[0];
    const csRaw = cs ? S.slice(cs[0], cs[1]) : '';
    check('[nit] the stale-match commit clears the three test prefs',
      ['test_no_sticky_session', 'test_auto_end_ms', 'test_auto_end_session'].every(k => csRaw.includes('.remove("' + k + '")')));
  }
  if (R != null) {
    const rc = codeView(R);
    const at = rc.search(/\bstartForegroundService\s*\(/);
    const tail = at >= 0 ? R.slice(at) : '';
    check('[7] the alarm receiver logs fgs_start_denied when startForegroundService throws',
      at >= 0 && /catch\s*\(\s*Throwable[\s\S]{0,200}"fgs_start_denied/.test(tail));
  }

  // Audit batch 2026-10-10 (R3, I1, I2, nits).
  if (E != null) {
    const ec = codeView(E);
    const ra = methodSpans(ec, 'private\\s+JSONObject\\s+resumeLocked')[0];
    const raRaw = ra ? E.slice(ra[0], ra[1]) : '';
    check('[R3] every resume gates stale prefs on resumeAllowedByAge(last_alive_ms, ...) and logs reason=stale',
      /resumeAllowedByAge\s*\(\s*lastAlive\s*,/.test(raRaw) && /getLong\("last_alive_ms"/.test(raRaw) && raRaw.includes('"reason=stale age_h="'));
    const st = methodSpans(ec, '\\bstartSessionInternal')[0];
    const stBody = st ? ec.slice(st[0], st[1]) : '';
    const ifAt = stBody.search(/if\s*\(\s*resuming\s*&&\s*opened\s*!=\s*null\s*\)\s*\{/);
    let ok1 = false;
    if (ifAt >= 0) {
      const ifBlk = blockFrom(stBody, ifAt);
      const afterIf = stBody.slice(ifBlk[1] + 1);
      const elseM = afterIf.match(/^\s*else\s*\{/);
      const elseBlk = elseM ? blockFrom(afterIf, elseM[0].length - 1) : null;
      const inIf = stBody.slice(ifBlk[0], ifBlk[1]);
      const inElse = elseBlk ? afterIf.slice(elseBlk[0], elseBlk[1]) : '';
      const outside = stBody.slice(0, ifAt) + (elseBlk ? afterIf.slice(elseBlk[1]) : afterIf);
      ok1 = /resumable\.resumeBroken\s*\(/.test(inIf) && !/resumable\.(startSessionAsync|resetSession)\s*\(/.test(inIf)
        && /resumable\.startSessionAsync\s*\(/.test(inElse) && /resumable\.resetSession\s*\(/.test(inElse)
        && !/resumable\.(startSessionAsync|resetSession)\s*\(/.test(outside);
    }
    check('[I1] a resume never resets or opens a resumable session (no duplicate Drive file); a fresh start does', ok1);
    const ru = readSource('NativeDriveResumableUploader.java');
    const rb = ru ? methodSpans(codeView(ru), 'public\\s+void\\s+resumeBroken')[0] : null;
    const rbBody = rb ? codeView(ru).slice(rb[0], rb[1]) : '';
    check('[I1] resumeBroken stays broken on the executor and never rewrites the persisted Drive keys',
      /executor\.submit/.test(rbBody) && /broken\s*=\s*true/.test(rbBody) && !/persistResumeKeys|openSession|createFile/.test(rbBody));
    check('[nit] the segment roll timer is gone (the heartbeat and the alarm tick)', !/segmentRollRunnable|scheduleSegmentRoll/.test(ec));
    check('[nit] no unused HrEngine.get(Context)', !/static\s+HrEngine\s+get\s*\(/.test(ec));
  }
  if (P != null) {
    const pc = codeView(P);
    const pmRe2 = /@PluginMethod[\s\S]*?public\s+void\s+(\w+)\s*\(\s*PluginCall\s+\w+\s*\)\s*\{/g;
    let m2;
    const unguarded = [];
    while ((m2 = pmRe2.exec(pc))) {
      const b = blockFrom(pc, m2.index + m2[0].length - 1);
      const body = pc.slice(b[0] + 1, b[1]);
      for (const call of ['authExecutor().execute(', 'startActivityForResult(']) {
        let i = body.indexOf(call);
        while (i >= 0) {
          let guarded = false;
          const tre = /\btry\s*\{/g;
          let t;
          while ((t = tre.exec(body))) {
            const tb = blockFrom(body, t.index + t[0].length - 1);
            if (tb && i > tb[0] && i < tb[1] && /^\s*catch\s*\(\s*Throwable\b/.test(body.slice(tb[1] + 1))) guarded = true;
          }
          if (!guarded) unguarded.push(m2[1] + ':' + call);
          i = body.indexOf(call, i + 1);
        }
      }
    }
    check('[I2] every authExecutor().execute( and startActivityForResult( in a @PluginMethod sits in try/catch (Throwable)',
      unguarded.length === 0, unguarded.join(', '));
    const load = methodSpans(pc, 'public\\s+void\\s+load')[0];
    const resume = methodSpans(pc, 'protected\\s+void\\s+handleOnResume')[0];
    check('[nit] a cold open wakes once: onWake in handleOnResume, not in load()',
      !!load && !/\.onWake\s*\(/.test(pc.slice(load[0], load[1])) && !!resume && /\.onWake\s*\(/.test(pc.slice(resume[0], resume[1])));
  }
  if (S != null) {
    const sc = codeView(S);
    check('[nit] a declined resume drops the alarm only through resumeDeclineCancelsAlarm',
      /idleStop\s*\([^;]*ServiceStartPolicy\.resumeDeclineCancelsAlarm\s*\(\s*reason\s*\)\s*\)/.test(sc));
  }

  // Test prefs are read only behind BuildConfig.TEST_HOOKS and the live session.
  const ungatedReads = [];
  let reads = 0;
  for (const f of javaFiles) {
    const s = readSource(f);
    if (!s) continue;
    const c = codeView(s);
    const ifs = ifStatements(c);
    const re = /\bget(?:Long|Boolean|Int|String)\s*\(\s*"test_(?:no_sticky_session|auto_end_ms|auto_end_session)"/g;
    let m;
    while ((m = re.exec(s))) {
      reads++;
      const i = m.index;
      const ok = ifs.some(f2 => i > f2.cond[0] && i < f2.end
        && /BuildConfig\.TEST_HOOKS/.test(f2.text) && /sessionStartMs/i.test(f2.text)
        && (i > f2.cond[1] || c.slice(f2.cond[0], i).includes('BuildConfig.TEST_HOOKS')));
      if (!ok) ungatedReads.push(f + ':' + lineOf(s, i));
    }
  }
  check('every test pref read sits inside if (BuildConfig.TEST_HOOKS && ... sessionStartMs ...)',
    reads > 0 && ungatedReads.length === 0, reads + ' read(s)' + (ungatedReads.length ? '; ungated: ' + ungatedReads.join(' ') : ''));
}
step2Checks();

// ---- Detangle (FABLE-DETANGLE.md): the engine is the truth, the page is a view -------------------
// Guards the 2026-10-10 bug: the page minted its own senderId and kept a one-shot status, so the engine's
// own ticks were filed as a foreign broadcaster and the toggle said Reconnect while native recorded.
function detangleChecks() {
  console.log('\n-- detangle');
  const E = src['HrEngine.java'];
  const P = src['NativeHrSessionPlugin.java'];
  const G = src['GattHrDevice.java'];
  const D = src['HrDevice.java'];
  if (E != null) {
    const ec = codeView(E);
    const st = methodSpans(ec, 'public\\s+JSONObject\\s+statusJson')[0];
    const body = st ? E.slice(st[0], st[1]) : '';
    const missing = ['linkState', 'linkUp', 'generation', 'targetMac', 'strapName', 'posture', 'lastHrAtMs']
      .filter(k => !body.includes('"' + k + '"'));
    check('[step 1] statusJson carries linkState, linkUp, generation, targetMac, strapName, posture, lastHrAtMs',
      !!st && missing.length === 0, missing.length ? 'missing: ' + missing.join(', ') : '');
    const emits = indexesOf(E, 'emit("linkState"');
    const applyLink = methodSpans(ec, 'private\\s+void\\s+applyLink')[0];
    check('[step 1] emit("linkState" appears 2+ times, one inside applyLink', emits.length >= 2 && !!applyLink && emits.some(i => inside(i, [applyLink])),
      'count=' + emits.length);
    check('[step 1] no senderIdArg: the engine mints the id on start', !/\bsenderIdArg\b/.test(ec));
    const start = methodSpans(ec, '\\bstartSessionInternal')[0];
    check('[step 1, A6] startSessionInternal mints with mintSenderId() and returns senderId',
      !!start && /mintSenderId\s*\(/.test(ec.slice(start[0], start[1])) && /putSafe\s*\(\s*ret\s*,\s*"senderId"/.test(E.slice(start[0], start[1])));
    // A4: the page's connected state comes from a real link flag, never from a handle existing.
    check('[A4] linkUp comes from the device link callbacks (isLinkUp), not hasHandle', /"linkUp"\s*,\s*device\.isLinkUp\s*\(\s*\)/.test(E));
    // Step 5 (pending reconnect) is self-contained: each hook site is one call into its own method.
    const spanOf = (sig) => { const m = methodSpans(ec, sig)[0]; return m ? ec.slice(m[0], m[1]) : ''; };
    const pUp = spanOf('private\\s+void\\s+pendingOnLinkUp');
    check('[A5] onLinkUp calls pendingOnLinkUp, which pulses the wake lock while NOT_FOUND',
      /pendingOnLinkUp\s*\(/.test(spanOf('public\\s+void\\s+onLinkUp')) && /NOT_FOUND/.test(pUp) && /\.pulse\s*\(/.test(pUp));
    for (const line of ['pending_connect armed', 'pending_connect fired', 'pending_connect cancelled reason=', 'pending_connect disabled']) {
      check('[step 5] lifecycle line "' + line + '"', E.includes(line));
    }
    check('[step 5] NOT_FOUND entry arms through applyLink -> pendingOnTransition',
      !!applyLink && /pendingOnTransition\s*\(/.test(ec.slice(applyLink[0], applyLink[1]))
        && /NOT_FOUND[\s\S]*armPendingConnect\s*\(/.test(spanOf('private\\s+void\\s+pendingOnTransition')));
    check('[step 5] a wake window end without a link arms through pendingOnWakeWindowEnd',
      /pendingOnWakeWindowEnd\s*\(/.test(spanOf('private\\s+void\\s+onWakeWindowEnd'))
        && /armPendingConnect\s*\(/.test(spanOf('private\\s+void\\s+pendingOnWakeWindowEnd')));
    check('[step 5] a NOT_FOUND link down goes through pendingOnLinkDown first', /pendingOnLinkDown\s*\(/.test(spanOf('public\\s+void\\s+onLinkDown')));
    // Runtime review 2: a link already up (pending mid-discovery) is never torn down by a direct attempt.
    const wake = spanOf('public\\s+void\\s+onWake');
    check('[rv2] onWake returns on device.isLinkUp() before link.onWake plans an attempt',
      /device\.isLinkUp\s*\(\s*\)/.test(wake) && wake.search(/device\.isLinkUp\s*\(/) < wake.indexOf('link.onWake('));
    check('[rv2] connect() in NOT_FOUND skips the direct attempt while the link is up',
      /NOT_FOUND\s*&&\s*!device\.isLinkUp\s*\(\s*\)\s*\)\s*postResolveAndConnect/.test(spanOf('public\\s+void\\s+connect')));
    // Runtime review 4: the posture survives a native resume in a new process.
    check('[rv4] logFact persists lastPosture and resumeLocked restores it',
      /putString\s*\(\s*"lastPosture"/.test(E) && /getString\s*\(\s*"lastPosture"/.test(E.slice(...(methodSpans(ec, 'private\\s+JSONObject\\s+resumeLocked')[0] || [0, 0]))));
    // Ledger 25 (S55): logFact hands back the stored time and the sanitised label, and the plugin resolves both.
    const lf = E.slice(...(methodSpans(ec, 'public\\s+JSONObject\\s+logFact')[0] || [0, 0]));
    check('[S55] logFact returns {status, ts, label}, label through SegmentWriter.clean',
      /putSafe\s*\(\s*r\s*,\s*"ts"\s*,\s*ts\s*\)/.test(lf) && /"label"\s*,[^;]*SegmentWriter\.clean\s*\(\s*fields\[0\]\s*\)/.test(lf));
    check('[S55] the plugin resolves written, ts and label', /\.put\(\s*"ts"\s*,\s*r\.optLong\(\s*"ts"\s*\)\s*\)\s*\.put\(\s*"label"/.test(P));
    const arm = spanOf('private\\s+void\\s+armPendingConnect');
    // Runtime review 3: the setting is read again inside the ioExecutor task.
    const lambdaAt = arm.indexOf('ioExecutor.execute(');
    check('[rv3] armPendingConnect re-reads pendingReconnectEnabled inside its ioExecutor task',
      lambdaAt >= 0 && /pendingReconnectEnabled\s*\(\s*\)/.test(arm.slice(lambdaAt)));
    check('[step 5] arming reads the persisted pendingReconnectEnabled setting before any connect',
      /pendingReconnectEnabled\s*\(\s*\)/.test(arm) && arm.indexOf('pendingReconnectEnabled') < arm.indexOf('pendingConnect('));
  }
  if (P != null) {
    const pc = codeView(P);
    const ss = methodSpans(pc, 'public\\s+void\\s+startSession')[0];
    check('[step 1] plugin startSession never reads a senderId from JS', !!ss && !P.slice(ss[0], ss[1]).includes('"senderId"'));
    const stp = methodSpans(pc, 'public\\s+void\\s+status')[0];
    check('[step 0] plugin status() logs status_call on exit', !!stp && P.slice(stp[0], stp[1]).includes('status_call'));
    const ping = methodSpans(pc, 'public\\s+void\\s+ping')[0];
    const pb = ping ? P.slice(ping[0], ping[1]) : '';
    check('[A1] plugin ping() logs bridge_ping, resolves, and catches Throwable',
      !!ping && pb.includes('bridge_ping') && /call\.resolve\s*\(/.test(pb) && /catch\s*\(\s*Throwable\b/.test(pb));
  }
  if (G != null && D != null) {
    const gc = codeView(G);
    const autoTrue = [...gc.matchAll(/connectGatt\s*\(\s*appCtx\s*,\s*true\b/g)].map(m => m.index);
    const pend = methodSpans(gc, 'public\\s+boolean\\s+pendingConnect')[0];
    check('[step 5] the only autoConnect=true connectGatt is in pendingConnect, bonded handle only',
      autoTrue.length === 1 && !!pend && inside(autoTrue[0], [pend]) && /findBondedDevice\s*\(/.test(gc.slice(pend[0], pend[1]))
        && /closeGattQuietly\s*\(/.test(gc.slice(pend[0], autoTrue[0])), 'autoConnect=true sites=' + autoTrue.length);
    check('[step 5, A4] HrDevice declares pendingConnect and isLinkUp', /boolean\s+pendingConnect\s*\(/.test(D) && /boolean\s+isLinkUp\s*\(/.test(D));
  }
  // Two-argument Log only (the 3-arg Throwable overload crashes the S8 at class load).
  const threeArg = [];
  for (const f of ['HrEngine.java', 'NativeHrSessionPlugin.java', 'GattHrDevice.java']) {
    const s = src[f];
    if (!s) continue;
    const c = codeView(s);
    const re = /\bLog\.[vdiwe]\s*\(/g;
    let m;
    while ((m = re.exec(c))) {
      const b = (() => { let d = 0; for (let k = m.index + m[0].length - 1; k < c.length; k++) { if (c[k] === '(') d++; else if (c[k] === ')' && --d === 0) return k; } return -1; })();
      const args = c.slice(m.index + m[0].length, b);
      let depth = 0, commas = 0;
      for (const ch of args) { if ('([{'.includes(ch)) depth++; else if (')]}'.includes(ch)) depth--; else if (ch === ',' && depth === 0) commas++; }
      if (commas !== 1) threeArg.push(f + ':' + lineOf(s, m.index));
    }
  }
  check('two-argument Log only in HrEngine, the plugin and GattHrDevice', threeArg.length === 0, threeArg.join(' '));

  // Page: every native-only path sits behind NATIVE; desktop web keeps the old code.
  const M = readRepo('hr_monitor.html');
  if (M != null) {
    const fnBody = (name) => {
      const i = M.search(new RegExp('(?:async\\s+)?function\\s+' + name + '\\s*\\('));
      if (i < 0) return null;
      const b = blockFrom(M, M.indexOf(')', i));
      return b ? M.slice(b[0], b[1]) : null;
    };
    const gdi = fnBody('getDeviceIdentity');
    check('[step 4, A3] getDeviceIdentity never mints on NATIVE (returns before getRandomValues)',
      !!gdi && /if\s*\(\s*NATIVE\s*\)/.test(gdi) && gdi.search(/if\s*\(\s*NATIVE\s*\)/) < gdi.indexOf('getRandomValues'));
    const wl = fnBody('acquireWakeLock');
    check('[step 4] acquireWakeLock returns on NATIVE before the native CPU lock', !!wl && /if\s*\(\s*NATIVE\s*\)\s*return/.test(wl)
      && wl.search(/if\s*\(\s*NATIVE\s*\)\s*return/) < wl.indexOf('HRMWakeLock'));
    const as = fnBody('startSessionAutoSave');
    check('[step 4] startSessionAutoSave returns on NATIVE', !!as && /if\s*\(\s*NATIVE\s*\)\s*return/.test(as));
    const gone = ['prepareLiveUiFromNativeSession', 'adoptNativeSessionUi', 'adoptNativeSenderIdentity', 'adoptLateNativeSession',
      'syncConnStateWithNative', '_nativeRelayLive'].filter(n => M.includes(n));
    check('[step 3] the merged adopt functions and _nativeRelayLive are gone', gone.length === 0, gone.join(', '));
    check('[step 3] syncFromEngine exists and logs sync reason=', !!fnBody('syncFromEngine') && /sync reason=/.test(M));
    // Runtime review 4: the page logs its posture fact for a start only, never on a resume or a publishing event.
    const cn = fnBody('connectNative') || '';
    check('[rv4] posture fact only after a start: in connectNative, never in an onPublishingChanged listener',
      /logNativeFact\s*\(\s*'posture'/.test(cn) && !/onPublishingChanged\s*\(\s*function[\s\S]{0,200}logNativeFact\s*\(\s*'posture'/.test(M));
  }
}
detangleChecks();

// S5: the notification Symptom action reaches the engine through SymptomReceiver, never the Service.
function symptomChecks() {
  const R = readSource('SymptomReceiver.java');
  check('[S5] SymptomReceiver.java exists', R != null);
  if (R != null) {
    const rc = codeView(R);
    const banned = ['startService', 'startForegroundService', 'stopSelf', 'stopService', 'decide', 'START_LOCK']
      .filter(w => new RegExp('\\b' + w + '\\b').test(rc));
    check('[S5] SymptomReceiver never starts, stops or decides', banned.length === 0, banned.join(', '));
    const lits = (R.match(/"(?:[^"\\]|\\.)*"/g) || []).filter(l => /(?:Live|Reconnecting|Strap|Saving|Resuming|Ended|Symptom|Stop session|Open|HR Monitor)/.test(l));
    check('[S5] SymptomReceiver carries no notification literal', lits.length === 0 && !/\bNotification\w*\b/.test(rc), lits.join(' '));
    const onr = methodSpans(rc, 'public\\s+void\\s+onReceive')[0];
    const ob = onr ? rc.slice(onr[0], onr[1]) : '';
    check('[S5] onReceive calls goAsync, starts one thread, finishes in a finally',
      /goAsync\s*\(\s*\)/.test(ob) && /new\s+Thread\s*\(/.test(ob) && /finally\s*\{[^}]*\.finish\s*\(\s*\)/.test(ob));
    check('[S5] the receiver decides through ServiceStartPolicy.symptomWrites and writes sym:symptom',
      /ServiceStartPolicy\.symptomWrites\s*\(/.test(rc) && /\.logFact\s*\(\s*"symptom"\s*,\s*\w+\s*,\s*"sym:symptom"\s*,\s*null\s*\)/.test(R)
        && R.includes('"symptom_dropped'));
  }
  const man = readRepo('mobile/android-overlay/app/src/main/AndroidManifest.xml');
  const decl = man && (man.match(/<receiver\b[^>]*SymptomReceiver[^>]*>/) || [''])[0];
  check('[S5] the manifest declares SymptomReceiver exported="false"', !!decl && /android:exported="false"/.test(decl), decl ? '' : 'absent');
  const S = readSource('NativeHrService.java');
  const b = S && methodSpans(codeView(S), 'static\\s+Notification\\s+buildNotificationStatic')[0];
  check('[S5] buildNotificationStatic found', !!b);
  if (b) {
    const bc = codeView(S).slice(b[0], b[1]);
    const raw = S.slice(b[0], b[1]);
    const statics = [...bc.matchAll(/\bHrEngine\s*\.\s*(\w+)/g)].map(m => m[1]);
    const vars = [...bc.matchAll(/\bHrEngine\s+(\w+)\s*=/g)].map(m => m[1]);
    const inst = vars.length ? [...bc.matchAll(new RegExp('\\b(?:' + vars.join('|') + ')\\s*\\.\\s*(\\w+)', 'g'))].map(m => m[1]) : [];
    const allowed = new Set(['peek', 'isSessionActive', 'isStopTeardownInProgress', 'linkState']);
    const reads = statics.concat(inst);
    check('[S5] buildNotificationStatic reads HrEngine only through peek, isSessionActive, isStopTeardownInProgress, linkState',
      reads.length > 0 && reads.every(r => allowed.has(r)) && !/HrEngine\s*::/.test(bc), 'reads: ' + reads.join(', '));
    const calls = [...bc.matchAll(/\b((?:start|stop)\w*|decide)\s*\(/g)].map(m => m[1]);
    check('[S5] buildNotificationStatic calls no start*, stop* or decide and names no START_LOCK',
      calls.length === 0 && !/\bSTART_LOCK\b/.test(bc), calls.join(', '));
    const tryAt = bc.search(/try\s*\{[^}]*HrEngine\.peek\s*\(/);
    check('[S5] the Symptom predicate runs inside try/catch (Throwable) and goes through symptomShown',
      tryAt >= 0 && /catch\s*\(\s*Throwable\b[^)]*\)\s*\{\s*sym\s*=\s*false\s*;/.test(bc) && /ServiceStartPolicy\.symptomShown\s*\(/.test(bc));
    check('[S5] Symptom is an explicit broadcast to SymptomReceiver, added only under if (sym)',
      /if\s*\(\s*sym\s*\)\s*\{[^}]*PendingIntent\.getBroadcast\s*\([^;]*new\s+Intent\s*\(\s*ctx\s*,\s*SymptomReceiver\.class\s*\)[^}]*addAction\s*\(\s*0\s*,\s*"Symptom"/.test(raw));
    check('[S5] Open and Stop session actions; Stop stays a service PendingIntent',
      /addAction\s*\(\s*0\s*,\s*"Open"\s*,\s*content\s*\)/.test(raw) && /addAction\s*\(\s*0\s*,\s*"Stop session"\s*,\s*stopPi\s*\)/.test(raw)
        && /stopPi\s*=\s*PendingIntent\.getService\s*\(/.test(raw));
  }
  const P = readSource('ServiceStartPolicy.java');
  const sp = P && methodSpans(codeView(P), 'public\\s+static\\s+boolean\\s+symptomShown')[0];
  check('[S5] ServiceStartPolicy.symptomShown catches Throwable and yields false',
    !!sp && /catch\s*\(\s*Throwable\b[^)]*\)\s*\{\s*return\s+false\s*;/.test(codeView(P).slice(sp[0], sp[1])));
}
symptomChecks();

// S15a: the report PDF runs beside a live session and must never reach into the recorder.
function pdfChecks() {
  const P = readSource('PdfPrinter.java');
  check('[S15a] PdfPrinter.java exists', P != null);
  if (P == null) return;
  const pc = codeView(P);
  const recorder = [...pc.matchAll(/\b(HrEngine|NativeHrService|FloatingOverlayService|SegmentWriter|SegmentUpload\w*|NativeCsvWriter|NativeDrive\w*|GattHrDevice|HrDevice|BleScanner|HrSink|TeeSink|SessionGate|ServiceStartPolicy|LinkStatePolicy|NativeHrSessionPlugin|start\w*Service|stopService)\b/g)].map(m => m[1]);
  check('[S15a] PdfPrinter names no engine, service, BLE, segment or Drive class', recorder.length === 0, recorder.join(', '));
  const makers = [...pc.matchAll(/\bExecutors\s*\.\s*(\w+)\s*\(/g)].map(m => m[1]);
  check('[S15a] PdfPrinter makes exactly one executor, a single thread, held in static final EXEC',
    makers.length === 1 && makers[0] === 'newSingleThreadExecutor'
      && /private\s+static\s+final\s+ExecutorService\s+EXEC\s*=\s*Executors\s*\.\s*newSingleThreadExecutor\s*\(/.test(pc), makers.join(', '));
  const submits = [...pc.matchAll(/(\w+)\s*\.\s*(execute|submit)\s*\(/g)].map(m => m[1] + '.' + m[2]);
  check('[S15a] every PdfPrinter execute goes to EXEC', submits.length > 0 && submits.every(x => x === 'EXEC.execute'), submits.join(', '));
  const run = methodSpans(pc, 'private\\s+static\\s+void\\s+run')[0];
  const rb = run ? pc.slice(run[0], run[1]) : '';
  const loop = rb.match(/for\s*\(\s*int\s+i\s*=\s*0\s*;[^)]*\)\s*\{[\s\S]*?\}\s*finally\s*\{[^}]*\}\s*\}/);
  const lb = loop ? loop[0] : '';
  check('[S15a] each page decodes inside a try whose finally recycles the bitmap',
    /try\s*\{\s*bmp\s*=\s*BitmapFactory\s*\.\s*decodeByteArray\s*\(/.test(lb) && /finally\s*\{[^}]*bmp\s*\.\s*recycle\s*\(\s*\)\s*;\s*bmp\s*=\s*null/.test(lb));
  check('[S15a] each page checks heap and system memory for the pages left before it decodes, and rejects pdf_low_memory',
    /lowMemory\s*\(\s*app\s*,\s*n\s*-\s*i\s*\)/.test(lb) && lb.search(/lowMemory\s*\(/) < lb.search(/decodeByteArray/)
      && /if\s*\(\s*lowMemory\s*\([^)]*\)\s*\)\s*\{\s*s\s*\.\s*fail\s*\(\s*"pdf_low_memory"\s*\)/.test(P));
  const lm = methodSpans(pc, 'private\\s+static\\s+boolean\\s+lowMemory')[0];
  check('[S15a] heap headroom reads maxMemory, totalMemory and freeMemory through Plan.heapLow',
    !!lm && /Plan\s*\.\s*heapLow\s*\(\s*rt\s*\.\s*maxMemory\s*\(\s*\)\s*,\s*rt\s*\.\s*totalMemory\s*\(\s*\)\s*,\s*rt\s*\.\s*freeMemory\s*\(\s*\)\s*\)/.test(pc.slice(lm[0], lm[1])));
  const rawRun = run ? P.slice(run[0], run[1]) : '';
  check('[S15a] run catches OutOfMemoryError and Throwable, and fails the call in finally after the document is closed',
    /catch\s*\(\s*OutOfMemoryError\s+\w+\s*\)\s*\{\s*failCode\s*=\s*"pdf_low_memory"/.test(rawRun)
      && /catch\s*\(\s*Throwable\s+\w+\s*\)\s*\{[^}]*failCode\s*=\s*"pdf_failed"/.test(rawRun)
      && /finally\s*\{[\s\S]*doc\s*\.\s*close\s*\([\s\S]*if\s*\(\s*failCode\s*!=\s*null\s*\)\s*s\s*\.\s*fail\s*\(\s*failCode\s*\)/.test(rawRun));
  const pr = methodSpans(pc, 'static\\s+void\\s+print')[0];
  const pb = pr ? pc.slice(pr[0], pr[1]) : '';
  check('[S15a] print catches Throwable and frees BUSY in the job finally and when execute throws',
    /catch\s*\(\s*Throwable\b/.test(pb) && /finally\s*\{\s*BUSY\s*\.\s*set\s*\(\s*false\s*\)/.test(pb)
      && /catch\s*\(\s*Throwable\s+\w+\s*\)\s*\{\s*BUSY\s*\.\s*set\s*\(\s*false\s*\)/.test(pb));
  check('[S15a] PdfPrinter settles only through Settle (no bare call.resolve or call.reject outside it)',
    (() => {
      const at = pc.search(/final\s+class\s+Settle\s*\{/);
      const span = at >= 0 ? blockFrom(pc, at) : null;
      const hits = [...pc.matchAll(/\bcall\s*\.\s*(resolve|reject)\s*\(/g)];
      return !!span && hits.length === 2 && hits.every(h => h.index > span[0] && h.index < span[1]);
    })());

  const S = readSource('NativeHrSessionPlugin.java');
  const m = S && methodSpans(codeView(S), 'public\\s+void\\s+printPdf')[0];
  check('[S15a] NativeHrSessionPlugin.printPdf found', !!m);
  if (m) {
    const b = codeView(S).slice(m[0], m[1]);
    const names = [...b.matchAll(/\b([A-Za-z_]\w*)\s*\(/g)].map(x => x[1]).filter(x => !['try', 'catch'].includes(x));
    check('[S15a] printPdf only hands the call to PdfPrinter.print and rejects on Throwable',
      /PdfPrinter\s*\.\s*print\s*\(\s*getContext\s*\(\s*\)\s*,\s*getActivity\s*\(\s*\)\s*,\s*call\s*\)/.test(b)
        && /catch\s*\(\s*Throwable\b[^)]*\)\s*\{\s*call\s*\.\s*reject\s*\(/.test(b)
        && names.every(x => ['print', 'getContext', 'getActivity', 'reject'].includes(x)), names.join(', '));
  }

  const J = readRepo('mobile/src/native-pdf.js');
  check('[S15a] mobile/src/native-pdf.js exists', J != null);
  if (J != null) {
    const body = J.replace(/^(\s*\/\/[^\n]*\n)*/, '').trim();
    check('[S15a] native-pdf.js is one IIFE reading Capacitor.Plugins.NativeHrSession, never registerPlugin',
      /^\(function\s*\(\)\s*\{/.test(body) && /\}\)\(\);$/.test(body) && /\.Plugins\.NativeHrSession\b/.test(J) && !/registerPlugin/.test(J));
  }
}
pdfChecks();

// S56: the resume overlay needs a real stop longer than the page's resumeOverlayMs; cold start and the fence stay.
function overlayChecks() {
  const A = readSource('MainActivity.java');
  check('[S56] MainActivity.java exists', A != null);
  if (A == null) return;
  const ac = codeView(A);
  const constM = ac.match(/static\s+final\s+long\s+RESUME_OVERLAY_MIN_STOP_MS\s*=\s*(\d+)L\s*;/);
  const L = readRepo('lifecycle-state.js');
  const jsM = L && L.match(/const\s+resumeOverlayMs\s*=[^;]*:\s*(\d+)\s*;/);
  check('[S56] RESUME_OVERLAY_MIN_STOP_MS equals lifecycle-state.js resumeOverlayMs',
    !!constM && !!jsM && constM[1] === jsM[1], (constM ? constM[1] : 'none') + ' vs ' + (jsM ? jsM[1] : 'none'));
  const stop = methodSpans(ac, 'public\\s+void\\s+onStop')[0];
  const sb = stop ? ac.slice(stop[0], stop[1]) : '';
  check('[S56] onStop records stoppedAtMs from SystemClock.elapsedRealtime()',
    /stoppedAtMs\s*=\s*SystemClock\s*\.\s*elapsedRealtime\s*\(\s*\)\s*;/.test(sb));
  const res = methodSpans(ac, 'public\\s+void\\s+onResume')[0];
  const rb = res ? ac.slice(res[0], res[1]) : '';
  const rraw = res ? A.slice(res[0], res[1]) : '';
  const shows = indexesOf(rb, 'showRestoreOverlay(');
  // The one show must sit under a flag that compares the measured stop with the constant.
  const dur = rb.match(/long\s+(\w+)\s*=\s*stoppedAtMs\s*>\s*0L\s*\?\s*SystemClock\s*\.\s*elapsedRealtime\s*\(\s*\)\s*-\s*stoppedAtMs\s*:\s*-1L\s*;/);
  const durVar = dur ? dur[1] : null;
  const gateRe = durVar ? new RegExp('\\b' + durVar + '\\s*>\\s*RESUME_OVERLAY_MIN_STOP_MS\\b') : null;
  const flag = gateRe && rb.match(/boolean\s+(\w+)\s*=([^;]*);/);
  const flagVar = flag && gateRe.test(flag[2]) && /\bactive\b/.test(flag[2]) && /!\s*cleanly\b/.test(flag[2]) ? flag[1] : null;
  const gated = shows.length === 1 && !!flagVar
    && new RegExp('if\\s*\\(\\s*' + flagVar + '\\s*\\)\\s*showRestoreOverlay\\s*\\(').test(rb);
  check('[S56] onResume shows only when active, not clean, and stopped longer than RESUME_OVERLAY_MIN_STOP_MS',
    gated, 'shows=' + shows.length + ' dur=' + durVar + ' flag=' + flagVar);
  check('[S56] onResume clears stoppedAtMs after reading it',
    !!dur && /stoppedAtMs\s*=\s*0L\s*;/.test(rb.slice(rb.indexOf(dur[0]) + dur[0].length)));
  const tryAt = rb.search(/try\s*\{/);
  const tryBlk = tryAt >= 0 ? blockFrom(rb, tryAt) : null;
  check('[S56] the stop read and the show sit inside the onResume try',
    !!tryBlk && !!dur && rb.indexOf(dur[0]) > tryBlk[0] && shows.length === 1 && shows[0] < tryBlk[1]);
  check('[S56] onResume logs overlay_resume show= stopped_ms= and resume_ctx',
    /logLifecycleAsync\s*\(\s*"overlay_resume show="\s*\+\s*\w+\s*\+\s*" stopped_ms="/.test(rraw) && /logResumeContext\s*\(\s*\)/.test(rb)
      && /"resume_ctx keyguard="[^;]*" interactive="/.test(A));
  const cre = methodSpans(ac, 'public\\s+void\\s+onCreate')[0];
  const craw = cre ? A.slice(cre[0], cre[1]) : '';
  check('[S56] onCreate still shows unconditionally (why=create)',
    /\n\s*showRestoreOverlay\s*\(\s*"create"\s*\)\s*;/.test(craw) && !/if\s*\([^)]*\)\s*\{?\s*showRestoreOverlay/.test(craw));
  check('[S56] the 60 s fence is unchanged and armed on every show',
    /static\s+final\s+long\s+OVERLAY_SAFETY_MS\s*=\s*60000L\s*;/.test(ac) && /postDelayed\s*\(\s*restoreSafetyTimer\s*,\s*OVERLAY_SAFETY_MS\s*\)/.test(ac));
  check('[S56] activity_stop, activity_start, window_focus and overlay_shown why= are logged',
    ['"activity_stop"', '"activity_start"', '"window_focus has="', '"overlay_shown why="'].every(t => A.includes(t)));
  const logs = [...ac.matchAll(/NativeHrService\s*\.\s*logLifecycle\s*\(/g)].map(m => m.index);
  const lla = methodSpans(ac, 'private\\s+void\\s+logLifecycleAsync')[0];
  const sto = methodSpans(ac, 'private\\s+void\\s+hideRestoreOverlayBySafetyTimer')[0];
  check('[S56] new lifecycle lines go through logLifecycleAsync (off the UI thread)',
    !!lla && /LIFECYCLE_LOG\s*\.\s*execute\s*\(/.test(ac.slice(lla[0], lla[1]))
      && logs.every(i => (i > lla[0] && i < lla[1]) || (!!sto && i > sto[0] && i < sto[1])), 'logLifecycle calls: ' + logs.length);
}
overlayChecks();

if (failures) {
  console.error('\n' + failures + ' engine boundary check(s) FAILED.');
  process.exit(1);
}
console.log('\nAll engine boundary checks passed.');
