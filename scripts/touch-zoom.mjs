// Guards: AUDIT-NOTES 2026-10-11 item 28 (Khal 2026-10-12, Galaxy S8: zooming into data on the phone is still hard; the strip brush was the only zoom) and the missed left brush handle on the first grab (Khal 2026-10-12, laptop and phone). Files: hrv_viewer.html chart gestures (wireChartGestures, doubleTapZoom, the brush handle hit test (brushModeAt, the overlay grab zone past the strip ends), #session-chart touch-action). Runtime about 40 s; --mutants about 60 s more.
// S32 touch zoom on the Day chart, headless, CDP touch (Input.dispatchTouchEvent) on ?demo=1 Day.
// 360: one pinch takes the range from the full day to under 1 h and keeps the time under the pinch centre there;
//      a one-finger sideways drag pans the zoomed range; a vertical swipe scrolls the page and leaves the range;
//      a single tap leaves the range; double-tap zooms 4x, repeated double-taps reach the 2 min floor, one more resets;
//      at most one chart update per animation frame during the pinch and none from inside a touch handler;
//      a touch 18 px outside a brush handle (inside its 44 px target) drags that handle; the left handle at the strip start
//      is grabbed by touch on its outer half.
// 1440 brush: the left handle at the strip start grabbed by its outer half; each handle grabbed 10 px off its drawn centre;
//      a click 18 px outside a handle keeps the zoom; cursors ew-resize on a handle, grab inside, crosshair elsewhere.
// 1440: ctrl+wheel zooms around the pointer and leaves the page; a plain wheel scrolls the page and leaves the range.
// --mutants: the pinch calling chart.update per touchmove, touch-action none on the canvas, 12 px touch handle targets,
// and a 6 px mouse handle zone;
// each named row must FAIL.
// Usage: node scripts/touch-zoom.mjs [--mutants] [--ux <ux-audit dir>]
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
const CHART = path.join(UX, '..', 'docs', 'audit-2026-10-09', 'harness-DT', 'vendor', 'chart.umd.min.js');
const { chromium } = createRequire(path.join(UX, 'kit', 'package.json'))('playwright');
const VIEWER = fs.readFileSync(path.join(ROOT, 'hrv_viewer.html'), 'utf8').replace(/\r\n/g, '\n');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png', '.woff2': 'font/woff2', '.csv': 'text/csv' };

function serve(html) {
  const server = http.createServer((req, res) => {
    const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (rel === '/hrv_viewer.html') { res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' }); res.end(html); return; }
    const file = path.join(ROOT, rel);
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(fs.readFileSync(file));
  });
  return new Promise((ok) => server.listen(0, '127.0.0.1', () => ok({ server, base: `http://127.0.0.1:${server.address().port}` })));
}

// Counts main chart updates per animation frame and updates run inside an input handler.
const INIT = () => {
  const P = window.__tz = { fid: 0, perFrame: {}, inInput: 0, updates: 0, on: false };
  let C;
  const wrap = (v) => {
    if (!v || !v.prototype || v.prototype.__tzw) return;
    v.prototype.__tzw = true;
    const f = v.prototype.update;
    v.prototype.update = function (...a) {
      if (P.on && this.canvas && this.canvas.id === 'session-chart') {
        P.updates++; P.perFrame[P.fid] = (P.perFrame[P.fid] || 0) + 1;
        const ev = window.event; if (ev && /^(pointer|mouse|touch|wheel)/.test(ev.type)) P.inInput++;
      }
      return f.apply(this, a);
    };
  };
  Object.defineProperty(window, 'Chart', { configurable: true, get() { return C; }, set(v) { C = v; wrap(v); } });
  P.start = () => { P.perFrame = {}; P.inInput = 0; P.updates = 0; P.on = true; const loop = () => { if (!P.on) return; P.fid++; requestAnimationFrame(loop); }; requestAnimationFrame(loop); };
  P.stop = () => { P.on = false; return { updates: P.updates, inInput: P.inInput, maxPerFrame: Math.max(0, ...Object.values(P.perFrame)) }; };
};

let browser;
try { browser = await chromium.launch(); } catch (e) { browser = await chromium.launch({ channel: 'chrome' }); }

async function openDay(base, width) {
  const phone = width < 600;
  const ctx = await browser.newContext({ viewport: { width, height: phone ? 740 : 900 }, deviceScaleFactor: 1, isMobile: phone, hasTouch: phone, timezoneId: 'America/Edmonton' });
  await ctx.route('**/*', (route) => {
    const u = route.request().url();
    if (u.startsWith('http://127.0.0.1:') || u.startsWith('data:') || u.startsWith('blob:')) return route.continue();
    if (/chart\.umd(\.min)?\.js/.test(u)) return route.fulfill({ status: 200, contentType: 'text/javascript', body: fs.readFileSync(CHART) });
    if (/fonts\.(googleapis|gstatic)\.com|cdn\.jsdelivr\.net|cdnjs\.cloudflare\.com/.test(u)) return route.continue();
    return route.fulfill({ status: 204, body: '' });
  });
  await ctx.addInitScript(INIT);
  const page = await ctx.newPage();
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(e.message));
  await page.goto(base + '/hrv_viewer.html?demo=1#/day/2026-04-26', { waitUntil: 'networkidle' });
  await page.waitForSelector('#view-day #session-chart', { timeout: 40000 });
  await page.waitForTimeout(1200);
  const cdp = await ctx.newCDPSession(page);
  return { ctx, page, cdp };
}

