#!/usr/bin/env node
// Parity test — catches drift between the JS `computeRMSSD` in
// hr_monitor.html and the Java `computeRmssd` in NativeHrSessionPlugin.java.
//
// Why this exists: these two functions compute RMSSD from RR intervals
// for the same user's data. The JS version powers the live widget; the
// Java version powers the relay broadcast and the CSV writer. If they
// diverge, the same strap shows different HRV numbers on phone vs
// overlay vs viewer. This happened once (April 2026) — the Java side
// was unfiltered, the JS side was ectopic-corrected. Readings differed
// by 2-3x during palpitation bursts. Fixed by aligning both on the same
// preprocessing.
//
// When either implementation changes:
//   1. Mirror the change in the OTHER file.
//   2. Update the port in this file to match.
//   3. Run `node scripts/rmssd-parity.test.js` — must print OK, exit 0.
//
// The golden vector at the end is deliberately adversarial: it includes
// out-of-range RRs, ectopic-sized jumps, and normal beats so any filter
// change produces a different number.

// -------- JS implementation (extracted verbatim from hr_monitor.html) ----
function computeRMSSD_js(rrs) {
  if (rrs.length < 2) return null;
  const clean = rrs.filter(rr => rr >= 300 && rr <= 2000);
  if (clean.length < 2) return null;
  let sumSq = 0, count = 0;
  for (let i = 1; i < clean.length; i++) {
    const d = clean[i] - clean[i-1];
    if (Math.abs(d) < 200) {
      sumSq += d * d;
      count++;
    }
  }
  if (count < 1) return null;
  return Math.sqrt(sumSq / count);
}

// -------- Java-equivalent implementation (JS port of NativeHrSessionPlugin.java) ----
// When the Java source changes, port the same changes here.
function computeRMSSD_javaPort(rrs) {
  if (rrs.length < 2) return null;
  const clean = [];
  for (const rr of rrs) {
    if (rr >= 300 && rr <= 2000) clean.push(rr);
  }
  if (clean.length < 2) return null;
  let sumSq = 0, count = 0;
  for (let i = 1; i < clean.length; i++) {
    const d = clean[i] - clean[i - 1];
    if (Math.abs(d) < 200) {
      sumSq += d * d;
      count += 1;
    }
  }
  if (count < 1) return null;
  return Math.sqrt(sumSq / count);
}

// -------- Golden vector + expected output ----
// This sequence covers: normal RR, RSA-sized variation (±20 ms), ectopic
// short RR (big negative jump), compensatory pause (big positive jump),
// out-of-range noise (must be filtered), and return to baseline.
const goldenRR = [
  800, 810, 790, 820, 805,             // normal RSA-like
  400,                                  // ectopic short
  1200,                                 // compensatory pause
  810, 795, 805,                        // return to normal
  2500,                                 // out-of-range high (must drop)
  200,                                  // out-of-range low (must drop)
  820, 815, 800, 810, 790, 805,         // more normal
];

// Expected RMSSD on this input (JS algorithm):
//   After filter: [800, 810, 790, 820, 805, 400, 1200, 810, 795, 805, 820, 815, 800, 810, 790, 805]
//   Successive diffs: [10, -20, 30, -15, -405, 800, -390, -15, 10, 15, -5, -15, 10, -20, 15]
//   Diffs with |d| < 200: [10, -20, 30, -15, -15, 10, 15, -5, -15, 10, -20, 15]  (12 values, dropped 3)
//   sumSq = 100+400+900+225+225+100+225+25+225+100+400+225 = 3150
//   RMSSD = sqrt(3150/12) = sqrt(262.5) = 16.2018...
const EXPECTED_RMSSD = 16.2018517460;
const TOLERANCE = 1e-6;

// -------- Run ----
const jsOut = computeRMSSD_js(goldenRR);
const javaOut = computeRMSSD_javaPort(goldenRR);

let ok = true;

function check(label, actual, expected) {
  const diff = Math.abs(actual - expected);
  const pass = diff < TOLERANCE;
  console.log(
    `${pass ? 'OK   ' : 'FAIL '} ${label.padEnd(32)} ` +
    `got=${actual.toFixed(10)} expected=${expected.toFixed(10)} diff=${diff.toExponential(3)}`
  );
  if (!pass) ok = false;
}

check('JS implementation', jsOut, EXPECTED_RMSSD);
check('Java port (hand-ported)', javaOut, EXPECTED_RMSSD);
check('JS vs Java parity', jsOut, javaOut);

