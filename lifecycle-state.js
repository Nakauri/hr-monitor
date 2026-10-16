// HR Monitor lifecycle state controller.
//
// Owns the "Restoring session" overlay's visibility from the JS side, owns the
// `html.restoring` class via the onShow/onHide callbacks the page wires in,
// and is the single caller of HRMRestoreOverlay.hide(). Drives recovery flows
// without polling: subscribes to publishingStarted, races a 25 s ceiling, calls
// the page-provided performRecovery hook, and reports failure to the page so it
// can render an actionable error UI.
//
// API:
//   const ctl = HRMLifecycleController.create({
//     hideOverlay,          // () => Promise
//     onShow, onHide,       // () => void; for html.restoring class etc
//     performRecovery,      // async (ctx, token) => void; throws to signal failure
//                           //   token.cancelled turns true once the ceiling passes
//     performRehydrate,     // async () => void; e.g. rehydrate from CSV
//     onPublishingChanged,  // (cb) => unsubscribe; native shim hook
//     isPublishing,         // () => bool; native publishing flag
//     onRecoveryFailed,     // (reason: string) => void; show error UI
//     onLateLive,           // () => void; native went live after the ceiling
//     recoveryTimeoutMs,    // default BUDGETS.recoveryMs; ceiling on performRecovery
//     rehydrateTimeoutMs,   // default BUDGETS.rehydrateMs; ceiling on performRehydrate
//     resumeOverlayMs,      // default 60000; shorter hides rehydrate without the overlay
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
//   failed ── native publishing later ─▶ idle (onLateLive)
//   idle ── bootstrap neither ──────────▶ idle
//   any  ── onResume ──────────────────▶ rehydrating ── done ──▶ idle

(function () {
  // Worst case 10 + 25 + 15 = 50 s, inside the native 60 s overlay fence.
  const BUDGETS = { statusReadyMs: 10000, recoveryMs: 25000, rehydrateMs: 15000 };

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
    const isPublishing = opts.isPublishing || function () { return false; };
    const onRecoveryFailed = opts.onRecoveryFailed || function () {};
    const onLateLive = opts.onLateLive || function () {};
    const recoveryTimeoutMs = typeof opts.recoveryTimeoutMs === 'number' ? opts.recoveryTimeoutMs : BUDGETS.recoveryMs;
    const rehydrateTimeoutMs = typeof opts.rehydrateTimeoutMs === 'number' ? opts.rehydrateTimeoutMs : BUDGETS.rehydrateMs;
    // Same value as MainActivity RESUME_OVERLAY_MIN_STOP_MS (native shows on resume only past it).
    const resumeOverlayMs = typeof opts.resumeOverlayMs === 'number' ? opts.resumeOverlayMs : 60000;
    const log = opts.log || function () {};

    // Page callbacks are supplied by the caller; a throw from one must not
    // strand the controller mid-transition.
    function safeCall(fn, label) {
      try { fn(); } catch (e) { log('lifecycle: ' + label + ' threw: ' + (e && e.message)); }
    }

    let state = 'idle';
    let unsubPublishing = null;
    let pendingRecovery = null;
    let lateLiveUnsub = null;
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

    function readPublishing() {
      try { return !!isPublishing(); } catch (e) { return false; }
    }

    function fireLateLive(source) {
      if (lateLiveUnsub) { try { lateLiveUnsub(); } catch (e) {} lateLiveUnsub = null; }
      if (disposed) return;
      log('lifecycle: native live after recovery ceiling (' + source + ')');
      if (state === 'failed') setState('idle');
      try { onLateLive(); } catch (e) { log('lifecycle: onLateLive threw: ' + (e && e.message)); }
    }

    // A failed recovery keeps running natively; adopt it if it goes live.
    function watchForLateLive() {
      if (lateLiveUnsub) return;
      lateLiveUnsub = onPublishingChanged(function (evt) {
        if (evt && evt.publishing) fireLateLive('event');
      });
    }

    async function runRecovery(ctx) {
      setState('recovering');
      // Cancelling suppresses the page's recovery UI only; native is never stopped.
      const token = { cancelled: false };
      const wait = awaitPublishingOrTimeout();
      // Observe the wait's rejection here so a late timeout (or the cancel
      // below) never reaches unhandledrejection; the try still awaits it.
      wait.catch(function () {});
      try {
        await withDeadline(performRecovery(ctx, token), recoveryTimeoutMs, 'perform_recovery');
        // Already publishing (a native resume that went live before the page listened): no event will come.
        if (readPublishing()) {
          if (pendingRecovery) { try { pendingRecovery.cancel(); } catch (err) {} }
        } else {
          await wait;
        }
        await runRehydrate();
      } catch (e) {
        // If performRecovery threw, `wait` is still pending with a live timer
        // and subscription; cancel it so nothing leaks or fires late.
        if (pendingRecovery) { try { pendingRecovery.cancel(); } catch (err) {} }
        token.cancelled = true;
        const reason = (e && e.message) || 'recovery_failed';
        log('lifecycle: recovery failed: ' + reason);
        dismiss('recovery_failed');
        setState('failed');
        if (readPublishing()) {
          fireLateLive('flag');
        } else {
          try { onRecoveryFailed(reason); } catch (err) {}
          watchForLateLive();
        }
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
      if ((args.hiddenForMs || 0) > resumeOverlayMs) safeCall(onShow, 'onShow');
      await runRehydrate();
    }

    function dispose() {
      disposed = true;
      if (unsubPublishing) { try { unsubPublishing(); } catch (e) {} }
      if (pendingRecovery) { try { pendingRecovery.cancel(); } catch (e) {} }
      if (lateLiveUnsub) { try { lateLiveUnsub(); } catch (e) {} lateLiveUnsub = null; }
    }

    return {
      bootstrap: bootstrap,
      onResume: onResume,
      dispose: dispose,
      getState: function () { return state; },
    };
  }

  const api = { create: create, withDeadline: withDeadline, BUDGETS: BUDGETS };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (typeof window !== 'undefined') {
    window.HRMLifecycleController = api;
  }
})();