// The chart's x range and the page scroll (whichever element scrolls, summed).
const state = (page) => page.evaluate(() => {
  const c = Chart.getChart(document.getElementById('session-chart'));
  const sc = [document.scrollingElement, document.querySelector('main'), ...document.querySelectorAll('[class*=view]')].filter(Boolean);
  return { lo: c.scales.x.min, hi: c.scales.x.max, span: c.scales.x.max - c.scales.x.min, scroll: sc.reduce((a, e) => a + e.scrollTop, 0) };
});
// Plot box in viewport pixels, after putting the chart in the middle of the screen.
const plot = (page) => page.evaluate(() => {
  const c = Chart.getChart(document.getElementById('session-chart'));
  c.canvas.scrollIntoView({ block: 'center' });
  const r = c.canvas.getBoundingClientRect(), a = c.chartArea;
  return { l: r.left + a.left, r: r.left + a.right, t: r.top + a.top, b: r.top + a.bottom, y: Math.round(r.top + (a.top + a.bottom) / 2) };
});
const timeAt = (s, p, x) => s.lo + (x - p.l) / (p.r - p.l) * s.span;
const reset = async (page) => { await page.evaluate(() => document.getElementById('context-overlay').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))); await page.waitForTimeout(400); };

const touch = (cdp, type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map(([x, y], id) => ({ x: Math.round(x), y: Math.round(y), id })) });
async function gesture(page, cdp, from, to, steps = 20, gap = 16) {
  await touch(cdp, 'touchStart', from);
  for (let i = 1; i <= steps; i++) {
    await touch(cdp, 'touchMove', from.map(([x, y], k) => [x + (to[k][0] - x) * i / steps, y + (to[k][1] - y) * i / steps]));
    await page.waitForTimeout(gap);
  }
  await touch(cdp, 'touchEnd', []);
  await page.waitForTimeout(400);
}
async function tap(page, cdp, x, y) { await touch(cdp, 'touchStart', [[x, y]]); await page.waitForTimeout(40); await touch(cdp, 'touchEnd', []); }
async function doubleTap(page, cdp, x, y) { await tap(page, cdp, x, y); await page.waitForTimeout(90); await tap(page, cdp, x, y); await page.waitForTimeout(700); }

