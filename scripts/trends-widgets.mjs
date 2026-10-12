// Guards: AUDIT-NOTES 2026-10-11 item 30 (Khal 2026-10-12, Trends "still seems weird": widgets on and off, resize, reorder). Files: hrv_viewer.html Trends view (renderAll, TREND_WIDGETS, .all-card CSS). Runtime: about 40 s, --mutants about 60 s.
// S34 Trends widgets on demo data (?demo=1#/all), headless, at 1440 and 360:
// every widget hidden and shown again by real clicks in the Widgets list, the grid never has an empty cell
// (each row of shown cards spans the grid; hidden cards take no space); Full and Half change the card width
// (1440); a Playwright mouse drag of a card header reorders the cards; Move up and Move down reorder them;
// a reload keeps order, hidden and size; no page errors.
// --mutants: layout not persisted, hidden widget keeps its cell; each must FAIL.
// --shots <dir>: s34-1440-trends.png (Widgets popover open) and s34-360-trends.png.
// Usage: node scripts/trends-widgets.mjs [--mutants] [--shots <dir>] [--ux <ux-audit dir>]
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

let MUTATE = null; // [find, replace] on hrv_viewer.html
let anchorMissing = false;
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png', '.csv': 'text/csv' };
const server = http.createServer((req, res) => {
  const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const file = path.join(ROOT, rel);
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end(); return; }
  let body = fs.readFileSync(file);
  if (MUTATE && rel === '/hrv_viewer.html') {
    const text = body.toString('utf8').replace(/\r\n/g, '\n');
    if (!text.includes(MUTATE[0])) { anchorMissing = true; console.log('MUTANT ANCHOR MISSING: ' + MUTATE[0].slice(0, 60)); }
    body = text.replace(MUTATE[0], MUTATE[1]);
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

async function open(width) {
  const phone = width < 600;
  const ctx = await browser.newContext({ viewport: { width, height: phone ? 740 : 900 }, deviceScaleFactor: 1, isMobile: phone, hasTouch: phone });
  await ctx.route('**/*', async (route) => {
    const u = route.request().url();
    if (u.startsWith(BASE) || u.startsWith('data:') || u.startsWith('blob:')) return route.continue();
    if (/chart\.umd(\.min)?\.js/.test(u)) return route.fulfill({ status: 200, contentType: 'text/javascript', body: fs.readFileSync(CHART) });
    if (/fonts\.(googleapis|gstatic)\.com|cdn\.jsdelivr\.net|cdnjs\.cloudflare\.com/.test(u)) return route.continue();
    return route.fulfill({ status: 204, body: '' });
  });
  const page = await ctx.newPage();
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(e.message));
  await page.goto(`${BASE}/hrv_viewer.html?demo=1#/all`, { waitUntil: 'networkidle' });
  await waitCards(page);
  return { ctx, page };
}
const waitCards = async (page) => {
  await page.waitForFunction(() => document.querySelectorAll('#all-grid .all-card canvas').length === 6 && window.Chart && Chart.getChart(document.querySelector('#all-grid canvas')), null, { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(300);
};

// Shown cards, in DOM order, with their boxes; hidden cards must have no box.
const layout = (page) => page.evaluate(() => {
  const grid = document.getElementById('all-grid');
  const g = grid.getBoundingClientRect();
  const cards = [...grid.querySelectorAll('.all-card[data-w]')];
  const vis = (c) => { const cs = getComputedStyle(c); return cs.display !== 'none' && cs.visibility !== 'hidden' && c.getBoundingClientRect().width > 0; };
  const shown = cards.filter(vis).map((c) => { const r = c.getBoundingClientRect(); return { id: c.dataset.w, x: r.left - g.left, y: Math.round(r.top), w: r.width }; });
  const hiddenBoxes = cards.filter((c) => !vis(c) && c.getBoundingClientRect().width > 0).map((c) => c.dataset.w);
  const gap = parseFloat(getComputedStyle(grid).columnGap) || 0;
  return { gridW: g.width, gap, shown, hiddenBoxes, order: cards.map((c) => c.dataset.w) };
});
// Every row of shown cards covers the grid's width: no empty cell.
function holes(L) {
  const rows = new Map();
  L.shown.forEach((c) => { const k = [...rows.keys()].find((y) => Math.abs(y - c.y) < 3); (rows.get(k ?? c.y) || rows.set(c.y, []).get(c.y)).push(c); });
  const bad = [];
  for (const [y, cs] of rows) {
    const span = cs.reduce((a, c) => a + c.w, 0) + L.gap * (cs.length - 1);
    if (Math.abs(span - L.gridW) > 2) bad.push(`row y=${y} covers ${Math.round(span)} of ${Math.round(L.gridW)} (${cs.map((c) => c.id).join(',')})`);
  }
  if (L.hiddenBoxes.length) bad.push('hidden cards keep a box: ' + L.hiddenBoxes.join(','));
  return bad;
}
async function openWidgets(page) {
  if (await page.locator('.widget-rows').count()) return;
  await page.locator('#widgets-open').click();
  await page.locator('.widget-rows .widget-row').first().waitFor({ timeout: 5000 });
}
async function closeWidgets(page) {
  if (!(await page.locator('.widget-rows').count())) return;
  await page.keyboard.press('Escape');
  await page.waitForTimeout(250);
}
const rowBtn = (page, id, sel) => page.locator(`.widget-row[data-w="${id}"] ${sel}`);

async function run(width) {
  const tag = `@${width}`;
  const { ctx, page } = await open(width);
  ok(await page.evaluate(() => typeof Sortable !== 'undefined'), `${tag} SortableJS loaded`);
  let L = await layout(page);
  ok(L.shown.length === 6 && !holes(L).length, `${tag} default grid: 6 cards, no empty cell ${holes(L).join('; ')}`);
  if (width < 768) ok(L.shown.every((c) => Math.abs(c.w - L.gridW) < 2), `${tag} one column`);
  const btnText = await page.locator('#widgets-open').innerText().catch(() => '');
  ok(/Widgets · 6/.test(btnText) || width < 600, `${tag} button reads "${btnText.replace(/\s+/g, ' ')}"`);

  // Hide each widget, check the grid, then hide a second alongside it, then show all again.
  const ids = L.order;
  await openWidgets(page);
  let holeFree = true, countsOk = true;
  for (const id of ids) {
    await rowBtn(page, id, '[data-act="show"]').click();
    await page.waitForTimeout(80);
    let M = await layout(page);
    if (holes(M).length || M.shown.some((c) => c.id === id)) { holeFree = false; console.log(`  hide ${id}: ${holes(M).join('; ')}`); }
    if (M.shown.length !== 5) countsOk = false;
    const other = ids[(ids.indexOf(id) + 2) % ids.length];
    await rowBtn(page, other, '[data-act="show"]').click();
    await page.waitForTimeout(80);
    M = await layout(page);
    if (holes(M).length) { holeFree = false; console.log(`  hide ${id}+${other}: ${holes(M).join('; ')}`); }
    if (M.shown.length !== 4) countsOk = false;
    await rowBtn(page, other, '[data-act="show"]').click();
    await rowBtn(page, id, '[data-act="show"]').click();
    await page.waitForTimeout(80);
  }
  ok(holeFree, `${tag} hiding each widget (alone and with a second) leaves no empty cell`);
  ok(countsOk && (await layout(page)).shown.length === 6, `${tag} hide and show by click change the shown count`);

  if (width >= 768) {
    // Full and Half on the first card.
    await rowBtn(page, 'hr', '[data-size="full"]').click();
    await page.waitForTimeout(150);
    let M = await layout(page);
    const hr = () => M.shown.find((c) => c.id === 'hr');
    ok(Math.abs(hr().w - M.gridW) < 2, `${tag} Full makes the card grid wide (${Math.round(hr().w)} of ${Math.round(M.gridW)})`);
    ok(!holes(M).length, `${tag} grid has no empty cell after Full ${holes(M).join('; ')}`);
    const canvasW = await page.evaluate(() => document.getElementById('all-morning-hr').getBoundingClientRect().width);
    await rowBtn(page, 'hr', '[data-size="half"]').click();
    await page.waitForTimeout(150);
    M = await layout(page);
    ok(Math.abs(hr().w - (M.gridW - M.gap) / 2) < 2, `${tag} Half makes the card half wide (${Math.round(hr().w)})`);
    const canvasW2 = await page.evaluate(() => document.getElementById('all-morning-hr').getBoundingClientRect().width);
    ok(canvasW2 < canvasW - 100, `${tag} the chart follows the size (${Math.round(canvasW)} to ${Math.round(canvasW2)})`);
  }

  // Move up and Move down.
  const before = (await layout(page)).order;
  const third = before[2];
  await rowBtn(page, third, '[data-act="up"]').click();
  let after = (await layout(page)).order;
  ok(after[1] === third && after[2] === before[1], `${tag} Move up reorders (${after.join(',')})`);
  ok(await page.evaluate(() => document.activeElement && /Move .* up/.test(document.activeElement.getAttribute('aria-label') || '')), `${tag} focus stays on Move up`);
  await rowBtn(page, before[0], '[data-act="down"]').click();
  after = (await layout(page)).order;
  ok(after[0] === third && after[1] === before[0], `${tag} Move down reorders (${after.join(',')})`);
  await closeWidgets(page);

  // Mouse drag by the header: first card onto the third card's spot.
  if (width >= 768) {
    const order0 = (await layout(page)).order;
    const src = page.locator(`.all-card[data-w="${order0[0]}"] .all-card-head`);
    const dst = page.locator(`.all-card[data-w="${order0[3]}"] .all-card-head`);
    await src.scrollIntoViewIfNeeded();
    const a = await src.boundingBox(), b = await dst.boundingBox();
    await page.mouse.move(a.x + 40, a.y + 10);
    await page.mouse.down();
    await page.mouse.move(a.x + 60, a.y + 30, { steps: 5 });
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 20 });
    await page.waitForTimeout(250);
    await page.mouse.up();
    await page.waitForTimeout(400);
    const order1 = (await layout(page)).order;
    ok(order1.join() !== order0.join() && order1.indexOf(order0[0]) > 0, `${tag} mouse drag of a header reorders (${order0.join(',')} to ${order1.join(',')})`);
  } else {
    const order0 = (await layout(page)).order;
    const src = page.locator(`.all-card[data-w="${order0[0]}"] .all-card-head`);
    const dst = page.locator(`.all-card[data-w="${order0[1]}"] .all-card-head`);
    // Touch: Sortable waits 150 ms on a touch before it picks up a card; a mouse drag does not wait.
    await src.scrollIntoViewIfNeeded();
    const a = await src.boundingBox(), b = await dst.boundingBox();
    await page.mouse.move(a.x + 40, a.y + 10);
    await page.mouse.down();
    await page.mouse.move(a.x + 50, a.y + 30, { steps: 5 });
    await page.mouse.move(b.x + b.width / 2, b.y + b.height - 4, { steps: 20 });
    await page.waitForTimeout(250);
    await page.mouse.up();
    await page.waitForTimeout(400);
    const order1 = (await layout(page)).order;
    ok(order1.join() !== order0.join(), `${tag} mouse drag of a header reorders (${order0.join(',')} to ${order1.join(',')})`);
  }

  // State for the reload: hide one, size one full.
  await openWidgets(page);
  const cur = (await layout(page)).order;
  const hideId = cur[cur.length - 1];
  await rowBtn(page, hideId, '[data-act="show"]').click();
  await rowBtn(page, 'rmssd', '[data-size="full"]').click();
  await closeWidgets(page);
  const want = await layout(page);
  const wantRm = await page.evaluate(() => document.querySelector('.all-card[data-w="rmssd"]').classList.contains('wide'));
  await page.reload({ waitUntil: 'networkidle' });
  await waitCards(page);
  const got = await layout(page);
  const gotRm = await page.evaluate(() => document.querySelector('.all-card[data-w="rmssd"]').classList.contains('wide'));
  ok(got.order.join() === want.order.join(), `${tag} reload keeps the order (${got.order.join(',')})`);
  ok(!got.shown.some((c) => c.id === hideId) && got.shown.length === 5, `${tag} reload keeps ${hideId} hidden`);
  ok(wantRm && gotRm, `${tag} reload keeps HRV average full width`);
  ok(!holes(got).length, `${tag} grid after reload has no empty cell ${holes(got).join('; ')}`);

  if (SHOTS) {
    await page.evaluate(() => { try { localStorage.removeItem('aorti_trends_layout_v1'); } catch (e) {} });
    await page.reload({ waitUntil: 'networkidle' });
    await waitCards(page);
    if (width >= 768) await openWidgets(page);
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(SHOTS, `s34-${width}-trends.png`), fullPage: width < 768 });
  }
  ok(!page.errors.length, `${tag} no page errors ${page.errors.join(' | ')}`);
  await ctx.close();
}

async function all() { for (const w of [1440, 360]) await run(w); }

if (args.includes('--mutants')) {
  const mutants = [
    ['layout not persisted', ["try { localStorage.setItem(TRENDS_LAYOUT_KEY", "try { void 0 && localStorage.setItem(TRENDS_LAYOUT_KEY"]],
    ['hidden widget keeps its cell', ['.all-card[hidden] { display: none; }', '.all-card[hidden] { visibility: hidden; }']],
  ];
  let survived = 0;
  for (const [name, m] of mutants) {
    MUTATE = m; anchorMissing = false; fails = 0; passes = 0;
    console.log(`--- mutant: ${name}`);
    await all();
    const caught = fails > 0 && !anchorMissing;
    if (!caught) survived++;
    console.log(`MUTANT ${name}: ${caught ? 'FAILED as it must (' + fails + ' fails)' : 'SURVIVED'}`);
  }
  await browser.close(); server.close();
  console.log(survived ? `${survived} mutant(s) survived` : 'all mutants failed as they must');
  process.exit(survived ? 1 : 0);
}
await all();
await browser.close(); server.close();
console.log(`\n${passes} passed, ${fails} failed`);
process.exit(fails ? 1 : 0);
