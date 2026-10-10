// Guards the lifecycle controller against wedging on a bridge call that never
// settles. Capacitor logs and rethrows when a plugin method throws without
// settling its PluginCall, so the JS promise hangs and the restore overlay
// stays up until a force-stop. Every await on such a call needs a ceiling.
//
// Run: node scripts/lifecycle-deadline.test.cjs   (must exit 0)
//
// .cjs because the repo package.json is "type":"module"; the file under test
// is a browser script, so it loads here through a window global.

const vm = require('vm');
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'lifecycle-state.js');
const sandbox = { window: {}, setTimeout, clearTimeout, Promise, Error, console };
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(SRC, 'utf8'), sandbox, { filename: SRC });
const create = sandbox.window.HRMLifecycleController.create;

const never = () => new Promise(() => {});
let failures = 0;

// A hang leaves the async IIFE pending and Node exits 0 with no output, so
// without these two guards the suite silently passes the bug it guards.
process.exitCode = 1;
const watchdog = setTimeout(() => {
  console.error('\nWATCHDOG: a controller call hung; the suite never finished');
  process.exit(1);
}, 15000);

function check(name, cond) {
  console.log((cond ? '  PASS  ' : '  FAIL  ') + name);
  if (!cond) failures++;
}

async function recoveryHangs() {
  let hidden = false, failedReason = null;
  const ctl = create({
    performRecovery: never,
    onHide: () => { hidden = true; },
    onRecoveryFailed: (r) => { failedReason = r; },
    recoveryTimeoutMs: 150,
  });
  await ctl.bootstrap({ recoveryContext: { mac: 'AA:BB' } });
  console.log('\nperformRecovery never settles');
  check('overlay dismissed', hidden);
  check('state is failed, not stuck in recovering', ctl.getState() === 'failed');
  check('reported the timeout', failedReason === 'timeout_perform_recovery');
}

async function rehydrateHangs() {
  let hidden = false;
  const ctl = create({
    performRehydrate: never,
    onHide: () => { hidden = true; },
    rehydrateTimeoutMs: 150,
  });
  await ctl.bootstrap({ publishing: true });
  console.log('\nperformRehydrate never settles');
  check('overlay dismissed', hidden);
  check('state returned to idle', ctl.getState() === 'idle');
}

async function resumeAfterFailure() {
  let hides = 0;
  const ctl = create({
    performRecovery: never,
    performRehydrate: () => Promise.resolve(),
    onHide: () => { hides++; },
    recoveryTimeoutMs: 150,
  });
  await ctl.bootstrap({ recoveryContext: { mac: 'AA:BB' } });
  await ctl.onResume({ hiddenForMs: 1000 });
  console.log('\nresume still works after a failed recovery');
  check('onResume not blocked by a stuck recovering state', hides >= 2);
  check('state is idle', ctl.getState() === 'idle');
}

async function happyPathUnchanged() {
  let hidden = false;
  const order = [];
  const ctl = create({
    performRecovery: () => { order.push('recover'); return Promise.resolve(); },
    performRehydrate: () => { order.push('rehydrate'); return Promise.resolve(); },
    onPublishingChanged: (cb) => { setTimeout(() => cb({ publishing: true }), 10); return () => {}; },
    onHide: () => { hidden = true; },
    recoveryTimeoutMs: 2000,
  });
  await ctl.bootstrap({ recoveryContext: { mac: 'AA:BB' } });
  console.log('\nnormal recovery still completes');
  check('ran recover then rehydrate', order.join(',') === 'recover,rehydrate');
  check('overlay dismissed', hidden);
  check('state is idle', ctl.getState() === 'idle');
}

async function cancelledRecoveryAdoptsLateLive() {
  let failed = 0, lateLive = 0, stops = 0, sawCancelled = null, uiAfterCancel = 0;
  let publishCb = null;
  const native = { stopSession: () => { stops++; return Promise.resolve(); } };
  const ctl = create({
    performRecovery: async (ctx, token) => {
      await new Promise((r) => setTimeout(r, 300));
      sawCancelled = !!(token && token.cancelled);
      if (!token.cancelled) uiAfterCancel++;
      setTimeout(() => publishCb && publishCb({ publishing: true }), 20);
    },
    onPublishingChanged: (cb) => { publishCb = cb; return () => { if (publishCb === cb) publishCb = null; }; },
    onRecoveryFailed: () => { failed++; },
    onLateLive: () => { lateLive++; },
    recoveryTimeoutMs: 150,
  });
  await ctl.bootstrap({ recoveryContext: { mac: 'AA:BB' } });
  const stateAtFail = ctl.getState();
  await new Promise((r) => setTimeout(r, 450));
  console.log('\nR5: recovery outlives its ceiling, native goes live later');
  check('reported the failure once at the ceiling', failed === 1 && stateAtFail === 'failed');
  check('the still-running recovery saw token.cancelled', sawCancelled === true);
  check('cancelled recovery ran no success UI', uiAfterCancel === 0);
  check('late publishing adopted once', lateLive === 1);
  check('state back to idle after adopt', ctl.getState() === 'idle');
  check('native stop never called', stops === 0);
}

