// Guards: dead hash routes, the select changing width per view and dropping Share (2026-10-11), the cloud spinning on every open (2026-10-11). Files: hrv_viewer.html bar and controls. Runtime: base about 55 s, --part s23 about 120 s; run by part.
// S8 viewer bar and navigation checks, on demo data (?demo=1), headless:
// every old hash route resolves; the viewer opens on the latest day; day arrows and arrow keys skip
// days without data; the Week tab opens the week holding the shown day; every bar control is wired
// (tabs, view select, Drive cloud, gear, Share). S22: the syncing state shows the full-size sync icon
// ("Syncing" beside it at 1440), its 3 px bar sits under the app bar clear of the view select, the
// phone select is 44 px with a 12 px gap after the wordmark, and the gear popover's buttons are 44 px.
// S23: every visible select, button and input on Month, Week, Day, Sessions, Trends, their menus and popovers,
// and the empty state carries a shared class inside .ui (360 and 1440); the bar's view select is one width on
// all five views; Share is in the bar on all five; the gear and threshold popovers give Cancel and Save one
// width with Reset leading the row; the Drive cloud shows syncing only when open-time work outlasts 1 s
// (fake Drive answering in 300 ms and in 3 s).
// --shots <dir> also shoots Month, Week, Day, Sessions and Trends at 1440, 360 and 360 with 200% text,
// plus the Drive cloud synced, syncing and off, and the gear popover.
// --part base | s23 | shots runs one half, or only the shots (default both halves); --mutants runs the S23
// negative controls, each must FAIL (--part then picks one group: sweep, bar, actions, cloud).
// Usage: node scripts/viewer-nav.mjs [--part base|s23] [--mutants] [--shots <dir>] [--ux <ux-audit dir>]
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
const { FakeDrive } = createRequire(import.meta.url)('./marks-store.test.cjs');
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
const PART = argVal('--part');
const MUTANTS_ONLY = args.includes('--mutants');
const PARTS = MUTANTS_ONLY ? ['sweep', 'bar', 'actions', 'cloud'] : ['base', 's23', 'shots'];
if (PART && !PARTS.includes(PART)) { console.log('unknown --part ' + PART + ' (one of ' + PARTS.join(', ') + ')'); process.exit(2); }
if (PART === 'shots' && !SHOTS) { console.log('--part shots needs --shots <dir>'); process.exit(2); }
// Served-file overrides for the negative controls: { '/hrv_viewer.html': [find, replace] }.
let MUTATE = {};
let anchorMissing = false;

// Two days without data (04-22, 04-23): the files that start there or run into them are left out.
const GAP_DROP = /2026-04-2(1T21|2T|3T)/;
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png', '.woff2': 'font/woff2', '.csv': 'text/csv' };
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const rel = decodeURIComponent(u.pathname);
  const file = path.join(ROOT, rel);
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end(); return; }
  let body = fs.readFileSync(file);
  if (MUTATE[rel]) {
    const text = body.toString('utf8').replace(/\r\n/g, '\n');
    const [a, b] = MUTATE[rel];
    if (!text.includes(a)) { anchorMissing = true; console.log('MUTANT ANCHOR MISSING ' + rel + ': ' + a.slice(0, 60)); res.writeHead(500); res.end(); return; }
    body = text.replace(a, b);
  }
  if (rel === '/demo/manifest.json' && /gap=1/.test(req.headers.referer || '')) {
    const m = JSON.parse(body); m.files = m.files.filter((f) => !GAP_DROP.test(f)); body = JSON.stringify(m);
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  res.end(body);
});
await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
const BASE = `http://127.0.0.1:${server.address().port}`;

let fails = 0, passes = 0;
const ok = (cond, msg) => { if (cond) { passes++; console.log('PASS ' + msg); } else { fails++; console.log('FAIL ' + msg); } };

