// Native relay-socket shim.
//
// Routes `new WebSocket(url)` for PartyKit relay URLs through a Capacitor
// plugin backed by OkHttp on the native side. OkHttp runs on its own
// dispatcher threads outside the WebView, so `ws.send()` never gets
// buffered when the Activity is paused (screen off / backgrounded). This
// is the single bug that motivated the native pivot in the first place.
//
// All other WebSocket calls fall through to the browser's native
// implementation, so this shim is non-invasive for anything that isn't
// the relay.
//
// Protocol with NativeRelaySocketPlugin.java:
//   plugin.open({ url, socketId }) → opens socket, fires state event
//   plugin.send({ text })       → enqueues a frame
//   plugin.close({ socketId })  → closes
//   addListener('state', ...)   → { state: 'open'|'closed'|'error', detail?, socketId? }
//   addListener('message', ...) → { text, socketId? }
// Events carrying another socketId are dropped; events without one (older
// APKs) are treated as this socket's own.

(function() {
  if (typeof window === 'undefined') return;

  const markerSet = (state) => { try { window.__hrMonitorNativeRelaySocketRanInit = state; } catch (e) {} };

  const cap = window.Capacitor;
  if (!cap || typeof cap.isNativePlatform !== 'function' || !cap.isNativePlatform()) {
    markerSet('skipped:not-native');
    return;
  }
  const plugin = cap.Plugins && cap.Plugins.NativeRelaySocket;
  if (!plugin) {
    markerSet('skipped:plugin-missing');
    return;
  }
  markerSet(true);

  const RELAY_URL_TEST = /partykit/i;
  const OriginalWebSocket = window.WebSocket;

  function newSocketId() {
    return 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  }

  function NativeRelayWebSocket(url) {
    const ws = this;
    ws.url = url;
    ws.readyState = 0; // CONNECTING
    ws.bufferedAmount = 0;
    ws.protocol = '';
    ws.extensions = '';
    ws.binaryType = 'blob';
    ws.onopen = null;
    ws.onmessage = null;
    ws.onclose = null;
    ws.onerror = null;
    ws._socketId = newSocketId();

    let stateHandle = null;
    let messageHandle = null;
    let closed = false;

    function isOwn(data) {
      return !data.socketId || data.socketId === ws._socketId;
    }

    // Error ends the socket like the browser WebSocket: onerror, then onclose.
    function fail(message) {
      if (ws.readyState === 3) return;
      ws.readyState = 3;
      cleanup();
      if (typeof ws.onerror === 'function') {
        try { ws.onerror({ type: 'error', message: message, target: ws }); } catch (e) {}
      }
      if (typeof ws.onclose === 'function') {
        try { ws.onclose({ type: 'close', code: 1006, reason: message, wasClean: false, target: ws }); } catch (e) {}
      }
    }

    const stateListener = function(data) {
      if (!data || !data.state || !isOwn(data)) return;
      if (ws.readyState === 3) return;
      if (data.state === 'open') {
        ws.readyState = 1;
        if (typeof ws.onopen === 'function') {
          try { ws.onopen({ type: 'open', target: ws }); } catch (e) {}
        }
      } else if (data.state === 'closed') {
        ws.readyState = 3;
        cleanup();
        if (typeof ws.onclose === 'function') {
          try {
            ws.onclose({ type: 'close', code: 1000, reason: data.detail || '', wasClean: true, target: ws });
          } catch (e) {}
        }
      } else if (data.state === 'error') {
        fail(data.detail || 'unknown');
      }
    };

    const messageListener = function(data) {
      if (!data || typeof data.text !== 'string' || !isOwn(data)) return;
      if (ws.readyState === 3) return;
      if (typeof ws.onmessage === 'function') {
        try { ws.onmessage({ type: 'message', data: data.text, target: ws }); } catch (e) {}
      }
    };

    function cleanup() {
      closed = true;
      try { if (stateHandle && stateHandle.remove) stateHandle.remove(); } catch (e) {}
      try { if (messageHandle && messageHandle.remove) messageHandle.remove(); } catch (e) {}
      stateHandle = null;
      messageHandle = null;
    }
    ws._cleanup = cleanup;

    // A handle that resolves after close is removed at once.
    function dropIfClosed(h) {
      if (!closed) return false;
      try { if (h && h.remove) h.remove(); } catch (e) {}
      return true;
    }
    Promise.resolve(plugin.addListener('state', stateListener))
      .then(function(h) { if (!dropIfClosed(h)) stateHandle = h; })
      .catch(function() {});
    Promise.resolve(plugin.addListener('message', messageListener))
      .then(function(h) { if (!dropIfClosed(h)) messageHandle = h; })
      .catch(function() {});

    plugin.open({ url: url, socketId: ws._socketId }).catch(function(e) {
      fail(String(e));
    });
  }

  NativeRelayWebSocket.prototype.send = function(data) {
    if (this.readyState !== 1) {
      // Match the native plugin's contract: drop silently when not OPEN.
      // Previous JS-shim threw on closed sockets which surfaced as
      // unhandled promise rejections in relay code that expects fire-and-
      // forget semantics. Native side returns { queued: false } in the
      // same situation; keeping both consistent removes one drift surface.
      console.debug('[native-relay-socket] send dropped — readyState=' + this.readyState);
      return;
    }
    const text = typeof data === 'string' ? data : (data && typeof data === 'object' ? JSON.stringify(data) : String(data));
    plugin.send({ text: text }).catch(function(e) {
      console.warn('[native-relay-socket] send failed:', e);
    });
  };

  NativeRelayWebSocket.prototype.close = function() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    if (this._cleanup) this._cleanup();
    plugin.close({ socketId: this._socketId }).catch(function() {});
  };

  NativeRelayWebSocket.prototype.addEventListener = function(type, fn) {
    if (type === 'open') this.onopen = fn;
    else if (type === 'message') this.onmessage = fn;
    else if (type === 'close') this.onclose = fn;
    else if (type === 'error') this.onerror = fn;
  };
  NativeRelayWebSocket.prototype.removeEventListener = function(type, fn) {
    if (type === 'open' && this.onopen === fn) this.onopen = null;
    else if (type === 'message' && this.onmessage === fn) this.onmessage = null;
    else if (type === 'close' && this.onclose === fn) this.onclose = null;
    else if (type === 'error' && this.onerror === fn) this.onerror = null;
  };

  NativeRelayWebSocket.CONNECTING = 0;
  NativeRelayWebSocket.OPEN = 1;
  NativeRelayWebSocket.CLOSING = 2;
  NativeRelayWebSocket.CLOSED = 3;

  // Replace the global. PartyKit URLs go through the native plugin;
  // anything else is unchanged.
  function PatchedWebSocket(url, protocols) {
    if (typeof url === 'string' && RELAY_URL_TEST.test(url)) {
      return new NativeRelayWebSocket(url);
    }
    return new OriginalWebSocket(url, protocols);
  }
  PatchedWebSocket.CONNECTING = 0;
  PatchedWebSocket.OPEN = 1;
  PatchedWebSocket.CLOSING = 2;
  PatchedWebSocket.CLOSED = 3;
  PatchedWebSocket.prototype = OriginalWebSocket.prototype;

  window.WebSocket = PatchedWebSocket;
})();
