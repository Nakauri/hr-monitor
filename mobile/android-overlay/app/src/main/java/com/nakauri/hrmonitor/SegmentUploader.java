package com.nakauri.hrmonitor;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.RandomAccessFile;
import java.io.UnsupportedEncodingException;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicLong;
import java.util.concurrent.locks.ReentrantLock;

// Mirrors v2 segments to HR Monitor Sessions/<yyyy-mm>/ under drive.file: closed segments once, the open
// one on the 30-min tick. Lookup is by name across all of Drive, the oldest copy is PATCHed, and nothing
// is ever deleted. Every run holds the process-wide LOCK, so all segment Drive writes are serial.
// Pure Java: HTTP, tokens and prefs come in through interfaces (device glue: SegmentUploadWorker).
// Behaviour: scripts/jvm/SegmentUploaderTest.java.
public final class SegmentUploader {
    public static final long OPEN_PATCH_MS = 30L * 60_000L;
    static final String ROOT_NAME = "HR Monitor Sessions";
    static final String FOLDER_MIME = "application/vnd.google-apps.folder";
    static final String FILES_URL = "https://www.googleapis.com/drive/v3/files";
    static final String UPLOAD_URL = "https://www.googleapis.com/upload/drive/v3/files";
    static final String STATE_NAME = ".upload.json";
    static final String K_OPEN_NAME = "open_seg_name";
    static final String K_OPEN_ID = "open_seg_id";
    static final String K_ROOT = "seg_root_id";
    static final String K_MONTH = "seg_month_";
    static final int MAX_PAGES = 100;
    static final String K_ACCOUNT = "seg_account";
    // A run rescans until a pass finds nothing new and no segment closed meanwhile (CLOSE_SEQ unchanged).
    static final int MAX_ROUNDS = 6;
    // After a state reset or an account switch, at most this many segments are looked up per run.
    static final int RELIST_CAP = 200;
    static final long OPEN_CHECK_MS = 3_600_000L;

    // Bumped on every segment close and every worker enqueue: KEEP drops an enqueue while a run is RUNNING,
    // so the running run itself must notice the close and sweep again.
    static final AtomicLong CLOSE_SEQ = new AtomicLong();
    public static void noteClosed() { CLOSE_SEQ.incrementAndGet(); }
    static final long MAX_SEND_BYTES = 32L * 1024L * 1024L;

    static final ReentrantLock LOCK = new ReentrantLock();

    public interface Http {
        Resp send(String method, String url, String token, String contentType, byte[] body) throws IOException;
    }

    public static final class Resp {
        public final int code;
        public final String body;
        public Resp(int code, String body) { this.code = code; this.body = body != null ? body : ""; }
        boolean ok() { return code >= 200 && code < 300; }
    }

    // token(false) is the cached or refreshed token, null when signed out; token(true) forces a refresh.
    // account() is the signed-in account's email, null when unknown.
    public interface Tokens {
        String token(boolean forceRefresh) throws TransientAuthException;
        String account();
    }

    public static final class TransientAuthException extends Exception {
        public TransientAuthException(String m) { super(m); }
    }

    public interface Store {
        String get(String k);
        void put(String k, String v);
        void remove(String k);
        void removePrefix(String prefix);
    }

    public enum Mode { CLOSED, OPEN_TICK }
    public enum Result { OK, SIGNED_OUT, RETRY, BUSY }

    private static final class Transient extends Exception { Transient(String m) { super(m); } }
    private static final class SignedOut extends Exception { SignedOut(String why) { super(why); } }
    private static final class AccountChanged extends Exception { AccountChanged() { super("account_changed"); } }
    private static final class Permanent extends Exception {
        final int code;
        Permanent(int code) { super("http " + code); this.code = code; }
    }

    private final File dir;
    private final File legacyDir;
    private final Http http;
    private final Tokens tokens;
    private final Store store;
    private final LifecycleLog log;
    private final Clock clock;
    // Valid for one run, under LOCK.
    private String token;
    private String account;
    private Set<String> validated = new HashSet<>();
    // When the cached open-segment id was last seen alive (not trashed); under LOCK.
    private String openCheckedId;
    private long openCheckedAt;

    public SegmentUploader(File dir, File legacyDir, Http http, Tokens tokens, Store store, LifecycleLog log) {
        this(dir, legacyDir, http, tokens, store, log, new Clock() {
            @Override public long wallMs() { return System.currentTimeMillis(); }
            @Override public long monoMs() { return System.nanoTime() / 1_000_000L; }
        });
    }

