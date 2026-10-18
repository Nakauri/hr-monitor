// Guards: five stat-tile systems drifting apart (consistency audit 2026-10-14, Khal "so our components werent laid out nice and
// consistent?"), "—" read as "em dash" by screen readers, 10 px capital labels, the Summary title reading Duration while it is hidden.
// Files: ui.css (.kpi), ui.js (UI.kpi), hrv_viewer.html (Summary, cards, Week, Month), hr_monitor.html (Session stats). Runtime: about 40 s per part.
// --part static,day,cards,calendar,monitor,textcheck (default: all but textcheck); --mutants runs the negative controls, each must FAIL.
// Usage: node scripts/kpi-tiles.mjs [--part <list>] [--mutants [--only 0,1]] [--root <checkout>] [--shots <dir>] [--ux <ux-audit dir>] [--tc <pages>]
// --root serves another tree (default this checkout), so the base commit can be measured with this probe (textcheck baseline).
// Needs mobile/www from `npm run copy-web` for the monitor part.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { uxDir } from './ux-dir.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const argVal = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const ROOT = path.resolve(argVal('--root') || path.join(here, '..'));
const UX = uxDir(here, argVal('--ux'));
const SHOTS = argVal('--shots') ? path.resolve(argVal('--shots')) : null;
const CHART = path.join(UX, '..', 'docs', 'audit-2026-10-09', 'harness-DT', 'vendor', 'chart.umd.min.js');
const { fakeBridge } = await import(pathToFileURL(path.join(UX, 'scripts', 'fake-bridge.mjs')).href);
const { chromium } = createRequire(path.join(UX, 'kit', 'package.json'))('playwright');
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
const PART = argVal('--part');
const MUTANTS = args.includes('--mutants');
const want = (p) => (PART ? PART.split(',').includes(p) : p !== 'textcheck');
const DASH = String.fromCharCode(0x2014);
const BLANKED = 'hrv_session_2026-04-21T12-36-30.csv';

// MUTATE = [file, from, to]: the server and the static part both read that file with the swap applied.
let MUTATE = null;
let anchorMissing = false;
function readSrc(file) {
  let text = fs.readFileSync(path.join(ROOT, file), 'utf8').replace(/\r\n/g, '\n');
  if (MUTATE && MUTATE[0] === file) {
    if (!text.includes(MUTATE[1])) { anchorMissing = true; console.log('MUTANT ANCHOR MISSING: ' + MUTATE[1].slice(0, 70)); }
    text = text.replace(MUTATE[1], MUTATE[2]);
  }
  return text;
}
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png', '.woff2': 'font/woff2', '.csv': 'text/csv' };
const server = http.createServer((req, res) => {
  let rel = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  let base = ROOT;
  if (rel.startsWith('/www/')) { base = path.join(ROOT, 'mobile', 'www'); rel = rel.slice(4); }
  let file = path.join(base, rel);
  if (!fs.existsSync(file)) file = path.join(ROOT, rel);
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end(); return; }
  const type = MIME[path.extname(file)] || 'application/octet-stream';
  let body = fs.readFileSync(file);
  if (MUTATE && path.basename(file) === MUTATE[0] && path.dirname(rel) === '/') {
    let text = body.toString('utf8').replace(/\r\n/g, '\n');
    if (!text.includes(MUTATE[1])) { anchorMissing = true; console.log('MUTANT ANCHOR MISSING: ' + MUTATE[1].slice(0, 70)); }
    body = text.replace(MUTATE[1], MUTATE[2]);
  }
  res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(body);
});
await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
const BASE = `http://127.0.0.1:${server.address().port}`;

let fails = 0, passes = 0;
const ok = (cond, msg, detail) => { if (cond) { passes++; console.log('PASS ' + msg); } else { fails++; console.log('FAIL ' + msg + (detail ? ' :: ' + detail : '')); } };

let browser;
try { browser = await chromium.launch(); } catch (e) { browser = await chromium.launch({ channel: 'chrome' }); }

const blankRmssd = (csv) => csv.replace(/\r\n/g, '\n').split('\n').map((l, i) => { if (i === 0 || !l) return l; const c = l.split(','); if (c.length > 3) c[3] = ''; return c.join(','); }).join('\n');

