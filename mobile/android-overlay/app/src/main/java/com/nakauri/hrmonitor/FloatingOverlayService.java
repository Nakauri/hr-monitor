package com.nakauri.hrmonitor;

import android.annotation.SuppressLint;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.graphics.Color;
import android.graphics.PixelFormat;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.util.Log;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.View;
import android.view.WindowManager;
import android.webkit.WebView;
import android.webkit.WebViewClient;

// Pulsoid-style floating BPM overlay. SYSTEM_ALERT_WINDOW + WindowManager
// hosts a WebView that loads file:///android_asset/floating_widget.html.
// Three display modes (compact / card / chart) are CSS-class toggles inside
// the page; HR + RMSSD data is injected from native via evaluateJavascript.
// Going through HTML/CSS lets the floating widget mirror the desktop
// widget's look without re-implementing the styling in native View code.
public class FloatingOverlayService extends Service {
    private static final String TAG = "FloatingOverlay";
    private static final String PREFS_MODE_KEY = "floating_overlay_mode";
    private static final String ASSET_URL = "file:///android_asset/floating_widget.html";

    private WindowManager windowManager;
    private WebView webView;
    private WindowManager.LayoutParams params;
    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private String mode = "compact"; // "compact" | "card" | "chart"
    private volatile boolean pageReady = false;
    private int pendingBpm = 0;
    private double pendingRmssd = 0.0;

    public interface HrUpdateListener {
        void onHrUpdate(int bpm, double rmssd);
    }

    @Override
    public IBinder onBind(Intent intent) { return null; }

    @Override
    @SuppressLint("SetJavaScriptEnabled")
    public void onCreate() {
        super.onCreate();
        windowManager = (WindowManager) getSystemService(Context.WINDOW_SERVICE);
        try {
            mode = getSharedPreferences("hr_monitor_session", 0).getString(PREFS_MODE_KEY, "compact");
        } catch (Throwable ignored) {}
        buildWebView();
        attachToWindow();
        NativeHrSessionPlugin.floatingOverlayListener = (bpm, rmssd) -> {
            pendingBpm = bpm;
            pendingRmssd = rmssd;
            mainHandler.post(this::pushHrToPage);
        };
        Log.i(TAG, "Overlay attached (mode=" + mode + ").");
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        return START_NOT_STICKY;
    }

    @Override
    public void onDestroy() {
        NativeHrSessionPlugin.floatingOverlayListener = null;
        if (webView != null && windowManager != null) {
            try { windowManager.removeView(webView); } catch (Throwable ignored) {}
            try { webView.destroy(); } catch (Throwable ignored) {}
        }
        webView = null;
        Log.i(TAG, "Overlay detached.");
        super.onDestroy();
    }

