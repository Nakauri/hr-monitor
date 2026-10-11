// S8 viewer bar and navigation checks, on demo data (?demo=1), headless:
// every old hash route resolves; the viewer opens on the latest day; day arrows and arrow keys skip
// days without data; the Week tab opens the week holding the shown day; every bar control is wired
// (tabs, view select, Drive cloud, gear, Share). --shots <dir> also shoots Month, Week, Day, Sessions
// and Trends at 1440, 360 and 360 with 200% text, plus the Drive cloud synced, syncing and off.
// Usage: node scripts/viewer-nav.mjs [--shots <dir>] [--ux <ux-audit dir>]
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const argVal = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const ROOT = path.resolve(here, '..');
const UX = path.resolve(argVal('--ux') || 'C:/Users/Khal/Desktop/Mine/HR Monitor/ux-audit');
const SHOTS = argVal('--shots');
const CHART = path.join(UX, '..', 'docs', 'audit-2026-10-09', 'harness-DT', 'vendor', 'chart.umd.min.js');
const { chromium } = createRequire(path.join(UX, 'kit', 'package.json'))('playwright');
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

// Two days without data (04-22, 04-23): the files that start there or run into them are left out.
const GAP_DROP = /2026-04-2(1T21|2T|3T)/;
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png', '.woff2': 'font/woff2', '.csv': 'text/csv' };
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const rel = decodeURIComponent(u.pathname);
  const file = path.join(ROOT, rel);
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end(); return; }
  let body = fs.readFileSync(file);
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
async function open(width, query = 'demo=1', hash = '', textScale = 1) {
  const phone = width < 600;
  const ctx = await browser.newContext({ viewport: { width, height: phone ? 740 : 900 }, deviceScaleFactor: 1, isMobile: phone, hasTouch: phone });
  await ctx.route('**/*', (route) => {
    const u = route.request().url();
    if (u.startsWith(BASE) || u.startsWith('data:') || u.startsWith('blob:')) return route.continue();
    if (/chart\.umd(\.min)?\.js/.test(u)) return route.fulfill({ status: 200, contentType: 'text/javascript', body: fs.readFileSync(CHART) });
    if (/fonts\.(googleapis|gstatic)\.com|cdn\.jsdelivr\.net|cdnjs\.cloudflare\.com/.test(u)) return route.continue();
    return route.fulfill({ status: 204, body: '' });
  });
  await ctx.addInitScript(() => { window.__prints = 0; window.print = () => { window.__prints++; }; });
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
async function go(page, hash) {
  await page.evaluate((h) => { location.hash = h; }, hash);
  await page.waitForTimeout(350);
}

try {
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
    for (const [s, w, h, right] of sizes) ok(w >= 44 && h >= 44 && right <= 360, `${tag}: ${s} ${w}x${h} inside the bar (right ${right})`);
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

  // 7. Empty state (no folder, no Drive): both ways in, no Share.
  {
    const { ctx, page } = await open(1440, 'x=1');
    ok((await visibleView(page)) === 'empty-state', 'first run shows the empty state');
    ok(await page.isVisible('#empty-drive'), 'empty state offers Sign in with Google');
    ok(!(await page.isVisible('#export-report')), 'Share hidden on the empty state');
    ok(page.errors.length === 0, 'no page errors on the empty state: ' + page.errors.join(' | '));
    await ctx.close();
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
      for (const st of ['synced', 'syncing', 'off']) {
        await page.evaluate((st) => {
          const bar = document.getElementById('app-bar');
          bar.classList.toggle('syncing', st === 'syncing'); bar.classList.toggle('drive-off', st === 'off');
          document.getElementById('syncbar-fill').style.transform = st === 'syncing' ? 'scaleX(.4)' : 'scaleX(0)';
          document.querySelectorAll('.spin').forEach((g) => { g.style.animationPlayState = 'paused'; g.style.animationDelay = '-.3s'; });
        }, st);
        await page.waitForTimeout(350);
        await page.screenshot({ path: path.join(SHOTS, `cloud-${st}-${tag}.png`), clip: { x: 0, y: 0, width: w, height: 120 } });
      }
      await page.evaluate(() => { const bar = document.getElementById('app-bar'); bar.classList.remove('syncing', 'drive-off'); });
      await page.click('#drive-cloud'); await page.waitForTimeout(200);
      await page.screenshot({ path: path.join(SHOTS, `drive-status-${tag}.png`), clip: { x: 0, y: 0, width: w, height: 360 } });
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
