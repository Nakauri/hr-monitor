// Plain-JDK test of SegmentWriter and TeeSink (no Android, no Gradle).
// Run: node scripts/jvm/run-segment-test.cjs   (compiles, runs, then runs the negative controls)
// Guards: S15 reopen by name, K10 partial last line, K11 clock jumps, K1/K2 tee, B3 hour segments.

import com.nakauri.hrmonitor.Clock;
import com.nakauri.hrmonitor.HrSink;
import com.nakauri.hrmonitor.LifecycleLog;
import com.nakauri.hrmonitor.SegmentWriter;
import com.nakauri.hrmonitor.TeeSink;
import com.nakauri.hrmonitor.TzSource;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.TimeZone;

public class SegmentWriterTest {
    static int failures = 0;
    static int passes = 0;

    static void check(String name, boolean ok, String detail) {
        if (ok) passes++; else failures++;
        System.out.println((ok ? "OK    " : "FAIL  ") + name + (detail != null && !detail.isEmpty() ? "  " + detail : ""));
    }
    static void check(String name, boolean ok) { check(name, ok, null); }

    static final class FakeClock implements Clock {
        long wall;
        long mono = 1_000_000L;
        FakeClock(long wall) { this.wall = wall; }
        public long wallMs() { return wall; }
        public long monoMs() { return mono; }
        void advance(long ms) { wall += ms; mono += ms; }
    }

    static final class Log implements LifecycleLog {
        final List<String> lines = new ArrayList<>();
        public void log(String e) { lines.add(e); }
        boolean has(String prefix) { for (String l : lines) if (l.startsWith(prefix)) return true; return false; }
        int count(String prefix) { int n = 0; for (String l : lines) if (l.startsWith(prefix)) n++; return n; }
    }

    static final TzSource UTC = ms -> 0;
    static final TzSource EDMONTON = ms -> TimeZone.getTimeZone("America/Edmonton").getOffset(ms) / 60_000;

    // Expected field count after t, per kind (BLOCK-B-SPEC.md section 2).
    static final Map<String, Integer> FIELDS = new HashMap<>();
    static {
        FIELDS.put("h", 3); FIELDS.put("c", 1); FIELDS.put("g", 2); FIELDS.put("e", 1); FIELDS.put("p", 2);
        FIELDS.put("s", 1); FIELDS.put("w", 2); FIELDS.put("x", 0); FIELDS.put("z", 1); FIELDS.put("k", 1);
    }

    static final List<File> made = new ArrayList<>();

    static void deleteTree(File f) {
        File[] kids = f.listFiles();
        if (kids != null) for (File k : kids) deleteTree(k);
        f.delete();
    }

    static File freshDir(String name) throws IOException {
        File d = Files.createTempDirectory("segtest-" + name).toFile();
        made.add(d);
        return d;
    }

    static long ms(String iso) { return Instant.parse(iso).toEpochMilli(); }

    static SegmentWriter writer(File dir, String iid, FakeClock c, TzSource tz, Log log) throws IOException {
        return new SegmentWriter(dir, iid, c, tz, "1.2.3", "808S 0025153", "personal", log);
    }

    static String read(File f) throws IOException {
        return new String(Files.readAllBytes(f.toPath()), StandardCharsets.UTF_8);
    }

    static List<String> lines(File f) throws IOException {
        String s = read(f);
        List<String> out = new ArrayList<>(Arrays.asList(s.split("\n", -1)));
        if (!out.isEmpty() && out.get(out.size() - 1).isEmpty()) out.remove(out.size() - 1);
        return out;
    }

    static File[] segFiles(File dir) {
        File[] fs = dir.listFiles((d, n) -> SegmentWriter.NAME_PATTERN.matcher(n).matches());
        Arrays.sort(fs);
        return fs;
    }

    static long headerBase(String header) {
        for (String p : header.split(",")) if (p.startsWith("base=")) return Long.parseLong(p.substring(5));
        return Long.MIN_VALUE;
    }
    static int headerTz(String header) {
        for (String p : header.split(",")) if (p.startsWith("tz=")) return Integer.parseInt(p.substring(3));
        return Integer.MIN_VALUE;
    }

    // Every data line has the field count its kind requires; returns the bad lines.
    static List<String> badRows(File f) throws IOException {
        List<String> bad = new ArrayList<>();
        List<String> ls = lines(f);
        for (int i = 1; i < ls.size(); i++) {
            String[] parts = ls.get(i).split(",", -1);
            Integer want = FIELDS.get(parts[0]);
            if (want == null || parts.length != want + 2) bad.add(ls.get(i));
            else { try { Long.parseLong(parts[1]); } catch (NumberFormatException e) { bad.add(ls.get(i)); } }
        }
        return bad;
    }

