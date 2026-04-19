// drive-auth-native.js — inside Capacitor (Android), override the web GSI
// popup flow with @codetrix-studio/capacitor-google-auth's native sign-in.
// The plugin calls Play Services Google Sign-In, gets an access token with
// the Drive scope, and we hand that to hr_monitor.html's existing
// driveAccessToken path. The rest of the Drive code stays untouched.
//
// The GSI popup never opens in a WebView, so without this override the Drive
// Sign In button hangs forever.

// Load marker for diagnostics: "did this script run at all?"
try { window.__hrMonitorDriveAuthLoaded = true; } catch (e) {}

// Defer until DOMContentLoaded so Capacitor's bridge is guaranteed present.
// Running from <head> means our listener registers before the main page's,
// so by the time hr_monitor.html's init code asks for the native override,
// it's already installed on window.
(function () {
  function whenReady(cb) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', cb, { once: true });
    } else {
      cb();
    }
  }
  whenReady(function () {
    // Capacitor's native bridge exposes Capacitor.Plugins without needing
    // registerPlugin. Only bail if window.Capacitor itself is missing.
    const cap = window.Capacitor;
    if (cap) init(cap);
    else console.info('[drive-auth-native] no Capacitor bridge — running as web.');
  });
})();

function dMark(key, val) { try { window[key] = val; } catch (e) {} }

function init(cap) {
  try {
    'use strict';
    dMark('__hrMonitorDriveAuthRanInit', true);
    const platform = cap.getPlatform ? cap.getPlatform() : 'unknown';
    dMark('__hrMonitorDriveAuthPlatform', platform);
    const isNative = cap.isNativePlatform && cap.isNativePlatform();
    dMark('__hrMonitorDriveAuthIsNative', !!isNative);
    if (!isNative) { console.info('[drive-auth-native] not native, skipping native GoogleAuth.'); return; }

    // Prefer the natively-populated Plugins reference over registerPlugin,
    // which is a JS-module-only API unavailable on window.Capacitor in
    // script-tag mode. Same pattern as ble-adapter.js.
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

  // Web OAuth client ID from hr_monitor.html. Used as serverClientId — the
  // plugin's native Google Sign-In SDK uses this to request an access token
  // (the Android OAuth client must also be registered in the SAME GCP
  // project, matched by package name + SHA-1 of the signing keystore).
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

  // Expose an override that hr_monitor.html's driveSignIn can delegate to.
  // Contract: returns a Promise<{ accessToken, expiresIn }> on success, or
  // throws with a user-friendly message. Called with no arguments.
  // Paint a branded dark overlay during sign-in so Play Services' legacy
  // oversized-white-spinner Activity doesn't crash into our dark app. We
  // can't restyle Google's dialog (it runs in Play Services' process), but
  // we CAN cover our side cleanly during the transition.
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
    // next frame → fade in
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

  // Sign-out counterpart so the hr_monitor.html sign-out button revokes on
  // native too.
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
