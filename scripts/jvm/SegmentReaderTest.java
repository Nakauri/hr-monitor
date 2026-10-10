// Plain-JDK test of SegmentReader and the open-segment length snapshot (B-b2). No Android, no Gradle.
// Run: node scripts/jvm/run-segment-test.cjs   (runs SegmentWriterTest and this, then the negative controls)
// Guards: K10 a reader never sees a partial row; the open segment is read only to the length captured
// under the writer lock while writes continue; a request name never leaves the segments folder.

import com.nakauri.hrmonitor.Clock;
import com.nakauri.hrmonitor.HrSink;
import com.nakauri.hrmonitor.LifecycleLog;
import com.nakauri.hrmonitor.SegmentReader;
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
import java.util.List;

public class SegmentReaderTest {
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

    static final LifecycleLog NOLOG = e -> { };
    static final TzSource UTC = ms -> 0;

    static final class NullSink implements HrSink {
        public void appendHr(int hr, Double rmssd, double a, double b, double c, int[] rr, long ts) { }
        public void appendConnection(String s, long ts) { }
        public void appendFact(String k, String[] f, long ts) { }
        public void appendSession(long id, String w, long ts) { }
        public void close() { }
        public File getFile() { return null; }
        public String getFilename() { return null; }
        public long getSessionStartMs() { return 0L; }
        public int getConsecutiveFailures() { return 0; }
        public int getTotalFailures() { return 0; }
    }

    static final List<File> made = new ArrayList<>();
    static File freshDir(String name) throws IOException {
        File d = Files.createTempDirectory("segread-" + name).toFile();
        made.add(d);
        return d;
    }
    static void deleteTree(File f) {
        File[] kids = f.listFiles();
        if (kids != null) for (File k : kids) deleteTree(k);
        f.delete();
    }
    static long ms(String iso) { return Instant.parse(iso).toEpochMilli(); }

    static SegmentReader.OpenSegment view(TeeSink tee) {
        return new SegmentReader.OpenSegment() {
            public String openName() { return tee.openSegmentName(); }
            public long readableLength(String name) { return tee.segmentReadableLength(name); }
        };
    }

    static int count(String text, String prefix) {
        int n = 0;
        for (String l : text.split("\n", -1)) if (l.startsWith(prefix)) n++;
        return n;
    }

    static void hr(TeeSink tee, FakeClock c, int n) {
        for (int i = 0; i < n; i++) {
            c.advance(1000);
            tee.appendHr(70 + i % 10, 42.0, 0, 0, 0, new int[] { 850 }, c.wall);
        }
    }

    public static void main(String[] args) throws Exception {
        try {
            openSnapshot();
            closedAndPartial();
            names();
            window();
            bounded();
        } finally {
            for (File d : made) deleteTree(d);
        }
        System.out.println();
        System.out.println(passes + " passed, " + failures + " failed");
        System.exit(failures == 0 ? 0 : 1);
    }

    // Rows still in the writer's buffer are flushed by the snapshot; rows written after it are not read.
    static void openSnapshot() throws Exception {
        File dir = freshDir("open");
        FakeClock c = new FakeClock(ms("2026-10-10T03:00:05Z"));
        SegmentWriter w = new SegmentWriter(dir, "abc123", c, UTC, "1.2.3", "dev", "personal", NOLOG);
        TeeSink tee = new TeeSink(new NullSink(), w, null, c, NOLOG);
        tee.appendSession(1791601205000L, "start", c.wall);
        hr(tee, c, 10);
        String name = tee.openSegmentName();
        File f = new File(dir, name);
        long onDiskBefore = f.length();

        SegmentReader.Read r = SegmentReader.read(dir, name, view(tee), SegmentReader.MAX_READ_BYTES);
        check("open: snapshot flushes buffered rows (10 h rows read)", count(r.text, "h,") == 10,
            "h=" + count(r.text, "h,") + " onDiskBefore=" + onDiskBefore);
        check("open: reported open", r.open);
        check("open: text ends at an LF", r.text.endsWith("\n"));
        check("open: size is the text's byte length", r.size == r.text.getBytes(StandardCharsets.UTF_8).length);

        // Capture the length, then the writer adds 5 rows and flushes them before the bytes are read.
        final long[] captured = { -1L };
        SegmentReader.OpenSegment racing = new SegmentReader.OpenSegment() {
            public String openName() { return tee.openSegmentName(); }
            public long readableLength(String n) {
                captured[0] = tee.segmentReadableLength(n);
                hr(tee, c, 5);
                tee.segmentReadableLength(n);
                return captured[0];
            }
        };
        SegmentReader.Read r2 = SegmentReader.read(dir, name, racing, SegmentReader.MAX_READ_BYTES);
        check("open: read stops at the captured length while writes continue", count(r2.text, "h,") == 10 && r2.size == captured[0],
            "h=" + count(r2.text, "h,") + " size=" + r2.size + " captured=" + captured[0] + " file=" + f.length());

        List<SegmentReader.Entry> list = SegmentReader.list(dir, Long.MIN_VALUE, Long.MAX_VALUE, view(tee));
        check("open: listed once, flagged open, size equals the file", list.size() == 1 && list.get(0).open
            && list.get(0).size == f.length(), list.size() == 1 ? "size=" + list.get(0).size + " file=" + f.length() : "n=" + list.size());

        tee.close();
        SegmentReader.Read r3 = SegmentReader.read(dir, name, view(tee), SegmentReader.MAX_READ_BYTES);
        check("closed tee: read is not open and has all 15 rows", !r3.open && count(r3.text, "h,") == 15 && count(r3.text, "g,") == 1,
            "open=" + r3.open + " h=" + count(r3.text, "h,"));
    }

