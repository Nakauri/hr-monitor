package com.nakauri.hrmonitor;

import android.Manifest;
import android.content.Intent;
import android.os.Build;
import android.util.Log;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * Capacitor bridge to the process-scoped HrEngine.
 *
 * The engine runs strap → tick → relay → CSV → Drive in native code so it
 * survives WebView pause and Activity recreation. This plugin delegates each
 * call to it and forwards engine events to JS while the Activity is alive.
 *
 * Public Capacitor methods:
 *   scan({timeoutMs?})            — scan for HR-service straps. Returns a device list.
 *   connect({mac})                — connect the strap and subscribe to 0x2A37.
 *   startSession({broadcastKey, senderId, senderLabel})
 *                                — open relay socket + start CSV file +
 *                                  begin Drive upload cadence.
 *   stopSession()                 — flush CSV + final Drive push + close socket.
 *   disconnect()                  — close BLE.
 *   status()                      — current state.
 *
 * Events emitted to JS:
 *   state       { ble, relay, session }  — connection state changes
 *   hr          { hr, rmssd, rrIntervals[], timestampMs }  — per HR notification
 */
@CapacitorPlugin(name = "NativeHrSession", permissions = {
    @Permission(strings = { Manifest.permission.BLUETOOTH_SCAN }, alias = "bluetoothScan"),
    @Permission(strings = { Manifest.permission.BLUETOOTH_CONNECT }, alias = "bluetoothConnect"),
})
public class NativeHrSessionPlugin extends Plugin {
    private static final String TAG = "NativeHrSession";

    // Process-scoped engine; outlives this plugin instance.
    private volatile HrEngine engine;

    // Live plugin instance, for MainActivity's trimMemory forward only; cleared on destroy.
    public static volatile NativeHrSessionPlugin instance;

    // Between handleOnPause and handleOnResume: hr events forwarded, for the webview_resume line.
    private volatile boolean webviewPaused = false;
    private final java.util.concurrent.atomic.AtomicInteger pausedHrForwarded = new java.util.concurrent.atomic.AtomicInteger(0);

    // Engine events to JS; a payload that cannot convert drops that one event.
    private final HrEngine.Listener engineListener = (name, data) -> {
        JSObject js;
        try {
            js = JSObject.fromJSONObject(data);
        } catch (JSONException e) {
            Log.w(TAG, "event " + name + " dropped: " + e.getMessage());
            return;
        }
        if (webviewPaused && "hr".equals(name)) pausedHrForwarded.incrementAndGet();
        notifyListeners(name, js);
    };

    // Main thread callers: the lifecycle file write runs on its own short thread.
    private void logLifecycleAsync(final String event) {
        final android.content.Context ctx = getContext();
        try {
            new Thread(() -> NativeHrService.logLifecycle(ctx, event), "hrm-lifecycle-log").start();
        } catch (Throwable t) {
            Log.w(TAG, "lifecycle log not queued: " + t);
        }
    }

    @Override
    protected void handleOnPause() {
        super.handleOnPause();
        pausedHrForwarded.set(0);
        webviewPaused = true;
        logLifecycleAsync("webview_pause");
    }

    @Override
    protected void handleOnResume() {
        super.handleOnResume();
        webviewPaused = false;
        logLifecycleAsync("webview_resume paused_hr=" + pausedHrForwarded.getAndSet(0));
        HrEngine e = engine;
        if (e != null) e.onWake(ServiceStartPolicy.ORIGIN_APP);
    }

    /** Forward Activity.onTrimMemory to JS so the page can free GPU buffers
     *  before LMK fires. Called from MainActivity. Safe to call before bridge
     *  is ready — notifyListeners no-ops in that case. */
    public void notifyTrimMemory(int level) {
        try {
            JSObject ev = new JSObject();
            ev.put("level", level);
            notifyListeners("trimMemory", ev);
        } catch (Throwable t) {
            Log.w(TAG, "notifyTrimMemory failed: " + t.getMessage());
        }
    }

