// S59: the "Readjust strap" chip flags a strap whose beats disagree with its own HR, and changes nothing else.
// Bug it guards (2026-10-16): from 07:00 half the strap's RR beats were impossible (250 to 430 ms at a real HR
// near 80), the HR byte stuck at 121 and HRV read about 100, with nothing on screen to say the signal was bad.
// Cases: clean 80 bpm no chip; a 40 s junk burst no chip; 50% junk shows it only after 60 s sustained; 1 in 4 junk
// holds it (hysteresis); clean hides it after 60 s; real fast HR
// at 150 no chip; PVC bigeminy (every other beat a short-long pair) no chip; PVC pairs plus junk shows it; HR, HRV and every series
// byte-identical with the check removed (native path, Needs mobile/www from `npm run copy-web`). While the chip shows, the monitor's HRV is dimmed and says unreliable. Drives processHRData, the one pipeline both web and native feed.
// Also: no-RR packets clear a shown chip, a packet gap restarts the show timer, reconnecting clears it, and the web
// path (page computes RMSSD) is byte-identical too.
// Usage: node scripts/signal-chip.mjs [--mutant <name>] [--shots <dir>] [--ux <dir>]. Mutants: no-hysteresis, no-threshold,
// ectopic-junk, dim-without-chip, chip-without-dim, stale-since, thin-never-hides, alters-hr, alters-rr.
// Each mutant must FAIL. Runtime: about 20 seconds.

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

const CALL = '    try { signalFeed(hr, rrs); } catch (e) {}\n';
const MUTANTS = {
  'no-hysteresis': ['SIGNAL_HIDE = 0.20, SIGNAL_TOL_BPM = 40, SIGNAL_SUSTAIN_MS = 60000', 'SIGNAL_HIDE = 0.35, SIGNAL_TOL_BPM = 40, SIGNAL_SUSTAIN_MS = 0'],
  'no-threshold': ['share >= SIGNAL_SHOW', 'share >= 0'],
  'ectopic-junk': ['if (pair) { push(false); continue; }', 'if (pair) { push(true); continue; }'],
  'dim-without-chip': ["document.body.classList.toggle('signal-poor', on);", "document.body.classList.toggle('signal-poor', true);"],
  'chip-without-dim': ["document.body.classList.toggle('signal-poor', on);", "document.body.classList.toggle('signal-poor', false);"],
  'stale-since': ['if (signal.lastAt && nowMs - signal.lastAt > SIGNAL_GAP_MS) signal.since = 0;', ''],
  'thin-never-hides': ['else if (nowMs - signal.thinSince >= SIGNAL_SUSTAIN_MS)', 'else if (false)'],
  'alters-hr': ['const base = 60000 / hr;', 'const base = 60000 / hr; state.hrSeries[state.hrSeries.length - 1].v = Math.round(hr * 0.9);'],
  'alters-rr': ['const base = 60000 / hr;', 'const base = 60000 / hr; state.rrBuffer = state.rrBuffer.filter((b) => b.rr > 450);'],
};
const mutant = argVal('--mutant');
if (mutant && !MUTANTS[mutant]) { console.log('FAIL unknown mutant ' + mutant); process.exit(2); }

