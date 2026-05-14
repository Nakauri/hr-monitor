package com.nakauri.hrmonitor;

import android.content.ComponentCallbacks2;
import android.content.res.ColorStateList;
import android.graphics.Color;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.WebView;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.TextView;

import com.getcapacitor.BridgeActivity;
import com.getcapacitor.BridgeWebViewClient;

/**
 * Overrides the Capacitor-generated stub to register our custom plugins
 * before the bridge initialises. `registerPlugin` MUST be called before
 * super.onCreate, otherwise Capacitor doesn't pick the plugin up and
 * `Capacitor.Plugins.<Name>` is undefined on the JS side.
 *
 * The generated MainActivity at mobile/android/app/src/main/java/com/
 * nakauri/hrmonitor/MainActivity.java is overwritten by this file during
 * the CI overlay step (cp -rv mobile/android-overlay/. mobile/android/).
 */
public class MainActivity extends BridgeActivity {
    private static final String TAG = "MainActivity";

    // Native loading overlay. Branded splash + spinner painted ON TOP of
    // the WebView whenever the Activity comes to the foreground while a
    // session is active. JS calls RestoreOverlayPlugin.hide() once the
    // page has rehydrated. 60-second safety timer dismisses if JS never
    // fires.
    private View restoreOverlay;
    private Runnable restoreSafetyTimer;
    // Cold-launch safety timer. Cold WebView startup on the S8 (Android 9)
    // can take 8-15 s before the page is interactive, between Chromium init,
    // CDN-loaded Chart.js, Google Fonts, and the 278 KB HTML parse. Long
    // window so the user sees the branded splash for the duration instead
    // of a blank WebView; JS dismisses earlier via RestoreOverlayPlugin.hide
    // once the bootstrap settles.
    private static final long OVERLAY_SAFETY_MS = 25000L;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(WakeLockPlugin.class);
        registerPlugin(OemBackgroundPlugin.class);
        registerPlugin(NativeRelaySocketPlugin.class);
        registerPlugin(NativeHrSessionPlugin.class);
        registerPlugin(RestoreOverlayPlugin.class);
        super.onCreate(savedInstanceState);

        showRestoreOverlay();

        // Renderer-recovery WebViewClient. Long sessions can OOM Chromium's
        // renderer; reloading the page in place beats Activity teardown.
        try {
            if (bridge != null && bridge.getWebView() != null) {
                WebView wv = bridge.getWebView();
                wv.setWebViewClient(new HrMonitorWebViewClient(bridge));
                // Dark default behind the page so the gap between the splash
                // dismissing and the page's first paint isn't a white flash.
                wv.setBackgroundColor(0xFF0A0A0A);
            }
        } catch (Throwable t) {
            Log.w(TAG, "Could not install renderer-recovery WebViewClient: " + t.getMessage());
        }

        // Periodic orphan-recovery worker. Catches CSVs that never got
        // uploaded because the previous session ended uncleanly. KEEP
        // policy ensures we don't reset the schedule on every Activity start.
        try {
            OrphanRecoveryWorker.schedule(this);
        } catch (Throwable t) {
            Log.w(TAG, "OrphanRecoveryWorker.schedule failed: " + t.getMessage());
        }

        // Redundant session-resurrection job. Independent of the AlarmManager
        // heartbeat so a single OEM throttle path can't take down both
        // resurrection routes at once.
        try {
            SessionResurrectionWorker.schedule(this);
        } catch (Throwable t) {
            Log.w(TAG, "SessionResurrectionWorker.schedule failed: " + t.getMessage());
        }

