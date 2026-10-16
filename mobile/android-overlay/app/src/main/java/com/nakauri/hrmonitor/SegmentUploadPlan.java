package com.nakauri.hrmonitor;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

// Pure decisions for the v2 segment uploader (B-c) and the B-d2 cleanup policy. No I/O, no android.*.
// Behaviour: scripts/jvm/UploadPlanTest.java.
public final class SegmentUploadPlan {
    private SegmentUploadPlan() {}

    // A segment the writer moved aside: hrm_..._iid.csv.bad-<ms>. Uploaded under its own name, never read by a viewer.
    public static final Pattern BAD_PATTERN =
        Pattern.compile("^(hrm_(\\d{8})T(\\d{2})Z_([a-z0-9]{6})\\.csv)\\.bad-(\\d{1,19})$");
    public static final long CLEANUP_MIN_AGE_MS = 30L * 24L * 3_600_000L;
    public static final long SIGNED_OUT_CAP_BYTES = 1024L * 1024L * 1024L;

    // One same-name file from a global Drive lookup.
    public static final class Remote {
        public final String id;
        public final long size;
        public final String createdTime;
        public Remote(String id, long size, String createdTime) {
            this.id = id; this.size = size; this.createdTime = createdTime;
        }
    }

    public enum Op { SKIP_OPEN, SKIP_EMPTY, SKIP_SAME, NEED_LIST, CREATE, PATCH }

    public static final class Plan {
        public final Op op;
        // Bytes to send: the file up to its last LF inside the length snapshot.
        public final long sendLen;
        public final String targetId;
        Plan(Op op, long sendLen, String targetId) { this.op = op; this.sendLen = sendLen; this.targetId = targetId; }
    }

    // uploadedLen < 0: never sent, or the local file restarted since it was sent. listedGlobal null: not looked up yet.
    public static Plan planUpload(long localLen, long lastLfLen, long uploadedLen, boolean isOpen, boolean openTick,
            Remote[] listedGlobal) {
        if (isOpen && !openTick) return new Plan(Op.SKIP_OPEN, 0L, null);
        long send = Math.min(Math.max(lastLfLen, 0L), Math.max(localLen, 0L));
        if (send <= 0L) return new Plan(Op.SKIP_EMPTY, 0L, null);
        if (uploadedLen >= 0L && send == uploadedLen) return new Plan(Op.SKIP_SAME, send, null);
        if (listedGlobal == null) return new Plan(Op.NEED_LIST, send, null);
        Remote oldest = oldest(listedGlobal);
        if (oldest == null) return new Plan(Op.CREATE, send, null);
        return new Plan(Op.PATCH, send, oldest.id);
    }

    // Oldest by createdTime (RFC 3339 UTC, so text order is time order); id breaks ties, as the viewer does.
    public static Remote oldest(Remote[] list) {
        Remote best = null;
        if (list == null) return null;
        for (Remote r : list) {
            if (r == null || r.id == null || r.id.isEmpty()) continue;
            if (best == null || older(r, best)) best = r;
        }
        return best;
    }

    static boolean older(Remote a, Remote b) {
        String ta = a.createdTime, tb = b.createdTime;
        if (ta != null && tb == null) return true;
        if (ta == null && tb != null) return false;
        if (ta != null) {
            int c = ta.compareTo(tb);
            if (c != 0) return c < 0;
        }
        return a.id.compareTo(b.id) < 0;
    }

    // A restart is any .bad sibling newer than the one recorded with the last upload.
    public static boolean restarted(long recordedBadMs, long[] badSiblingMs) {
        if (badSiblingMs == null) return false;
        for (long ms : badSiblingMs) if (ms > recordedBadMs) return true;
        return false;
    }

    // Name of the segment a .bad file came from, or null.
    public static String badBaseName(String name) {
        Matcher m = name != null ? BAD_PATTERN.matcher(name) : null;
        return m != null && m.matches() ? m.group(1) : null;
    }

