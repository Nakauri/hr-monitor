package com.nakauri.hrmonitor;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;

/** Health Connect's privacy-policy link target. Reads no extras or data; opens the policy and finishes. */
public class HealthRationaleActivity extends Activity {
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse("https://aorti.ca/legal.html#health-connect")));
        } catch (ActivityNotFoundException e) {
            android.util.Log.w("HealthConnect", "hc_rationale no_browser");
        } finally {
            finish();
        }
    }
}
