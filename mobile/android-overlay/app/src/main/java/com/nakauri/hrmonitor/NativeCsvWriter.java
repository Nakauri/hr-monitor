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

// PARITY CRITICAL — schema must match hr_monitor.html buildSessionCSV().
// Schema: time_min,epoch_ms,hr_bpm,rmssd_ms,palpitation,event,warning,connection,posture
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
        // .SSS prevents same-second collision; viewer regex tolerates it.
        SimpleDateFormat fmt = new SimpleDateFormat("yyyy-MM-dd'T'HH-mm-ss.SSS", Locale.US);
        fmt.setTimeZone(TimeZone.getDefault());
        String filename = "hrv_session_" + fmt.format(new Date(sessionStartMs)) + ".csv";
        this.file = new File(dir, filename);
        this.writer = new BufferedWriter(new FileWriter(file, false));
        writer.write(HEADER);
        writer.newLine();
        writer.flush();
        Log.i(TAG, "Opened: " + file.getAbsolutePath());
    }

    private int consecutiveFailures = 0;
    private int totalFailures = 0;
    public int getConsecutiveFailures() { return consecutiveFailures; }
    public int getTotalFailures() { return totalFailures; }

    public synchronized void appendHrRow(int hr, double rmssd, long timestampMs) {
        if (writer == null) return;
        double tMin = Math.max(0, (timestampMs - sessionStartMs)) / 60_000.0;
        try {
            writer.write(String.format(Locale.US,
                "%.4f,%d,%d,%.2f,,,,,",
                tMin, timestampMs, hr, rmssd));
            writer.newLine();
            writer.flush();
            consecutiveFailures = 0;
        } catch (IOException e) {
            consecutiveFailures++;
            totalFailures++;
            Log.w(TAG, "appendHrRow failed (consec=" + consecutiveFailures + " total=" + totalFailures + "): " + e.getMessage());
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
            consecutiveFailures = 0;
        } catch (IOException e) {
            consecutiveFailures++;
            totalFailures++;
            Log.w(TAG, "appendConnectionRow failed (consec=" + consecutiveFailures + " total=" + totalFailures + "): " + e.getMessage());
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
    public long getSessionStartMs() { return sessionStartMs; }
}
