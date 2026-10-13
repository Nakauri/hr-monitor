// Native report PDF: page canvases in, a shared PDF out (PdfPrinter.java through NativeHrSession.printPdf),
// or a PDF saved where the person picks (NativeHrSession.savePdf).
// Pages are US Letter drawn at 2x; window.__aortiNativePdf.proof() prints a worst-case synthetic day.
(function () {
  'use strict';

  var PT_W = 612;
  var PT_H = 792;
  var SCALE = 2;
  var MAX_MOMENTS = 6;
  var CEILING_MS = 90000;

  window.__aortiNativePdfRanInit = true;

  function plugin() {
    var cap = window.Capacitor;
    return (cap && cap.Plugins && cap.Plugins.NativeHrSession) || null;
  }

  function available() {
    var p = plugin();
    return !!(p && typeof p.printPdf === 'function');
  }

  // Page 1, then two moments per page, then the optional week page. Mirrors PdfPrinter.Plan.pageCount.
  function pageCount(moments, week) {
    var m = Math.max(0, Math.min(moments | 0, MAX_MOMENTS));
    return 1 + Math.ceil(m / 2) + (week ? 1 : 0);
  }

  // A blank page whose 2D context draws in points.
  function newPage(landscape) {
    var c = document.createElement('canvas');
    c.width = (landscape ? PT_H : PT_W) * SCALE;
    c.height = (landscape ? PT_W : PT_H) * SCALE;
    var g = c.getContext('2d');
    g.fillStyle = '#fff';
    g.fillRect(0, 0, c.width, c.height);
    g.scale(SCALE, SCALE);
    return c;
  }

  // One page at a time: encode, then free the canvas backing store before the next.
  function encode(canvas) {
    var url = canvas.toDataURL('image/png');
    var landscape = canvas.width > canvas.height;
    canvas.width = 0;
    canvas.height = 0;
    return { image: url.slice(url.indexOf(',') + 1), landscape: landscape };
  }

  function withCeiling(promise) {
    return new Promise(function (resolve, reject) {
      var timer = setTimeout(function () { reject(new Error('pdf_timeout')); }, CEILING_MS);
      promise.then(function (v) { clearTimeout(timer); resolve(v); },
        function (e) { clearTimeout(timer); reject(e); });
    });
  }

  // opts: { pages: [canvas], filename, moments?, week?, share? }. Resolves { uri, name, pages, bytes, ms, shared }.
  function print(opts) {
    var p = plugin();
    if (!p || typeof p.printPdf !== 'function') return Promise.reject(new Error('pdf_unavailable'));
    var pages = [];
    try {
      for (var i = 0; i < opts.pages.length; i++) pages.push(encode(opts.pages[i]));
    } catch (e) {
      return Promise.reject(e);
    }
    var args = { pages: pages, filename: opts.filename || 'aorti-report.pdf', share: opts.share !== false };
    if (opts.moments != null) {
      args.moments = opts.moments;
      args.week = !!opts.week;
    }
    return withCeiling(p.printPdf(args));
  }

  function canSave() {
    var p = plugin();
    return !!(p && typeof p.savePdf === 'function');
  }

  // Save to phone: the same pages, written by PdfPrinter, then the system "Save as" screen.
  // opts: { pages: [canvas], filename, moments?, week? }. Resolves { saved: true, name } or { saved: false, cancelled: true }.
  // No ceiling: the call stays open while the person picks a folder; native settles every path.
  function save(opts) {
    var p = plugin();
    if (!p || typeof p.savePdf !== 'function') return Promise.reject(new Error('pdf_unavailable'));
    var pages = [];
    try {
      for (var i = 0; i < opts.pages.length; i++) pages.push(encode(opts.pages[i]));
    } catch (e) {
      return Promise.reject(e);
    }
    var args = { pages: pages, filename: opts.filename || 'aorti-report.pdf' };
    if (opts.moments != null) {
      args.moments = opts.moments;
      args.week = !!opts.week;
    }
    return p.savePdf(args);
  }

  // ---- Worst-case synthetic day: 6 moments, 2 gaps, notes ----------------

  var INK = '#111';
  var INK2 = '#555';
  var INK3 = '#888';
  var RULE = '#bbb';
  var SLEEP = '#eceff3';
  var ZONE = ['#2f6f9f', '#b7791f', '#c0392b'];
  var FONT = 'Work Sans, system-ui, sans-serif';
  var MARGIN = 54;

  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function hm(m) { m = Math.round(m); return pad(Math.floor(m / 60) % 24) + ':' + pad(m % 60); }
  function rng(seed) {
    return function () {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
  }

  function syntheticDay() {
    var r = rng(4261);
    var gaps = [[134, 152, 'strap out of range'], [550, 560, 'recording stopped']];
    var sleep = [[0, 430]];
    var moments = [
      { n: 1, t: 485, kind: 'Standing', rise: 34, drop: -14, note: 'Stood up from the desk to make lunch.' },
      { n: 2, t: 702, kind: 'Symptom', rise: 41, drop: -18, note: 'Dizzy and warm after the shower.' },
      { n: 3, t: 860, kind: 'Symptom', rise: 27, drop: -11, note: 'Racing heart while sitting still.' },
      { n: 4, t: 963, kind: 'Standing', rise: 31, drop: -12, note: 'Second stand. Felt fine this time.' },
      { n: 5, t: 1110, kind: 'Rise', rise: 24, drop: -9, note: 'Climbed the stairs with laundry.' },
      { n: 6, t: 1260, kind: 'Calm', rise: 0, drop: 4, note: 'Lying on the couch, reading.' }
    ];
    var hr = [];
    var hrv = [];
    for (var m = 0; m < 1440; m++) {
      var gap = gaps.some(function (g) { return m >= g[0] && m < g[1]; });
      if (gap) { hr.push(null); hrv.push(null); continue; }
      var asleep = m < 430;
      var v = (asleep ? 64 : 90) + (r() - 0.5) * 8;
      var w = (asleep ? 46 : 28) + (r() - 0.5) * 8;
      moments.forEach(function (x) {
        var d = m - x.t;
        if (x.rise && d >= 0 && d < 25) { var k = d < 4 ? d / 4 : Math.max(0, 1 - (d - 4) / 21); v += x.rise * k; w += x.drop * k; }
      });
      hr.push(Math.round(v));
      hrv.push(Math.max(8, Math.round(w)));
    }
    return { date: 'Sunday, April 26, 2026', gaps: gaps, sleep: sleep, moments: moments, hr: hr, hrv: hrv };
  }

  function font(g, pt, weight) { g.font = (weight || 400) + ' ' + pt + 'px ' + FONT; }
  function text(g, s, x, y, pt, colour, weight, align) {
    font(g, pt, weight);
    g.fillStyle = colour || INK;
    g.textAlign = align || 'left';
    g.textBaseline = 'alphabetic';
    g.fillText(s, x, y);
  }
  function rule(g, x1, y, x2, colour, width) {
    g.strokeStyle = colour || RULE;
    g.lineWidth = width || 0.5;
    g.beginPath(); g.moveTo(x1, y); g.lineTo(x2, y); g.stroke();
  }
  function zone(v) { return v >= 120 ? ZONE[2] : v >= 100 ? ZONE[1] : ZONE[0]; }

  function hatch(g, x, y, w, h) {
    g.save();
    g.beginPath(); g.rect(x, y, w, h); g.clip();
    g.strokeStyle = INK3; g.lineWidth = 0.5;
    for (var k = -h; k < w + h; k += 4) { g.beginPath(); g.moveTo(x + k, y + h); g.lineTo(x + k + h, y); g.stroke(); }
    g.restore();
  }

  function circleNum(g, n, x, y, r, pt) {
    g.fillStyle = '#fff'; g.strokeStyle = INK; g.lineWidth = 1;
    g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill(); g.stroke();
    text(g, String(n), x, y + pt * 0.36, pt, INK, 600, 'center');
  }

  // HR line coloured by zone, HRV dashed below, sleep shaded, gaps hatched, over minutes [a, b).
  function chart(g, d, a, b, x, y, w, h, opts) {
    var lo = 40, hi = 170;
    var px = function (m) { return x + (m - a) / (b - a) * w; };
    var py = function (v) { return y + h - (v - lo) / (hi - lo) * h; };
    d.sleep.forEach(function (s) {
      var s0 = Math.max(a, s[0]), s1 = Math.min(b, s[1]);
      if (s1 > s0) { g.fillStyle = SLEEP; g.fillRect(px(s0), y, px(s1) - px(s0), h); }
    });
    d.gaps.forEach(function (s) {
      var s0 = Math.max(a, s[0]), s1 = Math.min(b, s[1]);
      if (s1 > s0) hatch(g, px(s0), y, px(s1) - px(s0), h);
    });
    [60, 100, 140].forEach(function (v) {
      rule(g, x, py(v), x + w, '#e2e2e2', 0.5);
      text(g, String(v), x - 4, py(v) + 2.5, 7, INK2, 400, 'right');
    });
    g.lineWidth = 1.2;
    for (var m = a + 1; m < b; m++) {
      if (d.hr[m] == null || d.hr[m - 1] == null) continue;
      g.strokeStyle = zone(d.hr[m]);
      g.beginPath(); g.moveTo(px(m - 1), py(d.hr[m - 1])); g.lineTo(px(m), py(d.hr[m])); g.stroke();
    }
    g.save();
    g.setLineDash([3, 2]); g.strokeStyle = INK2; g.lineWidth = 0.8;
    var hy = function (v) { return y + h + opts.hrvH - v / 80 * opts.hrvH; };
    g.beginPath();
    var pen = false;
    for (var k = a; k < b; k++) {
      if (d.hrv[k] == null) { pen = false; continue; }
      if (pen) g.lineTo(px(k), hy(d.hrv[k])); else { g.moveTo(px(k), hy(d.hrv[k])); pen = true; }
    }
    g.stroke();
    g.restore();
    rule(g, x, y + h, x + w, INK, 0.5);
    var step = opts.tick;
    for (var t = Math.ceil(a / step) * step; t <= b; t += step) {
      text(g, hm(t % 1440 === 0 && t > 0 ? 0 : t), px(t), y + h + opts.hrvH + 10, 7, INK2, 400, 'center');
    }
    return { px: px, py: py };
  }

  function page1(d, total, stamp) {
    var c = newPage(false);
    var g = c.getContext('2d');
    var L = MARGIN, R = PT_W - MARGIN, W = R - L;
    var y = 46;
    text(g, 'Heart rate report', L, y, 7, INK2);
    text(g, 'Print proof, synthetic day', R, y, 7, INK2, 400, 'right');
    rule(g, L, y + 5, R);
    y += 30;
    text(g, d.date, L, y, 15, INK, 600);
    y += 15;
    text(g, '00:00 to 24:00', L, y, 9, INK);
    y += 13;
    text(g, 'Recorded 23 h 32 min of 24 h · 2 gaps: 02:14 to 02:32 strap out of range, 09:10 to 09:20 recording stopped', L, y, 7.5, INK2);
    y += 22;
    text(g, 'Day', L, y, 9, INK, 600);
    rule(g, L, y + 4, R, INK, 0.8);
    y += 14;
    var cx = L + 20, cw = W - 20, ch = 150;
    var map = chart(g, d, 0, 1440, cx, y, cw, ch, { hrvH: 34, tick: 180 });
    d.moments.forEach(function (x) {
      var pk = d.hr[x.t + 4] || d.hr[x.t];
      circleNum(g, x.n, map.px(x.t), Math.max(y + 7, map.py(pk) - 11), 6, 7);
    });
    y += ch + 34 + 22;
    var legend = ['HR, coloured by zone', 'HRV, dashed', 'Asleep, shaded', 'No recording, hatched', 'Moment number'];
    var lx = L;
    legend.forEach(function (s) { text(g, s, lx, y, 7, INK2); lx += W / legend.length; });
    rule(g, L, y - 9, R, '#ddd', 0.5);
    y += 24;
    text(g, 'Moments', L, y, 9, INK, 600);
    rule(g, L, y + 4, R, INK, 0.8);
    y += 16;
    var cols = [L, L + 26, L + 64, L + 120, L + 190, L + 250, R - 40];
    ['No.', 'Time', 'Kind', 'HR', 'HRV', 'Note', 'Page'].forEach(function (h, i) { text(g, h, cols[i], y, 7, INK2, 500); });
    rule(g, L, y + 4, R);
    y += 15;
    d.moments.forEach(function (x) {
      var start = d.hr[x.t - 1] || d.hr[x.t];
      var peak = d.hr[x.t + 4] || start;
      text(g, String(x.n), cols[0], y, 8, INK, 600);
      text(g, hm(x.t), cols[1], y, 8);
      text(g, x.kind, cols[2], y, 8, INK, 600);
      text(g, x.rise ? start + ' to ' + peak : String(start), cols[3], y, 8);
      text(g, (x.drop > 0 ? '+' : '') + x.drop + ' ms', cols[4], y, 8);
      text(g, x.note, cols[5], y, 8);
      text(g, String(2 + Math.floor((x.n - 1) / 2)), cols[6], y, 8);
      y += 14;
    });
    y += 14;
    text(g, 'Awake and asleep', L, y, 9, INK, 600);
    rule(g, L, y + 4, R, INK, 0.8);
    y += 16;
    var colX = [L, L + 140, L + 260, L + 380];
    ['', 'Awake', 'Asleep', 'All'].forEach(function (h, i) { text(g, h, colX[i], y, 7, INK2, 500); });
    y += 14;
    [['Lowest HR', '76', '57', '57'], ['Typical HR', '91', '64', '84'], ['Highest HR', '131', '71', '131'],
      ['Time above your line', '1 h 12 min', '0 min', '1 h 12 min'], ['HRV against usual', 'below usual', 'within usual', 'below usual']]
      .forEach(function (row) {
        row.forEach(function (s, i) { text(g, s, colX[i], y, 8, i ? INK : INK2); });
        y += 13;
      });
    rule(g, L, PT_H - 48, R);
    text(g, 'Page 1 of ' + total + ' · Coospo H808S · Exported ' + stamp, L, PT_H - 36, 7, INK2);
    return c;
  }

  function momentBlock(g, d, x, top) {
    var L = MARGIN, R = PT_W - MARGIN, W = R - L;
    var before = x.kind === 'Standing' ? 5 : 10, after = x.kind === 'Standing' ? 10 : 20;
    var a = x.t - before, b = x.t + after;
    var y = top;
    circleNum(g, x.n, L + 9, y - 4, 9, 9);
    text(g, x.kind, L + 26, y, 11, INK, 600);
    text(g, hm(x.t), L + 26 + 70, y, 9, INK);
    text(g, 'Back to page 1', R, y, 7, INK2, 400, 'right');
    y += 13;
    text(g, before + ' min before, ' + after + ' min after', L + 26, y, 7, INK2);
    y += 12;
    g.fillStyle = '#f1f1f1'; g.fillRect(L, y, W, 8);
    g.fillStyle = INK; g.fillRect(L + a / 1440 * W, y, Math.max(2, (b - a) / 1440 * W), 8);
    [0, 360, 720, 1080, 1440].forEach(function (t) { text(g, hm(t === 1440 ? 0 : t), L + t / 1440 * W, y + 17, 7, INK2, 400, 'center'); });
    y += 30;
    var map = chart(g, d, a, b, L + 20, y, W - 20, 120, { hrvH: 30, tick: 5 });
    var start = d.hr[x.t - 1] || d.hr[x.t], peakM = x.t, endM = b - 1;
    for (var m = x.t; m < b; m++) if (d.hr[m] != null && d.hr[m] > d.hr[peakM]) peakM = m;
    [[x.t, 'Start ' + start], [peakM, 'Peak ' + d.hr[peakM] + ' at ' + hm(peakM)], [endM, 'End ' + d.hr[endM]]].forEach(function (cl, i) {
      var vx = map.px(cl[0]), vy = map.py(d.hr[cl[0]] || start);
      g.fillStyle = INK; g.beginPath(); g.arc(vx, vy, 1.8, 0, Math.PI * 2); g.fill();
      text(g, cl[1], vx, vy - 6, 7, INK, 500, i === 2 ? 'right' : i === 0 ? 'left' : 'center');
    });
    y += 120 + 30 + 24;
    if (x.kind === 'Standing') {
      var cols = ['Before', '1 min', '3 min', '5 min', '10 min', 'Peak'];
      var vals = [start, d.hr[x.t + 1], d.hr[x.t + 3], d.hr[x.t + 5], d.hr[x.t + 9], d.hr[peakM]];
      cols.forEach(function (h, i) {
        text(g, h, L + i * 70, y, 7, INK2, 500);
        text(g, String(vals[i]), L + i * 70, y + 12, 8, INK);
      });
      y += 26;
    } else {
      text(g, hm(x.t) + '  HR starts at ' + start + '.', L, y, 8, INK);
      text(g, hm(peakM) + '  HR peaks at ' + d.hr[peakM] + '.', L, y + 12, 8, INK);
      y += 26;
    }
    text(g, 'Note', L, y, 7, INK2, 500);
    text(g, x.note, L + 30, y, 9, INK);
    return y;
  }

  function momentPage(d, pair, no, total, stamp) {
    var c = newPage(false);
    var g = c.getContext('2d');
    var L = MARGIN, R = PT_W - MARGIN;
    text(g, d.date + ' · moments', L, 46, 7, INK2);
    text(g, 'Print proof, synthetic day', R, 46, 7, INK2, 400, 'right');
    rule(g, L, 51, R);
    momentBlock(g, d, pair[0], 86);
    if (pair[1]) {
      rule(g, L, 412, R, RULE, 0.5);
      momentBlock(g, d, pair[1], 446);
    }
    rule(g, L, PT_H - 48, R);
    text(g, 'Page ' + no + ' of ' + total + ' · Coospo H808S · Exported ' + stamp, L, PT_H - 36, 7, INK2);
    return c;
  }

  // opts: { share?: true }. Pages are drawn and encoded one at a time.
  function proof(opts) {
    opts = opts || {};
    var d = syntheticDay();
    var total = pageCount(d.moments.length, false);
    var now = new Date();
    var stamp = now.getFullYear() + '-' + pad(now.getMonth() + 1) + '-' + pad(now.getDate()) + ' ' + pad(now.getHours()) + ':' + pad(now.getMinutes());
    var p = plugin();
    if (!p || typeof p.printPdf !== 'function') return Promise.reject(new Error('pdf_unavailable'));
    var pages = [];
    try {
      pages.push(encode(page1(d, total, stamp)));
      for (var i = 0; i < d.moments.length; i += 2) {
        pages.push(encode(momentPage(d, [d.moments[i], d.moments[i + 1]], 2 + i / 2, total, stamp)));
      }
    } catch (e) {
      return Promise.reject(e);
    }
    var started = Date.now();
    return withCeiling(p.printPdf({
      pages: pages,
      filename: 'aorti-proof-' + stamp.slice(0, 10) + '.pdf',
      moments: d.moments.length,
      week: false,
      share: opts.share !== false
    })).then(function (r) {
      r.startedMs = started;
      r.endedMs = Date.now();
      r.expectedPages = total;
      return r;
    });
  }

  window.__aortiNativePdf = { available: available, canSave: canSave, pageCount: pageCount, newPage: newPage, print: print, save: save, proof: proof };
})();
