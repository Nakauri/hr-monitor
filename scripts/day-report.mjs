// Guards: Khal 2026-10-12 "since the share with your doctor button is so big now, i'd like us to get the reports in order",
// and the old page-print bug "Share prints the page in an ugly manner" (2026-10-12): Share printed the whole viewer page.
// Files: hrv_viewer.html (Share menu, Day report), report.css, mobile/scripts/copy-web.js; reads mobile/src/native-pdf.js.
// Runtime about 20 s; --mutants adds about 4 s.
// S44 Day report and Share menu, headless, on the demo showcase day and one sparse day:
// 1. Menu: opens by a real click and by the keyboard (Enter, arrows), Escape closes it and focus returns to Share;
//    the phone opens it as a sheet; menu items keep 4.5:1 text contrast plain, hovered and focused.
// 2. Paper: every page is US Letter portrait, page 1 content never reaches the footer, no page runs past its edge or
//    right margin; footers read "Page i of N"; N equals the count the menu shows and the PDF's page count.
// 3. Moment numbers: every page number on page 1 leads to a page holding that moment, and every moment page's moments
//    are on page 1 with that page number.
// 4. Type: captions at 7 pt or more, body 9 pt; forbidden words 0; no paragraph or cell ends on one word alone.
// 5. Digits centred in every moment circle within 0.5 px (mocks/report-centre.mjs, measured from pixels at 3x).
// 6. App path (fake bridge): Share report calls printPdf with N pages of 1224 x 1584 PNG and the promise settles; a
//    rejected call shows a notice and clears the report (the app WebView ignores print).
// 7. Save to phone (S48, fake bridge; guards a save that never settles and leaves Share busy, and a missing or wrong notice): the app menu shows "Save to phone" then "Share report"; Save calls savePdf with
//    N pages and no share flag, and settles for saved ("Saved" notice), cancelled (no notice) and failed (plain notice).
// --mutants: page 1 one row over the footer, and a menu count off by one; each must FAIL.
// Usage: node scripts/day-report.mjs [--mutants] [--ux <ux-audit dir>] [--shots]
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { uxDir } from './ux-dir.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const argVal = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const ROOT = path.resolve(here, '..');
const UX = uxDir(here, argVal('--ux'));
const MUTANTS = args.includes('--mutants');
const SHOTS = args.includes('--shots');
const CHART = path.join(UX, '..', 'docs', 'audit-2026-10-09', 'harness-DT', 'vendor', 'chart.umd.min.js');
const { chromium } = createRequire(path.join(UX, 'kit', 'package.json'))('playwright');
const { fakeBridge } = await import(pathToFileURL(path.join(UX, 'scripts', 'fake-bridge.mjs')).href);
const VIEWER = fs.readFileSync(path.join(ROOT, 'hrv_viewer.html'), 'utf8');
const NATIVE_PDF = fs.readFileSync(path.join(ROOT, 'mobile', 'src', 'native-pdf.js'), 'utf8');
const SHOT_DIR = path.join(UX, 'redesign', 'build-shots');
const DAYS = [['showcase', '2026-04-24'], ['sparse', '2026-04-26']];
// S61 adds the moment words (stood up, standing up, exercise, tachycardia, orthostatic, episode); POTS only in the footnote.
const FORBIDDEN = [/\bcase\b/i, /\bevidence\b/i, /\bflare/i, /diagnos/i, /sympathetic/i, /\bclinician/i, /\binterpretations? are estimate/i, /\bdisorder\b/i, /\babnormal/i, /stood up/i, /standing up/i, /\bexercise/i, /tachycardia/i, /orthostatic/i, /\bepisode/i];
const FORBIDDEN_CASE = [/\bPOTS\b/];
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png', '.woff2': 'font/woff2', '.csv': 'text/csv' };

