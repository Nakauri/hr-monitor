// Guards: v2 day Duration reading 0:00 (S10a), stats drifting from f7cbb1a, mark edits writing twice (S10b HIGH), S27 layout (AUDIT-NOTES 2026-10-11 items 7, 8, 11, 14 to 18); S31 moved layer rows into Layers (items 23, 24). Files: hrv_viewer.html Day view. Runtime: about 50 s per --part; run when hrv_viewer.html changes.
// S10a Day explorer checks, headless.
// 1. Stats parity: the stats bar on a real legacy day and a real v2 day equals the pre-step build
//    (--ref, default f7cbb1a, read through `git show`, opened at its old #/session/day: route).
// 2. Layer chips: each available chip changes its dataset or overlay count, and a second click restores it.
// 3. Structure: Day route renders the explorer; gaps note only with gaps; 44 px day arrows; no uppercase
//    micro-labels; a marker click zooms; a single recording still opens its explorer; no page errors.
// 4. Phone: no horizontal scroll, 44 px controls, at 360 and 360 with 200% text.
// 5. Marks (S10b), on a seeded fixture day that also gives Marks, Warnings, Palps, Posture and Sleep data, so
//    the chip loop exercises all 12 chips: diamonds; a mark label hover (S28); a marker click eases to its window within 1 px and
//    highlights it; edit, delete then Undo for a viewer tap, a recorded mark and a sleep mark; Add sleep;
//    the phone sheet. Each mutant of the viewer must FAIL its sub-check.
// --shots <dir> shoots Day at 1440, 360 and 360 with 200% text, zoomed, a marker selected, layers toggled,
// a single recording, and the S10b panel, sheet, sleep mark, edit and delete states.
// 6. Layout (S27): one phone tools row at 360 and 200% text, the Layers sheet, Reset zoom on the chart corner, gaps line
//    below the chart, Max and Min labels inside the plot, date title on one line, collapsed Summary numbers, no empty
//    band under the chart, chips in full rows, hover line past a pinned mark, clock tooltip; layout-mutants must FAIL.
// --part parity,chips (inside the Layers popover since S31),phone,marks,mutants,layout,layout-mutants,day-shots,marks-shots runs those parts only (default: all).
// Usage: node scripts/day-explorer.mjs [--ref <commit>] [--shots <dir>] [--part <list>] [--ux <ux-audit dir>] [--fixtures <dir>]
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { uxDir } from './ux-dir.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const argVal = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const ROOT = path.resolve(here, '..');
const UX = uxDir(here, argVal('--ux'));
const FIX = path.resolve(argVal('--fixtures') || path.join(UX, '..', 'docs', 'audit-2026-10-09', 'device-2026-10-10'));
const REF = argVal('--ref') || 'f7cbb1a';
const SHOTS = argVal('--shots');
const CHART = path.join(UX, '..', 'docs', 'audit-2026-10-09', 'harness-DT', 'vendor', 'chart.umd.min.js');
const { chromium } = createRequire(path.join(UX, 'kit', 'package.json'))('playwright');
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
const PART = argVal('--part');
const want = (p) => !PART || PART.split(',').includes(p);

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
    if (u.startsWith('http://127.0.0.1:') || u.startsWith('data:') || u.startsWith('blob:')) return route.continue();
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

