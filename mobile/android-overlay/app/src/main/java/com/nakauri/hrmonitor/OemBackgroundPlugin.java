package com.nakauri.hrmonitor;

import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * OEM-specific background-allow-list deep-links. Samsung, Xiaomi, Huawei etc.
 * each layer their own battery killer on top of stock Android's Doze; each
 * has a different settings screen where the user adds an app to a "never
 * sleeping" / "protected" / "auto-start" list. This plugin routes to the
 * right one for the current device's manufacturer.
 *
 * When the vendor-specific intent isn't available (or we don't have a mapping
 * yet), falls back to ACTION_APPLICATION_DETAILS_SETTINGS — the generic
 * per-app Settings page where battery / background options are reachable
 * with two more taps.
 *
 * Source of per-OEM intents: https://dontkillmyapp.com
 */
@CapacitorPlugin(name = "OemBackground")
public class OemBackgroundPlugin extends Plugin {

    @PluginMethod
    public void getManufacturer(PluginCall call) {
        String mfr = (Build.MANUFACTURER == null ? "" : Build.MANUFACTURER).toLowerCase();
        String brand = (Build.BRAND == null ? "" : Build.BRAND).toLowerCase();
        String vendor = detectVendor(mfr, brand);
        JSObject ret = new JSObject();
        ret.put("manufacturer", Build.MANUFACTURER == null ? "" : Build.MANUFACTURER);
        ret.put("brand", Build.BRAND == null ? "" : Build.BRAND);
        ret.put("vendor", vendor);
        ret.put("hasKnownBackgroundKiller", !"other".equals(vendor));
        call.resolve(ret);
    }

    @PluginMethod
    public void openBackgroundSettings(PluginCall call) {
        String mfr = (Build.MANUFACTURER == null ? "" : Build.MANUFACTURER).toLowerCase();
        String brand = (Build.BRAND == null ? "" : Build.BRAND).toLowerCase();
        String vendor = detectVendor(mfr, brand);
        boolean opened = false;
        String path = "none";

        if ("samsung".equals(vendor)) {
            // Samsung Device care -> Battery -> Never sleeping apps.
            // activity_type: 0=sleeping, 1=deep sleeping, 2=never sleeping.
            Intent intent = new Intent();
            intent.setClassName(
                "com.samsung.android.lool",
                "com.samsung.android.sm.ui.battery.BatteryActivity"
            );
            intent.setAction("com.samsung.android.sm.ACTION_OPEN_CHECKABLE_LISTACTIVITY");
            intent.putExtra("activity_type", 2);
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            opened = tryStart(intent);
            path = opened ? "samsung:never_sleeping" : "samsung:fallback";
        } else if ("xiaomi".equals(vendor)) {
            Intent intent = new Intent();
            intent.setClassName(
                "com.miui.securitycenter",
                "com.miui.permcenter.autostart.AutoStartManagementActivity"
            );
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            opened = tryStart(intent);
            path = opened ? "xiaomi:autostart" : "xiaomi:fallback";
        } else if ("huawei".equals(vendor) || "honor".equals(vendor)) {
            Intent intent = new Intent();
            intent.setClassName(
                "com.huawei.systemmanager",
                "com.huawei.systemmanager.startupmgr.ui.StartupNormalAppListActivity"
            );
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            opened = tryStart(intent);
            path = opened ? "huawei:startup" : "huawei:fallback";
        } else if ("oppo".equals(vendor) || "realme".equals(vendor)) {
            Intent intent = new Intent();
            intent.setClassName(
                "com.coloros.safecenter",
                "com.coloros.safecenter.permission.startup.StartupAppListActivity"
            );
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            opened = tryStart(intent);
            path = opened ? "oppo:startup" : "oppo:fallback";
        } else if ("vivo".equals(vendor)) {
            Intent intent = new Intent();
            intent.setClassName(
                "com.iqoo.secure",
                "com.iqoo.secure.ui.phoneoptimize.BgStartUpManager"
            );
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            opened = tryStart(intent);
            path = opened ? "vivo:bgstart" : "vivo:fallback";
        }

        if (!opened) {
            // Fallback: the app's own Settings page. User is two taps away
            // from whatever the OEM buried there.
            Intent fallback = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS);
            fallback.setData(Uri.parse("package:" + getContext().getPackageName()));
            fallback.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            opened = tryStart(fallback);
            path = opened ? (path + "+generic") : "failed";
        }

        JSObject ret = new JSObject();
        ret.put("opened", opened);
        ret.put("vendor", vendor);
        ret.put("path", path);
        call.resolve(ret);
    }

    private String detectVendor(String mfr, String brand) {
        if (mfr.contains("samsung") || brand.contains("samsung")) return "samsung";
        if (mfr.contains("xiaomi") || brand.contains("xiaomi") || brand.contains("redmi") || brand.contains("poco")) return "xiaomi";
        if (mfr.contains("huawei") || brand.contains("huawei")) return "huawei";
        if (mfr.contains("honor") || brand.contains("honor")) return "honor";
        if (mfr.contains("oppo") || brand.contains("oppo")) return "oppo";
        if (mfr.contains("realme") || brand.contains("realme")) return "realme";
        if (mfr.contains("vivo") || brand.contains("vivo") || brand.contains("iqoo")) return "vivo";
        if (mfr.contains("oneplus") || brand.contains("oneplus")) return "oneplus";
        return "other";
    }

    private boolean tryStart(Intent intent) {
        try {
            getContext().startActivity(intent);
            return true;
        } catch (ActivityNotFoundException | SecurityException e) {
            return false;
        } catch (Exception e) {
            return false;
        }
    }
}
