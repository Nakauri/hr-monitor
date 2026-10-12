// Guards: Day carets moving with the weekday's length, three nav designs, no jump calendar, and the KPI strip's 24:00:00 running into Avg HR (AUDIT-NOTES 2026-10-12 items 20 to 22). Files: hrv_viewer.html date nav, jump picker, summary grid. Runtime: about 60 s, --mutants about 90 s; run when hrv_viewer.html changes.
// S30 date nav checks, on demo data (?demo=1), headless:
// carets: the prev and next carets sit at the same x on Day (longest and shortest weekday, with and without data),
//   Week and Month (shortest and longest month name), at 360, 360 with 200% text and 1440.
// picker: the title opens the jump calendar by a real click (popover under the title at 1440, bottom sheet at 360);
//   days with data, today and the shown day are marked; picking a day with data and one without routes there; the
//   keyboard path (Enter, arrows, Page Down, Escape, Enter) moves, closes back to the title and picks.
// week: the Week picker marks the shown week and picking a day opens the week holding it.
// month: the Month title opens a 12-month grid with year carets; a click and the keyboard pick a month.
// kpi: with Duration forced to 24:00:00, every pair of stats on a row is one gap token apart (within 2 px), no value
//   leaves its column, values use tabular figures; at 1440, 360 (open and collapsed) and 360 with 200% text.
// --mutants: a title-sized caret track, the KPI gap removed, the KPI fit removed and a calendar that never opens each
//   must FAIL their part. --shots <dir> shoots the headers, the picker and the KPI strip.
// Usage: node scripts/date-nav.mjs [--part carets,picker,week,month,kpi] [--mutants] [--shots <dir>] [--ux <ux-audit dir>]
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
const SHOTS = argVal('--shots');
const CHART = path.join(UX, '..', 'docs', 'audit-2026-10-09', 'harness-DT', 'vendor', 'chart.umd.min.js');
const { chromium } = createRequire(path.join(UX, 'kit', 'package.json'))('playwright');
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
const PARTS = ['carets', 'picker', 'week', 'month', 'kpi'];
const PART = argVal('--part');
const want = (p) => !PART || PART.split(',').includes(p);
const MUTANTS = args.includes('--mutants');

let MUTATE = null;
let anchorMissing = false;
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png', '.woff2': 'font/woff2', '.csv': 'text/csv' };
const server = http.createServer((req, res) => {
  const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const file = path.join(ROOT, rel);
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end(); return; }
  let body = fs.readFileSync(file);
  if (MUTATE && rel === '/hrv_viewer.html') {
    const text = body.toString('utf8').replace(/\r\n/g, '\n');
    if (!text.includes(MUTATE[0])) { anchorMissing = true; console.log('MUTANT ANCHOR MISSING: ' + MUTATE[0].slice(0, 70)); }
    body = text.replace(MUTATE[0], MUTATE[1]);
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  res.end(body);
});
await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
const BASE = `http://127.0.0.1:${server.address().port}`;

let fails = 0, passes = 0;
const ok = (cond, msg, detail) => { if (cond) { passes++; console.log('PASS ' + msg); } else { fails++; console.log('FAIL ' + msg + (detail ? ' :: ' + detail : '')); } };

