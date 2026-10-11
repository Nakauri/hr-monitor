// The monitor's inline Stop confirm (#stop-confirm) stays in the page hidden, so it is left out of every .confirm match.
// S3 dialog checks on the shared components (ui.css, ui.js): destructive confirms are spied
// (Cancel, Escape, backdrop and close-then-reopen make 0 calls; only the danger button makes 1),
// the clear-cache count matches the fake phone, Copy OBS URL falls back to the read-only field,
// and a walk of the main screens at 360 and 1440 logs no console errors. --shots <dir> also shoots
// every converted sheet, confirm and notice at 360, 1440 and 360 with 200% text.
// Usage: node scripts/ui-dialogs.mjs [--shots <dir> [--shots-only] [--size 360|1440|360-text200]] [--ux <ux-audit dir>]
// Needs mobile/www from `npm run copy-web` (the app pages run there with the fake bridge).

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { uxDir } from './ux-dir.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const argVal = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const ROOT = path.resolve(here, '..');
const UX = uxDir(here, argVal('--ux'));
const SHOTS = argVal('--shots');
const CHART = path.join(UX, '..', 'docs', 'audit-2026-10-09', 'harness-DT', 'vendor', 'chart.umd.min.js');
const { fakeBridge, fakeWebSocket } = await import(pathToFileURL(path.join(UX, 'scripts', 'fake-bridge.mjs')).href);
const { chromium } = createRequire(path.join(UX, 'kit', 'package.json'))('playwright');
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
for (const f of ['ui.css', 'ui.js', 'diagnostics.js', 'hr_monitor.html']) {
  const www = path.join(ROOT, 'mobile', 'www', f);
  if (!fs.existsSync(www) || (f !== 'hr_monitor.html' && fs.readFileSync(www, 'utf8') !== fs.readFileSync(path.join(ROOT, f), 'utf8'))) {
    console.log(`FAIL mobile/www/${f} is missing or stale: run npm run copy-web in mobile first`); process.exit(1);
  }
}

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png', '.woff2': 'font/woff2' };
const server = http.createServer((req, res) => {
  let rel = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  let base = ROOT;
  if (rel.startsWith('/www/')) { base = path.join(ROOT, 'mobile', 'www'); rel = rel.slice(4); }
  let file = path.join(base, rel);
  if (!fs.existsSync(file)) file = path.join(ROOT, rel);
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  fs.createReadStream(file).pipe(res);
});
await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
const BASE = `http://127.0.0.1:${server.address().port}`;

const SPIES = `(() => {
  const S = window.__spy = { clearLocalCache: 0, signOut: 0, idbDelete: 0 };
  if (window.Capacitor && window.Capacitor.Plugins) {
    const P = window.Capacitor.Plugins;
    const hr = P.NativeHrSession;
    hr.getCacheStats = () => Promise.resolve({ count: 5, bytes: 4200000, oldestMs: Date.now() - 3 * 864e5 });
    hr.clearLocalCache = () => { S.clearLocalCache++; return Promise.resolve({ deleted: 4 }); };
    const oem = { getManufacturer: () => Promise.resolve({ vendor: 'samsung', manufacturer: 'samsung', hasKnownBackgroundKiller: true }),
      openBackgroundSettings: () => Promise.resolve({ opened: true }), addListener: () => Promise.resolve({ remove() {} }) };
    window.Capacitor.Plugins = new Proxy({}, { get: (_, k) => (k === 'OemBackground' ? oem : P[k]) });
  }
  const del = IDBObjectStore.prototype.delete;
  IDBObjectStore.prototype.delete = function () { S.idbDelete++; return del.apply(this, arguments); };
  const t = setInterval(() => {
    if (window.aortiAuth && !window.aortiAuth.__spied) {
      window.aortiAuth.signOut = function () { S.signOut++; return Promise.resolve(); };
      window.aortiAuth.__spied = true;
    }
  }, 20);
  if (window.__denyClipboard && navigator.clipboard) navigator.clipboard.writeText = () => Promise.reject(new Error('denied'));
})();`;

