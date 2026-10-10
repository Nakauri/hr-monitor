// Plain-JDK test of SegmentUploadPlan (B-c planner, B-d2 cleanup policy). No Android, no Gradle, no network.
// Run: node scripts/jvm/run-upload-test.cjs   (runs this and SegmentUploaderTest, then the negative controls)
// Guards: B5 never create when the name exists; K9 PATCH the globally oldest copy; K10 send only to the last LF;
// K11 cleanup needs a (name, size) Drive match and spares the open and previous segment; L7 legacy_pending;
// L8 the legacy pass keeps running while a local legacy file exists.

import com.nakauri.hrmonitor.SegmentUploadPlan;
import com.nakauri.hrmonitor.SegmentUploadPlan.LocalSeg;
import com.nakauri.hrmonitor.SegmentUploadPlan.Op;
import com.nakauri.hrmonitor.SegmentUploadPlan.Plan;
import com.nakauri.hrmonitor.SegmentUploadPlan.Remote;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

public class UploadPlanTest {
    static int failures = 0;
    static int passes = 0;

    static void check(String name, boolean ok, String detail) {
        if (ok) passes++; else failures++;
        System.out.println((ok ? "OK    " : "FAIL  ") + name + (detail != null && !detail.isEmpty() ? "  " + detail : ""));
    }
    static void check(String name, boolean ok) { check(name, ok, null); }

    static Remote r(String id, long size, String created) { return new Remote(id, size, created); }

    public static void main(String[] args) {
        planCases();
        nameCases();
        legacyCases();
        cleanupCases();
        System.out.println("UploadPlanTest: " + passes + " passed, " + failures + " failed");
        System.exit(failures == 0 ? 0 : 1);
    }

    static void planCases() {
        Remote[] none = new Remote[0];
        Plan p = SegmentUploadPlan.planUpload(1000, 900, -1, true, false, null);
        check("open segment is skipped outside the open tick", p.op == Op.SKIP_OPEN);
        p = SegmentUploadPlan.planUpload(1000, 900, -1, true, true, null);
        check("open tick sends the open segment", p.op == Op.NEED_LIST && p.sendLen == 900, "op=" + p.op + " len=" + p.sendLen);
        p = SegmentUploadPlan.planUpload(1000, 900, -1, false, false, null);
        check("send length is the last LF, not the file length [K10]", p.sendLen == 900, "len=" + p.sendLen);
        p = SegmentUploadPlan.planUpload(50, 0, -1, false, false, null);
        check("no complete line: nothing to send", p.op == Op.SKIP_EMPTY);
        p = SegmentUploadPlan.planUpload(1000, 900, 900, false, false, null);
        check("unchanged since the last upload: skip", p.op == Op.SKIP_SAME);
        p = SegmentUploadPlan.planUpload(1000, 900, 900, false, true, null);
        check("open tick also skips an unchanged closed segment", p.op == Op.SKIP_SAME);
        p = SegmentUploadPlan.planUpload(1000, 950, 900, false, false, null);
        check("grown segment needs a lookup", p.op == Op.NEED_LIST && p.sendLen == 950);
        p = SegmentUploadPlan.planUpload(1000, 600, 900, false, false, null);
        check("shrunk segment (restart) is sent again", p.op == Op.NEED_LIST && p.sendLen == 600);
        p = SegmentUploadPlan.planUpload(1000, 900, -1, false, false, none);
        check("name absent everywhere: create", p.op == Op.CREATE && p.targetId == null);
        Remote[] dup = { r("newer", 10, "2026-10-09T14:05:00.000Z"), r("oldest", 999, "2026-10-01T00:00:00.000Z"),
            r("mid", 5, "2026-10-05T00:00:00.000Z") };
        p = SegmentUploadPlan.planUpload(1000, 900, -1, false, false, dup);
        check("name exists: never create [B5]", p.op == Op.PATCH);
        check("PATCH targets the globally oldest copy [K9]", "oldest".equals(p.targetId), "target=" + p.targetId);
        Remote[] tie = { r("b", 1, "2026-10-01T00:00:00.000Z"), r("a", 1, "2026-10-01T00:00:00.000Z") };
        check("createdTime tie breaks on id, as the viewer does", "a".equals(SegmentUploadPlan.oldest(tie).id));
        Remote[] noTime = { r("x", 1, null), r("y", 1, "2026-10-01T00:00:00.000Z") };
        check("a copy without createdTime is never preferred", "y".equals(SegmentUploadPlan.oldest(noTime).id));
        p = SegmentUploadPlan.planUpload(1000, 900, 900, false, false, dup);
        check("listing does not override an unchanged skip", p.op == Op.SKIP_SAME);
        p = SegmentUploadPlan.planUpload(800, 900, -1, false, false, null);
        check("send length never exceeds the snapshot length", p.sendLen == 800);
    }

