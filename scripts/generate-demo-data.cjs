// Builds the sample week in /demo/ from a seeded model. No real recording is read or copied.
// S42 (AUDIT-NOTES 2026-10-11 item 36, 2026-10-12): the old demo files were real recordings.
// Same 12 file names, start times, lengths and 9-column CSV as before, so the viewer checks
// that walk the week (viewer-nav GAP_DROP and friends) still find the days they expect.
//
// Model: one made-up person, awake resting HR about 68 to 78, asleep 55 to 62, breathing
// wobble, beat noise, slow drift, walks, standing rises that settle, meals, an evening
// wind-down and 90-minute sleep cycles. RMSSD moves against HR. Tuned against summary
// statistics of the old files (row spacing about 4.95 s, 4 s HR step spread about 2.8 bpm,
// RMSSD 15 to 60 awake by hour of day), never against their rows.
//
// Deterministic: same SEED, same bytes. Usage: node scripts/generate-demo-data.cjs [--out <dir>]

const fs = require('fs');
const path = require('path');

const SEED = 4220426;
const ROOT = path.resolve(__dirname, '..');
const outArg = process.argv.indexOf('--out');
const OUT = outArg > 0 ? path.resolve(process.argv[outArg + 1]) : path.join(ROOT, 'demo');
const HEADER = 'time_min,epoch_ms,hr_bpm,rmssd_ms,palpitation,event,warning,connection,posture';
// Mountain Daylight Time for every day of the sample week (no clock change in late April).
const LOCAL_OFFSET_MS = -6 * 3600000;

// ---- Seeded random -----------------------------------------------------------------------
function hashStr(s) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619) >>> 0;
  return h;
}
function rng(seed) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  let spare = null;
  next.gauss = () => {
    if (spare != null) { const s = spare; spare = null; return s; }
    let u = 0; while (u === 0) u = next();
    const v = next();
    const r = Math.sqrt(-2 * Math.log(u));
    spare = r * Math.sin(2 * Math.PI * v);
    return r * Math.cos(2 * Math.PI * v);
  };
  return next;
}

