// Guards: web uploads while Drive sync is off; a Stop skipping the final upload (S4c). Files: hr_monitor.html, app-home.html. Runtime: about 90 s.
// S4c checks, headless. Web monitor on a fake strap, a fake folder and a fetch spy on Drive:
// sync on gives one upload per autosave tick and holds single flight; sync off gives zero uploads across
// five ticks while the folder write still happens; an old ?mode=offline link and a stored offline mode
// both read as sync off with no account prompt; a fresh install keeps broadcast off. After Stop on the
// web and the phone: where the recording went, the Drive line only when sync is on, View session; the
// unsaved notice and beforeunload. App home: gear, "Last recording ended", "No recordings yet".
// Negative control: the monitor with the gate line removed must fail the sync-off check.
// Usage: node scripts/monitor-sync.mjs [--shots <dir>] [--ux <ux-audit dir>]
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
const { fakeBridge } = await import(pathToFileURL(path.join(UX, 'scripts', 'fake-bridge.mjs')).href);
const { chromium } = createRequire(path.join(UX, 'kit', 'package.json'))('playwright');
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
for (const [www, src] of [['hr_monitor.html', 'function driveSyncOn'], ['index.html', 'hr_monitor_last_recording']]) {
  const f = path.join(ROOT, 'mobile', 'www', www);
  if (!fs.existsSync(f) || !fs.readFileSync(f, 'utf8').includes(src)) { console.log(`FAIL mobile/www/${www} is stale: run npm run copy-web in mobile first`); process.exit(1); }
}