    // A crashed hour keeps a partial tail on disk; readers and the listing stop at the last LF.
    static void closedAndPartial() throws Exception {
        File dir = freshDir("partial");
        FakeClock c = new FakeClock(ms("2026-10-10T04:00:01Z"));
        SegmentWriter w = new SegmentWriter(dir, "abc123", c, UTC, "1.2.3", "dev", "personal", NOLOG);
        TeeSink tee = new TeeSink(new NullSink(), w, null, c, NOLOG);
        hr(tee, c, 4);
        String name = tee.openSegmentName();
        tee.close();
        File f = new File(dir, name);
        long full = f.length();
        try (FileOutputStream o = new FileOutputStream(f, true)) { o.write("h,9000,7".getBytes(StandardCharsets.US_ASCII)); }

        SegmentReader.Read r = SegmentReader.read(dir, name, null, SegmentReader.MAX_READ_BYTES);
        check("partial: read drops the unterminated last row", r.size == full && !r.text.contains("h,9000,7"),
            "size=" + r.size + " full=" + full);
        check("partial: read is not open", !r.open);
        List<SegmentReader.Entry> list = SegmentReader.list(dir, Long.MIN_VALUE, Long.MAX_VALUE, null);
        check("partial: listed size is the last-LF length", list.size() == 1 && list.get(0).size == full && !list.get(0).open,
            list.size() == 1 ? "size=" + list.get(0).size + " full=" + full + " raw=" + f.length() : "n=" + list.size());
        check("partial: base matches the name's hour", list.size() == 1 && list.get(0).base == ms("2026-10-10T04:00:00Z"));
    }

    static void names() throws Exception {
        File dir = freshDir("names");
        String[] bad = { null, "", "../hrm_20261010T01Z_abc123.csv", "hrm_20261010T01Z_abc123.csv/../../x",
            "hrv_session_2026-10-10T01-00-00.000.csv", "hrm_20261010T01Z_ABC123.csv", "hrm_20261010T01Z_abc123.csv.bad-1",
            "..\\hrm_20261010T01Z_abc123.csv" };
        boolean allRejected = true;
        String leak = "";
        for (String n : bad) {
            if (SegmentReader.validName(n)) { allRejected = false; leak += n + " "; continue; }
            try {
                SegmentReader.read(dir, n, null, 1024);
                allRejected = false;
                leak += n + " ";
            } catch (IOException e) {
                if (!"bad_name".equals(e.getMessage())) { allRejected = false; leak += n + "=" + e.getMessage() + " "; }
            }
        }
        check("names: traversal, legacy, upper-case and .bad names are refused with bad_name", allRejected, leak);
        check("names: a v2 name is accepted", SegmentReader.validName("hrm_20261010T01Z_abc123.csv"));
        boolean missing = false;
        try { SegmentReader.read(dir, "hrm_20261010T01Z_abc123.csv", null, 1024); }
        catch (IOException e) { missing = "not_found".equals(e.getMessage()); }
        check("names: an absent segment is not_found", missing);
    }

    // Hours starting in [hourStart(from), to), oldest first; other files in the folder are not segments.
    static void window() throws Exception {
        File dir = freshDir("window");
        FakeClock c = new FakeClock(ms("2026-10-10T05:00:01Z"));
        SegmentWriter w = new SegmentWriter(dir, "abc123", c, UTC, "1.2.3", "dev", "personal", NOLOG);
        TeeSink tee = new TeeSink(new NullSink(), w, null, c, NOLOG);
        hr(tee, c, 2);
        c.wall = ms("2026-10-10T06:00:01Z"); c.mono += 3_600_000L;
        hr(tee, c, 2);
        c.wall = ms("2026-10-10T07:00:01Z"); c.mono += 3_600_000L;
        hr(tee, c, 2);
        new File(dir, ".upload.json").createNewFile();
        new File(dir, "hrm_20261010T05Z_abc123.csv.bad-17").createNewFile();
        List<SegmentReader.Entry> all = SegmentReader.list(dir, Long.MIN_VALUE, Long.MAX_VALUE, view(tee));
        StringBuilder names = new StringBuilder();
        for (SegmentReader.Entry e : all) names.append(e.name).append(e.open ? "*" : "").append(' ');
        check("window: three segments, oldest first, only the 07Z one open",
            names.toString().equals("hrm_20261010T05Z_abc123.csv hrm_20261010T06Z_abc123.csv hrm_20261010T07Z_abc123.csv* "),
            names.toString());
        List<SegmentReader.Entry> mid = SegmentReader.list(dir, ms("2026-10-10T06:30:00Z"), ms("2026-10-10T07:00:00Z"), view(tee));
        check("window: from rounds down to its hour, to is exclusive", mid.size() == 1 && mid.get(0).name.equals("hrm_20261010T06Z_abc123.csv"),
            "n=" + mid.size());
        tee.close();
    }

    static void bounded() throws Exception {
        File dir = freshDir("bounded");
        FakeClock c = new FakeClock(ms("2026-10-10T08:00:01Z"));
        SegmentWriter w = new SegmentWriter(dir, "abc123", c, UTC, "1.2.3", "dev", "personal", NOLOG);
        TeeSink tee = new TeeSink(new NullSink(), w, null, c, NOLOG);
        hr(tee, c, 40);
        String name = tee.openSegmentName();
        tee.close();
        SegmentReader.Read r = SegmentReader.read(dir, name, null, 300);
        check("bounded: a read past the cap is flagged truncated and still ends at an LF",
            r.truncated && r.size <= 300 && r.text.endsWith("\n") && r.size > 0, "size=" + r.size + " truncated=" + r.truncated);
    }
}
