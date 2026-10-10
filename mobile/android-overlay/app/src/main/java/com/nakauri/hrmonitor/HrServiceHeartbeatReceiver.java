package com.nakauri.hrmonitor;

import android.app.AlarmManager;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Build;
import android.util.Log;

// Periodic FGS-resurrection check. setAlarmClock is the ONLY alarm class
// Samsung's One UI cannot suppress in deep sleep — setExactAndAllowWhileIdle
// gets throttled hard on S8 / overnight. The cost is a visible alarm-clock
// chip in the status bar while a session is active; the benefit is the
// session actually surviving overnight without the user adding the app to
// "Never sleeping apps".
public class HrServiceHeartbeatReceiver extends BroadcastReceiver {
    private static final String TAG = "HrHeartbeat";
    private static final int REQ_CODE = 0xA0;
    // 10 min: short enough that a single missed beat still recovers within
    // 20 min; long enough that battery cost is negligible compared to the
    // wake lock the FGS already holds.
    private static final long INTERVAL_MS = 10L * 60L * 1000L;

    @Override
    public void onReceive(Context context, Intent intent) {
        boolean shouldContinue = false;
        try {
            SharedPreferences prefs = context.getSharedPreferences("hr_monitor_session", 0);
            boolean sessionActive = prefs.getBoolean("sessionActive", false);
            boolean cleanlyStopped = prefs.getBoolean("cleanlyStopped", true);
            shouldContinue = sessionActive && !cleanlyStopped;
            if (shouldContinue) {
                // The Service resumes a dead session or wakes a live one (onWake owns the segment tick).
                Intent startIntent = new Intent(context, NativeHrService.class);
                startIntent.setAction(NativeHrService.ACTION_START);
                startIntent.putExtra(NativeHrService.EXTRA_ORIGIN, ServiceStartPolicy.ORIGIN_ALARM);
                try {
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                        context.startForegroundService(startIntent);
                    } else {
                        context.startService(startIntent);
                    }
                    Log.i(TAG, "Heartbeat: requested FGS start (sessionActive=true, cleanlyStopped=false)");
                } catch (Throwable t) {
                    // API 31+: an inexact alarm carries no FGS-start allowance; only the exact alarm clock does.
                    NativeHrService.logLifecycle(context, "fgs_start_denied " + t.getClass().getSimpleName());
                }
            }
        } catch (Throwable t) {
            Log.w(TAG, "Heartbeat receive failed: " + t.getMessage());
        }
        // Re-arm only while a session is still meant to be running, so a
        // delivered alarm after a clean stop doesn't restart the loop forever.
        if (shouldContinue) schedule(context);
    }

    // True when the 10-minute alarm is an exact alarm clock (always below API 31).
    public static boolean exactAlarmsAllowed(Context context) {
        try {
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return true;
            AlarmManager am = (AlarmManager) context.getSystemService(Context.ALARM_SERVICE);
            return am != null && am.canScheduleExactAlarms();
        } catch (Throwable t) {
            return true;
        }
    }

    public static void schedule(Context context) {
        scheduleAt(context, System.currentTimeMillis() + INTERVAL_MS);
    }

    // The worker's API 31+ handoff: WorkManager may not start a foreground service there; the alarm may.
    public static void scheduleSoon(Context context, long delayMs) {
        scheduleAt(context, System.currentTimeMillis() + Math.max(0L, delayMs));
    }

    private static void scheduleAt(Context context, long triggerAt) {
        try {
            AlarmManager am = (AlarmManager) context.getSystemService(Context.ALARM_SERVICE);
            if (am == null) return;
            PendingIntent pi = pendingIntent(context, false);
            // API 31+: exact alarms can be revoked; setAlarmClock would throw without the grant.
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S && !am.canScheduleExactAlarms()) {
                am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, triggerAt, pi);
                NativeHrService.logLifecycle(context, "alarm_inexact");
                return;
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
                // Tap-target for the alarm chip — opens MainActivity. Required
                // by setAlarmClock (the chip wants somewhere to take the user).
                Intent showIntent = new Intent(context, MainActivity.class);
                showIntent.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                int piFlags = (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M ? PendingIntent.FLAG_IMMUTABLE : 0);
                PendingIntent showPi = PendingIntent.getActivity(context, REQ_CODE + 1, showIntent, piFlags | PendingIntent.FLAG_UPDATE_CURRENT);
                AlarmManager.AlarmClockInfo info = new AlarmManager.AlarmClockInfo(triggerAt, showPi);
                am.setAlarmClock(info, pi);
            } else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
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
