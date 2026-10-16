package com.nakauri.hrmonitor;

import java.util.ArrayDeque;
import java.util.Arrays;

// PARITY CRITICAL: hr-source.js is the twin. Checks: scripts/jvm/run-hr-source-test.cjs, scripts/hr-source-parity.test.cjs.
// Shown HR: the strap's value unless the beats clearly disagree. rrMs is never written; the shown value is what gets recorded.
public final class HrSourcePolicy {
    static final int ENTER_BPM = 12;
    static final long ENTER_HOLD_MS = 5000L;
    static final long START_WINDOW_MS = 60000L;
    static final long START_HOLD_MS = 2000L;
    static final int EXIT_BPM = 5;
    static final long EXIT_HOLD_MS = 10000L;
    static final long STALE_MS = 5000L;
    static final long RUN_GAP_MS = 10000L;
    static final long WINDOW_MS = 5000L;
    static final int WINDOW_MAX_BEATS = 64;
    static final int MIN_KEPT = 4;
    static final int REF_BEATS = 20;
    static final int REF_LO_MS = 270;
    static final int REF_HI_MS = 2000;
    static final double REF_TOL = 0.08;
    static final double REF_MIN_SHARE = 0.3;
    static final int REF_MIN_COUNT = 3;
    static final int REF_MIN_CLUSTER = 2;
    static final int RAW_LO_MS = 250;
    static final int RAW_HI_MS = 3000;
    static final int RANGE_LO_MS = 300;
    static final int RANGE_HI_MS = 2000;
    static final double MULT_RATIO = 1.7;
    static final int MULT_MIN = 2;
    static final int MULT_MAX = 4;
    static final double MULT_TOL = 0.15;
    static final double SHORT_RATIO = 0.7;
    static final double LONG_RATIO = 1.43;
    static final int STEP_BACK_MAX_MS = 5000;
    static final double START_CLEAN_SHARE = 0.75;
    static final double STEADY_PLAIN_SHARE = 0.8;
    static final double HALF_TOL = 0.1;

    private static final long NONE = Long.MIN_VALUE;
    private static final long ERROR_LOG_MS = 60000L;
    private static final double[] EMPTY = new double[0];

    public static final class Result {
        public final int shownHr;
        public final boolean beat;
        public final int switched;   // +1 to beats, -1 to strap, 0 none
        public final double beatHr;  // NaN when there is no estimate
        public final boolean newRun; // this packet started a run
        Result(int shownHr, boolean beat, int switched, double beatHr, boolean newRun) {
            this.shownHr = shownHr; this.beat = beat; this.switched = switched; this.beatHr = beatHr; this.newRun = newRun;
        }
        // The strap byte as is; the caller's fallback when onPacket throws.
        public static Result strap(int strapHr) { return new Result(strapHr, false, 0, Double.NaN, false); }
    }
    private static final class Beat {
        final long t; final double[] out;
        Beat(long t, double[] out) { this.t = t; this.out = out; }
    }

    private boolean pending = true;
    private long lastTs = NONE, runStart = 0L, overSince = NONE, underSince = NONE, lastGoodTs = NONE;
    private boolean beat = false;
    private long lastErrorLogMs = NONE;
    private double lastGood = Double.NaN;
    private final ArrayDeque<Integer> hist = new ArrayDeque<>();
    private final ArrayDeque<Beat> win = new ArrayDeque<>();

    public synchronized void reset() { pending = true; lastTs = NONE; }
    public synchronized void linkLive() { pending = true; }
    // True while the last packet was shown from beats; a new run ends that stretch without a switch.
    public synchronized boolean isBeat() { return beat; }
    // At most one error line per ERROR_LOG_MS.
    public synchronized boolean errorLogDue(long nowMs) {
        if (lastErrorLogMs != NONE && nowMs - lastErrorLogMs >= 0 && nowMs - lastErrorLogMs < ERROR_LOG_MS) return false;
        lastErrorLogMs = nowMs;
        return true;
    }

    private void startRun(long ts) {
        pending = false; runStart = ts; hist.clear(); win.clear(); beat = false;
        overSince = NONE; underSince = NONE; lastGood = Double.NaN; lastGoodTs = NONE;
    }

