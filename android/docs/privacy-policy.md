# HR Monitor privacy policy

Last updated: 2026-04-19

HR Monitor is a free Android app that reads your heart rate from a Bluetooth chest strap and, optionally, streams it to your own OBS overlay or saves it to your own Google Drive. This policy explains what data the app handles and where that data goes.

## What the app collects

- **Heart rate and RR intervals.** Read from the chest strap over Bluetooth Low Energy while a session is active. Used to display live heart rate, heart rate variability (RMSSD), and breathing rate.
- **Session recordings.** A CSV file per session, stored on your device. Contains heart rate, RR intervals, timestamps, and any events you mark during the session.
- **Device metadata for crash reports.** If the app crashes or freezes, a crash report containing the Android version, device model, and a stack trace is sent to Sentry. No heart rate data and no personal identifiers are included in crash reports.
- **Google account email (optional).** If you sign in to Google Drive, the app stores your email so it can label your account in the UI. It does not read your contacts, your other Drive files, or your Google profile.

## What the app does not collect

- No advertising identifiers.
- No location.
- No contacts, calendar, photos, SMS, or call log.
- No microphone or camera.
- No analytics beyond anonymous crash reports.

## Where your data goes

- **Heart rate, stays on your phone by default.** Live display and CSV files are local to your device.
- **Optional live relay.** If you enable "broadcast", the app sends live heart rate values to a relay server (hr-relay.nakauri.partykit.dev) keyed by a random broadcast key. The relay does not store any of these values; it forwards them to anyone you share the key with, then forgets. Encrypted in transit with TLS.
- **Optional Drive backup.** If you sign in to Google Drive, session CSVs are uploaded to your own Drive's hidden app-data folder. Only HR Monitor can read them. Revoke access at any time from your Google Account's connected-apps page.
- **Crash reports.** Sent to Sentry, a third-party crash reporting service. Used only to fix bugs. Retained for 90 days.

## Your choices

- Broadcasting and Drive sync are both off until you turn them on.
- You can delete any session CSV from your device at any time. Deleting a CSV from the app also removes the Drive copy if sync is enabled.
- You can revoke Drive access at any time. Revoking does not delete CSVs already uploaded; use the app's delete action for that.
- You can opt out of crash reporting in Settings, Diagnostics.

## Children

HR Monitor is not directed to children under 13 and does not knowingly collect any data from children under 13.

## Changes to this policy

Material changes to this policy will be announced in the app's release notes and on the app's public GitHub repository before they take effect.

## Contact

Open an issue at github.com/Nakauri/hr-monitor or email the maintainer through the email listed on that repository.