// ---- The week ----------------------------------------------------------------------------
// Times are local hours from the midnight of the file's start day (25.5 = 01:30 next day).
// start: epoch ms of the session start; mins: session length; dt: row spacing in ms.
// sleep [onset, wake]; lie: lying down before sleep; walks [from, to, peak HR];
// stands [at, minutes]; meals [at]; marks [at, event cell]; palps [at]; warns [at, type];
// gaps [at, minutes] (link dropped, no rows); arousals [at] (a short wake in the night).
const WEEK = [
  { name: 'hrv_session_2026-04-20T10-55-58.csv', start: 1776682555729, mins: 267.175, dt: 4950, web: true,
    sleep: [[0, 6.55]], wakeLie: 6.85, arousals: [5.6],
    stands: [[6.87, 18], [7.95, 4]], meals: [7.4], walks: [[8.08, 8.5, 104]], gaps: [[8.29, 0.85], [8.62, 1]],
    marks: [[6.95, 'ctx:water'], [7.4, 'Breakfast'], [7.5, 'ctx:meds'], [8.08, 'Walk to work']] },
  { name: 'hrv_session_2026-04-21T12-36-30.csv', start: 1776796590921, mins: 82.34, dt: 4950,
    meals: [12.75], walks: [[13.3, 13.55, 98]], stands: [[13.25, 3]],
    marks: [[12.75, 'Lunch'], [13.68, 'ctx:water']] },
  { name: 'hrv_session_2026-04-21T21-17-24.csv', start: 1776827844613, mins: 544.6537, dt: 4950,
    lie: [22.8, 23.2], sleep: [[23.2, 30.1]], wakeLie: 30.25, arousals: [26.4, 28.9],
    stands: [[21.7, 5], [30.27, 12]], gaps: [[25.12, 6], [27.49, 3.5], [29.71, 1.8]],
    marks: [[22.15, 'ctx:meds'], [30.3, 'ctx:water']] },
  { name: 'hrv_session_2026-04-22T12-57-27.csv', start: 1776884247804, mins: 305.305, dt: 4950,
    stands: [[13.9, 4], [14.8, 6], [17.1, 5]], walks: [[15.5, 15.92, 109]], meals: [16.9],
    gaps: [[16.2, 1.3], [17.79, 5]], palps: [14.2],
    marks: [[13.2, 'ctx:water'], [15.95, 'ctx:water'], [16.7, 'sym:fatigue'], [16.9, 'Snack']] },
  { name: 'hrv_session_2026-04-22T18-19-37.csv', start: 1776903577874, mins: 179.6714, dt: 4950,
    stands: [[18.33, 22]], meals: [18.75], walks: [[19.5, 19.85, 97]], gaps: [[20.92, 5.5]],
    marks: [[18.75, 'Dinner'], [20.5, 'ctx:salt'], [21.05, 'ctx:water']] },
  { name: 'hrv_session_2026-04-23T09-06-04.csv', start: 1776956764500, mins: 238.533, dt: 4950,
    stands: [[9.9, 4], [11.33, 6]], walks: [[12.15, 12.6, 112]], meals: [9.25],
    marks: [[9.25, 'Coffee'], [10.5, 'ctx:water'], [11.36, 'sym:dizzy'], [12.62, 'ctx:water']] },
  // The showcase night: sleep, a clear morning rise, a quiet desk morning and a lunch walk (04-24).
  { name: 'hrv_session_2026-04-23T22-16-32.csv', start: 1777004192835, mins: 937.8216, dt: 4950,
    lie: [22.7, 23.0], sleep: [[23.0, 31.05]], wakeLie: 31.2, arousals: [26.2, 29.6],
    stands: [[31.22, 25], [33.6, 4], [34.9, 5]], meals: [31.75, 36.25], walks: [[36.7, 37.05, 101]],
    gaps: [[27.35, 3]],
    marks: [[22.45, 'ctx:meds'], [31.3, 'ctx:water'], [31.75, 'Breakfast'], [31.85, 'ctx:meds'],
      [34.95, 'sym:dizzy'], [36.25, 'Lunch']] },
  { name: 'hrv_session_2026-04-24T13-57-32.csv', start: 1777060652693, mins: 442.564, dt: 4950,
    // Runs 3 s past the 21:20 file's start so 04-24 reads as one day from waking to sleep.
    stands: [[14.6, 4], [17.85, 30], [19.6, 6], [20.75, 4]], walks: [[15.2, 15.75, 114]], meals: [18.2],
    marks: [[15.2, 'Afternoon walk'], [15.8, 'ctx:water'], [16.9, 'ctx:salt'], [18.2, 'Dinner'], [20.4, 'ctx:water']] },
  { name: 'hrv_session_2026-04-24T21-20-03.csv', start: 1777087203533, mins: 287.9064, dt: 4950,
    lie: [23.05, 23.35], sleep: [[23.35, 27]], arousals: [25.4],
    stands: [[22.4, 4]], gaps: [[25.78, 0.75]],
    marks: [[22.0, 'ctx:meds'], [22.45, 'ctx:water']] },
  { name: 'hrv_session_2026-04-25T13-20-24.csv', start: 1777144824237, mins: 680.6716, dt: 4950,
    walks: [[13.95, 14.65, 106], [16.45, 16.58, 131]], stands: [[16.0, 6], [18.3, 25], [21.8, 4]],
    meals: [18.6], gaps: [[19.15, 4], [22.27, 5.2], [23.17, 1], [24.06, 1.4]], palps: [16.6, 16.62, 16.65], warns: [[16.53, 'warn-high']],
    lie: [23.75, 24.2], sleep: [[24.2, 30]],
    marks: [[13.95, 'Errands'], [14.75, 'ctx:water'], [16.62, 'sym:palpitations'], [18.6, 'Dinner'],
      [21.0, 'ctx:salt'], [22.6, 'ctx:meds']] },
  { name: 'hrv_session_2026-04-26T11-10-35.csv', start: 1777223435603, mins: 218.1955, dt: 4013,
    meals: [11.5], walks: [[12.5, 13.15, 103]], stands: [[11.3, 5], [14.2, 4]], gaps: [[13.59, 0.8]],
    marks: [[11.5, 'Brunch'], [12.5, 'Park walk'], [13.2, 'ctx:water']] },
  { name: 'hrv_session_2026-04-26T14-59-55.csv', start: 1777237195344, mins: 164.7605, dt: 4950,
    stands: [[15.6, 4], [16.7, 6]], meals: [16.2],
    marks: [[15.1, 'ctx:water'], [16.2, 'Snack'], [17.3, 'ctx:water']] },
];

// ---- One session -------------------------------------------------------------------------
function localMidnightMs(startMs) {
  const d = new Date(startMs + LOCAL_OFFSET_MS);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - LOCAL_OFFSET_MS;
}
const within = (list, h) => (list || []).find(([a, b]) => h >= a && h < b);