    public synchronized Result onPacket(int strapHr, int[] rrMs, long tsMs) {
        long ts = tsMs;
        boolean newRun = pending || lastTs == NONE || ts - lastTs > RUN_GAP_MS || ts < lastTs - RUN_GAP_MS;
        if (newRun) startRun(ts);
        else if (ts < lastTs) ts = lastTs;
        lastTs = ts;
        int n = rrMs == null ? 0 : rrMs.length;
        long[] times = new long[n];
        long t = ts;
        for (int j = n - 1; j >= 0; j--) { times[j] = t; if (rrMs[j] > 0 && rrMs[j] < STEP_BACK_MAX_MS) t -= rrMs[j]; }
        for (int j = 0; j < n; j++) {
            win.addLast(new Beat(times[j], times[j] < runStart ? EMPTY : repair(rrMs[j], modeRef(hist))));
            hist.addLast(rrMs[j]);
            if (hist.size() > REF_BEATS) hist.pollFirst();
        }
        while (!win.isEmpty() && win.peekFirst().t <= ts - WINDOW_MS) win.pollFirst();
        while (win.size() > WINDOW_MAX_BEATS) win.pollFirst();
        int kept = 0, plain = 0, nv = 0;
        for (Beat b : win) if (b.out.length > 0) { kept++; if (b.out.length == 1) plain++; nv += b.out.length; }
        boolean inStart = ts - runStart <= START_WINDOW_MS;
        double share = win.isEmpty() ? 0.0 : (double) (inStart ? kept : plain) / win.size();
        double est = Double.NaN;
        if (kept >= MIN_KEPT && share >= (inStart ? START_CLEAN_SHARE : STEADY_PLAIN_SHARE)) {
            double[] vals = new double[nv];
            int k = 0;
            for (Beat b : win) for (double x : b.out) vals[k++] = x;
            est = 60000.0 / median(vals);
        }
        boolean has = !Double.isNaN(est);
        boolean half = has && strapHr > 0 && Math.abs(2 * est - strapHr) <= HALF_TOL * strapHr;
        if (has) { lastGood = est; lastGoodTs = ts; }
        int switched = 0;
        if (!beat) {
            if (has && !half && Math.abs(strapHr - est) > ENTER_BPM) {
                if (overSince == NONE) overSince = ts;
                long hold = inStart ? START_HOLD_MS : ENTER_HOLD_MS;
                if (ts - overSince >= hold) { beat = true; underSince = NONE; switched = 1; }
            } else overSince = NONE;
        } else if (half) {
            beat = false; overSince = NONE; switched = -1;
        } else if (!has) {
            if (ts - lastGoodTs > STALE_MS) { beat = false; overSince = NONE; switched = -1; }
        } else if (Math.abs(strapHr - est) <= EXIT_BPM) {
            if (underSince == NONE) underSince = ts;
            if (ts - underSince >= EXIT_HOLD_MS) { beat = false; overSince = NONE; switched = -1; }
        } else underSince = NONE;
        int shown = beat ? (int) Math.round(has ? est : lastGood) : strapHr;
        return new Result(shown, beat, switched, est, newRun);
    }

    static double modeRef(Iterable<Integer> h) {
        int m = 0;
        for (int x : h) if (x >= REF_LO_MS && x <= REF_HI_MS) m++;
        if (m < REF_MIN_COUNT) return Double.NaN;
        double[] v = new double[m];
        int i = 0;
        for (int x : h) if (x >= REF_LO_MS && x <= REF_HI_MS) v[i++] = x;
        double best = 0, bestSum = 0;
        int bestN = 0;
        for (double c : v) {
            int n = 0; double s = 0;
            for (double x : v) if (Math.abs(x - c) <= REF_TOL * c) { n++; s += x; }
            if (n > bestN || (n == bestN && c < best)) { best = c; bestN = n; bestSum = s; }
        }
        if (bestN < Math.max(REF_MIN_CLUSTER, REF_MIN_SHARE * m)) return median(v);
        return bestSum / bestN;
    }

    static double[] repair(int rr, double ref) {
        if (rr < RAW_LO_MS || rr > RAW_HI_MS) return EMPTY;
        if (Double.isNaN(ref)) return (rr >= RANGE_LO_MS && rr <= RANGE_HI_MS) ? new double[] { rr } : EMPTY;
        double ratio = rr / ref;
        if (ratio > MULT_RATIO) {
            long k = Math.round(ratio);
            if (k >= MULT_MIN && k <= MULT_MAX && Math.abs((double) rr / k - ref) / ref <= MULT_TOL) {
                double[] o = new double[(int) k];
                Arrays.fill(o, (double) rr / k);
                return o;
            }
        }
        if (rr > RANGE_HI_MS) return EMPTY;
        if (ratio < SHORT_RATIO || ratio > LONG_RATIO) return EMPTY;
        return new double[] { rr };
    }

    static double median(double[] a) {
        double[] s = a.clone();
        Arrays.sort(s);
        int n = s.length;
        return n % 2 == 1 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
    }
}
