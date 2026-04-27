package com.nakauri.hrmonitor;

import android.content.Context;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.IOException;
import java.io.RandomAccessFile;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;

import okhttp3.MediaType;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;

/**
 * Resumable / trickle Drive uploader. One session = one Drive file =
 * one resumable upload session that stays open from sessionStart through
 * sessionStop. Each chunk sends ONLY the new bytes since the last chunk
 * (Content-Range: bytes X-Y/*) so we don't re-upload a 12 MB sleep CSV
 * 96 times. The final chunk on stop swaps the asterisk for the actual
 * total to commit.
 *
 * Constraint: every non-final chunk MUST be a multiple of 256 KB or
 * Drive rejects with 400. The final chunk has no size constraint.
 *
 * Failure isolation: this uploader runs on its own single-thread
 * executor. BLE, relay, CSV writer are completely independent of any
 * failure here. If anything goes wrong, the caller falls back to the
 * existing full-file PATCH uploader.
 */
public class NativeDriveResumableUploader {
    private static final String TAG = "NativeDriveResumable";
    private static final int CHUNK_BLOCK = 256 * 1024;  // hard Drive constraint

    private final Context context;
    private final OkHttpClient client;
    private final ExecutorService executor;
    private final NativeDriveUploader folderHelper;

    // All session-scoped state is mutated only on `executor` (single-thread).
    // Marked volatile because callers on other threads read isReady() to
    // decide whether to use this uploader vs fall back to the full path.
    private volatile String sessionUrl = null;
    private volatile String fileId = null;
    private volatile String filename = null;
    private volatile long lastChunkEnd = 0;
    private volatile boolean broken = false;
    private final AtomicBoolean inFlight = new AtomicBoolean(false);

    public NativeDriveResumableUploader(Context context, NativeDriveUploader folderHelper) {
        this.context = context.getApplicationContext();
        this.folderHelper = folderHelper;
        this.client = folderHelper.getHttpClient();
        this.executor = Executors.newSingleThreadExecutor();
    }

    /**
     * True iff a session has been opened and not marked broken. Caller
     * uses this to choose between resumable chunks and full-file PATCH.
     */
    public boolean isReady() {
        return sessionUrl != null && !broken;
    }

    /**
     * True iff the session has explicitly failed (auth, folder, open POST,
     * or a 4xx during chunk upload). Distinct from `not yet ready` —
     * during async initialization both isReady() and isBroken() return
     * false. Caller uses this to decide fallback: only fall back to the
     * full-file PATCH path when isBroken() is true. While initializing,
     * skip the upload tick entirely so we don't create a second Drive
     * file with the same name.
     */
    public boolean isBroken() { return broken; }

    public String getFileId() { return fileId; }

    /** Reset session-scoped state. Call at the start of every new session. */
    public void resetSession() {
        executor.submit(() -> {
            sessionUrl = null;
            fileId = null;
            filename = null;
            lastChunkEnd = 0;
            broken = false;
        });
    }

    /**
     * Open a resumable upload session for the given filename. Async; uses
     * the executor to avoid blocking the caller. Returns nothing — check
     * isReady() to confirm session opened. If folder lookup or session POST
     * fails, leaves the uploader in not-ready state and the caller falls
     * back to full-file uploads.
     */
    public void startSessionAsync(String filenameArg) {
        executor.submit(() -> {
            try {
                this.filename = filenameArg;
                this.lastChunkEnd = 0;
                this.fileId = null;
                this.sessionUrl = null;
                this.broken = false;

                String token = AuthStorage.getValidAccessToken(context);
                if (token == null) {
                    Log.i(TAG, "No valid Drive token; resumable disabled this session");
                    broken = true;
                    return;
                }
                String folderId = folderHelper.getOrFetchFolderIdSync(token);
                if (folderId == null) {
                    Log.w(TAG, "No folder; resumable disabled this session");
                    broken = true;
                    return;
                }
                String url = openSession(token, folderId, filenameArg);
                if (url == null) {
                    Log.w(TAG, "openSession failed; resumable disabled this session");
                    broken = true;
                    return;
                }
                sessionUrl = url;
                Log.i(TAG, "Resumable session opened for " + filenameArg);
            } catch (Throwable t) {
                Log.w(TAG, "startSessionAsync threw: " + t.getMessage());
                broken = true;
            }
        });
    }