    static void hrEverySecond(SegmentWriter w, FakeClock c, int n) {
        for (int i = 0; i < n; i++) {
            w.appendHr(80 + (i % 10), i < 3 ? null : 42.125, 1, 2, 3, new int[] { 750, 752 }, c.wall);
            c.advance(1000);
        }
    }

    public static void main(String[] args) throws Exception {
        rollAtHour();
        rollTimerOpensNothing();
        dstEdmonton();
        reopenAppends();
        partialLastLineTrimmed();
        headerOnlyPartialRestarts();
        badHeaderMovedAside();
        clockJumpBack();
        clockJumpForward5h();
        fsyncPoints();
        twoInstallIds();
        factsAndRowShape();
        bytesPerHour();
        teeGettersAndFailingSegment();
        teeOpenFailureRetries();
        closeIsFinal();
        factClamp();
        lastZOnReopen();
        failingStreamNoDuplicates();
        stopInsideBackoff();
        for (File d : made) deleteTree(d);
        System.out.println();
        System.out.println(passes + " passed, " + failures + " failed");
        System.exit(failures == 0 ? 0 : 1);
    }

    static void rollAtHour() throws Exception {
        File dir = freshDir("roll");
        Log log = new Log();
        FakeClock c = new FakeClock(ms("2026-10-09T06:59:30Z"));
        SegmentWriter w = writer(dir, "abc123", c, UTC, log);
        long sid = c.wall;
        w.appendSession(sid, "start", c.wall);
        hrEverySecond(w, c, 61);
        w.close();
        File[] fs = segFiles(dir);
        check("roll: two segments across the hour", fs.length == 2, Arrays.toString(fs));
        if (fs.length != 2) return;
        check("roll: names are the UTC hours", fs[0].getName().equals("hrm_20261009T06Z_abc123.csv")
            && fs[1].getName().equals("hrm_20261009T07Z_abc123.csv"), fs[0].getName() + " " + fs[1].getName());
        List<String> a = lines(fs[0]), b = lines(fs[1]);
        check("roll: header line 1 in both", a.get(0).startsWith("#hrm,v=2,") && b.get(0).startsWith("#hrm,v=2,"));
        check("roll: second segment line 2 is g,<t>,<id>,cont", b.get(1).equals("g,0," + sid + ",cont"), b.get(1));
        int hRows = 0;
        List<Long> eps = new ArrayList<>();
        for (File f : fs) {
            List<String> ls = lines(f);
            long base = headerBase(ls.get(0));
            for (String l : ls) if (l.startsWith("h,")) { hRows++; eps.add(base + Long.parseLong(l.split(",")[1])); }
        }
        check("roll: no lost row (61 h rows)", hRows == 61, "got " + hRows);
        long maxGap = 0;
        for (int i = 1; i < eps.size(); i++) maxGap = Math.max(maxGap, eps.get(i) - eps.get(i - 1));
        check("roll: largest ep gap across the boundary <= 3 s", maxGap <= 3000, "max " + maxGap);
        check("roll: base of each file is its UTC hour", headerBase(a.get(0)) == ms("2026-10-09T06:00:00Z")
            && headerBase(b.get(0)) == ms("2026-10-09T07:00:00Z"));
        check("roll: segment_roll logged", log.has("segment_roll from=hrm_20261009T06Z_abc123.csv to=hrm_20261009T07Z_abc123.csv"),
            String.join(" | ", log.lines));
        check("roll: rows well formed", badRows(fs[0]).isEmpty() && badRows(fs[1]).isEmpty(),
            badRows(fs[0]) + " " + badRows(fs[1]));
    }

    static void rollTimerOpensNothing() throws Exception {
        File dir = freshDir("timer");
        Log log = new Log();
        FakeClock c = new FakeClock(ms("2026-10-09T06:59:50Z"));
        SegmentWriter w = writer(dir, "abc123", c, UTC, log);
        long sid = c.wall;
        w.appendSession(sid, "start", c.wall);
        c.advance(12_000);
        w.rollIfDue(c.wall);
        check("timer: rollIfDue closes the past hour", !w.isOpen());
        check("timer: rollIfDue opens nothing", segFiles(dir).length == 1);
        c.advance(60_000);
        w.appendHr(77, 40.0, 0, 0, 0, new int[] { 780 }, c.wall);
        File[] fs = segFiles(dir);
        check("timer: next row opens its hour with g,cont", fs.length == 2 && lines(fs[1]).get(1).equals("g,0," + sid + ",cont"),
            fs.length == 2 ? lines(fs[1]).toString() : Arrays.toString(fs));
        w.close();
    }

