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

(async () => {
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
