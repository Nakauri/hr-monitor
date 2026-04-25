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

  // ----- Persistent log buffer ------------------------------------------
  // Ring buffer of the last 60 entries, persisted to localStorage so a
  // native Android crash + restart still surfaces the prelude. Anything
  // routed through HRMLog.* shows up in the diagnostics modal's "Recent
  // events" section and in the clipboard copy. Plus we hook window.onerror
  // and onunhandledrejection so uncaught failures land here automatically.
  const LOG_KEY = 'hrm_log_v1';
  const LOG_MAX = 60;
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
      // NativeHrSessionPlugin's own FGS (NativeHrService) — the actual one
      // that runs during a session. The @capawesome FGS plugin above is
      // legacy / never started on the session path.
      nativeFgsRunning: !!(window.HRMNativeHrSession && window.HRMNativeHrSession.isPublishing && window.HRMNativeHrSession.isPublishing()),
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
      localBroadcastKey: !!localStorage.getItem('hr_monitor_broadcast_key'),
      driveSignedIn: !!(window.aortiAuth && window.aortiAuth.isSignedIn()),
      driveEmail: (window.aortiAuth && window.aortiAuth.getEmail()) || null,
      driveMetaCount: (function () {
        try {
          const raw = localStorage.getItem('hrv_viewer_drive_meta');
          if (!raw) return 0;
          return Object.keys(JSON.parse(raw)).length;
        } catch (e) { return -1; }
      })(),
      driveLastSync: (function () {
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
        border-color: var(--accent-rmssd, #5DCAA5);
        color: var(--accent-rmssd, #5DCAA5);
        background: #202020;
      }
      .hrm-user-avatar svg { width: 16px; height: 16px; }
      .hrm-user-avatar.fresh { border-color: #F0C75E; color: #F0C75E; }
      .hrm-version-label {
        font-size: 9px;
        letter-spacing: 0.06em;
        color: var(--text-faint, #5a5a5a);
        font-family: 'Consolas', 'Monaco', monospace;
        text-transform: none;
      }
      .hrm-user-chip:hover .hrm-version-label { color: var(--text-dim, #8a8a8a); }

      .hrm-diag-overlay {
        position: fixed; inset: 0;
        background: rgba(0,0,0,0.7);
        z-index: 10000;
        display: flex; align-items: center; justify-content: center;
        padding: 20px;
      }
      .hrm-diag-modal {
        background: #0a0a0a;
        border: 1px solid #2a2a2a;
        border-radius: 12px;
        max-width: 520px; width: 100%;
        max-height: 90vh; overflow-y: auto;
        padding: 22px 24px;
        color: #d8d8d8;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        position: relative;
      }
      .hrm-diag-xclose {
        position: absolute; top: 10px; right: 10px;
        width: 34px; height: 34px;
        background: transparent; border: none;
        color: #8a8a8a; font-size: 20px; line-height: 1;
        cursor: pointer; border-radius: 6px;
        display: flex; align-items: center; justify-content: center;
      }
      .hrm-diag-xclose:hover { color: #d8d8d8; background: #1a1a1a; }
      .hrm-diag-xclose svg { width: 16px; height: 16px; }
      .hrm-diag-title { font-size: 15px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; margin: 0 0 14px; }
      .hrm-diag-legal-strip {
        display: block;
        text-align: center;
        padding: 10px 0 24px;
        margin: 0 0 18px;
        border-bottom: 1px solid #1a1a1a;
      }
      .hrm-diag-legal-strip a {
        color: #9a9a9a;
        text-decoration: none;
        font-size: 12px;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        padding: 8px 16px;
        border: 1px solid #2a2a2a;
        border-radius: 6px;
        transition: color 0.15s, border-color 0.15s, background 0.15s;
      }
      .hrm-diag-legal-strip a:hover { color: #d8d8d8; border-color: #3a3a3a; background: #1a1a1a; }
      .hrm-diag-subtitle { font-size: 11px; color: #8a8a8a; letter-spacing: 0.1em; text-transform: uppercase; font-weight: 700; margin: 14px 0 6px; }
      /* Collapsible section. <details>/<summary> drives state — no JS. The
         caret is drawn via CSS ::before so the browser's default ▶ doesn't
         show, and the rotation gives a visual open/closed cue. */
      .hrm-diag-section { margin: 0; }
      .hrm-diag-section > summary {
        font-size: 11px; color: #8a8a8a; letter-spacing: 0.1em; text-transform: uppercase;
        font-weight: 700; margin: 14px 0 6px; cursor: pointer; list-style: none;
        display: flex; align-items: center; gap: 8px;
        user-select: none; -webkit-user-select: none;
      }
      .hrm-diag-section > summary::-webkit-details-marker { display: none; }
      .hrm-diag-section > summary::before {
        content: ''; display: inline-block; width: 6px; height: 6px;
        border-right: 1.5px solid #8a8a8a; border-bottom: 1.5px solid #8a8a8a;
        transform: rotate(-45deg); transition: transform 0.15s;
      }
      .hrm-diag-section[open] > summary::before { transform: rotate(45deg); }
      .hrm-diag-section > summary:hover { color: #d8d8d8; }
      .hrm-diag-section > summary:hover::before { border-color: #d8d8d8; }
      .hrm-diag-row {
        display: flex; justify-content: space-between; gap: 12px;
        padding: 6px 0; border-bottom: 1px solid #1a1a1a;
        font-size: 12px;
      }
      .hrm-diag-row:last-child { border-bottom: none; }
      .hrm-diag-row .k { color: #8a8a8a; }
      .hrm-diag-row .v { color: #d8d8d8; font-family: 'Consolas', 'Monaco', monospace; text-align: right; max-width: 280px; word-break: break-word; }
      .hrm-diag-row .v.ok { color: #5DCAA5; }
      .hrm-diag-row .v.warn { color: #F0C75E; }
      .hrm-diag-row .v.err { color: #E24B4A; }
      .hrm-diag-log {
        background: #0a0a0a; border: 1px solid #1a1a1a; border-radius: 6px;
        padding: 8px 10px; margin: 0;
        font-family: 'Consolas', 'Monaco', monospace;
        font-size: 11px; line-height: 1.45;
        color: #b8b8b8; max-height: 260px; overflow: auto; white-space: pre-wrap;
        word-break: break-word;
      }
      .hrm-diag-log:empty::before { content: 'no events logged yet'; color: #5a5a5a; }
      .hrm-diag-actions { display: flex; gap: 8px; margin-top: 18px; flex-wrap: wrap; }
      .hrm-diag-actions button {
        flex: 1; padding: 10px 12px; min-width: 100px; min-height: 44px;
        background: #1a1a1a; color: #d8d8d8;
        border: 1px solid #2a2a2a; border-radius: 6px;
        font-size: 12px; cursor: pointer; letter-spacing: 0.03em;
        font-family: inherit;
      }
      .hrm-diag-actions button.primary { background: #5DCAA5; color: #0a0a0a; border-color: #5DCAA5; font-weight: 700; }
      .hrm-diag-actions button:hover { border-color: #3a3a3a; }
      .hrm-diag-actions button.primary:hover { filter: brightness(1.1); }
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
      if (!v.signed) avatar.classList.add('fresh');
    } else {
      chip.title = 'v0.5 · version unavailable (offline)\nClick for diagnostics';
    }
  }

  async function open() {
    injectStyles();
    const d = detect();
    const v = await fetchVersion();

    const existing = document.getElementById('hrm-diag-overlay');
    if (existing) existing.remove();

    const overlay = document.createElement('div');
    overlay.id = 'hrm-diag-overlay';
    overlay.className = 'hrm-diag-overlay';
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

    const ok = (cond) => cond ? 'ok' : 'err';
    const okwarn = (cond, warn) => cond ? 'ok' : (warn ? 'warn' : 'err');
    const yn = (cond) => cond ? 'yes' : 'no';

    // openByDefault: a small allow-list of sections that almost always
    // matter on first glance. Everything else starts collapsed so the
    // modal isn't a wall of text. User can twist any caret open.
    const openByDefault = new Set(['Build', 'Runtime', 'Google Drive shim (step-by-step)', 'Bluetooth shim (step-by-step)']);
    const rows = (title, items) => {
      const body = items.map(([k, v, cls]) => `<div class="hrm-diag-row"><span class="k">${esc(k)}</span><span class="v ${cls||''}">${esc(v)}</span></div>`).join('');
      const open = openByDefault.has(title) ? ' open' : '';
      return `<details class="hrm-diag-section"${open}><summary>${esc(title)}</summary>${body}</details>`;
    };

    overlay.innerHTML = `
      <div class="hrm-diag-modal">
        <button class="hrm-diag-xclose" id="hrm-diag-xclose" aria-label="Close diagnostics"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 3l10 10M13 3L3 13"/></svg></button>
        <div class="hrm-diag-legal-strip"><a href="./legal.html" target="_blank" rel="noopener">Legal &amp; disclaimers</a></div>
        <h2 class="hrm-diag-title">App diagnostics</h2>
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
        ${rows('Foreground service (background recording)', [
          ['Native session FGS running', yn(d.nativeFgsRunning), d.isNative ? ok(d.nativeFgsRunning) : ''],
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
          <summary>Local session cache</summary>
          <div class="hrm-diag-row"><span class="k">Files</span><span class="v" id="hrm-cache-count">…</span></div>
          <div class="hrm-diag-row"><span class="k">Size</span><span class="v" id="hrm-cache-bytes">…</span></div>
          <div class="hrm-diag-row"><span class="k">Oldest</span><span class="v" id="hrm-cache-oldest">…</span></div>
          <div style="margin-top: 10px; display: flex; gap: 8px;">
            <button id="hrm-cache-refresh" style="flex: 1; padding: 8px 12px; background: #1a1a1a; color: #d8d8d8; border: 1px solid #2a2a2a; border-radius: 6px; cursor: pointer; min-height: 36px;">Refresh</button>
            <button id="hrm-cache-clear" style="flex: 1; padding: 8px 12px; background: #2a1616; color: #E89898; border: 1px solid #5a2a2a; border-radius: 6px; cursor: pointer; min-height: 36px;">Clear cache</button>
          </div>
          <div style="font-size: 11px; color: #6a6a6a; margin-top: 8px; line-height: 1.4;">
            Local CSVs auto-clean after Drive sync (7 days) or after 30 days regardless. Hard cap 500 MB. Tap Clear to remove all but the active session.
          </div>
        </details>
        <details class="hrm-diag-section" open>
          <summary>Auth trace (newest last)</summary>
          <pre class="hrm-diag-log" id="hrm-auth-trace"></pre>
        </details>
        <details class="hrm-diag-section" open>
          <summary>Recent events (newest last)</summary>
          <pre class="hrm-diag-log" id="hrm-events-log">${esc(formatLog(readLog()))}</pre>
        </details>
        <div class="hrm-diag-actions">
          <button class="primary" id="hrm-diag-copy">Copy to clipboard</button>
          <button id="hrm-diag-clearlog">Clear events</button>
          <button id="hrm-diag-clearauth">Clear auth state</button>
          <button id="hrm-diag-purge" style="background: #2a1616; border-color: #5a2a2a; color: #E89898;">Purge app data</button>
          <button id="hrm-diag-close">Close</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    document.getElementById('hrm-diag-close').addEventListener('click', close);
    document.getElementById('hrm-diag-xclose').addEventListener('click', close);

    // Hydrate auth trace from localStorage. Set by drive-auth-native.js and
    // auth.js. Survives navigation because it's localStorage-based.
    try {
      const tracePane = document.getElementById('hrm-auth-trace');
      if (tracePane) {
        const raw = localStorage.getItem('hrm_auth_trace');
        const arr = raw ? JSON.parse(raw) : [];
        if (!arr.length) {
          tracePane.textContent = 'no auth events yet';
        } else {
          tracePane.textContent = arr.map(e => {
            const when = new Date(e.t).toISOString().slice(11, 23);
            const payload = e.payload != null ? ' ' + JSON.stringify(e.payload) : '';
            return when + '  ' + e.step + payload;
          }).join('\n');
        }
      }
    } catch (e) { /* ignore */ }

    // Local CSV cache — visible byte usage + manual clear. Calls into the
    // native plugin via the JS shim; no-op on web (plugin reports unsupported).
    const fmtBytes = (b) => {
      if (!b || b < 0) return '0 B';
      if (b < 1024) return b + ' B';
      if (b < 1024 * 1024) return (b / 1024).toFixed(1) + ' KB';
      if (b < 1024 * 1024 * 1024) return (b / 1024 / 1024).toFixed(1) + ' MB';
      return (b / 1024 / 1024 / 1024).toFixed(2) + ' GB';
    };
    async function refreshCacheStats() {
      const countEl = document.getElementById('hrm-cache-count');
      const bytesEl = document.getElementById('hrm-cache-bytes');
      const oldestEl = document.getElementById('hrm-cache-oldest');
      if (!countEl) return;
      if (!window.HRMNativeHrSession || typeof window.HRMNativeHrSession.getCacheStats !== 'function') {
        countEl.textContent = '—';
        bytesEl.textContent = 'native only';
        oldestEl.textContent = '—';
        return;
      }
      try {
        const s = await window.HRMNativeHrSession.getCacheStats();
        countEl.textContent = String(s.count || 0);
        bytesEl.textContent = fmtBytes(s.bytes || 0);
        if (s.oldestMs && s.oldestMs > 0) {
          const d = new Date(s.oldestMs);
          oldestEl.textContent = d.toLocaleString();
        } else {
          oldestEl.textContent = 'no files';
        }
      } catch (e) {
        countEl.textContent = '?';
        bytesEl.textContent = 'error';
        oldestEl.textContent = '—';
      }
    }
    refreshCacheStats();
    const cacheRefreshBtn = document.getElementById('hrm-cache-refresh');
    if (cacheRefreshBtn) cacheRefreshBtn.addEventListener('click', refreshCacheStats);
    const cacheClearBtn = document.getElementById('hrm-cache-clear');
    if (cacheClearBtn) {
      cacheClearBtn.addEventListener('click', async () => {
        if (!confirm('Delete all local session CSVs except the active one?\n\nThe sessions stay on Google Drive — this only frees up phone storage. You can re-pull them in the viewer if you sign in to Drive.')) return;
        if (!window.HRMNativeHrSession || typeof window.HRMNativeHrSession.clearLocalCache !== 'function') return;
        try {
          const r = await window.HRMNativeHrSession.clearLocalCache();
          cacheClearBtn.textContent = (r && r.deleted != null) ? `Cleared ${r.deleted}` : 'Cleared';
          setTimeout(() => { cacheClearBtn.textContent = 'Clear cache'; refreshCacheStats(); }, 1200);
        } catch (e) {
          cacheClearBtn.textContent = 'Failed';
        }
      });
    }

    document.getElementById('hrm-diag-copy').addEventListener('click', async () => {
      const text = buildCopyText(d, v);
      try {
        await navigator.clipboard.writeText(text);
        const btn = document.getElementById('hrm-diag-copy');
        btn.textContent = 'Copied!';
        setTimeout(() => { btn.textContent = 'Copy to clipboard'; }, 1500);
      } catch (e) {
        alert('Copy failed. Here is the text to paste:\n\n' + text);
      }
    });
    const clearBtn = document.getElementById('hrm-diag-clearlog');
    if (clearBtn) {
      clearBtn.addEventListener('click', () => {
        // Clear BOTH event stores. The previous handler called writeLog([])
        // (which only clears hrm_log_v1) plus document.querySelector('.hrm-diag-log')
        // — which returns the FIRST .hrm-diag-log node (the auth pane), so the
        // events pane stayed visually full while the auth pane went blank.
        // hrm_auth_trace localStorage was never cleared by anything.
        writeLog([]);
        try { localStorage.removeItem('hrm_auth_trace'); } catch (e) {}
        const eventsPane = document.getElementById('hrm-events-log');
        if (eventsPane) eventsPane.textContent = '';
        const tracePane = document.getElementById('hrm-auth-trace');
        if (tracePane) tracePane.textContent = 'no auth events yet';
      });
    }
    const clearAuthBtn = document.getElementById('hrm-diag-clearauth');
    if (clearAuthBtn) {
      clearAuthBtn.addEventListener('click', async () => {
        if (!confirm('Clear all saved Google auth state? You will need to sign in again.')) return;
        try {
          if (window.aortiAuth) await window.aortiAuth.signOut({ local: true, remote: false });
        } catch (e) { /* ignore */ }
        try { localStorage.removeItem('hr_monitor_drive_token'); } catch (e) {}
        // Also clear the auth trace — otherwise stale auth events from the
        // pre-signout state stick around and confuse subsequent debugging.
        try { localStorage.removeItem('hrm_auth_trace'); } catch (e) {}
        const tracePane = document.getElementById('hrm-auth-trace');
        if (tracePane) tracePane.textContent = 'no auth events yet';
        clearAuthBtn.textContent = 'Cleared — reload page';
        clearAuthBtn.disabled = true;
      });
    }
    const purgeBtn = document.getElementById('hrm-diag-purge');
    if (purgeBtn) {
      purgeBtn.addEventListener('click', async () => {
        if (!confirm(
          'Purge all app data on this device?\n\n' +
          'This clears:\n' +
          '• Google sign-in (you will need to sign in again)\n' +
          '• All session history cached on this device\n' +
          '• All settings (thresholds, widget prefs, folder pick)\n' +
          '• Event log + auth trace\n\n' +
          'Sessions stored on Google Drive are NOT affected. Your recordings are safe there.\n\n' +
          'Use this when the app is stuck in a weird state. Continue?'
        )) return;
        purgeBtn.textContent = 'Purging…';
        purgeBtn.disabled = true;
        try {
          if (window.aortiAuth) { try { await window.aortiAuth.signOut({ local: true, remote: false }); } catch (e) {} }
          try {
            const keys = Object.keys(localStorage);
            for (const k of keys) try { localStorage.removeItem(k); } catch (e) {}
          } catch (e) {}
          try { sessionStorage.clear(); } catch (e) {}
          // IndexedDB — drive-cache + any other app DBs. Queue in parallel.
          try {
            const dbs = (indexedDB.databases && (await indexedDB.databases())) || [{ name: 'hr_monitor_kv' }];
            await Promise.all(dbs.filter(d => d && d.name).map(d => new Promise((resolve) => {
              const req = indexedDB.deleteDatabase(d.name);
              req.onsuccess = req.onerror = req.onblocked = () => resolve();
            })));
          } catch (e) {}
          // Service worker, if any.
          try {
            if (navigator.serviceWorker && navigator.serviceWorker.getRegistrations) {
              const regs = await navigator.serviceWorker.getRegistrations();
              await Promise.all(regs.map(r => r.unregister().catch(() => {})));
            }
          } catch (e) {}
        } finally {
          purgeBtn.textContent = 'Purged. Reloading…';
          setTimeout(() => { try { location.reload(); } catch (e) {} }, 600);
        }
      });
    }
  }

  function close() {
    const overlay = document.getElementById('hrm-diag-overlay');
    if (overlay) overlay.remove();
  }

  function buildCopyText(d, v) {
    const lines = [];
    lines.push('HR Monitor diagnostics');
    lines.push('----------------------');
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