async function slowFirstHrOutsideCeiling() {
  let failed = 0, rehydrated = 0, tailCancelled = null;
  let publishCb = null;
  const ctl = create({
    // Resolves at startSession; the first-HR wait runs detached, longer than the ceiling.
    performRecovery: async (ctx, token) => {
      await new Promise((r) => setTimeout(r, 30));
      setTimeout(() => publishCb && publishCb({ publishing: true }), 10);
      (async () => {
        await new Promise((r) => setTimeout(r, 300));
        tailCancelled = !!token.cancelled;
      })();
    },
    performRehydrate: () => { rehydrated++; return Promise.resolve(); },
    onPublishingChanged: (cb) => { publishCb = cb; return () => { if (publishCb === cb) publishCb = null; }; },
    onRecoveryFailed: () => { failed++; },
    recoveryTimeoutMs: 150,
  });
  await ctl.bootstrap({ recoveryContext: { mac: 'AA:BB' } });
  await new Promise((r) => setTimeout(r, 350));
  console.log('\nR5: a slow first HR after startSession does not trip the ceiling');
  check('no failure reported', failed === 0);
  check('rehydrate ran', rehydrated === 1);
  check('state is idle', ctl.getState() === 'idle');
  check('first-HR tail finished uncancelled, so the resumed toast shows', tailCancelled === false);
}

async function ceilingWhileAlreadyLive() {
  let failed = 0, lateLive = 0;
  const ctl = create({
    performRecovery: never,
    isPublishing: () => true,
    onRecoveryFailed: () => { failed++; },
    onLateLive: () => { lateLive++; },
    recoveryTimeoutMs: 150,
  });
  await ctl.bootstrap({ recoveryContext: { mac: 'AA:BB' } });
  console.log('\nR5: ceiling passes while native already publishes');
  check('no failure message', failed === 0);
  check('adopted the live session', lateLive === 1);
  check('state is idle', ctl.getState() === 'idle');
}

async function restoreBudgets() {
  const B = sandbox.window.HRMLifecycleController.BUDGETS;
  console.log('\nC-2: restore budgets');
  check('status 10 s, recovery 25 s, rehydrate 15 s',
    B.statusReadyMs === 10000 && B.recoveryMs === 25000 && B.rehydrateMs === 15000);
  check('worst case 50 s sits inside the 60 s native fence',
    B.statusReadyMs + B.recoveryMs + B.rehydrateMs === 50000 && 50000 < 60000);
  // Defaults must be the budgets: record the delays the controller arms.
  const delays = [];
  const fakeSetTimeout = (fn, ms) => { delays.push(ms); return setTimeout(fn, 1); };
  const sb2 = { window: {}, setTimeout: fakeSetTimeout, clearTimeout, Promise, Error, console };
  vm.createContext(sb2);
  vm.runInContext(fs.readFileSync(SRC, 'utf8'), sb2, { filename: SRC });
  const ctl = sb2.window.HRMLifecycleController.create({ performRecovery: never });
  await ctl.bootstrap({ recoveryContext: { mac: 'AA:BB' } });
  const ctl2 = sb2.window.HRMLifecycleController.create({ performRehydrate: never });
  await ctl2.bootstrap({ publishing: true });
  check('default recovery ceiling is 25000', delays.includes(25000) && !delays.includes(30000));
  check('default rehydrate ceiling is 15000', delays.includes(15000) && !delays.includes(20000));
}

async function shortHideNoOverlay() {
  let shows = 0, rehydrates = 0;
  const ctl = create({
    onShow: () => { shows++; },
    performRehydrate: () => { rehydrates++; return Promise.resolve(); },
  });
  await ctl.onResume({ hiddenForMs: 10000 });
  const showsShort = shows;
  await ctl.onResume({ hiddenForMs: 61000 });
  console.log('\nH5: overlay only for hides over 60 s');
  check('10 s hide rehydrates silently', rehydrates === 2 && showsShort === 0);
  check('61 s hide shows the overlay', shows === 1);
}

