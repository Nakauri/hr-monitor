package com.nakauri.hrmonitor;

import android.Manifest;
import android.annotation.SuppressLint;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothDevice;
import android.bluetooth.BluetoothGatt;
import android.bluetooth.BluetoothGattCallback;
import android.bluetooth.BluetoothGattCharacteristic;
import android.bluetooth.BluetoothGattDescriptor;
import android.bluetooth.BluetoothManager;
import android.bluetooth.le.BluetoothLeScanner;
import android.bluetooth.le.ScanCallback;
import android.bluetooth.le.ScanResult;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;

import org.json.JSONArray;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.Iterator;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicLong;

import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.WebSocket;
import okhttp3.WebSocketListener;
import okio.ByteString;

/**
 * End-to-end native HR session pipeline.
 *
 * Runs the BLE → tick → relay → CSV → Drive path entirely in native code so
 * it survives WebView pause / Chromium background-tab JS throttling. The
 * WebView-hosted JS only consumes plugin events for live UI display when the
 * app is foregrounded; data flow is independent of JS execution.
 *
 * Public Capacitor methods:
 *   scan({timeoutMs?})            — scan for HR-service straps. Returns device list.
 *   connect({mac})                — connect via BluetoothGatt + subscribe to 0x2A37.
 *   startSession({broadcastKey, senderId, senderLabel})
 *                                — open relay WebSocket + start CSV file +
 *                                  begin Drive upload cadence.
 *   stopSession()                 — flush CSV + final Drive push + close socket.
 *   disconnect()                  — close BLE.
 *   status()                      — current state.
 *
 * Events emitted to JS:
 *   discovered  { mac, name, rssi }      — per scan result
 *   state       { ble, relay }           — connection state changes
 *   hr          { hr, rmssd, rrIntervals[], timestampMs }  — per HR notification
 */
@CapacitorPlugin(name = "NativeHrSession", permissions = {
    @Permission(strings = { Manifest.permission.BLUETOOTH_SCAN }, alias = "bluetoothScan"),
    @Permission(strings = { Manifest.permission.BLUETOOTH_CONNECT }, alias = "bluetoothConnect"),
})
public class NativeHrSessionPlugin extends Plugin {
    private static final String TAG = "NativeHrSession";

    // BLE UUIDs
    private static final UUID HR_SERVICE = UUID.fromString("0000180d-0000-1000-8000-00805f9b34fb");
    private static final UUID HR_MEASUREMENT = UUID.fromString("00002a37-0000-1000-8000-00805f9b34fb");
    private static final UUID CCCD = UUID.fromString("00002902-0000-1000-8000-00805f9b34fb");

    // RMSSD window — rolling 30 s of RR intervals, matching
    // hr_monitor.html:~2634 (`cutoff = now - 0.5` minute). 30 s is the
    // responsive-monitoring choice: brief flushes / vagal bursts / chills
    // show up visibly in the live number instead of being averaged out.
    // 60 s would be steadier but hides the events this app is built to
    // surface.
    // PARITY CRITICAL — see scripts/rmssd-parity.test.js.
    private static final long RR_WINDOW_MS = 30_000L;
    // Drive upload cadence — every 30 s. Same data pace as the JS auto-save.
    private static final long DRIVE_UPLOAD_INTERVAL_MS = 30_000L;
    // Fire a csvError event once after this many consecutive write failures.
    // Below this threshold a single transient error is silently retried; at
    // the threshold the UI gets one signal so it can show a banner. Resets
    // on the next successful write — won't re-fire until another N-streak.
    private static final int CSV_FAIL_ALERT_THRESHOLD = 5;
    // Buffers for the overlay charts. livePoints = 45 s of instantaneous
    // per-beat BPM; trend = 3 min of per-second HR + RMSSD. These match
    // what hr_monitor.html's broadcastTick emits so overlay.html renders
    // identically whether the sender is the web app or the native plugin.
    private static final long LIVE_WINDOW_MS = 45_000L;
    private static final long TREND_WINDOW_MS = 180_000L;

    private final Handler mainHandler = new Handler(Looper.getMainLooper());

    // BLE state
    private BluetoothAdapter adapter;
    private BluetoothLeScanner scanner;
    private BluetoothGatt currentGatt;
    private BluetoothGattCharacteristic hrChar;
    private final List<DiscoveredDevice> scanResults = new ArrayList<>();
    private ScanCallback scanCallback;

    // Session state
    private String broadcastKey;
    private String senderId;
    private String senderLabel;
    private long sessionStartMs;
    private final AtomicBoolean sessionActive = new AtomicBoolean(false);

