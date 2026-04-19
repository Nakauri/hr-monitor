// drive-auth-native.js — inside Capacitor (Android), override the web GSI
// popup flow with @codetrix-studio/capacitor-google-auth's native sign-in.
// Plugin accessed via Capacitor.Plugins.GoogleAuth (NOT registerPlugin —
// see CLAUDE.md for why).

try { window.__hrMonitorDriveAuthLoaded = true; } catch (e) {}

// Everything inside this IIFE: "init" used to be a global function decl,
// which collided with foreground-service.js's identically-named global and
// silently broke Drive sign-in. Local scope prevents that.
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
      if (!isNative) { console.info('[drive-auth-native] not native, skipping native GoogleAuth.'); return; }

      // Prefer the natively-populated Plugins reference. registerPlugin is
      // an ES-module-only API; not available on window.Capacitor in plain
      // script-tag mode. See CLAUDE.md.
      let GoogleAuth = (cap.Plugins && cap.Plugins.GoogleAuth) || null;
      if (!GoogleAuth && typeof cap.registerPlugin === 'function') {
        try { GoogleAuth = cap.registerPlugin('GoogleAuth'); }
        catch (e) {
          dMark('__hrMonitorDriveAuthLastError', 'registerPlugin threw: ' + (e && e.message ? e.message : String(e)));
        }
      }
      dMark('__hrMonitorDriveAuthGotPlugin', !!GoogleAuth);
      if (!GoogleAuth) {
        console.error('[drive-auth-native] GoogleAuth plugin missing — bail.');
        dMark('__hrMonitorDriveAuthLastError', (window.__hrMonitorDriveAuthLastError || '') + ' / Capacitor.Plugins.GoogleAuth undefined');
        return;
      }

      // Web OAuth client ID from hr_monitor.html. Plugin's native Google
      // Sign-In SDK uses this as serverClientId; Android OAuth client must
      // also be registered in the same GCP project, matched by package
      // name + SHA-1 of the signing keystore.
      const WEB_CLIENT_ID = '103129946542-0ll0ojj36a38p52c20uebfl8jnu59ona.apps.googleusercontent.com';
      const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';

      let initialized = false;
      async function ensureInit() {
        if (initialized) return;
        await GoogleAuth.initialize({
          clientId: WEB_CLIENT_ID,
          scopes: [DRIVE_SCOPE],
          grantOfflineAccess: false,
        });
        initialized = true;
      }

      // Branded dark overlay during sign-in so Play Services' legacy white
      // activity doesn't crash into our dark UI. Covers OUR side of the
      // transition — can't restyle Google's dialog (different process).
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

      window.__hrMonitorNativeDriveSignIn = async function() {
        showSignInOverlay();
        try {
          await ensureInit();
        } catch (e) {
          hideSignInOverlay();
          console.error('[drive-auth-native] initialize failed:', e);
          throw new Error('Google Sign-In init failed: ' + (e && e.message ? e.message : String(e)));
        }
        let user;
        try {
          user = await GoogleAuth.signIn();
        } catch (e) {
          hideSignInOverlay();
          console.error('[drive-auth-native] signIn rejected:', e);
          const msg = (e && e.message) ? e.message : String(e);
          if (/DEVELOPER_ERROR|10/i.test(msg)) {
            throw new Error('Google rejected this build\'s signature. Check that the keystore SHA-1 is registered with the Android OAuth client in Google Cloud Console.');
          }
          if (/NETWORK_ERROR|7/.test(msg)) {
            throw new Error('Network error contacting Google. Check the phone\'s internet connection.');
          }
          if (/SIGN_IN_CANCELLED|12501/.test(msg)) {
            throw new Error('Sign-in cancelled.');
          }
          throw new Error('Google Sign-In failed: ' + msg);
        }
        hideSignInOverlay();
        if (!user || !user.authentication || !user.authentication.accessToken) {
          throw new Error('Google sign-in returned no access token. Play Services may be missing on this device.');
        }
        return {
          accessToken: user.authentication.accessToken,
          expiresIn: 3600,
        };
      };

      window.__hrMonitorNativeDriveSignOut = async function() {
        try { await GoogleAuth.signOut(); } catch (e) { console.warn('[drive-auth-native] signOut:', e); }
      };

      dMark('__hrMonitorDriveAuthRegistered', true);
      console.info('[drive-auth-native] native Google Sign-In override wired.');
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
