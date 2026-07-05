package com.nakauri.hrmonitor;

import android.content.Context;
import android.util.Log;

import androidx.annotation.NonNull;
import androidx.work.Constraints;
import androidx.work.ExistingPeriodicWorkPolicy;
import androidx.work.NetworkType;
import androidx.work.PeriodicWorkRequest;
import androidx.work.WorkManager;
import androidx.work.Worker;
import androidx.work.WorkerParameters;

import java.io.File;
import java.util.concurrent.TimeUnit;

// Periodic Drive orphan recovery. Catches CSV files that never got
// uploaded because the previous session ended uncleanly (process kill,
// OEM background management) and the user never reopened the app.
// Runs every 6 h regardless of session state. Network-required so it
// doesn't burn battery on offline devices.
public class OrphanRecoveryWorker extends Worker {
    private static final String TAG = "OrphanRecoveryWorker";
    private static final String UNIQUE_NAME = "hr_monitor_orphan_recovery";

    public OrphanRecoveryWorker(@NonNull Context context, @NonNull WorkerParameters params) {
        super(context, params);
    }

    @NonNull
    @Override
    public Result doWork() {
        try {
            Context ctx = getApplicationContext();
            File sessionsDir = new File(ctx.getFilesDir(), "sessions");
            if (!sessionsDir.exists()) return Result.success();

            // Never scan while a session is recording (or died mid-record and
            // hasn't been cleanly stopped): the CSV is still growing and the
            // uploader owns it. Wait for the next 6 h pass.
            android.content.SharedPreferences prefs =
                ctx.getSharedPreferences("hr_monitor_session", Context.MODE_PRIVATE);
            boolean sessionActive = prefs.getBoolean("sessionActive", false);
            boolean cleanlyStopped = prefs.getBoolean("cleanlyStopped", true);
            if (sessionActive && !cleanlyStopped) {
                Log.i(TAG, "Orphan recovery skipped — session active/unclean.");
                return Result.success();
            }
            String activeCsv = prefs.getString("activeCsvFilename", null);

            NativeDriveUploader uploader = new NativeDriveUploader(ctx);
            // Mark the active filename so it's always skipped even if the flags
            // above are mid-transition.
            if (activeCsv != null && !activeCsv.isEmpty()) {
                uploader.markActiveSessionFilename(activeCsv);
            }
            // Run inline so WorkManager retry semantics actually apply.
            boolean ok = uploader.uploadOrphansSync(sessionsDir);
            Log.i(TAG, "Orphan recovery scan complete, ok=" + ok);
            return ok ? Result.success() : Result.retry();
        } catch (Throwable t) {
            Log.w(TAG, "Orphan recovery failed: " + t.getMessage());
            return Result.retry();
        }
    }

    public static void schedule(Context context) {
        try {
            Constraints constraints = new Constraints.Builder()
                .setRequiredNetworkType(NetworkType.CONNECTED)
                .build();
            PeriodicWorkRequest request = new PeriodicWorkRequest.Builder(
                    OrphanRecoveryWorker.class, 6, TimeUnit.HOURS)
                .setConstraints(constraints)
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