// An interrupted session that native resumes: the monitor's recovery path, then the OEM prompt.
const RECOVERY = `(() => {
  try { localStorage.removeItem('hrm_oem_whitelist_prompt'); } catch (e) {}
  const F = window.__fake; if (!F || !window.Capacitor) return;
  const ctx = { mac: 'AA:BB:CC:DD:00:25', strapName: '808S 0025153', sessionStartMs: Date.now() - 3600000, senderId: '0bf9c4', csvFile: 'hrv_session_demo.csv' };
  F.snapshot = { sessionActive: false, interruptedRecovery: true, recoveryContext: ctx, bleConnected: false, relayLive: false, linkState: 'none' };
  const hr = window.Capacitor.Plugins.NativeHrSession;
  hr.resumeSession = () => {
    F.snapshot = { sessionActive: true, senderId: '0bf9c4', senderLabel: 'HR Monitor Android', sessionStartMs: ctx.sessionStartMs, csvFile: ctx.csvFile,
      bleConnected: true, linkUp: true, relayLive: true, linkState: 'recording', generation: 3, targetMac: ctx.mac, strapName: ctx.strapName, interruptedRecovery: false };
    let n = 0;
    setInterval(() => { n++; const cb = F.listeners.hr; if (cb) cb({ hr: 80 + (n % 4), rrIntervals: [740], timestampMs: Date.now(), contactOff: false }); }, 1000);
    return Promise.resolve({ resumed: true, senderId: '0bf9c4', senderLabel: 'HR Monitor Android', sessionStartMs: ctx.sessionStartMs });
  };
})();`;

const ALLOW = /^https?:\/\/(127\.0\.0\.1|fonts\.googleapis\.com|fonts\.gstatic\.com|cdn\.jsdelivr\.net|cdnjs\.cloudflare\.com)(:|\/)/;
let fails = 0;
const fail = (m) => { fails++; console.log('FAIL ' + m); };
const ok = (m) => console.log('ok   ' + m);

const browser = await chromium.launch().catch(() => chromium.launch({ channel: 'chrome' }));

async function open(url, { width = 360, bridge = null, ws = false, deny = false, mobile = width < 600, init = null } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height: width < 600 ? 740 : 900 }, deviceScaleFactor: 1, isMobile: mobile, hasTouch: mobile });
  if (deny) await ctx.addInitScript('window.__denyClipboard = true;');
  if (bridge) await ctx.addInitScript(fakeBridge(bridge));
  if (ws) await ctx.addInitScript(fakeWebSocket(ws === true ? {} : ws));
  if (init) await ctx.addInitScript(init);
  await ctx.addInitScript(SPIES);
  await ctx.route('**/*', (route) => {
    const u = route.request().url();
    if (/chart\.umd(\.min)?\.js/.test(u) && !u.startsWith(BASE) && fs.existsSync(CHART)) return route.fulfill({ status: 200, contentType: 'text/javascript', body: fs.readFileSync(CHART) });
    if (/googleapis\.com\/(drive|upload)\//.test(u)) return route.fulfill({ status: 200, contentType: 'application/json', body: '{"files":[],"id":"fake-folder"}' });
    if (ALLOW.test(u) || u.startsWith('data:') || u.startsWith('blob:')) return route.continue();
    const js = /\.js(\?|$)/.test(u) || route.request().resourceType() === 'script';
    return route.fulfill({ status: js ? 200 : 204, contentType: js ? 'text/javascript' : 'text/plain', body: '' });
  });
  if (!deny) { try { await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: BASE }); } catch (e) {} }
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text().slice(0, 160)); });
  await page.goto(BASE + url, { waitUntil: 'load' });
  return { ctx, page, errors };
}

async function textScale(page, f) {
  await page.evaluate((f) => {
    const els = [...document.querySelectorAll('body, body *')].filter((e) => !e.dataset.uxFs && !(e instanceof SVGElement));
    const sizes = els.map((e) => parseFloat(getComputedStyle(e).fontSize));
    els.forEach((e, i) => { e.dataset.uxFs = String(sizes[i]); e.style.setProperty('font-size', sizes[i] * f + 'px', 'important'); });
  }, f);
}
async function shot(page, name) {
  if (!SHOTS) return;
  await page.waitForTimeout(250);
  await page.screenshot({ path: path.join(SHOTS, name + '.png') });
}
const spy = (page) => page.evaluate(() => Object.assign({}, window.__spy));
const confirmOpen = (page) => page.locator('.confirm:not(#stop-confirm)').count();

