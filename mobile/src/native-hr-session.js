// JS adapter for NativeHrSession plugin. Plugin owns BLE/relay/CSV/Drive;
// JS only consumes events for live UI. See docs/architecture.md.

(function () {
  function setMarker(v) { try { window.__hrMonitorNativeHrSessionRanInit = v; } catch (e) {} }

  // data-mode="reader" (the viewer): local segment reads only. No status() seed, no event
  // listeners, no session controls, so nothing monitor-only runs on that page.
  const shimEl = document.currentScript;
  const readerMode = !!(shimEl && shimEl.getAttribute('data-mode') === 'reader');

  function segmentReads(plugin) {
    return {
      // {fromMs?, toMs?} -> {segments: [{name, base, size, mtime, open}]}; size is the last-LF length.
      listSegments: function (opts) {
        if (typeof plugin.listSegments !== 'function') return Promise.reject(new Error('unsupported'));
        return plugin.listSegments(opts || {});
      },
      // name -> {name, text, size, open, truncated}; text ends at the segment's last LF.
      readSegment: function (name) {
        if (typeof plugin.readSegment !== 'function') return Promise.reject(new Error('unsupported'));
        return plugin.readSegment({ name: name });
      },
    };
  }

  function initReader() {
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
    const reads = segmentReads(plugin);
    window.HRMNativeHrSession = {
      isAvailable: true,
      mode: 'reader',
      listSegments: reads.listSegments,
      readSegment: reads.readSegment,
    };
    setMarker('reader');
    console.info('[native-hr-session] registered (reader).');
  }

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

    // The engine's truth, pulled by status() and pushed by events. Either channel can be lost (a reply
    // dropped by the bridge, an event fired before any listener), so every event re-pulls and a pull
    // retries until it settles. The page reads only this; it keeps no session copy of its own.
    const snapshot = {
      sessionActive: false, linkState: 'none', linkUp: false, bleConnected: false, relayLive: false,
      senderId: null, senderLabel: null, sessionStartMs: 0, csvFile: null, posture: null, generation: 0,
      targetMac: null, strapName: null, lastHrAtMs: 0, interruptedRecovery: false, recoveryContext: null,
    };
    const STATUS_ATTEMPT_MS = 5000;
    const STATUS_BACKOFF_MS = [1000, 2000, 4000, 8000];
    const SEED_DEBOUNCE_MS = 200;
    let everApplied = false;
    let reqSeq = 0;
    let lastAppliedReq = 0;
    // Bumped by every event and local mutation; a reply to a request sent before it is stale.
    let epoch = 0;
    let cycle = null;
    let seedAgain = null;
    let seedTimer = null;
    let refreshWaiters = [];
    const statusReadyCallbacks = [];
    const hrListeners = [];
    const stateListeners = [];
    const errorListeners = [];
    const trimMemoryListeners = [];
    const sessionInterruptedListeners = [];
    const publishingListeners = [];
    const snapshotListeners = [];

    // Timers through one pair so a host without setTimeout (a bare test vm) still seeds once.
    function later(fn, ms) { return typeof setTimeout === 'function' ? setTimeout(fn, ms) : null; }
    function cancel(t) { if (t != null && typeof clearTimeout === 'function') clearTimeout(t); }

    function log(msg, data) {
      try { if (window.HRMLog && window.HRMLog.event) window.HRMLog.event(msg, data); } catch (e) {}
    }
    function copy() { return Object.assign({}, snapshot); }
    function emitTo(list, arg, arg2) {
      for (const cb of list.slice()) { try { cb(arg, arg2); } catch (e) {} }
    }

    // One fan-out for every change: publishing listeners on a flip, snapshot listeners always.
    function changed(prevActive, reason, payload) {
      if (prevActive !== snapshot.sessionActive) {
        emitTo(publishingListeners, { publishing: snapshot.sessionActive, payload: payload || null, reason: reason });
      }
      emitTo(snapshotListeners, copy(), reason);
    }

    function clearSession() {
      snapshot.sessionActive = false;
      snapshot.linkState = 'none';
      snapshot.senderId = null;
      snapshot.senderLabel = null;
      snapshot.sessionStartMs = 0;
      snapshot.csvFile = null;
      snapshot.posture = null;
      snapshot.linkUp = false;
    }

    // Local truth from an event or a call result; a status() in flight from before it is now stale.
    function merge(fields, reason, payload) {
      const prev = snapshot.sessionActive;
      epoch++;
      Object.assign(snapshot, fields);
      if (!snapshot.sessionActive) clearSession();
      changed(prev, reason, payload);
      scheduleSeed(reason);
    }

    function applyStatus(s, reqId, reqEpoch) {
      if (!s || reqId <= lastAppliedReq) return 'older';
      if (reqEpoch !== epoch) return 'stale';
      lastAppliedReq = reqId;
      const prev = snapshot.sessionActive;
      const active = !!s.sessionActive;
      snapshot.sessionActive = active;
      snapshot.bleConnected = !!s.bleConnected;
      snapshot.linkUp = typeof s.linkUp === 'boolean' ? s.linkUp : !!s.bleConnected;
      snapshot.relayLive = !!s.relayLive;
      // An older APK sends no linkState: a handle means recording, else reconnecting.
      snapshot.linkState = typeof s.linkState === 'string' ? s.linkState
        : (active ? (s.bleConnected ? 'recording' : 'reconnecting') : 'none');
      snapshot.generation = s.generation || 0;
      snapshot.interruptedRecovery = !!s.interruptedRecovery;
      snapshot.recoveryContext = s.interruptedRecovery ? (s.recoveryContext || snapshot.recoveryContext || null) : null;
      if (active) {
        snapshot.senderId = s.senderId || null;
        snapshot.senderLabel = s.senderLabel || null;
        snapshot.sessionStartMs = s.sessionStartMs || 0;
        snapshot.csvFile = s.csvFile || null;
        snapshot.posture = s.posture || null;
        snapshot.targetMac = s.targetMac || null;
        snapshot.strapName = s.strapName || null;
        snapshot.lastHrAtMs = s.lastHrAtMs || 0;
      } else {
        clearSession();
      }
      const first = !everApplied;
      everApplied = true;
      emitTo(stateListeners, { ble: snapshot.bleConnected, relay: snapshot.relayLive, session: active });
      changed(prev, 'status', s);
      if (first) {
        const cbs = statusReadyCallbacks.splice(0);
        for (const cb of cbs) { try { cb(); } catch (e) {} }
      }
      return 'applied';
    }

    function finishCycle(c) {
      if (c.done) return;
      c.done = true;
      cancel(c.timer);
      cancel(c.retry);
      cycle = null;
      if (seedAgain != null) {
        const why = seedAgain;
        seedAgain = null;
        seed(why);
        return;
      }
      const ws = refreshWaiters.splice(0);
      for (const w of ws) { try { w(copy()); } catch (e) {} }
    }

    // One attempt of a cycle: a 5 s ceiling, then 1, 2, 4, 8 s backoff (8 s thereafter) until one settles.
    // A late reply from an earlier attempt still counts; replies are ordered by request id.
    function attempt(c) {
      if (c.done) return;
      const reqId = ++reqSeq;
      const reqEpoch = epoch;
      const n = c.attempts++;
      const t0 = Date.now();
      let over = false;
      const next = function (why) {
        if (over || c.done) return;
        over = true;
        cancel(c.timer); c.timer = null;
        const wait = STATUS_BACKOFF_MS[Math.min(n, STATUS_BACKOFF_MS.length - 1)];
        log(why === 'timeout' ? 'status timeout' : 'status failed', { seq: reqId, attempt: n + 1, retryMs: wait, reason: c.reason });
        c.retry = later(function () { c.retry = null; attempt(c); }, wait);
      };
      if (n === 0) c.firstReq = reqId;
      c.timer = later(function () { next('timeout'); }, STATUS_ATTEMPT_MS);
      let p;
      try { p = plugin.status({ seq: reqId, trace: c.reason !== 'heartbeat' }); } catch (e) { p = Promise.reject(e); }
      Promise.resolve(p).then(function (s) {
        const ms = Date.now() - t0;
        if (reqId === firstStatusReq) status1 = { settled: true, ms: ms };
        if (n > 0 || ms > 1000 || !everApplied || over) log('status reply ms=' + ms, { seq: reqId, attempt: n + 1, late: over, reason: c.reason });
        if (c.done) { applyStatus(s, reqId, reqEpoch); return; }
        const r = applyStatus(s, reqId, reqEpoch);
        if (r === 'stale') { if (seedAgain == null) seedAgain = c.reason; }
        finishCycle(c);
      }, function () {
        next('failed');
      });
    }

    function seed(reason) {
      if (cycle) {
        if (seedAgain == null) seedAgain = reason;
        return;
      }
      cycle = { reason: reason, attempts: 0, done: false, timer: null, retry: null };
      attempt(cycle);
    }

    function scheduleSeed(reason) {
      if (seedTimer) return;
      seedTimer = later(function () { seedTimer = null; seed(reason); }, SEED_DEBOUNCE_MS);
    }

    // Discriminator for the lost first reply (FABLE-DETANGLE A1): a throwaway ping goes first, then
    // status(); which one settled is reported to native once per page load as a bridge_ping line.
    let firstStatusReq = 0;
    let status1 = { settled: false, ms: null };
    const probe = { settled: null, ms: null };
    if (typeof plugin.ping === 'function') {
      const tp = Date.now();
      probe.settled = false;
      try {
        Promise.resolve(plugin.ping({ seq: 0 })).then(function () { probe.settled = true; probe.ms = Date.now() - tp; }, function () {});
      } catch (e) {}
    }
    firstStatusReq = reqSeq + 1;
    seed('load');
    later(function () {
      const note = 'discriminator probe=' + (probe.settled == null ? 'none' : (probe.settled ? 'settled' : 'lost'))
        + ' probe_ms=' + (probe.ms == null ? '-' : probe.ms)
        + ' status1=' + (status1.settled ? 'settled' : 'lost') + ' status1_ms=' + (status1.ms == null ? '-' : status1.ms);
      log('bridge ' + note);
      if (typeof plugin.ping === 'function') {
        try { Promise.resolve(plugin.ping({ seq: 99, note: note })).catch(function () {}); } catch (e) {}
      }
    }, 10000);

    plugin.addListener('hr', function (data) {
      for (const cb of hrListeners) {
        try { cb(data); } catch (e) { console.warn('[native-hr-session] hr cb:', e); }
      }
    });
    plugin.addListener('state', function (data) {
      if (data) {
        const f = {};
        if (typeof data.ble === 'boolean') f.bleConnected = data.ble;
        if (typeof data.linkUp === 'boolean') f.linkUp = data.linkUp;
        if (typeof data.relay === 'boolean') f.relayLive = data.relay;
        // A state event can only end a session; a late one emitted before a stop must not revive it.
        if (data.session === false) f.sessionActive = false;
        if (typeof data.linkState === 'string') f.linkState = data.linkState;
        merge(f, 'event:state', data);
      }
      emitTo(stateListeners, data);
    });
    plugin.addListener('linkState', function (data) {
      if (!data || typeof data.to !== 'string') return;
      const f = { linkState: data.to };
      if (data.generation) f.generation = data.generation;
      merge(f, 'event:linkState', data);
    });
    plugin.addListener('bleError', function (data) {
      console.warn('[native-hr-session] bleError', data);
      emitTo(errorListeners, data);
    });
    plugin.addListener('trimMemory', function (data) {
      emitTo(trimMemoryListeners, data);
    });
    plugin.addListener('sessionInterrupted', function (data) {
      // Transitional. status().recoveryContext is the authoritative source.
      if (data && !snapshot.recoveryContext) snapshot.recoveryContext = data;
      emitTo(sessionInterruptedListeners, data);
      scheduleSeed('event:sessionInterrupted');
    });
    plugin.addListener('publishingStarted', function (data) {
      const f = { sessionActive: true, recoveryContext: null, interruptedRecovery: false };
      if (data && data.senderId) f.senderId = data.senderId;
      if (data && data.senderLabel) f.senderLabel = data.senderLabel;
      if (data && data.sessionStartMs) f.sessionStartMs = data.sessionStartMs;
      if (data && data.csvFile) f.csvFile = data.csvFile;
      merge(f, 'event:publishingStarted', data);
    });
    plugin.addListener('publishingStopped', function (data) {
      merge({ sessionActive: false }, 'event:publishingStopped', data);
    });

    // A start, resume or stop result is truth as of its resolve.
    function adoptResult(r, reason) {
      if (!r) return;
      const f = { sessionActive: true, recoveryContext: null, interruptedRecovery: false };
      // The engine's start counts as recording and a resume as resuming; the next status() confirms.
      if (r.started && !r.alreadyRunning) f.linkState = 'recording';
      else if (r.resumed) f.linkState = 'resuming';
      if (r.senderId) f.senderId = r.senderId;
      if (r.senderLabel) f.senderLabel = r.senderLabel;
      if (r.sessionStartMs) f.sessionStartMs = r.sessionStartMs;
      if (r.csvFile) f.csvFile = r.csvFile;
      merge(f, reason, r);
    }

    const reads = segmentReads(plugin);
    window.HRMNativeHrSession = {
      isAvailable: true,
      mode: 'full',
      listSegments: reads.listSegments,
      readSegment: reads.readSegment,
      getSnapshot: copy,
      // cb(snapshot, reason) on every change: each event, each applied status(), each call result.
      onSnapshot: function (cb) {
        snapshotListeners.push(cb);
        return function remove() {
          const i = snapshotListeners.indexOf(cb);
          if (i >= 0) snapshotListeners.splice(i, 1);
        };
      },
      // Re-pull now (retrying until settled); resolves with the snapshot after that pull.
      refresh: function (reason) {
        // The heartbeat never waits: on a wedged bridge, waiters would pile up every 30 s.
        if (reason === 'heartbeat') { seed(reason); return Promise.resolve(copy()); }
        return new Promise(function (resolve) {
          refreshWaiters.push(resolve);
          seed(reason || 'refresh');
        });
      },
      isPublishing: function () { return snapshot.sessionActive; },
      getCsvFilename: function () { return snapshot.csvFile; },
      getSessionStartMs: function () { return snapshot.sessionStartMs; },
      getRecoveryContext: function () { return snapshot.recoveryContext; },
      getActiveSenderId: function () { return snapshot.senderId; },
      getActiveSenderLabel: function () { return snapshot.senderLabel; },
      // Transitional. New callers should read getRecoveryContext() directly.
      isInterruptedRecoveryPending: function () { return !!snapshot.recoveryContext && !snapshot.sessionActive; },
      // Resolves on the first SETTLED status(), never on a timer.
      whenStatusReady: function () {
        if (everApplied) return Promise.resolve();
        return new Promise(function (resolve) { statusReadyCallbacks.push(resolve); });
      },
      scan: function (opts) {
        return plugin.scan(opts || {});
      },
      connect: function (mac) {
        return plugin.connect({ mac: mac });
      },
      // The engine mints the senderId; the page never sends one.
      startSession: function (opts) {
        const o = Object.assign({}, opts || {});
        delete o.senderId;
        return plugin.startSession(o).then(function (r) {
          if (r && (r.started || r.alreadyRunning)) adoptResult(r, 'start');
          return r;
        });
      },
      // Adopts the session native prefs say is live; never starts one.
      resumeSession: function (opts) {
        if (typeof plugin.resumeSession !== 'function') return Promise.reject(new Error('unsupported'));
        return plugin.resumeSession(opts || {}).then(function (r) {
          if (r && (r.resumed || r.alreadyRunning)) adoptResult(r, 'resume');
          return r;
        });
      },
      stopSession: function () {
        return plugin.stopSession().then(function (r) {
          merge({ sessionActive: false }, 'stop', r);
          return r;
        });
      },
      disconnect: function () { return plugin.disconnect(); },
      // A direct pull; its answer lands in the snapshot like any other.
      status: function () {
        const reqId = ++reqSeq;
        const reqEpoch = epoch;
        return plugin.status({ seq: reqId, trace: true }).then(function (s) {
          applyStatus(s, reqId, reqEpoch);
          return s;
        });
      },
      setPrefs: function (prefs) {
        return plugin.setPrefs({ prefs: prefs || {} });
      },
      forceSyncNow: function () {
        if (typeof plugin.forceSyncNow !== 'function') return Promise.resolve({ ok: false, reason: 'shim_missing' });
        return plugin.forceSyncNow().catch(function (e) { return { ok: false, reason: (e && e.message) || String(e) }; });
      },
      hasOverlayPermission: function () {
        if (typeof plugin.hasOverlayPermission !== 'function') return Promise.resolve({ granted: false });
        return plugin.hasOverlayPermission().catch(function () { return { granted: false }; });
      },
      requestOverlayPermission: function () {
        if (typeof plugin.requestOverlayPermission !== 'function') return Promise.resolve({ opened: false });
        return plugin.requestOverlayPermission().catch(function () { return { opened: false }; });
      },
      startFloatingOverlay: function () {
        if (typeof plugin.startFloatingOverlay !== 'function') return Promise.resolve({ ok: false, reason: 'shim_missing' });
        return plugin.startFloatingOverlay().catch(function (e) { return { ok: false, reason: (e && e.message) || String(e) }; });
      },
      stopFloatingOverlay: function () {
        if (typeof plugin.stopFloatingOverlay !== 'function') return Promise.resolve({ ok: false, reason: 'shim_missing' });
        return plugin.stopFloatingOverlay().catch(function (e) { return { ok: false, reason: (e && e.message) || String(e) }; });
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
      // Fire and forget: a fact row (marker, posture, symptom, warning, ectopic) in the native v2 segment.
      logFact: function (kind, opts) {
        if (typeof plugin.logFact !== 'function') return;
        const o = opts || {};
        const payload = { kind: kind, tsMs: Math.round(Number.isFinite(o.tsMs) ? o.tsMs : Date.now()) };
        if (o.text != null) payload.text = String(o.text);
        if (Number.isFinite(o.value)) payload.value = o.value;
        // A status() already in flight carries the older posture: bump the epoch so it reads as stale.
        if (kind === 'posture' && o.text != null && snapshot.sessionActive) { snapshot.posture = String(o.text); epoch++; }
        try { plugin.logFact(payload).catch(() => {}); } catch (e) {}
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

  const start = readerMode ? initReader : init;
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }
})();