    /**
     * Send any new 256 KB-aligned bytes since the last chunk. No-op if
     * less than CHUNK_BLOCK has accumulated. Async.
     */
    public void appendChunkIfReadyAsync(File csv) {
        if (!isReady()) return;
        if (csv == null || !csv.exists()) return;
        if (!inFlight.compareAndSet(false, true)) return;
        executor.submit(() -> {
            try {
                long fileLen = csv.length();
                long avail = fileLen - lastChunkEnd;
                if (avail < CHUNK_BLOCK) return;  // wait for more data
                long blocks = avail / CHUNK_BLOCK;
                long chunkBytes = blocks * CHUNK_BLOCK;
                long startByte = lastChunkEnd;
                long endByte = startByte + chunkBytes - 1;
                boolean ok = sendChunk(csv, startByte, endByte, /*finalChunk=*/false, /*totalIfFinal=*/-1);
                if (ok) {
                    lastChunkEnd = endByte + 1;
                } else {
                    // sendChunk already logged + may have set broken
                }
            } catch (Throwable t) {
                Log.w(TAG, "appendChunkIfReadyAsync threw: " + t.getMessage());
                broken = true;
            } finally {
                inFlight.set(false);
            }
        });
    }

    /**
     * Send the final chunk (whatever's left after lastChunkEnd) with the
     * actual total size. Called at session stop. SYNCHRONOUS — blocks until
     * complete or failed. Returns true on success. Caller falls back to
     * full-file PATCH if false.
     */
    public boolean finalizeSync(File csv) {
        if (!isReady()) return false;
        if (csv == null || !csv.exists()) return false;
        try {
            // Wait for any in-flight chunk to finish so we don't race with a
            // concurrent appendChunkIfReadyAsync that hasn't completed yet.
            executor.submit(() -> { /* drain marker */ }).get();
        } catch (Exception ignored) {}
        try {
            long fileLen = csv.length();
            // Always send a final chunk, even if it's 0 bytes — Drive needs a
            // PUT with bytes X-Y/TOTAL to commit. Edge case: if lastChunkEnd
            // == fileLen, send an empty final chunk with bytes */fileLen.
            long startByte = lastChunkEnd;
            long endByte = fileLen - 1;
            // Retry the final chunk a couple of times on transient failures
            // (5xx, network blip). 401 is handled inside sendChunk. 4xx
            // permanent failures mark broken and don't retry. Better to
            // burn 6 seconds at session-stop than orphan a partial Drive file.
            boolean ok = false;
            final int MAX_TRIES = 3;
            for (int attempt = 1; attempt <= MAX_TRIES; attempt++) {
                ok = sendChunk(csv, startByte, endByte, /*finalChunk=*/true, /*totalIfFinal=*/fileLen);
                if (ok) break;
                if (broken) break;  // permanent failure flagged inside sendChunk
                if (attempt < MAX_TRIES) {
                    long backoff = 1000L * (1L << (attempt - 1));
                    Log.w(TAG, "finalize attempt " + attempt + " failed; retrying in " + backoff + "ms");
                    try { Thread.sleep(backoff); } catch (InterruptedException ie) { Thread.currentThread().interrupt(); break; }
                }
            }
            if (ok) {
                Log.i(TAG, "Resumable finalize OK: " + filename + " (" + fileLen + " bytes)");
                lastChunkEnd = fileLen;
            } else {
                Log.w(TAG, "Resumable finalize failed after retries; caller will fall back to full upload");
                broken = true;
            }
            return ok;
        } catch (Throwable t) {
            Log.w(TAG, "finalizeSync threw: " + t.getMessage());
            broken = true;
            return false;
        }
    }

    // ---- HTTP helpers ----

    /** POST to /upload?uploadType=resumable. Returns session URL or null. */
    private String openSession(String token, String folderId, String name) throws IOException {
        JSONObject meta = new JSONObject();
        try {
            meta.put("name", name);
            meta.put("parents", new JSONArray().put(folderId));
            meta.put("mimeType", "text/csv");
        } catch (Exception e) {
            return null;
        }
        Request req = new Request.Builder()
            .url("https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id")
            .header("Authorization", "Bearer " + token)
            .header("X-Upload-Content-Type", "text/csv")
            .post(RequestBody.create(MediaType.parse("application/json; charset=UTF-8"), meta.toString()))
            .build();
        try (Response resp = client.newCall(req).execute()) {
            if (!resp.isSuccessful()) {
                Log.w(TAG, "openSession HTTP " + resp.code());
                return null;
            }
            String loc = resp.header("Location");
            if (loc == null || loc.isEmpty()) {
                Log.w(TAG, "openSession returned no Location header");
                return null;
            }
            return loc;
        }
    }

