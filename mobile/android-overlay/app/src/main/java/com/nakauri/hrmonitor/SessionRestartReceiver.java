package com.nakauri.hrmonitor;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Build;
import android.util.Log;

// An app update kills the process mid-session; MY_PACKAGE_REPLACED (exempt from the API 31 FGS-start ban)
// starts the Service with origin=replaced, which resumes the session prefs say is live.
public class SessionRestartReceiver extends BroadcastReceiver {
    private static final String TAG = "SessionRestart";

    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent == null || !Intent.ACTION_MY_PACKAGE_REPLACED.equals(intent.getAction())) return;
        try {
            SharedPreferences prefs = context.getSharedPreferences("hr_monitor_session", 0);
            boolean live = ServiceStartPolicy.prefsLive(prefs.getBoolean("sessionActive", false),
                prefs.getBoolean("cleanlyStopped", true));
            NativeHrService.logLifecycle(context, "package_replaced live=" + live);
            if (!live) return;
            Intent start = new Intent(context, NativeHrService.class);
            start.setAction(NativeHrService.ACTION_START);
            start.putExtra(NativeHrService.EXTRA_ORIGIN, ServiceStartPolicy.ORIGIN_REPLACED);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(start);
            } else {
                context.startService(start);
            }
        } catch (Throwable t) {
            Log.w(TAG, "restart after update failed: " + t.getMessage());
        }
    }
}
