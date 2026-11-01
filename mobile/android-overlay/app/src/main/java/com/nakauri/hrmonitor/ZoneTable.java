package com.nakauri.hrmonitor;

import java.util.TimeZone;

// The system zone's UTC offsets as JSON, for local-clock.js: the WebView carries its own older zone data.
public final class ZoneTable {
    private static final long DAY_MS = 86_400_000L;
    private static final long YEAR_MS = 365 * DAY_MS;
    private static final long FROM_MS = 1577836800000L; // 2020-01-01

    private ZoneTable() {}

    public static String json(TimeZone zone, long nowMs) {
        return json(zone, FROM_MS, nowMs + 5 * YEAR_MS);
    }

    // {"from":ms,"to":ms,"changes":[[startMs,offsetMinutes],...]}, first entry starting at from.
    static String json(TimeZone zone, long from, long to) {
        StringBuilder out = new StringBuilder("{\"from\":").append(from).append(",\"to\":").append(to)
            .append(",\"changes\":[[").append(from).append(',').append(zone.getOffset(from) / 60_000).append(']');
        long prev = from;
        for (long t = from + DAY_MS; t <= to; t += DAY_MS) {
            if (zone.getOffset(t) != zone.getOffset(prev)) {
                long lo = prev, hi = t;
                while (hi - lo > 60_000L) {
                    long mid = lo + (hi - lo) / 2;
                    if (zone.getOffset(mid) == zone.getOffset(prev)) lo = mid; else hi = mid;
                }
                out.append(",[").append(hi - hi % 60_000L).append(',').append(zone.getOffset(hi) / 60_000).append(']');
            }
            prev = t;
        }
        return out.append("]}").toString();
    }
}
