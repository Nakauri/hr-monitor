// drive-auth-native.js — Capacitor Android sign-in bridge.
// Uses @codetrix-studio/capacitor-google-auth in OFFLINE mode so signIn()
// yields a serverAuthCode. We POST that code to
// https://aorti.ca/api/auth/exchange in exchange for access + refresh
// tokens. Tokens are then handed to NativeHrSession.storeAuthTokens for
// Keystore-backed encryption so the background uploader can refresh
// them while the WebView is paused.
//
// Plugin note: @codetrix-studio/capacitor-google-auth is unmaintained
// (last stable 2023). The actively-maintained successor
// @capgo/capacitor-social-login requires Capacitor 7+; we're on
// Capacitor 6. When we eventually upgrade Capacitor we can swap.

try { window.__hrMonitorDriveAuthLoaded = true; } catch (e) {}

(function () {
  function dMark(key, val) { try { window[key] = val; } catch (e) {} }

  // Persistent trace (last 30 events in localStorage) so we can see what
  // happened on a previous page after navigation. Diagnostics displays it.
  function trace(step, payload) {
    try {
      const entry = { t: Date.now(), step, payload: payload || null };
      let arr = [];
      try { arr = JSON.parse(localStorage.getItem('hrm_auth_trace') || '[]') || []; } catch {}
      arr.push(entry);
      if (arr.length > 30) arr = arr.slice(-30);
      localStorage.setItem('hrm_auth_trace', JSON.stringify(arr));
      console.info('[auth-trace]', step, payload || '');
    } catch (e) { /* ignore */ }
  }
  window.__hrmAuthTrace = trace;

  function whenReady(cb) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', cb, { once: true });
    } else {
      cb();
    }
  }

  function init(cap) {
    try {
      dMark('__hrMonitorDriveAuthRanInit', true);
      const platform = cap.getPlatform ? cap.getPlatform() : 'unknown';
      dMark('__hrMonitorDriveAuthPlatform', platform);
      const isNative = cap.isNativePlatform && cap.isNativePlatform();
      dMark('__hrMonitorDriveAuthIsNative', !!isNative);
      if (!isNative) { console.info('[drive-auth-native] not native, skipping native sign-in.'); return; }

      let GoogleAuth = (cap.Plugins && cap.Plugins.GoogleAuth) || null;
      const Native = (cap.Plugins && cap.Plugins.NativeHrSession) || null;
      if (!GoogleAuth && typeof cap.registerPlugin === 'function') {
        try { GoogleAuth = cap.registerPlugin('GoogleAuth'); }
        catch (e) {
          dMark('__hrMonitorDriveAuthLastError', 'registerPlugin threw: ' + (e && e.message ? e.message : String(e)));
        }
      }
      dMark('__hrMonitorDriveAuthGotPlugin', !!(GoogleAuth && Native));
      if (!GoogleAuth) {
        console.error('[drive-auth-native] GoogleAuth plugin missing.');
        dMark('__hrMonitorDriveAuthLastError', 'Capacitor.Plugins.GoogleAuth undefined');
        return;
      }
      if (!Native) {
        console.error('[drive-auth-native] NativeHrSession plugin missing.');
        dMark('__hrMonitorDriveAuthLastError', 'Capacitor.Plugins.NativeHrSession undefined');
        return;
      }

      const WEB_CLIENT_ID = '103129946542-0ll0ojj36a38p52c20uebfl8jnu59ona.apps.googleusercontent.com';
      const SCOPES = [
        'openid',
        'email',
        'https://www.googleapis.com/auth/drive.file',
      ];
      // Use www. directly — apex aorti.ca redirects to www and CORS
      // preflight rejects redirects.
      const EXCHANGE_URL = 'https://www.aorti.ca/api/auth/exchange';

      let initialized = false;
      async function ensureInit() {
        if (initialized) return;
        // grantOfflineAccess: true → signIn() returns a serverAuthCode we
        // can exchange for a refresh token on the server side.
        await GoogleAuth.initialize({
          clientId: WEB_CLIENT_ID,
          scopes: SCOPES,
          grantOfflineAccess: true,
        });
        initialized = true;
      }

      function showSignInOverlay() {
        if (document.getElementById('hrm-signin-overlay')) return;
        const style = document.createElement('style');
        style.id = 'hrm-signin-overlay-styles';
        style.textContent = `
          #hrm-signin-overlay {
            position: fixed; inset: 0;
            background: #0a0a0a;
            z-index: 20000;
            display: flex; flex-direction: column;
            align-items: center; justify-content: center;
            gap: 20px;
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
            color: #d8d8d8;
            opacity: 0;
            transition: opacity 0.2s;
          }
          #hrm-signin-overlay.shown { opacity: 1; }
          #hrm-signin-spinner {
            width: 44px; height: 44px;
            border: 3px solid rgba(93,202,165,0.15);
            border-top-color: #5DCAA5;
            border-radius: 50%;
            animation: hrm-spin 0.9s linear infinite;
          }
          @keyframes hrm-spin { to { transform: rotate(360deg); } }
          #hrm-signin-overlay .hrm-signin-label {
            font-size: 13px;
            letter-spacing: 0.08em;
            color: #8a8a8a;
            text-transform: uppercase;
            font-weight: 600;
          }
        `;
        document.head.appendChild(style);
        const overlay = document.createElement('div');
        overlay.id = 'hrm-signin-overlay';
        overlay.innerHTML = '<div id="hrm-signin-spinner"></div><div class="hrm-signin-label">Signing in with Google</div>';
        document.body.appendChild(overlay);
        requestAnimationFrame(() => overlay.classList.add('shown'));
      }
      function hideSignInOverlay() {
        const overlay = document.getElementById('hrm-signin-overlay');
        const style = document.getElementById('hrm-signin-overlay-styles');
        if (overlay) {
          overlay.classList.remove('shown');
          setTimeout(() => { if (overlay.parentNode) overlay.parentNode.removeChild(overlay); }, 220);
        }
        if (style && style.parentNode) style.parentNode.removeChild(style);
      }

      async function exchangeServerAuthCode(code) {
        const resp = await fetch(EXCHANGE_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ server_auth_code: code }),
        });
        let data = {};
        try { data = await resp.json(); } catch (e) { /* non-JSON */ }
        if (!resp.ok) {
          throw new Error('exchange_failed_' + (data.google_error || resp.status));
        }
        return data;
      }

      window.__hrMonitorNativeDriveSignIn = async function () {
        trace('signIn:start');
        showSignInOverlay();
        try {
          await ensureInit();
          trace('signIn:init_done');
        } catch (e) {
          trace('signIn:init_failed', (e && e.message) ? e.message : String(e));
          hideSignInOverlay();
          throw new Error('Google Sign-In init failed: ' + (e && e.message ? e.message : String(e)));
        }

        let loginResult;
        try {
          loginResult = await GoogleAuth.signIn();
          trace('signIn:plugin_done', {
            hasServerAuthCode: !!(loginResult && loginResult.serverAuthCode),
            hasAccessToken: !!(loginResult && loginResult.authentication && loginResult.authentication.accessToken),
            keys: loginResult ? Object.keys(loginResult) : null,
          });
        } catch (e) {
          trace('signIn:plugin_failed', (e && e.message) ? e.message : String(e));
          hideSignInOverlay();
          const msg = (e && e.message) ? e.message : String(e);
          if (/DEVELOPER_ERROR|10\b/i.test(msg)) {
            throw new Error('Google rejected this build\'s signature. Check that the keystore SHA-1 is registered with the Android OAuth client in Google Cloud Console.');
          }
          if (/NETWORK_ERROR|7\b/.test(msg)) {
            throw new Error('Network error contacting Google. Check the phone\'s internet connection.');
          }
          if (/cancel|SIGN_IN_CANCELLED|12501/i.test(msg)) {
            throw new Error('Sign-in cancelled.');
          }
          throw new Error('Google Sign-In failed: ' + msg);
        }

        // Codetrix offline-mode result shape: { serverAuthCode, authentication: {...}, email, ... }
        const serverAuthCode = loginResult && loginResult.serverAuthCode;
        if (!serverAuthCode) {
          trace('signIn:no_server_auth_code', { keys: loginResult ? Object.keys(loginResult) : null });
          hideSignInOverlay();
          throw new Error('No serverAuthCode from Google Sign-In. Check that Offline mode is enabled and the keystore SHA-1 is registered.');
        }
        trace('signIn:have_server_auth_code');

        let exchange;
        try {
          exchange = await exchangeServerAuthCode(serverAuthCode);
          trace('signIn:exchange_ok', {
            hasAccess: !!exchange.access_token,
            hasRefresh: !!exchange.refresh_token,
            email: exchange.email || null,
          });
        } catch (e) {
          trace('signIn:exchange_failed', (e && e.message) ? e.message : String(e));
          hideSignInOverlay();
          throw e;
        }

        const accessToken = exchange.access_token;
        const refreshToken = exchange.refresh_token;
        const expiresIn = exchange.expires_in || 3600;
        const expiresAt = Date.now() + expiresIn * 1000 - 60 * 1000;
        const email = exchange.email || (loginResult && loginResult.email) || null;

        try {
          await Native.storeAuthTokens({
            access_token: accessToken,
            refresh_token: refreshToken,
            expires_at: expiresAt,
            email: email,
          });
          trace('signIn:keystore_ok');
        } catch (e) {
          trace('signIn:keystore_failed', (e && e.message) ? e.message : String(e));
          console.warn('[drive-auth-native] storeAuthTokens failed', e);
        }

        hideSignInOverlay();
        trace('signIn:complete');
        return { accessToken, expiresIn, email };
      };

      window.__hrMonitorNativeDriveSignOut = async function () {
        try { await GoogleAuth.signOut(); } catch (e) { /* ignore */ }
        try { await Native.clearAuth(); } catch (e) { /* ignore */ }
      };

      // Expose a native refresh path to auth.js so getValidAccessToken() on
      // Capacitor can mint a fresh access token without re-running the
      // interactive login.
      window.__hrMonitorNativeDriveRefresh = async function () {
        try {
          const out = await Native.getValidAccessToken();
          return {
            accessToken: out.access_token,
            expiresAt: out.expires_at,
            email: out.email || null,
          };
        } catch (e) {
          return null;
        }
      };

      dMark('__hrMonitorDriveAuthRegistered', true);
      console.info('[drive-auth-native] native Google Sign-In wired (codetrix offline + AuthStorage).');
    } catch (err) {
      dMark('__hrMonitorDriveAuthLastError', 'outer: ' + (err && err.message ? err.message : String(err)));
      console.error('[drive-auth-native] unhandled error in init:', err);
    }
  }

  whenReady(function () {
    const cap = window.Capacitor;
    if (cap) init(cap);
    else console.info('[drive-auth-native] no Capacitor bridge — running as web.');
  });
})();
