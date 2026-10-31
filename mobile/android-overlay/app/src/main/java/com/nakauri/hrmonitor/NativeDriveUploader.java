package com.nakauri.hrmonitor;

import android.content.Context;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicReference;

import okhttp3.MediaType;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;

// Whole-file Drive uploads of finished session CSVs: one at Stop, and the orphan passes that catch any
// CSV Stop could not send. Never runs on the recording session's file; hourly segments back that up
// (SegmentUploader). Every send honours the Drive pause and the metered cap (DrivePolicy).
// Auth comes from AuthStorage, so these work with the WebView paused.
public class NativeDriveUploader {
    private static final String TAG = "NativeDriveUploader";
    private static final String DRIVE_FOLDER_NAME = "HR Monitor Sessions";
    private static final String FOLDER_MIME = "application/vnd.google-apps.folder";
    // List-then-create is one step across every instance, so two passes never create a same-name twin.
    private static final Object SEND_LOCK = new Object();

    private final Context context;
    private final OkHttpClient client;
    private final ExecutorService executor;
    private final AtomicReference<String> folderIdRef = new AtomicReference<>(null);
    private final AtomicReference<String> sessionFilenameRef = new AtomicReference<>(null);
    // Stopped files still in their stop upload, process-wide; orphan passes skip them to avoid a duplicate create.
    private static final java.util.Set<String> FINALIZING =
        java.util.Collections.newSetFromMap(new java.util.concurrent.ConcurrentHashMap<String, Boolean>());

    public static void markFinalizing(String name) { if (name != null) FINALIZING.add(name); }
    public static void clearFinalizing(String name) { if (name != null) FINALIZING.remove(name); }

    public NativeDriveUploader(Context context) {
        this.context = context.getApplicationContext();
        // Shared HTTP client; each Drive request is one-shot so we use
        // the default-timeout variant rather than the WebSocket one.
        this.client = HttpClientHolder.http();
        this.executor = Executors.newSingleThreadExecutor();
    }

    /** Reset session-scoped state at the start of a new session. */
    public void resetSession() {
        sessionFilenameRef.set(null);
    }

    // Stamps the recording session's file, so cleanup and the orphan passes leave it alone.
    public void markActiveSessionFilename(String name) {
        sessionFilenameRef.set(name);
    }

    // After Stop the file is no longer the active one, unless a newer session already took the slot.
    public void clearActiveSessionFilename(String name) {
        if (name != null) sessionFilenameRef.compareAndSet(name, null);
    }

    // A new sign-in may be another account, whose folder id differs.
    public void forgetFolder() { folderIdRef.set(null); }

    /** Folder lookup, cached per process. */
    public String getOrFetchFolderIdSync(String token) throws IOException {
        String fid = folderIdRef.get();
        if (fid != null) return fid;
        fid = ensureFolder(token);
        if (fid != null) folderIdRef.set(fid);
        return fid;
    }

    private boolean fullFileAllowed(File f) {
        return DrivePolicy.allowFullFile(f.length(), DriveGate.metered(context), DriveGate.paused(context));
    }

    // Persona-aware retention. Drive users get generous limits (Drive holds
    // durable copy); no-Drive users get tight limits (local is ephemeral).
    private static final long CAP_BYTES_DRIVE       = 200L * 1024L * 1024L;
    private static final long CAP_BYTES_NO_DRIVE    =  50L * 1024L * 1024L;
    private static final long AGE_FALLBACK_DRIVE    = 14L * 24L * 60L * 60L * 1000L;
    private static final long AGE_FALLBACK_NO_DRIVE =  2L * 24L * 60L * 60L * 1000L;
    private static final int  KEEP_RECENT_FLOOR     = 3;

