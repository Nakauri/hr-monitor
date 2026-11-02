// Health Connect bridge (S65a): HealthConnectPlugin through Capacitor.Plugins. Pages call window.__aortiHC.
// available() is false on the web, without the plugin, and until the person connects (aorti_hc_asked); the viewer
// makes no call while it is false. Counters for checks: globalThis.__s65.
(function () {
  'use strict';

  var ASKED = 'aorti_hc_asked';
  // Every key a lost sleep grant deletes, in both pages (they share the hr_monitor_kv store).
  var KEYS = ['hc:sleep', 'hc:sync', 'hc:drive'];
  var COUNT = globalThis.__s65 || (globalThis.__s65 = { status: 0, read: 0, idb: 0, up: 0, down: 0 });

  window.__aortiHealthConnectRanInit = true;

  function log(what, detail) {
    var L = window.HRMLog && window.HRMLog.event;
    if (L) L('hc.' + what, detail);
  }
  function logErr(what, e) {
    var L = window.HRMLog && window.HRMLog.error;
    var msg = e && (e.code || e.message) ? (e.code || e.message) : String(e);
    if (L) L('hc.' + what + ' failed', msg);
    else console.warn('[hc] ' + what + ' failed', msg);
  }

  function plugin() {
    var cap = window.Capacitor;
    if (!cap || !cap.isNativePlatform || !cap.isNativePlatform()) return null;
    return (cap.Plugins && cap.Plugins.HealthConnect) || null;
  }

  function asked() {
    try { return localStorage.getItem(ASKED) === '1'; } catch (e) { return false; }
  }
  function markAsked() {
    try { localStorage.setItem(ASKED, '1'); } catch (e) { logErr('asked flag', e); }
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

  function granted(st) { return !!(st && Array.isArray(st.granted) && st.granted.indexOf('sleep') >= 0); }

  // A status the plugin answered: sleep granted (however it was granted) lets the viewer read; not granted deletes
  // the copies and this phone's own sleep files from the Drive cache. store: { get(k), set(k, v), del(k), deviceId }.
  async function applyStatus(st, store) {
    if (granted(st)) { markAsked(); return false; }
    var drive = null, cache = null;
    try { drive = await store.get('hc:drive'); } catch (e) { logErr('drive state read', e); }
    try { cache = await store.get('sleepdrive'); } catch (e) { logErr('sleep cache read', e); }
    if (cache && cache.files) {
      var own = {}, months = (drive && drive.months) || {};
      for (var m in months) if (months[m] && months[m].id) own[months[m].id] = true;
      var files = {}, dropped = 0;
      for (var id in cache.files) {
        var f = cache.files[id];
        var mine = own[id] || (store.deviceId && f && typeof f.name === 'string' && f.name.slice(-12) === '_' + store.deviceId + '.json');
        if (mine) dropped++; else files[id] = f;
      }
      if (dropped) {
        try { await store.set('sleepdrive', { files: files }); } catch (e) { logErr('sleep cache write', e); }
      }
    }
    for (var i = 0; i < KEYS.length; i++) {
      try { await store.del(KEYS[i]); } catch (e) { logErr('copy delete', e); }
    }
    log('revoked', { sdk: st && st.sdk });
    return true;
  }

  var api = {
    KEYS: KEYS,
    native: native,
    asked: asked,
    granted: granted,
    applyStatus: applyStatus,
    available: function () { return native() && asked(); },
    status: function () {
      return Promise.resolve().then(function () { var p = need(); COUNT.status++; return p.status(); })
        .catch(function (e) { logErr('status', e); throw e; });
    },
    // The first tap marks the person as asked, so the viewer may read from then on.
    request: function (kinds) {
      return Promise.resolve().then(function () {
        var p = need();
        markAsked();
        return p.request({ kinds: kinds });
      }).then(function (r) { log('request', { changed: r && r.changed }); return r; }, function (e) { logErr('request', e); throw e; });
    },
    read: function (kind, from, to) {
      return Promise.resolve().then(function () { var p = need(); COUNT.read++; return p.read({ kind: kind, from: Math.floor(from), to: Math.floor(to) }); })
        .then(function (r) { log('read', { kind: kind, rows: r && r.rows ? r.rows.length : 0 }); return r; }, function (e) { logErr('read', e); throw e; });
    },
    openSettings: function () {
      return Promise.resolve().then(function () { return need().openSettings(); })
        .catch(function (e) { logErr('settings', e); throw e; });
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
