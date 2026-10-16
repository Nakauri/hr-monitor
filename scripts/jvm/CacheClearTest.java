// Plain-JDK test of CacheClear (ledger 24): Clear cache deletes only local CSVs Drive holds in full.
// Run: node scripts/jvm/run-cache-clear-test.cjs   (runs this, the wiring text checks, then the negative controls)

import com.nakauri.hrmonitor.CacheClear;
import com.nakauri.hrmonitor.SegmentUploadPlan;

import java.io.File;
import java.io.FileOutputStream;
import java.nio.file.Files;
import java.util.Arrays;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Map;
import java.util.Set;
import java.util.TreeSet;

public class CacheClearTest {
    static int failures = 0;
    static int passes = 0;

    static void check(String name, boolean ok, String detail) {
        if (ok) passes++; else failures++;
        System.out.println((ok ? "OK    " : "FAIL  ") + name + (detail != null && !detail.isEmpty() ? "  " + detail : ""));
    }

    static void put(File dir, String name, int bytes) throws Exception {
        try (FileOutputStream o = new FileOutputStream(new File(dir, name))) { o.write(new byte[bytes]); }
    }

    static Set<String> left(File dir) {
        String[] n = dir.list();
        return new TreeSet<>(Arrays.asList(n != null ? n : new String[0]));
    }

    // done.csv on Drive in full, short.csv truncated on Drive, missing.csv never uploaded, bigger.csv Drive larger,
    // live.csv the active session, stopping.csv in its stop upload, notes.txt not a CSV.
    static File fixture() throws Exception {
        File dir = Files.createTempDirectory("cacheclear").toFile();
        put(dir, "done.csv", 100);
        put(dir, "short.csv", 100);
        put(dir, "missing.csv", 100);
        put(dir, "bigger.csv", 100);
        put(dir, "live.csv", 100);
        put(dir, "stopping.csv", 100);
        put(dir, "notes.txt", 10);
        return dir;
    }

    static Map<String, Long> drive() {
        Map<String, Long> d = new HashMap<>();
        d.put("done.csv", 100L);
        d.put("short.csv", 60L);
        d.put("bigger.csv", 140L);
        d.put("live.csv", 100L);
        d.put("stopping.csv", 100L);
        return d;
    }

    static Set<String> skip() { return new HashSet<>(Arrays.asList("live.csv", "stopping.csv")); }

    public static void main(String[] args) throws Exception {
        File dir = fixture();
        int[] r = CacheClear.run(dir, skip(), drive());
        Set<String> rest = left(dir);
        check("deletes only files Drive holds in full", !rest.contains("done.csv") && !rest.contains("bigger.csv"), "left=" + rest);
        check("keeps a file whose Drive copy is shorter", rest.contains("short.csv"), "left=" + rest);
        check("keeps a file Drive does not have", rest.contains("missing.csv"), "left=" + rest);
        check("never touches the live or stopping session", rest.contains("live.csv") && rest.contains("stopping.csv"), "left=" + rest);
        check("never touches a file that is not a CSV", rest.contains("notes.txt"), "left=" + rest);
        check("counts deleted 2, kept 2", r[0] == 2 && r[1] == 2, "deleted=" + r[0] + " kept=" + r[1]);

        File noDrive = fixture();
        int[] n = CacheClear.run(noDrive, skip(), null);
        check("no Drive: deletes nothing", left(noDrive).size() == 7, "left=" + left(noDrive));
        check("no Drive: counts every CSV but the live ones as kept", n[0] == 0 && n[1] == 4, "deleted=" + n[0] + " kept=" + n[1]);

        File emptyDrive = fixture();
        int[] e = CacheClear.run(emptyDrive, skip(), new HashMap<String, Long>());
        check("empty Drive folder: deletes nothing", e[0] == 0 && left(emptyDrive).size() == 7, "left=" + left(emptyDrive));

        check("missing folder: nothing", Arrays.equals(CacheClear.run(new File(dir, "nope"), skip(), drive()), new int[] { 0, 0 }), null);

        Map<String, Long> local = new HashMap<>();
        local.put("done.csv", 100L);
        local.put("short.csv", 100L);
        local.put("missing.csv", 100L);
        local.put("bigger.csv", 100L);
        check("legacy_pending counts exactly the files Clear cache keeps", SegmentUploadPlan.legacyPending(local, drive()) == 2,
            "pending=" + SegmentUploadPlan.legacyPending(local, drive()));

        File emptyDir = Files.createTempDirectory("cacheclear").toFile();
        put(emptyDir, "empty.csv", 0);
        CacheClear.run(emptyDir, skip(), drive());
        check("keeps an empty file Drive does not have", left(emptyDir).contains("empty.csv"), "left=" + left(emptyDir));

        System.out.println("CacheClearTest: " + passes + " passed, " + failures + " failed");
        System.exit(failures == 0 ? 0 : 1);
    }
}
