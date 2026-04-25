package com.nakauri.hrmonitor;

import android.content.Context;
import android.os.PowerManager;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

// PARTIAL_WAKE_LOCK around the foreground service. Non-ref-counted.
@CapacitorPlugin(name = "WakeLock")
public class WakeLockPlugin extends Plugin {
    private static final String LOCK_TAG = "HRMonitor:FGS";
    // static: survives plugin reload so the lock isn't orphaned.
    private static PowerManager.WakeLock wakeLock;

    @PluginMethod
    public void acquire(PluginCall call) {
        try {
            if (wakeLock != null && wakeLock.isHeld()) {
                JSObject already = new JSObject();
                already.put("held", true);
                already.put("alreadyHeld", true);
                call.resolve(already);
                return;
            }
            PowerManager pm = (PowerManager) getContext().getSystemService(Context.POWER_SERVICE);
            if (pm == null) {
                call.reject("PowerManager unavailable");
                return;
            }
            wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, LOCK_TAG);
            wakeLock.setReferenceCounted(false);
            wakeLock.acquire();
            JSObject ret = new JSObject();
            ret.put("held", true);
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("acquire failed: " + e.getMessage(), e);
        }
    }

    @PluginMethod
    public void release(PluginCall call) {
        try {
            releaseStatic();
            JSObject ret = new JSObject();
            ret.put("held", false);
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("release failed: " + e.getMessage(), e);
        }
    }

    @PluginMethod
    public void isHeld(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("held", wakeLock != null && wakeLock.isHeld());
        call.resolve(ret);
    }

    public static void releaseStatic() {
        if (wakeLock != null && wakeLock.isHeld()) {
            try { wakeLock.release(); } catch (Exception ignored) {}
        }
        wakeLock = null;
    }

    @Override
    protected void handleOnDestroy() {
        releaseStatic();
        super.handleOnDestroy();
    }
}
