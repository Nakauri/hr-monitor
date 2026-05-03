package com.nakauri.hrmonitor;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Build;
import android.util.Log;

// Survives reboots and app updates. If the user had an active session
// when the OS rebooted (or the app was upgraded mid-session via Play
// Store), restart the FGS so recording resumes without manual reopen.
public class HrBootReceiver extends BroadcastReceiver {
    private static final String TAG = "HrBootReceiver";

    @Override
    public void onReceive(Context context, Intent intent) {
        String action = intent != null ? intent.getAction() : null;
        if (!Intent.ACTION_BOOT_COMPLETED.equals(action)
                && !Intent.ACTION_MY_PACKAGE_REPLACED.equals(action)) {
            return;
        }
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
                HrServiceHeartbeatReceiver.schedule(context);
                Log.i(TAG, "Boot/upgrade: resumed session via FGS restart (action=" + action + ")");
            }
        } catch (Throwable t) {
            Log.w(TAG, "Boot/upgrade resume failed: " + t.getMessage());
        }
    }
}
