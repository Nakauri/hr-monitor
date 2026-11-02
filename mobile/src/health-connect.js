// Health Connect bridge (S65a): HealthConnectPlugin through Capacitor.Plugins. Pages call window.__aortiHC.
// available() is false on the web, without the plugin, and until the person taps Connect (aorti_hc_asked); the viewer
// makes no call while it is false. Counters for checks: globalThis.__s65.
(function () {
  'use strict';

  var ASKED = 'aorti_hc_asked';
  var COUNT = globalThis.__s65 || (globalThis.__s65 = { status: 0, read: 0, idb: 0, up: 0, down: 0 });

  window.__aortiHealthConnectRanInit = true;

  function plugin() {
    var cap = window.Capacitor;
    if (!cap || !cap.isNativePlatform || !cap.isNativePlatform()) return null;
    return (cap.Plugins && cap.Plugins.HealthConnect) || null;
  }

  function asked() {
    try { return localStorage.getItem(ASKED) === '1'; } catch (e) { return false; }
  }

  // Android 9 (API 28) is the first that runs Health Connect.
  function androidOk() {
    var m = /Android (\d+)/.exec(navigator.userAgent || '');
    return !!m && +m[1] >= 9;
  }

  function native() { return !!plugin() && androidOk(); }

  function need() {
    var p = plugin();
    if (!p) throw new Error('hc_no_plugin');
    return p;
  }

  var api = {
    native: native,
    asked: asked,
    available: function () { return native() && asked(); },
    status: function () {
      return Promise.resolve().then(function () { var p = need(); COUNT.status++; return p.status(); });
    },
    // The first tap marks the person as asked, so the viewer may read from then on.
    request: function (kinds) {
      return Promise.resolve().then(function () {
        var p = need();
        try { localStorage.setItem(ASKED, '1'); } catch (e) { console.warn('[hc] asked flag not saved', e && e.message); }
        return p.request({ kinds: kinds });
      });
    },
    read: function (kind, from, to) {
      return Promise.resolve().then(function () { var p = need(); COUNT.read++; return p.read({ kind: kind, from: from, to: to }); });
    },
    openSettings: function () {
      return Promise.resolve().then(function () { return need().openSettings(); });
    },
  };

  function init() {
    window.__aortiHealthConnectPlugin = !!plugin();
    window.__aortiHC = api;
  }

  window.__aortiHC = api;
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