    // Three-tier cleanup: 1) Drive-verified delete, 2) age fallback, 3) byte cap.
    // Signed in, a CSV goes only once Drive holds it in full; an unknown Drive state deletes nothing.
    // Signed out, only the byte cap deletes: age proves nothing about a file that may never have uploaded.
    // KEEP_RECENT_FLOOR + active session are protected at every tier.
    public void cleanupLocalCachedAsync(File sessionsDir, long minAgeMs) {
        if (sessionsDir == null || !sessionsDir.isDirectory()) return;
        executor.submit(() -> {
            try {
                runCleanup(sessionsDir, minAgeMs);
            } catch (Throwable t) {
                Log.w(TAG, "cleanup threw: " + t.getMessage());
            }
        });
    }

    private static boolean heldInFull(java.util.Map<String, DriveFileInfo> driveFiles, File f) {
        if (driveFiles == null) return false;
        DriveFileInfo info = driveFiles.get(f.getName());
        return SegmentUploadPlan.legacyOnDrive(f.length(), info != null ? info.size : null);
    }

    private void runCleanup(File sessionsDir, long minAgeMs) {
        File[] localFiles = sessionsDir.listFiles();
        if (localFiles == null) return;
        String activeName = sessionFilenameRef.get();
        long now = System.currentTimeMillis();

        boolean signedIn = AuthStorage.isSignedIn(context);
        if (signedIn && DriveGate.paused(context)) return;
        java.util.Map<String, DriveFileInfo> driveFiles = null;
        try {
            String token = AuthStorage.getValidAccessToken(context);
            if (token != null) {
                String folderId = getOrFetchFolderIdSync(token);
                if (folderId != null) driveFiles = listDriveFiles(token, folderId);
            }
        } catch (Throwable t) {
            Log.w(TAG, "cleanup: Drive lookup failed: " + t.getMessage());
        }
        if (signedIn && driveFiles == null) {
            Log.i(TAG, "cleanup skipped: Drive state unknown");
            return;
        }
        boolean driveActive = driveFiles != null;

        long capBytes      = driveActive ? CAP_BYTES_DRIVE      : CAP_BYTES_NO_DRIVE;
        long fallbackMs    = driveActive ? AGE_FALLBACK_DRIVE   : AGE_FALLBACK_NO_DRIVE;
        long ageCutoff     = now - minAgeMs;
        long fallbackCutoff = now - fallbackMs;

        java.util.List<File> csvList = new java.util.ArrayList<>();
        for (File f : localFiles) {
            if (f.isFile() && f.getName().endsWith(".csv")) csvList.add(f);
        }
        java.util.Collections.sort(csvList, (a, b) -> Long.compare(b.lastModified(), a.lastModified()));
        java.util.Set<String> keepFloor = new java.util.HashSet<>();
        for (int i = 0; i < Math.min(KEEP_RECENT_FLOOR, csvList.size()); i++) {
            keepFloor.add(csvList.get(i).getName());
        }
        if (activeName != null) keepFloor.add(activeName);

        int tier1 = 0, tier2 = 0, tier3 = 0;
        long freedT1 = 0, freedT2 = 0, freedT3 = 0;

        for (File f : csvList) {
            if (keepFloor.contains(f.getName())) continue;
            boolean onDrive = heldInFull(driveFiles, f);
            if (signedIn && !onDrive) continue;
            if (onDrive && f.lastModified() <= ageCutoff) {
                long len = f.length();
                if (f.delete()) { tier1++; freedT1 += len; }
                continue;
            }
            if (signedIn && f.lastModified() <= fallbackCutoff) {
                long len = f.length();
                if (f.delete()) { tier2++; freedT2 += len; }
            }
        }

        File[] remaining = sessionsDir.listFiles();
        long total = 0;
        if (remaining != null) for (File f : remaining) if (f.isFile()) total += f.length();
        if (remaining != null && total > capBytes) {
            java.util.List<File> survivors = new java.util.ArrayList<>();
            for (File f : remaining) if (f.isFile() && f.getName().endsWith(".csv")) survivors.add(f);
            java.util.Collections.sort(survivors, (a, b) -> Long.compare(a.lastModified(), b.lastModified()));
            for (File f : survivors) {
                if (total <= capBytes) break;
                if (keepFloor.contains(f.getName())) continue;
                if (signedIn && !heldInFull(driveFiles, f)) continue;
                long len = f.length();
                if (f.delete()) { tier3++; freedT3 += len; total -= len; }
            }
        }

        Log.i(TAG, "cleanup persona=" + (driveActive ? "drive" : "no-drive")
            + " cap=" + capBytes + " keep-floor=" + KEEP_RECENT_FLOOR
            + " drive-verified=" + tier1 + " (" + freedT1 + "B)"
            + " age-fallback=" + tier2 + " (" + freedT2 + "B)"
            + " budget-cap=" + tier3 + " (" + freedT3 + "B)");
    }

