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

## Future stages (not yet implemented)

- **Stage 4:** Android foreground service with a persistent notification so
  the OS can't kill the app while it's recording. Required for the
  "screen off, walk around for hours" use case.
- **Stage 5:** Drive OAuth via a system-browser redirect flow (the WebView
  can't open Google's OAuth popup).
- **Stage 6:** Release signing + APK artifact. Right now the workflow
  produces a debug-signed APK — fine for sideload, not for Play Store.
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
