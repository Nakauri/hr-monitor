#!/usr/bin/env node
// Guards: real recordings shipping as the public sample week (AUDIT-NOTES 2026-10-11 item 36, Khal 2026-10-12). Files: scripts/generate-demo-data.cjs, demo/. Runtime: about 3 s.
// 1. The generator is deterministic: two runs into temp folders give the same bytes, and they match demo/.
// 2. No demo file carries a real row: none of the old real files' first 20 data rows (git 1710c80)
//    appears anywhere in the new file, and no new line equals any old line.
// 3. Every file parses with the 9-column header, epoch_ms rises, time_min never negative (a mark
//    before the start shifted every mark of 04-24 by 6 h in the first draft), HR sits in 40 to 180.
// Run: node scripts/demo-synthetic.test.cjs (exit 0 = OK).

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const DEMO = path.join(ROOT, 'demo');
const GEN = path.join(__dirname, 'generate-demo-data.cjs');
const REAL_REF = '1710c80';

let failures = 0;
function check(name, ok, detail) {
  console.log((ok ? 'OK    ' : 'FAIL  ') + name + (detail ? '  ' + detail : ''));
  if (!ok) failures++;
}

const manifest = JSON.parse(fs.readFileSync(path.join(DEMO, 'manifest.json'), 'utf8'));
const names = manifest.files;
check('manifest lists 12 files', names.length === 12, String(names.length));

// 1. Determinism.
const runs = [1, 2].map((i) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hrm-demo-' + i + '-'));
  execFileSync(process.execPath, [GEN, '--out', dir], { stdio: 'ignore' });
  return dir;
});
for (const f of [...names, 'manifest.json']) {
  const a = fs.readFileSync(path.join(runs[0], f));
  const b = fs.readFileSync(path.join(runs[1], f));
  // A Windows checkout may hold demo/ with CRLF (core.autocrlf); git stores LF.
  const c = Buffer.from(fs.readFileSync(path.join(DEMO, f), 'utf8').replace(/
/g, '
'), 'utf8');
  check('same bytes on two runs and in demo/: ' + f, a.equals(b) && a.equals(c));
}
for (const d of runs) fs.rmSync(d, { recursive: true, force: true });

// 2. Fingerprint against the real files the old demo shipped.
for (const f of names) {
  let old;
  try {
    old = execFileSync('git', ['-C', ROOT, 'show', REAL_REF + ':demo/' + f], { encoding: 'utf8', maxBuffer: 64 << 20 });
  } catch (e) {
    check('old real file readable at ' + REAL_REF + ': ' + f, false, e.message.split('\n')[0]);
    continue;
  }
  const oldLines = old.split(/\r?\n/).slice(1).filter(Boolean);
  const newLines = fs.readFileSync(path.join(DEMO, f), 'utf8').split(/\r?\n/).slice(1).filter(Boolean);
  const newSet = new Set(newLines);
  const first20 = oldLines.slice(0, 20);
  const hit20 = first20.filter((l) => newSet.has(l));
  check('no real first-20 row in ' + f, hit20.length === 0, hit20[0] || '');
  const oldSet = new Set(oldLines);
  const shared = newLines.filter((l) => oldSet.has(l));
  check('no line shared with the real file ' + f, shared.length === 0, shared.length ? shared.length + ' shared, first ' + shared[0] : '');
  const head = (ls) => ls.slice(0, 20).map((l) => l.split(',').slice(2).join(',')).join('|');
  check('first 20 rows differ in values ' + f, head(newLines) !== head(oldLines));
}

// 3. Shape and range.
for (const f of names) {
  const lines = fs.readFileSync(path.join(DEMO, f), 'utf8').split(/\r?\n/);
  const header = lines[0];
  check('header ' + f, header === 'time_min,epoch_ms,hr_bpm,rmssd_ms,palpitation,event,warning,connection,posture', header);
  let bad = 0, hrN = 0, lo = Infinity, hi = -Infinity, prev = -Infinity, back = 0;
  for (const l of lines.slice(1)) {
    if (!l) continue;
    const c = l.split(',');
    if (c.length !== 9 || !Number.isFinite(Number(c[0])) || !Number.isFinite(Number(c[1]))) { bad++; continue; }
    if (Number(c[1]) < prev || Number(c[0]) < 0) back++;
    prev = Number(c[1]);
    if (c[2] !== '') { const hr = Number(c[2]); hrN++; lo = Math.min(lo, hr); hi = Math.max(hi, hr); }
  }
  check('parses, rises, HR 40 to 180: ' + f, bad === 0 && back === 0 && hrN > 500 && lo >= 40 && hi <= 180,
    'bad ' + bad + ' back ' + back + ' hr rows ' + hrN + ' range ' + lo + ' to ' + hi);
}

console.log(failures ? failures + ' FAILED' : 'all OK');
process.exit(failures ? 1 : 0);
