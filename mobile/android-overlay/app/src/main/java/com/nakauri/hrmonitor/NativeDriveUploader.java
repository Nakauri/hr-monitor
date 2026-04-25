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

    // Storage limits differ by user persona:
    //   - Drive signed in: local cache is a viewer-speed accelerator, Drive
    //     holds the durable copy. 200 MB cap, 14-day age fallback.
    //   - No Drive: user isn't backing up. Local is ephemeral; keep just
    //     enough for the viewer to feel populated. 50 MB cap, 2-day age,
    //     but always preserve the most recent KEEP_RECENT_FLOOR sessions
    //     so even a once-a-month user has something to browse.
    private static final long CAP_BYTES_DRIVE       = 200L * 1024L * 1024L;
    private static final long CAP_BYTES_NO_DRIVE    =  50L * 1024L * 1024L;
    private static final long AGE_FALLBACK_DRIVE    = 14L * 24L * 60L * 60L * 1000L;
    private static final long AGE_FALLBACK_NO_DRIVE =  2L * 24L * 60L * 60L * 1000L;
    private static final int  KEEP_RECENT_FLOOR     = 3;

    /**
     * Three-tier cleanup of local CSVs. Each tier is independently safe;
     * later tiers only act on what earlier ones leave behind:
     *
     *   Tier 1 (preferred) — DRIVE-VERIFIED. If the user is signed in and
     *     the Drive folder listing succeeds, delete files older than
     *     minAgeMs whose names appear in the Drive listing. Conservative:
     *     never deletes a file Drive doesn't have.
     *
     *   Tier 2 (signed-out fallback) — AGE-ONLY. If Tier 1 couldn't run
     *     (no token, listing failed, etc.) OR Tier 1 left files that are
     *     older than AGE_DELETE_FALLBACK_MS (30 days), delete those. The
     *     longer cutoff makes losing an orphan less likely.
     *
     *   Tier 3 (emergency cap) — BUDGET-CAP. If sessions/ still exceeds
     *     HARD_CACHE_BUDGET_BYTES (500 MB), delete oldest first until
     *     under cap. This is the "phone won't fill up" guarantee for users
     *     who never sign in.
     *
     * Active session is always skipped at every tier.
     *
     * Runs on the upload executor — async, non-blocking. Errors logged.
     */
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

        // Tier 0 — figure out who the user is. Drive sign-in determines
        // whether we're in "viewer-cache for a backed-up user" mode (more
        // generous limits) or "ephemeral local for a casual user" mode
        // (much tighter — they have no other copy and no expectation of
        // long retention).
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

        // Build a sorted view (newest-first) so the keep-floor logic can
        // protect the most recent N sessions from any deletion path.
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
            // Tier 1: Drive-verified — file is on Drive AND older than the
            // user-configurable retention window. Only runs when Drive is
            // signed in.
            if (driveNames != null
                && f.lastModified() <= ageCutoff
                && driveNames.contains(f.getName())) {
                long len = f.length();
                if (f.delete()) { tier1++; freedT1 += len; }
                continue;
            }
            // Tier 2: age-only fallback — anything older than the persona-
            // appropriate cutoff. 14 days for Drive users, 2 days for the
            // casual no-Drive user (who doesn't expect retention anyway).
            if (f.lastModified() <= fallbackCutoff) {
                long len = f.length();
                if (f.delete()) { tier2++; freedT2 += len; }
            }
        }

        // Tier 3: emergency byte-budget cap. Sort survivors oldest-first
        // (keep-floor still respected) and delete until under cap.
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

    /**
     * Snapshot of local sessions/ for diagnostics. Returns total file count,
     * total bytes, and the timestamp of the oldest file. JS surfaces this
     * in the diagnostics modal so users can see what's accumulating.
     */
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

    /**
     * Manual clear-all triggered from the UI. Deletes every CSV in the
     * sessions/ directory EXCEPT the active session. Use as a "free up
     * space" action; users can always re-pull from Drive. Returns the
     * count of files deleted.
     */
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

    private java.util.Set<String> listDriveFilenames(String token, String folderId) throws IOException {
        java.util.Set<String> out = new java.util.HashSet<>();
        String pageToken = null;
        do {
            okhttp3.HttpUrl.Builder b = okhttp3.HttpUrl.parse("https://www.googleapis.com/drive/v3/files")
                .newBuilder()
                .addQueryParameter("q", "'" + folderId + "' in parents and trashed=false")
                .addQueryParameter("fields", "nextPageToken,files(name)")
                .addQueryParameter("pageSize", "200")
                .addQueryParameter("spaces", "drive");
            if (pageToken != null) b.addQueryParameter("pageToken", pageToken);
            Request req = new Request.Builder().url(b.build()).header("Authorization", "Bearer " + token).build();
            try (Response resp = client.newCall(req).execute()) {
                if (!resp.isSuccessful()) {
                    Log.w(TAG, "List filenames HTTP " + resp.code());
                    return null;
                }
                String body = resp.body() != null ? resp.body().string() : "";
                JSONObject json = new JSONObject(body);
                JSONArray files = json.optJSONArray("files");
                if (files != null) {
                    for (int i = 0; i < files.length(); i++) {
                        String name = files.getJSONObject(i).optString("name");
                        if (name != null && !name.isEmpty()) out.add(name);
                    }
                }
                pageToken = json.optString("nextPageToken", null);
                if (pageToken != null && pageToken.isEmpty()) pageToken = null;
            } catch (Exception e) {
                Log.w(TAG, "List filenames parse failed: " + e.getMessage());
                return null;
            }
        } while (pageToken != null);
        return out;
    }

    /** Attempt an upload of the given CSV file. No-op if signed-out, mid-flight, or file empty. */
    public void uploadAsync(File csv) {
        if (csv == null || !csv.exists() || csv.length() == 0) return;
        if (!inFlight.compareAndSet(false, true)) return;
        executor.submit(() -> {
            try {
                // Retry transient failures (5xx, network blip, IOException)
                // up to 3 times with exponential backoff. 401 has its own
                // retry path inside doUpload (token-refresh-and-retry).
                // Permanent failures (400, 403, 404) don't get retried.
                final int MAX_TRIES = 3;
                IOException lastIo = null;
                for (int attempt = 1; attempt <= MAX_TRIES; attempt++) {
                    try {
                        doUpload(csv);
                        // Treat 5xx as a retry trigger even when doUpload itself
                        // doesn't throw (it logs + returns on non-2xx).
                        int s = lastHttpStatus;
                        if (s >= 500 && s < 600 && attempt < MAX_TRIES) {
                            long backoff = 1000L * (1L << (attempt - 1));  // 1s, 2s, 4s
                            Log.w(TAG, "Drive 5xx (attempt " + attempt + "), retrying in " + backoff + "ms");
                            Thread.sleep(backoff);
                            continue;
                        }
                        return;  // success or permanent failure — don't retry
                    } catch (IOException io) {
                        lastIo = io;
                        if (attempt < MAX_TRIES) {
                            long backoff = 1000L * (1L << (attempt - 1));
                            Log.w(TAG, "Drive IO failure (attempt " + attempt + "), retrying in " + backoff + "ms: " + io.getMessage());
                            try { Thread.sleep(backoff); } catch (InterruptedException ie) {
                                Thread.currentThread().interrupt();
                                return;
                            }
                        }
                    }
                }
                if (lastIo != null) {
                    Log.w(TAG, "Drive upload failed after " + MAX_TRIES + " tries: " + lastIo.getMessage());
                }
            } catch (Throwable t) {
                Log.w(TAG, "Upload threw: " + t.getMessage());
            } finally {
                inFlight.set(false);
            }
        });
    }

    /** Synchronous upload (call from a background thread only). */
    private void doUpload(File csv) throws IOException {
        String token = AuthStorage.getValidAccessToken(context);
        if (token == null) {
            Log.i(TAG, "No valid Drive token; skipping upload");
            return;
        }

        String folderId = folderIdRef.get();
        if (folderId == null) {
            folderId = ensureFolder(token);
            if (folderId == null) {
                Log.w(TAG, "Could not resolve sessions folder");
                return;
            }
            folderIdRef.set(folderId);
        }

        byte[] csvBytes = readAllBytes(csv);
        String filename = csv.getName();
        sessionFilenameRef.set(filename);

        String fileId = sessionFileIdRef.get();
        boolean success;
        if (fileId == null) {
            String newId = createFile(token, folderId, filename, csvBytes);
            success = (newId != null);
            if (success) {
                sessionFileIdRef.set(newId);
                Log.i(TAG, "Created Drive file: " + filename + " -> " + newId);
            }
        } else {
            success = patchFile(token, fileId, csvBytes);
        }

        // 401 retry: token can expire between AuthStorage.getValidAccessToken
        // returning a not-yet-expired token and the actual HTTP call landing
        // (slow network, GC pause). Force a refresh and retry once before
        // giving up. Surfaces a real auth-broken signal to JS only after the
        // retry also 401s.
        if (!success && lastHttpStatus == 401) {
            Log.w(TAG, "Drive 401 — forcing token refresh + one retry");
            String fresh = AuthStorage.getValidAccessToken(context, /*forceRefresh=*/true);
            if (fresh != null && !fresh.equals(token)) {
                if (fileId == null) {
                    String newId = createFile(fresh, folderId, filename, csvBytes);
                    if (newId != null) sessionFileIdRef.set(newId);
                } else {
                    patchFile(fresh, fileId, csvBytes);
                }
            }
        }
    }

    // Last HTTP status seen by patchFile/createFile so doUpload can branch
    // on 401 specifically without parsing the response twice.
    private volatile int lastHttpStatus = 0;

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

    private String createFile(String token, String folderId, String filename, byte[] csvBytes) throws IOException {
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
            lastHttpStatus = resp.code();
            if (!resp.isSuccessful()) {
                Log.w(TAG, "Create file HTTP " + resp.code() + " body=" + (resp.body() != null ? resp.body().string() : ""));
                return null;
            }
            JSONObject jr = new JSONObject(resp.body().string());
            return jr.optString("id");
        } catch (Exception e) {
            Log.w(TAG, "Create file parse failed: " + e.getMessage());
            return null;
        }
    }

    private boolean patchFile(String token, String fileId, byte[] csvBytes) throws IOException {
        Request req = new Request.Builder()
            .url("https://www.googleapis.com/upload/drive/v3/files/" + fileId + "?uploadType=media")
            .header("Authorization", "Bearer " + token)
            .header("Content-Type", "text/csv")
            .patch(RequestBody.create(MediaType.parse("text/csv"), csvBytes))
            .build();
        try (Response resp = client.newCall(req).execute()) {
            lastHttpStatus = resp.code();
            if (!resp.isSuccessful()) {
                Log.w(TAG, "Patch HTTP " + resp.code());
                return false;
            }
            return true;
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
