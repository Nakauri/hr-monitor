package com.nakauri.hrmonitor;

import android.app.Activity;
import android.app.ActivityManager;
import android.content.ClipData;
import android.content.Context;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Paint;
import android.graphics.Rect;
import android.graphics.pdf.PdfDocument;
import android.net.Uri;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.util.Base64;
import android.util.Log;

import androidx.core.content.FileProvider;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PluginCall;

import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.lang.ref.WeakReference;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;

// Report PDF: each page arrives as one fixed-size raster at 2x and becomes one PdfDocument page,
// shared through the app FileProvider. Never touches the engine, the services or the plugin executors.
public final class PdfPrinter {
    private static final String TAG = "PdfPrinter";
    private static final String DIR = "reports";
    private static final long KEEP_MS = 60L * 60_000L;

    private static final ExecutorService EXEC = Executors.newSingleThreadExecutor(r -> {
        Thread t = new Thread(r, "aorti-pdf");
        t.setDaemon(true);
        t.setPriority(Thread.MIN_PRIORITY);
        return t;
    });
    private static final AtomicBoolean BUSY = new AtomicBoolean(false);

    private PdfPrinter() {}

    // JVM-PURE BEGIN: scripts/jvm/run-pdf-test.cjs compiles this block on a plain JDK.
    static final class Plan {
        static final int PAGE_W_PT = 612;
        static final int PAGE_H_PT = 792;
        static final int SCALE = 2;
        static final int MAX_MOMENTS = 6;
        static final int MAX_PAGES = 20;
        // Java heap for the page bytes; the rasters themselves live in native memory (systemLow).
        static final long BUDGET_BYTES = 24L * 1024L * 1024L;

        static int widthPt(boolean landscape) { return landscape ? PAGE_H_PT : PAGE_W_PT; }
        static int heightPt(boolean landscape) { return landscape ? PAGE_W_PT : PAGE_H_PT; }
        static int rasterW(boolean landscape) { return widthPt(landscape) * SCALE; }
        static int rasterH(boolean landscape) { return heightPt(landscape) * SCALE; }
        static long rasterBytes() { return (long) rasterW(false) * rasterH(false) * 4L; }

        static long headroom(long max, long total, long free) { return max - (total - free); }

        static boolean heapLow(long max, long total, long free) { return headroom(max, total, free) < BUDGET_BYTES; }

        // PdfDocument keeps every page's pixels until writeTo, so the system must hold all of them.
        static boolean systemLow(boolean lowFlag, long avail, long threshold, int pages) {
            return lowFlag || avail - threshold < pages * rasterBytes() + BUDGET_BYTES;
        }

        // Page 1, then two moments per page, then the optional week page.
        static int pageCount(int moments, boolean week) {
            int m = Math.max(0, Math.min(moments, MAX_MOMENTS));
            return 1 + (m + 1) / 2 + (week ? 1 : 0);
        }

        static boolean fits(int w, int h, boolean landscape) {
            return w == rasterW(landscape) && h == rasterH(landscape);
        }

        static String safeName(String raw) {
            String s = raw == null ? "" : raw;
            s = s.substring(Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\')) + 1);
            if (s.toLowerCase(java.util.Locale.ROOT).endsWith(".pdf")) s = s.substring(0, s.length() - 4);
            s = s.replaceAll("[^A-Za-z0-9._-]", "-").replaceAll("^[.-]+", "");
            if (s.length() > 80) s = s.substring(0, 80);
            if (s.isEmpty()) s = "aorti-report";
            return s + ".pdf";
        }
    }
    // JVM-PURE END

    // Settles a call once; later settles are dropped.
    private static final class Settle {
        private final PluginCall call;
        private final AtomicBoolean done = new AtomicBoolean(false);
        Settle(PluginCall call) { this.call = call; }
        void ok(JSObject ret) {
            if (!done.compareAndSet(false, true)) return;
            try { call.resolve(ret); } catch (Throwable t) { Log.w(TAG, "resolve failed: " + t); }
        }
        void fail(String code) {
            if (!done.compareAndSet(false, true)) return;
            try { call.reject(code, code); } catch (Throwable t) { Log.w(TAG, "reject failed: " + t); }
        }
    }

    // Called on the plugin thread; returns at once and settles the call from the pdf thread.
    static void print(Context ctx, Activity activity, PluginCall call) {
        final Settle s = new Settle(call);
        try {
            if (!BUSY.compareAndSet(false, true)) { s.fail("pdf_busy"); return; }
            final Context app = ctx.getApplicationContext();
            final WeakReference<Activity> act = new WeakReference<>(activity);
            try {
                EXEC.execute(() -> {
                    try {
                        run(app, act, call, s);
                    } finally {
                        BUSY.set(false);
                    }
                });
            } catch (Throwable t) {
                BUSY.set(false);
                s.fail("pdf_failed");
            }
        } catch (Throwable t) {
            s.fail("pdf_failed");
        }
    }