    public SegmentUploader(File dir, File legacyDir, Http http, Tokens tokens, Store store, LifecycleLog log, Clock clock) {
        this.dir = dir;
        this.legacyDir = legacyDir;
        this.http = http;
        this.tokens = tokens;
        this.store = store;
        this.log = log;
        this.clock = clock;
    }

    // OPEN_TICK never waits for the lock [L1]; CLOSED waits up to lockWaitMs. countLegacy logs legacy_pending.
    public Result run(Mode mode, SegmentReader.OpenSegment open, boolean countLegacy, long lockWaitMs) {
        boolean locked;
        if (mode == Mode.OPEN_TICK) {
            locked = LOCK.tryLock();
        } else {
            try {
                locked = LOCK.tryLock(Math.max(0L, lockWaitMs), TimeUnit.MILLISECONDS);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                return Result.RETRY;
            }
        }
        if (!locked) {
            log.log("upload_skip reason=busy mode=" + modeName(mode));
            return Result.BUSY;
        }
        try {
            return runLocked(mode, open, countLegacy);
        } catch (Throwable t) {
            log.log("upload_fail reason=" + t);
            return Result.RETRY;
        } finally {
            token = null;
            account = null;
            LOCK.unlock();
        }
    }

    static String modeName(Mode m) { return m == Mode.OPEN_TICK ? "open30" : "closed"; }

    // Clears the cached open-segment id when it belongs to name (null: any); the next tick looks the name up again.
    public void forgetOpen(String name) {
        try {
            if (name != null && !name.equals(store.get(K_OPEN_NAME))) return;
            store.remove(K_OPEN_NAME);
            store.remove(K_OPEN_ID);
        } catch (Throwable ignored) { }
    }

    private Result runLocked(Mode mode, SegmentReader.OpenSegment open, boolean countLegacy) {
        try {
            token = tokens.token(false);
        } catch (TransientAuthException e) {
            log.log("upload_skip reason=auth_transient");
            return Result.RETRY;
        }
        if (token == null) {
            log.log("upload_skip reason=signed_out");
            if (countLegacy) log.log("legacy_pending n=unknown");
            return Result.SIGNED_OUT;
        }
        account = accountKey(tokens.account());
        validated = new HashSet<>();
        State st = State.load(new File(dir, STATE_NAME), log);
        checkAccountSwitch(st);
        int budget = st.relist ? RELIST_CAP : Integer.MAX_VALUE;
        try {
            // Every run sweeps every pending segment and .bad file, whatever enqueued it.
            // Names that failed or were deferred this run are not retried; an open segment goes once per run.
            Set<String> failed = new HashSet<>();
            Set<String> sentOpen = new HashSet<>();
            boolean legacyDone = !countLegacy;
            for (int round = 1; ; round++) {
                long seq = CLOSE_SEQ.get();
                int tried = 0;
                boolean capped = false;
                List<Item> items = scan(st, mode, open);
                if (st.relist) items = relistOrder(items);
                for (Item it : items) {
                    if (failed.contains(it.name) || (it.open && sentOpen.contains(it.name))) continue;
                    // The open segment is outside the relist budget.
                    if (!it.open) {
                        if (budget <= 0) { capped = true; break; }
                        budget--;
                    }
                    tried++;
                    ensureSameAccount();
                    try {
                        if (!uploadItem(st, it)) failed.add(it.name);
                        else if (it.open) sentOpen.add(it.name);
                    } catch (Permanent p) {
                        failed.add(it.name);
                        log.log("upload_fail name=" + it.name + " status=" + p.code);
                    }
                }
                if (capped) {
                    // RETRY: the backlog drains on WorkManager backoff, not on the next roll or sweep.
                    log.log("upload_throttle cap=" + RELIST_CAP);
                    return Result.RETRY;
                }
                boolean quiet = tried == 0 && CLOSE_SEQ.get() == seq;
                if (quiet && !legacyDone) {
                    legacyDone = true;
                    legacyPass();
                    quiet = CLOSE_SEQ.get() == seq;
                }
                if (quiet) break;
                if (round >= MAX_ROUNDS) {
                    log.log("upload_retry reason=still_closing");
                    return Result.RETRY;
                }
            }
            if (st.relist) {
                st.relist = false;
                st.save(log);
            }
        } catch (Transient t) {
            log.log("upload_retry reason=" + t.getMessage());
            return Result.RETRY;
        } catch (SignedOut s) {
            // A refresh to no token, or a token Drive still rejects: wait for sign-in, which enqueues again.
            log.log("upload_skip reason=" + s.getMessage());
            return Result.SIGNED_OUT;
        } catch (AccountChanged a) {
            log.log("upload_skip reason=account_changed");
            return Result.RETRY;
        }
        return Result.OK;
    }

