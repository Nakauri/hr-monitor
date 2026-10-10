package com.nakauri.hrmonitor;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;
import android.util.Log;

import androidx.core.app.NotificationCompat;

import org.json.JSONObject;

// Foreground service for active HR sessions. Every start door (the engine, the alarm, the worker,
// a sticky restart, an app update) lands here; a dead session resumes through HrEngine.resumeFromPrefs.
public class NativeHrService extends Service {
    private static final String TAG = "NativeHrService";
    private static final String CHANNEL_ID = "hr_monitor_native";
    private static final int NOTIFICATION_ID = 7703;
    private static final int ENDED_NOTIFICATION_ID = 7704;

    public static final String ACTION_START = "com.nakauri.hrmonitor.NATIVE_HR_START";
    public static final String ACTION_STOP = "com.nakauri.hrmonitor.NATIVE_HR_STOP";
    // engine | alarm | worker | replaced; a null intent (sticky restart) is "sticky".
    public static final String EXTRA_ORIGIN = "origin";
    // On the Stop PendingIntent: the session it was built for. 0 = unknown.
    public static final String EXTRA_SESSION_START_MS = "sessionStartMs";
    // Bound on keeping the wake lock for the engine's stop upload worker.
    private static final long STOP_WORKER_WAIT_MS = 10L * 60L * 1000L;
    // onDestroy with a live session re-posts the FGS at most this often.
    private static final long FGS_RESTART_MIN_MS = 60_000L;
    private static volatile long lastFgsRestartMs = 0L;

    // Service-owned PARTIAL_WAKE_LOCK, held per link state (released in NOT_FOUND).
    private PowerManager.WakeLock wakeLock;
    // Timed lock for a wake's strap attempt.
    private PowerManager.WakeLock pulseLock;
    private final Handler mainHandler = new Handler(Looper.getMainLooper());

    // Set while the hrm-fgs-stop worker is mid-upload. A second ACTION_STOP
    // arriving in that window must not release the wake lock / drop foreground /
    // stopSelf, or it kills the upload the worker is protecting.
    private volatile boolean stopInFlight = false;

    private final HrEngine.ServiceHooks hooks = new HrEngine.ServiceHooks() {
        @Override public void set(boolean hold) {
            if (hold) acquireWakeLock();
            else if (!stopInFlight) releaseWakeLock();
        }
        @Override public void pulse(long ms) { pulseWakeLock(ms); }
        @Override public void liveStop(int gen, String reason) {
            mainHandler.post(() -> {
                HrEngine e = HrEngine.peek();
                if (e != null) startLiveStop(e, gen, reason);
            });
        }
    };

    @Override
    public void onCreate() {
        super.onCreate();
        ensureChannel();
    }

