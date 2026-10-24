// Monitor preview column: the watched widget fits by default, the edge drags and is saved, it never
// goes narrower than the widget, the OBS size does not move, and a widget click copies the OBS URL.
// Guards the 10-23 clip: the column was a fixed 340 px while the watched widget kept the sender's width.
// Guards: the 10-23 preview clip. Files: hr_monitor.html (#overlay-zone, #zone-resize, widget click-copy), overlay.html (body.embed #overlay-zone). Runtime: about 11 s.
// Usage: node scripts/zone-preview.mjs [--shots <dir>]
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
const ROOT = path.join(here, '..');
const SHOTS = argVal('--shots');
const KIT = path.join(uxDir(here, argVal('--ux')), 'kit', 'package.json');
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

// Every frame gets its own fake relay; __tick fans a message to every socket in that frame.
const FAKE_WS = `(() => {
  window.__ws = [];
  function F(u) { this.url = u; this.readyState = 0; this.l = {}; window.__ws.push(this); setTimeout(() => { this.readyState = 1; this.fire('open', {}); }, 20); }
  F.prototype.addEventListener = function (t, f) { (this.l[t] = this.l[t] || []).push(f); };
  F.prototype.removeEventListener = function () {};
  F.prototype.fire = function (t, e) { (this.l[t] || []).forEach((f) => f(e)); if (this['on' + t]) this['on' + t](e); };
  F.prototype.send = function () {};
  F.prototype.close = function () { this.readyState = 3; this.fire('close', {}); };
  F.CONNECTING = 0; F.OPEN = 1; F.CLOSING = 2; F.CLOSED = 3;
  window.WebSocket = F;
  window.__tick = (o) => window.__ws.forEach((s) => s.fire('message', { data: JSON.stringify(o) }));
  window.__copied = [];
  try { Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: (t) => { window.top.__copied.push(t); return Promise.resolve(); } } }); } catch (e) {}
})();`;

function tick(hr, fullWidgetsWidth) {
  const trendHR = [], trendRmssd = [], livePoints = [];
  for (let i = 0; i <= 90; i++) { const x = i * (3 / 90); trendHR.push({ x, y: Math.round(hr - 30 + i / 3 + Math.sin(i / 6) * 4) }); trendRmssd.push({ x, y: 30 + Math.cos(i / 9) * 6 }); }
  for (let i = 0; i <= 60; i++) livePoints.push({ x: i * 0.75, y: hr + Math.sin(i / 3) * 4 });
  return { type: 'tick', senderId: 'android', senderLabel: 'Android Chrome', hr, hrStage: 'stage-normal', rmssd: 26, rmssdStage: 'stage-elevated',
    palpPerMin: 0, contactOff: false, warn: null, conn: 'live', livePoints, liveWindow: [0, 45], trendHR, trendRmssd, trendWindow: [0, 3],
    prefs: { showHr: true, showHrv: true, showLiveHr: true, showInlineTrends: true, showPalpChip: true, showWarning: true, warningPlacement: 'inside', fullWidgetsWidth } };
}

