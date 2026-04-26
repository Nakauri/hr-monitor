package com.nakauri.hrmonitor;

import android.os.Build;
import android.os.Bundle;
import android.util.Log;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.WebView;

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

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(WakeLockPlugin.class);
        registerPlugin(OemBackgroundPlugin.class);
        registerPlugin(NativeRelaySocketPlugin.class);
        registerPlugin(NativeHrSessionPlugin.class);
        super.onCreate(savedInstanceState);

        // Wrap Capacitor's WebViewClient with one that handles renderer
        // crashes by reloading the page in place instead of letting Android
        // tear down the Activity. Long sessions can blow Chromium's
        // renderer memory budget; without this override an OOM kills the
        // entire app + foreground service. The native plugin keeps writing
        // CSV throughout, so on reload the rehydrate path picks up where
        // the chart left off.
        try {
            if (bridge != null && bridge.getWebView() != null) {
                bridge.getWebView().setWebViewClient(new HrMonitorWebViewClient(bridge));
            }
        } catch (Throwable t) {
            Log.w(TAG, "Could not install renderer-recovery WebViewClient: " + t.getMessage());
        }
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

    // Hardware back press: navigate WebView history if possible; otherwise
    // background the Activity instead of finishing it. finish() destroys the
    // bridge + JS context, killing the active session UI.
    @Override
    public void onBackPressed() {
        try {
            if (bridge != null && bridge.getWebView() != null && bridge.getWebView().canGoBack()) {
                bridge.getWebView().goBack();
                return;
            }
        } catch (Throwable ignored) {}
        moveTaskToBack(true);
    }
}