// ---- Engine step 2: recovery adopts the native resume, never starts ----

// Source of a top-level function in hr_monitor.html, brace-matched past strings and comments.
function pageFunction(name) {
  const html = fs.readFileSync(path.join(__dirname, '..', 'hr_monitor.html'), 'utf8');
  const at = html.search(new RegExp('(async\\s+)?function\\s+' + name + '\\s*\\('));
  if (at < 0) throw new Error('function ' + name + ' not found in hr_monitor.html');
  let i = html.indexOf('{', at), depth = 0;
  for (; i < html.length; i++) {
    const c = html[i];
    if (c === '/' && html[i + 1] === '/') { i = html.indexOf('\n', i); continue; }
    if (c === '/' && html[i + 1] === '*') { i = html.indexOf('*/', i) + 1; continue; }
    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      while (j < html.length && html[j] !== c) j += html[j] === '\\' ? 2 : 1;
      i = j; continue;
    }
    if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return html.slice(at, i + 1);
  }
  throw new Error('unbalanced ' + name);
}

function recoverySandbox(resumeResult) {
  const calls = [];
  const store = new Map();
  const sb = {
    calls, store,
    window: {
      HRMNativeHrSession: {
        resumeSession: (o) => { calls.push('resumeSession:' + (o && o.origin)); return Promise.resolve(resumeResult); },
        startSession: () => { calls.push('startSession'); return Promise.resolve({}); },
        connect: () => { calls.push('connect'); return Promise.resolve({}); },
      },
    },
    sessionStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) },
    buildNativeDevice: (d) => ({ name: d.name, gatt: { connected: false } }),
    setStatus: () => {}, resetLiveDataBuffers: () => calls.push('reset'), evictSelfFromBroadcasters: () => {},
    refreshFromEngine: (why) => { calls.push('refresh:' + why); return Promise.resolve(null); },
    nativeDeadline: (p) => p, NATIVE_START_MS: 40000, NATIVE_CONNECT_MS: 10000,
    rotateSenderId: () => calls.push('rotate'), getDeviceIdentity: () => { calls.push('getDeviceIdentity'); return { id: 'zzzzzz', label: 'x' }; },
    getOrCreateBroadcastKey: () => 'k', Promise, Error,
  };
  vm.createContext(sb);
  vm.runInContext(pageFunction('recoverNativeSession'), sb);
  return sb;
}

async function recoveryAdoptsNeverStarts() {
  console.log('\nstep 2: recovery calls resumeSession and never startSession');
  const body = pageFunction('recoverNativeSession');
  check('recoverNativeSession names no startSession or connect', !/\.startSession\s*\(|\.connect\s*\(/.test(body));
  const sb = recoverySandbox({ resumed: true, senderId: 'b0b0b0', senderLabel: 'Android Chrome', sessionStartMs: 123 });
  const ok = await sb.recoverNativeSession({ mac: 'AA:BB', sessionStartMs: 123 }, { cancelled: false });
  check('resumeSession called once with origin js', sb.calls.filter(c => c.startsWith('resumeSession')).join() === 'resumeSession:js');
  check('no startSession, connect, rotate or fresh identity', !sb.calls.some(c => /^(startSession|connect|rotate|getDeviceIdentity)$/.test(c)));
  check('stale buffers reset before the resume', sb.calls.indexOf('reset') >= 0 && sb.calls.indexOf('reset') < sb.calls.indexOf('resumeSession:js'));
  check('resumed: returns true and adopts the rotated senderId', ok === true && sb.store.get('hr_monitor_device_id') === 'b0b0b0');

  const sb2 = recoverySandbox({ resumed: false, alreadyRunning: true, senderId: 'c1c1c1', senderLabel: 'L' });
  await sb2.recoverNativeSession({ mac: 'AA:BB' }, { cancelled: false });
  check('alreadyRunning adopts its senderId', sb2.store.get('hr_monitor_device_id') === 'c1c1c1' && sb2.store.get('hr_monitor_device_label') === 'L');

  const sbc = recoverySandbox({ resumed: true, senderId: 'f4f4f4' });
  const late = await sbc.recoverNativeSession({ mac: 'AA:BB' }, { cancelled: true });
  check('past the ceiling: returns false and re-pulls the engine (no page-side adopt)', late === false && sbc.calls.includes('refresh:recovery_late'));

  const sb3 = recoverySandbox({ resumed: false, reason: 'not_live' });
  let err = null;
  try { await sb3.recoverNativeSession({ mac: 'AA:BB' }, { cancelled: false }); } catch (e) { err = e && e.message; }
  check('not_live throws not_live (the controller failure path)', err === 'not_live');
}

// The real shim in a vm with a fake plugin that resolves resumeSession and fires NO event.
function shimSandbox(pluginOverrides) {
  const listeners = {};
  const plugin = Object.assign({
    status: () => Promise.resolve({ sessionActive: false, interruptedRecovery: true, recoveryContext: { mac: 'AA:BB' } }),
    addListener: (n, cb) => { listeners[n] = cb; },
    resumeSession: () => Promise.resolve({ resumed: true, senderId: 'd2d2d2', senderLabel: 'L', sessionStartMs: 99, csvFile: 'f.csv' }),
  }, pluginOverrides || {});
  const win = { Capacitor: { isNativePlatform: () => true, Plugins: { NativeHrSession: plugin } } };
  const sb = { window: win, document: { readyState: 'complete', currentScript: null }, console, Promise, setTimeout, clearTimeout };
  vm.createContext(sb);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'mobile', 'src', 'native-hr-session.js'), 'utf8'), sb);
  return { ns: win.HRMNativeHrSession, listeners };
}