let browser;
try { browser = await chromium.launch(); } catch (e) { browser = await chromium.launch({ channel: 'chrome' }); }
async function open(width, hash, textScale = 1) {
  const phone = width < 600;
  const ctx = await browser.newContext({ viewport: { width, height: phone ? 740 : 900 }, deviceScaleFactor: 1, isMobile: phone, hasTouch: phone, timezoneId: 'America/Edmonton' });
  await ctx.route('**/*', (route) => {
    const u = route.request().url();
    if (u.startsWith(BASE) || u.startsWith('data:') || u.startsWith('blob:')) return route.continue();
    if (/chart\.umd(\.min)?\.js/.test(u)) return route.fulfill({ status: 200, contentType: 'text/javascript', body: fs.readFileSync(CHART) });
    if (/fonts\.(googleapis|gstatic)\.com|cdn\.jsdelivr\.net|cdnjs\.cloudflare\.com/.test(u)) return route.continue();
    return route.fulfill({ status: 204, body: '' });
  });
  const page = await ctx.newPage();
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(e.message));
  await page.goto(`${BASE}/hrv_viewer.html?demo=1${hash}`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.datenav', { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(400);
  if (textScale !== 1) {
    await page.evaluate((f) => {
      const els = [...document.querySelectorAll('body, body *')].filter((e) => !e.dataset.uxFs && !(e instanceof SVGElement));
      const sizes = els.map((e) => parseFloat(getComputedStyle(e).fontSize));
      els.forEach((e, i) => { e.dataset.uxFs = String(sizes[i]); e.style.setProperty('font-size', sizes[i] * f + 'px', 'important'); });
      window.dispatchEvent(new Event('resize'));
    }, textScale);
    await page.waitForTimeout(250);
  }
  return { ctx, page };
}
async function go(page, hash, sel) {
  await page.evaluate((h) => { location.hash = h; }, hash);
  await page.waitForFunction((s) => { const e = document.querySelector(s); return e && e.getBoundingClientRect().width > 0; }, sel, { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(300);
}
const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `s30-${name}.png`) }); };
const hashOf = (page) => page.evaluate(() => location.hash);
const active = (page) => page.evaluate(() => { const a = document.activeElement; return a ? (a.id || a.dataset.key || a.className) : ''; });

// ---- carets: one x for prev and one for next across views and title lengths ----
const CARET_ROUTES = [
  ['day', '#/day/2026-09-30', 'Wednesday, no data'], ['day', '#/day/2026-04-22', 'Wednesday'], ['day', '#/day/2026-04-24', 'Friday'],
  ['day', '#/day/2026-05-01', 'Friday, no data'], ['week', '#/week/2026-04-22', 'week'], ['week', '#/week/2026-09-30', 'week across months'],
  ['month', '#/month/2026-05', 'May'], ['month', '#/month/2026-09', 'September'],
];
async function partCarets() {
  for (const [w, scale] of [[1440, 1], [360, 1], [360, 2]]) {
    const { ctx, page } = await open(w, '#/day/2026-04-22', scale);
    const xs = [];
    for (const [view, hash, label] of CARET_ROUTES) {
      await go(page, hash, `#${view}-pick`);
      if (scale !== 1) await page.evaluate((f) => {
        const els = [...document.querySelectorAll('.datenav, .datenav *')].filter((e) => !e.dataset.uxFs && !(e instanceof SVGElement));
        const sizes = els.map((e) => parseFloat(getComputedStyle(e).fontSize));
        els.forEach((e, i) => { e.dataset.uxFs = String(sizes[i]); e.style.setProperty('font-size', sizes[i] * f + 'px', 'important'); });
      }, scale);
      const r = await page.evaluate((v) => ['prev', 'next', 'pick'].map((k) => { const b = document.getElementById(v + '-' + k).getBoundingClientRect(); return [b.left, b.width, b.height]; }), view);
      xs.push({ label, view, prev: r[0][0], next: r[1][0], sizes: [r[0][1], r[0][2], r[1][1], r[1][2]], pickH: r[2][2] });
      if (SHOTS && scale === 1 && /^(Wednesday|week|September)$/.test(label)) await shot(page, `${view}-header-${w}`);
      if (SHOTS && scale === 2 && label === 'Wednesday') await shot(page, `day-header-360-200`);
    }
    const tag = `${w}${scale !== 1 ? ' at 200% text' : ''}`;
    const spread = (k) => Math.max(...xs.map((x) => x[k])) - Math.min(...xs.map((x) => x[k]));
    ok(spread('prev') <= 0.5, `${tag}: the prev caret sits at one x on Day, Week and Month (spread ${spread('prev').toFixed(1)} px)`, xs.map((x) => `${x.label} ${x.prev.toFixed(1)}`).join(', '));
    ok(spread('next') <= 0.5, `${tag}: the next caret sits at one x on Day, Week and Month (spread ${spread('next').toFixed(1)} px)`, xs.map((x) => `${x.label} ${x.next.toFixed(1)}`).join(', '));
    ok(xs.every((x) => x.sizes.every((v) => v >= 44) && x.pickH >= 44), `${tag}: carets and the title are 44 px targets`);
    ok(!page.errors.length, `${tag}: no page errors`, page.errors.join(' | '));
    await ctx.close();
  }
}