async function main() {
  const server = await serve(ROOT);
  const base = `http://127.0.0.1:${server.address().port}`;
  const { chromium } = createRequire(KIT)('playwright');
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'zone-preview-'));
  const opts = { headless: true, viewport: { width: 1210, height: 842 } };
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
    const zoneW = () => page.evaluate(() => Math.round(document.getElementById('overlay-zone').getBoundingClientRect().width));
    const obsSize = () => page.evaluate(() => document.getElementById('obs-size-w')?.value + 'x' + document.getElementById('obs-size-h')?.value);
    const load = async () => { await page.goto(`${base}/hr_monitor.html`, { waitUntil: 'load' }); await page.waitForFunction(() => document.fonts.status === 'loaded'); await page.waitForTimeout(700); };
    const shot = async (name) => { if (!SHOTS) return; fs.mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: path.join(SHOTS, name) }); console.log(`shot ${path.join(SHOTS, name)}`); };
    const broadcast = async (width, n = 3) => {
      for (let i = 0; i < n; i++) {
        for (const f of page.frames()) { try { await f.evaluate((t) => window.__tick && window.__tick(t), tick(74, width)); } catch {} }
        await page.waitForTimeout(250);
      }
      await page.waitForTimeout(300);
    };

    await load();
    const localRow = await page.evaluate(() => document.querySelector('#overlay-zone .widget-row').getBoundingClientRect().width);
    const obs0 = await obsSize();
    check(await zoneW() >= localRow + 28, `local widget ${localRow} px fits the ${await zoneW()} px column`);

    // Local mode with widgets off: the column still never goes under 340, so re-enabling cannot cramp the OBS size.
    const toggles = ['toggle-hrv', 'toggle-live-hr', 'toggle-inline-trends'];
    const setToggle = (id, on) => page.evaluate(([id, on]) => { const el = document.getElementById(id); if (el.checked !== on) el.click(); }, [id, on]);
    for (const id of toggles) await setToggle(id, false);
    await page.waitForTimeout(400);
    await page.focus('#zone-resize'); await page.keyboard.press('Home'); await page.waitForTimeout(200);
    check(await zoneW() === 340, `Home in local mode with widgets off stops at 340 (${await zoneW()})`);
    for (const id of toggles) { await setToggle(id, true); await page.waitForTimeout(500); }
    check(await obsSize() === obs0, `widgets back on one at a time keep the OBS size (${await obsSize()} vs ${obs0})`);

    // Watch a stream whose sender measured a wider widget than this page draws.
    for (const width of [372, 430]) {
      await broadcast(width);
      const fr = page.frames().find((f) => f.url().includes('overlay.html'));
      const inner = fr && await fr.evaluate(() => ({ vw: innerWidth, right: document.getElementById('hr-widget').getBoundingClientRect().right, scroll: document.documentElement.scrollWidth }));
      check(await page.evaluate(() => document.body.classList.contains('watch-mode')), `watch mode on (sender width ${width})`);
      check(inner && inner.right <= inner.vw && inner.scroll <= inner.vw, `watched widget fits: card right ${inner && Math.round(inner.right)} within frame ${inner && inner.vw}`);
      await shot(`zone-watch-${width}.png`);
    }

    // Drag narrower than the widget: clamps to the fit width.
    const hy = 500;
    const fitW = await zoneW();
    let hb = await page.locator('#zone-resize').boundingBox();
    await page.mouse.move(hb.x + 5, hy); await page.mouse.down(); await page.mouse.move(150, hy, { steps: 5 }); await page.mouse.up();
    await page.waitForTimeout(200);
    check(await zoneW() === fitW, `drag left stops at the widget width (${await zoneW()} vs fit ${fitW})`);
    check(await page.evaluate(() => localStorage.getItem('hr_monitor_zone_w')) === null, 'a width at the stop is not saved');

    // Drag wider, reload: width kept, OBS size untouched.
    hb = await page.locator('#zone-resize').boundingBox();
    await page.mouse.move(hb.x + 5, hy); await page.mouse.down(); await page.mouse.move(hb.x + 155, hy, { steps: 6 }); await page.mouse.up();
    await page.waitForTimeout(300);
    const dragged = await zoneW();
    check(dragged >= fitW + 140, `drag right widens the column to ${dragged}`);
    await shot('zone-dragged.png');
    await load();
    check(Math.abs(await zoneW() - dragged) <= 1, `reload keeps ${await zoneW()} (was ${dragged})`);
    check(await obsSize() === obs0, `OBS size unchanged by a wide column (${await obsSize()} vs ${obs0})`);

    // Keyboard and double-click reset.
    const before = await zoneW();
    await page.focus('#zone-resize'); await page.keyboard.press('ArrowLeft'); await page.waitForTimeout(100);
    check(await zoneW() === before - 16, `ArrowLeft narrows by 16 (${before} to ${await zoneW()})`);
    await page.dblclick('#zone-resize'); await page.waitForTimeout(200);
    check(await zoneW() === 340, `double-click resets to 340 (${await zoneW()})`);

    // Click copies, hold does not.
    await page.evaluate(() => { window.__copied.length = 0; });
    await page.click('#hr-widget', { position: { x: 40, y: 40 } }); await page.waitForTimeout(200);
    const copied = await page.evaluate(() => window.__copied.slice());
    check(copied.length === 1 && /overlay\.html\?key=/.test(copied[0]), `widget click copies the OBS URL (${copied.length})`);
    check(await page.evaluate(() => document.getElementById('nav-copy-obs-url').classList.contains('copied')), 'nav button shows Copied');
    await page.evaluate(() => { window.__copied.length = 0; });
    const wb = await page.locator('#hr-widget').boundingBox();
    await page.mouse.move(wb.x + 40, wb.y + 40); await page.mouse.down(); await page.waitForTimeout(800); await page.mouse.up();
    await page.waitForTimeout(200);
    check((await page.evaluate(() => window.__copied.length)) === 0, 'holding the widget does not copy');

    // Watched widget click copies too.
    await broadcast(372, 2);
    const fr = page.frames().find((f) => f.url().includes('overlay.html'));
    await page.evaluate(() => { window.__copied.length = 0; });
    if (fr && await page.evaluate(() => document.body.classList.contains('watch-mode'))) {
      await fr.click('#hr-widget', { position: { x: 40, y: 40 } }); await page.waitForTimeout(300);
      check((await page.evaluate(() => window.__copied.length)) === 1, 'watched widget click copies the OBS URL');
    } else check(false, 'watch mode for the watched click');

    // Phone width: no handle, no copy cue.
    await page.setViewportSize({ width: 430, height: 900 }); await page.waitForTimeout(300);
    check(await page.evaluate(() => getComputedStyle(document.getElementById('zone-resize')).display === 'none' && !document.getElementById('overlay-zone').classList.contains('copy-on-click')), 'phone width hides the handle and the copy cue');
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
