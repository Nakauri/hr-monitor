package com.nakauri.hrmonitor;

import java.io.BufferedWriter;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.OutputStreamWriter;
import java.io.RandomAccessFile;
import java.nio.channels.FileChannel;
import java.nio.charset.StandardCharsets;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;
import java.util.TimeZone;
import java.util.regex.Pattern;

// Schema v2 hourly segments, one file per UTC hour and install id. Format authority: BLOCK-B-SPEC.md section 2.
// Row shape is checked by scripts/segment-format.test.cjs; behaviour by scripts/jvm/SegmentWriterTest.java.
// Pure Java: no android.* import.
public class SegmentWriter implements HrSink {
    public static final String NAME_REGEX = "^hrm_(\\d{8})T(\\d{2})Z_([a-z0-9]{6})\\.csv$";
    public static final Pattern NAME_PATTERN = Pattern.compile(NAME_REGEX);
    public static final String HEADER_FORMAT = "#hrm,v=2,base=%d,tz=%d,app=%s,dev=%s,flavour=%s";
    static final String HEADER_PREFIX = "#hrm,v=2,";
    static final long HOUR_MS = 3_600_000L;

    // Kind letter, then the field names after t.
    static final String[][] KINDS = {
        { "h", "hr", "rmssd", "rr" },
        { "c", "state" },
        { "g", "sessionId", "what" },
        { "e", "label" },
        { "p", "posture", "src" },
        { "s", "kind" },
        { "w", "type", "threshold" },
        { "x" },
        { "z", "offsetMin" },
        { "k", "prevEpochMs" },
    };
    // Kinds appendFact accepts; z and k are written by the writer itself.
    static final String FACT_KINDS = "epswx";

    static final int FACT_FIELD_MAX = 80;
    static final long CLOCK_JUMP_MS = 2_000L;
    private static final int FLUSH_EVERY_N_ROWS = 60;
    private static final long FLUSH_AFTER_MS = 30_000L;
    private static final long SYNC_AFTER_MS = 300_000L;
    // After a write failure the stream is dropped; the next reopen waits this long (mono).
    static final long REOPEN_BACKOFF_MS = 30_000L;
    // A fact stamped outside [now - FACT_PAST_MS, now + FACT_FUTURE_MS] is written at now.
    public static final long FACT_PAST_MS = 15L * 60_000L;
    public static final long FACT_FUTURE_MS = 5_000L;

    private final File dir;
    private final String iid;
    private final Clock clock;
    private final TzSource tz;
    private final String app;
    private final String dev;
    private final String flavour;
    private final LifecycleLog log;

    private File file;
    private FileOutputStream fos;
    private BufferedWriter out;
    private long base = Long.MIN_VALUE;
    private long failedHour = Long.MIN_VALUE;
    private int lastTz = Integer.MIN_VALUE;
    private long liveSessionId = 0L;

    private long lastWall = Long.MIN_VALUE;
    private long lastMono = 0L;
    private int rowsSinceFlush = 0;
    private long lastFlushMono;
    private long lastSyncMono;

    private boolean closed = false;
    private long reopenNotBeforeMono = Long.MIN_VALUE;
    // Rows refused during the reopen backoff; logged as segment_skip when the file reopens or closes.
    private int skippedRows = 0;
    private volatile CloseListener closeListener;
    private int consecutiveFailures = 0;
    private int totalFailures = 0;
    private long syncCount = 0;

    // Opens the current UTC hour's segment; throws when it cannot.
    public SegmentWriter(File dir, String iid, Clock clock, TzSource tz, String app, String dev,
            String flavour, LifecycleLog log) throws IOException {
        if (iid == null || !iid.matches("[a-z0-9]{6}")) throw new IOException("bad_iid");
        this.dir = dir;
        this.iid = iid;
        this.clock = clock;
        this.tz = tz;
        this.app = clean(app);
        this.dev = clean(dev);
        this.flavour = clean(flavour);
        this.log = log;
        if (!dir.exists() && !dir.mkdirs() && !dir.isDirectory()) throw new IOException("mkdir_failed " + dir);
        lastFlushMono = clock.monoMs();
        lastSyncMono = lastFlushMono;
        open(hourStart(clock.wallMs()));
    }

