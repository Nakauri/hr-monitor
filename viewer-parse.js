// Viewer parsing: the session file name, the gap helpers and the day helper module, shared by hrv_viewer.html.
// Checks: scripts/day-boundary.test.cjs, scripts/day-gaps.test.cjs, scripts/row-epoch.test.cjs.
(function (root) {
  'use strict';

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

  const api = { parseSessionFilename, DATA_JUMP_GAP_MIN, dataJumpGaps, gapsOutsideData, mergeGaps, trimGapsByData, DAY_START_HOUR, localDateKeyFromEpoch, localDateLabel, isoAddDays, dayWindow, dayKeyOf, dayKeysSpanned };
  root.AortiViewerParse = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof self !== 'undefined' ? self : globalThis);
