package com.nakauri.hrmonitor;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import android.util.Log;

import org.json.JSONObject;

import java.nio.charset.StandardCharsets;
import java.security.KeyStore;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

import okhttp3.MediaType;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;

/**
 * Encrypted storage for the aorti.ca Google OAuth refresh + access token pair.
 *
 * Design:
 *   - Generates a 256-bit AES key in the Android Keystore (hardware-backed
 *     on most devices since ~API 23).
 *   - Encrypts token strings with AES/GCM/NoPadding and stores the ciphertext
 *     (IV || CT || GCM-tag) as base64 in a private SharedPreferences file.
 *   - Background refresh: when the access token is within 2 min of expiry,
 *     POST the refresh_token to https://aorti.ca/api/auth/refresh and cache
 *     the new access token.
 *   - On refresh-token invalidation (401), wipe everything so the WebView
 *     knows to prompt a fresh sign-in.
 *
 * NOT using androidx.security:security-crypto (EncryptedSharedPreferences) —
 * that whole package was deprecated in AndroidX Security 1.1.0 (July 2025).
 */
public final class AuthStorage {
    private static final String TAG = "AuthStorage";

    private static final String KEYSTORE_PROVIDER = "AndroidKeyStore";
    private static final String KEY_ALIAS = "aorti_auth_v1";
    private static final String PREFS_NAME = "aorti_auth";

    private static final String PREF_ACCESS = "access_ct";
    private static final String PREF_REFRESH = "refresh_ct";
    private static final String PREF_EXPIRES_AT = "expires_at";
    private static final String PREF_EMAIL = "email";

    private static final int IV_BYTES = 12;
    private static final int GCM_TAG_BITS = 128;

    // Hit www.aorti.ca directly: apex redirects to www and the redirect
    // would add a second round-trip to every background refresh.
    private static final String REFRESH_URL = "https://www.aorti.ca/api/auth/refresh";
    // Capacitor Android WebView origin — matches the CORS allowlist in
    // /api/auth/* so the serverless functions accept this call. Native
    // okhttp requests don't set Origin automatically.
    private static final String APP_ORIGIN = "https://localhost";
    private static final long REFRESH_THRESHOLD_MS = 2L * 60L * 1000L;

    private static final OkHttpClient HTTP = new OkHttpClient();

    private AuthStorage() {}

    public static synchronized void store(
            Context ctx, String accessToken, String refreshToken, long expiresAt, String email) throws Exception {
        SecretKey key = getOrCreateKey();
        SharedPreferences.Editor ed = prefs(ctx).edit();
        if (accessToken != null) ed.putString(PREF_ACCESS, encrypt(key, accessToken));
        if (refreshToken != null) ed.putString(PREF_REFRESH, encrypt(key, refreshToken));
        if (expiresAt > 0) ed.putLong(PREF_EXPIRES_AT, expiresAt);
        if (email != null) ed.putString(PREF_EMAIL, email);
        ed.apply();
    }

    /**
     * Returns a valid access token, refreshing via /api/auth/refresh if the
     * cached one is within REFRESH_THRESHOLD_MS of expiry. Returns null if
     * no refresh token is available, or if refresh fails. Caller should
     * treat null as "not signed in" and skip the API call.
     *
     * Synchronous: must be invoked from a background thread.
     */
    public static synchronized String getValidAccessToken(Context ctx) {
        try {
            SharedPreferences p = prefs(ctx);
            String accessCt = p.getString(PREF_ACCESS, null);
            String refreshCt = p.getString(PREF_REFRESH, null);
            long expiresAt = p.getLong(PREF_EXPIRES_AT, 0);
            SecretKey key = getKey();
            if (key == null || refreshCt == null) return null;
            if (accessCt != null && System.currentTimeMillis() < expiresAt - REFRESH_THRESHOLD_MS) {
                return decrypt(key, accessCt);
            }
            String refreshToken = decrypt(key, refreshCt);
            return refreshAccessToken(ctx, refreshToken, key, p);
        } catch (Exception e) {
            Log.w(TAG, "getValidAccessToken: " + e.getMessage());
            return null;
        }
    }

    public static synchronized long getExpiresAt(Context ctx) {
        return prefs(ctx).getLong(PREF_EXPIRES_AT, 0);
    }

    public static synchronized String getEmail(Context ctx) {
        return prefs(ctx).getString(PREF_EMAIL, null);
    }

