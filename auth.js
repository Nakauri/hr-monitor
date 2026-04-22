// auth.js — shared Google OAuth module for aorti.ca
// Single source of truth for sign-in, token refresh, sign-out, and
// cross-tab sync across index.html, hr_monitor.html, hrv_viewer.html,
// app-home.html, and diagnostics.js.
//
// Web uses Authorization Code + PKCE via GIS initCodeClient; refresh
// token lives in an HttpOnly cookie set by /api/auth/exchange. Access
// token and a little metadata live in localStorage for UI state.
//
// Capacitor Android currently delegates sign-in to the old
// drive-auth-native.js shim (access token only, no refresh). Stage 3
// replaces that with serverAuthCode → /api/auth/exchange → Keystore
// refresh-token storage. Everything outside auth.js calls the same
// window.aortiAuth.* methods; the platform branch is hidden here.

(function () {
  'use strict';

  const CLIENT_ID = '103129946542-0ll0ojj36a38p52c20uebfl8jnu59ona.apps.googleusercontent.com';
  const SCOPES = 'openid email https://www.googleapis.com/auth/drive.file';
  const POPUP_REDIRECT_URI = 'postmessage';

  const LS_KEY_V2 = 'aorti_auth_v2';
  const LS_KEY_V1 = 'hr_monitor_drive_token';
  const LS_PKCE_VERIFIER = 'aorti_pkce_verifier';
  const LS_OAUTH_STATE = 'aorti_oauth_state';

  const REFRESH_THRESHOLD_MS = 2 * 60 * 1000;
  const REFRESH_UI_DELAY_MS = 500;

  const cap = window.Capacitor;
  const isNative = !!(cap && cap.isNativePlatform && cap.isNativePlatform());

  // When running inside Capacitor, API calls must cross-origin to aorti.ca.
  // Everywhere else (production, preview deploys, local servers) the HTMLs
  // and /api/auth/* live on the same origin, so relative URLs work.
  const apiBase = (function () {
    if (window.__aortiAuthApiBase) return window.__aortiAuthApiBase;
    if (isNative) return 'https://aorti.ca';
    return '';
  })();

  // ---------- storage -------------------------------------------------------

  function loadToken() {
    try {
      const raw = localStorage.getItem(LS_KEY_V2);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed || parsed.version !== 2 || !parsed.access_token) return null;
      return parsed;
    } catch {
      return null;
    }
  }

  function saveToken(data) {
    const record = {
      version: 2,
      access_token: data.access_token,
      expires_at: data.expires_at,
      email: data.email || null,
      scope: data.scope || SCOPES,
      issued_at: Date.now(),
    };
    localStorage.setItem(LS_KEY_V2, JSON.stringify(record));
    return record;
  }

  function clearToken() {
    localStorage.removeItem(LS_KEY_V2);
    localStorage.removeItem(LS_PKCE_VERIFIER);
    localStorage.removeItem(LS_OAUTH_STATE);
  }

  // One-shot migration. Older pages stored {token, expiresAt} under
  // hr_monitor_drive_token. That token has no refresh pair, so we wipe and
  // let the next page interaction re-run sign-in.
  (function migrateV1() {
    try {
      const legacy = localStorage.getItem(LS_KEY_V1);
      if (!legacy) return;
      localStorage.removeItem(LS_KEY_V1);
      // If a v2 record already exists, keep it. Otherwise just drop v1.
    } catch {
      // ignore
    }
  })();

  // ---------- crypto (PKCE + state) ----------------------------------------

  function base64UrlEncode(bytes) {
    let str = '';
    for (let i = 0; i < bytes.length; i++) str += String.fromCharCode(bytes[i]);
    return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function randomBytes(n) {
    const buf = new Uint8Array(n);
    crypto.getRandomValues(buf);
    return buf;
  }

  async function sha256(str) {
    const enc = new TextEncoder().encode(str);
    const hash = await crypto.subtle.digest('SHA-256', enc);
    return new Uint8Array(hash);
  }

  async function makePkcePair() {
    const verifier = base64UrlEncode(randomBytes(32));
    const challenge = base64UrlEncode(await sha256(verifier));
    return { verifier, challenge };
  }

  function makeStateToken() {
    return base64UrlEncode(randomBytes(16));
  }

  // ---------- GSI loading (web only) ---------------------------------------

  let gsiLoadPromise = null;
  function waitForGsi() {
    if (gsiLoadPromise) return gsiLoadPromise;
    gsiLoadPromise = new Promise((resolve, reject) => {
      const deadline = Date.now() + 10000;
      const tick = () => {
        if (window.google && window.google.accounts && window.google.accounts.oauth2) return resolve();
        if (Date.now() > deadline) return reject(new Error('gsi_load_timeout'));
        setTimeout(tick, 120);
      };
      tick();
    });
    return gsiLoadPromise;
  }

  // ---------- fetch helpers ------------------------------------------------

  async function postAuthApi(path, body) {
    const url = apiBase + path;
    const init = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
    };
    if (body) init.body = JSON.stringify(body);
    const resp = await fetch(url, init);
    let data = {};
    try { data = await resp.json(); } catch { /* non-JSON error */ }
    return { status: resp.status, ok: resp.ok, data };
  }

  // ---------- sign-in (web) ------------------------------------------------

  async function signInWeb() {
    await waitForGsi();

    const { verifier, challenge } = await makePkcePair();
    const state = makeStateToken();
    sessionStorage.setItem(LS_PKCE_VERIFIER, verifier);
    sessionStorage.setItem(LS_OAUTH_STATE, state);

    const code = await new Promise((resolve, reject) => {
      const client = google.accounts.oauth2.initCodeClient({
        client_id: CLIENT_ID,
        scope: SCOPES,
        ux_mode: 'popup',
        state,
        code_challenge: challenge,
        code_challenge_method: 'S256',
        access_type: 'offline',
        prompt: 'consent',
        callback: (resp) => {
          if (resp.error) return reject(new Error('gsi_' + resp.error));
          if (resp.state !== state) return reject(new Error('state_mismatch'));
          resolve(resp.code);
        },
        error_callback: (err) => {
          reject(new Error('gsi_error_' + (err && err.type ? err.type : 'unknown')));
        },
      });
      try {
        client.requestCode();
      } catch (e) {
        reject(e);
      }
    });

    const { ok, status, data } = await postAuthApi('/api/auth/exchange', {
      code,
      code_verifier: verifier,
      redirect_uri: POPUP_REDIRECT_URI,
    });
    sessionStorage.removeItem(LS_PKCE_VERIFIER);
    sessionStorage.removeItem(LS_OAUTH_STATE);

    if (!ok) {
      throw new Error('exchange_failed_' + (data.google_error || status));
    }

    const record = saveToken({
      access_token: data.access_token,
      expires_at: Date.now() + (data.expires_in || 3600) * 1000 - 60 * 1000,
      email: data.email,
      scope: data.scope,
    });
    notifyChange(record);
    return record;
  }

  // ---------- sign-in (Capacitor) ------------------------------------------
  // drive-auth-native.js owns the native flow: SocialLogin popup →
  // serverAuthCode → POST /api/auth/exchange → tokens land in Android
  // Keystore via NativeHrSession.storeAuthTokens. We just consume the
  // access_token it returns and mirror a v2 record into localStorage for
  // the UI.

  async function signInNative() {
    if (typeof window.__hrMonitorNativeDriveSignIn !== 'function') {
      throw new Error('native_shim_missing');
    }
    const result = await window.__hrMonitorNativeDriveSignIn();
    if (!result || !result.accessToken) throw new Error('native_no_token');
    const record = saveToken({
      access_token: result.accessToken,
      expires_at: Date.now() + (result.expiresIn || 3600) * 1000 - 60 * 1000,
      email: result.email || null,
      scope: SCOPES,
    });
    notifyChange(record);
    return record;
  }

  async function signIn() {
    if (isNative) return signInNative();
    return signInWeb();
  }

  // ---------- refresh ------------------------------------------------------

  let refreshInFlight = null;

  async function refreshIfNeeded() {
    if (refreshInFlight) return refreshInFlight;
    refreshInFlight = (async () => {
      try {
        if (isNative) {
          if (typeof window.__hrMonitorNativeDriveRefresh !== 'function') {
            throw new Error('native_refresh_unavailable');
          }
          const out = await window.__hrMonitorNativeDriveRefresh();
          if (!out || !out.accessToken) {
            clearToken();
            notifyChange(null);
            throw new Error('refresh_token_invalid');
          }
          const existing = loadToken();
          const record = saveToken({
            access_token: out.accessToken,
            expires_at: out.expiresAt || (Date.now() + 3600 * 1000 - 60 * 1000),
            email: out.email || (existing ? existing.email : null),
            scope: existing ? existing.scope : SCOPES,
          });
          notifyChange(record);
          return record;
        }
        const { ok, status, data } = await postAuthApi('/api/auth/refresh', null);
        if (status === 401) {
          clearToken();
          notifyChange(null);
          throw new Error('refresh_token_invalid');
        }
        if (!ok) throw new Error('refresh_failed_' + status);
        const existing = loadToken();
        const record = saveToken({
          access_token: data.access_token,
          expires_at: Date.now() + (data.expires_in || 3600) * 1000 - 60 * 1000,
          email: existing ? existing.email : null,
          scope: data.scope || (existing && existing.scope) || SCOPES,
        });
        notifyChange(record);
        return record;
      } finally {
        refreshInFlight = null;
      }
    })();
    return refreshInFlight;
  }

  async function getValidAccessToken() {
    const cached = loadToken();
    if (cached && Date.now() < cached.expires_at - REFRESH_THRESHOLD_MS) {
      return cached.access_token;
    }
    const refreshed = await refreshIfNeeded();
    return refreshed.access_token;
  }

  // ---------- sign-out -----------------------------------------------------

  async function signOut(opts) {
    const options = Object.assign({ local: true, remote: true }, opts || {});
    if (options.remote) {
      try {
        await postAuthApi('/api/auth/revoke', null);
      } catch (e) {
        console.warn('[auth] revoke network error, continuing local sign-out', e);
      }
      if (isNative && typeof window.__hrMonitorNativeDriveSignOut === 'function') {
        try { await window.__hrMonitorNativeDriveSignOut(); } catch (e) { /* ignore */ }
      }
    }
    if (options.local) {
      clearToken();
      notifyChange(null);
    }
  }

  // ---------- change notifications -----------------------------------------

  const listeners = new Set();
  function notifyChange(record) {
    for (const cb of listeners) {
      try { cb(record); } catch (e) { console.error('[auth] listener threw', e); }
    }
  }

  function onAuthChange(cb) {
    listeners.add(cb);
    return () => listeners.delete(cb);
  }

  window.addEventListener('storage', (e) => {
    if (e.key !== LS_KEY_V2) return;
    notifyChange(loadToken());
  });

  // ---------- public API ---------------------------------------------------

  window.aortiAuth = {
    signIn,
    signOut,
    getValidAccessToken,
    refreshIfNeeded,
    onAuthChange,
    isSignedIn() { return !!loadToken(); },
    getEmail() { const t = loadToken(); return t ? t.email : null; },
    getCachedToken() { return loadToken(); },
    isNative,
    // UI hooks for Stage 5 loading states — callers can subscribe.
    REFRESH_UI_DELAY_MS,
  };

  // Back-compat: index.html / hr_monitor.html / hrv_viewer.html all listen
  // for the legacy LS key. Mirror writes there until those pages are
  // refactored. Empty value signals sign-out.
  onAuthChange((record) => {
    try {
      if (record) {
        localStorage.setItem(LS_KEY_V1, JSON.stringify({
          token: record.access_token,
          expiresAt: record.expires_at,
        }));
      } else {
        localStorage.removeItem(LS_KEY_V1);
      }
    } catch { /* ignore */ }
  });

  try { window.__aortiAuthLoaded = true; } catch {}
})();