    static void dstEdmonton() throws Exception {
        File dir = freshDir("dst");
        Log log = new Log();
        // 2026-11-01: 02:00 MDT becomes 01:00 MST at 08:00Z; local 01:00 to 02:00 happens twice.
        FakeClock c = new FakeClock(ms("2026-11-01T06:30:00Z"));
        SegmentWriter w = writer(dir, "abc123", c, EDMONTON, log);
        w.appendSession(c.wall, "start", c.wall);
        for (int i = 0; i < 120; i++) {
            w.appendHr(70, 50.0, 0, 0, 0, new int[] { 850 }, c.wall);
            w.checkOffset(c.wall);
            c.advance(60_000);
        }
        w.close();
        File[] fs = segFiles(dir);
        List<String> names = new ArrayList<>();
        for (File f : fs) names.add(f.getName());
        check("dst: three distinct UTC names T06Z T07Z T08Z", names.equals(Arrays.asList(
            "hrm_20261101T06Z_abc123.csv", "hrm_20261101T07Z_abc123.csv", "hrm_20261101T08Z_abc123.csv")), names.toString());
        int z = 0;
        String zRow = null;
        for (File f : fs) for (String l : lines(f)) if (l.startsWith("z,")) { z++; zRow = f.getName() + ":" + l; }
        check("dst: exactly one z row", z == 1, "got " + z + " " + zRow);
        check("dst: z is -420 in the T08Z segment", zRow != null && zRow.startsWith("hrm_20261101T08Z") && zRow.endsWith(",-420"), zRow);
        if (fs.length == 3) {
            check("dst: header tz -360, -360, -420", headerTz(lines(fs[0]).get(0)) == -360
                && headerTz(lines(fs[1]).get(0)) == -360 && headerTz(lines(fs[2]).get(0)) == -420);
        }
    }

    static void reopenAppends() throws Exception {
        File dir = freshDir("reopen");
        Log log = new Log();
        FakeClock c = new FakeClock(ms("2026-10-09T10:05:00Z"));
        SegmentWriter w = writer(dir, "abc123", c, UTC, log);
        w.appendSession(c.wall, "start", c.wall);
        hrEverySecond(w, c, 10);
        w.close();
        long sizeBefore = segFiles(dir)[0].length();
        SegmentWriter w2 = writer(dir, "abc123", c, UTC, log);
        w2.appendSession(c.wall - 15_000, "resume", c.wall);
        hrEverySecond(w2, c, 5);
        w2.close();
        File[] fs = segFiles(dir);
        check("reopen: same hour, same file", fs.length == 1);
        List<String> ls = lines(fs[0]);
        int headers = 0;
        for (String l : ls) if (l.startsWith("#hrm")) headers++;
        check("reopen: one header", headers == 1, "got " + headers);
        check("reopen: appended, not rewritten", fs[0].length() > sizeBefore && ls.size() == 1 + 1 + 10 + 1 + 5,
            "lines " + ls.size());
        check("reopen: logged append=true trim=0", log.has("segment_open name=hrm_20261009T10Z_abc123.csv append=true trim=0"));
    }

    static void partialLastLineTrimmed() throws Exception {
        File dir = freshDir("trim");
        Log log = new Log();
        FakeClock c = new FakeClock(ms("2026-10-09T11:05:00Z"));
        SegmentWriter w = writer(dir, "abc123", c, UTC, log);
        w.appendSession(c.wall, "start", c.wall);
        hrEverySecond(w, c, 5);
        w.close();
        File f = segFiles(dir)[0];
        long good = f.length();
        Files.write(f.toPath(), "h,306000,8".getBytes(StandardCharsets.UTF_8), java.nio.file.StandardOpenOption.APPEND);
        SegmentWriter w2 = writer(dir, "abc123", c, UTC, log);
        check("trim: reopen truncates to the last LF", f.length() == good, f.length() + " vs " + good);
        check("trim: segment_trim bytes=10 logged", log.has("segment_trim bytes=10"), String.join(" | ", log.lines));
        w2.appendHr(90, 30.0, 0, 0, 0, new int[] { 666 }, c.wall);
        w2.close();
        String s = read(f);
        check("trim: no broken row kept", !s.contains("h,306000,8\n") && !s.contains("h,306000,8h,"), "");
        check("trim: file ends with LF", s.endsWith("\n"));
        check("trim: every row well formed", badRows(f).isEmpty(), badRows(f).toString());
    }

    static void headerOnlyPartialRestarts() throws Exception {
        File dir = freshDir("hdrpartial");
        Log log = new Log();
        FakeClock c = new FakeClock(ms("2026-10-09T12:05:00Z"));
        File f = new File(dir, SegmentWriter.nameFor(ms("2026-10-09T12:00:00Z"), "abc123"));
        Files.write(f.toPath(), "#hrm,v=2,base=17".getBytes(StandardCharsets.UTF_8));
        SegmentWriter w = writer(dir, "abc123", c, UTC, log);
        w.appendHr(70, null, 0, 0, 0, null, c.wall);
        w.close();
        List<String> ls = lines(f);
        check("header partial: restarted with a full header", ls.size() == 2 && ls.get(0).startsWith("#hrm,v=2,base=" + ms("2026-10-09T12:00:00Z") + ","),
            ls.toString());
        check("header partial: logged append=false", log.has("segment_open name=" + f.getName() + " append=false trim=16"),
            String.join(" | ", log.lines));
    }