    // While relisting: the open segment first, then the newest hours, each .bad file just before its segment,
    // so a capped run never leaves the current hour waiting behind a year of old names.
    static List<Item> relistOrder(List<Item> items) {
        List<Item> out = new ArrayList<>();
        for (Item it : items) if (it.open) out.add(it);
        List<Item> rest = new ArrayList<>();
        for (Item it : items) if (!it.open) rest.add(it);
        java.util.Collections.sort(rest, (a, b) -> {
            String ba = baseOf(a.name), bb = baseOf(b.name);
            int c = bb.compareTo(ba);
            if (c != 0) return c;
            boolean badA = !ba.equals(a.name), badB = !bb.equals(b.name);
            if (badA != badB) return badA ? -1 : 1;
            return a.name.compareTo(b.name);
        });
        out.addAll(rest);
        return out;
    }

    private static String baseOf(String name) {
        String b = SegmentUploadPlan.badBaseName(name);
        return b != null ? b : name;
    }

    // A different account than the caches were built for: drop the folder ids, the open id and the sent lengths,
    // so the new account receives every segment. The email itself is never logged.
    private void checkAccountSwitch(State st) {
        if (account == null) return;
        String stored = store.get(K_ACCOUNT);
        boolean switched = (stored != null && !stored.equals(account)) || (st.account != null && !st.account.equals(account));
        if (switched) {
            log.log("upload_account_switch");
            store.remove(K_ROOT);
            store.removePrefix(K_MONTH);
            forgetOpen(null);
            openCheckedId = null;
            st.m.clear();
            st.relist = true;
        }
        if (!account.equals(stored)) store.put(K_ACCOUNT, account);
        if (switched || !account.equals(st.account)) {
            st.account = account;
            st.save(log);
        }
    }

    // SHA-256 of the email, so the caches never hold the address itself; null when unknown.
    static String accountKey(String email) {
        if (email == null || email.isEmpty()) return null;
        try {
            byte[] d = java.security.MessageDigest.getInstance("SHA-256")
                .digest(email.trim().toLowerCase(java.util.Locale.US).getBytes(StandardCharsets.UTF_8));
            StringBuilder b = new StringBuilder();
            for (int i = 0; i < 12; i++) b.append(String.format(java.util.Locale.US, "%02x", d[i] & 0xff));
            return b.toString();
        } catch (java.security.NoSuchAlgorithmException e) {
            return null;
        }
    }

    // Re-read before every item: a sign-out or an account switch mid-run stops the run.
    private void ensureSameAccount() throws Transient, SignedOut, AccountChanged {
        String t;
        try {
            t = tokens.token(false);
        } catch (TransientAuthException e) {
            throw new Transient("auth_transient");
        }
        if (t == null) throw new SignedOut("signed_out");
        String a = accountKey(tokens.account());
        if (a == null ? account != null : !a.equals(account)) throw new AccountChanged();
        token = t;
    }

    // False when id is gone or in the trash; a cached folder or file id is checked once per run before use.
    private boolean alive(String id) throws Transient, SignedOut, Permanent {
        Resp r = call("GET", FILES_URL + "/" + enc(id) + "?fields=" + enc("id,trashed"), null, null);
        if (r.code == 404) return false;
        Map<String, Object> m = json(ok(r).body);
        return !Boolean.TRUE.equals(m.get("trashed"));
    }

    // ---- What to send ----

    private static final class Item {
        final String name;
        final File file;
        final boolean open;
        final long sendLen;
        final boolean restarted;
        final long maxBad;
        final List<String> badSiblings;
        Item(String name, File file, boolean open, long sendLen, boolean restarted, long maxBad, List<String> badSiblings) {
            this.name = name; this.file = file; this.open = open; this.sendLen = sendLen;
            this.restarted = restarted; this.maxBad = maxBad; this.badSiblings = badSiblings;
        }
    }

