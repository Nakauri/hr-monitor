// S10a Day explorer checks, headless.
// 1. Stats parity: the stats bar on a real legacy day and a real v2 day equals the pre-step build
//    (--ref, default f7cbb1a, read through `git show`, opened at its old #/session/day: route).
// 2. Layer chips: each available chip changes its dataset or overlay count, and a second click restores it.
// 3. Structure: Day route renders the explorer; gaps note only with gaps; 44 px day arrows; no uppercase
//    micro-labels; a marker click zooms; a single recording still opens its explorer; no page errors.
// --shots <dir> shoots Day at 1440, 360 and 360 with 200% text, zoomed, a marker selected, layers toggled,
// and a single recording.
// Usage: node scripts/day-explorer.mjs [--ref <commit>] [--shots <dir>] [--ux <ux-audit dir>] [--fixtures <dir>]
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const argVal = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const ROOT = path.resolve(here, '..');
const UX = path.resolve(argVal('--ux') || 'C:/Users/Khal/Desktop/Mine/HR Monitor/ux-audit');
const FIX = path.resolve(argVal('--fixtures') || path.join(UX, '..', 'docs', 'audit-2026-10-09', 'device-2026-10-10'));
const REF = argVal('--ref') || 'f7cbb1a';
const SHOTS = argVal('--shots');
const CHART = path.join(UX, '..', 'docs', 'audit-2026-10-09', 'harness-DT', 'vendor', 'chart.umd.min.js');
const { chromium } = createRequire(path.join(UX, 'kit', 'package.json'))('playwright');
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png', '.woff2': 'font/woff2', '.csv': 'text/csv' };
function serve(viewerHtml) {
  const server = http.createServer((req, res) => {
    const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (viewerHtml && rel === '/hrv_viewer.html') { res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' }); res.end(viewerHtml); return; }
    const file = path.join(ROOT, rel);
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(fs.readFileSync(file));
  });
  return new Promise((ok) => server.listen(0, '127.0.0.1', () => ok({ server, base: `http://127.0.0.1:${server.address().port}` })));
}
const cur = await serve(null);
const old = await serve(execFileSync('git', ['show', REF + ':hrv_viewer.html'], { cwd: ROOT, maxBuffer: 64 << 20 }).toString('utf8'));

let fails = 0, passes = 0;
const ok = (cond, msg) => { if (cond) { passes++; console.log('PASS ' + msg); } else { fails++; console.log('FAIL ' + msg); } };

let browser;
try { browser = await chromium.launch(); } catch (e) { browser = await chromium.launch({ channel: 'chrome' }); }
async function newPage(width, textScale = 1) {
  const phone = width < 600;
  const ctx = await browser.newContext({ viewport: { width, height: phone ? 740 : 900 }, deviceScaleFactor: 1, isMobile: phone, hasTouch: phone, timezoneId: 'America/Edmonton' });
  await ctx.route('**/*', (route) => {
    const u = route.request().url();
    if (u.startsWith(cur.base) || u.startsWith(old.base) || u.startsWith('data:') || u.startsWith('blob:')) return route.continue();
    if (/chart\.umd(\.min)?\.js/.test(u)) return route.fulfill({ status: 200, contentType: 'text/javascript', body: fs.readFileSync(CHART) });
    if (/fonts\.(googleapis|gstatic)\.com|cdn\.jsdelivr\.net|cdnjs\.cloudflare\.com/.test(u)) return route.continue();
    return route.fulfill({ status: 204, body: '' });
  });
  await ctx.addInitScript(() => { window.print = () => {}; });
  const page = await ctx.newPage();
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(e.message));
  page.scaleText = async () => {
    if (textScale === 1) return;
    await page.evaluate((f) => {
      const els = [...document.querySelectorAll('body, body *')].filter((e) => !e.dataset.uxFs && !(e instanceof SVGElement));
      const sizes = els.map((e) => parseFloat(getComputedStyle(e).fontSize));
      els.forEach((e, i) => { e.dataset.uxFs = String(sizes[i]); e.style.setProperty('font-size', sizes[i] * f + 'px', 'important'); });
      window.dispatchEvent(new Event('resize'));
    }, textScale);
    await page.waitForTimeout(300);
  };
  return { ctx, page };
}
const waitExplorer = (page, sel = '#summary-bar') => page.waitForSelector(sel, { timeout: 40000 }).then(() => page.waitForTimeout(900)).catch(() => {});

