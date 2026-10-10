package com.nakauri.hrmonitor;

// Wall and monotonic time for SegmentWriter; monoMs is SystemClock.elapsedRealtime on device.
public interface Clock {
    long wallMs();
    long monoMs();
}
