package com.nakauri.hrmonitor;

import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;

import org.json.JSONException;
import org.json.JSONObject;

import java.util.ArrayDeque;
import java.util.Deque;
import java.util.Iterator;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;
import java.util.concurrent.atomic.AtomicReference;

import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.WebSocket;
import okhttp3.WebSocketListener;
import okio.ByteString;

// Process-scoped recording engine: strap, RR maths, CSV sink, relay, Drive, FGS. No Capacitor types.
public final class HrEngine implements HrDevice.Callback {
    private static final String TAG = "NativeHrSession";

    public interface Listener { void onEvent(String name, JSONObject data); }

    public interface Done<T> {
        void ok(T value);
        void fail(String code);
    }

    // startSessionInternal while a different session is live.
    public static final class AlreadyActiveException extends Exception {
        AlreadyActiveException() { super("already_active"); }
    }

    public static final class Obtained {
        public final HrEngine engine;
        public final boolean created;
        Obtained(HrEngine engine, boolean created) { this.engine = engine; this.created = created; }
    }

    private static volatile HrEngine sInstance;

    // Builds the engine on first call; never seeds session state from prefs.
    public static synchronized Obtained obtain(Context ctx) {
        HrEngine e = sInstance;
        if (e != null) return new Obtained(e, false);
        e = new HrEngine(ctx.getApplicationContext());
        sInstance = e;
        return new Obtained(e, true);
    }

    public static HrEngine get(Context ctx) { return obtain(ctx).engine; }

    // Never creates.
    public static HrEngine peek() { return sInstance; }

    // RMSSD window — rolling 30 s of RR intervals. Matches the JS
    // monitor's `cutoff = now - 0.5` minute window. Brief flushes / vagal
    // bursts / chills show up in the live number; 60 s would be steadier
    // but hides the events this app is built to surface.
    // PARITY CRITICAL — see scripts/rmssd-parity.test.js.
    private static final long RR_WINDOW_MS = 30_000L;
    // SDNN 5-min rolling window. Clinical short-term HRV reference.
    private static final long RR_WINDOW_5MIN_MS = 300_000L;
    // Buffers for the overlay charts. livePoints = 45 s of instantaneous
    // per-beat BPM; trend = 3 min of per-second HR + RMSSD. These match
    // what hr_monitor.html's broadcastTick emits so overlay.html renders
    // identically whether the sender is the web app or the native plugin.
    private static final long LIVE_WINDOW_MS = 45_000L;
    private static final long TREND_WINDOW_MS = 180_000L;
    // Drive upload cadence — every 30 s. Same data pace as the JS auto-save.
    // 5 min during a session. Final upload happens at stopSessionInternal.
    // Crash loss = 5 min Drive lag; local CSV is always intact and re-uploads
    // on next session-stop or reopen.
    private static final long DRIVE_UPLOAD_INTERVAL_MS = 300_000L;
    // Fire a csvError event once after this many consecutive write failures.
    // Below this threshold a single transient error is silently retried; at
    // the threshold the UI gets one signal so it can show a banner. Resets
    // on the next successful write — won't re-fire until another N-streak.
    private static final int CSV_FAIL_ALERT_THRESHOLD = 5;
    // Periodic finalize+restart cadence. Every 30 min the resumable session
    // commits (file appears in Drive) and a fresh PATCH session opens against
    // the same fileId.
    private static final long DRIVE_FINALIZE_INTERVAL_MS = 30L * 60L * 1000L;

    private final Context appCtx;
    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private final BleScanner bleScanner;
    private final GattHrDevice device;

    private final AtomicReference<Listener> listener = new AtomicReference<>();
    private final boolean interruptedAtCreate;
    private final boolean markedBrokenAtCreate;

    // Floating-overlay Service listener; the Service installs itself in onCreate and clears in onDestroy.
    public static volatile FloatingOverlayService.HrUpdateListener floatingOverlayListener;

    // Session state
    private String broadcastKey;
    private String senderId;
    private String senderLabel;
    private long sessionStartMs;
    private final AtomicBoolean sessionActive = new AtomicBoolean(false);
    // Bumped each time a session becomes active. A deferred stop (background
    // worker off the FGS Stop button) captures the generation and only tears
    // down if it still matches, so a new session started meanwhile survives.
    private final AtomicInteger sessionGeneration = new AtomicInteger(0);

    // volatile: BLE binder thread reads while main thread can null on stop.
    private volatile HrSink sink;
    private final NativeDriveUploader uploader;
    private final NativeDriveResumableUploader resumable;
    private final AtomicLong lastUploadMs = new AtomicLong(0);
    private final AtomicLong lastFinalizeMs = new AtomicLong(0);
    // Blocks chunk-append + concurrent finalize while a commit is in flight.
    private final AtomicBoolean committing = new AtomicBoolean(false);

    private final OkHttpClient httpClient;
    private volatile WebSocket relaySocket;
    private final AtomicBoolean relayLive = new AtomicBoolean(false);
    // User toggle. When false, no relay socket is opened and publishTick is a no-op.
    private volatile boolean broadcastEnabled = true;
    private volatile String prefsJson = null;

    private long lastNotifUpdateMs = 0;

    // Heartbeat: if no HR notification for STALE_HR_THRESHOLD_MS, force a reconnect.
    // Seeded at session start so a link that never delivers a first HR is caught too.
    private volatile long lastHrAtMs = 0;
    private volatile boolean firstHrSeen = false;
    private int gattReconnectAttempts = 0;
    // A backoff reconnect is posted and not yet fired/cancelled. The heartbeat
    // only schedules when none is pending, so a long backoff (>15 s heartbeat
    // interval) isn't cancelled and rescheduled forever.
    private volatile boolean reconnectPending = false;
    private static final long STALE_HR_THRESHOLD_MS = 60_000L;
    private static final long HEARTBEAT_INTERVAL_MS = 15_000L;

    // Connect, snapshot and cache work; never shut down.
    private final ExecutorService ioExecutor = Executors.newSingleThreadExecutor(
        r -> new Thread(r, "hrm-engine-io"));

    // RR + RMSSD
    private final Deque<RrEntry> rrWindow = new ArrayDeque<>();
    private final Deque<RrEntry> rrWindow5min = new ArrayDeque<>();
    private final Deque<double[]> liveBuffer = new ArrayDeque<>();
    private final Deque<double[]> trendHrBuffer = new ArrayDeque<>();
    private final Deque<double[]> trendRmssdBuffer = new ArrayDeque<>();
    // Welford running stats for session-wide SDNN. Reset per session.
    // PARITY CRITICAL — must match hr_monitor.html state.sdnnFull*.
    private long sdnnFullCount = 0;
    private double sdnnFullMean = 0.0;
    private double sdnnFullM2 = 0.0;

    private HrEngine(Context appCtx) {
        this.appCtx = appCtx;
        bleScanner = new BleScanner(appCtx);
        device = new GattHrDevice(appCtx, bleScanner);
        device.setCallback(this);
        uploader = new NativeDriveUploader(appCtx);
        resumable = new NativeDriveResumableUploader(appCtx, uploader);
        httpClient = HttpClientHolder.webSocketClient();
        // A session the previous process left open: mark its resumable upload
        // broken so the periodic tick falls through to uploader.uploadAsync.
        // Constructor only, so attaching to a live session never marks it.
        boolean interrupted = false;
        boolean marked = false;
        try {
            android.content.SharedPreferences prefs = appCtx.getSharedPreferences("hr_monitor_session", 0);
            boolean prefsActive = prefs.getBoolean("sessionActive", false);
            boolean cleanly = prefs.getBoolean("cleanlyStopped", true);
            interrupted = prefsActive && !cleanly;
            if (prefsActive && !cleanly && !sessionActive.get()) {
                resumable.markBrokenForRestart();
                marked = true;
            }
        } catch (Throwable t) {
            Log.w(TAG, "interrupted-session check failed: " + t.getMessage());
        }
        interruptedAtCreate = interrupted;
        markedBrokenAtCreate = marked;
        // Last, so a constructor that throws earlier never leaves a registered callback behind.
        registerNetworkCallback();
    }

    public boolean wasInterruptedAtCreate() { return interruptedAtCreate; }

    public boolean wasMarkedBrokenAtCreate() { return markedBrokenAtCreate; }

    public boolean isStrapLinked() { return device.hasHandle(); }

    public boolean isRelayLive() { return relayLive.get(); }

    // ---- Listener ---------------------------------------------------------

    public void setListener(Listener l) { listener.set(l); }

    // Clears only if the slot still holds l; Activity destroy and create order is not guaranteed.
    public boolean clearListener(Listener l) {
        return l != null && listener.compareAndSet(l, null);
    }

    private void emit(String name, JSONObject data) {
        Listener l = listener.get();
        if (l == null) return;
        try { l.onEvent(name, data); }
        catch (Throwable t) { Log.w(TAG, "emit " + name + ": " + t); }
    }

