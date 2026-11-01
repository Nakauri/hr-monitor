// Viewer parsing and the per-session summary: hrv_viewer.html loads it as a script and runs it as its parse Worker.
// Checks: scripts/viewer-parse.test.cjs (6554b5b parity, Worker vs main), day-boundary, day-gaps, row-epoch.
(function (root) {
  'use strict';

  // HR shift settings when the page passes none; the page's getHrShiftSettings falls back to the same.
  const HR_SHIFT_DEFAULT = { threshold: 30, windowMin: 10 };

  function parseSessionFilename(fn) {
    // Virtual day-timeline key: 'day:YYYY-MM-DD', starting at the day start (dayWindow).
    const dayMatch = fn && fn.match(/^day:(\d{4}-\d{2}-\d{2})$/);
    if (dayMatch) {
      const date = new Date(dayWindow(dayMatch[1]).start);
      return {
        date, isoDate: dayMatch[1], isoTime: String(DAY_START_HOUR).padStart(2, '0') + ':00:00',
        filename: fn, kind: 'day',
        tooltip: `Stitched timeline for ${dayMatch[1]}`,
      };
    }
    // hrv_session_2026-04-17T14-32-00.csv is a web write in UTC.
    // hrv_session_2026-04-17T14-32-00.123.csv is a native write in device local time.
    // Native files from 2026-04-21 to 04-24 have no .123 suffix and still parse as UTC.
    const m = fn.match(/^hrv_session_(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})(\.\d{3})?\.csv$/);
    if (m) {
      const isLocal = !!m[5];
      const date = new Date(`${m[1]}T${m[2]}:${m[3]}:${m[4]}${isLocal ? m[5] : 'Z'}`);
      // Recompute isoDate + isoTime in the user's LOCAL timezone so session cards
      // group under the date the user actually experienced, not UTC date.
      const pad = n => String(n).padStart(2, '0');
      const localDate = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
      const localTime = `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
      // Tooltip-ready diagnostic — so a user who sees what looks like a 1-hour
      // offset can check whether the file was literally recorded at that time
      // or whether something went wrong with TZ/DST.
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'local';
      const tooltip = `Recorded: ${date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'medium' })} (${tz})\nFilename (${isLocal ? 'local time' : 'UTC'}): ${m[1]} ${m[2]}:${m[3]}:${m[4]}`;
      return { date, isoDate: localDate, isoTime: localTime, filename: fn, kind: 'session', tooltip };
    }
    // hrm_20261009T07Z_ab12cd.csv: a v2 segment, named by its UTC hour and install id.
    // v2:ab12cd:1791091200500: a v2 session, keyed by install id and sessionId (its start epoch).
    const seg = fn.match(/^hrm_(\d{8})T(\d{2})Z_([a-z0-9]{6})\.csv$/);
    const v2 = seg ? null : fn.match(/^v2:([a-z0-9]{6}):(\d+)$/);
    if (seg || v2) {
      const base = seg ? Date.UTC(+seg[1].slice(0, 4), +seg[1].slice(4, 6) - 1, +seg[1].slice(6, 8), +seg[2]) : +v2[2];
      const date = new Date(base);
      const pad = n => String(n).padStart(2, '0');
      const localDate = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
      const localTime = `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'local';
      const tooltip = `Recorded: ${date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'medium' })} (${tz})`;
      return {
        date, isoDate: localDate, isoTime: localTime, filename: fn, kind: seg ? 'segment' : 'v2session',
        iid: seg ? seg[3] : v2[1], hourStart: seg ? base : null, tooltip,
      };
    }
    // hrv_daily_2026-04-17.csv — one file per calendar day, starts at local midnight
    const d = fn.match(/^hrv_daily_(\d{4})-(\d{2})-(\d{2})\.csv$/);
    if (d) {
      const dt = new Date(+d[1], +d[2] - 1, +d[3], 0, 0, 0);
      return { date: dt, isoDate: `${d[1]}-${d[2]}-${d[3]}`, isoTime: '00:00:00', filename: fn, kind: 'daily' };
    }
    return null;
  }

  // A process death writes no disconnect row; the only trace is a jump between samples.
  const DATA_JUMP_GAP_MIN = 0.5;
  function dataJumpGaps(hrPoints) {
    const out = [];
    let prevT = null;
    for (const p of hrPoints) {
      if (p.v == null) continue;
      if (prevT != null && p.t - prevT > DATA_JUMP_GAP_MIN) out.push({ start: prevT, end: p.t });
      prevT = p.t;
    }
    return out;
  }

  // A day's gaps less the stretches any recording has HR for: one recording's gap (a web monitor left waiting
  // while the phone recorded) never hides another's data. pts: the day's HR points, sorted, { x } in minutes.
  function gapsOutsideData(gaps, pts) {
    const cover = [];
    for (const p of pts) {
      if (p.y == null) continue;
      const last = cover[cover.length - 1];
      if (last && p.x - last[1] <= DATA_JUMP_GAP_MIN) last[1] = p.x;
      else cover.push([p.x, p.x]);
    }
    const out = [];
    let k = 0;
    for (const g of gaps) {
      let s = g.start;
      while (k < cover.length && cover[k][1] < s) k++;
      for (let j = k; j < cover.length && cover[j][0] < g.end; j++) {
        if (cover[j][0] - s >= DATA_JUMP_GAP_MIN) out.push({ start: s, end: cover[j][0] });
        s = Math.max(s, cover[j][1]);
      }
      if (g.end - s >= DATA_JUMP_GAP_MIN) out.push({ start: s, end: g.end });
    }
    return out;
  }

  function mergeGaps(gaps) {
    const sorted = gaps.filter(g => g.end > g.start).sort((a, b) => a.start - b.start);
    const out = [];
    for (const g of sorted) {
      const last = out[out.length - 1];
      if (last && g.start <= last.end) last.end = Math.max(last.end, g.end);
      else out.push({ start: g.start, end: g.end });
    }
    return out;
  }

  // Given raw gap spans from disconnect→connect events, drop any gap whose
  // interior actually contains HR data. Covers three real cases:
  //   1. Spurious disconnect events that fire during healthy recording
  //      (Coospo firmware, brief Windows BT stack blip with instant recovery).
  //   2. Native-Android sessions where the auto-reconnect writes a "connected"
  //      row after the disconnect — but the HR characteristic notifications
  //      carried on through the micro-blip.
  //   3. Any future source of false disconnect events.
  // Keeps gaps that are real (no data at all within them).
  function trimGapsByData(rawGaps, hrPoints) {
    if (!rawGaps.length) return [];
    const out = [];
    let idx = 0;
    for (const g of rawGaps) {
      // Advance idx past any samples before the gap (hrPoints is time-sorted).
      while (idx < hrPoints.length && hrPoints[idx].t < g.start) idx++;
      let inGap = 0;
      let firstT = null, lastT = null;
      for (let i = idx; i < hrPoints.length && hrPoints[i].t <= g.end; i++) {
        if (hrPoints[i].v == null) continue; // skip null break-points
        if (firstT == null) firstT = hrPoints[i].t;
        lastT = hrPoints[i].t;
        inGap++;
      }
      // If the gap is covered by real data (3+ samples AND they span the
      // majority of the gap), treat the disconnect events as spurious.
      const gapDur = Math.max(0, g.end - g.start);
      const dataSpan = firstT != null ? (lastT - firstT) : 0;
      if (inGap >= 3 && (gapDur === 0 || dataSpan > gapDur * 0.5)) continue;
      out.push(g);
    }
    return out;
  }

  // Epoch of the first row in a file, used to reconstruct epoch_ms when the
  // column isn't present in older CSVs. Returns 0 if filename is unrecognised.
  function deriveFileStartEpoch(filename) {
    const m = parseSessionFilename(filename);
    return m ? m.date.getTime() : 0;
  }
  // The one row-epoch rule: the epoch_ms cell when it parses to a number, else the file start plus elapsed minutes t.
  // A cell may already be a number (v2 rows). checks: scripts/row-epoch.test.cjs.
  function rowEpochFn(idx, fileStartEpoch) {
    const col = idx.epoch_ms;
    return (row, t) => {
      const c = col == null ? '' : row[col];
      if (c !== '') {
        const e = typeof c === 'number' ? c : parseFloat(c);
        if (!isNaN(e)) return e;
      }
      return fileStartEpoch + t * 60000;
    };
  }

  // ===== CSV parsing + per-session summary =====
  function parseCSV(text) {
    const lines = text.split(/\r?\n/);
    if (lines.length < 2) return { rows: [], header: [] };
    const header = lines[0].split(',');
    const rows = [];
    for (let i = 1; i < lines.length; i++) {
      const l = lines[i];
      if (!l) continue;
      const cells = l.split(',');
      rows.push(cells);
    }
    return { rows, header };
  }

  // S35 (AUDIT-NOTES item 31): every row's elapsed minutes come from here, never from time_min directly.
  // A JS writer once carried a stale session start into time_min (4235 min on a 3 min file), so time_min
  // is trusted only when it starts plausibly and its span agrees with epoch_ms; otherwise the real
  // timestamps decide. A normal file returns time_min untouched, so its summary is unchanged.
  const ELAPSED_MAX_START_MIN = 10;
  const ELAPSED_MAX_DRIFT_MIN = 1;
  // The S35 rule over n rows read through tAt(i) and eAt(i). mode 0: time_min as written; otherwise at(t, e) rebuilds
  // it. Shared by rowElapsedMinFn (CSV cells) and v2SeriesFromRows (numbers), so the two can never drift.
  function elapsedRule(n, tAt, eAt) {
    let firstT = NaN, pt0 = NaN, pe0 = NaN, ptN = NaN, peN = NaN;
    for (let i = 0; i < n; i++) {
      const t = tAt(i);
      if (!Number.isFinite(t)) continue;
      if (!Number.isFinite(firstT)) firstT = t;
      const e = eAt(i);
      if (!Number.isFinite(e)) continue;
      if (!Number.isFinite(pt0)) { pt0 = t; pe0 = e; }
      ptN = t; peN = e;
    }
    const plausible = !Number.isFinite(firstT) || (firstT >= 0 && firstT <= ELAPSED_MAX_START_MIN);
    const round4 = (x) => Math.round(x * 1e4) / 1e4;
    if (Number.isFinite(pt0)) {
      const agree = Math.abs((ptN - pt0) - (peN - pe0) / 60000) <= ELAPSED_MAX_DRIFT_MIN;
      if (plausible && agree) return { mode: 0 };
      const base = plausible ? pt0 : 0;
      return { mode: 1, at: (t, e) => Number.isFinite(e) ? round4(base + (e - pe0) / 60000) : Number.isFinite(t) ? round4(base + t - pt0) : NaN };
    }
    if (plausible) return { mode: 0 };
    return { mode: 2, at: (t) => Number.isFinite(t) ? round4(t - firstT) : NaN };
  }
  function rowElapsedMinFn(rows, idx) {
    const tI = idx.time_min, eI = idx.epoch_ms;
    const tm = (r) => tI == null ? NaN : parseFloat(r[tI]);
    const em = (r) => (eI == null || r[eI] == null || r[eI] === '') ? NaN : parseFloat(r[eI]);
    const rule = elapsedRule(rows.length, (i) => tm(rows[i]), (i) => em(rows[i]));
    if (rule.mode === 0) return tm;
    if (rule.mode === 1) return (r) => rule.at(tm(r), em(r));
    return (r) => rule.at(tm(r));
  }

  // ===== Autonomic event detection (v2) =====
  //
  // Both flush and chills detection are grounded in what the literature
  // actually says these events look like in HR/HRV data, not in rolling
  // statistical thresholds.
  //
  // Shared machinery: rolling 5-min trailing MEAN (baseline) per sample and
  // nearest-value lookup between hr and rmssd series. Keeps everything O(n).

  // Trailing-window rolling mean. For each series[i], returns the mean of
  // v over (series[i].t - winMin, series[i].t). Excludes the current
  // sample itself — baseline is where you're coming from, not where you
  // are. Null values skipped. Returns null entries while the window isn't
  // full (< winMin of history).
  function rollingTrailingMean(series, winMin) {
    const out = new Array(series.length).fill(null);
    let sum = 0, count = 0;
    let lo = 0;
    for (let i = 0; i < series.length; i++) {
      while (lo < i && series[lo].t < series[i].t - winMin) {
        if (series[lo].v != null) { sum -= series[lo].v; count--; }
        lo++;
      }
      if (count > 0 && series[i].t - series[lo].t >= winMin * 0.5) {
        out[i] = sum / count;
      }
      if (series[i].v != null) { sum += series[i].v; count++; }
    }
    return out;
  }

  // Nearest RMSSD value at (or before) time t. Caller passes an index hint
  // that monotonically advances, keeping the amortised cost O(1) per call.
  function nearestRmssdAt(rmssd, t, hint) {
    while (hint.idx + 1 < rmssd.length && rmssd[hint.idx + 1].t <= t) hint.idx++;
    let j = Math.min(hint.idx, rmssd.length - 1);
    while (j >= 0 && rmssd[j].v == null) j--;
    return j >= 0 ? rmssd[j].v : null;
  }

  // Chills detector. Two physiological kinds emitted into one list with a
  // `kind` field: 'sympathetic' (HR up + RMSSD down, sustained minutes,
  // shivering / cold exposure) and 'vagal' (RMSSD spikes sharply, seconds
  // to ~2 min, frisson / vagal-burst / ectopic-driven). ratioThreshold is
  // wired to the sensitivity slider; it only scales the stdDev gate.
  function detectChillsWindows(hr, ratioThreshold, rmssd) {
    const out = [];
    if (!hr || hr.length < 20) return out;
    const WIN_MIN = 1.0;          // 60-sec rolling analysis window
    const BASELINE_MIN = 5;       // 5-min trailing baseline
    const MIN_STD_ABS = 3;        // permissive floor — slider filters by ratio post-detect
    const MIN_HR_DELTA = 8;       // permissive — slider filters by ratio post-detect
    const RMSSD_SUPPR = 0.85;     // permissive — slider filters by ratio post-detect
    const MIN_DURATION = 1.5;     // sustained ≥90 sec
    const COOLDOWN = 5;           // 5-min between events

    const hrBaseline = rollingTrailingMean(hr, BASELINE_MIN);
    const rmssdBaseline = rmssd ? rollingTrailingMean(rmssd, BASELINE_MIN) : null;

    const stds = new Array(hr.length).fill(null);
    const winMeans = new Array(hr.length).fill(null);
    // Sliding window: running sum and sum of squares, one pass. Re-summing
    // the window at every point cost ~7M steps on a full day.
    let n = 0, sum = 0, sumSq = 0, lo = 0;
    for (let i = 0; i < hr.length; i++) {
      const v = hr[i].v;
      if (Number.isFinite(v)) { sum += v; sumSq += v * v; n++; }
      while (hr[i].t - hr[lo].t > WIN_MIN) {
        const w = hr[lo].v;
        if (Number.isFinite(w)) { sum -= w; sumSq -= w * w; n--; }
        lo++;
      }
      if (n < 10) continue;
      const m = sum / n;
      stds[i] = Math.sqrt(Math.max(0, sumSq / n - m * m));
      winMeans[i] = m;
    }
    const nonNull = Float64Array.from(stds.filter(v => v != null)).sort();
    const medStd = nonNull.length ? nonNull[Math.floor(nonNull.length / 2)] : 0;

    const hint = { idx: 0 };
    const rmssdHint = { idx: 0 };
    let cur = null;
    let lastEmit = -Infinity;

    for (let i = 0; i < hr.length; i++) {
      const s = stds[i];
      const m = winMeans[i];
      const baseHR = hrBaseline[i];
      if (s == null || m == null || baseHR == null) {
        if (cur && cur.end - cur.start >= MIN_DURATION && cur.start >= lastEmit + COOLDOWN) {
          out.push(cur); lastEmit = cur.end;
        }
        cur = null;
        continue;
      }
      const stdOk = s >= Math.max(MIN_STD_ABS, medStd * ratioThreshold);
      const hrOk = m >= baseHR + MIN_HR_DELTA;
      let rmssdOk = true;
      if (rmssd && rmssdBaseline) {
        const rNow = nearestRmssdAt(rmssd, hr[i].t, rmssdHint);
        // Find baseline RMSSD at the same hint point.
        const baseRmssd = rmssdBaseline[rmssdHint.idx];
        rmssdOk = (rNow != null && baseRmssd != null) ? (rNow < baseRmssd * RMSSD_SUPPR) : false;
      }
      const isChill = stdOk && hrOk && rmssdOk;
      if (isChill) {
        if (!cur) cur = { start: hr[i].t, end: hr[i].t, maxStd: s, ratio: s / (medStd || 1), kind: 'sympathetic' };
        else { cur.end = hr[i].t; if (s > cur.maxStd) { cur.maxStd = s; cur.ratio = s / (medStd || 1); } }
      } else if (cur) {
        if (cur.end - cur.start >= MIN_DURATION && cur.start >= lastEmit + COOLDOWN) {
          out.push(cur); lastEmit = cur.end;
        }
        cur = null;
      }
    }
    if (cur && cur.end - cur.start >= MIN_DURATION && cur.start >= lastEmit + COOLDOWN) {
      out.push(cur);
    }

    // Vagal-burst pass — sharp RMSSD rise above trailing baseline.
    // Gates: ratio ≥2.5× baseline AND ≥+20 ms absolute; ≥5 s sustained;
    // ≤2 min length cap; 2-min cooldown.
    if (rmssd && rmssdBaseline) {
      const VAGAL_RATIO = 2.5;
      const VAGAL_ABS_DELTA = 20;
      const VAGAL_MIN_DURATION = 5 / 60;   // 5 seconds in minutes
      const VAGAL_MAX_DURATION = 2;        // 2 min cap
      const VAGAL_COOLDOWN = 2;
      let vagalCur = null;
      let vagalLastEmit = -Infinity;
      for (let i = 0; i < rmssd.length; i++) {
        const rNow = rmssd[i].v;
        const rBase = rmssdBaseline[i];
        if (rNow == null || rBase == null || rBase <= 0) {
          if (vagalCur && vagalCur.end - vagalCur.start >= VAGAL_MIN_DURATION
              && vagalCur.start >= vagalLastEmit + VAGAL_COOLDOWN) {
            out.push(vagalCur); vagalLastEmit = vagalCur.end;
          }
          vagalCur = null;
          continue;
        }
        const isVagal = rNow >= rBase * VAGAL_RATIO && rNow - rBase >= VAGAL_ABS_DELTA;
        if (isVagal) {
          if (!vagalCur) {
            vagalCur = { start: rmssd[i].t, end: rmssd[i].t, peakRmssd: rNow, baseRmssd: rBase, ratio: rNow / (rBase || 1), kind: 'vagal' };
          } else {
            vagalCur.end = rmssd[i].t;
            if (rNow > vagalCur.peakRmssd) { vagalCur.peakRmssd = rNow; vagalCur.ratio = rNow / (vagalCur.baseRmssd || 1); }
            // Close early if burst is running longer than VAGAL_MAX_DURATION
            if (vagalCur.end - vagalCur.start > VAGAL_MAX_DURATION) {
              if (vagalCur.start >= vagalLastEmit + VAGAL_COOLDOWN) {
                out.push(vagalCur); vagalLastEmit = vagalCur.end;
              }
              vagalCur = null;
            }
          }
        } else if (vagalCur) {
          if (vagalCur.end - vagalCur.start >= VAGAL_MIN_DURATION
              && vagalCur.start >= vagalLastEmit + VAGAL_COOLDOWN) {
            out.push(vagalCur); vagalLastEmit = vagalCur.end;
          }
          vagalCur = null;
        }
      }
      if (vagalCur && vagalCur.end - vagalCur.start >= VAGAL_MIN_DURATION
          && vagalCur.start >= vagalLastEmit + VAGAL_COOLDOWN) {
        out.push(vagalCur);
      }
    }

    return out;
  }

  // Bump to make every cached summary reparse (legacy index and the v2 sess:/prec: caches).
  const SUMMARY_SCHEMA_V = 16;
  // opts: { quad, shift }, the page's quadrant thresholds and HR shift settings (the Worker gets them per message).
  function summarizeCSV(filename, text, opts) {
    const quad = (opts && opts.quad) || {}, shift = (opts && opts.shift) || HR_SHIFT_DEFAULT;
    const { rows, header } = parseCSV(text);
    if (!rows.length) {
      // Mid-upload: file has headers but no data rows yet (mobile is
      // sending a resumable PATCH that hasn't trickled data through).
      // Return a ghost stub instead of null so the file shows up in the
      // calendar as a placeholder. needsReparse picks it up via the
      // __incomplete flag and replaces it with a real summary once rows
      // arrive on the next sync cycle. Other null-return paths below
      // (no valid HR, future-dated) remain — those are genuinely invalid
      // states that won't fix themselves.
      return {
        filename,
        __incomplete: true,
        __schemaV: SUMMARY_SCHEMA_V,
        startEpoch: deriveFileStartEpoch(filename),
        duration: 0,
        hrCount: 0,
        hrAvg: 0, hrMax: 0, hrMin: 0,
        rmssdAvg: null, rmssdMin: null,
        palpCount: 0, warnCount: 0,
        events: [], warnings: [], connections: [], postureLog: [],
        hr: [], rmssd: [], sdnnMatch: [], sdnn5min: [], sdnnFullSeries: [],
        palpTimes: [],
      };
    }
    const idx = {};
    header.forEach((h, i) => idx[h.trim()] = i);

    const hr = [];          // {t, v}
    const rmssd = [];       // {t, v}
    const sdnnMatch = [];   // {t, v}
    const sdnn5min = [];    // {t, v}
    const sdnnFullSeries = []; // {t, v} — running session SDNN per row
    const palpTimes = [];   // [t, t, ...]
    const events = [];      // {t, label}
    const warnings = [];    // {t, type}
    const connections = []; // {t, type}
    const postureLog = [];  // {t, posture}

    const fileStartEpoch = deriveFileStartEpoch(filename);
    const epochFor = rowEpochFn(idx, fileStartEpoch);
    // Insert a null break-point when consecutive rows are more than
    // GAP_MIN minutes apart. With spanGaps:false on the chart, this
    // renders as a visible gap instead of a long straight line across
    // a silent window. Prevents the "flat at 100 bpm for 13 min" look
    // that was really a BLE / pause gap.
    const GAP_MIN = 10 / 60; // 10 seconds
    let lastT = null;
    const elapsedMin = rowElapsedMinFn(rows, idx);
    for (const r of rows) {
      const t = elapsedMin(r);
      if (isNaN(t)) continue;
      if (lastT != null && t - lastT > GAP_MIN) {
        hr.push({ t: t - 0.001, v: null });
        rmssd.push({ t: t - 0.001, v: null });
      }
      lastT = t;
      const ep = epochFor(r, t);
      const h = r[idx.hr_bpm] !== '' ? parseFloat(r[idx.hr_bpm]) : null;
      if (h != null && !isNaN(h)) hr.push({ t, v: h, ep });
      const rm = r[idx.rmssd_ms] !== '' ? parseFloat(r[idx.rmssd_ms]) : null;
      // RMSSD <= 0 is a missing value, not a reading.
      if (rm != null && !isNaN(rm) && rm > 0) rmssd.push({ t, v: rm, ep });
      if (idx.sdnn_match_ms != null) {
        const v = r[idx.sdnn_match_ms] !== '' ? parseFloat(r[idx.sdnn_match_ms]) : null;
        if (v != null && !isNaN(v) && v > 0) sdnnMatch.push({ t, v, ep });
      }
      if (idx.sdnn_5min_ms != null) {
        const v = r[idx.sdnn_5min_ms] !== '' ? parseFloat(r[idx.sdnn_5min_ms]) : null;
        if (v != null && !isNaN(v) && v > 0) sdnn5min.push({ t, v, ep });
      }
      if (idx.sdnn_full_ms != null) {
        const v = r[idx.sdnn_full_ms] !== '' ? parseFloat(r[idx.sdnn_full_ms]) : null;
        if (v != null && !isNaN(v) && v > 0) sdnnFullSeries.push({ t, v, ep });
      }
      if (r[idx.palpitation] === '1') palpTimes.push(t);
      if (r[idx.event] && r[idx.event] !== '') events.push({ t, label: r[idx.event], ep });
      if (r[idx.warning] && r[idx.warning] !== '') warnings.push({ t, type: r[idx.warning] });
      if (r[idx.connection] && r[idx.connection] !== '') {
        // Normalize: native Android writes past tense ("connected" /
        // "disconnected"); web writes present tense ("connect" / "disconnect").
        // Canonicalize so everything downstream can match a single string.
        const raw = r[idx.connection];
        const ct = raw === 'disconnected' ? 'disconnect'
                 : raw === 'connected' ? 'connect'
                 : raw;
        connections.push({ t, type: ct });
      }
      if (idx.posture != null && r[idx.posture] && r[idx.posture] !== '') postureLog.push({ t, posture: r[idx.posture] });
    }

    if (!hr.length) return null;

    // Authoritative session start time. Prefer the first row's epoch_ms
    // (UTC ms) because the filename's wall-clock portion can be in the
    // device's local time (Android) OR UTC (web) depending on which
    // surface wrote it. epoch_ms is unambiguous across both. The day
    // view reads this so sessions land in the correct hour regardless
    // of how the filename was stamped.
    const startEpoch = (hr[0] && hr[0].ep) ? hr[0].ep : fileStartEpoch;

    // Drop null gap-markers before averaging. Without the filter, reduce
    // treats null as 0 and divides by the inflated length — sessions with
    // BLE gaps end up with hrAvg pulled toward zero (or 0 outright when
    // every row is a gap marker).
    const hrVals = hr.map(p => p.v).filter(v => v != null);
    const rmssdVals = rmssd.map(p => p.v).filter(v => v != null);
    const sdnnMatchVals = sdnnMatch.map(p => p.v);
    const sdnn5minVals = sdnn5min.map(p => p.v);

    // Max/min with timestamps. Skip null gap-marker entries — without this,
    // null < anyNumber returns true (null coerces to 0) so hrMin gets set to
    // {v: null}, which downstream renders as "null bpm" in summary cards.
    let maxHR = null, minHR = null;
    for (const p of hr) {
      if (p.v == null) continue;
      if (maxHR == null || p.v > maxHR.v) maxHR = p;
      if (minHR == null || p.v < minHR.v) minHR = p;
    }
    if (maxHR == null) maxHR = { t: 0, v: 0 };
    if (minHR == null) minHR = { t: 0, v: 0 };
    let maxRM = null, minRM = null;
    if (rmssd.length) {
      for (const p of rmssd) {
        if (p.v == null) continue;
        if (maxRM == null || p.v > maxRM.v) maxRM = p;
        if (minRM == null || p.v < minRM.v) minRM = p;
      }
    }

    // Palpitation clustering: consecutive palps within 0.5 min -> one cluster
    const palpClusters = [];
    let cur = null;
    for (const t of palpTimes) {
      if (!cur) { cur = { start: t, end: t, count: 1 }; }
      else if (t - cur.end <= 0.5) { cur.end = t; cur.count++; }
      else { palpClusters.push(cur); cur = { start: t, end: t, count: 1 }; }
    }
    if (cur) palpClusters.push(cur);

    // Warning segments: group same-type warnings within 1 min. Filter out
    // single-event spans (< 5s sustained) since the monitor currently fires
    // on single-reading threshold crossings — a stray 131 bpm beat shouldn't
    // render as a warning stripe across the chart. Real physiological
    // crossings keep firing across multiple consecutive samples.
    const warnSegsRaw = [];
    for (const w of warnings) {
      const last = warnSegsRaw[warnSegsRaw.length - 1];
      if (last && last.type === w.type && w.t - last.end <= 1) last.end = w.t;
      else warnSegsRaw.push({ type: w.type, start: w.t, end: w.t });
    }
    const WARN_MIN_DURATION = 5 / 60; // 5 seconds in minutes
    const warnSegs = warnSegsRaw.filter(seg => (seg.end - seg.start) >= WARN_MIN_DURATION);

    // Connection gaps (disconnect -> next connect). For an open gap at end of
    // session, clamp end to at least start — otherwise a disconnect that fired
    // AFTER the last HR sample produces a negative "gap" which inflates uptime
    // past 100%.
    const rawGaps = [];
    const lastHRT = hr.length ? hr[hr.length - 1].t : 0;
    for (let i = 0; i < connections.length; i++) {
      if (connections[i].type === 'disconnect') {
        const next = connections.find((c, j) => j > i && c.type === 'connect');
        const start = connections[i].t;
        const end = next ? next.t : Math.max(start, lastHRT);
        rawGaps.push({ start, end });
      }
    }
    // Trim any gap against actual HR data presence. A disconnect event that
    // somehow fired while HR samples were still arriving (buggy firmware,
    // spurious state change, recovered-instantly reconnect without a matching
    // connect row) should not mask regions with real data.
    const connGaps = mergeGaps(trimGapsByData(rawGaps, hr).concat(dataJumpGaps(hr)));
    const gapTotalMin = connGaps.reduce((s, g) => s + Math.max(0, g.end - g.start), 0);

    // Resting HR proxy: the LOWEST 5-min rolling mean across the session. Unlike
    // "morning HR" this works for non-24 / odd schedules — it finds the calmest
    // stretch regardless of when in the day the session happened. Skip null
    // gap-markers; they coerce to 0 in arithmetic and pull the average down.
    const ROLL_MIN = 5;
    let restingHR = null;
    for (let i = 0; i < hr.length; i++) {
      if (hr[i].v == null) continue;
      const windowVals = [];
      for (let j = i; j < hr.length && hr[j].t - hr[i].t <= ROLL_MIN; j++) {
        if (hr[j].v != null) windowVals.push(hr[j].v);
      }
      if (windowVals.length < 10) continue;
      const m = windowVals.reduce((a, b) => a + b, 0) / windowVals.length;
      if (restingHR == null || m < restingHR) restingHR = m;
    }
    restingHR = restingHR != null ? Math.round(restingHR) : null;

    // Time in tachycardia (HR > 100). Denominator is real samples only;
    // gap-markers count as neither tachy nor not-tachy.
    const realHrCount = hrVals.length;
    const tachy = realHrCount > 0 ? hr.filter(p => p.v != null && p.v > 100).length / realHrCount : 0;

    // HR delta events — sustained rises/drops of >=20 bpm within any window up to
    // 10 min (POTS tilt-test criterion is 30 bpm in 10 min of standing). The
    // earlier 3-min window missed anything slower than ~8 bpm/min. We also smooth
    // HR with a 5-beat mean first so single-beat noise doesn't trigger false events.
    const smHR = [];
    for (let i = 0; i < hr.length; i++) {
      if (hr[i].v == null) { smHR.push({ t: hr[i].t, v: null }); continue; }
      let sum = 0, n = 0;
      for (let j = Math.max(0, i - 2); j < Math.min(hr.length, i + 3); j++) {
        if (hr[j].v == null) continue;
        sum += hr[j].v; n++;
      }
      smHR.push({ t: hr[i].t, v: n > 0 ? sum / n : null });
    }
    // Sympathetic flush detector. Sustained HR rise + RMSSD drop, mirrors
    // the POTS tilt-test criterion (≥30 bpm sustained over 10 min).
    // All five gates required:
    //   1. Smoothed peak HR ≥ max(baseline + 25, 100 bpm).
    //   2. Onset: HR rose ≥20 bpm from 5-min trailing baseline in 2 min before peak.
    //   3. Sustain: smoothed HR stays ≥(baseline + 20) for ≥60 sec after peak.
    //   4. RMSSD drops ≥30% vs trailing baseline during event.
    //   5. 15-min cooldown between events.
    const flushes = [];
    const FLUSH_PEAK_FLOOR = 100;
    const FLUSH_DELTA_MIN = 20;          // rise from baseline
    const FLUSH_ONSET_WIN = 2.0;         // peak must occur within 2 min of rise
    const FLUSH_SUSTAIN_MIN = 1.0;       // HR stays elevated for ≥60s after peak
    const FLUSH_SUSTAIN_DELTA = 20;      // "elevated" = baseline + 20
    const FLUSH_RMSSD_DROP = 0.30;
    const FLUSH_COOLDOWN_MIN = 15;
    const FLUSH_EDGE_MIN = 1;
    const FLUSH_BASELINE_MIN = 5;        // 5-min trailing baseline

    const hrBaselineSeries = rollingTrailingMean(hr, FLUSH_BASELINE_MIN);
    const rmssdBaselineSeries = rollingTrailingMean(rmssd, FLUSH_BASELINE_MIN);
    const hrLastT = hr.length ? hr[hr.length - 1].t : 0;
    let lastFlush = -Infinity;
    const rmssdHint = { idx: 0 };

    for (let i = 0; i < smHR.length; i++) {
      const cur = smHR[i];
      if (cur.v == null) continue;
      if (cur.t < FLUSH_EDGE_MIN || cur.t > hrLastT - FLUSH_EDGE_MIN) continue;
      if (cur.t < lastFlush + FLUSH_COOLDOWN_MIN) continue;

      const baseHR = hrBaselineSeries[i];
      if (baseHR == null) continue;

      const peakFloor = Math.max(FLUSH_PEAK_FLOOR, baseHR + 25);
      if (cur.v < peakFloor) continue;
      if (cur.v - baseHR < FLUSH_DELTA_MIN) continue;

      // Onset: at some point in the last FLUSH_ONSET_WIN minutes, smoothed
      // HR was within 5 bpm of baseline. That tells us the rise is recent,
      // not that HR has been elevated for 30 min already.
      let onsetOk = false;
      for (let j = i - 1; j >= 0 && cur.t - smHR[j].t <= FLUSH_ONSET_WIN; j--) {
        if (smHR[j].v != null && smHR[j].v <= baseHR + 5) { onsetOk = true; break; }
      }
      if (!onsetOk) continue;

      // Sustain: smoothed HR stays at least (baseline + FLUSH_SUSTAIN_DELTA)
      // for FLUSH_SUSTAIN_MIN minutes after the peak. Any dip below that
      // floor kills the candidate — real sympathetic surges don't flicker.
      let sustainReached = false;
      let lastSustainT = cur.t;
      let sustainBroken = false;
      for (let j = i + 1; j < smHR.length && smHR[j].t <= cur.t + FLUSH_SUSTAIN_MIN + 0.5; j++) {
        if (smHR[j].v == null) continue;
        if (smHR[j].v < baseHR + FLUSH_SUSTAIN_DELTA) { sustainBroken = true; break; }
        lastSustainT = smHR[j].t;
        if (smHR[j].t >= cur.t + FLUSH_SUSTAIN_MIN) { sustainReached = true; break; }
      }
      if (sustainBroken || !sustainReached) continue;

      // RMSSD: trailing baseline vs nearest during-event value.
      const rNow = nearestRmssdAt(rmssd, cur.t, rmssdHint);
      const rBase = rmssdBaselineSeries[rmssdHint.idx];
      if (rNow == null || rBase == null || rBase <= 0) continue;
      const rDropPct = (rBase - rNow) / rBase;
      if (rDropPct < FLUSH_RMSSD_DROP) continue;

      // Onset start: walk backward again to the actual crossing point, so
      // the span on the chart reflects when the rise BEGAN.
      let onsetStart = cur.t;
      for (let j = i - 1; j >= 0 && cur.t - smHR[j].t <= FLUSH_ONSET_WIN; j--) {
        if (smHR[j].v != null && smHR[j].v <= baseHR + 5) { onsetStart = smHR[j].t; break; }
      }

      flushes.push({
        start: onsetStart,
        end: lastSustainT,
        t: cur.t,
        hrDelta: Math.round(cur.v - baseHR),
        rmssdDropPct: Math.round(rDropPct * 100),
        peak: Math.round(cur.v),
        baseline: Math.round(baseHR),
      });
      lastFlush = cur.t;
    }

    // Chills/shivering volatility (extracted for re-run in the viewer).
    // rmssd passed so the detector can verify concurrent vagal withdrawal —
    // real shivering is a sympathetic event, not just statistical variance.
    const chillsWindows = detectChillsWindows(hr, 2.5, rmssd);

    const hrDeltas = [];
    // Thresholds are user-configurable (settings panel). Defaults match the
    // clinical POTS criterion: ≥30 bpm rise within 10 minutes (of standing).
    // 20 bpm is a more sensitive non-clinical default if the user prefers to
    // surface smaller jumps. The 3-bpm "stable" tolerance and 2-minute
    // cooldown between flags stay fixed — they just de-noise the detector.
    const DELTA_THRESH = shift.threshold;
    const WIN_MIN = shift.windowMin;
    const COOLDOWN = 2;
    let lastFlagAt = -Infinity;
    for (let i = 1; i < smHR.length; i++) {
      const cur = smHR[i];
      // Skip null gap-markers — without this, `null < rangeMin` coerces to
      // `0 < rangeMin` and rangeMin gets pulled to 0, producing fake
      // "82 → 0" / "0 → 89" deltas across BLE drops.
      if (cur.v == null) continue;
      if (cur.t < lastFlagAt + COOLDOWN) continue;
      let rangeMin = cur.v, rangeMax = cur.v;
      let minT = cur.t, maxT = cur.t;
      for (let j = i - 1; j >= 0 && cur.t - smHR[j].t <= WIN_MIN; j--) {
        if (smHR[j].v == null) continue;
        if (smHR[j].v < rangeMin) { rangeMin = smHR[j].v; minT = smHR[j].t; }
        if (smHR[j].v > rangeMax) { rangeMax = smHR[j].v; maxT = smHR[j].t; }
      }
      if (cur.v - rangeMin >= DELTA_THRESH && cur.v >= rangeMax - 3) {
        hrDeltas.push({ start: minT, end: cur.t, startHR: Math.round(rangeMin), endHR: Math.round(cur.v), delta: Math.round(cur.v - rangeMin), direction: 'rise' });
        lastFlagAt = cur.t;
      } else if (rangeMax - cur.v >= DELTA_THRESH && cur.v <= rangeMin + 3) {
        hrDeltas.push({ start: maxT, end: cur.t, startHR: Math.round(rangeMax), endHR: Math.round(cur.v), delta: Math.round(cur.v - rangeMax), direction: 'drop' });
        lastFlagAt = cur.t;
      }
    }

    // Per-calendar-day breakdown for sessions that span midnight. Each
    // local date the session touches gets its own slice (avg HR, max/min,
    // tachy %, count + min epoch / max epoch). Month + week views read
    // s.byDay[iso] so a 39-hour session reports its Saturday slice
    // (e.g. 1.5 h, 12% tachy) on the Saturday cell instead of the
    // file-wide 14% tachy.
    const byDay = {};
    {
      const buckets = new Map();
      const ymdLocal = (ms) => dayKeyOf(ms);
      for (const p of hr) {
        if (p.v == null || p.ep == null) continue;
        const k = ymdLocal(p.ep);
        let b = buckets.get(k);
        if (!b) {
          b = { hrSum: 0, hrCount: 0, tachyCount: 0, hrMax: -Infinity, hrMin: Infinity, startMs: p.ep, endMs: p.ep, palpCount: 0 };
          buckets.set(k, b);
        }
        b.hrSum += p.v;
        b.hrCount++;
        if (p.v > 100) b.tachyCount++;
        if (p.v > b.hrMax) b.hrMax = p.v;
        if (p.v < b.hrMin) b.hrMin = p.v;
        if (p.ep < b.startMs) b.startMs = p.ep;
        if (p.ep > b.endMs) b.endMs = p.ep;
      }
      // Per-day palp count from absolute palp times.
      for (const t of palpTimes) {
        const ep = (hr[0] && hr[0].ep) ? hr[0].ep + (t - hr[0].t) * 60000 : startEpoch + t * 60000;
        const k = ymdLocal(ep);
        const b = buckets.get(k);
        if (b) b.palpCount++;
      }
      for (const [k, b] of buckets) {
        if (!b.hrCount) continue;
        byDay[k] = {
          hrAvg: Math.round(b.hrSum / b.hrCount),
          hrMax: b.hrMax,
          hrMin: b.hrMin,
          tachyPct: Math.round((b.tachyCount / b.hrCount) * 100),
          durationMin: Math.max(0.0001, (b.endMs - b.startMs) / 60000),
          hrCount: b.hrCount,
          palpCount: b.palpCount,
        };
      }
    }
    // Sanity-check: a session that claims to extend more than a minute into
    // the future is either a clock-skew artifact or a contaminated file
    // (writer dumped stale state.hrSeries into a fresh filename). Refusing
    // the summary here keeps the bad file out of sessionsIndex + the
    // sessionsByDate buckets, so it can't paint phantom days in the calendar.
    const summaryDuration = hr[hr.length - 1].t;
    const summaryEndMs = startEpoch + summaryDuration * 60000;
    const nowMs = Date.now();
    if (startEpoch > nowMs + 60000 || summaryEndMs > nowMs + 60000) {
      console.warn('[summarizeCSV] rejecting summary with future epoch',
        { filename, startEpoch, duration: summaryDuration, endMs: summaryEndMs, nowMs });
      return null;
    }
    const summary = {
      filename,
      startEpoch,
      hrCount: hr.length,
      duration: summaryDuration,
      hrAvg: hrVals.length ? Math.round(hrVals.reduce((s, v) => s + v, 0) / hrVals.length) : 0,
      hrMax: maxHR,
      hrMin: minHR,
      rmssdAvg: rmssdVals.length ? Math.round(rmssdVals.reduce((s, v) => s + v, 0) / rmssdVals.length) : null,
      sdnnMatchAvg: sdnnMatchVals.length ? Math.round(sdnnMatchVals.reduce((s, v) => s + v, 0) / sdnnMatchVals.length) : null,
      sdnn5minAvg: sdnn5minVals.length ? Math.round(sdnn5minVals.reduce((s, v) => s + v, 0) / sdnn5minVals.length) : null,
      sdnnFull: sdnnFullSeries.length ? Math.round(sdnnFullSeries[sdnnFullSeries.length - 1].v) : null,
      rmssdMax: maxRM,
      rmssdMin: minRM,
      restingHR,
      palpCount: palpTimes.length,
      palpClusters,
      warnCount: warnSegs.length,
      warnSegs,
      events,
      connGaps,
      gapTotalMin,
      tachyPct: Math.round(tachy * 100),
      hrDeltas,
      flushes,
      chillsWindows,
      byDay,
      // Bump whenever summarizeCSV's output shape or logic changes. Forces a
      // re-parse of cached sessionsIndex entries that were produced by older
      // code — otherwise bug fixes in the summarize path never reach past
      // sessions already in the cache.
      __schemaV: SUMMARY_SCHEMA_V,
    };
    // Per-session quadrant percentages — how much of the session was spent in each
    // autonomic zone. Useful for cross-session POTS-severity trends.
    // Pair HR + RMSSD, classify each RMSSD sample, sum durations.
    const quadPct = { 'low-high': 0, 'high-high': 0, 'low-low': 0, 'high-low': 0 };
    if (rmssd.length && hr.length) {
      let hrIdx = 0;
      // Pull live user thresholds so quadPct matches whatever the user has
      // customized in the kebab editors. Cached summaries may lag by one render
      // cycle after a threshold change; invalidateQuadrantCache() clears them.
      const t = quad;
      const quadCounts = { 'low-high': 0, 'high-high': 0, 'low-low': 0, 'high-low': 0, 'neutral': 0 };
      for (const p of rmssd) {
        while (hrIdx + 1 < hr.length && Math.abs(hr[hrIdx + 1].t - p.t) <= Math.abs(hr[hrIdx].t - p.t)) hrIdx++;
        const hrVal = hr[hrIdx].v;
        const hrLow = hrVal < t.hrLow, hrHigh = hrVal > t.hrHigh;
        const rmLow = p.v < t.hrvLow,  rmHigh = p.v > t.hrvHigh;
        let key = 'neutral';
        if (hrLow && rmHigh) key = 'low-high';
        else if (hrHigh && rmHigh) key = 'high-high';
        else if (hrLow && rmLow) key = 'low-low';
        else if (hrHigh && rmLow) key = 'high-low';
        quadCounts[key]++;
      }
      const total = rmssd.length;
      for (const k of Object.keys(quadCounts)) quadPct[k] = Math.round((quadCounts[k] / total) * 100);
    }
    summary.quadPct = quadPct;
    // Posture: convert change points into contiguous spans (carry forward until next change)
    if (postureLog.length) {
      const spans = [];
      // S61: the file's first posture row under 0.02 min (1.2 s) is the start stamp, not a press.
      for (let i = 0; i < postureLog.length; i++) {
        spans.push({ start: postureLog[i].t, end: i + 1 < postureLog.length ? postureLog[i + 1].t : hr[hr.length - 1].t, posture: postureLog[i].posture, stamp: i === 0 && postureLog[i].t < 0.02 });
      }
      summary.postureSpans = spans;
    }
    return summary;
  }

  // ===== Day helper module BEGIN =====
  // Every day boundary in the viewer goes through here (scripts/day-boundary.test.cjs enforces it).
  // A viewer day runs from DAY_START_HOUR local time on its date to the same hour next date, so DST days
  // are 23 or 25 h. Day start is midnight (decision 2026-10-09); making it a setting is deferred.
  // v2 day keys use the browser zone too; the segment's recorded offset (tz, z) is DEFERRED.
  const DAY_START_HOUR = 0;
  // Local-tz YYYY-MM-DD of an epoch. Never toISOString().slice(0,10): west of UTC that is the previous day.
  function localDateKeyFromEpoch(epochMs) {
    if (!epochMs) return '';
    const d = new Date(epochMs);
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  // Calendar label for a cursor or week bound; pure local date, never shifted by the day start.
  function localDateLabel(ms) {
    return localDateKeyFromEpoch(ms);
  }
  function isoAddDays(iso, n) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || '');
    if (!m) return '';
    return localDateLabel(new Date(+m[1], +m[2] - 1, +m[3] + n, 12).getTime());
  }
  // [start, end) epochs of the viewer day named iso, in browser local time.
  function dayWindow(iso) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || '');
    if (!m) return { start: NaN, end: NaN };
    return {
      start: new Date(+m[1], +m[2] - 1, +m[3], DAY_START_HOUR).getTime(),
      end: new Date(+m[1], +m[2] - 1, +m[3] + 1, DAY_START_HOUR).getTime(),
    };
  }
  // Viewer day of a data epoch (a sample, a session start, now). The last window is kept: callers walk samples in order.
  let _dayKeyLast = { start: 0, end: 0, key: '' };
  function dayKeyOf(ep) {
    if (!ep) return '';
    if (ep >= _dayKeyLast.start && ep < _dayKeyLast.end) return _dayKeyLast.key;
    const k0 = localDateLabel(ep);
    const k = ep < dayWindow(k0).start ? isoAddDays(k0, -1) : k0;
    const w = dayWindow(k);
    _dayKeyLast = { start: w.start, end: w.end, key: k };
    return k;
  }
  // Every viewer day whose window overlaps [startMs, endMs); days starting after notAfterMs are left out.
  function dayKeysSpanned(startMs, endMs, notAfterMs) {
    const out = [dayKeyOf(startMs)];
    for (let i = 0; i < 400; i++) {
      const next = isoAddDays(out[out.length - 1], 1);
      const w = dayWindow(next);
      if (!(w.start < endMs) || (notAfterMs != null && w.start > notAfterMs)) break;
      out.push(next);
    }
    return out;
  }
  // ===== Day helper module END =====

  const api = { parseSessionFilename, DATA_JUMP_GAP_MIN, dataJumpGaps, gapsOutsideData, mergeGaps, trimGapsByData, DAY_START_HOUR, localDateKeyFromEpoch, localDateLabel, isoAddDays, dayWindow, dayKeyOf, dayKeysSpanned, HR_SHIFT_DEFAULT, SUMMARY_SCHEMA_V, ELAPSED_MAX_START_MIN, ELAPSED_MAX_DRIFT_MIN, deriveFileStartEpoch, rowEpochFn, parseCSV, elapsedRule, rowElapsedMinFn, rollingTrailingMean, nearestRmssdAt, detectChillsWindows, summarizeCSV };
  root.AortiViewerParse = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
  // In the parse Worker (the page runs new Worker('./viewer-parse.js?v=' + SUMMARY_SCHEMA_V)): one summary per message.
  if (typeof importScripts === 'function' && typeof document === 'undefined') {
    root.onmessage = (e) => {
      const d = e.data;
      try {
        if (d.zoneTable && !root.AortiLocalClock) {
          importScripts('./local-clock.js');
          root.AortiLocalClock.install(d.zoneTable);
        }
        root.postMessage({ id: d.id, __schemaV: SUMMARY_SCHEMA_V, summary: summarizeCSV(d.fn, d.text, { quad: d.quad, shift: d.shift }) });
      } catch (err) {
        root.postMessage({ id: d.id, __schemaV: SUMMARY_SCHEMA_V, error: String(err && err.message || err), name: err && err.name });
      }
    };
  }
})(typeof self !== 'undefined' ? self : globalThis);