    @Override
    public void load() {
        instance = this;
        NativeHrService.logLifecycle(getContext(), "plugin_load");
        HrEngine.Obtained o;
        try {
            o = HrEngine.obtain(getContext());
        } catch (Throwable t) {
            Log.e(TAG, "engine obtain failed: " + t);
            NativeHrService.logLifecycle(getContext(), "engine_create_failed " + t.getClass().getSimpleName());
            return;
        }
        HrEngine e = o.engine;
        engine = e;
        if (o.created) {
            NativeHrService.logLifecycle(getContext(), "engine_create pid=" + android.os.Process.myPid()
                + " interrupted=" + e.wasInterruptedAtCreate() + " markedBroken=" + e.wasMarkedBrokenAtCreate());
        } else {
            NativeHrService.logLifecycle(getContext(), "engine_attach active=" + e.isSessionActive()
                + " gen=" + e.getSessionGeneration() + " gatt=" + e.isStrapLinked() + " relay=" + e.isRelayLive());
        }
        e.setListener(engineListener);
        // A session interrupted by process death is recovered by JS from status(); this event is transitional.
        try {
            android.content.SharedPreferences prefs = getContext().getSharedPreferences("hr_monitor_session", 0);
            boolean wasActive = prefs.getBoolean("sessionActive", false);
            boolean cleanlyStopped = prefs.getBoolean("cleanlyStopped", true);
            long lastAliveMs = prefs.getLong("last_alive_ms", 0);
            String lastFgLossReason = prefs.getString("last_fg_loss_reason", null);
            long lastFgLossMs = prefs.getLong("last_fg_loss_ms", 0);
            int lastTrimLevel = prefs.getInt("last_trim_memory_level", 0);
            long lastTrimMs = prefs.getLong("last_trim_memory_ms", 0);
            Log.i(TAG, "Post-mortem: lastAlive=" + lastAliveMs
                + " fgLoss=" + lastFgLossReason + "@" + lastFgLossMs
                + " trim=" + lastTrimLevel + "@" + lastTrimMs);
            // Same formula as status().interruptedRecovery.
            if (wasActive && !cleanlyStopped && !e.isSessionActive()) {
                Log.i(TAG, "Detected interrupted session — JS will read context from status().");
                JSONObject ev = HrEngine.buildRecoveryContext(prefs, lastAliveMs,
                    lastFgLossReason, lastFgLossMs, lastTrimLevel, lastTrimMs);
                notifyListeners("sessionInterrupted", JSObject.fromJSONObject(ev));
            }
        } catch (Throwable t) {
            Log.w(TAG, "Interrupted-session detection failed: " + t.getMessage());
        }
        // Best effort; status() stays the snapshot JS reads at bootstrap.
        e.emitState();
        // handleOnResume follows on a cold open and makes the one onWake("app").
    }

    // Releases only this plugin's listener and executors; the engine and its session keep running.
    @Override
    protected void handleOnDestroy() {
        HrEngine e = engine;
        boolean cleared = e != null && e.clearListener(engineListener);
        try {
            NativeHrService.logLifecycle(getContext(), "plugin_destroy cleared=" + cleared);
        } catch (Throwable ignored) {}
        // Drops the static's hold on this Bridge, Activity and WebView.
        if (instance == this) instance = null;
        synchronized (this) {
            if (exportExecutor != null) {
                exportExecutor.shutdown();
                exportExecutor = null;
            }
            if (authExecutor != null) {
                authExecutor.shutdown();
                authExecutor = null;
            }
        }
        super.handleOnDestroy();
    }

    // Engine for a delegating call, or null after rejecting it.
    private HrEngine engineOrReject(PluginCall call) {
        HrEngine e = engine;
        if (e == null) call.reject("engine_unavailable");
        return e;
    }

    // Settles a call from an engine callback; a payload that cannot convert rejects.
    private static HrEngine.Done<JSONObject> jsDone(PluginCall call) {
        return new HrEngine.Done<JSONObject>() {
            @Override public void ok(JSONObject value) {
                JSObject ret;
                try {
                    ret = value != null ? JSObject.fromJSONObject(value) : new JSObject();
                } catch (JSONException e) {
                    Log.w(TAG, "payload convert failed: " + e.getMessage());
                    call.reject("payload_convert_failed");
                    return;
                }
                call.resolve(ret);
            }
            @Override public void fail(String code) { call.reject(code); }
        };
    }