    static void badHeaderMovedAside() throws Exception {
        File dir = freshDir("bad");
        Log log = new Log();
        FakeClock c = new FakeClock(ms("2026-10-09T13:05:00Z"));
        File f = new File(dir, SegmentWriter.nameFor(ms("2026-10-09T13:00:00Z"), "abc123"));
        Files.write(f.toPath(), "not a header\nh,1,2,3,4\n".getBytes(StandardCharsets.UTF_8));
        SegmentWriter w = writer(dir, "abc123", c, UTC, log);
        w.close();
        File[] bad = dir.listFiles((d, n) -> n.startsWith(f.getName() + ".bad-"));
        check("bad header: moved to <name>.bad-<ms>", bad != null && bad.length == 1);
        check("bad header: moved file kept intact", bad != null && bad.length == 1 && read(bad[0]).equals("not a header\nh,1,2,3,4\n"));
        check("bad header: fresh file has a v2 header", lines(f).get(0).startsWith("#hrm,v=2,"));
        check("bad header: logged", log.has("segment_bad name=" + f.getName()));
    }

    static void clockJumpBack() throws Exception {
        File dir = freshDir("jumpback");
        Log log = new Log();
        FakeClock c = new FakeClock(ms("2026-10-09T14:30:00Z"));
        SegmentWriter w = writer(dir, "abc123", c, UTC, log);
        w.appendSession(c.wall, "start", c.wall);
        hrEverySecond(w, c, 3);
        long before = c.wall;
        c.wall -= 2 * 3_600_000L;
        c.mono += 1000;
        w.appendHr(70, 50.0, 0, 0, 0, new int[] { 850 }, c.wall);
        hrEverySecond(w, c, 3);
        w.close();
        File[] fs = segFiles(dir);
        check("jump back: no older file opened", fs.length == 1, Arrays.toString(fs));
        List<String> ls = lines(fs[0]);
        String k = null;
        for (String l : ls) if (l.startsWith("k,")) k = l;
        check("jump back: k row written with the previous clock's epoch", k != null && k.endsWith("," + (before + 1000)), k);
        check("jump back: later rows have negative t", ls.get(ls.size() - 1).startsWith("h,-"), ls.get(ls.size() - 1));
        check("jump back: rows well formed", badRows(fs[0]).isEmpty(), badRows(fs[0]).toString());
    }

    static void clockJumpForward5h() throws Exception {
        File dir = freshDir("jumpfwd");
        Log log = new Log();
        FakeClock c = new FakeClock(ms("2026-10-09T15:30:00Z"));
        SegmentWriter w = writer(dir, "abc123", c, UTC, log);
        w.appendSession(c.wall, "start", c.wall);
        hrEverySecond(w, c, 3);
        c.wall += 5 * 3_600_000L;
        c.mono += 1000;
        hrEverySecond(w, c, 3);
        w.close();
        File[] fs = segFiles(dir);
        check("jump forward 5 h: one new file, not five", fs.length == 2
            && fs[1].getName().equals("hrm_20261009T20Z_abc123.csv"), Arrays.toString(fs));
        int k = 0;
        for (File f : fs) for (String l : lines(f)) if (l.startsWith("k,")) k++;
        check("jump forward 5 h: one k row", k == 1, "got " + k);
    }

    static void fsyncPoints() throws Exception {
        File dir = freshDir("fsync");
        Log log = new Log();
        FakeClock c = new FakeClock(ms("2026-10-09T16:59:58Z"));
        SegmentWriter w = writer(dir, "abc123", c, UTC, log);
        long s0 = w.getSyncCount();
        w.appendHr(70, null, 0, 0, 0, null, c.wall);
        check("fsync: not on an h row", w.getSyncCount() == s0);
        w.appendSession(c.wall, "start", c.wall);
        long s1 = w.getSyncCount();
        check("fsync: on a g row", s1 > s0);
        w.appendConnection("connected", c.wall);
        long s2 = w.getSyncCount();
        check("fsync: on a c row", s2 > s1);
        c.advance(3000);
        w.appendHr(70, null, 0, 0, 0, null, c.wall);
        check("fsync: on roll", w.getSyncCount() > s2);
        long s3 = w.getSyncCount();
        c.advance(301_000);
        w.appendHr(70, null, 0, 0, 0, null, c.wall);
        check("fsync: every 5 minutes", w.getSyncCount() > s3);
        long s4 = w.getSyncCount();
        w.close();
        check("fsync: on close", w.getSyncCount() > s4);
    }