let browser;
try { browser = await chromium.launch(); } catch (e) { browser = await chromium.launch({ channel: 'chrome' }); }
// drive: { delay(url) -> ms, log: [] } signs the page in and answers Drive from a fake, each call after delay(url).
async function open(width, query = 'demo=1', hash = '', textScale = 1, drive = null) {
  const phone = width < 600;
  const ctx = await browser.newContext({ viewport: { width, height: phone ? 740 : 900 }, deviceScaleFactor: 1, isMobile: phone, hasTouch: phone });
  await ctx.route('**/*', async (route) => {
    const u = route.request().url();
    if (u.startsWith(BASE) || u.startsWith('data:') || u.startsWith('blob:')) return route.continue();
    if (drive && u.startsWith('https://www.googleapis.com/')) {
      const req = route.request();
      drive.log.push({ at: Date.now(), url: u });
      const d = drive.delay(u);
      if (d) await new Promise((r) => setTimeout(r, d));
      let status = 200, text = '{"files":[]}';
      try {
        const r = await drive.fake.fetch(u, { method: req.method(), headers: req.headers(), body: req.postData() || undefined });
        status = r.status; text = await r.text();
      } catch (e) {}
      drive.log.push({ at: Date.now(), url: u, done: true });
      return route.fulfill({ status, contentType: 'application/json', body: text });
    }
    if (/chart\.umd(\.min)?\.js/.test(u)) return route.fulfill({ status: 200, contentType: 'text/javascript', body: fs.readFileSync(CHART) });
    if (/fonts\.(googleapis|gstatic)\.com|cdn\.jsdelivr\.net|cdnjs\.cloudflare\.com/.test(u)) return route.continue();
    return route.fulfill({ status: 204, body: '' });
  });
  await ctx.addInitScript(() => { window.__prints = 0; window.print = () => { window.__prints++; }; });
  if (drive) await ctx.addInitScript(() => {
    localStorage.setItem('aorti_auth_v2', JSON.stringify({ version: 2, access_token: 'fake', expires_at: Date.now() + 3600000, email: 'a@example.com', scope: 'drive.file', issued_at: Date.now() }));
    // Every change of the bar's syncing class, with its time.
    window.__cloudLog = [];
    document.addEventListener('DOMContentLoaded', () => {
      const bar = document.getElementById('app-bar');
      let was = bar.classList.contains('syncing');
      new MutationObserver(() => {
        const now = bar.classList.contains('syncing');
        if (now !== was) { was = now; window.__cloudLog.push({ at: Date.now(), syncing: now }); }
      }).observe(bar, { attributes: true, attributeFilter: ['class'] });
    });
  });
  const page = await ctx.newPage();
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(e.message));
  await page.goto(`${BASE}/hrv_viewer.html?${query}${hash}`, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => document.querySelector('#view-day .day-title, #view-index .session-card, #view-month .cal-cell, #view-week .week-grid, #view-all .all-card'), null, { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(500);
  if (textScale !== 1) await scaleText(page, textScale);
  return { ctx, page };
}
async function scaleText(page, f) {
  await page.evaluate((f) => {
    const els = [...document.querySelectorAll('body, body *')].filter((e) => !e.dataset.uxFs && !(e instanceof SVGElement));
    const sizes = els.map((e) => parseFloat(getComputedStyle(e).fontSize));
    els.forEach((e, i) => { e.dataset.uxFs = String(sizes[i]); e.style.setProperty('font-size', sizes[i] * f + 'px', 'important'); });
    window.dispatchEvent(new Event('resize'));
  }, f);
  await page.waitForTimeout(200);
}
const hashOf = (page) => page.evaluate(() => location.hash);
const visibleView = (page) => page.evaluate(() => {
  const v = ['empty-state', 'view-index', 'view-session', 'view-month', 'view-day', 'view-week', 'view-all'].find((id) => {
    const el = document.getElementById(id); return el && !el.classList.contains('hidden') && el.offsetParent !== null && el.innerHTML.trim();
  });
  return v || null;
});
// Mirrors paintCloud's classes and fill; paintCloud is closure-scoped and needs a Drive token.
async function forceCloud(page, st, frac = 0.4) {
  await page.evaluate(({ st, frac }) => {
    const bar = document.getElementById('app-bar');
    bar.classList.toggle('syncing', st === 'syncing'); bar.classList.toggle('drive-off', st === 'off');
    document.getElementById('syncbar-fill').style.transform = st === 'syncing' ? 'scaleX(' + frac + ')' : 'scaleX(0)';
  }, { st, frac });
  await page.waitForTimeout(350);
}
async function go(page, hash) {
  await page.evaluate((h) => { location.hash = h; }, hash);
  await page.waitForTimeout(350);
}

// ---------------------------------------------------------------- S23
// Each S23 check returns [[label, ok, detail], ...]; report() counts them, the mutant runner wants a FAIL.
const report = (rows) => { for (const [l, c, d] of rows) ok(c, l + (!c && d ? '  [' + d + ']' : '')); return rows; };
const S23_VIEWS = [['month', '#/month/2026-04'], ['week', '#/week/2026-04-26'], ['day', '#/day/2026-04-26'], ['sessions', '#/index'], ['trends', '#/all']];

// In the page: the visible selects, buttons and inputs under root, and those without a shared class or outside .ui.
const SWEEP = (rootSel) => {
  const root = rootSel ? document.querySelector(rootSel) : document;
  if (!root) return { n: 0, bad: ['no ' + rootSel] };
  const shown = (e) => {
    const t = (e.type === 'checkbox' && e.closest('label')) || e;
    const r = t.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && getComputedStyle(t).visibility !== 'hidden';
  };
  const shared = (e) => {
    if (e.tagName === 'BUTTON') return e.matches('.btn, .chip, .toggle, .row-btn, .segmented > button, .menu > button, .menu > [role^="menuitem"], .tabs > button, .chip-removable > button, .toast .undo');
    if (e.tagName === 'INPUT' && e.type === 'checkbox') return e.matches('.menu > label > input');
    return !!e.closest('.field');
  };
  const name = (e) => e.tagName.toLowerCase() + (e.id ? '#' + e.id : '') + (typeof e.className === 'string' && e.className.trim() ? '.' + e.className.trim().split(/\s+/).join('.') : '');
  let n = 0;
  const bad = new Set();
  for (const e of root.querySelectorAll('select, button, input, textarea')) {
    if (!shown(e)) continue;
    n++;
    const inUi = !!e.closest('.ui');
    if (!inUi || !shared(e)) bad.add(name(e) + (inUi ? '' : ' outside .ui'));
  }
  return { n, bad: [...bad] };
};
async function sweepRow(page, label, rootSel) {
  const r = await page.evaluate(SWEEP, rootSel || null);
  return [`S23 sweep ${label}: ${r.n} controls, each shared and in .ui`, r.n > 0 && !r.bad.length, r.bad.join(', ')];
}
async function closeLayers(page) { await page.keyboard.press('Escape'); await page.mouse.click(3, 300); await page.waitForTimeout(150); }

async function s23Sweep(opts = {}) {
  const rows = [];
  for (const w of opts.widths || [360, 1440]) {
    for (const [name, hash] of S23_VIEWS.filter(([n]) => !opts.views || opts.views.includes(n))) {
      const { ctx, page } = await open(w, 'demo=1', hash);
      const tag = w + ' ' + name;
      rows.push(await sweepRow(page, tag));
      if (!opts.quick) {
        await page.click('#viewer-settings-btn'); await page.waitForTimeout(200);
        rows.push(await sweepRow(page, tag + ' gear popover', '#viewer-settings-popover'));
        await closeLayers(page);
      }
      if (name === 'day') {
        await page.click('#summary-bar-kebab'); await page.waitForTimeout(200);
        rows.push(await sweepRow(page, tag + ' stats menu', '#summary-bar-menu'));
        await closeLayers(page);
        await page.click('#interp-edit'); await page.waitForTimeout(200);
        rows.push(await sweepRow(page, tag + ' threshold popover', '#quadrant-thresh-popover'));
        await closeLayers(page);
        if (w < 600) {
          await page.click('#markers-open'); await page.waitForTimeout(300);
          rows.push(await sweepRow(page, tag + ' markers sheet', '.sheet'));
          await closeLayers(page);
        }
      }
      if (name === 'sessions') {
        await page.locator('.session-card-kebab').first().click(); await page.waitForTimeout(200);
        rows.push(await sweepRow(page, tag + ' card menu', '.session-card-menu'));
        await closeLayers(page);
      }
      rows.push([`S23 sweep ${tag}: no page errors`, !page.errors.length, page.errors.join(' | ')]);
      await ctx.close();
    }
    if (!opts.views) {
      // Signed out, outside the demo: the Drive status shows its Sign in action (the demo hides the actions).
      const { ctx, page } = await open(w, 'x=1');
      rows.push(await sweepRow(page, w + ' empty state', '#empty-state'));
      await page.click('#drive-cloud'); await page.waitForTimeout(200);
      rows.push(await sweepRow(page, w + ' Drive status', '#drive-pop'));
      await ctx.close();
    }
  }
  return rows;
}

// The bar's view select is one width on all five views; Share is in the bar on all five.
async function s23Bar() {
  const rows = [];
  for (const [w, scale] of [[360, 1], [360, 2], [1440, 1]]) {
    const { ctx, page } = await open(w, 'demo=1', S23_VIEWS[0][1], scale);
    const tag = w + (scale === 2 ? ' at 200% text' : '');
    const widths = [], share = [];
    for (const [name, hash] of S23_VIEWS) {
      await go(page, hash);
      const m = await page.evaluate(() => {
        const s = document.getElementById('view-select').getBoundingClientRect();
        const b = document.getElementById('export-report'); const r = b.getBoundingClientRect();
        const bar = document.getElementById('app-bar').getBoundingClientRect();
        return { sel: Math.round(s.width * 10) / 10, share: !b.hidden && getComputedStyle(b).display !== 'none' && r.width >= 36 && r.height >= 36 && r.right <= innerWidth && r.top >= bar.top && r.bottom <= bar.bottom,
          w: Math.round(r.width), h: Math.round(r.height), sw: document.documentElement.scrollWidth };
      });
      widths.push([name, m.sel]);
      share.push([name, m.share && m.sw <= w, m.w + 'x' + m.h]);
    }
    if (w < 600) {
      const vals = widths.map((x) => x[1]);
      rows.push([`S23 ${tag}: view select one width on all five views (${widths.map((x) => x.join(' ')).join(', ')})`, vals[0] > 0 && vals.every((v) => v === vals[0])]);
    }
    rows.push([`S23 ${tag}: Share in the bar on all five views (${share.map((x) => x[0] + ' ' + x[2]).join(', ')})`, share.every((x) => x[1])]);
    await ctx.close();
  }
  return rows;
}

// The gear and threshold popovers: Cancel and Save one width, Reset a ghost button of the same height leading the row.
async function s23Actions() {
  const rows = [];
  const measure = (ids) => ({
    c: (() => { const b = document.getElementById(ids[0]).getBoundingClientRect(); return [b.left, b.width, b.height]; })(),
    s: (() => { const e = document.getElementById(ids[1]); const b = e.getBoundingClientRect(); return [b.left, b.width, b.height, e.className]; })(),
    r: (() => { const e = document.getElementById(ids[2]); const b = e.getBoundingClientRect(); return [b.left, b.width, b.height, e.className, e.parentElement.getBoundingClientRect().left]; })(),
  });
  for (const [w, scale] of [[360, 1], [360, 2], [1440, 1]]) {
    const { ctx, page } = await open(w, 'demo=1', '#/day/2026-04-26', scale);
    const tag = w + (scale === 2 ? ' at 200% text' : '');
    for (const [pop, opener, ids] of [['gear popover', '#viewer-settings-btn', ['hrshift-cancel', 'hrshift-save', 'hrshift-reset']],
      ['threshold popover', '#interp-edit', ['thresh-cancel', 'thresh-save', 'thresh-reset']]]) {
      await page.click(opener); await page.waitForTimeout(250);
      if (scale !== 1) { await scaleText(page, scale); await closeLayers(page); await page.click(opener); await page.waitForTimeout(250); }
      const m = await page.evaluate(measure, ids);
      const eqW = Math.abs(m.c[1] - m.s[1]) <= 0.5;
      const eqH = Math.abs(m.c[2] - m.s[2]) <= 0.5 && Math.abs(m.r[2] - m.s[2]) <= 0.5;
      const lead = Math.abs(m.r[0] - m.r[4]) <= 0.5 && m.r[0] < m.c[0] + 0.5;
      rows.push([`S23 ${tag} ${pop}: Cancel ${m.c[1].toFixed(1)} and Save ${m.s[1].toFixed(1)} px wide, ${m.s[2]} px tall; Reset ${m.r[2]} px tall at the row start`,
        eqW && eqH && lead && /\bbtn\b/.test(m.r[3]) && /\bghost\b/.test(m.r[3]) && /\bprimary\b/.test(m.s[3]), JSON.stringify(m)]);
      await closeLayers(page);
    }
    rows.push([`S23 ${tag} action rows: no page errors`, !page.errors.length, page.errors.join(' | ')]);
    await ctx.close();
  }
  return rows;
}

// The Drive cloud on open, signed in, against a fake Drive whose first call answers after delayMs.
async function cloudRun(delayMs) {
  const fake = new FakeDrive();
  fake.folder('HR Monitor Sessions', null, '2025-01-01T00:00:00.000Z', 'root1');
  let first = true;
  const drive = { fake, log: [], delay: () => { if (!first) return 0; first = false; return delayMs; } };
  const { ctx, page } = await open(1440, 'x=1', '', 1, drive);
  await page.waitForTimeout(Math.max(0, delayMs + 2500 - 1000));
  const log = await page.evaluate(() => window.__cloudLog);
  const end = await page.evaluate(() => document.getElementById('app-bar').classList.contains('syncing'));
  const errs = page.errors.slice();
  await ctx.close();
  const reqs = drive.log.filter((x) => !x.done);
  const slowDone = drive.log.find((x) => x.done);
  return { log, end, errs, t0: reqs.length ? reqs[0].at : 0, slowDone: slowDone ? slowDone.at : 0, calls: reqs.length };
}
async function s23Cloud() {
  const rows = [];
  const q = await cloudRun(300);
  rows.push([`S23 cloud: open-time Drive work ending in about 300 ms never shows syncing (${q.calls} Drive calls, ${q.log.length} class changes)`,
    q.calls > 0 && q.log.every((x) => !x.syncing) && !q.end, JSON.stringify(q.log.map((x) => [x.at - q.t0, x.syncing]))]);
  const s = await cloudRun(3000);
  const on = s.log.find((x) => x.syncing), off = on && s.log.find((x) => !x.syncing && x.at > on.at);
  const after = on ? on.at - s.t0 : -1, left = off ? off.at - s.slowDone : -1;
  rows.push([`S23 cloud: work running 3 s shows syncing ${after} ms after the first Drive call and clears ${left} ms after the slow call answers`,
    !!on && after >= 700 && after <= 1400 && !!off && left >= 0 && left <= 1500 && !s.end, JSON.stringify(s.log.map((x) => [x.at - s.t0, x.syncing]))]);
  rows.push(['S23 cloud: no page errors', !q.errs.length && !s.errs.length, q.errs.concat(s.errs).join(' | ')]);
  return rows;
}

const S23_MUTANTS = [
  ['sweep', 'Sessions range select without .field', { '/hrv_viewer.html': ['<span class="field"><span class="select"><select id="index-range" aria-label="Date range">${rangeOptionsHtml}</select></span></span>', '<select id="index-range" aria-label="Date range">${rangeOptionsHtml}</select>'] },
    () => s23Sweep({ widths: [360], views: ['sessions'], quick: true })],
  ['sweep', 'stats kebab without .btn', { '/hrv_viewer.html': ['<button class="btn icon summary-bar-kebab"', '<button class="summary-bar-kebab"'] },
    () => s23Sweep({ widths: [1440], views: ['day'], quick: true })],
  ['sweep', 'Month header outside .ui', { '/hrv_viewer.html': ['<div class="cal-header ui">', '<div class="cal-header">'] },
    () => s23Sweep({ widths: [1440], views: ['month'], quick: true })],
  ['bar', 'view select sized to the chosen view', { '/hrv_viewer.html': ['  .vsel select { cursor: pointer; }', '  .vsel select { cursor: pointer; field-sizing: content; }'] }, s23Bar],
  ['bar', 'Share hidden on Sessions', { '/hrv_viewer.html': ["exportBtn.hidden = isNativeApp || id === 'empty-state';", "exportBtn.hidden = isNativeApp || id === 'empty-state' || id === 'view-index';"] }, s23Bar],
  ['actions', 'Cancel and Save at content width', { '/ui.css': ['.action-row > .pair { flex: 1 1 14em; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--s2); }', '.action-row > .pair { display: flex; gap: var(--s2); margin-left: auto; }'] }, s23Actions],
  ['cloud', 'no 1 s delay', { '/hrv_viewer.html': ['    const syncing = busy && cloud.shown;', '    const syncing = busy;'] }, s23Cloud],
];

try {
  if (!MUTANTS_ONLY && (!PART || PART === 'base')) {
  // 1. Opens on the latest recorded day.
  {
    const { ctx, page } = await open(1440);
    ok((await hashOf(page)) === '#/day', 'no hash opens #/day');
    const t = await page.textContent('#view-day .day-title').catch(() => '');
    ok(/April 26, 2026/.test(t || ''), 'opens on the latest recorded day: ' + t);
    ok((await page.getAttribute('.view-tabs a[data-view="day"]', 'aria-current')) === 'page', 'Day tab is current');

    // 2. Old hash routes resolve.
    const routes = [['#/index', 'view-index'], ['#/month', 'view-month'], ['#/month/2026-04', 'view-month'], ['#/week', 'view-week'],
      ['#/week/2026-04-22', 'view-week'], ['#/day', 'view-day'], ['#/day/2026-04-22', 'view-day'], ['#/all', 'view-all'],
      ['#/session/' + encodeURIComponent('hrv_session_2026-04-22T12-57-27.csv'), 'view-session'], ['#/session/day%3A2026-04-22', 'view-day'], ['#/bogus', 'view-index']];
    for (const [h, id] of routes) {
      await go(page, h);
      if (h.startsWith('#/session')) await page.waitForTimeout(1200);
      const v = await visibleView(page);
      const stub = await page.evaluate(() => /not found/i.test(document.getElementById('view-session').textContent));
      ok(v === id && !stub, `route ${h} shows ${id} (got ${v})`);
    }

    // 3. Week tab opens the week holding the shown day; Month tab its month.
    await go(page, '#/day/2026-04-22');
    ok((await page.getAttribute('.view-tabs a[data-view="week"]', 'href')) === '#/week/2026-04-22', 'Week tab holds the shown day');
    ok((await page.getAttribute('.view-tabs a[data-view="month"]', 'href')) === '#/month/2026-04', 'Month tab holds the shown day');
    await page.click('.view-tabs a[data-view="week"]'); await page.waitForTimeout(350);
    ok((await hashOf(page)) === '#/week/2026-04-22' && (await visibleView(page)) === 'view-week', 'Week tab opens week of 2026-04-22');
    ok(await page.evaluate(() => !!document.querySelector('#view-week [data-date="2026-04-22"]')), 'that week shows 2026-04-22');

    // 4. Every bar tab is wired.
    for (const [v, id] of [['month', 'view-month'], ['week', 'view-week'], ['day', 'view-day'], ['index', 'view-index'], ['all', 'view-all']]) {
      await page.click(`.view-tabs a[data-view="${v}"]`); await page.waitForTimeout(350);
      ok((await visibleView(page)) === id && (await page.getAttribute(`.view-tabs a[data-view="${v}"]`, 'aria-current')) === 'page', `tab ${v} shows ${id} and is current`);
    }
    // Drive cloud, gear, Share, Monitor.
    await page.click('#drive-cloud');
    ok(await page.isVisible('#drive-pop'), 'cloud opens the Drive status');
    ok((await page.getAttribute('#drive-cloud', 'aria-expanded')) === 'true', 'cloud aria-expanded true');
    await page.keyboard.press('Escape');
    ok(!(await page.isVisible('#drive-pop')), 'Escape closes the Drive status');
    await page.click('#drive-cloud'); await page.mouse.click(700, 600);
    ok(!(await page.isVisible('#drive-pop')), 'outside click closes the Drive status');
    await page.click('#viewer-settings-btn');
    ok(await page.isVisible('#viewer-settings-popover'), 'gear opens the viewer settings popover');
    await page.click('#drive-cloud');
    ok(!(await page.isVisible('#viewer-settings-popover')) && await page.isVisible('#drive-pop'), 'cloud closes the settings popover');
    await page.click('#viewer-settings-btn');
    ok(!(await page.isVisible('#drive-pop')), 'gear closes the Drive status');
    await page.mouse.click(700, 600);
    await page.click('#export-report'); await page.waitForTimeout(400);
    ok((await page.evaluate(() => window.__prints)) === 1, 'Share runs the print path');
    ok((await page.getAttribute('#monitor-link', 'href')) === './hr_monitor.html' && /Monitor/.test(await page.textContent('#monitor-link')), 'Monitor link');
    ok(page.errors.length === 0, 'no page errors at 1440: ' + page.errors.join(' | '));
    await ctx.close();
  }

  // 5. Day arrows and arrow keys skip days without data.
  {
    const { ctx, page } = await open(1440, 'demo=1&gap=1', '#/day/2026-04-21');
    await page.click('#day-next'); await page.waitForTimeout(350);
    ok((await hashOf(page)) === '#/day/2026-04-24', 'next from 04-21 over two empty days lands on 04-24: ' + (await hashOf(page)));
    await page.click('#day-prev'); await page.waitForTimeout(350);
    ok((await hashOf(page)) === '#/day/2026-04-21', 'prev from 04-24 lands on 04-21');
    await page.keyboard.press('ArrowRight'); await page.waitForTimeout(350);
    ok((await hashOf(page)) === '#/day/2026-04-24', 'ArrowRight pages to 04-24');
    await page.keyboard.press('ArrowLeft'); await page.waitForTimeout(350);
    ok((await hashOf(page)) === '#/day/2026-04-21', 'ArrowLeft pages back to 04-21');
    await go(page, '#/day/2026-04-22');
    await page.click('#day-next'); await page.waitForTimeout(350);
    ok((await hashOf(page)) === '#/day/2026-04-24', 'next from an empty day lands on the next day with data');
    await go(page, '#/day/2026-04-26');
    ok(await page.isDisabled('#day-next'), 'next is disabled on the last day with data');
    await page.keyboard.press('ArrowRight'); await page.waitForTimeout(300);
    ok((await hashOf(page)) === '#/day/2026-04-26', 'ArrowRight on the last day stays');
    ok(page.errors.length === 0, 'no page errors on the gap set: ' + page.errors.join(' | '));
    await ctx.close();
  }

  // 6. Phone bar: view select, no hamburger, 44 px controls, no horizontal overflow.
  for (const scale of [1, 2]) {
    const { ctx, page } = await open(360, 'demo=1', '', scale);
    const tag = scale === 1 ? '360' : '360 at 200% text';
    ok(!(await page.$('#mobile-menu-btn')), `${tag}: no hamburger`);
    ok(await page.isVisible('#view-select') && !(await page.isVisible('.view-tabs')), `${tag}: view select replaces the tabs`);
    const sizes = await page.evaluate(() => ['.vbar .brand', '#view-select', '#drive-cloud', '#export-report', '#viewer-settings-btn'].map((s) => {
      const r = document.querySelector(s).getBoundingClientRect(); return [s, Math.round(r.width), Math.round(r.height), Math.round(r.right)];
    }));
    // S23: the logo is the last thing fitBar drops (tight-3), only when nothing else is left to drop.
    const tight3 = await page.evaluate(() => document.getElementById('app-bar').classList.contains('tight-3'));
    ok(scale === 2 || !tight3, `${tag}: logo ${tight3 ? 'dropped' : 'kept'}`);
    for (const [s, w, h, right] of sizes) if (!(tight3 && s === '.vbar .brand')) ok(w >= 44 && h >= 44 && right <= 360, `${tag}: ${s} ${w}x${h} inside the bar (right ${right})`);
    const order = await page.evaluate(() => ['#drive-cloud', '#export-report', '#viewer-settings-btn'].map((s) => document.querySelector(s).getBoundingClientRect().left));
    ok(order[0] < order[1] && order[1] < order[2], `${tag}: cloud, Share, gear in order`);
    ok(await page.evaluate(() => document.documentElement.scrollWidth <= 360), `${tag}: no horizontal page scroll`);
    if (scale === 1) {
      await page.selectOption('#view-select', 'week'); await page.waitForTimeout(400);
      ok((await visibleView(page)) === 'view-week' && /^#\/week\/2026-04-26$/.test(await hashOf(page)), 'select Week opens the week holding the shown day');
      await page.selectOption('#view-select', 'all'); await page.waitForTimeout(400);
      ok((await visibleView(page)) === 'view-all', 'select Trends opens Trends');
      await go(page, '#/day/2026-04-26');
      await page.focus('#view-select');
      for (let i = 0; i < 6; i++) { await page.keyboard.press('ArrowDown'); await page.waitForTimeout(150); }
      ok(page.url().includes('/hrv_viewer.html'), 'arrowing through the select stays in the viewer');
      await page.tap('#drive-cloud');
      ok(await page.isVisible('#drive-pop'), 'phone cloud opens the Drive status');
      const pr = await page.evaluate(() => { const r = document.getElementById('drive-pop').getBoundingClientRect(); return [r.left, r.right]; });
      ok(pr[0] >= 0 && pr[1] <= 360, 'Drive status fits at 360: ' + pr.join(','));
    }
    ok(page.errors.length === 0, `${tag}: no page errors: ` + page.errors.join(' | '));
    await ctx.close();
  }

  // 7. S22 sync state, sync bar, phone select and gear popover.
  for (const [w, scale] of [[1440, 1], [360, 1], [360, 2]]) {
    const { ctx, page } = await open(w, 'demo=1', '#/day/2026-04-26', scale);
    const tag = w + (scale === 2 ? ' at 200% text' : '');
    const geo = () => page.evaluate(() => {
      const box = (s) => {
        const e = document.querySelector(s); if (!e) return null;
        const cs = getComputedStyle(e); const r = e.getBoundingClientRect();
        return { l: r.left, t: r.top, r: r.right, b: r.bottom, w: r.width, h: r.height, cw: parseFloat(cs.width), ch: parseFloat(cs.height), anim: cs.animationName,
          shown: cs.display !== 'none' && cs.visibility !== 'hidden' && +cs.opacity > 0 && r.width > 0 };
      };
      return { bar: box('#app-bar'), sb: box('.syncbar'), sel: box('#view-select'), mark: box('.vbar .wordmark'),
        synced: box('#drive-cloud .when-synced'), syncing: box('#drive-cloud .when-syncing'), lbl: box('#drive-cloud .sync-lbl'),
        cloud: box('#drive-cloud'), gear: box('#viewer-settings-btn'), share: box('#export-report'), sw: document.documentElement.scrollWidth };
    });
    await forceCloud(page, 'synced');
    const a = await geo();
    ok(a.synced.shown && !a.syncing.shown && !a.sb.shown, `${tag}: synced shows the cloud, no sync icon, no bar`);
    await forceCloud(page, 'syncing');
    const g = await geo();
    ok(!g.synced.shown && g.syncing.shown && g.syncing.cw === a.synced.cw && g.syncing.ch === a.synced.ch,
      `${tag}: syncing swaps the cloud for a ${g.syncing.cw}x${g.syncing.ch} sync icon (cloud ${a.synced.cw}x${a.synced.ch})`);
    ok(g.syncing.anim === 'drive-sync-spin', `${tag}: the sync icon spins (${g.syncing.anim})`);
    const word = w > 768 ? g.lbl.shown && /Syncing/.test(await page.textContent('#drive-cloud .sync-lbl')) : !g.lbl.shown;
    ok(word, `${tag}: "Syncing" word ${w > 768 ? 'beside the icon' : 'hidden'}`);
    ok(g.sb.shown && g.sb.t >= g.bar.b - 0.01 && Math.round(g.sb.h) === 3 && Math.round(g.sb.w) === Math.round(g.bar.w),
      `${tag}: sync bar ${Math.round(g.sb.w)}x${g.sb.h} starts at ${g.sb.t}, app bar ends at ${g.bar.b}`);
    if (g.sel.w) ok(g.sb.t >= g.sel.b + 4, `${tag}: sync bar clear of the view select (select ends ${g.sel.b}, bar starts ${g.sb.t})`);
    ok(g.cloud.h >= 44 && g.cloud.w >= 44 && g.share.r <= w && g.gear.r <= w && g.sw <= w, `${tag}: syncing keeps every bar control inside ${w} with no page scroll`);
    if (w < 600) {
      ok(g.sel.h >= 44, `${tag}: view select ${Math.round(g.sel.h)} px tall`);
      if (g.mark.shown) ok(g.sel.l - g.mark.r >= 12, `${tag}: ${Math.round(g.sel.l - g.mark.r)} px from the wordmark to the select`);
    }
    await forceCloud(page, 'synced');
    await page.click('#viewer-settings-btn'); await page.waitForTimeout(250);
    if (scale !== 1) {
      // Scale the new popover's text, then reopen so it is placed at its scaled height.
      await scaleText(page, scale); await page.mouse.click(5, 700); await page.waitForTimeout(150);
      await page.click('#viewer-settings-btn'); await page.waitForTimeout(250);
    }
    const pop = await page.evaluate(() => {
      const r = (s) => { const e = document.querySelector(s); const b = e.getBoundingClientRect(); return [Math.round(b.width), Math.round(b.height), e.className]; };
      const p = document.getElementById('viewer-settings-popover').getBoundingClientRect();
      return { target: parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--target')), save: r('#hrshift-save'), cancel: r('#hrshift-cancel'), reset: r('#hrshift-reset'), tog: r('#autonomic-toggle'), thr: r('#hrshift-thresh'), l: p.left, r: p.right };
    });
    const tgt = w < 600 ? 44 : pop.target;
    ok(pop.save[1] >= tgt && /\bbtn\b/.test(pop.save[2]) && /\bprimary\b/.test(pop.save[2]), `${tag}: popover Save is a ${pop.save[0]}x${pop.save[1]} .btn.primary`);
    ok(pop.cancel[1] >= tgt && pop.reset[1] >= tgt && pop.tog[1] >= tgt && pop.thr[1] >= tgt,
      `${tag} (target ${tgt}): Cancel ${pop.cancel[1]}, Reset ${pop.reset[1]}, switch ${pop.tog[1]}, threshold field ${pop.thr[1]} px tall`);
    ok(pop.l >= 0 && pop.r <= w, `${tag}: popover inside the viewport (${Math.round(pop.l)} to ${Math.round(pop.r)})`);
    await page.evaluate(() => document.getElementById('hrshift-save').scrollIntoView({ block: 'nearest' }));
    const saveBox = await page.evaluate(() => { const b = document.getElementById('hrshift-save').getBoundingClientRect(); return [b.top, b.bottom, innerHeight]; });
    ok(saveBox[0] >= 0 && saveBox[1] <= saveBox[2], `${tag}: Save reachable inside the viewport (${Math.round(saveBox[0])} to ${Math.round(saveBox[1])} of ${saveBox[2]})`);
    if (scale === 1 && w === 1440) {
      const before = await page.getAttribute('#autonomic-toggle', 'aria-checked');
      await page.click('#autonomic-toggle'); await page.waitForTimeout(300);
      const after = await page.getAttribute('#autonomic-toggle', 'aria-checked');
      const noAut = await page.evaluate(() => document.body.classList.contains('no-autonomic'));
      ok(before !== after && noAut === (after === 'false'), `autonomic switch ${before} to ${after}, body no-autonomic ${noAut}`);
      await page.click('#autonomic-toggle'); await page.waitForTimeout(300);
      await page.fill('#hrshift-thresh', '25'); await page.click('#hrshift-save'); await page.waitForTimeout(600);
      const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('hrv_viewer_hr_shift_settings') || 'null'));
      ok(saved && saved.threshold === 25 && !(await page.isVisible('#viewer-settings-popover')), 'Save stores the threshold and closes the popover');
    }
    ok(page.errors.length === 0, `${tag}: no page errors in the sync and popover cases: ` + page.errors.join(' | '));
    await ctx.close();
  }

  // 7b. A crowded laptop bar drops the Syncing word first; fitBar runs on resize.
  {
    const { ctx, page } = await open(1440, 'demo=1', '#/day/2026-04-26');
    await forceCloud(page, 'syncing');
    for (const vw of [900, 1024]) {
      await page.setViewportSize({ width: vw, height: 800 }); await page.waitForTimeout(300);
      const r = await page.evaluate(() => {
        const bar = document.getElementById('app-bar'); const l = document.querySelector('#drive-cloud .sync-lbl');
        return { fits: bar.scrollWidth <= bar.clientWidth + 1, tight0: bar.classList.contains('tight-0'), lbl: getComputedStyle(l).display !== 'none', w: Math.round(document.getElementById('drive-cloud').getBoundingClientRect().width) };
      });
      ok(r.fits && (r.tight0 ? !r.lbl && r.w === 44 : r.lbl), `${vw}: syncing bar fits, Syncing word ${r.lbl ? 'shown' : 'dropped'} (cloud ${r.w} px)`);
    }
    await forceCloud(page, 'synced'); await page.setViewportSize({ width: 900, height: 800 }); await page.waitForTimeout(300);
    ok(!(await page.evaluate(() => document.getElementById('app-bar').classList.contains('tight-0'))), '900: tight-0 only while syncing');
    ok(page.errors.length === 0, 'no page errors in the resize cases: ' + page.errors.join(' | '));
    await ctx.close();
  }

  // 8. Empty state (no folder, no Drive): both ways in, no Share.
  {
    const { ctx, page } = await open(1440, 'x=1');
    ok((await visibleView(page)) === 'empty-state', 'first run shows the empty state');
    ok(await page.isVisible('#empty-drive'), 'empty state offers Sign in with Google');
    ok(!(await page.isVisible('#export-report')), 'Share hidden on the empty state');
    ok(page.errors.length === 0, 'no page errors on the empty state: ' + page.errors.join(' | '));
    await ctx.close();
  }

  }

  if (!MUTANTS_ONLY && (!PART || PART === 's23')) {
    report(await s23Sweep());
    report(await s23Bar());
    report(await s23Actions());
    report(await s23Cloud());
  }
  if (MUTANTS_ONLY) {
    console.log('\nS23 negative controls (each must FAIL):');
    for (const [id, name, mut, fn] of S23_MUTANTS.filter((m) => !PART || m[0] === PART)) {
      MUTATE = mut; anchorMissing = false;
      let rows;
      try { rows = await fn(); } catch (e) { rows = [['threw: ' + e.message.split('\n')[0], false]]; }
      MUTATE = {};
      const bad = rows.filter((r) => !r[1]);
      if (bad.length && !anchorMissing) { passes++; console.log(`MUTANT ${id} ${name}: FAILED as required  (${bad.map((r) => r[0]).join(' | ')})`); }
      else { fails++; console.log(`MUTANT ${id} ${name}: NOT CAUGHT${anchorMissing ? ' (anchor missing)' : ''}`); }
    }
  }

  // 8. Shots.
  if (SHOTS) {
    const views = [['month', '#/month/2026-04'], ['week', '#/week/2026-04-26'], ['day', '#/day/2026-04-26'], ['sessions', '#/index'], ['trends', '#/all']];
    for (const [w, scale, tag] of [[1440, 1, '1440'], [360, 1, '360'], [360, 2, '360-text200']]) {
      for (const [name, h] of views) {
        const { ctx, page } = await open(w, 'demo=1', h, scale);
        await page.screenshot({ path: path.join(SHOTS, `${name}-${tag}.png`), fullPage: false });
        await ctx.close();
      }
    }
    for (const [w, tag] of [[1440, '1440'], [360, '360'], [360, '360-text200']]) {
      const { ctx, page } = await open(w, 'demo=1', '#/day/2026-04-26', tag.endsWith('200') ? 2 : 1);
      const top = await page.evaluate(() => Math.round(document.getElementById('app-bar').getBoundingClientRect().top));
      for (const st of ['synced', 'syncing', 'off']) {
        await forceCloud(page, st);
        await page.evaluate(() => { const s = document.querySelector('#drive-cloud .when-syncing'); s.style.animationPlayState = 'paused'; s.style.animationDelay = '-.3s'; });
        await page.screenshot({ path: path.join(SHOTS, `cloud-${st}-${tag}.png`), clip: { x: 0, y: 0, width: w, height: top + 120 } });
      }
      await forceCloud(page, 'synced');
      // Each popover and menu: open, scale its new text at 200%, reopen so it is placed at its scaled size.
      for (const [name, opener] of [['gear-popover', '#viewer-settings-btn'], ['thresh-popover', '#interp-edit'], ['stats-menu', '#summary-bar-kebab']]) {
        await page.click(opener); await page.waitForTimeout(250);
        if (tag.endsWith('200')) { await scaleText(page, 2); await closeLayers(page); await page.click(opener); await page.waitForTimeout(250); }
        await page.screenshot({ path: path.join(SHOTS, `${name}-${tag}.png`), fullPage: false });
        await closeLayers(page);
      }
      await page.evaluate(() => document.getElementById('app-bar').scrollIntoView());
      await page.evaluate(() => { const bar = document.getElementById('app-bar'); bar.classList.remove('syncing', 'drive-off'); });
      await page.click('#drive-cloud'); await page.waitForTimeout(200);
      await page.screenshot({ path: path.join(SHOTS, `drive-status-${tag}.png`), clip: { x: 0, y: 0, width: w, height: 360 } });
      await ctx.close();
      const s = await open(w, 'demo=1', '#/index', tag.endsWith('200') ? 2 : 1);
      await s.page.locator('.session-card-kebab').first().click(); await s.page.waitForTimeout(250);
      await s.page.screenshot({ path: path.join(SHOTS, `card-menu-${tag}.png`), fullPage: false });
      await s.ctx.close();
    }
    for (const w of [360, 1440]) {
      const { ctx, page } = await open(w, 'x=1');
      await page.screenshot({ path: path.join(SHOTS, `empty-${w}.png`), fullPage: false });
      await ctx.close();
    }
    console.log('shots in ' + SHOTS);
  }
} finally {
  if (browser) await browser.close();
  server.close();
}
console.log(`viewer-nav: ${passes} pass, ${fails} fail`);
process.exit(fails ? 1 : 0);