async function run(html) {
  const { server, base } = await serve(html);
  const rows = [];
  const add = (id, cond, msg) => rows.push({ id, cond: !!cond, msg });
  try {
    // ---- 360 touch ----
    let { ctx, page, cdp } = await openDay(base, 360);
    let p = await plot(page); await page.waitForTimeout(300); p = await plot(page);
    const s0 = await state(page);
    const cx = Math.round(p.l + (p.r - p.l) * 0.4), tc = timeAt(s0, p, cx);
    await page.evaluate(() => window.__tz.start());
    await gesture(page, cdp, [[cx - 15, p.y], [cx + 15, p.y]], [[cx - 165, p.y], [cx + 165, p.y]]);
    const pf = await page.evaluate(() => window.__tz.stop());
    const s1 = await state(page);
    add('pinch', s0.span > 600 && s1.span < 60, `pinch takes the range from ${(s0.span / 60).toFixed(1)} h to ${s1.span.toFixed(1)} min (under 60)`);
    const tAfter = timeAt(s1, p, Math.max(p.l, Math.min(p.r, cx)));
    add('pinch', Math.abs(tAfter - tc) < Math.max(1, s1.span * 0.05), `the pinch centre keeps its time (${tc.toFixed(1)} before, ${tAfter.toFixed(1)} after)`);
    add('perframe', pf.updates > 0 && pf.maxPerFrame <= 1 && pf.inInput === 0, `pinch: at most 1 chart update per frame, none from a touch handler (${pf.maxPerFrame} max per frame, ${pf.inInput} from input, ${pf.updates} updates)`);

    const px = p.l + (p.r - p.l) * 0.5;
    await gesture(page, cdp, [[px + 80, p.y]], [[px - 80, p.y]], 12);
    const s2 = await state(page);
    const want = 160 / (p.r - p.l) * s1.span;
    add('pan', Math.abs((s2.lo - s1.lo) - want) < want * 0.25 && Math.abs(s2.span - s1.span) < 0.01, `one-finger drag pans the zoomed range by ${(s2.lo - s1.lo).toFixed(2)} min (want ${want.toFixed(2)}), span kept`);

    await tap(page, cdp, px, p.y); await page.waitForTimeout(500);
    const sTap = await state(page);
    add('tap', Math.abs(sTap.lo - s2.lo) < 0.01 && Math.abs(sTap.span - s2.span) < 0.01, `a single tap leaves the range (${s2.span.toFixed(2)} to ${sTap.span.toFixed(2)} min)`);

    await gesture(page, cdp, [[px, p.y + 60]], [[px + 4, p.y - 140]], 12);
    await page.waitForTimeout(300);
    const s3 = await state(page);
    add('vscroll', s3.scroll - sTap.scroll > 60 && Math.abs(s3.lo - sTap.lo) < 0.01 && Math.abs(s3.span - sTap.span) < 0.01, `a vertical swipe on the chart scrolls the page ${Math.round(s3.scroll - sTap.scroll)} px and leaves the range`);

    await reset(page);
    p = await plot(page); await page.waitForTimeout(300); p = await plot(page);
    const d0 = await state(page);
    await doubleTap(page, cdp, cx, p.y);
    const d1 = await state(page);
    add('dtap', Math.abs(d1.span - d0.span / 4) < d0.span * 0.02, `double-tap zooms 4x (${d0.span.toFixed(1)} to ${d1.span.toFixed(1)} min)`);
    let n = 0, dk = d1;
    while (dk.span > 2.001 && n < 8) { await doubleTap(page, cdp, cx, p.y); dk = await state(page); n++; }
    add('dtap', Math.abs(dk.span - 2) < 0.01, `repeated double-taps stop at the 2 min floor (${dk.span.toFixed(2)} min after ${n} more)`);
    await doubleTap(page, cdp, cx, p.y);
    const d2 = await state(page);
    const hidden = await page.evaluate(() => document.getElementById('reset-zoom').classList.contains('hidden'));
    add('dtap', Math.abs(d2.span - s0.span) < 0.5 && hidden, `double-tap at the floor resets to the data range (${d2.span.toFixed(1)} min against ${s0.span.toFixed(1)}, Reset zoom hidden ${hidden})`);
    // Brush handle: a touch 18 px outside the right handle (inside its 44 px target) moves that handle only.
    await page.evaluate(() => document.getElementById('context-overlay').scrollIntoView({ block: 'center' }));
    await page.waitForTimeout(300);
    const hb = await page.evaluate(() => { const r = document.getElementById('context-brush').getBoundingClientRect(); return { lo: r.left, hi: r.right, y: Math.round(r.top + r.height / 2) }; });
    const h0 = await state(page);
    await gesture(page, cdp, [[hb.hi + 18, hb.y]], [[hb.hi - 80, hb.y]], 10);
    const h1 = await state(page);
    add('handle', Math.abs(h1.lo - h0.lo) < 0.5 && h0.hi - h1.hi > 60, `a touch 18 px outside the right brush handle drags it (start ${h0.lo.toFixed(1)} to ${h1.lo.toFixed(1)}, end ${h0.hi.toFixed(1)} to ${h1.hi.toFixed(1)})`);
    // The left handle at the strip start (start 0), grabbed by touch on its outer half, 6 px before the strip.
    const sl = await page.evaluate(() => document.getElementById('context-overlay').getBoundingClientRect().left);
    await gesture(page, cdp, [[sl - 6, hb.y]], [[sl + 60, hb.y]], 10);
    const h2 = await state(page);
    add('brushgrab', h1.lo < 0.01 && h2.lo > 20 && Math.abs(h2.hi - h1.hi) < 0.5, `touch grabs the left handle at the strip start by its outer half (start ${h1.lo.toFixed(1)} to ${h2.lo.toFixed(1)}, end kept ${h2.hi.toFixed(1)})`);
    add('errors', !page.errors.length, `no page errors at 360 ${page.errors.join(' | ')}`);
    await ctx.close();

    // ---- 1440 wheel ----
    ({ ctx, page, cdp } = await openDay(base, 1440));
    p = await plot(page); await page.waitForTimeout(300); p = await plot(page);
    const w0 = await state(page);
    const wx = Math.round(p.l + (p.r - p.l) * 0.3), wy = Math.round(p.y);
    for (let i = 0; i < 6; i++) { await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: wx, y: wy, deltaX: 0, deltaY: -100, modifiers: 2 }); await page.waitForTimeout(40); }
    await page.waitForTimeout(400);
    const w1 = await state(page);
    const tw0 = timeAt(w0, p, wx), tw1 = timeAt(w1, p, wx);
    add('wheel', w1.span < w0.span / 4 && Math.abs(tw1 - tw0) < Math.max(1, w1.span * 0.05) && Math.abs(w1.scroll - w0.scroll) < 1, `ctrl+wheel zooms around the pointer (${w0.span.toFixed(0)} to ${w1.span.toFixed(1)} min, time under pointer ${tw0.toFixed(1)} then ${tw1.toFixed(1)}), page still`);
    for (let i = 0; i < 3; i++) { await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: wx, y: wy, deltaX: 0, deltaY: 120 }); await page.waitForTimeout(60); }
    await page.waitForTimeout(500);
    const w2 = await state(page);
    add('wheel', w2.scroll - w1.scroll > 50 && Math.abs(w2.span - w1.span) < 0.01, `a plain wheel scrolls the page ${Math.round(w2.scroll - w1.scroll)} px and leaves the range`);
    // Brush handles with a mouse (Khal missed the left handle on the first grab every time).
    await reset(page);
    const strip = () => page.evaluate(() => { const o = document.getElementById('context-overlay'); o.scrollIntoView({ block: 'center' }); const r = o.getBoundingClientRect(), b = document.getElementById('context-brush').getBoundingClientRect(); return { l: r.left, y: Math.round(r.top + r.height / 2), cl: b.left + 2, cr: b.right - 2 }; });
    const mdrag = async (x0, x1, y) => { await page.mouse.move(x0, y); await page.mouse.down(); await page.mouse.move(x1, y, { steps: 6 }); await page.mouse.up(); await page.waitForTimeout(400); };
    let st = await strip(); await page.waitForTimeout(200); st = await strip();
    const b0 = await state(page);
    await mdrag(st.l - 2, st.l + 80, st.y);
    const b1 = await state(page);
    add('brushgrab', b0.lo < 0.01 && b1.lo > 30 && Math.abs(b1.hi - b0.hi) < 0.5, `mouse grabs the left handle at the strip start by its outer half (start ${b0.lo.toFixed(1)} to ${b1.lo.toFixed(1)}, end kept ${b1.hi.toFixed(1)})`);
    st = await strip();
    await mdrag(st.cl + 10, st.cl + 70, st.y);
    const b2 = await state(page);
    add('brushgrab', b2.lo - b1.lo > 30 && Math.abs(b2.hi - b1.hi) < 0.5, `mouse 10 px inside the left handle's centre moves that handle (start ${b1.lo.toFixed(1)} to ${b2.lo.toFixed(1)}, end ${b1.hi.toFixed(1)} to ${b2.hi.toFixed(1)})`);
    st = await strip();
    await mdrag(st.cr - 10, st.cr - 70, st.y);
    const b3 = await state(page);
    add('brushgrab', b2.hi - b3.hi > 30 && Math.abs(b3.lo - b2.lo) < 0.5, `mouse 10 px inside the right handle's centre moves that handle (end ${b2.hi.toFixed(1)} to ${b3.hi.toFixed(1)}, start ${b2.lo.toFixed(1)} to ${b3.lo.toFixed(1)})`);
    st = await strip();
    await page.mouse.move(st.cl - 18, st.y); await page.mouse.down(); await page.mouse.up(); await page.waitForTimeout(400);
    const b4 = await state(page);
    add('brushgrab', Math.abs(b4.lo - b3.lo) < 0.01 && Math.abs(b4.hi - b3.hi) < 0.01, `a click 18 px outside the left handle keeps the zoom ([${b3.lo.toFixed(1)}, ${b3.hi.toFixed(1)}] to [${b4.lo.toFixed(1)}, ${b4.hi.toFixed(1)}])`);
    const cur = async (x) => { await page.mouse.move(x, st.y); await page.waitForTimeout(80); return page.evaluate(() => getComputedStyle(document.getElementById('context-overlay')).cursor); };
    const cs = [await cur(st.cl), await cur((st.cl + st.cr) / 2), await cur(st.l + 3)];
    add('cursor', cs.join() === 'ew-resize,grab,crosshair', `strip cursors on a handle, inside the window, elsewhere: ${cs.join(', ')}`);
    add('errors', !page.errors.length, `no page errors at 1440 ${page.errors.join(' | ')}`);
    await ctx.close();
  } finally { server.close(); }
  return rows;
}

