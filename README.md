# HR Monitor

Live heart rate + HRV tracking via Web Bluetooth chest strap, with POTS-aware session review.

Two static HTML files, no build step. Opens directly in a modern Chromium browser (Chrome / Edge / Comet).

## Files

- `index.html` – landing page with links to the two apps.
- `hr_monitor.html` – live monitor. Pairs with a BLE chest strap (standard Heart Rate Service 0x180D), shows real-time HR and RMSSD, fires audio alerts on threshold crossings, auto-saves sessions to a user-picked folder.
- `hrv_viewer.html` – session browser. Reads CSVs from the same folder. Month / week / day / session / all-time views. Autonomic interpretation, palpitation detection, posture bands, sleep window overlay, printable report export.

## Stack

- Single-file HTML per app, no bundler. Chart.js 4.4 + chartjs-plugin-annotation loaded from CDN.
- Web Bluetooth API (Chromium-only) for the strap.
- File System Access API for local save/read. Also supports Google Drive (via OAuth) when deployed to a hosted origin.
- LocalStorage for user preferences + per-session tags/overrides.
- No backend. All data is client-side in the user's browser / device.

## Privacy

No telemetry. No accounts. No remote storage unless the user explicitly signs in with Google to enable Drive backup. Health data never leaves the user's device unless they opt into cloud sync.

## Hardware

Tested with Coospo H808S and Polar H10. Any chest strap exposing the standard BLE Heart Rate Measurement characteristic with RR intervals should work.

## Development snapshot

`_local_snapshot_2026-04-18/` holds a known-good local copy of the files at the point of transition to hosted deployment. Keep as a reference / rollback.