function serve(viewerHtml) {
  const server = http.createServer((req, res) => {
    const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (rel === '/hrv_viewer.html') { res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' }); res.end(viewerHtml); return; }
    const file = path.join(ROOT, rel);
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(fs.readFileSync(file));
  });
  return new Promise((ok) => server.listen(0, '127.0.0.1', () => ok({ server, base: `http://127.0.0.1:${server.address().port}` })));
}

let browser;
try { browser = await chromium.launch(); } catch (e) { browser = await chromium.launch({ channel: 'chrome' }); }

async function openDay(base, iso, o = {}) {
  const width = o.width || 1440, phone = width < 600;
  const ctx = await browser.newContext({ viewport: { width, height: phone ? 740 : 900 }, deviceScaleFactor: o.dpr || 1, isMobile: phone, hasTouch: phone, timezoneId: 'America/Edmonton' });
  await ctx.route('**/*', (route) => {
    const u = route.request().url();
    if (u.startsWith('http://127.0.0.1:') || u.startsWith('data:') || u.startsWith('blob:')) return route.continue();
    if (/chart\.umd(\.min)?\.js/.test(u)) return route.fulfill({ status: 200, contentType: 'text/javascript', body: fs.readFileSync(CHART) });
    if (/fonts\.(googleapis|gstatic)\.com|cdn\.jsdelivr\.net|cdnjs\.cloudflare\.com/.test(u)) return route.continue();
    return route.fulfill({ status: 204, body: '' });
  });
  if (o.app) {
    await ctx.addInitScript(fakeBridge({ scenario: 'idle' }));
    await ctx.addInitScript(NATIVE_PDF);
    await ctx.addInitScript(({ reject, saveMode }) => {
      window.__pdfCalls = []; window.__printCalls = 0; window.__saveCalls = [];
      window.print = () => { window.__printCalls++; };
      const install = () => {
        const p = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.NativeHrSession;
        if (!p) return setTimeout(install, 0);
        p.printPdf = (a) => {
          const call = { pages: a.pages.length, moments: a.moments, week: a.week, share: a.share, filename: a.filename, images: a.pages.map((x) => x.image), landscape: a.pages.map((x) => x.landscape), settled: null };
          window.__pdfCalls.push(call);
          return new Promise((ok, no) => setTimeout(() => { call.settled = reject ? 'rejected' : 'resolved'; reject ? no(new Error('pdf_low_memory')) : ok({ uri: 'content://x/aorti.pdf', pages: a.pages.length, shared: true }); }, 50));
        };
        // S48 Save to phone: one fake mode per run, the three ways the native call settles.
        p.savePdf = (a) => {
          const call = { pages: a.pages.length, moments: a.moments, week: a.week, share: a.share, filename: a.filename, images: a.pages.map((x) => x.image), landscape: a.pages.map((x) => x.landscape), settled: null };
          window.__saveCalls.push(call);
          return new Promise((ok, no) => setTimeout(() => {
            call.settled = saveMode === 'failed' ? 'rejected' : 'resolved';
            if (saveMode === 'failed') no(new Error('pdf_save_failed'));
            else if (saveMode === 'cancelled') ok({ saved: false, cancelled: true });
            else ok({ saved: true, name: a.filename });
          }, 50));
        };
      };
      install();
    }, { reject: !!o.reject, saveMode: o.saveMode || 'saved' });
  }
  const page = await ctx.newPage();
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(e.message));
  await page.goto(base + '/hrv_viewer.html?demo=1#/day/' + iso, { waitUntil: 'networkidle' });
  await page.waitForSelector('#view-day #session-chart', { timeout: 40000 }).catch(() => {});
  await page.evaluate(async () => { await Promise.all(["400 12px 'Work Sans'", "500 12px 'Work Sans'", "600 12px 'Work Sans'"].map((f) => document.fonts.load(f))); await document.fonts.ready; });
  await page.waitForTimeout(300);
  return { ctx, page };
}

let fails = 0;
const failed = [];
function checkOut(name, ok, detail) { return check(name, ok, detail); }
function check(name, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
  if (!ok) { fails++; failed.push(name); }
  return ok;
}

// ---------- in-page measures ----------
const MEASURE_PAGES = () => [...document.querySelectorAll('#report-print .page')].map((pg) => {
  const pr = pg.getBoundingClientRect(), foot = pg.querySelector('.foot'), fr = foot.getBoundingClientRect();
  let bottom = 0, right = 0, worst = '';
  pg.querySelectorAll('*').forEach((el) => {
    if (foot.contains(el)) return;
    const r = el.getBoundingClientRect(); if (!r.width && !r.height) return;
    if (r.bottom - pr.top > bottom) { bottom = r.bottom - pr.top; worst = el.tagName + ' ' + (el.textContent || '').trim().slice(0, 30); }
    right = Math.max(right, r.right - pr.left);
  });
  return { id: pg.id, w: Math.round(pr.width), h: Math.round(pr.height), room: Math.round(fr.top - bottom - pr.top), footBottom: Math.round(fr.bottom - pr.top), scrollH: pg.scrollHeight, right: Math.round(right), worst, footText: foot.querySelector('.bar b').textContent };
});
function paperChecks(tag, res, quiet) {
  let ok = true;
  const check = quiet ? (n, v) => v : checkOut;
  res.forEach((r, i) => {
    if (r.w !== 816 || r.h !== 1056) ok = check(`${tag} p${i + 1} is US Letter portrait`, false, `${r.w}x${r.h}`) && ok;
    if (r.room < 8) ok = check(`${tag} p${i + 1} content stays clear of the footer`, false, `room ${r.room} px, last ${r.worst}`) && ok;
    if (r.footBottom > 1056 || r.scrollH > 1056) ok = check(`${tag} p${i + 1} inside the page`, false, `foot ${r.footBottom}, scroll ${r.scrollH}`) && ok;
    if (r.right > 816 - 63) ok = check(`${tag} p${i + 1} inside the right margin`, false, `right ${r.right}`) && ok;
    if (r.footText !== `Page ${i + 1} of ${res.length}`) ok = check(`${tag} p${i + 1} footer`, false, `"${r.footText}"`) && ok;
  });
  return ok;
}