    // Returns [count, bytes, oldestMs] of CSVs in sessions/.
    public static long[] cacheStats(File sessionsDir) {
        if (sessionsDir == null || !sessionsDir.isDirectory()) return new long[] { 0, 0, 0 };
        File[] files = sessionsDir.listFiles();
        if (files == null) return new long[] { 0, 0, 0 };
        long count = 0, bytes = 0, oldest = 0;
        for (File f : files) {
            if (!f.isFile() || !f.getName().endsWith(".csv")) continue;
            count++;
            bytes += f.length();
            long mt = f.lastModified();
            if (oldest == 0 || mt < oldest) oldest = mt;
        }
        return new long[] { count, bytes, oldest };
    }

    // Deletes only non-active CSVs Drive holds in full. {deleted, kept, drive: ok | none | unreachable}.
    public JSONObject clearLocalCache(File sessionsDir) throws org.json.JSONException {
        String drive = "none";
        java.util.Map<String, Long> driveSizes = null;
        try {
            if (AuthStorage.isSignedIn(context)) {
                drive = "unreachable";
                String token = AuthStorage.getValidAccessToken(context);
                String folderId = token != null ? getOrFetchFolderIdSync(token) : null;
                java.util.Map<String, DriveFileInfo> files = folderId != null ? listDriveFiles(token, folderId) : null;
                if (files != null) {
                    driveSizes = new java.util.HashMap<>();
                    for (java.util.Map.Entry<String, DriveFileInfo> e : files.entrySet()) driveSizes.put(e.getKey(), e.getValue().size);
                    drive = "ok";
                }
            }
        } catch (Throwable t) {
            Log.w(TAG, "clearLocalCache: Drive lookup failed, deleting nothing: " + t.getMessage());
        }
        java.util.Set<String> skip = new java.util.HashSet<>(FINALIZING);
        String activeName = sessionFilenameRef.get();
        if (activeName != null) skip.add(activeName);
        // A crashed session not yet resumed lives only in prefs; its resume reuses the name and Drive id.
        String savedName = context.getSharedPreferences("hr_monitor_session", Context.MODE_PRIVATE).getString("activeCsvFilename", null);
        if (savedName != null && !savedName.isEmpty()) skip.add(savedName);
        int[] r = CacheClear.run(sessionsDir, skip, driveSizes);
        Log.i(TAG, "clearLocalCache drive=" + drive + " deleted=" + r[0] + " kept=" + r[1]);
        return new JSONObject().put("deleted", r[0]).put("kept", r[1]).put("drive", drive);
    }

    // Per-file Drive metadata. id is needed for PATCH (size-mismatch repair),
    // size for the local-bigger-than-Drive detection that catches truncated
    // uploads from a session that died before its final flush completed.
    private static class DriveFileInfo {
        final String id;
        final long size;
        DriveFileInfo(String id, long size) { this.id = id; this.size = size; }
    }

    // Outcome of a single create/patch HTTP call. Returned up the call chain
    // so the retry loop reads this instead of a shared volatile field (which
    // raced between the session path and the orphan path).
    private static class HttpResult {
        final int status;
        final boolean rateLimited;
        final String fileId; // set by createFile on success
        HttpResult(int status, boolean rateLimited, String fileId) {
            this.status = status; this.rateLimited = rateLimited; this.fileId = fileId;
        }
        boolean ok() { return status >= 200 && status < 300; }
    }

