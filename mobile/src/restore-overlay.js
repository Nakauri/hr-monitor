// restore-overlay.js — JS shim for the native RestoreOverlay plugin.
// The overlay is shown automatically by MainActivity.onCreate; this shim
// only exposes the hide call. On web (no Capacitor), exposes a no-op so
// page code can call HRMRestoreOverlay.hide() unconditionally.

(function () {
  function init() {
    const cap = window.Capacitor;
    const isNative = !!(cap && cap.isNativePlatform && cap.isNativePlatform());
    const plugin = isNative && cap.Plugins ? cap.Plugins.RestoreOverlay : null;

    window.HRMRestoreOverlay = {
      isAvailable: !!plugin,
      hide: function () {
        if (!plugin || typeof plugin.hide !== 'function') return Promise.resolve();
        try {
          return plugin.hide().catch(function (e) {
            console.warn('[restore-overlay] hide failed:', (e && e.message) || e);
          });
        } catch (e) {
          console.warn('[restore-overlay] hide threw:', e && e.message);
          return Promise.resolve();
        }
      },
    };
  }

  // No DOM access needed — Capacitor's bridge is set up before page
  // scripts run, so window.Capacitor.Plugins is already populated.
  // Init synchronously so window.HRMRestoreOverlay is defined before
  // any inline IIFE in app-home or hr_monitor tries to call .hide().
  init();
})();