async function openMenuByClick(page) {
  await page.click('#export-report');
  await page.waitForSelector('#share-menu [role="menuitem"]', { timeout: 10000 });
  return page.evaluate(() => {
    const c = document.querySelector('#share-menu .share-menu-count');
    return { count: c ? +c.dataset.pages : null, text: c ? c.textContent : '', items: [...document.querySelectorAll('#share-menu [role="menuitem"]')].map((b) => b.textContent.trim()),
      expanded: document.getElementById('export-report').getAttribute('aria-expanded'), focus: document.activeElement && document.activeElement.getAttribute('role') };
  });
}

// ---------- 1 to 5: per day, web ----------
async function webDay(base, label, iso, o = {}) {
  const { ctx, page } = await openDay(base, iso);
  const tag = `${label} ${iso}`;
  // Menu by click.
  const m = await openMenuByClick(page);
  check(`${tag} menu opens by click`, m.expanded === 'true' && m.focus === 'menuitem' && m.items.length === 1 && /Download report \(PDF\)/.test(m.items[0]), JSON.stringify(m.items));
  check(`${tag} menu shows the page count`, m.count > 0 && m.text === `${m.count} page${m.count === 1 ? '' : 's'}`, m.text);
  // Item contrast plain, hovered, focused.
  const contrast = [];
  for (const st of ['plain', 'hover', 'focus']) {
    if (st === 'hover') await page.hover('#share-menu [role="menuitem"]');
    if (st === 'focus') { await page.mouse.move(0, 0); await page.focus('#share-menu [role="menuitem"]'); }
    contrast.push(await page.evaluate((st) => {
      const el = document.querySelector('#share-menu [role="menuitem"]');
      const parse = (c) => { const v = /rgba?\(([^)]+)\)/.exec(c || ''); if (!v) return null; const p = v[1].split(/[\s,/]+/).filter(Boolean).map(parseFloat); return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1]; };
      const chain = []; for (let n = el; n && n.nodeType === 1; n = n.parentElement) { const c = parse(getComputedStyle(n).backgroundColor); if (c && c[3] > 0) { chain.push(c); if (c[3] >= 1) break; } }
      let bg = [10, 10, 10]; for (let i = chain.length - 1; i >= 0; i--) { const c = chain[i]; bg = [0, 1, 2].map((k) => c[k] * c[3] + bg[k] * (1 - c[3])); }
      const fg = parse(getComputedStyle(el.querySelector('span')).color);
      const L = (rgb) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(rgb[0]) + 0.7152 * f(rgb[1]) + 0.0722 * f(rgb[2]); };
      const tx = [0, 1, 2].map((k) => fg[k] * fg[3] + bg[k] * (1 - fg[3]));
      const a = L(tx), b = L(bg);
      return { st, ratio: +((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)).toFixed(2) };
    }, st));
  }
  check(`${tag} menu item text 4.5:1 plain, hovered, focused`, contrast.every((c) => c.ratio >= 4.5), contrast.map((c) => c.st + ' ' + c.ratio).join(', '));
  await page.keyboard.press('Escape');
  const esc = await page.evaluate(() => ({ gone: !document.getElementById('share-menu'), focus: document.activeElement && document.activeElement.id, expanded: document.getElementById('export-report').getAttribute('aria-expanded') }));
  check(`${tag} Escape closes the menu, focus back on Share`, esc.gone && esc.focus === 'export-report' && esc.expanded === 'false', JSON.stringify(esc));
  // Menu by keyboard.
  await page.focus('#export-report');
  await page.keyboard.press('Enter');
  await page.waitForSelector('#share-menu [role="menuitem"]', { timeout: 10000 }).catch(() => {});
  await page.keyboard.press('ArrowDown');
  const kb = await page.evaluate(() => ({ open: !!document.getElementById('share-menu'), focus: document.activeElement && document.activeElement.getAttribute('role') }));
  await page.keyboard.press('Escape');
  check(`${tag} menu opens by keyboard, arrows keep focus on items`, kb.open && kb.focus === 'menuitem', JSON.stringify(kb));
  // Download: the item builds the report, then calls print with the print view on.
  await page.evaluate(() => { window.__printed = []; window.print = () => { window.__printed.push({ cls: document.body.classList.contains('rpt-printing'), pages: document.querySelectorAll('#report-print .page').length, title: document.title }); }; });
  await openMenuByClick(page);
  await page.click('#share-menu [data-act="download"]');
  await page.waitForFunction(() => window.__printed.length > 0, null, { timeout: 15000 }).catch(() => {});
  const pr = await page.evaluate(() => window.__printed[0] || null);
  check(`${tag} Download calls print once the report is ready`, !!pr && pr.cls && pr.pages === m.count && /day report/.test(pr.title), JSON.stringify(pr));

  // Paper.
  const res = await page.evaluate(MEASURE_PAGES);
  console.log(`      ${tag}: ${res.length} pages; page 1 room ${res[0] && res[0].room} px`);
  check(`${tag} page count equals the menu count`, res.length === m.count, `${res.length} vs ${m.count}`);
  check(`${tag} pages fit (Letter, footer clear, margins, footers)`, paperChecks(tag, res));
  const nums = await page.evaluate(() => {
    const idx = [...document.querySelectorAll('#rpg1 table.idx tbody tr')].map((tr) => ({ n: +tr.querySelector('svg.mn text').textContent, page: tr.querySelector('.pg a') ? +tr.querySelector('.pg a').textContent : null }));
    const onPages = [...document.querySelectorAll('#report-print .page')].slice(1).flatMap((pg, i) => [...pg.querySelectorAll('.moment')].map((mo) => ({ n: +mo.dataset.n, page: i + 2, head: +mo.querySelector('.mhead svg.mn text').textContent })));
    const chart = [...document.querySelectorAll('#rpg1 .chart circle.mc')].map((c) => +c.nextElementSibling.textContent).sort((a, b) => a - b);
    return { idx, onPages, chart };
  });
  const linked = nums.idx.filter((r) => r.page);
  const okLinks = linked.every((r) => nums.onPages.some((p) => p.n === r.n && p.page === r.page)) && nums.onPages.every((p) => p.head === p.n && linked.some((r) => r.n === p.n && r.page === p.page));
  const okChart = JSON.stringify(nums.chart) === JSON.stringify(nums.idx.map((r) => r.n).sort((a, b) => a - b));
  check(`${tag} moment numbers on page 1 match their pages`, okLinks && okChart && nums.onPages.length <= 6, `${linked.length} linked, ${nums.onPages.length} on pages, chart ${nums.chart.join(',')}`);
  // S62 (Khal 10-18, half-width "Whole day" table): Summary is one full-width row of figures, each on one line.
  const sum = await page.evaluate(() => {
    const t = document.querySelector('#rpg1 table.sum'); if (!t) return null;
    const lines = (el) => { const r = document.createRange(); r.selectNodeContents(el); return new Set([...r.getClientRects()].map((x) => Math.round(x.top))).size; };
    return { labels: [...t.querySelectorAll('th')].map((th) => th.textContent.trim()), rows: t.querySelectorAll('tbody tr').length,
      w: Math.round(t.getBoundingClientRect().width), sec: Math.round(t.previousElementSibling.getBoundingClientRect().width), lines: [...t.querySelectorAll('th')].map(lines).concat([...t.querySelectorAll('td')].map((td) => getComputedStyle(td).whiteSpace === 'nowrap' && td.scrollWidth <= td.clientWidth ? 1 : 2)) };
  });
  check(`${tag} Summary one full-width row of figures`, !!sum && sum.rows === 1 && sum.labels[0] === 'Recorded' && sum.labels.length === 5 && Math.abs(sum.w - sum.sec) <= 1 && sum.lines.every((n) => n === 1), JSON.stringify(sum));
  // Type sizes.
  const type = await page.evaluate(() => {
    const small = [], pt = (px) => +(px * 0.75).toFixed(2);
    const w = document.createTreeWalker(document.getElementById('report-print'), NodeFilter.SHOW_TEXT); let n;
    while ((n = w.nextNode())) {
      if (!n.textContent.trim()) continue;
      const el = n.parentElement; const f = el instanceof SVGElement ? parseFloat(el.getAttribute('font-size') || getComputedStyle(el).fontSize) : parseFloat(getComputedStyle(el).fontSize);
      if (el.closest('sup')) continue;
      if (pt(f) < 7) small.push(pt(f) + 'pt ' + n.textContent.trim().slice(0, 20));
    }
    return { small, body: pt(parseFloat(getComputedStyle(document.querySelector('#report-print .page')).fontSize)), span: pt(parseFloat(getComputedStyle(document.querySelector('#rpg1 .span')).fontSize)) };
  });
  check(`${tag} captions 7 pt or more, body 9 pt`, !type.small.length && type.body === 9 && type.span === 9, `${type.small.length} under 7 pt ${type.small.slice(0, 3).join('; ')}; body ${type.body} pt`);
  // Words.
  const text = await page.evaluate(() => document.getElementById('report-print').innerText + '\n' + 'Share with my doctor Download report (PDF) Save to phone Share report');
  const noFoot = await page.evaluate(() => { const c = document.getElementById('report-print').cloneNode(true); c.querySelectorAll('.foot .note').forEach((e) => e.remove()); return c.textContent; });
  const hits = FORBIDDEN.flatMap((re) => (text.match(new RegExp(re.source, 'gi')) || [])).concat(FORBIDDEN_CASE.flatMap((re) => (noFoot.match(new RegExp(re.source, 'g')) || [])));
  check(`${tag} forbidden words 0`, hits.length === 0, hits.join(', '));
  const dashes = (text.match(/[–—]/g) || []).length;
  check(`${tag} no dashes in report text`, dashes === 0, String(dashes));
  if (o.textOut) fs.writeFileSync(o.textOut, text);
  // Widows: a block that wraps must end with two or more words on its last line.
  const widows = await page.evaluate(() => {
    const out = [];
    document.querySelectorAll('#report-print p, #report-print td, #report-print .timeline span').forEach((el) => {
      const words = []; const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT); let n;
      while ((n = w.nextNode())) { const re = /\S+/g; let m; while ((m = re.exec(n.textContent))) words.push([n, m.index, m.index + m[0].length]); }
      if (words.length < 3) return;
      const top = (wd) => { const r = document.createRange(); r.setStart(wd[0], wd[1]); r.setEnd(wd[0], wd[2]); const b = r.getClientRects(); return b.length ? b[b.length - 1].top : 0; };
      const first = top(words[0]), last = top(words[words.length - 1]), prev = top(words[words.length - 2]);
      if (last - first > 4 && last - prev > 4) out.push(el.textContent.trim().slice(-40));
    });
    return out;
  });
  check(`${tag} no widows in the report text`, widows.length === 0, widows.slice(0, 3).join(' | '));
  if (o.pdfOut) {
    await page.evaluate(() => { const h = document.getElementById('report-print'); h.style.position = 'absolute'; h.style.left = '0px'; h.style.zIndex = 99999; });
    const pgs = await page.$$('#report-print .page');
    for (let i = 0; i < Math.min(2, pgs.length); i++) await pgs[i].screenshot({ path: path.join(SHOT_DIR, `s44-report-p${i + 1}.png`) });
    await page.evaluate(() => { const h = document.getElementById('report-print'); h.style.position = ''; h.style.left = ''; h.style.zIndex = ''; });
  }
  // PDF from the print view: page count and size.
  await page.evaluate(() => document.body.classList.add('rpt-printing'));
  await page.emulateMedia({ media: 'print' });
  const pdf = await page.pdf({ preferCSSPageSize: true, printBackground: true });
  const boxes = [...pdf.toString('latin1').matchAll(/\/MediaBox\s*\[\s*0 0 ([\d.]+) ([\d.]+)\s*\]/g)].map((x) => [Math.round(+x[1]), Math.round(+x[2])]);
  check(`${tag} PDF has the menu's page count, all 612 x 792 pt`, boxes.length === m.count && boxes.every((b) => b[0] === 612 && b[1] === 792), boxes.map((b) => b.join('x')).join(' '));
  if (o.pdfOut) fs.writeFileSync(o.pdfOut, pdf);
  check(`${tag} no page errors`, page.errors.length === 0, page.errors.slice(0, 2).join('; '));
  await ctx.close();
  return m.count;
}