// ---- picker: Day ----
async function partPicker() {
  {
    const { ctx, page } = await open(1440, '#/day/2026-04-22');
    await page.click('#day-pick');
    await page.waitForSelector('.date-pop .dp-grid', { timeout: 3000 }).catch(() => {});
    const st = await page.evaluate(() => {
      const pop = document.querySelector('.date-pop .sheet');
      if (!pop) return null;
      const t = document.getElementById('day-pick').getBoundingClientRect(), p = pop.getBoundingClientRect();
      const keys = (sel) => [...pop.querySelectorAll(sel)].map((c) => c.dataset.key);
      return { below: p.top >= t.bottom - 1, label: pop.querySelector('.dp-label').textContent, has: keys('.dp-cell.has'), shown: keys('.dp-cell.shown'), focus: document.activeElement.dataset.key, cell: [...pop.querySelectorAll('button.dp-cell')].map((c) => c.getBoundingClientRect()).every((r) => r.width >= 44 && r.height >= 44) };
    });
    ok(!!st, '1440: a click on the Day title opens the jump calendar as a popover');
    if (!st) { await ctx.close(); return; }
    {
      ok(st.below && st.label === 'April 2026', '1440: the popover sits under the title on the shown month', `${st.label} below ${st.below}`);
      ok(st.has.join() === ['20', '21', '22', '23', '24', '25', '26'].map((d) => '2026-04-' + d).join(), '1440: the 7 days with data are marked', st.has.join());
      ok(st.shown.join() === '2026-04-22' && st.focus === '2026-04-22', '1440: the shown day is marked and focused', st.shown.join() + ' focus ' + st.focus);
      ok(st.cell, '1440: every day is a 44 px target');
    }
    await shot(page, 'picker-day-1440');
    // Today: turn to the month holding today.
    const todayKey = await page.evaluate(() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; });
    const months = (+todayKey.slice(0, 4) - 2026) * 12 + (+todayKey.slice(5, 7) - 4);
    for (let i = 0; i < Math.abs(months); i++) await page.click(`.dp-step[data-step="${months > 0 ? 1 : -1}"]`);
    const today = await page.evaluate(() => [...document.querySelectorAll('.dp-cell.today')].map((c) => c.dataset.key));
    ok(today.join() === todayKey, 'today is marked', today.join() + ' vs ' + todayKey);
    await page.keyboard.press('Escape');
    // Pick a day with data.
    await page.click('#day-pick');
    await page.click('.dp-cell[data-key="2026-04-24"]');
    await page.waitForTimeout(500);
    ok((await hashOf(page)) === '#/day/2026-04-24' && !(await page.$('.date-pick')), 'picking a day with data routes to it and closes', await hashOf(page));
    ok((await active(page)) === 'day-pick', 'focus is back on the title after a pick', await active(page));
    // Pick a day without data, in the month before.
    await page.click('#day-pick');
    await page.click('.dp-step[data-step="-1"]');
    await page.click('.dp-cell[data-key="2026-03-10"]');
    await page.waitForTimeout(500);
    const empty = await page.evaluate(() => document.querySelector('#view-day .stub-panel') && document.querySelector('#view-day .stub-panel').textContent);
    ok((await hashOf(page)) === '#/day/2026-03-10' && /No recordings/.test(empty || ''), 'picking a day without data routes to it', await hashOf(page));
    // Keyboard path.
    await go(page, '#/day/2026-04-22', '#day-pick');
    await page.focus('#day-pick');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(150);
    ok((await active(page)) === '2026-04-22', 'Enter on the title opens the calendar on the shown day', await active(page));
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowDown');
    ok((await active(page)) === '2026-04-30', 'arrows move by a day and a week', await active(page));
    await page.keyboard.press('ArrowRight');
    ok((await active(page)) === '2026-05-01' && (await page.textContent('.dp-label')) === 'May 2026', 'an arrow past the month turns the page', await active(page));
    await page.keyboard.press('PageUp');
    ok((await active(page)) === '2026-04-01', 'Page Up turns back a month', await active(page));
    await page.keyboard.press('Escape');
    await page.waitForTimeout(150);
    ok(!(await page.$('.date-pick')) && (await active(page)) === 'day-pick' && (await hashOf(page)) === '#/day/2026-04-22', 'Escape closes, focus back on the title, the day unchanged', `${await active(page)} ${await hashOf(page)}`);
    await page.keyboard.press('Enter');
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(500);
    ok((await hashOf(page)) === '#/day/2026-04-21' && (await active(page)) === 'day-pick', 'arrow then Enter picks that day, focus on the new title', `${await hashOf(page)} ${await active(page)}`);
    ok(!page.errors.length, 'picker 1440: no page errors', page.errors.join(' | '));
    await ctx.close();
  }
  {
    const { ctx, page } = await open(360, '#/day/2026-04-22');
    await page.click('#day-pick');
    await page.waitForSelector('.date-pick .dp-grid', { timeout: 3000 }).catch(() => {});
    const st = await page.evaluate(() => {
      const root = document.querySelector('.date-pick');
      if (!root) return null;
      const p = root.querySelector('.sheet').getBoundingClientRect();
      return { pop: root.classList.contains('date-pop'), bottom: Math.round(p.bottom), width: Math.round(p.width), title: root.querySelector('.sheet-head h2').textContent, cells: [...root.querySelectorAll('button.dp-cell')].every((c) => { const r = c.getBoundingClientRect(); return r.width >= 44 && r.height >= 44; }), scroll: document.documentElement.scrollWidth <= window.innerWidth };
    });
    ok(st && !st.pop && st.bottom === 740 && st.width === 360, '360: the title opens a bottom sheet', JSON.stringify(st));
    ok(st && st.cells && st.scroll, '360: 44 px days, no sideways scroll');
    await shot(page, 'picker-day-360');
    await page.click('.dp-cell[data-key="2026-04-25"]');
    await page.waitForTimeout(500);
    ok((await hashOf(page)) === '#/day/2026-04-25' && !(await page.$('.date-pick')), '360: a tap on a day routes and closes the sheet', await hashOf(page));
    ok(!page.errors.length, 'picker 360: no page errors', page.errors.join(' | '));
    await ctx.close();
  }
}

