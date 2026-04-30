package com.nakauri.hrmonitor;

import android.app.Activity;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Native restore-session overlay control. The overlay itself is built and
 * added in MainActivity.onCreate (via addContentView). This plugin exposes
 * a single hide() method to JS so the page can dismiss it once the chart
 * is populated. Idempotent — multiple hides are fine.
 *
 * Safety net: MainActivity also schedules an automatic hide after 30 s,
 * so if this plugin is ever missing or the JS path fails, the overlay
 * goes away regardless.
 */
@CapacitorPlugin(name = "RestoreOverlay")
public class RestoreOverlayPlugin extends Plugin {
    @PluginMethod
    public void hide(PluginCall call) {
        Activity activity = getActivity();
        if (activity instanceof MainActivity) {
            ((MainActivity) activity).hideRestoreOverlay();
        }
        call.resolve();
    }
}
