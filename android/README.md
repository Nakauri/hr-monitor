# HR Monitor — native Android build

Kotlin + Jetpack Compose + Nordic BLE + Ktor WebSockets. Replaces the Capacitor-wrapped WebView under `../mobile/`. See `../MOBILE_LAUNCH_PLAN.md` for the full rewrite plan and phase breakdown.

## Why native

The Chromium WebView used by Capacitor buffers outbound `ws.send()` calls while the Activity is paused. On the user's Samsung S8 this caused a burst-on-foreground when the phone was screen-off + backgrounded; the relay got nothing until the Activity resumed. Native BLE + native WebSockets eliminates the WebView layer entirely.

## Layout

```
android/
├── build.gradle.kts            # root plugins
├── settings.gradle.kts         # module list, repos
├── gradle.properties           # JVM args, AndroidX flags
├── gradle/libs.versions.toml   # version catalog
├── gradle/wrapper/             # wrapper properties (jar committed on first local build)
├── keystore.properties         # LOCAL ONLY — never commit
├── hr-monitor-release.keystore # LOCAL ONLY — reused from ../mobile/
├── docs/
│   ├── privacy-policy.md
│   └── play-store-listing.md
└── app/
    ├── build.gradle.kts
    ├── proguard-rules.pro
    └── src/main/
        ├── AndroidManifest.xml
        ├── kotlin/com/nakauri/hrmonitor/
        │   ├── HrMonitorApp.kt         # Application, Sentry init, notification channel
        │   ├── MainActivity.kt         # Compose entry
        │   ├── service/
        │   │   ├── HrSessionService.kt # FGS, wake lock
        │   │   ├── WakeLockHelper.kt   # ported from Capacitor build
        │   │   └── BootReceiver.kt     # declared, wired in Phase 4
        │   ├── util/
        │   │   └── OemBackground.kt    # ported from Capacitor build
        │   └── ui/theme/
        │       └── Theme.kt
        └── res/...
```

## First-time local setup

1. Reuse the existing release keystore from the Capacitor build. Copy `../mobile/hr-monitor-release.keystore` to `./hr-monitor-release.keystore` and the keystore password plus alias to `./keystore.properties`:

   ```properties
   ANDROID_KEYSTORE_PASSWORD=<the password in ../mobile/keystore-password.txt>
   ANDROID_KEY_ALIAS=hr-monitor
   ANDROID_KEY_PASSWORD=<same as store password unless you set a separate key password>
   SENTRY_DSN=<paste from Sentry project settings, or leave blank to skip Sentry init>
   ```

2. Generate the Gradle wrapper. Needs a Gradle install on PATH (from Android Studio or Homebrew):

   ```sh
   cd android
   gradle wrapper --gradle-version 8.11.1
   ```

   This creates `gradlew`, `gradlew.bat`, and `gradle/wrapper/gradle-wrapper.jar`. Commit those once they exist so CI does not need a separate Gradle bootstrap.

3. Build a sideload APK:

   ```sh
   ./gradlew :app:assembleRelease
   ```

   The signed APK lands at `app/build/outputs/apk/release/app-release.apk`.

4. Install on your phone:

   ```sh
   adb install -r app/build/outputs/apk/release/app-release.apk
   ```

   The first install after switching from the Capacitor APK requires uninstalling the Capacitor version first, because the package name is the same but the signing certificate may differ depending on which keystore was used.

## Signing

- Local: `keystore.properties` at the project root (this folder). Gitignored.
- CI: GitHub Actions reads `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD`, `SENTRY_DSN` from repo secrets. Same secrets the Capacitor workflow already uses.
- The SHA-1 fingerprint registered in Google Cloud Platform for Drive sign-in must match the keystore the APK is signed with. Same keystore for both APKs keeps SHA-1 consistent.

## Phase status

Phase 0 (this commit): Gradle project scaffolded, manifest with all required permissions + FGS types, empty Compose UI, FGS skeleton with wake lock, Sentry wired via BuildConfig, CI workflow for release APK, privacy policy + Play Store listing drafted.

Next phases in `../MOBILE_LAUNCH_PLAN.md`.

## Do not touch `../mobile/`

The Capacitor build keeps shipping to `android-latest` GitHub Releases while the native build stabilises. It is the user's current install. Do not modify the Capacitor project or its workflow until the native build passes a 30-minute screen-off soak on three devices.