    private static boolean isRateLimitBody(String body) {
        return body != null && (body.contains("userRateLimitExceeded") || body.contains("rateLimitExceeded"));
    }

    private java.util.Map<String, DriveFileInfo> listDriveFiles(String token, String folderId) throws IOException {
        java.util.Map<String, DriveFileInfo> out = new java.util.HashMap<>();
        String pageToken = null;
        do {
            okhttp3.HttpUrl.Builder b = okhttp3.HttpUrl.parse("https://www.googleapis.com/drive/v3/files")
                .newBuilder()
                .addQueryParameter("q", "'" + folderId + "' in parents and trashed=false")
                .addQueryParameter("fields", "nextPageToken,files(id,name,size)")
                .addQueryParameter("pageSize", "200")
                .addQueryParameter("spaces", "drive");
            if (pageToken != null) b.addQueryParameter("pageToken", pageToken);
            Request req = new Request.Builder().url(b.build()).header("Authorization", "Bearer " + token).build();
            try (Response resp = client.newCall(req).execute()) {
                if (!resp.isSuccessful()) {
                    Log.w(TAG, "List files HTTP " + resp.code());
                    return null;
                }
                String body = resp.body() != null ? resp.body().string() : "";
                JSONObject json = new JSONObject(body);
                JSONArray files = json.optJSONArray("files");
                if (files != null) {
                    for (int i = 0; i < files.length(); i++) {
                        JSONObject f = files.getJSONObject(i);
                        String name = f.optString("name");
                        String id = f.optString("id");
                        // Drive API returns size as a string (long can overflow JSON number).
                        long size = 0;
                        try { size = Long.parseLong(f.optString("size", "0")); } catch (NumberFormatException e) {}
                        if (name != null && !name.isEmpty() && id != null && !id.isEmpty()) {
                            out.put(name, new DriveFileInfo(id, size));
                        }
                    }
                }
                pageToken = json.optString("nextPageToken", null);
                if (pageToken != null && pageToken.isEmpty()) pageToken = null;
            } catch (Exception e) {
                Log.w(TAG, "List files parse failed: " + e.getMessage());
                return null;
            }
        } while (pageToken != null);
        return out;
    }

    /**
     * Crash-recovery: scan the sessions dir, find any CSV that doesn't have
     * a Drive counterpart, and upload it. Skips the active session. Used
     * by forceSyncNow (manual sync button) so a tap also salvages any
     * prior session whose resumable upload was orphaned by a crash.
     */
    public void uploadOrphansAsync(File sessionsDir) {
        if (sessionsDir == null || !sessionsDir.isDirectory()) return;
        executor.submit(() -> runOrphanScan(sessionsDir));
    }

    /**
     * Synchronous orphan scan for WorkManager. Runs inline on the caller's
     * thread and returns false only on a failure a retry might fix (folder
     * resolve / list failure), so the Worker can map it to Result.retry().
     */
    public boolean uploadOrphansSync(File sessionsDir) {
        if (sessionsDir == null || !sessionsDir.isDirectory()) return true;
        return runOrphanScan(sessionsDir);
    }

    private boolean runOrphanScan(File sessionsDir) {
        synchronized (SEND_LOCK) { return runOrphanScanLocked(sessionsDir); }
    }