    static void twoInstallIds() throws Exception {
        File dir = freshDir("iids");
        Log log = new Log();
        FakeClock c = new FakeClock(ms("2026-10-09T18:10:00Z"));
        SegmentWriter a = writer(dir, "aaaaaa", c, UTC, log);
        SegmentWriter b = writer(dir, "bbbbbb", c, UTC, log);
        a.appendHr(70, null, 0, 0, 0, null, c.wall);
        b.appendHr(71, null, 0, 0, 0, null, c.wall);
        a.close();
        b.close();
        File[] fs = segFiles(dir);
        check("two install ids: two names for one hour", fs.length == 2
            && !fs[0].getName().equals(fs[1].getName()), Arrays.toString(fs));
        boolean threw = false;
        try { writer(dir, "BAD", c, UTC, log); } catch (IOException e) { threw = true; }
        check("install id must be [a-z0-9]{6}", threw);
    }

    static void factsAndRowShape() throws Exception {
        File dir = freshDir("facts");
        Log log = new Log();
        FakeClock c = new FakeClock(ms("2026-10-09T19:10:00Z"));
        SegmentWriter w = writer(dir, "abc123", c, UTC, log);
        long sid = c.wall;
        w.appendSession(sid, "start", c.wall);
        w.appendHr(88, null, 1, 2, 3, null, c.wall);
        w.appendHr(89, 42.123, 1, 2, 3, new int[] { 700, 702, 698 }, c.wall + 1);
        w.appendConnection("disconnected", c.wall + 2);
        String longLabel = "a,b\nc\rd" + "x".repeat(200);
        check("fact e accepted", w.writeFact("e", new String[] { longLabel }, c.wall + 3));
        check("fact p accepted", w.writeFact("p", new String[] { "standing", "btn" }, c.wall + 4));
        check("fact s accepted", w.writeFact("s", new String[] { "dizzy" }, c.wall + 5));
        check("fact w accepted", w.writeFact("w", new String[] { "warn-palp", "5" }, c.wall + 6));
        check("fact x accepted", w.writeFact("x", new String[0], c.wall + 7));
        check("fact z refused (writer-only kind)", !w.writeFact("z", new String[] { "60" }, c.wall + 8));
        check("fact unknown refused", !w.writeFact("q", new String[] { "1" }, c.wall + 8));
        w.appendSession(sid, "stop", c.wall + 9);
        w.close();
        File f = segFiles(dir)[0];
        List<String> ls = lines(f);
        String header = ls.get(0);
        check("header fields in order", header.matches("#hrm,v=2,base=-?\\d+,tz=-?\\d+,app=1\\.2\\.3,dev=808S 0025153,flavour=personal"), header);
        check("no time_min anywhere", !read(f).contains("time_min"));
        check("g start row", ls.get(1).equals("g,600000," + sid + ",start"), ls.get(1));
        check("h with null rmssd and no rr", ls.get(2).equals("h,600000,88,,"), ls.get(2));
        check("h with rmssd %.2f and rr joined by ;", ls.get(3).equals("h,600001,89,42.12,700;702;698"), ls.get(3));
        check("c row", ls.get(4).equals("c,600002,disconnected"), ls.get(4));
        String e = ls.get(5);
        check("e label sanitized to 80 chars, no comma or line break", e.startsWith("e,600003,a b c d")
            && e.length() == "e,600003,".length() + 80 && e.split(",", -1).length == 3, e);
        check("p row", ls.get(6).equals("p,600004,standing,btn"), ls.get(6));
        check("s row", ls.get(7).equals("s,600005,dizzy"), ls.get(7));
        check("w row", ls.get(8).equals("w,600006,warn-palp,5"), ls.get(8));
        check("x row has no fields", ls.get(9).equals("x,600007"), ls.get(9));
        check("g stop row", ls.get(10).equals("g,600009," + sid + ",stop"), ls.get(10));
        check("every row well formed", badRows(f).isEmpty(), badRows(f).toString());
        check("UTF-8, LF only, no BOM", !read(f).contains("\r") && Files.readAllBytes(f.toPath())[0] == '#');
    }

    static void bytesPerHour() throws Exception {
        File dir = freshDir("size");
        Log log = new Log();
        FakeClock c = new FakeClock(ms("2026-10-09T21:00:00Z"));
        SegmentWriter w = writer(dir, "abc123", c, UTC, log);
        w.appendSession(c.wall, "start", c.wall);
        for (int i = 0; i < 2800; i++) {
            int[] rr = (i % 3 == 0) ? new int[] { 812, 790 } : new int[] { 801 };
            w.appendHr(72 + (i % 30), 35.5 + (i % 7), 0, 0, 0, rr, c.wall);
            c.advance(1285);
        }
        w.close();
        long bytes = segFiles(dir)[0].length();
        System.out.println("INFO  bytes per recorded hour (2,800 h rows): " + bytes + " (" + (bytes / 1024) + " KB)");
        check("bytes per hour under 100 KB", bytes < 100 * 1024, String.valueOf(bytes));
    }

