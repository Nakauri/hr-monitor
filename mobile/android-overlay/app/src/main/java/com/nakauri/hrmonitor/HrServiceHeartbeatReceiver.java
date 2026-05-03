package com.nakauri.hrmonitor;

import android.app.AlarmManager;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Build;
import android.util.Log;

// Periodic FGS-resurrection check. Fires every 15 min via
// setExactAndAllowWhileIdle (Doze-pierces). If a session was active and
// hasn't been cleanly stopped, ensures the FGS is running by issuing a
// startForegroundService Intent. The Service's onStartCommand is
// idempotent — already-running services just refresh the notification.
public class HrServiceHeartbeatReceiver extends BroadcastReceiver {
    private static final String TAG = "HrHeartbeat";
    private static final int REQ_CODE = 0xA0;
    private static final long INTERVAL_MS = 15L * 60L * 1000L;

    @Override
    public void onReceive(Context context, Intent intent) {
        try {
            SharedPreferences prefs = context.getSharedPreferences("hr_monitor_session", 0);
            boolean sessionActive = prefs.getBoolean("sessionActive", false);
            boolean cleanlyStopped = prefs.getBoolean("cleanlyStopped", true);
            if (sessionActive && !cleanlyStopped) {
                Intent startIntent = new Intent(context, NativeHrService.class);
                startIntent.setAction(NativeHrService.ACTION_START);
                startIntent.putExtra(NativeHrService.EXTRA_TITLE, "HR Monitor");
                startIntent.putExtra(NativeHrService.EXTRA_BODY, "Reconnecting after restart");
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    context.startForegroundService(startIntent);
                } else {
                    context.startService(startIntent);
                }
                Log.i(TAG, "Heartbeat: requested FGS start (sessionActive=true, cleanlyStopped=false)");
            }
        } catch (Throwable t) {
            Log.w(TAG, "Heartbeat receive failed: " + t.getMessage());
        }
        // Always re-schedule. The receiver is the loop.
        schedule(context);
    }

    public static void schedule(Context context) {
        try {
            AlarmManager am = (AlarmManager) context.getSystemService(Context.ALARM_SERVICE);
            if (am == null) return;
            PendingIntent pi = pendingIntent(context, false);
            long triggerAt = System.currentTimeMillis() + INTERVAL_MS;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                am.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, triggerAt, pi);
            } else {
                am.setExact(AlarmManager.RTC_WAKEUP, triggerAt, pi);
            }
        } catch (Throwable t) {
            Log.w(TAG, "schedule failed: " + t.getMessage());
        }
    }

    public static void cancel(Context context) {
        try {
            AlarmManager am = (AlarmManager) context.getSystemService(Context.ALARM_SERVICE);
            if (am == null) return;
            PendingIntent pi = pendingIntent(context, true);
            if (pi != null) {
                am.cancel(pi);
                pi.cancel();
            }
        } catch (Throwable t) {
            Log.w(TAG, "cancel failed: " + t.getMessage());
        }
    }

    private static PendingIntent pendingIntent(Context context, boolean noCreate) {
        Intent i = new Intent(context, HrServiceHeartbeatReceiver.class);
        int flags = (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M ? PendingIntent.FLAG_IMMUTABLE : 0);
        flags |= noCreate ? PendingIntent.FLAG_NO_CREATE : PendingIntent.FLAG_UPDATE_CURRENT;
        return PendingIntent.getBroadcast(context, REQ_CODE, i, flags);
    }
}
