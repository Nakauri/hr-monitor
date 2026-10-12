// Guards: v2 day Duration reading 0:00 (S10a), stats drifting from f7cbb1a, mark edits writing twice (S10b HIGH). Files: hrv_viewer.html Day view. Runtime: about 50 s per --part; run when hrv_viewer.html changes.
// S10a Day explorer checks, headless.
// 1. Stats parity: the stats bar on a real legacy day and a real v2 day equals the pre-step build
//    (--ref, default f7cbb1a, read through `git show`, opened at its old #/session/day: route).
// 2. Layer chips: each available chip changes its dataset or overlay count, and a second click restores it.
// 3. Structure: Day route renders the explorer; gaps note only with gaps; 44 px day arrows; no uppercase
//    micro-labels; a marker click zooms; a single recording still opens its explorer; no page errors.
// 4. Phone: no horizontal scroll, 44 px controls, at 360 and 360 with 200% text.
// 5. Marks (S10b), on a seeded fixture day that also gives Marks, Warnings, Palps, Posture and Sleep data, so
//    the chip loop exercises all 12 chips: diamonds; a marker click eases to its window within 1 px and
//    highlights it; edit, delete then Undo for a viewer tap, a recorded mark and a sleep mark; Add sleep;
//    the phone sheet. Each mutant of the viewer must FAIL its sub-check.
// --shots <dir> shoots Day at 1440, 360 and 360 with 200% text, zoomed, a marker selected, layers toggled,
// a single recording, and the S10b panel, sheet, sleep mark, edit and delete states.
// --part parity,chips,phone,marks,mutants,day-shots,marks-shots runs those parts only (default: all).
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
    c[3] = (32 + 6 * Math.cos(i / 400)).toFixed(2);
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
async function openFixture(base, width = 1440, scale = 1) {
  const { ctx, page } = await newPage(width, scale);
  await seedFixture(page, base);
  await page.goto(base + '/hrv_viewer.html#/day/' + FX_DAY, { waitUntil: 'networkidle' });
  await waitExplorer(page, '#view-day #session-chart');
  await page.waitForFunction(() => window.AortiMarksPage && window.AortiMarksPage.store, null, { timeout: 15000 }).catch(() => {});
  await page.waitForSelector('#markers-actions:not([hidden])', { state: 'attached', timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(400);
  await page.scaleText();
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
  const an = Object.keys((c.options.plugins.annotation || {}).annotations || {}).length;
  return `${ds}|ov${ov}|an${an}`;
});
const covered = new Set(), seen = new Set();
if (want('chips')) {
  const { ctx, page } = await newPage(1440);
  await seedFixture(page, cur.base);
  for (const iso of DEMO_DAYS.concat(FX_DAY)) {
    await page.goto(cur.base + '/hrv_viewer.html' + (iso === FX_DAY ? '' : '?demo=1') + '#/day/' + iso, { waitUntil: 'networkidle' });
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
      const ann = Object.entries(c.options.plugins.annotation.annotations);
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
    const { ctx, page } = await openFixture(base, width);
    const rows = [];
    const dur = await fullDur(page);
    if (width < 600) {
      const before = await page.evaluate(() => ({ btn: !!document.getElementById('markers-open').offsetParent, side: !!document.querySelector('#session-layout > .session-sidebar').offsetParent }));
      rows.push([before.btn && !before.side, `360: Markers button shows and the inline panel is hidden (${JSON.stringify(before)})`]);
      await tap(page, '#markers-open');
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
      await tap(page, '#markers-open'); await settle(page, 300);
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

  // A viewer tap: edit, delete (Cancel keeps it), delete then Undo.
  async tap(base) {
    const { ctx, page } = await openFixture(base);
    const rows = [];
    await tap(page, '#layer-chips .chip[data-layer="warning"]');
    await rowOf(page, 'Nausea').locator('.mk-edit').click({ timeout: 4000 }).catch(() => {});
    await fillSoft(page, '#mk-label', 'Nausea bad');
    await tap(page, '.mark-editor [data-cls="note"]');
    await tap(page, '.mark-editor [data-act="save"]'); await settle(page, 1200);
    let L = await evLabels(page), r = await storeGet(page, FX_TAP);
    rows.push([L.includes('Nausea bad') && !L.includes('Nausea') && r && !r.deleted && r.label === 'Nausea bad' && r.cls === 'note' && r.at === FX_MIN(40), `viewer tap edit: list ${JSON.stringify(L)}, record ${r && r.cls + ' ' + r.label}`]);
    const warnChip = await page.getAttribute('#layer-chips .chip[data-layer="warning"]', 'aria-pressed').catch(() => null);
    rows.push([warnChip === 'false', `a save keeps the layer choices (Warnings chip pressed ${warnChip})`]);
    await tap(page, '#layer-chips .chip[data-layer="warning"]');
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
    const { ctx, page } = await openFixture(base);
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
    const { ctx, page } = await openFixture(base);
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
    await tap(page, '#markers-open'); await settle(page, 300);
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
  for (const name of ['diamonds', 'focus', 'tap', 'recorded', 'sleep', 'phone']) report5(await runSub(name, cur.base));
}
if (want('mutants')) {
  const real = fs.readFileSync(path.join(ROOT, 'hrv_viewer.html'), 'utf8').replace(/\r\n/g, '\n');
  const MUTANTS = [
    ['diamonds', 'no diamond handles', "          annotations['mk_' + idCounter++] = handle;", "          void handle;"],
    ['focus', 'marker click jumps with the old zoom, no highlight', '    easeBrushTo(lo, hi, () => { if (pinnedMarkT === item.t) highlightAtTime(item.t); });', '    zoomTo(item.t);'],
    ['focus', 'marker click without the highlight', '    pinnedMarkT = item.t;\n    if (fromSheet) {', '    if (fromSheet) {'],
    ['tap', 'delete skips the confirm', "    if (!ok) return;\n    const id = item.edit.markId;", "    const id = item.edit.markId;"],
    ['tap', 'a save resets the layers', '    if (priorFilters) for (const k of Object.keys(activeFilters))', '    if (false) for (const k of Object.keys(activeFilters))'],
    ['tap', 'Undo does nothing', '      undo: () => marksWrite(() => id ? store.restore(id) : store.unreverse(row)),', '      undo: () => {},'],
    ['recorded', 'a recorded edit adds a tap without hiding the row', "store.editRecorded({ ep: item.edit.ep, label: raw }, patch)", 'store.createTap(patch)'],
    ['recorded', 'Undo of a recorded delete restores nothing', '      undo: () => marksWrite(() => id ? store.restore(id) : store.unreverse(row)),', '      undo: () => marksWrite(() => id ? store.restore(id) : Promise.resolve()),'],
    ['sleep', 'Save has no busy guard', "      if (box.dataset.busy) return false;\n      box.dataset.busy = '1';\n      box.querySelectorAll('button').forEach(b => { b.disabled = true; });\n", ''],
    ['recorded', 'Save with nothing changed still writes', "      if (cls === cls0 && text === (label || '').trim() && timeInput.value === timeInput.defaultValue) { closeEditor(box); return; }\n", ''],
    ['sleep', 'a sleep edit keeps the old window', '    marksWrite(() => rec ? store.edit(rec.id, { from: a, to: b }) : store.createSleep({ from: a, to: b }), box);', '    marksWrite(() => rec ? store.edit(rec.id, {}) : store.createSleep({ from: a, to: b }), box);'],
    ['phone', 'no markers sheet', "    if (!sb || (markersSheet && !markersSheet.closed)) return;", "    return;"],
  ];
  for (const [sub, name, a, b] of MUTANTS) {
    if (!real.includes(a)) { ok(false, `mutant ${name}: anchor missing`); continue; }
    const m = await serve(real.replace(a, b));
    const rows = await runSub(sub, m.base);
    m.server.close();
    const failed = rows.filter((r) => !r[0]);
    ok(failed.length > 0, `MUTANT ${sub}: ${name}: ` + (failed.length ? 'FAILED as required (' + failed.map((r) => r[1].slice(0, 70)).join(' | ') + ')' : 'NOT CAUGHT'));
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
