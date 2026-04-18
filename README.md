# HR Monitor

A simple browser app for live heart rate and HRV monitoring from a Bluetooth chest strap. Includes a session viewer for reviewing past recordings, with POTS-aware context.

Built because commercial HR overlays are either subscription-based or miss autonomic patterns that matter to POTS streamers.

## Requirements

- A Bluetooth chest strap that exposes the standard Heart Rate Service (0x180D) with RR intervals.
- A Chromium browser (Chrome, Edge, Comet). Web Bluetooth does not work in Safari or Firefox.

Tested with the Coospo H808S. Other straps that implement the standard spec should work but have not been verified.

## What it does

**Live monitor** (`hr_monitor.html`)
- Pairs with the strap and shows real-time BPM, HRV (RMSSD), and a live HR trace.
- Audio alerts when thresholds are crossed.
- Auto-saves the session as a CSV to a folder you pick.
- Optional Google Drive backup.
- OBS overlay support via a Browser Source URL, with toggles to hide widgets you don't want on stream.

**Session viewer** (`hrv_viewer.html`)
- Reads the CSVs from the same folder.
- Month, week, day, and single-session views.
- Daily, weekly, and monthly summary reports.
- Palpitation detection, autonomic interpretation, HR shift flags.

## Data and privacy

- No accounts, no sign-up, no analytics.
- Session CSVs stay in the folder you picked. Nothing is uploaded by default.
- Google Drive backup is opt-in. If signed in, sessions are copied to a Drive folder you choose.
- OBS broadcast is opt-in. When enabled, live readings pass through a PartyKit relay so an OBS Browser Source in a different process can receive them. The relay does not store messages; it only forwards them to subscribers holding the broadcast key. Anyone with the key can subscribe, so treat it like a password.
- Turn off broadcast and Drive, and no data leaves the browser.

## Running it

The hosted version is at [hr-monitor-topaz.vercel.app](https://hr-monitor-topaz.vercel.app).

To run locally, open `index.html` in Chrome or Edge. No build step, no install.

## Disclaimer

This is not a medical device. It is a visual tool for self-monitoring. Do not use it to diagnose or treat anything. If numbers concern you, talk to a clinician.