    // ---- Plugin methods --------------------------------------------------
    // Capacitor never settles a call whose method throws, so every wrapper catches Throwable.

    @PluginMethod
    public void scan(PluginCall call) {
        try {
            HrEngine e = engineOrReject(call);
            if (e == null) return;
            long timeoutMs = call.getLong("timeoutMs", 8000L);
            e.scan(timeoutMs, new HrEngine.Done<JSONArray>() {
                @Override public void ok(JSONArray devices) {
                    JSObject ret = new JSObject();
                    ret.put("devices", devices);
                    call.resolve(ret);
                }
                @Override public void fail(String code) { call.reject(code); }
            });
        } catch (Throwable t) {
            call.reject("scan_failed: " + t.getMessage());
        }
    }

    @PluginMethod
    public void connect(PluginCall call) {
        try {
            HrEngine e = engineOrReject(call);
            if (e == null) return;
            final String mac = call.getString("mac");
            if (mac == null) { call.reject("mac required"); return; }
            if (!e.hasAdapter()) { call.reject("Bluetooth adapter unavailable"); return; }
            e.connect(mac, jsDone(call));
        } catch (Throwable t) {
            call.reject("connect failed: " + t.getMessage());
        }
    }

    @PluginMethod
    public void startSession(PluginCall call) {
        try {
            HrEngine e = engineOrReject(call);
            if (e == null) return;
            JSONObject ret = e.startSessionInternal(
                call.getString("broadcastKey"),
                call.getString("senderLabel", "HR Monitor Android"),
                call.getBoolean("broadcast"),
                call.getString("resumeFilename"),
                call.getLong("resumeSessionStartMs", 0L),
                ServiceStartPolicy.ORIGIN_START);
            call.resolve(JSObject.fromJSONObject(ret));
        } catch (HrEngine.AlreadyActiveException a) {
            call.reject("already_active");
        } catch (Throwable t) {
            Log.e(TAG, "startSession failed: " + t);
            call.reject("start_session_failed: " + t.getMessage());
        }
    }

    // Adopts the session prefs say is live (the same resume the Service runs): {resumed, senderId,
    // senderLabel, sessionStartMs, csvFile}, {alreadyRunning, ...} or {resumed:false, reason}.
    @PluginMethod
    public void resumeSession(PluginCall call) {
        try {
            HrEngine e = engineOrReject(call);
            if (e == null) return;
            call.resolve(JSObject.fromJSONObject(e.resumeFromPrefs(ServiceStartPolicy.ORIGIN_JS)));
        } catch (Throwable t) {
            Log.e(TAG, "resumeSession failed: " + t);
            call.reject("resume_session_failed: " + t.getMessage());
        }
    }

    // Resolves once the stop flags are committed; the Drive upload continues on hrm-stop-upload.
    @PluginMethod
    public void stopSession(PluginCall call) {
        try {
            HrEngine e = engineOrReject(call);
            if (e == null) return;
            e.stopSessionInternal();
            call.resolve(new JSObject().put("stopped", true));
        } catch (Throwable t) {
            Log.e(TAG, "stopSession failed: " + t);
            call.reject("stop_session_failed: " + t.getMessage());
        }
    }

    @PluginMethod
    public void disconnect(PluginCall call) {
        try {
            HrEngine e = engineOrReject(call);
            if (e == null) return;
            e.disconnect();
            call.resolve(new JSObject().put("disconnected", true));
        } catch (Throwable t) {
            call.reject("disconnect_failed: " + t.getMessage());
        }
    }

    @PluginMethod
    public void forceSyncNow(PluginCall call) {
        try {
            HrEngine e = engineOrReject(call);
            if (e == null) return;
            e.forceSyncNow(jsDone(call));
        } catch (Throwable t) {
            call.reject("force_sync_failed: " + t.getMessage());
        }
    }

    @PluginMethod
    public void setPrefs(PluginCall call) {
        try {
            HrEngine e = engineOrReject(call);
            if (e == null) return;
            JSObject p = call.getObject("prefs");
            e.setPrefs(p != null ? p.toString() : null);
            call.resolve();
        } catch (Throwable t) {
            call.reject("set_prefs_failed: " + t.getMessage());
        }
    }