// One fresh context per page and text scale (a second text scale on one page would re-test the first).
async function openViewer(width, hash, { scale = 1, init = [] } = {}) {
  const phone = width < 600;
  const ctx = await browser.newContext({ viewport: { width, height: phone ? 740 : 900 }, deviceScaleFactor: 1, isMobile: phone, hasTouch: phone, timezoneId: 'America/Edmonton' });
  await ctx.route('**/*', (route) => {
    const u = route.request().url();
    if (u.startsWith(BASE) && u.includes('/demo/' + BLANKED)) {
      return route.fulfill({ status: 200, contentType: 'text/csv', body: blankRmssd(fs.readFileSync(path.join(ROOT, 'demo', BLANKED), 'utf8')) });
    }
    if (u.startsWith(BASE) || u.startsWith('data:') || u.startsWith('blob:')) return route.continue();
    if (/chart\.umd(\.min)?\.js/.test(u)) return route.fulfill({ status: 200, contentType: 'text/javascript', body: fs.readFileSync(CHART) });
    if (/fonts\.(googleapis|gstatic)\.com|cdn\.jsdelivr\.net|cdnjs\.cloudflare\.com/.test(u)) return route.continue();
    return route.fulfill({ status: 204, body: '' });
  });
  await ctx.addInitScript(() => { window.print = () => {}; try { localStorage.removeItem('hrv_viewer_index'); } catch (e) {} });
  for (const s of init) await ctx.addInitScript(s);
  const page = await ctx.newPage();
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(e.message));
  await page.goto(`${BASE}/hrv_viewer.html?demo=1${hash}`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(600);
  if (scale !== 1) {
    await page.evaluate((f) => {
      const els = [...document.querySelectorAll('body, body *')].filter((e) => !(e instanceof SVGElement));
      const sizes = els.map((e) => parseFloat(getComputedStyle(e).fontSize));
      els.forEach((e, i) => e.style.setProperty('font-size', sizes[i] * f + 'px', 'important'));
      window.dispatchEvent(new Event('resize'));
    }, scale);
    await page.waitForTimeout(250);
  }
  return { ctx, page };
}
const lsInit = (k, v) => `try { localStorage.setItem(${JSON.stringify(k)}, ${JSON.stringify(v)}); } catch (e) {}`;
const shot = async (page, name, sel) => {
  if (!SHOTS) return;
  const p = path.join(SHOTS, name + '.png');
  if (sel) { const l = page.locator(sel).first(); if (await l.count()) await l.screenshot({ path: p }); }
  else await page.screenshot({ path: p, fullPage: true });
};

// In-page helpers, shared by the viewer and monitor parts.
const HELPERS = `(() => {
  window.__k = {
    dashNodes(root) { const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT); const out = []; let n;
      while ((n = w.nextNode())) if (n.textContent.includes(${JSON.stringify(DASH)})) out.push(n.textContent.trim().slice(0, 40)); return out; },
    capsLabel(el) { const t = el.textContent.trim(); const cs = getComputedStyle(el);
      return cs.textTransform !== 'none' || (t.replace(/[^A-Za-z]/g, '').length >= 5 && t === t.toUpperCase()); },
    colourOf(css) { const p = document.createElement('span'); p.style.color = css; document.body.appendChild(p); const c = getComputedStyle(p).color; p.remove(); return c; },
    faceOf(css) { const p = document.createElement('span'); p.style.fontFamily = css; document.body.appendChild(p); const c = getComputedStyle(p).fontFamily; p.remove(); return c; },
    textBox(el) { const r = document.createRange(); r.selectNodeContents(el); return r.getBoundingClientRect(); },
    shown(el) { if (!el) return false; const cs = getComputedStyle(el); if (cs.display === 'none') return false; const b = el.getBoundingClientRect(); return b.width > 0 && b.height > 0; },
  };
})();`;