const GATE = '    if (!driveSyncOn()) return;\n';
const monitorSrc = fs.readFileSync(path.join(ROOT, 'hr_monitor.html'), 'utf8').replace(/\r\n/g, '\n');
const gateCount = monitorSrc.split(GATE).length - 1;
const NEG = monitorSrc.replace(GATE, '');

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png', '.woff2': 'font/woff2' };
const server = http.createServer((req, res) => {
  let rel = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (rel === '/neg/hr_monitor.html') { res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' }); res.end(NEG); return; }
  if (rel.startsWith('/neg/')) rel = rel.slice(4);
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
const ALLOW = /^https?:\/\/(127\.0\.0\.1|fonts\.googleapis\.com|fonts\.gstatic\.com)(:|\/)/;

let fails = 0;
const fail = (m) => { fails++; console.log('FAIL ' + m); };
const pass = (m) => console.log('ok   ' + m);
const check = (ok, m, detail) => (ok ? pass(m) : fail(m + (detail ? ': ' + detail : '')));

// Strap ticking HR 88, a folder that keeps every write, a signed-in token when asked, Drive answered by a
// fetch spy, the autosave interval handed to the test as window.__tick, and sign-in prompts counted.
const FAKE_WEB = (o) => `(() => {
  const o = ${JSON.stringify(o)};
  window.__written = []; window.__drive = []; window.__prompts = 0; window.__uploadDelay = 0; window.__uploadFail = false;
  if (o.signedIn && !sessionStorage.getItem('__seeded')) {
    localStorage.setItem('aorti_auth_v2', JSON.stringify({ version: 2, access_token: 'fake-token', expires_at: Date.now() + 36e5, email: 'demo@example.com', scope: '', issued_at: Date.now() }));
  }
  if (o.seed && !sessionStorage.getItem('__seeded')) Object.entries(o.seed).forEach(([k, v]) => localStorage.setItem(k, v));
  sessionStorage.setItem('__seeded', '1');
  const realFetch = window.fetch.bind(window);
  window.fetch = async (u, init) => {
    const url = String(u && u.url || u);
    if (/googleapis\\.com/.test(url)) {
      const method = (init && init.method) || 'GET';
      const session = /upload\\/drive\\/v3\\/files/.test(url) && (/fields=id/.test(url) || method === 'PATCH');
      const rec = { url, method, session, done: false };
      window.__drive.push(rec);
      if (session && window.__uploadDelay) await new Promise((r) => setTimeout(r, window.__uploadDelay));
      rec.done = true;
      if (session && window.__uploadFail) return new Response('{}', { status: 500 });
      return new Response(JSON.stringify({ files: [], id: 'fake-file' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (/accounts\\.google\\.com|oauth2/.test(url)) window.__prompts++;
    return realFetch(u, init);
  };
  const realOpen = window.open; window.open = function () { window.__prompts++; return null; };
  const realSI = window.setInterval;
  window.setInterval = function (fn, ms) { if (fn && fn.name === 'writeAutoSave') { window.__tick = fn; return 990001; } return realSI.apply(this, arguments); };
  const file = (n) => ({ createWritable: async () => ({ write: async (c) => { window.__written.push({ n, c: String(c), at: Date.now() }); }, close: async () => {} }) });
  window.showDirectoryPicker = async () => ({ name: 'Sessions', kind: 'directory', queryPermission: async () => 'granted', requestPermission: async () => 'granted', getFileHandle: async (n) => file(n) });
  const listeners = [];
  const chr = { value: null, startNotifications: async () => chr, stopNotifications: async () => chr,
    addEventListener: (t, cb) => { if (t === 'characteristicvaluechanged') listeners.push(cb); }, removeEventListener: () => {} };
  let timer = null;
  const gatt = { connected: false,
    connect: async () => { gatt.connected = true; if (!timer) timer = realSI(() => {
      const b = new DataView(new ArrayBuffer(4)); b.setUint8(0, 0x10); b.setUint8(1, 88); b.setUint16(2, 698, true);
      chr.value = b; listeners.forEach((cb) => cb({ target: chr }));
    }, 1000); return server; },
    disconnect: () => { gatt.connected = false; clearInterval(timer); timer = null; } };
  const server = { device: null, connected: true,
    getPrimaryService: async (s) => { if (s === 'heart_rate' || s === 0x180d || s === 0x180D) return { getCharacteristic: async () => chr }; throw new Error('no service'); } };
  const device = { name: '808S Fake', id: 'fake', gatt, addEventListener: () => {}, removeEventListener: () => {}, watchAdvertisements: async () => {} };
  server.device = device;
  Object.defineProperty(navigator, 'bluetooth', { configurable: true, value: { getDevices: async () => [], requestDevice: async () => device, getAvailability: async () => true } });
})();`;

// S24: while a session runs, Stop sits behind the Controls header, closed on every load.
async function tapToggle(page) {
  if (await page.evaluate(() => { const s = document.getElementById('session-toggle').closest('.section'); return !!s && s.classList.contains('collapsed'); })) {
    await page.click('[data-section="controls"] .section-header');
    await page.waitForTimeout(300);
  }
  await page.click('#session-toggle');
}
async function textScale(page, f) {
  await page.evaluate((f) => {
    const els = [...document.querySelectorAll('body, body *')].filter((e) => !e.dataset.uxFs && !(e instanceof SVGElement));
    const sizes = els.map((e) => parseFloat(getComputedStyle(e).fontSize));
    els.forEach((e, i) => { e.dataset.uxFs = String(sizes[i]); e.style.setProperty('font-size', sizes[i] * f + 'px', 'important'); });
  }, f);
}

const browser = await chromium.launch().catch(() => chromium.launch({ channel: 'chrome' }));
const VIEW = { '360': { width: 360, height: 740 }, '360-text200': { width: 360, height: 740 }, '1440': { width: 1440, height: 900 } };

async function newPage({ size = '360', native = false, web = {}, bridge = null, extra = [], url }) {
  const phone = size !== '1440';
  const ctx = await browser.newContext({ viewport: VIEW[size], deviceScaleFactor: 1, isMobile: phone, hasTouch: phone, acceptDownloads: true });
  await ctx.route('**/*', (route) => {
    const u = route.request().url();
    if (/chart\.umd(\.min)?\.js/.test(u) && !u.startsWith('http://127.0.0.1')) return route.fulfill({ status: 200, contentType: 'text/javascript', body: fs.readFileSync(CHART) });
    if (/googleapis\.com\/(drive|upload)\//.test(u)) return route.fulfill({ status: 200, contentType: 'application/json', body: '{"files":[],"id":"fake-file"}' });
    if (ALLOW.test(u) || u.startsWith('data:') || u.startsWith('blob:')) return route.continue();
    const js = /\.js(\?|$)/.test(u) || route.request().resourceType() === 'script';
    return route.fulfill({ status: js ? 200 : 204, contentType: js ? 'text/javascript' : 'text/plain', body: '' });
  });
  if (native) {
    await ctx.addInitScript(fakeBridge(Object.assign({ scenario: 'live', savedStrap: true, signedIn: true, sessionAgeMs: 5 * 60000 }, bridge || {})));
    await ctx.addInitScript(`(() => { if (!localStorage.getItem('hr_monitor_widget_prefs')) localStorage.setItem('hr_monitor_widget_prefs', JSON.stringify({ customWidth: 263, customHeight: 208, fullWidgetsWidth: 263 })); })();`);
  } else {
    await ctx.addInitScript(FAKE_WEB(web));
  }
  for (const s of extra) await ctx.addInitScript(s);
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errs.push('console: ' + m.text().split('\n')[0]); });
  await page.goto(BASE + url, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1200);
  if (size === '360-text200') { await textScale(page, 2); await page.waitForTimeout(200); }
  return { ctx, page, errs };
}
const shot = async (page, name, full = true) => { if (/text200/.test(name)) await textScale(page, 2); if (SHOTS) await page.screenshot({ path: path.join(SHOTS, name + '.png'), fullPage: full }); };

async function startWeb(page, { folder = true } = {}) {
  if (folder) { await page.evaluate(() => document.getElementById('autosave-toggle').click()); await page.waitForTimeout(300); }
  await tapToggle(page);
  await page.waitForFunction(() => document.getElementById('session-toggle').textContent.trim() === 'Stop session', null, { timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(800);
}
const sessionUploads = (page) => page.evaluate(() => window.__drive.filter((r) => r.session).length);
const pending = (page) => page.evaluate(() => window.__drive.some((r) => !r.done));
async function settle(page) { for (let i = 0; i < 40 && await pending(page); i++) await page.waitForTimeout(100); }
async function afterStop(page) {
  return page.evaluate(() => {
    const vis = (e) => !!e && !e.hidden && getComputedStyle(e).display !== 'none' && e.getBoundingClientRect().height > 0;
    const b = document.getElementById('after-stop');
    const v = document.getElementById('after-stop-view');
    const d = document.getElementById('after-stop-drive');
    const x = document.getElementById('after-stop-export');
    const t = document.querySelector('.toast-host .toast');
    return { shown: vis(b), saved: document.getElementById('after-stop-saved').textContent, drive: vis(d) ? d.textContent : null,
      view: vis(v) ? v.getAttribute('href') : null, viewH: vis(v) ? Math.round(v.getBoundingClientRect().height) : 0, exp: vis(x),
      toast: !!t, posture: document.querySelectorAll('.posture-btn').length,
      overflow: document.documentElement.scrollWidth > innerWidth + 1 };
  });
}
const unload = (page) => page.evaluate(() => { const e = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(e); return e.defaultPrevented; });
const today = () => { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };

// Sync off: five forced ticks write the folder five times and upload nothing.
async function syncOffCase(url, label) {
  const { ctx, page, errs } = await newPage({ size: '1440', web: { signedIn: true, seed: { hr_monitor_drive_sync: '0' } }, url });
  await startWeb(page);
  await page.waitForTimeout(600);
  await settle(page);
  const w0 = await page.evaluate(() => window.__written.length);
  const u0 = await sessionUploads(page);
  for (let i = 0; i < 5; i++) { await page.evaluate(() => window.__tick()); await settle(page); }
  const r = { writes: (await page.evaluate(() => window.__written.length)) - w0, uploads: await sessionUploads(page), before: u0, tick: await page.evaluate(() => typeof window.__tick) };
  await ctx.close();
  return { r, errs, ok: r.tick === 'function' && r.uploads === 0 && r.writes === 5 };
}

try {
  check(gateCount === 1, 'hr_monitor.html: the gate line appears once, as the first line of driveUploadSession', String(gateCount));
  check(/async function driveUploadSession\(filename, csvText\) \{\n    if \(!driveSyncOn\(\)\) return;\n/.test(monitorSrc), 'driveUploadSession opens with the gate line');
  const idx = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const monLinks = idx.match(/href="[^"]*hr_monitor\.html[^"]*"/g) || [];
  check(!/mode=offline/.test(idx) && monLinks.length >= 2 && monLinks.every((h) => h === 'href="./hr_monitor.html"'), 'index.html: every Open monitor link is a plain link to the monitor', monLinks.join(' '));
  check(!/mode=offline/.test(fs.readFileSync(path.join(ROOT, 'app-home.html'), 'utf8')), 'app-home.html: no Offline mode link');
  check(!/mode-offline|__hrMonitorMode/.test(monitorSrc), 'hr_monitor.html: no mode-offline rules and no __hrMonitorMode');

  // 1. Sync on: one upload per tick, single flight held.
  {
    const { ctx, page, errs } = await newPage({ size: '1440', web: { signedIn: true }, url: '/hr_monitor.html' });
    await page.waitForFunction(() => /Syncing to Drive/.test(document.getElementById('drive-status').textContent), null, { timeout: 6000 }).catch(() => {});
    await page.click('.section[data-section="connection"] .section-header');
    const tog = await page.evaluate(() => { const t = document.getElementById('drive-sync-toggle'); return { on: t.getAttribute('aria-checked'), shown: getComputedStyle(t).visibility === 'visible' && !document.getElementById('drive-sync-wrap').hidden, h: Math.round(t.getBoundingClientRect().height) }; });
    check(tog.on === 'true' && tog.shown && tog.h >= 44, 'web: Drive sync toggle shown and on by default, 44 px or more', JSON.stringify(tog));
    await startWeb(page);
    await settle(page);
    const u0 = await sessionUploads(page);
    for (let i = 0; i < 5; i++) { await page.evaluate(() => window.__tick()); await settle(page); }
    const per = (await sessionUploads(page)) - u0;
    check(per === 5, 'sync on: five ticks give five uploads, one per tick', String(per));
    await page.evaluate(() => { window.__uploadDelay = 1500; });
    const u1 = await sessionUploads(page);
    await page.evaluate(async () => { await window.__tick(); await window.__tick(); await window.__tick(); });
    await page.waitForTimeout(200);
    const burst = (await sessionUploads(page)) - u1;
    check(burst === 1, 'sync on: three ticks during one running upload give one upload (single flight)', String(burst));
    await settle(page);
    await page.evaluate(() => { window.__uploadDelay = 0; });
    await page.waitForTimeout(3500);
    const notice = await page.$('#unsaved-notice');
    check(!notice, 'sync on with a folder: no unsaved notice');
    check(!(await unload(page)), 'sync on with a folder: leaving the page does not ask');
    // Stop: folder line, then the Drive result.
    await tapToggle(page);
    await page.waitForFunction(() => /Saved to Drive|failed/.test(document.getElementById('after-stop-drive').textContent), null, { timeout: 8000 }).catch(() => {});
    const a = await afterStop(page);
    check(a.shown && /^Saved to Sessions · \d+:\d\d$/.test(a.saved) && a.drive === 'Saved to Drive' && a.view === './hrv_viewer.html#/day/' + today() && a.viewH >= 36 && !a.exp,
      'web Stop, sync on: "Saved to Sessions · m:ss", Drive line "Saved to Drive", View session opens today', JSON.stringify(a));
    await shot(page, 'web-after-stop-sync-on-1440', false);
    // Start again: the block leaves.
    await tapToggle(page);
    await page.waitForTimeout(1200);
    check(!(await afterStop(page)).shown, 'web: the after-Stop block leaves when a new session starts');
    // Toggle off from the UI.
    await page.click('#drive-sync-toggle');
    const off = await page.evaluate(() => ({ aria: document.getElementById('drive-sync-toggle').getAttribute('aria-checked'), ls: localStorage.getItem('hr_monitor_drive_sync'), st: document.getElementById('drive-status').textContent }));
    check(off.aria === 'false' && off.ls === '0' && off.st === 'Sync off', 'web: tapping Drive sync turns it off and stores it', JSON.stringify(off));
    if (errs.length) fail('web sync on: page errors ' + errs.join('; '));
    await ctx.close();
  }

  // 2. Sync off: zero uploads across five ticks, the folder still written; negative control without the gate.
  {
    const r = await syncOffCase('/hr_monitor.html', 'sync off');
    check(r.ok, 'sync off: five ticks give zero uploads and five folder writes', JSON.stringify(r.r));
    if (r.errs.length) fail('sync off: page errors ' + r.errs.join('; '));
    const n = await syncOffCase('/neg/hr_monitor.html', 'negative');
    check(!n.ok && n.r.uploads > 0, 'negative control: with the gate line removed the sync-off check fails (uploads happen)', JSON.stringify(n.r));
  }

  // 2b. Stop while an upload runs: the final upload waits for it instead of being skipped; a failing upload says so.
  {
    const { ctx, page, errs } = await newPage({ size: '1440', web: { signedIn: true }, url: '/hr_monitor.html' });
    await page.waitForFunction(() => /Syncing to Drive/.test(document.getElementById('drive-status').textContent), null, { timeout: 6000 }).catch(() => {});
    await startWeb(page);
    await settle(page);
    await page.evaluate(() => { window.__uploadDelay = 3000; });
    const u0 = await sessionUploads(page);
    await page.evaluate(() => window.__tick());
    await page.waitForTimeout(100);
    await tapToggle(page);
    await page.waitForTimeout(300);
    const label = await page.evaluate(() => document.getElementById('session-toggle').textContent.trim());
    check(label === 'Saving', 'web Stop during an upload: the button reads Saving while it waits', label);
    await page.waitForFunction(() => /Saved to Drive|failed|incomplete|confirmed/.test(document.getElementById('after-stop-drive').textContent), null, { timeout: 12000 }).catch(() => {});
    const n = (await sessionUploads(page)) - u0;
    const a = await afterStop(page);
    check(n === 2 && a.drive === 'Saved to Drive', 'web Stop during an upload: the running upload and the final one both go (2), then "Saved to Drive"', JSON.stringify({ n, drive: a.drive }));
    if (errs.length) fail('web stop during upload: page errors ' + errs.join('; '));
    await ctx.close();
  }
  {
    const { ctx, page, errs } = await newPage({ size: '1440', web: { signedIn: true }, url: '/hr_monitor.html' });
    await page.waitForFunction(() => /Syncing to Drive/.test(document.getElementById('drive-status').textContent), null, { timeout: 6000 }).catch(() => {});
    await startWeb(page);
    await settle(page);
    await page.evaluate(() => { window.__uploadFail = true; });
    await tapToggle(page);
    await page.waitForFunction(() => /Saved to Drive|failed/.test(document.getElementById('after-stop-drive').textContent), null, { timeout: 8000 }).catch(() => {});
    const a = await afterStop(page);
    check(/^Saved to Sessions · /.test(a.saved) && a.drive === 'Drive upload failed', 'web Stop with a failing upload: "Drive upload failed"', JSON.stringify(a));
    await shot(page, 'web-after-stop-drive-failed-1440', false);
    const other = errs.filter((e) => !/Drive upload failed/.test(e));
    if (other.length) fail('web failing upload: page errors ' + other.join('; '));
    await ctx.close();
  }

  // 3. Sync off, after Stop: folder line, no Drive line.
  for (const size of ['360', '360-text200', '1440']) {
    const { ctx, page, errs } = await newPage({ size, web: { signedIn: true, seed: { hr_monitor_drive_sync: '0' } }, url: '/hr_monitor.html' });
    await startWeb(page);
    await tapToggle(page);
    await page.waitForTimeout(1200);
    const a = await afterStop(page);
    check(a.shown && /^Saved to Sessions · /.test(a.saved) && a.drive === null && !!a.view && !a.overflow, `web ${size} Stop, sync off: folder line, no Drive line, View session, no sideways scroll`, JSON.stringify(a));
    await shot(page, `web-after-stop-${size}`, size !== '1440');
    if (errs.length) fail(`web ${size}: page errors ` + errs.join('; '));
    await ctx.close();
  }

  // 4. Old ?mode=offline link and stored modes; fresh install broadcast off.
  {
    const { ctx, page, errs } = await newPage({ size: '1440', url: '/hr_monitor.html?mode=offline' });
    const r = await page.evaluate(() => ({ sync: localStorage.getItem('hr_monitor_drive_sync'), mode: localStorage.getItem('hr_monitor_mode'), url: location.search,
      aria: document.getElementById('drive-sync-toggle').getAttribute('aria-checked'), cls: document.body.className,
      sheet: !!document.querySelector('.sheet'), prompts: window.__prompts, bc: document.getElementById('toggle-broadcast').checked }));
    check(r.sync === '0' && r.mode === null && r.url === '' && r.aria === 'false' && !/mode-/.test(r.cls), 'old ?mode=offline link: sync off, mode dropped from the address and storage', JSON.stringify(r));
    check(!r.sheet && r.prompts === 0, 'old ?mode=offline link: no account prompt', JSON.stringify(r));
    check(r.bc === false, 'fresh install: broadcast off');
    if (errs.length) fail('offline link: page errors ' + errs.join('; '));
    await ctx.close();
  }
  for (const [stored, want] of [['offline', '0'], ['online', null]]) {
    const { ctx, page, errs } = await newPage({ size: '1440', web: { seed: { hr_monitor_mode: stored } }, url: '/hr_monitor.html' });
    const r = await page.evaluate(() => ({ sync: localStorage.getItem('hr_monitor_drive_sync'), mode: localStorage.getItem('hr_monitor_mode'), aria: document.getElementById('drive-sync-toggle').getAttribute('aria-checked') }));
    check(r.sync === want && r.mode === null && r.aria === (want === '0' ? 'false' : 'true'), `stored mode ${stored}: reads as sync ${want === '0' ? 'off' : 'on'}, old key removed`, JSON.stringify(r));
    if (errs.length) fail(`stored ${stored}: page errors ` + errs.join('; '));
    await ctx.close();
  }
  {
    const { ctx, page, errs } = await newPage({ size: '1440', url: '/hr_monitor.html?mode=online' });
    const r = await page.evaluate(() => ({ bc: document.getElementById('toggle-broadcast').checked, p: JSON.parse(localStorage.getItem('hr_monitor_widget_prefs') || 'null'), url: location.search }));
    check(r.bc === false && !(r.p && r.p.broadcast) && r.url === '', 'fresh install from a ?mode=online link: broadcast off', JSON.stringify(r));
    if (errs.length) fail('online link: page errors ' + errs.join('; '));
    await ctx.close();
  }

  // 5. Unsaved web session: notice, beforeunload, Stop keeps the CSV for Export.
  for (const size of ['360', '360-text200', '1440']) {
    const { ctx, page, errs } = await newPage({ size, url: '/hr_monitor.html' });
    await startWeb(page, { folder: false });
    await page.waitForSelector('#unsaved-notice', { timeout: 6000 }).catch(() => {});
    const n = await page.evaluate(() => { const e = document.getElementById('unsaved-notice'); return e ? { text: e.querySelector('.msg').textContent, btn: [...e.querySelectorAll('.btn')].map((b) => b.textContent + ':' + Math.round(b.getBoundingClientRect().height)) } : null; });
    check(n && n.text === 'Not saved to a folder or Drive' && n.btn.length === 1 && /^Export CSV:(4[4-9]|[5-9]\d)/.test(n.btn[0]), `web ${size} unsaved: notice with Export CSV, 44 px`, JSON.stringify(n));
    check(await unload(page), `web ${size} unsaved: leaving the page asks first`);
    await shot(page, `web-unsaved-${size}`, size !== '1440');
    await tapToggle(page);
    await page.waitForTimeout(1200);
    const a = await afterStop(page);
    check(a.shown && /^Not saved · /.test(a.saved) && a.exp && a.view === null && a.drive === null && !(await page.$('#unsaved-notice')), `web ${size} Stop unsaved: "Not saved", Export CSV, no View session, notice gone`, JSON.stringify(a));
    check(await unload(page), `web ${size} Stop unsaved: leaving still asks until exported`);
    await shot(page, `web-after-stop-unsaved-${size}`, size !== '1440');
    if (size === '1440') {
      const dl = page.waitForEvent('download', { timeout: 4000 }).catch(() => null);
      await page.click('#after-stop-export');
      const d = await dl;
      check(!!d && /\.csv$/.test(d.suggestedFilename()), 'web Stop unsaved: Export CSV downloads the stopped session', d ? d.suggestedFilename() : 'no download');
      check(!(await afterStop(page)).exp, 'web after Export: the Export CSV button leaves');
      check(!(await unload(page)), 'web after Export: leaving no longer asks');
    }
    if (errs.length) fail(`web unsaved ${size}: page errors ` + errs.join('; '));
    await ctx.close();
  }

  // 6. Phone app: Stop shows "Saved on this phone", the Drive line, View session; sync gate stays open.
  for (const size of ['360', '360-text200', '1440']) {
    const { ctx, page, errs } = await newPage({ size, native: true, extra: [`localStorage.setItem('hr_monitor_drive_sync', '0');`], url: '/www/hr_monitor.html' });
    await page.waitForFunction(() => document.getElementById('session-toggle').textContent.trim() === 'Stop session', null, { timeout: 10000 }).catch(() => {});
    const g = await page.evaluate(() => ({ wrap: document.getElementById('drive-sync-wrap').hidden }));
    check(g.wrap, `native ${size}: no Drive sync toggle on the phone`);
    if (size === '360-text200') await textScale(page, 2);
    await tapToggle(page);
    await page.waitForTimeout(1500);
    const a = await afterStop(page);
    check(a.shown && /^Saved on this phone · 5:\d\d$/.test(a.saved) && a.drive === 'Queued for Drive' && a.view === './hrv_viewer.html#/day/' + (await page.evaluate(() => { const d = new Date(Date.now() - 5 * 60000); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); })) && !a.exp,
      `native ${size} Stop: "Saved on this phone · 5:ss", "Queued for Drive", View session`, JSON.stringify(a));
    check(!a.toast && a.posture === 3 && !a.overflow, `native ${size} Stop: no Drive toast, posture row kept, no sideways scroll`, JSON.stringify(a));
    const last = await page.evaluate(() => JSON.parse(localStorage.getItem('hr_monitor_last_recording') || 'null'));
    check(last && last.end - last.start >= 5 * 60000 && last.end - last.start < 6 * 60000, `native ${size} Stop: last recording stored`, JSON.stringify(last));
    if (size === '360') {
      const calls = await page.evaluate(() => window.__fake.calls.filter((c) => /stopSession/.test(c)).length);
      check(calls === 1, 'native Stop: the engine is told once', String(calls));
    }
    await shot(page, `native-after-stop-${size}`, size !== '1440');
    if (errs.length) fail(`native ${size}: page errors ` + errs.join('; '));
    await ctx.close();
  }
  // A session that ends elsewhere while the page watches is stored too.
  {
    const { ctx, page, errs } = await newPage({ native: true, url: '/www/hr_monitor.html' });
    await page.waitForFunction(() => document.getElementById('session-toggle').textContent.trim() === 'Stop session', null, { timeout: 10000 }).catch(() => {});
    await page.waitForTimeout(1500);
    await page.evaluate(() => { const F = window.__fake; F.snapshot = JSON.parse(JSON.stringify(F.states.IDLE)); document.dispatchEvent(new Event('visibilitychange')); });
    await page.waitForFunction(() => !!localStorage.getItem('hr_monitor_last_recording'), null, { timeout: 8000 }).catch(() => {});
    const last = await page.evaluate(() => JSON.parse(localStorage.getItem('hr_monitor_last_recording') || 'null'));
    check(last && last.end - last.start >= 5 * 60000, 'native: a session stopped from the notification is stored as the last recording', JSON.stringify(last));
    if (errs.length) fail('native ended elsewhere: page errors ' + errs.join('; '));
    await ctx.close();
  }

  // 7. App home: gear, last recording line, no recordings yet, segment fallback; the gear opens Settings.
  const segs = (list) => `(() => { const p = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.NativeHrSession; if (p) p.listSegments = () => Promise.resolve({ segments: ${JSON.stringify(list)} }); })();`;
  const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const end = Date.now() - 3 * 3600e3;
  const start = end - (11 * 60 + 28) * 60000;
  const endD = new Date(end);
  const hhmm = String(endD.getHours()).padStart(2, '0') + ':' + String(endD.getMinutes()).padStart(2, '0');
  const startD = new Date(start);
  const isoStart = startD.getFullYear() + '-' + String(startD.getMonth() + 1).padStart(2, '0') + '-' + String(startD.getDate()).padStart(2, '0');
  for (const size of ['360', '360-text200', '1440']) {
    const { ctx, page, errs } = await newPage({ size, native: true, bridge: { scenario: 'idle' },
      extra: [segs([{ name: 'a', base: start, size: 10, mtime: end - 1000, open: false }]), `localStorage.setItem('hr_monitor_last_recording', JSON.stringify({ start: ${start}, end: ${end} }));`], url: '/www/index.html' });
    await page.waitForTimeout(600);
    const h = await page.evaluate(() => {
      const a = document.querySelector('#app-last a');
      const g = document.querySelector('.app-gear');
      const gr = g && g.getBoundingClientRect();
      return { text: a ? a.textContent : document.getElementById('app-last').textContent, href: a && a.getAttribute('href'), ah: a ? Math.round(a.getBoundingClientRect().height) : 0,
        gear: g && g.getAttribute('href'), gw: gr && Math.round(gr.width), gh: gr && Math.round(gr.height), label: g && g.getAttribute('aria-label'),
        offline: [...document.querySelectorAll('a')].some((x) => /offline/i.test(x.textContent + x.getAttribute('href'))), overflow: document.documentElement.scrollWidth > innerWidth + 1 };
    });
    check(h.text === `Last recording ended ${DAYS[endD.getDay()]} ${hhmm} · 11h 28m long` && h.href === './hrv_viewer.html#/day/' + isoStart && h.ah >= 44,
      `app home ${size}: "Last recording ended" with day, time and length, opens the recording's first day, 44 px`, JSON.stringify(h));
    check(h.gear === './hr_monitor.html#settings' && h.gw >= 44 && h.gh >= 44 && h.label === 'Settings' && !h.offline && !h.overflow, `app home ${size}: 44 px gear to Settings, no Offline mode link`, JSON.stringify(h));
    const reach = await page.evaluate(() => { window.scrollTo(0, document.documentElement.scrollHeight); const v = [...document.querySelectorAll('.app-secondary')].find((a) => a.textContent === 'Viewer'); const r = v.getBoundingClientRect(); return { bottom: Math.round(r.bottom), h: innerHeight }; });
    check(reach.bottom <= reach.h, `app home ${size}: the Viewer link can be scrolled into view`, JSON.stringify(reach));
    await page.evaluate(() => window.scrollTo(0, 0));
    await shot(page, `app-home-${size}`, size === '360-text200');
    if (errs.length) fail(`app home ${size}: page errors ` + errs.join('; '));
    await ctx.close();
  }
  {
    const { ctx, page, errs } = await newPage({ native: true, bridge: { scenario: 'idle' }, extra: [segs([])], url: '/www/index.html' });
    await page.waitForTimeout(600);
    const t = await page.evaluate(() => { const e = document.getElementById('app-last'); return e.hidden ? null : e.textContent; });
    check(t === 'No recordings yet', 'app home, no recordings: "No recordings yet"', String(t));
    await shot(page, 'app-home-no-recordings-360', false);
    if (errs.length) fail('app home empty: page errors ' + errs.join('; '));
    await ctx.close();
  }
  {
    const later = Date.now() - 3600e3;
    const { ctx, page, errs } = await newPage({ native: true, bridge: { scenario: 'idle' },
      extra: [segs([{ name: 'b', base: later - 600000, size: 10, mtime: later, open: false }]), `localStorage.setItem('hr_monitor_last_recording', JSON.stringify({ start: ${start}, end: ${end} }));`], url: '/www/index.html' });
    await page.waitForTimeout(600);
    const t = await page.evaluate(() => document.getElementById('app-last').textContent);
    const ld = new Date(later);
    check(t === `Last recording ended ${DAYS[ld.getDay()]} ${String(ld.getHours()).padStart(2, '0')}:${String(ld.getMinutes()).padStart(2, '0')}`, 'app home: a later closed segment (stopped from the notification) wins, without a length', t);
    if (errs.length) fail('app home segment: page errors ' + errs.join('; '));
    await ctx.close();
  }
  {
    const { ctx, page, errs } = await newPage({ native: true, bridge: { scenario: 'idle' }, url: '/www/hr_monitor.html#settings' });
    await page.waitForTimeout(400);
    const s = await page.evaluate(() => { const sec = document.querySelector('.section[data-section="settings"]'); const r = sec.getBoundingClientRect(); return { open: !sec.classList.contains('collapsed'), exp: sec.querySelector('.section-header').getAttribute('aria-expanded'), top: Math.round(r.top), focus: document.activeElement && document.activeElement.classList.contains('section-header') }; });
    check(s.open && s.exp === 'true' && s.top < 740 && s.focus, 'monitor #settings: the Settings section opens, in view, header focused', JSON.stringify(s));
    if (errs.length) fail('monitor #settings: page errors ' + errs.join('; '));
    await ctx.close();
  }
} finally {
  await browser.close();
  server.close();
}
console.log(fails ? `${fails} FAILED` : 'monitor-sync: all pass');
process.exit(fails ? 1 : 0);
