# Relay tick wire format

This is the JSON shape sent over the PartyKit relay (`wss://hr-relay.nakauri.partykit.dev/parties/main/<broadcastKey>`). It is the single contract between **senders** and **viewers**. Both senders must produce the same fields. All viewers read from one handler.

Keep this file **in sync with the code** when any tick field is added, removed, or renamed.

## Senders (produce ticks)

1. **`hr_monitor.html` → `broadcastTick()`** (around line ~2875). Runs in Chrome, Edge, Capacitor WebView when the JS-side BLE path owns the strap.
2. **`NativeHrSessionPlugin.publishTick()`** in `mobile/android-overlay/app/src/main/java/com/nakauri/hrmonitor/NativeHrSessionPlugin.java`. Runs natively on Android when the native plugin owns the strap.

Either sender writes to the relay; consumers don't care which. Both must emit the same field set.

## Viewers (consume ticks)

1. **`overlay.html` → `handleTick()`** (around line ~340). OBS browser source, chroma-key overlay.
2. **`hr_monitor.html` watch-mode** for the iframe preview and the broadcasters panel.
3. **Future**: any read-only embed or dashboard.

## Tick shape

```
{
  type: "tick",                     // required; discriminator
  senderId: string,                 // required; unique per sender
  senderLabel: string,              // required; human-readable
  senderBooted: number,             // required; ms epoch, used to dedupe
  t: number,                        // required; minutes since session start

  hr: number,                       // required; integer BPM
  hrStage: string,                  // required; "stage-low" | "stage-normal" | ...
  rmssd: number | null,             // optional; ms
  rmssdStage: string | null,        // optional; same palette as hrStage
  palpPerMin: number,               // required; 0 if unknown
  contactOff: boolean,              // required
  warn: string | null,              // required; "warn-high" | "warn-crash" | null
  conn: string,                     // required; "live" | "reconnecting" | "idle"

  // Chart arrays. Overlay renders these directly. If omitted,
  // overlay.html will render numbers but charts stay blank. Both
  // senders MUST include these for full-fidelity viewers.
  livePoints: Array<{x: number, y: number}>,   // 45 s window, x=seconds
  liveWindow: [number, number],                // [startSec, endSec]
  trendHR: Array<{x: number, y: number}>,      // 3 min window, x=minutes
  trendRmssd: Array<{x: number, y: number}>,   // 3 min window, smoothed
  trendWindow: [number, number],               // [startMin, endMin]

  // Optional. Widget prefs mirror so the OBS overlay reflects live toggles.
  // Produced only by hr_monitor.html broadcastTick. The native Android
  // plugin currently does NOT emit this — it has no awareness of the
  // WebView's widget toggle state. Viewers must treat an absent prefs
  // field as "use local defaults" and not replace current settings.
  prefs?: {
    showHr: boolean,
    showHrv: boolean,
    showLiveHr: boolean,
    showInlineTrends: boolean,
    showPalpChip: boolean,
    showWarning: boolean,
    warningAbove: boolean,
    broadcast: boolean,
    // 'reactive' (default) plots per-beat with straight segments so RSA
    // oscillation is visible. 'smooth' applies monotone-cubic interpolation
    // through the same per-beat points. Overlay calls
    // HRWidget.setLiveTraceStyle(chart, value) so monitor + OBS render
    // identically. Ignore unknown values.
    liveTraceStyle?: "reactive" | "smooth",
  }
}
```

## Known per-sender gaps

- **Native Android sender** always emits `palpPerMin: 0`, `warn: null`, `conn: "live"`, and no `prefs`. These are set by `hr_monitor.html` on the web path from real state. Viewers must render degraded (no warning banner, no palp chip, no pref-driven toggles) when those fields are missing or fixed.

## Checklist when touching the tick payload

1. Update **both** senders at the same time:
   - `hr_monitor.html` `broadcastTick()`
   - `NativeHrSessionPlugin.publishTick()` (Java)
2. Update **every** viewer that reads the new field:
   - `overlay.html` `handleTick()`
   - Any watch-mode code in `hr_monitor.html`
3. Update this file. Treat it as the source of truth.
4. If adding a field that some senders can't produce (e.g. native can't compute X yet), say so here and have viewers treat it as optional with a fallback.

## Common drift bugs

- **Missing chart arrays from the native sender**: overlay renders BPM / HRV numbers fine but the trend chart stays empty. Symptom: numbers update, line chart is flat.
- **Sender field added to JS only**: OBS overlay works for web-originated broadcasts, blank for Android-originated ones.
- **Prefs shape changes**: overlay toggles misbehave because keys don't match.

The fix in every case is: update all three places (both senders, all viewers) in the same change.
