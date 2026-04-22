// drive-auth-native.js — Capacitor Android sign-in bridge.
// Replaces the abandoned @codetrix-studio/capacitor-google-auth plugin
// with @capgo/capacitor-social-login (actively maintained). The login
// returns a one-time `serverAuthCode` which we POST to
// https://aorti.ca/api/auth/exchange in exchange for access + refresh
// tokens. Tokens are then handed to NativeHrSession.storeAuthTokens for
// Keystore-backed encryption so the background uploader can refresh
// them while the WebView is paused.

try { window.__hrMonitorDriveAuthLoaded = true; } catch (e) {}

(function () {
  function dMark(key, val) { try { window[key] = val; } catch (e) {} }

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

      const SocialLogin = (cap.Plugins && cap.Plugins.SocialLogin) || null;
      const Native = (cap.Plugins && cap.Plugins.NativeHrSession) || null;
      dMark('__hrMonitorDriveAuthGotPlugin', !!(SocialLogin && Native));
      if (!SocialLogin) {
        console.error('[drive-auth-native] SocialLogin plugin missing.');
        dMark('__hrMonitorDriveAuthLastError', 'Capacitor.Plugins.SocialLogin undefined');
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
      const EXCHANGE_URL = 'https://aorti.ca/api/auth/exchange';

      let initialized = false;
      async function ensureInit() {
        if (initialized) return;
        await SocialLogin.initialize({
          google: {
            webClientId: WEB_CLIENT_ID,
            mode: 'offline',
          },
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
        showSignInOverlay();
        try {
          await ensureInit();
        } catch (e) {
          hideSignInOverlay();
          throw new Error('Google Sign-In init failed: ' + (e && e.message ? e.message : String(e)));
        }

        let loginResult;
        try {
          loginResult = await SocialLogin.login({
            provider: 'google',
            options: {
              scopes: SCOPES,
              forceRefreshToken: true,
            },
          });
        } catch (e) {
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

        // Capgo returns the actual fields under `.result`.
        const result = (loginResult && loginResult.result) || loginResult || {};
        const serverAuthCode = result.serverAuthCode || result.authCode || null;
        if (!serverAuthCode) {
          hideSignInOverlay();
          throw new Error('No serverAuthCode from Google Sign-In (offline mode not returning a code).');
        }

        let exchange;
        try {
          exchange = await exchangeServerAuthCode(serverAuthCode);
        } catch (e) {
          hideSignInOverlay();
          throw e;
        }

        const accessToken = exchange.access_token;
        const refreshToken = exchange.refresh_token;
        const expiresIn = exchange.expires_in || 3600;
        const expiresAt = Date.now() + expiresIn * 1000 - 60 * 1000;
        const email = exchange.email || (result.profile && result.profile.email) || null;

        try {
          await Native.storeAuthTokens({
            access_token: accessToken,
            refresh_token: refreshToken,
            expires_at: expiresAt,
            email: email,
          });
        } catch (e) {
          console.warn('[drive-auth-native] storeAuthTokens failed', e);
        }

        hideSignInOverlay();
        return { accessToken, expiresIn, email };
      };

      window.__hrMonitorNativeDriveSignOut = async function () {
        try { await SocialLogin.logout({ provider: 'google' }); } catch (e) { /* ignore */ }
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
      console.info('[drive-auth-native] native Google Sign-In wired (capgo/social-login + AuthStorage).');
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
