// Guards: a changed strap or relay reconnect cadence (lost heart rate, a hammered relay). Files: ReconnectPolicy.java. Runtime: about 15 s via run-reconnect-test.cjs.
package com.nakauri.hrmonitor;

import java.util.Random;

// Plain-JVM test of ReconnectPolicy: GATT and relay backoff, the full-reconnect switch, the notice, the watchdog.
// Run through scripts/jvm/run-reconnect-test.cjs, which also runs the named mutants.
public class ReconnectPolicyTest {
    static int failures = 0;
    static int passes = 0;

    static void check(String name, boolean ok) { check(name, ok, null); }
    static void check(String name, boolean ok, String detail) {
        System.out.println((ok ? "OK    " : "FAIL  ") + name + (detail != null && !ok ? "  " + detail : ""));
        if (ok) passes++; else failures++;
    }

    // A jitter source that always returns r.
    static ReconnectPolicy fixed(double r) { return new ReconnectPolicy(() -> r); }

    static String seq(long[] a) { return java.util.Arrays.toString(a); }

    static long[] gattRun(ReconnectPolicy p, int n) {
        long[] out = new long[n];
        for (int i = 0; i < n; i++) out[i] = p.nextGattDelayMs();
        return out;
    }

    static long[] relayRun(ReconnectPolicy p, int n) {
        long[] out = new long[n];
        for (int i = 0; i < n; i++) out[i] = p.nextRelayDelayMs();
        return out;
    }

    // The formulas as they stood in HrEngine at 77d068a (scheduleGattReconnect, nextRelayBackoffMs), verbatim.
    static long legacyGatt(int attemptsAfterIncrement, double random) {
        long base = Math.min(30_000L, 2_000L * (1L << Math.min(attemptsAfterIncrement - 1, 4)));
        return (long) (base * (1.0 + (random * 0.4 - 0.2)));
    }
    static long legacyRelay(int attemptsAfterIncrement, double random) {
        long base = Math.min(60_000L, 2_000L * (1L << Math.min(attemptsAfterIncrement, 5)));
        double jitter = 1.0 + (random * 0.5 - 0.25);
        return (long) (base * jitter);
    }

    static void gattCases() {
        long[] mid = gattRun(fixed(0.5), 8);
        check("GATT delays at mid jitter: 2, 4, 8, 16, 30, 30 s",
            seq(mid).equals("[2000, 4000, 8000, 16000, 30000, 30000, 30000, 30000]"), seq(mid));
        long[] lo = gattRun(fixed(0.0), 6);
        check("GATT delays at the low jitter edge are 80% of base",
            seq(lo).equals("[1600, 3200, 6400, 12800, 24000, 24000]"), seq(lo));
        double top = Math.nextDown(1.0);
        long[] hi = gattRun(fixed(top), 6);
        check("GATT delays at the high jitter edge reach at most 120% of base",
            seq(hi).equals("[2400, 4800, 9600, 19200, 36000, 36000]"), seq(hi));

        ReconnectPolicy p = fixed(0.5);
        boolean earlyFull = false;
        for (int i = 1; i <= 5; i++) {
            p.nextGattDelayMs();
            if (p.gattFullReconnect(true)) earlyFull = true;
        }
        check("attempts 1 to 5 reuse the cached gatt", !earlyFull && p.gattAttempts() == 5);
        p.nextGattDelayMs();
        check("attempt 6 (past 5) switches to a full reconnect", p.gattAttempts() == 6 && p.gattFullReconnect(true));
        p.nextGattDelayMs();
        check("it stays full while failures continue", p.gattFullReconnect(true));
        ReconnectPolicy nh = fixed(0.5);
        nh.nextGattDelayMs();
        check("no gatt handle: full reconnect from attempt 1", nh.gattFullReconnect(false));
        check("no gatt handle: full reconnect before any attempt", fixed(0.5).gattFullReconnect(false));
        check("a handle and no attempts: plain reconnect", !fixed(0.5).gattFullReconnect(true));

        p.gattReset();
        check("HR resets the GATT count", p.gattAttempts() == 0 && !p.gattFullReconnect(true));
        check("after a reset the backoff starts again at 2 s", p.nextGattDelayMs() == 2000L && p.gattAttempts() == 1);
        p.nextGattDelayMs(); p.nextGattDelayMs();
        check("a reset does not touch the relay count", p.relayAttempts() == 0);
    }