// -------- RMSSD stage classification parity ----
// JS: hr_monitor.html:getRMSSDStage
// Java: NativeHrSessionPlugin.java:rmssdStage
// If these diverge, same RMSSD shows different colours on monitor vs relay
// overlay — which happened at RMSSD=36 (JS normal/green, Java elevated/orange).
function rmssdStage_js(rmssd, thresholdCritical) {
  if (rmssd == null) return 'stage-normal';
  if (rmssd < thresholdCritical) return 'stage-critical';
  if (rmssd < 20) return 'stage-high';
  if (rmssd < 35) return 'stage-elevated';
  if (rmssd < 60) return 'stage-normal';
  return 'stage-low';
}
function rmssdStage_javaPort(rmssd, thresholdCritical) {
  if (rmssd < thresholdCritical) return 'stage-critical';
  if (rmssd < 20) return 'stage-high';
  if (rmssd < 35) return 'stage-elevated';
  if (rmssd < 60) return 'stage-normal';
  return 'stage-low';
}

function checkStage(label, rmssd, critical, expected) {
  const js = rmssdStage_js(rmssd, critical);
  const java = rmssdStage_javaPort(rmssd, critical);
  const pass = js === expected && java === expected && js === java;
  console.log(
    `${pass ? 'OK   ' : 'FAIL '} ${label.padEnd(32)} ` +
    `rmssd=${rmssd} critical=${critical} js=${js} java=${java} expected=${expected}`
  );
  if (!pass) ok = false;
}

console.log('\nRMSSD stage classification parity:');
checkStage('crash at user threshold', 10, 15, 'stage-critical');
checkStage('just above critical',     16, 15, 'stage-high');
checkStage('high range',              22, 15, 'stage-elevated');
checkStage('elevated range',          36, 15, 'stage-normal');   // the reported mismatch
checkStage('normal range',            55, 15, 'stage-normal');
checkStage('excellent range',         80, 15, 'stage-low');

// -------- HR stage classification parity ----
// JS: hr_monitor.html:getHRStage
// Java: NativeHrSessionPlugin.java:hrStage
// Both use user-configurable thresholds pushed from JS via setStageThresholds.
// Boundaries must match exactly (the `<=` on low is load-bearing).
function hrStage_js(hr, t) {
  if (hr == null) return 'stage-normal';
  if (hr <= t.low) return 'stage-low';
  if (hr < t.normal) return 'stage-normal';
  if (hr < t.elevated) return 'stage-elevated';
  if (hr < t.high) return 'stage-high';
  return 'stage-critical';
}
function hrStage_javaPort(hr, t) {
  if (hr <= t.low) return 'stage-low';
  if (hr < t.normal) return 'stage-normal';
  if (hr < t.elevated) return 'stage-elevated';
  if (hr < t.high) return 'stage-high';
  return 'stage-critical';
}

function checkHRStage(label, hr, t, expected) {
  const js = hrStage_js(hr, t);
  const java = hrStage_javaPort(hr, t);
  const pass = js === expected && java === expected && js === java;
  console.log(
    `${pass ? 'OK   ' : 'FAIL '} ${label.padEnd(32)} ` +
    `hr=${hr} t=${JSON.stringify(t)} js=${js} java=${java} expected=${expected}`
  );
  if (!pass) ok = false;
}

console.log('\nHR stage classification parity:');
const T = { low: 70, normal: 90, elevated: 110, high: 130 };  // default user thresholds
checkHRStage('below low boundary',    50, T, 'stage-low');
checkHRStage('at low boundary',       70, T, 'stage-low');        // inclusive
checkHRStage('just above low',        71, T, 'stage-normal');
checkHRStage('at normal boundary',    89, T, 'stage-normal');
checkHRStage('elevated range',        93, T, 'stage-elevated');   // user reported 93 green/orange mismatch
checkHRStage('high range',           115, T, 'stage-high');
checkHRStage('at high boundary',     129, T, 'stage-high');
checkHRStage('critical',             130, T, 'stage-critical');   // strict: = high hits critical

if (!ok) {
  console.error('\nFAIL: RMSSD parity broken.');
  console.error('  - If JS is right: update NativeHrSessionPlugin.java:computeRmssd + the port above.');
  console.error('  - If Java is right: update hr_monitor.html:computeRMSSD + the port above.');
  console.error('  - If expected value changed intentionally: recompute EXPECTED_RMSSD and document why.');
  process.exit(1);
}

console.log('\nOK: JS and Java-port RMSSD match on the golden vector.');