    // org.json throws on NaN and Infinity; drop the key as JSObject.put does.
    static JSONObject putSafe(JSONObject o, String k, Object v) {
        try { o.put(k, v); } catch (JSONException ignored) {}
        return o;
    }

    // ---- RR maths ---------------------------------------------------------

    private static final class RrEntry {
        final int rrMs;
        final long timestampMs;
        RrEntry(int rrMs, long ts) { this.rrMs = rrMs; this.timestampMs = ts; }
    }

    // PARITY CRITICAL — MUST MATCH hr_monitor.html:computeRMSSD (line ~1857).
    //
    // Both implementations ship RMSSD to end users (JS to the monitor
    // widget, Java to the relay broadcast and the CSV writer). If they
    // drift, the same recording shows different HRV numbers on different
    // surfaces. Already happened once (see scripts/rmssd-parity.test.js
    // for the golden vector and regression history).
    //
    // Both filters are standard HRV preprocessing:
    //   - RR range 300..2000 ms (HR 30..200) drops obvious artefacts
    //   - |successive-diff| >= 200 ms drops ectopic-beat jumps
    //
    // When you change either implementation, update the other and run
    // `node scripts/rmssd-parity.test.js` to verify both still produce
    // the golden-vector expected output.
    private static Double computeRmssd(Deque<RrEntry> window) {
        if (window.size() < 2) return null;
        java.util.ArrayList<Integer> clean = new java.util.ArrayList<>();
        for (RrEntry e : window) {
            if (e.rrMs >= 300 && e.rrMs <= 2000) clean.add(e.rrMs);
        }
        if (clean.size() < 2) return null;
        double sumSq = 0.0;
        int count = 0;
        for (int i = 1; i < clean.size(); i++) {
            int d = clean.get(i) - clean.get(i - 1);
            if (Math.abs(d) < 200) {
                sumSq += (double) d * d;
                count += 1;
            }
        }
        if (count < 1) return null;
        return Math.sqrt(sumSq / count);
    }

    // PARITY CRITICAL — must match hr_monitor.html computeSDNN.
    // Sample stddev (n-1) of in-range RR intervals. No diff filter so the
    // formula stays simple and parity-testable; ectopics inflate SDNN, which
    // is the standard clinical behaviour.
    private static Double computeSdnn(Deque<RrEntry> window) {
        if (window.size() < 2) return null;
        java.util.ArrayList<Integer> clean = new java.util.ArrayList<>();
        for (RrEntry e : window) {
            if (e.rrMs >= 300 && e.rrMs <= 2000) clean.add(e.rrMs);
        }
        if (clean.size() < 2) return null;
        double sum = 0.0;
        for (int rr : clean) sum += rr;
        double mean = sum / clean.size();
        double sumSq = 0.0;
        for (int rr : clean) {
            double d = rr - mean;
            sumSq += d * d;
        }
        return Math.sqrt(sumSq / (clean.size() - 1));
    }

    // Force relay reconnect on Wi-Fi/cellular handoff (OkHttp readTimeout=0 stalls). Registered once, never unregistered.
    private android.net.ConnectivityManager.NetworkCallback networkCallback;
    private android.net.Network lastActiveNetwork;

    private void registerNetworkCallback() {
        if (networkCallback != null) return;
        try {
            android.net.ConnectivityManager cm = (android.net.ConnectivityManager)
                appCtx.getSystemService(Context.CONNECTIVITY_SERVICE);
            if (cm == null) return;
            networkCallback = new android.net.ConnectivityManager.NetworkCallback() {
                @Override public void onAvailable(android.net.Network network) {
                    if (lastActiveNetwork != null && !network.equals(lastActiveNetwork)
                            && sessionActive.get() && broadcastEnabled) {
                        Log.i(TAG, "Network changed — forcing relay reconnect");
                        relayReconnectAttempts = 0;
                        mainHandler.post(() -> {
                            try { closeRelaySocket(); } catch (Throwable ignored) {}
                            try { openRelaySocket(); } catch (Throwable ignored) {}
                        });
                    }
                    lastActiveNetwork = network;
                }
                @Override public void onLost(android.net.Network network) {
                    if (network.equals(lastActiveNetwork)) lastActiveNetwork = null;
                }
            };
            android.net.NetworkRequest req = new android.net.NetworkRequest.Builder()
                .addCapability(android.net.NetworkCapabilities.NET_CAPABILITY_INTERNET)
                .build();
            cm.registerNetworkCallback(req, networkCallback);
        } catch (Throwable t) {
            Log.w(TAG, "registerNetworkCallback failed: " + t.getMessage());
            networkCallback = null;
        }
    }

    public void setPrefs(String json) { prefsJson = json; }

    public void setBroadcast(boolean enabled) {
        boolean prev = broadcastEnabled;
        broadcastEnabled = enabled;
        // Cancel any pending reconnect immediately so a stale onClosed→
        // scheduleRelayReconnect callback can't open a socket we just turned off.
        mainHandler.removeCallbacks(relayReconnectRunnable);
        if (sessionActive.get() && enabled != prev) {
            mainHandler.post(() -> {
                if (enabled && broadcastKey != null && !broadcastKey.isEmpty()) {
                    relayReconnectAttempts = 0;
                    try { openRelaySocket(); } catch (Throwable ignored) {}
                } else {
                    try { closeRelaySocket(); } catch (Throwable ignored) {}
                    relayLive.set(false);
                    emitState();
                }
            });
        }
    }

    // ---- Relay WebSocket --------------------------------------------------

    // Reconnect backoff. 2s → 4s → 8s ... capped at 60s, with ±25% jitter
    // so devices behind the same outage don't synchronise their retries
    // and so a hard server outage isn't hammered at 0.5 Hz indefinitely.
    private int relayReconnectAttempts = 0;
    private static final long RELAY_RECONNECT_BASE_MS = 2_000L;
    private static final long RELAY_RECONNECT_MAX_MS = 60_000L;
    // After this many consecutive failures, surface the situation to JS so
    // the UI can show "relay unreachable" instead of just sitting silent.
    private static final int RELAY_RECONNECT_NOTIFY_AFTER = 10;

    private long nextRelayBackoffMs() {
        long base = Math.min(RELAY_RECONNECT_MAX_MS,
                             RELAY_RECONNECT_BASE_MS * (1L << Math.min(relayReconnectAttempts, 5)));
        double jitter = 1.0 + (Math.random() * 0.5 - 0.25);
        return (long) (base * jitter);
    }

    private final Runnable relayReconnectRunnable = this::openRelaySocket;

    private void scheduleRelayReconnect() {
        if (!sessionActive.get() || !broadcastEnabled) return;
        mainHandler.removeCallbacks(relayReconnectRunnable);
        relayReconnectAttempts++;
        long delay = nextRelayBackoffMs();
        Log.i(TAG, "Relay reconnect scheduled in " + delay + "ms (attempt " + relayReconnectAttempts + ")");
        if (relayReconnectAttempts == RELAY_RECONNECT_NOTIFY_AFTER) {
            JSONObject ev = new JSONObject();
            putSafe(ev, "kind", "relayUnreachable");
            putSafe(ev, "attempts", relayReconnectAttempts);
            emit("relayError", ev);
        }
        mainHandler.postDelayed(relayReconnectRunnable, delay);
    }

    private void openRelaySocket() {
        if (broadcastKey == null) return;
        if (!broadcastEnabled) return;
        mainHandler.removeCallbacks(relayReconnectRunnable);
        closeRelaySocket();
        Request req = new Request.Builder()
            .url("wss://hr-relay.nakauri.partykit.dev/parties/main/" + broadcastKey + "?role=publisher")
            .build();
        // Stale callbacks (from a socket we replaced or closed) compare ws to
        // the volatile relaySocket field and bail. Required because OkHttp
        // queues callbacks on a worker thread and they can fire after we've
        // moved on.
        relaySocket = httpClient.newWebSocket(req, new WebSocketListener() {
            @Override public void onOpen(WebSocket ws, Response r) {
                if (ws != relaySocket) return;
                relayLive.set(true);
                relayReconnectAttempts = 0;
                Log.i(TAG, "Relay open");
                emitState();
            }
            @Override public void onClosed(WebSocket ws, int code, String reason) {
                if (ws != relaySocket) return;
                relayLive.set(false);
                emitState();
                scheduleRelayReconnect();
            }
            @Override public void onFailure(WebSocket ws, Throwable t, Response r) {
                if (ws != relaySocket) return;
                relayLive.set(false);
                Log.w(TAG, "Relay failure: " + (t != null ? t.getMessage() : "unknown"));
                emitState();
                scheduleRelayReconnect();
            }
            @Override public void onMessage(WebSocket ws, String text) { /* ignored */ }
            @Override public void onMessage(WebSocket ws, ByteString bytes) { /* ignored */ }
        });
    }

