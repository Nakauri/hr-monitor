# Google Play Store launch plan

End-state: aorti listed in Play, Internal Testing → Closed Testing → Production. Solo dev, frame as fitness/training app (not medical device), `drive.file` scope (per-file, single user-owned folder).

## 0. Decisions to lock before starting

- **Package name** stays `com.nakauri.hrmonitor`. Once published it's immutable, so confirm now.
- **App title** for the store: e.g. "aorti — HR & HRV Monitor". Limit 30 chars.
- **Studio CG branding**: developer name shown in Play. Either personal name or "Studio CG" / "Nakauri". Affects both Play Console signup and Drive OAuth consent screen.
- **Pricing**: free, no IAP, no ads. Simplifies review + privacy form.
- **Distribution**: all countries, or restricted? Default to all unless there's a regulatory reason not to (no HIPAA / GDPR-special handling needed because we don't process data on a server).
- **Health Connect integration**: out of scope for v1. Can add later. Reviewers may ask why we don't sync to Health; answer is "user data stays in user's own Drive, no third-party sync". Not a blocker.

## 1. Technical prep

### 1.1 Build output: APK → AAB

Play requires Android App Bundle (`.aab`). One-line gradle change:

```
./gradlew bundleRelease
```

Output lands in `mobile/android/app/build/outputs/bundle/release/app-release.aab`.

The existing `assembleDebug` / `assembleRelease` flow stays for sideloading. CI Action needs a new `bundleRelease` step.

### 1.2 Verify gradle config

Audit `mobile/android-overlay/app/build.gradle`:

