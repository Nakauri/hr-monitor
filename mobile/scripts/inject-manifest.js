#!/usr/bin/env node
// inject-manifest.js — post-cap-sync: add our custom permissions + tweak
// the foreground-service type in the Capacitor-generated AndroidManifest.xml.
//
// Plugins auto-merge their own manifests (BLE perms, base FGS perms). Here
// we only inject what's specific to THIS app's use case:
//   - REQUEST_IGNORE_BATTERY_OPTIMIZATIONS (for the battery-exemption prompt)
//   - foregroundServiceType="connectedDevice" on the capawesome FGS service
//     (the plugin's default may be a different type; BLE strap = connectedDevice)
//
// Idempotent: only injects if the line isn't already present.

const fs = require('fs');
const path = require('path');

const manifestPath = path.resolve(__dirname, '..', 'android', 'app', 'src', 'main', 'AndroidManifest.xml');

if (!fs.existsSync(manifestPath)) {
  console.error('[inject-manifest] AndroidManifest.xml not found at', manifestPath);
  process.exit(1);
}

let xml = fs.readFileSync(manifestPath, 'utf8');
let changed = false;

// Ensure tools namespace is declared so tools:replace works on merged elements.
if (!/xmlns:tools=/.test(xml)) {
  xml = xml.replace(
    /<manifest\s+xmlns:android="http:\/\/schemas\.android\.com\/apk\/res\/android"/,
    '<manifest xmlns:android="http://schemas.android.com/apk/res/android" xmlns:tools="http://schemas.android.com/tools"'
  );
  changed = true;
  console.log('[inject-manifest] added xmlns:tools');
}

// Inject REQUEST_IGNORE_BATTERY_OPTIMIZATIONS before </manifest>.
if (!/REQUEST_IGNORE_BATTERY_OPTIMIZATIONS/.test(xml)) {
  xml = xml.replace(
    /<\/manifest>\s*$/,
    '    <uses-permission android:name="android.permission.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS" />\n</manifest>\n'
  );
  changed = true;
  console.log('[inject-manifest] added REQUEST_IGNORE_BATTERY_OPTIMIZATIONS');
}

// Inject WAKE_LOCK. The capawesome foreground-service plugin grabs a wake
// lock internally to keep the service CPU-active; without this permission
// it throws SecurityException at startForegroundService() time and the
// notification never shows. Symptom when missing: "neither user N nor
// current process as android.permission.WAKE_LOCK" in fgs last error.
if (!/android\.permission\.WAKE_LOCK/.test(xml)) {
  xml = xml.replace(
    /<\/manifest>\s*$/,
    '    <uses-permission android:name="android.permission.WAKE_LOCK" />\n</manifest>\n'
  );
  changed = true;
  console.log('[inject-manifest] added WAKE_LOCK');
}

// Inject FOREGROUND_SERVICE_CONNECTED_DEVICE. On Android 14 a foreground
// service declared with foregroundServiceType="connectedDevice" MUST have
// this permission; without it the OS throws SecurityException on the main
// thread at startForegroundService() time and kills the app outside any
// JS try/catch ("HR Monitor keeps stopping").
if (!/FOREGROUND_SERVICE_CONNECTED_DEVICE/.test(xml)) {
  xml = xml.replace(
    /<\/manifest>\s*$/,
    '    <uses-permission android:name="android.permission.FOREGROUND_SERVICE_CONNECTED_DEVICE" />\n</manifest>\n'
  );
  changed = true;
  console.log('[inject-manifest] added FOREGROUND_SERVICE_CONNECTED_DEVICE');
}

// Inject a service-type override for the capawesome FGS plugin's service.
// Plugin ships AndroidForegroundService; we override the type to connectedDevice.
if (!/AndroidForegroundService[\s\S]{0,400}connectedDevice/.test(xml)) {
  const serviceOverride = `        <service
            android:name="io.capawesome.capacitorjs.plugins.foregroundservice.AndroidForegroundService"
            android:foregroundServiceType="connectedDevice"
            tools:replace="android:foregroundServiceType"
            android:exported="false" />\n`;
  if (/<\/application>/.test(xml)) {
    xml = xml.replace(/<\/application>/, serviceOverride + '    </application>');
    changed = true;
    console.log('[inject-manifest] added connectedDevice foregroundServiceType override');
  } else {
    console.warn('[inject-manifest] no </application> tag — service override skipped');
  }
}

if (changed) {
  fs.writeFileSync(manifestPath, xml);
  console.log('[inject-manifest] wrote', manifestPath);
} else {
  console.log('[inject-manifest] no changes needed');
}
