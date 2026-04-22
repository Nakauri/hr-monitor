// native-hr-session.js — JS adapter for NativeHrSession Capacitor plugin.
//
// The plugin owns the BLE connection, publishes ticks via its own OkHttp
// WebSocket, writes CSV natively, and uploads to Drive — all outside the
// WebView, so the data path survives Chromium's background-tab JS throttling.
// JS only consumes the 'hr' event to update the live UI while foregrounded.
//
// When active, the rest of hr_monitor.html's publishToRelay / WebSocket
// code becomes a no-op (gated on window.HRMNativeHrSession.isPublishing()).

(function () {
  function setMarker(v) { try { window.__hrMonitorNativeHrSessionRanInit = v; } catch (e) {} }

  function init() {
    const cap = window.Capacitor;
    if (!cap || typeof cap.isNativePlatform !== 'function' || !cap.isNativePlatform()) {
      setMarker('skipped:not-native');
      return;
    }
    const plugin = cap.Plugins && cap.Plugins.NativeHrSession;
    if (!plugin) {
      setMarker('skipped:plugin-missing');
      return;
    }
    setMarker(true);

    let publishing = false;
    let csvFilename = null;
    const hrListeners = [];
    const stateListeners = [];

    // Seed JS-side publishing flag from the real plugin state on every
    // load. Without this, a WebView reload (e.g. from tapping the FGS
    // notification or Android killing the renderer) would leave the flag
    // at false even though the native session is still running, and any
    // UI restore path gated on isPublishing() would never fire.
    try {
      if (typeof plugin.status === 'function') {
        plugin.status().then(function (s) {
          if (s && s.sessionActive) {
            publishing = true;
            csvFilename = s.csvFile || csvFilename;
            for (const cb of stateListeners) {
              try { cb({ ble: !!s.bleConnected, relay: !!s.relayLive, session: true }); } catch (e) {}
            }
          }
        }).catch(function () { /* no-op */ });
      }
    } catch (e) {}

    plugin.addListener('hr', function (data) {
      for (const cb of hrListeners) {
        try { cb(data); } catch (e) { console.warn('[native-hr-session] hr cb:', e); }
      }
    });
    plugin.addListener('state', function (data) {
      for (const cb of stateListeners) {
        try { cb(data); } catch (e) {}
      }
    });

    window.HRMNativeHrSession = {
      isAvailable: true,
      isPublishing: function () { return publishing; },
      getCsvFilename: function () { return csvFilename; },
      scan: function (opts) {
        return plugin.scan(opts || {});
      },
      connect: function (mac) {
        return plugin.connect({ mac: mac });
      },
      startSession: function (opts) {
        return plugin.startSession(opts).then(function (r) {
          publishing = true;
          csvFilename = r && r.csvFile || null;
          return r;
        });
      },
      stopSession: function () {
        return plugin.stopSession().then(function (r) {
          publishing = false;
          return r;
        });
      },
      disconnect: function () { return plugin.disconnect(); },
      status: function () { return plugin.status(); },
      setPrefs: function (prefs) {
        return plugin.setPrefs({ prefs: prefs || {} });
      },
      onHr: function (cb) {
        hrListeners.push(cb);
        return function remove() {
          const i = hrListeners.indexOf(cb);
          if (i >= 0) hrListeners.splice(i, 1);
        };
      },
      onState: function (cb) {
        stateListeners.push(cb);
        return function remove() {
          const i = stateListeners.indexOf(cb);
          if (i >= 0) stateListeners.splice(i, 1);
        };
      },
      /**
       * Render a simple picker modal so the user can choose from scan
       * results. Returns a Promise resolving to { mac, name } or rejecting
       * if the user cancels. The returned promise also carries a `.cancel()`
       * method so callers can abort the scan/picker from outside (e.g. when
       * the user taps a UI-level Cancel while the scan is still running).
       */
      showPicker: function () {
        let cancelFn = null;
        let cancelled = false;
        let backdropEl = null;
        const p = new Promise(function (resolve, reject) {
          cancelFn = function () {
            if (cancelled) return;
            cancelled = true;
            if (backdropEl && backdropEl.parentNode) {
              try { backdropEl.parentNode.removeChild(backdropEl); } catch (e) {}
              backdropEl = null;
            }
            reject(new Error('cancelled'));
          };
          plugin.scan({ timeoutMs: 10000 }).then(function (r) {
            if (cancelled) return;
            const devices = (r && r.devices) || [];
            const hr = devices.filter(function (d) { return d.isHr; });
            const list = hr.length ? hr : devices;
            if (!list.length) { reject(new Error('No devices found')); return; }

            const backdrop = document.createElement('div');
            backdropEl = backdrop;
            backdrop.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.85);z-index:99999;display:flex;align-items:center;justify-content:center;padding:24px;';
            const modal = document.createElement('div');
            modal.style.cssText = 'background:#101010;border:1px solid #1f1f1f;border-radius:14px;padding:20px;max-width:420px;width:100%;color:#d8d8d8;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;';
            modal.innerHTML = '<div style="font-weight:700;font-size:16px;margin-bottom:12px;">Pair a strap</div>';
            const listEl = document.createElement('div');
            listEl.style.cssText = 'display:flex;flex-direction:column;gap:8px;max-height:60vh;overflow-y:auto;';
            list.forEach(function (d) {
              const btn = document.createElement('button');
              btn.style.cssText = 'text-align:left;padding:12px 14px;background:#0a0a0a;border:1px solid #1f1f1f;border-radius:10px;color:inherit;font-family:inherit;font-size:14px;cursor:pointer;';
              const label = document.createElement('div');
              label.style.cssText = 'font-weight:600;';
              label.textContent = d.name || d.mac;
              const meta = document.createElement('div');
              meta.style.cssText = 'font-size:11px;color:#8a8a8a;margin-top:3px;font-family:Consolas,Monaco,monospace;';
              meta.textContent = d.mac + ' • ' + d.rssi + ' dBm' + (d.isHr ? ' • HR strap' : '');
              btn.appendChild(label);
              btn.appendChild(meta);
              btn.addEventListener('click', function () {
                document.body.removeChild(backdrop);
                resolve({ mac: d.mac, name: d.name });
              });
              listEl.appendChild(btn);
            });
            modal.appendChild(listEl);
            const cancel = document.createElement('button');
            cancel.textContent = 'Cancel';
            cancel.style.cssText = 'margin-top:16px;padding:10px 14px;background:transparent;border:1px solid #1f1f1f;border-radius:999px;color:#8a8a8a;font-family:inherit;font-size:13px;cursor:pointer;width:100%;';
            cancel.addEventListener('click', function () {
              document.body.removeChild(backdrop);
              reject(new Error('cancelled'));
            });
            modal.appendChild(cancel);
            backdrop.appendChild(modal);
            document.body.appendChild(backdrop);
          }).catch(reject);
        });
        p.cancel = function () { if (cancelFn) cancelFn(); };
        return p;
      },
    };
    console.info('[native-hr-session] registered.');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
