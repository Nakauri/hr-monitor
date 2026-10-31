// Fake Capacitor bridge for the browser checks (moved from the local ux-audit kit so CI can run them):
// scan/connect/startSession answer like a real strap, and synthetic HR ticks flow once a session is live.
// No real health data: every number here is generated.
//   scenario: 'live' | 'not_found' | 'reconnecting' | 'resuming' | 'idle' | 'start' (idle until Start, then live)
//   sessionAgeMs: how long the running session has been going (default 10 min)
//   lostAgoMs: how long ago the last reading came in, for reconnecting, not_found and resuming
//   savedStrap: true seeds the last-strap record (returning user); false = first run
//   signedIn: true seeds a fake aorti_auth_v2 token (demo@example.com) so Start session skips Google sign-in
export function fakeBridge(cfg) {
  return `(() => {
    const cfg = ${JSON.stringify(cfg)};
    if (window.top !== window) return;
    try {
      if (!localStorage.getItem('__ux_seeded')) {
        localStorage.setItem('__ux_seeded', '1');
        if (cfg.savedStrap) localStorage.setItem('hr_monitor_last_strap', JSON.stringify({ name: '808S 0012345', mac: 'AA:BB:CC:DD:00:25' }));
        if (cfg.signedIn) localStorage.setItem('aorti_auth_v2', JSON.stringify({ version: 2, access_token: 'fake-token', expires_at: Date.now() + 36e5, email: 'demo@example.com', scope: '', issued_at: Date.now() }));
      }
    } catch (e) {}
    const LIVE = { sessionActive: true, senderId: 'a1b2c3', senderLabel: 'HR Monitor Android', sessionStartMs: Date.now() - (cfg.sessionAgeMs || 600000), lastHrAtMs: Date.now(),
      csvFile: 'hrv_session_demo.csv', bleConnected: true, linkUp: true, relayLive: true, linkState: 'recording', generation: 2,
      targetMac: 'AA:BB:CC:DD:00:25', strapName: '808S 0012345', posture: 'sitting', interruptedRecovery: false };
    const IDLE = { sessionActive: false, bleConnected: false, relayLive: false, interruptedRecovery: false, linkState: 'none' };
    const lostAt = Date.now() - (cfg.lostAgoMs || 0);
    const NOT_FOUND = Object.assign({}, LIVE, { linkState: 'not_found', linkUp: false, bleConnected: false, lastHrAtMs: lostAt });
    const RECONNECTING = Object.assign({}, LIVE, { linkState: 'reconnecting', linkUp: false, bleConnected: true, lastHrAtMs: lostAt });
    const RESUMING = Object.assign({}, LIVE, { linkState: 'resuming', linkUp: false, bleConnected: false, lastHrAtMs: lostAt });
    const start = { live: LIVE, not_found: NOT_FOUND, reconnecting: RECONNECTING, resuming: RESUMING, idle: IDLE, start: IDLE }[cfg.scenario] || IDLE;
    const F = window.__fake = { states: { LIVE, NOT_FOUND, RECONNECTING, RESUMING, IDLE }, statusCalls: 0, calls: [], listeners: {}, relaySent: [], relayListeners: {}, sockets: [], snapshot: JSON.parse(JSON.stringify(start)) };
    let tickTimer = null, n = 0;
    function startTicks() {
      if (tickTimer) return;
      tickTimer = setInterval(() => {
        n++;
        const hr = Math.round(72 + 6 * Math.sin(n / 9) + (n % 5) - 2);
        const rr = Math.round(60000 / hr);
        const cb = F.listeners.hr; if (cb) cb({ hr, rrIntervals: [rr], timestampMs: Date.now(), contactOff: false });
      }, 1000);
    }
    if (F.snapshot.sessionActive && F.snapshot.linkState === 'recording') startTicks();
    const generic = (name) => new Proxy({}, { get: (_, k) => {
      if (k === 'then') return undefined;
      if (k === 'addListener') return (n, cb) => Promise.resolve({ remove() {} });
      return () => { F.calls.push(name + '.' + String(k)); return Promise.resolve({}); };
    } });
    const hr = {
      addListener: (n, cb) => { F.listeners[n] = cb; return Promise.resolve({ remove() {} }); },
      setRelayOnMobile: (o) => { F.calls.push('setRelayOnMobile:' + o.allow); F.snapshot.relayOnMobile = !!o.allow; return Promise.resolve({ allow: !!o.allow }); },
      setDrivePaused: (o) => { F.calls.push('setDrivePaused:' + o.paused); F.snapshot.drivePaused = !!o.paused; return Promise.resolve({ paused: !!o.paused }); },
      status: () => { F.statusCalls++; return Promise.resolve(JSON.parse(JSON.stringify(F.snapshot))); },
      ping: () => Promise.resolve({ ok: true }),
      scan: () => new Promise((r) => setTimeout(() => r({ devices: [
        { name: '808S 0012345', mac: 'AA:BB:CC:DD:00:25', isHr: true, rssi: -58 },
        { name: 'Polar H10 9A1B2C3D', mac: 'AA:BB:CC:DD:00:26', isHr: true, rssi: -77 } ] }), 1200)),
      connect: () => new Promise((r) => setTimeout(() => r({ connected: true }), 400)),
      startSession: () => {
        F.calls.push('startSession');
        F.snapshot = JSON.parse(JSON.stringify(LIVE)); F.snapshot.sessionStartMs = Date.now();
        setTimeout(startTicks, 300);
        return Promise.resolve({ started: true, senderId: 'a1b2c3', senderLabel: 'HR Monitor Android', sessionStartMs: F.snapshot.sessionStartMs, csvFile: 'hrv_session_demo.csv' });
      },
      stopSession: () => { F.calls.push('stopSession'); clearInterval(tickTimer); tickTimer = null; F.snapshot = JSON.parse(JSON.stringify(IDLE)); return Promise.resolve({ stopped: true }); },
      getSessionSnapshot: () => Promise.resolve({ csv: 'time_min,epoch_ms,hr,rmssd\\n', sessionStartMs: F.snapshot.sessionStartMs || 0 }),
      // The plugin's real reply (NativeHrSessionPlugin.java:486).
      logFact: (o) => { F.calls.push('logFact:' + (o && o.kind)); return Promise.resolve({ written: true }); },
    };
    const hrProxy = new Proxy(hr, { get: (t, k) => (k in t ? t[k] : (k === 'then' ? undefined : () => { F.calls.push('NativeHrSession.' + String(k)); return Promise.resolve({}); })) });
    const relay = {
      addListener: (n, cb) => { (F.relayListeners[n] = F.relayListeners[n] || []).push(cb); return Promise.resolve({ remove() {} }); },
      open: (o) => { F.sockets.push(o.socketId); setTimeout(() => (F.relayListeners.state || []).forEach((cb) => cb({ state: 'open', socketId: o.socketId })), 50); return Promise.resolve({}); },
      send: (o) => { F.relaySent.push(o.text); return Promise.resolve({ queued: true }); },
      close: () => Promise.resolve({}),
    };
    const wake = { acquire: () => Promise.resolve({ held: true }), release: () => Promise.resolve({ held: false }), addListener: () => Promise.resolve({ remove() {} }) };
    const plugins = { NativeHrSession: hrProxy, NativeRelaySocket: relay, WakeLock: wake };
    window.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'android', isPluginAvailable: () => true,
      Plugins: new Proxy({}, { get: (_, k) => plugins[k] || generic(String(k)) }) };
  })();`;
}