    private boolean runOrphanScanLocked(File sessionsDir) {
        try {
            if (DriveGate.paused(context)) return true;
            File[] files = sessionsDir.listFiles();
            if (files == null) return true;
            String token = AuthStorage.getValidAccessToken(context);
            if (token == null) return true; // signed out — nothing to do
            String folderId = folderIdRef.get();
            if (folderId == null) {
                folderId = ensureFolder(token);
                if (folderId != null) folderIdRef.set(folderId);
            }
            if (folderId == null) return false;
            java.util.Map<String, DriveFileInfo> driveFiles = listDriveFiles(token, folderId);
            if (driveFiles == null) return false;
            String activeName = sessionFilenameRef.get();
            int created = 0, patched = 0;
            for (File f : files) {
                if (!f.isFile() || !f.getName().endsWith(".csv")) continue;
                if (activeName != null && f.getName().equals(activeName)) continue;
                if (FINALIZING.contains(f.getName())) continue;
                if (f.length() == 0) continue;
                if (!fullFileAllowed(f)) continue;
                DriveFileInfo info = driveFiles.get(f.getName());
                if (info == null) {
                    Log.i(TAG, "uploadOrphans: creating " + f.getName() + " (" + f.length() + " bytes)");
                    try { if (createOrphan(token, folderId, f)) created++; }
                    catch (IOException io) { Log.w(TAG, "orphan create failed: " + io.getMessage()); }
                } else if (f.length() > info.size) {
                    // Drive copy is truncated (session died before final flush
                    // landed). PATCH the existing fileId with the full local
                    // content instead of POSTing a duplicate.
                    Log.i(TAG, "uploadOrphans: patching " + f.getName()
                        + " (local=" + f.length() + " bytes, drive=" + info.size + " bytes)");
                    try {
                        if (patchOrphan(token, info.id, f)) patched++;
                    } catch (IOException io) { Log.w(TAG, "orphan patch failed: " + io.getMessage()); }
                }
                // else: sizes match — Drive already has the complete file, skip.
            }
            if (created + patched > 0) Log.i(TAG, "uploadOrphans: created=" + created + " patched=" + patched);
            return true;
        } catch (Throwable t) {
            Log.w(TAG, "uploadOrphans threw: " + t.getMessage());
            return false;
        }
    }

    /**
     * Targeted variant: re-upload one specific filename if it's missing
     * from Drive. Used at session start to catch the most common case —
     * the IMMEDIATELY previous session ended uncleanly.
     */
    public void uploadOrphanIfNeededAsync(File sessionsDir, String filename) {
        if (sessionsDir == null || filename == null || filename.isEmpty()) return;
        executor.submit(() -> {
            synchronized (SEND_LOCK) { try {
                if (FINALIZING.contains(filename)) return;
                File f = new File(sessionsDir, filename);
                if (!f.exists() || f.length() == 0 || !fullFileAllowed(f)) return;
                String token = AuthStorage.getValidAccessToken(context);
                if (token == null) return;
                String folderId = folderIdRef.get();
                if (folderId == null) {
                    folderId = ensureFolder(token);
                    if (folderId != null) folderIdRef.set(folderId);
                }
                if (folderId == null) return;
                java.util.Map<String, DriveFileInfo> driveFiles = listDriveFiles(token, folderId);
                if (driveFiles == null) return;
                DriveFileInfo info = driveFiles.get(filename);
                if (info == null) {
                    Log.i(TAG, "uploadOrphan: creating " + filename + " (" + f.length() + " bytes)");
                    createOrphan(token, folderId, f);
                } else if (f.length() > info.size) {
                    Log.i(TAG, "uploadOrphan: patching " + filename
                        + " (local=" + f.length() + " bytes, drive=" + info.size + " bytes)");
                    patchOrphan(token, info.id, f);
                }
                // else: Drive already has the complete file, nothing to do.
            } catch (IOException io) {
                Log.w(TAG, "uploadOrphanIfNeeded: " + io.getMessage());
            } catch (Throwable t) {
                Log.w(TAG, "uploadOrphanIfNeeded threw: " + t.getMessage());
            } }
        });
    }

