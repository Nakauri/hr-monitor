package com.nakauri.hrmonitor;

import java.io.File;
import java.io.IOException;

// Writes every row to the legacy CSV and the v2 segment. The legacy writer alone answers every
// file, status and failure getter, so resume, snapshot, trickle upload and status() see the legacy file.
// A throw on one side is caught here and never reaches the other. Pure Java.
public final class TeeSink implements HrSink {
    public interface SegmentOpener {
        SegmentWriter open() throws IOException;
    }

    private final HrSink legacy;
    private final SegmentOpener opener;
    private final LifecycleLog log;
    private final Clock clock;
    private SegmentWriter segment;
    // UTC hour of the last failed segment open; a later hour retries.
    private long failedHour = Long.MIN_VALUE;
    private long liveSessionId = 0L;
    // Set by close(); the segment side is never reopened afterwards.
    private boolean closed = false;
    private int legacyThrows = 0;
    private int segmentThrows = 0;

    public TeeSink(HrSink legacy, SegmentWriter segment, SegmentOpener opener, Clock clock, LifecycleLog log) {
        if (legacy == null) throw new IllegalArgumentException("legacy required");
        this.legacy = legacy;
        this.segment = segment;
        this.opener = opener;
        this.clock = clock;
        this.log = log;
        if (segment == null && clock != null) failedHour = SegmentWriter.hourStart(clock.wallMs());
    }

    public synchronized boolean hasSegment() { return segment != null; }
    public synchronized SegmentWriter segment() { return segment; }

    private void legacyFailed(String what, Throwable t) {
        legacyThrows++;
        if (legacyThrows == 1 || legacyThrows % 300 == 0) {
            log.log("tee_legacy_throw op=" + what + " n=" + legacyThrows + " reason=" + t);
        }
    }

    private void segmentFailed(String what, Throwable t) {
        segmentThrows++;
        if (segmentThrows == 1 || segmentThrows % 300 == 0) {
            log.log("tee_segment_throw op=" + what + " n=" + segmentThrows + " reason=" + t);
        }
    }

    // Segment side for a row at tsMs; retries a failed open once the UTC hour has moved on.
    private SegmentWriter seg(long tsMs) {
        if (closed) return null;
        if (segment != null || opener == null) return segment;
        long now = clock != null ? clock.wallMs() : tsMs;
        long h = SegmentWriter.hourStart(Math.max(now, tsMs));
        if (failedHour != Long.MIN_VALUE && h <= failedHour) return null;
        try {
            segment = opener.open();
            if (liveSessionId != 0L) segment.appendSession(liveSessionId, "cont", Math.max(now, tsMs));
        } catch (Throwable t) {
            failedHour = h;
            log.log("segment_open_fail reason=" + t.getMessage());
        }
        return segment;
    }

    @Override
    public synchronized void appendHr(int hr, Double rmssd, double sdnnMatch, double sdnn5min, double sdnnFull,
            int[] rrMs, long tsMs) {
        try { legacy.appendHr(hr, rmssd, sdnnMatch, sdnn5min, sdnnFull, rrMs, tsMs); }
        catch (Throwable t) { legacyFailed("hr", t); }
        try {
            SegmentWriter s = seg(tsMs);
            if (s != null) s.appendHr(hr, rmssd, sdnnMatch, sdnn5min, sdnnFull, rrMs, tsMs);
        } catch (Throwable t) { segmentFailed("hr", t); }
    }

    @Override
    public synchronized void appendConnection(String state, long tsMs) {
        try { legacy.appendConnection(state, tsMs); }
        catch (Throwable t) { legacyFailed("c", t); }
        try {
            SegmentWriter s = seg(tsMs);
            if (s != null) s.appendConnection(state, tsMs);
        } catch (Throwable t) { segmentFailed("c", t); }
    }

    @Override
    public synchronized void appendFact(String kind, String[] fields, long tsMs) {
        writeFact(kind, fields, tsMs);
    }

    // Returns true when the fact reached the segment; the legacy CSV has no fact rows.
    public synchronized boolean writeFact(String kind, String[] fields, long tsMs) {
        try { legacy.appendFact(kind, fields, tsMs); }
        catch (Throwable t) { legacyFailed("fact", t); }
        try {
            SegmentWriter s = seg(tsMs);
            return s != null && s.writeFact(kind, fields, tsMs);
        } catch (Throwable t) {
            segmentFailed("fact", t);
            return false;
        }
    }

    @Override
    public synchronized void appendSession(long id, String what, long tsMs) {
        boolean stop = "stop".equals(what);
        try { legacy.appendSession(id, what, tsMs); }
        catch (Throwable t) { legacyFailed("g", t); }
        if (!stop) liveSessionId = id;
        try {
            SegmentWriter s = seg(tsMs);
            if (s != null) s.appendSession(id, what, tsMs);
        } catch (Throwable t) { segmentFailed("g", t); }
        if (stop) liveSessionId = 0L;
    }

    public synchronized void rollIfDue(long nowMs) {
        if (closed) return;
        try {
            SegmentWriter s = segment;
            if (s != null) s.rollIfDue(nowMs);
        } catch (Throwable t) { segmentFailed("roll", t); }
    }

    public synchronized void checkOffset(long nowMs) {
        if (closed) return;
        try {
            SegmentWriter s = segment;
            if (s != null) s.checkOffset(nowMs);
        } catch (Throwable t) { segmentFailed("tz", t); }
    }

    // Open segment for a reader, under this lock then the writer's (the order every write takes).
    public synchronized String openSegmentName() {
        if (closed) return null;
        try {
            SegmentWriter s = segment;
            return s != null ? s.openName() : null;
        } catch (Throwable t) { segmentFailed("open_name", t); return null; }
    }

    public synchronized long segmentReadableLength(String name) {
        if (closed) return -1L;
        try {
            SegmentWriter s = segment;
            return s != null ? s.readableLength(name) : -1L;
        } catch (Throwable t) { segmentFailed("read_len", t); return -1L; }
    }

    @Override
    public synchronized void close() {
        closed = true;
        try { legacy.close(); }
        catch (Throwable t) { legacyFailed("close", t); }
        try {
            SegmentWriter s = segment;
            if (s != null) s.close();
        } catch (Throwable t) { segmentFailed("close", t); }
    }

    @Override public File getFile() { return legacy.getFile(); }
    @Override public String getFilename() { return legacy.getFilename(); }
    @Override public long getSessionStartMs() { return legacy.getSessionStartMs(); }
    @Override public int getConsecutiveFailures() { return legacy.getConsecutiveFailures(); }
    @Override public int getTotalFailures() { return legacy.getTotalFailures(); }
}