    @SuppressLint({"SetJavaScriptEnabled", "ClickableViewAccessibility"})
    private void buildWebView() {
        webView = new WebView(this);
        webView.setBackgroundColor(Color.TRANSPARENT);
        webView.getSettings().setJavaScriptEnabled(true);
        webView.getSettings().setDomStorageEnabled(false);
        webView.setVerticalScrollBarEnabled(false);
        webView.setHorizontalScrollBarEnabled(false);
        webView.setWebViewClient(new WebViewClient() {
            @Override
            public void onPageFinished(WebView view, String url) {
                pageReady = true;
                applyMode();
                // Push whatever HR sample we've buffered so the user doesn't
                // wait up to a full tick interval to see a number after the
                // WebView finishes loading.
                pushHrToPage();
            }
        });
        webView.loadUrl(ASSET_URL);
        // Touch on the overlay:
        //   short small-movement tap → cycle display mode
        //   long-press (700 ms+) → close the overlay
        //   drag → reposition (params.x/y follow the finger)
        // No visible close button — long-press is symmetric with the
        // long-press-the-widget gesture that opens this in the first place.
        webView.setOnTouchListener(new View.OnTouchListener() {
            private int initialX, initialY;
            private float touchX, touchY;
            private long touchStart;
            private Runnable longPressRunnable;
            private boolean longPressed;
            private boolean moved;
            private static final int TAP_MOVE_THRESHOLD_DP = 8;
            private static final long TAP_MAX_DURATION_MS = 250;
            private static final long LONG_PRESS_MS = 700;
            @Override
            public boolean onTouch(View v, MotionEvent event) {
                switch (event.getAction()) {
                    case MotionEvent.ACTION_DOWN:
                        initialX = params.x;
                        initialY = params.y;
                        touchX = event.getRawX();
                        touchY = event.getRawY();
                        touchStart = System.currentTimeMillis();
                        longPressed = false;
                        moved = false;
                        longPressRunnable = () -> {
                            if (!moved) {
                                longPressed = true;
                                stopSelf();
                            }
                        };
                        mainHandler.postDelayed(longPressRunnable, LONG_PRESS_MS);
                        return true;
                    case MotionEvent.ACTION_MOVE: {
                        float mdx = event.getRawX() - touchX;
                        float mdy = event.getRawY() - touchY;
                        int thresholdPx = dp(TAP_MOVE_THRESHOLD_DP);
                        if (Math.abs(mdx) >= thresholdPx || Math.abs(mdy) >= thresholdPx) moved = true;
                        if (moved && longPressRunnable != null) {
                            mainHandler.removeCallbacks(longPressRunnable);
                            longPressRunnable = null;
                        }
                        params.x = initialX + (int) mdx;
                        params.y = initialY + (int) mdy;
                        try { windowManager.updateViewLayout(webView, params); } catch (Throwable ignored) {}
                        return true;
                    }
                    case MotionEvent.ACTION_UP:
                    case MotionEvent.ACTION_CANCEL:
                        if (longPressRunnable != null) {
                            mainHandler.removeCallbacks(longPressRunnable);
                            longPressRunnable = null;
                        }
                        if (longPressed) return true;
                        long elapsed = System.currentTimeMillis() - touchStart;
                        if (!moved && elapsed < TAP_MAX_DURATION_MS) toggleMode();
                        return true;
                }
                return false;
            }
        });
    }

    private void pushHrToPage() {
        if (!pageReady || webView == null) return;
        final int bpm = pendingBpm;
        final double rmssd = pendingRmssd;
        try {
            webView.evaluateJavascript(
                "window.updateHr && window.updateHr(" + bpm + ", " + rmssd + ");", null);
        } catch (Throwable ignored) {}
    }

    private void toggleMode() {
        if ("compact".equals(mode)) mode = "card";
        else if ("card".equals(mode)) mode = "chart";
        else mode = "compact";
        try {
            getSharedPreferences("hr_monitor_session", 0).edit()
                .putString(PREFS_MODE_KEY, mode).apply();
        } catch (Throwable ignored) {}
        applyMode();
    }

    private void applyMode() {
        if (!pageReady || webView == null) return;
        final String m = mode;
        try {
            webView.evaluateJavascript("window.setMode && window.setMode('" + m + "');", null);
        } catch (Throwable ignored) {}
    }

    private void attachToWindow() {
        int type = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
            ? WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
            : WindowManager.LayoutParams.TYPE_PHONE;
        params = new WindowManager.LayoutParams(
            // WRAP_CONTENT lets the widget render to its CSS-determined size.
            // The HTML's max-width and inline-grid keep the pill compact.
            WindowManager.LayoutParams.WRAP_CONTENT,
            WindowManager.LayoutParams.WRAP_CONTENT,
            type,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE
                | WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL
                | WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,
            PixelFormat.TRANSLUCENT);
        // TOP|START so drag math is intuitive: dx > 0 → window right,
        // dx < 0 → window left. Gravity.END inverts the x axis and broke
        // leftward dragging in the previous build.
        params.gravity = Gravity.TOP | Gravity.START;
        int screenWidth = getResources().getDisplayMetrics().widthPixels;
        params.x = Math.max(0, screenWidth - dp(260));
        params.y = dp(100);
        try {
            windowManager.addView(webView, params);
        } catch (Throwable t) {
            Log.w(TAG, "addView failed: " + t.getMessage());
            stopSelf();
        }
    }

    private int dp(int v) {
        return (int) (v * getResources().getDisplayMetrics().density + 0.5f);
    }
}
