# Play Store listing — draft

Draft content for the Google Play Console listing. Confirm field-by-field before submission.

---

## App details

- **App name**: HR Monitor
- **Default language**: English (United States) — Canadian English copy used in-app; the Play Console language list doesn't include en-CA as a default, and en-US is the closest match.
- **App or game**: App
- **Free or paid**: Free
- **Category**: Health and Fitness
- **Tags**: Heart rate, fitness tracking, wellness

## Short description (80 chars max)

> Live heart rate and HRV from your Bluetooth chest strap.

## Full description

> HR Monitor streams heart rate and heart rate variability from your Bluetooth Low Energy chest strap. It shows live numbers, a rolling trace, and colour-coded zones, and it can broadcast the same widget to an OBS overlay on your desktop for streaming.
>
> What you get:
> - Pair any Bluetooth Low Energy chest strap that advertises the standard heart rate service (0x180D). Tested on the Coospo H808S; works with Polar, Garmin, Wahoo straps on the same standard.
> - Live heart rate, live RMSSD heart rate variability, and breathing rate.
> - Session recording. Every session is saved as a CSV you own and can export.
> - Optional live overlay. Stream the compact widget to OBS from any desktop browser by opening an overlay URL paired to your phone.
> - Optional Google Drive backup. Your session CSVs sync to your own Drive's app folder. No other Drive files are touched.
>
> Privacy:
> - Broadcasting and Drive sync are off until you turn them on.
> - Heart rate data stays on your phone by default.
> - No advertising, no analytics beyond anonymous crash reports, no data sold.
>
> Free, open source, and built by one person. Code and issue tracker at github.com/Nakauri/hr-monitor.

## Screenshots

Required. Minimum 2, recommended 8. Capture from the native app:
1. Pair screen with a strap visible.
2. Live screen with heart rate and trace.
3. Diagnostics screen with the "Keep alive on your phone" flow.
4. Overlay preview showing the widget on a mock stream.

## Feature graphic

1024 x 500 PNG. Heart icon on a dark background, "HR Monitor" wordmark.

## Content rating

- Content rating questionnaire answers: No violence. No sexual content. No controlled substances. No gambling. No user-generated content. No location sharing.
- Expected rating: **Everyone**.

## Data safety form

### Data collected

| Data type | Collected | Shared | Purpose | Optional | Encrypted in transit |
|-----------|-----------|--------|---------|----------|----------------------|
| Health (heart rate) | Yes | No | App functionality | No | Yes |
| Health (fitness info — HRV, breathing) | Yes | No | App functionality | No | Yes |
| Personal info (email address) | Yes | No | Account management (Drive sign-in) | Yes | Yes |
| App info (crash logs) | Yes | Yes (Sentry) | Analytics / bug fixing | Yes | Yes |
| Device or other IDs | No | | | | |
| Location | No | | | | |
| Contacts | No | | | | |
| Photos or videos | No | | | | |
| Audio files | No | | | | |
| Files and docs (Drive app folder only) | Yes | No | App functionality | Yes | Yes |

- **Data is encrypted in transit**: Yes.
- **Users can request data deletion**: Yes, in-app delete action, plus revoke Drive access.

### Justifications

- Heart rate and HRV are the core functionality.
- Email is used only to label the signed-in account in the UI.
- Files and docs scope is limited to Drive's app-data scope. HR Monitor cannot read any other files on your Drive.
- Crash logs are anonymous. No heart rate data is sent in crash reports.

## Permissions declaration

- **BLUETOOTH_SCAN** with `android:usesPermissionFlags="neverForLocation"`. Core to pairing the strap. Not used for geolocation.
- **BLUETOOTH_CONNECT**. Core to subscribing to heart rate notifications.
- **FOREGROUND_SERVICE** and three subtypes:
  - `connectedDevice`: Continuous heart rate from a paired BLE chest strap during an active session.
  - `health`: Fitness and autonomic session tracking while the phone is locked or backgrounded.
  - `dataSync`: Session CSV upload to the user's Google Drive when the session ends.
- **POST_NOTIFICATIONS**. Shows the session notification with current heart rate and a Stop button.
- **WAKE_LOCK**. Keeps the CPU awake under Doze so the strap stream does not drop when the screen is off.
- **REQUEST_IGNORE_BATTERY_OPTIMIZATIONS**. One-tap prompt on first run so Android does not kill the background session. User can decline.
- **RECEIVE_BOOT_COMPLETED**. Optional. User opts in to restart the session service after reboot from the in-app diagnostics screen.

## Closed testing

- Track: Closed testing.
- Minimum testers: 20 (Google's required floor for new developer accounts).
- Test duration: 14 calendar days minimum.
- Access: link-based invitation, no Google Group required.

## Production rollout plan

1. 10% staged rollout for 72 hours. Crashlytics/Sentry watched for a crash-free session rate above 99%.
2. 50% for 24 hours.
3. 100%.

## Open items before submission

- Privacy policy hosted at a stable URL. Candidate: `hr-monitor-topaz.vercel.app/privacy` rendering `android/docs/privacy-policy.md`.
- 8 real screenshots from the native build (once Phase 1 UI is in place).
- Feature graphic PNG.
- App icon PNG (adaptive icon already defined; export a 512x512 PNG from the foreground layer).
- Developer account created on Google Play Console ($25 one-time).
- Closed testing tester group assembled.