// ---- 1. Stats parity on real recordings ----
function fixtureSet(kind) {
  const out = {};
  if (kind === 'legacy') out['hrv_session_2026-10-09T21-05-43.246.csv'] = fs.readFileSync(path.join(FIX, 'legacy.csv'), 'utf8');
  else for (const n of fs.readdirSync(path.join(FIX, 'segments'))) if (n.endsWith('.csv')) out[n] = fs.readFileSync(path.join(FIX, 'segments', n), 'utf8');
  return out;
}
async function seeded(base, kind) {
  const { ctx, page } = await newPage(1440);
  await page.goto(base + '/hrv_viewer.html#/month', { waitUntil: 'networkidle' });
  await page.waitForTimeout(800);
  await page.evaluate(async (files) => {
    const db = await new Promise((res, rej) => { const q = indexedDB.open('hr_monitor_kv', 2);
      q.onupgradeneeded = () => { for (const s of ['kv', 'drive-cache']) if (!q.result.objectStoreNames.contains(s)) q.result.createObjectStore(s); };
      q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
    await new Promise((res, rej) => { const tx = db.transaction('drive-cache', 'readwrite');
      for (const [k, v] of Object.entries(files)) tx.objectStore('drive-cache').put(v, k);
      tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
    db.close();
    localStorage.removeItem('hrv_viewer_index');
  }, fixtureSet(kind));
  await page.goto('about:blank');
  return { ctx, page };
}
const readStats = (page) => page.evaluate(() => Object.fromEntries([...document.querySelectorAll('#summary-bar .summary-stat[data-stat]')].map((e) => [
  e.dataset.stat,
  { v: (e.querySelector('.summary-stat-value') || {}).textContent?.replace(/\s+/g, ' ').trim() || '',
    u: ((e.querySelector('.summary-stat-unit') || {}).textContent || '').match(/\d+(?::\d+)*/g) || [] },
])));
const legacyRef = {};
for (const kind of ['legacy', 'v2']) {
  for (const iso of ['2026-10-09', '2026-10-10']) {
    const a = await seeded(old.base, kind);
    await a.page.goto(old.base + '/hrv_viewer.html#/session/day%3A' + iso, { waitUntil: 'networkidle' });
    await waitExplorer(a.page);
    const before = await readStats(a.page);
    console.log(`  ${REF} ${kind} ${iso}: ` + Object.entries(before).map(([k, x]) => `${k}=${x.v}`).join(' '));
    if (kind === 'legacy') legacyRef[iso] = before;
    // Fixed in S10a: the pre-step build cached a v2 day built from index stubs (no startEpoch or
    // duration yet) and showed Duration 0:00 for the page's life. The same recording as a legacy
    // file gives the right value, so the v2 Duration is expected to equal the legacy one.
    else if (before.duration && legacyRef[iso] && legacyRef[iso].duration) before.duration = legacyRef[iso].duration;
    await a.ctx.close();
    if (args.includes('--baseline-only')) continue;
    const b = await seeded(cur.base, kind);
    await b.page.goto(cur.base + '/hrv_viewer.html#/day/' + iso, { waitUntil: 'networkidle' });
    await waitExplorer(b.page, '#view-day #summary-bar');
    const after = await readStats(b.page);
    const errs = b.page.errors.slice();
    await b.ctx.close();
    const keys = Object.keys(before).filter((k) => k in after);
    const diff = keys.filter((k) => before[k].v !== after[k].v || before[k].u.join(' ') !== after[k].u.join(' '));
    ok(keys.length >= 10 && !diff.length, `${kind} ${iso}: ${keys.length} stats equal the pre-step build` + (diff.length ? ' DIFF ' + diff.map((k) => `${k} ${JSON.stringify(before[k])} vs ${JSON.stringify(after[k])}`).join('; ') : ` (avg HR ${after.hrAvg && after.hrAvg.v}, max ${after.hrMax && after.hrMax.v}, HRV ${after.rmssdAvg && after.rmssdAvg.v}, uptime ${after.uptime && after.uptime.v})`));
    ok(!errs.length, `${kind} ${iso}: no page errors ` + errs.join(' | '));
  }
}

if (args.includes('--baseline-only')) { await browser.close(); cur.server.close(); old.server.close(); process.exit(0); }

// ---- 2. Layer chips ----
const DEMO_DAYS = ['2026-04-20', '2026-04-21', '2026-04-22', '2026-04-23', '2026-04-24', '2026-04-25', '2026-04-26'];
const signature = (page) => page.evaluate(() => {
  const c = window.Chart && Chart.getChart(document.getElementById('session-chart'));
  if (!c) return null;
  const ds = c.data.datasets.filter((d) => !String(d.label).startsWith('_HL')).map((d) => `${d.label}:${d.hidden ? 'h' : 'v'}:${d.data.length}`).join(',');
  const ov = ((c.options.plugins.hrOverlays || {}).overlays || []).length;
  const an = Object.keys((c.options.plugins.annotation || {}).annotations || {}).length;
  return `${ds}|ov${ov}|an${an}`;
});
const covered = new Set(), seen = new Set();
{
  const { ctx, page } = await newPage(1440);
  for (const iso of DEMO_DAYS) {
    await page.goto(cur.base + '/hrv_viewer.html?demo=1#/day/' + iso, { waitUntil: 'networkidle' });
    await waitExplorer(page, '#view-day #session-chart');
    const chips = await page.$$eval('#layer-chips .chip[data-layer]', (els) => els.map((e) => ({ t: e.dataset.layer, dis: e.disabled, on: e.getAttribute('aria-pressed') })));
    for (const c of chips) {
      seen.add(c.t);
      if (c.dis || covered.has(c.t)) continue;
      const s0 = await signature(page);
      await page.click(`#layer-chips .chip[data-layer="${c.t}"]`); await page.waitForTimeout(150);
      const s1 = await signature(page);
      const p1 = await page.getAttribute(`#layer-chips .chip[data-layer="${c.t}"]`, 'aria-pressed');
      await page.click(`#layer-chips .chip[data-layer="${c.t}"]`); await page.waitForTimeout(150);
      const s2 = await signature(page);
      const p2 = await page.getAttribute(`#layer-chips .chip[data-layer="${c.t}"]`, 'aria-pressed');
      ok(s0 && s1 !== s0 && s2 === s0 && p1 !== c.on && p2 === c.on, `chip ${c.t} on ${iso}: ${s0 === s1 ? 'NO CHANGE' : 'changes'} the chart and restores it (aria-pressed ${c.on} > ${p1} > ${p2})`);
      if (!s0 || s1 !== s0) covered.add(c.t);
    }
  }
  const never = [...seen].filter((t) => !covered.has(t));
  console.log(`layer chips: ${seen.size} shown, ${covered.size} exercised; no demo day has data for: ${never.join(', ') || 'none'}`);
  ok(seen.size >= 12, `${seen.size} layer chips`);
  ok(['hr', 'rmssd', 'maxmin'].every((t) => covered.has(t)), 'HR, RMSSD and max and min are real toggles');

  // ---- 3. Structure on the demo day ----
  await page.goto(cur.base + '/hrv_viewer.html?demo=1#/day/2026-04-26', { waitUntil: 'networkidle' });
  await waitExplorer(page, '#view-day #session-chart');
  ok(await page.isVisible('#view-day .day-title') && await page.isVisible('#view-day #session-chart'), 'Day route renders the explorer');
  ok(await page.evaluate(() => !document.querySelector('#view-session #session-chart')), 'only one explorer in the page');
  const order = await page.evaluate(() => ['.day-header', '#summary-bar', '#session-layout', '#interp-panel', '#insight-text', '.day-sessions-head'].map((s) => { const e = document.querySelector('#view-day ' + s); return e ? Math.round(e.getBoundingClientRect().top) : -1; }));
  ok(order.every((v, i) => v >= 0 && (i === 0 || v > order[i - 1])), 'order: date, stats, chart, interpretation, day report, sessions ' + order.join(','));
  const arrows = await page.evaluate(() => ['#day-prev', '#day-next'].map((s) => { const r = document.querySelector(s).getBoundingClientRect(); return [r.width, r.height]; }));
  ok(arrows.every(([w, h]) => w >= 44 && h >= 44), 'day arrows are 44 px: ' + JSON.stringify(arrows));
  const upper = await page.evaluate(() => [...document.querySelectorAll('#view-day *')].filter((e) => {
    if (!e.offsetParent || ![...e.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())) return false;
    return getComputedStyle(e).textTransform === 'uppercase';
  }).map((e) => e.textContent.trim().slice(0, 20)));
  ok(!upper.length, 'no uppercase labels: ' + upper.slice(0, 6).join(' | '));
  const gapsNote = await page.evaluate(() => { const e = document.querySelector('#view-day .gaps-note'); return e ? e.textContent.trim() : null; });
  const recGaps = await page.evaluate(() => document.querySelector('#view-day .day-header').dataset.gaps);
  ok((recGaps === '0') === (gapsNote === null), `gaps note only with gaps (gaps ${recGaps}, note ${JSON.stringify(gapsNote)})`);
  // Marker click zooms to the mark and highlights it.
  const mk = await page.$('#marker-list .marker-item');
  if (mk) {
    const t = parseFloat(await mk.getAttribute('data-t'));
    await mk.click(); await page.waitForTimeout(700);
    const sc = await page.evaluate(() => { const c = Chart.getChart(document.getElementById('session-chart')); return [c.scales.x.min, c.scales.x.max]; });
    ok(sc[0] <= t && sc[1] >= t && sc[1] - sc[0] <= 4.01, `marker click zooms to ${t.toFixed(2)}: ${sc.map((v) => v.toFixed(2)).join(' to ')}`);
    ok(await page.isVisible('#reset-zoom'), 'Reset zoom shows after a zoom');
    await page.click('#reset-zoom'); await page.waitForTimeout(500);
    ok(!(await page.isVisible('#reset-zoom')), 'Reset zoom returns to the data range');
    // Zone strip: painted in zone colours, and its right handle zooms the chart.
    const painted = await page.evaluate(() => { const c = document.getElementById('context-chart'); const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++; return n / (d.length / 4); });
    ok(painted > 0.2, `zone strip is painted (${Math.round(painted * 100)}% of pixels)`);
    const xr0 = await page.evaluate(() => { document.getElementById('context-overlay').scrollIntoView({ block: 'center' }); return Chart.getChart(document.getElementById('session-chart')).scales.x.max; });
    const hb = await page.$eval('#context-brush', (e) => { const r = e.getBoundingClientRect(); return [r.left, r.right, r.top + r.height / 2]; });
    await page.mouse.move(hb[1] - 1, hb[2]); await page.mouse.down();
    await page.mouse.move(hb[0] + (hb[1] - hb[0]) * 0.5, hb[2], { steps: 6 }); await page.mouse.up(); await page.waitForTimeout(400);
    const xr1 = await page.evaluate(() => Chart.getChart(document.getElementById('session-chart')).scales.x.max);
    ok(xr1 < xr0 - 1 && await page.isVisible('#reset-zoom'), `dragging the strip's right handle zooms (${xr0.toFixed(0)} > ${xr1.toFixed(0)} min)`);
    await page.click('#reset-zoom'); await page.waitForTimeout(400);
  } else ok(false, 'demo day has a marker');
  // Clock and duration axis.
  await page.click('#axis-mode button[data-mode="clock"]'); await page.waitForTimeout(250);
  const tick0 = await page.evaluate(() => Chart.getChart(document.getElementById('session-chart')).scales.x.ticks.map((t) => t.label).slice(0, 2).join(' '));
  await page.click('#axis-mode button[data-mode="duration"]'); await page.waitForTimeout(250);
  const tick1 = await page.evaluate(() => Chart.getChart(document.getElementById('session-chart')).scales.x.ticks.map((t) => t.label).slice(0, 2).join(' '));
  ok(tick0 !== tick1 && /AM|PM/.test(tick0) && (await page.getAttribute('#axis-mode button[data-mode="duration"]', 'aria-pressed')) === 'true', `axis switches clock to duration (${tick0} > ${tick1})`);
  await page.click('#axis-mode button[data-mode="clock"]'); await page.waitForTimeout(150);
  // Stats kebab holds Show stats and Tags.
  await page.click('#summary-bar-kebab');
  ok(await page.isVisible('#summary-bar-menu input[data-stat="hrAvg"]') && await page.isVisible('#tag-input'), 'kebab holds Show stats and Tags');
  await page.fill('#tag-input', 'check'); await page.press('#tag-input', 'Enter');
  ok(/check/.test(await page.textContent('#tags-current')), 'a tag added from the kebab shows');
  await page.click('#tags-current [data-remove="check"]');
  ok(!/check/.test(await page.textContent('#tags-current')), 'a tag removed from the kebab goes');
  await page.keyboard.press('Escape');
  ok(await page.isHidden('#summary-bar-menu') && (await page.getAttribute('#summary-bar-kebab', 'aria-expanded')) === 'false', 'Escape closes the stats menu');
  // Edit thresholds opens the threshold popover.
  await page.click('#interp-head');
  await page.waitForTimeout(150);
  if (!(await page.isVisible('#interp-edit'))) { await page.click('#interp-head'); await page.waitForTimeout(150); }
  await page.click('#interp-edit'); await page.waitForTimeout(200);
  ok(await page.isVisible('#quadrant-thresh-popover'), 'Edit thresholds opens the threshold popover');
  await page.keyboard.press('Escape');
  // Session cards open a single recording, which keeps its own explorer.
  await page.click('#view-day .session-card'); await page.waitForTimeout(1500);
  ok(/^#\/session\/hrv_session/.test(await page.evaluate(() => location.hash)) && await page.isVisible('#view-session #session-chart'), 'a session card opens the single recording explorer');
  ok(await page.evaluate(() => !document.querySelector('#view-day #session-chart')), 'the Day explorer is cleared when a recording opens');
  await page.evaluate(() => { location.hash = '#/session/day%3A2026-04-25'; }); await page.waitForTimeout(1500);
  ok((await page.evaluate(() => location.hash)) === '#/day/2026-04-25' && await page.isVisible('#view-day #session-chart'), 'old #/session/day: route opens the Day view');
  ok(!page.errors.length, 'no page errors on demo: ' + page.errors.join(' | '));
  await ctx.close();
}

// ---- 4. Phone ----
for (const scale of [1, 2]) {
  const { ctx, page } = await newPage(360, scale);
  await page.goto(cur.base + '/hrv_viewer.html?demo=1#/day/2026-04-26', { waitUntil: 'networkidle' });
  await waitExplorer(page, '#view-day #session-chart');
  await page.scaleText();
  const tag = scale === 1 ? '360' : '360 at 200% text';
  ok(await page.evaluate(() => document.documentElement.scrollWidth <= 360), `${tag}: no horizontal page scroll`);
  const small = await page.evaluate(() => [...document.querySelectorAll('#view-day button, #view-day input, #view-day a[href]')].filter((e) => {
    if (!e.offsetParent) return false; const r = e.getBoundingClientRect(); return r.width < 43.5 || r.height < 43.5;
  }).map((e) => (e.id || e.className || e.tagName) + ' ' + Math.round(e.getBoundingClientRect().width) + 'x' + Math.round(e.getBoundingClientRect().height)));
  ok(!small.length, `${tag}: every Day control is 44 px: ` + small.slice(0, 6).join('; '));
  ok(!page.errors.length, `${tag}: no page errors ` + page.errors.join(' | '));
  await ctx.close();
}

// ---- Shots ----
if (SHOTS) {
  const shot = async (name, w, scale, setup, full = false) => {
    const { ctx, page } = await newPage(w, scale);
    await page.goto(cur.base + '/hrv_viewer.html?demo=1#/day/2026-04-26', { waitUntil: 'networkidle' });
    await waitExplorer(page, '#view-day #session-chart');
    await page.scaleText();
    if (setup) await setup(page);
    await page.waitForTimeout(500);
    await page.screenshot({ path: path.join(SHOTS, name + '.png'), fullPage: full });
    if (page.errors.length) console.log('page errors in shot ' + name + ': ' + page.errors.join(' | '));
    await ctx.close();
  };
  const scrollMain = (y) => async (page) => { await page.evaluate((y) => { const m = document.querySelector('main'); if (m) m.scrollTop = y; window.scrollTo(0, y); }, y); };
  await shot('day-1440', 1440, 1);
  await shot('day-1440-below', 1440, 1, scrollMain(760));
  await shot('day-360', 360, 1);
  await shot('day-360-chart', 360, 1, async (p) => { await p.evaluate(() => document.getElementById('session-layout').scrollIntoView()); });
  await shot('day-360-text200', 360, 2);
  await shot('day-360-text200-chart', 360, 2, async (p) => { await p.evaluate(() => document.getElementById('session-layout').scrollIntoView()); });
  // Zoomed: drag the strip's right handle from the data end back to 70% of it.
  await shot('day-1440-zoomed', 1440, 1, async (p) => {
    await p.evaluate(() => document.getElementById('context-overlay').scrollIntoView({ block: 'end' }));
    const b = await p.$eval('#context-brush', (e) => { const r = e.getBoundingClientRect(); return [r.left, r.right, r.top + r.height / 2]; });
    await p.mouse.move(b[1] - 1, b[2]); await p.mouse.down();
    await p.mouse.move(b[0] + (b[1] - b[0]) * 0.7, b[2], { steps: 8 }); await p.mouse.up();
    await p.mouse.move(b[0] + 30, b[2]); await p.mouse.down();
    await p.mouse.move(b[0] + (b[1] - b[0]) * 0.55, b[2], { steps: 8 }); await p.mouse.up();
  });
  await shot('day-1440-marker', 1440, 1, async (p) => { const items = await p.$$('#marker-list .marker-item'); const m = items[Math.min(1, items.length - 1)]; await m.click(); await p.waitForTimeout(600); await m.hover(); });
  await shot('day-1440-layers', 1440, 1, async (p) => { for (const t of ['rmssd', 'maxmin', 'disconnect', 'delta']) { const c = await p.$(`#layer-chips .chip[data-layer="${t}"]:not([disabled])`); if (c) await c.click(); } await p.evaluate(() => document.getElementById('layer-chips').scrollIntoView({ block: 'center' })); });
  await shot('day-1440-kebab', 1440, 1, async (p) => { await p.click('#summary-bar-kebab'); });
  await shot('day-1440-interp', 1440, 1, async (p) => { await p.evaluate(() => { document.getElementById('interp-panel').classList.remove('collapsed'); document.getElementById('interp-panel').scrollIntoView(); }); });
  await shot('day-360-layers', 360, 1, async (p) => { await p.evaluate(() => document.getElementById('layer-chips').scrollIntoView()); });
  {
    const { ctx, page } = await newPage(1440);
    await page.goto(cur.base + '/hrv_viewer.html?demo=1#/session/' + encodeURIComponent('hrv_session_2026-04-26T11-10-35.csv'), { waitUntil: 'networkidle' });
    await waitExplorer(page, '#view-session #session-chart');
    await page.screenshot({ path: path.join(SHOTS, 'single-1440.png') });
    await ctx.close();
    const p2 = await newPage(360);
    await p2.page.goto(cur.base + '/hrv_viewer.html?demo=1#/session/' + encodeURIComponent('hrv_session_2026-04-26T11-10-35.csv'), { waitUntil: 'networkidle' });
    await waitExplorer(p2.page, '#view-session #session-chart');
    await p2.page.screenshot({ path: path.join(SHOTS, 'single-360.png') });
    await p2.ctx.close();
  }
  console.log('shots in ' + SHOTS);
}

await browser.close();
cur.server.close(); old.server.close();
console.log(`day-explorer: ${passes} pass, ${fails} fail`);
process.exit(fails ? 1 : 0);
