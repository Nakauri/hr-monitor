// battery-opt.js — wraps @capawesome-team/capacitor-android-battery-optimization
// so hr_monitor.html can check and request exemption from Android's Doze mode.
//
// Without this exemption, backgrounded sessions get throttled (BLE packets
// slowed / paused) after ~5-10 min of screen-off. Foreground service alone
// is not enough on Android 13+.
//
// Plugin accessed via Capacitor.Plugins.BatteryOptimization. See CLAUDE.md for
// why it's not Capacitor.registerPlugin.

try { window.__hrMonitorBatteryOptLoaded = true; } catch (e) {}

(function () {
  function bMark(key, val) { try { window[key] = val; } catch (e) {} }

  function whenReady(cb) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', cb, { once: true });
    } else {
      cb();
    }
  }

  function init(cap) {
    try {
      bMark('__hrMonitorBatteryOptRanInit', true);
      const BatteryOptimization = (cap.Plugins && cap.Plugins.BatteryOptimization) || null;
      bMark('__hrMonitorBatteryOptGotPlugin', !!BatteryOptimization);
      if (!BatteryOptimization) {
        console.error('[battery-opt] plugin missing — bail.');
        return;
      }

      // The plugin returns { enabled: true } when Android IS optimising the
      // app (which is what we want to STOP). "ignoring" reads more naturally
      // in the UI: true = app is exempted / background survives.
      async function isIgnoring() {
        try {
          const r = await BatteryOptimization.isBatteryOptimizationEnabled();
          return !(r && r.enabled);
        } catch (e) {
          console.warn('[battery-opt] isIgnoring failed:', e);
          bMark('__hrMonitorBatteryOptLastError', 'isIgnoring: ' + (e && e.message ? e.message : String(e)));
          return null;
        }
      }

      async function request() {
        try {
          await BatteryOptimization.requestIgnoreBatteryOptimization();
          return true;
        } catch (e) {
          console.warn('[battery-opt] request failed:', e);
          bMark('__hrMonitorBatteryOptLastError', 'request: ' + (e && e.message ? e.message : String(e)));
          return false;
        }
      }

      async function openSettings() {
        try {
          await BatteryOptimization.openBatteryOptimizationSettings();
          return true;
        } catch (e) {
          console.warn('[battery-opt] openSettings failed:', e);
          bMark('__hrMonitorBatteryOptLastError', 'openSettings: ' + (e && e.message ? e.message : String(e)));
          return false;
        }
      }

      window.HRMBatteryOpt = { isIgnoring, request, openSettings, isAvailable: true };
      bMark('__hrMonitorBatteryOptRegistered', true);
      console.info('[battery-opt] wrapper registered.');
    } catch (err) {
      bMark('__hrMonitorBatteryOptLastError', 'outer: ' + (err && err.message ? err.message : String(err)));
      console.error('[battery-opt] unhandled init error:', err);
    }
  }

  whenReady(function () {
    const cap = window.Capacitor;
    if (!cap) { console.info('[battery-opt] no Capacitor bridge — running as web.'); return; }
    const isNative = cap.isNativePlatform && cap.isNativePlatform();
    if (!isNative) { console.info('[battery-opt] not native, skipping.'); return; }
    init(cap);
  });
})();