// A WebSocket that never leaves the page. With cfg.ticks, it plays synthetic HR ticks (for overlay.html?key=...).
export function fakeWebSocket(cfg = {}) {
  return `(() => {
    const cfg = ${JSON.stringify(cfg)};
    function FakeWS(url) { this.url = url; this.readyState = 0; this.l = {}; const s = this;
      setTimeout(() => { s.readyState = 1; (s.l.open || []).forEach((f) => f({})); if (s.onopen) s.onopen({}); }, 50);
      if (cfg.ticks) { let n = 0; s.t = setInterval(() => { n++; const hr = Math.round(74 + 7 * Math.sin(n / 8));
        const msg = { data: JSON.stringify({ type: 'tick', senderId: 'demo01', senderLabel: 'Demo phone', hr, rmssd: 38 + (n % 7), hrStage: 'stage-normal', rmssdStage: 'stage-normal', palpPerMin: 0, conn: 'live', t: n }) };
        (s.l.message || []).forEach((f) => f(msg)); if (s.onmessage) s.onmessage(msg); }, 1000); } }
    FakeWS.prototype.addEventListener = function (t, f) { (this.l[t] = this.l[t] || []).push(f); };
    FakeWS.prototype.removeEventListener = function () {};
    FakeWS.prototype.send = function () {};
    FakeWS.prototype.close = function () { this.readyState = 3; clearInterval(this.t); };
    FakeWS.CONNECTING = 0; FakeWS.OPEN = 1; FakeWS.CLOSING = 2; FakeWS.CLOSED = 3;
    window.WebSocket = FakeWS;
  })();`;
}