// Phone: Share opens a sheet holding the menu.
async function phoneMenu(base, iso) {
  const { ctx, page } = await openDay(base, iso, { width: 360 });
  await page.tap('#export-report');
  await page.waitForSelector('.sheet #share-menu [role="menuitem"]', { timeout: 10000 }).catch(() => {});
  const r = await page.evaluate(() => {
    const b = document.querySelector('.sheet #share-menu [role="menuitem"]');
    const rc = b && b.getBoundingClientRect();
    return { sheet: !!b, h: rc ? Math.round(rc.height) : 0, w: rc ? Math.round(rc.width) : 0 };
  });
  await page.keyboard.press('Escape');
  const closed = await page.evaluate(() => !document.querySelector('.sheet-root') && document.getElementById('export-report').getAttribute('aria-expanded') === 'false');
  check(`phone ${iso} Share opens a sheet, items 44 px, Escape closes`, r.sheet && r.h >= 44 && closed, JSON.stringify(r) + ' closed ' + closed);
  if (SHOTS) {
    await page.tap('#export-report');
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(SHOT_DIR, 's44', 'share-sheet-360.png') });
  }
  await ctx.close();
}

// ---------- 5: digit centring (port of mocks/report-centre.mjs) ----------
async function centring(base, iso) {
  const DPR = 3, LIMIT = 0.5;
  const { ctx, page } = await openDay(base, iso, { dpr: DPR });
  await page.evaluate(async () => { await window.__aortiReport.prepare(); const h = document.getElementById('report-print'); h.style.position = 'absolute'; h.style.left = '0px'; h.style.zIndex = 99999; });
  const an = await (await browser.newContext()).newPage();
  const rows = [];
  for (const [name, sel] of [['page 1 chart', '#rpg1 .chart circle.mc'], ['page 1 index', '#rpg1 table.idx svg.mn circle'], ['moment header', '.mhead svg.mn circle']]) {
    const n = await page.evaluate((s) => document.querySelectorAll(s).length, sel);
    for (let i = 0; i < Math.min(n, 6); i++) {
      const bx = await page.evaluate(([s, i]) => {
        const e = document.querySelectorAll(s)[i]; e.scrollIntoView({ block: 'center' });
        const b = e.getBoundingClientRect();
        return { x: b.x, y: b.y, w: b.width, h: b.height, sw: parseFloat(e.getAttribute('stroke-width')), txt: e.nextElementSibling.textContent };
      }, [sel, i]);
      const pad = 6;
      const buf = await page.screenshot({ clip: { x: bx.x - pad, y: bx.y - pad, width: bx.w + 2 * pad, height: bx.h + 2 * pad } });
      const res = await an.evaluate(async ({ b64, bx, pad, DPR }) => {
        const img = new Image(); img.src = 'data:image/png;base64,' + b64; await img.decode();
        const c = document.createElement('canvas'); c.width = img.width; c.height = img.height; const g = c.getContext('2d'); g.drawImage(img, 0, 0);
        const d = g.getImageData(0, 0, c.width, c.height).data;
        const lum = (i) => 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
        const gx = (pad + bx.w / 2) * DPR, gy = (pad + bx.h / 2) * DPR, R = (bx.w / 2 + bx.sw / 2) * DPR;
        const rIn0 = (bx.w / 2 - bx.sw / 2) * DPR - 3.5;
        const bg = lum((Math.round(gy) * c.width + Math.round(gx - rIn0 + 2)) * 4);
        const sw = bx.sw * DPR, rLo = R - sw - 0.6 * DPR, rHi = R + 0.5 * DPR;
        let cx = gx, cy = gy;
        for (let it = 0; it < 4; it++) {
          let ax0 = 1e9, ax1 = -1, wy = 0, wsum = 0;
          for (let y = Math.floor(cy - R - 4); y <= Math.ceil(cy + R + 4); y++) for (let x = Math.floor(cx - R - 4); x <= Math.ceil(cx + R + 4); x++) {
            if (x < 0 || y < 0 || x >= c.width || y >= c.height) continue;
            const dx = x + 0.5 - cx, dy = y + 0.5 - cy, dist = Math.hypot(dx, dy);
            if (dist < rLo || dist > rHi + 1.5) continue;
            const ink = Math.abs(lum((y * c.width + x) * 4) - bg); if (ink < 30) continue;
            if (Math.abs(dy) < R * 0.5) { ax0 = Math.min(ax0, x); ax1 = Math.max(ax1, x); }
            if (Math.abs(dx) > R * 0.6) { wy += (y + 0.5) * ink; wsum += ink; }
          }
          cx = (ax0 + ax1 + 1) / 2; cy = wy / wsum;
        }
        let x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1;
        for (let y = Math.floor(cy - rIn0); y <= Math.ceil(cy + rIn0); y++) for (let x = Math.floor(cx - rIn0); x <= Math.ceil(cx + rIn0); x++) {
          if (Math.hypot(x + 0.5 - cx, y + 0.5 - cy) > rIn0) continue;
          if (Math.abs(lum((y * c.width + x) * 4) - bg) < 60) continue;
          x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
        }
        return { dx: +(((x0 + x1 + 1) / 2 - cx) / DPR).toFixed(2), dy: +(((y0 + y1 + 1) / 2 - cy) / DPR).toFixed(2) };
      }, { b64: buf.toString('base64'), bx, pad, DPR });
      rows.push({ where: name, digit: bx.txt, dx: res.dx, dy: res.dy, ok: Math.abs(res.dx) <= LIMIT && Math.abs(res.dy) <= LIMIT });
    }
  }
  await an.context().close();
  await ctx.close();
  const worst = Math.max(...rows.map((r) => Math.max(Math.abs(r.dx), Math.abs(r.dy))));
  check(`${iso} digits centred within 0.5 px`, rows.length > 0 && rows.every((r) => r.ok), `${rows.length} circles, worst ${worst} px` + rows.filter((r) => !r.ok).map((r) => ` [${r.where} ${r.digit} ${r.dx},${r.dy}]`).join(''));
}

