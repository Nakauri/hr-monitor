package com.nakauri.hrmonitor;

import android.app.Service;
import android.content.Context;
import android.content.Intent;
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
import android.widget.LinearLayout;
import android.widget.TextView;

// Pulsoid-style floating BPM overlay. Uses SYSTEM_ALERT_WINDOW + WindowManager
// to render a small draggable pill on top of any app. Subscribes to HR ticks
// from NativeHrSessionPlugin via a singleton listener slot.
public class FloatingOverlayService extends Service {
    private static final String TAG = "FloatingOverlay";

    private WindowManager windowManager;
    private View overlayView;
    private TextView bpmText;
    private WindowManager.LayoutParams params;
    private final Handler mainHandler = new Handler(Looper.getMainLooper());

    // Functional interface the plugin calls per HR tick. Kept simple so the
    // plugin doesn't take a dependency on this class.
    public interface HrUpdateListener {
        void onHrUpdate(int bpm);
    }

    @Override
    public IBinder onBind(Intent intent) { return null; }

    @Override
    public void onCreate() {
        super.onCreate();
        windowManager = (WindowManager) getSystemService(Context.WINDOW_SERVICE);
        buildView();
        attachToWindow();
        NativeHrSessionPlugin.floatingOverlayListener = bpm -> {
            mainHandler.post(() -> {
                if (bpmText != null) bpmText.setText(bpm > 0 ? String.valueOf(bpm) : "—");
            });
        };
        Log.i(TAG, "Overlay attached.");
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
        pill.setPadding(dp(14), dp(8), dp(10), dp(8));

        GradientDrawable bg = new GradientDrawable();
        bg.setColor(Color.argb(220, 10, 10, 12));
        bg.setCornerRadius(dp(20));
        bg.setStroke(dp(1), Color.argb(255, 60, 60, 64));
        pill.setBackground(bg);

        TextView heart = new TextView(this);
        heart.setText("♥"); // ♥
        heart.setTextColor(Color.parseColor("#FF6B6B"));
        heart.setTextSize(TypedValue.COMPLEX_UNIT_SP, 16);
        LinearLayout.LayoutParams heartLp = new LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        heartLp.rightMargin = dp(8);
        pill.addView(heart, heartLp);

        bpmText = new TextView(this);
        bpmText.setText("—");
        bpmText.setTextColor(Color.WHITE);
        bpmText.setTextSize(TypedValue.COMPLEX_UNIT_SP, 22);
        bpmText.setTypeface(bpmText.getTypeface(), android.graphics.Typeface.BOLD);
        pill.addView(bpmText);

        TextView closeX = new TextView(this);
        closeX.setText("×"); // ×
        closeX.setTextColor(Color.parseColor("#8A8A8A"));
        closeX.setTextSize(TypedValue.COMPLEX_UNIT_SP, 18);
        closeX.setPadding(dp(10), 0, dp(2), 0);
        closeX.setOnClickListener(v -> stopSelf());
        pill.addView(closeX);

        // Drag handling: anywhere on the pill (except the close X) initiates
        // a window drag. Move offsets x/y from the initial down position.
        pill.setOnTouchListener(new View.OnTouchListener() {
            private int initialX, initialY;
            private float touchX, touchY;
            @Override
            public boolean onTouch(View v, MotionEvent event) {
                switch (event.getAction()) {
                    case MotionEvent.ACTION_DOWN:
                        initialX = params.x;
                        initialY = params.y;
                        touchX = event.getRawX();
                        touchY = event.getRawY();
                        return true;
                    case MotionEvent.ACTION_MOVE:
                        params.x = initialX + (int) (event.getRawX() - touchX);
                        params.y = initialY + (int) (event.getRawY() - touchY);
                        try { windowManager.updateViewLayout(overlayView, params); } catch (Throwable ignored) {}
                        return true;
                }
                return false;
            }
        });

        overlayView = pill;
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
