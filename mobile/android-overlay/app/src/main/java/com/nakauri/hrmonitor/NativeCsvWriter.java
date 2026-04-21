package com.nakauri.hrmonitor;

import android.content.Context;
import android.os.Environment;
import android.util.Log;

import java.io.BufferedWriter;
import java.io.File;
import java.io.FileWriter;
import java.io.IOException;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;
import java.util.TimeZone;

/**
 * Per-session CSV writer matching the schema produced by hr_monitor.html's
 * buildSessionCSV() exactly. Writing happens natively (not via JS) so
 * recording continues uninterrupted while the WebView is paused in
 * background.
 *
 * Schema:
 *   time_min, epoch_ms, hr_bpm, rmssd_ms, palpitation, event,
 *   warning, connection, posture
 *
 * Files land in app-private files dir
 * (/data/data/com.nakauri.hrmonitor/files/sessions/) so they survive across
 * app upgrades and sit alongside Drive's own copy. Filename matches
 * `hrv_session_YYYY-MM-DDTHH-MM-SS.csv` so hrv_viewer.html parses them
 * with no schema changes.
 */
public class NativeCsvWriter {
    private static final String TAG = "NativeCsvWriter";
    private static final String HEADER =
        "time_min,epoch_ms,hr_bpm,rmssd_ms,palpitation,event,warning,connection,posture";

    private final File file;
    private final long sessionStartMs;
    private BufferedWriter writer;

    public NativeCsvWriter(Context context, long sessionStartMs) throws IOException {
        this.sessionStartMs = sessionStartMs;
        File dir = new File(context.getFilesDir(), "sessions");
        if (!dir.exists()) dir.mkdirs();
        SimpleDateFormat fmt = new SimpleDateFormat("yyyy-MM-dd'T'HH-mm-ss", Locale.US);
        fmt.setTimeZone(TimeZone.getDefault());
        String filename = "hrv_session_" + fmt.format(new Date(sessionStartMs)) + ".csv";
        this.file = new File(dir, filename);
        this.writer = new BufferedWriter(new FileWriter(file, false));
        writer.write(HEADER);
        writer.newLine();
        writer.flush();
        Log.i(TAG, "Opened: " + file.getAbsolutePath());
    }

    public synchronized void appendHrRow(int hr, double rmssd, long timestampMs) {
        if (writer == null) return;
        double tMin = Math.max(0, (timestampMs - sessionStartMs)) / 60_000.0;
        try {
            writer.write(String.format(Locale.US,
                "%.4f,%d,%d,%.2f,,,,,",
                tMin, timestampMs, hr, rmssd));
            writer.newLine();
            // Flush every row — small files, low cost, ensures data is on
            // disk if the process gets killed mid-session.
            writer.flush();
        } catch (IOException e) {
            Log.w(TAG, "appendHrRow failed: " + e.getMessage());
        }
    }

    public synchronized void appendConnectionRow(String connState, long timestampMs) {
        if (writer == null) return;
        double tMin = Math.max(0, (timestampMs - sessionStartMs)) / 60_000.0;
        try {
            writer.write(String.format(Locale.US,
                "%.4f,%d,,,,,,%s,",
                tMin, timestampMs, connState));
            writer.newLine();
            writer.flush();
        } catch (IOException e) {
            Log.w(TAG, "appendConnectionRow failed: " + e.getMessage());
        }
    }

    public synchronized void close() {
        if (writer != null) {
            try { writer.flush(); writer.close(); } catch (IOException ignored) {}
            writer = null;
            Log.i(TAG, "Closed: " + file.getName() + " (" + file.length() + " bytes)");
        }
    }

    public File getFile() { return file; }
    public String getFilename() { return file.getName(); }
}
