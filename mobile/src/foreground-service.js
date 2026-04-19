// foreground-service.js — wraps @capawesome-team/capacitor-android-foreground-service
// so hr_monitor.html can start/stop/update a persistent notification without
// knowing about Capacitor internals. Required for screen-off / background /
// multi-hour sessions on Android 13+.
//
// Plugin accessed via Capacitor.Plugins.ForegroundService (NOT registerPlugin
// — see CLAUDE.md for why).

try { window.__hrMonitorFgsLoaded = true; } catch (e) {}

// Everything inside an IIFE — "init" used to be a global function decl and
// collided with drive-auth-native.js's identically-named global, silently
// breaking whichever script loaded second.
(function () {
  function fgsMark(key, val) { try { window[key] = val; } catch (e) {} }

  function whenReady(cb) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', cb, { once: true });
    } else {
      cb();
    }
  }

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
      // Explicit notification channel. Required on API 26+; creating it up-
      // front (not lazily inside startForegroundService) avoids a race with
      // the 5-second "did not call startForeground in time" watchdog on
      // Samsung OneUI 9 / API 28.
      const CHANNEL_ID = 'hr_monitor_fgs';
      let channelCreated = false;
      let started = false;
      let lastTitle = '';
      let lastBody = '';

      // Throttle updateForegroundService to 1 Hz. Updates omit smallIcon
      // (the initial post set it) + smallIcon on every tick would re-resolve
      // the drawable ID in the plugin, wasted work. silent:true keeps the
      // notification from buzzing / pinging every second.
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
            notificationChannelId: CHANNEL_ID,
            title,
            body,
            silent: true,
          });
        } catch (e) { console.warn('[fgs] update failed:', e); }
      }

      const log = (window.HRMLog && window.HRMLog.event) ? window.HRMLog.event : function () {};
      const logErr = (window.HRMLog && window.HRMLog.error) ? window.HRMLog.error : function () {};

      async function start(initialTitle, initialBody) {
        log('fgs.start called', { started, title: initialTitle });
        if (started) return true;
        let permState = 'unknown';
        try {
          const perm = await ForegroundService.requestPermissions();
          fgsMark('__hrMonitorFgsPermission', perm || 'unknown');
          permState = (perm && (perm.display || perm.notifications || perm.postNotifications)) || 'unknown';
          log('fgs.requestPermissions ok', { permState, raw: perm });
        } catch (e) {
          const emsg = e && e.message ? e.message : String(e);
          fgsMark('__hrMonitorFgsPermission', 'error: ' + emsg);
          permState = 'error';
          logErr('fgs.requestPermissions threw', emsg);
        }
        // Gate startForegroundService on POST_NOTIFICATIONS being granted.
        // If denied, Android 14's ForegroundServiceDidNotStartInTimeException
        // watchdog fires on the main thread outside any JS try/catch.
        if (permState !== 'granted' && permState !== 'unknown') {
          fgsMark('__hrMonitorFgsLastError', 'notifications denied — service not started to avoid Android 14 watchdog');
          logErr('fgs.start bailing: notifications denied', permState);
          return false;
        }
        // Create the channel explicitly before startForegroundService so
        // Notification.Builder(context, channelId) always finds it. No-op
        // on API < 26 (plugin handles the version guard).
        if (!channelCreated) {
          try {
            await ForegroundService.createNotificationChannel({
              id: CHANNEL_ID,
              name: 'HR Monitor recording',
              description: 'Keeps the app recording while the screen is off.',
              importance: 2, // LOW — visible but no sound/vibrate
            });
            channelCreated = true;
            log('fgs.createNotificationChannel resolved', { id: CHANNEL_ID });
          } catch (e) {
            const emsg = e && e.message ? e.message : String(e);
            logErr('fgs.createNotificationChannel threw', emsg);
          }
        }
        try {
          // serviceType is intentionally omitted. The declared attribute in
          // AndroidManifest.xml (foregroundServiceType="connectedDevice") is
          // the one that matters on API 29+. Passing serviceType here with a
          // value the plugin's type enum doesn't recognise (8/Location or
          // 128/Microphone only) causes issues on newer Android, and is
          // meaningless on API 28.
          log('fgs.startForegroundService calling', { channel: CHANNEL_ID });
          await ForegroundService.startForegroundService({
            id: NOTIFICATION_ID,
            notificationChannelId: CHANNEL_ID,
            title: initialTitle || 'HR Monitor',
            body: initialBody || 'Recording',
            smallIcon: 'ic_stat_hr',
            silent: true,
          });
          started = true;
          lastTitle = initialTitle || 'HR Monitor';
          lastBody = initialBody || 'Recording';
          updateTimer = setInterval(flushPending, 1000);
          fgsMark('__hrMonitorFgsStarted', true);
          log('fgs.startForegroundService resolved');
          return true;
        } catch (e) {
          const emsg = e && e.message ? e.message : String(e);
          console.error('[fgs] start failed:', e);
          fgsMark('__hrMonitorFgsLastError', 'start: ' + emsg);
          logErr('fgs.startForegroundService threw', emsg);
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

  whenReady(function () {
    const cap = window.Capacitor;
    if (!cap) { console.info('[fgs] no Capacitor bridge — running as web.'); return; }
    const isNative = cap.isNativePlatform && cap.isNativePlatform();
    if (!isNative) { console.info('[fgs] not native, skipping foreground service.'); return; }
    init(cap);
  });
})();