// ---------- Diagnostics confirms on the phone monitor ----------
async function diagOpen(page) {
  await page.evaluate(() => window.HRMDiagnostics.open());
  await page.waitForSelector('#hrm-diag-overlay .sheet');
  await page.evaluate(() => document.querySelectorAll('#hrm-diag-overlay details').forEach((d) => { d.open = true; }));
}
async function diagCase(page, btn, key, label) {
  const trigger = async () => {
    if (!(await page.locator('#hrm-diag-overlay').count())) await diagOpen(page);
    await page.locator('#hrm-diag-overlay #' + btn).scrollIntoViewIfNeeded();
    await page.locator('#hrm-diag-overlay #' + btn).click();
    await page.waitForSelector('#hrm-diag-overlay .confirm');
  };
  const counts = {};
  await trigger();
  const info = await page.evaluate(() => ({ text: document.querySelector('.confirm:not(#stop-confirm)').innerText.replace(/\s+/g, ' '), focus: document.activeElement && document.activeElement.textContent.trim(),
    danger: getComputedStyle(document.querySelector('.confirm:not(#stop-confirm) .btn.danger')).backgroundColor,
    warn: getComputedStyle(document.documentElement).getPropertyValue('--warn-high').trim() }));
  if (info.focus !== 'Cancel') fail(`${label}: focus on open is "${info.focus}", not Cancel`);
  await page.locator('.confirm:not(#stop-confirm) .btn', { hasText: 'Cancel' }).click();
  counts.cancel = (await spy(page))[key];
  await trigger();
  await page.keyboard.press('Escape');
  counts.escape = (await spy(page))[key];
  const focusInSheet = await page.evaluate(() => !!document.activeElement.closest('#hrm-diag-overlay'));
  if (!focusInSheet) fail(`${label}: focus left the open sheet after Escape`);
  const sheetAfterEsc = await page.locator('#hrm-diag-overlay').count();
  await trigger();
  await page.mouse.click(4, 4);
  await page.waitForTimeout(100);
  counts.backdrop = (await spy(page))[key];
  const sheetAfterScrim = await page.locator('#hrm-diag-overlay').count();
  await trigger();
  await page.locator('#hrm-diag-overlay .sheet-head .btn.icon').click();
  await diagOpen(page);
  const stale = await confirmOpen(page);
  counts.reopen = (await spy(page))[key];
  await trigger();
  await page.locator('.confirm:not(#stop-confirm) .btn.danger').click();
  await page.waitForTimeout(80);
  counts.danger = (await spy(page))[key];
  const want = { cancel: 0, escape: 0, backdrop: 0, reopen: 0, danger: 1 };
  const bad = Object.keys(want).filter((k) => counts[k] !== want[k]);
  if (bad.length) fail(`${label}: calls ${JSON.stringify(counts)}`);
  else ok(`${label}: Cancel 0, Escape 0, backdrop 0, close-then-reopen 0, danger 1; focus ${info.focus}; danger fill ${info.danger} (--warn-high ${info.warn})`);
  if (sheetAfterEsc !== 1) fail(`${label}: Escape closed the sheet as well as the confirm`);
  if (sheetAfterScrim !== 0) fail(`${label}: backdrop click left the sheet open`);
  if (stale) fail(`${label}: a confirm survived close and reopen`);
  return info;
}