    // Called under this writer's lock once a segment file is closed; must not block. reason null = final close.
    public interface CloseListener {
        void onSegmentClosed(String name, String reason);
    }

    public void setCloseListener(CloseListener l) { closeListener = l; }

    private void notifyClosed(String name, String reason) {
        CloseListener l = closeListener;
        if (l == null) return;
        try {
            l.onSegmentClosed(name, reason);
        } catch (Throwable t) {
            log.log("segment_close_listener_throw reason=" + t);
        }
    }

    public static long hourStart(long epochMs) {
        return Math.floorDiv(epochMs, HOUR_MS) * HOUR_MS;
    }

    public static String nameFor(long hourStartMs, String iid) {
        SimpleDateFormat f = new SimpleDateFormat("yyyyMMdd'T'HH", Locale.US);
        f.setTimeZone(TimeZone.getTimeZone("UTC"));
        return "hrm_" + f.format(new Date(hourStartMs)) + "Z_" + iid + ".csv";
    }

    // Commas and line breaks become spaces; at most FACT_FIELD_MAX chars.
    static String clean(String s) {
        if (s == null) return "";
        String r = s.replace(',', ' ').replace('\r', ' ').replace('\n', ' ');
        return r.length() > FACT_FIELD_MAX ? r.substring(0, FACT_FIELD_MAX) : r;
    }

    public static long clampFactTs(long tsMs, long nowMs) {
        return (tsMs < nowMs - FACT_PAST_MS || tsMs > nowMs + FACT_FUTURE_MS) ? nowMs : tsMs;
    }

    static int fieldCount(String kind) {
        for (String[] k : KINDS) if (k[0].equals(kind)) return k.length - 1;
        return -1;
    }

    // ---- Open, reopen, roll, close ------------------------------------------

    private void open(long hourStartMs) throws IOException {
        String name = nameFor(hourStartMs, iid);
        File f = new File(dir, name);
        boolean append = false;
        long trimmed = 0;
        if (f.exists() && f.length() > 0) {
            long len = f.length();
            long lastLf = lastLfOffset(f);
            if (lastLf < 0) {
                // No complete line, not even the header: restart the file.
                truncate(f, 0);
                trimmed = len;
            } else if (!headerOk(firstLine(f))) {
                File bad = new File(dir, name + ".bad-" + clock.wallMs());
                if (!f.renameTo(bad)) throw new IOException("bad_header_move_failed " + name);
                log.log("segment_bad name=" + name + " moved=" + bad.getName());
            } else {
                append = true;
                if (lastLf + 1 < len) {
                    truncate(f, lastLf + 1);
                    trimmed = len - (lastLf + 1);
                }
            }
            if (trimmed > 0) log.log("segment_trim bytes=" + trimmed);
        }
        FileOutputStream s = openStream(f, append);
        BufferedWriter w = new BufferedWriter(new OutputStreamWriter(s, StandardCharsets.UTF_8));
        int tzNow = tz.offsetMinutes(clock.wallMs());
        try {
            if (!append) {
                w.write(String.format(Locale.US, HEADER_FORMAT, hourStartMs, tzNow, app, dev, flavour));
                w.write('\n');
            }
            w.flush();
        } catch (IOException e) {
            try { w.close(); } catch (IOException ignored) {}
            throw e;
        }
        file = f;
        fos = s;
        out = w;
        base = hourStartMs;
        failedHour = Long.MIN_VALUE;
        log.log("segment_open name=" + name + " append=" + append + " trim=" + trimmed);
        logSkipped();
        // The file is open from here on; a failed g,cont or z row counts as a write failure, not an open failure.
        try {
            int prevTz = append ? lastTzInFile(f) : lastTz;
            if (liveSessionId != 0L) {
                long contTs = append ? Math.max(hourStartMs, clock.wallMs()) : hourStartMs;
                rawRow("g", contTs, String.valueOf(liveSessionId), "cont");
            }
            if (prevTz != Integer.MIN_VALUE && prevTz != tzNow) {
                rawRow("z", Math.max(hourStartMs, clock.wallMs()), String.valueOf(tzNow));
            }
            if (liveSessionId != 0L) sync();
        } catch (IOException e) {
            noteFailure("open_rows", e);
            dropStream("open_rows");
        }
        lastTz = tzNow;
    }

