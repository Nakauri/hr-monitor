// Unit tests for lifecycle-state.js. No DOM, no Capacitor — drives mock
// callbacks through the controller and asserts the visible state transitions.
//
// Run: node scripts/lifecycle-state.test.cjs
// Exits 0 on success, 1 on any failed assertion.

const path = require('path');
const fs = require('fs');
// lifecycle-state.js is loaded as a classic <script> by hr_monitor.html, so
// the repo's "type": "module" package.json would force ESM if we require'd
// it directly. Read + eval in a sandbox that exposes module.exports — the
// IIFE inside the file populates it when module is defined.
const source = fs.readFileSync(path.join(__dirname, '..', 'lifecycle-state.js'), 'utf8');
const sandboxModule = { exports: {} };
new Function('module', 'window', source)(sandboxModule, undefined);
const ctlModule = sandboxModule.exports;

let passed = 0;
let failed = 0;

function eq(actual, expected, label) {
  if (actual === expected) {
    passed++;
    console.log('  ok  ' + label);
  } else {
    failed++;
    console.error('  FAIL ' + label + ': expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual));
  }
}

function tick(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

function mockHarness(extra) {
  extra = extra || {};
  const calls = { hide: 0, show: 0, recovery: 0, rehydrate: 0, failed: [] };
  let publishingCb = null;
  return {
    calls: calls,
    fireFromOutside: function (evt) { if (publishingCb) publishingCb(evt); },
    config: Object.assign({
      hideOverlay: function () { calls.hide++; return Promise.resolve(); },
      onShow: function () { calls.show++; },
      onHide: function () {},
      performRecovery: function (ctx) { calls.recovery++; return Promise.resolve(); },
      performRehydrate: function () { calls.rehydrate++; return Promise.resolve(); },
      onPublishingChanged: function (cb) { publishingCb = cb; return function () { publishingCb = null; }; },
      onRecoveryFailed: function (reason) { calls.failed.push(reason); },
      recoveryTimeoutMs: 50,
      log: function () {},
    }, extra),
  };
}

async function testColdNoSession() {
  console.log('test: cold launch, no session');
  const h = mockHarness();
  const ctl = ctlModule.create(h.config);
  await ctl.bootstrap({ publishing: false, recoveryContext: null });
  eq(h.calls.hide, 1, 'overlay hidden exactly once');
  eq(h.calls.recovery, 0, 'no recovery attempted');
  eq(h.calls.rehydrate, 0, 'no rehydrate attempted');
  eq(ctl.getState(), 'idle', 'state idle after cold start');
}

async function testColdPublishingAlive() {
  console.log('test: cold launch, session already publishing');
  const h = mockHarness();
  const ctl = ctlModule.create(h.config);
  await ctl.bootstrap({ publishing: true, recoveryContext: null });
  eq(h.calls.rehydrate, 1, 'rehydrate ran once');
  eq(h.calls.hide, 1, 'overlay hidden once after rehydrate');
  eq(h.calls.recovery, 0, 'no recovery (publishing already true)');
  eq(ctl.getState(), 'idle', 'state idle after rehydrate');
}

async function testRecoverySuccess() {
  console.log('test: recovery completes when publishingStarted fires');
  const h = mockHarness({
    performRecovery: async function (ctx) {
      h.calls.recovery++;
      setTimeout(function () { h.fireFromOutside({ publishing: true }); }, 10);
    },
  });
  const ctl = ctlModule.create(h.config);
  await ctl.bootstrap({ publishing: false, recoveryContext: { mac: 'AA:BB' } });
  eq(h.calls.show, 1, 'overlay shown for recovery');
  eq(h.calls.recovery, 1, 'recovery hook invoked');
  eq(h.calls.rehydrate, 1, 'rehydrate ran after publishingStarted');
  eq(h.calls.hide, 1, 'overlay dismissed after rehydrate');
  eq(h.calls.failed.length, 0, 'recovery did not fail');
  eq(ctl.getState(), 'idle', 'state idle after success');
}

async function testRecoveryTimeout() {
  console.log('test: recovery times out when publishingStarted never fires');
  const h = mockHarness({
    performRecovery: function () { h.calls.recovery++; return Promise.resolve(); },
    recoveryTimeoutMs: 30,
  });
  const ctl = ctlModule.create(h.config);
  await ctl.bootstrap({ publishing: false, recoveryContext: { mac: 'AA:BB' } });
  eq(h.calls.recovery, 1, 'recovery hook ran');
  eq(h.calls.rehydrate, 0, 'rehydrate did not run');
  eq(h.calls.hide, 1, 'overlay dismissed on timeout');
  eq(h.calls.failed.length, 1, 'failure reported');
  eq(h.calls.failed[0], 'recovery_timeout', 'failure reason is timeout');
  eq(ctl.getState(), 'failed', 'state failed after timeout');
}

async function testRecoveryThrows() {
  console.log('test: recovery hook throwing surfaces as recovery_failed');
  const h = mockHarness({
    performRecovery: function () { h.calls.recovery++; return Promise.reject(new Error('ble_busy')); },
    recoveryTimeoutMs: 1000,
  });
  const ctl = ctlModule.create(h.config);
  await ctl.bootstrap({ publishing: false, recoveryContext: { mac: 'AA:BB' } });
  eq(h.calls.recovery, 1, 'recovery hook ran');
  eq(h.calls.hide, 1, 'overlay dismissed on throw');
  eq(h.calls.failed.length, 1, 'failure reported');
  eq(h.calls.failed[0], 'ble_busy', 'failure reason propagated');
  eq(ctl.getState(), 'failed', 'state failed after throw');
}

async function testResumeFromDim() {
  console.log('test: onResume rehydrates and dismisses');
  const h = mockHarness();
  const ctl = ctlModule.create(h.config);
  await ctl.onResume({ hiddenForMs: 7000 });
  eq(h.calls.rehydrate, 1, 'rehydrate ran on resume');
  eq(h.calls.hide, 1, 'overlay dismissed after resume rehydrate');
}

async function testResumeDuringRecoveryIsIgnored() {
  console.log('test: onResume during active recovery is a no-op');
  let resolveRecovery;
  const recoveryPromise = new Promise(function (r) { resolveRecovery = r; });
  const h = mockHarness({
    performRecovery: function () { h.calls.recovery++; return recoveryPromise; },
    recoveryTimeoutMs: 5000,
  });
  const ctl = ctlModule.create(h.config);
  const boot = ctl.bootstrap({ publishing: false, recoveryContext: { mac: 'AA:BB' } });
  await tick(10);
  eq(ctl.getState(), 'recovering', 'recovery in progress');
  await ctl.onResume({ hiddenForMs: 100 });
  eq(h.calls.rehydrate, 0, 'resume did not steal rehydrate');
  resolveRecovery();
  h.fireFromOutside({ publishing: true });
  await boot;
  eq(ctl.getState(), 'idle', 'state idle after recovery completes');
}

async function main() {
  await testColdNoSession();
  await testColdPublishingAlive();
  await testRecoverySuccess();
  await testRecoveryTimeout();
  await testRecoveryThrows();
  await testResumeFromDim();
  await testResumeDuringRecoveryIsIgnored();
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
}

main().catch(function (e) {
  console.error('test runner crashed:', e);
  process.exit(1);
});