    private void closeRelaySocket() {
        mainHandler.removeCallbacks(relayReconnectRunnable);
        // Fire presence-end for this senderId before tearing down the socket.
        // Without this the relay's activeBroadcasters map keeps the id around
        // until its 15 s idle eviction fires; users see ghost "live recording"
        // entries between a session stop and the next presence cleanup tick.
        if (relaySocket != null && senderId != null && !senderId.isEmpty()) {
            try {
                String msg = "{\"type\":\"presence-end\",\"senderId\":\"" + escapeJson(senderId) + "\"}";
                relaySocket.send(msg);
            } catch (Throwable ignored) {}
        }
        if (relaySocket != null) {
            try { relaySocket.close(1000, "session stop"); } catch (Exception ignored) {}
            relaySocket = null;
        }
        relayLive.set(false);
    }


    /**
     * Publish a tick to the relay. Wire format is documented in
     * RELAY_TICK.md at the repo root. The web sender
     * (hr_monitor.html broadcastTick) MUST emit the same fields.
     * When adding or renaming a field, update all three: this method,
     * hr_monitor.html broadcastTick, and overlay.html handleTick.
     */
    private void publishTick(int hr, Double rmssd, boolean contactOff, long nowMs) {
        if (!broadcastEnabled) return;
        if (relaySocket == null || !relayLive.get()) return;
        double tMin = Math.max(0, nowMs - sessionStartMs) / 60_000.0;
        // Construct minimal JSON manually — avoids extra dep on org.json
        // and matches the wire shape overlay.html consumes.
        StringBuilder sb = new StringBuilder(256);
        sb.append("{\"type\":\"tick\"");
        sb.append(",\"senderId\":\"").append(escapeJson(senderId)).append('"');
        sb.append(",\"senderLabel\":\"").append(escapeJson(senderLabel)).append('"');
        sb.append(",\"senderBooted\":").append(sessionStartMs);
        sb.append(",\"t\":").append(String.format(java.util.Locale.US, "%.4f", tMin));
        sb.append(",\"hr\":").append(hr);
        sb.append(",\"hrStage\":\"").append(hrStage(hr)).append('"');
        if (rmssd != null) {
            sb.append(",\"rmssd\":").append(String.format(java.util.Locale.US, "%.2f", rmssd));
            sb.append(",\"rmssdStage\":\"").append(rmssdStage(rmssd)).append('"');
        }
        sb.append(",\"palpPerMin\":0");
        sb.append(",\"contactOff\":").append(contactOff);
        sb.append(",\"warn\":null");
        sb.append(",\"conn\":\"live\"");

        // Chart arrays: overlay.html renders these directly. Must match
        // hr_monitor.html broadcastTick's shape. See RELAY_TICK.md.
        double nowSec = (nowMs - sessionStartMs) / 1000.0;
        double nowMin = nowSec / 60.0;
        appendLiveArray(sb, nowMs);
        sb.append(",\"liveWindow\":[")
          .append(String.format(java.util.Locale.US, "%.2f", Math.max(0, nowSec - 45)))
          .append(',')
          .append(String.format(java.util.Locale.US, "%.2f", Math.max(45, nowSec)))
          .append(']');
        appendTrendArray(sb, "trendHR", trendHrBuffer);
        appendTrendArray(sb, "trendRmssd", trendRmssdBuffer);
        sb.append(",\"trendWindow\":[")
          .append(String.format(java.util.Locale.US, "%.4f", Math.max(0, nowMin - 3)))
          .append(',')
          .append(String.format(java.util.Locale.US, "%.4f", Math.max(3, nowMin)))
          .append(']');

        // prefs passthrough — JS tracks the source of truth, native just
        // relays it so the OBS overlay mirrors widget toggles in real time.
        if (prefsJson != null) {
            sb.append(",\"prefs\":").append(prefsJson);
        }

        sb.append('}');
        relaySocket.send(sb.toString());
    }

    // Snapshot the deque before iterating. ArrayDeque is not thread-safe;
    // BLE callbacks (binder thread) addLast on liveBuffer / trendHrBuffer /
    // trendRmssdBuffer at the same moment publishTick (main thread) walks
    // them. Today the call chain happens to serialise, but a future caller
    // off either thread would hit ConcurrentModificationException. Cheap
    // toArray copy avoids the race for the lifetime of the iteration.
    private void appendLiveArray(StringBuilder sb, long nowMs) {
        sb.append(",\"livePoints\":[");
        Object[] snap;
        synchronized (liveBuffer) { snap = liveBuffer.toArray(); }
        boolean first = true;
        for (Object o : snap) {
            double[] e = (double[]) o;
            double xSec = (e[0] - sessionStartMs) / 1000.0;
            if (!first) sb.append(',');
            first = false;
            sb.append("{\"x\":").append(String.format(java.util.Locale.US, "%.2f", xSec))
              .append(",\"y\":").append(String.format(java.util.Locale.US, "%.1f", e[1])).append('}');
        }
        sb.append(']');
    }

    private void appendTrendArray(StringBuilder sb, String name, Deque<double[]> buf) {
        sb.append(",\"").append(name).append("\":[");
        Object[] snap;
        synchronized (buf) { snap = buf.toArray(); }
        boolean first = true;
        for (Object o : snap) {
            double[] e = (double[]) o;
            double xMin = (e[0] - sessionStartMs) / 60000.0;
            if (!first) sb.append(',');
            first = false;
            sb.append("{\"x\":").append(String.format(java.util.Locale.US, "%.4f", xMin))
              .append(",\"y\":").append(String.format(java.util.Locale.US, "%.2f", e[1])).append('}');
        }
        sb.append(']');
    }

