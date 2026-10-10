package com.nakauri.hrmonitor;

// One line into files/lifecycle.log; pure Java so SegmentWriter runs under plain java.
public interface LifecycleLog {
    void log(String event);
}
