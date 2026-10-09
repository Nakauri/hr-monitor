package com.nakauri.hrmonitor;

import android.util.Log;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.util.concurrent.TimeUnit;

import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.WebSocket;
import okhttp3.WebSocketListener;
import okio.ByteString;

/**
 * Native WebSocket for the PartyKit relay. The original Capacitor build
 * used the WebView's built-in WebSocket — outbound `ws.send()` calls
 * buffered when the Activity was paused (screen off / app backgrounded),
 * causing the desktop overlay to go silent until the user returned to
 * the app. This plugin runs the socket on OkHttp's own dispatcher
 * threads, completely outside the WebView, so sends are immediate and
 * unaffected by WebView lifecycle state.
 *
 * Single-socket model — only the relay socket goes through here, and
 * the app only ever has one open at a time. Multiple JS callers would
 * collapse onto the same OkHttp socket; the shim keeps that semantically
 * correct because the JS-side WebSocket subclass is also single-instance
 * per session.
 *
 * JS side: see mobile/src/native-relay-socket.js. It monkey-patches
 * window.WebSocket only for partykit URLs, so existing relay code paths
 * in hr_monitor.html are routed through here transparently.
 */
@CapacitorPlugin(name = "NativeRelaySocket")
public class NativeRelaySocketPlugin extends Plugin {
    private static final String TAG = "NativeRelaySocket";

    private OkHttpClient client;
    // Socket identity: OkHttp callbacks from a replaced socket compare against this and bail.
    private volatile WebSocket socket;
    private volatile String socketId;
    private volatile String currentUrl;

    @Override
    public void load() {
        // Shared client — matches NativeHrSessionPlugin's relay socket so
        // both code paths use the same connection pool. See HttpClientHolder.
        client = HttpClientHolder.webSocketClient();
    }

    @PluginMethod
    public void open(PluginCall call) {
        try {
            String url = call.getString("url");
            if (url == null || url.isEmpty()) {
                call.reject("url required");
                return;
            }
            // Missing socketId (older shim): events go out without one.
            String id = call.getString("socketId");
            // One socket at a time. If JS opens a second, close the first.
            String oldId = socketId;
            boolean hadSocket = socket != null;
            closeExistingQuietly("reopen");
            // The replaced socket's callbacks are now dropped, so tell its wrapper here.
            if (hadSocket && oldId != null && !oldId.equals(id)) emitState(oldId, "closed", "replaced");

            currentUrl = url;
            Request request = new Request.Builder().url(url).build();
            synchronized (this) {
                socketId = id;
                socket = client.newWebSocket(request, new RelayListener(id));
            }
            JSObject ret = new JSObject();
            ret.put("opening", true);
            if (id != null) ret.put("socketId", id);
            call.resolve(ret);
        } catch (Throwable t) {
            // 2-arg Log only; the Throwable overload ClassNotFoundExceptions
            // on API 28.
            Log.e(TAG, "newWebSocket failed: " + t);
            socket = null;
            socketId = null;
            currentUrl = null;
            call.reject("open failed: " + t.getMessage());
        }
    }

    @PluginMethod
    public void send(PluginCall call) {
        try {
            String text = call.getString("text");
            if (text == null) {
                call.reject("text required");
                return;
            }
            WebSocket s = socket;
            if (s == null) {
                // Don't reject — the relay JS code expects send() to be a
                // fire-and-forget on a maybe-not-open socket. Drop silently
                // (matching browser WebSocket behavior post-close).
                call.resolve(new JSObject().put("queued", false));
                return;
            }
            boolean queued = s.send(text);
            JSObject ret = new JSObject();
            ret.put("queued", queued);
            call.resolve(ret);
        } catch (Throwable t) {
            call.reject("send failed: " + t.getMessage());
        }
    }

    @PluginMethod
    public void close(PluginCall call) {
        try {
            // A close from a replaced shim socket must not close the live one.
            String id = call.getString("socketId");
            String live = socketId;
            if (id != null && live != null && !id.equals(live)) {
                NativeHrService.logLifecycle(getContext(), "relay_close_ignored stale socketId");
                call.resolve(new JSObject().put("closed", false).put("reason", "not_current"));
                return;
            }
            closeExistingQuietly("client close");
            currentUrl = null;
            JSObject ret = new JSObject();
            ret.put("closed", true);
            call.resolve(ret);
        } catch (Throwable t) {
            call.reject("close failed: " + t.getMessage());
        }
    }

    @PluginMethod
    public void status(PluginCall call) {
        try {
            JSObject ret = new JSObject();
            ret.put("connected", socket != null);
            ret.put("url", currentUrl);
            String id = socketId;
            if (id != null) ret.put("socketId", id);
            call.resolve(ret);
        } catch (Throwable t) {
            call.reject("status failed: " + t.getMessage());
        }
    }

    private synchronized void closeExistingQuietly(String reason) {
        WebSocket s = socket;
        socket = null;
        socketId = null;
        if (s != null) {
            try { s.close(1000, reason); } catch (Throwable ignored) {}
        }
    }

    // Synchronized so a callback racing open() waits for the socket assignment.
    private synchronized boolean isCurrent(WebSocket ws) { return ws == socket; }

    // Clears the live socket only if it is still the one that failed or closed.
    private synchronized boolean releaseIfCurrent(WebSocket ws) {
        if (ws != socket) return false;
        socket = null;
        socketId = null;
        return true;
    }

    private void emitState(String id, String state, String detail) {
        JSObject data = new JSObject();
        data.put("state", state);
        if (detail != null) data.put("detail", detail);
        if (id != null) data.put("socketId", id);
        notifyListeners("state", data);
    }

    private void emitMessage(String id, String text) {
        JSObject data = new JSObject();
        data.put("text", text);
        if (id != null) data.put("socketId", id);
        notifyListeners("message", data);
    }

    private class RelayListener extends WebSocketListener {
        private final String id;
        RelayListener(String id) { this.id = id; }

        @Override
        public void onOpen(WebSocket webSocket, Response response) {
            if (!isCurrent(webSocket)) return;
            Log.i(TAG, "WebSocket open: " + currentUrl);
            emitState(id, "open", null);
        }

        @Override
        public void onMessage(WebSocket webSocket, String text) {
            if (webSocket != socket) return;
            emitMessage(id, text);
        }

        @Override
        public void onMessage(WebSocket webSocket, ByteString bytes) {
            if (webSocket != socket) return;
            // Relay frames are always text in our protocol; if something
            // sends binary, decode as UTF-8 so JS gets a string either way.
            emitMessage(id, bytes.utf8());
        }

        @Override
        public void onClosing(WebSocket webSocket, int code, String reason) {
            // Acknowledge server-initiated close.
            try { webSocket.close(code, reason); } catch (Throwable ignored) {}
        }

        @Override
        public void onClosed(WebSocket webSocket, int code, String reason) {
            if (!releaseIfCurrent(webSocket)) return;
            Log.i(TAG, "WebSocket closed: " + code + " " + reason);
            emitState(id, "closed", reason);
        }

        @Override
        public void onFailure(WebSocket webSocket, Throwable t, Response response) {
            if (!releaseIfCurrent(webSocket)) return;
            String msg = t != null && t.getMessage() != null ? t.getMessage() : "unknown";
            Log.w(TAG, "WebSocket failure: " + msg);
            emitState(id, "error", msg);
        }
    }
}
