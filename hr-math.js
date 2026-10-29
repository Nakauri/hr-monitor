// Heart-rate maths shared by hr_monitor.html and scripts/rmssd-parity.test.js.
// PARITY CRITICAL: every function here MUST MATCH HrEngine.java (computeRmssd, computeSdnn, hrStage, rmssdStage)
// and GattHrDevice.java (raw RR conversion). Change one, mirror the other, run `node scripts/rmssd-parity.test.js`.
(function (root) {
  'use strict';

  // BLE RR is in 1/1024 s; rounded, not truncated (GattHrDevice.java).
  function rrMsFromRaw(raw) {
    return Math.round(raw * 1000 / 1024);
  }

  // Filters: RR 300..2000 ms drops artefacts; |successive diff| >= 200 ms drops ectopic jumps.
  function computeRMSSD(rrs) {
    if (rrs.length < 2) return null;
    const clean = rrs.filter(rr => rr >= 300 && rr <= 2000);
    if (clean.length < 2) return null;
    let sumSq = 0, count = 0;
    for (let i = 1; i < clean.length; i++) {
      const d = clean[i] - clean[i - 1];
      if (Math.abs(d) < 200) {
        sumSq += d * d;
        count++;
      }
    }
    if (count < 1) return null;
    return Math.sqrt(sumSq / count);
  }

  // Sample stddev (n-1) of in-range RR intervals. No successive-diff filter.
  function computeSDNN(rrs) {
    if (rrs.length < 2) return null;
    const clean = rrs.filter(rr => rr >= 300 && rr <= 2000);
    if (clean.length < 2) return null;
    let sum = 0;
    for (const rr of clean) sum += rr;
    const mean = sum / clean.length;
    let sumSq = 0;
    for (const rr of clean) {
      const d = rr - mean;
      sumSq += d * d;
    }
    return Math.sqrt(sumSq / (clean.length - 1));
  }

  // bands: { low, normal, elevated, high }; high is the audio "High HR" value, so beep and red agree.
  function hrStage(hr, bands) {
    if (hr == null) return 'stage-normal';
    if (hr <= bands.low) return 'stage-low';
    if (hr < bands.normal) return 'stage-normal';
    if (hr < bands.elevated) return 'stage-elevated';
    if (hr < bands.high) return 'stage-high';
    return 'stage-critical';
  }

  // bands: { critical }, the "HRV crash" alert value. 20/35/60 are fixed here and in HrEngine.java.
  function rmssdStage(rmssd, bands) {
    if (rmssd == null) return 'stage-normal';
    if (rmssd < bands.critical) return 'stage-critical';
    if (rmssd < 20) return 'stage-high';
    if (rmssd < 35) return 'stage-elevated';
    if (rmssd < 60) return 'stage-normal';
    return 'stage-low';
  }

  const api = { rrMsFromRaw, computeRMSSD, computeSDNN, hrStage, rmssdStage };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.HRMath = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : null));
