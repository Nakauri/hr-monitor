package com.nakauri.hrmonitor;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Build;
import android.util.Log;

// Resumes the FGS only after a Play Store upgrade mid-session. Phone
// reboot is intentionally NOT handled here: the user expectation is
// that opening the app re-engages the strap, not that the device
// silently reconnects on cold boot. The "Reconnecting after restart"
// notification was misleading because the WebView/plugin aren't loaded
// yet at boot — the FGS just sat there showing copy that didn't match
// reality.
public class HrBootReceiver extends BroadcastReceiver {
    private static final String TAG = "HrBootReceiver";

    @Override
    public void onReceive(Context context, Intent intent) {
        String action = intent != null ? intent.getAction() : null;
        if (!Intent.ACTION_MY_PACKAGE_REPLACED.equals(action)) {
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
                startIntent.putExtra(NativeHrService.EXTRA_BODY, "Resuming after app update");
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    context.startForegroundService(startIntent);
                } else {
                    context.startService(startIntent);
                }
                HrServiceHeartbeatReceiver.schedule(context);
                Log.i(TAG, "App-upgrade: resumed session via FGS restart");
            }
        } catch (Throwable t) {
            Log.w(TAG, "Upgrade resume failed: " + t.getMessage());
        }
    }
}