    /**
     * PUT a byte range to the resumable session URL.
     * - finalChunk=false: Content-Range: bytes start-end/* — expects 308.
     * - finalChunk=true:  Content-Range: bytes start-end/TOTAL — expects 200.
     *
     * 401 token-expiry: re-fetch token and retry once. The session URL
     * itself doesn't carry auth; each PUT carries its own bearer header.
     */
    private boolean sendChunk(File csv, long startByte, long endByte, boolean finalChunk, long totalIfFinal) throws IOException {
        String token = AuthStorage.getValidAccessToken(context);
        if (token == null) {
            Log.w(TAG, "No token for chunk; marking broken");
            broken = true;
            return false;
        }
        boolean result = doSendChunk(token, csv, startByte, endByte, finalChunk, totalIfFinal);
        if (!result && lastChunkHttpStatus == 401) {
            String fresh = AuthStorage.getValidAccessToken(context, /*forceRefresh=*/true);
            if (fresh != null && !fresh.equals(token)) {
                result = doSendChunk(fresh, csv, startByte, endByte, finalChunk, totalIfFinal);
            }
        }
        if (!result && (lastChunkHttpStatus >= 400 && lastChunkHttpStatus < 500 && lastChunkHttpStatus != 408 && lastChunkHttpStatus != 429)) {
            // 4xx (except 408/429) means the session is dead. Mark broken.
            broken = true;
        }
        return result;
    }

    private volatile int lastChunkHttpStatus = 0;

    private boolean doSendChunk(String token, File csv, long startByte, long endByte, boolean finalChunk, long totalIfFinal) throws IOException {
        long chunkLen = endByte - startByte + 1;
        if (chunkLen < 0) chunkLen = 0;  // empty final chunk is legal

        byte[] body = new byte[(int) chunkLen];
        if (chunkLen > 0) {
            try (RandomAccessFile raf = new RandomAccessFile(csv, "r")) {
                raf.seek(startByte);
                int read = 0;
                while (read < body.length) {
                    int r = raf.read(body, read, body.length - read);
                    if (r < 0) break;
                    read += r;
                }
                if (read < body.length) {
                    Log.w(TAG, "short read: wanted " + body.length + " got " + read);
                    // file shrank? truncate body to actual read.
                    byte[] trimmed = new byte[read];
                    System.arraycopy(body, 0, trimmed, 0, read);
                    body = trimmed;
                    endByte = startByte + read - 1;
                    if (finalChunk) totalIfFinal = startByte + read;
                }
            }
        }

        String contentRange;
        if (finalChunk) {
            if (chunkLen == 0) {
                // Empty final commit. Drive accepts bytes */TOTAL with no body.
                contentRange = "bytes */" + totalIfFinal;
            } else {
                contentRange = "bytes " + startByte + "-" + endByte + "/" + totalIfFinal;
            }
        } else {
            contentRange = "bytes " + startByte + "-" + endByte + "/*";
        }

        RequestBody reqBody = RequestBody.create(MediaType.parse("text/csv"), body);
        Request req = new Request.Builder()
            .url(sessionUrl)
            .header("Authorization", "Bearer " + token)
            .header("Content-Range", contentRange)
            .put(reqBody)
            .build();
        try (Response resp = client.newCall(req).execute()) {
            lastChunkHttpStatus = resp.code();
            int code = resp.code();
            if (finalChunk) {
                if (code >= 200 && code < 300) {
                    // Success — capture file ID for any subsequent ops.
                    try {
                        String b = resp.body() != null ? resp.body().string() : "";
                        if (!b.isEmpty()) {
                            JSONObject jr = new JSONObject(b);
                            String id = jr.optString("id", null);
                            if (id != null && !id.isEmpty()) fileId = id;
                        }
                    } catch (Exception ignored) {}
                    return true;
                }
                Log.w(TAG, "Final chunk HTTP " + code);
                return false;
            } else {
                if (code == 308) return true;
                if (code >= 200 && code < 300) {
                    // Drive thinks we're done — odd but accept. File ID may be in body.
                    Log.i(TAG, "Drive returned 2xx mid-stream; treating as accepted");
                    return true;
                }
                Log.w(TAG, "Intermediate chunk HTTP " + code);
                return false;
            }
        }
    }
}
