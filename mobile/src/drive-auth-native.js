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
    try {
      await ensureInit();
    } catch (e) {
      console.error('[drive-auth-native] initialize failed:', e);
      throw new Error('Google Sign-In init failed: ' + (e && e.message ? e.message : String(e)));
    }
    let user;
    try {
      user = await GoogleAuth.signIn();
    } catch (e) {
      console.error('[drive-auth-native] signIn rejected:', e);
      // Google's most common native errors. Translate into something actionable.
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
    if (!user || !user.authentication || !user.authentication.accessToken) {
      throw new Error('Google sign-in returned no access token. Play Services may be missing on this device.');
    }
    return {
      accessToken: user.authentication.accessToken,
      // The plugin doesn't return expires_in on the RC. 3600 is Google's
      // default; silent-refresh will bail us out if it's actually shorter.
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