    @PluginMethod
    public void setBroadcast(PluginCall call) {
        try {
            HrEngine e = engineOrReject(call);
            if (e == null) return;
            Boolean enabled = call.getBoolean("enabled");
            if (enabled == null) { call.reject("enabled required"); return; }
            e.setBroadcast(enabled);
            call.resolve();
        } catch (Throwable t) {
            call.reject("set_broadcast_failed: " + t.getMessage());
        }
    }

    @PluginMethod
    public void getCacheStats(PluginCall call) {
        try {
            HrEngine e = engineOrReject(call);
            if (e == null) return;
            e.getCacheStats(jsDone(call));
        } catch (Throwable t) {
            call.reject("getCacheStats failed: " + t.getMessage());
        }
    }

    @PluginMethod
    public void clearLocalCache(PluginCall call) {
        try {
            HrEngine e = engineOrReject(call);
            if (e == null) return;
            e.clearLocalCache(jsDone(call));
        } catch (Throwable t) {
            call.reject("clearLocalCache failed: " + t.getMessage());
        }
    }

    // Local v2 segments for the in-app viewer: {fromMs?, toMs?} -> {segments: [{name, base, size, mtime, open}]}.
    @PluginMethod
    public void listSegments(PluginCall call) {
        try {
            HrEngine e = engineOrReject(call);
            if (e == null) return;
            JSObject data = call.getData();
            Object from = data != null ? data.opt("fromMs") : null;
            Object to = data != null ? data.opt("toMs") : null;
            e.listSegments(from instanceof Number ? Long.valueOf(((Number) from).longValue()) : null,
                to instanceof Number ? Long.valueOf(((Number) to).longValue()) : null, jsDone(call));
        } catch (Throwable t) {
            call.reject("list_segments_failed: " + t.getMessage());
        }
    }

    // {name} -> {name, text, size, open, truncated}; text ends at the segment's last LF.
    @PluginMethod
    public void readSegment(PluginCall call) {
        try {
            HrEngine e = engineOrReject(call);
            if (e == null) return;
            e.readSegment(call.getString("name"), jsDone(call));
        } catch (Throwable t) {
            call.reject("read_segment_failed: " + t.getMessage());
        }
    }

    @PluginMethod
    public void getSessionSnapshot(PluginCall call) {
        try {
            HrEngine e = engineOrReject(call);
            if (e == null) return;
            e.getSessionSnapshot(call.getInt("tailMinutes"), jsDone(call));
        } catch (Throwable t) {
            call.reject("getSessionSnapshot failed: " + t.getMessage());
        }
    }

    // The exit line pairs each JS status() with its native settle time (a lost reply has an exit and no JS reply).
    @PluginMethod
    public void status(PluginCall call) {
        long t0 = android.os.SystemClock.elapsedRealtime();
        String out = "resolved";
        try {
            HrEngine e = engineOrReject(call);
            if (e == null) { out = "no_engine"; return; }
            call.resolve(JSObject.fromJSONObject(e.statusJson()));
        } catch (Throwable t) {
            out = "rejected";
            call.reject("status_failed: " + t.getMessage());
        } finally {
            try {
                if (call.getBoolean("trace", true)) {
                    NativeHrService.logLifecycle(getContext(), "status_call seq=" + call.getInt("seq", -1)
                        + " ms=" + (android.os.SystemClock.elapsedRealtime() - t0) + " out=" + out);
                }
            } catch (Throwable ignored) {}
        }
    }

    // Persisted; false gives the alarm-only retry in NOT_FOUND. {enabled} -> {enabled}.
    @PluginMethod
    public void setPendingReconnect(PluginCall call) {
        try {
            HrEngine e = engineOrReject(call);
            if (e == null) return;
            Boolean on = call.getBoolean("enabled");
            if (on != null) e.setPendingReconnectEnabled(on);
            call.resolve(new JSObject().put("enabled", e.pendingReconnectEnabled()));
        } catch (Throwable t) {
            call.reject("set_pending_reconnect_failed: " + t.getMessage());
        }
    }

