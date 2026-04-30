package com.nakauri.hrmonitor;

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

    // Native restore-session overlay. Painted instantly when the Activity
    // surface is created (via addContentView), covering the WebView while
    // it rebuilds after recents-tap or renderer crash. Hidden by JS via
    // RestoreOverlayPlugin once the chart has data, or auto-removed by
    // the safety timer below if JS never fires.
    private View restoreOverlay;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(WakeLockPlugin.class);
        registerPlugin(OemBackgroundPlugin.class);
        registerPlugin(NativeRelaySocketPlugin.class);
        registerPlugin(NativeHrSessionPlugin.class);
        registerPlugin(RestoreOverlayPlugin.class);
        super.onCreate(savedInstanceState);

        try {
            restoreOverlay = createRestoreOverlay();
            addContentView(restoreOverlay, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT));
            // Safety net: if JS never calls RestoreOverlay.hide() (auth fail,
            // page parse error, plugin missing), the overlay self-destructs
            // after 30 s so the user is never stuck staring at a spinner.
            new Handler(Looper.getMainLooper()).postDelayed(this::hideRestoreOverlay, 30000);
        } catch (Throwable t) {
            Log.w(TAG, "Could not install restore overlay: " + t.getMessage());
        }

        // Renderer-recovery WebViewClient. Long sessions can OOM Chromium's
        // renderer; reloading the page in place beats Activity teardown.
        try {
            if (bridge != null && bridge.getWebView() != null) {
                bridge.getWebView().setWebViewClient(new HrMonitorWebViewClient(bridge));
            }
        } catch (Throwable t) {
            Log.w(TAG, "Could not install renderer-recovery WebViewClient: " + t.getMessage());
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

    /**
     * Capacitor's BridgeActivity.onPause calls bridge.onPause() which
     * suspends the WebView's JavaScript engine when the Activity goes to
     * background. For our use case that kills the BLE → tick → relay
     * pipeline because the JS callbacks stop firing — the FGS notification
     * stays up and wake lock stays held, but no data flows.
     *
     * Re-call webView.onResume() right after super.onPause() so JS keeps
     * running while backgrounded. The wake lock + FGS keep CPU + process
     * alive; this keeps JS scheduled. Trade-off: the WebView consumes more
     * battery while the screen is off, but for a 24/7 streaming app
     * that's the point.
     */
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

    /** Idempotent. Called by RestoreOverlayPlugin.hide() from JS, by the 30 s
     *  safety timer in onCreate, or by future native paths if needed. */
    public void hideRestoreOverlay() {
        runOnUiThread(() -> {
            try {
                if (restoreOverlay != null && restoreOverlay.getParent() instanceof ViewGroup) {
                    ((ViewGroup) restoreOverlay.getParent()).removeView(restoreOverlay);
                }
            } catch (Throwable ignored) {}
            restoreOverlay = null;
        });
    }

}