    // Test seam for a failing stream.
    protected FileOutputStream openStream(File f, boolean append) throws IOException {
        return new FileOutputStream(f, append);
    }

    static boolean headerOk(String line) {
        return line != null && line.startsWith(HEADER_PREFIX) && line.contains(",base=");
    }

    private static int headerTz(String line) {
        if (line == null) return Integer.MIN_VALUE;
        for (String part : line.split(",")) {
            if (part.startsWith("tz=")) {
                try { return Integer.parseInt(part.substring(3)); } catch (NumberFormatException e) { return Integer.MIN_VALUE; }
            }
        }
        return Integer.MIN_VALUE;
    }

    // Offset in force at the end of an existing segment: its last z row, else the header's tz.
    private static int lastTzInFile(File f) throws IOException {
        byte[] all;
        try (RandomAccessFile raf = new RandomAccessFile(f, "r")) {
            all = new byte[(int) Math.min(raf.length(), 4L * 1024L * 1024L)];
            raf.readFully(all);
        }
        String text = new String(all, StandardCharsets.UTF_8);
        int at = text.lastIndexOf("\nz,");
        if (at >= 0) {
            int end = text.indexOf('\n', at + 1);
            if (end > 0) {
                String[] parts = text.substring(at + 1, end).split(",");
                if (parts.length == 3) {
                    try { return Integer.parseInt(parts[2]); } catch (NumberFormatException ignored) { }
                }
            }
        }
        return headerTz(firstLine(f));
    }

    private static long lastLfOffset(File f) throws IOException {
        try (RandomAccessFile raf = new RandomAccessFile(f, "r")) {
            long pos = raf.length();
            byte[] buf = new byte[4096];
            while (pos > 0) {
                int n = (int) Math.min(buf.length, pos);
                pos -= n;
                raf.seek(pos);
                raf.readFully(buf, 0, n);
                for (int i = n - 1; i >= 0; i--) if (buf[i] == '\n') return pos + i;
            }
            return -1;
        }
    }

    private static String firstLine(File f) throws IOException {
        try (RandomAccessFile raf = new RandomAccessFile(f, "r")) {
            byte[] buf = new byte[(int) Math.min(512, raf.length())];
            raf.readFully(buf);
            int end = 0;
            while (end < buf.length && buf[end] != '\n') end++;
            if (end == buf.length) return null;
            return new String(buf, 0, end, StandardCharsets.UTF_8);
        }
    }

    private static void truncate(File f, long size) throws IOException {
        try (RandomAccessFile raf = new RandomAccessFile(f, "rw"); FileChannel ch = raf.getChannel()) {
            ch.truncate(size);
            ch.force(true);
        }
    }

    private void closeOpen(String reason) {
        if (out == null) return;
        String name = file.getName();
        try {
            out.flush();
            fos.getFD().sync();
            syncCount++;
        } catch (IOException e) {
            noteFailure("close", e);
            dropStream("close");
            log.log("segment_close name=" + name + " bytes=" + file.length() + " reason=failed");
            notifyClosed(name, "failed");
            return;
        }
        try { out.close(); } catch (IOException ignored) {}
        out = null;
        fos = null;
        log.log("segment_close name=" + name + " bytes=" + file.length() + (reason != null ? " reason=" + reason : ""));
        notifyClosed(name, reason);
    }

    // Moves to the hour of tsMs when it is later than the open one; never to an earlier hour.
    private void logSkipped() {
        if (skippedRows > 0) {
            log.log("segment_skip n=" + skippedRows);
            skippedRows = 0;
        }
    }

