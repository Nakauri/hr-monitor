package com.nakauri.hrmonitor;

import java.io.File;

// Per-session row sink. NativeCsvWriter is the legacy CSV; SegmentWriter the v2 hourly segments; TeeSink feeds both.
public interface HrSink {
    void appendHr(int hr, Double rmssd, double sdnnMatch, double sdnn5min, double sdnnFull, int[] rrMs, long tsMs);
    void appendConnection(String state, long tsMs);
    // The strap HR byte on a packet shown from beats; only the v2 segment keeps it.
    default void appendStrapHr(int strapHr, long tsMs) { }
    // kind is a v2 fact kind (e, p, s, w, x); fields exclude t.
    void appendFact(String kind, String[] fields, long tsMs);
    // what: start, resume, cont or stop.
    void appendSession(long id, String what, long tsMs);
    void close();
    File getFile();
    String getFilename();
    long getSessionStartMs();
    int getConsecutiveFailures();
    int getTotalFailures();
}
