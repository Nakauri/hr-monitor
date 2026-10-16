// PARITY CRITICAL: HrSourcePolicy.java is the twin. Checks: scripts/hr-source-parity.test.cjs, scripts/jvm/run-hr-source-test.cjs.
// Shown HR: the strap's value unless the beats clearly disagree. The RR array is never changed; the shown value is what gets recorded.
(function (root) {
  const C = Object.freeze({
    ENTER_BPM: 12, ENTER_HOLD_MS: 5000, START_WINDOW_MS: 60000, START_HOLD_MS: 2000, EXIT_BPM: 5, EXIT_HOLD_MS: 10000,
    STALE_MS: 5000, RUN_GAP_MS: 10000, WINDOW_MS: 5000, WINDOW_MAX_BEATS: 64, MIN_KEPT: 4, REF_BEATS: 20,
    REF_LO_MS: 270, REF_HI_MS: 2000, REF_TOL: 0.08, REF_MIN_SHARE: 0.3, REF_MIN_COUNT: 3, REF_MIN_CLUSTER: 2,
    RAW_LO_MS: 250, RAW_HI_MS: 3000, RANGE_LO_MS: 300, RANGE_HI_MS: 2000, MULT_RATIO: 1.7, MULT_MIN: 2, MULT_MAX: 4,
    MULT_TOL: 0.15, SHORT_RATIO: 0.7, LONG_RATIO: 1.43, STEP_BACK_MAX_MS: 5000,
    START_CLEAN_SHARE: 0.75, STEADY_PLAIN_SHARE: 0.8, HALF_TOL: 0.1,
  });
  function median(a) {
    const s = a.slice().sort((x, y) => x - y), n = s.length;
    return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
  }
  function modeRef(h) {
    const v = h.filter((x) => x >= C.REF_LO_MS && x <= C.REF_HI_MS);
    if (v.length < C.REF_MIN_COUNT) return null;
    let best = 0, bestN = 0, bestSum = 0;
    for (const c of v) {
      let n = 0, s = 0;
      for (const x of v) if (Math.abs(x - c) <= C.REF_TOL * c) { n++; s += x; }
      if (n > bestN || (n === bestN && c < best)) { best = c; bestN = n; bestSum = s; }
    }
    if (bestN < Math.max(C.REF_MIN_CLUSTER, C.REF_MIN_SHARE * v.length)) return median(v);
    return bestSum / bestN;
  }
  function repair(rr, ref) {
    if (rr < C.RAW_LO_MS || rr > C.RAW_HI_MS) return [];
    if (ref == null) return rr >= C.RANGE_LO_MS && rr <= C.RANGE_HI_MS ? [rr] : [];
    const ratio = rr / ref;
    if (ratio > C.MULT_RATIO) {
      const k = Math.round(ratio);
      if (k >= C.MULT_MIN && k <= C.MULT_MAX && Math.abs(rr / k - ref) / ref <= C.MULT_TOL) return Array(k).fill(rr / k);
    }
    if (rr > C.RANGE_HI_MS) return [];
    if (ratio < C.SHORT_RATIO || ratio > C.LONG_RATIO) return [];
    return [rr];
  }
  function create() {
    let pending = true, lastTs = null, runStart = 0, hist = [], win = [], beat = false;
    let over = null, under = null, lastGood = null, lastGoodTs = null;
    function startRun(ts) {
      pending = false; runStart = ts; hist = []; win = []; beat = false;
      over = null; under = null; lastGood = null; lastGoodTs = null;
    }
    return {
      reset() { pending = true; lastTs = null; },
      linkLive() { pending = true; },
      onPacket(strapHr, rrs, tsIn) {
        let ts = tsIn;
        const newRun = pending || lastTs == null || ts - lastTs > C.RUN_GAP_MS || ts < lastTs - C.RUN_GAP_MS;
        if (newRun) startRun(ts);
        else if (ts < lastTs) ts = lastTs;
        lastTs = ts;
        const n = rrs ? rrs.length : 0, times = new Array(n);
        let t = ts;
        for (let j = n - 1; j >= 0; j--) { times[j] = t; if (rrs[j] > 0 && rrs[j] < C.STEP_BACK_MAX_MS) t -= rrs[j]; }
        for (let j = 0; j < n; j++) {
          const out = times[j] < runStart ? [] : repair(rrs[j], modeRef(hist));
          win.push({ t: times[j], out });
          hist.push(rrs[j]);
          if (hist.length > C.REF_BEATS) hist.shift();
        }
        while (win.length && win[0].t <= ts - C.WINDOW_MS) win.shift();
        while (win.length > C.WINDOW_MAX_BEATS) win.shift();
        let kept = 0, plain = 0; const vals = [];
        for (const w of win) if (w.out.length) { kept++; if (w.out.length === 1) plain++; for (const x of w.out) vals.push(x); }
        const inStart = ts - runStart <= C.START_WINDOW_MS;
        const share = win.length ? (inStart ? kept : plain) / win.length : 0;
        const est = kept >= C.MIN_KEPT && share >= (inStart ? C.START_CLEAN_SHARE : C.STEADY_PLAIN_SHARE) ? 60000 / median(vals) : null;
        const half = est != null && strapHr > 0 && Math.abs(2 * est - strapHr) <= C.HALF_TOL * strapHr;
        if (est != null) { lastGood = est; lastGoodTs = ts; }
        let switched = 0;
        if (!beat) {
          if (est != null && !half && Math.abs(strapHr - est) > C.ENTER_BPM) {
            if (over == null) over = ts;
            const hold = inStart ? C.START_HOLD_MS : C.ENTER_HOLD_MS;
            if (ts - over >= hold) { beat = true; under = null; switched = 1; }
          } else over = null;
        } else if (half) {
          beat = false; over = null; switched = -1;
        } else if (est == null) {
          if (ts - lastGoodTs > C.STALE_MS) { beat = false; over = null; switched = -1; }
        } else if (Math.abs(strapHr - est) <= C.EXIT_BPM) {
          if (under == null) under = ts;
          if (ts - under >= C.EXIT_HOLD_MS) { beat = false; over = null; switched = -1; }
        } else under = null;
        return { shown: beat ? Math.round(est != null ? est : lastGood) : strapHr, beat, switched, est, newRun };
      },
    };
  }
  root.HrSource = { C, create, modeRef, repair, median };
})(typeof window !== 'undefined' ? window : globalThis);
