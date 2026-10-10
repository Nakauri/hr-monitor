// Plain-JDK integration test of SegmentUploader against an in-memory fake Drive. No Android, no network.
// Run: node scripts/jvm/run-upload-test.cjs   (runs UploadPlanTest and this, then the negative controls)
// Guards: B5 a timed-out create is never duplicated; K9 global name lookup over every page, oldest copy
// PATCHed, no parent filter; K10 bytes only to the last LF of the length snapshot; L1 a tick never waits
// for the lock; month-folder race converges on the oldest folder; signed out waits without retrying;
// a restarted segment's .bad bytes reach Drive under their own name before the restart is PATCHed.

import com.nakauri.hrmonitor.LifecycleLog;
import com.nakauri.hrmonitor.MiniJson;
import com.nakauri.hrmonitor.SegmentReader;
import com.nakauri.hrmonitor.SegmentUploader;
import com.nakauri.hrmonitor.SegmentUploader.Mode;
import com.nakauri.hrmonitor.SegmentUploader.Resp;
import com.nakauri.hrmonitor.SegmentUploader.Result;
import com.nakauri.hrmonitor.SegmentWriter;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.text.SimpleDateFormat;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.Comparator;
import java.util.Date;
import java.util.Deque;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.TimeZone;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

public class SegmentUploaderTest {
    static int failures = 0;
    static int passes = 0;

    static void check(String name, boolean ok, String detail) {
        if (ok) passes++; else failures++;
        System.out.println((ok ? "OK    " : "FAIL  ") + name + (detail != null && !detail.isEmpty() ? "  " + detail : ""));
    }
    static void check(String name, boolean ok) { check(name, ok, null); }

    static final String FOLDER = "application/vnd.google-apps.folder";
    static final String SEG_A = "hrm_20261009T14Z_abc123.csv";
    static final String SEG_B = "hrm_20261009T15Z_abc123.csv";
    static final String SEG_C = "hrm_20261009T16Z_abc123.csv";
    static final String SEG_NOV = "hrm_20261101T02Z_abc123.csv";

    // ---- fake Drive ----

    static final class DFile {
        String id, name, mime, created;
        List<String> parents = new ArrayList<>();
        byte[] data = new byte[0];
        boolean trashed;
    }

    static final Pattern Q_ROOT = Pattern.compile("^name='HR Monitor Sessions' and mimeType='" + FOLDER + "' and trashed=false$");
    static final Pattern Q_NAME = Pattern.compile("^name='((?:[^'\\\\]|\\\\.)+)' and trashed=false$");
    static final Pattern Q_MONTH = Pattern.compile("^name='(\\d{4}-\\d{2})' and '([^']+)' in parents and mimeType='" + FOLDER + "' and trashed=false$");
    static final Pattern Q_LEGACY = Pattern.compile("^'([^']+)' in parents and name contains 'hrv_session' and trashed=false$");

    static final class FakeDrive implements SegmentUploader.Http {
        final List<DFile> files = new CopyOnWriteArrayList<>();
        final Set<String> validTokens = Collections.synchronizedSet(new HashSet<>(Collections.singletonList("t1")));
        final List<String> calls = new CopyOnWriteArrayList<>();
        final List<String> violations = new CopyOnWriteArrayList<>();
        // method -> queued faults: an Integer status, "io" (nothing stored) or "io_commit" (stored, then the reply is lost).
        final Map<String, Deque<Object>> faults = new HashMap<>();
        int pageSize = 2;
        boolean honourOrder = true;
        long latencyMs = 0;
        int seq = 0;
        Runnable onFolderCreate;
        Runnable onFileCreate;
        CountDownLatch blockGets;     // when set, GET waits on it (holds the uploader inside a run)
        CountDownLatch enteredGet;

        synchronized String nextCreated() {
            seq++;
            SimpleDateFormat f = new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US);
            f.setTimeZone(TimeZone.getTimeZone("UTC"));
            return f.format(new Date(1_790_000_000_000L + seq * 1000L));
        }

        synchronized String nextId() { return "id" + (++seq); }

        DFile add(String name, String mime, String parent, byte[] data, String created) {
            DFile d = new DFile();
            d.id = nextId();
            d.name = name;
            d.mime = mime;
            if (parent != null) d.parents.add(parent);
            d.data = data != null ? data : new byte[0];
            d.created = created != null ? created : nextCreated();
            files.add(d);
            return d;
        }

        void fault(String method, Object f) { faults.computeIfAbsent(method, k -> new ArrayDeque<>()).add(f); }

        List<DFile> named(String name) {
            List<DFile> out = new ArrayList<>();
            for (DFile d : files) if (!d.trashed && d.name.equals(name)) out.add(d);
            return out;
        }

        DFile byId(String id) { for (DFile d : files) if (d.id.equals(id) && !d.trashed) return d; return null; }
        // Trashed or not: Drive accepts writes into a trashed folder and a PATCH to a trashed file.
        DFile byIdAny(String id) { for (DFile d : files) if (d.id.equals(id)) return d; return null; }
        Runnable onLegacyList;
        Runnable onEveryNameList;
        Runnable afterMeta;

        int count(String prefix) { int n = 0; for (String c : calls) if (c.startsWith(prefix)) n++; return n; }