    // .bad files first, so a restarted segment's earlier bytes are on Drive under their own name before it is PATCHed.
    private List<Item> scan(State st, Mode mode, SegmentReader.OpenSegment open) throws Transient {
        List<Item> out = new ArrayList<>();
        String[] names = dir.list();
        if (names == null) return out;
        Arrays.sort(names);
        Set<String> present = new HashSet<>(Arrays.asList(names));
        st.retainOnly(present);
        Map<String, List<String>> badsByBase = new HashMap<>();
        for (String n : names) {
            String base = SegmentUploadPlan.badBaseName(n);
            if (base == null) continue;
            List<String> l = badsByBase.get(base);
            if (l == null) { l = new ArrayList<>(); badsByBase.put(base, l); }
            l.add(n);
            File f = new File(dir, n);
            if (!f.isFile()) continue;
            long len = f.length();
            long lf = lastLfOrSkip(f, len);
            if (lf < 0L) continue;
            SegmentUploadPlan.Plan p = SegmentUploadPlan.planUpload(len, lf, st.len(n), false, false, null);
            if (p.op == SegmentUploadPlan.Op.NEED_LIST) out.add(new Item(n, f, false, p.sendLen, false, 0L, null));
        }
        String openName = open != null ? open.openName() : null;
        for (String n : names) {
            if (!SegmentReader.validName(n)) continue;
            File f = new File(dir, n);
            if (!f.isFile()) continue;
            boolean isOpen = n.equals(openName);
            if (isOpen && mode != Mode.OPEN_TICK) continue;
            long cap = isOpen ? open.readableLength(n) : -1L;
            if (cap < 0L) { isOpen = false; cap = f.length(); }
            long lf = lastLfOrSkip(f, cap);
            if (lf < 0L) continue;
            List<String> bads = badsByBase.get(n);
            long maxBad = 0L;
            long[] badMs = null;
            if (bads != null) {
                badMs = new long[bads.size()];
                for (int i = 0; i < bads.size(); i++) {
                    badMs[i] = SegmentUploadPlan.badMarkerMs(bads.get(i));
                    maxBad = Math.max(maxBad, badMs[i]);
                }
            }
            boolean restarted = SegmentUploadPlan.restarted(st.bad(n), badMs);
            long uploaded = restarted ? -1L : st.len(n);
            SegmentUploadPlan.Plan p = SegmentUploadPlan.planUpload(cap, lf, uploaded, isOpen,
                mode == Mode.OPEN_TICK, null);
            if (p.op == SegmentUploadPlan.Op.NEED_LIST) {
                out.add(new Item(n, f, isOpen, p.sendLen, restarted, restarted ? maxBad : st.bad(n), bads));
            }
        }
        return out;
    }

    // One unreadable file is skipped and logged; it never stops the other uploads.
    private long lastLfOrSkip(File f, long cap) {
        try {
            return SegmentReader.lastLfLength(f, cap);
        } catch (IOException e) {
            log.log("upload_skip reason=read name=" + f.getName());
            return -1L;
        }
    }

    private static long lastLf(File f, long cap) throws Transient {
        try {
            return SegmentReader.lastLfLength(f, cap);
        } catch (IOException e) {
            throw new Transient("read " + f.getName() + " " + e.getMessage());
        }
    }

