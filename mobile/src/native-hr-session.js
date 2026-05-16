// JS adapter for NativeHrSession plugin. Plugin owns BLE/relay/CSV/Drive;
// JS only consumes events for live UI. See docs/architecture.md.

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
    let sessionStartMs = 0;
    // Populated from status().recoveryContext when the native plugin detects
    // a session that survived the previous process. Null otherwise.
    let recoveryContext = null;
    const statusReadyCallbacks = [];
    let statusReady = false;
    const hrListeners = [];
    const stateListeners = [];
    const errorListeners = [];
    const trimMemoryListeners = [];
    const sessionInterruptedListeners = [];
    const publishingListeners = [];

    function setPublishing(next, payload) {
      const prev = publishing;
      publishing = !!next;
      if (publishing && payload) {
        if (payload.csvFile) csvFilename = payload.csvFile;
        if (payload.sessionStartMs) sessionStartMs = payload.sessionStartMs;
      }
      if (!publishing) {
        sessionStartMs = 0;
        csvFilename = null;
      }
      if (prev !== publishing) {
        const evt = { publishing: publishing, payload: payload || null };
        for (const cb of publishingListeners) {
          try { cb(evt); } catch (e) {}
        }
      }
    }

    function fireStatusReady() {
      statusReady = true;
      const cbs = statusReadyCallbacks.splice(0);
      for (const cb of cbs) { try { cb(); } catch (e) {} }
    }

    // Seed from native state so a WebView reload doesn't lose what the
    // process already knows. status() carries both the live snapshot and
    // (when applicable) the recovery context for an interrupted session.
    try {
      if (typeof plugin.status === 'function') {
        plugin.status().then(function (s) {
          if (s && s.sessionActive) {
            publishing = true;
            csvFilename = s.csvFile || csvFilename;
            sessionStartMs = s.sessionStartMs || 0;
            for (const cb of stateListeners) {
              try { cb({ ble: !!s.bleConnected, relay: !!s.relayLive, session: true }); } catch (e) {}
            }
          }
          if (s && s.interruptedRecovery && s.recoveryContext) {
            recoveryContext = s.recoveryContext;
          }
          fireStatusReady();
        }).catch(function () { fireStatusReady(); });
      } else {
        fireStatusReady();
      }
    } catch (e) { fireStatusReady(); }

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
    plugin.addListener('bleError', function (data) {
      console.warn('[native-hr-session] bleError', data);
      for (const cb of errorListeners) {
        try { cb(data); } catch (e) {}
      }
    });
    plugin.addListener('trimMemory', function (data) {
      for (const cb of trimMemoryListeners) {
        try { cb(data); } catch (e) {}
      }
    });
    plugin.addListener('sessionInterrupted', function (data) {
      // Transitional. status().recoveryContext is the authoritative source.
      if (data && !recoveryContext) recoveryContext = data;
      for (const cb of sessionInterruptedListeners) {
        try { cb(data); } catch (e) {}
      }
    });
    plugin.addListener('publishingStarted', function (data) {
      recoveryContext = null;
      setPublishing(true, data);
    });
    plugin.addListener('publishingStopped', function (data) {
      setPublishing(false, data);
    });

    window.HRMNativeHrSession = {
      isAvailable: true,
      isPublishing: function () { return publishing; },
      getCsvFilename: function () { return csvFilename; },
      getSessionStartMs: function () { return sessionStartMs; },
      getRecoveryContext: function () { return recoveryContext; },
      // Transitional. New callers should read getRecoveryContext() directly.
      isInterruptedRecoveryPending: function () { return !!recoveryContext && !publishing; },
      // Resolves once the initial status() IPC has completed. Lets the page
      // bootstrap branch on snapshot state synchronously, no polling.
      whenStatusReady: function () {
        if (statusReady) return Promise.resolve();
        return new Promise(function (resolve) { statusReadyCallbacks.push(resolve); });
      },
      scan: function (opts) {
        return plugin.scan(opts || {});
      },
      connect: function (mac) {
        return plugin.connect({ mac: mac });
      },
      startSession: function (opts) {
        // The publishingStarted event is authoritative for the publishing
        // flag flip. We still update sessionStartMs here for callers that
        // read it from the resolve value's path.
        return plugin.startSession(opts).then(function (r) {
          if (r && r.sessionStartMs) sessionStartMs = r.sessionStartMs;
          else if (opts && opts.resumeSessionStartMs) sessionStartMs = opts.resumeSessionStartMs;
          return r;
        });
      },
      stopSession: function () {
        // publishingStopped event flips the flag; this just forwards the call.
        return plugin.stopSession();
      },
      disconnect: function () { return plugin.disconnect(); },
      status: function () { return plugin.status(); },
      setPrefs: function (prefs) {
        return plugin.setPrefs({ prefs: prefs || {} });
      },
      forceSyncNow: function () {
        if (typeof plugin.forceSyncNow !== 'function') return Promise.resolve({ ok: false, reason: 'shim_missing' });
        return plugin.forceSyncNow().catch(function (e) { return { ok: false, reason: (e && e.message) || String(e) }; });
      },
      setBroadcast: function (enabled) {
        if (typeof plugin.setBroadcast !== 'function') return Promise.resolve();
        return plugin.setBroadcast({ enabled: !!enabled });
      },
      exportCsv: function (filename, csv) {
        if (typeof plugin.exportCsv !== 'function') return Promise.reject(new Error('unsupported'));
        return plugin.exportCsv({ filename: filename, csv: csv });
      },
      setStageThresholds: function (t) {
        return plugin.setStageThresholds(t || {});
      },
      getSessionSnapshot: function (opts) {
        // opts.tailMinutes: trailing minutes only; older APKs ignore.
        return plugin.getSessionSnapshot(opts || {});
      },
      getCacheStats: function () {
        if (typeof plugin.getCacheStats !== 'function') {
          return Promise.resolve({ count: 0, bytes: 0, oldestMs: 0, unsupported: true });
        }
        return plugin.getCacheStats();
      },
      clearLocalCache: function () {
        if (typeof plugin.clearLocalCache !== 'function') {
          return Promise.resolve({ deleted: 0, unsupported: true });
        }
        return plugin.clearLocalCache();
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
      onError: function (cb) {
        errorListeners.push(cb);
        return function remove() {
          const i = errorListeners.indexOf(cb);
          if (i >= 0) errorListeners.splice(i, 1);
        };
      },
      onTrimMemory: function (cb) {
        trimMemoryListeners.push(cb);
        return function remove() {
          const i = trimMemoryListeners.indexOf(cb);
          if (i >= 0) trimMemoryListeners.splice(i, 1);
        };
      },
      onSessionInterrupted: function (cb) {
        sessionInterruptedListeners.push(cb);
        return function remove() {
          const i = sessionInterruptedListeners.indexOf(cb);
          if (i >= 0) sessionInterruptedListeners.splice(i, 1);
        };
      },
      onPublishingChanged: function (cb) {
        publishingListeners.push(cb);
        return function remove() {
          const i = publishingListeners.indexOf(cb);
          if (i >= 0) publishingListeners.splice(i, 1);
        };
      },
      // Picker modal. Returns Promise<{mac, name}> with a .cancel() method.
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
              const rssiPart = d.bonded ? 'paired' : (d.rssi + ' dBm');
              meta.textContent = d.mac + ' • ' + rssiPart + (d.isHr ? ' • HR strap' : '');
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
