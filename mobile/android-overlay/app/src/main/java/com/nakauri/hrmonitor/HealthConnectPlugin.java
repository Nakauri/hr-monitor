package com.nakauri.hrmonitor;

import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.SystemClock;
import android.util.Log;

import androidx.activity.result.ActivityResult;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/** Health Connect reads for the viewer (S65a): status, request, read, openSettings. No client import here (HcClient). */
@CapacitorPlugin(name = "HealthConnect")
public class HealthConnectPlugin extends Plugin {
    private static final String TAG = "HealthConnect";
    private static final HcAwait.Slots SLOTS = new HcAwait.Slots(SystemClock::elapsedRealtime);
    private final ExecutorService exec = Executors.newSingleThreadExecutor(r -> new Thread(r, "hrm-hc"));
    private volatile List<String> grantedBefore = new ArrayList<>();

    private static boolean supported() { return Build.VERSION.SDK_INT >= 28; }

    private String state() {
        if (!supported()) return HcMap.sdkState(0, false, Build.VERSION.SDK_INT);
        int s = HcClient.sdkStatus(getContext());
        return HcMap.sdkState(s, s != 2 || HcClient.installed(getContext()), Build.VERSION.SDK_INT);
    }

    private static JSArray arr(List<String> s) {
        JSArray a = new JSArray();
        for (String p : s) a.put(p);
        return a;
    }

    private static String code(Throwable t) {
        String m = String.valueOf(t.getMessage());
        if (m.contains("hc_timeout")) return "hc_timeout";
        if (m.contains("hc_busy")) return "hc_busy";
        if (m.toLowerCase().contains("foreground")) return "background";
        return t.getClass().getSimpleName();
    }

    @PluginMethod
    public void status(PluginCall call) {
        exec.execute(() -> {
            try {
                String st = state();
                JSObject o = new JSObject();
                o.put("sdk", st);
                o.put("granted", "available".equals(st) ? arr(HcMap.kinds(HcClient.granted(getContext()))) : new JSArray());
                call.resolve(o);
            } catch (Throwable t) {
                Log.w(TAG, "hc_status_fail code=" + code(t));
                call.reject("hc_status_fail", code(t));
            }
        });
    }

    @PluginMethod
    public void request(PluginCall call) {
        exec.execute(() -> {
            try {
                if (!"available".equals(state())) { call.reject("hc_unavailable"); return; }
                grantedBefore = HcMap.kinds(HcClient.granted(getContext()));
                Set<String> perms = new HashSet<>();
                JSArray kinds = call.getArray("kinds", new JSArray());
                for (int i = 0; i < kinds.length(); i++) {
                    String p = HcMap.permission(kinds.optString(i));
                    if (p != null) perms.add(p);
                }
                if (perms.isEmpty()) { call.reject("hc_no_kinds"); return; }
                Intent i = HcClient.permissionIntent(getContext(), perms);
                getBridge().executeOnMainThread(() -> {
                    try {
                        startActivityForResult(call, i, "onPermissionResult");
                    } catch (Throwable t) {
                        call.reject("hc_request_fail", code(t));
                    }
                });
            } catch (Throwable t) {
                call.reject("hc_request_fail", code(t));
            }
        });
    }

    @ActivityCallback
    private void onPermissionResult(PluginCall call, ActivityResult result) {
        if (call == null) return;
        exec.execute(() -> {
            try {
                List<String> after = HcMap.kinds(HcClient.granted(getContext()));
                JSObject o = new JSObject();
                o.put("granted", arr(after));
                o.put("changed", !HcMap.sameSet(grantedBefore, after));
                call.resolve(o);
            } catch (Throwable t) {
                call.reject("hc_request_fail", code(t));
            }
        });
    }

    @PluginMethod
    public void read(PluginCall call) {
        exec.execute(() -> {
            String kind = call.getString("kind", "");
            if (!"sleep".equals(kind)) { call.reject("hc_kind"); return; }
            if (!supported()) { call.reject("hc_unavailable"); return; }
            Double fromD = call.getDouble("from"), toD = call.getDouble("to");
            if (fromD == null || toD == null || toD < fromD) { call.reject("hc_range"); return; }
            HcAwait.Lease lease = SLOTS.take(kind);
            if (lease == null) { call.reject("hc_busy"); return; }
            try {
                HcMap.Rows r = HcClient.readSleep(getContext(), fromD.longValue(), toD.longValue(), lease);
                JSArray rows = new JSArray();
                for (Map<String, Object> m : r.rows) {
                    JSObject o = new JSObject();
                    o.put("id", m.get("id"));
                    o.put("origin", m.get("origin"));
                    o.put("s", m.get("s"));
                    o.put("e", m.get("e"));
                    JSArray aw = new JSArray();
                    @SuppressWarnings("unchecked") List<long[]> awake = (List<long[]>) m.get("awake");
                    for (long[] x : awake) { JSArray p = new JSArray(); p.put(x[0]); p.put(x[1]); aw.put(p); }
                    o.put("awake", aw);
                    rows.put(o);
                }
                JSObject out = new JSObject();
                out.put("rows", rows);
                out.put("more", r.more);
                Log.i(TAG, "hc_read kind=sleep rows=" + r.rows.size() + " more=" + r.more);
                call.resolve(out);
            } catch (Throwable t) {
                Log.w(TAG, "hc_read_fail kind=sleep code=" + code(t));
                call.reject("hc_read_fail", code(t));
            } finally {
                lease.close();
            }
        });
    }

    @PluginMethod
    public void openSettings(PluginCall call) {
        exec.execute(() -> {
            try {
                String st = state();
                Intent i = "available".equals(st)
                    ? new Intent(HcClient.SETTINGS_ACTION)
                    : new Intent(Intent.ACTION_VIEW, Uri.parse("market://details?id=" + HcMap.PROVIDER));
                i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                try {
                    getContext().startActivity(i);
                } catch (ActivityNotFoundException e) {
                    Intent web = new Intent(Intent.ACTION_VIEW, Uri.parse("https://play.google.com/store/apps/details?id=" + HcMap.PROVIDER));
                    web.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                    getContext().startActivity(web);
                }
                call.resolve(new JSObject());
            } catch (Throwable t) {
                call.reject("hc_settings_fail", code(t));
            }
        });
    }
}
