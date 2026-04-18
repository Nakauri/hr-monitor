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

No accounts. No telemetry. Saved session CSVs stay on the user's device (File System Access). The app is free and open.

**When the OBS broadcast feature is used**, live HR readings transit through a Cloudflare-hosted PartyKit relay so that an OBS Browser Source — which runs in a separate browser from the monitor — can receive them. The relay does not persist data; messages exist only long enough to fan out. Access is gated by a random per-user broadcast key stored in the user's browser (anyone with the key can subscribe to that user's stream, so the key should be treated as a secret).

If the broadcast feature isn't used, no data leaves the user's device at all.

## Hardware

Tested with Coospo H808S and Polar H10. Any chest strap exposing the standard BLE Heart Rate Measurement characteristic with RR intervals should work.

## Development snapshot

`_local_snapshot_2026-04-18/` holds a known-good local copy of the files at the point of transition to hosted deployment. Keep as a reference / rollback.
