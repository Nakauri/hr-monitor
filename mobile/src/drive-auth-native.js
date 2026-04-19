// drive-auth-native.js — inside Capacitor (Android), override the web GSI
// popup flow with @codetrix-studio/capacitor-google-auth's native sign-in.
// The plugin calls Play Services Google Sign-In, gets an access token with
// the Drive scope, and we hand that to hr_monitor.html's existing
// driveAccessToken path. The rest of the Drive code stays untouched.
//
// The GSI popup never opens in a WebView, so without this override the Drive
// Sign In button hangs forever.

(function() {
  'use strict';

  const isNative = !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
  if (!isNative) return;

  const GoogleAuth = window.Capacitor && window.Capacitor.registerPlugin
    ? window.Capacitor.registerPlugin('GoogleAuth')
    : null;
  if (!GoogleAuth) {
    console.error('[drive-auth-native] GoogleAuth plugin missing — bail.');
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
  window.__hrMonitorNativeDriveSignIn = async function() {
    await ensureInit();
    const user = await GoogleAuth.signIn();
    if (!user || !user.authentication || !user.authentication.accessToken) {
      throw new Error('Google sign-in returned no token');
    }
    return {
      accessToken: user.authentication.accessToken,
      // The plugin doesn't return an expires_in on the RC. 3600 is the Google
      // access-token default. Worst case the silent-refresh path kicks in.
      expiresIn: 3600,
    };
  };

  // Sign-out counterpart so the hr_monitor.html sign-out button revokes on
  // native too.
  window.__hrMonitorNativeDriveSignOut = async function() {
    try { await GoogleAuth.signOut(); } catch (e) { console.warn('[drive-auth-native] signOut:', e); }
  };

  console.info('[drive-auth-native] native Google Sign-In override wired.');
})();
