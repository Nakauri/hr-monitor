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
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;

import okhttp3.MediaType;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;

/**
 * Native Drive uploader. Reads the active session CSV file periodically
 * and pushes it to Google Drive in the same "HR Monitor Sessions" folder
 * the web app uses. Runs entirely in native code so uploads continue
 * while the WebView is paused / app is backgrounded.
 *
 * Auth: pulls the current OAuth access token from AuthStorage, which is
 * Keystore-backed and refreshes via /api/auth/refresh whenever the token is
 * near expiry. The WebView populated these tokens at sign-in time via
 * NativeHrSessionPlugin.storeAuthTokens().
 *
 * Strategy: same Drive file ID per session, PATCH-update its content on
 * each upload tick (matches hr_monitor.html driveUploadSession exactly).
 * This avoids accumulating dozens of partial files in the user's Drive.
 */
public class NativeDriveUploader {
    private static final String TAG = "NativeDriveUploader";
    private static final String DRIVE_FOLDER_NAME = "HR Monitor Sessions";
    private static final String FOLDER_MIME = "application/vnd.google-apps.folder";

    private final Context context;
    private final OkHttpClient client;
    private final ExecutorService executor;
    private final AtomicBoolean inFlight = new AtomicBoolean(false);
    private final AtomicReference<String> folderIdRef = new AtomicReference<>(null);
    private final AtomicReference<String> sessionFileIdRef = new AtomicReference<>(null);
    private final AtomicReference<String> sessionFilenameRef = new AtomicReference<>(null);

    public NativeDriveUploader(Context context) {
        this.context = context.getApplicationContext();
        // Shared HTTP client; each Drive request is one-shot so we use
        // the default-timeout variant rather than the WebSocket one.
        this.client = HttpClientHolder.http();
        this.executor = Executors.newSingleThreadExecutor();
    }

    /** Reset session-scoped state at the start of a new session. */
    public void resetSession() {
        sessionFileIdRef.set(null);
        sessionFilenameRef.set(null);
    }

    /**
     * Stamp the active session filename. Used by cleanupLocalCachedAsync
     * to avoid deleting the session that's currently being recorded.
     * Normally set inside doUpload, but the resumable path bypasses
     * doUpload entirely, so the plugin marks it manually at startSession.
     */
    public void markActiveSessionFilename(String name) {
        sessionFilenameRef.set(name);
    }

    /** Shared folder lookup for sibling uploaders (e.g. resumable). Caches per-process. */
    public String getOrFetchFolderIdSync(String token) throws IOException {
        String fid = folderIdRef.get();
        if (fid != null) return fid;
        fid = ensureFolder(token);
        if (fid != null) folderIdRef.set(fid);
        return fid;
    }

    public OkHttpClient getHttpClient() { return client; }

    // Persona-aware retention. Drive users get generous limits (Drive holds
    // durable copy); no-Drive users get tight limits (local is ephemeral).
    private static final long CAP_BYTES_DRIVE       = 200L * 1024L * 1024L;
    private static final long CAP_BYTES_NO_DRIVE    =  50L * 1024L * 1024L;
    private static final long AGE_FALLBACK_DRIVE    = 14L * 24L * 60L * 60L * 1000L;
    private static final long AGE_FALLBACK_NO_DRIVE =  2L * 24L * 60L * 60L * 1000L;
    private static final int  KEEP_RECENT_FLOOR     = 3;

    // Three-tier cleanup: 1) Drive-verified delete, 2) age fallback, 3) byte cap.
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