    private synchronized void acquireWakeLock() {
        if (wakeLock != null && wakeLock.isHeld()) return;
        try {
            PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
            if (pm == null) return;
            wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "HRMonitor:Service");
            wakeLock.setReferenceCounted(false);
            wakeLock.acquire();
        } catch (Throwable t) {
            Log.w(TAG, "acquireWakeLock failed: " + t.getMessage());
        }
    }

    private synchronized void releaseWakeLock() {
        try {
            if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        } catch (Throwable ignored) {}
        wakeLock = null;
    }

    private synchronized void pulseWakeLock(long ms) {
        try {
            if (pulseLock == null) {
                PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
                if (pm == null) return;
                pulseLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "HRMonitor:Wake");
                pulseLock.setReferenceCounted(false);
            }
            pulseLock.acquire(ms);
        } catch (Throwable t) {
            Log.w(TAG, "pulseWakeLock failed: " + t.getMessage());
        }
    }

    private synchronized void releasePulse() {
        try {
            if (pulseLock != null && pulseLock.isHeld()) pulseLock.release();
        } catch (Throwable ignored) {}
    }

    private static String originOf(Intent intent) {
        if (intent == null) return ServiceStartPolicy.ORIGIN_STICKY;
        String o = intent.getStringExtra(EXTRA_ORIGIN);
        // No origin: treat as our own start, which never resumes.
        return o != null && !o.isEmpty() ? o : ServiceStartPolicy.ORIGIN_ENGINE;
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent != null && intent.getAction() != null ? intent.getAction() : ACTION_START;
        String origin = originOf(intent);
        SharedPreferences prefs = getSharedPreferences("hr_monitor_session", 0);
        boolean prefsLive = ServiceStartPolicy.prefsLive(prefs.getBoolean("sessionActive", false),
            prefs.getBoolean("cleanlyStopped", true));
        HrEngine peeked = HrEngine.peek();
        boolean active = peeked != null && peeked.isSessionActive();
        logLifecycle(this, "service_start action=" + action + " origin=" + origin + " engine=" + (peeked != null)
            + " active=" + active + " prefsLive=" + prefsLive);

        // startForeground first, on every path: each startForegroundService is a fresh 5 s contract.
        long startMs = intent != null ? intent.getLongExtra(EXTRA_SESSION_START_MS, 0L) : 0L;
        if (startMs <= 0L) startMs = prefs.getLong("sessionStartMs", 0L);
        boolean stopping = stopInFlight || HrEngine.isStopTeardownInProgress();
        LinkStatePolicy.State shown = ServiceStartPolicy.notificationState(stopping, active,
            active ? peeked.linkState() : LinkStatePolicy.State.PRE_RESUME);
        String[] text = shown == LinkStatePolicy.State.STOPPING || !active
            ? ServiceStartPolicy.text(shown, 0, null, 0L) : peeked.notificationText();
        try {
            startForeground(NOTIFICATION_ID, buildNotificationStatic(this, text[0], text[1], startMs));
        } catch (Throwable t) {
            Log.w(TAG, "startForeground failed: " + t.getMessage());
        }

        long liveSessionStartMs = active ? peeked.getSessionStartMs() : prefs.getLong("sessionStartMs", 0L);
        boolean noStickyTest = false;
        if (BuildConfig.TEST_HOOKS && liveSessionStartMs > 0L
                && prefs.getLong("test_no_sticky_session", 0L) == liveSessionStartMs) {
            noStickyTest = true;
        }

        if (ACTION_STOP.equals(action)) {
            // A stop worker is already running; the branches below would
            // release the wake lock and stopSelf mid-upload.
            if (stopInFlight) {
                Log.i(TAG, "ACTION_STOP ignored — stop already in flight.");
                return START_NOT_STICKY;
            }
            final long intentStartMs = intent != null ? intent.getLongExtra(EXTRA_SESSION_START_MS, 0L) : 0L;
            final HrEngine[] liveEngine = new HrEngine[1];
            // Live or stale decided under START_LOCK: never between a resume's claim and its prefs commit.
            SessionGate.StopPath path = HrEngine.GATE.stop(
                () -> {
                    HrEngine e = HrEngine.peek();
                    liveEngine[0] = e;
                    return e != null && e.isSessionActive();
                },
                HrEngine::isStopTeardownInProgress,
                () -> startLiveStop(liveEngine[0], liveEngine[0].getSessionGeneration(), ServiceStartPolicy.REASON_USER_STOP),
                () -> {
                    setFgLossReason(this, "stale_action_stop");
                    commitStaleStopIfCurrent(intentStartMs);
                });
            if (path == SessionGate.StopPath.TEARDOWN) {
                Log.i(TAG, "ACTION_STOP ignored — stop upload worker in progress.");
            } else if (path == SessionGate.StopPath.STALE) {
                Log.i(TAG, "ACTION_STOP with no live session (stale intent or pending recovery).");
                // A mismatched Stop left prefs live: the resume alarm stays.
                boolean liveAfter = ServiceStartPolicy.prefsLive(prefs.getBoolean("sessionActive", false),
                    prefs.getBoolean("cleanlyStopped", true));
                if (ServiceStartPolicy.staleStopCancelsAlarm(liveAfter)) HrServiceHeartbeatReceiver.cancel(this);
                releaseWakeLock();
                try { stopForeground(true); } catch (Throwable ignored) {}
                stopSelf(startId);
            }
            return START_NOT_STICKY;
        }

        ServiceStartPolicy.Action decision = ServiceStartPolicy.decide(origin, prefsLive, active,
            HrEngine.isStopTeardownInProgress());
        switch (decision) {
            case ATTACH:
                attach(peeked, origin);
                return ServiceStartPolicy.sticky(decision, noStickyTest) ? START_STICKY : START_NOT_STICKY;
            case TEARDOWN:
                logLifecycle(this, "service_teardown_wait origin=" + origin);
                return START_NOT_STICKY;
            case RESUME: {
                // obtain, never the constructor: the constructor's mark-broken runs only on first construction.
                HrEngine.Obtained o = HrEngine.obtain(this);
                if (o.created) {
                    logLifecycle(this, "engine_create by=service pid=" + android.os.Process.myPid()
                        + " interrupted=" + o.engine.wasInterruptedAtCreate() + " markedBroken=" + o.engine.wasMarkedBrokenAtCreate());
                }
                JSONObject r = o.engine.resumeFromPrefs(origin);
                if (r.optBoolean("resumed", false) || r.optBoolean("alreadyRunning", false)) {
                    attach(o.engine, origin);
                    return ServiceStartPolicy.sticky(decision, noStickyTest) ? START_STICKY : START_NOT_STICKY;
                }
                String reason = r.optString("reason", "");
                // Only not_live drops the alarm; error and stopping keep it for the next try.
                idleStop(startId, origin + " resume=" + reason, ServiceStartPolicy.resumeDeclineCancelsAlarm(reason));
                return START_NOT_STICKY;
            }
            case IDLE_STOP:
            default:
                idleStop(startId, origin, true);
                return START_NOT_STICKY;
        }
    }

    // A live engine: wake lock per link state (through the hooks), the alarm, the current text, then the wake.
    private void attach(HrEngine engine, String origin) {
        engine.setServiceHooks(hooks);
        HrServiceHeartbeatReceiver.schedule(this);
        try {
            String[] t = engine.notificationText();
            NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm != null) nm.notify(NOTIFICATION_ID, buildNotificationStatic(this, t[0], t[1], engine.getSessionStartMs()));
        } catch (Throwable t) {
            Log.w(TAG, "notification refresh failed: " + t.getMessage());
        }
        engine.onWake(origin);
    }

    // Nothing records: no wake lock, notification or (unless kept) alarm survives a stray start.
    private void idleStop(int startId, String origin, boolean cancelAlarm) {
        logLifecycle(this, "service_idle_stop origin=" + origin);
        if (cancelAlarm) HrServiceHeartbeatReceiver.cancel(this);
        releaseWakeLock();
        releasePulse();
        try { stopForeground(true); } catch (Throwable ignored) {}
        stopSelf(startId);
    }

    // The live Stop, for the notification button and the auto-end: holds the wake lock until the engine's
    // upload worker ends; the generation guard spares a newer session.
    private void startLiveStop(final HrEngine engine, final int gen, final String reason) {
        if (engine == null) return;
        if (stopInFlight) {
            Log.i(TAG, "live stop (" + reason + ") ignored — stop already in flight.");
            return;
        }
        setFgLossReason(this, reason);
        // NOT_FOUND released the lock; the A2 uploads need it in Doze.
        acquireWakeLock();
        stopInFlight = true;
        final Context app = getApplicationContext();
        Thread stopWorker = new Thread(() -> {
            boolean stopped = false;
            try {
                java.util.concurrent.CountDownLatch uploadDone = engine.stopSessionInternalIfCurrent(gen);
                stopped = uploadDone != null;
                boolean announce = ServiceStartPolicy.announceAutoEnd(stopped, reason);
                if (announce) {
                    logLifecycle(app, "session_auto_end reason=strap_missing hours="
                        + ServiceStartPolicy.hoursLabel(engine.autoEndUsedMs()));
                }
                if (stopped && !uploadDone.await(STOP_WORKER_WAIT_MS, java.util.concurrent.TimeUnit.MILLISECONDS)) {
                    Log.w(TAG, "stop upload worker still running after " + STOP_WORKER_WAIT_MS + " ms");
                }
                // After the worker's FGS stop, so the ongoing notification is gone first.
                if (announce) postEndedNotification(app, engine.autoEndUsedMs());
            } catch (Throwable t) {
                Log.w(TAG, "deferred stopSessionInternal threw: " + t.getMessage());
            } finally {
                // A session started during the upload owns the alarm and wake lock.
                HrEngine cur = HrEngine.peek();
                boolean newerLive = cur != null && cur.isSessionActive();
                if (ServiceStartPolicy.cancelAlarmAfterLiveStop(stopped, newerLive)) HrServiceHeartbeatReceiver.cancel(app);
                stopInFlight = false;
                if (ServiceStartPolicy.releaseAfterLiveStop(stopped, newerLive, HrEngine.isStopTeardownInProgress())) {
                    releaseWakeLock();
                    releasePulse();
                }
            }
        }, "hrm-fgs-stop");
        // Clear the flag if start() throws, else the Stop button stays dead.
        try {
            stopWorker.start();
        } catch (Throwable t) {
            stopInFlight = false;
            Log.w(TAG, "hrm-fgs-stop start failed: " + t.getMessage());
        }
    }

    // Plain and dismissible, on its own id, so it outlives the foreground notification.
    static void postEndedNotification(Context ctx, long autoEndMs) {
        try {
            ensureChannelStatic(ctx);
            NotificationManager nm = (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm == null) return;
            String[] t = ServiceStartPolicy.endedText(autoEndMs);
            Intent launch = new Intent(ctx, MainActivity.class);
            launch.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
            int piFlags = PendingIntent.FLAG_UPDATE_CURRENT
                | (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M ? PendingIntent.FLAG_IMMUTABLE : 0);
            PendingIntent content = PendingIntent.getActivity(ctx, 2, launch, piFlags);
            Notification n = new NotificationCompat.Builder(ctx, CHANNEL_ID)
                .setContentTitle(t[0])
                .setContentText(t[1])
                .setSmallIcon(ctx.getResources().getIdentifier("ic_stat_hr", "drawable", ctx.getPackageName()))
                .setContentIntent(content)
                .setAutoCancel(true)
                .setOngoing(false)
                .setPriority(NotificationCompat.PRIORITY_LOW)
                .build();
            nm.notify(ENDED_NOTIFICATION_ID, n);
            logLifecycle(ctx, "ended_notification_posted");
        } catch (Throwable t) {
            Log.w(TAG, "ENDED notification failed: " + t.getMessage());
        }
    }

    // Ends a session awaiting recovery only when the intent names it; an older queued Stop leaves prefs alone.
    private void commitStaleStopIfCurrent(long intentStartMs) {
        try {
            SharedPreferences prefs = getSharedPreferences("hr_monitor_session", 0);
            long prefsStartMs = prefs.getLong("sessionStartMs", 0L);
            boolean prefsActive = prefs.getBoolean("sessionActive", false);
            if (intentStartMs > 0L && intentStartMs == prefsStartMs && prefsActive) {
                String activeCsv = prefs.getString("activeCsvFilename", "");
                SharedPreferences.Editor ed = prefs.edit()
                    .putBoolean("sessionActive", false)
                    .putBoolean("cleanlyStopped", true)
                    .putString("activeCsvFilename", "")
                    .remove("test_no_sticky_session")
                    .remove("test_auto_end_ms")
                    .remove("test_auto_end_session");
                if (activeCsv != null && !activeCsv.isEmpty()) ed.putString("lastSessionFilename", activeCsv);
                ed.commit();
                logLifecycle(this, "stale_stop_match start=" + intentStartMs);
            } else {
                logLifecycle(this, "stale_stop_mismatch intent=" + intentStartMs
                    + " prefs=" + prefsStartMs + " prefsActive=" + prefsActive);
            }
        } catch (Throwable t) {
            Log.w(TAG, "commitStaleStopIfCurrent failed: " + t.getMessage());
        }
    }

    @Override
    public void onDestroy() {
        setFgLossReason(this, "service_on_destroy");
        HrEngine e = HrEngine.peek();
        if (e != null) e.clearServiceHooks(hooks);
        // A deliberate stop clears the session before stopService, so it never reaches the restart.
        boolean lostActive = e != null && e.isSessionActive() && !HrEngine.isStopTeardownInProgress();
        try { stopForeground(true); } catch (Throwable ignored) {}
        releaseWakeLock();
        releasePulse();
        if (lostActive) {
            logLifecycle(this, "fgs_lost_active");
            long now = System.currentTimeMillis();
            if (now - lastFgsRestartMs >= FGS_RESTART_MIN_MS) {
                lastFgsRestartMs = now;
                try {
                    Intent i = new Intent(getApplicationContext(), NativeHrService.class);
                    i.setAction(ACTION_START);
                    i.putExtra(EXTRA_ORIGIN, ServiceStartPolicy.ORIGIN_ENGINE);
                    i.putExtra(EXTRA_SESSION_START_MS, e.getSessionStartMs());
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                        getApplicationContext().startForegroundService(i);
                    } else {
                        getApplicationContext().startService(i);
                    }
                } catch (Throwable t) {
                    // API 31+ background start ban: the alarm door restarts it.
                    boolean denied = t.getClass().getName().endsWith("ForegroundServiceStartNotAllowedException");
                    logLifecycle(this, denied ? "fgs_restart_denied" : "fgs_restart_failed " + t.getClass().getSimpleName());
                }
            }
        }
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) { return null; }

    // Session survives swipe-from-recents. Only the notification Stop button
    // (ACTION_STOP) and JS-initiated stopSession may terminate a session.
    // Samsung One UI invokes onTaskRemoved on long-destroyed Activities even
    // without a user gesture; terminating here loses overnight recordings.
    @Override
    public void onTaskRemoved(Intent rootIntent) {
        Log.i(TAG, "onTaskRemoved — ignoring (session-survives-swipe)");
        setFgLossReason(this, "task_removed_ignored");
        super.onTaskRemoved(rootIntent);
    }

    // Synchronous probe write. Both keys committed together so a post-mortem
    // adb shell run-as ... cat shared_prefs/hr_monitor_session.xml names the
    // exit door + when. .commit() because we may be torn down within frames.
    static void setFgLossReason(Context ctx, String reason) {
        try {
            SharedPreferences prefs = ctx.getSharedPreferences("hr_monitor_session", 0);
            prefs.edit()
                .putString("last_fg_loss_reason", reason)
                .putLong("last_fg_loss_ms", System.currentTimeMillis())
                .commit();
        } catch (Throwable t) {
            Log.w(TAG, "setFgLossReason failed: " + t.getMessage());
        }
        logLifecycle(ctx, "fg_loss:" + reason);
    }

    private static final long LIFECYCLE_LOG_MAX_BYTES = 512 * 1024;
    private static boolean processStartLogged = false;

    // Append-only lifecycle trail in files/lifecycle.log ("epochMs,event"); read with adb run-as.
    static synchronized void logLifecycle(Context ctx, String event) {
        if (ctx == null) return;
        try {
            java.io.File f = new java.io.File(ctx.getFilesDir(), "lifecycle.log");
            if (f.length() > LIFECYCLE_LOG_MAX_BYTES) trimToTail(f, LIFECYCLE_LOG_MAX_BYTES / 2);
            try (java.io.FileWriter w = new java.io.FileWriter(f, true)) {
                long now = System.currentTimeMillis();
                if (!processStartLogged) {
                    w.write(now + ",process_start pid=" + android.os.Process.myPid() + "\n");
                    processStartLogged = true;
                }
                w.write(now + "," + event + "\n");
            }
        } catch (Throwable t) {
            Log.w(TAG, "logLifecycle failed: " + t.getMessage());
        }
    }

    private static void trimToTail(java.io.File f, long keepBytes) throws java.io.IOException {
        long len = f.length();
        byte[] buf = new byte[(int) Math.min(keepBytes, len)];
        try (java.io.RandomAccessFile raf = new java.io.RandomAccessFile(f, "r")) {
            raf.seek(len - buf.length);
            raf.readFully(buf);
        }
        int start = 0;
        while (start < buf.length && buf[start] != '\n') start++;
        try (java.io.FileOutputStream out = new java.io.FileOutputStream(f, false)) {
            out.write(buf, Math.min(start + 1, buf.length), buf.length - Math.min(start + 1, buf.length));
        }
    }

    private void ensureChannel() { ensureChannelStatic(this); }

    static void ensureChannelStatic(Context ctx) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager nm = (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null) return;
        NotificationChannel existing = nm.getNotificationChannel(CHANNEL_ID);
        if (existing != null) return;
        NotificationChannel ch = new NotificationChannel(
            CHANNEL_ID, "HR Monitor recording", NotificationManager.IMPORTANCE_LOW);
        ch.setDescription("Keeps the app recording while the screen is off.");
        ch.setShowBadge(false);
        nm.createNotificationChannel(ch);
    }

    static Notification buildNotificationStatic(Context ctx, String title, String body, long sessionStartMs) {
        Intent launch = new Intent(ctx, MainActivity.class);
        launch.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        launch.putExtra("route", "monitor");
        int piFlags = PendingIntent.FLAG_UPDATE_CURRENT
            | (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M ? PendingIntent.FLAG_IMMUTABLE : 0);
        PendingIntent content = PendingIntent.getActivity(ctx, 0, launch, piFlags);

        Intent stop = new Intent(ctx, NativeHrService.class);
        stop.setAction(ACTION_STOP);
        stop.putExtra(EXTRA_SESSION_START_MS, sessionStartMs);
        PendingIntent stopPi = PendingIntent.getService(ctx, 1, stop, piFlags);

        return new NotificationCompat.Builder(ctx, CHANNEL_ID)
            .setContentTitle(title)
            .setContentText(body)
            .setSmallIcon(ctx.getResources().getIdentifier("ic_stat_hr", "drawable", ctx.getPackageName()))
            .setContentIntent(content)
            .setOngoing(true)
            .setSilent(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .addAction(0, "Stop session", stopPi)
            .build();
    }

    static int getNotificationId() { return NOTIFICATION_ID; }

}