    static final class FakeLegacy implements HrSink {
        final List<String> calls = new ArrayList<>();
        final File file = new File("hrv_session_2026-10-09T10-00-00.000.csv");
        public void appendHr(int hr, Double r, double a, double b, double c, int[] rr, long ts) {
            calls.add("hr " + hr + " sdnn " + a + "/" + b + "/" + c);
        }
        public void appendConnection(String s, long ts) { calls.add("c " + s); }
        public void appendFact(String k, String[] f, long ts) { calls.add("fact " + k); }
        public void appendSession(long id, String w, long ts) { calls.add("g " + w); }
        public void close() { calls.add("close"); }
        public File getFile() { return file; }
        public String getFilename() { return file.getName(); }
        public long getSessionStartMs() { return 1234L; }
        public int getConsecutiveFailures() { return 7; }
        public int getTotalFailures() { return 9; }
    }

    static final class ThrowingSegment extends SegmentWriter {
        ThrowingSegment(File dir, FakeClock c, Log log) throws IOException {
            super(dir, "thrwng", c, UTC, "1", "d", "personal", log);
        }
        @Override public synchronized void appendHr(int hr, Double r, double a, double b, double c, int[] rr, long ts) {
            throw new IllegalStateException("boom");
        }
        @Override public synchronized void appendConnection(String s, long ts) { throw new IllegalStateException("boom"); }
    }

    static void teeGettersAndFailingSegment() throws Exception {
        File dir = freshDir("tee");
        Log log = new Log();
        FakeClock c = new FakeClock(ms("2026-10-09T22:10:00Z"));
        FakeLegacy legacy = new FakeLegacy();
        SegmentWriter seg = writer(dir, "abc123", c, UTC, log);
        TeeSink tee = new TeeSink(legacy, seg, null, c, log);
        check("tee getFile is the legacy file", tee.getFile() == legacy.file);
        check("tee getFilename is the legacy name", tee.getFilename().equals(legacy.getFilename()));
        check("tee getSessionStartMs is legacy's", tee.getSessionStartMs() == 1234L);
        check("tee failure counts are legacy's", tee.getConsecutiveFailures() == 7 && tee.getTotalFailures() == 9);
        tee.appendHr(80, 40.0, 11.5, 22.5, 33.5, new int[] { 750 }, c.wall);
        check("tee keeps legacy SDNN", legacy.calls.contains("hr 80 sdnn 11.5/22.5/33.5"), legacy.calls.toString());
        tee.close();
        check("tee writes the segment too", read(seg.getFile()).contains("\nh,600000,80,40.00,750\n"));
        check("tee close closes both sides", legacy.calls.contains("close") && !seg.isOpen());

        FakeLegacy legacy2 = new FakeLegacy();
        ThrowingSegment bad = new ThrowingSegment(freshDir("tee2"), c, log);
        TeeSink tee2 = new TeeSink(legacy2, bad, null, c, log);
        boolean escaped = false;
        try {
            tee2.appendHr(81, null, 1, 2, 3, null, c.wall);
            tee2.appendConnection("connected", c.wall);
        } catch (Throwable t) { escaped = true; }
        check("tee: a throwing segment never reaches the caller", !escaped);
        check("tee: legacy still gets every row when the segment throws",
            legacy2.calls.contains("hr 81 sdnn 1.0/2.0/3.0") && legacy2.calls.contains("c connected"), legacy2.calls.toString());
        check("tee: segment throw logged", log.has("tee_segment_throw"));
        tee2.close();
    }

    static void teeOpenFailureRetries() throws Exception {
        File dir = freshDir("teeretry");
        Log log = new Log();
        FakeClock c = new FakeClock(ms("2026-10-09T23:10:00Z"));
        FakeLegacy legacy = new FakeLegacy();
        int[] attempts = { 0 };
        TeeSink.SegmentOpener opener = () -> {
            attempts[0]++;
            if (c.wall < ms("2026-10-10T00:00:00Z")) throw new IOException("disk");
            return writer(dir, "abc123", c, UTC, log);
        };
        TeeSink tee = new TeeSink(legacy, null, opener, c, log);
        long sid = c.wall;
        tee.appendSession(sid, "start", c.wall);
        tee.appendHr(70, null, 0, 0, 0, null, c.wall);
        check("open failure: legacy keeps recording", legacy.calls.contains("g start") && legacy.calls.size() == 2, legacy.calls.toString());
        check("open failure: no retry inside the failed hour", attempts[0] == 0, "attempts " + attempts[0]);
        check("open failure: tee getters still legacy", tee.getFilename().equals(legacy.getFilename()));
        c.advance(3_600_000L);
        tee.appendHr(71, null, 0, 0, 0, null, c.wall);
        check("open failure: a later hour retries and opens", attempts[0] == 1 && tee.hasSegment(), "attempts " + attempts[0]);
        tee.close();
        File[] fs = segFiles(dir);
        check("open failure: retried segment starts g,cont then the row", fs.length == 1
            && lines(fs[0]).get(1).equals("g,600000," + sid + ",cont") && lines(fs[0]).get(2).startsWith("h,600000,71,"),
            fs.length == 1 ? lines(fs[0]).toString() : Arrays.toString(fs));
    }

