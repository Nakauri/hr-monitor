# HR Monitor — Android build (Capacitor wrapper)

This directory wraps the existing web monitor in a Capacitor shell so you can
run it on Android with **background BLE, screen-off recording, and hours-long
sessions** — things Chrome Android cannot do as a plain webpage because it
kills backgrounded tabs.

The web files in the repo root (`hr_monitor.html`, `overlay.html`,
`hrv_viewer.html`, `widget.css`, `widget.js`, `index.html`) are the source of
truth. The build copies them into `www/` and wraps them with a tiny BLE
adapter shim. **No fork, no duplication.**

## You do NOT need Android Studio on your PC.

Builds run on GitHub Actions. Push to `main`, the CI job produces a debug
APK, you download it on your phone, and sideload.

## Install flow (one time)

1. Push this repo to GitHub (Vercel already hooks `main` for the web build;
   GitHub Actions is configured in `.github/workflows/build-android.yml`).
2. Open the Actions tab after your first push. Wait for **Build Android APK**
   to finish (~3–5 minutes the first run, ~2 minutes on repeat thanks to
   cached gradle).
3. On your phone, open the same GitHub run in a browser. Scroll to
   **Artifacts** at the bottom, tap `hr-monitor-debug-…` to download the
   `.apk`.
4. Open the downloaded APK. Android will ask you to allow installs from
   your browser / file manager — allow it, then tap **Install**.
5. Open HR Monitor on your phone. Pair your strap. That's it.

## Day-to-day loop

- Edit the web files in the repo root.
- `git push`. The CI job runs automatically.
- Download the new APK on your phone. Reinstall (it updates in place).

## Plugin access pattern (IMPORTANT — read before adding native shims)

Access Capacitor plugins via `Capacitor.Plugins.<Name>`, not `Capacitor.registerPlugin(...)`.

`registerPlugin` is an ES-module API from `@capacitor/core`. Plain `<script>`-tag code (which is what all our shims are) can't import it; `window.Capacitor.registerPlugin` is `undefined` on Android. Capacitor's native bridge populates `Capacitor.Plugins.BluetoothLe`, `.GoogleAuth`, etc. directly — read from there.

```js
// Do this
const plugin = (window.Capacitor.Plugins && window.Capacitor.Plugins.SomePlugin) || null;

// Don't do this (will throw `registerPlugin is not a function`)
const plugin = window.Capacitor.registerPlugin('SomePlugin');
```

Always defer shim init to DOMContentLoaded — the bridge isn't guaranteed available before then. Use load markers at every phase so diagnostics can point at exactly which step failed.

## Architecture notes

- `src/ble-adapter.js` is the load-bearing piece. It monkey-patches
  `navigator.bluetooth` to proxy to `@capacitor-community/bluetooth-le`, so
  the repo-root `hr_monitor.html` BLE code runs unchanged on Android.
- `src/capacitor-bootstrap.js` runs first, detects whether we're native,
  and logs to console.
- `scripts/copy-web.js` pulls the repo-root HTMLs + CSS + JS into
  `mobile/www/`, injects `capacitor-bootstrap.js` + `ble-adapter.js`
  before `hr_monitor.html`'s `</head>`.
- `capacitor.config.json` holds the app id + plugin settings.
- `package.json` pins Capacitor 6 + the BLE plugin.

## What lives where

- Repo root: web source (shipped to Vercel). Unchanged by this project.
- `mobile/package.json`, `capacitor.config.json`, `scripts/`, `src/`:
  Capacitor source. Committed.
- `mobile/www/`, `mobile/android/`: generated. Gitignored. CI regenerates
  both every build.
- `.github/workflows/build-android.yml`: the CI build.

## One-time setup: Google Sign-In (Drive sync on the APK)

For Drive sign-in to work in the Android build, Google needs to know the
SHA-1 fingerprint of the keystore your APK is signed with. One-time setup
with a helper script that does everything except a couple of web-UI clicks:

### Step 1 — run the helper script (once)

Pick whichever shell you have open. Both scripts do exactly the same thing.

Git Bash (or any bash on macOS / Linux):
```bash
cd mobile
bash scripts/setup-signing.sh
```

Windows PowerShell:
```powershell
cd mobile
powershell -ExecutionPolicy Bypass -File scripts/setup-signing.ps1
```

Prerequisite: a JDK (for `keytool`). If the script reports "keytool not
found," install one from PowerShell:

```powershell
winget install --id EclipseAdoptium.Temurin.21.JDK -e
```

Close and reopen your terminal after the install, then retry. The scripts
also look in `C:\Program Files\Eclipse Adoptium`, `C:\Program Files\Java`,
etc., so you don't strictly have to wait for PATH to update.

The script:
- generates `mobile/hr-monitor-release.keystore` (gitignored)
- extracts the SHA-1 into `mobile/sha1.txt`
- base64-encodes the keystore into `mobile/hr-monitor-release.keystore.b64`
- prints a copy/paste summary of exactly what to register where

It asks you for two passwords. Use any password you want — just keep them
in a password manager. The certificate questions (name, organization, etc.)
can be anything at all; they're just baked into the cert's subject line.

### Step 2 — register the SHA-1 with Google

Go to https://console.cloud.google.com/apis/credentials → your HR Monitor
project → **Create Credentials** → **OAuth 2.0 Client ID** → **Android**.

- Package name: `com.nakauri.hrmonitor`
- SHA-1 certificate fingerprint: paste from `mobile/sha1.txt`

Save. Nothing to copy back — Google matches Android builds by package name
+ SHA-1 automatically using the web OAuth client already in the code.

### Step 3 — add the four GitHub secrets

Go to https://github.com/Nakauri/hr-monitor/settings/secrets/actions →
**New repository secret** four times:

| Name                        | Value                                            |
|-----------------------------|--------------------------------------------------|
| `ANDROID_KEYSTORE_BASE64`   | entire contents of `hr-monitor-release.keystore.b64` |
| `ANDROID_KEYSTORE_PASSWORD` | the store password you chose in step 1           |
| `ANDROID_KEY_ALIAS`         | `hr-monitor`                                     |
| `ANDROID_KEY_PASSWORD`      | the key password you chose in step 1             |

### Step 4 — back up the keystore and forget it

Move `mobile/hr-monitor-release.keystore` somewhere safe (password manager,
backup drive, whatever). It's gitignored so it won't leak through a commit,
but **if you lose this file, you cannot ever update the installed Android
app** — users would have to uninstall + reinstall fresh. One-time setup;
you'll never touch it again once the GitHub secrets are filled in.

Next push to `main` produces a signed APK. Google Sign-In on the phone
works. The landing page's Download for Android button still serves the
latest APK from the rolling release.

Until the secrets are set, the workflow falls back to Capacitor's default
debug keystore. The APK builds and installs, but Google Sign-In fails with
an "unauthorized_client" / "developer error" message.

## Future stages (not yet implemented)

- **Stage 4:** Android foreground service with a persistent notification so
  the OS can't kill the app while it's recording. Required for the
  "screen off, walk around for hours" use case.
- **iOS:** same codebase, needs `$99/year` Apple dev program + a Mac. Deferred.

## Local build, if you ever want it

Not needed, but if you do want to build on your PC:

```bash
cd mobile
npm install
npm run copy-web
npx cap add android
npx cap sync android
cd android
./gradlew assembleDebug
# APK ends up at android/app/build/outputs/apk/debug/app-debug.apk
```

Prereqs: Node 18+, JDK 17, Android SDK + platform-tools. See Capacitor's
docs at capacitorjs.com if you go this route.
