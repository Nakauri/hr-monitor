// Guards: S29 parse off the main thread. Named bug: AUDIT-NOTES 2026-10-11 item 13, phone trace 2026-10-12 11:15
// (perf-2026-10-12/spin/phone-trace-1.json), one 1,674 ms main-thread task after a Drive reply that froze the sync
// icon and scrolling. Files: hrv_viewer.html (summarizeCSVAsync, parseWorkerSource). Runtime: about 40 s; run when
// hrv_viewer.html's parse path changes and before a push.
// Checks: worker and main-thread summaries are identical on every demo file; a 60k-row recording parses at 360 with
// the CPU slowed 6x and no main-thread task over 100 ms; the same parse with the worker off (negative control) MUST
// exceed 100 ms, or the measurement proves nothing.
// Usage: node scripts/parse-worker.mjs [--ux <ux-audit dir>]
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { uxDir } from './ux-dir.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const argVal = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const ROOT = path.resolve(here, '..');
const UX = uxDir(here, argVal('--ux'));
const { chromium } = createRequire(path.join(UX, 'kit', 'package.json'))('playwright');
const BUDGET_MS = 100;

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.csv': 'text/csv', '.woff2': 'font/woff2' };
const server = http.createServer((req, res) => {
  const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const file = path.join(ROOT, rel);
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  res.end(fs.readFileSync(file));
});
await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
const BASE = `http://127.0.0.1:${server.address().port}`;

let fails = 0, passes = 0;
const ok = (cond, msg) => { if (cond) { passes++; console.log('PASS ' + msg); } else { fails++; console.log('FAIL ' + msg); } };

// 60k rows at 1 Hz (16.7 h), the size of the phone's long recordings.
function bigCsv() {
  const t0 = Date.UTC(2026, 8, 15, 12, 0, 0);
  const out = ['time_min,epoch_ms,hr_bpm,rmssd_ms,sdnn_match_ms,sdnn_5min_ms,sdnn_full_ms,palpitation,event,warning,connection,posture'];
  for (let i = 0; i < 60000; i++) {
    const c = new Array(12).fill('');
    c[0] = (i / 60).toFixed(4);
    c[1] = String(t0 + i * 1000);
    c[2] = String(80 + Math.round(12 * Math.sin(i / 700)) + (i % 5000 < 60 ? 35 : 0));
    c[3] = (35 + 10 * Math.cos(i / 900)).toFixed(2);
    if (i % 4000 === 0) c[7] = '1';
    if (i === 0) { c[10] = 'connected'; c[11] = 'sitting'; }
    out.push(c.join(','));
  }
  return out.join('\n') + '\n';
}

let browser;
try { browser = await chromium.launch(); } catch (e) { browser = await chromium.launch({ channel: 'chrome' }); }
const ctx = await browser.newContext({ viewport: { width: 360, height: 740 } });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(BASE + '/hrv_viewer.html?demo=1#/month', { waitUntil: 'networkidle' });
await page.waitForFunction(() => window.__hrmParse, null, { timeout: 15000 });

// ---- Parity: worker vs main thread on every demo file ----
const files = JSON.parse(fs.readFileSync(path.join(ROOT, 'demo', 'manifest.json'), 'utf8')).files;
const parity = await page.evaluate(async (files) => {
  const out = [];
  for (const fn of files) {
    const text = await fetch('./demo/' + fn).then((r) => r.text());
    const a = JSON.stringify(window.__hrmParse.summarizeCSV(fn, text));
    const b = JSON.stringify(await window.__hrmParse.summarizeCSVAsync(fn, text));
    out.push([fn, a === b, a.length]);
  }
  return out;
}, files);
for (const [fn, same, n] of parity) ok(same, `worker and main thread give the same summary: ${fn} (${n} chars)`);
ok(parity.length === files.length && parity.length > 0, `parity ran on all ${files.length} demo files`);
ok(await page.evaluate(() => !!window.Worker), 'the browser has Worker');