    static void closeIsFinal() throws Exception {
        File dir = freshDir("closed");
        Log log = new Log();
        FakeClock c = new FakeClock(ms("2026-10-10T01:10:00Z"));
        SegmentWriter w = writer(dir, "abc123", c, UTC, log);
        w.appendSession(c.wall, "start", c.wall);
        w.appendHr(70, null, 0, 0, 0, null, c.wall);
        w.close();
        File f = segFiles(dir)[0];
        long size = f.length();
        w.appendHr(71, null, 0, 0, 0, null, c.wall);
        check("close is final: a fact after close writes nothing", !w.writeFact("e", new String[] { "late" }, c.wall));
        c.advance(3_600_000L);
        w.appendHr(72, null, 0, 0, 0, null, c.wall);
        w.appendConnection("disconnected", c.wall);
        w.rollIfDue(c.wall);
        w.checkOffset(c.wall);
        check("close is final: writer adds no bytes after close", f.length() == size, f.length() + " vs " + size);
        check("close is final: writer opens no file after close", segFiles(dir).length == 1, Arrays.toString(segFiles(dir)));

        File dir2 = freshDir("closedtee");
        int[] opens = { 0 };
        FakeLegacy legacy = new FakeLegacy();
        TeeSink tee = new TeeSink(legacy, null, () -> { opens[0]++; return writer(dir2, "abc123", c, UTC, log); }, c, log);
        tee.close();
        c.advance(3_600_000L);
        tee.appendHr(73, null, 0, 0, 0, null, c.wall);
        boolean wrote = tee.writeFact("e", new String[] { "late" }, c.wall);
        tee.appendSession(1L, "start", c.wall);
        check("close is final: tee never reopens a segment after close", opens[0] == 0 && !tee.hasSegment() && !wrote
            && segFiles(dir2).length == 0, "opens " + opens[0]);
    }

    static void factClamp() throws Exception {
        long now = ms("2026-10-10T02:10:00Z");
        check("clamp: 50 h ahead becomes now", SegmentWriter.clampFactTs(now + 50L * 3_600_000L, now) == now);
        check("clamp: 16 min back becomes now", SegmentWriter.clampFactTs(now - 16L * 60_000L, now) == now);
        check("clamp: 14 min back is kept", SegmentWriter.clampFactTs(now - 14L * 60_000L, now) == now - 14L * 60_000L);
        check("clamp: 4 s ahead is kept", SegmentWriter.clampFactTs(now + 4_000L, now) == now + 4_000L);
        check("clamp: 6 s ahead becomes now", SegmentWriter.clampFactTs(now + 6_000L, now) == now);
        File dir = freshDir("clamp");
        Log log = new Log();
        FakeClock c = new FakeClock(now);
        SegmentWriter w = writer(dir, "abc123", c, UTC, log);
        w.writeFact("e", new String[] { "far" }, SegmentWriter.clampFactTs(now + 50L * 3_600_000L, now));
        w.close();
        File[] fs = segFiles(dir);
        check("clamp: a fact 50 h ahead lands in the current hour", fs.length == 1
            && fs[0].getName().equals("hrm_20261010T02Z_abc123.csv") && lines(fs[0]).get(1).equals("e,600000,far"),
            fs.length == 1 ? lines(fs[0]).toString() : Arrays.toString(fs));
    }

    static void lastZOnReopen() throws Exception {
        File dir = freshDir("lastz");
        Log log = new Log();
        FakeClock c = new FakeClock(ms("2026-10-10T03:10:00Z"));
        int[] off = { 0 };
        TzSource tz = ms -> off[0];
        SegmentWriter w = writer(dir, "abc123", c, tz, log);
        w.appendHr(70, null, 0, 0, 0, null, c.wall);
        off[0] = -360;
        c.advance(1000);
        w.checkOffset(c.wall);
        w.appendHr(71, null, 0, 0, 0, null, c.wall);
        w.close();
        c.advance(1000);
        SegmentWriter w2 = writer(dir, "abc123", c, tz, log);
        w2.appendHr(72, null, 0, 0, 0, null, c.wall);
        w2.close();
        File f = segFiles(dir)[0];
        int z = 0;
        for (String l : lines(f)) if (l.startsWith("z,")) z++;
        check("reopen: offset compared with the last z row, not the header (one z)", z == 1, "got " + z + " " + lines(f));
        off[0] = 60;
        c.advance(1000);
        SegmentWriter w3 = writer(dir, "abc123", c, tz, log);
        w3.close();
        z = 0;
        String last = null;
        for (String l : lines(f)) if (l.startsWith("z,")) { z++; last = l; }
        check("reopen: a real change since the last z row still writes z", z == 2 && last.endsWith(",60"), "got " + z + " " + last);
    }

