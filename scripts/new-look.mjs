// Guards: S41 (2026-10-12) the "new look" announcement page, new-look.html, and its pictures in assets/new-look/.
// Named bugs: pages drifting to their own top bar (Khal 2026-10-12, "the home button on privacy and terms is weirdly
// placed"), so nav and footer must equal index.html; the phone Day picture showing a tall one-column summary (Khal 10-12).
// S46 named bugs (Khal 2026-10-12): the page "EXTREMELY bad about its right real estate" (text and pictures leaving the
// right side empty), the Day story missing the old "View as full-day timeline" step, the intro paragraph he cut, and
// the Zoom copy saying the markers list moved without saying where it lives now.
// S47: copy in a UX shape (release line, goals, problem then change per section, outcomes list).
// Two modes. Runtime: --capture about 3 min; checks about 10 s; --mutants about 30 s more.
//   node scripts/new-look.mjs --capture <before-root>   takes every before/after pair on synthetic data only
//        (the viewer's ?demo=1 files, identical in both builds, and the fake phone bridge for the monitor) and
//        writes display and full-size WebP files. <before-root> holds the app files written out with `git show`.
//   node scripts/new-look.mjs [--mutants]   checks the page: every pair at both sizes, files resolve and stay under
//        budget; the picture dialog opens by click and by Enter, traps focus, closes on Escape with focus back on the
//        picture, arrows move in page order; no sideways scroll at 360; nav and footer identical to index.html;
//        analytics tag present. --mutants serves a copy whose dialog never returns focus, which must FAIL.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { uxDir } from './ux-dir.mjs';
import { execFileSync, spawnSync } from 'node:child_process';
import os from 'node:os';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');
const args = process.argv.slice(2);
const argVal = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const UX = uxDir(here, argVal('--ux'));
const CHART = path.join(UX, '..', 'docs', 'audit-2026-10-09', 'harness-DT', 'vendor', 'chart.umd.min.js');
const { chromium } = createRequire(path.join(UX, 'kit', 'package.json'))('playwright');
const OUT = path.join(ROOT, 'assets', 'new-look');

