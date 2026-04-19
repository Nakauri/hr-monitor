// Capacitor bootstrap — loaded first (before ble-adapter.js) so the
// Capacitor runtime is present when the adapter asks whether it's running
// on a native platform.
//
// Capacitor 6's own runtime is auto-injected into the WebView by Capacitor
// itself, so this file is mostly documentation + a safety check that warns
// loudly in the console if the adapter ends up running in a vanilla browser
// (where it would silently no-op).

(function() {
  'use strict';
  const isNative = !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
  if (!isNative) {
    // This file is ONLY bundled into the Capacitor build's www/, so seeing
    // it in a vanilla browser means someone served mobile/www/ from a web
    // server. The BLE adapter will be a no-op; the site will still render
    // but Connect strap won't work.
    console.info('[hr-monitor] Capacitor runtime not detected — ble-adapter will stay dormant.');
  } else {
    console.info('[hr-monitor] Capacitor native detected:', window.Capacitor.getPlatform());
  }
})();