// ---------- 6: app path with the fake bridge ----------
async function appPath(base, iso, expect) {
  for (const reject of [false, true]) {
    const { ctx, page } = await openDay(base, iso, { app: true, reject });
    const vis = await page.evaluate(() => !document.getElementById('export-report').hidden);
    const m = vis ? await openMenuByClick(page) : { items: [] };
    if (!reject) check(`app ${iso} Share shows Save to phone then Share report with the page count`, vis && m.items.length === 2 && /^Save to phone$/.test(m.items[0].trim()) && /Share report/.test(m.items[1]) && m.count === expect, JSON.stringify(m));
    if (!vis) { await ctx.close(); continue; }
    await page.click('#share-menu [data-act="share"]');
    await page.waitForFunction(() => window.__pdfCalls.length && window.__pdfCalls[0].settled, null, { timeout: 60000 }).catch(() => {});
    await page.waitForTimeout(200);
    const r = await page.evaluate(async () => {
      const c = window.__pdfCalls[0];
      if (!c) return null;
      const dims = [];
      for (const b64 of c.images) { const img = new Image(); img.src = 'data:image/png;base64,' + b64; await img.decode(); dims.push(img.width + 'x' + img.height); }
      const notice = [...document.querySelectorAll('.notice')].map((n) => n.textContent.trim()).join(' | ');
      return { pages: c.pages, moments: c.moments, week: c.week, share: c.share, filename: c.filename, dims, settled: c.settled, landscape: c.landscape, printCalls: window.__printCalls, notice, calls: window.__pdfCalls.length };
    });
    if (!reject) {
      const formula = r ? 1 + Math.ceil(Math.min(r.moments, 6) / 2) : -1;
      check(`app ${iso} printPdf gets N pages of 1224 x 1584 PNG and settles`, !!r && r.calls === 1 && r.pages === expect && formula === r.pages && r.dims.every((d) => d === '1224x1584') && r.landscape.every((l) => !l) && r.settled === 'resolved' && r.share === true && r.printCalls === 0, JSON.stringify(r && { ...r, dims: [...new Set(r.dims)] }));
      if (SHOTS && r) {
        const png = await page.evaluate(() => window.__pdfCalls[0].images[0]);
        fs.writeFileSync(path.join(SHOT_DIR, 's44', 'app-raster-p1.png'), Buffer.from(png, 'base64'));
      }
    } else {
      const left = await page.evaluate(() => ({ pages: document.querySelectorAll('#report-print .page').length, printing: document.body.classList.contains('rpt-printing') }));
      // The app WebView ignores window.print(), so a failed share clears and says so instead of printing.
      check(`app ${iso} a rejected printPdf settles, shows a notice, clears the report`, !!r && r.settled === 'rejected' && r.printCalls === 0 && /Could not make the PDF/.test(r.notice) && left.pages === 0 && !left.printing, JSON.stringify(r && { settled: r.settled, printCalls: r.printCalls, notice: r.notice, left }));
    }
    check(`app ${iso}${reject ? ' rejected' : ''} no page errors`, page.errors.length === 0, page.errors.slice(0, 2).join('; '));
    await ctx.close();
  }
}

