// S4e: on a native session the app shows the engine's RMSSD, the number the bubble and the stream show. S54: native shows the engine's HR pick; web shows the twin's.
// Bug it guards (2026-10-11, S8): at session start the app read 13 while bubble and stream read 24, because
// the page recomputed RMSSD from the beats that reached it instead of using the engine's value.
// Cases: ticks whose RRs give 40 ms but carry rmssd 24 show 24; ticks without an engine value never show the
// page's own figure. N3: native HR 150 with beats worth 100 shows 150 (the twin never runs on native). N4: web
// Web Bluetooth with strap byte 80 and beats worth 160 shows 150 to 170 within 8 s. Each has a served-file mutant
// that must FAIL it. Page errors fail every case.
// Usage: node scripts/native-rmssd.mjs [--ux <ux-audit dir>]. Needs mobile/www from `npm run copy-web`.

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
const CHART = path.join(UX, '..', 'docs', 'audit-2026-10-09', 'harness-DT', 'vendor', 'chart.umd.min.js');
const { fakeBridge } = await import(pathToFileURL(path.join(UX, 'scripts', 'fake-bridge.mjs')).href);
const { chromium } = createRequire(path.join(UX, 'kit', 'package.json'))('playwright');

const wwwMon = path.join(ROOT, 'mobile', 'www', 'hr_monitor.html');
if (!fs.existsSync(wwwMon) || !fs.readFileSync(wwwMon, 'utf8').includes('engineRmssd')) {
  console.log('FAIL mobile/www/hr_monitor.html is missing or stale: run npm run copy-web in mobile first'); process.exit(1);
}
const wwwSrc = path.join(ROOT, 'mobile', 'www', 'hr-source.js');
if (!fs.existsSync(wwwSrc) || fs.readFileSync(wwwSrc, 'utf8') !== fs.readFileSync(path.join(ROOT, 'hr-source.js'), 'utf8')
  || !fs.readFileSync(wwwMon, 'utf8').includes('webHrSource')) {
  console.log('FAIL mobile/www/hr-source.js is missing or stale: run npm run copy-web in mobile first'); process.exit(1);
}
// [find, replace] applied to hr_monitor.html as served (both the www and the root copy).
let MUTATE = null, anchorMissing = false;

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png', '.woff2': 'font/woff2' };
const server = http.createServer((req, res) => {
  let rel = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  let base = ROOT;
  if (rel.startsWith('/www/')) { base = path.join(ROOT, 'mobile', 'www'); rel = rel.slice(4); }
  let file = path.join(base, rel);
  if (!fs.existsSync(file)) file = path.join(ROOT, rel);
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  if (MUTATE && path.basename(file) === 'hr_monitor.html') {
    const text = fs.readFileSync(file, 'utf8');
    if (!text.includes(MUTATE[0])) anchorMissing = true;
    res.end(text.replace(MUTATE[0], MUTATE[1]));
    return;
  }
  fs.createReadStream(file).pipe(res);
});
await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
const BASE = `http://127.0.0.1:${server.address().port}`;
const ALLOW = /^https?:\/\/(127\.0\.0\.1|fonts\.googleapis\.com|fonts\.gstatic\.com)(:|\/)/;

let fails = 0;
const fail = (m) => { fails++; console.log('FAIL ' + m); };
const pass = (m) => console.log('ok   ' + m);
const browser = await chromium.launch().catch(() => chromium.launch({ channel: 'chrome' }));

// The fake's own ticks are swallowed; the test drives the page's hr listener by hand.
const CAPTURE = `(() => { const h = window.Capacitor && window.Capacitor.Plugins.NativeHrSession; if (!h) return;
  const add = h.addListener; h.addListener = (n, cb) => { if (n === 'hr') { window.__hrCb = cb; return Promise.resolve({ remove() {} }); } return add(n, cb); }; })();`;

