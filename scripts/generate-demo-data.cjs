// Generates 10 plausible-looking demo CSV sessions for aorti.ca/viewer?demo=1
// Output: demo/hrv_session_*.csv + demo/manifest.json
// Run: node scripts/generate-demo-data.cjs
//
// Patterns to showcase:
//   - resting (low HR / high HRV)
//   - orthostatic stress (HR rise on standing)
//   - sympathetic flush (HR up + RMSSD down briefly)
//   - chills window (HR volatility burst)
//   - palpitation cluster
//   - long sleep session (low HR, occasional RMSSD spikes)
//   - BLE gap mid-session

const fs = require('fs');
const path = require('path');

const OUT = path.resolve(__dirname, '..', 'demo');
if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });

const HEADER = 'time_min,epoch_ms,hr_bpm,rmssd_ms,palpitation,event,warning,connection,posture';

// Anchor demo data so it's "recent" relative to whoever views it. We use a
// fixed reference date so the demo is reproducible — Vercel re-deploys
// regenerate the same data. Users see "two weeks ago" relative to that anchor.
const ANCHOR_ISO = '2026-04-25T08:00:00Z';

function fmtFilename(epochMs) {
  const d = new Date(epochMs);
  const pad = n => String(n).padStart(2, '0');
  return `hrv_session_${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}-${pad(d.getUTCMinutes())}-${pad(d.getUTCSeconds())}.csv`;
}

// Random helpers (seeded so output is stable).
let SEED = 12345;
function rand() { SEED = (SEED * 1103515245 + 12345) % 2147483648; return SEED / 2147483648; }
function randRange(lo, hi) { return lo + rand() * (hi - lo); }
function noise(amp) { return (rand() - 0.5) * 2 * amp; }

// Build one CSV. Returns { filename, csv }.
//   spec.startEpochMs — when the session starts
//   spec.durationMin  — total minutes
//   spec.baseHr       — typical resting HR
//   spec.baseRmssd    — typical resting RMSSD
//   spec.events[]     — array of { atMin, kind } where kind is one of:
//                       'flush', 'chills', 'palp-cluster', 'standing', 'gap'
function buildSession(spec) {
  const rows = [];
  const STEP_S = 1; // one row per second
  const totalSteps = spec.durationMin * 60;

  // Pre-compute event impulse functions so each tick can blend them.
  const events = (spec.events || []).map(e => ({ ...e, atSec: e.atMin * 60 }));

  // Schedule palps as discrete spikes (palpitation column = 1 for one row).
  const palpTimes = new Set();
  for (const e of events) {
    if (e.kind === 'palp-cluster') {
      // cluster: 5–9 palps over ~2 minutes
      const n = 5 + Math.floor(rand() * 5);
      for (let i = 0; i < n; i++) {
        const t = e.atSec + Math.floor(rand() * 120);
        if (t < totalSteps) palpTimes.add(t);
      }
    } else if (e.kind === 'palp-isolated') {
      const t = e.atSec + Math.floor(rand() * 30);
      if (t < totalSteps) palpTimes.add(t);
    }
  }

  // Schedule connection gaps (no rows for those seconds, then a "disconnected"/"connected" pair).
  const gapWindows = events.filter(e => e.kind === 'gap')
    .map(e => ({ start: e.atSec, end: e.atSec + (e.durSec || 90) }));

  let lastConn = 'connected';
  rows.push({ tSec: 0, hr: null, rmssd: null, palp: 0, event: '', warning: '', connection: 'connected', posture: 'sit' });

  for (let s = 0; s < totalSteps; s++) {
    // Skip disconnected windows.
    const inGap = gapWindows.find(g => s >= g.start && s < g.end);
    if (inGap) {
      if (lastConn === 'connected' && s === inGap.start) {
        rows.push({ tSec: s, hr: null, rmssd: null, palp: 0, event: '', warning: '', connection: 'disconnected', posture: '' });
        lastConn = 'disconnected';
      }
      continue;
    }
    if (lastConn === 'disconnected') {
      rows.push({ tSec: s, hr: null, rmssd: null, palp: 0, event: '', warning: '', connection: 'connected', posture: '' });
      lastConn = 'connected';
    }

    // Compute HR + RMSSD for this second.
    let hr = spec.baseHr + Math.sin(s / 240) * 2 + noise(1.5);
    let rmssd = spec.baseRmssd + Math.sin(s / 600) * 4 + noise(1.5);

    // Apply event blends.
    for (const e of events) {
      const dt = s - e.atSec;
      if (e.kind === 'flush' && dt >= -30 && dt < 240) {
        // 4-min envelope: HR up, RMSSD down
        const env = Math.exp(-Math.pow((dt - 60) / 90, 2));
        hr += 30 * env;
        rmssd -= 12 * env;
      } else if (e.kind === 'chills' && dt >= 0 && dt < (e.durSec || 120)) {
        // Add std volatility, slight HR rise, RMSSD dip
        hr += 15 * Math.sin(dt * 0.6) + noise(8);
        rmssd -= 8;
      } else if (e.kind === 'standing' && dt >= 0 && dt < 600) {
        // POTS-style sustained HR rise on standing
        const env = Math.min(1, dt / 30);
        hr += 28 * env;
        rmssd -= 8 * env;
      } else if (e.kind === 'vagal-burst' && dt >= 0 && dt < (e.durSec || 60)) {
        rmssd += 30 * Math.exp(-Math.pow((dt - (e.durSec || 60) / 2) / 20, 2));
      } else if (e.kind === 'sleep-deepen' && dt >= 0 && dt < 1800) {
        // Gradual HR drop + RMSSD rise during sleep onset
        const t = Math.min(1, dt / 1800);
        hr -= 10 * t;
        rmssd += 12 * t;
      }
    }

    // Drift hr/rmssd into reasonable ranges
    hr = Math.max(45, Math.min(175, hr));
    rmssd = Math.max(8, Math.min(120, rmssd));

    // Down-sample to one row per 4 seconds to keep CSV size moderate.
    if (s % 4 !== 0) continue;

    rows.push({
      tSec: s,
      hr: Math.round(hr),
      rmssd: +rmssd.toFixed(1),
      palp: palpTimes.has(s) ? 1 : 0,
      event: '',
      warning: '',
      connection: '',
      posture: '',
    });
  }

  // Posture markers from `standing` events.
  for (const e of events) {
    if (e.kind === 'standing') {
      const idx = rows.findIndex(r => r.tSec >= e.atSec);
      if (idx >= 0) rows[idx].posture = 'stand';
      const idxBack = rows.findIndex(r => r.tSec >= e.atSec + 600);
      if (idxBack >= 0) rows[idxBack].posture = 'sit';
    }
  }

  // Optional event labels.
  for (const e of events) {
    if (e.kind === 'event-label') {
      const idx = rows.findIndex(r => r.tSec >= e.atSec);
      if (idx >= 0) rows[idx].event = e.label || 'note';
    }
  }

  // Build CSV string.
  const out = [HEADER];
  for (const r of rows) {
    const epoch = spec.startEpochMs + r.tSec * 1000;
    const tMin = (r.tSec / 60).toFixed(4);
    const hr = r.hr == null ? '' : r.hr;
    const rmssd = r.rmssd == null ? '' : r.rmssd;
    out.push(`${tMin},${epoch},${hr},${rmssd},${r.palp},${r.event},${r.warning},${r.connection},${r.posture}`);
  }
  return { filename: fmtFilename(spec.startEpochMs), csv: out.join('\n') };
}

