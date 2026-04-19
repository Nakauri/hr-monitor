// wake-lock.js — thin JS wrapper around our custom WakeLockPlugin
// (mobile/android-overlay/app/src/main/java/.../WakeLockPlugin.java).
//
// Why custom: the capawesome foreground-service plugin declares the
// WAKE_LOCK permission but doesn't actually acquire one, so Android's
// Doze mode still throttles CPU after ~5 minutes of screen-off even
// with a valid FGS running. Holding our own PARTIAL_WAKE_LOCK alongside
// the service prevents Light Idle / Deep Doze from choking the BLE
// stream and the WebSocket.

try { window.__hrMonitorWakeLockLoaded = true; } catch (e) {}

(function () {
  function wMark(key, val) { try { window[key] = val; } catch (e) {} }

  function whenReady(cb) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', cb, { once: true });
    } else {
      cb();
    }
  }

  function init(cap) {
    try {
      wMark('__hrMonitorWakeLockRanInit', true);
      const WakeLock = (cap.Plugins && cap.Plugins.WakeLock) || null;
      wMark('__hrMonitorWakeLockGotPlugin', !!WakeLock);
      if (!WakeLock) {
        console.error('[wake-lock] plugin missing — bail.');
        return;
      }

      const LOG = (window.HRMLog && window.HRMLog.event) ? window.HRMLog.event : function () {};
      const LOG_ERR = (window.HRMLog && window.HRMLog.error) ? window.HRMLog.error : function () {};

      async function acquire() {
        try {
          const r = await WakeLock.acquire();
          LOG('wake-lock acquired', r);
          return !!(r && r.held);
        } catch (e) {
          const emsg = e && e.message ? e.message : String(e);
          wMark('__hrMonitorWakeLockLastError', 'acquire: ' + emsg);
          LOG_ERR('wake-lock acquire threw', emsg);
          return false;
        }
      }

      async function release() {
        try {
          await WakeLock.release();
          LOG('wake-lock released');
          return true;
        } catch (e) {
          const emsg = e && e.message ? e.message : String(e);
          wMark('__hrMonitorWakeLockLastError', 'release: ' + emsg);
          LOG_ERR('wake-lock release threw', emsg);
          return false;
        }
      }

      async function isHeld() {
        try {
          const r = await WakeLock.isHeld();
          return !!(r && r.held);
        } catch (e) { return false; }
      }

      window.HRMWakeLock = { acquire, release, isHeld, isAvailable: true };
      wMark('__hrMonitorWakeLockRegistered', true);
      console.info('[wake-lock] wrapper registered.');
    } catch (err) {
      wMark('__hrMonitorWakeLockLastError', 'outer: ' + (err && err.message ? err.message : String(err)));
      console.error('[wake-lock] unhandled init error:', err);
    }
  }

  whenReady(function () {
    const cap = window.Capacitor;
    if (!cap) { console.info('[wake-lock] no Capacitor bridge — web mode.'); return; }
    const isNative = cap.isNativePlatform && cap.isNativePlatform();
    if (!isNative) { console.info('[wake-lock] not native, skipping.'); return; }
    init(cap);
  });
})();