async function shimResumeFlipsPublishing() {
  console.log('\n[S4] a shim resumeSession resolution flips publishing so the wait resolves with no event');
  const { ns } = shimSandbox();
  await ns.whenStatusReady();
  let failed = 0, rehydrated = 0;
  const ctl = create({
    performRecovery: () => ns.resumeSession({ origin: 'js' }),
    performRehydrate: () => { rehydrated++; return Promise.resolve(); },
    onPublishingChanged: (cb) => ns.onPublishingChanged(cb),
    isPublishing: () => ns.isPublishing(),
    onRecoveryFailed: () => { failed++; },
    recoveryTimeoutMs: 2000,
  });
  const t0 = Date.now();
  await ctl.bootstrap({ recoveryContext: ns.getRecoveryContext() });
  check('recovery completes without a failure, well inside the ceiling', failed === 0 && rehydrated === 1 && Date.now() - t0 < 1000);
  check('publishing, senderId and start adopted from the result',
    ns.isPublishing() && ns.getActiveSenderId() === 'd2d2d2' && ns.getSessionStartMs() === 99 && ns.getRecoveryContext() === null);

  // The Service resumed first: publishingStarted fired before the page listened, the result is alreadyRunning.
  const s2 = shimSandbox({ resumeSession: () => Promise.resolve({ alreadyRunning: true, senderId: 'e3e3e3' }) });
  await s2.ns.whenStatusReady();
  s2.listeners.publishingStarted({ sessionStartMs: 77, senderId: 'e3e3e3', senderLabel: 'L', origin: 'sticky' });
  check('publishingStarted caches the rotated senderId', s2.ns.getActiveSenderId() === 'e3e3e3');
  let failed2 = 0, rehydrated2 = 0;
  const ctl2 = create({
    performRecovery: () => s2.ns.resumeSession({ origin: 'js' }),
    performRehydrate: () => { rehydrated2++; return Promise.resolve(); },
    onPublishingChanged: (cb) => s2.ns.onPublishingChanged(cb),
    isPublishing: () => s2.ns.isPublishing(),
    onRecoveryFailed: () => { failed2++; },
    recoveryTimeoutMs: 2000,
  });
  const t1 = Date.now();
  await ctl2.bootstrap({ recoveryContext: { mac: 'AA:BB' } });
  check('already publishing before the page listened: recovery resolves with no event and no failure',
    failed2 === 0 && rehydrated2 === 1 && ctl2.getState() === 'idle' && Date.now() - t1 < 1000);
}

(async () => {
  await recoveryAdoptsNeverStarts();
  await shimResumeFlipsPublishing();
  await recoveryHangs();
  await rehydrateHangs();
  await resumeAfterFailure();
  await happyPathUnchanged();
  await cancelledRecoveryAdoptsLateLive();
  await ceilingWhileAlreadyLive();
  await slowFirstHrOutsideCeiling();
  await restoreBudgets();
  await shortHideNoOverlay();
  clearTimeout(watchdog);
  console.log('\n' + (failures === 0 ? 'ALL PASS' : failures + ' FAILED'));
  process.exit(failures === 0 ? 0 : 1);
})();