    static void relayCases() {
        long[] mid = relayRun(fixed(0.5), 8);
        check("relay delays at mid jitter: 4, 8, 16, 32, 60 s (first retry is 4 s)",
            seq(mid).equals("[4000, 8000, 16000, 32000, 60000, 60000, 60000, 60000]"), seq(mid));
        long[] lo = relayRun(fixed(0.0), 6);
        check("relay delays at the low jitter edge are 75% of base",
            seq(lo).equals("[3000, 6000, 12000, 24000, 45000, 45000]"), seq(lo));
        double top = Math.nextDown(1.0);
        long[] hi = relayRun(fixed(top), 6);
        check("relay delays at the high jitter edge reach at most 125% of base",
            seq(hi).equals("[5000, 10000, 20000, 40000, 75000, 75000]"), seq(hi));

        Random rnd = new Random(20261028L);
        boolean inBounds = true;
        String bad = null;
        for (int run = 0; run < 200 && inBounds; run++) {
            ReconnectPolicy p = new ReconnectPolicy(rnd::nextDouble);
            for (int a = 1; a <= 15; a++) {
                long d = p.nextRelayDelayMs();
                long base = Math.min(60_000L, 2_000L << Math.min(a, 5));
                if (d < base * 3 / 4 || d > base * 5 / 4) { inBounds = false; bad = "attempt " + a + " delay " + d; break; }
            }
        }
        check("random relay delays stay within 75% to 125% of base, capped at 60 s", inBounds, bad);

        ReconnectPolicy p = fixed(0.5);
        StringBuilder notices = new StringBuilder();
        for (int i = 1; i <= 25; i++) { p.nextRelayDelayMs(); if (p.relayNotifyNow()) notices.append(p.relayAttempts()).append(' '); }
        check("the unreachable notice fires once, at exactly attempt 10", notices.toString().equals("10 "), notices.toString());
        check("no notice before any attempt", !fixed(0.5).relayNotifyNow());
        p.relayReset();
        check("a relay open resets the count", p.relayAttempts() == 0 && !p.relayNotifyNow());
        check("after a reset the relay backoff starts again at 4 s", p.nextRelayDelayMs() == 4000L);
        for (int i = 2; i <= 10; i++) p.nextRelayDelayMs();
        check("after a reset the notice fires again at 10", p.relayAttempts() == 10 && p.relayNotifyNow());
        check("a relay reset does not touch the GATT count", p.gattAttempts() == 0);
    }

    static void legacyParity() {
        Random rnd = new Random(77L);
        int mismatches = 0;
        String first = null;
        for (int run = 0; run < 500; run++) {
            double[] draws = new double[24];
            for (int i = 0; i < draws.length; i++) draws[i] = rnd.nextDouble();
            draws[0] = 0.0;
            draws[1] = Math.nextDown(1.0);
            int[] k = { 0 };
            ReconnectPolicy p = new ReconnectPolicy(() -> draws[k[0]++]);
            for (int a = 1; a <= 12; a++) {
                double r = draws[k[0]];
                long got = p.nextGattDelayMs();
                long want = legacyGatt(a, r);
                if (got != want) { mismatches++; if (first == null) first = "gatt a=" + a + " got " + got + " want " + want; }
            }
            for (int a = 1; a <= 12; a++) {
                double r = draws[k[0]];
                long got = p.nextRelayDelayMs();
                long want = legacyRelay(a, r);
                if (got != want) { mismatches++; if (first == null) first = "relay a=" + a + " got " + got + " want " + want; }
            }
        }
        check("every delay equals the 77d068a HrEngine formula for the same random draw (12,000 cases)", mismatches == 0, first);
    }

    static void watchdogCases() {
        long last = 1_000_000L;
        long due = ReconnectPolicy.RELAY_WATCHDOG_MS;
        int wrong = 0;
        String first = null;
        long[] gaps = { -5_000L, 0L, due - 1, due, due + 1, 10 * due };
        for (int m = 0; m < 16; m++) {
            boolean broadcast = (m & 1) != 0, hasKey = (m & 2) != 0, live = (m & 4) != 0, retry = (m & 8) != 0;
            for (long gap : gaps) {
                boolean want = broadcast && hasKey && !live && !retry && gap >= due;
                boolean got = ReconnectPolicy.relayWatchdogDue(broadcast, hasKey, live, retry, last + gap, last);
                if (got != want) { wrong++; if (first == null) first = "b=" + broadcast + " key=" + hasKey + " live=" + live + " retry=" + retry + " gap=" + gap; }
            }
        }
        check("watchdog truth table: 16 flag combinations x 6 gaps", wrong == 0, first);
        check("watchdog window is 2 min", due == 120_000L);
        check("watchdog fires at exactly 2 min down", ReconnectPolicy.relayWatchdogDue(true, true, false, false, last + 120_000L, last));
        check("watchdog waits at 2 min less 1 ms", !ReconnectPolicy.relayWatchdogDue(true, true, false, false, last + 119_999L, last));
        check("a queued retry holds the watchdog off", !ReconnectPolicy.relayWatchdogDue(true, true, false, true, last + 10 * due, last));
        check("a live relay never trips the watchdog", !ReconnectPolicy.relayWatchdogDue(true, true, true, false, last + 10 * due, last));
        check("broadcast off never trips the watchdog", !ReconnectPolicy.relayWatchdogDue(false, true, false, false, last + 10 * due, last));
        check("no key never trips the watchdog", !ReconnectPolicy.relayWatchdogDue(true, false, false, false, last + 10 * due, last));
        check("never opened (last 0) and up 2 min: due", ReconnectPolicy.relayWatchdogDue(true, true, false, false, 120_000L, 0L));
    }

    public static void main(String[] args) {
        gattCases();
        relayCases();
        legacyParity();
        watchdogCases();
        System.out.println();
        if (failures > 0) { System.out.println(failures + " failure(s), " + passes + " passed"); System.exit(1); }
        System.out.println("ReconnectPolicyTest: " + passes + " checks pass");
    }
}