    // RR + RMSSD
    private final Deque<RrEntry> rrWindow = new ArrayDeque<>();
    // Rolling buffers for the overlay chart payloads. See LIVE_WINDOW_MS
    // and TREND_WINDOW_MS above. Each entry keeps the wall-clock ms and
    // the value; the publish path converts to seconds / minutes since
    // sessionStartMs at emit time.
    private final Deque<double[]> liveBuffer = new ArrayDeque<>();
    private final Deque<double[]> trendHrBuffer = new ArrayDeque<>();
    private final Deque<double[]> trendRmssdBuffer = new ArrayDeque<>();

    // Recording + Drive. csv is volatile because the BLE binder thread reads
    // it (handleHrReading → csv.appendHrRow) while the main thread can null
    // it on session stop. NativeCsvWriter.appendHrRow is itself synchronized,
    // so the inner call is safe; volatile just prevents the dereference race
    // (binder sees non-null, main thread nulls + closes, binder dereferences
    // the closed writer → IOException, currently swallowed).
    private volatile NativeCsvWriter csv;
    private NativeDriveUploader uploader;
    private final AtomicLong lastUploadMs = new AtomicLong(0);

    // Relay WebSocket — owned by this plugin so publishing happens
    // entirely in native code, immune to WebView pause.
    private OkHttpClient httpClient;
    private WebSocket relaySocket;
    private final AtomicBoolean relayLive = new AtomicBoolean(false);

    // Throttle notification updates to 1 Hz (HR ticks come in at ~1/s anyway,
    // but guard against bursts).
    private long lastNotifUpdateMs = 0;

    // Widget prefs mirror. JS pushes this via setPrefs() whenever the
    // user toggles a widget checkbox. publishTick splices it into every
    // outgoing relay message so overlay.html can resize / hide the same
    // way whether the sender is the web app or the native plugin.
    private volatile String prefsJson = null;

    // Static ref so NativeHrService (separate Android component) can ask
    // us to clean up when the user taps Stop from the notification.
    // volatile so concurrent reads from the service thread see a consistent
    // value when load()/handleOnDestroy() race with notification taps.
    public static volatile NativeHrSessionPlugin instance;

    @Override
    public void load() {
        instance = this;
        BluetoothManager bm = (BluetoothManager) getContext().getSystemService(Context.BLUETOOTH_SERVICE);
        if (bm != null) {
            adapter = bm.getAdapter();
            if (adapter != null) scanner = adapter.getBluetoothLeScanner();
        }
        httpClient = new OkHttpClient.Builder()
            .pingInterval(20, TimeUnit.SECONDS)
            .readTimeout(0, TimeUnit.SECONDS)
            .build();
        uploader = new NativeDriveUploader(getContext());
        registerNetworkCallback();
    }

    @Override
    protected void handleOnDestroy() {
        // Activity / WebView going down. Clear the static so the
        // NativeHrService notification handler doesn't dispatch into a dead
        // plugin. The session itself keeps running because the FGS owns it
        // independently — only the JS bridge handle is invalidated here.
        if (instance == this) instance = null;
        unregisterNetworkCallback();
        super.handleOnDestroy();
    }

    // ---- Network change handling ----------------------------------------
    // OkHttp WebSocket with readTimeout(0) (= forever) silently stalls when
    // Wi-Fi / cellular hand off underneath. Listen for ConnectivityManager
    // NetworkCallback events and force a relay socket reconnect on every
    // network transition so the session recovers within seconds instead of
    // hanging until something else times out.
    private android.net.ConnectivityManager.NetworkCallback networkCallback;
    private android.net.Network lastActiveNetwork;

