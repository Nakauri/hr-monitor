# Cross-Surface Contract

Anywhere the same logical value is computed or transmitted by more than one implementation in this codebase, it lives in this document. Each row names the locations, the authoritative spec, and how parity is enforced (if at all).

**Rule of thumb:** if a user can see the same number on two surfaces and they disagree, it goes in this table. Changing any row requires updating every listed location AND the parity test (if one exists).

---

## Live numeric values

| Value | JS location | Native location | Authority | Enforcement |
|-------|-------------|-----------------|-----------|-------------|
| RMSSD | `hr_monitor.html:computeRMSSD` (~L1857) | `NativeHrSessionPlugin.java:computeRmssd` | Filter RR∈[300, 2000] ms; drop successive diffs ≥200 ms; `sqrt(mean(diff²))` | `scripts/rmssd-parity.test.js` — golden vector |
| RMSSD window size | `hr_monitor.html:~L2634` (`cutoff = now - 1` min) | `NativeHrSessionPlugin.java:RR_WINDOW_MS` | **60 seconds** | No test — single constant on each side, parity-critical comment tags both |
| HR stage classification | `hr_monitor.html:getHRStage` (~L2294) | `NativeHrSessionPlugin.java:hrStage` + `setStageThresholds` | User-configurable thresholds pushed from JS via `HRMNativeHrSession.setStageThresholds({low,normal,elevated,high})` on init + every save | Single-source (JS pushes). Missing a test — TODO |
| RMSSD stage classification | `hr_monitor.html:getRMSSDStage` (~L2319) | `NativeHrSessionPlugin.java:rmssdStage` | `<critical = stage-critical`, `<20 = stage-high`, `<35 = stage-elevated`, `<60 = stage-normal`, else `stage-low`. `critical` is user-configurable, pushed from JS via `setStageThresholds({rmssdCritical})`. Other cutoffs hard-coded in both | `scripts/rmssd-parity.test.js` — table of input rmssd + expected stage |

## Data output (CSV)

| Column | JS writer | Native writer | Authority | Enforcement |
|--------|-----------|---------------|-----------|-------------|
| CSV header order | `hr_monitor.html:writeAutoSave` | `NativeCsvWriter.java:appendHrRow` | `time_min,epoch_ms,hr_bpm,rmssd_ms,palpitation,event,warning,connection,posture` | Viewer's `summarizeCSV` parses by column name, not position — normalizes across sources. Gap: no parity test |
| `connection` value | `hr_monitor.html` writes `connect` / `disconnect` | native writes `connected` / `disconnected` | Viewer normalizes both to `connect` / `disconnect` at parse time (`hrv_viewer.html:~L3575`) | Normalization is itself load-bearing; if removed, viewer gap-rendering breaks on native CSVs |

## Relay tick wire format

| Field | JS sender | Native sender | Authority | Enforcement |
|-------|-----------|---------------|-----------|-------------|
| All fields | `hr_monitor.html:broadcastTick` | `NativeHrSessionPlugin.java:publishTick` | `docs/RELAY_TICK.md` | Doc only. Gap: no schema test that validates both senders' output against a JSON Schema |
| `prefs` mirror | JS emits `prefs` object | Native omits `prefs` | Viewers must treat absent `prefs` as "use local defaults" — consuming code in `overlay.html:handleTick` respects this | Missing test — TODO |

## Settings / preferences

| Pref | Source of truth | Mirrored to native? | Enforcement |
|------|-----------------|---------------------|-------------|
| `widgetPrefs` (visibility toggles) | `hr_monitor.html` localStorage | Yes — via `setPrefs({prefs})` | Pushed from JS; single-source |
| `colorThresholds` (HR stage) | `hr_monitor.html` localStorage | Yes — via `setStageThresholds` | Pushed from JS; missing test — TODO |
| `thresholds.rmssd` (HRV crash alert floor) | `hr_monitor.html` localStorage | Yes — via `setStageThresholds.rmssdCritical` | Pushed from JS; covered by stage parity test |
| `thresholds.high` / `.low` (audio alert) | `hr_monitor.html` only | No | Audio alerts are JS-only, no drift surface |
| `liveTraceStyle` (per-beat vs smoothed live trace) | `hr_monitor.html` localStorage | Yes — embedded in `prefs` of every relay tick | Single-source: rendering logic in `widget.js:setLiveTraceStyle` called by both monitor and overlay. Data (per-beat BPM) unchanged across modes — the style flip is purely Chart.js config |

## Viewer post-hoc detectors (single-implementation)

These live only in `hrv_viewer.html:summarizeCSV` and consume CSV data after the session has ended. No native mirror exists, so no drift risk — but listing them here because any future decision to pre-compute them on native would introduce parity risk.

- `detectFlushes` — sympathetic surge detection (rewrite 2026-04-23 grounded in POTS diagnostic criteria; see `docs/autonomic_events_research.md`)
- `detectChillsWindows` — chills (sympathetic + vagal paths, same research doc)
- `detectPalpitations` — ectopic beat clusters
- `detectNoteworthyMoments` — statistical outliers
- `detectSleepWindows` — known silently-broken (reads `.v`/`.t`; gets `{x,y}` on day sessions). Not parity-relevant; listed for the TODO fix

---

## Enforcement checklist for future changes

Before shipping a change to anything in the tables above:

1. **Find the row**. Touch every location it lists.
2. **Run the parity test** if one exists: `node scripts/rmssd-parity.test.js`. Must exit 0.
3. **Update the parity test's golden vector / expected output** if the algorithm legitimately changed.
4. **If adding a new cross-implementation value**, add a row here first. If it can be parity-tested, add the test before shipping the implementations.
5. **If consolidating into a single-source pattern** (e.g., JS pushes to native), note the direction + the API method in the Authority column.

## Parity test coverage status (2026-04-23)

| Row | Has test | Notes |
|-----|----------|-------|
| RMSSD numeric | ✅ | `scripts/rmssd-parity.test.js` |
| RMSSD window size | ⚠️ | No test; single constant each side |
| HR stage | ⚠️ | Pushed from JS; no test |
| RMSSD stage | ✅ | Table in `rmssd-parity.test.js` |
| Relay tick schema | ❌ | Doc only |
| CSV writer header | ❌ | Doc in RELAY_TICK.md |
| CSV `connection` values | ❌ | Normalization in viewer |
| `widgetPrefs` schema | ❌ | Pushed from JS; no schema test |

## Why this is harder than it looks

- Three surfaces (JS web monitor, native Android plugin, viewer) evolve at different cadences.
- No build step or type system that would catch drift automatically.
- Some values are user-configurable (pushed one way); others are hard-coded (must match literally in both places).
- The "correct" value often depends on device context (phone sensor noise vs chest strap quality) but the user sees unified numbers and gets confused by disagreements.

The parity tests + this contract doc are the closest we'll get to a type system for now.