    // Writes half of each block and then fails while FAIL is set, like a disk that fills mid-write.
    static volatile boolean FAIL = false;

    static final class HalfFailingStream extends FileOutputStream {
        HalfFailingStream(File f, boolean append) throws IOException { super(f, append); }
        @Override public void write(byte[] b, int off, int len) throws IOException {
            if (FAIL) {
                super.write(b, off, len / 2);
                throw new IOException("ENOSPC");
            }
            super.write(b, off, len);
        }
        @Override public void write(int b) throws IOException {
            if (FAIL) throw new IOException("ENOSPC");
            super.write(b);
        }
    }

    static final class FailingWriter extends SegmentWriter {
        FailingWriter(File dir, FakeClock c, Log log) throws IOException {
            super(dir, "abc123", c, UTC, "1", "d", "personal", log);
        }
        @Override protected FileOutputStream openStream(File f, boolean append) throws IOException {
            return new HalfFailingStream(f, append);
        }
    }

    static void failingStreamNoDuplicates() throws Exception {
        File dir = freshDir("enospc");
        Log log = new Log();
        FakeClock c = new FakeClock(ms("2026-10-10T04:10:00Z"));
        FAIL = false;
        FailingWriter w = new FailingWriter(dir, c, log);
        long sid = c.wall;
        w.appendSession(sid, "start", c.wall);
        for (int i = 0; i < 10; i++) { w.appendHr(60 + i, null, 0, 0, 0, null, c.wall); c.advance(1000); }
        FAIL = true;
        w.appendConnection("disconnected", c.wall);
        c.advance(1000);
        w.appendHr(90, null, 0, 0, 0, null, c.wall);
        FAIL = false;
        c.advance(31_000);
        for (int i = 0; i < 5; i++) { w.appendHr(100 + i, null, 0, 0, 0, null, c.wall); c.advance(1000); }
        w.close();
        File f = segFiles(dir)[0];
        List<String> ls = lines(f);
        java.util.Set<String> seen = new java.util.HashSet<>();
        List<String> dups = new ArrayList<>();
        for (String l : ls) if (l.startsWith("h,") && !seen.add(l)) dups.add(l);
        check("ENOSPC: stream dropped after the failed write", log.has("segment_drop name=" + f.getName()), String.join(" | ", log.lines));
        check("ENOSPC: reopened in append with the partial tail trimmed", log.count("segment_open name=" + f.getName() + " append=true trim=") == 1
            && !log.has("segment_open name=" + f.getName() + " append=true trim=0"), String.join(" | ", log.lines));
        check("ENOSPC: no row written twice", dups.isEmpty(), dups.toString());
        check("ENOSPC: every row well formed", badRows(f).isEmpty(), badRows(f).toString());
        check("ENOSPC: rows after recovery are on disk", ls.get(ls.size() - 1).startsWith("h,") && ls.get(ls.size() - 1).contains(",104,"),
            ls.get(ls.size() - 1));
    }

    static void stopInsideBackoff() throws Exception {
        File dir = freshDir("backoff");
        Log log = new Log();
        FakeClock c = new FakeClock(ms("2026-10-10T05:10:00Z"));
        FAIL = false;
        FailingWriter w = new FailingWriter(dir, c, log);
        long sid = c.wall;
        w.appendSession(sid, "start", c.wall);
        w.appendHr(70, null, 0, 0, 0, null, c.wall);
        FAIL = true;
        c.advance(1000);
        w.appendConnection("disconnected", c.wall);
        FAIL = false;
        for (int i = 0; i < 3; i++) { c.advance(1000); w.appendHr(80 + i, null, 0, 0, 0, null, c.wall); }
        c.advance(1000);
        long stopT = c.wall - ms("2026-10-10T05:00:00Z");
        w.appendSession(sid, "stop", c.wall);
        w.close();
        File f = segFiles(dir)[0];
        List<String> ls = lines(f);
        check("backoff: refused rows counted and logged as segment_skip", log.has("segment_skip n=3"), String.join(" | ", log.lines));
        check("backoff: a stop inside the backoff still reaches disk", ls.get(ls.size() - 1).equals("g," + stopT + "," + sid + ",stop"),
            ls.get(ls.size() - 1));
        check("backoff: rows well formed", badRows(f).isEmpty(), badRows(f).toString());
    }
}