// ---- week ----
async function partWeek() {
  const { ctx, page } = await open(1440, '#/week/2026-04-22');
  ok((await page.textContent('#week-pick')).trim() === 'Apr 19 to 25, 2026', 'the Week title reads Apr 19 to 25, 2026', await page.textContent('#week-pick'));
  await page.click('#week-pick');
  await page.waitForSelector('.date-pop .dp-grid', { timeout: 3000 }).catch(() => {});
  const inweek = await page.evaluate(() => [...document.querySelectorAll('.dp-cell.inweek')].map((c) => c.dataset.key.slice(8)).join());
  ok(inweek === '19,20,21,22,23,24,25', 'the Week picker marks the shown week', inweek);
  await shot(page, 'picker-week-1440');
  await page.click('.dp-cell[data-key="2026-04-08"]');
  await page.waitForTimeout(500);
  ok((await hashOf(page)) === '#/week/2026-04-08' && (await page.textContent('#week-pick')).trim() === 'Apr 5 to 11, 2026', 'picking a day opens the week holding it', `${await hashOf(page)} ${await page.textContent('#week-pick')}`);
  await go(page, '#/week/2026-09-30', '#week-pick');
  ok((await page.textContent('#week-pick')).trim() === 'Sep 27 to Oct 3, 2026', 'a week across months names both', await page.textContent('#week-pick'));
  ok(!page.errors.length, 'week: no page errors', page.errors.join(' | '));
  await ctx.close();
}