// ---- Freeze: 60k rows at 360, CPU 6x ----
const cdp = await ctx.newCDPSession(page);
await cdp.send('Emulation.setCPUThrottlingRate', { rate: 6 });
await page.evaluate((t) => { window.__bigCsv = t; }, bigCsv());
async function longest(noWorker) {
  return page.evaluate(async (noWorker) => {
    window.__hrmNoParseWorker = noWorker;
    // Long tasks on the page's main thread. The parse starts from a page timer, as a Drive reply would: work started
    // by the test driver is not a page task and never shows as one. (A timer heartbeat jitters 70 to 95 ms at 6x idle.)
    const tasks = [];
    const po = new PerformanceObserver((l) => { for (const e of l.getEntries()) tasks.push(e.duration); });
    po.observe({ type: 'longtask' });
    const t0 = performance.now();
    const s = await new Promise((r) => setTimeout(() => r(window.__hrmParse.summarizeCSVAsync('hrv_session_2026-09-15T06-00-00.000.csv', window.__bigCsv)), 0));
    const wall = performance.now() - t0;
    await new Promise((r) => setTimeout(r, 300));
    po.disconnect();
    window.__hrmNoParseWorker = false;
    return { longest: Math.round(Math.max(0, ...tasks)), wall: Math.round(wall), hrCount: s && s.hrCount };
  }, noWorker);
}
await longest(false); // first call builds the Worker
const w = await longest(false);
const m = await longest(true);
ok(w.hrCount === 60000, `the worker summarizes all 60k rows (${w.hrCount})`);
ok(w.longest <= BUDGET_MS, `worker: no main-thread task over ${BUDGET_MS} ms during a 60k-row parse at 6x (longest ${w.longest} ms, parse ${w.wall} ms)`);
ok(m.longest > BUDGET_MS, `negative control, main thread: the same parse blocks over ${BUDGET_MS} ms (longest ${m.longest} ms, parse ${m.wall} ms, rows ${m.hrCount}), so the check can fail`);
ok(!errors.length, 'no page errors ' + errors.join(' | '));

// ---- Fallbacks: no Worker at all, and a Worker that dies after the request went out ----
const FALLBACKS = {
  'no Worker': 'window.Worker = undefined;',
  'a Worker that dies': 'window.Worker = class { constructor() {} postMessage() { setTimeout(() => this.onerror && this.onerror({ message: "boom" }), 20); } terminate() {} };',
};
for (const [name, init] of Object.entries(FALLBACKS)) {
  const c2 = await browser.newContext({ viewport: { width: 360, height: 740 } });
  await c2.addInitScript(init);
  const p2 = await c2.newPage();
  const errs2 = [];
  p2.on('pageerror', (e) => errs2.push(e.message));
  await p2.goto(BASE + '/hrv_viewer.html?demo=1#/month', { waitUntil: 'networkidle' });
  await p2.waitForFunction(() => window.__hrmParse, null, { timeout: 15000 });
  const r = await p2.evaluate(async (fn) => {
    const text = await fetch('./demo/' + fn).then((x) => x.text());
    const a = JSON.stringify(window.__hrmParse.summarizeCSV(fn, text));
    const b = await Promise.race([window.__hrmParse.summarizeCSVAsync(fn, text).then((s) => JSON.stringify(s)), new Promise((res) => setTimeout(() => res('TIMEOUT'), 10000))]);
    return { same: a === b, b: b.slice(0, 40) };
  }, files[0]);
  ok(r.same, `${name}: the summary comes from the main thread instead (${r.b})`);
  ok(!errs2.length, `${name}: no page errors ` + errs2.join(' | '));
  await c2.close();
}

await browser.close();
server.close();
console.log(`parse-worker: ${passes} pass, ${fails} fail`);
process.exit(fails ? 1 : 0);
