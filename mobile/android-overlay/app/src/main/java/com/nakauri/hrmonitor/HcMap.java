package com.nakauri.hrmonitor;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/** Health Connect values to plain Java types. No Android or client import: JVM-tested by scripts/jvm/HcTest.java. */
final class HcMap {
    static final String PROVIDER = "com.google.android.apps.healthdata";
    static final String READ_SLEEP = "android.permission.health.READ_SLEEP";
    static final int MAX_ROWS = 5000;
    // SleepSessionRecord stage types kept as awake: 1 awake, 3 out of bed, 7 awake in bed.
    static final int[] AWAKE_TYPES = { 1, 3, 7 };

    private HcMap() {}

    /** getSdkStatus: 1 unavailable, 2 provider update required (also a missing app on API 28 to 33), 3 available. */
    static String sdkState(int status, boolean installed, int api) {
        if (api < 28) return "unsupported";
        if (status == 3) return "available";
        if (status == 2) return installed ? "update" : "not-installed";
        return "unsupported";
    }

    static String permission(String kind) {
        return "sleep".equals(kind) ? READ_SLEEP : null;
    }

    static List<String> kinds(Iterable<String> permissions) {
        List<String> out = new ArrayList<>();
        if (permissions == null) return out;
        for (String p : permissions) if (READ_SLEEP.equals(p) && !out.contains("sleep")) out.add("sleep");
        return out;
    }

    private static boolean awakeType(int t) {
        for (int a : AWAKE_TYPES) if (a == t) return true;
        return false;
    }

    /** Awake stretches of one session, clipped to [s, e], touching ones joined. stages: {start, end, type}. */
    static List<long[]> awake(long s, long e, long[][] stages) {
        List<long[]> in = new ArrayList<>();
        if (stages != null) for (long[] st : stages) {
            if (st == null || st.length < 3 || !awakeType((int) st[2])) continue;
            long a = Math.max(s, st[0]), b = Math.min(e, st[1]);
            if (b > a) in.add(new long[] { a, b });
        }
        in.sort(Comparator.comparingLong(x -> x[0]));
        List<long[]> out = new ArrayList<>();
        for (long[] r : in) {
            long[] last = out.isEmpty() ? null : out.get(out.size() - 1);
            if (last != null && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
            else out.add(new long[] { r[0], r[1] });
        }
        return out;
    }

    /** One sleep row: { id, origin, s, e, awake: [[s, e], ...] }. Light, deep and REM stages are not kept. */
    static Map<String, Object> sleepRow(String id, String origin, long s, long e, long[][] stages) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("id", id);
        m.put("origin", origin);
        m.put("s", s);
        m.put("e", e);
        m.put("awake", awake(s, e, stages));
        return m;
    }

    static boolean sameSet(Iterable<String> a, Iterable<String> b) {
        List<String> x = new ArrayList<>(), y = new ArrayList<>();
        if (a != null) for (String s : a) if (!x.contains(s)) x.add(s);
        if (b != null) for (String s : b) if (!y.contains(s)) y.add(s);
        String[] xa = x.toArray(new String[0]), ya = y.toArray(new String[0]);
        Arrays.sort(xa);
        Arrays.sort(ya);
        return Arrays.equals(xa, ya);
    }

    /** One read's rows, stopped at MAX_ROWS with more = true. */
    static final class Rows {
        final List<Map<String, Object>> rows = new ArrayList<>();
        boolean more;

        boolean add(Map<String, Object> row) {
            if (rows.size() >= MAX_ROWS) { more = true; return false; }
            rows.add(row);
            return true;
        }
    }
}