    // False when the item was left for a later run (bad_pending, too_large, short_read).
    private boolean uploadItem(State st, Item it) throws Transient, SignedOut, Permanent {
        if (it.restarted && it.badSiblings != null) {
            for (String b : it.badSiblings) {
                if (SegmentUploadPlan.badMarkerMs(b) <= st.bad(it.name)) continue;
                File bf = new File(dir, b);
                // A .bad file too large to send stays on the phone and never blocks its segment.
                if (bf.length() > MAX_SEND_BYTES) continue;
                if (st.len(b) != lastLf(bf, bf.length())) {
                    log.log("upload_skip reason=bad_pending name=" + it.name);
                    return false;
                }
            }
        }
        if (it.sendLen > MAX_SEND_BYTES) {
            log.log("upload_skip reason=too_large name=" + it.name + " bytes=" + it.sendLen);
            return false;
        }
        byte[] data = readPrefix(it.file, it.sendLen);
        if (data == null) {
            log.log("upload_skip reason=short_read name=" + it.name);
            return false;
        }
        long t0 = System.nanoTime();
        String op = null;
        String id = null;
        if (it.open) {
            String cachedId = it.name.equals(store.get(K_OPEN_NAME)) ? store.get(K_OPEN_ID) : null;
            if (cachedId != null && !cachedId.isEmpty()) {
                long now = clock.wallMs();
                boolean recent = cachedId.equals(openCheckedId) && now >= openCheckedAt && now - openCheckedAt < OPEN_CHECK_MS;
                // Drive accepts a PATCH to a trashed file, so the id is checked at most once an hour.
                if (!recent) {
                    if (alive(cachedId)) {
                        openCheckedId = cachedId;
                        openCheckedAt = now;
                    } else {
                        forgetOpen(null);
                        cachedId = null;
                    }
                }
            }
            if (cachedId != null && !cachedId.isEmpty()) {
                Resp r = call("PATCH", patchUrl(cachedId), "text/csv", data);
                if (r.ok()) {
                    op = "patch";
                    id = cachedId;
                } else if (r.code == 404) {
                    forgetOpen(null);
                } else {
                    raise(r);
                }
            }
        }
        for (int attempt = 0; op == null; attempt++) {
            SegmentUploadPlan.Remote[] listed = listByName(it.name);
            SegmentUploadPlan.Plan p = SegmentUploadPlan.planUpload(it.sendLen, it.sendLen, -1L, false, true, listed);
            Resp r;
            if (p.op == SegmentUploadPlan.Op.CREATE) {
                String month = SegmentUploadPlan.monthOf(it.name);
                r = createFile(monthFolder(month), it.name, data);
                if (r.code == 404 && attempt == 0) {
                    // The cached folder is gone: resolve root and month again.
                    store.remove(K_MONTH + month);
                    store.remove(K_ROOT);
                    continue;
                }
                if (!r.ok()) raise(r);
                op = "create";
                id = idOf(r);
            } else {
                SegmentUploadPlan.Remote target = SegmentUploadPlan.oldest(listed);
                // Same size and no restart: Drive already holds these bytes (a shared prefix of equal length).
                if (!it.restarted && target != null && target.size == it.sendLen) {
                    op = "match";
                    id = p.targetId;
                    break;
                }
                r = call("PATCH", patchUrl(p.targetId), "text/csv", data);
                if (r.code == 404 && attempt == 0) continue;
                if (!r.ok()) raise(r);
                op = "patch";
                id = p.targetId;
            }
        }
        st.put(it.name, it.sendLen, it.maxBad);
        st.save(log);
        if (it.open && id != null && !id.isEmpty()) {
            store.put(K_OPEN_NAME, it.name);
            store.put(K_OPEN_ID, id);
            if (!id.equals(openCheckedId)) {
                openCheckedId = id;
                openCheckedAt = clock.wallMs();
            }
        }
        long ms = (System.nanoTime() - t0) / 1_000_000L;
        log.log("upload_done name=" + it.name + " op=" + op + " bytes=" + it.sendLen + " ms=" + ms
            + (it.restarted ? " restarted=true" : ""));
        return true;
    }

    private static byte[] readPrefix(File f, long len) {
        byte[] buf = new byte[(int) len];
        try (RandomAccessFile raf = new RandomAccessFile(f, "r")) {
            int got = 0;
            while (got < buf.length) {
                int n = raf.read(buf, got, buf.length - got);
                if (n < 0) return null;
                got += n;
            }
            return buf;
        } catch (IOException e) {
            return null;
        }
    }

    // ---- Drive calls ----

    // One 401 retry with a forced refresh; a refresh to no token means signed out.
    private Resp call(String method, String url, String contentType, byte[] body) throws Transient, SignedOut {
        Resp r = send(method, url, token, contentType, body);
        if (r.code != 401) return r;
        String fresh;
        try {
            fresh = tokens.token(true);
        } catch (TransientAuthException e) {
            throw new Transient("auth_transient");
        }
        if (fresh == null) throw new SignedOut("signed_out");
        if (fresh.equals(token)) throw new SignedOut("auth_rejected");
        token = fresh;
        r = send(method, url, token, contentType, body);
        if (r.code == 401) throw new SignedOut("auth_rejected");
        return r;
    }

    private Resp send(String method, String url, String tok, String contentType, byte[] body) throws Transient {
        try {
            Resp r = http.send(method, url, tok, contentType, body);
            if (r == null) throw new Transient("no_response");
            return r;
        } catch (IOException e) {
            throw new Transient("io " + e.getMessage());
        }
    }

    // 5xx, 429 and a rate-limited 403 are worth a later retry; the rest are not.
    private static void raise(Resp r) throws Transient, Permanent {
        int c = r.code;
        boolean rl = (c == 403 || c == 429) && (r.body.contains("userRateLimitExceeded") || r.body.contains("rateLimitExceeded"));
        if (c >= 500 || c == 429 || rl || c == 0) throw new Transient("http " + c);
        throw new Permanent(c);
    }

    private static Resp ok(Resp r) throws Transient, Permanent {
        if (!r.ok()) raise(r);
        return r;
    }

    static String esc(String v) { return v.replace("\\", "\\\\").replace("'", "\\'"); }

    static String enc(String v) {
        try {
            return URLEncoder.encode(v, "UTF-8").replace("+", "%20");
        } catch (UnsupportedEncodingException e) {
            throw new IllegalStateException(e);
        }
    }

    static String patchUrl(String id) { return UPLOAD_URL + "/" + enc(id) + "?uploadType=media&fields=id,size"; }

