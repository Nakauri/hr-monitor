package com.nakauri.hrmonitor;

import java.util.Arrays;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicLong;

import kotlin.ResultKt;
import kotlin.coroutines.Continuation;
import kotlin.coroutines.intrinsics.IntrinsicsKt;

// S65a: HcAwait (Java continuation, timeout, per-kind busy slot with tokens) and HcMap (pure mapping). Run by run-hc-test.cjs.
public class HcTest {
    static int fails = 0;

    static void ok(boolean c, String msg) {
        System.out.println((c ? "PASS  " : "FAIL  ") + msg);
        if (!c) fails++;
    }

    static String threw(HcAwait.SuspendCall call, long ms, HcAwait.Lease lease) {
        try { HcAwait.await(call, ms, lease); return "none"; } catch (Throwable t) { return String.valueOf(t.getMessage()); }
    }

    public static void main(String[] a) throws Throwable {
        Object SUSP = IntrinsicsKt.getCOROUTINE_SUSPENDED();

        // HcAwait
        ok("v".equals(HcAwait.await(c -> "v", 50)), "A1 an immediate value is returned");
        Object r2 = HcAwait.await(c -> { new Thread(() -> { sleep(20); c.resumeWith("later"); }).start(); return SUSP; }, 2000);
        ok("later".equals(r2), "A2 suspended then resumed returns the resumed value (" + r2 + ")");
        String f3 = threw(c -> { new Thread(() -> c.resumeWith(ResultKt.createFailure(new IllegalStateException("boom")))).start(); return SUSP; }, 2000, null);
        ok("boom".equals(f3), "A3 a failure is rethrown (" + f3 + ")");
        String t4 = threw(c -> SUSP, 30, null);
        ok("hc_timeout".equals(t4), "A4 never resumed gives hc_timeout (" + t4 + ")");

        // Slots with an injected clock.
        AtomicLong now = new AtomicLong(1000);
        HcAwait.Slots slots = new HcAwait.Slots(now::get);
        HcAwait.Lease l1 = slots.take("sleep");
        ok(l1 != null && slots.take("sleep") == null, "S1 one call per kind: a second take while held is refused");
        l1.close();
        ok(slots.current("sleep") == 0, "S2 a settled call frees its kind");
        HcAwait.Lease l2 = slots.take("sleep");
        Continuation[] held = new Continuation[1];
        String t5 = threw(c -> { held[0] = c; return SUSP; }, 30, l2);
        l2.close();
        ok("hc_timeout".equals(t5) && slots.take("sleep") == null, "S3 a timed-out call keeps its kind busy (" + t5 + ")");
        now.addAndGet(HcAwait.BUSY_CAP_MS - 1);
        ok(slots.take("sleep") == null, "S4 still busy 1 ms before the 2 min cap");
        now.addAndGet(1);
        HcAwait.Lease l3 = slots.take("sleep");
        ok(l3 != null, "S5 the cap frees the kind and a new call takes the slot");
        Continuation[] held3 = new Continuation[1];
        Object[] got3 = new Object[1];
        Thread t = new Thread(() -> {
            try { got3[0] = HcAwait.await(c -> { held3[0] = c; return SUSP; }, 2000, l3); } catch (Throwable e) { got3[0] = "threw " + e.getMessage(); }
        });
        t.start();
        while (held3[0] == null) sleep(2);
        held[0].resumeWith("old");
        sleep(30);
        ok(slots.current("sleep") == l3.token, "S6 the old call's late result does not clear the new token (current " + slots.current("sleep") + ", want " + l3.token + ")");
        ok(got3[0] == null, "S7 the old call's late result does not settle the new call (" + got3[0] + ")");
        held3[0].resumeWith("new");
        t.join(2000);
        l3.close();
        ok("new".equals(got3[0]) && slots.current("sleep") == 0, "S8 the new call settles with its own result and frees the kind (" + got3[0] + ")");
        HcAwait.Lease l4 = slots.take("sleep");
        Continuation[] held4 = new Continuation[1];
        threw(c -> { held4[0] = c; return SUSP; }, 30, l4);
        l4.close();
        held4[0].resumeWith("late");
        sleep(30);
        ok(slots.current("sleep") == 0, "S9 a late result frees its own slot before the cap");

        // HcMap.sdkState
        String[] got = {
            HcMap.sdkState(3, true, 28), HcMap.sdkState(3, false, 28), HcMap.sdkState(2, true, 28), HcMap.sdkState(2, false, 28),
            HcMap.sdkState(1, true, 28), HcMap.sdkState(1, false, 28), HcMap.sdkState(3, true, 27), HcMap.sdkState(2, false, 34),
        };
        String want = "available,available,update,not-installed,unsupported,unsupported,unsupported,not-installed";
        ok(String.join(",", got).equals(want), "M1 sdkState for every status, installed and not, and API 27: " + String.join(",", got));

        // HcMap.sleepRow: awake stretches from types 1, 3 and 7 only, joined when touching, clipped to the session.
        long s = 0, e = 480 * 60000L, m = 60000L;
        long[][] stages = {
            { 0, 60 * m, 4 }, { 60 * m, 90 * m, 1 }, { 90 * m, 100 * m, 7 }, { 100 * m, 200 * m, 5 },
            { 200 * m, 210 * m, 6 }, { 300 * m, 310 * m, 3 }, { 470 * m, 500 * m, 1 }, { 320 * m, 330 * m, 2 },
        };
        Map<String, Object> row = HcMap.sleepRow("id1", "com.urbandroid.sleep", s, e, stages);
        @SuppressWarnings("unchecked") List<long[]> aw = (List<long[]>) row.get("awake");
        StringBuilder sb = new StringBuilder();
        for (long[] x : aw) sb.append(x[0] / m).append('-').append(x[1] / m).append(' ');
        ok(sb.toString().trim().equals("60-100 300-310 470-480") && row.keySet().toString().equals("[id, origin, s, e, awake]"),
            "M2 sleep row keeps id, origin, s, e and awake stretches only: " + sb.toString().trim() + " " + row.keySet());
        ok(HcMap.sameSet(Arrays.asList("sleep"), Arrays.asList("sleep")) && !HcMap.sameSet(Arrays.asList(), Arrays.asList("sleep")),
            "M3 changed is false on the same set, true on a new grant");
        ok(HcMap.kinds(Arrays.asList(HcMap.READ_SLEEP, "android.permission.health.READ_STEPS")).equals(Arrays.asList("sleep")),
            "M4 granted permissions map to kinds, unknown ones dropped");
        HcMap.Rows rows = new HcMap.Rows();
        int added = 0;
        for (int i = 0; i < HcMap.MAX_ROWS + 3; i++) if (rows.add(row)) added++;
        ok(added == 5000 && rows.more, "M5 a read stops at 5,000 rows with more = true (" + added + ", " + rows.more + ")");

        System.out.println(fails == 0 ? "HcTest: all pass" : "HcTest: " + fails + " fail");
        System.exit(fails == 0 ? 0 : 1);
    }

    static void sleep(long ms) { try { Thread.sleep(ms); } catch (InterruptedException e) { Thread.currentThread().interrupt(); } }
}
