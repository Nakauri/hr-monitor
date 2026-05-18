package com.nakauri.hrmonitor;

import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.graphics.PixelFormat;
import android.graphics.drawable.GradientDrawable;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.util.Log;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.View;
import android.view.WindowManager;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.TextView;

// Pulsoid-style floating BPM overlay. SYSTEM_ALERT_WINDOW + WindowManager
// to render a small draggable pill on top of any app. Subscribes to HR ticks
// from NativeHrSessionPlugin via a singleton listener slot. Two display modes
// toggled by tapping the pill (anywhere except the close X):
//   compact: logo + BPM
//   card:    logo + BPM + RMSSD
public class FloatingOverlayService extends Service {
    private static final String TAG = "FloatingOverlay";
    private static final String PREFS_MODE_KEY = "floating_overlay_mode";

    private WindowManager windowManager;
    private View overlayView;
    private TextView bpmText;
    private TextView rmssdText;
    private TextView rmssdLabel;
    private WindowManager.LayoutParams params;
    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private String mode = "compact"; // "compact" | "card"

    // Plugin's handleHrReading calls this on every HR tick. Both fields are
    // best-effort: bpm is 0 if no parse, rmssd is 0 if no RR window yet.
    public interface HrUpdateListener {
        void onHrUpdate(int bpm, double rmssd);
    }

    @Override
    public IBinder onBind(Intent intent) { return null; }

