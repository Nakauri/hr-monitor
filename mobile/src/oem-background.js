// oem-background.js — thin JS wrapper around OemBackgroundPlugin. Detects
// the device manufacturer and, on phones with their own background-killer
// layer (Samsung, Xiaomi, Huawei, Oppo, Vivo etc.), exposes a one-tap deep-
// link to the vendor's "Never sleeping apps" / "Auto-start" / "Protected
// apps" settings screen — the real place where the user has to add HR
// Monitor for sessions to survive long screen-off.
//
// Populates window.HRMOem with { vendor, hasKnownBackgroundKiller, openBackgroundSettings }
// plus body class `oem-<vendor>` so CSS can show a vendor-specific button.

try { window.__hrMonitorOemLoaded = true; } catch (e) {}

(function () {
  function oMark(key, val) { try { window[key] = val; } catch (e) {} }

  function whenReady(cb) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', cb, { once: true });
    } else {
      cb();
    }
  }

  async function init(cap) {
    try {
      oMark('__hrMonitorOemRanInit', true);
      const Oem = (cap.Plugins && cap.Plugins.OemBackground) || null;
      oMark('__hrMonitorOemGotPlugin', !!Oem);
      if (!Oem) {
        console.error('[oem] plugin missing — bail.');
        return;
      }

      const LOG = (window.HRMLog && window.HRMLog.event) ? window.HRMLog.event : function () {};
      const LOG_ERR = (window.HRMLog && window.HRMLog.error) ? window.HRMLog.error : function () {};

      let info = { vendor: 'other', hasKnownBackgroundKiller: false };
      try {
        info = await Oem.getManufacturer();
        LOG('oem.detected', info);
      } catch (e) {
        LOG_ERR('oem.detect threw', e && e.message ? e.message : String(e));
      }

      // Tag the body so CSS can reveal the "Add to Never sleeping apps"
      // style button only on phones that actually need it.
      try {
        document.body.classList.add('oem-' + (info.vendor || 'other'));
        if (info.hasKnownBackgroundKiller) {
          document.body.classList.add('has-oem-killer');
        }
      } catch (e) {}

      async function openBackgroundSettings() {
        try {
          const r = await Oem.openBackgroundSettings();
          LOG('oem.openBackgroundSettings', r);
          return !!(r && r.opened);
        } catch (e) {
          const emsg = e && e.message ? e.message : String(e);
          oMark('__hrMonitorOemLastError', 'open: ' + emsg);
          LOG_ERR('oem.openBackgroundSettings threw', emsg);
          return false;
        }
      }

      window.HRMOem = {
        vendor: info.vendor || 'other',
        manufacturer: info.manufacturer || '',
        hasKnownBackgroundKiller: !!info.hasKnownBackgroundKiller,
        openBackgroundSettings,
        isAvailable: true,
      };
      oMark('__hrMonitorOemRegistered', true);
      console.info('[oem] detected:', info.vendor);
    } catch (err) {
      oMark('__hrMonitorOemLastError', 'outer: ' + (err && err.message ? err.message : String(err)));
      console.error('[oem] unhandled init error:', err);
    }
  }

  whenReady(function () {
    const cap = window.Capacitor;
    if (!cap) return;
    const isNative = cap.isNativePlatform && cap.isNativePlatform();
    if (!isNative) return;
    init(cap);
  });
})();