- `compileSdk` — must be ≥ 34 (Play 2026 floor; bump to 35 to be safe).
- `targetSdkVersion` — must match Play's current floor (35 in 2026; check at submission time).
- `minSdkVersion` — currently set, verify. 26 (Android 8) is the practical floor for FGS support and current BLE behaviour. Anything lower is just not worth supporting.
- `versionCode` — monotonic integer; bump every release. Adopt `<major><minor><patch><build>` (e.g. `10203` for 1.2.3 build #1).
- `versionName` — semantic version string for users.
- `signingConfigs.release` — verify the keystore path + alias + password env vars work in CI.

### 1.3 Play App Signing (mandatory for new apps)

Play App Signing means Google holds the final signing key; we sign with an "upload key". Once enrolled, the upload key can be rotated; the actual app signing key cannot leave Google. **This is mandatory for new apps and irreversible — enrol the same upload key as our current `release.keystore`.**

Practical: in Play Console during initial app creation, choose "Use Play App Signing", upload our existing keystore as the upload key, and Google generates the deployment key on their side.

### 1.4 Manifest audit

Walk through `mobile/android-overlay/app/src/main/AndroidManifest.xml` and confirm every declared permission has a justification ready for the Play Console form (see §3.2). Anything declared-but-unused should be removed before submission.

Expected permissions:

- `BLUETOOTH_SCAN` — discovering HR straps.
- `BLUETOOTH_CONNECT` — connecting to picked strap.
- `BLUETOOTH` / `BLUETOOTH_ADMIN` (legacy, only if `minSdk < 31`).
- `ACCESS_FINE_LOCATION` — required by Android 6-11 to use BLE scan results. Mark with `usesPermissionFlags="neverForLocation"` so Play knows we don't actually use location.
- `FOREGROUND_SERVICE` — required for the recording service.
- `FOREGROUND_SERVICE_HEALTH` — Android 14+ requires a typed FGS declaration. Use `health` for HR monitoring.
- `POST_NOTIFICATIONS` — Android 13+ to show the recording notification.
- `WAKE_LOCK` — keep CPU active while recording with screen off.
- `INTERNET` — relay WebSocket + Drive uploads.
- `ACCESS_NETWORK_STATE` — for the relay handoff watcher (currently throws on Samsung S8 if missing — verify it's declared).
- `RECEIVE_BOOT_COMPLETED` — only if we want session resume after reboot. Probably skip for v1.
- `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` — battery optimisation prompt. Already used.

Service `<service android:name=".NativeHrService" android:foregroundServiceType="health" exported="false" />`.

### 1.5 Renderer + WebView quirks

The `WebViewRenderProcessClient` `ClassNotFoundException` we hit on Samsung S8 (API 28) is a Capacitor 6 + AndroidX webkit thing on first install. Doesn't break anything but looks bad. Investigate before launch:

- Check if Capacitor 6 truly requires API 29+ at runtime, or if the missing class is only used in optional code paths.
- If unavoidable, bump `minSdkVersion` to 29 (Android 10). Cuts off ~10% of devices but ends the crash.

## 2. Drive OAuth verification

`drive.file` is in Google's **Sensitive** scope tier (re-classified in 2023). Requires OAuth verification before public release, but **does not** require a third-party security assessment (CASA). That's only for Restricted scopes (`drive`, `drive.readonly`, `drive.metadata`).

### 2.1 Verification submission

OAuth verification form in Google Cloud Console → APIs & Services → OAuth consent screen → Submit for verification.

What's needed:

- **Privacy policy URL** at a stable hostname (aorti.ca/privacy).
- **App demo video** (YouTube unlisted) showing:
  - Sign-in flow with the consent screen visible
  - Where the Drive scope is used (folder shows up in the user's Drive)
  - That data stays in the user's own Drive
  - Roughly 1-3 minutes total
- **Justification text** explaining the scope: "Used to write per-session HR/HRV CSV files to a single user-owned `aorti` folder in the user's Google Drive. No access to other Drive content. Per-file scope; we cannot read or list anything we didn't create."
- **Domain ownership** of aorti.ca verified in Google Search Console (linked to the Cloud Console project).
- **Brand info** matching the consent screen (app name, logo, support email, links).

Realistic timeline: 2-6 weeks. Google ping-pongs feedback. Submit early; verification is the long pole.

### 2.2 Pre-verification UX

Until verification clears, the OAuth consent screen shows the "unverified app" warning. We can:

- Add up to 100 test users in the Cloud Console — they bypass the warning.
- Use the testing tracks on Play with the same allowlisted Google accounts.
- Once verified, the warning disappears for all users.

This means we can soft-launch via Play's Internal/Closed Testing while verification is in flight.

## 3. Privacy policy + Data Safety form

### 3.1 Privacy policy

Host at `aorti.ca/privacy` (or wherever, but URL must be stable, public, and link from the Play listing). Must explicitly cover:

- **What data is collected**: HR readings, HRV (RMSSD), session timestamps, optional events / posture markers, optional broadcast key.
- **Where it goes**: only to the user's own Google Drive (if they sign in) and/or to a relay PartyKit server (only if broadcast is on, only HR/HRV ticks, no identity info beyond a self-generated device label).
- **What we don't collect**: no analytics, no third-party tracking, no ad SDKs, no health data shared with the developer or any third party.
- **BLE permissions**: HR strap connection only; no location use.
- **User rights**: how to delete (clear local cache button + delete files from their Drive folder).
- **Contact**: support email.
- **Effective date** + change log.

`legal.html` already has a lot of this. Audit it against the points above and fill the gaps. One canonical source.

### 3.2 Data Safety form (Play Console)

The data safety form maps each declared permission and data type to:

- Is it collected? (sent off the device under our control)
- Is it shared with third parties?
- Is it required or optional?
- Is data encrypted in transit?
- Can users request deletion?

Per Google's definition, **data sent to user's own Drive does not count as "collected by the developer"** — it never reaches us. Same for the relay: ticks fan out to other devices on the same key, no developer-owned server stores them.

So the realistic answers:

- **Collected**: nothing under our control.
- **Shared**: HR/HRV ticks are shared with the relay (PartyKit) only when broadcast is on. Mark this as user-controlled and optional.
- **Encryption in transit**: yes (HTTPS to Drive, WSS to relay).
- **Deletion**: yes, via the "Clear local cache" button + user can delete their own Drive folder.

### 3.3 Account deletion link

Play now requires a way for users to request account deletion **without re-installing the app**, even for apps that don't have backend accounts. Practically, link to a page that explains:

- We don't have a backend account
- Local data: clear via the in-app Diagnostics → Clear local cache button
- Drive data: delete the `aorti` folder in their own Drive
- Relay: stops automatically when the user closes the app

## 4. Store listing assets

### 4.1 Required assets

- **App icon**: 512×512 PNG, 32-bit, no alpha background. Reuse our existing `ic_launcher` design at 512×512.
- **Feature graphic**: 1024×500 PNG/JPG. Hero banner shown above screenshots in the Play listing. Needs a real design pass — current branding is just the wordmark.
- **Phone screenshots**: minimum 2, maximum 8. JPG/PNG, between 320-3840px, aspect ratio 16:9 to 9:16. Capture from actual device (Galaxy S8 works) showing:
  - Live monitor with HR + HRV
  - Viewer day timeline
  - Session detail with autonomic events
  - Settings / Connection panel
  - Diagnostics modal (proves the open-source-ish dev posture)
  - Multi-device broadcast view
- **7-inch tablet screenshots**: optional but recommended — use Chrome on a wider browser window if no tablet handy.
- **10-inch tablet screenshots**: optional.

### 4.2 Text content

- **Title**: 30 chars max.
- **Short description**: 80 chars. e.g. "Heart rate and HRV tracking with autonomic event detection. Strap, phone, web."
- **Full description**: 4000 chars. Cover: what it does, who it's for (POTS / autonomic monitoring / training), what straps work (Coospo H808S, Polar H10, Wahoo, generic Bluetooth HR Service), Drive sync, OBS overlay, no ads, no tracking, open-source-style transparency. Avoid medical claims; frame as "informational fitness/training tool".
- **Tags / category**: Health & Fitness > Fitness Training. (Avoid the Medical category — different review process.)

### 4.3 Content rating

Quick questionnaire: no violence, no gambling, no user-generated content, no in-app purchases. Should land at "PEGI 3 / Everyone" instantly.

### 4.4 Target audience

Adults (18+) is the safest declaration since we handle health-adjacent data. Avoids COPPA / families-program scrutiny.

## 5. Release tracks

Stage in increasing-blast-radius order:

### 5.1 Internal testing

- Up to 100 testers, by email allowlist.
- Just the dev + 1-2 friends with HR straps.
- Iterate on the AAB until it installs cleanly via Play, opens, runs a session, and uploads to Drive.

### 5.2 Closed testing

- Up to a few hundred testers, allowlist-by-email or by Google Group.
- 14-day continuous testing with **at least 12 testers** is now required to graduate to Production for new personal-account developers (Google Play 2024 policy).
- Use this to validate Drive OAuth verification + permission UX on a variety of devices.

### 5.3 Open testing

- Anyone with the opt-in link.
- Optional. Skip if Closed Testing is sufficient.

### 5.4 Production

- Submit for review. First review usually 1-7 days. Update reviews are usually faster.
- Watch for Play crashes / ANRs in Console for the first week and patch quickly.

## 6. CI/CD

Existing GitHub Actions builds the APK. Extend:

- Add a `bundleRelease` step that produces the AAB.
- Sign the AAB with the upload keystore (env-var passwords, same as the APK signing).
- Optional: integrate Fastlane `supply` to upload the AAB directly to Play. Faster iteration but requires a service-account JSON in Actions secrets.
- Tag a release in GitHub on every Play submission so it's clear what code is on Play.

Versioning convention: bump `versionCode` automatically in CI from the GitHub run number, set `versionName` from the git tag.

## 7. Risks + mitigations

- **Drive OAuth verification rejection**: most common cause is privacy policy mismatch with the consent screen. Mitigation — write the privacy policy first, copy bullet points verbatim into the verification form's justification text.
- **Play rejection for medical claims**: avoid words like "diagnosis", "monitor for arrhythmia", "detect AFib", etc. Use "HRV trends", "session stats", "autonomic context". Disclaimer in the description AND in-app on first run.
- **Play rejection for foreground service abuse**: provide a clear in-app explanation of why the FGS exists (recording while screen off) and ensure the notification's content reflects that. Already in good shape.
- **Background BLE review**: Play occasionally wants extra justification for BLE in background. Have a 1-paragraph response ready: "BLE remains active during a recording session so HR data continues to flow when the screen is off. The user explicitly starts a session by tapping Start, and the app shows a persistent notification while it's active. BLE is closed when the user stops the session or closes the app."
- **Battery optimisation prompt UX**: the dialog already exists but Play occasionally flags `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` as sensitive. Justification: "needed so Android Doze doesn't kill the BLE connection during long recording sessions". If Play pushes back, the alternative is the Health typed FGS, which exempts the app from Doze without the prompt — already partially in place via `foregroundServiceType="health"`.
- **Reviewer asks for HealthKit-equivalent (Health Connect)**: not a blocker for v1. If they push, point to the privacy policy: "user data stays in the user's own Drive folder; we do not export to platform health stores by default to avoid third-party data sync".

## 8. Concrete checklist (in submission order)

1. Decide app title, developer name, package name (immutable).
2. Bump `compileSdk` and `targetSdkVersion` to 35.
3. Add `bundleRelease` to CI; verify AAB builds + signs.
4. Audit AndroidManifest, mark `BLUETOOTH_SCAN` with `neverForLocation`, declare `foregroundServiceType="health"`.
5. Investigate the API 28 `WebViewRenderProcessClient` crash; either fix or bump `minSdkVersion` to 29.
6. Write privacy policy at aorti.ca/privacy.
7. Set up the Google Cloud Console OAuth consent screen with brand assets, link the privacy policy.
8. Submit OAuth verification (long pole — start now, parallelise with Play).
9. Create Play Console account ($25 one-time).
10. Create the app in Play Console, enrol in Play App Signing, upload the upload-key keystore.
11. Build screenshots + feature graphic.
12. Fill in store listing copy.
13. Fill in Data Safety form.
14. Add account-deletion link.
15. Submit content rating questionnaire.
16. Upload the first AAB to Internal Testing.
17. Test end-to-end via Play install: pair a strap, run a session, confirm Drive upload + relay broadcast.
18. Add 12+ testers to Closed Testing, accumulate the 14-day continuous testing requirement.
19. Wait for OAuth verification to complete.
20. Submit Closed → Production review. Address feedback. Ship.

## 9. Out of scope for v1 launch

These are nice-to-haves that should not block the first submission:

- Health Connect read/write integration.
- Wear OS companion app.
- ANT+ strap support.
- App localisation (English-only at launch).
- Tablet-optimised layouts.
- Subscription / IAP (we said free; keep it free).

Add them in updates after the v1 listing is live.
