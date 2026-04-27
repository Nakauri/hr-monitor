// Curates real session CSVs from local "CSV Dates" folder into /demo/.
// Source files are real recordings; this script downsamples each one to
// ~every 4 seconds and copies it to /demo/ with original filename.
// Runs offline; the source folder is gitignored so this only works on the
// dev machine. Output (/demo/*.csv + manifest.json) IS committed.
//
// Usage: node scripts/generate-demo-data.cjs

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'CSV Dates', 'HR Monitor Sessions-20260427T010308Z-3-001', 'HR Monitor Sessions');
const OUT = path.join(ROOT, 'demo');

// Curated picks: variety of times-of-day, durations, patterns. Picked by
// hand from session listings — file size correlates with duration.
const PICKS = [
  'hrv_session_2026-04-20T10-55-58.csv',          // morning
  'hrv_session_2026-04-21T12-36-30.csv',          // midday
  'hrv_session_2026-04-21T21-17-24.csv',          // evening + into sleep
  'hrv_session_2026-04-22T12-57-27.csv',          // long afternoon
  'hrv_session_2026-04-22T18-19-37.csv',          // late afternoon
  'hrv_session_2026-04-23T09-06-04.csv',          // long morning
  'hrv_session_2026-04-23T22-16-32.csv',          // overnight sleep (long)
  'hrv_session_2026-04-24T13-57-32.csv',          // afternoon
  'hrv_session_2026-04-24T21-20-03.536.csv',      // evening
  'hrv_session_2026-04-25T13-20-24.235.csv',      // long afternoon
  'hrv_session_2026-04-26T11-10-35.604.csv',      // morning
  'hrv_session_2026-04-26T14-59-55.346.csv',      // afternoon
];

const DOWNSAMPLE_EVERY_N_SECONDS = 4;

if (!fs.existsSync(SRC)) {
  console.error('Source folder not found:', SRC);
  console.error('This script only runs on the dev machine. Demo data is committed; no need to regenerate unless updating it.');
  process.exit(1);
}

// Wipe any existing /demo/*.csv first.
if (fs.existsSync(OUT)) {
  for (const f of fs.readdirSync(OUT)) {
    if (f.endsWith('.csv') || f === 'manifest.json') {
      fs.unlinkSync(path.join(OUT, f));
    }
  }
} else {
  fs.mkdirSync(OUT, { recursive: true });
}

const filenames = [];

for (const pick of PICKS) {
  const srcPath = path.join(SRC, pick);
  if (!fs.existsSync(srcPath)) {
    console.warn('skipped (missing):', pick);
    continue;
  }

  const text = fs.readFileSync(srcPath, 'utf8');
  const lines = text.split(/\r?\n/);
  const header = lines[0];
  const out = [header];

  let lastKeptEpoch = 0;
  const stepMs = DOWNSAMPLE_EVERY_N_SECONDS * 1000;

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    const cols = line.split(',');
    // cols: time_min, epoch_ms, hr_bpm, rmssd_ms, palpitation, event, warning, connection, posture
    const epoch = Number(cols[1]);
    const palp = cols[4];
    const event = cols[5];
    const warning = cols[6];
    const conn = cols[7];
    const posture = cols[8];

    // Always keep rows with a connection state, palpitation, event, warning, or posture
    // marker — these are sparse and meaningful.
    const isMeaningful = (palp && palp !== '0') || (event && event !== '') || (warning && warning !== '') || (conn && conn !== '') || (posture && posture !== '');

    if (isMeaningful) {
      out.push(line);
      lastKeptEpoch = epoch;
      continue;
    }

    if (!Number.isFinite(epoch)) continue;
    if (epoch - lastKeptEpoch >= stepMs) {
      out.push(line);
      lastKeptEpoch = epoch;
    }
  }

  // Drop the .NNN millisecond suffix from filename if present so the demo
  // filenames look uniform.
  const cleanName = pick.replace(/\.\d{3}\.csv$/, '.csv');
  fs.writeFileSync(path.join(OUT, cleanName), out.join('\n'), 'utf8');
  filenames.push(cleanName);
  console.log('wrote', cleanName, '(', out.length - 1, 'rows from', lines.length - 1, ')');
}

fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify({
  generatedAt: new Date().toISOString(),
  files: filenames.sort(),
}, null, 2), 'utf8');
console.log('wrote manifest.json (' + filenames.length + ' sessions)');
