// Overlay behaviour on a fake relay socket: a tick shows its HR, 3 s of silence sets conn-reconnecting,
// a socket close opens a second socket within 5 s. Optional shots of every warning state at the OBS size.
// Usage: node scripts/overlay-behaviour.mjs [--root <dir>] [--shots <dir>] [--size 311x238]

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { uxDir } from './ux-dir.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const argVal = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const ROOT = path.resolve(argVal('--root') || path.join(here, '..'));
const SHOTS = argVal('--shots');
const [W, H] = (argVal('--size') || '311x238').split('x').map(Number);
const KIT = argVal('--kit') || path.join(uxDir(here, argVal('--ux')), 'kit', 'package.json');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };

function serve(root) {
  const server = http.createServer((req, res) => {
    const file = path.join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname));
    if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((ok) => server.listen(0, '127.0.0.1', () => ok(server)));
}

// Every socket the page opens is recorded; the test drives messages and closes by hand.
const FAKE_WS = `(() => {
  window.__ws = [];
  function FakeWS(url) { this.url = url; this.readyState = 0; this.l = {}; this.born = performance.now(); window.__ws.push(this);
    setTimeout(() => { this.readyState = 1; this.fire('open', {}); }, 20); }
  FakeWS.prototype.addEventListener = function (t, f) { (this.l[t] = this.l[t] || []).push(f); };
  FakeWS.prototype.removeEventListener = function () {};
  FakeWS.prototype.fire = function (t, ev) { (this.l[t] || []).forEach((f) => f(ev)); if (this['on' + t]) this['on' + t](ev); };
  FakeWS.prototype.send = function () {};
  FakeWS.prototype.close = function () { this.readyState = 3; this.fire('close', {}); };
  FakeWS.CONNECTING = 0; FakeWS.OPEN = 1; FakeWS.CLOSING = 2; FakeWS.CLOSED = 3;
  window.WebSocket = FakeWS;
  window.__tick = (o) => { const s = window.__ws[window.__ws.length - 1]; s.fire('message', { data: JSON.stringify(o) }); window.__lastTickAt = performance.now(); };
})();`;

function tick(hr, extra = {}) {
  const stage = hr <= 70 ? 'stage-low' : hr < 90 ? 'stage-normal' : hr < 110 ? 'stage-elevated' : hr < 130 ? 'stage-high' : 'stage-critical';
  const trendHR = [], trendRmssd = [], livePoints = [];
  for (let i = 0; i <= 90; i++) {
    const x = i * (3 / 90);
    trendHR.push({ x, y: Math.round(hr - 30 + i / 3 + Math.sin(i / 6) * 4) });
    trendRmssd.push({ x, y: 30 + Math.cos(i / 9) * 6 });
  }
  for (let i = 0; i <= 60; i++) livePoints.push({ x: i * 0.75, y: hr + Math.sin(i / 3) * 4 });
  return { type: 'tick', senderId: 'test01', senderLabel: 'Test phone', hr, hrStage: stage, rmssd: 26, rmssdStage: 'stage-elevated',
    palpPerMin: 0, contactOff: false, warn: null, conn: 'live', livePoints, liveWindow: [0, 45], trendHR, trendRmssd, trendWindow: [0, 3], ...extra };
}

async function main() {
  const server = await serve(ROOT);
  const base = `http://127.0.0.1:${server.address().port}`;
  const { chromium } = createRequire(KIT)('playwright');
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'overlay-behaviour-'));
  const opts = { headless: true, viewport: { width: W, height: H } };
  let ctx;
  try { ctx = await chromium.launchPersistentContext(profile, opts); }
  catch { ctx = await chromium.launchPersistentContext(profile, { ...opts, channel: 'chrome' }); }
  const fails = [], errors = [];
  const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) fails.push(what); };
  try {
    await ctx.route('**/*', (r) => (r.request().url().startsWith(base) || r.request().url().includes('cdnjs.cloudflare.com') ? r.continue() : r.abort()));
    await ctx.addInitScript(FAKE_WS);
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`${base}/overlay.html?key=testkey&bg=transparent&autoreload=0`, { waitUntil: 'load' });
    await page.waitForFunction(() => window.__ws.length === 1 && window.__ws[0].readyState === 1 && document.fonts.status === 'loaded', null, { timeout: 10000 });
    const shot = async (name) => {
      if (!SHOTS) return;
      fs.mkdirSync(SHOTS, { recursive: true });
      await page.evaluate(() => { document.documentElement.style.background = '#141418'; });
      await page.waitForTimeout(250);
      await page.screenshot({ path: path.join(SHOTS, name) });
      console.log(`shot ${path.join(SHOTS, name)}`);
    };
    if (SHOTS) {
      await page.addStyleTag({ content: '.warning-banner.active { animation: none !important; } *, *::before, *::after { transition: none !important; }' });
      await page.evaluate(() => document.body.classList.add('connected'));
      await shot(`overlay-${W}x${H}-no-strap.png`);
    }

    await page.evaluate((t) => window.__tick(t), tick(128));
    const big = await page.textContent('#hr-big');
    check(big.trim() === '128', `tick with HR 128 shows "${big.trim()}"`);
    await shot(`overlay-${W}x${H}-live.png`);
    for (const [warn, hr] of [['warn-high', 142], ['warn-low', 50], ['warn-crash', 104], ['warn-palp', 96]]) {
      await page.evaluate((t) => window.__tick(t), tick(hr, warn === 'warn-crash' ? { warn, rmssd: 11, rmssdStage: 'stage-critical' } : warn === 'warn-palp' ? { warn, palpPerMin: 7 } : { warn }));
      const b = await page.evaluate(() => { const e = document.getElementById('warning-banner'); return { cls: e.className, text: e.textContent.trim() }; });
      check(b.cls.includes(warn) && b.cls.includes('active'), `${warn} banner: "${b.text}"`);
      await shot(`overlay-${W}x${H}-${warn}.png`);
    }

    const handle = await page.waitForFunction(() => document.body.classList.contains('conn-reconnecting') && (performance.now() - window.__lastTickAt) / 1000, null, { timeout: 8000, polling: 50 }).catch(() => null);
    const silent = handle ? await handle.jsonValue() : 99;
    const rc = await page.evaluate(() => document.body.classList.contains('conn-reconnecting'));
    check(rc && silent >= 3 && silent <= 5, `silence sets conn-reconnecting ${silent.toFixed(1)} s after the last tick`);
    await shot(`overlay-${W}x${H}-reconnecting.png`);

    const t1 = await page.evaluate(() => { window.__ws[0].close(); return performance.now(); });
    await page.waitForFunction(() => window.__ws.length >= 2, null, { timeout: 8000 }).catch(() => {});
    const second = await page.evaluate((t) => (window.__ws.length >= 2 ? (window.__ws[1].born - t) / 1000 : null), t1);
    check(second != null && second <= 5.5, `close opens a second socket after ${second == null ? 'never' : second.toFixed(2) + ' s'}`);
    check(errors.length === 0, `page errors: ${errors.length}${errors.length ? ' ' + errors.slice(0, 3).join(' | ') : ''}`);
  } finally {
    await ctx.close();
    server.close();
    fs.rmSync(profile, { recursive: true, force: true });
  }
  console.log(fails.length ? `FAIL (${fails.length})` : 'PASS');
  process.exit(fails.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