// Pairs in page order. Sizes: 1440 laptop, 360 phone. The widget pair is one size (the widget does not change with the page).
export const PAIRS = ['day', 'zoom', 'month', 'week', 'trends', 'monitor', 'settings'];
export const WIDGETS = ['chip', 'slim', 'hrhrv', 'notrends'];
// S46: Day before step 2 (the old full-day timeline page) at both sizes, and the Markers list open on the laptop.
export const EXTRAS = ['day-before2-1440', 'day-before2-360', 'markers-after-1440'];
const BUDGET = { display: 300 * 1024, full: 900 * 1024 };
const DAY = '2026-04-24'; // Khal 2026-10-12: the most complete demo day
// Widget measurements taken at capture time (local, beside the build shots): trace and trend coverage, HRV text.
const WIDGET_LOG = path.join(UX, 'redesign', 'build-shots', 'new-look-widgets.json');

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png', '.webp': 'image/webp', '.woff2': 'font/woff2', '.csv': 'text/csv', '.ico': 'image/x-icon' };
function serve(root, rewrite) {
  const server = http.createServer((req, res) => {
    const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    // The sample week always comes from this build's demo/ (generated since fb75bb4), so both sides show the same data.
    const file = path.join(rel.startsWith('/demo/') ? ROOT : root, rel === '/' ? '/index.html' : rel);
    if (!file.startsWith(rel.startsWith('/demo/') ? ROOT : root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end(); return; }
    let body = fs.readFileSync(file);
    if (rewrite) body = rewrite(rel, body);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' }); res.end(body);
  });
  return new Promise((ok) => server.listen(0, '127.0.0.1', () => ok({ server, base: `http://127.0.0.1:${server.address().port}` })));
}
// The app page as copy-web builds it for the phone: the native shims before </head>, read from that build's mobile/src.
const SHIMS = ['capacitor-bootstrap', 'ble-adapter', 'native-relay-socket', 'native-hr-session', 'drive-auth-native', 'foreground-service', 'battery-opt', 'wake-lock', 'oem-background', 'restore-overlay'];
const appShim = (root) => (rel, body) => {
  if (rel !== '/hr_monitor.html') return body;
  const tags = SHIMS.filter((n) => fs.existsSync(path.join(root, 'mobile', 'src', n + '.js'))).map((n) => `<script src="./mobile/src/${n}.js"></script>`).join('\n');
  return Buffer.from(body.toString('utf8').replace(/<\/head>/i, tags + '\n</head>'));
};
async function route(ctx, base) {
  await ctx.route('**/*', (r) => {
    const u = r.request().url();
    if (u.startsWith(base) || u.startsWith('data:') || u.startsWith('blob:')) return r.continue();
    if (/chart\.umd(\.min)?\.js/.test(u)) return r.fulfill({ status: 200, contentType: 'text/javascript', body: fs.readFileSync(CHART) });
    if (/fonts\.(googleapis|gstatic)\.com|cdn\.jsdelivr\.net\/npm\/(sortablejs|chartjs-plugin)/.test(u)) return r.continue();
    if (/googleapis\.com\/(drive|upload)\//.test(u)) return r.fulfill({ status: 200, contentType: 'application/json', body: '{"files":[]}' });
    const js = r.request().resourceType() === 'script';
    return r.fulfill({ status: js ? 200 : 204, contentType: js ? 'text/javascript' : 'text/plain', body: '' });
  });
}

// ---------------------------------------------------------------- capture
async function capture(beforeRoot) {
  fs.mkdirSync(OUT, { recursive: true });
  const { fakeBridge } = await import(pathToFileURL(path.join(UX, 'scripts', 'fake-bridge.mjs')).href);
  const browser = await chromium.launch().catch(() => chromium.launch({ channel: 'chrome' }));
  const enc = await (await browser.newContext()).newPage();
  const log = [];
  async function save(png, name, maxW) {
    for (const [kind, w] of [['display', Math.round(maxW * 0.75)], ['full', maxW]]) {
      const r = await enc.evaluate(async ({ b64, w, budget }) => {
        const img = new Image(); img.src = 'data:image/png;base64,' + b64; await img.decode();
        const W = Math.min(w, img.naturalWidth), H = Math.round(img.naturalHeight * W / img.naturalWidth);
        const c = document.createElement('canvas'); c.width = W; c.height = H;
        const x = c.getContext('2d'); x.imageSmoothingQuality = 'high'; x.drawImage(img, 0, 0, W, H);
        let d, q;
        for (q = 0.9; q >= 0.4; q -= 0.05) { d = c.toDataURL('image/webp', q); if ((d.length - 23) * 0.75 <= budget) break; }
        return { d, W, H, q: +q.toFixed(2) };
      }, { b64: png.toString('base64'), w, budget: BUDGET[kind] });
      const file = path.join(OUT, `${name}${kind === 'full' ? '-full' : ''}.webp`);
      fs.writeFileSync(file, Buffer.from(r.d.split(',')[1], 'base64'));
      log.push(`${path.basename(file)} ${r.W}x${r.H} q${r.q} ${Math.round(fs.statSync(file).size / 1024)} KB`);
    }
  }
  // Stream widget pictures (S46 follow-up, Khal 10-12 "the stream widget example doesnt have a trend line"):
  // Now comes from the landing page's own variant preview (real widget.js on a seeded heart-like history);
  // Before is the old monitor fed 11 minutes of beats on a shifted clock so its trend and trace fill.
  // Each picture's canvases and HRV text are measured as it is taken and written to WIDGET_LOG for the checks.
  const measure = () => {
    const out = {};
    for (const id of ['hr-live-trace', 'compact-chart']) {
      const c = document.getElementById(id);
      if (!c || !c.offsetWidth || !c.width) continue;
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      let cols = 0;
      for (let i = 0; i < c.width; i++) for (let j = 0; j < c.height; j++) {
        const k = (j * c.width + i) * 4;
        if (d[k + 3] > 60 && Math.max(d[k], d[k + 1], d[k + 2]) - Math.min(d[k], d[k + 1], d[k + 2]) > 40) { cols++; break; }
      }
      out[id] = +(cols / c.width).toFixed(2);
    }
    const v = document.getElementById('compact-hrv-value');
    out.hrv = v && v.offsetWidth ? v.textContent.trim() : null;
    return out;
  };
  const record = {};
  async function widgetShots(base, ver, opts) {
    const wctx = await browser.newContext(Object.assign({}, opts, { deviceScaleFactor: 2 })); await route(wctx, base);
    const w = await wctx.newPage();
    const variants = ver === 'before' ? [['single', '']] : [['chip', ''], ['slim', 'no-hrv no-live-hr no-inline-trends'], ['hrhrv', 'no-live-hr no-inline-trends'], ['notrends', 'no-inline-trends']];
    if (ver === 'before') {
      await wctx.addInitScript(fakeBridge({ scenario: 'live', savedStrap: true, signedIn: true, sessionAgeMs: 72 * 60000 }));
      await wctx.addInitScript(() => { const real = Date.now.bind(Date); window.__dt = 0; Date.now = () => real() + window.__dt; });
      await w.goto(`${base}/hr_monitor.html`, { waitUntil: 'domcontentloaded' });
      await w.waitForTimeout(2500);
      await w.evaluate(async () => {
        const F = window.__fake; if (!F || !F.listeners.hr) return;
        for (let i = 0; i < 660; i++) {
          window.__dt += 1000;
          const hr = Math.round(76 + 10 * Math.sin(i / 47) + 5 * Math.sin(i / 9.1) + ((i * 7) % 5) - 2);
          const rr = [Math.round(60000 / hr) + ((i * 13) % 41) - 20];
          const rmssd = 30 + 8 * Math.sin(i / 61) + ((i * 11) % 7) - 3;
          F.listeners.hr({ hr, rrIntervals: rr, rmssd, timestampMs: Date.now(), contactOff: false });
          if (i % 4 === 0) await new Promise((r) => setTimeout(r, 4));
        }
      });
      await w.waitForTimeout(2000);
      for (const [v] of variants) {
        const m = await w.evaluate(measure);
        await save(await w.locator('#hr-widget').screenshot(), `widget-${ver}-${v}`, 1200);
        record[`widget-${ver}-${v}`] = m;
      }
    } else {
      await w.goto(`${base}/index.html`, { waitUntil: 'load' });
      await w.waitForSelector('body.variants-ready', { timeout: 20000 });
      const frame = await (await w.$('#variant-frame')).contentFrame();
      // Lift the preview out of its scaled stage so the widget renders at its true size.
      const lift = () => w.evaluate(() => { const f = document.getElementById('variant-frame'); Object.assign(f.style, { position: 'fixed', left: '0px', top: '0px', bottom: 'auto', width: '380px', transform: 'none', zIndex: 99999 }); });
      await w.waitForTimeout(2500);
      for (const [v, cls] of variants) {
        await w.locator('#variant-seg button').nth(variants.findIndex((x) => x[0] === v)).click();
        await w.waitForTimeout(1500); await lift(); await w.waitForTimeout(600);
        const got = await frame.evaluate(() => document.body.className);
        if (cls.split(' ').filter(Boolean).some((c) => !got.includes(c))) log.push(`WARN ${v}: preview classes "${got}"`);
        const m = await frame.evaluate(measure);
        m.footprint = await frame.evaluate(() => { const r = document.getElementById('hr-widget').getBoundingClientRect(); return Math.round(r.width) + ' × ' + Math.round(r.height); });
        await save(await frame.locator('#hr-widget').screenshot(), `widget-${ver}-${v}`, 1200);
        record[`widget-${ver}-${v}`] = m;
      }
    }
    for (const n of Object.keys(record)) {
      if (!n.startsWith(`widget-${ver}-`)) continue;
      const f = path.join(OUT, `${n}.webp`), g = path.join(OUT, `${n}-full.webp`);
      Object.assign(record[n], { size: fs.statSync(f).size, fullSize: fs.statSync(g).size });
    }
    await wctx.close();
    const prev = fs.existsSync(WIDGET_LOG) ? JSON.parse(fs.readFileSync(WIDGET_LOG, 'utf8')) : {};
    fs.writeFileSync(WIDGET_LOG, JSON.stringify(Object.assign(prev, record), null, 1));
    log.push('widgets ' + JSON.stringify(record));
  }
  if (argVal('--only') === 'widgets') {
    for (const [ver, root] of [['before', path.resolve(beforeRoot)], ['after', ROOT]].filter(([v]) => !argVal('--side') || v === argVal('--side'))) {
      const { server, base } = await serve(root, appShim(root));
      await widgetShots(base, ver, { viewport: { width: 1440, height: 900 }, timezoneId: 'America/Edmonton' });
      server.close();
    }
    await browser.close(); console.log(log.join('\n')); return;
  }
  // --side before|after takes one side only (each side runs about 90 s).
  const side = argVal('--side');
  // --only day2 (with --side before) or --only markers (with --side after) takes just that Day extra; about 20 s.
  const dayOnly = ['day2', 'markers'].includes(argVal('--only'));
  for (const [ver, root] of [['before', path.resolve(beforeRoot)], ['after', ROOT]].filter(([v]) => !side || v === side)) {
    const { server, base } = await serve(root, appShim(root));
    for (const size of [1440, 360]) {
      const phone = size === 360;
      const vp = phone ? { width: 360, height: 760 } : { width: 1440, height: 900 };
      const opts = { viewport: vp, deviceScaleFactor: phone ? 2 : 1, isMobile: phone, hasTouch: phone, timezoneId: 'America/Edmonton' };
      const maxW = phone ? 720 : 1440;
      // Viewer on the demo files (synthetic, identical in both builds).
      const ctx = await browser.newContext(opts); await route(ctx, base);
      const page = await ctx.newPage();
      const go = async (hash) => {
        await page.goto('about:blank');
        await page.goto(`${base}/hrv_viewer.html?demo=1${hash}`, { waitUntil: 'networkidle' });
        await page.waitForTimeout(2500);
        await page.evaluate(() => window.scrollTo(0, 0));
      };
      for (const [id, hash] of [['day', `#/day/${DAY}`], ['month', '#/month/2026-04'], ['week', '#/week/2026-04-20'], ['trends', '#/all']].slice(0, dayOnly ? 1 : 4)) {
        // Taller frames where the view's point sits low: the phone Day chart, the laptop Month's data week.
        const tall = { day: phone ? 1300 : null, month: phone ? null : 1180 }[id];
        await page.setViewportSize({ width: vp.width, height: tall || vp.height });
        await go(hash);
        // Phone Now Day: the Summary collapsed to its four numbers, so the frame shows the chart (Khal 10-12).
        const fold = phone && ver === 'after' && id === 'day';
        if (fold) {
          await page.evaluate(() => { const b = document.getElementById('summary-bar'); if (b && !b.classList.contains('collapsed')) b.click(); });
          await page.waitForTimeout(800);
        }
        if (!dayOnly) await save(await page.screenshot(), `${id}-${ver}-${size}`, maxW);
        if (fold) await page.evaluate(() => { try { localStorage.removeItem('hrv_summary_collapsed'); } catch (e) {} });
        // Before, step 2: the old Day reached its graph only through "View as full-day timeline" (S46).
        if (ver === 'before' && id === 'day') {
          const link = page.locator('#day-view-timeline');
          if (await link.count()) {
            await link.click(); await page.waitForTimeout(3000);
            await page.evaluate(() => window.scrollTo(0, 0)); await page.waitForTimeout(300);
            await save(await page.screenshot(), `day-before2-${size}`, maxW);
          } else log.push(`WARN before ${size}: no "View as full-day timeline" link`);
        }
        // Now, laptop: the Markers button opens the list over the chart (S46: the copy names where it lives).
        if (ver === 'after' && id === 'day' && !phone) {
          const btn = page.locator('#markers-toggle');
          if (await btn.count()) {
            await btn.click(); await page.waitForTimeout(1200);
            await save(await page.screenshot(), 'markers-after-1440', maxW);
            await btn.click(); await page.waitForTimeout(400);
          } else log.push('WARN after 1440: no Markers button');
        }
      }
      if (dayOnly) { await ctx.close(); console.log(`captured ${ver} ${size} Day extra`); continue; }
      // Zoomed chart: before, the full-day session view; after, the Day view. Drag across the strip under the chart.
      await page.setViewportSize(vp);
      await go(ver === 'before' ? `#/session/day:${DAY}` : `#/day/${DAY}`);
      const strip = await page.evaluate(() => {
        const b = document.getElementById('context-brush'); const el = document.querySelector('.context-overlay') || (b && b.parentElement);
        if (!el) return null; el.scrollIntoView({ block: 'center' }); const r = el.getBoundingClientRect(); return { x: r.left, y: r.top + r.height / 2, w: r.width };
      });
      if (strip) {
        // Both builds open with the brush over the whole day: pull the left handle in, then the right one.
        const drag = async (from, to) => {
          await page.mouse.move(strip.x + from, strip.y); await page.mouse.down();
          for (let i = 1; i <= 12; i++) await page.mouse.move(strip.x + from + (to - from) * i / 12, strip.y);
          await page.mouse.up(); await page.waitForTimeout(700);
        };
        await drag(2, strip.w * 0.555);
        await drag(strip.w - 2, strip.w * 0.64);
        await page.waitForTimeout(600);
        await page.evaluate(() => { const c = document.getElementById('session-chart'); if (c) { const r = c.getBoundingClientRect(); window.scrollBy(0, r.top - 200); } });
        await page.waitForTimeout(400);
      } else log.push(`WARN ${ver} ${size}: no brush strip`);
      await save(await page.screenshot(), `zoom-${ver}-${size}`, maxW);
      await ctx.close();
      // Monitor while recording, on the fake phone bridge (generated heart rate ticks only).
      const mctx = await browser.newContext(opts); await route(mctx, base);
      await mctx.addInitScript(fakeBridge({ scenario: 'live', savedStrap: true, signedIn: true, sessionAgeMs: 72 * 60000 }));
      const m = await mctx.newPage();
      // Four minutes of generated beats, fed through the fake strap's own listener with spread timestamps.
      await m.goto(`${base}/hr_monitor.html`, { waitUntil: 'domcontentloaded' });
      await m.waitForTimeout(2500);
      const feedBeats = (pg) => pg.evaluate(async () => {
        const F = window.__fake; if (!F || !F.listeners.hr) return;
        const t0 = Date.now() - 240000;
        for (let i = 0; i < 240; i++) {
          const hr = Math.round(74 + 9 * Math.sin(i / 23) + 4 * Math.sin(i / 5.3) + ((i * 7) % 5) - 2);
          const rr = [Math.round(60000 / hr) + ((i * 13) % 31) - 15];
          const rmssd = 28 + 7 * Math.sin(i / 31) + ((i * 11) % 7) - 3; // the phone engine sends its own HRV
          F.listeners.hr({ hr, rrIntervals: rr, rmssd, timestampMs: t0 + i * 1000, contactOff: false });
          await new Promise((r) => setTimeout(r, 25));
        }
      });
      await feedBeats(m);
      const openSec = (names, open = true) => m.evaluate(([names, open]) => {
        for (const n of names) {
          const s = document.querySelector(`.section[data-section="${n}"]`); if (!s) continue;
          const h = s.querySelector('.section-header') || s.firstElementChild;
          const closed = s.classList.contains('collapsed') || (h && h.getAttribute('aria-expanded') === 'false');
          if (closed === open && h) h.click();
        }
      }, [names, open]);
      await openSec(['stats', 'chart']);
      await m.waitForTimeout(1500);
      await m.evaluate(() => window.scrollTo(0, 0));
      await save(await m.screenshot(), `monitor-${ver}-${size}`, maxW);
      await openSec(['stats', 'chart', 'connection'], false); await openSec(['settings']);
      await m.waitForTimeout(800);
      await m.evaluate(() => { const s = document.querySelector('.section[data-section="settings"]'); if (s) window.scrollBy(0, s.getBoundingClientRect().top - 16); });
      await m.waitForTimeout(400);
      await save(await m.screenshot(), `settings-${ver}-${size}`, maxW);
      if (!phone) await widgetShots(base, ver, opts);
      await mctx.close();
      console.log(`captured ${ver} ${size}`);
    }
    server.close();
  }
  await browser.close();
  console.log(log.join('\n'));
}

if (args.includes('--capture')) { await capture(argVal('--capture')); process.exit(0); }

// ---------------------------------------------------------------- checks
const MAIN = path.dirname(UX); // the main checkout: files this branch does not carry yet (S40's site.css and site.js)
const MUTANTS = args.includes('--mutants');
let fails = 0;
const check = (ok, label, detail) => { if (ok) console.log('ok   ' + label); else { fails++; console.log('FAIL ' + label + (detail ? '  ' + detail : '')); } return !!ok; };
const PAGE = fs.readFileSync(path.join(ROOT, 'new-look.html'), 'utf8').replace(/\r\n/g, '\n');
const MUTANT = ['dialog without focus return', [['if (opener) opener.focus();', '']]];

function staticChecks() {
  const kb = (f) => Math.round(fs.statSync(f).size / 1024);
  const want = [];
  for (const id of PAIRS) for (const size of [1440, 360]) for (const ver of ['before', 'after']) want.push(`${id}-${ver}-${size}`);
  want.push('widget-before-single', ...WIDGETS.map((v) => `widget-after-${v}`), ...EXTRAS);
  const missing = [], over = [];
  for (const n of want) {
    for (const [suffix, budget, attr] of [['', BUDGET.display, `src="./assets/new-look/${n}.webp"`], ['-full', BUDGET.full, `data-full="./assets/new-look/${n}-full.webp"`]]) {
      const f = path.join(OUT, `${n}${suffix}.webp`);
      if (!fs.existsSync(f) || !PAGE.includes(attr)) missing.push(n + suffix);
      else if (fs.statSync(f).size > budget) over.push(`${n}${suffix} ${kb(f)} KB`);
    }
  }
  check(!missing.length, `every pair at 1440 and 360 plus the widget set: ${want.length} pictures, each with a full-size file, on the page and on disk`, missing.join(', '));
  check(!over.length, `display pictures under ${BUDGET.display / 1024} KB, full-size under ${BUDGET.full / 1024} KB`, over.join(', '));
  const imgs = [...PAGE.matchAll(/<img [^>]*src="([^"]+)"/g)].map((m) => m[1]);
  check(imgs.length >= want.length && imgs.every((s) => s.startsWith('./assets/new-look/')) && !imgs.some((s) => s.endsWith('-full.webp')),
    `pictures come only from assets/new-look (demo data and the fake strap), full-size files never in an img src (${imgs.length} img)`, imgs.filter((s) => !s.startsWith('./assets/new-look/')).join(', '));
  check((PAGE.match(/<img [^>]*loading="lazy"/g) || []).length === imgs.length, 'every page picture is lazy-loaded');
  check(/<script defer src="https:\/\/cdn\.vercel-insights\.com\/v1\/script\.js"><\/script>/.test(PAGE), 'Vercel analytics tag present');
  // Nav and footer: this tree's index.html once main is merged into it, else main's (S40's shared nav landed there first).
  let idx = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8').replace(/\r\n/g, '\n'), from = 'index.html';
  const hasMain = spawnSync('git', ['-C', ROOT, 'merge-base', '--is-ancestor', 'main', 'HEAD']).status === 0;
  if (!hasMain) { idx = execFileSync('git', ['-C', ROOT, 'show', 'main:index.html'], { encoding: 'utf8' }).replace(/\r\n/g, '\n'); from = 'main:index.html'; }
  const nav = (s) => (s.match(/<nav class="nav"[\s\S]*?\n<\/nav>/) || [null])[0];
  const foot = (s) => (s.match(/<footer class="site-footer">[\s\S]*?<\/footer>/) || [null])[0];
  // S46 follow-up: widget pictures with a filled trace and trend and a number for HRV, measured when taken.
  const wl = fs.existsSync(WIDGET_LOG) ? JSON.parse(fs.readFileSync(WIDGET_LOG, 'utf8')) : {};
  const wbad = [];
  for (const n of ['widget-before-single', ...WIDGETS.map((v) => `widget-after-${v}`)]) {
    const r = wl[n], f = path.join(OUT, `${n}.webp`);
    if (!r) { wbad.push(`${n}: not measured`); continue; }
    if (!fs.existsSync(f) || fs.statSync(f).size !== r.size) wbad.push(`${n}: file changed since it was measured`);
    const need = /single|chip/.test(n) ? ['hr-live-trace', 'compact-chart'] : /notrends/.test(n) ? ['hr-live-trace'] : [];
    for (const c of need) if (!(r[c] >= 0.6)) wbad.push(`${n}: ${c} covers ${r[c]}`);
    if (!/slim/.test(n) && !/^\d+$/.test(r.hrv || '')) wbad.push(`${n}: HRV shows "${r.hrv}"`);
    if (r.footprint && !PAGE.includes(`${r.footprint} px</figcaption>`)) wbad.push(`${n}: caption lacks ${r.footprint} px`);
  }
  check(!wbad.length, 'widget pictures: trace and trend drawn across 60% or more, HRV a number, captions match the footprint', wbad.join('; '));
  // S46: Day tells the old two-step route (block bar, then "View as full-day timeline") against one Now screen.
  const day = (PAGE.match(/<section class="area" id="day"[\s\S]*?<\/section>/) || [''])[0];
  const steps = [...day.matchAll(/<div class="pair[^"]*">([\s\S]*?)<\/div>\s*(?=<h3|<\/div>)/g)].map((m) =>
    [...m[1].matchAll(/<figcaption>([^<]*)<\/figcaption>[\s\S]*?<img src="[^"]*-(1440|360)\.webp"/g)].map((f) => f[2] + ' ' + f[1].split(':')[0]));
  const wantSteps = (s) => [`${s} Before, step 1`, `${s} Before, step 2`, `${s} Now`].join(' | ');
  check(steps.length === 2 && steps[0].join(' | ') === wantSteps('1440') && steps[1].join(' | ') === wantSteps('360'),
    'Day: Before step 1, Before step 2 and Now at laptop and phone', JSON.stringify(steps));
  check(/<figcaption>Before, step 2: after View as full-day timeline<\/figcaption>/.test(day) && /one click less/.test(day), 'Day: step 2 named by its link, Now says one click less');
  check(!/I rebuilt most of aorti/.test(PAGE) && /<time datetime="2026-10-12">October 12, 2026<\/time>/.test(PAGE), 'intro paragraph gone, the date in a time[datetime]');
  const zoomSec = (PAGE.match(/<section class="area" id="zoom"[\s\S]*?<\/section>/) || [''])[0];
  check(/Markers button above the chart/.test(zoomSec) && /markers-after-1440\.webp"[^>]*alt="[^"]*Markers · \d+ button/.test(zoomSec), 'Zoom: the copy names the Markers button and a Now picture shows its list open');
  // S47 (Khal 2026-10-12, after the Studio C&G case study): release line, three goals, each area told as the problem
  // then the change in exactly two paragraphs, and the speed list as outcomes.
  check(/<p class="date">Released <time datetime="\d{4}-\d{2}-\d{2}">[^<]+<\/time><\/p>/.test(PAGE), 'intro: "Released" plus a time[datetime]');
  const goals = (PAGE.match(/<ul class="goals">([\s\S]*?)<\/ul>/) || ['', ''])[1];
  check((goals.match(/<li>/g) || []).length === 3, 'intro: the goals list has three items', goals.replace(/\s+/g, ' '));
  const paras = [...PAGE.matchAll(/<section class="area" id="([^"]+)"[\s\S]*?<div class="area-text">([\s\S]*?)<\/div>/g)]
    .filter((m) => m[1] !== 'speed').map((m) => [m[1], (m[2].match(/<p[\s>]/g) || []).length]);
  check(paras.length === PAIRS.length + 1 && paras.every((p) => p[1] === 2), `every area section has exactly two copy paragraphs (${paras.length} sections)`, JSON.stringify(paras));
  const outcomes = (PAGE.match(/<section class="area speed"[\s\S]*?<ul class="outcomes">([\s\S]*?)<\/ul>/) || ['', ''])[1];
  check(/One click fewer to the graph/.test(outcomes) && /One set of controls instead of each screen's own/.test(outcomes) && /125 ms[\s\S]*14 ms/.test(outcomes),
    'outcomes list: the measured numbers, one click fewer, one set of controls');
  check(nav(idx) && nav(PAGE) === nav(idx), `nav identical to ${from}`);
  check(foot(idx) && foot(PAGE) === foot(idx), `footer identical to ${from}`);
}

async function runtime(browser, base, size, only) {
  const phone = size === 360;
  const ctx = await browser.newContext({ viewport: phone ? { width: 360, height: 760 } : { width: 1440, height: 900 }, isMobile: phone, hasTouch: phone, deviceScaleFactor: 1 });
  await ctx.route('**/*', (r) => (r.request().url().startsWith(base) ? r.continue() : r.fulfill({ status: 204, body: '' })));
  const page = await ctx.newPage();
  const errs = []; page.on('pageerror', (e) => errs.push(e.message));
  const fulls = []; page.on('request', (q) => { if (/-full\.webp/.test(q.url())) fulls.push(q.url()); });
  await page.goto(base + '/new-look.html', { waitUntil: 'load' });
  await page.waitForTimeout(400);
  const t = `${size}`;
  const state = () => page.evaluate(() => {
    const d = document.getElementById('lightbox'), a = document.activeElement;
    return { open: d.open, inside: d.contains(a), active: a && (a.getAttribute('aria-label') || a.id || a.tagName), cap: document.getElementById('lb-caption').textContent,
      src: (document.getElementById('lb-img').getAttribute('src') || '') };
  });
  const order = await page.evaluate(() => [...document.querySelectorAll('button.zoom')].filter((b) => b.offsetParent)
    .sort((a, b) => { const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect(); return (ra.top - rb.top) || (ra.left - rb.left); })
    .map((b) => ({ alt: b.querySelector('img').alt, full: b.dataset.full })));
  if (!only) {
    check(!fulls.length, `${t}: no full-size picture loads before a dialog opens`, fulls.slice(0, 2).join(' '));
    const sw = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, w: window.innerWidth }));
    check(sw.sw <= sw.w, `${t}: no sideways scroll`, JSON.stringify(sw));
    if (phone) check(/after/.test(order[0].full), `${t}: Now stacks first on the phone`, order[0].full);
    if (!phone) {
      // S46: text column beside the pictures, and no picture row leaving more than 35% of the section empty beside it.
      const fill = await page.evaluate(() => [...document.querySelectorAll('main > section')].map((sec) => {
        const s = sec.getBoundingClientRect(), t = sec.querySelector(':scope > .area-text'), p = sec.querySelector(':scope > .area-pics');
        if (!t || !p) return { id: sec.id || sec.className, empty: 1, side: false };
        const tr = t.getBoundingClientRect(), pr = p.getBoundingClientRect();
        const rows = [...p.children].filter((c) => c.tagName !== 'H3').map((r) => {
          const figs = [...r.querySelectorAll('figure')].map((f) => f.getBoundingClientRect());
          const w = figs.length ? Math.max(...figs.map((f) => f.right)) - Math.min(...figs.map((f) => f.left)) : r.getBoundingClientRect().width;
          return 1 - (tr.width + w) / s.width;
        });
        const spill = [...p.querySelectorAll('figure')].some((f) => f.getBoundingClientRect().right > s.right + 1);
        return { id: sec.id || sec.className, side: pr.left >= tr.right - 1 && Math.abs(pr.top - tr.top) < 4 && !spill, spill, empty: +Math.max(...rows).toFixed(2) };
      }));
      const bad = fill.filter((f) => !f.side || f.empty > 0.35);
      check(fill.length >= 10 && !bad.length, `${t}: every section is text beside pictures, worst empty share ${Math.max(...fill.map((f) => f.empty))} (limit 0.35)`, JSON.stringify(bad));
      const shots = argVal('--shots');
      if (shots) {
        fs.mkdirSync(shots, { recursive: true });
        await page.evaluate(async () => { for (const i of document.images) { i.loading = 'eager'; } await Promise.all([...document.images].map((i) => i.decode().catch(() => {}))); });
        await page.screenshot({ path: path.join(shots, 's46-page-1440.png'), fullPage: true });
        await page.locator('#day').screenshot({ path: path.join(shots, 's46-day-1440.png') });
        await page.evaluate(() => window.scrollTo(0, 0));
      }
    }
  }
  // Click the third picture in page order: opens on its full-size file with its alt text as the caption.
  const third = order[2];
  // Opened by a click that leaves focus where it was, as Safari does with a tapped button: the browser's own
  // dialog focus return then lands on the page, so only the page's explicit return puts it back on the picture.
  await page.evaluate((full) => { document.activeElement && document.activeElement.blur && document.activeElement.blur(); document.querySelector(`button.zoom[data-full="${full}"]`).click(); }, third.full);
  await page.waitForTimeout(250);
  let s = await state();
  if (!only) check(s.open && s.src === third.full && s.cap === third.alt && s.inside, `${t}: a click opens the dialog on that picture, caption is its alt text, focus inside`, JSON.stringify(s));
  if (!only) {
    let trapped = true;
    for (let i = 0; i < 6; i++) { await page.keyboard.press('Tab'); if (!(await state()).inside) trapped = false; }
    for (let i = 0; i < 6; i++) { await page.keyboard.press('Shift+Tab'); if (!(await state()).inside) trapped = false; }
    check(trapped, `${t}: Tab and Shift+Tab stay inside the dialog`);
    await page.keyboard.press('ArrowRight'); const r1 = await state();
    await page.keyboard.press('ArrowRight'); const r2 = await state();
    await page.keyboard.press('ArrowLeft'); await page.keyboard.press('ArrowLeft'); await page.keyboard.press('ArrowLeft'); const l1 = await state();
    check(r1.src === order[3].full && r2.src === order[4].full && l1.src === order[1].full, `${t}: arrow keys move through the pictures in page order`, [r1.src, r2.src, l1.src].map((x) => path.basename(x)).join(' '));
    if (phone) {
      const cdp = await ctx.newCDPSession(page);
      const from = (await state()).src;
      const touch = (type, x) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y: 380 }] });
      await touch('touchStart', 300); await touch('touchMove', 200); await touch('touchMove', 100); await touch('touchEnd', 100);
      await page.waitForTimeout(150);
      check(from === order[1].full && (await state()).src === order[2].full, `${t}: a left swipe moves to the next picture`);
    }
  }
  await page.keyboard.press('Escape'); await page.waitForTimeout(200);
  s = await state();
  const back = await page.evaluate((full) => !!(document.activeElement && document.activeElement.dataset && document.activeElement.dataset.full === full), third.full);
  check(!s.open && back, `${t}: Escape closes and focus returns to the picture that opened it`, JSON.stringify({ open: s.open, active: s.active }));
  if (!only) {
    // Keyboard only: focus a picture, Enter opens, the Close button shuts it, focus back on that picture.
    const first = order[0];
    await page.locator(`button.zoom[data-full="${first.full}"]`).focus();
    await page.keyboard.press('Enter'); await page.waitForTimeout(200);
    const e1 = await state();
    await page.locator('#lb-close').click(); await page.waitForTimeout(200);
    const e2 = await page.evaluate((full) => ({ open: document.getElementById('lightbox').open, back: !!(document.activeElement && document.activeElement.dataset.full === full) }), first.full);
    check(e1.open && e1.src === first.full && !e2.open && e2.back, `${t}: Enter opens it, Close shuts it, focus back on the picture`, JSON.stringify({ e1, e2 }));
    check(!errs.length, `${t}: no page errors`, errs.join(' | '));
  }
  await ctx.close();
}