    // g rows (start, resume, cont, stop) skip the reopen backoff and try a reopen at once.
    private boolean ensureHour(long tsMs, boolean sessionRow) {
        if (closed) return false;
        long h = hourStart(tsMs);
        if (out != null) {
            if (h <= base) return true;
        } else {
            if (!sessionRow && reopenNotBeforeMono != Long.MIN_VALUE && clock.monoMs() < reopenNotBeforeMono) {
                skippedRows++;
                return false;
            }
            // Closed by rollIfDue or a failed open: a late row lands in the current hour, never an earlier one.
            h = Math.max(h, hourStart(clock.wallMs()));
            if (base != Long.MIN_VALUE && h < base) h = base;
            if (failedHour != Long.MIN_VALUE && h <= failedHour) return false;
        }
        String from = file != null ? file.getName() : "none";
        if (out != null) closeOpen("roll");
        try {
            open(h);
            if (!from.equals(file.getName())) log.log("segment_roll from=" + from + " to=" + file.getName());
            return true;
        } catch (IOException e) {
            failedHour = h;
            log.log("segment_open_fail reason=" + e.getMessage());
            return false;
        }
    }

    // Closes the open segment once its UTC hour has passed; opens nothing.
    public synchronized void rollIfDue(long nowMs) {
        if (out != null && hourStart(nowMs) > base) {
            log.log("segment_roll from=" + file.getName() + " to=next_row");
            closeOpen("hour_end");
        }
    }

    // Writes z when the UTC offset differs from the last one recorded.
    public synchronized void checkOffset(long nowMs) {
        if (out == null) return;
        int cur = tz.offsetMinutes(nowMs);
        if (lastTz != Integer.MIN_VALUE && cur != lastTz) {
            writeRow("z", nowMs, String.valueOf(cur));
            lastTz = cur;
        }
    }

    // ---- Rows ---------------------------------------------------------------

    private void rawRow(String kind, long tsMs, String... fields) throws IOException {
        if (fields.length != fieldCount(kind)) throw new IllegalArgumentException("field count " + kind);
        StringBuilder sb = new StringBuilder(32);
        sb.append(kind).append(',').append(tsMs - base);
        for (String f : fields) sb.append(',').append(f);
        sb.append('\n');
        out.write(sb.toString());
    }

    // Clock-jump check, roll, then the row. Returns false when nothing could be written.
    private boolean writeRow(String kind, long tsMs, String... fields) {
        long w = clock.wallMs();
        long m = clock.monoMs();
        long prevExpected = Long.MIN_VALUE;
        if (lastWall != Long.MIN_VALUE) {
            long expected = lastWall + (m - lastMono);
            if (Math.abs(w - expected) > CLOCK_JUMP_MS) prevExpected = expected;
        }
        lastWall = w;
        lastMono = m;
        try {
            boolean jump = prevExpected != Long.MIN_VALUE;
            if (jump) log.log("segment_clock_jump by=" + (w - prevExpected));
            if (jump && out != null) {
                rawRow("k", w, String.valueOf(prevExpected));
                jump = false;
            }
            if (!ensureHour(tsMs, "g".equals(kind))) return false;
            if (jump) rawRow("k", w, String.valueOf(prevExpected));
            rawRow(kind, tsMs, fields);
            rowsSinceFlush++;
            if (rowsSinceFlush >= FLUSH_EVERY_N_ROWS || m - lastFlushMono >= FLUSH_AFTER_MS) {
                out.flush();
                rowsSinceFlush = 0;
                lastFlushMono = m;
            }
            if (m - lastSyncMono >= SYNC_AFTER_MS) sync();
            consecutiveFailures = 0;
            return true;
        } catch (IOException e) {
            noteFailure(kind, e);
            dropStream(kind);
            return false;
        }
    }

    private void sync() throws IOException {
        if (out == null) return;
        out.flush();
        fos.getFD().sync();
        syncCount++;
        long m = clock.monoMs();
        rowsSinceFlush = 0;
        lastFlushMono = m;
        lastSyncMono = m;
    }