// ---------- 7: Save to phone with the fake bridge (S48) ----------
async function savePath(base, iso, expect) {
  for (const mode of ['saved', 'cancelled', 'failed']) {
    const { ctx, page } = await openDay(base, iso, { app: true, saveMode: mode });
    const vis = await page.evaluate(() => !document.getElementById('export-report').hidden);
    if (!vis) { check(`app save ${mode}: Share button visible`, false); await ctx.close(); continue; }
    // Notices already up (the demo banner) are the baseline; a cancel adds none.
    const before = await page.evaluate(() => [...document.querySelectorAll('.notice')].map((n) => n.textContent.trim()).join(' | '));
    await openMenuByClick(page);
    await page.click('#share-menu [data-act="save"]');
    await page.waitForFunction(() => window.__saveCalls.length && window.__saveCalls[0].settled, null, { timeout: 60000 }).catch(() => {});
    await page.waitForTimeout(300);
    const r = await page.evaluate(async () => {
      const c = window.__saveCalls[0];
      if (!c) return null;
      const dims = [];
      for (const b64 of c.images) { const img = new Image(); img.src = 'data:image/png;base64,' + b64; await img.decode(); dims.push(img.width + 'x' + img.height); }
      const notice = [...document.querySelectorAll('.notice')].map((n) => n.textContent.trim()).join(' | ');
      return { pages: c.pages, moments: c.moments, share: c.share, filename: c.filename, dims, landscape: c.landscape, settled: c.settled, saves: window.__saveCalls.length, prints: window.__pdfCalls.length, printCalls: window.__printCalls, notice,
        left: document.querySelectorAll('#report-print .page').length };
    });
    const base1 = !!r && r.saves === 1 && r.prints === 0 && r.printCalls === 0 && r.left === 0;
    if (mode === 'saved') {
      check(`app ${iso} Save calls savePdf with N pages of 1224 x 1584 PNG, named aorti-day-${iso}.pdf`, base1 && r.pages === expect && r.share === undefined && r.filename === `aorti-day-${iso}.pdf` && r.dims.every((d) => d === '1224x1584') && r.landscape.every((l) => !l), JSON.stringify(r && { ...r, dims: [...new Set(r.dims)] }));
      check(`app ${iso} Save saved: settles and shows Saved`, base1 && r.settled === 'resolved' && /\bSaved\b/.test(r.notice) && !/Could not/.test(r.notice), JSON.stringify(r && { settled: r.settled, notice: r.notice }));
    } else if (mode === 'cancelled') {
      check(`app ${iso} Save cancelled: settles with no notice`, base1 && r.settled === 'resolved' && r.notice === before, JSON.stringify(r && { settled: r.settled, notice: r.notice, before }));
    } else {
      check(`app ${iso} Save failed: settles and says Could not save the PDF. Try again.`, base1 && r.settled === 'rejected' && /Could not save the PDF\. Try again\./.test(r.notice), JSON.stringify(r && { settled: r.settled, notice: r.notice }));
    }
    // The menu opens again afterwards, so a settled save never leaves the report busy.
    const again = await openMenuByClick(page).catch(() => ({ items: [] }));
    check(`app ${iso} Save ${mode}: menu opens again, no page errors`, again.items.length === 2 && page.errors.length === 0, page.errors.slice(0, 2).join('; ') || JSON.stringify(again.items));
    await ctx.close();
  }
}