{
  // Files this branch does not carry yet (site.css, site.js from S40) come from the main checkout.
  const srv = http.createServer((req, res) => {
    const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    let file = path.join(ROOT, rel);
    if (!fs.existsSync(file)) file = path.join(MAIN, rel);
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end(); return; }
    let body = fs.readFileSync(file);
    if (srv.mutant && rel === '/new-look.html') body = Buffer.from(srv.mutant[1].reduce((s, [a, b]) => s.split(a).join(b), body.toString('utf8')));
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' }); res.end(body);
  });
  await new Promise((ok) => srv.listen(0, '127.0.0.1', ok));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const browser = await chromium.launch().catch(() => chromium.launch({ channel: 'chrome' }));
  if (!MUTANTS) {
    staticChecks();
    for (const size of [1440, 360]) await runtime(browser, base, size, false);
    for (const w of [1440, 360]) {
      const r = spawnSync(process.execPath, [path.join(UX, 'redesign', 'checks', 'rules.mjs'), 'new-look.html', '--states', '--root', ROOT, '--fallback', MAIN, '--width', String(w)], { encoding: 'utf8', timeout: 150000 });
      const out = (r.stdout || '') + (r.stderr || '');
      const line = ((out.match(/state contrast:.*/) || [''])[0]).trim();
      check(r.status === 0 && /rules pass/.test(out) && /; 0 under/.test(line), `rules --states at ${w}: ${line}`, out.split('\n').slice(-12).join(' | '));
    }
    const lint = path.join(os.homedir(), '.claude', 'tools', 'copylint', 'cli.mjs');
    if (fs.existsSync(lint)) {
      const r = spawnSync(process.execPath, [lint, path.join(ROOT, 'new-look.html')], { encoding: 'utf8' });
      const tail = ((r.stdout || '') + (r.stderr || '')).trim().split('\n').pop();
      check(/ 0 errors, 0 warnings/.test(tail), `copylint: ${tail}`);
    } else console.log('note copylint is not on this machine, skipped');
  } else {
    srv.mutant = MUTANT;
    const before = fails;
    await runtime(browser, base, 1440, true);
    const caught = fails > before;
    fails = before;
    check(caught, `mutant "${MUTANT[0]}" FAILS the focus-return check`);
  }
  await browser.close(); srv.close();
  console.log(fails ? `new-look: ${fails} failed` : 'new-look: all passed');
  process.exit(fails ? 1 : 0);
}