    // Bridge probe: the shim's throwaway first call, and its report of which reply arrived.
    @PluginMethod
    public void ping(PluginCall call) {
        try {
            call.resolve(new JSObject().put("ok", true));
        } catch (Throwable t) {
            call.reject("ping_failed: " + t.getMessage());
        }
        try {
            String note = call.getString("note", "");
            NativeHrService.logLifecycle(getContext(), "bridge_ping seq=" + call.getInt("seq", -1)
                + (note == null || note.isEmpty() ? "" : " " + note));
        } catch (Throwable ignored) {}
    }

    @PluginMethod
    public void setStageThresholds(PluginCall call) {
        try {
            HrEngine e = engineOrReject(call);
            if (e == null) return;
            e.setStageThresholds(call.getInt("low"), call.getInt("normal"), call.getInt("elevated"),
                call.getInt("high"), call.getInt("rmssdCritical"));
            call.resolve();
        } catch (Throwable t) {
            call.reject("set_stage_thresholds_failed: " + t.getMessage());
        }
    }

    // {kind: marker|posture|symptom|warning|ectopic, tsMs, text?, value?} into the v2 segment.
    @PluginMethod
    public void logFact(PluginCall call) {
        try {
            HrEngine e = engineOrReject(call);
            if (e == null) return;
            JSObject data = call.getData();
            Object ts = data != null ? data.opt("tsMs") : null;
            Object val = data != null ? data.opt("value") : null;
            String r = e.logFact(call.getString("kind"),
                ts instanceof Number ? Long.valueOf(((Number) ts).longValue()) : null,
                call.getString("text"),
                val instanceof Number ? Double.valueOf(((Number) val).doubleValue()) : null);
            if ("bad_kind".equals(r) || "no_session".equals(r)) {
                call.reject(r);
                return;
            }
            call.resolve(new JSObject().put("written", "written".equals(r)));
        } catch (Throwable t) {
            call.reject("log_fact_failed: " + t.getMessage());
        }
    }

    // ---- Floating overlay ------------------------------------------------

    @PluginMethod
    public void hasOverlayPermission(PluginCall call) {
        boolean granted = Build.VERSION.SDK_INT < Build.VERSION_CODES.M
            || android.provider.Settings.canDrawOverlays(getContext());
        call.resolve(new JSObject().put("granted", granted));
    }