    private void runCleanup(File sessionsDir, long minAgeMs) {
        File[] localFiles = sessionsDir.listFiles();
        if (localFiles == null) return;
        String activeName = sessionFilenameRef.get();
        long now = System.currentTimeMillis();

        java.util.Set<String> driveNames = null;
        boolean driveActive = false;
        try {
            String token = AuthStorage.getValidAccessToken(context);
            if (token != null) {
                String folderId = folderIdRef.get();
                if (folderId == null) {
                    folderId = ensureFolder(token);
                    if (folderId != null) folderIdRef.set(folderId);
                }
                if (folderId != null) {
                    driveNames = listDriveFilenames(token, folderId);
                    driveActive = (driveNames != null);
                }
            }
        } catch (Throwable t) {
            Log.w(TAG, "cleanup: Drive lookup failed, treating as no-Drive: " + t.getMessage());
        }

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
            if (driveNames != null
                && f.lastModified() <= ageCutoff
                && driveNames.contains(f.getName())) {
                long len = f.length();
                if (f.delete()) { tier1++; freedT1 += len; }
                continue;
            }
            if (f.lastModified() <= fallbackCutoff) {
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

    // Deletes every non-active CSV. Returns count.
    public int clearLocalCache(File sessionsDir) {
        if (sessionsDir == null || !sessionsDir.isDirectory()) return 0;
        File[] files = sessionsDir.listFiles();
        if (files == null) return 0;
        String activeName = sessionFilenameRef.get();
        int deleted = 0;
        for (File f : files) {
            if (!f.isFile() || !f.getName().endsWith(".csv")) continue;
            if (activeName != null && f.getName().equals(activeName)) continue;
            if (f.delete()) deleted++;
        }
        return deleted;
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

    // Thin wrapper for the cleanup path which only needs filenames.
    private java.util.Set<String> listDriveFilenames(String token, String folderId) throws IOException {
        java.util.Map<String, DriveFileInfo> files = listDriveFiles(token, folderId);
        return files == null ? null : files.keySet();
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
        try {
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
                if (f.length() == 0) continue;
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
            try {
                File f = new File(sessionsDir, filename);
                if (!f.exists() || f.length() == 0) return;
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
            }
        });
    }

    /** Attempt an upload of the given CSV file. No-op if signed-out, mid-flight, or file empty. */
    public void uploadAsync(File csv) {
        if (csv == null || !csv.exists() || csv.length() == 0) return;
        if (!inFlight.compareAndSet(false, true)) return;
        executor.submit(() -> {
            try { runUploadWithRetry(csv); }
            finally { inFlight.set(false); }
        });
    }

    /**
     * Synchronous upload — blocks the calling thread until the upload finishes
     * (success or permanent failure). Returns true if the file made it to
     * Drive. Called by forceSyncNow so the JS "Synced" status reflects the
     * actual outcome instead of a fire-and-forget queue. If a periodic upload
     * is already in flight, this waits up to 30 s for it to drain before
     * starting; the periodic upload itself is what makes the file visible, so
     * after it lands we return success without re-uploading.
     */
    public boolean uploadSync(File csv) {
        if (csv == null || !csv.exists() || csv.length() == 0) return false;
        long deadline = System.currentTimeMillis() + 30000L;
        while (!inFlight.compareAndSet(false, true)) {
            if (System.currentTimeMillis() >= deadline) {
                Log.w(TAG, "uploadSync: another upload held inFlight for 30s, giving up");
                return false;
            }
            try { Thread.sleep(200L); } catch (InterruptedException ie) {
                Thread.currentThread().interrupt();
                return false;
            }
        }
        try { return runUploadWithRetry(csv); }
        finally { inFlight.set(false); }
    }

    /**
     * Shared upload-with-retry loop. Retries transient failures (5xx, network
     * blip, IOException) up to 3 times with exponential backoff. 401 has its
     * own retry inside doUpload (token-refresh-and-retry). Permanent failures
     * (400, 403, 404) don't retry. Returns true iff the last attempt landed
     * a 2xx response.
     */
    private boolean runUploadWithRetry(File csv) {
        final int MAX_TRIES = 3;
        IOException lastIo = null;
        for (int attempt = 1; attempt <= MAX_TRIES; attempt++) {
            try {
                HttpResult r = doUpload(csv);
                int s = r.status;
                // Retry 5xx, 429, and rate-limited 403 — all transient.
                boolean retryable = (s >= 500 && s < 600) || s == 429 || (s == 403 && r.rateLimited);
                if (retryable && attempt < MAX_TRIES) {
                    long backoff = 1000L * (1L << (attempt - 1));
                    Log.w(TAG, "Drive retryable status " + s + " (attempt " + attempt + "), retrying in " + backoff + "ms");
                    try { Thread.sleep(backoff); } catch (InterruptedException ie) {
                        Thread.currentThread().interrupt();
                        return false;
                    }
                    continue;
                }
                return r.ok();
            } catch (IOException io) {
                lastIo = io;
                if (attempt < MAX_TRIES) {
                    long backoff = 1000L * (1L << (attempt - 1));
                    Log.w(TAG, "Drive IO failure (attempt " + attempt + "), retrying in " + backoff + "ms: " + io.getMessage());
                    try { Thread.sleep(backoff); } catch (InterruptedException ie) {
                        Thread.currentThread().interrupt();
                        return false;
                    }
                }
            } catch (Throwable t) {
                Log.w(TAG, "Upload threw: " + t.getMessage());
                return false;
            }
        }
        if (lastIo != null) {
            Log.w(TAG, "Drive upload failed after " + MAX_TRIES + " tries: " + lastIo.getMessage());
        }
        return false;
    }

    /** Synchronous session upload (call from a background thread only). */
    private HttpResult doUpload(File csv) throws IOException {
        String token = AuthStorage.getValidAccessToken(context);
        if (token == null) {
            Log.i(TAG, "No valid Drive token; skipping upload");
            return new HttpResult(0, false, null);
        }

        String folderId = folderIdRef.get();
        if (folderId == null) {
            folderId = ensureFolder(token);
            if (folderId == null) {
                Log.w(TAG, "Could not resolve sessions folder");
                return new HttpResult(0, false, null);
            }
            folderIdRef.set(folderId);
        }

        byte[] csvBytes = readAllBytes(csv);
        String filename = csv.getName();
        sessionFilenameRef.set(filename);

        String fileId = sessionFileIdRef.get();
        if (fileId == null) {
            // Hydrate from prefs — the in-memory ref is null after every
            // process restart but currentDriveFileId persists. Without this
            // we'd POST a duplicate file instead of PATCHing the existing one,
            // and the viewer would see two files with the same name.
            try {
                String prefId = context.getSharedPreferences("hr_monitor_session", 0)
                    .getString("currentDriveFileId", null);
                if (prefId != null && !prefId.isEmpty()) {
                    fileId = prefId;
                    sessionFileIdRef.set(prefId);
                }
            } catch (Throwable ignored) {}
        }
        HttpResult res;
        if (fileId == null) {
            res = createFile(token, folderId, filename, csvBytes);
            if (res.ok() && res.fileId != null && !res.fileId.isEmpty()) {
                sessionFileIdRef.set(res.fileId);
                Log.i(TAG, "Created Drive file: " + filename + " -> " + res.fileId);
            }
        } else {
            res = patchFile(token, fileId, csvBytes);
            // 404 = file ID no longer exists (user deleted from Drive, or it
            // got trashed). Without this fallback, every subsequent upload
            // PATCHes a dead ID and silently fails. Clear the stale ID +
            // persisted ref, then CREATE a fresh file so sync stays alive.
            if (!res.ok() && res.status == 404) {
                Log.w(TAG, "Drive PATCH 404 for fileId=" + fileId + " — clearing stale ref and creating fresh file");
                sessionFileIdRef.set(null);
                try {
                    context.getSharedPreferences("hr_monitor_session", 0).edit()
                        .putString("currentDriveFileId", "").apply();
                } catch (Throwable ignored) {}
                res = createFile(token, folderId, filename, csvBytes);
                if (res.ok() && res.fileId != null && !res.fileId.isEmpty()) {
                    sessionFileIdRef.set(res.fileId);
                    Log.i(TAG, "Created replacement Drive file: " + filename + " -> " + res.fileId);
                }
            }
        }

        // 401 retry: token can expire between AuthStorage.getValidAccessToken
        // returning a not-yet-expired token and the actual HTTP call landing
        // (slow network, GC pause). Force a refresh and retry once before
        // giving up. Surfaces a real auth-broken signal to JS only after the
        // retry also 401s.
        if (!res.ok() && res.status == 401) {
            Log.w(TAG, "Drive 401 — forcing token refresh + one retry");
            String fresh = AuthStorage.getValidAccessToken(context, /*forceRefresh=*/true);
            if (fresh != null && !fresh.equals(token)) {
                if (fileId == null) {
                    res = createFile(fresh, folderId, filename, csvBytes);
                    if (res.ok() && res.fileId != null && !res.fileId.isEmpty()) sessionFileIdRef.set(res.fileId);
                } else {
                    res = patchFile(fresh, fileId, csvBytes);
                }
            }
        }
        return res;
    }

    // Orphan create — never touches session refs (sessionFilenameRef /
    // sessionFileIdRef / currentDriveFileId). Keeps the 401-refresh-and-retry.
    private boolean createOrphan(String token, String folderId, File f) throws IOException {
        byte[] data = readAllBytes(f);
        HttpResult r = createFile(token, folderId, f.getName(), data);
        if (r.status == 401) {
            String fresh = AuthStorage.getValidAccessToken(context, /*forceRefresh=*/true);
            if (fresh != null && !fresh.equals(token)) r = createFile(fresh, folderId, f.getName(), data);
        }
        return r.ok();
    }

    // Orphan patch — same ref-safety + 401 handling as createOrphan.
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
            .addQueryParameter("fields", "files(id,name)")
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
            if (files != null && files.length() > 0) {
                return files.getJSONObject(0).optString("id");
            }
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