    static void nameCases() {
        String seg = "hrm_20261009T14Z_abc123.csv";
        String bad = seg + ".bad-1760018400123";
        check("month of a segment is its UTC month", "2026-10".equals(SegmentUploadPlan.monthOf(seg)));
        check("month of a .bad file follows its segment", "2026-10".equals(SegmentUploadPlan.monthOf(bad)));
        check("month of a legacy name is null", SegmentUploadPlan.monthOf("hrv_session_2026-10-09.csv") == null);
        check(".bad base name", seg.equals(SegmentUploadPlan.badBaseName(bad)));
        check(".bad marker ms", SegmentUploadPlan.badMarkerMs(bad) == 1760018400123L);
        check("a segment name is not a .bad name", SegmentUploadPlan.badBaseName(seg) == null);
        check("a .bad name with a path separator is rejected",
            SegmentUploadPlan.badBaseName("../" + bad) == null && SegmentUploadPlan.badBaseName(seg + ".bad-1/x") == null);
        check("restart: a .bad sibling newer than the recorded one", SegmentUploadPlan.restarted(100L, new long[] { 50L, 200L }));
        check("no restart: every .bad sibling already recorded", !SegmentUploadPlan.restarted(200L, new long[] { 50L, 200L }));
        check("no restart without .bad siblings", !SegmentUploadPlan.restarted(0L, null));
    }

    static void legacyCases() {
        Map<String, Long> local = new LinkedHashMap<>();
        local.put("hrv_session_a.csv", 100L);   // Drive equal
        local.put("hrv_session_b.csv", 300L);   // Drive smaller (largest copy 200)
        local.put("hrv_session_c.csv", 50L);    // missing on Drive
        local.put("hrv_session_d.csv", 10L);    // Drive larger
        Map<String, Long> drive = new HashMap<>();
        drive.put("hrv_session_a.csv", 100L);
        drive.put("hrv_session_b.csv", 200L);
        drive.put("hrv_session_d.csv", 99L);
        int n = SegmentUploadPlan.legacyPending(local, drive);
        check("legacy_pending counts larger-than-Drive and missing files [L7]", n == 2, "n=" + n);
        check("legacy_pending signed out is unknown [L7]",
            SegmentUploadPlan.legacyPending(local, null) == -1 && "unknown".equals(SegmentUploadPlan.legacyPendingText(-1)));
        check("legacy_pending text of a count", "0".equals(SegmentUploadPlan.legacyPendingText(0)));
        check("legacy pass kept while a local legacy file exists [L8]", SegmentUploadPlan.legacyPassNeeded(1, 5));
        check("legacy pass kept until two signed-in zero reads", SegmentUploadPlan.legacyPassNeeded(0, 1));
        check("legacy pass may go after two zero reads and no local file", !SegmentUploadPlan.legacyPassNeeded(0, 2));
    }

    static void cleanupCases() {
        long day = 24L * 3_600_000L;
        long now = 100L * day;
        List<LocalSeg> segs = new ArrayList<>();
        segs.add(new LocalSeg("old_match", now - 40 * day, 1000));
        segs.add(new LocalSeg("old_size_differs", now - 40 * day, 1000));
        segs.add(new LocalSeg("old_missing", now - 40 * day, 1000));
        segs.add(new LocalSeg("young_match", now - 10 * day, 1000));
        segs.add(new LocalSeg("open", now - 45 * day, 1000));
        segs.add(new LocalSeg("previous", now - 44 * day, 1000));
        segs.add(new LocalSeg("old_dup_match", now - 41 * day, 1000));
        Map<String, long[]> drive = new HashMap<>();
        drive.put("old_match", new long[] { 1000 });
        drive.put("old_size_differs", new long[] { 999 });
        drive.put("young_match", new long[] { 1000 });
        drive.put("open", new long[] { 1000 });
        drive.put("previous", new long[] { 1000 });
        drive.put("old_dup_match", new long[] { 500, 1000 });
        List<String> del = SegmentUploadPlan.planCleanup(segs, drive, "open", "previous", now, 0, 0, false);
        check("signed in: deletes an old segment whose Drive (name, size) matches [K11]", del.contains("old_match"));
        check("signed in: a same-name copy of equal size among duplicates counts", del.contains("old_dup_match"));
        check("signed in: never on a size mismatch", !del.contains("old_size_differs"));
        check("signed in: never when Drive lacks the name", !del.contains("old_missing"));
        check("signed in: never under 30 days", !del.contains("young_match"));
        check("never the open segment", !del.contains("open"));
        check("never the previous segment", !del.contains("previous"));
        check("signed in: exactly the two eligible", del.size() == 2, del.toString());

        List<String> out = SegmentUploadPlan.planCleanup(segs, null, "open", "previous", now, 5000, 10_000, true);
        check("signed out: never by age, under the cap nothing goes", out.isEmpty(), out.toString());
        out = SegmentUploadPlan.planCleanup(segs, null, "open", "previous", now, 12_500, 10_000, false);
        check("signed out: nothing before the settings notice", out.isEmpty(), out.toString());
        out = SegmentUploadPlan.planCleanup(segs, null, "open", "previous", now, 12_500, 10_000, true);
        check("signed out past the cap: oldest first until under it",
            out.equals(Arrays.asList("old_dup_match", "old_match", "old_size_differs")), out.toString());
        check("signed out past the cap: open and previous still spared", !out.contains("open") && !out.contains("previous"));
    }
}