    private static void run(Context app, WeakReference<Activity> act, PluginCall call, Settle s) {
        PdfDocument doc = null;
        Bitmap bmp = null;
        File out = null;
        String failCode = null;
        boolean kept = false;
        try {
            android.os.Process.setThreadPriority(android.os.Process.THREAD_PRIORITY_BACKGROUND);
            long t0 = SystemClock.elapsedRealtime();
            JSArray pages = call.getArray("pages");
            int n = pages == null ? 0 : pages.length();
            if (n < 1 || n > Plan.MAX_PAGES) { s.fail("pdf_bad_pages"); return; }
            Integer moments = call.getInt("moments");
            if (moments != null && Plan.pageCount(moments, call.getBoolean("week", false)) != n) {
                s.fail("pdf_page_count");
                return;
            }
            if (lowMemory(app, n)) { s.fail("pdf_low_memory"); return; }

            File dir = new File(app.getCacheDir(), DIR);
            if (!dir.isDirectory() && !dir.mkdirs()) { s.fail("pdf_write_failed"); return; }
            prune(dir, System.currentTimeMillis());
            File own = new File(dir, String.valueOf(SystemClock.elapsedRealtimeNanos()));
            if (!own.mkdirs()) { s.fail("pdf_write_failed"); return; }
            out = new File(own, Plan.safeName(call.getString("filename")));

            doc = new PdfDocument();
            Paint paint = new Paint(Paint.FILTER_BITMAP_FLAG);
            for (int i = 0; i < n; i++) {
                if (lowMemory(app, n - i)) { s.fail("pdf_low_memory"); return; }
                Object item = pages.get(i);
                String data;
                boolean landscape = false;
                if (item instanceof JSONObject) {
                    data = ((JSONObject) item).optString("image", "");
                    landscape = ((JSONObject) item).optBoolean("landscape", false);
                } else {
                    data = String.valueOf(item);
                }
                byte[] bytes = Base64.decode(data.substring(data.indexOf(',') + 1), Base64.DEFAULT);
                BitmapFactory.Options bounds = new BitmapFactory.Options();
                bounds.inJustDecodeBounds = true;
                BitmapFactory.decodeByteArray(bytes, 0, bytes.length, bounds);
                if (!Plan.fits(bounds.outWidth, bounds.outHeight, landscape)) { s.fail("pdf_bad_page"); return; }
                try {
                    bmp = BitmapFactory.decodeByteArray(bytes, 0, bytes.length);
                    bytes = null;
                    if (bmp == null) { s.fail("pdf_bad_page"); return; }
                    PdfDocument.Page page = doc.startPage(new PdfDocument.PageInfo.Builder(
                        Plan.widthPt(landscape), Plan.heightPt(landscape), i + 1).create());
                    page.getCanvas().drawBitmap(bmp, null,
                        new Rect(0, 0, Plan.widthPt(landscape), Plan.heightPt(landscape)), paint);
                    doc.finishPage(page);
                } finally {
                    if (bmp != null) { bmp.recycle(); bmp = null; }
                }
            }
            try (FileOutputStream fos = new FileOutputStream(out)) {
                doc.writeTo(fos);
            }
            doc.close();
            doc = null;

            Uri uri = FileProvider.getUriForFile(app, app.getPackageName() + ".fileprovider", out);
            JSObject ret = new JSObject();
            ret.put("uri", uri.toString());
            ret.put("name", out.getName());
            ret.put("pages", n);
            ret.put("bytes", out.length());
            ret.put("ms", SystemClock.elapsedRealtime() - t0);
            kept = true;
            if (!call.getBoolean("share", true)) {
                ret.put("shared", false);
                s.ok(ret);
                return;
            }
            boolean posted = new Handler(Looper.getMainLooper()).post(() -> share(act, uri, ret, s));
            if (!posted) s.fail("pdf_share_failed");
        } catch (OutOfMemoryError oom) {
            failCode = "pdf_low_memory";
        } catch (Throwable t) {
            Log.w(TAG, "print failed: " + t);
            failCode = "pdf_failed";
        } finally {
            if (bmp != null) bmp.recycle();
            if (doc != null) {
                try { doc.close(); } catch (Throwable ignored) {}
            }
            if (!kept && out != null) {
                try { out.delete(); } catch (Throwable ignored) {}
            }
            // Settled after the pages are released, so the reject itself has memory to run.
            if (failCode != null) s.fail(failCode);
        }
    }

    // Main thread: the system share sheet with read access to this one file.
    private static void share(WeakReference<Activity> act, Uri uri, JSObject ret, Settle s) {
        try {
            Intent send = new Intent(Intent.ACTION_SEND);
            send.setType("application/pdf");
            send.putExtra(Intent.EXTRA_STREAM, uri);
            send.setClipData(ClipData.newRawUri("", uri));
            send.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            Intent chooser = Intent.createChooser(send, null);
            chooser.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            Activity a = act.get();
            // Android 10+ blocks a background start; with no live Activity the file is returned unshared.
            boolean shown = a != null && !a.isFinishing();
            if (shown) a.startActivity(chooser);
            ret.put("shared", shown);
            s.ok(ret);
        } catch (Throwable t) {
            Log.w(TAG, "share failed: " + t);
            s.fail("pdf_share_failed");
        }
    }

    // Java heap headroom for the page bytes; with pages > 0 also the system memory for every raster.
    private static boolean lowMemory(Context app, int pages) {
        Runtime rt = Runtime.getRuntime();
        if (Plan.heapLow(rt.maxMemory(), rt.totalMemory(), rt.freeMemory())) return true;
        if (pages <= 0) return false;
        ActivityManager am = (ActivityManager) app.getSystemService(Context.ACTIVITY_SERVICE);
        if (am == null) return false;
        ActivityManager.MemoryInfo mi = new ActivityManager.MemoryInfo();
        am.getMemoryInfo(mi);
        return Plan.systemLow(mi.lowMemory, mi.availMem, mi.threshold, pages);
    }

    // Each print has its own folder; folders older than an hour go, so a share target keeps reading a recent one.
    private static void prune(File dir, long nowMs) {
        File[] old = dir.listFiles();
        if (old == null) return;
        for (File f : old) {
            if (nowMs - f.lastModified() <= KEEP_MS) continue;
            File[] inner = f.listFiles();
            if (inner != null) for (File g : inner) { try { g.delete(); } catch (Throwable ignored) {} }
            try { f.delete(); } catch (Throwable ignored) {}
        }
    }
}