        @Override
        public Resp send(String method, String url, String token, String contentType, byte[] body) throws IOException {
            if (latencyMs > 0) try { Thread.sleep(latencyMs); } catch (InterruptedException ignored) { }
            String path = url.contains("?") ? url.substring(0, url.indexOf('?')) : url;
            Map<String, String> qp = query(url);
            String kind = method + " " + path.replace("https://www.googleapis.com", "") + (qp.containsKey("q") ? " q=" + qp.get("q") : "");
            calls.add(kind);
            if (!token_ok(token)) return new Resp(401, "{\"error\":{\"code\":401}}");
            Deque<Object> fq = faults.get(method);
            Object fault = fq != null ? fq.poll() : null;
            if (fault instanceof Integer) {
                int code = (Integer) fault;
                return new Resp(code, code == 403 ? "{\"error\":{\"errors\":[{\"reason\":\"forbidden\"}]}}" : "{}");
            }
            if ("io".equals(fault)) throw new IOException("timeout");
            if (method.equals("GET") && path.contains("/drive/v3/files/")) {
                String id = URLDecoder.decode(path.substring(path.lastIndexOf('/') + 1), "UTF-8");
                DFile d = byIdAny(id);
                Resp meta = d == null ? new Resp(404, "{}") : new Resp(200, "{\"id\":\"" + d.id + "\",\"trashed\":" + d.trashed + "}");
                if (afterMeta != null) { Runnable r = afterMeta; afterMeta = null; r.run(); }
                return meta;
            }
            if (method.equals("GET") && path.endsWith("/drive/v3/files")) {
                if (blockGets != null) {
                    if (enteredGet != null) enteredGet.countDown();
                    try { blockGets.await(10, TimeUnit.SECONDS); } catch (InterruptedException ignored) { }
                }
                return list(qp);
            }
            if (method.equals("POST") && path.endsWith("/drive/v3/files") && !path.contains("/upload/")) {
                Map<String, Object> m = MiniJson.parseObject(new String(body, StandardCharsets.UTF_8));
                String parent = parentOf(m);
                if (parent != null && byIdAny(parent) == null) return new Resp(404, "{}");
                DFile d = add(MiniJson.str(m, "name"), MiniJson.str(m, "mimeType"), parent, null, null);
                if (onFolderCreate != null) { Runnable r = onFolderCreate; onFolderCreate = null; r.run(); }
                return new Resp(200, "{\"id\":\"" + d.id + "\"}");
            }
            if (method.equals("POST") && path.endsWith("/upload/drive/v3/files")) {
                if (!"multipart".equals(qp.get("uploadType"))) violations.add("create without multipart");
                String boundary = contentType.substring(contentType.indexOf("boundary=") + 9);
                byte[][] parts = multipart(body, boundary);
                Map<String, Object> meta = MiniJson.parseObject(new String(parts[0], StandardCharsets.UTF_8));
                String parent = parentOf(meta);
                if (parent == null || byIdAny(parent) == null) return new Resp(404, "{}");
                DFile d = add(MiniJson.str(meta, "name"), MiniJson.str(meta, "mimeType"), parent, parts[1], null);
                if (onFileCreate != null) { Runnable r = onFileCreate; onFileCreate = null; r.run(); }
                if ("io_commit".equals(fault)) throw new IOException("timeout after commit");
                return new Resp(200, "{\"id\":\"" + d.id + "\",\"size\":\"" + d.data.length + "\"}");
            }
            if (method.equals("PATCH") && path.contains("/upload/drive/v3/files/")) {
                String id = URLDecoder.decode(path.substring(path.lastIndexOf('/') + 1), "UTF-8");
                DFile d = byIdAny(id);
                if (d == null) return new Resp(404, "{}");
                if (!"media".equals(qp.get("uploadType"))) violations.add("patch without media");
                d.data = body.clone();
                if ("io_commit".equals(fault)) throw new IOException("timeout after commit");
                return new Resp(200, "{\"id\":\"" + d.id + "\",\"size\":\"" + d.data.length + "\"}");
            }
            violations.add("unexpected " + method + " " + url);
            return new Resp(400, "{}");
        }

        boolean token_ok(String t) { return t != null && validTokens.contains(t); }

        static String parentOf(Map<String, Object> m) {
            Object p = m.get("parents");
            if (p instanceof List && !((List<?>) p).isEmpty()) return (String) ((List<?>) p).get(0);
            return null;
        }

        Resp list(Map<String, String> qp) {
            String q = qp.get("q");
            List<DFile> hits = new ArrayList<>();
            Matcher m;
            boolean ordered = "createdTime".equals(qp.get("orderBy"));
            if (Q_ROOT.matcher(q).matches()) {
                if (!ordered) violations.add("root lookup without orderBy=createdTime");
                for (DFile d : files) if (!d.trashed && FOLDER.equals(d.mime) && d.name.equals("HR Monitor Sessions")) hits.add(d);
            } else if ((m = Q_MONTH.matcher(q)).matches()) {
                if (!ordered) violations.add("month folder lookup without orderBy=createdTime");
                if (byIdAny(m.group(2)) == null) return new Resp(404, "{}");
                for (DFile d : files) if (!d.trashed && FOLDER.equals(d.mime) && d.name.equals(m.group(1)) && d.parents.contains(m.group(2))) hits.add(d);
            } else if ((m = Q_NAME.matcher(q)).matches()) {
                if (!ordered) violations.add("name lookup without orderBy=createdTime");
                if (onEveryNameList != null) onEveryNameList.run();
                String name = m.group(1).replace("\\'", "'").replace("\\\\", "\\");
                hits.addAll(named(name));
            } else if ((m = Q_LEGACY.matcher(q)).matches()) {
                if (onLegacyList != null) { Runnable r = onLegacyList; onLegacyList = null; r.run(); }
                for (DFile d : files) if (!d.trashed && d.parents.contains(m.group(1)) && d.name.contains("hrv_session")) hits.add(d);
            } else {
                violations.add("query not allowed: " + q);
                return new Resp(400, "{}");
            }
            hits.sort(Comparator.comparing((DFile d) -> d.created));
            if (!(ordered && honourOrder)) Collections.reverse(hits);
            int start = qp.containsKey("pageToken") ? Integer.parseInt(qp.get("pageToken").substring(1)) : 0;
            int end = Math.min(hits.size(), start + pageSize);
            StringBuilder sb = new StringBuilder("{\"files\":[");
            for (int i = start; i < end; i++) {
                DFile d = hits.get(i);
                if (i > start) sb.append(',');
                sb.append("{\"id\":").append(MiniJson.quote(d.id)).append(",\"name\":").append(MiniJson.quote(d.name))
                    .append(",\"size\":\"").append(d.data.length).append("\",\"createdTime\":\"").append(d.created).append("\"}");
            }
            sb.append(']');
            if (end < hits.size()) sb.append(",\"nextPageToken\":\"p").append(end).append('"');
            sb.append('}');
            return new Resp(200, sb.toString());
        }

        static Map<String, String> query(String url) {
            Map<String, String> out = new LinkedHashMap<>();
            int qi = url.indexOf('?');
            if (qi < 0) return out;
            for (String kv : url.substring(qi + 1).split("&")) {
                int e = kv.indexOf('=');
                try {
                    out.put(URLDecoder.decode(kv.substring(0, e), "UTF-8"), URLDecoder.decode(kv.substring(e + 1), "UTF-8"));
                } catch (Exception x) { throw new IllegalStateException(x); }
            }
            return out;
        }

