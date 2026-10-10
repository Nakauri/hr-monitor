package com.nakauri.hrmonitor;

import java.util.TimeZone;

// UTC offset in minutes at an instant.
public interface TzSource {
    int offsetMinutes(long epochMs);

    static TzSource system() {
        return ms -> TimeZone.getDefault().getOffset(ms) / 60_000;
    }
}