// Each mutant puts one named bug back; its rows must FAIL.
const MUTANTS = [
  ['perframe', 'pinch calls chart.update on every touchmove',
    '        setZoomRange(pinch.t - f * span, pinch.t + (1 - f) * span);\n        return;\n',
    '        setZoomRange(pinch.t - f * span, pinch.t + (1 - f) * span);\n        applyChartRange();\n        return;\n'],
  ['vscroll', 'touch-action none on the chart canvas', '#session-chart { touch-action: pan-y; }', '#session-chart { touch-action: none; }'],
  ['handle', 'brush handles back to a 12 px touch target', 'const hit = touch ? 22 : 12;', 'const hit = touch ? 12 : 12;'],
  ['brushgrab', 'mouse handle zone back to 6 px', 'const hit = touch ? 22 : 12;', 'const hit = touch ? 22 : 6;'],
];

let fails = 0, passes = 0;
const ok = (cond, msg) => { if (cond) passes++; else fails++; console.log((cond ? 'PASS ' : 'FAIL ') + msg); };
if (args.includes('--mutants')) {
  for (const [id, bug, find, repl] of MUTANTS) {
    if (!VIEWER.includes(find)) { ok(false, `MUTANT ${bug}: anchor missing`); continue; }
    const rows = (await run(VIEWER.replace(find, repl))).filter((r) => r.id === id);
    for (const r of rows) console.log('  ' + (r.cond ? 'ok   ' : 'fail ') + r.msg);
    ok(rows.length && rows.some((r) => !r.cond), `MUTANT ${bug}: ${rows.some((r) => !r.cond) ? 'FAILED as required' : 'NOT CAUGHT'}`);
  }
} else for (const r of await run(VIEWER)) ok(r.cond, r.msg);
console.log(`touch-zoom: ${passes} pass, ${fails} fail`);
await browser.close();
process.exit(fails ? 1 : 0);