// ---- static ----
function stripComments(s) {
  return s.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((l) => (/^\s*\/\//.test(l) ? '' : l.replace(/\s\/\/\s.*$/, ''))).join('\n');
}
function fnBody(src, name) {
  const m = new RegExp('(async\\s+)?function ' + name + '\\s*\\(').exec(src);
  if (!m) return null;
  let i = src.indexOf('{', m.index), depth = 0;
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') { depth--; if (depth === 0) return src.slice(i, j + 1); }
  }
  return null;
}
function styleText(html) { return [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join('\n'); }
function partStatic() {
  const viewer = readSrc('hrv_viewer.html'), monitor = readSrc('hr_monitor.html'), uiCss = readSrc('ui.css'), uiJs = readSrc('ui.js');
  const bodies = [];
  for (const n of ['renderIndex', 'renderDay', 'renderWeek', 'renderMonth', 'renderSession', 'computeHeadline', 'formatDuration', 'formatClockTime', 'drawSessionChart']) bodies.push(['hrv_viewer.html ' + n, fnBody(viewer, n)]);
  for (const n of ['updateStats', 'updateUptimeStat', 'renderEvents']) bodies.push(['hr_monitor.html ' + n, fnBody(monitor, n)]);
  const a = monitor.indexOf('<div class="section" data-section="stats">');
  bodies.push(['hr_monitor.html stats markup', a >= 0 ? monitor.slice(a, monitor.indexOf('<div class="section"', a + 10)) : null]);
  bodies.push(['ui.js kpi', fnBody(uiJs, 'kpi') && (fnBody(uiJs, 'kpi') + (uiJs.match(/const KPI_NODATA = [^\n]*/) || [''])[0])]);
  for (const [name, b] of bodies) {
    if (b == null) { ok(false, `static: ${name} found`); continue; }
    const s = stripComments(b);
    const hits = s.split('\n').filter((l) => l.includes(DASH) || l.includes('&mdash;'));
    ok(!hits.length, `static: ${name} has no dash placeholder`, hits.map((l) => l.trim().slice(0, 80)).join(' | '));
  }
  const RX = /\.(kpi|week-col-(hr|stat)|cal-hr|cal-session-count)[\w-]*/;
  for (const [file, css] of [['ui.css', uiCss], ['hrv_viewer.html', styleText(viewer)], ['hr_monitor.html', styleText(monitor)]]) {
    const caps = [...stripComments(css).matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter((m) => RX.test(m[1]) && /text-transform:\s*uppercase/.test(m[2])).map((m) => m[1].trim());
    ok(!caps.length, `static: ${file} no stat label rule sets uppercase`, caps.join(' | '));
    ok(!/'Arial Black'/.test(css), `static: ${file} no raw 'Arial Black' (uses --num-face)`);
  }
  const vStyle = styleText(viewer);
  const hex = ['#E8A858', '#85B7EB', '#B48CFF'].filter((h) => vStyle.toUpperCase().includes(h));
  ok(!hex.length, 'static: viewer <style> has no stray event hex (tokens instead)', hex.join(', '));
  const dead = ['.card.stats', '.all-headline', '.pots-'].filter((d) => uiCss.includes(d) || viewer.includes(d));
  ok(!dead.length, 'static: dead stat CSS removed (.card.stats, .all-headline, .pots-*)', dead.join(', '));
}

// ---- day ----
async function partDay() {
  for (const w of [1440, 360]) {
    const { ctx, page } = await openViewer(w, '#/day/2026-04-21');
    await page.waitForSelector('#summary-bar .kpi', { timeout: 20000 }).catch(() => {});
    await page.addScriptTag({ content: HELPERS });
    const r = await page.evaluate(() => {
      const bar = document.getElementById('summary-bar');
      if (!bar) return null;
      const tiles = [...bar.querySelectorAll('.kpi[data-stat]')];
      const shape = tiles.filter((t) => { const k = t.children; return !t.closest('dl.kpi-grid') || !k[0] || !k[0].matches('dt.kpi-label') || !k[1] || !k[1].matches('dd.kpi-value'); }).map((t) => t.dataset.stat);
      const caps = tiles.map((t) => t.querySelector('.kpi-label')).filter((l) => l && __k.capsLabel(l)).map((l) => l.textContent.trim());
      return { n: tiles.length, old: bar.querySelectorAll('.summary-stat').length, shape, caps, dash: __k.dashNodes(bar) };
    });
    if (!r) { ok(false, `day ${w}: Summary renders`); await ctx.close(); continue; }
    ok(r.n >= 10 && r.old === 0, `day ${w}: ${r.n} Summary tiles are .kpi, no .summary-stat (${r.old})`);
    ok(!r.shape.length, `day ${w}: every tile is dl.kpi-grid > div.kpi > dt.kpi-label + dd.kpi-value`, r.shape.join(', '));
    ok(!r.caps.length, `day ${w}: no label in capitals`, r.caps.join(', '));
    ok(!r.dash.length, `day ${w}: no dash text in the Summary`, r.dash.join(' | '));
    ok(!page.errors.length, `day ${w}: no page errors`, page.errors.join(' | '));
    await shot(page, `day-summary-${w}`, '#summary-bar');
    await ctx.close();
  }
}
async function partDayTitle() {
  for (const [hidden, label] of [[true, 'Duration hidden'], [false, 'default']]) {
    const init = hidden ? [lsInit('hrv_summary_hidden', '["duration","sdnn5minAvg","sdnnFull"]')] : [];
    const { ctx, page } = await openViewer(360, '#/day/2026-04-21', { init });
    await page.waitForSelector('#summary-toggle', { timeout: 20000 }).catch(() => {});
    const exact = await page.getByRole('button', { name: 'Summary', exact: true }).count();
    const name = await page.evaluate(() => { const b = document.getElementById('summary-toggle'); return b ? b.innerText + ' | ' + (b.getAttribute('aria-label') || '') : ''; });
    const full = await page.locator('#summary-toggle').evaluate((b) => b.textContent);
    if (hidden) ok(exact === 1, `day, title 360 (${label}): accessible name is exactly "Summary"`, name);
    else ok(exact === 0 && /duration/.test(full) && (await page.getByRole('button', { name: /^Summary duration / }).count()) === 1, `day, title 360 (${label}): name reads "Summary duration ..."`, name);
    await ctx.close();
  }
}

// ---- cards ----
const NEUTRAL = ['palpCount', 'warnCount', 'shifts', 'flushes', 'chills', 'uptime'];
async function readCards(page, unitsCheck) {
  await page.addScriptTag({ content: HELPERS });
  return page.evaluate(({ NEUTRAL, unitsCheck, BLANKED }) => {
    const text = __k.colourOf('var(--text)');
    const cards = [...document.querySelectorAll('.session-card')].filter((c) => __k.shown(c));
    const labelPx = (() => { const l = document.querySelector('.session-card .kpi-label'); return l ? parseFloat(getComputedStyle(l).fontSize) : null; })();
    return { labelPx, cards: cards.map((c) => {
      const dls = c.querySelectorAll('dl.kpi-grid.cols');
      const tiles = dls.length ? [...dls[0].children] : [];
      const tops = {}; tiles.forEach((t) => { const y = Math.round(t.getBoundingClientRect().top); tops[y] = (tops[y] || 0) + 1; });
      const rows = Object.keys(tops).sort((a, b) => a - b).map((k) => tops[k]);
      const unitLine = [];
      if (unitsCheck) for (const t of tiles) {
        const v = t.querySelector('.kpi-value'), u = t.querySelector('.kpi-unit');
        if (!v || !u || !__k.shown(u)) continue;
        const vb = __k.textBox(v), ub = __k.textBox(u);
        // Against the value's line box: the text range of a 900-weight face is taller than its line.
        if (vb.width + 4 + ub.width <= t.getBoundingClientRect().width && !(ub.top < v.getBoundingClientRect().bottom - 2)) unitLine.push(t.dataset.stat);
      }
      const blank = decodeURIComponent(c.dataset.filename || '').includes(BLANKED) ? (() => {
        const t = c.querySelector('[data-stat="rmssdAvg"]'); if (!t) return 'no tile';
        const nd = t.querySelector('.kpi-value .kpi-nodata'); const u = t.querySelector('.kpi-unit');
        return nd && nd.textContent.trim() === 'no data' && (!u || getComputedStyle(u).display === 'none') ? 'ok' : 'reads ' + t.querySelector('.kpi-value').textContent.trim() + (u ? ', unit ' + getComputedStyle(u).display : '');
      })() : null;
      return {
        file: decodeURIComponent(c.dataset.filename || '').slice(-23), dls: dls.length, n: tiles.length,
        allKpi: tiles.length > 0 && tiles.every((t) => t.matches('div.kpi.sm') && t.children[0] && t.children[0].matches('dt.kpi-label') && t.children[1] && t.children[1].matches('dd.kpi-value')),
        rows, overflow: tiles.filter((t) => t.scrollWidth > t.clientWidth + 1).map((t) => t.dataset.stat).concat(dls.length && dls[0].scrollWidth > dls[0].clientWidth + 1 ? ['grid'] : []),
        tinted: tiles.filter((t) => NEUTRAL.includes(t.dataset.stat)).filter((t) => getComputedStyle(t.querySelector('.kpi-value')).color !== text).map((t) => t.dataset.stat + ' ' + getComputedStyle(t.querySelector('.kpi-value')).color),
        caps: tiles.map((t) => t.querySelector('.kpi-label')).filter((l) => l && __k.capsLabel(l)).map((l) => l.textContent.trim()),
        dash: __k.dashNodes(c), unitLine, blank,
      };
    }) };
  }, { NEUTRAL, unitsCheck, BLANKED });
}
async function partCards() {
  const cases = [['Day, Autonomic on', '#/day/2026-04-21', '1'], ['Day, Autonomic off', '#/day/2026-04-21', '0'], ['All sessions', '#/index', null]];
  const sizes = [[1440, 1], [360, 1], [360, 1.3], [360, 1.5], [360, 2]];
  let blankSeen = false;
  const seen = new Set();
  for (const [label, hash, auto] of cases) {
    for (const [w, f] of sizes) {
      const init = auto == null ? [] : [lsInit('hrv_viewer_autonomic_on', auto)];
      const { ctx, page } = await openViewer(w, hash, { scale: f, init });
      await page.waitForSelector('.session-card', { timeout: 20000 }).catch(() => {});
      const tag = `cards ${label} ${w}${f !== 1 ? ' at ' + f + 'x' : ''}`;
      const r = await readCards(page, w === 360 && f === 1);
      if (!r.cards.length) { ok(false, `${tag}: session cards render`); await ctx.close(); continue; }
      ok(r.labelPx != null && Math.abs(r.labelPx - 12 * f) < 0.6, `${tag}: label text is ${12 * f} px (scale applied)`, String(r.labelPx));
      const bad = (k, fn) => r.cards.filter(fn).map((c) => c.file + ' ' + (k ? JSON.stringify(c[k]) : ''));
      ok(!bad(null, (c) => c.dls !== 1 || !c.allKpi).length, `${tag}: ${r.cards.length} cards, each one dl.kpi-grid.cols of .kpi.sm tiles`, bad('n', (c) => c.dls !== 1 || !c.allKpi).join(' | '));
      ok(!bad('rows', (c) => Math.max(...c.rows) - Math.min(...c.rows) > 1 || c.rows.join('+') === '3+3+1').length, `${tag}: rows balanced (${[...new Set(r.cards.map((c) => c.rows.join(' + ')))].join(', ')}), never 3 + 3 + 1`, bad('rows', (c) => Math.max(...c.rows) - Math.min(...c.rows) > 1 || c.rows.join('+') === '3+3+1').join(' | '));
      ok(!bad('overflow', (c) => c.overflow.length).length, `${tag}: no tile or tile row overflows`, bad('overflow', (c) => c.overflow.length).join(' | '));
      ok(!bad('tinted', (c) => c.tinted.length).length, `${tag}: count values are neutral (--text)`, bad('tinted', (c) => c.tinted.length).join(' | '));
      ok(!bad('caps', (c) => c.caps.length).length, `${tag}: no label in capitals`, bad('caps', (c) => c.caps.length).join(' | '));
      ok(!bad('dash', (c) => c.dash.length).length, `${tag}: no dash text in any card`, bad('dash', (c) => c.dash.length).join(' | '));
      if (w === 360 && f === 1) ok(!bad('unitLine', (c) => c.unitLine.length).length, `${tag}: units that fit sit on the value line`, bad('unitLine', (c) => c.unitLine.length).join(' | '));
      r.cards.forEach((c) => seen.add(c.file));
      const blanks = r.cards.filter((c) => c.blank != null);
      if (blanks.length) { blankSeen = true; ok(blanks.every((c) => c.blank === 'ok'), `${tag}: blanked recording's HRV reads "no data", unit hidden`, blanks.map((c) => c.blank).join(' | ')); }
      ok(!page.errors.length, `${tag}: no page errors`, page.errors.join(' | '));
      if (f === 1 || f === 2) await shot(page, `cards-${label.replace(/[^a-z]+/gi, '-').toLowerCase()}-${w}${f !== 1 ? '-' + f + 'x' : ''}`, auto == null ? '.sessions-grid, #view-index' : '.sessions-grid');
      await ctx.close();
    }
  }
  ok(blankSeen, 'cards: the blanked recording was found on at least one surface', [...seen].join(', '));
}

// ---- calendar ----
async function partCalendar() {
  const widths = [800, 900, 1440, 1536, 1920, 360];
  for (const view of ['week', 'month']) {
    for (const w of widths) {
      const hash = view === 'week' ? '#/week/2026-04-20' : '#/month/2026-04';
      const { ctx, page } = await openViewer(w, hash, { init: [lsInit('hrv_viewer_headline_metric', 'tachy')] });
      await page.waitForSelector(view === 'week' ? '.week-col' : '.cal-cell', { timeout: 20000 }).catch(() => {});
      await page.addScriptTag({ content: HELPERS });
      const r = await page.evaluate((view) => {
        const root = document.getElementById('view-' + view) || document.body;
        const face = __k.faceOf('var(--num-face)');
        const cells = [...root.querySelectorAll(view === 'week' ? '.week-col.has-sessions' : '.cal-cell.has-sessions')];
        const out = { n: cells.length, tint: [], face: [], above: [], caps: [], pct: [], over: [], dlShape: [], rows: [], dash: __k.dashNodes(root) };
        for (const c of cells) {
          const v = c.querySelector(view === 'week' ? '.week-col-hr' : '.cal-hr');
          const l = c.querySelector(view === 'week' ? '.week-col-hr-label' : '.cal-hr-label');
          const id = c.dataset.date;
          if (!v) { out.face.push(id + ' no value'); continue; }
          if (getComputedStyle(v).fontFamily !== face) out.face.push(id + ' ' + getComputedStyle(v).fontFamily);
          if (l && __k.shown(l) && l.getBoundingClientRect().bottom > v.getBoundingClientRect().top + 1) out.above.push(id);
          if (!l && view === 'week') out.above.push(id + ' no label');
          for (const e of [l, c.querySelector('.cal-session-count')]) if (e && __k.capsLabel(e)) out.caps.push(id + ' ' + e.textContent.trim());
          if (v.textContent.includes('%') && !v.querySelector('.kpi-pct')) out.pct.push(id);
          // Tachy is not an HR value, so it reads neutral (consistency review 2026-10-17 SHOULD 1).
          if (getComputedStyle(v).color !== __k.colourOf('var(--text)')) out.tint.push(id);
          const ov = [v, ...c.querySelectorAll('.week-col-stat, .week-col-stat dt, .week-col-stat dd')].filter((e) => __k.shown(e) && e.scrollWidth > e.clientWidth + 1);
          if (ov.length) out.over.push(id + ' ' + ov.map((e) => e.className || e.tagName).join(','));
          if (view === 'week') {
            const dl = c.querySelector('.week-col-stats');
            const dts = dl ? [...dl.querySelectorAll('dt')] : [];
            if (!dl || dl.tagName !== 'DL' || dts.length !== 4 || dts.some((d) => !/^[A-Z][a-z]+$/.test(d.textContent.trim()))) out.dlShape.push(id + ' ' + (dl ? dl.tagName + ' ' + dts.map((d) => d.textContent).join('/') : 'none'));
            const tops = {}; dl && [...dl.children].forEach((s) => { const y = Math.round(s.getBoundingClientRect().top); tops[y] = (tops[y] || 0) + 1; });
            out.rows.push(Object.values(tops).join('+'));
          }
        }
        return out;
      }, view);
      const tag = `calendar ${view} ${w}`;
      ok(r.n > 0, `${tag}: ${r.n} days with sessions render`);
      ok(!r.face.length, `${tag}: headline values use --num-face`, r.face.slice(0, 3).join(' | '));
      ok(!r.above.length, `${tag}: label sits above the value`, r.above.slice(0, 3).join(' | '));
      ok(!r.caps.length, `${tag}: labels and session counts not in capitals`, r.caps.slice(0, 3).join(' | '));
      ok(!r.pct.length, `${tag}: % is the shared .kpi-pct`, r.pct.join(', '));
      ok(!r.tint.length, `${tag}: Tachy headline is neutral (--text)`, r.tint.slice(0, 3).join(', '));
      ok(!r.dash.length, `${tag}: no dash text`, r.dash.join(' | '));
      ok(!r.over.length, `${tag}: no headline or mini stat overflows`, r.over.slice(0, 3).join(' | '));
      if (view === 'week') {
        const want = w >= 769 && w <= 1199 ? '1+1+1+1' : '2+2';
        ok(!r.dlShape.length, `${tag}: mini stats are a dl with sentence-case terms`, r.dlShape.slice(0, 2).join(' | '));
        ok(r.rows.every((x) => x === want), `${tag}: mini stats in rows of ${want}`, [...new Set(r.rows)].join(', '));
      }
      ok(!page.errors.length, `${tag}: no page errors`, page.errors.join(' | '));
      if ([360, 1440].includes(w) || (view === 'week' && [900, 1536].includes(w))) await shot(page, `${view}-${w}`, view === 'week' ? '.week-grid' : '.cal-grid');
      await ctx.close();
    }
  }
}

// ---- monitor ----
async function openMonitor(scenario, width) {
  const phone = width < 600;
  const ctx = await browser.newContext({ viewport: { width, height: phone ? 740 : 900 }, deviceScaleFactor: 1, isMobile: phone, hasTouch: phone });
  await ctx.route('**/*', (route) => {
    const u = route.request().url();
    if (/chart\.umd(\.min)?\.js/.test(u) && !u.startsWith(BASE)) return route.fulfill({ status: 200, contentType: 'text/javascript', body: fs.readFileSync(CHART) });
    if (/googleapis\.com\/(drive|upload)\//.test(u)) return route.fulfill({ status: 200, contentType: 'application/json', body: '{"files":[],"id":"fake-folder"}' });
    if (u.startsWith(BASE) || /fonts\.(googleapis|gstatic)\.com/.test(u) || u.startsWith('data:') || u.startsWith('blob:')) return route.continue();
    const js = /\.js(\?|$)/.test(u) || route.request().resourceType() === 'script';
    return route.fulfill({ status: js ? 200 : 204, contentType: js ? 'text/javascript' : 'text/plain', body: '' });
  });
  await ctx.addInitScript(fakeBridge({ scenario, savedStrap: true, signedIn: true, sessionAgeMs: 10 * 60000 }));
  const page = await ctx.newPage();
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(e.message));
  await page.goto(`${BASE}/www/hr_monitor.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);
  const head = page.locator('[data-section="stats"] .section-header');
  if (await head.count() && (await head.getAttribute('aria-expanded')) === 'false') { await head.click(); await page.waitForTimeout(300); }
  return { ctx, page };
}
async function partMonitor() {
  const www = path.join(ROOT, 'mobile', 'www');
  for (const f of ['hr_monitor.html', 'ui.css', 'ui.js']) {
    const a = path.join(www, f);
    const stale = !fs.existsSync(a) || (f !== 'hr_monitor.html' && fs.readFileSync(a, 'utf8') !== fs.readFileSync(path.join(ROOT, f), 'utf8')) || (f === 'hr_monitor.html' && !fs.readFileSync(a, 'utf8').includes('id="stats-grid"'));
    if (stale) { ok(false, `monitor: mobile/www/${f} is current (run npm run copy-web in mobile)`); return; }
  }
  for (const w of [1440, 360]) {
    {
      const { ctx, page } = await openMonitor('idle', w);
      await page.addScriptTag({ content: HELPERS });
      const r = await page.evaluate(() => {
        const sec = document.querySelector('[data-section="stats"]');
        if (!sec) return null;
        const tiles = [...sec.querySelectorAll('.kpi.sm')];
        const by = (k) => sec.querySelector(`.kpi[data-stat="${k}"]`);
        const nodata = ['hrAvg', 'rmssdAvg', 'hrMax', 'hrMin', 'palpRate', 'palpCount', 'warnCount', 'uptime'].filter((k) => { const t = by(k); if (!t) return true;
          const nd = t.querySelector('.kpi-value .kpi-nodata'); const u = t.querySelector('.kpi-unit');
          return !(nd && nd.textContent.trim() === 'no data' && (!u || getComputedStyle(u).display === 'none')); });
        const labels = tiles.map((t) => (t.querySelector('.kpi-label') || {}).textContent || '');
        const shape = tiles.filter((t) => !t.closest('dl.kpi-grid') || !t.children[0].matches('dt.kpi-label') || !t.children[1].matches('dd.kpi-value')).length;
        const caps = tiles.map((t) => t.querySelector('.kpi-label')).filter((l) => l && __k.capsLabel(l)).map((l) => l.textContent);
        return { n: tiles.length, nodata, labels, shape, caps, dash: __k.dashNodes(sec) };
      });
      const tag = `monitor idle ${w}`;
      if (!r) { ok(false, `${tag}: Session stats renders`); await ctx.close(); continue; }
      ok(r.n === 8 && !r.shape, `${tag}: 8 .kpi.sm tiles in dl.kpi-grid with dt + dd`, `${r.n} tiles, ${r.shape} malformed`);
      ok(!r.nodata.length, `${tag}: all 8 values read "no data" before a session starts, units hidden`, r.nodata.join(', '));
      ok(r.labels.includes('Avg HRV') && !r.labels.includes('Avg RMSSD'), `${tag}: label says Avg HRV, not Avg RMSSD`, r.labels.join('/'));
      ok(!r.caps.length, `${tag}: no label in capitals`, r.caps.join(', '));
      ok(!r.dash.length, `${tag}: no dash text in the section`, r.dash.join(' | '));
      ok(!page.errors.length, `${tag}: no page errors`, page.errors.join(' | '));
      await shot(page, `monitor-idle-${w}`, '[data-section="stats"]');
      await ctx.close();
    }
    {
      const { ctx, page } = await openMonitor('live', w);
      await page.waitForFunction(() => /^\d+$/.test((document.getElementById('avg-hr') || {}).textContent || ''), null, { timeout: 10000 }).catch(() => {});
      await page.addScriptTag({ content: HELPERS });
      const r = await page.evaluate(() => {
        const v = document.getElementById('avg-hr'); const t = v && v.closest('.kpi'); const u = t && t.querySelector('.kpi-unit');
        const vb = v ? __k.textBox(v) : null, ub = u ? __k.textBox(u) : null;
        return { text: v ? v.textContent : null, cls: v ? v.className : '', unitOnLine: vb && ub ? ub.top < v.getBoundingClientRect().bottom - 2 : null, dash: __k.dashNodes(document.querySelector('[data-section="stats"]')) };
      });
      const tag = `monitor live ${w}`;
      ok(/^\d+$/.test(r.text || '') && /\bstage-\w+/.test(r.cls), `${tag}: Avg HR is digits with a stage colour class`, `${r.text} [${r.cls}]`);
      if (w === 360) ok(r.unitOnLine === true, `${tag}: "bpm" sits on the value line`, String(r.unitOnLine));
      ok(!r.dash.length, `${tag}: no dash text in the section`, r.dash.join(' | '));
      ok(!page.errors.length, `${tag}: no page errors`, page.errors.join(' | '));
      await shot(page, `monitor-live-${w}`, '[data-section="stats"]');
      await ctx.close();
    }
  }
}

// ---- textcheck ----
// Async on purpose: a sync child would block this process's server. --tc day,week,month,index,monitor picks pages (default all).
async function partTextcheck() {
  const tc = path.join(os.homedir(), '.claude', 'kit', 'textcheck', 'textcheck.mjs');
  const PAGES = { day: '/hrv_viewer.html?demo=1#/day/2026-04-21', week: '/hrv_viewer.html?demo=1#/week/2026-04-20', month: '/hrv_viewer.html?demo=1#/month/2026-04', index: '/hrv_viewer.html?demo=1#/index', monitor: '/hr_monitor.html' };
  const pick = (argVal('--tc') || Object.keys(PAGES).join(',')).split(',');
  const urls = pick.map((k) => BASE + PAGES[k]);
  // textcheck waits 400 ms after load; the demo data needs longer, so the state waits for rendered sessions (both class sets).
  const READY = "new Promise((r) => { const t0 = Date.now(); (function w() { if (document.querySelector('.session-card, .week-col.has-sessions, .cal-cell.has-sessions, [data-section=stats]') || Date.now() - t0 > 10000) setTimeout(r, 600); else setTimeout(w, 100); })(); })";
  const { out, code } = await new Promise((done) => execFile('node', [tc, ...urls, '--widths', '1440,430', '--expand', '--state', READY], { encoding: 'utf8', maxBuffer: 16 << 20, timeout: 165000 },
    (e, stdout, stderr) => done({ out: (stdout || '') + (stderr || ''), code: e ? (e.code == null || typeof e.code !== 'number' ? 1 : e.code) : 0 })));
  console.log(out.trim());
  console.log(`textcheck exit ${code} (root ${ROOT}, pages ${pick.join(',')})`);
}

const RUN = { static: partStatic, day: async () => { await partDay(); await partDayTitle(); }, cards: partCards, calendar: partCalendar, monitor: partMonitor };
const runPart = async (p) => { try { await RUN[p](); } catch (e) { ok(false, `${p} threw: ${String(e.message).split('\n')[0]}`); } };

if (MUTANTS) {
  const M = [
    ['ui.js', 'return KPI_NODATA;', "return '" + DASH + "';", ['static', 'cards']],
    ['ui.css', '.kpi-label { margin: 0;', '.kpi-label { text-transform: uppercase; margin: 0;', ['day']],
    ['ui.css', '  .kpi { flex-direction: row; flex-wrap: wrap;', '  .kpi { flex-direction: column; flex-wrap: wrap;', ['cards', 'monitor']],
    ['hrv_viewer.html', '                  <div class="week-col-hr-label">${escape(headline.label || \'HR\')}</div>\n                  <div class="week-col-hr"${headlineStyle(headline) ? ` style="${headlineStyle(headline)}"` : \'\'}>${headlineValue(headline)}</div>',
      '                  <div class="week-col-hr"${headlineStyle(headline) ? ` style="${headlineStyle(headline)}"` : \'\'}>${headlineValue(headline)}</div>\n                  <div class="week-col-hr-label">${escape(headline.label || \'HR\')}</div>', ['calendar']],
    ['hrv_viewer.html', 'aria-controls="summary-grid">', 'aria-controls="summary-grid" aria-label="Summary, duration ${dur}">', ['day']],
    ['hrv_viewer.html', "${kpiTile('palpCount', 'Palps', UI.kpi(s.palpCount), '', { sm: true })}", "${kpiTile('palpCount', 'Palps', UI.kpi(s.palpCount), '', { sm: true, style: 'color: var(--warn-palp);' })}", ['cards']],
    ['ui.js', '`<div class="kpi${o.sm ? \' sm\' : \'\'}" ', '`<div class="${o.sm ? \'session-card-stat\' : \'kpi\'}" ', ['cards']],
    ['hr_monitor.html', "el.className = 'kpi-value' + (v != null ? ' ' + getHRStage(v) : '');", "el.className = 'kpi-value';", ['monitor']],
    ['hrv_viewer.html', '@container (max-width: calc(18em + 36px)) { .session-card .kpi-grid[data-n="7"] { --kpi-cols: 2; } }', '@container (max-width: calc(18em + 36px)) { .session-card .kpi-grid[data-n="7"] { --kpi-cols: 4; } }', ['cards']],
  ];
  const only = argVal('--only') ? argVal('--only').split(',').map(Number) : null;
  const pick = M.map((m, i) => [i, m]).filter(([i]) => !only || only.includes(i));
  // A mutant counts only against a part that passes unmutated in this run.
  const clean = {};
  for (const p of [...new Set(pick.flatMap(([, m]) => m[3]))]) { const before = fails; console.log(`-- baseline: ${p}`); await runPart(p); clean[p] = fails === before; }
  const results = [];
  for (const [i, [file, from, to, parts]] of pick) {
    for (const p of parts) {
      MUTATE = [file, from, to]; anchorMissing = false;
      const before = fails;
      console.log(`-- mutant ${i + 1} (${file}) against ${p}`);
      await runPart(p);
      results.push([`mutant ${i + 1} ${file} "${from.slice(0, 40)}" fails ${p}`, clean[p] && !anchorMissing && fails > before, clean[p] ? (anchorMissing ? 'anchor missing' : 'NOT CAUGHT') : 'part fails unmutated']);
    }
  }
  MUTATE = null;
  fails = 0; passes = 0;
  console.log('== mutant results');
  for (const [name, killed, why] of results) ok(killed, name + (killed ? ': FAILED as required' : ''), killed ? '' : why);
} else {
  for (const p of ['static', 'day', 'cards', 'calendar', 'monitor']) if (want(p)) { console.log(`-- ${p}`); await runPart(p); }
  if (want('textcheck')) { console.log('-- textcheck'); await partTextcheck(); }
}
await browser.close();
server.close();
console.log(fails ? `kpi-tiles: ${fails} failed, ${passes} passed` : `kpi-tiles: all ${passes} passed`);
process.exit(fails ? 1 : 0);