try {
  if (!args.includes('--shots-only')) {
  {
    const { ctx, page, errors } = await open('/www/hr_monitor.html?mode=online', { bridge: { scenario: 'live', savedStrap: true, signedIn: true } });
    await page.waitForTimeout(3500);
    const info = await diagCase(page, 'hrm-cache-clear', 'clearLocalCache', 'clear cache');
    const n = /Deletes (\d+) recordings/.exec(info.text);
    if (!n || +n[1] !== 4) fail(`clear cache: confirm says "${info.text}", expected 4 (5 local CSVs, 1 live)`);
    else ok(`clear cache: N = ${n[1]} (5 local CSVs minus the live one)`);
    if (!/not yet on Drive/.test(info.text)) fail('clear cache: "not yet on Drive" missing');
    await diagCase(page, 'hrm-diag-clearauth', 'signOut', 'clear auth state');
    if (errors.length) fail('monitor diagnostics errors: ' + errors.join(' | '));
    await ctx.close();
  }
  {
    const { ctx, page } = await open('/www/hr_monitor.html?mode=online', { bridge: { scenario: 'live', savedStrap: true, signedIn: true } });
    await page.waitForTimeout(3500);
    await diagCase(page, 'hrm-diag-purge', 'signOut', 'purge app data');
    await ctx.close();
  }

  // ---------- Viewer session delete (demo data, demo flag dropped so delete runs) ----------
  {
    const { ctx, page, errors } = await open('/hrv_viewer.html?demo=1#/index', { width: 1440 });
    await page.waitForTimeout(3500);
    await page.evaluate(() => history.replaceState(null, '', location.pathname + location.hash));
    const before = await page.locator('.session-card').count();
    const trigger = async () => {
      await page.locator('.session-card').first().hover();
      await page.locator('.session-card-kebab').first().click();
      await page.locator('.session-card-menu [data-action="delete"]').click();
      await page.waitForSelector('.session-card .confirm');
    };
    const counts = {};
    await trigger();
    const focus = await page.evaluate(() => document.activeElement.textContent.trim());
    const text = await page.locator('.session-card .confirm').innerText();
    await page.locator('.confirm:not(#stop-confirm) .btn', { hasText: 'Cancel' }).click();
    counts.cancel = (await spy(page)).idbDelete;
    const hashAfterCancel = await page.evaluate(() => location.hash);
    await trigger();
    await page.keyboard.press('Escape');
    counts.escape = (await spy(page)).idbDelete;
    await trigger();
    await page.mouse.click(1430, 890);
    await page.waitForTimeout(100);
    counts.backdrop = (await spy(page)).idbDelete;
    const leftOpen = await confirmOpen(page);
    await trigger();
    counts.reopen = (await spy(page)).idbDelete;
    await page.locator('.confirm:not(#stop-confirm) .btn.danger').click();
    await page.waitForTimeout(800);
    counts.danger = (await spy(page)).idbDelete;
    const after = await page.locator('.session-card').count();
    const bad = ['cancel', 'escape', 'backdrop', 'reopen'].filter((k) => counts[k] !== 0);
    if (bad.length || counts.danger !== 1) fail(`viewer delete: store deletes ${JSON.stringify(counts)}`);
    else ok(`viewer delete: Cancel 0, Escape 0, outside click 0, reopen 0, danger 1 store delete; focus ${focus}; cards ${before} to ${after}`);
    if (focus !== 'Cancel') fail('viewer delete: Cancel not focused');
    if (hashAfterCancel !== '#/index') fail('viewer delete: a click in the confirm opened the session (' + hashAfterCancel + ')');
    if (leftOpen) fail('viewer delete: outside click left the confirm open');
    console.log('     text: ' + text.replace(/\s+/g, ' '));
    if (errors.length) fail('viewer errors: ' + errors.join(' | '));
    await ctx.close();
  }

  // ---------- Copy OBS URL with the clipboard denied ----------
  {
    const { ctx, page, errors } = await open('/hr_monitor.html?mode=online', { width: 1440, ws: true, deny: true, mobile: false });
    await page.waitForTimeout(2500);
    await page.locator('#nav-copy-obs-url').click();
    await page.waitForSelector('.sheet .field-copy input');
    const v = await page.locator('.sheet .field-copy input').inputValue();
    const sel = await page.evaluate(() => { const i = document.querySelector('.sheet .field-copy input'); return document.activeElement === i && i.selectionEnd - i.selectionStart === i.value.length; });
    if (!/overlay/.test(v)) fail('copy OBS URL fallback: field holds "' + v + '"');
    else ok(`copy OBS URL, clipboard denied: read-only field shows ${v.slice(0, 60)}..., focused and selected ${sel}`);
    await shot(page, 'copy-obs-url-1440');
    await page.keyboard.press('Escape');
    const gone = !(await page.locator('.sheet').count());
    if (!gone) fail('copy sheet: Escape did not close it');
    if (errors.length) fail('web monitor errors: ' + errors.join(' | '));
    await ctx.close();
  }

  // ---------- Walk: no console errors ----------
  const SCREENS = [
    { name: 'landing', url: '/index.html' },
    { name: 'legal', url: '/legal.html' },
    { name: 'web-monitor', url: '/hr_monitor.html?mode=online', ws: true },
    { name: 'app-home', url: '/www/index.html', bridge: { scenario: 'idle' } },
    { name: 'monitor-live', url: '/www/hr_monitor.html?mode=online', bridge: { scenario: 'live', savedStrap: true, signedIn: true } },
    { name: 'viewer-month', url: '/hrv_viewer.html?demo=1#/month' },
    { name: 'viewer-week', url: '/hrv_viewer.html?demo=1#/week' },
    { name: 'viewer-day', url: '/hrv_viewer.html?demo=1#/day' },
    { name: 'viewer-sessions', url: '/hrv_viewer.html?demo=1#/index' },
    { name: 'viewer-trends', url: '/hrv_viewer.html?demo=1#/all' },
    { name: 'app-viewer-day', url: '/www/hrv_viewer.html?demo=1#/day', bridge: { scenario: 'idle', signedIn: true } },
    { name: 'overlay', url: '/overlay.html?key=demo01', ws: { ticks: true } },
  ];
  let walked = 0;
  for (const s of SCREENS) for (const width of [360, 1440]) {
    const { ctx, page, errors } = await open(s.url, { width, bridge: s.bridge, ws: s.ws });
    await page.waitForTimeout(2500);
    walked++;
    if (errors.length) fail(`walk ${s.name} at ${width}: ${errors.length} errors: ${errors.slice(0, 3).join(' | ')}`);
    await ctx.close();
  }
  ok(`walk: ${walked} loads (${SCREENS.length} screens at 360 and 1440)`);
  }

  // ---------- Shots ----------
  if (SHOTS) {
    const tag = (w, t) => (t === 2 ? '360-text200' : String(w));
    const sizes = [[360, 1], [1440, 1], [360, 2]].filter(([w, t]) => !argVal('--size') || argVal('--size') === tag(w, t));
    for (const [w, t] of sizes) {
      const live = { bridge: { scenario: 'live', savedStrap: true, signedIn: true }, width: w };
      { // diagnostics sheet, clear-cache confirm, purge confirm
        const { ctx, page } = await open('/www/hr_monitor.html?mode=online', live);
        await page.waitForTimeout(3500);
        await diagOpen(page);
        if (t === 2) await textScale(page, 2);
        await shot(page, 'diagnostics-' + tag(w, t));
        await page.locator('#hrm-diag-overlay #hrm-cache-clear').scrollIntoViewIfNeeded();
        await page.locator('#hrm-diag-overlay #hrm-cache-clear').click();
        await page.waitForSelector('.confirm:not(#stop-confirm)');
        if (t === 2) await textScale(page, 2);
        await page.locator('.confirm:not(#stop-confirm)').scrollIntoViewIfNeeded();
        await shot(page, 'confirm-clear-cache-' + tag(w, t));
        await page.keyboard.press('Escape');
        await page.locator('#hrm-diag-overlay #hrm-diag-purge').scrollIntoViewIfNeeded();
        await page.locator('#hrm-diag-overlay #hrm-diag-purge').click();
        await page.waitForSelector('.confirm:not(#stop-confirm)');
        if (t === 2) await textScale(page, 2);
        await page.locator('.confirm:not(#stop-confirm)').scrollIntoViewIfNeeded();
        await shot(page, 'confirm-purge-' + tag(w, t));
        await ctx.close();
      }
      { // web monitor: reliability notice and tips sheet (desktop browser at either width)
        const { ctx, page } = await open('/hr_monitor.html?mode=online', { width: w, ws: true, mobile: false });
        await page.waitForTimeout(2500);
        if (t === 2) await textScale(page, 2);
        await shot(page, 'notice-web-reliability-' + tag(w, t));
        if (await page.locator('#hrm-web-banner-link').count()) {
          await page.locator('#hrm-web-banner-link').click();
          await page.waitForSelector('#hrm-tips-sheet');
          if (t === 2) await textScale(page, 2);
          await shot(page, 'sheet-tips-' + tag(w, t));
        } else console.log('     no reliability notice at ' + w + ' (navigator.bluetooth missing?)');
        await ctx.close();
      }
      { // copy sheet fallback
        const { ctx, page } = await open('/hr_monitor.html?mode=online', { width: w, ws: true, deny: true, mobile: false });
        await page.waitForTimeout(2000);
        await page.evaluate(() => document.getElementById('copy-obs-url').click());
        await page.waitForSelector('.sheet .field-copy');
        if (t === 2) await textScale(page, 2);
        await shot(page, 'sheet-copy-url-' + tag(w, t));
        await ctx.close();
      }
      { // OEM prompt after an interrupted session resumes
        const { ctx, page } = await open('/www/hr_monitor.html?mode=online', { width: w, bridge: { scenario: 'idle', savedStrap: true, signedIn: true },
          init: RECOVERY });
        const shown = await page.waitForSelector('#hrm-oem-prompt-sheet', { timeout: 28000 }).then(() => true, () => false);
        if (shown) { if (t === 2) await textScale(page, 2); await shot(page, 'sheet-oem-' + tag(w, t)); }
        else if (t === 1 && w === 360) console.log('     OEM sheet: not reached by the fake bridge (no recovery path in the live scenario)');
        await ctx.close();
      }
      { // viewer: demo notice, demo-delete notice, delete confirm
        const { ctx, page } = await open('/hrv_viewer.html?demo=1#/index', { width: w });
        await page.waitForTimeout(3500);
        if (t === 2) await textScale(page, 2);
        await shot(page, 'notice-demo-' + tag(w, t));
        await page.locator('.session-card').first().hover();
        await page.locator('.session-card-kebab').first().click();
        await page.locator('.session-card-menu [data-action="delete"]').click();
        await page.waitForSelector('.notice-stack .notice');
        if (t === 2) await textScale(page, 2);
        await shot(page, 'notice-delete-off-' + tag(w, t));
        await page.evaluate(() => history.replaceState(null, '', location.pathname + location.hash));
        await page.locator('.session-card-kebab').first().click();
        await page.locator('.session-card-menu [data-action="delete"]').click();
        await page.waitForSelector('.session-card .confirm');
        if (t === 2) await textScale(page, 2);
        await page.locator('.session-card .confirm').scrollIntoViewIfNeeded();
        await shot(page, 'confirm-delete-session-' + tag(w, t));
        await ctx.close();
      }
      { // app home intro sheet and beta pill
        const { ctx, page } = await open('/www/index.html', { width: w, bridge: { scenario: 'idle' }, init: `localStorage.setItem('aorti_intro_enabled', '1'); localStorage.removeItem('aorti_intro_seen');` });
        await page.waitForTimeout(1500);
        if (t === 2) await textScale(page, 2);
        await shot(page, 'sheet-intro-' + tag(w, t));
        await page.keyboard.press('Escape');
        await shot(page, 'app-home-' + tag(w, t));
        await ctx.close();
      }
      { // legal draft notice, landing beta pill
        for (const [n, u] of [['notice-legal', '/legal.html'], ['landing-beta', '/index.html']]) {
          const { ctx, page } = await open(u, { width: w });
          await page.waitForTimeout(1500);
          if (t === 2) await textScale(page, 2);
          await shot(page, n + '-' + tag(w, t));
          await ctx.close();
        }
      }
      { // audio confirm in Settings > Audio (web monitor, custom sound saved)
        const { ctx, page } = await open('/hr_monitor.html?mode=online', { width: w, ws: true, mobile: false,
          init: `localStorage.setItem('hr_monitor_custom_audio', JSON.stringify({ high: { name: 'beep.mp3', dataUrl: 'data:audio/mp3;base64,AA==' } }));` });
        await page.waitForTimeout(2000);
        await page.evaluate(() => { const h = document.querySelector('.section[data-section="settings"] .section-header'); if (h) h.click(); });
        await page.waitForTimeout(300);
        await page.evaluate(() => { const b = document.querySelector('.tab[data-tab="audio"]'); if (b) b.click(); });
        await page.waitForTimeout(300);
        await page.locator('.audio-upload[data-type="high"]').dispatchEvent('contextmenu');
        const shown = await page.waitForSelector('.audio-grid .confirm', { timeout: 3000 }).then(() => true, () => false);
        if (shown) { if (t === 2) await textScale(page, 2); await page.locator('.audio-grid .confirm').scrollIntoViewIfNeeded(); await shot(page, 'confirm-audio-remove-' + tag(w, t)); }
        await ctx.close();
      }
    }
    ok('shots written to ' + SHOTS);
  }
} finally {
  await browser.close();
  server.close();
}
console.log(fails ? `${fails} FAILED` : 'PASS');
process.exit(fails ? 1 : 0);
