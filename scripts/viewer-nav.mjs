// S8 viewer bar and navigation checks, on demo data (?demo=1), headless:
// every old hash route resolves; the viewer opens on the latest day; day arrows and arrow keys skip
// days without data; the Week tab opens the week holding the shown day; every bar control is wired
// (tabs, view select, Drive cloud, gear, Share). S22: the syncing state shows the full-size sync icon
// ("Syncing" beside it at 1440), its 3 px bar sits under the app bar clear of the view select, the
// phone select is 44 px with a 12 px gap after the wordmark, and the gear popover's buttons are 44 px.
// --shots <dir> also shoots Month, Week, Day, Sessions and Trends at 1440, 360 and 360 with 200% text,
// plus the Drive cloud synced, syncing and off, and the gear popover.
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
      await page.click('#viewer-settings-btn'); await page.waitForTimeout(250);
      if (tag.endsWith('200')) await scaleText(page, 2);
      await page.screenshot({ path: path.join(SHOTS, `gear-popover-${tag}.png`), fullPage: false });
      await page.mouse.click(5, 700); await page.waitForTimeout(150);
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
