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
    private WebSocket socket;
    private String currentUrl;

    @Override
    public void load() {
        client = new OkHttpClient.Builder()
            // Match the web client's keep-alive expectations (PartyKit
            // server pings ~20 s; we ping back at the same cadence so an
            // idle backgrounded socket stays warm under Doze when the FGS
            // wake lock holds CPU.
            .pingInterval(20, TimeUnit.SECONDS)
            .connectTimeout(10, TimeUnit.SECONDS)
            .readTimeout(0, TimeUnit.SECONDS) // disable read timeout for long-lived sockets
            .build();
    }

    @PluginMethod
    public void open(PluginCall call) {
        String url = call.getString("url");
        if (url == null || url.isEmpty()) {
            call.reject("url required");
            return;
        }
        // One socket at a time. If JS opens a second, close the first.
        closeExistingQuietly("reopen");

        currentUrl = url;
        Request request = new Request.Builder().url(url).build();
        try {
            socket = client.newWebSocket(request, new RelayListener());
            JSObject ret = new JSObject();
            ret.put("opening", true);
            call.resolve(ret);
        } catch (Exception e) {
            Log.e(TAG, "newWebSocket failed", e);
            socket = null;
            currentUrl = null;
            call.reject("open failed: " + e.getMessage());
        }
    }

    @PluginMethod
    public void send(PluginCall call) {
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
    }

    @PluginMethod
    public void close(PluginCall call) {
        closeExistingQuietly("client close");
        currentUrl = null;
        JSObject ret = new JSObject();
        ret.put("closed", true);
        call.resolve(ret);
    }

    @PluginMethod
    public void status(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("connected", socket != null);
        ret.put("url", currentUrl);
        call.resolve(ret);
    }

    private void closeExistingQuietly(String reason) {
        WebSocket s = socket;
        if (s != null) {
            try { s.close(1000, reason); } catch (Exception ignored) {}
        }
        socket = null;
    }

    private void emitState(String state, String detail) {
        JSObject data = new JSObject();
        data.put("state", state);
        if (detail != null) data.put("detail", detail);
        notifyListeners("state", data);
    }

    private void emitMessage(String text) {
        JSObject data = new JSObject();
        data.put("text", text);
        notifyListeners("message", data);
    }

    private class RelayListener extends WebSocketListener {
        @Override
        public void onOpen(WebSocket webSocket, Response response) {
            Log.i(TAG, "WebSocket open: " + currentUrl);
            emitState("open", null);
        }

        @Override
        public void onMessage(WebSocket webSocket, String text) {
            emitMessage(text);
        }

        @Override
        public void onMessage(WebSocket webSocket, ByteString bytes) {
            // Relay frames are always text in our protocol; if something
            // sends binary, decode as UTF-8 so JS gets a string either way.
            emitMessage(bytes.utf8());
        }

        @Override
        public void onClosing(WebSocket webSocket, int code, String reason) {
            // Acknowledge server-initiated close.
            try { webSocket.close(code, reason); } catch (Exception ignored) {}
        }

        @Override
        public void onClosed(WebSocket webSocket, int code, String reason) {
            Log.i(TAG, "WebSocket closed: " + code + " " + reason);
            socket = null;
            emitState("closed", reason);
        }

        @Override
        public void onFailure(WebSocket webSocket, Throwable t, Response response) {
            String msg = t != null && t.getMessage() != null ? t.getMessage() : "unknown";
            Log.w(TAG, "WebSocket failure: " + msg);
            socket = null;
            emitState("error", msg);
        }
    }
}
