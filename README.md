# aorti.ca

> **Beta.** Solo-developed, actively changing, bugs expected. Please open an Issue if something breaks. Feature requests and strap test reports welcome.

Live heart rate and HRV for streams and self. Pair a chest strap, watch it in real time, stream it to OBS, or come back later and read weeks of your own data. Free, no subscription, no account required.

Hosted at [aorti.ca](https://aorti.ca). Android APK for 24/7 background recording available from the GitHub releases.

## What you get

- **Live monitor** (`hr_monitor.html`). Real-time HR and RMSSD, a live trace, audio alerts, posture logging, OBS-ready widget. Auto-saves every session as a CSV.
- **Session viewer** (`hrv_viewer.html`). Month, week, day, and single-session views over every recording. Autonomic interpretation, palpitation clusters, sympathetic flushes, posture and sleep windows. Multiple sessions on the same day stitch into a single day timeline.
- **OBS overlay** (`overlay.html`). Browser-source companion to the monitor. Chroma-key ready. Uses a broadcast key so one phone or laptop can publish and any OBS instance can subscribe.
- **Android APK**. Native BLE plus a foreground service, so recording survives the screen going off, the phone locking, and the app being backgrounded. Drive sync in the background. Release-signed.

## Requirements

- A Bluetooth HR chest strap that advertises the standard Heart Rate Service (0x180D) with RR intervals. Confirmed on the Coospo H808S. Polar H10, Wahoo TICKR, and Garmin HRM-Dual should work on the same spec but have not been individually tested. Apple Watch, Garmin Fenix, and Fitbit do not expose the BLE HR service and are not supported.
- A Chromium browser for the desktop experience. Chrome, Edge, and Brave all work. Safari and Firefox do not implement Web Bluetooth.
- Android 9 or newer for the APK.

## Data and privacy

- No accounts needed. Anonymous mode keeps everything on the device.
- Google sign-in is optional. When on, session CSVs sync to your Drive and the viewer reads them across devices.
- Broadcasting to OBS is opt-in. When on, live ticks pass through a PartyKit relay to subscribers holding the broadcast key. The relay does not persist messages.
- Turn off broadcast and sign out of Google, and nothing leaves the device.
- Not a medical device. Interpretations are estimates. Talk to a clinician if numbers concern you.

## Running it locally

Open `index.html` in any Chromium browser. No build step, no install. The three HTML files (`hr_monitor.html`, `hrv_viewer.html`, `overlay.html`) are self-contained.

The relay is a small PartyKit project under `relay/`. The mobile Capacitor wrapper under `mobile/` builds the APK.
