// foreground-service.js — wraps @capawesome-team/capacitor-android-foreground-service
// so hr_monitor.html can start/stop/update a persistent notification without
// knowing about Capacitor internals.
//
// Why a foreground service: Android 13+ kills backgrounded WebViews within ~1 min
// of screen off. A foreground service with connectedDevice type keeps the app
// process alive so BLE GATT notifications keep flowing during screen-off, long
// sessions, walks, etc. This is the Pulsoid-style recording unlock.
//
// Plugin methods consumed:
//   startForegroundService({id, title, body, smallIcon, serviceType})
//   updateForegroundService({id, title, body, smallIcon})
//   stopForegroundService()
//   requestPermissions()  → { display: 'granted' | 'denied' | 'prompt' }
//
// Read pattern: we pull the plugin from Capacitor.Plugins directly (NOT
// registerPlugin — see CLAUDE.md for why).

try { window.__hrMonitorFgsLoaded = true; } catch (e) {}

(function () {
  function whenReady(cb) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', cb, { once: true });
    } else {
      cb();
    }
  }
  whenReady(function () {
    const cap = window.Capacitor;
    if (!cap) { console.info('[fgs] no Capacitor bridge — running as web.'); return; }
    const isNative = cap.isNativePlatform && cap.isNativePlatform();
    if (!isNative) { console.info('[fgs] not native, skipping foreground service.'); return; }
    init(cap);
  });
})();

function fgsMark(key, val) { try { window[key] = val; } catch (e) {} }

function init(cap) {
  try {
    fgsMark('__hrMonitorFgsRanInit', true);
    const ForegroundService = (cap.Plugins && cap.Plugins.ForegroundService) || null;
    fgsMark('__hrMonitorFgsGotPlugin', !!ForegroundService);
    if (!ForegroundService) {
      console.error('[fgs] plugin missing — bail.');
      return;
    }

    const NOTIFICATION_ID = 7701;
    const SERVICE_TYPE_CONNECTED_DEVICE = 16;
    let started = false;
    let lastTitle = '';
    let lastBody = '';

    // Throttle updateForegroundService to 1 Hz max — HR chars fire at ~1 Hz
    // already and hammering NotificationManager any faster is wasted CPU
    // (per battery research). Store the latest values and flush on an
    // interval or on stop.
    let pendingUpdate = null;
    let updateTimer = null;
    function flushPending() {
      if (!started || !pendingUpdate) return;
      const { title, body } = pendingUpdate;
      pendingUpdate = null;
      if (title === lastTitle && body === lastBody) return;
      lastTitle = title; lastBody = body;
      try {
        ForegroundService.updateForegroundService({
          id: NOTIFICATION_ID,
          title,
          body,
          smallIcon: 'ic_stat_hr',
        });
      } catch (e) { console.warn('[fgs] update failed:', e); }
    }

    async function start(initialTitle, initialBody) {
      if (started) return true;
      try {
        await ForegroundService.requestPermissions();
      } catch (e) { /* already granted or user declined, non-fatal */ }
      try {
        await ForegroundService.startForegroundService({
          id: NOTIFICATION_ID,
          title: initialTitle || 'HR Monitor',
          body: initialBody || 'Recording',
          smallIcon: 'ic_stat_hr',
          serviceType: SERVICE_TYPE_CONNECTED_DEVICE,
        });
        started = true;
        lastTitle = initialTitle || 'HR Monitor';
        lastBody = initialBody || 'Recording';
        updateTimer = setInterval(flushPending, 1000);
        fgsMark('__hrMonitorFgsStarted', true);
        return true;
      } catch (e) {
        console.error('[fgs] start failed:', e);
        fgsMark('__hrMonitorFgsLastError', 'start: ' + (e && e.message ? e.message : String(e)));
        return false;
      }
    }

    async function stop() {
      if (!started) return;
      try { await ForegroundService.stopForegroundService(); }
      catch (e) { console.warn('[fgs] stop failed:', e); }
      started = false;
      lastTitle = lastBody = '';
      pendingUpdate = null;
      if (updateTimer) { clearInterval(updateTimer); updateTimer = null; }
      fgsMark('__hrMonitorFgsStarted', false);
    }

    function update(title, body) {
      if (!started) return;
      pendingUpdate = { title, body };
    }

    function isStarted() { return started; }

    window.HRMForegroundService = { start, stop, update, isStarted };
    fgsMark('__hrMonitorFgsRegistered', true);
    console.info('[fgs] foreground service wrapper registered.');
  } catch (err) {
    fgsMark('__hrMonitorFgsLastError', 'outer: ' + (err && err.message ? err.message : String(err)));
    console.error('[fgs] unhandled error in init:', err);
  }
}