// ---- month ----
async function partMonth() {
  const { ctx, page } = await open(1440, '#/month/2026-04');
  await page.click('#month-pick');
  await page.waitForSelector('.date-pop .dp-months', { timeout: 3000 }).catch(() => {});
  const st = await page.evaluate(() => ({ n: document.querySelectorAll('.dp-months button.dp-cell').length, label: (document.querySelector('.dp-label') || {}).textContent, has: [...document.querySelectorAll('.dp-cell.has')].map((c) => c.dataset.key).join(), shown: [...document.querySelectorAll('.dp-cell.shown')].map((c) => c.dataset.key).join() }));
  ok(st.n === 12 && st.label === '2026', 'the Month title opens a 12-month grid for the year', JSON.stringify(st));
  ok(st.has === '2026-04' && st.shown === '2026-04', 'months with data and the shown month are marked', JSON.stringify(st));
  await shot(page, 'picker-month-1440');
  await page.click('.dp-step[data-step="1"]');
  const y1 = await page.textContent('.dp-label');
  await page.click('.dp-step[data-step="-1"]');
  ok(y1 === '2027' && (await page.textContent('.dp-label')) === '2026', 'the year carets turn the year');
  await page.click('.dp-cell[data-key="2026-09"]');
  await page.waitForTimeout(400);
  ok((await hashOf(page)) === '#/month/2026-09' && (await page.textContent('#month-pick .t-long')).trim() === 'September 2026', 'a click on a month opens it', await hashOf(page));
  await page.focus('#month-pick');
  await page.keyboard.press('Enter');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(400);
  ok((await hashOf(page)) === '#/month/2026-12' && (await active(page)) === 'month-pick', 'the keyboard picks a month a row down, focus on the title', `${await hashOf(page)} ${await active(page)}`);
  ok(!page.errors.length, 'month: no page errors', page.errors.join(' | '));
  await ctx.close();
}