    public static long badMarkerMs(String name) {
        Matcher m = name != null ? BAD_PATTERN.matcher(name) : null;
        if (m == null || !m.matches()) return Long.MIN_VALUE;
        try { return Long.parseLong(m.group(5)); } catch (NumberFormatException e) { return Long.MIN_VALUE; }
    }

    // UTC month folder name, yyyy-mm, for a segment or .bad name; null for anything else.
    public static String monthOf(String name) {
        if (name == null) return null;
        String base = SegmentWriter.NAME_PATTERN.matcher(name).matches() ? name : badBaseName(name);
        if (base == null) return null;
        return base.substring(4, 8) + "-" + base.substring(8, 10);
    }

    // ---- legacy_pending [L7] and the removal guard [L8] ----

    // Local legacy files whose size exceeds the largest same-name Drive size (missing = 0). -1 = unknown (signed out).
    public static int legacyPending(Map<String, Long> localSizes, Map<String, Long> driveMaxSizes) {
        if (driveMaxSizes == null) return -1;
        int n = 0;
        for (Map.Entry<String, Long> e : localSizes.entrySet()) {
            if (!legacyOnDrive(e.getValue(), driveMaxSizes.get(e.getKey()))) n++;
        }
        return n;
    }

    // A legacy file is on Drive when a same-name Drive copy is at least its size (missing = 0).
    public static boolean legacyOnDrive(long localSize, Long driveMaxSize) {
        return localSize <= (driveMaxSize != null ? driveMaxSize : 0L);
    }

    public static String legacyPendingText(int n) { return n < 0 ? "unknown" : String.valueOf(n); }

    // The legacy orphan pass keeps running while any local legacy file exists, or until two signed-in passes read 0.
    public static boolean legacyPassNeeded(int localLegacyFiles, int signedInZeroReads) {
        return localLegacyFiles > 0 || signedInZeroReads < 2;
    }

    // ---- B-d2 cleanup policy (not wired in B-c; B-c deletes nothing) ----

    public static final class LocalSeg {
        public final String name;
        public final long hourBase;
        public final long lastLfLen;
        public LocalSeg(String name, long hourBase, long lastLfLen) {
            this.name = name; this.hourBase = hourBase; this.lastLfLen = lastLfLen;
        }
    }

    // driveSizes: name -> sizes of every same-name copy from a fresh (name, size) re-list; null when signed out.
    // Never the open or previous segment. Signed in: a Drive copy of equal size and an hour over 30 days old.
    // Signed out: never by age; only past the cap, oldest first, after the settings notice.
    public static List<String> planCleanup(List<LocalSeg> segs, Map<String, long[]> driveSizes, String openName,
            String previousName, long nowMs, long totalBytes, long capBytes, boolean noticeShown) {
        List<String> out = new ArrayList<>();
        List<LocalSeg> sorted = new ArrayList<>(segs);
        Collections.sort(sorted, (a, b) -> Long.compare(a.hourBase, b.hourBase));
        if (driveSizes != null) {
            for (LocalSeg s : sorted) {
                if (s.name.equals(openName) || s.name.equals(previousName)) continue;
                if (s.hourBase + 3_600_000L > nowMs - CLEANUP_MIN_AGE_MS) continue;
                long[] sizes = driveSizes.get(s.name);
                if (sizes == null) continue;
                for (long sz : sizes) {
                    if (sz == s.lastLfLen && sz > 0L) { out.add(s.name); break; }
                }
            }
            return out;
        }
        if (!noticeShown || totalBytes <= capBytes) return out;
        long total = totalBytes;
        for (LocalSeg s : sorted) {
            if (total <= capBytes) break;
            if (s.name.equals(openName) || s.name.equals(previousName)) continue;
            out.add(s.name);
            total -= s.lastLfLen;
        }
        return out;
    }
}
