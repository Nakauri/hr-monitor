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

/**
 * Foreground Service owned by NativeHrSessionPlugin. Lives for the duration
 * of an active HR session, anchors the process so Android doesn't kill us
 * while backgrounded with the screen off, and displays the recording
 * notification the user expects.
 *
 * Intentionally thin — BLE + relay + CSV + Drive all live in the plugin
 * instance. This class exists solely to satisfy Android's "you must run a
 * foreground service to do long-lived work in the background" contract.
 *
 * Replaces our prior use of the @capawesome FGS plugin which crashed with
 * "Context.startForegroundService() did not then call Service.startForeground()"
 * during the session teardown path.
 */
public class NativeHrService extends Service {
    private static final String TAG = "NativeHrService";
    private static final String CHANNEL_ID = "hr_monitor_native";
    private static final int NOTIFICATION_ID = 7703;

    public static final String ACTION_START = "com.nakauri.hrmonitor.NATIVE_HR_START";
    public static final String ACTION_STOP = "com.nakauri.hrmonitor.NATIVE_HR_STOP";
    public static final String ACTION_UPDATE = "com.nakauri.hrmonitor.NATIVE_HR_UPDATE";
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
        if (ACTION_STOP.equals(action)) {
            // Tell the plugin to flush CSV + final Drive upload + close
            // relay + close GATT before the service dies. Without this,
            // tapping Stop from the notification would abruptly kill the
            // session with no final upload.
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
        return START_STICKY;
    }

    @Override
    public IBinder onBind(Intent intent) { return null; }

    private void ensureChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null) return;
        NotificationChannel existing = nm.getNotificationChannel(CHANNEL_ID);
        if (existing != null) return;
        NotificationChannel ch = new NotificationChannel(
            CHANNEL_ID, "HR Monitor recording", NotificationManager.IMPORTANCE_LOW);
        ch.setDescription("Keeps the app recording while the screen is off.");
        ch.setShowBadge(false);
        nm.createNotificationChannel(ch);
    }

    private Notification buildNotification(String title, String body) {
        // Tap the notification body to return to the app. Route hint is
        // read by MainActivity so we land on the monitor page, not the
        // landing page, when a session is active.
        Intent launch = new Intent(this, MainActivity.class);
        launch.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        launch.putExtra("route", "monitor");
        int piFlags = PendingIntent.FLAG_UPDATE_CURRENT
            | (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M ? PendingIntent.FLAG_IMMUTABLE : 0);
        PendingIntent content = PendingIntent.getActivity(this, 0, launch, piFlags);

        // Stop action: direct broadcast to the plugin so the user can kill
        // a running session without navigating into the app.
        Intent stop = new Intent(this, NativeHrService.class);
        stop.setAction(ACTION_STOP);
        PendingIntent stopPi = PendingIntent.getService(this, 1, stop, piFlags);

        return new NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle(title)
            .setContentText(body)
            .setSmallIcon(getResources().getIdentifier("ic_stat_hr", "drawable", getPackageName()))
            .setContentIntent(content)
            .setOngoing(true)
            .setSilent(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .addAction(0, "Stop session", stopPi)
            .build();
    }
}
