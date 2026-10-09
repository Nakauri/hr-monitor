package com.nakauri.hrmonitor;

import java.io.File;

// Per-session row sink; NativeCsvWriter is the CSV implementation.
public interface HrSink {
    void appendHr(int hr, Double rmssd, double sdnnMatch, double sdnn5min, double sdnnFull, long tsMs);
    void appendConnection(String state, long tsMs);
    void close();
    File getFile();
    String getFilename();
    long getSessionStartMs();
    int getConsecutiveFailures();
    int getTotalFailures();
}