    // Every same-name file in Drive regardless of folder [K9], every page, oldest first.
    SegmentUploadPlan.Remote[] listByName(String name) throws Transient, SignedOut, Permanent {
        return listQuery("name='" + esc(name) + "' and trashed=false").toArray(new SegmentUploadPlan.Remote[0]);
    }

    private List<SegmentUploadPlan.Remote> listQuery(String q) throws Transient, SignedOut, Permanent {
        List<SegmentUploadPlan.Remote> out = new ArrayList<>();
        String pageToken = null;
        int pages = 0;
        do {
            String url = FILES_URL + "?q=" + enc(q) + "&orderBy=createdTime"
                + "&fields=" + enc("nextPageToken,files(id,name,size,createdTime)")
                + "&pageSize=100&spaces=drive"
                + (pageToken != null ? "&pageToken=" + enc(pageToken) : "");
            Resp r = ok(call("GET", url, null, null));
            Map<String, Object> m = json(r.body);
            Object files = m.get("files");
            if (files instanceof List) {
                for (Object o : (List<?>) files) {
                    if (!(o instanceof Map)) continue;
                    @SuppressWarnings("unchecked") Map<String, Object> f = (Map<String, Object>) o;
                    String id = MiniJson.str(f, "id");
                    if (id == null || id.isEmpty()) continue;
                    out.add(new SegmentUploadPlan.Remote(id, MiniJson.num(f, "size"), MiniJson.str(f, "createdTime")));
                }
            }
            pageToken = MiniJson.str(m, "nextPageToken");
            if (pageToken != null && pageToken.isEmpty()) pageToken = null;
            pages++;
        } while (pageToken != null && pages < MAX_PAGES);
        // Never pick an oldest copy from a partial listing.
        if (pageToken != null) throw new Transient("too_many_pages");
        return out;
    }

    private static Map<String, Object> json(String body) throws Transient {
        try {
            return MiniJson.parseObject(body);
        } catch (IllegalArgumentException e) {
            throw new Transient("bad_json");
        }
    }

    private static String idOf(Resp r) throws Transient {
        String id = MiniJson.str(json(r.body), "id");
        if (id == null || id.isEmpty()) throw new Transient("no_id");
        return id;
    }

    // Oldest root by createdTime, id breaking ties: the same pick as the viewer's driveEnsureFolder and
    // NativeDriveUploader.ensureFolder, so all three agree when more than one root exists.
    String rootFolder() throws Transient, SignedOut, Permanent {
        String cached = store.get(K_ROOT);
        if (cached != null && !cached.isEmpty()) {
            if (validated.contains(cached)) return cached;
            if (alive(cached)) {
                validated.add(cached);
                return cached;
            }
            log.log("upload_folder_gone name=root");
            store.remove(K_ROOT);
            store.removePrefix(K_MONTH);
        }
        String q = "name='" + ROOT_NAME + "' and mimeType='" + FOLDER_MIME + "' and trashed=false";
        String url = FILES_URL + "?q=" + enc(q) + "&orderBy=createdTime&fields=" + enc("files(id,name,createdTime)")
            + "&spaces=drive";
        String id = firstId(ok(call("GET", url, null, null)));
        if (id == null) {
            String created = idOf(ok(call("POST", FILES_URL + "?fields=id", "application/json; charset=UTF-8",
                folderBody(ROOT_NAME, null))));
            String again = firstId(ok(call("GET", url, null, null)));
            id = again != null ? again : created;
            log.log("upload_folder_create name=root id_reused=" + !id.equals(created));
        }
        store.put(K_ROOT, id);
        validated.add(id);
        return id;
    }

    // Oldest folder on the first page of a createdTime-ordered listing; null when there is none.
    private static String firstId(Resp r) throws Transient {
        Object files = json(r.body).get("files");
        List<SegmentUploadPlan.Remote> l = new ArrayList<>();
        if (files instanceof List) {
            for (Object o : (List<?>) files) {
                if (!(o instanceof Map)) continue;
                @SuppressWarnings("unchecked") Map<String, Object> f = (Map<String, Object>) o;
                l.add(new SegmentUploadPlan.Remote(MiniJson.str(f, "id"), 0L, MiniJson.str(f, "createdTime")));
            }
        }
        SegmentUploadPlan.Remote best = SegmentUploadPlan.oldest(l.toArray(new SegmentUploadPlan.Remote[0]));
        return best != null ? best.id : null;
    }

