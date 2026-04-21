package com.nakauri.hrmonitor;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

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
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(WakeLockPlugin.class);
        registerPlugin(OemBackgroundPlugin.class);
        registerPlugin(NativeRelaySocketPlugin.class);
        registerPlugin(NativeHrSessionPlugin.class);
        super.onCreate(savedInstanceState);
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
            // Defensive: if Capacitor changes Bridge API in the future and
            // breaks this override, fail open — Activity pause still
            // succeeded above, we just lose the keep-alive optimization.
        }
    }
}