        // Back navigation. Use OnBackPressedDispatcher so Android 14+
        // predictive-back gestures route through us; the legacy onBackPressed()
        // override is bypassed by the new gesture API.
        getOnBackPressedDispatcher().addCallback(this, new androidx.activity.OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                try {
                    if (bridge != null && bridge.getWebView() != null && bridge.getWebView().canGoBack()) {
                        bridge.getWebView().goBack();
                        return;
                    }
                } catch (Throwable ignored) {}
                moveTaskToBack(true);
            }
        });
    }

    private static class HrMonitorWebViewClient extends BridgeWebViewClient {
        HrMonitorWebViewClient(com.getcapacitor.Bridge bridge) { super(bridge); }

        @Override
        public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
            // Returning true tells Android we've handled the renderer death
            // ourselves; without this the entire Activity (and process)
            // gets terminated. Return false would propagate the crash.
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
                return super.onRenderProcessGone(view, detail);
            }
            boolean didCrash = detail != null && detail.didCrash();
            Log.w(TAG, "Renderer gone (didCrash=" + didCrash + "), reloading WebView");
            try {
                String url = view.getUrl();
                if (url == null || url.isEmpty()) url = "https://localhost/";
                view.loadUrl(url);
            } catch (Throwable t) {
                Log.w(TAG, "Reload after renderer-gone failed: " + t.getMessage());
            }
            return true;
        }
    }

    // Override Capacitor's bridge.onPause() suspension of the WebView JS
    // engine so the BLE → tick → relay pipeline keeps flowing while
    // backgrounded. Costs WebView battery; required for 24/7 streaming.
    @Override
    public void onPause() {
        super.onPause();
        try {
            if (this.bridge != null && this.bridge.getWebView() != null) {
                this.bridge.getWebView().onResume();
            }
        } catch (Throwable t) {
            // Fail open if Capacitor's Bridge API shifts.
        }
    }

    // Re-show the loading overlay every time the Activity comes back to
    // foreground while a session is active. WebView rehydrate of a 12-hour
    // CSV on the S8 takes ~20-30 sec; without this the user stares at a
    // frozen WebView during that window. JS calls hide() once rehydrate
    // completes (or immediately on visibilitychange-visible if hidden was
    // brief enough to skip rehydrate).
    @Override
    public void onResume() {
        super.onResume();
        try {
            android.content.SharedPreferences prefs = getSharedPreferences("hr_monitor_session", 0);
            boolean active = prefs.getBoolean("sessionActive", false);
            boolean cleanly = prefs.getBoolean("cleanlyStopped", true);
            if (active && !cleanly) showRestoreOverlay();
        } catch (Throwable t) {
            Log.w(TAG, "onResume overlay check failed: " + t.getMessage());
        }
    }

    /** Proactive memory release before LMK fires. At RUNNING_CRITICAL the
     *  system is about to start killing background processes; freeing the
     *  WebView's GPU buffers (Chart.js canvases ~320 MB) drops our PSS
     *  enough to stay below the cutoff. JS handles the actual destroy. */
    @Override
    public void onTrimMemory(int level) {
        super.onTrimMemory(level);
        if (level >= ComponentCallbacks2.TRIM_MEMORY_RUNNING_CRITICAL) {
            try {
                NativeHrSessionPlugin p = NativeHrSessionPlugin.instance;
                if (p != null) p.notifyTrimMemory(level);
            } catch (Throwable t) {
                Log.w(TAG, "onTrimMemory dispatch failed: " + t.getMessage());
            }
        }
    }

    /** Build the restore-session overlay programmatically. Hardcoded colours
     *  (no theme references) so One UI / Material You skin differences don't
     *  change anything across S8 / S24 / etc. */
    private View createRestoreOverlay() {
        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(Color.parseColor("#0a0a0a"));
        // Block touch events so taps don't reach the WebView underneath
        // while the overlay is visible.
        root.setClickable(true);
        root.setFocusable(true);

        LinearLayout column = new LinearLayout(this);
        column.setOrientation(LinearLayout.VERTICAL);
        column.setGravity(Gravity.CENTER);

        // Aorti glyph above the spinner — gives the launch frame a Discord-style
        // branded loading state on every Android version, not just API 31+ where
        // the SplashScreen API renders the icon.
        ImageView logo = new ImageView(this);
        try {
            int logoRes = getResources().getIdentifier("aorti_foreground", "drawable", getPackageName());
            if (logoRes != 0) logo.setImageResource(logoRes);
        } catch (Throwable ignored) {}
        int logoSize = dp(160);
        LinearLayout.LayoutParams logoLp = new LinearLayout.LayoutParams(logoSize, logoSize);
        logoLp.bottomMargin = dp(12);
        logo.setLayoutParams(logoLp);

        ProgressBar spinner = new ProgressBar(this);
        spinner.setIndeterminate(true);
        // Tint the spinner to the app's accent green. setIndeterminateTintList
        // is API 21+ — both target devices (API 28, 34) are well above it.
        try {
            spinner.setIndeterminateTintList(ColorStateList.valueOf(Color.parseColor("#5DCAA5")));
        } catch (Throwable ignored) {}
        int spinnerSize = dp(48);
        LinearLayout.LayoutParams spinnerLp = new LinearLayout.LayoutParams(spinnerSize, spinnerSize);
        spinnerLp.bottomMargin = dp(18);
        spinner.setLayoutParams(spinnerLp);

        TextView label = new TextView(this);
        label.setText("Restoring session\u2026");
        label.setTextColor(Color.parseColor("#d8d8d8"));
        label.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14);
        label.setGravity(Gravity.CENTER);

        column.addView(logo);
        column.addView(spinner);
        column.addView(label);

        FrameLayout.LayoutParams columnLp = new FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        columnLp.gravity = Gravity.CENTER;
        root.addView(column, columnLp);

        return root;
    }

    private int dp(int value) {
        float density = getResources().getDisplayMetrics().density;
        return (int) (value * density + 0.5f);
    }

    // Idempotent. No-ops when the overlay is already attached. Always
    // re-arms the safety timer so a stale onResume can't strand the user.
    public void showRestoreOverlay() {
        runOnUiThread(() -> {
            try {
                if (restoreOverlay != null && restoreOverlay.getParent() != null) {
                    armRestoreSafetyTimer();
                    return;
                }
                restoreOverlay = createRestoreOverlay();
                addContentView(restoreOverlay, new FrameLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.MATCH_PARENT));
                armRestoreSafetyTimer();
            } catch (Throwable t) {
                Log.w(TAG, "showRestoreOverlay failed: " + t.getMessage());
            }
        });
    }

    private void armRestoreSafetyTimer() {
        Handler h = new Handler(Looper.getMainLooper());
        if (restoreSafetyTimer != null) h.removeCallbacks(restoreSafetyTimer);
        restoreSafetyTimer = this::hideRestoreOverlayBySafetyTimer;
        h.postDelayed(restoreSafetyTimer, OVERLAY_SAFETY_MS);
    }

    /** Idempotent. Called by RestoreOverlayPlugin.hide() from JS, by the
     *  safety timer, or by future native paths if needed. */
    public void hideRestoreOverlay() {
        runOnUiThread(() -> {
            try {
                if (restoreOverlay != null && restoreOverlay.getParent() instanceof ViewGroup) {
                    ((ViewGroup) restoreOverlay.getParent()).removeView(restoreOverlay);
                }
            } catch (Throwable ignored) {}
            restoreOverlay = null;
            if (restoreSafetyTimer != null) {
                new Handler(Looper.getMainLooper()).removeCallbacks(restoreSafetyTimer);
                restoreSafetyTimer = null;
            }
        });
    }

    /** Safety-timer dismissal. Logs a diagnostic so logcat can distinguish
     *  "JS hide() never came" from a normal dismissal. */
    private void hideRestoreOverlayBySafetyTimer() {
        if (restoreOverlay != null) {
            Log.w(TAG, "Restore overlay auto-hidden by 60 s safety timer (JS hide() not received)");
        }
        hideRestoreOverlay();
    }

}
