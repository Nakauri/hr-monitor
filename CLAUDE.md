# HR Monitor

Single-file HTML app for real-time heart rate and HRV monitoring via Web Bluetooth. Used as a streaming overlay in OBS.

## What it does

Connects to a Coospo H808S chest strap, displays HR + HRV (RMSSD) with color-coded zones, breathing detection via respiratory sinus arrhythmia, audio alerts for threshold crossings, and a Claude API integration for session analysis.

## User context

User has POTS (postural orthostatic tachycardia syndrome). Resting HR runs 85-95 bpm sitting. Monitoring for autonomic patterns, HR spikes, and HRV crashes during streams.

## Tech

- `hr_monitor.html` — single file, no build step, opens in Chrome/Edge
- Chart.js 4.4.0 from CDN
- Web Bluetooth API (BLE heart rate service 0x180D)
- Web Audio API for alert sounds
- localStorage for settings persistence

## Layout

- **Left column (380px)** — overlay zone cropped in OBS Window Capture
- **Right column** — control panel (settings, stats, events, Claude integration)

## Overlay styles

Four switchable styles: Bold (default), Compact, Minimal, Neon. Compact collapses HR + HRV + dual-line trend into one card. Style-specific CSS rules exist for `.widget`, `.trend-widget`, and `.breath-widget`.

## Don'ts

- Don't touch BLE parsing offsets in `parseHR()` — correct for H808S
- Don't remove the `state.startTime == null` guard in `onHRNotification`
- Don't change `acceptAllDevices: true` in `requestDevice`
- Don't shorten the 10-second audio alert cooldown
- Don't add emoji to the UI

## Key architecture

- `state` object holds all session data (HR/RMSSD series, RR buffers, warnings, breath phase)
- `colorThresholds` object drives `getHRStage()` — persisted to localStorage
- `thresholds` object drives audio alert triggers — read live from inputs
- Breathing detection uses a 30-second `breathBuffer` separate from the 1-second `rrBuffer`
- Pips are stage-based (1-5 mapped to stage class), not range-based
- Settings panel uses tabs (Style / Thresholds / Audio) with `data-tab`/`data-tabpanel` attributes