    // HR Monitor Sessions/<yyyy-mm>. After a create, re-list and take the oldest, so racing creators converge.
    String monthFolder(String month) throws Transient, SignedOut, Permanent {
        if (month == null) throw new Permanent(0);
        // Root first: a trashed or deleted root drops every cached month id with it.
        String root = rootFolder();
        String cached = store.get(K_MONTH + month);
        if (cached != null && !cached.isEmpty()) {
            if (validated.contains(cached)) return cached;
            if (alive(cached)) {
                validated.add(cached);
                return cached;
            }
            log.log("upload_folder_gone name=" + month);
            store.remove(K_MONTH + month);
        }
        String q = monthQuery(month, root);
        List<SegmentUploadPlan.Remote> found;
        try {
            found = listQuery(q);
        } catch (Permanent p) {
            if (p.code != 404) throw p;
            // The cached root no longer exists: resolve it once more.
            store.remove(K_ROOT);
            validated.remove(root);
            root = rootFolder();
            q = monthQuery(month, root);
            found = listQuery(q);
        }
        SegmentUploadPlan.Remote oldest = SegmentUploadPlan.oldest(found.toArray(new SegmentUploadPlan.Remote[0]));
        String id;
        if (oldest != null) {
            id = oldest.id;
        } else {
            Resp c = call("POST", FILES_URL + "?fields=id", "application/json; charset=UTF-8", folderBody(month, root));
            if (c.code == 404) {
                store.remove(K_ROOT);
                throw new Transient("root_gone");
            }
            String created = idOf(ok(c));
            SegmentUploadPlan.Remote after = SegmentUploadPlan.oldest(
                listQuery(q).toArray(new SegmentUploadPlan.Remote[0]));
            id = after != null ? after.id : created;
            log.log("upload_folder_create name=" + month + " id_reused=" + !id.equals(created));
        }
        store.put(K_MONTH + month, id);
        validated.add(id);
        return id;
    }

    private static String monthQuery(String month, String root) {
        return "name='" + month + "' and '" + esc(root) + "' in parents and mimeType='" + FOLDER_MIME + "' and trashed=false";
    }

    private static byte[] folderBody(String name, String parent) {
        String j = "{\"name\":" + MiniJson.quote(name) + ",\"mimeType\":" + MiniJson.quote(FOLDER_MIME)
            + (parent != null ? ",\"parents\":[" + MiniJson.quote(parent) + "]" : "") + "}";
        return j.getBytes(StandardCharsets.UTF_8);
    }

    // Multipart create, the same wire format as NativeDriveUploader.createFile.
    private Resp createFile(String folderId, String name, byte[] data) throws Transient, SignedOut {
        String boundary = "-------hr-monitor-" + Long.toHexString(System.nanoTime());
        String meta = "{\"name\":" + MiniJson.quote(name) + ",\"parents\":[" + MiniJson.quote(folderId)
            + "],\"mimeType\":\"text/csv\"}";
        byte[] hdr = ("--" + boundary + "\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n" + meta
            + "\r\n--" + boundary + "\r\nContent-Type: text/csv\r\n\r\n").getBytes(StandardCharsets.UTF_8);
        byte[] ftr = ("\r\n--" + boundary + "--\r\n").getBytes(StandardCharsets.UTF_8);
        byte[] body = new byte[hdr.length + data.length + ftr.length];
        System.arraycopy(hdr, 0, body, 0, hdr.length);
        System.arraycopy(data, 0, body, hdr.length, data.length);
        System.arraycopy(ftr, 0, body, hdr.length + data.length, ftr.length);
        return call("POST", UPLOAD_URL + "?uploadType=multipart&fields=id,size",
            "multipart/related; boundary=" + boundary, body);
    }

    // ---- legacy_pending [L7] ----

    private void legacyPass() {
        try {
            Map<String, Long> local = new HashMap<>();
            String[] names = legacyDir != null ? legacyDir.list() : null;
            if (names != null) {
                for (String n : names) {
                    if (!n.startsWith("hrv_session_") || !n.endsWith(".csv")) continue;
                    File f = new File(legacyDir, n);
                    if (f.isFile()) local.put(n, f.length());
                }
            }
            Map<String, Long> driveMax = new HashMap<>();
            if (!local.isEmpty()) {
                driveMax = maxSizeByName("'" + esc(rootFolder()) + "' in parents and name contains 'hrv_session' and trashed=false");
            }
            log.log("legacy_pending n=" + SegmentUploadPlan.legacyPendingText(
                SegmentUploadPlan.legacyPending(local, driveMax)) + " local=" + local.size());
        } catch (Throwable t) {
            log.log("legacy_pending n=unknown reason=" + t.getMessage());
        }
    }