// ---- Fixture day (S10b, and S10a's L15): marks, warnings, palps, posture and a sleep mark ----
// 2026-09-15 08:00 to 11:00 in America/Edmonton (MDT, UTC-6).
const FX_DAY = '2026-09-15', FX0 = Date.UTC(2026, 8, 15, 14, 0, 0), FX_FILE = 'hrv_session_2026-09-15T08-00-00.000.csv';
const FX_MIN = (m) => FX0 + m * 60000;
function fixtureCsv() {
  const out = ['time_min,epoch_ms,hr_bpm,rmssd_ms,sdnn_match_ms,sdnn_5min_ms,sdnn_full_ms,palpitation,event,warning,connection,posture'];
  for (let i = 0; i < 3 * 3600; i++) {
    const c = new Array(12).fill('');
    c[0] = (i / 60).toFixed(4);
    c[1] = String(FX0 + i * 1000);
    c[2] = String(i >= 3600 && i < 3630 ? 132 : 82 + Math.round(5 * Math.sin(i / 300)));
    c[3] = (i >= 6000 && i < 6020 ? 110 : 32 + 6 * Math.cos(i / 400)).toFixed(2); // 20 s vagal spike: the chills layer has data
    if (i === 1800 || i === 1805 || i === 1810) c[7] = '1';
    if (i === 2700) c[8] = 'sym:dizzy';
    if (i === 3000) c[8] = 'ctx:water';
    if (i === 3300) c[8] = 'Lunch';
    if (i >= 3600 && i < 3630) c[9] = 'warn-high';
    if (i === 0) { c[10] = 'connected'; c[11] = 'sitting'; }
    if (i === 5400) c[11] = 'standing';
    if (i === 7200) c[11] = 'lying';
    out.push(c.join(','));
  }
  return out.join('\n') + '\n';
}
const mrec = (o) => Object.assign({ v: 1, m: '2026-09', by: 'zzzzzz', createdAt: 1, updatedAt: 1, base: 0, deleted: false }, o);
const FX_TAP = 'zzzzzz-t1-aaaa', FX_SLEEP = 'zzzzzz-s1-aaaa';
const FX_MARKS = [
  mrec({ id: FX_TAP, kind: 'tap', at: FX_MIN(40), cls: 'sym', label: 'Nausea' }),
  mrec({ id: FX_SLEEP, kind: 'sleep', from: FX_MIN(150), to: FX_MIN(170) }),
];
// Seeds the recording into the viewer's Drive cache and the marks into aorti_marks, on this origin.
async function seedFixture(page, base) {
  await page.goto(base + '/hrv_viewer.html#/month', { waitUntil: 'networkidle' });
  await page.waitForTimeout(600);
  await page.evaluate(async ({ files, records }) => {
    const openDb = (name, v, stores) => new Promise((res, rej) => { const q = indexedDB.open(name, v);
      q.onupgradeneeded = () => { for (const s of stores) if (!q.result.objectStoreNames.contains(s)) q.result.createObjectStore(s); };
      q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
    const put = (db, store, entries) => new Promise((res, rej) => { const tx = db.transaction(store, 'readwrite');
      for (const [k, v] of entries) tx.objectStore(store).put(v, k); tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
    const kv = await openDb('hr_monitor_kv', 2, ['kv', 'drive-cache']);
    await put(kv, 'drive-cache', Object.entries(files)); kv.close();
    const mk = await openDb('aorti_marks', 1, ['records', 'mine', 'files', 'meta']);
    await put(mk, 'mine', records.map((r) => [r.id, r]));
    await put(mk, 'meta', [['deviceId', 'zzzzzz']]); mk.close();
    localStorage.removeItem('hrv_viewer_index');
  }, { files: { [FX_FILE]: fixtureCsv() }, records: FX_MARKS });
  await page.goto('about:blank');
}
// markers: open the laptop Markers drawer (S31), where the marks checks find their rows.
async function openFixture(base, width = 1440, scale = 1, markers = false) {
  const { ctx, page } = await newPage(width, scale);
  await seedFixture(page, base);
  await page.goto(base + '/hrv_viewer.html#/day/' + FX_DAY, { waitUntil: 'networkidle' });
  await waitExplorer(page, '#view-day #session-chart');
  await page.waitForFunction(() => window.AortiMarksPage && window.AortiMarksPage.store, null, { timeout: 15000 }).catch(() => {});
  await page.waitForSelector('#markers-actions:not([hidden])', { state: 'attached', timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(400);
  await page.scaleText();
  if (markers && width > 768 && !(await page.isVisible('#marker-list'))) { await page.click('#markers-toggle'); await page.waitForTimeout(400); }
  return { ctx, page };
}

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
for (const kind of (want('parity') ? ['legacy', 'v2'] : [])) {
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
  const mk = Object.keys(c.$marks || {}).length;
  const mm = c.config.plugins.some((p) => p.id === 'hrMaxMin') ? 1 : 0;
  return `${ds}|ov${ov}|mk${mk}|mm${mm}`;
});
const covered = new Set(), seen = new Set();
if (want('chips')) {
  const { ctx, page } = await newPage(1440);
  await seedFixture(page, cur.base);
  for (const iso of DEMO_DAYS.concat(FX_DAY)) {
    await page.goto(cur.base + '/hrv_viewer.html' + (iso === FX_DAY ? '' : '?demo=1') + '#/day/' + iso, { waitUntil: 'networkidle' });
    await waitExplorer(page, '#view-day #session-chart');
    await page.click('#markers-open'); await page.waitForSelector('.layers-pop #layer-chips .chip[data-layer]');
    const chips = await page.$$eval('.layers-pop #layer-chips .chip[data-layer]', (els) => els.map((e) => ({ t: e.dataset.layer, dis: e.disabled, on: e.getAttribute('aria-pressed') })));
    for (const c of chips) {
      seen.add(c.t);
      if (c.dis || covered.has(c.t)) continue;
      const s0 = await signature(page);
      await page.click(`.layers-pop #layer-chips .chip[data-layer="${c.t}"]`); await page.waitForTimeout(150);
      const s1 = await signature(page);
      const p1 = await page.getAttribute(`.layers-pop #layer-chips .chip[data-layer="${c.t}"]`, 'aria-pressed');
      await page.click(`.layers-pop #layer-chips .chip[data-layer="${c.t}"]`); await page.waitForTimeout(150);
      const s2 = await signature(page);
      const p2 = await page.getAttribute(`.layers-pop #layer-chips .chip[data-layer="${c.t}"]`, 'aria-pressed');
      ok(s0 && s1 !== s0 && s2 === s0 && p1 !== c.on && p2 === c.on, `chip ${c.t} on ${iso}: ${s0 === s1 ? 'NO CHANGE' : 'changes'} the chart and restores it (aria-pressed ${c.on} > ${p1} > ${p2})`);
      if (!s0 || s1 !== s0) covered.add(c.t);
    }
    await page.keyboard.press('Escape'); await page.waitForTimeout(200);
  }
  const never = [...seen].filter((t) => !covered.has(t));
  console.log(`layer chips: ${seen.size} shown, ${covered.size} exercised; no demo day has data for: ${never.join(', ') || 'none'}`);
  ok(seen.size >= 12, `${seen.size} layer chips`);
  ok(covered.size === 12, `all 12 layer chips exercised (${covered.size})`);
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
    // The list lives in the Markers drawer; the sample week has marks since S42, so open it first.
    if (!(await mk.isVisible())) { await page.click('#markers-toggle'); await page.waitForTimeout(400); }
    await mk.click(); await page.waitForTimeout(700);
    const sc = await page.evaluate(() => { const c = Chart.getChart(document.getElementById('session-chart')); return [c.scales.x.min, c.scales.x.max]; });
    ok(sc[0] <= t && sc[1] >= t && sc[1] - sc[0] < 60, `marker click zooms to ${t.toFixed(2)}: ${sc.map((v) => v.toFixed(2)).join(' to ')}`);
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
for (const scale of (want('phone') ? [1, 2] : [])) {
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

// ---- 5. Marks (S10b) ----
// Each sub-check returns rows [pass, message]; a mutant run must produce at least one failing row.
const evLabels = (page) => page.$$eval('#marker-list .marker-item.type-event .marker-label', (els) => els.map((e) => e.textContent.trim()));
const rowOf = (page, label, type = 'event') => page.locator(`#marker-list .marker-item.type-${type}`, { has: page.locator('.marker-label', { hasText: new RegExp('^' + label + '$') }) }).first();
const storeGet = (page, id) => page.evaluate((id) => window.AortiMarksPage.store.get(id), id);
const storeList = (page, q) => page.evaluate((q) => window.AortiMarksPage.store.list(q), q);
const settle = (page, ms = 700) => page.waitForTimeout(ms);
// Layer chips live in the Layers popover (S31): open it, act, close it.
async function inLayers(page, fn) {
  await tap(page, '#markers-open'); await settle(page, 300);
  try { return await fn('.layers-pop #layer-chips'); } finally { await page.keyboard.press('Escape'); await settle(page, 300); }
}
const layerTap = (page, t) => inLayers(page, (pre) => tap(page, `${pre} .chip[data-layer="${t}"]`));
const layerPressed = (page, t) => inLayers(page, (pre) => page.getAttribute(`${pre} .chip[data-layer="${t}"]`, 'aria-pressed', { timeout: 4000 }).catch(() => null));
// A click that fails soft, so a mutant without the control fails its row instead of stalling the run.
const fillSoft = (page, sel, v) => page.fill(sel, v, { timeout: 4000 }).then(() => true, () => false);
const tap = (page, sel) => (typeof sel === 'string' ? page.locator(sel).first() : sel).click({ timeout: 4000 }).then(() => true, () => false);
// Double-click on the strip resets the brush to the whole axis; its max is the view's duration in minutes.
async function fullDur(page) {
  await page.dblclick('#context-overlay').catch(() => {});
  await settle(page, 400);
  return page.evaluate(() => Chart.getChart(document.getElementById('session-chart')).scales.x.max);
}
// The spec's window: 4 min around a point; a span plus 15% (at least 0.5 min) each side, at least 4 min.
function expectWindow(t, end, dur) {
  let lo, hi;
  if (end != null && end - t > 0.01) { const pad = Math.max(0.5, (end - t) * 0.15); lo = t - pad; hi = end + pad; }
  else { lo = t - 2; hi = t + 2; }
  if (hi - lo < 4) { const c = (lo + hi) / 2; lo = c - 2; hi = c + 2; }
  if (hi - lo >= dur) return [0, dur];
  if (lo < 0) { hi -= lo; lo = 0; }
  if (hi > dur) { lo -= hi - dur; hi = dur; }
  return [lo, hi];
}
// Clicks a marker row, then measures the chart against the expected window in pixels.
async function clickAndMeasure(page, row, dur) {
  const t = parseFloat(await row.getAttribute('data-t'));
  const endAttr = await row.getAttribute('data-end');
  const end = endAttr == null ? null : parseFloat(endAttr);
  await tap(page, row.locator('.mk-go'));
  await page.mouse.move(1, 1);
  await settle(page, 800);
  return page.evaluate(({ t, end, w }) => {
    const c = Chart.getChart(document.getElementById('session-chart'));
    const x = c.scales.x, a = c.chartArea;
    const sel = document.querySelector('#marker-list .marker-item[aria-current="true"]');
    return {
      t, dLeft: Math.abs(x.getPixelForValue(w[0]) - a.left), dRight: Math.abs(x.getPixelForValue(w[1]) - a.right),
      hlAt: c.$hlT == null ? null : c.$hlT, selected: sel ? Number(sel.dataset.t) : null, min: x.min, max: x.max,
    };
  }, { t, end, w: expectWindow(t, end, dur) });
}

const SUBCHECKS = {
  async diamonds(base) {
    const { ctx, page } = await openFixture(base);
    const got = await page.evaluate(() => {
      const c = Chart.getChart(document.getElementById('session-chart'));
      const ann = Object.entries(c.$marks || {});
      const text = getComputedStyle(document.documentElement).getPropertyValue('--text').trim();
      const dim = getComputedStyle(document.documentElement).getPropertyValue('--text-dim').trim();
      const dia = ann.filter(([k]) => k.startsWith('mk_')).map(([, a]) => a);
      const lines = ann.filter(([k]) => k.startsWith('ev_')).map(([, a]) => a);
      return {
        dia: dia.length, diaOk: dia.every((a) => a.pointStyle === 'rectRot' && a.backgroundColor === text),
        userLines: lines.filter((a) => a.markKind !== 'context').every((a) => a.borderColor === text && !(a.borderDash && a.borderDash.length)),
        ctxLines: lines.filter((a) => a.markKind === 'context').every((a) => a.borderColor === dim && a.borderDash && a.borderDash.length > 0),
        listUser: document.querySelectorAll('#marker-list .marker-item.type-event .mk-dia:not(.detected)').length,
        listEvents: document.querySelectorAll('#marker-list .marker-item.type-event').length,
        listDetected: document.querySelectorAll('#marker-list .marker-item.type-warning .mk-dia.detected, #marker-list .marker-item.type-palp .mk-dia.detected').length,
      };
    });
    const rows = [
      [got.dia === 3 && got.diaOk, `chart: 3 user marks carry a text colour diamond (${got.dia}, ok ${got.diaOk})`],
      [got.userLines && got.ctxLines, `chart: user mark lines solid in the text colour, context ticks dim and dashed (${got.userLines}, ${got.ctxLines})`],
      [got.listEvents === 4 && got.listUser === 4 && got.listDetected >= 2, `list: 4 marks with solid diamonds, detected rows dashed (${got.listUser}/${got.listEvents}, detected ${got.listDetected})`],
      [!page.errors.length, 'diamonds: no page errors ' + page.errors.join(' | ')],
    ];
    await ctx.close();
    return rows;
  },

  async focus(base, width = 1440) {
    const { ctx, page } = await openFixture(base, width, 1, true);
    const rows = [];
    const dur = await fullDur(page);
    if (width < 600) {
      const before = await page.evaluate(() => ({ btn: !!document.getElementById('markers-toggle').offsetParent, side: !!document.querySelector('#session-layout > .session-sidebar').offsetParent }));
      rows.push([before.btn && !before.side, `360: Markers button shows and the inline panel is hidden (${JSON.stringify(before)})`]);
      await tap(page, '#markers-toggle');
      await settle(page, 300);
      const inSheet = await page.evaluate(() => ({
        list: !!document.querySelector('.markers-sheet #marker-list') && !!document.querySelector('.markers-sheet #marker-list').offsetParent,
        slider: !!document.querySelector('.markers-sheet #chills-tune-slider') && !!document.querySelector('.markers-sheet #chills-tune-slider').offsetParent,
      }));
      rows.push([inSheet.list && inSheet.slider, `360: the sheet holds the markers list and the chills slider (${JSON.stringify(inSheet)})`]);
    }
    const m = await clickAndMeasure(page, rowOf(page, 'Dizzy'), dur);
    rows.push([m.dLeft <= 1 && m.dRight <= 1, `${width}: a point mark click eases the chart to its 4 min window (edges off by ${m.dLeft.toFixed(2)} and ${m.dRight.toFixed(2)} px)`]);
    rows.push([m.hlAt != null && Math.abs(m.hlAt - m.t) < 1e-6 && m.selected === m.t, `${width}: the mark is highlighted on the chart and in the list (line at ${m.hlAt}, row ${m.selected})`]);
    if (width < 600) {
      await tap(page, '#markers-toggle'); await settle(page, 300);
      const w = await clickAndMeasure(page, page.locator('.markers-sheet #marker-list .marker-item.type-warning').first(), dur);
      rows.push([w.dLeft <= 1 && w.dRight <= 1, `360: a span click from the sheet eases to the span plus margins (edges off by ${w.dLeft.toFixed(2)} and ${w.dRight.toFixed(2)} px)`]);
      const after = await page.evaluate(() => ({ sheet: !!document.querySelector('.markers-sheet'), back: !!document.querySelector('#session-layout > .session-sidebar #marker-list') }));
      rows.push([!after.sheet && after.back, `360: a marker click closes the sheet and the panel returns to the page (${JSON.stringify(after)})`]);
    } else {
      const w = await clickAndMeasure(page, page.locator('#marker-list .marker-item.type-warning').first(), dur);
      rows.push([w.dLeft <= 1 && w.dRight <= 1 && w.hlAt === w.t, `${width}: a span click eases to the span plus margins (edges off by ${w.dLeft.toFixed(2)} and ${w.dRight.toFixed(2)} px)`]);
      await page.mouse.move(5, 5);
      const kept = await page.evaluate(() => { const c = Chart.getChart(document.getElementById('session-chart')); return c.$hlT == null ? null : c.$hlT; });
      rows.push([kept === w.t, `${width}: the highlight stays after the pointer leaves (${kept})`]);
      await tap(page, '#reset-zoom'); await settle(page, 400);
      const cleared = await page.evaluate(() => ({ sel: document.querySelectorAll('#marker-list .marker-item[aria-current]').length, hl: Chart.getChart(document.getElementById('session-chart')).$hlT == null ? 0 : 1 }));
      rows.push([cleared.sel === 0 && cleared.hl === 0, `${width}: Reset zoom clears the selection (${JSON.stringify(cleared)})`]);
    }
    rows.push([!page.errors.length, `focus ${width}: no page errors ` + page.errors.join(' | ')]);
    await ctx.close();
    return rows;
  },

  // S28: marks hover through the marks plugin, not chartjs-plugin-annotation. Pointer on a mark's label, 2 px
  // right of its line, clear of other marks (box overlays off): the chart highlight, the list row and the tip follow
  // it, with no chart update; off the canvas all clear.
  async hover(base) {
    const { ctx, page } = await openFixture(base);
    const rows = [];
    const p = await page.evaluate(() => {
      const c = Chart.getChart(document.getElementById('session-chart'));
      c.canvas.scrollIntoView({ block: 'center' });
      const lines = (c._hrMk || []).filter((i) => i.kind === 'line');
      // Box overlays hover after the marks and would take the highlight; this check is about the marks alone.
      c._hrOvCache = [];
      const free = (i) => lines.every((o) => o === i || Math.abs(o.px - i.px) > 12);
      const it = lines.filter((i) => i.lab && free(i)).sort((a, b) => a.px - b.px)[0];
      if (!it) return null;
      window.__upd = 0; const u = c.update; c.update = function (...a) { window.__upd++; return u.apply(this, a); };
      const r = c.canvas.getBoundingClientRect();
      return { x: r.left + it.px + 2, y: r.top + it.lab.y + it.lab.h / 2, t: it.m.t, label: it.m.label.content };
    });
    if (!p) { await ctx.close(); return [[false, 'hover: no mark label clear of other marks']]; }
    await page.mouse.move(p.x - 40, p.y + 120); await settle(page, 200);
    await page.mouse.move(p.x, p.y); await settle(page, 300);
    const on = await page.evaluate(() => {
      const c = Chart.getChart(document.getElementById('session-chart'));
      const row = document.querySelector('#marker-list .marker-item.chart-hover');
      const tip = document.getElementById('anno-tip');
      return { hl: c.$hlT, row: row ? Number(row.dataset.t) : null, upd: window.__upd, tip: tip && tip.style.display !== 'none' ? tip.textContent : null };
    });
    rows.push([on.hl === p.t && on.row === p.t && on.upd === 0 && !!on.tip && on.tip.includes(p.label), `hover on the "${p.label}" label highlights the mark on the chart and in the list with no chart update (${JSON.stringify(on)}, mark at ${p.t})`]);
    await page.mouse.move(2, 2); await settle(page, 300);
    const off = await page.evaluate(() => ({ hl: Chart.getChart(document.getElementById('session-chart')).$hlT, rows: document.querySelectorAll('#marker-list .marker-item.chart-hover').length, tip: (document.getElementById('anno-tip') || { style: {} }).style.display }));
    rows.push([off.hl == null && off.rows === 0 && off.tip === 'none', `pointer off the chart clears the highlight, the list row and the tip (${JSON.stringify(off)})`]);
    rows.push([!page.errors.length, 'hover: no page errors ' + page.errors.join(' | ')]);
    await ctx.close();
    return rows;
  },

  // A viewer tap: edit, delete (Cancel keeps it), delete then Undo.
  async tap(base) {
    const { ctx, page } = await openFixture(base, 1440, 1, true);
    const rows = [];
    await layerTap(page, 'warning');
    await rowOf(page, 'Nausea').locator('.mk-edit').click({ timeout: 4000 }).catch(() => {});
    await fillSoft(page, '#mk-label', 'Nausea bad');
    await tap(page, '.mark-editor [data-cls="note"]');
    await tap(page, '.mark-editor [data-act="save"]'); await settle(page, 1200);
    let L = await evLabels(page), r = await storeGet(page, FX_TAP);
    rows.push([L.includes('Nausea bad') && !L.includes('Nausea') && r && !r.deleted && r.label === 'Nausea bad' && r.cls === 'note' && r.at === FX_MIN(40), `viewer tap edit: list ${JSON.stringify(L)}, record ${r && r.cls + ' ' + r.label}`]);
    const warnChip = await layerPressed(page, 'warning');
    rows.push([warnChip === 'false', `a save keeps the layer choices (Warnings chip pressed ${warnChip})`]);
    await layerTap(page, 'warning');
    await rowOf(page, 'Nausea bad').locator('.mk-edit').click({ timeout: 4000 }).catch(() => {});
    await tap(page, '.mark-editor [data-act="delete"]');
    const cancelled = await tap(page, '.mark-editor .confirm [class="btn"]'); await settle(page, 500);
    L = await evLabels(page); r = await storeGet(page, FX_TAP);
    rows.push([cancelled && L.includes('Nausea bad') && !r.deleted, `viewer tap delete: Cancel in the confirm keeps it (Cancel clicked ${cancelled})`]);
    await tap(page, '.mark-editor [data-act="delete"]');
    await tap(page, '.mark-editor .confirm .btn.danger'); await settle(page, 1200);
    L = await evLabels(page); r = await storeGet(page, FX_TAP);
    const toast = await page.evaluate(() => { const t = document.querySelector('.toast'); return t ? t.textContent.trim() : ''; });
    rows.push([!L.includes('Nausea bad') && r.deleted && /Mark deleted/.test(toast) && /Undo/.test(toast), `viewer tap delete: gone, tombstoned, toast "${toast}"`]);
    await tap(page, '.toast .undo'); await settle(page, 1200);
    L = await evLabels(page); r = await storeGet(page, FX_TAP);
    rows.push([L.includes('Nausea bad') && !r.deleted && r.label === 'Nausea bad', `viewer tap Undo restores it: ${JSON.stringify(L)}`]);
    rows.push([!page.errors.length, 'viewer tap: no page errors ' + page.errors.join(' | ')]);
    await ctx.close();
    return rows;
  },

  // A recorded mark: edit (a reversal plus a replacing tap), delete then Undo.
  async recorded(base) {
    const { ctx, page } = await openFixture(base, 1440, 1, true);
    const rows = [];
    await rowOf(page, 'Dizzy').locator('.mk-edit').click({ timeout: 4000 }).catch(() => {});
    await fillSoft(page, '#mk-label', 'Dizzy spell');
    await tap(page, '.mark-editor [data-act="save"]'); await settle(page, 1200);
    let L = await evLabels(page);
    const revs = await storeList(page, { kind: 'rev' });
    const taps = await storeList(page, { kind: 'tap' });
    const rev = revs.find((x) => x.row.ep === FX_MIN(45) && x.row.label === 'sym:dizzy');
    const rep = taps.find((x) => rev && x.replaces === rev.id);
    rows.push([L.includes('Dizzy spell') && !L.includes('Dizzy') && !!rev && !!rep && rep.label === 'Dizzy spell' && rep.cls === 'sym', `recorded edit: list ${JSON.stringify(L)}, rev ${!!rev}, replacing tap ${rep && rep.label}`]);
    const before = JSON.stringify(await storeList(page, { withDeleted: true }));
    await rowOf(page, 'Water').locator('.mk-edit').click({ timeout: 4000 }).catch(() => {});
    await tap(page, '.mark-editor [data-act="save"]'); await settle(page, 800);
    rows.push([before === JSON.stringify(await storeList(page, { withDeleted: true })) && !(await page.$('.mark-editor')), 'Save with nothing changed writes nothing and closes the editor']);
    await rowOf(page, 'Lunch').locator('.mk-edit').click({ timeout: 4000 }).catch(() => {});
    await tap(page, '.mark-editor [data-act="delete"]');
    await tap(page, '.mark-editor .confirm .btn.danger'); await settle(page, 1200);
    L = await evLabels(page);
    let lunchRev = (await storeList(page, { kind: 'rev' })).find((x) => x.row.ep === FX_MIN(55) && x.row.label === 'Lunch');
    rows.push([!L.includes('Lunch') && !!lunchRev, `recorded delete: gone from the list, reversal written (${!!lunchRev})`]);
    await tap(page, '.toast .undo'); await settle(page, 1200);
    L = await evLabels(page);
    lunchRev = (await storeList(page, { kind: 'rev', withDeleted: true })).find((x) => x.row.ep === FX_MIN(55) && x.row.label === 'Lunch');
    rows.push([L.includes('Lunch') && !!lunchRev && lunchRev.deleted, `recorded Undo restores it: ${JSON.stringify(L)}, reversal deleted ${lunchRev && lunchRev.deleted}`]);
    rows.push([!page.errors.length, 'recorded: no page errors ' + page.errors.join(' | ')]);
    await ctx.close();
    return rows;
  },

  // Sleep marks: Add sleep, edit the end, an end before the start, delete then Undo.
  async sleep(base) {
    const { ctx, page } = await openFixture(base, 1440, 1, true);
    const rows = [];
    const mine = () => page.$$eval('#marker-list .marker-item.type-sleep.mine', (els) => els.length);
    const n0 = await mine();
    await tap(page, '#add-sleep');
    await fillSoft(page, '#sl-from', '2026-09-15T10:00');
    await fillSoft(page, '#sl-to', '2026-09-15T10:20');
    await page.locator('.mark-editor [data-act="save"]').dblclick({ timeout: 4000 }).catch(() => {}); await settle(page, 1200);
    let sl = await storeList(page, { kind: 'sleep' });
    const made = sl.find((x) => x.id !== FX_SLEEP);
    rows.push([sl.length === 2, `a double tap on Save makes one sleep mark (${sl.length - 1} made)`]);
    rows.push([n0 === 1 && (await mine()) === 2 && !!made && made.from === FX_MIN(120) && made.to === FX_MIN(140), `Add sleep: ${n0} > ${await mine()} sleep marks, new ${made && (made.from - FX0) / 60000}..${made && (made.to - FX0) / 60000} min`]);
    const ov = await page.evaluate((a) => (Chart.getChart(document.getElementById('session-chart')).options.plugins.hrOverlays.overlays || []).some((o) => Math.abs(o.xMin - a[0]) < 0.01 && Math.abs(o.xMax - a[1]) < 0.01), [(FX_MIN(120) - Date.UTC(2026, 8, 15, 6)) / 60000, (FX_MIN(140) - Date.UTC(2026, 8, 15, 6)) / 60000]);
    rows.push([ov, 'the new sleep mark draws a sleep window on the chart']);
    const rowNew = page.locator('#marker-list .marker-item.type-sleep.mine').filter({ has: page.locator(`.marker-time`, { hasText: '10:00:00' }) }).first();
    await rowNew.locator('.mk-edit').click({ timeout: 4000 }).catch(() => {});
    await fillSoft(page, '#sl-to', '2026-09-15T09:50');
    await tap(page, '.mark-editor [data-act="save"]'); await settle(page, 400);
    const err = await page.evaluate(() => { const e = document.querySelector('.mark-editor .err'); return e && !e.hidden ? e.textContent : ''; });
    sl = await storeList(page, { kind: 'sleep' });
    rows.push([/End is before start/.test(err) && sl.find((x) => x.id === made.id).to === FX_MIN(140), `an end before the start is refused ("${err}")`]);
    await fillSoft(page, '#sl-to', '2026-09-15T10:30');
    await tap(page, '.mark-editor [data-act="save"]'); await settle(page, 1200);
    sl = await storeList(page, { kind: 'sleep' });
    rows.push([sl.find((x) => x.id === made.id).to === FX_MIN(150) && sl.find((x) => x.id === made.id).from === FX_MIN(120), 'sleep edit moves the end']);
    await page.locator('#marker-list .marker-item.type-sleep.mine').filter({ has: page.locator('.marker-time', { hasText: '10:30:00' }) }).first().locator('.mk-edit').click({ timeout: 4000 }).catch(() => {});
    await tap(page, '.mark-editor [data-act="delete"]');
    await tap(page, '.mark-editor .confirm .btn.danger'); await settle(page, 1200);
    const gone = await storeGet(page, FX_SLEEP);
    rows.push([gone.deleted && (await mine()) === 1, `sleep delete: tombstoned, ${await mine()} left`]);
    await tap(page, '.toast .undo'); await settle(page, 1200);
    const back = await storeGet(page, FX_SLEEP);
    rows.push([!back.deleted && back.from === FX_MIN(150) && back.to === FX_MIN(170) && (await mine()) === 2, 'sleep Undo restores the window']);
    rows.push([!page.errors.length, 'sleep: no page errors ' + page.errors.join(' | ')]);
    await ctx.close();
    return rows;
  },

  // Phone: edit inside the sheet; the sheet stays open on the re-rendered panel.
  async phone(base) {
    const rows = await SUBCHECKS.focus(base, 360);
    const { ctx, page } = await openFixture(base, 360);
    await tap(page, '#markers-toggle'); await settle(page, 300);
    await page.locator('.markers-sheet #marker-list .marker-item.type-sleep.mine .mk-edit').first().click({ timeout: 4000 }).catch(() => {});
    await fillSoft(page, '#sl-to', '2026-09-15T10:55');
    await tap(page, '.mark-editor [data-act="save"]'); await settle(page, 1200);
    const st = await page.evaluate(() => ({ open: !!document.querySelector('.markers-sheet #marker-list'), one: document.querySelectorAll('#marker-list').length }));
    const r = await storeGet(page, FX_SLEEP);
    rows.push([st.open && st.one === 1 && r.to === FX_MIN(175), `360: an edit in the sheet saves and the sheet shows the new list (${JSON.stringify(st)}, end ${(r.to - FX0) / 60000} min)`]);
    rows.push([!page.errors.length, 'phone: no page errors ' + page.errors.join(' | ')]);
    await ctx.close();
    return rows;
  },
};

async function runSub(name, base) {
  try { return await SUBCHECKS[name](base); }
  catch (e) { return [[false, `${name} threw: ${String(e && e.message).split(String.fromCharCode(10))[0]}`]]; }
}
const report5 = (rows) => { for (const [c, m] of rows) ok(c, m); };
if (want('marks')) {
  // --sub <a,b> runs those sub-checks only; all seven together pass one 170 s shell window.
  const subs = ['diamonds', 'hover', 'focus', 'tap', 'recorded', 'sleep', 'phone'].filter((n) => !argVal('--sub') || argVal('--sub').split(',').includes(n));
  for (const name of subs) report5(await runSub(name, cur.base));
}
if (want('mutants')) {
  const real = fs.readFileSync(path.join(ROOT, 'hrv_viewer.html'), 'utf8').replace(/\r\n/g, '\n');
  const MUTANTS = [
    ['diamonds', 'no diamond handles', "          marks['mk_' + idCounter++] = handle;", "          void handle;"],
    ['focus', 'marker click jumps with the old zoom, no highlight', '    easeBrushTo(lo, hi, () => { if (pinnedMarkT === item.t) highlightAtTime(item.t); });', '    zoomTo(item.t);'],
    ['focus', 'marker click without the highlight', '    pinnedMarkT = item.t;\n    // A tooltip left by a tap', '    // A tooltip left by a tap'],
    ['tap', 'delete skips the confirm', "    if (!ok) return;\n    const id = item.edit.markId;", "    const id = item.edit.markId;"],
    ['tap', 'a save resets the layers', '    if (priorFilters) for (const k of Object.keys(activeFilters))', '    if (false) for (const k of Object.keys(activeFilters))'],
    ['tap', 'Undo does nothing', '      undo: () => marksWrite(() => id ? store.restore(id) : store.unreverse(row)),', '      undo: () => {},'],
    ['recorded', 'a recorded edit adds a tap without hiding the row', "store.editRecorded({ ep: item.edit.ep, label: raw }, patch)", 'store.createTap(patch)'],
    ['recorded', 'Undo of a recorded delete restores nothing', '      undo: () => marksWrite(() => id ? store.restore(id) : store.unreverse(row)),', '      undo: () => marksWrite(() => id ? store.restore(id) : Promise.resolve()),'],
    ['sleep', 'Save has no busy guard', "      if (box.dataset.busy) return false;\n      box.dataset.busy = '1';\n      box.querySelectorAll('button').forEach(b => { b.disabled = true; });\n", ''],
    ['recorded', 'Save with nothing changed still writes', "      if (cls === cls0 && text === (label || '').trim() && timeInput.value === timeInput.defaultValue) { closeEditor(box); return; }\n", ''],
    ['sleep', 'a sleep edit keeps the old window', '    marksWrite(() => rec ? store.edit(rec.id, { from: a, to: b }) : store.createSleep({ from: a, to: b }), box);', '    marksWrite(() => rec ? store.edit(rec.id, {}) : store.createSleep({ from: a, to: b }), box);'],
    ['phone', 'no markers sheet', "    if (!sb || (markersSheet && !markersSheet.closed)) return;", "    return;"],
    ['hover', 'marks hover enters nothing', '      if (hit) annoEnter(hit.t, hit.html, e);', '      void hit;'],
  ];
  // --only <n,n> runs those mutants by index, so the set can run in parts.
  const onlyM = argVal('--only') ? argVal('--only').split(',').map(Number) : null;
  for (const [sub, name, a, b] of MUTANTS.filter((m, i) => !onlyM || onlyM.includes(i))) {
    if (!real.includes(a)) { ok(false, `mutant ${name}: anchor missing`); continue; }
    const m = await serve(real.replace(a, b));
    const rows = await runSub(sub, m.base);
    m.server.close();
    const failed = rows.filter((r) => !r[0]);
    ok(failed.length > 0, `MUTANT ${sub}: ${name}: ` + (failed.length ? 'FAILED as required (' + failed.map((r) => r[1].slice(0, 70)).join(' | ') + ')' : 'NOT CAUGHT'));
  }
}

// ---- 6. Layout (S27) ----
// Named bugs, AUDIT-NOTES-2026-10-11: item 7 (empty band under the chart, 11 plus 1 chips), item 8 (hover line frozen
// at a pinned mark), items 11 and 18 (phone tools row wraps; Layers sheet), item 14 (gaps line above the chart), item 15
// (phone Summary shows no numbers), item 16 (Max and Min labels clipped), item 17 (date title on 2 lines at 360; a
// left-edge tooltip in duration form on a clock axis). Each mutant below must FAIL the layout rows.
async function openDemo(base, width, scale = 1, init) {
  const { ctx, page } = await newPage(width, scale);
  if (init) await ctx.addInitScript(init);
  await page.goto(base + '/hrv_viewer.html?demo=1#/day/2026-04-26', { waitUntil: 'networkidle' });
  await waitExplorer(page, '#view-day #session-chart');
  await page.waitForTimeout(400);
  await page.scaleText();
  await page.waitForTimeout(300);
  return { ctx, page };
}
// Max and Min label boxes against the chart area, as the max and min plugin last drew them.
const labelBoxes = (page) => page.evaluate(() => {
  const c = Chart.getChart(document.getElementById('session-chart'));
  const a = c.chartArea;
  return (c.$maxMin || [])
    .map((e) => ({ name: e.name, inside: e.x >= a.left - 0.5 && e.x2 <= a.right + 0.5 && e.y >= a.top - 0.5 && e.y2 <= a.bottom + 0.5, box: [e.x, e.y, e.x2, e.y2].map(Math.round), area: [a.left, a.top, a.right, a.bottom].map(Math.round) }));
});
const rect = (page, sel) => page.evaluate((sel) => { const e = document.querySelector(sel); if (!e) return null; const r = e.getBoundingClientRect(); return { l: r.left, t: r.top, r: r.right, b: r.bottom, w: r.width, h: r.height, shown: r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== 'hidden' }; }, sel);
// Drags the strip's right handle to a share of the strip width.
async function dragStrip(page, share) {
  await page.evaluate(() => document.getElementById('context-overlay').scrollIntoView({ block: 'center' }));
  const hb = await page.$eval('#context-brush', (e) => { const r = e.getBoundingClientRect(); return [r.left, r.right, r.top + r.height / 2]; });
  const strip = await rect(page, '#context-overlay');
  await page.mouse.move(hb[1] - 1, hb[2]); await page.mouse.down();
  await page.mouse.move(strip.l + strip.w * share, hb[2], { steps: 6 }); await page.mouse.up();
  await page.waitForTimeout(500);
}
// White pixels down a canvas column inside the chart area (the highlight and hover line are white).
const whiteAt = (page, x) => page.evaluate((x) => {
  const c = Chart.getChart(document.getElementById('session-chart'));
  const a = c.chartArea, ctx = c.canvas.getContext('2d');
  let n = 0, w = 0;
  for (let y = Math.ceil(a.top) + 4; y < a.bottom - 4; y += 6) { n++; const d = ctx.getImageData(Math.round(x), y, 1, 1).data; if (d[0] > 235 && d[1] > 235 && d[2] > 235) w++; }
  return n ? w / n : 0;
}, x);

// Reset zoom box against the plot area and both y-axis label columns (page px). S27 follow-up (Khal 10-12 via the main
// session: the button covered the right axis 45 and 40).
const resetClear = (page) => page.evaluate(() => {
  const c = Chart.getChart(document.getElementById('session-chart'));
  const cr = c.canvas.getBoundingClientRect(), a = c.chartArea;
  const b = document.getElementById('reset-zoom').getBoundingClientRect();
  const col = (s) => s && s.options.display !== false ? [cr.left + s.left, cr.left + s.right] : null;
  const hit = (x) => x && b.left < x[1] && b.right > x[0];
  return {
    shown: b.width > 0, w: Math.round(b.width), h: Math.round(b.height),
    inPlot: b.left >= cr.left + a.left - 0.5 && b.right <= cr.left + a.right + 0.5 && b.top >= cr.top + a.top - 0.5 && b.bottom <= cr.top + a.bottom + 0.5,
    nearTopRight: cr.left + a.right - b.right <= 12 && b.top - (cr.top + a.top) <= 12,
    hitsY: hit(col(c.scales.y)), hitsY1: hit(col(c.scales.y1)),
    bg: getComputedStyle(document.getElementById('reset-zoom')).backgroundColor,
  };
});
// Layers sheet rows: label and swatch contrast against the row (opacity included) and the drawn box per state.
const sheetRows = (page) => page.evaluate(() => {
  const parse = (c) => { const m = /rgba?\(([^)]+)\)/.exec(c || ''); if (!m) return null; const p = m[1].split(/[\s,/]+/).filter(Boolean).map(parseFloat); return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1]; };
  const lum = (c) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]); };
  const ratio = (x, y) => { const p = lum(x), q = lum(y); return (Math.max(p, q) + 0.05) / (Math.min(p, q) + 0.05); };
  const bgOf = (el) => { const chain = []; for (let n = el; n; n = n.parentElement) { const c = parse(getComputedStyle(n).backgroundColor); if (c && c[3] > 0) { chain.push(c); if (c[3] >= 1) break; } } let bg = [10, 10, 10]; for (let i = chain.length - 1; i >= 0; i--) { const c = chain[i]; bg = [0, 1, 2].map((k) => c[k] * c[3] + bg[k] * (1 - c[3])); } return bg; };
  const opa = (el) => { let o = 1; for (let n = el; n; n = n.parentElement) o *= +getComputedStyle(n).opacity; return o; };
  return [...document.querySelectorAll('.layers-sheet #layer-chips .chip')].filter((c) => c.getBoundingClientRect().height > 0).map((c) => {
    const lbl = c.querySelector('.lbl'), bg = bgOf(c), o = opa(lbl), fg = parse(getComputedStyle(lbl).color);
    const seen = [0, 1, 2].map((k) => fg[k] * o * fg[3] + bg[k] * (1 - o * fg[3]));
    const box = getComputedStyle(c, '::after'), tick = getComputedStyle(c, '::before');
    return { t: c.dataset.layer, on: c.getAttribute('aria-pressed') === 'true', disabled: c.disabled, text: +ratio(seen, bg).toFixed(2),
      boxFill: box.backgroundColor, boxBorder: box.borderTopColor, boxW: parseFloat(box.width), tick: tick.content !== 'none' && tick.content !== 'normal',
      frame: getComputedStyle(c).borderTopColor + ' ' + getComputedStyle(c).boxShadow + ' ' + getComputedStyle(c).backgroundColor };
  });
});

const LAYOUT = {
  async phone(base) {
    const rows = [];
    for (const scale of [1, 2]) {
      const tag = scale === 1 ? '360' : '360 at 200% text';
      const { ctx, page } = await openDemo(base, 360, scale);
      await page.evaluate(() => document.querySelector('.chart-panel').scrollIntoView({ block: 'start' }));
      const seg = await rect(page, '#axis-mode'), lay = await rect(page, '#markers-open'), chart = await rect(page, '.chart-wrap'), panel = await page.evaluate(() => { const e = document.querySelector('.chart-panel'); const r = e.getBoundingClientRect(), cs = getComputedStyle(e); return { l: r.left + parseFloat(cs.paddingLeft), r: r.right - parseFloat(cs.paddingRight) }; });
      const segTops = await page.$$eval('#axis-mode > button', (bs) => bs.map((b) => Math.round(b.getBoundingClientRect().top)));
      const layFits = await page.$eval('#markers-open', (e) => e.scrollWidth <= e.clientWidth + 1);
      const segRight = await page.$$eval('#axis-mode > button', (bs) => Math.max(...bs.map((b) => b.getBoundingClientRect().right)));
      const oneRow = seg && lay && Math.abs(seg.t - lay.t) < 2 && segTops.every((t) => Math.abs(t - segTops[0]) < 2) && lay.b <= chart.t && lay.r <= panel.r + 0.5 && seg.l >= panel.l - 0.5 && segRight <= lay.l + 0.5 && layFits && lay.h >= 43.5;
      rows.push([oneRow, `${tag}: Clock, Duration and Layers on one row above the chart, inside the card (segmented top ${seg && Math.round(seg.t)} right ${Math.round(segRight)}, Layers top ${lay && Math.round(lay.t)} ${lay && Math.round(lay.l)}..${lay && Math.round(lay.r)}, card right ${Math.round(panel.r)})`]);
      const reset0 = await rect(page, '#reset-zoom');
      rows.push([!reset0.shown, `${tag}: Reset zoom is not shown at full range`]);
      const chipsInPage = await page.evaluate(() => { const c = document.querySelector('.chart-panel > #layer-chips'); return !!c && c.getBoundingClientRect().height > 0; });
      rows.push([!chipsInPage, `${tag}: no layer chips under the chart on the phone`]);
      const gaps = await rect(page, '#view-day .gaps-note'), strip = await rect(page, '.context-wrap');
      rows.push([!!gaps && gaps.shown && gaps.t >= chart.b && gaps.t >= strip.b - 0.5, `${tag}: gaps line sits below the chart and the strip (${gaps ? Math.round(gaps.t) : 'none'} vs chart bottom ${Math.round(chart.b)})`]);
      if (scale === 1) {
        const title = await page.evaluate(() => { const h = document.querySelector('#view-day .day-title'); const lines = [...h.querySelectorAll('span')].filter((s) => s.getBoundingClientRect().width > 0).reduce((n, s) => n + s.getClientRects().length, 0); return { lines, text: h.innerText.trim() }; });
        rows.push([title.lines === 1, `360: date title on one line ("${title.text}", ${title.lines} line boxes)`]);
      }
      const lb = await labelBoxes(page);
      rows.push([lb.length === 2 && lb.every((b) => b.inside), `${tag}: Max and Min labels inside the plot ${JSON.stringify(lb.map((b) => [b.name, b.box, b.area]))}`]);
      // Layers sheet (S31): full-width 44 px layer rows only; the markers list has its own sheet.
      await tap(page, '#markers-open'); await page.waitForTimeout(400);
      const sh = await page.evaluate(() => {
        const s = document.querySelector('.layers-sheet .sheet-body');
        if (!s) return null;
        const cs = getComputedStyle(s), inner = s.getBoundingClientRect().width - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
        const chips = [...s.querySelectorAll('#layer-chips .chip')].filter((c) => c.getBoundingClientRect().height > 0);
        return { title: document.querySelector('.layers-sheet .sheet-head h2').textContent.trim(), n: chips.length, full: chips.every((c) => c.getBoundingClientRect().width >= inner - 1), tall: chips.every((c) => c.getBoundingClientRect().height >= 43.5), noList: !s.querySelector('#marker-list, .marker-item') };
      });
      rows.push([!!sh && sh.title === 'Layers' && sh.n >= 10 && sh.full && sh.tall && sh.noList, `${tag}: Layers sheet holds full-width 44 px layer rows and no markers ${JSON.stringify(sh)}`]);
      const sr = await sheetRows(page);
      const onBoxes = new Set(sr.filter((r) => r.on).map((r) => r.boxFill + r.boxBorder)), offBoxes = new Set(sr.filter((r) => !r.on).map((r) => r.boxFill + r.boxBorder));
      const lowText = sr.filter((r) => r.text < (r.disabled ? 3 : 4.5)).map((r) => r.t + ' ' + r.text);
      rows.push([sr.length >= 10 && !lowText.length, `${tag}: every Layers row label reads at 4.5:1 on or off, 3:1 when there is none here (lowest ${Math.min(...sr.map((r) => r.text))}${lowText.length ? '; under: ' + lowText.join(', ') : ''})`]);
      // Khal 2026-10-12: rows with none here are dimmed a little so they read as not clickable.
      const live = sr.filter((r) => !r.disabled).map((r) => r.text), dead = sr.filter((r) => r.disabled).map((r) => r.text);
      rows.push([dead.length > 0 && Math.max(...dead) < Math.min(...live), `${tag}: none-here rows are dimmer than every live row (dimmest live ${Math.min(...live)}, brightest none-here ${Math.max(...dead)})`]);
      rows.push([sr.every((r) => r.boxW >= 17) && onBoxes.size === 1 && offBoxes.size === 1 && [...onBoxes][0] !== [...offBoxes][0] && sr.every((r) => r.tick === r.on) && new Set(sr.map((r) => r.frame)).size === 1 && sr.some((r) => r.on) && sr.some((r) => !r.on && !r.disabled) && sr.some((r) => r.disabled),
        `${tag}: Layers rows have two states, read from the box (on ${sr.filter((r) => r.on).length}, off ${sr.filter((r) => !r.on).length}, box styles on ${onBoxes.size} off ${offBoxes.size}, row frames ${new Set(sr.map((r) => r.frame)).size})`]);
      await page.keyboard.press('Escape'); await page.waitForTimeout(300);
      const back = await page.evaluate(() => !document.querySelector('.layers-sheet') && !document.querySelector('#view-day .layer-chip') && !!document.querySelector('#session-layout > .session-sidebar'));
      rows.push([back, `${tag}: closing the sheet removes the layer rows and leaves the markers panel in place`]);
      // Zoomed: Reset zoom on the chart's top corner.
      await dragStrip(page, 0.3);
      await page.evaluate(() => document.querySelector('.chart-panel').scrollIntoView({ block: 'start' }));
      const rz = await rect(page, '#reset-zoom'), cw = await rect(page, '.chart-wrap'), lay2 = await rect(page, '#markers-open');
      const segRight2 = await page.$$eval('#axis-mode > button', (bs) => Math.max(...bs.map((b) => b.getBoundingClientRect().right)));
      const rc = await resetClear(page);
      rows.push([rz && rz.shown && rc.inPlot && rc.nearTopRight && !rc.hitsY && !rc.hitsY1 && rc.w <= 44.5 && rc.h <= 44.5 && Math.abs(lay2.t - lay.t) < 2 && segRight2 <= lay2.l + 0.5 && Math.abs(lay2.r - lay.r) < 1, `${tag}: zoomed, Reset zoom is a 44 px button in the plot's top right, clear of both axis label columns, and the tools row keeps its places (${JSON.stringify(rc)})`]);
      const lbz = await labelBoxes(page);
      rows.push([lbz.every((b) => b.inside), `${tag}: zoomed, shown Max and Min labels inside the plot ${JSON.stringify(lbz.map((b) => [b.name, b.box, b.area]))}`]);
      rows.push([!page.errors.length, `${tag}: no page errors ` + page.errors.join(' | ')]);
      await ctx.close();
    }
    // Collapsed Summary keeps the key numbers.
    const { ctx, page } = await openDemo(base, 360, 1, () => { try { localStorage.setItem('hrv_summary_collapsed', '1'); } catch (e) {} });
    const sum = await page.evaluate(() => {
      const bar = document.getElementById('summary-bar');
      const shown = [...bar.querySelectorAll('.summary-stat')].filter((s) => s.getBoundingClientRect().height > 0).map((s) => s.dataset.stat);
      const vals = [...bar.querySelectorAll('.summary-stat-value')].filter((v) => v.getBoundingClientRect().height > 0).length;
      return { collapsed: bar.classList.contains('collapsed'), shown, vals, h: Math.round(bar.getBoundingClientRect().height) };
    });
    rows.push([sum.collapsed && ['hrAvg', 'hrMax', 'hrMin', 'rmssdAvg'].every((k) => sum.shown.includes(k)) && sum.vals === 4 && sum.h <= 160, `360: collapsed Summary shows Avg HR, Max, Min and Avg HRV (${JSON.stringify(sum)})`]);
    await ctx.close();
    return rows;
  },

  async laptop(base) {
    const rows = [];
    for (const width of [1440, 1767]) {
      const { ctx, page } = await openDemo(base, width);
      for (const open of [true, false]) {
        if (open) { await page.click('#markers-toggle'); await page.waitForTimeout(500); }
        else { await page.click('#markers-close'); await page.waitForTimeout(500); }
        const tag = `${width}${open ? ' markers open' : ''}`;
        const band = await page.evaluate(() => { const c = document.querySelector('.chart-panel').getBoundingClientRect(), n = document.getElementById('interp-panel').getBoundingClientRect(); return Math.round(n.top - c.bottom); });
        rows.push([band >= 0 && band <= 32, `${tag}: next card ${band} px below the chart card (32 at most)`]);
        const chips = await page.$$eval('#view-day .chip', (cs) => cs.filter((c) => c.getBoundingClientRect().height > 0).length);
        rows.push([chips === 0, `${tag}: no layer chips on the Day page; Layers is a popover (S31) (${chips})`]);
      }
      const gaps = await rect(page, '#view-day .gaps-note'), chart = await rect(page, '.chart-wrap');
      rows.push([!!gaps && gaps.t >= chart.b, `${width}: gaps line below the chart (${gaps ? Math.round(gaps.t) : 'none'} vs ${Math.round(chart.b)})`]);
      const lb = await labelBoxes(page);
      rows.push([lb.length === 2 && lb.every((b) => b.inside), `${width}: Max and Min labels inside the plot ${JSON.stringify(lb.map((b) => [b.name, b.box, b.area]))}`]);
      await ctx.close();
    }
    // A long markers list (the fixture day with every layer on) never sizes the row.
    {
      const { ctx, page } = await openFixture(base, 1440);
      await tap(page, '#markers-open'); await page.waitForTimeout(300);
      for (const t of ['disconnect', 'delta']) await tap(page, `.layers-pop #layer-chips .chip[data-layer="${t}"][aria-pressed="false"]:not([disabled])`);
      await page.keyboard.press('Escape'); await page.waitForTimeout(300);
      for (const collapsed of [false, true]) {
        await page.click(collapsed ? '#markers-close' : '#markers-toggle'); await page.waitForTimeout(500);
        const m = await page.evaluate(() => ({ band: Math.round(document.getElementById('interp-panel').getBoundingClientRect().top - document.querySelector('.chart-panel').getBoundingClientRect().bottom), items: document.querySelectorAll('#marker-list .marker-item').length }));
        rows.push([m.band >= 0 && m.band <= 32, `1440 fixture day, ${m.items} markers${collapsed ? ', panel closed' : ''}: next card ${m.band} px below the chart card (32 at most)`]);
      }
      await ctx.close();
    }
    {
      const { ctx, page } = await openDemo(base, 1440);
      await dragStrip(page, 0.3);
      await page.evaluate(() => document.querySelector('.chart-wrap').scrollIntoView({ block: 'center' }));
      const rc = await resetClear(page);
      rows.push([rc.shown && rc.inPlot && rc.nearTopRight && !rc.hitsY && !rc.hitsY1 && rc.w <= 44.5, `1440: zoomed, Reset zoom sits in the plot's top right, clear of both axis label columns (${JSON.stringify(rc)})`]);
      await ctx.close();
    }
    // Hover line follows the pointer while a mark is pinned; the pinned line returns on leave.
    const { ctx, page } = await openDemo(base, 1440);
    await page.click('#axis-mode button[data-mode="clock"]'); await page.waitForTimeout(250);
    const mk = page.locator('#marker-list .marker-item .mk-go').first();
    await page.click('#markers-toggle'); await page.waitForTimeout(300);
    await mk.click({ timeout: 4000 }).catch(() => {}); await page.waitForTimeout(900);
    await page.click('#markers-close'); await page.waitForTimeout(300);
    await page.evaluate(() => document.querySelector('.chart-wrap').scrollIntoView({ block: 'center' }));
    const geo = await page.evaluate(() => { const c = Chart.getChart(document.getElementById('session-chart')); const r = c.canvas.getBoundingClientRect(); return { l: r.left, t: r.top, a: c.chartArea, pin: c.$hlT == null ? null : c.scales.x.getPixelForValue(c.$hlT) }; });
    const seen = [];
    for (const share of [0.2, 0.75]) {
      await page.mouse.move(geo.l + geo.a.left + geo.a.width * share, geo.t + geo.a.top + geo.a.height / 2, { steps: 3 });
      await page.waitForTimeout(250);
      const hx = await page.evaluate(() => { const c = Chart.getChart(document.getElementById('session-chart')); const act = c.tooltip.getActiveElements(); return act.length ? act[0].element.x : null; });
      const at = hx == null ? 0 : await whiteAt(page, hx);
      const atPin = geo.pin == null || hx == null || Math.abs(geo.pin - hx) < 6 ? 0 : await whiteAt(page, geo.pin);
      seen.push({ hx: hx && Math.round(hx), at: +at.toFixed(2), atPin: +atPin.toFixed(2) });
    }
    rows.push([geo.pin != null && seen.every((s) => s.hx != null && s.at > 0.7 && s.atPin < 0.3) && seen[0].hx !== seen[1].hx, `1440: with a mark pinned, the hover line follows the pointer and the pinned line steps aside ${JSON.stringify({ pin: geo.pin && Math.round(geo.pin), seen })}`]);
    await page.mouse.move(geo.l - 20, geo.t - 20); await page.waitForTimeout(250);
    const back = geo.pin == null ? 0 : await whiteAt(page, geo.pin);
    rows.push([back > 0.7, `1440: the pinned line returns when the pointer leaves (${back.toFixed(2)})`]);
    // Left edge, clock axis: the tooltip reads clock time.
    await page.click('#reset-zoom').catch(() => {}); await page.waitForTimeout(400);
    const g2 = await page.evaluate(() => { const c = Chart.getChart(document.getElementById('session-chart')); const r = c.canvas.getBoundingClientRect(); return { l: r.left, t: r.top, a: c.chartArea }; });
    await page.mouse.move(g2.l + g2.a.left + 2, g2.t + g2.a.top + g2.a.height / 2); await page.waitForTimeout(250);
    const tip = await page.evaluate(() => { const c = Chart.getChart(document.getElementById('session-chart')); const t = c.tooltip; return { title: (t.title || []).join(' '), x: Math.round(t.x), w: Math.round(t.width), tick: c.scales.x.ticks[0] && c.scales.x.ticks[0].label }; });
    rows.push([/^\d{1,2}:\d{2} (AM|PM)$/.test(tip.title) && /AM|PM/.test(tip.tick || '') && tip.x >= 0, `1440: left-edge tooltip on the clock axis reads clock time (${JSON.stringify(tip)})`]);
    rows.push([!page.errors.length, 'laptop: no page errors ' + page.errors.join(' | ')]);
    await ctx.close();
    return rows;
  },
};
async function runLayout(name, base) {
  try { return await LAYOUT[name](base); }
  catch (e) { return [[false, `layout ${name} threw: ${String(e && e.message).split(String.fromCharCode(10))[0]}`]]; }
}
if (want('layout')) {
  for (const name of ['phone', 'laptop']) report5(await runLayout(name, cur.base));
}
if (want('layout-mutants')) {
  const real = fs.readFileSync(path.join(ROOT, 'hrv_viewer.html'), 'utf8').replace(/\r\n/g, '\n');
  // Retired 10-12: 'tools row wraps as before' (a flex row without Reset zoom no longer wraps at 360; the 200% overflow
  // mutant guards the one-row rule).
  const L_MUTANTS = [
    ['phone', 'gaps line back above the chart', "chartNote: gapsNoteHtml((s && s.recGaps) || []) });", "});"],
    ['phone', 'Layers keeps its name at 200% text (row overflows)', '  @container (max-width: 18em) {\n    .chart-tools .markers-open { width: 44px; padding: 0; }\n    .chart-tools .markers-open .lbl { display: none; }\n  }\n', ''],
    ['phone', 'long date title on the phone', '    .datenav .day-title .t-long { display: none; }\n', ''],
    ['phone', 'collapsed Summary hides every stat', '    .summary-bar.collapsed .summary-grid { grid-template-columns:', '    .summary-bar.collapsed .summary-grid { display: none; grid-template-columns:'],
    ['phone', 'Layers sheet without the layer rows', 'body: chips ? [chips, sb] : sb,', 'body: sb,'],
    ['phone', 'Reset zoom at the canvas corner over the right axis', '  .chart-wrap .reset-zoom { position: absolute; top: var(--plot-top, 8px); right: var(--plot-right, 8px);', '  .chart-wrap .reset-zoom { position: absolute; top: 4px; right: 4px;'],
    ['laptop', 'Reset zoom at the canvas corner over the right axis (1440)', '  .chart-wrap .reset-zoom { position: absolute; top: var(--plot-top, 8px); right: var(--plot-right, 8px);', '  .chart-wrap .reset-zoom { position: absolute; top: 4px; right: 4px;'],
    ['phone', 'Layers rows faded as before (off dim, no data at 40%)', '    background: transparent; border-color: var(--border); box-shadow: none; opacity: 1;\n  }\n', '  }\n  .markers-sheet .layer-toggles .chip[aria-pressed="false"] { color: var(--text-dim); }\n  .markers-sheet .layer-toggles .chip:disabled { opacity: .4; }\n'],
    ['phone', 'Layers rows without the drawn box (on read from the ring)', '  .markers-sheet .layer-toggles .chip[aria-pressed="true"]::after { background: var(--action); border-color: var(--action); }\n', ''],
    ['phone', 'Max and Min labels unclamped', '      const cx = Math.min(Math.max(px, a.left + w / 2 + 2), a.right - w / 2 - 2);\n      let cy = below ? py + gap + h / 2 : py - gap - h / 2;\n      if (cy - h / 2 < a.top + 2) cy = py + gap + h / 2;\n      if (cy + h / 2 > a.bottom - 2) cy = py - gap - h / 2;\n', '      const cx = px;\n      const cy = below ? py + gap + h / 2 : py - gap - h / 2;\n'],
    ['laptop', 'Max label unclamped', "        place: labelInPlot(s.hrMax.t, s.hrMax.v, `Max ${s.hrMax.v}`, false) },", '        place: () => ({ dx: 0, dy: -4 }) },'],
    ['laptop', 'panel content sizes the row (empty band)', '  .session-layout > .session-sidebar { contain: size; }\n', ''],
    ['laptop', 'chips auto-fill (11 plus 1)', '  .layer-toggles { --lc: 2; grid-template-columns: repeat(var(--lc), minmax(0, 1fr));', '  .layer-toggles { --lc: 2; grid-template-columns: repeat(auto-fill, minmax(10em, 1fr));'],
    ['laptop', 'hover line frozen at the pinned mark', '      const t = hov ? chart.data.datasets[hov.datasetIndex].data[hov.index].x : chart.$hlT;', '      const t = chart.$hlT;'],
    ['laptop', 'tooltip title in duration form', "              title: (items) => items.length ? makeTimeTickFormatter(sessionStartEpochMs)(items[0].parsed.x) : '',", "              title: (items) => items.length ? formatDuration(items[0].parsed.x) : '',"],
  ];
  // --only <n,n> runs those layout mutants by index (the whole set runs past one 170 s run).
  const only = argVal('--only') ? argVal('--only').split(',').map(Number) : null;
  for (const [sub, name, a, b] of L_MUTANTS.filter((m, i) => !only || only.includes(i))) {
    if (!real.includes(a)) { ok(false, `layout mutant ${name}: anchor missing`); continue; }
    const m = await serve(real.replace(a, b));
    const rows = await runLayout(sub, m.base);
    m.server.close();
    const failed = rows.filter((r) => !r[0]);
    ok(failed.length > 0, `LAYOUT MUTANT ${sub}: ${name}: ` + (failed.length ? 'FAILED as required (' + failed.map((r) => r[1].slice(0, 70)).join(' | ') + ')' : 'NOT CAUGHT'));
  }
}

// S10b shots on the fixture day: panel, selected mark, sleep mark, editors, confirm, Undo, phone sheet.
if (SHOTS && want('marks-shots')) {
  const mshot = async (name, w, scale, setup, full = false) => {
    const { ctx, page } = await openFixture(cur.base, w, scale);
    if (setup) await setup(page);
    await page.scaleText();
    await page.waitForTimeout(500);
    await page.screenshot({ path: path.join(SHOTS, name + '.png'), fullPage: full });
    if (page.errors.length) console.log('page errors in shot ' + name + ': ' + page.errors.join(' | '));
    await ctx.close();
  };
  const toChart = async (p) => { await p.evaluate(() => document.getElementById('session-layout').scrollIntoView()); };
  const pick = (label, type = 'event') => async (p) => { await toChart(p); await rowOf(p, label, type).locator('.mk-go').click(); await p.waitForTimeout(700); await p.mouse.move(2, 2); };
  const editOf = (label) => async (p) => { await toChart(p); await rowOf(p, label).locator('.mk-edit').click(); await p.waitForTimeout(300); };
  const sleepEdit = async (p) => { await toChart(p); await p.locator('#marker-list .marker-item.type-sleep.mine .mk-edit').first().click(); await p.waitForTimeout(300); };
  const sheet = async (p) => { await toChart(p); await p.click('#markers-open'); await p.waitForTimeout(400); };
  await mshot('marks-1440-panel', 1440, 1, toChart);
  await mshot('marks-1440-selected', 1440, 1, pick('Dizzy'));
  await mshot('marks-1440-sleep', 1440, 1, async (p) => { await toChart(p); await p.locator('#marker-list .marker-item.type-sleep.mine .mk-go').first().click(); await p.waitForTimeout(700); await p.mouse.move(2, 2); });
  await mshot('marks-1440-edit', 1440, 1, editOf('Dizzy'));
  await mshot('marks-1440-sleep-edit', 1440, 1, sleepEdit);
  await mshot('marks-1440-add-sleep', 1440, 1, async (p) => { await toChart(p); await p.click('#add-sleep'); await p.waitForTimeout(300); });
  await mshot('marks-1440-delete-confirm', 1440, 1, async (p) => { await editOf('Lunch')(p); await p.click('.mark-editor [data-act="delete"]'); await p.waitForTimeout(300); });
  await mshot('marks-1440-undo', 1440, 1, async (p) => { await editOf('Lunch')(p); await p.click('.mark-editor [data-act="delete"]'); await p.click('.mark-editor .confirm .btn.danger'); await p.waitForTimeout(1200); });
  await mshot('marks-360', 360, 1, toChart);
  await mshot('marks-360-sheet', 360, 1, sheet);
  await mshot('marks-360-sheet-edit', 360, 1, async (p) => { await sheet(p); await p.locator('.markers-sheet .marker-item.type-event .mk-edit').first().click(); await p.waitForTimeout(300); });
  await mshot('marks-360-sheet-sleep-edit', 360, 1, async (p) => { await sheet(p); await p.locator('.markers-sheet .marker-item.type-sleep.mine .mk-edit').first().click(); await p.waitForTimeout(300); });
  await mshot('marks-360-sheet-delete-confirm', 360, 1, async (p) => { await sheet(p); await p.locator('.markers-sheet .marker-item.type-event .mk-edit').first().click(); await p.click('.mark-editor [data-act="delete"]'); await p.waitForTimeout(300); });
  await mshot('marks-360-selected', 360, 1, async (p) => { await sheet(p); await p.locator('.markers-sheet .marker-item.type-event .mk-go').nth(1).click(); await p.waitForTimeout(800); });
  await mshot('marks-360-text200', 360, 2, toChart);
  await mshot('marks-360-text200-sheet', 360, 2, sheet);
  await mshot('marks-360-text200-sheet-edit', 360, 2, async (p) => { await sheet(p); await p.locator('.markers-sheet .marker-item.type-event .mk-edit').first().click(); await p.waitForTimeout(300); });
  console.log('marks shots in ' + SHOTS);
}

// ---- Shots ----
if (SHOTS && want('day-shots')) {
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
