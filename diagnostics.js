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
      bleAdapterSawCapacitor: !!window.__hrMonitorBleAdapterCapacitorAvailable,
      bleCapacitorPlugin: blePlugin || bleRegistered,
      driveNativeOverride: nativeDriveSignIn,
      driveAuthLoaded: !!window.__hrMonitorDriveAuthLoaded,
      userAgent: navigator.userAgent,
      localBroadcastKey: !!localStorage.getItem('hr_monitor_broadcast_key'),
      driveSignedIn: !!localStorage.getItem('hr_monitor_drive_token'),
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
      }
      .hrm-diag-title { font-size: 15px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; margin: 0 0 14px; }
      .hrm-diag-subtitle { font-size: 11px; color: #8a8a8a; letter-spacing: 0.1em; text-transform: uppercase; font-weight: 700; margin: 14px 0 6px; }
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
      .hrm-diag-actions { display: flex; gap: 8px; margin-top: 18px; flex-wrap: wrap; }
      .hrm-diag-actions button {
        flex: 1; padding: 8px 12px; min-width: 100px;
        background: #1a1a1a; color: #d8d8d8;
        border: 1px solid #2a2a2a; border-radius: 6px;
        font-size: 12px; cursor: pointer; letter-spacing: 0.03em;
        font-family: inherit;
      }
      .hrm-diag-actions button.primary { background: #5DCAA5; color: #0a0a0a; border-color: #5DCAA5; font-weight: 700; }
      .hrm-diag-actions button:hover { border-color: #3a3a3a; }
      .hrm-diag-actions button.primary:hover { filter: brightness(1.1); }
    `;
    document.head.appendChild(s);
  }

  // Generic anonymous-user silhouette. Becomes a real profile picture when
  // Phase D's Google Sign-In wires up.
  const AVATAR_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="8" r="4"/><path d="M4 21v-2a6 6 0 0 1 6-6h4a6 6 0 0 1 6 6v2"/></svg>';

  async function mountChip(target) {
    injectStyles();
    const el = typeof target === 'string' ? document.querySelector(target) : target;
    if (!el) return;

    const chip = document.createElement('a');
    chip.className = 'hrm-user-chip';
    chip.href = '#';
    chip.setAttribute('aria-label', 'Account and app diagnostics');
    chip.innerHTML = `
      <span class="hrm-user-avatar">${AVATAR_SVG}</span>
      <span class="hrm-version-label">v0.5</span>
    `;
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

    const rows = (title, items) => {
      const body = items.map(([k, v, cls]) => `<div class="hrm-diag-row"><span class="k">${esc(k)}</span><span class="v ${cls||''}">${esc(v)}</span></div>`).join('');
      return `<div class="hrm-diag-subtitle">${esc(title)}</div>${body}`;
    };

    overlay.innerHTML = `
      <div class="hrm-diag-modal">
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
        ${rows('Bluetooth', [
          ['ble-adapter.js loaded', yn(d.bleAdapterLoaded), d.isNative ? ok(d.bleAdapterLoaded) : ''],
          ['ble-adapter saw Capacitor', yn(d.bleAdapterSawCapacitor), d.isNative ? ok(d.bleAdapterSawCapacitor) : ''],
          ['navigator.bluetooth', yn(d.blePresent), ok(d.blePresent)],
          ['Web Bluetooth', yn(d.bleWeb), d.isNative ? '' : ok(d.bleWeb)],
          ['Capacitor BLE plugin', yn(d.bleCapacitorPlugin), d.isNative ? ok(d.bleCapacitorPlugin) : ''],
        ])}
        ${rows('Google Drive', [
          ['drive-auth-native.js loaded', yn(d.driveAuthLoaded), d.isNative ? ok(d.driveAuthLoaded) : ''],
          ['Native sign-in override', yn(d.driveNativeOverride), d.isNative ? ok(d.driveNativeOverride) : ''],
          ['Currently signed in', yn(d.driveSignedIn), d.driveSignedIn ? 'ok' : 'warn'],
        ])}
        ${rows('Relay', [
          ['Broadcast key set', yn(d.localBroadcastKey), d.localBroadcastKey ? 'ok' : 'warn'],
        ])}
        <div class="hrm-diag-actions">
          <button class="primary" id="hrm-diag-copy">Copy to clipboard</button>
          <button id="hrm-diag-close">Close</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    document.getElementById('hrm-diag-close').addEventListener('click', close);
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
    lines.push('Broadcast:  ' + (d.localBroadcastKey ? 'key set' : 'no key'));
    lines.push('User agent: ' + d.userAgent);
    return lines.join('\n');
  }

  window.HRMDiagnostics = { mountChip, open, close, detect };
})();