    // Largest size per name over every page of q.
    private Map<String, Long> maxSizeByName(String q) throws Transient, SignedOut, Permanent {
        Map<String, Long> out = new HashMap<>();
        String pageToken = null;
        int pages = 0;
        do {
            String url = FILES_URL + "?q=" + enc(q) + "&fields=" + enc("nextPageToken,files(id,name,size)")
                + "&pageSize=1000&spaces=drive" + (pageToken != null ? "&pageToken=" + enc(pageToken) : "");
            Map<String, Object> m = json(ok(call("GET", url, null, null)).body);
            Object files = m.get("files");
            if (files instanceof List) {
                for (Object o : (List<?>) files) {
                    if (!(o instanceof Map)) continue;
                    @SuppressWarnings("unchecked") Map<String, Object> f = (Map<String, Object>) o;
                    String n = MiniJson.str(f, "name");
                    if (n == null) continue;
                    long size = MiniJson.num(f, "size");
                    Long prev = out.get(n);
                    if (prev == null || size > prev) out.put(n, size);
                }
            }
            pageToken = MiniJson.str(m, "nextPageToken");
            if (pageToken != null && pageToken.isEmpty()) pageToken = null;
            pages++;
        } while (pageToken != null && pages < MAX_PAGES);
        if (pageToken != null) throw new Transient("too_many_pages");
        return out;
    }

    // ---- segments/.upload.json: name -> {n: bytes sent, b: newest .bad marker seen} ----

    static final class State {
        final File file;
        final Map<String, long[]> m = new TreeMap<>();
        // The account these lengths were sent to; relist throttles the lookups after a reset or a switch.
        String account;
        boolean relist;
        State(File file) { this.file = file; }

        static State load(File f, LifecycleLog log) {
            State s = new State(f);
            if (!f.isFile()) return s;
            try {
                byte[] raw = new byte[(int) f.length()];
                try (RandomAccessFile raf = new RandomAccessFile(f, "r")) { raf.readFully(raw); }
                Map<String, Object> top = MiniJson.parseObject(new String(raw, StandardCharsets.UTF_8));
                Object acct = top.get("_account");
                if (acct instanceof String) s.account = (String) acct;
                s.relist = Boolean.TRUE.equals(top.get("_relist"));
                for (Map.Entry<String, Object> e : top.entrySet()) {
                    if (!(e.getValue() instanceof Map)) continue;
                    @SuppressWarnings("unchecked") Map<String, Object> v = (Map<String, Object>) e.getValue();
                    long n = MiniJson.num(v, "n");
                    long b = MiniJson.num(v, "b");
                    if (n >= 0L) s.m.put(e.getKey(), new long[] { n, Math.max(b, 0L) });
                }
            } catch (Throwable t) {
                // Losing the state only costs a lookup and a resend per segment; the name lookup prevents duplicates.
                log.log("upload_state_reset reason=" + t.getMessage());
                s.m.clear();
                s.account = null;
                s.relist = true;
            }
            return s;
        }

        long len(String name) { long[] v = m.get(name); return v != null ? v[0] : -1L; }
        long bad(String name) { long[] v = m.get(name); return v != null ? v[1] : 0L; }
        void put(String name, long n, long b) { m.put(name, new long[] { n, b }); }
        void retainOnly(Set<String> names) { m.keySet().retainAll(names); }

        // Temp file, fsync, then rename over the old one.
        void save(LifecycleLog log) {
            StringBuilder sb = new StringBuilder("{\"_relist\":").append(relist);
            if (account != null) sb.append(",\"_account\":").append(MiniJson.quote(account));
            boolean first = false;
            for (Map.Entry<String, long[]> e : m.entrySet()) {
                if (!first) sb.append(',');
                first = false;
                sb.append(MiniJson.quote(e.getKey())).append(":{\"n\":").append(e.getValue()[0])
                    .append(",\"b\":").append(e.getValue()[1]).append('}');
            }
            sb.append("}\n");
            File tmp = new File(file.getParentFile(), file.getName() + ".tmp");
            try {
                try (FileOutputStream o = new FileOutputStream(tmp)) {
                    o.write(sb.toString().getBytes(StandardCharsets.UTF_8));
                    o.flush();
                    o.getFD().sync();
                }
                if (!tmp.renameTo(file)) {
                    // Rename does not replace on every filesystem (Windows test hosts); Android's does.
                    if (!file.delete() || !tmp.renameTo(file)) throw new IOException("rename_failed");
                }
            } catch (IOException e) {
                log.log("upload_state_save_fail reason=" + e.getMessage());
                tmp.delete();
            }
        }
    }
}
