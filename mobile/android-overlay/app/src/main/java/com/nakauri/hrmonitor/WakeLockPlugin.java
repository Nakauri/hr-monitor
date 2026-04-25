package com.nakauri.hrmonitor;

import android.content.Context;
import android.os.PowerManager;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * PARTIAL_WAKE_LOCK around the foreground-service lifetime. The capawesome
 * FGS plugin declares the WAKE_LOCK permission but never acquires one, so
 * Android Doze still throttles CPU after ~5 minutes of screen-off even
 * with a valid foreground service running. This plugin lets the JS shim
 * acquire the wake lock when the FGS starts and release it when it stops.
 *
 * Non-reference-counted: one acquire pairs with one release no matter how
 * many times acquire() is called. Simpler lifecycle, no leak risk.
 */
@CapacitorPlugin(name = "WakeLock")
public class WakeLockPlugin extends Plugin {
    private static final String LOCK_TAG = "HRMonitor:FGS";
    // Static so the lock survives plugin reloads (renderer crash recovery,
    // route changes that re-instantiate the plugin). If the field were
    // per-instance, a reload mid-session would orphan the held lock and the
    // garbage-collected plugin would never release it — battery drain until
    // process death.
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

    // Static release so other plugins (e.g. NativeHrSessionPlugin during
    // forced cleanup) or the Activity destroy hook can drop the lock without
    // needing a plugin instance handle.
    public static void releaseStatic() {
        if (wakeLock != null && wakeLock.isHeld()) {
            try { wakeLock.release(); } catch (Exception ignored) {}
        }
        wakeLock = null;
    }

    @Override
    protected void handleOnDestroy() {
        // Activity is going down. If a wake lock is still held (caller forgot
        // to release, or the WebView crashed after acquire but before
        // release), drop it now so we don't keep the CPU on after teardown.
        releaseStatic();
        super.handleOnDestroy();
    }
}
