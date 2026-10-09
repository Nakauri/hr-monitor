#!/usr/bin/env node
// Engine boundary test: reads the native Java as text, no JVM.
// Guards three bugs: the C3 orphan neutralize on Activity recreate, a
// sessionActive seeded outside start/stop (skips strap reconnection after a
// real process death), and markBrokenForRestart run on attach (breaks a live
// resumable upload).
// Run: node scripts/engine-boundary.test.cjs            (exit 0 = OK)
//      node scripts/engine-boundary.test.cjs --legacy   (reads 7aae996; must FAIL)

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const REL = 'mobile/android-overlay/app/src/main/java/com/nakauri/hrmonitor/';
const LEGACY = process.argv.includes('--legacy');
const LEGACY_REV = '7aae996';

let failures = 0;
function check(name, ok, detail) {
  console.log((ok ? 'OK    ' : 'FAIL  ') + name + (detail ? '  ' + detail : ''));
  if (!ok) failures++;
}

function readSource(file) {
  if (LEGACY) {
    try {
      return execSync('git show ' + LEGACY_REV + ':' + REL + file,
        { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    } catch (e) {
      return null;
    }
  }
  const p = path.join(ROOT, REL, file);
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
}

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
if (LEGACY) console.log('Legacy mode: reading ' + LEGACY_REV + '\n');
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

if (failures) {
  console.error('\n' + failures + ' engine boundary check(s) FAILED.');
  process.exit(1);
}
console.log('\nAll engine boundary checks passed.');
