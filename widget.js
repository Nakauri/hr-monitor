// widget.js — shared widget chart configs for hr_monitor.html, overlay.html
// and the landing hero. Chart.js init code and widget tables that must render
// identically on every surface live here exactly once. Page-specific charts
// (main session chart, inline-trend, rsa, session-viewer charts) stay in
// their respective files.
//
// Pages load tokens.css, then this after Chart.js. Exposes window.HRWidget.
(function() {
  'use strict';

  // Reads a token from tokens.css. The widget re-declares the set, so read
  // there first: a page's own :root may still override a name.
  function tok(name) {
    const el = document.getElementById('hr-widget') || document.documentElement;
    return getComputedStyle(el).getPropertyValue('--' + name).trim();
  }

  const STAGE_TOKEN = {
    'stage-low': 'stage-1',
    'stage-normal': 'stage-2',
    'stage-elevated': 'stage-3',
    'stage-high': 'stage-4',
    'stage-critical': 'stage-5',
  };
  const STAGE_COLORS = {};
  Object.keys(STAGE_TOKEN).forEach((k) => {
    Object.defineProperty(STAGE_COLORS, k, { enumerable: true, get: () => tok(STAGE_TOKEN[k]) });
  });

  const STAGE_PIPS = { 'stage-low': 1, 'stage-normal': 2, 'stage-elevated': 3, 'stage-high': 4, 'stage-critical': 5 };

  const WARN_ICONS = {
    'warn-high': '<svg viewBox="0 0 24 24"><polyline points="17 11 12 6 7 11"></polyline><polyline points="17 17 12 12 7 17"></polyline></svg>',
    'warn-low': '<svg viewBox="0 0 24 24"><polyline points="7 13 12 18 17 13"></polyline><polyline points="7 7 12 12 17 7"></polyline></svg>',
    'warn-crash': '<svg viewBox="0 0 24 24"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path><line x1="12" y1="9" x2="12" y2="13"></line><line x1="12" y1="17" x2="12.01" y2="17"></line></svg>',
    'warn-palp': '<svg viewBox="0 0 24 24"><path d="M3 12h4l2-8 4 16 2-8h6"></path></svg>',
    'status-reconnecting': '<svg viewBox="0 0 24 24"><path d="M21 12a9 9 0 1 1-3-6.7"/><polyline points="21 3 21 9 15 9"/></svg>',
  };
  const WARN_TEXT = {
    'warn-high': 'Heart rate high',
    'warn-low': 'Heart rate low',
    'warn-crash': 'HRV crashed',
    'warn-palp': 'Ectopics high',
    'status-reconnecting': 'Reconnecting…',
  };

  const baseOpts = {
    responsive: true, maintainAspectRatio: false, animation: false,
    plugins: { legend: { display: false }, tooltip: { enabled: false } },
    scales: { x: { type: 'linear', display: false }, y: { display: false, grace: '8%' } },
  };

  // 45-second per-beat HR trace drawn on the left column of the compact widget.
  // Monotone cubic + borderWidth 1.75 stop the line from overshooting its
  // vertical bounds (otherwise it bleeds into the pips row below).
  function createLiveTraceChart(canvasCtx) {
    const c = STAGE_COLORS['stage-normal'];
    return new Chart(canvasCtx, {
      type: 'line',
      data: { datasets: [{ data: [], borderColor: c, backgroundColor: hexToRgba(c, 0.12), tension: 0, cubicInterpolationMode: 'monotone', pointRadius: 0, borderWidth: 1.75, fill: true }] },
      options: { ...baseOpts, scales: { x: { type: 'linear', display: false, min: 0, max: 45 }, y: { display: false, grace: '12%' } } },
    });
  }

  // 3-min HR + RMSSD dual-line trend across the full width at the bottom of
  // the compact widget. HR is coloured per segment by the zone of the
  // segment's end point; stageOf(hr) returns a stage class. RMSSD is white
  // dashed. Defaults min:0 max:3 so the first points stick to the left edge.
  function createCompactTrendChart(canvasCtx, stageOf) {
    const zone = typeof stageOf === 'function' ? stageOf : () => 'stage-normal';
    // Colours are read once per update, not once per segment.
    const colours = {};
    const readColours = () => { for (const k of Object.keys(STAGE_TOKEN)) colours[k] = STAGE_COLORS[k]; };
    readColours();
    return new Chart(canvasCtx, {
      type: 'line',
      plugins: [{ id: 'zoneColours', beforeUpdate: readColours }],
      data: { datasets: [
        { label: 'HR', data: [], borderColor: colours['stage-normal'], backgroundColor: 'transparent', yAxisID: 'y', tension: 0.4, pointRadius: 0, borderWidth: 1.5,
          segment: { borderColor: (s) => colours[zone(s.p1.parsed.y)] || colours['stage-normal'] } },
        { label: 'RMSSD', data: [], borderColor: tok('text'), backgroundColor: 'transparent', yAxisID: 'y1', tension: 0.4, pointRadius: 0, borderWidth: 1.3, borderDash: [3, 3] },
      ] },
      options: {
        responsive: true, maintainAspectRatio: false, animation: false,
        plugins: { legend: { display: false }, tooltip: { enabled: false } },
        scales: {
          x: { type: 'linear', display: false, min: 0, max: 3 },
          y: { display: false },
          y1: { position: 'right', display: false },
        },
      },
    });
  }

  // Zone bands for a receiver that only sees (hr, hrStage) pairs, such as the
  // overlay. Starts at the monitor defaults and moves a band edge whenever a
  // tick contradicts it, so it settles on the sender's own thresholds.
  function zoneLearner() {
    const edge = { low: 70, normal: 90, elevated: 110, high: 130 };
    function stageOf(hr) {
      if (hr == null) return 'stage-normal';
      if (hr <= edge.low) return 'stage-low';
      if (hr < edge.normal) return 'stage-normal';
      if (hr < edge.elevated) return 'stage-elevated';
      if (hr < edge.high) return 'stage-high';
      return 'stage-critical';
    }
    function learn(hr, stage) {
      if (!Number.isFinite(hr) || !STAGE_PIPS[stage] || stageOf(hr) === stage) return;
      const r = STAGE_PIPS[stage];
      if (r === 1) edge.low = Math.max(edge.low, hr);
      if (r > 1) edge.low = Math.min(edge.low, hr - 1);
      if (r === 2) edge.normal = Math.max(edge.normal, hr + 1);
      if (r > 2) edge.normal = Math.min(edge.normal, hr);
      if (r === 3) edge.elevated = Math.max(edge.elevated, hr + 1);
      if (r > 3) edge.elevated = Math.min(edge.elevated, hr);
      if (r === 4) edge.high = Math.max(edge.high, hr + 1);
      if (r > 4) edge.high = Math.min(edge.high, hr);
    }
    return { stageOf, learn };
  }

  function hexToRgba(hex, alpha) {
    const n = parseInt(String(hex).trim().slice(1), 16);
    return 'rgba(' + ((n >> 16) & 0xff) + ',' + ((n >> 8) & 0xff) + ',' + (n & 0xff) + ',' + alpha + ')';
  }

  // Recolour a single-dataset chart to match the current HR stage. Creates a
  // vertical gradient fill anchored to the line colour; falls back to a flat
  // tint if the 2D context isn't ready yet.
  function tintChart(chart, color) {
    if (!chart || !color) return;
    const ds = chart.data.datasets[0];
    ds.borderColor = color;
    try {
      const ctx = chart.ctx;
      const g = ctx.createLinearGradient(0, 0, 0, chart.height || 100);
      g.addColorStop(0, hexToRgba(color, 0.32));
      g.addColorStop(1, hexToRgba(color, 0));
      ds.backgroundColor = g;
    } catch (e) {
      ds.backgroundColor = hexToRgba(color, 0.12);
    }
    try { chart.update('none'); } catch (e) {}
  }

  // Sets the body.phone-widget layout from the 480 px query. The monitor and
  // the landing call it; the overlay never does.
  function watchPhoneLayout() {
    const mq = window.matchMedia('(max-width: 480px)');
    const apply = () => {
      document.documentElement.classList.toggle('phone-widget', mq.matches);
      if (document.body) document.body.classList.toggle('phone-widget', mq.matches);
    };
    apply();
    if (!document.body) document.addEventListener('DOMContentLoaded', apply);
    if (mq.addEventListener) mq.addEventListener('change', apply); else mq.addListener(apply);
  }

  window.HRWidget = {
    tok,
    STAGE_COLORS,
    STAGE_PIPS,
    WARN_ICONS,
    WARN_TEXT,
    createLiveTraceChart,
    createCompactTrendChart,
    zoneLearner,
    tintChart,
    hexToRgba,
    watchPhoneLayout,
  };
})();