    /** Full upload of a stopped file: same-name Drive copy PATCHed, else created. False leaves it to the orphan pass. */
    public boolean uploadFinishedSync(File f) {
        if (f == null || !f.exists() || f.length() == 0) return false;
        if (!fullFileAllowed(f)) {
            Log.i(TAG, "uploadFinishedSync: deferred " + f.getName() + " (" + f.length() + " bytes)");
            return false;
        }
        synchronized (SEND_LOCK) { try {
            String token = AuthStorage.getValidAccessToken(context);
            if (token == null) return false;
            String folderId = getOrFetchFolderIdSync(token);
            if (folderId == null) return false;
            java.util.Map<String, DriveFileInfo> driveFiles = listDriveFiles(token, folderId);
            if (driveFiles == null) return false;
            DriveFileInfo info = driveFiles.get(f.getName());
            if (info != null) return f.length() <= info.size || patchOrphan(token, info.id, f);
            return createOrphan(token, folderId, f);
        } catch (Throwable t) {
            Log.w(TAG, "uploadFinishedSync failed: " + t.getMessage());
            return false;
        } }
    }

    // Orphan create, with the 401 refresh and one retry.
    private boolean createOrphan(String token, String folderId, File f) throws IOException {
        byte[] data = readAllBytes(f);
        HttpResult r = createFile(token, folderId, f.getName(), data);
        if (r.status == 401) {
            String fresh = AuthStorage.getValidAccessToken(context, /*forceRefresh=*/true);
            if (fresh != null && !fresh.equals(token)) r = createFile(fresh, folderId, f.getName(), data);
        }
        return r.ok();
    }

    // Orphan patch, with the same 401 handling as createOrphan.
    private boolean patchOrphan(String token, String fileId, File f) throws IOException {
        byte[] data = readAllBytes(f);
        HttpResult r = patchFile(token, fileId, data);
        if (r.status == 401) {
            String fresh = AuthStorage.getValidAccessToken(context, /*forceRefresh=*/true);
            if (fresh != null && !fresh.equals(token)) r = patchFile(fresh, fileId, data);
        }
        return r.ok();
    }

    private String ensureFolder(String token) throws IOException {
        String q = "name='" + DRIVE_FOLDER_NAME + "' and mimeType='" + FOLDER_MIME + "' and trashed=false";
        okhttp3.HttpUrl url = okhttp3.HttpUrl.parse("https://www.googleapis.com/drive/v3/files")
            .newBuilder()
            .addQueryParameter("q", q)
            .addQueryParameter("orderBy", "createdTime")
            .addQueryParameter("fields", "files(id,name,createdTime)")
            .addQueryParameter("spaces", "drive")
            .build();
        Request req = new Request.Builder().url(url).header("Authorization", "Bearer " + token).build();
        try (Response resp = client.newCall(req).execute()) {
            if (!resp.isSuccessful()) {
                Log.w(TAG, "Folder query HTTP " + resp.code());
                return null;
            }
            String body = resp.body() != null ? resp.body().string() : "";
            JSONObject json = new JSONObject(body);
            JSONArray files = json.optJSONArray("files");
            // Oldest root wins, id breaking ties: the same pick as SegmentUploader and the viewer.
            String bestId = null, bestTime = null;
            for (int i = 0; files != null && i < files.length(); i++) {
                JSONObject f = files.getJSONObject(i);
                String id = f.optString("id", "");
                String t = f.optString("createdTime", "");
                if (id.isEmpty()) continue;
                if (t.isEmpty()) t = "￿";
                if (bestId == null || t.compareTo(bestTime) < 0 || (t.equals(bestTime) && id.compareTo(bestId) < 0)) {
                    bestId = id;
                    bestTime = t;
                }
            }
            if (bestId != null) return bestId;
        } catch (Exception e) {
            Log.w(TAG, "Folder query parse failed: " + e.getMessage());
            return null;
        }
        // Folder not found — create it.
        try {
            JSONObject body = new JSONObject();
            body.put("name", DRIVE_FOLDER_NAME);
            body.put("mimeType", FOLDER_MIME);
            Request createReq = new Request.Builder()
                .url("https://www.googleapis.com/drive/v3/files?fields=id")
                .header("Authorization", "Bearer " + token)
                .post(RequestBody.create(MediaType.parse("application/json"), body.toString()))
                .build();
            try (Response createResp = client.newCall(createReq).execute()) {
                if (!createResp.isSuccessful()) {
                    Log.w(TAG, "Folder create HTTP " + createResp.code());
                    return null;
                }
                JSONObject jr = new JSONObject(createResp.body().string());
                return jr.optString("id");
            }
        } catch (Exception e) {
            Log.w(TAG, "Folder create failed: " + e.getMessage());
            return null;
        }
    }