// 10-session demo schedule. Anchor is 2026-04-25; sessions span ~14 days back.
const ANCHOR = Date.parse(ANCHOR_ISO);
const DAY = 86400_000;
const HOUR = 3600_000;

const sessions = [
  // Day -14: morning rest
  { startEpochMs: ANCHOR - 14*DAY + 7*HOUR, durationMin: 35, baseHr: 78, baseRmssd: 38, events: [] },
  // Day -12: evening with one flush
  { startEpochMs: ANCHOR - 12*DAY + 19*HOUR + 30*60_000, durationMin: 50, baseHr: 86, baseRmssd: 28, events: [{ atMin: 18, kind: 'flush' }] },
  // Day -11: morning standing test (POTS)
  { startEpochMs: ANCHOR - 11*DAY + 8*HOUR, durationMin: 30, baseHr: 80, baseRmssd: 32, events: [{ atMin: 5, kind: 'standing' }, { atMin: 22, kind: 'event-label', label: 'felt dizzy' }] },
  // Day -9: long sleep with deepening
  { startEpochMs: ANCHOR - 9*DAY + 23*HOUR + 30*60_000, durationMin: 240, baseHr: 70, baseRmssd: 42, events: [{ atMin: 5, kind: 'sleep-deepen' }, { atMin: 90, kind: 'vagal-burst', durSec: 45 }] },
  // Day -8: morning rest again, smooth
  { startEpochMs: ANCHOR - 8*DAY + 7*HOUR + 15*60_000, durationMin: 25, baseHr: 76, baseRmssd: 40, events: [] },
  // Day -6: post-coffee with palp cluster
  { startEpochMs: ANCHOR - 6*DAY + 10*HOUR, durationMin: 45, baseHr: 92, baseRmssd: 22, events: [{ atMin: 12, kind: 'palp-cluster' }] },
  // Day -5: chills window during a recovery session
  { startEpochMs: ANCHOR - 5*DAY + 14*HOUR, durationMin: 60, baseHr: 84, baseRmssd: 26, events: [{ atMin: 22, kind: 'chills', durSec: 150 }] },
  // Day -3: rest with a brief BLE gap
  { startEpochMs: ANCHOR - 3*DAY + 9*HOUR, durationMin: 40, baseHr: 80, baseRmssd: 34, events: [{ atMin: 18, kind: 'gap', durSec: 75 }] },
  // Day -2: stress flare — multiple shifts + one flush
  { startEpochMs: ANCHOR - 2*DAY + 16*HOUR, durationMin: 70, baseHr: 88, baseRmssd: 24, events: [{ atMin: 10, kind: 'standing' }, { atMin: 35, kind: 'flush' }, { atMin: 50, kind: 'palp-isolated' }] },
  // Day -1: calm evening
  { startEpochMs: ANCHOR - 1*DAY + 21*HOUR, durationMin: 30, baseHr: 74, baseRmssd: 44, events: [] },
];

const filenames = [];
for (const spec of sessions) {
  const built = buildSession(spec);
  fs.writeFileSync(path.join(OUT, built.filename), built.csv, 'utf8');
  filenames.push(built.filename);
  console.log('wrote', built.filename, '(' + built.csv.length + ' bytes)');
}

fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify({
  generatedAt: ANCHOR_ISO,
  files: filenames.sort(),
}, null, 2), 'utf8');
console.log('wrote manifest.json (' + filenames.length + ' sessions)');