    // Closes the raw stream without flushing, so a buffer that failed to write is never written twice.
    // The next write reopens the file in append and trims any partial last line.
    private void dropStream(String why) {
        if (fos != null) {
            try { fos.close(); } catch (IOException ignored) { }
        }
        out = null;
        fos = null;
        reopenNotBeforeMono = clock.monoMs() + REOPEN_BACKOFF_MS;
        log.log("segment_drop name=" + (file != null ? file.getName() : "none") + " reason=" + why);
    }

    private void noteFailure(String what, IOException e) {
        consecutiveFailures++;
        totalFailures++;
        if (consecutiveFailures == 1 || consecutiveFailures % 300 == 0) {
            log.log("segment_write_fail kind=" + what + " consec=" + consecutiveFailures + " reason=" + e.getMessage());
        }
    }

    // Null RMSSD (warm-up, too few clean beats) is an empty field. SDNN values are not written.
    @Override
    public synchronized void appendHr(int hr, Double rmssd, double sdnnMatch, double sdnn5min, double sdnnFull,
            int[] rrMs, long tsMs) {
        String rmssdField = rmssd == null ? "" : String.format(Locale.US, "%.2f", rmssd);
        StringBuilder rr = new StringBuilder();
        if (rrMs != null) {
            for (int i = 0; i < rrMs.length; i++) {
                if (i > 0) rr.append(';');
                rr.append(rrMs[i]);
            }
        }
        writeRow("h", tsMs, String.valueOf(hr), rmssdField, rr.toString());
    }

    @Override
    public synchronized void appendConnection(String state, long tsMs) {
        if (writeRow("c", tsMs, clean(state))) syncQuietly("c");
    }

    @Override
    public synchronized void appendFact(String kind, String[] fields, long tsMs) {
        writeFact(kind, fields, tsMs);
    }

    // Returns true when the row reached the segment.
    public synchronized boolean writeFact(String kind, String[] fields, long tsMs) {
        if (kind == null || kind.length() != 1 || FACT_KINDS.indexOf(kind.charAt(0)) < 0) return false;
        int n = fieldCount(kind);
        String[] f = new String[n];
        for (int i = 0; i < n; i++) f[i] = clean(fields != null && i < fields.length ? fields[i] : "");
        return writeRow(kind, tsMs, f);
    }

    @Override
    public synchronized void appendSession(long id, String what, long tsMs) {
        boolean stop = "stop".equals(what);
        if (!stop) liveSessionId = id;
        if (writeRow("g", tsMs, String.valueOf(id), clean(what))) syncQuietly("g");
        if (stop) liveSessionId = 0L;
    }

    private void syncQuietly(String what) {
        try { sync(); } catch (IOException e) { noteFailure(what, e); dropStream(what); }
    }

    @Override
    // Final: no later write reopens a segment.
    public synchronized void close() {
        closeOpen(null);
        logSkipped();
        closed = true;
    }

    @Override public synchronized File getFile() { return file; }
    @Override public synchronized String getFilename() { return file != null ? file.getName() : null; }
    @Override public synchronized long getSessionStartMs() { return liveSessionId; }
    @Override public synchronized int getConsecutiveFailures() { return consecutiveFailures; }
    @Override public synchronized int getTotalFailures() { return totalFailures; }
    public synchronized long getSyncCount() { return syncCount; }

    // For a reader of the open segment: flushes buffered rows (no fsync) and returns the file length,
    // captured under this lock so a read stops there while writes continue. -1 when name is not open.
    // A failed flush is a write failure: the stream drops and the next row reopens and trims.
    public synchronized long readableLength(String name) {
        if (out == null || file == null || name == null || !name.equals(file.getName())) return -1L;
        try {
            out.flush();
        } catch (IOException e) {
            noteFailure("read", e);
            dropStream("read");
            return -1L;
        }
        return file.length();
    }

    // Name of the segment this writer holds open, or null.
    public synchronized String openName() { return out != null && file != null ? file.getName() : null; }
    public synchronized boolean isOpen() { return out != null; }
}