    private HttpResult createFile(String token, String folderId, String filename, byte[] csvBytes) throws IOException {
        // Multipart upload — same wire format as hr_monitor.html driveUploadSession.
        String boundary = "-------hr-monitor-" + Long.toHexString(System.nanoTime());
        String metaJson;
        try {
            metaJson = new JSONObject()
                .put("name", filename)
                .put("parents", new JSONArray().put(folderId))
                .put("mimeType", "text/csv")
                .toString();
        } catch (Exception e) {
            Log.w(TAG, "Metadata JSON build failed: " + e.getMessage());
            return null;
        }
        StringBuilder header = new StringBuilder();
        header.append("--").append(boundary).append("\r\n");
        header.append("Content-Type: application/json; charset=UTF-8\r\n\r\n");
        header.append(metaJson);
        header.append("\r\n--").append(boundary).append("\r\n");
        header.append("Content-Type: text/csv\r\n\r\n");
        String footer = "\r\n--" + boundary + "--\r\n";

        byte[] hdr = header.toString().getBytes("UTF-8");
        byte[] ftr = footer.getBytes("UTF-8");
        byte[] body = new byte[hdr.length + csvBytes.length + ftr.length];
        System.arraycopy(hdr, 0, body, 0, hdr.length);
        System.arraycopy(csvBytes, 0, body, hdr.length, csvBytes.length);
        System.arraycopy(ftr, 0, body, hdr.length + csvBytes.length, ftr.length);

        Request req = new Request.Builder()
            .url("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id")
            .header("Authorization", "Bearer " + token)
            .post(RequestBody.create(MediaType.parse("multipart/related; boundary=" + boundary), body))
            .build();
        try (Response resp = client.newCall(req).execute()) {
            int status = resp.code();
            if (!resp.isSuccessful()) {
                String errBody = resp.body() != null ? resp.body().string() : "";
                Log.w(TAG, "Create file HTTP " + status + " body=" + errBody);
                boolean rl = (status == 403 || status == 429) && isRateLimitBody(errBody);
                return new HttpResult(status, rl, null);
            }
            JSONObject jr = new JSONObject(resp.body().string());
            return new HttpResult(status, false, jr.optString("id"));
        } catch (Exception e) {
            Log.w(TAG, "Create file parse failed: " + e.getMessage());
            return new HttpResult(0, false, null);
        }
    }

    private HttpResult patchFile(String token, String fileId, byte[] csvBytes) throws IOException {
        Request req = new Request.Builder()
            .url("https://www.googleapis.com/upload/drive/v3/files/" + fileId + "?uploadType=media")
            .header("Authorization", "Bearer " + token)
            .header("Content-Type", "text/csv")
            .patch(RequestBody.create(MediaType.parse("text/csv"), csvBytes))
            .build();
        try (Response resp = client.newCall(req).execute()) {
            int status = resp.code();
            if (!resp.isSuccessful()) {
                String errBody = resp.body() != null ? resp.body().string() : "";
                Log.w(TAG, "Patch HTTP " + status);
                boolean rl = (status == 403 || status == 429) && isRateLimitBody(errBody);
                return new HttpResult(status, rl, null);
            }
            return new HttpResult(status, false, null);
        }
    }

    private static byte[] readAllBytes(File f) throws IOException {
        try (FileInputStream in = new FileInputStream(f)) {
            byte[] buf = new byte[(int) f.length()];
            int read = 0;
            while (read < buf.length) {
                int r = in.read(buf, read, buf.length - read);
                if (r < 0) break;
                read += r;
            }
            return buf;
        }
    }
}