    public static synchronized boolean isSignedIn(Context ctx) {
        return prefs(ctx).getString(PREF_REFRESH, null) != null;
    }

    public static synchronized void clear(Context ctx) {
        prefs(ctx).edit().clear().apply();
        try {
            KeyStore ks = KeyStore.getInstance(KEYSTORE_PROVIDER);
            ks.load(null);
            if (ks.containsAlias(KEY_ALIAS)) ks.deleteEntry(KEY_ALIAS);
        } catch (Exception e) {
            Log.w(TAG, "clear keystore entry: " + e.getMessage());
        }
    }

    private static SharedPreferences prefs(Context ctx) {
        return ctx.getApplicationContext().getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
    }

    private static String refreshAccessToken(Context ctx, String refreshToken, SecretKey key, SharedPreferences p) throws Exception {
        JSONObject body = new JSONObject();
        body.put("refresh_token", refreshToken);
        Request req = new Request.Builder()
            .url(REFRESH_URL)
            .header("Content-Type", "application/json")
            .header("Origin", APP_ORIGIN)
            .post(RequestBody.create(MediaType.parse("application/json"), body.toString()))
            .build();
        try (Response resp = HTTP.newCall(req).execute()) {
            if (resp.code() == 401) {
                Log.w(TAG, "Refresh token revoked, clearing auth");
                clear(ctx);
                return null;
            }
            if (!resp.isSuccessful()) {
                Log.w(TAG, "Refresh HTTP " + resp.code());
                return null;
            }
            String rawBody = resp.body() != null ? resp.body().string() : "{}";
            JSONObject j = new JSONObject(rawBody);
            String newAccess = j.optString("access_token", null);
            if (newAccess == null || newAccess.isEmpty()) return null;
            long expiresIn = j.optLong("expires_in", 3600L);
            long newExpiresAt = System.currentTimeMillis() + expiresIn * 1000L - 60L * 1000L;
            SharedPreferences.Editor ed = p.edit();
            ed.putString(PREF_ACCESS, encrypt(key, newAccess));
            ed.putLong(PREF_EXPIRES_AT, newExpiresAt);
            String rotated = j.optString("refresh_token", null);
            if (rotated != null && !rotated.isEmpty()) {
                ed.putString(PREF_REFRESH, encrypt(key, rotated));
            }
            ed.apply();
            return newAccess;
        }
    }

    private static SecretKey getOrCreateKey() throws Exception {
        SecretKey existing = getKey();
        if (existing != null) return existing;
        KeyGenerator kg = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE_PROVIDER);
        kg.init(new KeyGenParameterSpec.Builder(
                KEY_ALIAS,
                KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(256)
            .setUserAuthenticationRequired(false)
            .build());
        return kg.generateKey();
    }

    private static SecretKey getKey() throws Exception {
        KeyStore ks = KeyStore.getInstance(KEYSTORE_PROVIDER);
        ks.load(null);
        return (SecretKey) ks.getKey(KEY_ALIAS, null);
    }

    private static String encrypt(SecretKey key, String plaintext) throws Exception {
        Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
        c.init(Cipher.ENCRYPT_MODE, key);
        byte[] iv = c.getIV();
        byte[] ct = c.doFinal(plaintext.getBytes(StandardCharsets.UTF_8));
        byte[] combined = new byte[iv.length + ct.length];
        System.arraycopy(iv, 0, combined, 0, iv.length);
        System.arraycopy(ct, 0, combined, iv.length, ct.length);
        return Base64.encodeToString(combined, Base64.NO_WRAP);
    }

    private static String decrypt(SecretKey key, String b64) throws Exception {
        byte[] combined = Base64.decode(b64, Base64.NO_WRAP);
        if (combined.length <= IV_BYTES) throw new IllegalArgumentException("ciphertext too short");
        byte[] iv = new byte[IV_BYTES];
        byte[] ct = new byte[combined.length - IV_BYTES];
        System.arraycopy(combined, 0, iv, 0, IV_BYTES);
        System.arraycopy(combined, IV_BYTES, ct, 0, ct.length);
        Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
        c.init(Cipher.DECRYPT_MODE, key, new GCMParameterSpec(GCM_TAG_BITS, iv));
        return new String(c.doFinal(ct), StandardCharsets.UTF_8);
    }
}
