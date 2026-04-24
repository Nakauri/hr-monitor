// widget.js — shared widget chart configs for hr_monitor.html and overlay.html.
// Chart.js init code that must render identically on both surfaces lives here
// exactly once. Page-specific charts (main session chart, inline-trend, rsa,
// session-viewer charts) stay in their respective files.
//
// Pages load this after Chart.js. Exposes window.HRWidget.
(function() {
  'use strict';

  const STAGE_COLORS = {
    'stage-low':      '#7DB8E8',
    'stage-normal':   '#B8D97E',
    'stage-elevated': '#F0C75E',
    'stage-high':     '#E89858',
    'stage-critical': '#E24B4A',
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
    return new Chart(canvasCtx, {
      type: 'line',
      data: { datasets: [{ data: [], borderColor: '#B8D97E', backgroundColor: 'rgba(184,217,126,0.12)', tension: 0, cubicInterpolationMode: 'monotone', pointRadius: 0, borderWidth: 1.75, fill: true }] },
      options: { ...baseOpts, scales: { x: { type: 'linear', display: false, min: 0, max: 45 }, y: { display: false, grace: '12%' } } },
    });
  }

  // 3-min HR + RMSSD dual-line trend across the full width at the bottom of
  // the compact widget. Defaults min:0 max:3 so the first few data points
  // stick to the left edge and the line grows rightward.
  function createCompactTrendChart(canvasCtx) {
    return new Chart(canvasCtx, {
      type: 'line',
      data: { datasets: [
        { label: 'HR', data: [], borderColor: '#E89858', backgroundColor: 'transparent', yAxisID: 'y', tension: 0.4, pointRadius: 0, borderWidth: 1.5 },
        { label: 'RMSSD', data: [], borderColor: '#d8d8d8', backgroundColor: 'transparent', yAxisID: 'y1', tension: 0.4, pointRadius: 0, borderWidth: 1.3, borderDash: [3, 3] },
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

  function hexToRgba(hex, alpha) {
    const n = parseInt(hex.slice(1), 16);
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

  window.HRWidget = {
    STAGE_COLORS,
    createLiveTraceChart,
    createCompactTrendChart,
    tintChart,
    hexToRgba,
  };
})();