    @Override
    public void onCreate() {
        super.onCreate();
        windowManager = (WindowManager) getSystemService(Context.WINDOW_SERVICE);
        try {
            mode = getSharedPreferences("hr_monitor_session", 0).getString(PREFS_MODE_KEY, "compact");
        } catch (Throwable ignored) {}
        buildView();
        applyMode();
        attachToWindow();
        NativeHrSessionPlugin.floatingOverlayListener = (bpm, rmssd) -> {
            mainHandler.post(() -> {
                if (bpmText != null) bpmText.setText(bpm > 0 ? String.valueOf(bpm) : "—");
                if (rmssdText != null) rmssdText.setText(rmssd > 0 ? String.valueOf((int) Math.round(rmssd)) : "—");
            });
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
        if (overlayView != null && windowManager != null) {
            try { windowManager.removeView(overlayView); } catch (Throwable ignored) {}
        }
        overlayView = null;
        Log.i(TAG, "Overlay detached.");
        super.onDestroy();
    }

    private void buildView() {
        LinearLayout pill = new LinearLayout(this);
        pill.setOrientation(LinearLayout.HORIZONTAL);
        pill.setGravity(Gravity.CENTER_VERTICAL);
        pill.setPadding(dp(10), dp(6), dp(8), dp(6));

        GradientDrawable bg = new GradientDrawable();
        bg.setColor(Color.argb(220, 10, 10, 12));
        bg.setCornerRadius(dp(20));
        bg.setStroke(dp(1), Color.argb(255, 60, 60, 64));
        pill.setBackground(bg);

        // Aorti logo (vector drawable from drawable/aorti_foreground.xml).
        ImageView logo = new ImageView(this);
        int logoRes = getResources().getIdentifier("aorti_foreground", "drawable", getPackageName());
        if (logoRes != 0) logo.setImageResource(logoRes);
        int logoSize = dp(28);
        LinearLayout.LayoutParams logoLp = new LinearLayout.LayoutParams(logoSize, logoSize);
        logoLp.rightMargin = dp(4);
        pill.addView(logo, logoLp);

        bpmText = new TextView(this);
        bpmText.setText("—");
        bpmText.setTextColor(Color.WHITE);
        bpmText.setTextSize(TypedValue.COMPLEX_UNIT_SP, 22);
        bpmText.setTypeface(bpmText.getTypeface(), android.graphics.Typeface.BOLD);
        pill.addView(bpmText);

        // RMSSD value + label, hidden in compact mode.
        rmssdText = new TextView(this);
        rmssdText.setText("—");
        rmssdText.setTextColor(Color.parseColor("#9ADFC8"));
        rmssdText.setTextSize(TypedValue.COMPLEX_UNIT_SP, 16);
        rmssdText.setTypeface(rmssdText.getTypeface(), android.graphics.Typeface.BOLD);
        LinearLayout.LayoutParams rmssdLp = new LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        rmssdLp.leftMargin = dp(10);
        pill.addView(rmssdText, rmssdLp);

        rmssdLabel = new TextView(this);
        rmssdLabel.setText("ms");
        rmssdLabel.setTextColor(Color.parseColor("#6A6A6A"));
        rmssdLabel.setTextSize(TypedValue.COMPLEX_UNIT_SP, 10);
        LinearLayout.LayoutParams rmssdLabelLp = new LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        rmssdLabelLp.leftMargin = dp(2);
        pill.addView(rmssdLabel, rmssdLabelLp);

        TextView closeX = new TextView(this);
        closeX.setText("×");
        closeX.setTextColor(Color.parseColor("#8A8A8A"));
        closeX.setTextSize(TypedValue.COMPLEX_UNIT_SP, 18);
        closeX.setPadding(dp(10), 0, dp(2), 0);
        closeX.setOnClickListener(v -> stopSelf());
        pill.addView(closeX);

        // Touch handling on the pill:
        //   ACTION_DOWN: record initial position + time.
        //   ACTION_MOVE: update window x/y as the finger moves.
        //   ACTION_UP: if movement was small AND duration was short, it's a
        //              tap → toggle display mode; else it was a drag → no-op.
        pill.setOnTouchListener(new View.OnTouchListener() {
            private int initialX, initialY;
            private float touchX, touchY;
            private long touchStart;
            private static final int TAP_MOVE_THRESHOLD_DP = 8;
            private static final long TAP_MAX_DURATION_MS = 250;
            @Override
            public boolean onTouch(View v, MotionEvent event) {
                switch (event.getAction()) {
                    case MotionEvent.ACTION_DOWN:
                        initialX = params.x;
                        initialY = params.y;
                        touchX = event.getRawX();
                        touchY = event.getRawY();
                        touchStart = System.currentTimeMillis();
                        return true;
                    case MotionEvent.ACTION_MOVE:
                        params.x = initialX + (int) (event.getRawX() - touchX);
                        params.y = initialY + (int) (event.getRawY() - touchY);
                        try { windowManager.updateViewLayout(overlayView, params); } catch (Throwable ignored) {}
                        return true;
                    case MotionEvent.ACTION_UP:
                        float dx = event.getRawX() - touchX;
                        float dy = event.getRawY() - touchY;
                        long elapsed = System.currentTimeMillis() - touchStart;
                        int thresholdPx = dp(TAP_MOVE_THRESHOLD_DP);
                        if (Math.abs(dx) < thresholdPx && Math.abs(dy) < thresholdPx
                                && elapsed < TAP_MAX_DURATION_MS) {
                            toggleMode();
                        }
                        return true;
                }
                return false;
            }
        });

        overlayView = pill;
    }

    private void toggleMode() {
        mode = mode.equals("compact") ? "card" : "compact";
        try {
            getSharedPreferences("hr_monitor_session", 0).edit()
                .putString(PREFS_MODE_KEY, mode).apply();
        } catch (Throwable ignored) {}
        applyMode();
    }

    private void applyMode() {
        boolean card = "card".equals(mode);
        if (rmssdText != null) rmssdText.setVisibility(card ? View.VISIBLE : View.GONE);
        if (rmssdLabel != null) rmssdLabel.setVisibility(card ? View.VISIBLE : View.GONE);
    }

    private void attachToWindow() {
        int type = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
            ? WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
            : WindowManager.LayoutParams.TYPE_PHONE;
        params = new WindowManager.LayoutParams(
            WindowManager.LayoutParams.WRAP_CONTENT,
            WindowManager.LayoutParams.WRAP_CONTENT,
            type,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE
                | WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL
                | WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,
            PixelFormat.TRANSLUCENT);
        params.gravity = Gravity.TOP | Gravity.END;
        params.x = dp(16);
        params.y = dp(100);
        try {
            windowManager.addView(overlayView, params);
        } catch (Throwable t) {
            Log.w(TAG, "addView failed: " + t.getMessage());
            stopSelf();
        }
    }

    private int dp(int v) {
        return (int) (v * getResources().getDisplayMetrics().density + 0.5f);
    }
}
