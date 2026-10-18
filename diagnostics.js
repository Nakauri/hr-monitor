// diagnostics.js — shared across hr_monitor.html and hrv_viewer.html.
// Surfaces build version + runtime state so the user can verify which APK
// is running and which shims are active. Replaces "uninstall + pray + retry"
// with "open diagnostics, read the truth."
//
// Usage:
//   <script src="./diagnostics.js"></script>
//   HRMDiagnostics.mountChip('#version-chip-target'); // inserts a clickable chip
//   HRMDiagnostics.open();                             // opens the modal
//
// Zero dependencies.

(function() {
  'use strict';

  const REPO = 'Nakauri/hr-monitor';
  let cachedVersion = null;

  // Demo mode is a clean public sandbox. The diagnostics modal must not
  // reveal the visitor's own account email, Drive cache size, or broadcast
  // key state when the page was loaded with ?demo=1.
  function isDemoView() {
    try {
      const u = new URL(location.href);
      return u.searchParams.get('demo') === '1' || /(?:^|[?&#])demo=1/.test(location.hash);
    } catch (e) { return false; }
  }

  // ----- Persistent log buffer ------------------------------------------
  // Ring buffer of the last 300 entries, persisted to localStorage so a
  // native Android crash + restart still surfaces the prelude. Anything
  // routed through HRMLog.* shows up in the diagnostics modal's "Recent
  // events" section and in the clipboard copy. Plus we hook window.onerror
  // and onunhandledrejection so uncaught failures land here automatically.
  const LOG_KEY = 'hrm_log_v1';
  const LOG_MAX = 300;
  function readLog() {
    try { return JSON.parse(localStorage.getItem(LOG_KEY) || '[]'); }
    catch (e) { return []; }
  }
  function writeLog(arr) {
    try { localStorage.setItem(LOG_KEY, JSON.stringify(arr)); } catch (e) {}
  }
  function appendLog(level, msg, ctx) {
    const arr = readLog();
    arr.push({
      t: Date.now(),
      level: level,
      msg: String(msg == null ? '' : msg).slice(0, 500),
      ctx: ctx == null ? null : (typeof ctx === 'string' ? ctx.slice(0, 200) : ctx),
    });
    while (arr.length > LOG_MAX) arr.shift();
    writeLog(arr);
  }
  try {
    window.addEventListener('error', function (e) {
      appendLog('error', (e && e.message ? e.message : 'uncaught error') +
        ' @ ' + (e && e.filename ? e.filename.split('/').pop() : '?') +
        ':' + (e && e.lineno ? e.lineno : '?'));
    });
    window.addEventListener('unhandledrejection', function (e) {
      const r = e && e.reason;
      const rmsg = r && r.message ? r.message : String(r);
      appendLog('error', 'unhandled rejection: ' + rmsg);
    });
  } catch (err) { /* ignore: very old browser */ }
  window.HRMLog = {
    error: function (msg, ctx) { appendLog('error', msg, ctx); },
    warn:  function (msg, ctx) { appendLog('warn', msg, ctx); },
    info:  function (msg, ctx) { appendLog('info', msg, ctx); },
    event: function (tag, data) { appendLog('event', tag, data); },
    drain: function () { return readLog(); },
    clear: function () { writeLog([]); },
  };

  function detect() {
    const cap = window.Capacitor || null;
    const isNative = !!(cap && cap.isNativePlatform && cap.isNativePlatform());
    const platform = cap && cap.getPlatform ? cap.getPlatform() : 'web';
    const nativeDriveSignIn = typeof window.__hrMonitorNativeDriveSignIn === 'function';
    const bleAdapter = isNative && !!navigator.bluetooth && !!navigator.bluetooth.__capacitorPatched;
    const webBluetooth = !isNative && !!navigator.bluetooth;
    const blePresent = !!navigator.bluetooth;
    const blePlugin = !!(cap && cap.Plugins && cap.Plugins.BluetoothLe);
    const bleRegistered = isNative && cap && typeof cap.registerPlugin === 'function';
    return {
      platform,
      isNative,
      runtime: isNative ? ('Capacitor · ' + platform) : 'Web browser',
      blePresent,
      bleWeb: webBluetooth,
      bleAdapterPatched: bleAdapter,
      bleAdapterLoaded: !!window.__hrMonitorBleAdapterLoaded,
      bleAdapterRanInit: !!window.__hrMonitorBleAdapterRanInit,
      bleAdapterSawCapacitor: !!window.__hrMonitorBleAdapterCapacitorAvailable,
      bleAdapterPlatform: window.__hrMonitorBleAdapterPlatform || null,
      bleAdapterIsNative: !!window.__hrMonitorBleAdapterIsNative,
      bleAdapterGotPlugin: !!window.__hrMonitorBleAdapterGotPlugin,
      bleAdapterPatchedMarker: !!window.__hrMonitorBleAdapterPatched,
      bleAdapterLastError: window.__hrMonitorBleAdapterLastError || null,
      bleCapacitorPlugin: blePlugin || bleRegistered,
      driveNativeOverride: nativeDriveSignIn,
      driveAuthLoaded: !!window.__hrMonitorDriveAuthLoaded,
      driveAuthRanInit: !!window.__hrMonitorDriveAuthRanInit,
      driveAuthIsNative: !!window.__hrMonitorDriveAuthIsNative,
      driveAuthGotPlugin: !!window.__hrMonitorDriveAuthGotPlugin,
      driveAuthRegistered: !!window.__hrMonitorDriveAuthRegistered,
      driveAuthLastError: window.__hrMonitorDriveAuthLastError || null,
      fgsLoaded: !!window.__hrMonitorFgsLoaded,
      fgsRanInit: !!window.__hrMonitorFgsRanInit,
      fgsGotPlugin: !!window.__hrMonitorFgsGotPlugin,
      fgsRegistered: !!window.__hrMonitorFgsRegistered,
      fgsStarted: !!window.__hrMonitorFgsStarted,
      fgsPermission: window.__hrMonitorFgsPermission || null,
      fgsLastError: window.__hrMonitorFgsLastError || null,
      // HrEngine's own FGS (NativeHrService) — the actual one
      // that runs during a session. The @capawesome FGS plugin above is
      // legacy / never started on the session path.
      nativeFgsRunning: !!(window.HRMNativeHrSession && window.HRMNativeHrSession.isPublishing && window.HRMNativeHrSession.isPublishing()),
      sessionShimMarker: window.__hrMonitorNativeHrSessionRanInit === undefined ? null : String(window.__hrMonitorNativeHrSessionRanInit),
      sessionShimAvailable: !!(window.HRMNativeHrSession && window.HRMNativeHrSession.isAvailable),
      sessionShimMode: (window.HRMNativeHrSession && window.HRMNativeHrSession.mode) || null,
      sessionShimSegments: !!(window.HRMNativeHrSession && typeof window.HRMNativeHrSession.listSegments === 'function'),
      battoptLoaded: !!window.__hrMonitorBatteryOptLoaded,
      battoptRanInit: !!window.__hrMonitorBatteryOptRanInit,
      battoptGotPlugin: !!window.__hrMonitorBatteryOptGotPlugin,
      battoptRegistered: !!window.__hrMonitorBatteryOptRegistered,
      battoptLastError: window.__hrMonitorBatteryOptLastError || null,
      wakeLockLoaded: !!window.__hrMonitorWakeLockLoaded,
      wakeLockRanInit: !!window.__hrMonitorWakeLockRanInit,
      wakeLockGotPlugin: !!window.__hrMonitorWakeLockGotPlugin,
      wakeLockRegistered: !!window.__hrMonitorWakeLockRegistered,
      wakeLockLastError: window.__hrMonitorWakeLockLastError || null,
      oemLoaded: !!window.__hrMonitorOemLoaded,
      oemRanInit: !!window.__hrMonitorOemRanInit,
      oemGotPlugin: !!window.__hrMonitorOemGotPlugin,
      oemRegistered: !!window.__hrMonitorOemRegistered,
      oemVendor: (window.HRMOem && window.HRMOem.vendor) || null,
      oemManufacturer: (window.HRMOem && window.HRMOem.manufacturer) || null,
      oemHasKnownKiller: !!(window.HRMOem && window.HRMOem.hasKnownBackgroundKiller),
      oemLastError: window.__hrMonitorOemLastError || null,
      userAgent: navigator.userAgent,
      demoView: isDemoView(),
      localBroadcastKey: isDemoView() ? false : !!localStorage.getItem('hr_monitor_broadcast_key'),
      driveSignedIn: isDemoView() ? false : !!(window.aortiAuth && window.aortiAuth.isSignedIn()),
      driveEmail: isDemoView() ? null : ((window.aortiAuth && window.aortiAuth.getEmail()) || null),
      driveMetaCount: (function () {
        if (isDemoView()) return 0;
        try {
          const raw = localStorage.getItem('hrv_viewer_drive_meta');
          if (!raw) return 0;
          return Object.keys(JSON.parse(raw)).length;
        } catch (e) { return -1; }
      })(),
      // S63: the Day report's sleep split weights, set once per device from the console.
      sleepWeights: (function () {
        try { return localStorage.getItem('hrv_viewer_sleep_weights') === 'personal' ? 'personal' : 'general'; } catch (e) { return 'general'; }
      })(),
      marks: (function () {
        if (isDemoView() || !window.AortiMarksPage || typeof window.AortiMarksPage.diag !== 'function') return null;
        try { return window.AortiMarksPage.diag(); } catch (e) { return null; }
      })(),
      driveLastSync: (function () {
        if (isDemoView()) return null;
        try {
          const t = parseInt(localStorage.getItem('hrv_viewer_drive_lastsync') || '0', 10);
          if (!t) return null;
          return new Date(t).toISOString().slice(0, 19).replace('T', ' ');
        } catch (e) { return null; }
      })(),
    };
  }

  async function fetchVersion() {
    if (cachedVersion) return cachedVersion;
    try {
      const r = await fetch('https://api.github.com/repos/' + REPO + '/releases/tags/android-latest', { cache: 'no-store' });
      if (!r.ok) return null;
      const rel = await r.json();
      const body = rel.body || '';
      const shaMatch = body.match(/commit\s+([0-9a-f]{7,40})/i);
      const apk = (rel.assets || []).find(a => a.name === 'hr-monitor.apk');
      const stamp = (apk && apk.updated_at) || rel.updated_at || rel.published_at;
      cachedVersion = {
        sha: shaMatch ? shaMatch[1] : null,
        shortSha: shaMatch ? shaMatch[1].slice(0, 7) : null,
        builtAt: stamp ? new Date(stamp) : null,
        signed: /signed:\s*true/i.test(body),
      };
      return cachedVersion;
    } catch (e) { return null; }
  }

  function fmt(d) {
    if (!(d instanceof Date) || isNaN(d)) return '—';
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
      + ' · '
      + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  }

  function formatLogTime(ts) {
    const d = new Date(ts);
    const pad = n => String(n).padStart(2, '0');
    return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
  }
  function formatLog(entries) {
    if (!entries || !entries.length) return '';
    return entries.map(e => {
      const level = (e.level || 'info').toUpperCase().padEnd(5);
      const ctx = e.ctx ? '  ' + (typeof e.ctx === 'string' ? e.ctx : JSON.stringify(e.ctx)) : '';
      return formatLogTime(e.t) + '  ' + level + '  ' + e.msg + ctx;
    }).join('\n');
  }

  function injectStyles() {
    if (document.getElementById('hrm-diagnostics-styles')) return;
    const s = document.createElement('style');
    s.id = 'hrm-diagnostics-styles';
    s.textContent = `
      /* Avatar + version label — tiny, unobtrusive. Avatar is the click
         target (will become the account menu in Phase D); version label
         beside it is informational only. Full build details live in the
         hover tooltip + the diagnostics modal opened on click. */
      .hrm-user-chip {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        padding: 0;
        background: transparent;
        border: none;
        cursor: pointer;
        text-decoration: none;
        color: inherit;
        font-family: inherit;
      }
      .hrm-user-avatar {
        width: 28px; height: 28px;
        border-radius: 50%;
        display: flex; align-items: center; justify-content: center;
        background: #1a1a1a;
        border: 1px solid rgba(255,255,255,0.14);
        color: var(--text-dim, #8a8a8a);
        transition: border-color 0.15s, color 0.15s, background 0.15s;
        flex-shrink: 0;
      }
      .hrm-user-chip:hover .hrm-user-avatar {
        border-color: var(--hrv, #5DCAA5);
        color: var(--hrv, #5DCAA5);
        background: #202020;
      }
      .hrm-user-avatar svg { width: 16px; height: 16px; }
      .hrm-user-avatar.fresh { border-color: #F0C75E; color: #F0C75E; }
      .hrm-version-label {
        font-size: 9px;
        letter-spacing: 0.06em;
        color: var(--text-dim, #5a5a5a);
        font-family: 'Consolas', 'Monaco', monospace;
        text-transform: none;
      }
      .hrm-user-chip:hover .hrm-version-label { color: var(--text-dim, #8a8a8a); }

      .hrm-diag .sheet { max-width: 600px; }
      .hrm-diag-legal-strip { margin: 0 0 var(--s3); }
      .hrm-diag-legal-strip a { display: inline-flex; align-items: center; min-height: 44px; color: var(--text); font-size: var(--t12); }
      .hrm-diag-section { margin: 0; border-top: 1px solid var(--border); }
      .hrm-diag-section > summary {
        display: flex; align-items: center; gap: var(--s2); min-height: 44px;
        font-size: var(--t14); font-weight: 600; color: var(--text); cursor: pointer; list-style: none;
        user-select: none; -webkit-user-select: none;
      }
      .hrm-diag-section > summary::-webkit-details-marker { display: none; }
      .hrm-diag-section > summary .ico { color: var(--text-dim); transform: rotate(-90deg); }
      .hrm-diag-section[open] > summary .ico { transform: none; }
      .hrm-diag-row {
        display: flex; justify-content: space-between; gap: var(--s3);
        padding: 6px 0; border-bottom: 1px solid var(--border);
        font-size: var(--t12);
      }
      .hrm-diag-row:last-child { border-bottom: none; }
      .hrm-diag-row .k { color: var(--text-dim); }
      .hrm-diag-row .v { color: var(--text); font-family: var(--mono); text-align: right; max-width: 280px; word-break: break-word; }
      .hrm-diag-row .v.ok { color: var(--live); }
      .hrm-diag-row .v.warn { color: var(--stage-3); }
      .hrm-diag-row .v.err { color: var(--warn-high); }
      .hrm-diag-log {
        background: var(--bg); border: 1px solid var(--border); border-radius: var(--r-ctl);
        padding: var(--s2) var(--s3); margin: 0 0 var(--s3);
        font-family: var(--mono); font-size: var(--t12); line-height: 1.45;
        color: var(--text); max-height: 260px; overflow: auto; white-space: pre-wrap; word-break: break-word;
      }
      .hrm-diag-log:empty::before { content: 'no events logged yet'; color: var(--text-dim); }
      .hrm-diag-cache-actions, .hrm-diag-actions { display: flex; flex-wrap: wrap; gap: var(--s2); margin-top: var(--s3); }
      .hrm-diag-cache-actions .btn, .hrm-diag-actions .btn { flex: 1 1 140px; }
      .hrm-diag-note { margin: var(--s2) 0 var(--s3); font-size: var(--t12); color: var(--text-dim); line-height: 1.45; }
      .hrm-diag-pill {
        display: inline-block;
        padding: 3px 8px;
        font-size: 10px;
        font-family: 'Consolas', 'Monaco', monospace;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        text-decoration: none;
        color: #6a6a6a;
        border: 1px solid #2a2a2a;
        border-radius: 4px;
        background: transparent;
        transition: color 0.12s, border-color 0.12s;
      }
      .hrm-diag-pill:hover { color: #d8d8d8; border-color: #3a3a3a; }
    `;
    document.head.appendChild(s);
  }

  // Generic anonymous-user silhouette. Becomes a real profile picture when
  // Phase D's Google Sign-In wires up.
  const AVATAR_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="8" r="4"/><path d="M4 21v-2a6 6 0 0 1 6-6h4a6 6 0 0 1 6 6v2"/></svg>';

  async function mountChip(target) {
    // On Capacitor: full chip with avatar + version (BLE / FGS / battery /
    // OEM rows are meaningful there). On web: a discrete "diag" pill so
    // the user can still pop the modal to inspect Drive cache, auth trace,
    // sign-in state, etc. without devtools.
    injectStyles();
    const el = typeof target === 'string' ? document.querySelector(target) : target;
    if (!el) return;
    const cap = window.Capacitor;
    const isNative = !!(cap && cap.isNativePlatform && cap.isNativePlatform());

    const chip = document.createElement('a');
    chip.href = '#';
    chip.setAttribute('aria-label', 'App diagnostics');
    if (isNative) {
      chip.className = 'hrm-user-chip';
      chip.innerHTML = `
        <span class="hrm-user-avatar">${AVATAR_SVG}</span>
        <span class="hrm-version-label">v0.5</span>
      `;
    } else {
      chip.className = 'hrm-diag-pill';
      chip.textContent = 'diag';
      chip.title = 'App diagnostics + auth trace';
    }
    chip.addEventListener('click', (e) => { e.preventDefault(); open(); });
    el.innerHTML = '';
    el.appendChild(chip);

    const v = await fetchVersion();
    const avatar = chip.querySelector('.hrm-user-avatar');
    if (v && v.shortSha) {
      const when = v.builtAt ? fmt(v.builtAt) : '';
      chip.title = 'v0.5 · ' + v.shortSha + (when ? ' · ' + when : '') + '\nClick for diagnostics';
      if (avatar && !v.signed) avatar.classList.add('fresh');
    } else {
      chip.title = 'v0.5 · version unavailable (offline)\nClick for diagnostics';
    }
  }

  let current = null;

  async function open() {
    injectStyles();
    const d = detect();
    const v = await fetchVersion();
    close();

    const ok = (cond) => cond ? 'ok' : 'err';
    const yn = (cond) => cond ? 'yes' : 'no';
    const chevron = window.UI.icon('chevron');

    // openByDefault: sections that matter at first glance; the rest start collapsed.
    const openByDefault = new Set(['Build', 'Runtime', 'Google Drive shim (step-by-step)', 'Bluetooth shim (step-by-step)']);
    const rows = (title, items) => {
      const body = items.map(([k, v, cls]) => `<div class="hrm-diag-row"><span class="k">${esc(k)}</span><span class="v ${cls||''}">${esc(v)}</span></div>`).join('');
      const open = openByDefault.has(title) ? ' open' : '';
      return `<details class="hrm-diag-section"${open}><summary>${chevron}${esc(title)}</summary>${body}</details>`;
    };

    const content = `
        <div class="hrm-diag-legal-strip"><a href="./legal.html" target="_blank" rel="noopener">Legal &amp; disclaimers</a></div>
        ${rows('Build', [
          ['Version', v && v.shortSha ? 'v0.5 · ' + v.shortSha : 'v0.5 · offline'],
          ['Built', v && v.builtAt ? fmt(v.builtAt) : '—'],
          ['Signed APK', v ? yn(v.signed) : '—', v && v.signed ? 'ok' : 'warn'],
        ])}
        ${rows('Runtime', [
          ['Platform', d.runtime, 'ok'],
          ['Capacitor native', yn(d.isNative), d.isNative ? 'ok' : ''],
        ])}
        ${rows('Bluetooth shim (step-by-step)', [
          ['1. script loaded', yn(d.bleAdapterLoaded), d.isNative ? ok(d.bleAdapterLoaded) : ''],
          ['2. init ran', yn(d.bleAdapterRanInit), d.isNative ? ok(d.bleAdapterRanInit) : ''],
          ['3. saw Capacitor', yn(d.bleAdapterSawCapacitor), d.isNative ? ok(d.bleAdapterSawCapacitor) : ''],
          ['4. platform', d.bleAdapterPlatform || '—'],
          ['5. isNative()', yn(d.bleAdapterIsNative), d.isNative ? ok(d.bleAdapterIsNative) : ''],
          ['6. got plugin', yn(d.bleAdapterGotPlugin), d.isNative ? ok(d.bleAdapterGotPlugin) : ''],
          ['7. patched', yn(d.bleAdapterPatchedMarker), d.isNative ? ok(d.bleAdapterPatchedMarker) : ''],
          ['last error', d.bleAdapterLastError || 'none', d.bleAdapterLastError ? 'err' : 'ok'],
          ['navigator.bluetooth', yn(d.blePresent), ok(d.blePresent)],
        ])}
        ${rows('Google Drive shim (step-by-step)', [
          ['1. script loaded', yn(d.driveAuthLoaded), d.isNative ? ok(d.driveAuthLoaded) : ''],
          ['2. init ran', yn(d.driveAuthRanInit), d.isNative ? ok(d.driveAuthRanInit) : ''],
          ['3. isNative()', yn(d.driveAuthIsNative), d.isNative ? ok(d.driveAuthIsNative) : ''],
          ['4. got plugin', yn(d.driveAuthGotPlugin), d.isNative ? ok(d.driveAuthGotPlugin) : ''],
          ['5. registered', yn(d.driveAuthRegistered), d.isNative ? ok(d.driveAuthRegistered) : ''],
          ['last error', d.driveAuthLastError || 'none', d.driveAuthLastError ? 'err' : 'ok'],
          ['Native sign-in override', yn(d.driveNativeOverride), d.isNative ? ok(d.driveNativeOverride) : ''],
          ['Currently signed in', yn(d.driveSignedIn), d.driveSignedIn ? 'ok' : 'warn'],
          ['Account', d.driveEmail || '—', d.driveEmail ? 'ok' : ''],
          ['Viewer cache (sessions)', String(d.driveMetaCount), d.driveMetaCount > 0 ? 'ok' : ''],
          ['Last viewer sync', d.driveLastSync || 'never', d.driveLastSync ? 'ok' : ''],
        ])}
        ${d.marks ? rows('Marks', [
          ['Device', d.marks.device || '—'],
          ['Marks', String(d.marks.records)],
          ['Not on Drive', String(d.marks.dirty), d.marks.dirty ? 'warn' : 'ok'],
          ['Saved on this device', d.marks.persisted, d.marks.persisted === 'yes' ? 'ok' : 'warn'],
          ['Sync', d.marks.locks ? (d.marks.blocked ? 'Off, another account' : 'On') : 'Marks sync unavailable on this browser', d.marks.locks && !d.marks.blocked ? 'ok' : 'warn'],
          ['Unreadable files', String(d.marks.badFiles), d.marks.badFiles ? 'warn' : 'ok'],
          ['Skipped records', String(d.marks.badRecords), d.marks.badRecords ? 'warn' : 'ok'],
          ['Last error', d.marks.lastError || 'none', d.marks.lastError ? 'err' : 'ok'],
        ]) : ''}
        ${rows('Session shim', [
          ['init marker', d.sessionShimMarker || 'not loaded', d.isNative ? ok(d.sessionShimMarker === 'true' || d.sessionShimMarker === 'reader') : ''],
          ['isAvailable', yn(d.sessionShimAvailable), d.isNative ? ok(d.sessionShimAvailable) : ''],
          ['mode', d.sessionShimMode || '—', ''],
          ['phone recordings readable', yn(d.sessionShimSegments), d.isNative ? ok(d.sessionShimSegments) : ''],
        ])}
        ${rows('Foreground service (background recording)', [
          ['Native session FGS running', d.sessionShimMode === 'reader' ? 'skipped' : yn(d.nativeFgsRunning), d.isNative && d.sessionShimMode !== 'reader' ? ok(d.nativeFgsRunning) : ''],
          ['Legacy @capawesome plugin loaded', yn(d.fgsLoaded), ''],
          ['Legacy @capawesome started', yn(d.fgsStarted), ''],
          ['notification permission', (d.fgsPermission != null ? JSON.stringify(d.fgsPermission) : 'not required on this OS'), ''],
          ['last error', d.fgsLastError || 'none', d.fgsLastError ? 'err' : 'ok'],
        ])}
        ${rows('Battery optimisation', [
          ['1. script loaded', yn(d.battoptLoaded), d.isNative ? ok(d.battoptLoaded) : ''],
          ['2. init ran', yn(d.battoptRanInit), d.isNative ? ok(d.battoptRanInit) : ''],
          ['3. got plugin', yn(d.battoptGotPlugin), d.isNative ? ok(d.battoptGotPlugin) : ''],
          ['4. registered', yn(d.battoptRegistered), d.isNative ? ok(d.battoptRegistered) : ''],
          ['last error', d.battoptLastError || 'none', d.battoptLastError ? 'err' : 'ok'],
        ])}
        ${rows('Wake lock (CPU-on during session)', [
          ['1. script loaded', yn(d.wakeLockLoaded), d.isNative ? ok(d.wakeLockLoaded) : ''],
          ['2. init ran', yn(d.wakeLockRanInit), d.isNative ? ok(d.wakeLockRanInit) : ''],
          ['3. got plugin', yn(d.wakeLockGotPlugin), d.isNative ? ok(d.wakeLockGotPlugin) : ''],
          ['4. registered', yn(d.wakeLockRegistered), d.isNative ? ok(d.wakeLockRegistered) : ''],
          ['last error', d.wakeLockLastError || 'none', d.wakeLockLastError ? 'err' : 'ok'],
        ])}
        ${rows('OEM background killer', [
          ['1. script loaded', yn(d.oemLoaded), d.isNative ? ok(d.oemLoaded) : ''],
          ['2. init ran', yn(d.oemRanInit), d.isNative ? ok(d.oemRanInit) : ''],
          ['3. got plugin', yn(d.oemGotPlugin), d.isNative ? ok(d.oemGotPlugin) : ''],
          ['4. registered', yn(d.oemRegistered), d.isNative ? ok(d.oemRegistered) : ''],
          ['manufacturer', d.oemManufacturer || '—'],
          ['vendor', d.oemVendor || '—'],
          ['has known killer', yn(d.oemHasKnownKiller), d.oemHasKnownKiller ? 'warn' : 'ok'],
          ['last error', d.oemLastError || 'none', d.oemLastError ? 'err' : 'ok'],
        ])}
        ${rows('Relay', [
          ['Broadcast key set', yn(d.localBroadcastKey), d.localBroadcastKey ? 'ok' : 'warn'],
        ])}
        <details class="hrm-diag-section">
          <summary>${chevron}Local session cache</summary>
          <div class="hrm-diag-row"><span class="k">Files</span><span class="v" id="hrm-cache-count">…</span></div>
          <div class="hrm-diag-row"><span class="k">Size</span><span class="v" id="hrm-cache-bytes">…</span></div>
          <div class="hrm-diag-row"><span class="k">Oldest</span><span class="v" id="hrm-cache-oldest">…</span></div>
          <div class="hrm-diag-cache-actions" id="hrm-cache-actions">
            <button type="button" class="btn" id="hrm-cache-refresh">Refresh</button>
            <button type="button" class="btn" id="hrm-cache-clear">Clear cache</button>
          </div>
          <p class="hrm-diag-note">
            Auto-cleanup respects the user. Signed in to Drive: keeps 7 days local + 14-day fallback, capped at 200 MB. Not signed in: keeps the most recent 3 sessions only, capped at 50 MB. The 3-session floor always wins so the viewer is never empty.
          </p>
        </details>
        <details class="hrm-diag-section" open>
          <summary>${chevron}Auth trace (newest last)</summary>
          <pre class="hrm-diag-log" id="hrm-auth-trace"></pre>
        </details>
        <details class="hrm-diag-section" open>
          <summary>${chevron}Recent events (newest last)</summary>
          <pre class="hrm-diag-log" id="hrm-events-log">${esc(d.demoView ? 'hidden in demo mode' : formatLog(readLog()))}</pre>
        </details>
        <div class="hrm-diag-actions" id="hrm-diag-actions">
          <button type="button" class="btn primary" id="hrm-diag-copy">Copy to clipboard</button>
          <button type="button" class="btn" id="hrm-diag-clearlog">Clear events</button>
          <button type="button" class="btn" id="hrm-diag-clearauth">Clear auth state</button>
          <button type="button" class="btn" id="hrm-diag-purge">Purge app data</button>
          <button type="button" class="btn" id="hrm-diag-close">Close</button>
        </div>
    `;
    const sheet = window.UI.sheet({ id: 'hrm-diag-overlay', className: 'hrm-diag', title: 'App diagnostics', closeLabel: 'Close diagnostics', body: content,
      onClose: () => { if (current === sheet) current = null; } });
    current = sheet;
    const $ = (id) => sheet.root.querySelector('#' + id);

    $('hrm-diag-close').addEventListener('click', close);

    // Auth trace from localStorage (drive-auth-native.js and auth.js). Demo mode hides it: it can hold account hints.
    try {
      const tracePane = $('hrm-auth-trace');
      if (d.demoView) {
        tracePane.textContent = 'hidden in demo mode';
        $('hrm-events-log').textContent = 'hidden in demo mode';
      } else {
        const raw = localStorage.getItem('hrm_auth_trace');
        const arr = raw ? JSON.parse(raw) : [];
        tracePane.textContent = !arr.length ? 'no auth events yet' : arr.map(e => {
          const when = new Date(e.t).toISOString().slice(11, 23);
          const payload = e.payload != null ? ' ' + JSON.stringify(e.payload) : '';
          return when + '  ' + e.step + payload;
        }).join('\n');
      }
    } catch (e) { /* ignore */ }

    // Local CSV cache through the native shim; on web the plugin is absent.
    const fmtBytes = (b) => {
      if (!b || b < 0) return '0 B';
      if (b < 1024) return b + ' B';
      if (b < 1024 * 1024) return (b / 1024).toFixed(1) + ' KB';
      if (b < 1024 * 1024 * 1024) return (b / 1024 / 1024).toFixed(1) + ' MB';
      return (b / 1024 / 1024 / 1024).toFixed(2) + ' GB';
    };
    const shim = () => window.HRMNativeHrSession;
    async function refreshCacheStats() {
      const countEl = $('hrm-cache-count');
      const bytesEl = $('hrm-cache-bytes');
      const oldestEl = $('hrm-cache-oldest');
      if (!countEl) return;
      if (!shim() || typeof shim().getCacheStats !== 'function') {
        countEl.textContent = '—';
        bytesEl.textContent = 'native only';
        oldestEl.textContent = '—';
        return;
      }
      try {
        const s = await shim().getCacheStats();
        countEl.textContent = String(s.count || 0);
        bytesEl.textContent = fmtBytes(s.bytes || 0);
        oldestEl.textContent = s.oldestMs > 0 ? new Date(s.oldestMs).toLocaleString() : 'no files';
      } catch (e) {
        countEl.textContent = '?';
        bytesEl.textContent = 'error';
        oldestEl.textContent = '—';
      }
    }
    // clearLocalCache deletes only recordings Drive holds in full, never the live one.
    async function clearableCount() {
      const s = await shim().getCacheStats();
      const n = Number(s && s.count) || 0;
      const live = typeof shim().isPublishing === 'function' && shim().isPublishing()
        && typeof shim().getCsvFilename === 'function' && /\.csv$/.test(shim().getCsvFilename() || '');
      return Math.max(0, n - (live ? 1 : 0));
    }
    function clearNote(r) {
      if (!r) return '';
      if (r.drive === 'none') return 'Nothing deleted. Without Drive, this phone holds the only copy.';
      if (r.drive === 'unreachable') return 'Nothing deleted. Drive could not be checked.';
      const k = Number(r.kept) || 0;
      return k ? 'Kept ' + k + (k === 1 ? ' recording' : ' recordings') + ' not yet on Drive.' : '';
    }
    refreshCacheStats();
    $('hrm-cache-refresh').addEventListener('click', refreshCacheStats);
    const cacheClearBtn = $('hrm-cache-clear');
    cacheClearBtn.addEventListener('click', async () => {
      if (!shim() || typeof shim().clearLocalCache !== 'function') return;
      let n = null;
      try { n = await clearableCount(); } catch (e) {}
      if (n === 0) {
        cacheClearBtn.textContent = 'Nothing to clear';
        setTimeout(() => { cacheClearBtn.textContent = 'Clear cache'; }, 1500);
        return;
      }
      const what = n == null ? 'every recording' : n + (n === 1 ? ' recording' : ' recordings');
      const go = await window.UI.confirm({ anchor: $('hrm-cache-actions'), key: 'diag', danger: true, title: 'Clear cache',
        text: 'Deletes ' + what + ' from this phone once Drive has a copy. Any not yet on Drive stay.', confirmLabel: 'Delete' });
      if (!go || !cacheClearBtn.isConnected) return;
      try {
        const r = await shim().clearLocalCache();
        cacheClearBtn.textContent = (r && r.deleted != null) ? `Cleared ${r.deleted}` : 'Cleared';
        const note = clearNote(r);
        if (note) window.UI.toast(note);
        setTimeout(() => { cacheClearBtn.textContent = 'Clear cache'; refreshCacheStats(); }, 1200);
      } catch (e) {
        cacheClearBtn.textContent = 'Failed';
      }
    });

    $('hrm-diag-copy').addEventListener('click', async () => {
      const text = buildCopyText(d, v);
      const btn = $('hrm-diag-copy');
      try {
        await navigator.clipboard.writeText(text);
        btn.textContent = 'Copied';
        setTimeout(() => { btn.textContent = 'Copy to clipboard'; }, 1500);
      } catch (e) {
        window.UI.copySheet(text, { title: 'Diagnostics', label: 'Diagnostics text', multiline: true });
      }
    });
    $('hrm-diag-clearlog').addEventListener('click', () => {
      writeLog([]);
      try { localStorage.removeItem('hrm_auth_trace'); } catch (e) {}
      $('hrm-events-log').textContent = '';
      $('hrm-auth-trace').textContent = 'no auth events yet';
    });
    const actions = $('hrm-diag-actions');
    const clearAuthBtn = $('hrm-diag-clearauth');
    clearAuthBtn.addEventListener('click', async () => {
      const go = await window.UI.confirm({ anchor: actions, key: 'diag', danger: true, title: 'Clear auth state',
        text: 'Signs this device out of Google', confirmLabel: 'Clear' });
      if (!go || !clearAuthBtn.isConnected) return;
      try {
        if (window.aortiAuth) await window.aortiAuth.signOut({ local: true, remote: false });
      } catch (e) { /* ignore */ }
      try { localStorage.removeItem('hr_monitor_drive_token'); } catch (e) {}
      try { localStorage.removeItem('hrm_auth_trace'); } catch (e) {}
      $('hrm-auth-trace').textContent = 'no auth events yet';
      clearAuthBtn.textContent = 'Cleared, reload the page';
      clearAuthBtn.disabled = true;
    });
    const purgeBtn = $('hrm-diag-purge');
    purgeBtn.addEventListener('click', async () => {
      // Marks are uploaded first (5 s deadline in beforePurge); the confirm names what is still only here.
      let unsynced = 0;
      const mp = window.AortiMarksPage;
      if (mp && typeof mp.beforePurge === 'function') {
        purgeBtn.disabled = true;
        purgeBtn.textContent = 'Saving marks';
        try { unsynced = await mp.beforePurge(); } catch (e) { unsynced = mp.store ? mp.store.dirtyCount() : 0; }
        purgeBtn.textContent = 'Purge app data';
        purgeBtn.disabled = false;
        if (!purgeBtn.isConnected) return;
      }
      const marksLine = unsynced ? ' ' + unsynced + (unsynced === 1 ? ' mark' : ' marks') + ' not on Drive will be deleted.' : '';
      const go = await window.UI.confirm({ anchor: actions, key: 'diag', danger: true, title: 'Purge app data',
        text: 'Clears sign-in, settings, cached sessions and logs on this device, then reloads. Recording files stay.' + marksLine, confirmLabel: 'Purge' });
      if (!go || !purgeBtn.isConnected) return;
      purgeBtn.textContent = 'Purging';
      purgeBtn.disabled = true;
      try {
        if (window.aortiAuth) { try { await window.aortiAuth.signOut({ local: true, remote: false }); } catch (e) {} }
        try {
          const keys = Object.keys(localStorage);
          for (const k of keys) try { localStorage.removeItem(k); } catch (e) {}
        } catch (e) {}
        try { sessionStorage.clear(); } catch (e) {}
        try {
          const dbs = (indexedDB.databases && (await indexedDB.databases())) || [{ name: 'hr_monitor_kv' }, { name: 'aorti_marks' }];
          await Promise.all(dbs.filter(d => d && d.name).map(d => new Promise((resolve) => {
            const req = indexedDB.deleteDatabase(d.name);
            req.onsuccess = req.onerror = req.onblocked = () => resolve();
          })));
        } catch (e) {}
        try {
          if (navigator.serviceWorker && navigator.serviceWorker.getRegistrations) {
            const regs = await navigator.serviceWorker.getRegistrations();
            await Promise.all(regs.map(r => r.unregister().catch(() => {})));
          }
        } catch (e) {}
      } finally {
        purgeBtn.textContent = 'Purged, reloading';
        setTimeout(() => { try { location.reload(); } catch (e) {} }, 600);
      }
    });
  }

  function close() {
    if (current) { const c = current; current = null; c.close(); }
  }

  function buildCopyText(d, v) {
    const lines = [];
    lines.push('HR Monitor diagnostics');
    lines.push('----------------------');
    if (d.demoView) {
      lines.push('(demo mode: personal fields suppressed)');
      lines.push('Version:    v0.5 · ' + (v && v.shortSha ? v.shortSha : 'offline'));
      lines.push('Built:      ' + (v && v.builtAt ? fmt(v.builtAt) : '—'));
      lines.push('Runtime:    ' + d.runtime);
      lines.push('User agent: ' + d.userAgent);
      return lines.join('\n');
    }
    lines.push('Version:    v0.5 · ' + (v && v.shortSha ? v.shortSha : 'offline'));
    lines.push('Built:      ' + (v && v.builtAt ? fmt(v.builtAt) : '—'));
    lines.push('Signed:     ' + (v ? (v.signed ? 'yes' : 'no') : '—'));
    lines.push('Runtime:    ' + d.runtime);
    lines.push('Native:     ' + (d.isNative ? 'yes' : 'no'));
    lines.push('BLE:        ' + (d.blePresent ? 'present' : 'missing'));
    lines.push('  web:      ' + (d.bleWeb ? 'yes' : 'no'));
    lines.push('  cap plug: ' + (d.bleCapacitorPlugin ? 'yes' : 'no'));
    lines.push('Drive:');
    lines.push('  native:   ' + (d.driveNativeOverride ? 'override present' : 'not overridden'));
    lines.push('  auth:     ' + (d.driveSignedIn ? 'signed in' : 'not signed in'));
    if (d.marks) {
      lines.push('Marks:');
      lines.push('  device:   ' + d.marks.device);
      lines.push('  records:  ' + d.marks.records + ', not on Drive ' + d.marks.dirty);
      lines.push('  saved:    ' + d.marks.persisted);
      lines.push('  sync:     ' + (d.marks.locks ? (d.marks.blocked ? 'off, another account' : 'on') : 'unavailable (no navigator.locks)'));
      lines.push('  bad:      files ' + d.marks.badFiles + ', records ' + d.marks.badRecords);
      lines.push('  error:    ' + (d.marks.lastError || 'none'));
    }
    lines.push('Session shim:');
    lines.push('  marker:   ' + (d.sessionShimMarker || 'not loaded'));
    lines.push('  avail:    ' + (d.sessionShimAvailable ? 'yes' : 'no') + (d.sessionShimMode ? ' (' + d.sessionShimMode + ')' : ''));
    lines.push('  segments: ' + (d.sessionShimSegments ? 'yes' : 'no'));
    lines.push('FGS:');
    lines.push('  loaded:   ' + (d.fgsLoaded ? 'yes' : 'no'));
    lines.push('  plugin:   ' + (d.fgsGotPlugin ? 'yes' : 'no'));
    lines.push('  started:  ' + (d.fgsStarted ? 'yes' : 'no'));
    lines.push('  notif:    ' + (d.fgsPermission != null ? JSON.stringify(d.fgsPermission) : 'not asked'));
    lines.push('  error:    ' + (d.fgsLastError || 'none'));
    lines.push('BattOpt:');
    lines.push('  loaded:   ' + (d.battoptLoaded ? 'yes' : 'no'));
    lines.push('  plugin:   ' + (d.battoptGotPlugin ? 'yes' : 'no'));
    lines.push('  error:    ' + (d.battoptLastError || 'none'));
    lines.push('WakeLock:');
    lines.push('  loaded:   ' + (d.wakeLockLoaded ? 'yes' : 'no'));
    lines.push('  plugin:   ' + (d.wakeLockGotPlugin ? 'yes' : 'no'));
    lines.push('  error:    ' + (d.wakeLockLastError || 'none'));
    lines.push('Broadcast:  ' + (d.localBroadcastKey ? 'key set' : 'no key'));
    lines.push('Sleep weights: ' + d.sleepWeights);
    lines.push('User agent: ' + d.userAgent);
    const events = readLog();
    if (events.length) {
      lines.push('');
      lines.push('Recent events (newest last)');
      lines.push('---------------------------');
      lines.push(formatLog(events));
    }
    return lines.join('\n');
  }

  window.HRMDiagnostics = { mountChip, open, close, detect };
})();
