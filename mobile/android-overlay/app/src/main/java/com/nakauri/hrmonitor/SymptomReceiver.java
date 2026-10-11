package com.nakauri.hrmonitor;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.util.Log;

// The notification's Symptom action: one symptom fact into a live session, else a dropped line.
// Reads the engine only; the Service and its start decisions stay out of reach.
public class SymptomReceiver extends BroadcastReceiver {
    private static final String TAG = "HrSymptom";
    private static long lastWriteMs;

    @Override
    public void onReceive(Context context, Intent intent) {
        final long now = System.currentTimeMillis();
        final Context app = context.getApplicationContext() != null ? context.getApplicationContext() : context;
        final PendingResult pending;
        try {
            pending = goAsync();
        } catch (Throwable t) {
            Log.w(TAG, "goAsync failed: " + t);
            return;
        }
        try {
            new Thread(() -> {
                try {
                    record(app, now);
                } catch (Throwable t) {
                    Log.w(TAG, "symptom failed: " + t);
                } finally {
                    try { pending.finish(); } catch (Throwable ignored) {}
                }
            }, "hrm-symptom").start();
        } catch (Throwable t) {
            Log.w(TAG, "symptom thread not started: " + t);
            try { pending.finish(); } catch (Throwable ignored) {}
        }
    }

    private static void record(Context ctx, long now) {
        HrEngine e = HrEngine.peek();
        boolean active = e != null && e.isSessionActive();
        if (!ServiceStartPolicy.symptomWrites(e != null, active)) {
            NativeHrService.logLifecycle(ctx, "symptom_dropped engine=" + (e != null) + " active=" + active);
            return;
        }
        synchronized (SymptomReceiver.class) {
            if (ServiceStartPolicy.symptomDebounced(lastWriteMs, now)) {
                NativeHrService.logLifecycle(ctx, "symptom_dropped reason=debounce");
                return;
            }
            lastWriteMs = now;
        }
        String r = e.logFact("symptom", now, "sym:symptom", null);
        if ("no_session".equals(r)) {
            NativeHrService.logLifecycle(ctx, "symptom_dropped reason=no_session");
        } else {
            NativeHrService.logLifecycle(ctx, "symptom_tap result=" + r);
        }
    }
}