    private void registerNetworkCallback() {
        if (networkCallback != null) return;
        try {
            android.net.ConnectivityManager cm = (android.net.ConnectivityManager)
                getContext().getSystemService(Context.CONNECTIVITY_SERVICE);
            if (cm == null) return;
            networkCallback = new android.net.ConnectivityManager.NetworkCallback() {
                @Override public void onAvailable(android.net.Network network) {
                    if (lastActiveNetwork != null && !network.equals(lastActiveNetwork) && sessionActive.get()) {
                        Log.i(TAG, "Network changed — forcing relay reconnect");
                        relayReconnectAttempts = 0;  // reset so backoff doesn't punish a real transition
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

    private void unregisterNetworkCallback() {
        if (networkCallback == null) return;
        try {
            android.net.ConnectivityManager cm = (android.net.ConnectivityManager)
                getContext().getSystemService(Context.CONNECTIVITY_SERVICE);
            if (cm != null) cm.unregisterNetworkCallback(networkCallback);
        } catch (Throwable t) { /* ignore — process is going away */ }
        networkCallback = null;
    }

    // ---- Plugin methods --------------------------------------------------

    @PluginMethod
    @SuppressLint("MissingPermission")
    public void scan(PluginCall call) {
        if (scanner == null) { call.reject("Bluetooth unavailable"); return; }
        long timeoutMs = call.getLong("timeoutMs", 8000L);
        scanResults.clear();
        if (scanCallback == null) {
            scanCallback = new ScanCallback() {
                @Override
                public void onScanResult(int callbackType, ScanResult result) {
                    ingestScanResult(result);
                }
                @Override
                public void onScanFailed(int errorCode) {
                    Log.w(TAG, "Scan failed errorCode=" + errorCode);
                }
            };
        }
        try {
            // Unfiltered — many straps (Coospo H808S included) advertise
            // 0x180D only in scan response, not the primary advertisement.
            // Filtering would miss them. Classify in ingestScanResult.
            scanner.startScan(scanCallback);
            mainHandler.postDelayed(() -> {
                try { scanner.stopScan(scanCallback); } catch (Exception ignored) {}
                JSArray arr = new JSArray();
                for (DiscoveredDevice d : scanResults) {
                    JSObject obj = new JSObject();
                    obj.put("mac", d.mac);
                    obj.put("name", d.name);
                    obj.put("rssi", d.rssi);
                    obj.put("isHr", d.isHr);
                    arr.put(obj);
                }
                JSObject ret = new JSObject();
                ret.put("devices", arr);
                call.resolve(ret);
            }, timeoutMs);
        } catch (SecurityException e) {
            call.reject("BLUETOOTH_SCAN denied: " + e.getMessage());
        }
    }

    @PluginMethod
    @SuppressLint("MissingPermission")
    public void connect(PluginCall call) {
        String mac = call.getString("mac");
        if (mac == null) { call.reject("mac required"); return; }
        if (adapter == null) { call.reject("Bluetooth adapter unavailable"); return; }
        // Use cached BluetoothDevice from scan if we have one — has correct
        // address type (PUBLIC vs RANDOM). Falls back to getRemoteDevice.
        BluetoothDevice device = null;
        for (DiscoveredDevice d : scanResults) {
            if (d.mac.equals(mac)) { device = d.btDevice; break; }
        }
        if (device == null) device = adapter.getRemoteDevice(mac);

        closeGattQuietly();
        try {
            currentGatt = device.connectGatt(getContext(), false, gattCallback);
            JSObject ret = new JSObject();
            ret.put("connecting", true);
            call.resolve(ret);
        } catch (SecurityException e) {
            call.reject("BLUETOOTH_CONNECT denied: " + e.getMessage());
        }
    }

    @PluginMethod
    public void startSession(PluginCall call) {
        broadcastKey = call.getString("broadcastKey");
        senderId = call.getString("senderId", "android");
        senderLabel = call.getString("senderLabel", "HR Monitor Android");
        if (broadcastKey == null || broadcastKey.isEmpty()) {
            call.reject("broadcastKey required");
            return;
        }
        sessionStartMs = System.currentTimeMillis();
        synchronized (rrWindow) { rrWindow.clear(); }
        synchronized (liveBuffer) { liveBuffer.clear(); }
        synchronized (trendHrBuffer) { trendHrBuffer.clear(); }
        synchronized (trendRmssdBuffer) { trendRmssdBuffer.clear(); }
        lastUploadMs.set(0);

        // CSV
        try {
            csv = new NativeCsvWriter(getContext(), sessionStartMs);
        } catch (Exception e) {
            Log.w(TAG, "Could not open CSV: " + e.getMessage());
            csv = null;
        }
        if (uploader != null) uploader.resetSession();

        // Relay WebSocket
        openRelaySocket();

        // Start our own foreground service so Android keeps the process
        // alive + BLE callbacks firing while backgrounded. Replaces the
        // @capawesome FGS plugin on the session path (which crashed with
        // "did not then call startForeground" during teardown).
        startNativeForegroundService("HR Monitor", "Recording");

        sessionActive.set(true);
        emitState();
        JSObject ret = new JSObject();
        ret.put("started", true);
        if (csv != null) ret.put("csvFile", csv.getFilename());
        call.resolve(ret);
    }

    @PluginMethod
    public void stopSession(PluginCall call) {
        stopSessionInternal();
        call.resolve(new JSObject().put("stopped", true));
    }

    /**
     * Non-plugin-call shutdown path. Called by the Stop action in the
     * FGS notification (NativeHrService triggers this directly so the
     * CSV is flushed and Drive gets a final push even when the user
     * kills the session without having the app open).
     */
    public void stopSessionInternal() {
        sessionActive.set(false);
        if (csv != null) {
            csv.close();
            if (uploader != null) uploader.uploadAsync(csv.getFile());
            csv = null;
        }
        closeRelaySocket();
        closeGattQuietly();
        stopNativeForegroundService();
        // Fire-and-forget local CSV cleanup. Only deletes files that have
        // been verified-uploaded to Drive AND are at least 7 days old —
        // never touches the just-stopped session or anything Drive doesn't
        // already have. Runs on the upload executor; doesn't block stop.
        try {
            if (uploader != null) {
                java.io.File sessionsDir = new java.io.File(getContext().getFilesDir(), "sessions");
                long sevenDaysMs = 7L * 24L * 60L * 60L * 1000L;
                uploader.cleanupLocalCachedAsync(sessionsDir, sevenDaysMs);
            }
        } catch (Throwable t) { /* cleanup is best-effort; never block stop */ }
        emitState();
    }

    @PluginMethod
    public void disconnect(PluginCall call) {
        closeGattQuietly();
        call.resolve(new JSObject().put("disconnected", true));
    }

    @PluginMethod
    public void setPrefs(PluginCall call) {
        JSObject p = call.getObject("prefs");
        prefsJson = p != null ? p.toString() : null;
        call.resolve();
    }

    // Returns the active session's CSV contents + start epoch so the WebView
    // can rehydrate state.hrSeries / state.rmssdSeries after being reclaimed
    // mid-session. Rejects if no session is active or the file is missing.
    @PluginMethod
    public void getSessionSnapshot(PluginCall call) {
        // Optional tailMinutes — when set, only read the trailing ~N minutes of
        // the CSV instead of the full file. Saves a 1-3 MB disk read + JSON
        // IPC + JS parse on long sessions where rehydrate only keeps the last
        // 3 min anyway. Omitting the arg = legacy behaviour (read the full file).
        final Integer tailMinutes = call.getInt("tailMinutes");
        executor().execute(() -> {
            try {
                if (!sessionActive.get() || csv == null) {
                    call.reject("no_active_session");
                    return;
                }
                java.io.File file = csv.getFile();
                if (file == null || !file.exists()) {
                    call.reject("no_csv_file");
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
                JSObject ret = new JSObject();
                ret.put("filename", csv.getFilename());
                ret.put("csv", text);
                ret.put("sessionStartMs", csv.getSessionStartMs());
                // sizeBytes = full on-disk file size (diagnostic only, JS logs it).
                // In tail mode the actual transferred payload is ~tailMinutes worth,
                // not this — but the caller cares about total file size.
                ret.put("sizeBytes", size);
                call.resolve(ret);
            } catch (Exception e) {
                call.reject("getSessionSnapshot failed: " + e.getMessage(), e);
            }
        });
    }

    // ---- Auth storage (Keystore-backed) ---------------------------------
    // JS sign-in flow: SocialLogin.login -> serverAuthCode -> POST
    // /api/auth/exchange -> storeAuthTokens(). Native background uploader
    // then reads the encrypted access+refresh pair via AuthStorage directly.

    @PluginMethod
    public void storeAuthTokens(PluginCall call) {
        String accessToken = call.getString("access_token");
        String refreshToken = call.getString("refresh_token");
        Long expiresAt = call.getLong("expires_at");
        String email = call.getString("email");
        executor().execute(() -> {
            try {
                AuthStorage.store(getContext(), accessToken, refreshToken,
                    expiresAt != null ? expiresAt : 0L, email);
                call.resolve();
            } catch (Exception e) {
                call.reject("storeAuthTokens failed: " + e.getMessage(), e);
            }
        });
    }

    @PluginMethod
    public void getValidAccessToken(PluginCall call) {
        executor().execute(() -> {
            String token = AuthStorage.getValidAccessToken(getContext());
            if (token == null) {
                call.reject("no_valid_token");
                return;
            }
            JSObject ret = new JSObject();
            ret.put("access_token", token);
            ret.put("expires_at", AuthStorage.getExpiresAt(getContext()));
            ret.put("email", AuthStorage.getEmail(getContext()));
            call.resolve(ret);
        });
    }

    @PluginMethod
    public void clearAuth(PluginCall call) {
        executor().execute(() -> {
            AuthStorage.clear(getContext());
            call.resolve();
        });
    }

    @PluginMethod
    public void authStatus(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("signed_in", AuthStorage.isSignedIn(getContext()));
        ret.put("email", AuthStorage.getEmail(getContext()));
        ret.put("expires_at", AuthStorage.getExpiresAt(getContext()));
        call.resolve(ret);
    }

    private java.util.concurrent.ExecutorService authExecutor;
    private synchronized java.util.concurrent.ExecutorService executor() {
        if (authExecutor == null) {
            authExecutor = java.util.concurrent.Executors.newSingleThreadExecutor();
        }
        return authExecutor;
    }

    @PluginMethod
    public void status(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("sessionActive", sessionActive.get());
        ret.put("bleConnected", currentGatt != null);
        ret.put("relayLive", relayLive.get());
        if (csv != null) ret.put("csvFile", csv.getFilename());
        call.resolve(ret);
    }

    // ---- BLE plumbing ----------------------------------------------------

    private final BluetoothGattCallback gattCallback = new BluetoothGattCallback() {
        @Override
        @SuppressLint("MissingPermission")
        public void onConnectionStateChange(BluetoothGatt gatt, int status, int newState) {
            if (newState == BluetoothGatt.STATE_CONNECTED) {
                Log.i(TAG, "GATT connected");
                emitState();
                gatt.discoverServices();
            } else if (newState == BluetoothGatt.STATE_DISCONNECTED) {
                Log.i(TAG, "GATT disconnected status=" + status);
                hrChar = null;
                if (csv != null) csv.appendConnectionRow("disconnected", System.currentTimeMillis());
                emitState();
                // Auto-reconnect if the session is still active. Android
                // supervision timeout (status 8) + short link flicks happen
                // all the time — phone in pocket, body in the way, brief RF
                // contention — and we want to recover without user action.
                // gatt.connect() reuses the existing binding, so this is
                // cheaper than building a new BluetoothGatt.
                if (sessionActive.get()) {
                    final BluetoothGatt g = gatt;
                    mainHandler.postDelayed(() -> {
                        try {
                            if (sessionActive.get() && g == currentGatt) {
                                Log.i(TAG, "Attempting GATT reconnect…");
                                g.connect();
                            }
                        } catch (Throwable t) {
                            Log.w(TAG, "gatt reconnect failed: " + t.getMessage());
                        }
                    }, 2000);
                }
            }
        }

        @Override
        @SuppressLint("MissingPermission")
        public void onServicesDiscovered(BluetoothGatt gatt, int status) {
            if (status != BluetoothGatt.GATT_SUCCESS) {
                Log.w(TAG, "Services discovery status=" + status);
                return;
            }
            android.bluetooth.BluetoothGattService svc = gatt.getService(HR_SERVICE);
            if (svc == null) {
                Log.w(TAG, "HR service not present");
                return;
            }
            hrChar = svc.getCharacteristic(HR_MEASUREMENT);
            if (hrChar == null) {
                Log.w(TAG, "HR measurement characteristic missing");
                return;
            }
            // Enable notifications — both register callback locally AND
            // write CCCD. The "connected" CSV row is now deferred to
            // onDescriptorWrite so it only fires after the CCCD ack lands;
            // previously a silent CCCD failure would mark the session
            // "connected" but no HR notifications would ever arrive.
            gatt.setCharacteristicNotification(hrChar, true);
            BluetoothGattDescriptor desc = hrChar.getDescriptor(CCCD);
            if (desc != null) {
                desc.setValue(BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE);
                gatt.writeDescriptor(desc);
            } else {
                Log.w(TAG, "CCCD descriptor missing on HR characteristic");
            }
            // Bump the connection priority to HIGH (~11-15 ms interval) for
            // the lowest-jitter HR cadence the strap supports. Default is
            // BALANCED (~50-100 ms), which made the native-only path
            // noticeably more jittery than the JS path on the same strap.
            try {
                gatt.requestConnectionPriority(BluetoothGatt.CONNECTION_PRIORITY_HIGH);
            } catch (Throwable t) {
                Log.w(TAG, "requestConnectionPriority failed: " + t.getMessage());
            }
        }

        @Override
        public void onDescriptorWrite(BluetoothGatt gatt, BluetoothGattDescriptor descriptor, int status) {
            if (!CCCD.equals(descriptor.getUuid())) return;
            if (status == BluetoothGatt.GATT_SUCCESS) {
                Log.i(TAG, "CCCD write OK — notifications live");
                NativeCsvWriter w = csv;  // snapshot the volatile field
                if (w != null) w.appendConnectionRow("connected", System.currentTimeMillis());
            } else {
                Log.w(TAG, "CCCD write FAILED status=" + status + " — retrying once");
                // One retry; some strap firmwares NACK the first write under
                // heavy RF and accept the second. If both fail the user sees
                // the strap as not-connected which surfaces in the UI.
                try {
                    descriptor.setValue(BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE);
                    gatt.writeDescriptor(descriptor);
                } catch (Throwable t) {
                    Log.w(TAG, "CCCD retry threw: " + t.getMessage());
                }
            }
        }

        @Override
        public void onCharacteristicChanged(BluetoothGatt gatt, BluetoothGattCharacteristic ch) {
            if (!HR_MEASUREMENT.equals(ch.getUuid())) return;
            byte[] value = ch.getValue();
            if (value == null || value.length < 2) return;
            HrParse parsed = parseHrPacket(value);
            handleHrReading(parsed);
        }
    };

    private void handleHrReading(HrParse p) {
        long now = System.currentTimeMillis();
        // Update RR window. All four buffers (rrWindow + liveBuffer +
        // trendHrBuffer + trendRmssdBuffer) are read by publishTick on the
        // main thread via appendLiveArray / appendTrendArray; mutating them
        // on the BLE binder thread without locking would race the iteration.
        // Lock on each buffer's monitor — same monitor used by the snapshot
        // helpers above.
        Double rmssd;
        synchronized (rrWindow) {
            if (p.rrMs != null) {
                for (int rr : p.rrMs) rrWindow.addLast(new RrEntry(rr, now));
            }
            // Prune anything older than RR_WINDOW_MS
            long cutoff = now - RR_WINDOW_MS;
            Iterator<RrEntry> it = rrWindow.iterator();
            while (it.hasNext()) {
                if (it.next().timestampMs < cutoff) it.remove();
                else break;
            }
            rmssd = computeRmssd(rrWindow);
        }

        // Grow the overlay-chart buffers.
        // livePoints: per-RR instantaneous BPM, 45 s window.
        synchronized (liveBuffer) {
            if (p.rrMs != null) {
                for (int rr : p.rrMs) {
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
            trendHrBuffer.addLast(new double[] { now, p.hr });
            while (!trendHrBuffer.isEmpty() && trendHrBuffer.peekFirst()[0] < trendCutoff) trendHrBuffer.pollFirst();
        }
        if (rmssd != null) {
            synchronized (trendRmssdBuffer) {
                trendRmssdBuffer.addLast(new double[] { now, rmssd });
                while (!trendRmssdBuffer.isEmpty() && trendRmssdBuffer.peekFirst()[0] < trendCutoff) trendRmssdBuffer.pollFirst();
            }
        }

        // CSV append (per-row flush ensures persistence under process kill).
        // Snapshot the volatile field to a local so a concurrent stop on the
        // main thread doesn't null csv between the check and the call.
        NativeCsvWriter writer = csv;
        if (writer != null) {
            writer.appendHrRow(p.hr, rmssd != null ? rmssd : 0.0, now);
            // Surface a csvError event the first time consecutive failures
            // cross the threshold. Don't spam — only fire on the boundary.
            int consec = writer.getConsecutiveFailures();
            if (consec == CSV_FAIL_ALERT_THRESHOLD) {
                JSObject err = new JSObject();
                err.put("kind", "csv");
                err.put("totalFailures", writer.getTotalFailures());
                err.put("consecutiveFailures", consec);
                notifyListeners("csvError", err);
            }
        }

        // Tick payload — minimal subset matching the wire shape overlay.html
        // expects. Trends + livePoints omitted; overlay falls back gracefully.
        publishTick(p.hr, rmssd, p.contactOff, now);

        // Live event for JS UI (when foregrounded)
        JSObject ev = new JSObject();
        ev.put("hr", p.hr);
        if (rmssd != null) ev.put("rmssd", rmssd);
        ev.put("contactOff", p.contactOff);
        ev.put("timestampMs", now);
        if (p.rrMs != null && p.rrMs.length > 0) {
            JSONArray arr = new JSONArray();
            for (int rr : p.rrMs) arr.put(rr);
            try { ev.put("rrIntervals", arr); } catch (Exception ignored) {}
        }
        notifyListeners("hr", ev);

        // Periodic Drive upload
        if (csv != null && uploader != null) {
            long since = now - lastUploadMs.get();
            if (since >= DRIVE_UPLOAD_INTERVAL_MS) {
                lastUploadMs.set(now);
                uploader.uploadAsync(csv.getFile());
            }
        }

        // Notification update (1 Hz)
        if (now - lastNotifUpdateMs >= 1000 && sessionActive.get()) {
            lastNotifUpdateMs = now;
            long elapsedMs = now - sessionStartMs;
            long mm = elapsedMs / 60000L;
            long ss = (elapsedMs / 1000L) % 60;
            String body = String.format(java.util.Locale.US, "Recording · %d:%02d", mm, ss);
            String title = "HR " + p.hr + " bpm" + (rmssd != null ? " · HRV " + Math.round(rmssd) + "ms" : "");
            updateNativeForegroundService(title, body);
        }
    }

    // ---- Foreground Service lifecycle ------------------------------------

    private void startNativeForegroundService(String title, String body) {
        try {
            Intent i = new Intent(getContext(), NativeHrService.class);
            i.setAction(NativeHrService.ACTION_START);
            i.putExtra(NativeHrService.EXTRA_TITLE, title);
            i.putExtra(NativeHrService.EXTRA_BODY, body);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                getContext().startForegroundService(i);
            } else {
                getContext().startService(i);
            }
        } catch (Throwable t) {
            Log.w(TAG, "Failed to start FGS: " + t.getMessage());
        }
    }

    private void updateNativeForegroundService(String title, String body) {
        try {
            Intent i = new Intent(getContext(), NativeHrService.class);
            i.setAction(NativeHrService.ACTION_START);
            i.putExtra(NativeHrService.EXTRA_TITLE, title);
            i.putExtra(NativeHrService.EXTRA_BODY, body);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                getContext().startForegroundService(i);
            } else {
                getContext().startService(i);
            }
        } catch (Throwable t) { /* non-fatal */ }
    }

    private void stopNativeForegroundService() {
        try {
            Intent i = new Intent(getContext(), NativeHrService.class);
            i.setAction(NativeHrService.ACTION_STOP);
            getContext().startService(i);
        } catch (Throwable t) {
            try { getContext().stopService(new Intent(getContext(), NativeHrService.class)); } catch (Throwable ignored) {}
        }
    }

    private void closeGattQuietly() {
        if (currentGatt != null) {
            try { currentGatt.disconnect(); } catch (Exception ignored) {}
            try { currentGatt.close(); } catch (Exception ignored) {}
            currentGatt = null;
            hrChar = null;
        }
    }

    private void ingestScanResult(ScanResult result) {
        if (result == null || result.getDevice() == null) return;
        BluetoothDevice device = result.getDevice();
        String mac = device.getAddress();
        if (mac == null) return;
        for (DiscoveredDevice d : scanResults) {
            if (d.mac.equals(mac)) return; // already seen
        }
        String name = null;
        if (result.getScanRecord() != null) name = result.getScanRecord().getDeviceName();
        if (name == null) {
            try { name = device.getName(); } catch (SecurityException ignored) {}
        }
        boolean hasHrService = false;
        if (result.getScanRecord() != null && result.getScanRecord().getServiceUuids() != null) {
            for (android.os.ParcelUuid u : result.getScanRecord().getServiceUuids()) {
                if (HR_SERVICE.equals(u.getUuid())) { hasHrService = true; break; }
            }
        }
        boolean nameHints = name != null && (
            name.toUpperCase().contains("COOSPO") ||
            name.toUpperCase().contains("H808") ||
            name.toUpperCase().contains("POLAR") ||
            name.toUpperCase().contains("GARMIN") ||
            name.toUpperCase().contains("WAHOO") ||
            name.toUpperCase().contains("HRM") ||
            name.toUpperCase().contains("HEART"));
        scanResults.add(new DiscoveredDevice(mac, name, result.getRssi(), hasHrService || nameHints, device));
    }

    // ---- HR packet parsing ------------------------------------------------

    private static class HrParse {
        int hr;
        int[] rrMs;
        boolean contactOff;
    }

    /** Matches hr_monitor.html parseHR offsets. */
    private static HrParse parseHrPacket(byte[] b) {
        HrParse out = new HrParse();
        int flags = b[0] & 0xff;
        boolean is16 = (flags & 0x01) != 0;
        boolean contactSupported = (flags & 0x04) != 0;
        boolean contactDetected = (flags & 0x02) != 0;
        boolean hasEnergy = (flags & 0x08) != 0;
        boolean hasRr = (flags & 0x10) != 0;
        out.contactOff = contactSupported && !contactDetected;

        int offset = 1;
        if (is16) {
            if (b.length < offset + 2) return out;
            int lo = b[offset] & 0xff;
            int hi = b[offset + 1] & 0xff;
            out.hr = (hi << 8) | lo;
            offset += 2;
        } else {
            if (b.length < offset + 1) return out;
            out.hr = b[offset] & 0xff;
            offset += 1;
        }
        if (hasEnergy) offset += 2;
        if (hasRr) {
            List<Integer> rrs = new ArrayList<>();
            while (b.length >= offset + 2) {
                int lo = b[offset] & 0xff;
                int hi = b[offset + 1] & 0xff;
                int raw = (hi << 8) | lo;
                rrs.add(raw * 1000 / 1024); // 1/1024 s → ms
                offset += 2;
            }
            int[] arr = new int[rrs.size()];
            for (int i = 0; i < rrs.size(); i++) arr[i] = rrs.get(i);
            out.rrMs = arr;
        }
        return out;
    }

    private static class RrEntry {
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

    // ---- Relay WebSocket --------------------------------------------------

    // Reconnect backoff. Previous behaviour was a fixed 2-second delay with
    // no jitter and no max-retry — a server outage hammered PartyKit at
    // 0.5 Hz indefinitely and multiple devices behind the same outage all
    // synchronised their reconnect attempts. Exponential backoff up to 60 s
    // + ±25 % jitter spreads the load and gives the server room to recover.
    private int relayReconnectAttempts = 0;
    private static final long RELAY_RECONNECT_BASE_MS = 2_000L;
    private static final long RELAY_RECONNECT_MAX_MS = 60_000L;
    // After this many consecutive failures, surface the situation to JS so
    // the UI can show "relay unreachable" instead of just sitting silent.
    private static final int RELAY_RECONNECT_NOTIFY_AFTER = 10;

    private long nextRelayBackoffMs() {
        long base = Math.min(RELAY_RECONNECT_MAX_MS,
                             RELAY_RECONNECT_BASE_MS * (1L << Math.min(relayReconnectAttempts, 5)));
        // ±25 % jitter so devices don't sync up after a network partition.
        double jitter = 1.0 + (Math.random() * 0.5 - 0.25);
        return (long) (base * jitter);
    }

    private void scheduleRelayReconnect() {
        if (!sessionActive.get()) return;
        relayReconnectAttempts++;
        long delay = nextRelayBackoffMs();
        Log.i(TAG, "Relay reconnect scheduled in " + delay + "ms (attempt " + relayReconnectAttempts + ")");
        if (relayReconnectAttempts == RELAY_RECONNECT_NOTIFY_AFTER) {
            JSObject ev = new JSObject();
            ev.put("kind", "relayUnreachable");
            ev.put("attempts", relayReconnectAttempts);
            notifyListeners("relayError", ev);
        }
        mainHandler.postDelayed(NativeHrSessionPlugin.this::openRelaySocket, delay);
    }

    private void openRelaySocket() {
        if (broadcastKey == null) return;
        closeRelaySocket();
        Request req = new Request.Builder()
            .url("wss://hr-relay.nakauri.partykit.dev/parties/main/" + broadcastKey)
            .build();
        relaySocket = httpClient.newWebSocket(req, new WebSocketListener() {
            @Override public void onOpen(WebSocket ws, Response r) {
                relayLive.set(true);
                relayReconnectAttempts = 0;  // reset on successful open
                Log.i(TAG, "Relay open");
                emitState();
            }
            @Override public void onClosed(WebSocket ws, int code, String reason) {
                relayLive.set(false);
                emitState();
                scheduleRelayReconnect();
            }
            @Override public void onFailure(WebSocket ws, Throwable t, Response r) {
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
        if (relaySocket != null) {
            try { relaySocket.close(1000, "session stop"); } catch (Exception ignored) {}
            relaySocket = null;
        }
        relayLive.set(false);
    }

    // User-configurable stage thresholds. Defaults match the web defaults
    // (color-low 70, color-normal 90, color-elevated 110, alert-high 130).
    // JS calls setStageThresholds() on load and whenever the user edits them
    // so the relay tick's hrStage matches what the monitor's own WebView
    // shows. Without this the OBS overlay and the phone UI show different
    // colours for the same HR.
    private volatile int stageLow = 70;
    private volatile int stageNormal = 90;
    private volatile int stageElevated = 110;
    private volatile int stageHigh = 130;

    @PluginMethod
    public void setStageThresholds(PluginCall call) {
        Integer low = call.getInt("low");
        Integer normal = call.getInt("normal");
        Integer elevated = call.getInt("elevated");
        Integer high = call.getInt("high");
        // rmssdCritical is the user-configurable HRV-crash threshold. Other
        // RMSSD stage cutoffs (20/35/60) are literature-grounded and hard-
        // coded to match hr_monitor.html:getRMSSDStage.
        Integer rmssdCritical = call.getInt("rmssdCritical");
        if (low != null) stageLow = low;
        if (normal != null) stageNormal = normal;
        if (elevated != null) stageElevated = elevated;
        if (high != null) stageHigh = high;
        if (rmssdCritical != null) stageRmssdCritical = rmssdCritical;
        call.resolve();
    }

    private String hrStage(int hr) {
        if (hr <= stageLow) return "stage-low";
        if (hr < stageNormal) return "stage-normal";
        if (hr < stageElevated) return "stage-elevated";
        if (hr < stageHigh) return "stage-high";
        return "stage-critical";
    }

    // PARITY CRITICAL — MUST MATCH hr_monitor.html:getRMSSDStage (line ~2319).
    // Prior thresholds here (40/25/15) didn't match the JS ones (60/35/20/
    // user-critical); an RMSSD of 36 rendered orange on the native side and
    // green on the JS side for the same reading. `critical` threshold is
    // the user-configurable one, pushed via setRmssdStageThresholds so the
    // monitor widget and the relay overlay agree on when to flag a crash.
    private volatile int stageRmssdCritical = 15;  // default; overridden by setStageThresholds
    private String rmssdStage(double rmssd) {
        if (rmssd < stageRmssdCritical) return "stage-critical";
        if (rmssd < 20) return "stage-high";
        if (rmssd < 35) return "stage-elevated";
        if (rmssd < 60) return "stage-normal";
        return "stage-low";
    }

    /**
     * Publish a tick to the relay. Wire format is documented in
     * RELAY_TICK.md at the repo root. The web sender
     * (hr_monitor.html broadcastTick) MUST emit the same fields.
     * When adding or renaming a field, update all three: this method,
     * hr_monitor.html broadcastTick, and overlay.html handleTick.
     */
    private void publishTick(int hr, Double rmssd, boolean contactOff, long nowMs) {
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

    // ---- Misc -------------------------------------------------------------

    private void emitState() {
        JSObject ev = new JSObject();
        ev.put("ble", currentGatt != null);
        ev.put("relay", relayLive.get());
        ev.put("session", sessionActive.get());
        notifyListeners("state", ev);
    }

    private static class DiscoveredDevice {
        final String mac;
        final String name;
        final int rssi;
        final boolean isHr;
        final BluetoothDevice btDevice;
        DiscoveredDevice(String mac, String name, int rssi, boolean isHr, BluetoothDevice device) {
            this.mac = mac; this.name = name; this.rssi = rssi; this.isHr = isHr; this.btDevice = device;
        }
    }
}
