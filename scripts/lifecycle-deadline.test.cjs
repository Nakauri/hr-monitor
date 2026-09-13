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

(async () => {
  await recoveryHangs();
  await rehydrateHangs();
  await resumeAfterFailure();
  await happyPathUnchanged();
  clearTimeout(watchdog);
  console.log('\n' + (failures === 0 ? 'ALL PASS' : failures + ' FAILED'));
  process.exit(failures === 0 ? 0 : 1);
})();
