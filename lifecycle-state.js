// HR Monitor lifecycle state controller.
//
// Owns the "Restoring session" overlay's visibility from the JS side, owns the
// `html.restoring` class via the onShow/onHide callbacks the page wires in,
// and is the single caller of HRMRestoreOverlay.hide(). Drives recovery flows
// without polling: subscribes to publishingStarted, races a 30 s ceiling, calls
// the page-provided performRecovery hook, and reports failure to the page so it
// can render an actionable error UI.
//
// API:
//   const ctl = HRMLifecycleController.create({
//     hideOverlay,          // () => Promise
//     onShow, onHide,       // () => void; for html.restoring class etc
//     performRecovery,      // async (ctx) => void; throws to signal failure
//     performRehydrate,     // async () => void; e.g. rehydrate from CSV
//     onPublishingChanged,  // (cb) => unsubscribe; native shim hook
//     onRecoveryFailed,     // (reason: string) => void; show error UI
//     recoveryTimeoutMs,    // default 30000; ceiling on performRecovery
//     rehydrateTimeoutMs,   // default 20000; ceiling on performRehydrate
//     log,                  // optional logger fn(message)
//   });
//   await ctl.bootstrap({ publishing, recoveryContext });
//   await ctl.onResume({ hiddenForMs });   // from visibilitychange visible
//   ctl.dispose();                          // unwire listeners (tests)
//
// State diagram:
//   idle ── bootstrap publishing:true ──▶ rehydrating ── done ──▶ idle
//   idle ── bootstrap recoveryCtx ──────▶ recovering   ── pub event ──▶ rehydrating
//                                                       └─ timeout/throw ─▶ failed
//   idle ── bootstrap neither ──────────▶ idle
//   any  ── onResume ──────────────────▶ rehydrating ── done ──▶ idle

(function () {
  // Capacitor leaves a call unsettled when its plugin method throws, so an
  // await on one can hang forever. Every such await carries a ceiling.
  function withDeadline(promise, ms, label) {
    return new Promise(function (resolve, reject) {
      let settled = false;
      const timer = setTimeout(function () {
        if (settled) return;
        settled = true;
        reject(new Error('timeout_' + label));
      }, ms);
      Promise.resolve(promise).then(function (v) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(v);
      }, function (e) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(e);
      });
    });
  }

  function create(opts) {
    opts = opts || {};
    const hideOverlay = opts.hideOverlay || function () { return Promise.resolve(); };
    const onShow = opts.onShow || function () {};
    const onHide = opts.onHide || function () {};
    const performRecovery = opts.performRecovery || function () { return Promise.resolve(); };
    const performRehydrate = opts.performRehydrate || function () { return Promise.resolve(); };
    const onPublishingChanged = opts.onPublishingChanged || function () { return function () {}; };
    const onRecoveryFailed = opts.onRecoveryFailed || function () {};
    const recoveryTimeoutMs = typeof opts.recoveryTimeoutMs === 'number' ? opts.recoveryTimeoutMs : 30000;
    const rehydrateTimeoutMs = typeof opts.rehydrateTimeoutMs === 'number' ? opts.rehydrateTimeoutMs : 20000;
    const log = opts.log || function () {};

    // Page callbacks are supplied by the caller; a throw from one must not
    // strand the controller mid-transition.
    function safeCall(fn, label) {
      try { fn(); } catch (e) { log('lifecycle: ' + label + ' threw: ' + (e && e.message)); }
    }

    let state = 'idle';
    let unsubPublishing = null;
    let pendingRecovery = null;
    let disposed = false;

    function setState(next) {
      log('lifecycle: ' + state + ' -> ' + next);
      state = next;
    }

    function dismiss(reason) {
      safeCall(onHide, 'onHide');
      Promise.resolve(hideOverlay()).catch(function (e) {
        log('lifecycle: hideOverlay failed: ' + (e && e.message));
      });
      log('lifecycle: dismissed (' + reason + ')');
    }

    async function runRehydrate() {
      setState('rehydrating');
      try {
        await withDeadline(performRehydrate(), rehydrateTimeoutMs, 'rehydrate');
      } catch (e) {
        log('lifecycle: rehydrate threw: ' + (e && e.message));
      } finally {
        dismiss('rehydrate_complete');
        setState('idle');
      }
    }

    function awaitPublishingOrTimeout() {
      return new Promise(function (resolve, reject) {
        let timer = null;
        let unsub = null;
        function cleanup() {
          if (timer) { clearTimeout(timer); timer = null; }
          if (unsub) { try { unsub(); } catch (e) {} unsub = null; }
        }
        unsub = onPublishingChanged(function (evt) {
          if (evt && evt.publishing) {
            cleanup();
            resolve(evt);
          }
        });
        timer = setTimeout(function () {
          cleanup();
          reject(new Error('recovery_timeout'));
        }, recoveryTimeoutMs);
        pendingRecovery = { cancel: function () { cleanup(); reject(new Error('cancelled')); } };
      });
    }

    async function runRecovery(ctx) {
      setState('recovering');
      const wait = awaitPublishingOrTimeout();
      // Observe the wait's rejection here so a late timeout (or the cancel
      // below) never reaches unhandledrejection; the try still awaits it.
      wait.catch(function () {});
      try {
        await withDeadline(performRecovery(ctx), recoveryTimeoutMs, 'perform_recovery');
        await wait;
        await runRehydrate();
      } catch (e) {
        // If performRecovery threw, `wait` is still pending with a live timer
        // and subscription; cancel it so nothing leaks or fires late.
        if (pendingRecovery) { try { pendingRecovery.cancel(); } catch (err) {} }
        const reason = (e && e.message) || 'recovery_failed';
        log('lifecycle: recovery failed: ' + reason);
        dismiss('recovery_failed');
        setState('failed');
        try { onRecoveryFailed(reason); } catch (err) {}
      } finally {
        pendingRecovery = null;
      }
    }

    async function bootstrap(args) {
      if (disposed) return;
      args = args || {};
      if (args.publishing) {
        log('lifecycle: bootstrap publishing=true');
        await runRehydrate();
      } else if (args.recoveryContext) {
        log('lifecycle: bootstrap recoveryContext present');
        safeCall(onShow, 'onShow');
        await runRecovery(args.recoveryContext);
      } else {
        log('lifecycle: bootstrap cold-start');
        dismiss('cold_start_no_session');
        setState('idle');
      }
    }

    async function onResume(args) {
      if (disposed) return;
      args = args || {};
      if (state === 'recovering') {
        log('lifecycle: onResume during recovery — leaving recovery to complete');
        return;
      }
      safeCall(onShow, 'onShow');
      await runRehydrate();
    }

    function dispose() {
      disposed = true;
      if (unsubPublishing) { try { unsubPublishing(); } catch (e) {} }
      if (pendingRecovery) { try { pendingRecovery.cancel(); } catch (e) {} }
    }

    return {
      bootstrap: bootstrap,
      onResume: onResume,
      dispose: dispose,
      getState: function () { return state; },
    };
  }

  const api = { create: create, withDeadline: withDeadline };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (typeof window !== 'undefined') {
    window.HRMLifecycleController = api;
  }
})();
