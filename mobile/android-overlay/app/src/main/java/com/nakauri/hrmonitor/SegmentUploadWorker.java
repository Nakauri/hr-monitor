package com.nakauri.hrmonitor;

import android.content.Context;
import android.content.SharedPreferences;
import android.util.Log;

import androidx.annotation.NonNull;
import androidx.work.BackoffPolicy;
import androidx.work.Constraints;
import androidx.work.Data;
import androidx.work.ExistingWorkPolicy;
import androidx.work.NetworkType;
import androidx.work.OneTimeWorkRequest;
import androidx.work.WorkManager;
import androidx.work.Worker;
import androidx.work.WorkerParameters;

import java.io.File;
import java.io.IOException;
import java.util.concurrent.TimeUnit;

import okhttp3.MediaType;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;

// Backstop for closed v2 segments [K11]: enqueued on roll, stop, sign-in, app start and the 6 h orphan pass.
// Also builds the device SegmentUploader (OkHttp from HttpClientHolder, tokens from AuthStorage).
public class SegmentUploadWorker extends Worker {
    private static final String TAG = "SegmentUploadWorker";
    static final String UNIQUE_NAME = "segment-upload";
    private static final String PREFS = "hr_monitor_segments";
    private static final String KEY_REASON = "reason";
    // The open tick finishes one pass well inside this; past it the worker retries rather than block.
    private static final long LOCK_WAIT_MS = 120_000L;

    private static volatile SegmentUploader sUploader;

    public SegmentUploadWorker(@NonNull Context context, @NonNull WorkerParameters params) {
        super(context, params);
    }

    // reason: closed, stop or sweep. Never blocks and never throws.
    public static void enqueue(Context ctx, String reason, String name) {
        // Before the enqueue: a run already RUNNING (KEEP drops this request) sees the bump and sweeps again.
        SegmentUploader.noteClosed();
        try {
            Context app = ctx.getApplicationContext();
            NativeHrService.logLifecycle(app, "upload_enqueue name=" + (name != null ? name : "*") + " reason=" + reason);
            OneTimeWorkRequest req = new OneTimeWorkRequest.Builder(SegmentUploadWorker.class)
                .setConstraints(new Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
                .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
                .setInputData(new Data.Builder().putString(KEY_REASON, reason).build())
                .build();
            // KEEP: a pending or running worker already sweeps every pending segment, so a dropped enqueue loses nothing.
            WorkManager.getInstance(app).enqueueUniqueWork(UNIQUE_NAME, ExistingWorkPolicy.KEEP, req);
        } catch (Throwable t) {
            Log.w(TAG, "enqueue failed: " + t);
        }
    }

    @NonNull
    @Override
    public Result doWork() {
        try {
            Context ctx = getApplicationContext();
            String reason = getInputData().getString(KEY_REASON);
            HrEngine engine = HrEngine.peek();
            SegmentReader.OpenSegment open = engine != null ? engine.openSegmentForUpload() : null;
            // The reason is only logged: every run is a full sweep, legacy_pending included.
            NativeHrService.logLifecycle(ctx, "upload_run reason=" + reason);
            SegmentUploader.Result r = uploader(ctx).run(SegmentUploader.Mode.CLOSED, open, true, LOCK_WAIT_MS);
            switch (r) {
                case RETRY:
                case BUSY:
                    return Result.retry();
                default:
                    // Signed out: the files wait for sign-in, which enqueues again.
                    return Result.success();
            }
        } catch (Throwable t) {
            Log.w(TAG, "doWork threw: " + t);
            return Result.retry();
        }
    }

    static SegmentUploader uploader(Context ctx) {
        SegmentUploader u = sUploader;
        if (u != null) return u;
        synchronized (SegmentUploadWorker.class) {
            if (sUploader == null) {
                final Context app = ctx.getApplicationContext();
                final SharedPreferences prefs = app.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
                sUploader = new SegmentUploader(
                    new File(app.getFilesDir(), "segments"),
                    new File(app.getFilesDir(), "sessions"),
                    SegmentUploadWorker::send,
                    new SegmentUploader.Tokens() {
                        @Override public String token(boolean force) throws SegmentUploader.TransientAuthException {
                            try {
                                return AuthStorage.getValidAccessTokenOrThrow(app, force);
                            } catch (AuthStorage.TransientRefreshException e) {
                                throw new SegmentUploader.TransientAuthException(String.valueOf(e.getMessage()));
                            }
                        }
                        @Override public String account() { return AuthStorage.getEmail(app); }
                    },
                    new SegmentUploader.Store() {
                        @Override public String get(String k) { return prefs.getString(k, null); }
                        @Override public void put(String k, String v) { prefs.edit().putString(k, v).apply(); }
                        @Override public void remove(String k) { prefs.edit().remove(k).apply(); }
                        @Override public void removePrefix(String prefix) {
                            SharedPreferences.Editor ed = prefs.edit();
                            for (String k : prefs.getAll().keySet()) if (k.startsWith(prefix)) ed.remove(k);
                            ed.apply();
                        }
                    },
                    event -> NativeHrService.logLifecycle(app, event));
            }
            return sUploader;
        }
    }

    private static SegmentUploader.Resp send(String method, String url, String token, String contentType, byte[] body)
            throws IOException {
        Request.Builder b = new Request.Builder().url(url).header("Authorization", "Bearer " + token);
        if (body == null) {
            b.get();
        } else {
            b.method(method, RequestBody.create(MediaType.parse(contentType), body));
        }
        try (Response resp = HttpClientHolder.http().newCall(b.build()).execute()) {
            return new SegmentUploader.Resp(resp.code(), resp.body() != null ? resp.body().string() : "");
        }
    }
}