        static byte[][] multipart(byte[] body, String boundary) {
            String s = new String(body, StandardCharsets.ISO_8859_1);
            String sep = "--" + boundary;
            int p1 = s.indexOf("\r\n\r\n", s.indexOf(sep)) + 4;
            int e1 = s.indexOf("\r\n" + sep, p1);
            int p2 = s.indexOf("\r\n\r\n", e1 + 2) + 4;
            int e2 = s.lastIndexOf("\r\n" + sep + "--");
            return new byte[][] { s.substring(p1, e1).getBytes(StandardCharsets.ISO_8859_1),
                s.substring(p2, e2).getBytes(StandardCharsets.ISO_8859_1) };
        }
    }

    static final class FakeTokens implements SegmentUploader.Tokens {
        volatile String current = "t1";
        volatile String afterRefresh = "t2";
        volatile boolean transientFail = false;
        volatile String acct = "a@example.com";
        int refreshes = 0;
        public String account() { return acct; }
        public synchronized String token(boolean force) throws SegmentUploader.TransientAuthException {
            if (transientFail) throw new SegmentUploader.TransientAuthException("blip");
            if (force) { refreshes++; current = afterRefresh; }
            return current;
        }
    }

    static final class MapStore implements SegmentUploader.Store {
        final Map<String, String> m = new java.util.concurrent.ConcurrentHashMap<>();
        public String get(String k) { return m.get(k); }
        public void put(String k, String v) { m.put(k, v); }
        public void remove(String k) { m.remove(k); }
        public void removePrefix(String p) { m.keySet().removeIf(k -> k.startsWith(p)); }
    }

    static final class Log implements LifecycleLog {
        final List<String> lines = new CopyOnWriteArrayList<>();
        public void log(String e) { lines.add(e); }
        boolean has(String prefix) { for (String l : lines) if (l.startsWith(prefix)) return true; return false; }
        int count(String prefix) { int n = 0; for (String l : lines) if (l.startsWith(prefix)) n++; return n; }
        public String toString() { return lines.toString(); }
    }

    static final class OpenView implements SegmentReader.OpenSegment {
        final String name;
        volatile long cap;
        OpenView(String name, long cap) { this.name = name; this.cap = cap; }
        public String openName() { return name; }
        public long readableLength(String n) { return name.equals(n) ? cap : -1L; }
    }

    static final class Env {
        final File dir, legacy;
        final FakeDrive drive = new FakeDrive();
        final FakeTokens tokens = new FakeTokens();
        final MapStore store = new MapStore();
        final Log log = new Log();
        final SegmentUploader up;
        final long[] now = { 1_790_000_000_000L };
        Env(String name) throws IOException { this(name, null); }
        Env(String name, SegmentUploader.Http http) throws IOException {
            dir = Files.createTempDirectory("segup-" + name).toFile();
            legacy = Files.createTempDirectory("segleg-" + name).toFile();
            com.nakauri.hrmonitor.Clock c = new com.nakauri.hrmonitor.Clock() {
                public long wallMs() { return now[0]; }
                public long monoMs() { return now[0]; }
            };
            up = new SegmentUploader(dir, legacy, http != null ? http : drive, tokens, store, log, c);
        }
        File write(String name, String text) throws IOException {
            File f = new File(dir, name);
            try (FileOutputStream o = new FileOutputStream(f)) { o.write(text.getBytes(StandardCharsets.UTF_8)); }
            return f;
        }
        void append(String name, String text) throws IOException {
            try (FileOutputStream o = new FileOutputStream(new File(dir, name), true)) { o.write(text.getBytes(StandardCharsets.UTF_8)); }
        }
        Result closed() { return up.run(Mode.CLOSED, null, false, 5_000L); }
        String driveText(String name) {
            List<DFile> l = drive.named(name);
            return l.isEmpty() ? null : new String(l.get(0).data, StandardCharsets.UTF_8);
        }
        DFile folder(String name) {
            for (DFile d : drive.files) if (FOLDER.equals(d.mime) && d.name.equals(name) && !d.trashed) return d;
            return null;
        }
    }

    static String header(String hourIso) { return "#hrm,v=2,base=0,tz=-360,app=t,dev=s,flavour=personal\n"; }
    static String rows(int from, int n) {
        StringBuilder b = new StringBuilder();
        for (int i = from; i < from + n; i++) b.append("h,").append(i * 1000).append(",80,40.5,750;760\n");
        return b.toString();
    }

    public static void main(String[] args) throws Exception {
        testCreatePatchAndPartial();
        testOpenTick();
        test401();
        testDuplicates();
        testMonthRace();
        testSerialChain();
        testSignedOut();
        testBadRestart();
        testBadPendingBlocksOverwrite();
        testTransientAndTimedOutCreate();
        testPermanentAndLegacy();
        testBusyTick();
        testStateCorrupt();
        testCloseListener();
        testKeepFullSweep();
        testTwoRoots();
        testCloseDuringLegacy();
        testAccountSwitch();
        testMidRunAuthChanges();
        testStaleRoot404();
        testTrashedFolders();
        testRelistThrottle();
        System.out.println("SegmentUploaderTest: " + passes + " passed, " + failures + " failed");
        System.exit(failures == 0 ? 0 : 1);
    }

    static void noViolations(String label, Env e) {
        check(label + ": fake Drive saw only allowed requests", e.drive.violations.isEmpty(), e.drive.violations.toString());
    }

    static void testCreatePatchAndPartial() throws Exception {
        Env e = new Env("create");
        String full = header("") + rows(0, 3);
        e.write(SEG_A, full + "h,9999,8");       // partial last line
        Result r = e.closed();
        check("create: run OK", r == Result.OK, String.valueOf(r) + " " + e.log);
        DFile f = e.drive.named(SEG_A).isEmpty() ? null : e.drive.named(SEG_A).get(0);
        check("create: one copy on Drive", e.drive.named(SEG_A).size() == 1);
        check("create: bytes end at the last LF [K10]", f != null && full.equals(new String(f.data, StandardCharsets.UTF_8)));
        DFile root = e.folder("HR Monitor Sessions");
        DFile month = e.folder("2026-10");
        check("create: month folder under the root", root != null && month != null && month.parents.contains(root.id));
        check("create: segment lives in its month folder", f != null && month != null && f.parents.contains(month.id));
        check("create: upload_done op=create logged", e.log.has("upload_done name=" + SEG_A + " op=create bytes=" + full.length()), e.log.toString());
        check("create: state file written, no temp left", new File(e.dir, ".upload.json").isFile() && !new File(e.dir, ".upload.json.tmp").exists());
        noViolations("create", e);

        int writes = e.drive.count("POST") + e.drive.count("PATCH");
        int gets = e.drive.count("GET");
        r = e.closed();
        check("unchanged: no Drive write and no lookup", r == Result.OK && e.drive.count("POST") + e.drive.count("PATCH") == writes
            && e.drive.count("GET") == gets, e.drive.calls.toString());

        e.write(SEG_A, full + rows(3, 2));
        r = e.closed();
        String grown = full + rows(3, 2);
        check("grown: PATCHed, still one copy", r == Result.OK && e.drive.named(SEG_A).size() == 1 && grown.equals(e.driveText(SEG_A)));
        check("grown: upload_done op=patch", e.log.has("upload_done name=" + SEG_A + " op=patch"));

        e.write(SEG_NOV, header("") + rows(0, 1));
        e.closed();
        DFile nov = e.folder("2026-11");
        check("a November segment goes to 2026-11", nov != null && e.drive.named(SEG_NOV).get(0).parents.contains(nov.id));
        check("the root is reused, not created twice", countFolders(e, "HR Monitor Sessions") == 1);
        noViolations("grow", e);
    }

    static int countFolders(Env e, String name) {
        int n = 0;
        for (DFile d : e.drive.files) if (FOLDER.equals(d.mime) && d.name.equals(name) && !d.trashed) n++;
        return n;
    }

    static void testOpenTick() throws Exception {
        Env e = new Env("open");
        String closedText = header("") + rows(0, 2);
        e.write(SEG_A, closedText);
        String open1 = header("") + rows(0, 4);
        e.write(SEG_B, open1 + rows(4, 3));     // the writer has gone past the snapshot
        OpenView ov = new OpenView(SEG_B, open1.length() + 7);   // snapshot ends mid-row
        Result r = e.up.run(Mode.CLOSED, ov, false, 1000L);
        check("closed mode skips the open segment", r == Result.OK && e.drive.named(SEG_B).isEmpty() && e.drive.named(SEG_A).size() == 1);
        r = e.up.run(Mode.OPEN_TICK, ov, false, 0L);
        check("open tick sends the open segment to the last LF inside the snapshot [K10]",
            r == Result.OK && open1.equals(e.driveText(SEG_B)), e.driveText(SEG_B) == null ? "missing" : "len=" + e.driveText(SEG_B).length());
        check("open tick caches the open file id", SEG_B.equals(e.store.get("open_seg_name")) && e.store.get("open_seg_id") != null);
        e.up.forgetOpen(SEG_A);
        check("closing another segment keeps the open id cached", SEG_B.equals(e.store.get("open_seg_name")));
        String open2 = open1 + rows(4, 3);
        ov.cap = open2.length();
        int nameLookups = countNameLookups(e);
        int metaBefore = countMeta(e);
        r = e.up.run(Mode.OPEN_TICK, ov, false, 0L);
        check("second tick PATCHes the cached id without a lookup", r == Result.OK && open2.equals(e.driveText(SEG_B))
            && countNameLookups(e) == nameLookups);
        check("within the hour the cached id is not re-checked", countMeta(e) == metaBefore, "meta=" + (countMeta(e) - metaBefore));
        // Trashed: Drive would still accept the PATCH, so the hourly check must catch it.
        for (DFile d : e.drive.named(SEG_B)) d.trashed = true;
        e.append(SEG_B, rows(7, 1));
        String open3 = open2 + rows(7, 1);
        ov.cap = open3.length();
        e.now[0] += 61L * 60_000L;
        r = e.up.run(Mode.OPEN_TICK, ov, false, 0L);
        check("a trashed cached id is dropped after the hourly check and the name looked up again",
            r == Result.OK && e.drive.named(SEG_B).size() == 1 && open3.equals(e.driveText(SEG_B))
            && countNameLookups(e) > nameLookups, e.log.toString());
        // Deleted outright inside the hour: the PATCH 404s and the lookup runs again.
        int lookups = countNameLookups(e);
        e.drive.files.removeAll(e.drive.named(SEG_B));
        e.append(SEG_B, rows(8, 1));
        ov.cap = open3.length() + rows(8, 1).length();
        r = e.up.run(Mode.OPEN_TICK, ov, false, 0L);
        check("404 on the cached id runs the global lookup again", r == Result.OK && e.drive.named(SEG_B).size() == 1
            && countNameLookups(e) > lookups, e.log.toString());
        noViolations("open", e);
    }

    static String stateText(Env e) throws IOException {
        File f = new File(e.dir, ".upload.json");
        return f.exists() ? new String(Files.readAllBytes(f.toPath()), StandardCharsets.UTF_8) : "";
    }

    static int countMeta(Env e) {
        int n = 0;
        for (String c : e.drive.calls) if (c.startsWith("GET /drive/v3/files/")) n++;
        return n;
    }

    static int countNameLookups(Env e) {
        int n = 0;
        for (String c : e.drive.calls) if (c.startsWith("GET") && Q_NAME.matcher(c.substring(c.indexOf("q=") + 2)).matches()) n++;
        return n;
    }

    static void test401() throws Exception {
        Env e = new Env("auth");
        e.drive.validTokens.clear();
        e.drive.validTokens.add("t2");
        e.write(SEG_A, header("") + rows(0, 2));
        Result r = e.closed();
        check("401: refreshes once and succeeds", r == Result.OK && e.tokens.refreshes == 1 && e.drive.named(SEG_A).size() == 1,
            "r=" + r + " refreshes=" + e.tokens.refreshes);
        Env e2 = new Env("auth2");
        e2.drive.validTokens.clear();
        e2.tokens.afterRefresh = "t1";
        e2.write(SEG_A, header("") + rows(0, 2));
        r = e2.closed();
        check("refresh to the same rejected token: wait for sign-in, no retry loop", r == Result.SIGNED_OUT
            && e2.tokens.refreshes == 1 && e2.drive.calls.size() == 1 && e2.log.has("upload_skip reason=auth_rejected"),
            "r=" + r + " calls=" + e2.drive.calls.size());
        Env e5 = new Env("auth5");
        e5.drive.validTokens.clear();          // Drive rejects every token: a revoked grant
        e5.write(SEG_A, header("") + rows(0, 2));
        r = e5.closed();
        check("401 after a fresh token: wait for sign-in, no WorkManager retry", r == Result.SIGNED_OUT
            && e5.tokens.refreshes == 1 && e5.drive.calls.size() == 2 && e5.log.has("upload_skip reason=auth_rejected"),
            "r=" + r + " calls=" + e5.drive.calls.size());
        Env e3 = new Env("auth3");
        e3.drive.validTokens.clear();
        e3.tokens.afterRefresh = null;
        e3.write(SEG_A, header("") + rows(0, 2));
        r = e3.closed();
        check("refresh to no token mid-run: signed out", r == Result.SIGNED_OUT);
        Env e4 = new Env("auth4");
        e4.tokens.transientFail = true;
        e4.write(SEG_A, header("") + rows(0, 2));
        r = e4.closed();
        check("transient token failure: retry, no Drive call", r == Result.RETRY && e4.drive.calls.isEmpty());
    }

    static void testDuplicates() throws Exception {
        Env e = new Env("dups");
        e.drive.pageSize = 1;
        e.drive.honourOrder = false;   // newest first: the oldest copy is on the last page
        DFile root = e.drive.add("HR Monitor Sessions", FOLDER, null, null, null);
        DFile other = e.drive.add("2026-09", FOLDER, root.id, null, null);
        DFile oldest = e.drive.add(SEG_A, "text/csv", other.id, "x\n".getBytes(StandardCharsets.UTF_8), null);
        DFile month = e.drive.add("2026-10", FOLDER, root.id, null, null);
        DFile mid = e.drive.add(SEG_A, "text/csv", month.id, "yy\n".getBytes(StandardCharsets.UTF_8), null);
        DFile newest = e.drive.add(SEG_A, "text/csv", root.id, "zzz\n".getBytes(StandardCharsets.UTF_8), null);
        String text = header("") + rows(0, 3);
        e.write(SEG_A, text);
        Result r = e.closed();
        check("duplicates: run OK", r == Result.OK, String.valueOf(r) + " " + e.log);
        check("duplicates: the globally oldest copy is PATCHed, wherever it lives [K9]",
            text.equals(new String(oldest.data, StandardCharsets.UTF_8)));
        check("duplicates: the other copies are untouched",
            "yy\n".equals(new String(mid.data, StandardCharsets.UTF_8)) && "zzz\n".equals(new String(newest.data, StandardCharsets.UTF_8)));
        check("duplicates: no create, nothing deleted", e.drive.named(SEG_A).size() == 3 && e.drive.count("POST") == 0);
        check("duplicates: every page was read", countNameLookups(e) == 3, "lookups=" + countNameLookups(e));
        noViolations("duplicates (no parent filter in the name lookup)", e);
    }

    static void testMonthRace() throws Exception {
        Env e = new Env("race");
        DFile root = e.drive.add("HR Monitor Sessions", FOLDER, null, null, null);
        final String[] winner = new String[1];
        // Another install creates the same month folder; Drive lists it as older.
        e.drive.onFolderCreate = () -> winner[0] = e.drive.add("2026-10", FOLDER, root.id, null, "2020-01-01T00:00:00.000Z").id;
        e.write(SEG_A, header("") + rows(0, 2));
        Result r = e.closed();
        DFile f = e.drive.named(SEG_A).isEmpty() ? null : e.drive.named(SEG_A).get(0);
        check("month race: run OK", r == Result.OK);
        check("month race: the file lands in the oldest month folder", f != null && f.parents.contains(winner[0]),
            f == null ? "missing" : "parent=" + f.parents + " winner=" + winner[0]);
        check("month race: the cache holds the oldest folder", winner[0] != null && winner[0].equals(e.store.get("seg_month_2026-10")));
        check("month race: the losing folder is left in place", countFolders(e, "2026-10") == 2);
        e.write(SEG_B, header("") + rows(0, 2));
        e.closed();
        check("month race: later segments use the cached oldest folder", e.drive.named(SEG_B).get(0).parents.contains(winner[0]));
        noViolations("month race", e);
    }

    static void testSerialChain() throws Exception {
        Env e = new Env("chain");
        e.drive.latencyMs = 15;
        e.write(SEG_A, header("") + rows(0, 2));
        e.write(SEG_B, header("") + rows(0, 2));
        SegmentUploader second = new SegmentUploader(e.dir, e.legacy, e.drive, e.tokens, e.store, e.log);
        Result[] rs = new Result[2];
        Thread t1 = new Thread(() -> rs[0] = e.up.run(Mode.CLOSED, null, false, 10_000L));
        Thread t2 = new Thread(() -> rs[1] = second.run(Mode.CLOSED, null, false, 10_000L));
        t1.start(); t2.start();
        t1.join(20_000); t2.join(20_000);
        check("serial chain: both runs finish OK", rs[0] == Result.OK && rs[1] == Result.OK, Arrays.toString(rs));
        check("serial chain: one root and one month folder", countFolders(e, "HR Monitor Sessions") == 1 && countFolders(e, "2026-10") == 1,
            "roots=" + countFolders(e, "HR Monitor Sessions") + " months=" + countFolders(e, "2026-10"));
        check("serial chain: each segment once", e.drive.named(SEG_A).size() == 1 && e.drive.named(SEG_B).size() == 1);
    }

    static void testSignedOut() throws Exception {
        Env e = new Env("signedout");
        e.tokens.current = null;
        e.write(SEG_A, header("") + rows(0, 2));
        e.write(SEG_B, header("") + rows(0, 2));
        e.write(SEG_C, header("") + rows(0, 2));
        new File(e.legacy, "hrv_session_x.csv").createNewFile();
        Result r = e.up.run(Mode.CLOSED, null, true, 1000L);
        check("signed out: result SIGNED_OUT (worker succeeds, no retry)", r == Result.SIGNED_OUT);
        check("signed out: no Drive call", e.drive.calls.isEmpty());
        check("signed out: upload_skip reason=signed_out", e.log.has("upload_skip reason=signed_out"));
        check("signed out: legacy_pending n=unknown [L7]", e.log.has("legacy_pending n=unknown"));
        check("signed out: files untouched", new File(e.dir, SEG_A).length() > 0 && !new File(e.dir, ".upload.json").exists());
        e.tokens.current = "t1";
        r = e.closed();
        check("after sign-in the backlog uploads once each", r == Result.OK && e.drive.named(SEG_A).size() == 1
            && e.drive.named(SEG_B).size() == 1 && e.drive.named(SEG_C).size() == 1 && e.log.count("upload_done") == 3);
    }

    static void testBadRestart() throws Exception {
        Env e = new Env("bad");
        String gen1 = header("") + rows(0, 5);
        e.write(SEG_A, gen1);
        e.closed();
        check("bad: first generation on Drive", gen1.equals(e.driveText(SEG_A)));
        // The writer found a bad header: moved aside, restarted with different rows of the same length.
        File a = new File(e.dir, SEG_A);
        String badName = SEG_A + ".bad-1790000123456";
        check("bad: test setup rename", a.renameTo(new File(e.dir, badName)));
        String gen2 = header("") + rows(100, 5);
        gen2 = gen2.substring(0, gen1.length() - 1) + "\n";
        check("bad: restarted file has the uploaded length (size alone cannot see it)", gen2.length() == gen1.length());
        e.write(SEG_A, gen2);
        Result r = e.closed();
        check("bad: run OK", r == Result.OK, e.log.toString());
        check("bad: the .bad file is on Drive under its own name", gen1.equals(e.driveText(badName)));
        DFile month = e.folder("2026-10");
        check("bad: the .bad file sits in the month folder", month != null && e.drive.named(badName).get(0).parents.contains(month.id));
        check("bad: the restarted segment replaces the stale Drive copy", gen2.equals(e.driveText(SEG_A)) && e.drive.named(SEG_A).size() == 1);
        check("bad: upload_done marks the restart", e.log.has("upload_done name=" + SEG_A + " op=patch bytes=" + gen2.length() + " ms=")
            && e.log.toString().contains("restarted=true"));
        int writes = e.drive.count("POST") + e.drive.count("PATCH");
        e.closed();
        check("bad: a later run sends nothing", e.drive.count("POST") + e.drive.count("PATCH") == writes);
        noViolations("bad", e);
    }

    static void testBadPendingBlocksOverwrite() throws Exception {
        Env e = new Env("badpending");
        String gen1 = header("") + rows(0, 5);
        e.write(SEG_A, gen1);
        e.closed();
        String badName = SEG_A + ".bad-1790000123456";
        new File(e.dir, SEG_A).renameTo(new File(e.dir, badName));
        e.write(SEG_A, header("") + rows(200, 2));
        e.drive.fault("POST", 400);   // the .bad create fails for good this pass
        Result r = e.closed();
        check("bad pending: pass completes", r == Result.OK, e.log.toString());
        check("bad pending: Drive keeps the first generation until its .bad copy is up", gen1.equals(e.driveText(SEG_A)));
        check("bad pending: upload_skip reason=bad_pending", e.log.has("upload_skip reason=bad_pending name=" + SEG_A));
        e.closed();
        check("bad pending: next pass uploads both", gen1.equals(e.driveText(badName))
            && (header("") + rows(200, 2)).equals(e.driveText(SEG_A)));
    }

    static void testTransientAndTimedOutCreate() throws Exception {
        Env e = new Env("transient");
        e.write(SEG_A, header("") + rows(0, 2));
        e.drive.fault("POST", 503);   // root folder create
        Result r = e.closed();
        check("5xx: retry later, nothing recorded", r == Result.RETRY && !stateText(e).contains(SEG_A));
        r = e.closed();
        check("5xx: the next run uploads once", r == Result.OK && e.drive.named(SEG_A).size() == 1);

        Env t = new Env("timeout");
        String text = header("") + rows(0, 3);
        t.write(SEG_A, text);
        t.closed();                      // folders exist now
        t.write(SEG_B, text);
        t.drive.fault("POST", "io_commit");   // Drive stores the create, the reply is lost
        r = t.closed();
        check("timed-out create: retry", r == Result.RETRY);
        r = t.closed();
        check("timed-out create: the retry finds the name, sees the bytes already there, never a duplicate [B5]",
            r == Result.OK && t.drive.named(SEG_B).size() == 1 && t.log.has("upload_done name=" + SEG_B + " op=match"));
        t.write(SEG_C, text);
        t.drive.fault("GET", "io");
        r = t.closed();
        check("IOException on the lookup: retry", r == Result.RETRY && t.drive.named(SEG_C).isEmpty());
    }

    static void testPermanentAndLegacy() throws Exception {
        Env e = new Env("perm");
        e.write(SEG_A, header("") + rows(0, 2));
        e.write(SEG_B, header("") + rows(0, 2));
        e.closed();                                  // folders, A and B up
        e.write(SEG_C, header("") + rows(0, 2));
        e.append(SEG_A, rows(2, 1));
        e.drive.fault("PATCH", 403);                 // A's PATCH refused for good, not rate limited
        Result r = e.closed();
        check("permanent 4xx on one file: pass still OK and later files go up", r == Result.OK
            && e.drive.named(SEG_C).size() == 1 && e.log.has("upload_fail name=" + SEG_A + " status=403"), e.log.toString());

        Env l = new Env("legacy");
        DFile root = l.drive.add("HR Monitor Sessions", FOLDER, null, null, null);
        l.drive.add("hrv_session_a.csv", "text/csv", root.id, new byte[100], null);
        l.drive.add("hrv_session_b.csv", "text/csv", root.id, new byte[50], null);
        l.drive.add("hrv_session_b.csv", "text/csv", root.id, new byte[200], null);
        try (FileOutputStream o = new FileOutputStream(new File(l.legacy, "hrv_session_a.csv"))) { o.write(new byte[100]); }
        try (FileOutputStream o = new FileOutputStream(new File(l.legacy, "hrv_session_b.csv"))) { o.write(new byte[150]); }
        try (FileOutputStream o = new FileOutputStream(new File(l.legacy, "hrv_session_c.csv"))) { o.write(new byte[10]); }
        r = l.up.run(Mode.CLOSED, null, true, 1000L);
        check("legacy_pending: largest same-name Drive size wins, missing counts [L7]", r == Result.OK
            && l.log.has("legacy_pending n=1 local=3"), l.log.toString());
        noViolations("legacy", l);
    }

    static void testBusyTick() throws Exception {
        Env e = new Env("busy");
        e.write(SEG_A, header("") + rows(0, 2));
        e.drive.blockGets = new CountDownLatch(1);
        e.drive.enteredGet = new CountDownLatch(1);
        Result[] worker = new Result[1];
        Thread w = new Thread(() -> worker[0] = e.up.run(Mode.CLOSED, null, false, 5_000L));
        w.start();
        check("busy: worker is inside a Drive call holding the lock", e.drive.enteredGet.await(5, TimeUnit.SECONDS));
        Result[] tick = new Result[1];
        long t0 = System.nanoTime();
        Thread tk = new Thread(() -> tick[0] = e.up.run(Mode.OPEN_TICK, new OpenView(SEG_B, 0), false, 0L));
        tk.start();
        tk.join(2_000);
        long ms = (System.nanoTime() - t0) / 1_000_000L;
        boolean returned = !tk.isAlive();
        e.drive.blockGets.countDown();
        tk.join(10_000);
        w.join(10_000);
        check("busy: the tick returns BUSY without waiting [L1]", returned && tick[0] == Result.BUSY, "returned=" + returned + " ms=" + ms + " r=" + tick[0]);
        check("busy: upload_skip reason=busy logged", e.log.has("upload_skip reason=busy mode=open30"));
        check("busy: the worker run still completes", worker[0] == Result.OK && e.drive.named(SEG_A).size() == 1);
    }

    static void testStateCorrupt() throws Exception {
        Env e = new Env("state");
        String text = header("") + rows(0, 2);
        e.write(SEG_A, text);
        e.closed();
        e.write(".upload.json", "{not json");
        Result r = e.closed();
        check("corrupt state: reset logged, lookup PATCHes, no duplicate", r == Result.OK && e.log.has("upload_state_reset")
            && e.drive.named(SEG_A).size() == 1 && e.log.count("upload_done name=" + SEG_A) == 2);
        String saved = new String(Files.readAllBytes(new File(e.dir, ".upload.json").toPath()), StandardCharsets.UTF_8);
        Map<String, Object> m = MiniJson.parseObject(saved);
        check("state file is valid JSON with the sent length", m.containsKey(SEG_A) && saved.contains("\"n\":" + text.length()), saved);
        check("JSON reader handles escapes", "a\"b\\cé/".equals(MiniJson.str(MiniJson.parseObject("{\"k\":\"a\\\"b\\\\c\\u00e9\\/\"}"), "k")));
    }

    // The engine enqueues the worker from this callback on roll and stop [K11].
    static void testCloseListener() throws Exception {
        File d = Files.createTempDirectory("segclose").toFile();
        final long[] wall = { 1_791_000_000_000L - (1_791_000_000_000L % 3_600_000L) + 60_000L };
        com.nakauri.hrmonitor.Clock clock = new com.nakauri.hrmonitor.Clock() {
            public long wallMs() { return wall[0]; }
            public long monoMs() { return wall[0]; }
        };
        List<String> closed = new ArrayList<>();
        SegmentWriter w = new SegmentWriter(d, "abc123", clock, ms -> 0, "t", "s", "personal", ev -> { });
        w.setCloseListener((name, reason) -> closed.add(name + "|" + reason));
        String first = w.openName();
        w.appendSession(wall[0], "start", wall[0]);
        w.appendHr(80, 40.0, 0, 0, 0, new int[] { 750 }, wall[0]);
        wall[0] += 3_600_000L;
        w.appendHr(81, 41.0, 0, 0, 0, new int[] { 740 }, wall[0]);
        String second = w.openName();
        w.appendSession(wall[0] - 3_600_000L, "stop", wall[0]);
        w.close();
        check("close listener: the roll reports the closed hour", closed.size() >= 1 && closed.get(0).equals(first + "|roll"), closed.toString());
        check("close listener: the final close reports reason null", closed.size() == 2 && closed.get(1).equals(second + "|null"), closed.toString());
    }

    // KEEP drops an enqueue while a run is pending or running, so one run must carry every closed segment.
    static void testKeepFullSweep() throws Exception {
        Env e = new Env("keep");
        e.write(SEG_A, header("") + rows(0, 2));   // enqueue A (reason closed, name A)
        e.write(SEG_B, header("") + rows(0, 3));   // enqueue B while A's run is pending: dropped by KEEP
        Result r = e.closed();                      // the single run
        check("KEEP: one run uploads both A and B", r == Result.OK && e.drive.named(SEG_A).size() == 1
            && e.drive.named(SEG_B).size() == 1, e.log.toString());
        Env m = new Env("keepmid");
        m.write(SEG_A, header("") + rows(0, 2));
        // C closes while the run is already past its scan; its enqueue is dropped because A's run is running.
        m.drive.onFileCreate = () -> {
            try { m.write(SEG_C, header("") + rows(0, 4)); } catch (IOException x) { throw new RuntimeException(x); }
        };
        r = m.closed();
        check("KEEP: a segment closed mid-run is uploaded by the same run", r == Result.OK
            && m.drive.named(SEG_A).size() == 1 && m.drive.named(SEG_C).size() == 1, m.log.toString());
        int writes = m.drive.count("POST") + m.drive.count("PATCH");
        m.closed();
        check("KEEP: the rescan stops once nothing is pending", m.drive.count("POST") + m.drive.count("PATCH") == writes);
    }

    // Two HR Monitor Sessions roots: the oldest wins (id breaks ties), the same pick as the viewer and the legacy uploader.
    static void testTwoRoots() throws Exception {
        Env e = new Env("roots");
        e.drive.honourOrder = false;   // Drive hands the roots back newest first
        DFile newer = e.drive.add("HR Monitor Sessions", FOLDER, null, null, "2026-05-01T00:00:00.000Z");
        DFile older = e.drive.add("HR Monitor Sessions", FOLDER, null, null, "2025-01-01T00:00:00.000Z");
        e.write(SEG_A, header("") + rows(0, 2));
        Result r = e.closed();
        DFile month = e.folder("2026-10");
        check("two roots: the oldest root is used", r == Result.OK && older.id.equals(e.store.get("seg_root_id"))
            && month != null && month.parents.contains(older.id), "root=" + e.store.get("seg_root_id") + " older=" + older.id + " newer=" + newer.id);
        Env t = new Env("roottie");
        t.drive.honourOrder = false;
        DFile b = t.drive.add("HR Monitor Sessions", FOLDER, null, null, "2025-01-01T00:00:00.000Z");
        DFile a = t.drive.add("HR Monitor Sessions", FOLDER, null, null, "2025-01-01T00:00:00.000Z");
        String lower = a.id.compareTo(b.id) < 0 ? a.id : b.id;
        t.write(SEG_A, header("") + rows(0, 2));
        t.closed();
        check("two roots, same createdTime: the lower id wins", lower.equals(t.store.get("seg_root_id")),
            "root=" + t.store.get("seg_root_id") + " lower=" + lower);
        noViolations("two roots", e);
    }

    // KEEP drops the enqueue of a close that lands while a run is RUNNING; CLOSE_SEQ makes that run sweep again.
    static void testCloseDuringLegacy() throws Exception {
        Env e = new Env("closeseq");
        e.write(SEG_A, header("") + rows(0, 2));
        try (FileOutputStream o = new FileOutputStream(new File(e.legacy, "hrv_session_x.csv"))) { o.write(new byte[5]); }
        e.drive.onLegacyList = () -> {
            try { e.write(SEG_C, header("") + rows(0, 3)); } catch (IOException x) { throw new RuntimeException(x); }
            SegmentUploader.noteClosed();
        };
        Result r = e.up.run(Mode.CLOSED, null, true, 1000L);
        check("closeSeq: a segment closed during legacyPass uploads in the same run", r == Result.OK
            && e.drive.named(SEG_C).size() == 1 && e.drive.named(SEG_A).size() == 1, e.log.toString());
        Env f = new Env("closeseq2");
        f.write(SEG_A, header("") + rows(0, 2));
        final int[] n = { 0 };
        f.drive.onEveryNameList = () -> {
            n[0]++;
            try { f.write("hrm_20261009T" + (17 + n[0]) + "Z_abc123.csv", header("") + rows(0, 1)); } catch (IOException x) { throw new RuntimeException(x); }
            SegmentUploader.noteClosed();
        };
        r = f.closed();
        check("closeSeq: closes that never stop end the run with RETRY", r == Result.RETRY
            && f.log.has("upload_retry reason=still_closing"), "r=" + r);
    }

    // Two accounts behind one Http: the uploader talks to whichever Drive is current.
    static final class SwitchHttp implements SegmentUploader.Http {
        volatile FakeDrive cur;
        SwitchHttp(FakeDrive d) { cur = d; }
        public Resp send(String m, String u, String t, String c, byte[] b) throws IOException { return cur.send(m, u, t, c, b); }
    }

    static void testAccountSwitch() throws Exception {
        FakeDrive first = new FakeDrive();
        SwitchHttp sw = new SwitchHttp(first);
        Env e = new Env("acct", sw);
        e.write(SEG_A, header("") + rows(0, 2));
        e.write(SEG_B, header("") + rows(0, 2));
        e.closed();
        check("account: first account has both segments", first.named(SEG_A).size() == 1 && first.named(SEG_B).size() == 1);
        FakeDrive second = new FakeDrive();
        sw.cur = second;
        e.tokens.acct = "b@example.com";
        Result r = e.closed();
        check("account switch: logged, and the new account receives every segment", r == Result.OK
            && e.log.has("upload_account_switch") && second.named(SEG_A).size() == 1 && second.named(SEG_B).size() == 1,
            e.log.toString());
        DFile root2 = null;
        for (DFile d : second.files) if (FOLDER.equals(d.mime) && d.name.equals("HR Monitor Sessions")) root2 = d;
        check("account switch: folder caches point into the new account", root2 != null && root2.id.equals(e.store.get("seg_root_id")));
        String state = new String(Files.readAllBytes(new File(e.dir, ".upload.json").toPath()), StandardCharsets.UTF_8);
        check("account switch: the caches hold a hash, never the email", !state.contains("@") && !String.valueOf(e.store.m).contains("@"), state);
        int writes = second.count("POST") + second.count("PATCH");
        e.closed();
        check("account switch: a later run sends nothing", second.count("POST") + second.count("PATCH") == writes);
    }

    static void testMidRunAuthChanges() throws Exception {
        Env e = new Env("midout");
        e.write(SEG_A, header("") + rows(0, 2));
        e.write(SEG_B, header("") + rows(0, 2));
        e.write(SEG_C, header("") + rows(0, 2));
        e.drive.onFileCreate = () -> e.tokens.current = null;
        Result r = e.closed();
        int up = e.drive.named(SEG_A).size() + e.drive.named(SEG_B).size() + e.drive.named(SEG_C).size();
        check("sign-out mid-run: the run stops at the next item", r == Result.SIGNED_OUT && up == 1
            && e.log.has("upload_skip reason=signed_out") && e.tokens.refreshes == 0, "r=" + r + " up=" + up + " " + e.log);
        Env a = new Env("midacct");
        a.write(SEG_A, header("") + rows(0, 2));
        a.write(SEG_B, header("") + rows(0, 2));
        a.write(SEG_C, header("") + rows(0, 2));
        a.drive.onFileCreate = () -> a.tokens.acct = "b@example.com";
        r = a.closed();
        up = a.drive.named(SEG_A).size() + a.drive.named(SEG_B).size() + a.drive.named(SEG_C).size();
        check("account change mid-run: the run stops and retries", r == Result.RETRY && up == 1
            && a.log.has("upload_skip reason=account_changed"), "r=" + r + " up=" + up);
    }

    static void testStaleRoot404() throws Exception {
        Env e = new Env("staleroot");
        DFile root = e.drive.add("HR Monitor Sessions", FOLDER, null, null, null);
        e.store.put("seg_root_id", root.id);
        // The root is deleted for good right after it passed the alive check.
        e.drive.afterMeta = () -> e.drive.files.remove(root);
        e.write(SEG_A, header("") + rows(0, 2));
        Result r = e.closed();
        DFile f = e.drive.named(SEG_A).isEmpty() ? null : e.drive.named(SEG_A).get(0);
        DFile month = e.folder("2026-10");
        DFile newRoot = e.folder("HR Monitor Sessions");
        check("stale root: a 404 from the month list re-resolves the root once", r == Result.OK && f != null
            && month != null && f.parents.contains(month.id) && newRoot != null && !newRoot.id.equals(root.id)
            && newRoot.id.equals(e.store.get("seg_root_id")), e.log.toString());
    }

    static void testTrashedFolders() throws Exception {
        Env e = new Env("trashmonth");
        DFile root = e.drive.add("HR Monitor Sessions", FOLDER, null, null, null);
        DFile month = e.drive.add("2026-10", FOLDER, root.id, null, null);
        e.store.put("seg_root_id", root.id);
        e.store.put("seg_month_2026-10", month.id);
        month.trashed = true;
        e.write(SEG_A, header("") + rows(0, 2));
        Result r = e.closed();
        DFile f = e.drive.named(SEG_A).isEmpty() ? null : e.drive.named(SEG_A).get(0);
        check("trashed month folder: dropped and re-resolved, the file avoids the trash", r == Result.OK && f != null
            && !f.parents.contains(month.id) && !month.id.equals(e.store.get("seg_month_2026-10")), e.log.toString());
        check("trashed month folder: checked once per run", countMeta(e) == 2, "meta=" + countMeta(e));
        Env t = new Env("trashroot");
        DFile r0 = t.drive.add("HR Monitor Sessions", FOLDER, null, null, null);
        DFile m0 = t.drive.add("2026-10", FOLDER, r0.id, null, null);
        t.store.put("seg_root_id", r0.id);
        t.store.put("seg_month_2026-10", m0.id);
        r0.trashed = true;
        t.write(SEG_A, header("") + rows(0, 2));
        r = t.closed();
        DFile g = t.drive.named(SEG_A).isEmpty() ? null : t.drive.named(SEG_A).get(0);
        DFile gm = g == null ? null : t.drive.byIdAny(g.parents.get(0));
        check("trashed root: a new root is used and the file lands under it", r == Result.OK && g != null && gm != null
            && !gm.parents.contains(r0.id) && !r0.id.equals(t.store.get("seg_root_id")), t.log.toString());
    }

    static void testRelistThrottle() throws Exception {
        Env e = new Env("relist");
        long base = 1_790_812_800_000L - (1_790_812_800_000L % 3_600_000L);
        List<String> names = new ArrayList<>();
        for (int i = 0; i < 205; i++) {
            String n = SegmentWriter.nameFor(base + i * 3_600_000L, "abc123");
            names.add(n);
            e.write(n, header("") + rows(0, 1));
        }
        Result r = e.closed();
        check("relist: first run uploads all 205", r == Result.OK && e.log.count("upload_done") == 205);
        e.write(".upload.json", "{broken");
        int lookups = countNameLookups(e);
        int patches = e.drive.count("PATCH");
        r = e.closed();
        int done1 = e.log.count("upload_done") - 205;
        check("relist: after a state reset at most 200 segments are looked up in one run, and the run asks for a retry",
            r == Result.RETRY && done1 == 200 && countNameLookups(e) - lookups == 200 && e.log.has("upload_throttle cap=200"),
            "r=" + r + " done=" + done1 + " lookups=" + (countNameLookups(e) - lookups));
        check("relist: copies already on Drive at the same size are not re-sent", e.drive.count("PATCH") == patches,
            "patches=" + (e.drive.count("PATCH") - patches));
        r = e.closed();
        check("relist: the next run finishes the rest and clears the throttle", r == Result.OK
            && e.log.count("upload_done") == 205 + 205
            && new String(Files.readAllBytes(new File(e.dir, ".upload.json").toPath()), StandardCharsets.UTF_8).contains("\"_relist\":false"));
        boolean dupFree = true;
        for (String n : names) if (e.drive.named(n).size() != 1) dupFree = false;
        check("relist: no duplicates", dupFree);
        testRelistOrder();
    }

    // Under the cap the open segment goes first (outside the budget), then the newest closed hours.
    static void testRelistOrder() throws Exception {
        Env e = new Env("relistorder");
        long base = 1_790_812_800_000L - (1_790_812_800_000L % 3_600_000L);
        List<String> names = new ArrayList<>();
        for (int i = 0; i < 205; i++) {
            String n = SegmentWriter.nameFor(base + i * 3_600_000L, "abc123");
            names.add(n);
            e.write(n, header("") + rows(0, 1));
        }
        // An open hour that sorts oldest (a clock set back) must still go first.
        String openName = SegmentWriter.nameFor(base - 3_600_000L, "abc123");
        String openText = header("") + rows(0, 2);
        e.write(openName, openText);
        OpenView ov = new OpenView(openName, openText.length());
        e.up.run(Mode.CLOSED, ov, false, 1000L);
        e.write(".upload.json", "{broken");
        int before = e.log.lines.size();
        Result r = e.up.run(Mode.OPEN_TICK, ov, false, 0L);
        List<String> done = new ArrayList<>();
        for (String l : e.log.lines.subList(before, e.log.lines.size())) {
            if (l.startsWith("upload_done name=")) done.add(l.substring(17, l.indexOf(' ', 17)));
        }
        check("relist order: the open segment goes first", !done.isEmpty() && done.get(0).equals(openName),
            done.isEmpty() ? "none" : done.get(0));
        check("relist order: the open segment is outside the budget (201 sent)", r == Result.RETRY && done.size() == 201,
            "r=" + r + " n=" + done.size());
        check("relist order: the newest closed hour is next and the oldest five wait",
            done.size() > 1 && done.get(1).equals(names.get(204)) && !done.contains(names.get(0))
            && !done.contains(names.get(4)) && done.contains(names.get(5)), done.size() > 1 ? done.get(1) : "none");
    }
}
