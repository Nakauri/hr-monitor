package com.nakauri.hrmonitor;

import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Build;
import android.util.Log;

import androidx.annotation.NonNull;
import androidx.work.ExistingPeriodicWorkPolicy;
import androidx.work.PeriodicWorkRequest;
import androidx.work.WorkManager;
import androidx.work.Worker;
import androidx.work.WorkerParameters;

import java.util.concurrent.TimeUnit;

// Redundant FGS-resurrection job. Independent of HrServiceHeartbeatReceiver
// (AlarmManager) so an OEM that throttles one path still leaves the other
// running. WorkManager periodic jobs are scheduled by the OS itself and
// survive across kill / Doze. 15 min is the minimum WorkManager interval.
public class SessionResurrectionWorker extends Worker {
    private static final String TAG = "SessionResurrection";
    private static final String UNIQUE_NAME = "hr_monitor_session_resurrection";

    public SessionResurrectionWorker(@NonNull Context context, @NonNull WorkerParameters params) {
        super(context, params);
    }

    @NonNull
    @Override
    public Result doWork() {
        try {
            Context ctx = getApplicationContext();
            SharedPreferences prefs = ctx.getSharedPreferences("hr_monitor_session", 0);
            boolean sessionActive = prefs.getBoolean("sessionActive", false);
            boolean cleanlyStopped = prefs.getBoolean("cleanlyStopped", true);
            if (sessionActive && !cleanlyStopped) {
                Intent startIntent = new Intent(ctx, NativeHrService.class);
                startIntent.setAction(NativeHrService.ACTION_START);
                startIntent.putExtra(NativeHrService.EXTRA_TITLE, "HR Monitor");
                startIntent.putExtra(NativeHrService.EXTRA_BODY, "Recording");
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    ctx.startForegroundService(startIntent);
                } else {
                    ctx.startService(startIntent);
                }
                Log.i(TAG, "Resurrection job: requested FGS start.");
            }
            return Result.success();
        } catch (Throwable t) {
            Log.w(TAG, "Resurrection job failed: " + t.getMessage());
            return Result.retry();
        }
    }

    public static void schedule(Context context) {
        try {
            // 15 min is WorkManager's hard minimum periodic interval. Paired
            // with the 10-min AlarmManager heartbeat the LCM is 30 min and
            // worst-case gap between any-fire is ~10 min. initialDelay 5 min
            // offsets the first WM fire from the first AM fire so they don't
            // coincide on schedule().
            PeriodicWorkRequest request = new PeriodicWorkRequest.Builder(
                    SessionResurrectionWorker.class, 15, TimeUnit.MINUTES)
                .setInitialDelay(5, TimeUnit.MINUTES)
                .build();
            WorkManager.getInstance(context).enqueueUniquePeriodicWork(
                UNIQUE_NAME,
                ExistingPeriodicWorkPolicy.KEEP,
                request);
        } catch (Throwable t) {
            Log.w(TAG, "schedule failed: " + t.getMessage());
        }
    }
}