    private static String escapeJson(String s) {
        if (s == null) return "";
        StringBuilder o = new StringBuilder(s.length() + 4);
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            if (c == '"' || c == '\\') o.append('\\').append(c);
            else if (c < 0x20) o.append(String.format("\\u%04x", (int) c));
            else o.append(c);
        }
        return o.toString();
    }

    public void emitState() {
        JSONObject ev = new JSONObject();
        putSafe(ev, "ble", device.hasHandle());
        putSafe(ev, "relay", relayLive.get());
        putSafe(ev, "session", sessionActive.get());
        emit("state", ev);
    }

    // ---- Foreground Service lifecycle ------------------------------------

    private void startNativeForegroundService(String title, String body) {
        try {
            Intent i = new Intent(appCtx, NativeHrService.class);
            i.setAction(NativeHrService.ACTION_START);
            i.putExtra(NativeHrService.EXTRA_TITLE, title);
            i.putExtra(NativeHrService.EXTRA_BODY, body);
            i.putExtra(NativeHrService.EXTRA_SESSION_START_MS, sessionStartMs);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                appCtx.startForegroundService(i);
            } else {
                appCtx.startService(i);
            }
        } catch (Throwable t) {
            Log.w(TAG, "Failed to start FGS: " + t.getMessage());
        }
    }

    private void updateNativeForegroundService(String title, String body) {
        // Direct NotificationManager.notify avoids the FGS-contract crash
        // that startForegroundService() triggers if the service is mid-stop.
        if (!sessionActive.get()) return;
        try {
            android.content.Context ctx = appCtx;
            NativeHrService.ensureChannelStatic(ctx);
            android.app.NotificationManager nm = (android.app.NotificationManager)
                ctx.getSystemService(android.content.Context.NOTIFICATION_SERVICE);
            if (nm == null) return;
            android.app.Notification n = NativeHrService.buildNotificationStatic(ctx, title, body, sessionStartMs);
            nm.notify(NativeHrService.getNotificationId(), n);
        } catch (Throwable t) { /* non-fatal */ }
    }

    private void stopNativeForegroundService() {
        // Use stopService directly. startService(ACTION_STOP) was racy: the
        // intent could queue and deliver to a future service instance after
        // the user had started a new session, killing the fresh GATT.
        try {
            appCtx.stopService(new Intent(appCtx, NativeHrService.class));
        } catch (Throwable ignored) {}
    }

    // ---- Reconnect policy -------------------------------------------------

    // Backoff reconnect: 2 → 4 → 8 → 16 → 30 s, capped. After 5 attempts on
    // the cached gatt, do a full reconnect (close + new connectGatt) which
    // recovers from a borked GATT object that gatt.connect() can't reset.
    private final Runnable gattReconnectRunnable = this::doGattReconnect;
    private void scheduleGattReconnect() {
        if (!sessionActive.get()) return;
        mainHandler.removeCallbacks(gattReconnectRunnable);
        reconnectPending = true;
        gattReconnectAttempts++;
        long base = Math.min(30_000L, 2_000L * (1L << Math.min(gattReconnectAttempts - 1, 4)));
        long delay = (long) (base * (1.0 + (Math.random() * 0.4 - 0.2)));
        Log.i(TAG, "GATT reconnect scheduled in " + delay + "ms (attempt " + gattReconnectAttempts + ")");
        mainHandler.postDelayed(gattReconnectRunnable, delay);
    }
    private void doGattReconnect() {
        reconnectPending = false;
        if (!sessionActive.get()) return;
        if (gattReconnectAttempts > 5 || !device.hasHandle()) {
            Log.i(TAG, "GATT reconnect: full reconnect (attempts=" + gattReconnectAttempts + ")");
            fullReconnectGatt();
            return;
        }
        device.reconnect();
    }
    private void fullReconnectGatt() {
        if (!sessionActive.get()) return;
        device.fullReconnect();
    }

    // Heartbeat: catches silent BLE drops Doze can produce (no onConnectionStateChange
    // fires). If no HR for STALE_HR_THRESHOLD_MS, force a reconnect.
    private final Runnable heartbeatRunnable = new Runnable() {
        @Override public void run() {
            if (!sessionActive.get()) return;
            long now = System.currentTimeMillis();
            if (lastHrAtMs > 0 && now - lastHrAtMs > STALE_HR_THRESHOLD_MS && !reconnectPending) {
                if (!firstHrSeen) {
                    // Connected-but-silent since start: rebuild the link now, then wait another full window.
                    Log.w(TAG, "Heartbeat: no first HR after " + (now - lastHrAtMs) + "ms — full reconnect");
                    NativeHrService.logLifecycle(appCtx, "stale_before_first_hr_reconnect gatt=" + device.hasHandle());
                    lastHrAtMs = now;
                    fullReconnectGatt();
                } else {
                    Log.w(TAG, "Heartbeat: no HR for " + (now - lastHrAtMs) + "ms — forcing reconnect");
                    scheduleGattReconnect();
                }
            }
            // Re-check before re-posting: sessionActive may have flipped during this run.
            if (sessionActive.get()) mainHandler.postDelayed(this, HEARTBEAT_INTERVAL_MS);
        }
    };

    // stopStreams precedes disconnect on every path.
    private void disconnectDevice() {
        device.stopStreams();
        device.disconnect();
    }

    // ---- Drive --------------------------------------------------------------

    // A mid-session commit thread may outlive its session; it only touches Drive state while this holds.
    private boolean stillSession(int gen) {
        return sessionActive.get() && sessionGeneration.get() == gen;
    }

    private static JSONObject syncResult(boolean ok, String reason) {
        JSONObject ret = putSafe(new JSONObject(), "ok", ok);
        if (reason != null) putSafe(ret, "reason", reason);
        return ret;
    }

    /**
     * Manual sync: commit the current resumable session so the partial CSV
     * becomes visible in Drive, then re-open a PATCH session for the next
     * batch of trickled chunks. Also re-uploads any orphans from prior
     * sessions whose stop never ran. Wired to the monitor's drive-sync
     * icon button on Capacitor.
     */
    public void forceSyncNow(Done<JSONObject> done) {
        boolean settled = false;
        try {
            if (sink == null || !sessionActive.get()) {
                settled = true;
                done.ok(syncResult(false, "no_active_session"));
                return;
            }
            if (!committing.compareAndSet(false, true)) {
                settled = true;
                done.ok(syncResult(false, "already_committing"));
                return;
            }
            lastFinalizeMs.set(System.currentTimeMillis());
            final int syncGen = sessionGeneration.get();
            try {
                new Thread(() -> {
                    String reason = null;
                    boolean ok = false;
                    try {
                        HrSink w = sink;
                        java.io.File file = w != null ? w.getFile() : null;
                        if (file == null) { reason = "csv_gone"; return; }
                        String name = file.getName();
                        boolean finalized = false;
                        if (resumable.isReady()) {
                            finalized = resumable.finalizeSync(file);
                            if (finalized) {
                                ok = true;
                                Log.i(TAG, "forceSyncNow finalize OK: " + name);
                                reason = "trickle_committed";
                            } else {
                                Log.w(TAG, "forceSyncNow finalize failed: " + name);
                            }
                        }
                        // Run the safety-net PATCH BEFORE reopening the resumable
                        // session. Drive holds files with an open resumable session
                        // partially-shadowed from folder listings — if we reopen
                        // (restartSessionAsync) concurrently with uploadSync, the
                        // listing doesn't see the PATCH bytes until the next session
                        // ends. This was the May 21 regression: tap-sync mid-recording
                        // returned "Synced" but the viewer couldn't see the file until
                        // the app process closed (which abandoned the resumable
                        // session and let Drive's index recover).
                        if (!stillSession(syncGen)) {
                            // Stopped meanwhile: the stop worker owns this file's final upload.
                            reason = reason == null ? "session_stopped" : reason + "+session_stopped";
                        } else {
                            boolean uploadOk = uploader.uploadSync(file);
                            if (uploadOk) {
                                ok = true;
                                if (reason == null) reason = "full_patch_ok";
                                else if (reason.equals("trickle_committed")) reason = "trickle_committed+full_patch";
                            } else if (!ok) {
                                reason = reason == null ? "upload_failed" : reason + "+upload_failed";
                            }
                        }
                        // NOW reopen the resumable session for future periodic chunks.
                        // Sequential after uploadSync so no two operations race against
                        // the same fileId. restartSessionAsync itself is async (fires
                        // onto the resumable executor); we don't block on it.
                        if (finalized && stillSession(syncGen)) {
                            resumable.restartSessionAsync();
                        }
                        // Orphan re-upload runs unconditionally (different files).
                        java.io.File sessionsDir = new java.io.File(appCtx.getFilesDir(), "sessions");
                        uploader.uploadOrphansAsync(sessionsDir);
                    } catch (Throwable t) {
                        Log.w(TAG, "forceSyncNow threw: " + t.getMessage());
                        reason = t.getMessage();
                    } finally {
                        committing.set(false);
                        done.ok(syncResult(ok, reason));
                    }
                }, "drive-force-sync").start();
                settled = true;
            } catch (Throwable t) {
                committing.set(false);
                settled = true;
                done.fail("force_sync_failed: " + t.getMessage());
            }
        } finally {
            if (!settled) done.fail("internal");
        }
    }

    /** Periodic finalize+restart timer body. Runs on its own thread because
     *  finalizeSync is synchronous and would block the BLE binder thread
     *  if invoked from the tick handler. */
    private void finalizeAndRestartAsync() {
        final int gen = sessionGeneration.get();
        new Thread(() -> {
            try {
                HrSink w = sink;
                java.io.File file = w != null ? w.getFile() : null;
                if (file == null) return;
                String name = file.getName();
                if (resumable.isReady()) {
                    boolean ok = resumable.finalizeSync(file);
                    if (!stillSession(gen)) {
                        Log.i(TAG, "periodic finalize: session stopped meanwhile; stop worker owns " + name);
                    } else if (ok) {
                        Log.i(TAG, "periodic finalize OK: " + name);
                        resumable.restartSessionAsync();
                    } else {
                        Log.w(TAG, "periodic finalize failed; falling back to full upload: " + name);
                        uploader.uploadAsync(file);
                    }
                } else {
                    Log.i(TAG, "periodic finalize: resumable not ready, full-upload fallback");
                    uploader.uploadAsync(file);
                }
            } catch (Throwable t) {
                Log.w(TAG, "finalizeAndRestart threw: " + t.getMessage());
            } finally {
                committing.set(false);
            }
        }, "drive-periodic-finalize").start();
    }

    /**
     * Snapshot of local CSV cache for the diagnostics modal. JS surfaces
     * count + bytes so the user can see what's accumulating, and an
     * "oldest" timestamp so they can decide whether to clear.
     */
    public void getCacheStats(Done<JSONObject> done) {
        try {
            ioExecutor.execute(() -> {
                boolean settled = false;
                try {
                    java.io.File sessionsDir = new java.io.File(appCtx.getFilesDir(), "sessions");
                    long[] stats = NativeDriveUploader.cacheStats(sessionsDir);
                    JSONObject ret = new JSONObject();
                    putSafe(ret, "count", stats[0]);
                    putSafe(ret, "bytes", stats[1]);
                    putSafe(ret, "oldestMs", stats[2]);
                    settled = true;
                    done.ok(ret);
                } catch (Throwable t) {
                    settled = true;
                    done.fail("getCacheStats failed: " + t.getMessage());
                } finally {
                    if (!settled) done.fail("internal");
                }
            });
        } catch (Throwable t) {
            done.fail("getCacheStats failed: " + t.getMessage());
        }
    }

    /**
     * Manual cache clear from the diagnostics UI. Deletes every CSV in
     * the sessions/ directory except the active session. Returns the
     * count of files removed so the UI can confirm.
     */
    public void clearLocalCache(Done<JSONObject> done) {
        try {
            ioExecutor.execute(() -> {
                boolean settled = false;
                try {
                    java.io.File sessionsDir = new java.io.File(appCtx.getFilesDir(), "sessions");
                    int deleted = uploader.clearLocalCache(sessionsDir);
                    JSONObject ret = putSafe(new JSONObject(), "deleted", deleted);
                    settled = true;
                    done.ok(ret);
                } catch (Throwable t) {
                    settled = true;
                    done.fail("clearLocalCache failed: " + t.getMessage());
                } finally {
                    if (!settled) done.fail("internal");
                }
            });
        } catch (Throwable t) {
            done.fail("clearLocalCache failed: " + t.getMessage());
        }
    }

    // Returns the active session's CSV contents + start epoch so the WebView
    // can rehydrate state.hrSeries / state.rmssdSeries after being reclaimed
    // mid-session. Fails if no session is active or the file is missing.
    // tailMinutes, when set, reads only the trailing ~N minutes of the CSV.
    public void getSessionSnapshot(final Integer tailMinutes, Done<JSONObject> done) {
        try {
            ioExecutor.execute(() -> {
                boolean settled = false;
                try {
                    HrSink s = sink;
                    if (!sessionActive.get() || s == null) {
                        settled = true;
                        done.fail("no_active_session");
                        return;
                    }
                    java.io.File file = s.getFile();
                    if (file == null || !file.exists()) {
                        settled = true;
                        done.fail("no_csv_file");
                        return;
                    }
                    long size = file.length();
                    String text;
                    if (tailMinutes != null && tailMinutes > 0 && size > 0) {
                        // Estimate: ~80 bytes per CSV row × 60 rows/min × tailMinutes
                        // + a 4 KB safety slack so we always overshoot rather than
                        // miss the first targeted row. Capped at file size.
                        long bytesToRead = Math.min(size, (long) tailMinutes * 60L * 80L + 4096L);
                        long offset = Math.max(0L, size - bytesToRead);
                        int chunk = (int) bytesToRead;
                        byte[] bytes = new byte[chunk];
                        try (java.io.RandomAccessFile raf = new java.io.RandomAccessFile(file, "r")) {
                            raf.seek(offset);
                            int read = 0;
                            while (read < chunk) {
                                int n = raf.read(bytes, read, chunk - read);
                                if (n < 0) break;
                                read += n;
                            }
                            if (read < chunk) {
                                byte[] trimmed = new byte[read];
                                System.arraycopy(bytes, 0, trimmed, 0, read);
                                bytes = trimmed;
                            }
                        }
                        text = new String(bytes, java.nio.charset.StandardCharsets.UTF_8);
                        // If we seeked into the middle of a row, drop the partial first
                        // line. Prepend a placeholder so callers that "skip line 0"
                        // (the CSV header convention) keep working without special-casing
                        // tail mode. When offset == 0 we have the real header already.
                        if (offset > 0) {
                            int nl = text.indexOf('\n');
                            if (nl >= 0) {
                                text = "tail\n" + text.substring(nl + 1);
                            }
                        }
                    } else {
                        byte[] bytes = new byte[(int) size];
                        try (java.io.FileInputStream fis = new java.io.FileInputStream(file)) {
                            int read = 0;
                            while (read < bytes.length) {
                                int n = fis.read(bytes, read, bytes.length - read);
                                if (n < 0) break;
                                read += n;
                            }
                        }
                        text = new String(bytes, java.nio.charset.StandardCharsets.UTF_8);
                    }
                    JSONObject ret = new JSONObject();
                    putSafe(ret, "filename", s.getFilename());
                    putSafe(ret, "csv", text);
                    putSafe(ret, "sessionStartMs", s.getSessionStartMs());
                    // sizeBytes  = full on-disk file size.
                    // payloadBytes = chars in the response text (≈ bytes for ASCII
                    //               CSV). In tail mode payloadBytes << sizeBytes;
                    //               JS logs both so a regression where tail mode
                    //               accidentally reads the whole file is visible.
                    putSafe(ret, "sizeBytes", size);
                    putSafe(ret, "payloadBytes", text != null ? text.length() : 0);
                    settled = true;
                    done.ok(ret);
                } catch (Throwable t) {
                    // Throwable, not Exception: an OutOfMemoryError on the file
                    // read would escape and leave the call unsettled.
                    settled = true;
                    done.fail("getSessionSnapshot failed: " + t.getMessage());
                } finally {
                    if (!settled) done.fail("internal");
                }
            });
        } catch (Throwable t) {
            done.fail("getSessionSnapshot failed: " + t.getMessage());
        }
    }

    // ---- Session ------------------------------------------------------------

    // Stop upload workers still running, process-wide; the FGS stale-intent branch defers to them.
    private static final AtomicInteger stopWorkersRunning = new AtomicInteger(0);
    // Stop worker's bound on the final commit, queue wait included.
    private static final long STOP_FINALIZE_WAIT_MS = 180_000L;
    // Throttle for the post-mortem alive-pulse pref write. shared_prefs.apply
    // is cheap but at 1 Hz the file rewrites would still churn — 10 sec is
    // fine resolution for "when did we last record" forensics.
    private static final long ALIVE_WRITE_INTERVAL_MS = 10_000L;
    private long lastAliveWriteMs = 0L;

    public boolean isSessionActive() { return sessionActive.get(); }

    public static boolean isStopTeardownInProgress() { return stopWorkersRunning.get() > 0; }

    public int getSessionGeneration() { return sessionGeneration.get(); }

    public boolean hasAdapter() { return bleScanner.adapter() != null; }

    public void scan(long timeoutMs, Done<org.json.JSONArray> done) {
        bleScanner.scan(timeoutMs, mainHandler, done);
    }

    // Off the plugin thread: the rescan can block ~3 s.
    public void connect(final String mac, Done<JSONObject> done) {
        try {
            ioExecutor.execute(() -> doConnect(mac, done));
        } catch (Throwable t) {
            done.fail("connect failed: " + t.getMessage());
        }
    }

    private void doConnect(String mac, Done<JSONObject> done) {
        boolean settled = false;
        try {
            boolean bonded;
            try {
                bonded = device.connect(mac);
            } catch (SecurityException e) {
                settled = true;
                done.fail("BLUETOOTH_CONNECT denied: " + e.getMessage());
                return;
            }
            // Cache MAC for auto-resume after process kill. .apply is fine —
            // stale-by-30s acceptable, the same MAC carries across kills.
            try {
                appCtx.getSharedPreferences("hr_monitor_session", 0).edit()
                    .putString("lastConnectedMac", mac).apply();
            } catch (Throwable ignored) {}
            JSONObject ret = new JSONObject();
            putSafe(ret, "connecting", true);
            putSafe(ret, "bonded", bonded);
            settled = true;
            done.ok(ret);
        } catch (Throwable t) {
            // 2-arg Log only; the Throwable overload pulls in a class that
            // ClassNotFoundExceptions on API 28.
            Log.e(TAG, "doConnect failed: " + t);
            settled = true;
            done.fail("connect failed: " + t.getMessage());
        } finally {
            if (!settled) done.fail("internal");
        }
    }

    public void disconnect() { disconnectDevice(); }

    public JSONObject startSessionInternal(String broadcastKeyArg, String senderIdArg, String senderLabelArg,
            Boolean broadcastOpt, String resumeFilename, Long resumeStartMs) throws AlreadyActiveException {
        // A live session is never torn down by a second start; a resume of the same file reports it as running.
        if (sessionActive.get()) {
            HrSink cur = sink;
            if (resumeFilename != null && cur != null && resumeFilename.equals(cur.getFilename())) {
                JSONObject running = putSafe(new JSONObject(), "started", true);
                putSafe(running, "alreadyRunning", true);
                putSafe(running, "csvFile", cur.getFilename());
                putSafe(running, "sessionStartMs", sessionStartMs);
                putSafe(running, "senderId", senderId);
                putSafe(running, "senderLabel", senderLabel);
                return running;
            }
            throw new AlreadyActiveException();
        }
        // Bump generation before resource creation so a stale stop's recheck fails first.
        sessionGeneration.incrementAndGet();
        broadcastKey = broadcastKeyArg;
        senderId = senderIdArg;
        senderLabel = senderLabelArg;
        broadcastEnabled = (broadcastOpt == null) ? true : broadcastOpt;
        // Relay needs a broadcastKey; offline mode runs without one.
        boolean canBroadcast = broadcastEnabled && broadcastKey != null && !broadcastKey.isEmpty();
        // Resume context: when JS replays a sessionInterrupted event back into
        // startSession, the prior session's filename + start ms come along so
        // we can append to the existing CSV instead of fragmenting one logical
        // recording across two files.
        boolean resuming = resumeFilename != null && !resumeFilename.isEmpty()
            && resumeStartMs != null && resumeStartMs > 0L;
        sessionStartMs = resuming ? resumeStartMs : System.currentTimeMillis();
        NativeHrService.logLifecycle(appCtx, resuming ? "session_resume file=" + resumeFilename : "session_start");
        synchronized (rrWindow) { rrWindow.clear(); }
        synchronized (rrWindow5min) { rrWindow5min.clear(); }
        synchronized (rrWindow) {
            sdnnFullCount = 0;
            sdnnFullMean = 0.0;
            sdnnFullM2 = 0.0;
        }
        synchronized (liveBuffer) { liveBuffer.clear(); }
        synchronized (trendHrBuffer) { trendHrBuffer.clear(); }
        synchronized (trendRmssdBuffer) { trendRmssdBuffer.clear(); }
        lastUploadMs.set(0);
        lastFinalizeMs.set(System.currentTimeMillis());
        committing.set(false);

        // CSV — append to prior file when resuming, fresh file otherwise.
        // Close any writer still open from a prior start that never stopped so
        // its file handle doesn't leak.
        HrSink prevWriter;
        synchronized (this) { prevWriter = sink; sink = null; }
        if (prevWriter != null) { try { prevWriter.close(); } catch (Throwable ignored) {} }
        synchronized (this) {
            try {
                sink = new NativeCsvWriter(appCtx, sessionStartMs, resuming ? resumeFilename : null);
            } catch (Exception e) {
                Log.w(TAG, "Could not open CSV: " + e.getMessage());
                sink = null;
            }
        }
        HrSink opened = sink;
        uploader.resetSession();
        resumable.resetSession();
        if (opened != null) {
            // Stamp the active filename on the regular uploader so the
            // cleanup pass knows not to delete the in-progress CSV even
            // if the resumable path is doing all the actual uploads.
            uploader.markActiveSessionFilename(opened.getFile().getName());
            // Open the resumable session up-front. Async; callers later
            // read isReady() to decide chunk-vs-fallback. If openSession
            // fails or auth isn't ready yet, the periodic upload path
            // falls back to full PATCH transparently.
            resumable.startSessionAsync(opened.getFile().getName());
        }

        // Pre-session cleanup pass. Catches orphan CSVs from prior sessions
        // that ended unclean (process kill, OEM kill, force-stop).
        try {
            java.io.File sessionsDir = new java.io.File(appCtx.getFilesDir(), "sessions");
            long sevenDaysMs = 7L * 24L * 60L * 60L * 1000L;
            uploader.cleanupLocalCachedAsync(sessionsDir, sevenDaysMs);
            // Crash recovery: if the immediately-previous session ended
            // uncleanly (process killed mid-trickle, no finalize), its
            // resumable session was orphaned by Drive and the file never
            // appeared in the user's folder. Re-upload from the local
            // CSV so they can see it on the viewer.
            try {
                String prev = appCtx.getSharedPreferences("hr_monitor_session", 0)
                    .getString("lastSessionFilename", null);
                if (prev != null && !prev.isEmpty() && (opened == null || !prev.equals(opened.getFile().getName()))) {
                    uploader.uploadOrphanIfNeededAsync(sessionsDir, prev);
                }
            } catch (Throwable ignored) {}
            // Also full-scan: any local CSV whose Drive copy is missing OR
            // smaller than local (truncated upload from a session that
            // died before its final flush). Catches the case where the
            // dead session is NOT lastSessionFilename — e.g. user started
            // multiple sessions after the kill and the truncated file
            // is now two or three back in the lastSessionFilename chain.
            try { uploader.uploadOrphansAsync(sessionsDir); } catch (Throwable ignored) {}
        } catch (Throwable t) { /* never block session start */ }

        if (canBroadcast) openRelaySocket();

        // Start our own foreground service so Android keeps the process
        // alive + BLE callbacks firing while backgrounded.
        startNativeForegroundService("HR Monitor", "Recording");

        sessionActive.set(true);
        // Persist crash-safety flags + resume context. .commit() on the
        // booleans because SIGKILL between here and the heartbeat alarm
        // would lose the "we're recording" signal. Other keys are .apply
        // (best-effort) since they're rewritten at next session start
        // regardless.
        try {
            appCtx.getSharedPreferences("hr_monitor_session", 0).edit()
                .putBoolean("sessionActive", true)
                .putBoolean("cleanlyStopped", false)
                .commit();
            appCtx.getSharedPreferences("hr_monitor_session", 0).edit()
                .putLong("sessionStartMs", sessionStartMs)
                .putString("broadcastKey", broadcastKey == null ? "" : broadcastKey)
                .putString("senderId", senderId == null ? "" : senderId)
                .putString("senderLabel", senderLabel == null ? "" : senderLabel)
                .putBoolean("broadcastEnabled", broadcastEnabled)
                .putString("activeCsvFilename", opened != null ? opened.getFile().getName() : "")
                .apply();
        } catch (Throwable t) { Log.w(TAG, "session-state commit failed: " + t.getMessage()); }
        lastHrAtMs = System.currentTimeMillis();
        firstHrSeen = false;
        gattReconnectAttempts = 0;
        mainHandler.removeCallbacks(heartbeatRunnable);
        mainHandler.postDelayed(heartbeatRunnable, HEARTBEAT_INTERVAL_MS);
        emitState();
        JSONObject startedEv = putSafe(new JSONObject(), "sessionStartMs", sessionStartMs);
        if (opened != null) putSafe(startedEv, "csvFile", opened.getFilename());
        emit("publishingStarted", startedEv);
        JSONObject ret = putSafe(new JSONObject(), "started", true);
        if (opened != null) putSafe(ret, "csvFile", opened.getFilename());
        return ret;
    }

    /**
     * Stop the session ONLY if it is still the generation the caller intended
     * to stop. Guards the deferred FGS-Stop worker against tearing down a new
     * session the user started while the stop was in flight. Returns the stop
     * worker's latch, or null when nothing was stopped.
     */
    public java.util.concurrent.CountDownLatch stopSessionInternalIfCurrent(int expectedGeneration) {
        if (sessionGeneration.get() != expectedGeneration) {
            Log.i(TAG, "Deferred stop skipped — session generation changed.");
            return null;
        }
        return stopSessionInternal();
    }

    /** Returns after the stop flags commit; Drive work runs on hrm-stop-upload, whose end opens the latch. Null if already stopping. */
    public java.util.concurrent.CountDownLatch stopSessionInternal() {
        // Counted before the claim so a notification Stop landing in between takes the defer branch.
        stopWorkersRunning.incrementAndGet();
        // Claim the stop atomically; a concurrent JS + notification stop runs teardown once.
        if (!sessionActive.compareAndSet(true, false)) {
            stopWorkersRunning.decrementAndGet();
            Log.i(TAG, "stopSessionInternal skipped — already stopping.");
            return null;
        }
        final java.util.concurrent.CountDownLatch done = new java.util.concurrent.CountDownLatch(1);
        // Generation this stop tears down; a session started before the worker ends keeps its FGS.
        final int stopGen = sessionGeneration.get();
        boolean workerStarted = false;
        String finalizingName = null;
        try {
            NativeHrService.setFgLossReason(appCtx, "plugin_stop_session_internal");
            // Snapshot + null under lock so BLE binder reads can't observe a half-closed writer.
            HrSink snap;
            synchronized (this) { snap = sink; sink = null; }
            final String stoppedFilename = snap != null ? snap.getFile().getName() : null;
            // lastSessionFilename lands before resolve so a killed upload worker is caught by the next orphan pass.
            try {
                android.content.SharedPreferences.Editor ed = appCtx
                    .getSharedPreferences("hr_monitor_session", 0).edit()
                    .putBoolean("sessionActive", false)
                    .putBoolean("cleanlyStopped", true)
                    .putString("activeCsvFilename", "");
                if (stoppedFilename != null) ed.putString("lastSessionFilename", stoppedFilename);
                ed.commit();
            } catch (Throwable t) { Log.w(TAG, "session-state commit failed: " + t.getMessage()); }
            emit("publishingStopped", putSafe(new JSONObject(), "reason", "plugin_stop"));
            HrServiceHeartbeatReceiver.cancel(appCtx);
            mainHandler.removeCallbacks(heartbeatRunnable);
            mainHandler.removeCallbacks(gattReconnectRunnable);
            reconnectPending = false;
            // Relay closes now so presence-end carries this session's senderId and no tick follows Stop.
            closeRelaySocket();
            disconnectDevice();
            java.io.File stoppedFile = null;
            String knownFileId = null;
            java.util.concurrent.Future<NativeDriveResumableUploader.StopResult> finalize = null;
            if (snap != null) {
                snap.close();
                stoppedFile = snap.getFile();
                NativeDriveUploader.markFinalizing(stoppedFilename);
                finalizingName = stoppedFilename;
                knownFileId = uploader.getSessionFileId();
                // Queued now, so the next session's resetSession/startSessionAsync run after it.
                finalize = resumable.finalizeForStopAsync(stoppedFile);
            }
            emitState();
            final java.io.File workFile = stoppedFile;
            final String workFileId = knownFileId;
            final java.util.concurrent.Future<NativeDriveResumableUploader.StopResult> workFinalize = finalize;
            final NativeDriveUploader workUploader = uploader;
            Runnable work = () -> runStopUpload(workFile, workFileId, workFinalize, workUploader, stopGen, done);
            workerStarted = true;
            try {
                new Thread(work, "hrm-stop-upload").start();
            } catch (Throwable t) {
                Log.w(TAG, "hrm-stop-upload start failed, running inline: " + t);
                work.run();
            }
            return done;
        } finally {
            if (!workerStarted) {
                // Teardown threw before the worker took over: release the FGS, the flag and the skip mark here.
                try { stopForegroundUnlessNewerSession(stopGen); } catch (Throwable ignored) {}
                NativeDriveUploader.clearFinalizing(finalizingName);
                stopWorkersRunning.decrementAndGet();
                done.countDown();
            }
        }
    }

    // Body of the hrm-stop-upload worker. Reads only its arguments, never the live session fields.
    private void runStopUpload(java.io.File file, String knownFileId,
            java.util.concurrent.Future<NativeDriveResumableUploader.StopResult> fut, NativeDriveUploader up,
            int stopGen, java.util.concurrent.CountDownLatch done) {
        String name = file != null ? file.getName() : null;
        NativeHrService.logLifecycle(appCtx, "stop_worker_start file=" + name);
        String outcome = "no_file";
        try {
            if (file != null) {
                NativeDriveResumableUploader.StopResult fin = null;
                boolean finTimedOut = false;
                if (fut != null) {
                    try {
                        fin = fut.get(STOP_FINALIZE_WAIT_MS, TimeUnit.MILLISECONDS);
                    } catch (java.util.concurrent.TimeoutException te) {
                        finTimedOut = true;
                    } catch (InterruptedException ie) {
                        Thread.currentThread().interrupt();
                        finTimedOut = true;
                    } catch (Throwable t) {
                        Log.w(TAG, "stop finalize threw: " + t);
                    }
                }
                String fileId = fin != null && fin.fileId != null ? fin.fileId : knownFileId;
                // A finalize still in flight may commit later; never create a same-name copy beside it.
                boolean safetyOk = up != null && up.uploadFinishedSync(file, fileId, !finTimedOut);
                outcome = "finalize=" + (fin != null && fin.ok)
                    + (finTimedOut ? " finalize_timeout" : "")
                    + " fileId=" + (fileId != null) + " safety=" + safetyOk;
                Log.i(TAG, "stop upload " + name + ": " + outcome);
            }
        } catch (Throwable t) {
            outcome = "threw " + t;
            Log.w(TAG, "stop upload threw: " + t);
        } finally {
            boolean fgsStopped = false;
            try { fgsStopped = stopForegroundUnlessNewerSession(stopGen); } catch (Throwable ignored) {}
            try {
                if (up != null) {
                    java.io.File sessionsDir = new java.io.File(appCtx.getFilesDir(), "sessions");
                    up.cleanupLocalCachedAsync(sessionsDir, 7L * 24L * 60L * 60L * 1000L);
                }
            } catch (Throwable ignored) {}
            NativeDriveUploader.clearFinalizing(name);
            stopWorkersRunning.decrementAndGet();
            NativeHrService.logLifecycle(appCtx, "stop_worker_end " + outcome + " fgsStopped=" + fgsStopped);
            done.countDown();
        }
    }

    // Stops the FGS unless a newer session owns it; returns true if stopped.
    private boolean stopForegroundUnlessNewerSession(int stopGen) {
        boolean newer = sessionGeneration.get() != stopGen || sessionActive.get();
        if (newer) {
            Log.i(TAG, "stop worker — newer session owns the FGS; leaving it up.");
            return false;
        }
        stopNativeForegroundService();
        // A Start in the gap between the check and stopService gets its FGS back.
        if (sessionActive.get()) {
            NativeHrService.logLifecycle(appCtx, "stop_worker_fgs_restarted");
            startNativeForegroundService("HR Monitor", "Recording");
        }
        return true;
    }

    public JSONObject statusJson() {
        JSONObject ret = new JSONObject();
        boolean active = sessionActive.get();
        putSafe(ret, "sessionActive", active);
        putSafe(ret, "bleConnected", device.hasHandle());
        putSafe(ret, "relayLive", relayLive.get());
        HrSink statusWriter = sink;
        if (statusWriter != null) {
            putSafe(ret, "csvFile", statusWriter.getFilename());
            putSafe(ret, "sessionStartMs", statusWriter.getSessionStartMs());
        }
        // Expose the relay identity so a fresh WebView (Activity restart with
        // FGS surviving) adopts our senderId instead of minting a new one.
        // Otherwise JS sees our own relay ticks as a foreign broadcaster.
        // isEmpty guard matches the persistence check so an empty string
        // can never round-trip through status() either.
        if (active && senderId != null && !senderId.isEmpty()) {
            putSafe(ret, "senderId", senderId);
            putSafe(ret, "senderLabel", senderLabel == null ? "" : senderLabel);
        }
        // When the in-memory AtomicBoolean disagrees with persisted state, the
        // process was killed mid-session. JS reads the recoveryContext block
        // synchronously from this snapshot — no event timing race.
        try {
            android.content.SharedPreferences prefs = appCtx
                .getSharedPreferences("hr_monitor_session", 0);
            boolean prefsActive = prefs.getBoolean("sessionActive", false);
            boolean cleanly = prefs.getBoolean("cleanlyStopped", true);
            boolean recoveryPending = prefsActive && !cleanly && !active;
            putSafe(ret, "interruptedRecovery", recoveryPending);
            if (recoveryPending) {
                putSafe(ret, "recoveryContext", buildRecoveryContext(prefs,
                    prefs.getLong("last_alive_ms", 0),
                    prefs.getString("last_fg_loss_reason", null),
                    prefs.getLong("last_fg_loss_ms", 0),
                    prefs.getInt("last_trim_memory_level", 0),
                    prefs.getLong("last_trim_memory_ms", 0)));
            }
        } catch (Throwable ignored) {
            putSafe(ret, "interruptedRecovery", false);
        }
        return ret;
    }

    // Single source of truth for the interrupted-recovery payload: status() and the transitional load() emit.
    static JSONObject buildRecoveryContext(android.content.SharedPreferences prefs,
            long lastAliveMs, String lastFgLossReason, long lastFgLossMs,
            int lastTrimLevel, long lastTrimMs) {
        JSONObject ctx = new JSONObject();
        putSafe(ctx, "mac", prefs.getString("lastConnectedMac", ""));
        putSafe(ctx, "broadcastKey", prefs.getString("broadcastKey", ""));
        putSafe(ctx, "senderId", prefs.getString("senderId", ""));
        putSafe(ctx, "senderLabel", prefs.getString("senderLabel", ""));
        putSafe(ctx, "broadcastEnabled", prefs.getBoolean("broadcastEnabled", true));
        putSafe(ctx, "sessionStartMs", prefs.getLong("sessionStartMs", 0));
        putSafe(ctx, "activeCsvFilename", prefs.getString("activeCsvFilename", ""));
        putSafe(ctx, "lastAliveMs", lastAliveMs);
        putSafe(ctx, "lastFgLossReason", lastFgLossReason);
        putSafe(ctx, "lastFgLossMs", lastFgLossMs);
        putSafe(ctx, "lastTrimMemoryLevel", lastTrimLevel);
        putSafe(ctx, "lastTrimMemoryMs", lastTrimMs);
        return ctx;
    }

    // ---- Strap callbacks ----------------------------------------------------

    @Override
    public void onLinkUp() {
        NativeHrService.logLifecycle(appCtx, "gatt_connected");
        emitState();
    }

    @Override
    public void onLinkDown(int status) {
        NativeHrService.logLifecycle(appCtx, "gatt_disconnected status=" + status + " sessionActive=" + sessionActive.get());
        HrSink w = sink;
        if (w != null) w.appendConnection("disconnected", System.currentTimeMillis());
        emitState();
        if (sessionActive.get()) scheduleGattReconnect();
    }

    @Override
    public void onStreamsLive() {
        NativeHrService.logLifecycle(appCtx, "notifications_live");
        HrSink w = sink;
        if (w != null) w.appendConnection("connected", System.currentTimeMillis());
    }

    @Override
    public void onError(String reason, boolean staleBondCleared) {
        JSONObject err = putSafe(new JSONObject(), "reason", reason);
        putSafe(err, "staleBondCleared", staleBondCleared);
        emit("bleError", err);
    }

    @Override public void onEcg(long tsMs, int[] microvolts) { }

    @Override public void onAcc(long tsMs, int[] xyzMilliG) { }

    @Override
    public void onHr(int hr, int[] rrMs, boolean contactOff, long tsMs) {
        long now = tsMs;
        lastHrAtMs = now;
        firstHrSeen = true;
        gattReconnectAttempts = 0;
        if (now - lastAliveWriteMs >= ALIVE_WRITE_INTERVAL_MS) {
            lastAliveWriteMs = now;
            try {
                appCtx.getSharedPreferences("hr_monitor_session", 0)
                    .edit().putLong("last_alive_ms", now).apply();
            } catch (Throwable ignored) {}
        }
        // synchronized: BLE binder writes, main thread reads in publishTick.
        Double rmssd;
        Double sdnnMatch;
        synchronized (rrWindow) {
            if (rrMs != null) {
                for (int rr : rrMs) rrWindow.addLast(new RrEntry(rr, now));
            }
            long cutoff = now - RR_WINDOW_MS;
            Iterator<RrEntry> it = rrWindow.iterator();
            while (it.hasNext()) {
                if (it.next().timestampMs < cutoff) it.remove();
                else break;
            }
            rmssd = computeRmssd(rrWindow);
            sdnnMatch = computeSdnn(rrWindow);
            // Welford running stats — fed once per RR. Same range filter as
            // computeRmssd / computeSdnn for parity.
            if (rrMs != null) {
                for (int rr : rrMs) {
                    if (rr >= 300 && rr <= 2000) {
                        sdnnFullCount++;
                        double delta = rr - sdnnFullMean;
                        sdnnFullMean += delta / sdnnFullCount;
                        double delta2 = rr - sdnnFullMean;
                        sdnnFullM2 += delta * delta2;
                    }
                }
            }
        }
        Double sdnn5min;
        synchronized (rrWindow5min) {
            if (rrMs != null) {
                for (int rr : rrMs) rrWindow5min.addLast(new RrEntry(rr, now));
            }
            long cutoff5 = now - RR_WINDOW_5MIN_MS;
            Iterator<RrEntry> it5 = rrWindow5min.iterator();
            while (it5.hasNext()) {
                if (it5.next().timestampMs < cutoff5) it5.remove();
                else break;
            }
            sdnn5min = computeSdnn(rrWindow5min);
        }
        Double sdnnFull = (sdnnFullCount >= 2)
            ? Math.sqrt(sdnnFullM2 / (sdnnFullCount - 1))
            : null;

        synchronized (liveBuffer) {
            if (rrMs != null) {
                for (int rr : rrMs) {
                    if (rr > 0) {
                        double instantBpm = 60000.0 / rr;
                        liveBuffer.addLast(new double[] { now, instantBpm });
                    }
                }
            }
            long liveCutoff = now - LIVE_WINDOW_MS;
            while (!liveBuffer.isEmpty() && liveBuffer.peekFirst()[0] < liveCutoff) liveBuffer.pollFirst();
        }

        // trendHR / trendRmssd: per-tick HR + RMSSD, 3 min window.
        long trendCutoff = now - TREND_WINDOW_MS;
        synchronized (trendHrBuffer) {
            trendHrBuffer.addLast(new double[] { now, hr });
            while (!trendHrBuffer.isEmpty() && trendHrBuffer.peekFirst()[0] < trendCutoff) trendHrBuffer.pollFirst();
        }
        if (rmssd != null) {
            synchronized (trendRmssdBuffer) {
                trendRmssdBuffer.addLast(new double[] { now, rmssd });
                while (!trendRmssdBuffer.isEmpty() && trendRmssdBuffer.peekFirst()[0] < trendCutoff) trendRmssdBuffer.pollFirst();
            }
        }

        HrSink writer = sink;
        if (writer != null) {
            writer.appendHr(
                hr,
                rmssd,
                sdnnMatch != null ? sdnnMatch : 0.0,
                sdnn5min != null ? sdnn5min : 0.0,
                sdnnFull != null ? sdnnFull : 0.0,
                now);
            int consec = writer.getConsecutiveFailures();
            if (consec == CSV_FAIL_ALERT_THRESHOLD) {
                JSONObject err = putSafe(new JSONObject(), "kind", "csv");
                putSafe(err, "totalFailures", writer.getTotalFailures());
                putSafe(err, "consecutiveFailures", consec);
                emit("csvError", err);
            }
        }

        publishTick(hr, rmssd, contactOff, now);

        FloatingOverlayService.HrUpdateListener overlay = floatingOverlayListener;
        if (overlay != null) {
            try { overlay.onHrUpdate(hr, rmssd != null ? rmssd : 0.0); } catch (Throwable ignored) {}
        }

        JSONObject ev = putSafe(new JSONObject(), "hr", hr);
        if (rmssd != null) putSafe(ev, "rmssd", rmssd);
        putSafe(ev, "contactOff", contactOff);
        putSafe(ev, "timestampMs", now);
        if (rrMs != null && rrMs.length > 0) {
            org.json.JSONArray arr = new org.json.JSONArray();
            for (int rr : rrMs) arr.put(rr);
            putSafe(ev, "rrIntervals", arr);
        }
        emit("hr", ev);

        // Periodic Drive upload. Prefer the resumable trickle path: opens
        // a single Drive upload session at startSession and trickles only
        // the new bytes (256 KB-aligned chunks) instead of re-uploading
        // the whole CSV every interval. ~50x cellular bytes saved on a
        // long sleep session. If the resumable session FAILED (auth fail,
        // network blip during open POST), fall back to the full-file
        // PATCH path so there's still a Drive backup growing. If the
        // resumable session is still INITIALIZING (in-flight, not yet
        // ready and not yet broken), skip this interval — we'd otherwise
        // create a duplicate Drive file with the same filename.
        HrSink uploadWriter = sink;
        if (uploadWriter != null && !committing.get()) {
            long since = now - lastUploadMs.get();
            if (since >= DRIVE_UPLOAD_INTERVAL_MS) {
                if (resumable.isReady()) {
                    lastUploadMs.set(now);
                    resumable.appendChunkIfReadyAsync(uploadWriter.getFile());
                } else if (resumable.isBroken()) {
                    lastUploadMs.set(now);
                    uploader.uploadAsync(uploadWriter.getFile());
                }
                // else: resumable is initializing — skip this tick, retry next interval.
            }
        }
        // Periodic finalize: makes the trickled bytes visible in Drive at
        // the current state. Falls back to a full upload if the resumable
        // session isn't ready.
        if (sink != null && !committing.get()
                && now - lastFinalizeMs.get() >= DRIVE_FINALIZE_INTERVAL_MS) {
            if (committing.compareAndSet(false, true)) {
                lastFinalizeMs.set(now);
                finalizeAndRestartAsync();
            }
        }

        // Notification update cadence: 5 s screen-on, 10 s screen-off.
        // Higher rates trigger Samsung's "abusive notification" heuristic
        // and provoke FGS kills during overnight Doze. Suspected regression
        // for sessions ending mid-sleep (May 2026).
        long notifInterval = 10000L;
        try {
            android.os.PowerManager pm = (android.os.PowerManager) appCtx.getSystemService(android.content.Context.POWER_SERVICE);
            if (pm != null && pm.isInteractive()) notifInterval = 5000L;
        } catch (Throwable ignored) {}
        if (now - lastNotifUpdateMs >= notifInterval && sessionActive.get()) {
            lastNotifUpdateMs = now;
            long elapsedMs = now - sessionStartMs;
            long mm = elapsedMs / 60000L;
            long ss = (elapsedMs / 1000L) % 60;
            String body = String.format(java.util.Locale.US, "Recording · %d:%02d", mm, ss);
            String title = "HR " + hr + " bpm" + (rmssd != null ? " · HRV " + Math.round(rmssd) + "ms" : "");
            updateNativeForegroundService(title, body);
        }
    }

    // ---- Stage bands ------------------------------------------------------

    // PARITY CRITICAL — defaults must match hr_monitor.html stage bands.
    private volatile int stageLow = 70;
    private volatile int stageNormal = 90;
    private volatile int stageElevated = 110;
    private volatile int stageHigh = 130;

    public void setStageThresholds(Integer low, Integer normal, Integer elevated, Integer high, Integer rmssdCritical) {
        if (low != null) stageLow = low;
        if (normal != null) stageNormal = normal;
        if (elevated != null) stageElevated = elevated;
        if (high != null) stageHigh = high;
        if (rmssdCritical != null) stageRmssdCritical = rmssdCritical;
    }

    private String hrStage(int hr) {
        if (hr <= stageLow) return "stage-low";
        if (hr < stageNormal) return "stage-normal";
        if (hr < stageElevated) return "stage-elevated";
        if (hr < stageHigh) return "stage-high";
        return "stage-critical";
    }

    // PARITY CRITICAL — MUST MATCH hr_monitor.html:getRMSSDStage.
    private volatile int stageRmssdCritical = 15;
    private String rmssdStage(double rmssd) {
        if (rmssd < stageRmssdCritical) return "stage-critical";
        if (rmssd < 20) return "stage-high";
        if (rmssd < 35) return "stage-elevated";
        if (rmssd < 60) return "stage-normal";
        return "stage-low";
    }
}