function buildSession(spec) {
  const r = rng(SEED ^ hashStr(spec.name));
  const mid = localMidnightMs(spec.start);
  const H = (ep) => (ep - mid) / 3600000;
  const endMs = spec.start + spec.mins * 60000;
  const conn = spec.web ? ['connect', 'disconnect'] : ['connected', 'disconnected'];

  // Per-session character: a person is a little different each day.
  const restBias = r.gauss() * 1.5;
  const sleepBase = 58.5 + r.gauss() * 1.1;
  const rmssdBias = 1 + r.gauss() * 0.08;
  const stands = (spec.stands || []).map(([at, m]) => ({ at, end: at + m / 60, amp: 11 + r() * 12 }));
  const walks = (spec.walks || []).map(([a, b, peak]) => ({ a, b, peak }));

  function mode(h) {
    if (within(spec.sleep, h)) return 'sleep';
    if (walks.find((w) => h >= w.a && h < w.b)) return 'walk';
    if (stands.find((s) => h >= s.at && h < s.end)) return 'stand';
    if (within(spec.lie ? [spec.lie] : null, h)) return 'lying';
    if (spec.wakeLie && spec.sleep && spec.sleep.some(([, w]) => h >= w && h < spec.wakeLie)) return 'lying';
    return 'sit';
  }
  // Awake sitting baseline by time of day: a little higher in the morning, winding down at night.
  function awakeBase(h) {
    const hd = ((h % 24) + 24) % 24;
    let b = 73 + restBias;
    if (hd >= 6 && hd < 11) b += 3 * Math.exp(-(hd - 7) * (hd - 7) / 4);
    if (hd >= 20) b -= Math.min(6, (hd - 20) * 1.8);
    if (hd < 5) b -= 5;
    return b;
  }
  function awakeRmssd(h) {
    const hd = ((h % 24) + 24) % 24;
    return (hd < 11 ? 36 : hd < 18 ? 31 : 28) * rmssdBias;
  }
  function sleepTarget(h, onset, wake) {
    const x = h - onset;
    const settle = Math.exp(-x / 0.45);
    const phase = (x / 1.5) * 2 * Math.PI;
    const deep = Math.max(0, -Math.sin(phase)) * Math.exp(-x / 3.5);
    const rem = Math.max(0, Math.sin(phase - 0.6)) * Math.min(1, x / 3);
    const dawn = Math.max(0, 1 - (wake - h) / 1.2);
    const hr = sleepBase + settle * (awakeBase(onset) - 4 - sleepBase) - 3 * deep + 3.5 * rem + 3 * dawn;
    const rm = (60 + 18 * deep - 12 * rem - 10 * settle) * rmssdBias;
    return { hr, rm, rem };
  }

  const rows = [];
  const push = (ep, cells) => rows.push({ ep, cells });
  // Discrete rows: marks, posture taps, palpitations, warnings, link changes.
  const at = (h) => Math.round(mid + h * 3600000 + r() * 900);
  for (const [h, label] of spec.marks || []) push(at(h), { event: label });
  for (const h of spec.palps || []) push(at(h), { palp: '1' });
  for (const [h, type] of spec.warns || []) push(at(h), { warning: type });
  const gapList = (spec.gaps || []).map(([h, m]) => [mid + h * 3600000, mid + h * 3600000 + m * 60000]);
  for (const [a, b] of gapList) { push(Math.round(a), { conn: conn[1] }); push(Math.round(b), { conn: conn[0] }); }
  const firstEp = spec.start + 700 + Math.round(r() * 1300);
  push(firstEp, { conn: conn[0] });

  let ep = firstEp + 2600 + Math.round(r() * 1200);
  let hr = null, rmSm = null, drift = 0, rdrift = 0, breathPhase = r() * 6.28, breathRate = 0.25;
  let lastPosture = null, nHr = 0, recovery = 0, mealLoad = 0, arousal = 0;
  while (ep <= endMs) {
    const h = H(ep);
    const dts = spec.dt / 1000;
    const m = mode(h);
    const asleep = m === 'sleep';
    // Posture taps at real changes; short stand-ups go untapped.
    const posture = asleep || m === 'lying' ? 'lying' : (m === 'walk' || (m === 'stand' && stands.find((s) => h >= s.at && h < s.end).end - stands.find((s) => h >= s.at && h < s.end).at > 0.15)) ? 'standing' : m === 'stand' ? lastPosture : 'sitting';
    // The first tap lands after the strap is streaming, never before the first HR row.
    if (posture && posture !== lastPosture && nHr >= 6) { push(ep - 400 - Math.round(r() * 500), { posture }); lastPosture = posture; }

    // Slow drift (Ornstein-Uhlenbeck, about 15 min memory).
    const k = dts / 900;
    drift += -drift * k + Math.sqrt(2 * k) * (asleep ? 1.4 : 2.4) * r.gauss();
    rdrift += -rdrift * k + Math.sqrt(2 * k) * 0.12 * r.gauss();
    for (const a of spec.arousals || []) if (Math.abs(h - a) * 3600 < dts / 2) arousal = 13 + r() * 6;
    arousal *= Math.exp(-dts / 70);
    for (const mt of spec.meals || []) if (Math.abs(h - mt) * 3600 < dts / 2) mealLoad += 6;
    mealLoad *= Math.exp(-dts / 2700);

    let target, rmBase, restRef;
    if (asleep) {
      const [on, wk] = within(spec.sleep, h);
      const s = sleepTarget(h, on, wk);
      target = s.hr + arousal; rmBase = s.rm; restRef = s.hr;
    } else {
      const base = awakeBase(h);
      restRef = base; rmBase = awakeRmssd(h);
      target = base + mealLoad * 0.8;
      if (m === 'lying') target -= 5;
      const st = stands.find((s) => h >= s.at && h < s.end);
      if (st) {
        const x = (h - st.at) * 3600;
        target += 8 + st.amp * (1 - Math.exp(-x / 14)) * Math.exp(-x / 75);
      }
      const w = walks.find((w) => h >= w.a && h < w.b);
      if (w) {
        const x = (h - w.a) * 3600;
        target = w.peak + 4 * Math.sin(x / 420 * 2 * Math.PI) + 2 * Math.sin(x / 97);
        recovery = Math.max(recovery, (w.peak - base) * 0.28);
      } else {
        recovery *= Math.exp(-dts / 480);
        target += recovery;
      }
    }
    target += drift;
    if (hr == null) hr = target;
    const tau = target > hr ? (m === 'walk' ? 40 : 16) : (asleep ? 60 : 45);
    hr += (target - hr) * (1 - Math.exp(-dts / tau));

    // Breathing (rate wanders around 0.25 Hz) and beat noise on top of the smooth rate.
    breathRate = Math.min(0.32, Math.max(0.17, breathRate + r.gauss() * 0.004 + (0.25 - breathRate) * 0.01));
    breathPhase += 2 * Math.PI * breathRate * dts;
    const rsa = (asleep ? 3.8 : m === 'walk' ? 1.2 : 2.2) * Math.sin(breathPhase);
    const shown = Math.round(Math.min(178, Math.max(42, hr + rsa + r.gauss() * (asleep ? 0.7 : 1.0))));

    const inst = rmBase * Math.exp(-(hr - restRef) / 26) * Math.exp(rdrift + r.gauss() * 0.16);
    rmSm = rmSm == null ? inst : rmSm + (inst - rmSm) * (1 - Math.exp(-dts / 25));
    const rm = Math.min(140, Math.max(4, rmSm));

    if (!gapList.some(([a, b]) => ep >= a && ep < b)) { push(ep, { hr: shown, rm: rm.toFixed(2) }); nHr++; }
    ep += spec.dt + Math.round(r.gauss() * 30);
  }

  rows.sort((a, b) => a.ep - b.ep);
  const lines = [HEADER];
  for (const { ep: e, cells: c } of rows) {
    const tm = ((e - spec.start) / 60000).toFixed(4);
    lines.push([tm, e, c.hr ?? '', c.rm ?? '', c.palp ?? '', c.event ?? '', c.warning ?? '', c.conn ?? '', c.posture ?? ''].join(','));
  }
  return lines.join('\n');
}

function main() {
  fs.mkdirSync(OUT, { recursive: true });
  for (const f of fs.readdirSync(OUT)) {
    if (f.endsWith('.csv') || f === 'manifest.json') fs.unlinkSync(path.join(OUT, f));
  }
  const names = [];
  for (const spec of WEEK) {
    const csv = buildSession(spec);
    fs.writeFileSync(path.join(OUT, spec.name), csv, 'utf8');
    names.push(spec.name);
    console.log('wrote', spec.name, '(' + (csv.split('\n').length - 1) + ' rows)');
  }
  fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify({
    generatedAt: '2026-10-12T00:00:00.000Z',
    synthetic: true,
    seed: SEED,
    files: names.sort(),
  }, null, 2), 'utf8');
  console.log('wrote manifest.json (' + names.length + ' sessions)');
}

if (require.main === module) main();
module.exports = { buildSession, WEEK, SEED, HEADER };