// The app page on a live native session with the hr listener captured.
async function nativePage() {
  const ctx = await browser.newContext({ viewport: { width: 360, height: 740 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
  await ctx.route('**/*', (route) => routeFor(route));
  await ctx.addInitScript(fakeBridge({ scenario: 'live', savedStrap: true, signedIn: true, sessionAgeMs: 600000 }));
  await ctx.addInitScript(CAPTURE);
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  await page.goto(`${BASE}/www/hr_monitor.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof window.__hrCb === 'function', null, { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(800);
  return { ctx, page, errs };
}

async function run(label, withEngine, expect) {
  const { ctx, page, errs } = await nativePage();
  const shown = await page.evaluate(async (withEngine) => {
    if (typeof window.__hrCb !== 'function') return 'no hr listener';
    // Alternating 800/840 ms beats: the page's own RMSSD would be 40.
    for (let i = 0; i < 12; i++) {
      const d = { hr: 73, rrIntervals: [i % 2 ? 840 : 800], timestampMs: Date.now(), contactOff: false };
      if (withEngine) d.rmssd = 24.2;
      window.__hrCb(d);
      await new Promise((r) => setTimeout(r, 30));
    }
    await new Promise((r) => setTimeout(r, 300));
    const el = document.getElementById('compact-hrv-value');
    return el ? el.textContent.trim() : 'no #compact-hrv-value';
  }, withEngine);
  if (expect(shown)) pass(`${label}: shows "${shown}"`); else fail(`${label}: shows "${shown}"`);
  if (errs.length) fail(`${label}: page errors: ${errs.join(' | ')}`);
  await ctx.close();
}

// N3: native ticks, HR 150 with one 600 ms beat each (100 bpm; 80 bpm would sit within 10% of half the strap, where the twin keeps the strap anyway), engine RMSSD present. Returns #hr-big.
async function n3() {
  const { ctx, page, errs } = await nativePage();
  const shown = await page.evaluate(async () => {
    if (typeof window.__hrCb !== 'function') return 'no hr listener';
    for (let i = 0; i < 16; i++) {
      window.__hrCb({ hr: 150, rrIntervals: [600], rmssd: 24.2, timestampMs: Date.now(), contactOff: false });
      await new Promise((r) => setTimeout(r, 250));
    }
    await new Promise((r) => setTimeout(r, 200));
    const el = document.getElementById('hr-big');
    return el ? el.textContent.trim() : 'no #hr-big';
  });
  await ctx.close();
  return { shown, errs };
}

// N4: desktop Web Bluetooth; each 1 s packet carries strap byte 80 and two or three RR of raw 384 (375 ms, 160 bpm).
const FAKE_WEB_LAG = `(() => {
  window.showDirectoryPicker = async () => ({ name: 'fake', kind: 'directory', queryPermission: async () => 'granted', requestPermission: async () => 'granted',
    getFileHandle: async () => ({ createWritable: async () => ({ write: async () => {}, close: async () => {} }) }) });
  const listeners = [];
  const chr = { value: null, startNotifications: async () => chr, stopNotifications: async () => chr,
    addEventListener: (t, cb) => { if (t === 'characteristicvaluechanged') listeners.push(cb); }, removeEventListener: () => {} };
  let timer = null, k = 0;
  const gatt = { connected: false,
    connect: async () => { gatt.connected = true; if (!timer) timer = setInterval(() => {
      const n = (k++ % 3 === 2) ? 2 : 3;
      const b = new DataView(new ArrayBuffer(2 + 2 * n)); b.setUint8(0, 0x10); b.setUint8(1, 80);
      for (let i = 0; i < n; i++) b.setUint16(2 + 2 * i, 384, true);
      chr.value = b; listeners.forEach((cb) => cb({ target: chr }));
    }, 1000); return server; },
    disconnect: () => { gatt.connected = false; clearInterval(timer); timer = null; } };
  const server = { device: null, connected: true,
    getPrimaryService: async (s) => { if (s === 'heart_rate' || s === 0x180d || s === 0x180D) return { getCharacteristic: async () => chr }; throw new Error('no service'); } };
  const device = { name: '808S Fake', id: 'fake', gatt, addEventListener: () => {}, removeEventListener: () => {}, watchAdvertisements: async () => {} };
  server.device = device;
  Object.defineProperty(navigator, 'bluetooth', { configurable: true, value: { getDevices: async () => [], requestDevice: async () => device, getAvailability: async () => true } });
})();`;
async function n4() {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  await ctx.route('**/*', (route) => routeFor(route));
  await ctx.addInitScript(FAKE_WEB_LAG);
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  await page.goto(`${BASE}/hr_monitor.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1200);
  await page.evaluate(() => document.getElementById('autosave-toggle').click());
  await page.waitForTimeout(300);
  await page.click('#session-toggle');
  const t0 = Date.now();
  let seen = [];
  while (Date.now() - t0 < 8000) {
    seen.push(await page.evaluate(() => { const el = document.getElementById('hr-big'); return el ? el.textContent.trim() : ''; }));
    const v = Number(seen[seen.length - 1]);
    if (v >= 150 && v <= 170) break;
    await page.waitForTimeout(250);
  }
  await ctx.close();
  return { shown: seen[seen.length - 1], trail: [...new Set(seen)].join(' '), errs };
}
function routeFor(route) {
  const u = route.request().url();
  if (/chart\.umd(\.min)?\.js/.test(u) && !u.startsWith('http://127.0.0.1')) return route.fulfill({ status: 200, contentType: 'text/javascript', body: fs.readFileSync(CHART) });
  if (/googleapis\.com\/(drive|upload)\//.test(u)) return route.fulfill({ status: 200, contentType: 'application/json', body: '{"files":[],"id":"fake-folder"}' });
  if (ALLOW.test(u) || u.startsWith('data:') || u.startsWith('blob:')) return route.continue();
  const js = /\.js(\?|$)/.test(u) || route.request().resourceType() === 'script';
  return route.fulfill({ status: js ? 200 : 204, contentType: js ? 'text/javascript' : 'text/plain', body: '' });
}
const n3ok = (r) => r.shown === '150' && !r.errs.length;
const n4ok = (r) => Number(r.shown) >= 150 && Number(r.shown) <= 170 && !r.errs.length;

await run('engine rmssd 24.2 with beats worth 40', true, (t) => t === '24');
await run('no engine rmssd', false, (t) => t !== '40');
{
  const r = await n3();
  if (n3ok(r)) pass(`N3 native HR 150 with beats worth 100: #hr-big shows "${r.shown}"`); else fail(`N3 native: #hr-big shows "${r.shown}"${r.errs.length ? ' errors ' + r.errs.join(' | ') : ''}`);
}
{
  const r = await n4();
  if (n4ok(r)) pass(`N4 web strap 80 with beats worth 160: #hr-big shows "${r.shown}" within 8 s (${r.trail})`); else fail(`N4 web: #hr-big shows "${r.shown}" (${r.trail})${r.errs.length ? ' errors ' + r.errs.join(' | ') : ''}`);
}
// Mutants: each must make its case FAIL.
const MUTANTS = [
  ['N3 twin runs on native', ['engineRmssd === undefined && webHrSource.policy', 'webHrSource.policy'], n3, n3ok],
  ['N4 shown value dropped', ['hr = webHrSource.policy.onPacket(hr, rrs, Date.now()).shown;', 'webHrSource.policy.onPacket(hr, rrs, Date.now());'], n4, n4ok],
];
for (const [name, swap, fn, ok] of MUTANTS) {
  MUTATE = swap; anchorMissing = false;
  const r = await fn();
  MUTATE = null;
  if (anchorMissing) fail(`mutant ${name}: anchor missing`);
  else if (ok(r)) fail(`mutant ${name}: SURVIVED (shows "${r.shown}")`);
  else pass(`mutant ${name}: FAILED as required (shows "${r.shown}")`);
}
await browser.close();
server.close();
console.log(fails ? `${fails} failed` : 'all passed');
process.exit(fails ? 1 : 0);