// ---------- mutants ----------
async function mutants(base) {
  // Page 1 one row over: add index rows until the content passes the footer by one row; the overflow check must fail.
  const { ctx, page } = await openDay(base, DAYS[0][1]);
  const over = await page.evaluate(async (fnSrc) => {
    await window.__aortiReport.prepare();
    const measure = eval('(' + fnSrc + ')');
    const tb = document.querySelector('#rpg1 table.idx tbody'), row = tb.lastElementChild;
    const rowH = row.getBoundingClientRect().height;
    const room = measure()[0].room;
    const add = Math.floor((room - 8) / rowH) + 1;
    for (let i = 0; i < add; i++) tb.appendChild(row.cloneNode(true));
    return measure();
  }, MEASURE_PAGES.toString());
  const caught = !paperChecks('mutant page 1 one row over', over, true);
  console.log(`${caught ? 'PASS' : 'FAIL'}  mutant page 1 one row over: the overflow check ${caught ? 'fails' : 'passes (missed)'}`);
  if (!caught) { fails++; failed.push('mutant page 1 one row over'); }
  await ctx.close();
  // Menu count off by one.
  const src = 'function rptPageCount(d) { return 1 + Math.ceil(';
  if (!VIEWER.includes(src)) { check('mutant menu count: source found', false); return; }
  const mut = await serve(VIEWER.replace(src, 'function rptPageCount(d) { return 2 + Math.ceil('));
  const m2 = await openDay(mut.base, DAYS[0][1]);
  const menu = await openMenuByClick(m2.page);
  await m2.page.evaluate(() => window.__aortiReport.prepare());
  const n = await m2.page.evaluate(() => document.querySelectorAll('#report-print .page').length);
  const caught2 = menu.count !== n;
  console.log(`${caught2 ? 'PASS' : 'FAIL'}  mutant menu count off by one: page count check ${caught2 ? 'fails' : 'passes (missed)'} (menu ${menu.count}, pages ${n})`);
  if (!caught2) { fails++; failed.push('mutant menu count off by one'); }
  await m2.ctx.close();
  mut.server.close();
}

const { server, base } = await serve(VIEWER);
try {
  if (SHOTS) fs.mkdirSync(path.join(SHOT_DIR, 's44'), { recursive: true });
  const counts = {};
  for (const [label, iso] of DAYS) {
    counts[iso] = await webDay(base, label, iso, label === 'showcase' && SHOTS ? { pdfOut: path.join(SHOT_DIR, 's44-day-report.pdf'), textOut: path.join(SHOT_DIR, 's44', 'report-text.txt') } : {});
  }
  await phoneMenu(base, DAYS[0][1]);
  for (const [, iso] of DAYS) await centring(base, iso);
  await appPath(base, DAYS[0][1], counts[DAYS[0][1]]);
  await savePath(base, DAYS[0][1], counts[DAYS[0][1]]);
  if (MUTANTS) await mutants(base);
} finally {
  await browser.close();
  server.close();
}
console.log(fails ? `\n${fails} FAILED: ${failed.join('; ')}` : '\nAll day report checks pass.');
process.exit(fails ? 1 : 0);