const WWW = path.join(ROOT, 'mobile', 'www');
const src = fs.existsSync(path.join(WWW, 'hr_monitor.html')) ? fs.readFileSync(path.join(WWW, 'hr_monitor.html'), 'utf8') : '';
if (!src.includes(CALL)) { console.log('FAIL mobile/www/hr_monitor.html missing or stale: run npm run copy-web in mobile'); process.exit(1); }
const webSrc = fs.readFileSync(path.join(ROOT, 'hr_monitor.html'), 'utf8');
const mutate = (html) => {
  if (!mutant) return html;
  const [a, b] = MUTANTS[mutant];
  if (html.split(a).length !== 2) { console.log('FAIL mutant anchor not unique: ' + a); process.exit(1); }
  return html.replace(a, b);
};
const variants = { '/feat.html': mutate(src), '/bare.html': src.replace(CALL, ''), '/web-feat.html': mutate(webSrc), '/web-bare.html': webSrc.replace(CALL, '') };

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png', '.woff2': 'font/woff2' };
const server = http.createServer((req, res) => {
  const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (variants[rel]) { res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' }); res.end(variants[rel]); return; }
  let file = path.join(WWW, rel);
  if (!fs.existsSync(file)) file = path.join(ROOT, rel);
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  fs.createReadStream(file).pipe(res);
});
await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
const BASE = `http://127.0.0.1:${server.address().port}`;
const ALLOW = /^https?:\/\/(127\.0\.0\.1|fonts\.googleapis\.com|fonts\.gstatic\.com)(:|\/)/;

// Shifted clock so a minute of beats runs in milliseconds.
const CLOCK = `(() => { const n = Date.now.bind(Date); let s = 0; window.__shift = (ms) => { s += ms; }; Date.now = () => n() + s; })();`;

// In-page beat generator, seeded so both builds see the same beats.
const FEED = `window.__feed = (seconds, kind, seed) => {
  let x = seed >>> 0; const rnd = () => { x = (x * 1664525 + 1013904223) >>> 0; return x / 4294967296; };
  const p = { clean: 0, junk50: 0.5 };
  let elapsed = 0, flips = 0, n12 = 0, wasShown = !document.getElementById('signal-row').hidden;
  const tick = (hr, rr) => { window.__shift(rr); window.__hrCb({ hr, rrIntervals: [rr], rmssd: 108, timestampMs: Date.now(), contactOff: false }); elapsed += rr;
    const s = !document.getElementById('signal-row').hidden; if (s !== wasShown) { flips++; wasShown = s; } };
  while (elapsed < seconds * 1000) {
    if (kind === 'norr') { window.__shift(1000); window.__hrCb({ hr: 80, rrIntervals: [], rmssd: 108, timestampMs: Date.now(), contactOff: false }); elapsed += 1000;
      const s = !document.getElementById('signal-row').hidden; if (s !== wasShown) { flips++; wasShown = s; } continue; }
    if (kind === 'junk25') { n12++; tick(80, n12 % 4 ? 750 + Math.round((rnd() - 0.5) * 60) : 300); continue; }
    if (kind === 'fast') { tick(150, 400 + Math.round((rnd() - 0.5) * 20)); continue; }
    const pvc = kind === 'pvc' ? 1 : kind === 'pvc20' ? 0.2 : kind === 'pvcjunk' ? 0.1 : 0;
    const junk = kind === 'pvcjunk' ? 0.5 : (p[kind] || 0);
    if (pvc && rnd() < pvc) { tick(80, 450); tick(80, 1050); continue; }
    if (kind === 'pvcjunk') { n12++; if (n12 % 2) { tick(80, 250 + Math.round(rnd() * 180)); continue; } }
    else if (junk && rnd() < junk) { tick(80, 250 + Math.round(rnd() * 180)); continue; }
    tick(80, 750 + Math.round((rnd() - 0.5) * 60));
  }
  return { shown: wasShown, flips };
};`;

let fails = 0;
const fail = (m) => { fails++; console.log('FAIL ' + m); };
const pass = (m) => console.log('ok   ' + m);
const browser = await chromium.launch().catch(() => chromium.launch({ channel: 'chrome' }));

// Web path: a fake strap behind navigator.bluetooth; __hrCb sends one 0x2A37 packet, so the page computes RMSSD itself.
const WEB = `(() => {
  const listeners = [];
  const chr = { value: null, startNotifications: async () => chr, stopNotifications: async () => chr,
    addEventListener: (t, cb) => { if (t === 'characteristicvaluechanged') listeners.push(cb); }, removeEventListener: () => {} };
  const gatt = { connected: false, connect: async () => { gatt.connected = true; return server; }, disconnect: () => { gatt.connected = false; } };
  const server = { device: null, connected: true,
    getPrimaryService: async (s) => { if (s === 'heart_rate' || s === 0x180d || s === 0x180D) return { getCharacteristic: async () => chr }; throw new Error('no service'); } };
  const device = { name: 'Test strap', id: 'fake', gatt, addEventListener: () => {}, removeEventListener: () => {}, watchAdvertisements: async () => {} };
  server.device = device;
  Object.defineProperty(navigator, 'bluetooth', { configurable: true, value: { getDevices: async () => [], requestDevice: async () => device, getAvailability: async () => true } });
  window.__hrCb = (d) => {
    const rrs = d.rrIntervals || [];
    const b = new DataView(new ArrayBuffer(2 + 2 * rrs.length));
    b.setUint8(0, rrs.length ? 0x10 : 0); b.setUint8(1, d.hr);
    rrs.forEach((rr, i) => b.setUint16(2 + 2 * i, Math.round(rr * 1024 / 1000), true));
    chr.value = b; listeners.forEach((cb) => cb({ target: chr }));
  };
})();`;

async function open(file, web) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.route('**/*', (route) => {
    const u = route.request().url();
    if (/chart\.umd(\.min)?\.js/.test(u) && !u.startsWith('http://127.0.0.1')) return route.fulfill({ status: 200, contentType: 'text/javascript', body: fs.readFileSync(CHART) });
    if (ALLOW.test(u) || u.startsWith('data:') || u.startsWith('blob:')) return route.continue();
    const js = /\.js(\?|$)/.test(u) || route.request().resourceType() === 'script';
    return route.fulfill({ status: js ? 200 : 204, contentType: js ? 'text/javascript' : 'text/plain', body: '' });
  });
  await ctx.addInitScript(CLOCK);
  if (web) await ctx.addInitScript(WEB);
  else await ctx.addInitScript(fakeBridge({ scenario: 'live', savedStrap: true, signedIn: true, sessionAgeMs: 600000 }));
  if (!web) await ctx.addInitScript(`(() => { const h = window.Capacitor && window.Capacitor.Plugins.NativeHrSession; if (!h) return;
    const add = h.addListener; h.addListener = (n, cb) => { if (n === 'hr') { window.__hrCb = cb; return Promise.resolve({ remove() {} }); } return add(n, cb); }; })();`);
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  await page.goto(BASE + file, { waitUntil: 'load' });
  if (web) {
    await page.waitForTimeout(500);
    if (await page.evaluate(() => { const s = document.getElementById('session-toggle').closest('.section'); return !!s && s.classList.contains('collapsed'); })) {
      await page.click('[data-section="controls"] .section-header');
      await page.waitForTimeout(300);
    }
    await page.click('#session-toggle');
  }
  await page.waitForFunction(() => typeof window.__hrCb === 'function' && document.body.classList.contains('conn-live'), null, { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(500);
  await page.evaluate(FEED);
  await page.evaluate(() => window.__shift(21000));
  return { ctx, page, errs };
}

const tile = async (page) => { await page.waitForTimeout(600); return page.evaluate(() => {
  const v = document.getElementById('compact-hrv-value'), f = document.getElementById('compact-hrv-flag');
  const probe = document.createElement('span'); probe.style.color = 'var(--text-dim)'; v.parentNode.appendChild(probe);
  const dim = getComputedStyle(probe).color; probe.remove();
  const color = getComputedStyle(v).color;
  return { poor: document.body.classList.contains('signal-poor'), flag: !!f && getComputedStyle(f).display !== 'none' && f.textContent === 'unreliable', dimmed: color === dim, color, dim };
}); };
const tileOk = (t, on) => (on ? t.poor && t.flag && t.dimmed : !t.poor && !t.flag && !t.dimmed);
const feed = (page, s, kind, seed) => page.evaluate(([a, b, c]) => window.__feed(a, b, c), [s, kind, seed]);

{
  const { ctx, page, errs } = await open('/feat.html');
  let r = await feed(page, 100, 'clean', 1);
  if (!r.shown && !r.flips) pass('(a) clean 80 bpm: no chip'); else fail(`(a) clean 80 bpm: shown=${r.shown} flips=${r.flips}`);
  { const t = await tile(page); if (tileOk(t, false)) pass('(a) HRV tile normal'); else fail('(a) HRV tile ' + JSON.stringify(t)); }
  r = await feed(page, 40, 'junk50', 11);
  const burst = await feed(page, 90, 'clean', 12);
  if (!r.shown && !r.flips && !burst.shown && !burst.flips) pass('(h) 40 s burst of 50% junk then clean: no chip'); else fail(`(h) burst: shown=${r.shown || burst.shown} flips=${r.flips + burst.flips}`);
  r = await feed(page, 50, 'junk50', 13);
  if (!r.shown) pass('(b) 50% junk for 50 s: not yet (needs 60 s sustained)'); else fail('(b) chip showed before the share held 60 s');
  r = await feed(page, 60, 'junk50', 2);
  if (r.shown && r.flips === 1) pass('(b) 50% junk: chip shows'); else fail(`(b) 50% junk: shown=${r.shown} flips=${r.flips}`);
  { const t = await tile(page); if (tileOk(t, true)) pass('(b) HRV tile unreliable'); else fail('(b) HRV tile ' + JSON.stringify(t)); }
  await page.waitForTimeout(300);
  const chip = await page.evaluate(() => ({ text: document.getElementById('signal-chip').textContent, live: document.getElementById('status-announce').textContent }));
  if (chip.text === 'Readjust strap' && chip.live === 'Readjust strap') pass('(b) chip text and polite announcement'); else fail('(b) chip text ' + JSON.stringify(chip));
  const shots = argVal('--shots');
  if (shots) {
    await page.click('#signal-chip');
    for (const [w, h] of [[1440, 900], [430, 932]]) {
      await page.setViewportSize({ width: w, height: h });
      await page.waitForTimeout(300);
      await page.screenshot({ path: path.join(shots, `s59-chip-${w}.png`) });
    }
    await page.click('#signal-chip');
    await page.setViewportSize({ width: 1440, height: 900 });
  }
  r = await feed(page, 120, 'junk25', 3);
  if (r.shown && !r.flips) pass('(b2) 1 in 4 junk holds the chip, no flicker'); else fail(`(b2) 1 in 4 junk: shown=${r.shown} flips=${r.flips}`);
  r = await feed(page, 150, 'clean', 4);
  if (!r.shown && r.flips === 1) pass('(c) back to clean: chip hides'); else fail(`(c) clean again: shown=${r.shown} flips=${r.flips}`);
  r = await feed(page, 130, 'fast', 5);
  if (!r.shown && !r.flips) pass('(f) real fast HR 150 with RR 400: no chip'); else fail(`(f) fast HR: shown=${r.shown} flips=${r.flips}`);
  { const t = await tile(page); if (tileOk(t, false)) pass('(f) HRV tile normal'); else fail('(f) HRV tile ' + JSON.stringify(t)); }
  r = await feed(page, 130, 'pvc', 6);
  if (!r.shown && !r.flips) pass('(e) 80 bpm with PVC bigeminy: no chip'); else fail(`(e) PVC pairs: shown=${r.shown} flips=${r.flips}`);
  { const t = await tile(page); if (tileOk(t, false)) pass('(e) HRV tile normal'); else fail('(e) HRV tile ' + JSON.stringify(t)); }
  r = await feed(page, 130, 'pvcjunk', 7);
  if (r.shown) pass('(g) PVC pairs plus 50% junk: chip shows'); else fail(`(g) PVC plus junk: shown=${r.shown}`);
  r = await feed(page, 130, 'norr', 8);
  if (!r.shown && r.flips === 1) pass('(i) shown chip clears once beats stay under 30 for 60 s (packets with no RR)'); else fail(`(i) no RR: shown=${r.shown} flips=${r.flips}`);
  { const t = await tile(page); if (tileOk(t, false)) pass('(i) HRV tile normal again'); else fail('(i) HRV tile ' + JSON.stringify(t)); }
  r = await feed(page, 50, 'junk50', 14);
  await page.evaluate(() => window.__shift(10000));
  const r2 = await feed(page, 40, 'junk50', 15);
  if (!r.shown && !r2.shown) pass('(j) a 10 s packet gap restarts the 60 s show timer'); else fail(`(j) gap: shown=${r.shown || r2.shown}`);
  r = await feed(page, 40, 'junk50', 16);
  if (r.shown) pass('(j) chip shows once junk holds 60 s after the gap'); else fail('(j) chip never showed after the gap');
  await page.evaluate(() => { const F = window.__fake; F.snapshot = JSON.parse(JSON.stringify(F.states.RECONNECTING)); document.dispatchEvent(new Event('visibilitychange')); });
  await page.waitForFunction(() => !document.body.classList.contains('conn-live'), null, { timeout: 8000 }).catch(() => {});
  { const t = await tile(page); const hid = await page.evaluate(() => document.getElementById('signal-row').hidden);
    if (hid && tileOk(t, false)) pass('(k) reconnecting clears the chip and the dim'); else fail('(k) after reconnecting: hidden=' + hid + ' ' + JSON.stringify(t)); }
  if (errs.length) fail('page errors: ' + errs.join(' | '));
  await ctx.close();
}

// (d) Same beats through the build without the check: every shown and recorded value must match.
async function snapshot(file, web) {
  const { ctx, page, errs } = await open(file, web);
  await feed(page, 50, 'junk50', 9);
  await feed(page, 30, 'pvc20', 10);
  await page.waitForTimeout(300);
  const s = await page.evaluate(() => {
    const txt = (id) => { const e = document.getElementById(id); return e ? e.textContent : null; };
    const charts = [...document.querySelectorAll('canvas')].map((c) => { const ch = window.Chart && window.Chart.getChart(c);
      return ch ? [c.id, ch.data.datasets.map((d) => d.data.map((p) => (p && typeof p === 'object' ? p.y : p)))] : null; }).filter(Boolean);
    return JSON.stringify({ ids: ['hr-big', 'compact-hrv-value', 'rmssd-big', 'avg-hr', 'avg-rmssd', 'max-hr', 'min-hr', 'palp-rate', 'palp-total', 'warn-count', 'palp-chip-count'].map(txt), charts });
  });
  if (errs.length) fail(file + ' page errors: ' + errs.join(' | '));
  await ctx.close();
  return s;
}
const withCheck = await snapshot('/feat.html');
const without = await snapshot('/bare.html');
if (withCheck === without) pass(`(d) native: HR, HRV and series byte-identical without the check (${withCheck.length} bytes)`);
else fail('(d) native values differ with the check: ' + withCheck.slice(0, 160) + ' vs ' + without.slice(0, 160));
const webWith = await snapshot('/web-feat.html', true);
const webWithout = await snapshot('/web-bare.html', true);
const webHrv = JSON.parse(webWith).ids[1];
if (!/^\d+$/.test(webHrv)) fail('(d) web: page RMSSD did not run, HRV shows "' + webHrv + '"');
else if (webWith === webWithout) pass(`(d) web: computeRMSSD path, HRV ${webHrv}, byte-identical without the check (${webWith.length} bytes)`);
else fail('(d) web values differ with the check: ' + webWith.slice(0, 160) + ' vs ' + webWithout.slice(0, 160));

await browser.close();
server.close();
console.log((mutant ? `[mutant ${mutant}] ` : '') + (fails ? `${fails} failed` : 'all passed'));
process.exit(fails ? 1 : 0);
