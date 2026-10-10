#!/usr/bin/env node
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
      /if\s*\(\s*ServiceStartPolicy\.releaseAfterLiveStop\s*\([^)]*\)\s*\)\s*\{[^}]*releaseWakeLock\s*\(/.test(lsBody)
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

if (failures) {
  console.error('\n' + failures + ' engine boundary check(s) FAILED.');
  process.exit(1);
}
console.log('\nAll engine boundary checks passed.');
