// One-off audit. Reads /demo/manifest.json + each CSV, runs a stub of
// summarizeCSV's resting-HR / hrAvg / startEpoch logic, and reports per
// session. Helps catch data-quality issues before the viewer encounters
// them in the wild.
//
// Usage: node scripts/audit-demo.cjs

const fs = require('fs');
const path = require('path');

const DEMO = path.resolve(__dirname, '..', 'demo');
const manifest = JSON.parse(fs.readFileSync(path.join(DEMO, 'manifest.json'), 'utf8'));

function parseCsv(text) {
  const lines = text.split(/\r?\n/);
  const header = lines[0].split(',');
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i]) continue;
    rows.push(lines[i].split(','));
  }
  return { header, rows };
}

function summarize(filename, text) {
  const { header, rows } = parseCsv(text);
  const idx = {};
  header.forEach((h, i) => idx[h.trim()] = i);

  const hr = [];
  const GAP_MIN = 10 / 60;
  let lastT = null;
  for (const r of rows) {
    const t = parseFloat(r[idx.time_min]);
    if (isNaN(t)) continue;
    if (lastT != null && t - lastT > GAP_MIN) {
      hr.push({ t: t - 0.001, v: null });
    }
    lastT = t;
    const ep = parseFloat(r[idx.epoch_ms]);
    const hStr = r[idx.hr_bpm];
    const h = hStr !== '' ? parseFloat(hStr) : null;
    if (h != null && !isNaN(h)) hr.push({ t, v: h, ep });
  }

  // hrAvg
  const hrVals = hr.map(p => p.v).filter(v => v != null);
  const hrAvg = hrVals.length ? Math.round(hrVals.reduce((a, b) => a + b, 0) / hrVals.length) : 0;

  // restingHR (FIXED — filter nulls)
  const ROLL_MIN = 5;
  let restingHR = null;
  for (let i = 0; i < hr.length; i++) {
    if (hr[i].v == null) continue;
    const w = [];
    for (let j = i; j < hr.length && hr[j].t - hr[i].t <= ROLL_MIN; j++) {
      if (hr[j].v != null) w.push(hr[j].v);
    }
    if (w.length < 10) continue;
    const m = w.reduce((a, b) => a + b, 0) / w.length;
    if (restingHR == null || m < restingHR) restingHR = m;
  }
  if (restingHR != null) restingHR = Math.round(restingHR);

  // restingHR (BUGGY — null-poisoned, what the previous version would compute)
  let restingHRBuggy = null;
  for (let i = 0; i < hr.length; i++) {
    const w = [];
    for (let j = i; j < hr.length && hr[j].t - hr[i].t <= ROLL_MIN; j++) w.push(hr[j].v);
    if (w.length < 10) continue;
    const m = w.reduce((a, b) => a + b, 0) / w.length;
    if (restingHRBuggy == null || m < restingHRBuggy) restingHRBuggy = m;
  }
  if (restingHRBuggy != null) restingHRBuggy = Math.round(restingHRBuggy);

  // startEpoch — first row's epoch_ms (any row, not just hr[0] since gap markers
  // skip storing ep). Mirrors the viewer's deriveFileStartEpoch fallback.
  let startEpoch = null;
  for (const r of rows) {
    const e = parseFloat(r[idx.epoch_ms]);
    if (!isNaN(e)) { startEpoch = e; break; }
  }
  // Filename fallback (UTC parse — same as viewer's deriveFileStartEpoch)
  if (startEpoch == null) {
    const m = filename.match(/(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})/);
    if (m) startEpoch = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
  }

  // Local date key
  let dateKey = null;
  if (startEpoch) {
    const d = new Date(startEpoch);
    dateKey = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }

  // Null gap-marker count (proxies for connection instability)
  const gapMarkers = hr.filter(p => p.v == null).length;
  const realRows = hrVals.length;

  return { filename, dateKey, hrAvg, restingHR, restingHRBuggy, startEpoch, gapMarkers, realRows, totalRows: rows.length };
}

const byDate = {};
for (const fn of manifest.files) {
  const text = fs.readFileSync(path.join(DEMO, fn), 'utf8');
  const s = summarize(fn, text);
  console.log(`${fn}`);
  console.log(`  startEpoch=${s.startEpoch} → date=${s.dateKey}`);
  console.log(`  rows=${s.totalRows} real=${s.realRows} gapMarkers=${s.gapMarkers}`);
  console.log(`  hrAvg=${s.hrAvg}  restingHR(fixed)=${s.restingHR}  restingHR(was)=${s.restingHRBuggy}`);
  if (s.dateKey) byDate[s.dateKey] = (byDate[s.dateKey] || 0) + 1;
}
console.log('\nDate keys (what month view groups by):');
for (const k of Object.keys(byDate).sort()) console.log(`  ${k}: ${byDate[k]} session(s)`);
