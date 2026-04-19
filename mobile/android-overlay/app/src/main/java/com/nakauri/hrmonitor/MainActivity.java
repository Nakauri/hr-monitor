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
        super.onCreate(savedInstanceState);
    }
}
