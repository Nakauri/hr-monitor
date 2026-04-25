package com.nakauri.hrmonitor;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.os.IBinder;
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

    @Override
    public void onCreate() {
        super.onCreate();
        ensureChannel();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent != null ? intent.getAction() : ACTION_START;

        // startForeground must run within 5 s of startForegroundService, even on STOP.
        String title = intent != null && intent.getStringExtra(EXTRA_TITLE) != null
            ? intent.getStringExtra(EXTRA_TITLE) : "HR Monitor";
        String body = intent != null && intent.getStringExtra(EXTRA_BODY) != null
            ? intent.getStringExtra(EXTRA_BODY) : "Recording";
        Notification n = buildNotification(title, body);
        try {
            startForeground(NOTIFICATION_ID, n);
        } catch (Throwable t) {
            Log.w(TAG, "startForeground failed: " + t.getMessage());
        }

        if (ACTION_STOP.equals(action)) {
            try {
                if (NativeHrSessionPlugin.instance != null) {
                    NativeHrSessionPlugin.instance.stopSessionInternal();
                }
            } catch (Throwable t) {
                Log.w(TAG, "plugin.stopSessionInternal threw: " + t.getMessage());
            }
            stopForeground(true);
            stopSelf();
            return START_NOT_STICKY;
        }
        return START_STICKY;
    }

    @Override
    public IBinder onBind(Intent intent) { return null; }

    // Swipe-to-stop: terminate the session. Posted to main thread because
    // onTaskRemoved fires on a binder thread (would ANR + race BLE callback).
    @Override
    public void onTaskRemoved(Intent rootIntent) {
        Log.i(TAG, "onTaskRemoved — terminating session");
        final NativeHrSessionPlugin plugin = NativeHrSessionPlugin.instance;
        new android.os.Handler(android.os.Looper.getMainLooper()).post(() -> {
            try {
                if (plugin != null) plugin.stopSessionInternal();
            } catch (Throwable t) {
                Log.w(TAG, "stopSessionInternal threw: " + t.getMessage());
            }
            try { stopForeground(true); } catch (Throwable ignored) {}
            stopSelf();
        });
        super.onTaskRemoved(rootIntent);
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

    static Notification buildNotificationStatic(Context ctx, String title, String body) {
        Intent launch = new Intent(ctx, MainActivity.class);
        launch.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        launch.putExtra("route", "monitor");
        int piFlags = PendingIntent.FLAG_UPDATE_CURRENT
            | (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M ? PendingIntent.FLAG_IMMUTABLE : 0);
        PendingIntent content = PendingIntent.getActivity(ctx, 0, launch, piFlags);

        Intent stop = new Intent(ctx, NativeHrService.class);
        stop.setAction(ACTION_STOP);
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

    private Notification buildNotification(String title, String body) {
        return buildNotificationStatic(this, title, body);
    }
}
