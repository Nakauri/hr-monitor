// S4e: on a native session the app shows the engine's RMSSD, the number the bubble and the stream show.
// Bug it guards (2026-10-11, S8): at session start the app read 13 while bubble and stream read 24, because
// the page recomputed RMSSD from the beats that reached it instead of using the engine's value.
// Cases: ticks whose RRs give 40 ms but carry rmssd 24 show 24; ticks without an engine value never show the
// page's own figure. Page errors fail every case.
// Usage: node scripts/native-rmssd.mjs [--ux <ux-audit dir>]. Needs mobile/www from `npm run copy-web`.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const argVal = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const ROOT = path.resolve(here, '..');
const UX = path.resolve(argVal('--ux') || 'C:/Users/Khal/Desktop/Mine/HR Monitor/ux-audit');
const CHART = path.join(UX, '..', 'docs', 'audit-2026-10-09', 'harness-DT', 'vendor', 'chart.umd.min.js');
const { fakeBridge } = await import(pathToFileURL(path.join(UX, 'scripts', 'fake-bridge.mjs')).href);
const { chromium } = createRequire(path.join(UX, 'kit', 'package.json'))('playwright');

const wwwMon = path.join(ROOT, 'mobile', 'www', 'hr_monitor.html');
if (!fs.existsSync(wwwMon) || !fs.readFileSync(wwwMon, 'utf8').includes('engineRmssd')) {
  console.log('FAIL mobile/www/hr_monitor.html is missing or stale: run npm run copy-web in mobile first'); process.exit(1);
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
const ALLOW = /^https?:\/\/(127\.0\.0\.1|fonts\.googleapis\.com|fonts\.gstatic\.com)(:|\/)/;

let fails = 0;
const fail = (m) => { fails++; console.log('FAIL ' + m); };
const pass = (m) => console.log('ok   ' + m);
const browser = await chromium.launch().catch(() => chromium.launch({ channel: 'chrome' }));

// The fake's own ticks are swallowed; the test drives the page's hr listener by hand.
const CAPTURE = `(() => { const h = window.Capacitor && window.Capacitor.Plugins.NativeHrSession; if (!h) return;
  const add = h.addListener; h.addListener = (n, cb) => { if (n === 'hr') { window.__hrCb = cb; return Promise.resolve({ remove() {} }); } return add(n, cb); }; })();`;

async function run(label, withEngine, expect) {
  const ctx = await browser.newContext({ viewport: { width: 360, height: 740 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
  await ctx.route('**/*', (route) => {
    const u = route.request().url();
    if (/chart\.umd(\.min)?\.js/.test(u) && !u.startsWith('http://127.0.0.1')) return route.fulfill({ status: 200, contentType: 'text/javascript', body: fs.readFileSync(CHART) });
    if (/googleapis\.com\/(drive|upload)\//.test(u)) return route.fulfill({ status: 200, contentType: 'application/json', body: '{"files":[],"id":"fake-folder"}' });
    if (ALLOW.test(u) || u.startsWith('data:') || u.startsWith('blob:')) return route.continue();
    const js = /\.js(\?|$)/.test(u) || route.request().resourceType() === 'script';
    return route.fulfill({ status: js ? 200 : 204, contentType: js ? 'text/javascript' : 'text/plain', body: '' });
  });
  await ctx.addInitScript(fakeBridge({ scenario: 'live', savedStrap: true, signedIn: true, sessionAgeMs: 600000 }));
  await ctx.addInitScript(CAPTURE);
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  await page.goto(`${BASE}/www/hr_monitor.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof window.__hrCb === 'function', null, { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(800);
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

await run('engine rmssd 24.2 with beats worth 40', true, (t) => t === '24');
await run('no engine rmssd', false, (t) => t !== '40');
await browser.close();
server.close();
console.log(fails ? `${fails} failed` : 'all passed');
process.exit(fails ? 1 : 0);
