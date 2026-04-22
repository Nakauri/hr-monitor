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
        this.client = new OkHttpClient();
        this.executor = Executors.newSingleThreadExecutor();
    }

    /** Reset session-scoped state at the start of a new session. */
    public void resetSession() {
        sessionFileIdRef.set(null);
        sessionFilenameRef.set(null);
    }

    /** Attempt an upload of the given CSV file. No-op if signed-out, mid-flight, or file empty. */
    public void uploadAsync(File csv) {
        if (csv == null || !csv.exists() || csv.length() == 0) return;
        if (!inFlight.compareAndSet(false, true)) return;
        executor.submit(() -> {
            try {
                doUpload(csv);
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
        if (fileId == null) {
            fileId = createFile(token, folderId, filename, csvBytes);
            if (fileId != null) {
                sessionFileIdRef.set(fileId);
                Log.i(TAG, "Created Drive file: " + filename + " -> " + fileId);
            }
        } else {
            patchFile(token, fileId, csvBytes);
        }
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

    private void patchFile(String token, String fileId, byte[] csvBytes) throws IOException {
        Request req = new Request.Builder()
            .url("https://www.googleapis.com/upload/drive/v3/files/" + fileId + "?uploadType=media")
            .header("Authorization", "Bearer " + token)
            .header("Content-Type", "text/csv")
            .patch(RequestBody.create(MediaType.parse("text/csv"), csvBytes))
            .build();
        try (Response resp = client.newCall(req).execute()) {
            if (!resp.isSuccessful()) {
                Log.w(TAG, "Patch HTTP " + resp.code());
            }
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
