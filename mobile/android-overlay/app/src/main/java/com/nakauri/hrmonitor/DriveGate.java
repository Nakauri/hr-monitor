package com.nakauri.hrmonitor;

import android.content.Context;
import android.net.ConnectivityManager;

// Device reads for DrivePolicy. The pause lives in the segment prefs so SegmentUploader reads it through its Store.
public final class DriveGate {
    private static final String PREFS = "hr_monitor_segments";

    private DriveGate() { }

    public static boolean paused(Context ctx) {
        return "1".equals(ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(SegmentUploader.K_PAUSED, null));
    }

    public static void setPaused(Context ctx, boolean paused) {
        android.content.SharedPreferences.Editor ed = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit();
        if (paused) ed.putString(SegmentUploader.K_PAUSED, "1"); else ed.remove(SegmentUploader.K_PAUSED);
        ed.commit();
    }

    // Unknown counts as metered, so a failed read never spends mobile data.
    public static boolean metered(Context ctx) {
        try {
            ConnectivityManager cm = (ConnectivityManager) ctx.getSystemService(Context.CONNECTIVITY_SERVICE);
            return cm == null || cm.isActiveNetworkMetered();
        } catch (Throwable t) {
            return true;
        }
    }
}