    @PluginMethod
    public void requestOverlayPermission(PluginCall call) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M
                || android.provider.Settings.canDrawOverlays(getContext())) {
            call.resolve(new JSObject().put("granted", true));
            return;
        }
        try {
            Intent i = new Intent(android.provider.Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
                android.net.Uri.parse("package:" + getContext().getPackageName()));
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(i);
            call.resolve(new JSObject().put("opened", true));
        } catch (Throwable t) {
            call.reject("could not open overlay-permission settings: " + t.getMessage());
        }
    }

    @PluginMethod
    public void startFloatingOverlay(PluginCall call) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M
                && !android.provider.Settings.canDrawOverlays(getContext())) {
            call.resolve(new JSObject().put("ok", false).put("reason", "permission_required"));
            return;
        }
        try {
            Intent i = new Intent(getContext(), FloatingOverlayService.class);
            getContext().startService(i);
            call.resolve(new JSObject().put("ok", true));
        } catch (Throwable t) {
            call.resolve(new JSObject().put("ok", false).put("reason", t.getMessage()));
        }
    }

    @PluginMethod
    public void stopFloatingOverlay(PluginCall call) {
        try {
            getContext().stopService(new Intent(getContext(), FloatingOverlayService.class));
        } catch (Throwable ignored) {}
        call.resolve(new JSObject().put("ok", true));
    }

    // ---- Export ----------------------------------------------------------

    // SAF "Save as" dialog. User picks the destination (Downloads, Drive,
    // anywhere). Works on every Android version with no permissions; the
    // alternatives (MediaStore.Downloads on 29+, WRITE_EXTERNAL_STORAGE on
    // ≤28) require version-specific code AND a runtime permission flow on
    // older OSes. SAF sidesteps both.
    // Map keyed by Capacitor's per-call ID so two rapid Export taps can't
    // overwrite each other's CSV.
    private final java.util.Map<String, String> pendingExports = new java.util.concurrent.ConcurrentHashMap<>();
    @PluginMethod
    public void exportCsv(PluginCall call) {
        final String filename = call.getString("filename");
        final String csv = call.getString("csv");
        if (filename == null || csv == null) { call.reject("filename + csv required"); return; }
        try {
            pendingExports.put(call.getCallbackId(), csv);
            Intent i = new Intent(Intent.ACTION_CREATE_DOCUMENT);
            i.addCategory(Intent.CATEGORY_OPENABLE);
            i.setType("text/csv");
            i.putExtra(Intent.EXTRA_TITLE, filename);
            startActivityForResult(call, i, "exportCsvResult");
        } catch (Throwable t) {
            pendingExports.remove(call.getCallbackId());
            call.reject("export_failed: " + t.getMessage());
        }
    }

    @com.getcapacitor.annotation.ActivityCallback
    private void exportCsvResult(PluginCall call, androidx.activity.result.ActivityResult result) {
        String csv = pendingExports.remove(call.getCallbackId());
        if (csv == null) { call.reject("export state lost"); return; }
        if (result == null || result.getResultCode() != android.app.Activity.RESULT_OK) {
            call.reject("user_cancelled");
            return;
        }
        Intent data = result.getData();
        android.net.Uri uri = data != null ? data.getData() : null;
        if (uri == null) { call.reject("no_uri_returned"); return; }
        try {
            exportExecutor().execute(() -> {
                try (java.io.OutputStream os = getContext().getContentResolver().openOutputStream(uri)) {
                    if (os == null) { call.reject("openOutputStream null"); return; }
                    os.write(csv.getBytes("UTF-8"));
                    os.flush();
                    JSObject ret = new JSObject();
                    ret.put("uri", uri.toString());
                    call.resolve(ret);
                } catch (Throwable t) {
                    Log.w(TAG, "exportCsv write failed: " + t);
                    call.reject("write_failed: " + t.getMessage());
                }
            });
        } catch (Throwable t) {
            call.reject("write_failed: " + t.getMessage());
        }
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
        try {
            authExecutor().execute(() -> {
                try {
                    AuthStorage.store(getContext(), accessToken, refreshToken,
                        expiresAt != null ? expiresAt : 0L, email);
                    call.resolve();
                    // Segments recorded while signed out wait for this.
                    SegmentUploadWorker.enqueue(getContext(), "sweep", null);
                } catch (Throwable t) {
                    call.reject("storeAuthTokens failed: " + t.getMessage());
                }
            });
        } catch (Throwable t) {
            call.reject("storeAuthTokens_failed: " + t.getMessage());
        }
    }

    @PluginMethod
    public void getValidAccessToken(PluginCall call) {
        try {
            authExecutor().execute(() -> {
                try {
                    String token;
                    try {
                        token = AuthStorage.getValidAccessTokenOrThrow(getContext(), false);
                    } catch (AuthStorage.TransientRefreshException e) {
                        call.reject("refresh_transient");
                        return;
                    }
                    if (token == null) {
                        call.reject("refresh_invalid");
                        return;
                    }
                    JSObject ret = new JSObject();
                    ret.put("access_token", token);
                    ret.put("expires_at", AuthStorage.getExpiresAt(getContext()));
                    ret.put("email", AuthStorage.getEmail(getContext()));
                    call.resolve(ret);
                } catch (Throwable t) {
                    call.reject("refresh_transient: " + t.getMessage());
                }
            });
        } catch (Throwable t) {
            // The JS auth layer reads refresh_transient as "try again", never as signed out.
            call.reject("refresh_transient: " + t.getMessage());
        }
    }

    @PluginMethod
    public void clearAuth(PluginCall call) {
        try {
            authExecutor().execute(() -> {
                try {
                    AuthStorage.clear(getContext());
                    call.resolve();
                } catch (Throwable t) {
                    call.reject("clearAuth failed: " + t.getMessage());
                }
            });
        } catch (Throwable t) {
            call.reject("clearAuth_failed: " + t.getMessage());
        }
    }

    @PluginMethod
    public void authStatus(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("signed_in", AuthStorage.isSignedIn(getContext()));
        ret.put("email", AuthStorage.getEmail(getContext()));
        ret.put("expires_at", AuthStorage.getExpiresAt(getContext()));
        call.resolve(ret);
    }

    @PluginMethod
    public void printPdf(PluginCall call) {
        // PdfPrinter owns its thread and settles the call; this only hands it over.
        try {
            PdfPrinter.print(getContext(), getActivity(), call);
        } catch (Throwable t) {
            call.reject("pdf_failed");
        }
    }

    // Save to phone: PdfPrinter writes the PDF to the cache on its own thread, then the SAF "Save as" screen
    // (same as exportCsv) lets the person pick Downloads or any folder. Every path settles the call.
    @PluginMethod
    public void savePdf(PluginCall call) {
        try {
            PdfPrinter.save(getContext(), call, (file) -> {
                final String id = call.getCallbackId();
                PdfPrinter.hold(id, file);
                boolean posted = new android.os.Handler(android.os.Looper.getMainLooper()).post(() -> {
                    try {
                        androidx.appcompat.app.AppCompatActivity a = getActivity();
                        // A picker started from the background never returns, so the call would hang.
                        if (a == null || a.isFinishing() || !a.getLifecycle().getCurrentState()
                                .isAtLeast(androidx.lifecycle.Lifecycle.State.STARTED)) {
                            PdfPrinter.discard(id);
                            call.reject("pdf_save_background");
                            return;
                        }
                        Intent i = new Intent(Intent.ACTION_CREATE_DOCUMENT);
                        i.addCategory(Intent.CATEGORY_OPENABLE);
                        i.setType("application/pdf");
                        i.putExtra(Intent.EXTRA_TITLE, file.getName());
                        startActivityForResult(call, i, "savePdfResult");
                    } catch (Throwable t) {
                        Log.w(TAG, "savePdf picker failed: " + t);
                        PdfPrinter.discard(id);
                        call.reject("pdf_save_failed");
                    }
                });
                if (!posted) {
                    PdfPrinter.discard(id);
                    call.reject("pdf_save_failed");
                }
            });
        } catch (Throwable t) {
            call.reject("pdf_failed");
        }
    }

    @com.getcapacitor.annotation.ActivityCallback
    private void savePdfResult(PluginCall call, androidx.activity.result.ActivityResult result) {
        if (call == null) return;
        try { getBridge().releaseCall(call); } catch (Throwable ignored) {}
        try {
            final String id = call.getCallbackId();
            if (result == null || result.getResultCode() != android.app.Activity.RESULT_OK) {
                PdfPrinter.discard(id);
                JSObject ret = new JSObject();
                ret.put("saved", false);
                ret.put("cancelled", true);
                call.resolve(ret);
                return;
            }
            Intent data = result.getData();
            android.net.Uri uri = data != null ? data.getData() : null;
            if (uri == null) {
                PdfPrinter.discard(id);
                call.reject("pdf_save_failed");
                return;
            }
            // PdfPrinter copies off the main thread and settles.
            PdfPrinter.copyTo(getContext(), call, uri);
        } catch (Throwable t) {
            Log.w(TAG, "savePdfResult failed: " + t);
            try { call.reject("pdf_save_failed"); } catch (Throwable ignored) {}
        }
    }

    // CSV export writes; engine work runs on the engine's own executor.
    private java.util.concurrent.ExecutorService exportExecutor;
    private synchronized java.util.concurrent.ExecutorService exportExecutor() {
        if (exportExecutor == null) {
            exportExecutor = java.util.concurrent.Executors.newSingleThreadExecutor();
        }
        return exportExecutor;
    }

    // Token store, refresh and clear; a refresh can hold the AuthStorage lock across the network.
    private java.util.concurrent.ExecutorService authExecutor;
    private synchronized java.util.concurrent.ExecutorService authExecutor() {
        if (authExecutor == null) {
            authExecutor = java.util.concurrent.Executors.newSingleThreadExecutor();
        }
        return authExecutor;
    }
}
