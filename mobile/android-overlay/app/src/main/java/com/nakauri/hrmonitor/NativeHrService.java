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
import android.os.IBinder;
import android.os.PowerManager;
import android.util.Log;

import androidx.core.app.NotificationCompat;

// Foreground service for active HR sessions. Owns only the notification +
// process anchor; BLE / relay / CSV / Drive live in NativeHrSessionPlugin.
public class NativeHrService extends Service {
    private static final String TAG = "NativeHrService";
    private static final String CHANNEL_ID = "hr_monitor_native";
    private static final int NOTIFICATION_ID = 7703;

    public static final String ACTION_START = "com.nakauri.hrmonitor.NATIVE_HR_START";
    public static final String ACTION_STOP = "com.nakauri.hrmonitor.NATIVE_HR_STOP";
    public static final String EXTRA_TITLE = "title";
    public static final String EXTRA_BODY = "body";
    // On the Stop PendingIntent: the session it was built for. 0 = unknown.
    public static final String EXTRA_SESSION_START_MS = "sessionStartMs";
    // Bound on keeping the wake lock for the plugin's stop upload worker.
    private static final long STOP_WORKER_WAIT_MS = 10L * 60L * 1000L;

    // Service-owned PARTIAL_WAKE_LOCK. Held for the session's lifetime so
    // BLE callbacks keep firing through Doze.
    private PowerManager.WakeLock wakeLock;

    // Set while the hrm-fgs-stop worker is mid-upload. A second ACTION_STOP
    // arriving in that window must not release the wake lock / drop foreground /
    // stopSelf, or it kills the upload the worker is protecting.
    private volatile boolean stopInFlight = false;

    @Override
    public void onCreate() {
        super.onCreate();
        ensureChannel();
    }

    private void acquireWakeLock() {
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

    private void releaseWakeLock() {
        try {
            if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        } catch (Throwable ignored) {}
        wakeLock = null;
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent != null ? intent.getAction() : ACTION_START;

        // startForeground must run within 5 s of startForegroundService, even on STOP.
        String title = intent != null && intent.getStringExtra(EXTRA_TITLE) != null
            ? intent.getStringExtra(EXTRA_TITLE) : "HR Monitor";
        String body = intent != null && intent.getStringExtra(EXTRA_BODY) != null
            ? intent.getStringExtra(EXTRA_BODY) : "Recording";
        long startMs = intent != null ? intent.getLongExtra(EXTRA_SESSION_START_MS, 0L) : 0L;
        if (startMs <= 0L) startMs = prefsSessionStartMs(this);
        Notification n = buildNotificationStatic(this, title, body, startMs);
        try {
            startForeground(NOTIFICATION_ID, n);
        } catch (Throwable t) {
            Log.w(TAG, "startForeground failed: " + t.getMessage());
        }

        if (ACTION_STOP.equals(action)) {
            // A stop worker is already running; the flag branches below would
            // release the wake lock and stopSelf mid-upload. Bail after the
            // mandatory startForeground.
            if (stopInFlight) {
                Log.i(TAG, "ACTION_STOP ignored — stop already in flight.");
                return START_NOT_STICKY;
            }
            // Stale-intent guard: if no session is active, this is a queued
            // intent from a prior session that delivered after the user
            // started a new one. Tear down the FGS but do not call
            // stopSessionInternal (which would close the fresh GATT).
            NativeHrSessionPlugin plugin = NativeHrSessionPlugin.instance;
            boolean sessionLive = plugin != null && plugin.isSessionActive();
            setFgLossReason(this, sessionLive ? "user_stop_button" : "stale_action_stop");
            if (sessionLive) {
                // Holds the wake lock until the plugin's upload worker ends; the generation guard spares a newer session.
                final int gen = plugin.getSessionGeneration();
                final NativeHrSessionPlugin p = plugin;
                stopInFlight = true;
                Thread stopWorker = new Thread(() -> {
                    boolean stopped = false;
                    try {
                        java.util.concurrent.CountDownLatch uploadDone = p.stopSessionInternalIfCurrent(gen);
                        stopped = uploadDone != null;
                        if (stopped && !uploadDone.await(STOP_WORKER_WAIT_MS, java.util.concurrent.TimeUnit.MILLISECONDS)) {
                            Log.w(TAG, "stop upload worker still running after " + STOP_WORKER_WAIT_MS + " ms");
                        }
                    } catch (Throwable t) {
                        Log.w(TAG, "deferred stopSessionInternal threw: " + t.getMessage());
                    } finally {
                        // A session started during the upload owns the alarm and wake lock.
                        NativeHrSessionPlugin cur = NativeHrSessionPlugin.instance;
                        boolean newerLive = cur != null && cur.isSessionActive();
                        if (stopped && !newerLive) {
                            HrServiceHeartbeatReceiver.cancel(NativeHrService.this);
                            releaseWakeLock();
                        }
                        stopInFlight = false;
                    }
                }, "hrm-fgs-stop");
                // Clear the flag if start() throws, else the Stop button stays dead.
                try {
                    stopWorker.start();
                } catch (Throwable t) {
                    stopInFlight = false;
                    Log.w(TAG, "hrm-fgs-stop start failed: " + t.getMessage());
                }
                return START_NOT_STICKY;
            }
            // A stop's upload worker is still running; its tail owns service shutdown.
            if (NativeHrSessionPlugin.isStopTeardownInProgress()) {
                Log.i(TAG, "ACTION_STOP ignored — stop upload worker in progress.");
                return START_NOT_STICKY;
            }
            Log.i(TAG, "ACTION_STOP with no live session (stale intent or pending recovery).");
            commitStaleStopIfCurrent(intent != null ? intent.getLongExtra(EXTRA_SESSION_START_MS, 0L) : 0L);
            HrServiceHeartbeatReceiver.cancel(this);
            releaseWakeLock();
            stopForeground(true);
            stopSelf();
            return START_NOT_STICKY;
        }
        // ACTION_START path: acquire CPU keepalive + arm the periodic FGS
        // resurrection alarm. Both are no-ops if already done — the heartbeat
        // receiver re-fires this same path so we get re-armed across kills.
        acquireWakeLock();
        HrServiceHeartbeatReceiver.schedule(this);
        return START_STICKY;
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
                    .putString("activeCsvFilename", "");
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

    private static long prefsSessionStartMs(Context ctx) {
        try {
            return ctx.getSharedPreferences("hr_monitor_session", 0).getLong("sessionStartMs", 0L);
        } catch (Throwable t) {
            return 0L;
        }
    }

    @Override
    public void onDestroy() {
        setFgLossReason(this, "service_on_destroy");
        try { stopForeground(true); } catch (Throwable ignored) {}
        releaseWakeLock();
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