// ---- kpi ----
async function partKpi() {
  for (const [w, scale, collapsed] of [[1440, 1, false], [360, 1, false], [360, 1, true], [360, 2, false]]) {
    const { ctx, page } = await open(w, '#/day/2026-04-21', 1);
    await page.waitForSelector('#summary-bar .summary-stat', { timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(600);
    await page.evaluate((c) => { const b = document.getElementById('summary-bar'); if (b) b.classList.toggle('collapsed', c); }, collapsed);
    if (scale !== 1) await page.evaluate((f) => {
      const els = [...document.querySelectorAll('#summary-bar, #summary-bar *')].filter((e) => !(e instanceof SVGElement));
      const sizes = els.map((e) => parseFloat(getComputedStyle(e).fontSize));
      els.forEach((e, i) => e.style.setProperty('font-size', sizes[i] * f + 'px', 'important'));
    }, scale);
    await page.evaluate(() => {
      const v = document.querySelector('#summary-bar [data-stat="duration"] .summary-stat-value');
      if (v) v.textContent = '24:00:00';
      window.dispatchEvent(new Event('resize'));
    });
    await page.waitForTimeout(200);
    const r = await page.evaluate(() => {
      const grid = document.querySelector('#summary-bar .summary-grid');
      if (!grid) return null;
      const token = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--s5'));
      const stats = [...grid.children].filter((e) => e.offsetParent !== null).map((e) => {
        const b = e.getBoundingClientRect();
        const kids = [...e.children].filter((k) => k.offsetParent !== null).map((k) => { const rg = document.createRange(); rg.selectNodeContents(k); const t = rg.getBoundingClientRect(); return { right: t.right, w: t.width }; });
        const v = e.querySelector('.summary-stat-value');
        return { key: e.dataset.stat, left: b.left, right: b.right, top: Math.round(b.top), inside: kids.every((k) => k.right <= b.right + 0.5), tab: v ? getComputedStyle(v).fontVariantNumeric.includes('tabular-nums') : true, vright: v ? (() => { const rg = document.createRange(); rg.selectNodeContents(v); return rg.getBoundingClientRect().right; })() : b.right };
      });
      const gaps = [], overlaps = [];
      for (let i = 1; i < stats.length; i++) {
        if (stats[i].top !== stats[i - 1].top) continue;
        gaps.push({ pair: stats[i - 1].key + '|' + stats[i].key, gap: stats[i].left - stats[i - 1].right });
        overlaps.push(stats[i].left - stats[i - 1].vright);
      }
      return { token, n: stats.length, gaps, minClear: overlaps.length ? Math.min(...overlaps) : null, outside: stats.filter((s) => !s.inside).map((s) => s.key), tab: stats.every((s) => s.tab), scroll: document.documentElement.scrollWidth <= window.innerWidth };
    });
    const tag = `${w}${scale !== 1 ? ' at 200% text' : ''}${collapsed ? ' collapsed' : ''}`;
    if (!r) { ok(false, `${tag}: the KPI strip renders`); await ctx.close(); continue; }
    const bad = r.gaps.filter((g) => Math.abs(g.gap - r.token) > 2);
    ok(r.n > 0 && !bad.length, `${tag}: ${r.gaps.length ? r.gaps.length + ' stat pairs, each ' + r.token + ' px apart within 2 px' : r.n + ' stats in one column'}`, bad.map((g) => `${g.pair} ${g.gap.toFixed(1)}`).join(', '));
    ok(!r.outside.length && (r.minClear == null || r.minClear >= r.token - 2), `${tag}: 24:00:00 and every other value stay inside their column (closest ${r.minClear == null ? 'n/a' : r.minClear.toFixed(1)} px)`, r.outside.join(', '));
    ok(r.tab && r.scroll, `${tag}: tabular figures, no sideways scroll`);
    if (SHOTS && w === 360 && scale === 1 && !collapsed) await page.locator('#summary-bar').screenshot({ path: path.join(SHOTS, 's30-kpi-360.png') });
    if (SHOTS && w === 360 && scale === 2) await page.locator('#summary-bar').screenshot({ path: path.join(SHOTS, 's30-kpi-360-200.png') });
    if (SHOTS && w === 1440) await page.locator('#summary-bar').screenshot({ path: path.join(SHOTS, 's30-kpi-1440.png') });
    ok(!page.errors.length, `${tag}: no page errors`, page.errors.join(' | '));
    await ctx.close();
  }
}

const RUN = { carets: partCarets, picker: partPicker, week: partWeek, month: partMonth, kpi: partKpi };
if (MUTANTS) {
  const M = [
    ['title-sized caret track', 'carets', ['.datenav-h { flex: 0 0 auto; width: 16.5em;', '.datenav-h { flex: 0 0 auto; width: auto;']],
    ['KPI gap removed', 'kpi', ['gap: var(--s4) var(--kpi-gap);', 'gap: var(--s4) 0;']],
    ['KPI fit removed', 'kpi', ["if (w) grid.style.setProperty('--kpi-col'", "if (false) grid.style.setProperty('--kpi-col'"]],
    ['calendar never opens', 'picker', ["g('-pick').addEventListener('click',", "g('-pick').addEventListener('dblclick',"]],
  ];
  const results = [];
  for (const [name, part, swap] of M) {
    MUTATE = swap; anchorMissing = false;
    const before = fails;
    console.log(`-- mutant: ${name} (part ${part})`);
    try { await RUN[part](); } catch (e) { fails++; console.log('FAIL ' + part + ' threw: ' + String(e.message).split(String.fromCharCode(10))[0]); }
    results.push([name, !anchorMissing && fails > before]);
  }
  MUTATE = null;
  fails = 0; passes = 0;
  for (const [name, killed] of results) ok(killed, `mutant "${name}" fails its part`);
} else {
  for (const p of PARTS) if (want(p)) { console.log(`-- ${p}`); await RUN[p](); }
}
await browser.close();
server.close();
console.log(`\n${passes} passed, ${fails} failed`);
process.exit(fails ? 1 : 0);
