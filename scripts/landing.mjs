// Landing, changelog and legal checks.
// Guards: LANDING-AUDIT 2026-10-11 (eyebrows, Inter + Space Grotesk, hero warnings flashing every loop,
//   legal draft banner, health wording in meta) and Khal's 2026-10-12 calls ("Open monitor" leads the
//   hero, the story line stays in his words, Work Sans, streamers first, a hero widget that looks real,
//   widget variants, one footer with the GitHub link, privacy text that matches the code).
// Files: index.html, legal.html, changelog.html, changelog.json, assets/landing/, widget.js, overlay.html.
// Runtime: about 60 s (static checks under 5 s; one headless Chromium for the rest).
// Usage: node scripts/landing.mjs [--root <dir>] [--shots <dir>] [--prefix s20-] [--shots-only]
//        node scripts/landing.mjs --write-changelog   (rewrites the entries in changelog.html from changelog.json)
// Mutants (story line reworded, Inter loaded) run on every call and must FAIL the static checks.

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { uxDir } from './ux-dir.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const argVal = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const ROOT = path.resolve(argVal('--root') || path.join(here, '..'));
const SHOTS = argVal('--shots');
const PREFIX = argVal('--prefix') || 's20-';
const SHOTS_ONLY = args.includes('--shots-only');
// Compare on LF: Windows checkouts (core.autocrlf) hold CRLF while the commits are LF.
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/\r\n/g, '\n');

const STORY = 'I was dealing with heart rate swings, high and low, that nobody seemed to take seriously. I wanted a quiet 24/7 way to record HR and HRV, then look back at the patterns myself over weeks and months.';
const CONDITION_WORDS = /\b(POTS|tachy\w*|orthostatic|flare|symptom\w*|arrhythm\w*|anxiety|abnormal|diagnos\w*|doctor|dysautonomia|palpitation\w*)\b/i;
const ANALYTICS = /^\s*<script\s+defer\s+src="https:\/\/cdn\.vercel-insights\.com[^>]*><\/script>\s*$/m;
const PRIVACY_CLAIMS = [
  'HR Monitor Sessions', 'drive.file', 'I never receive your recordings', 'Sign-in is only for Drive',
  'Share live HR is off until you turn it on', 'stores nothing', 'Vercel Web Analytics', 'The Android app leaves it out',
  'I do not sell or share your data', 'Clear cache', 'This page is not legal advice.', 'github.com/Nakauri/hr-monitor',
];
const VARIANTS = [
  ['Full chip', []],
  ['Slim, heart rate only', ['no-hrv', 'no-live-hr', 'no-inline-trends']],
  ['HR and HRV', ['no-live-hr', 'no-inline-trends']],
  ['No trends', ['no-inline-trends']],
];

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const fmtDate = (iso) => new Date(iso + 'T12:00:00Z').toLocaleDateString('en-CA', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });

function changelogBlock(json) {
  const days = [];
  for (const it of json.items) {
    const last = days[days.length - 1];
    if (last && last.date === it.date) last.items.push(it); else days.push({ date: it.date, items: [it] });
  }
  return days.map((d) => {
    const entries = d.items.map((it) => {
      const id = `${d.date}-${slug(it.title)}`;
      return `    <article class="entry" id="${id}">\n      <h3><a href="#${id}">${esc(it.title)}</a></h3>\n      <p>${esc(it.body)}</p>\n    </article>`;
    }).join('\n');
    return `  <section class="day">\n    <h2><time datetime="${d.date}">${fmtDate(d.date)}</time></h2>\n    <div>\n${entries}\n    </div>\n  </section>`;
  }).join('\n');
}
const MARK_A = '<!-- CHANGELOG:BEGIN -->', MARK_B = '<!-- CHANGELOG:END -->';
function withChangelog(html, json) {
  const a = html.indexOf(MARK_A), b = html.indexOf(MARK_B);
  if (a < 0 || b < 0) throw new Error('changelog.html: CHANGELOG markers missing');
  return html.slice(0, a + MARK_A.length) + '\n' + changelogBlock(json) + '\n' + html.slice(b);
}

if (args.includes('--write-changelog')) {
  const crlf = fs.readFileSync(path.join(ROOT, 'changelog.html'), 'utf8').includes('\r\n');
  const out = withChangelog(read('changelog.html'), JSON.parse(read('changelog.json')));
  fs.writeFileSync(path.join(ROOT, 'changelog.html'), crlf ? out.replace(/\n/g, '\r\n') : out);
  console.log('changelog.html entries rewritten from changelog.json');
  process.exit(0);
}

const footerOf = (html) => { const m = html.match(/<footer class="site-footer">[\s\S]*?<\/footer>/); return m ? m[0] : null; };
const headMeta = (html) => [...html.matchAll(/<title>([^<]*)<\/title>|<meta\s+(?:name|property)="(?:description|og:[^"]+|twitter:[^"]+)"\s+content="([^"]*)"/g)].map((m) => m[1] || m[2]).join(' | ');
const widgetSig = (html) => {
  const a = html.indexOf('<div class="widget-row">');
  if (a < 0) return null;
  const b = html.indexOf('<div class="compact-trend">', a);
  return [...html.slice(a, b).matchAll(/<(\w+)((?:\s+(?:class|id)="[^"]*")*)/g)].map((m) => m[1] + m[2]).join('\n');
};

function staticChecks(files, fail) {
  const { index, legal, changelog, json, overlay, monitor } = files;
  fail(!/class="[^"]*eyebrow/.test(index), 'index.html has no eyebrows');
  for (const [n, h] of [['index', index], ['legal', legal], ['changelog', changelog]]) {
    fail(!/family=Inter|Space\+Grotesk|font-family:\s*'?(Inter|Space Grotesk)/.test(h), `${n}: no Inter or Space Grotesk`);
    fail(ANALYTICS.test(h), `${n}: Vercel analytics tag present on its own line (copy-web strips it for Android)`);
    const meta = headMeta(h);
    fail(!CONDITION_WORDS.test(meta), `${n}: title, meta, OG and Twitter carry no condition words${CONDITION_WORDS.test(meta) ? ' (found "' + meta.match(CONDITION_WORDS)[0] + '")' : ''}`);
  }
  fail(index.includes(STORY), 'index.html keeps the story line exactly as Khal wrote it');
  fail(/<title>[^<]*OBS/.test(index) && /og:title" content="[^"]*OBS/.test(index), 'index.html title and og:title aim at the OBS search');
  fail(!/Draft document/i.test(legal) && !/reviewed by a lawyer/i.test(legal), 'legal.html has no draft banner or lawyer line');
  for (const c of PRIVACY_CLAIMS) fail(legal.includes(c), `legal.html states: ${c}`);
  const block = changelogBlock(json);
  fail(changelog.includes(block), 'changelog.html entries match changelog.json (run --write-changelog if not)');
  const missing = json.items.filter((it) => !changelog.includes(esc(it.title)) || !changelog.includes(esc(it.body)));
  fail(missing.length === 0, `changelog.html lists all ${json.items.length} changelog.json entries${missing.length ? ' (missing ' + missing.map((m) => m.title).join(', ') + ')' : ''}`);
  fail(index.includes('href="./changelog.html"'), 'index.html links the changelog');
  const feet = [index, legal, changelog].map(footerOf);
  fail(feet.every((f) => f && f === feet[0]), 'footer identical on index, changelog and legal');
  fail(!!feet[0] && feet[0].includes('https://github.com/Nakauri/hr-monitor"') && feet[0].includes('Source on GitHub'), 'footer links the GitHub source');
  fail(!/Heart rate high|HRV crashed/.test(index) && index.includes('W.WARN_TEXT[warn]'), 'hero warning text comes from widget.js WARN_TEXT, not a copy');
  fail(/HRWidget\.WARN_TEXT/.test(overlay) && /HRWidget\.WARN_TEXT/.test(monitor), 'overlay.html and hr_monitor.html read the same WARN_TEXT');
  fail(widgetSig(index) && widgetSig(index) === widgetSig(overlay), 'hero widget markup matches overlay.html (tags, classes, ids)');
  fail(!/(\.big-number|\.compact-hrv|\.pip\b|#hr-widget)/.test((index.match(/<style>([\s\S]*?)<\/style>/) || [, ''])[1]),'index.html carries no widget styling (widget.css only)');
}

function runStatic() {
  const files = { index: read('index.html'), legal: read('legal.html'), changelog: read('changelog.html'), json: JSON.parse(read('changelog.json')), overlay: read('overlay.html'), monitor: read('hr_monitor.html') };
  const fails = [];
  staticChecks(files, (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) fails.push(what); });
  // Mutants: each must trip at least one static check.
  const mutants = {
    'story line reworded': { ...files, index: files.index.replace('nobody seemed to take seriously', 'no one seemed to take seriously') },
    'Inter loaded': { ...files, index: files.index.replace('</head>', '<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600&display=swap" rel="stylesheet">\n</head>') },
  };
  for (const [name, m] of Object.entries(mutants)) {
    let caught = 0;
    staticChecks(m, (ok) => { if (!ok) caught++; });
    console.log(`${caught ? 'ok  ' : 'FAIL'} mutant "${name}" fails the checks (${caught} failing)`);
    if (!caught) fails.push(`mutant ${name} passed`);
  }
  // Images.
  const dir = path.join(ROOT, 'assets', 'landing');
  const imgs = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
  const big = imgs.filter((f) => fs.statSync(path.join(dir, f)).size > 250 * 1024);
  console.log(`${big.length ? 'FAIL' : 'ok  '} ${imgs.length} images under assets/landing, none over 250 KB ${big.join(' ')}`);
  if (big.length || !imgs.length) fails.push('images');
  const refs = [...files.index.matchAll(/(?:src|srcset)="\.\/(assets\/landing\/[^"]+)"/g)].map((m) => m[1]);
  const gone = refs.filter((r) => !fs.existsSync(path.join(ROOT, r)));
  console.log(`${gone.length ? 'FAIL' : 'ok  '} ${refs.length} landing image references resolve ${gone.join(' ')}`);
  if (gone.length) fails.push('image refs');
  // Parse checks: the project script, plus changelog.html's inline scripts (it has none today).
  const pc = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'parse-check.cjs')], { encoding: 'utf8' });
  const pcBad = pc.status !== 0 || !/\[ok\]\s+index\.html/.test(pc.stdout) || !/\[ok\]\s+legal\.html/.test(pc.stdout);
  let clBad = 0;
  for (const m of files.changelog.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)) { try { new Function(m[1]); } catch { clBad++; } }
  console.log(`${pcBad || clBad ? 'FAIL' : 'ok  '} parse-check: index.html, legal.html, changelog.html`);
  if (pcBad || clBad) fails.push('parse-check');
  // Copylint.
  // Khal kept "This page is not legal advice." word for word (2026-10-12); the narrates-the-app rule flags "this page".
  const COPY_ALLOWED = [/^ERROR\s+narrates the app\s+legal\.html:\d+\s+Last updated: [^\n]*This page is not legal advice\.$/];
  const cl = spawnSync(process.execPath, [path.join(os.homedir(), '.claude', 'tools', 'copylint', 'cli.mjs'), 'index.html', 'legal.html', 'changelog.html'], { cwd: ROOT, encoding: 'utf8' });
  const clOut = cl.stdout + cl.stderr;
  const clErrors = (clOut.match(/^ERROR[^\n]*\n[^\n]*/gm) || []).map((e) => e.trim()).filter((e) => !COPY_ALLOWED.some((re) => re.test(e)));
  const clOk = /\d+ strings in 3 files/.test(clOut) && clErrors.length === 0 && !/[1-9]\d* warnings?/.test(clOut);
  console.log(`${clOk ? 'ok  ' : 'FAIL'} copylint on index.html, legal.html, changelog.html (${clErrors.length} errors besides the kept legal line)${clOk ? '' : '\n' + clOut.trim()}`);
  if (!clOk) fails.push('copylint');
  return fails;
}

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png', '.webp': 'image/webp', '.woff2': 'font/woff2', '.jpg': 'image/jpeg' };
function serve(root) {
  const server = http.createServer((req, res) => {
    let rel = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (rel.endsWith('/')) rel += 'index.html';
    const file = path.join(root, rel);
    if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(fs.readFileSync(file));
  });
  return new Promise((ok) => server.listen(0, '127.0.0.1', () => ok(server)));
}

async function runtime(fails) {
  const server = await serve(ROOT);
  const base = `http://127.0.0.1:${server.address().port}`;
  const KIT = argVal('--kit') || path.join(uxDir(here, argVal('--ux')), 'kit', 'package.json');
  const { chromium } = createRequire(KIT)('playwright');
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'landing-check-'));
  let browser;
  try { browser = await chromium.launch(); } catch { browser = await chromium.launch({ channel: 'chrome' }); }
  const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) fails.push(what); };
  const shotPath = (n) => { fs.mkdirSync(SHOTS, { recursive: true }); return path.join(SHOTS, PREFIX + n); };
  async function open(url, width, height, { scale = 1, clock = false } = {}) {
    const phone = width < 600;
    const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1, isMobile: phone, hasTouch: phone });
    await ctx.route('**/*', (r) => { const u = r.request().url(); return u.startsWith(base) || u.startsWith('data:') || u.startsWith('about:') || u.includes('cdnjs.cloudflare.com') ? r.continue() : r.fulfill({ status: 204, body: '' }); });
    const page = await ctx.newPage();
    page.errors = [];
    page.on('pageerror', (e) => page.errors.push(e.message));
    if (clock) await page.clock.install();
    await page.goto(base + url, { waitUntil: 'load' });
    await page.evaluate(() => document.fonts.ready);
    if (clock) await page.clock.runFor(1500); else await page.waitForTimeout(1500);
    if (scale !== 1) {
      await page.evaluate((f) => {
        const els = [...document.querySelectorAll('body, body *')].filter((e) => !(e instanceof SVGElement));
        const sizes = els.map((e) => parseFloat(getComputedStyle(e).fontSize));
        els.forEach((e, i) => e.style.setProperty('font-size', sizes[i] * f + 'px', 'important'));
        window.dispatchEvent(new Event('resize'));
      }, scale);
      await page.waitForTimeout(400);
    }
    return { ctx, page };
  }
  const heroBtn = (page) => page.evaluate(() => {
    const b = document.getElementById('hero-open-monitor'), nav = document.querySelector('.nav .btn-primary');
    const r = b && b.getBoundingClientRect(), n = nav && nav.getBoundingClientRect();
    const se = document.scrollingElement;
    return { text: b && b.textContent.trim(), inHero: !!(b && b.closest('.hero')), top: r && r.top, bottom: r && r.bottom, w: r && r.width,
      shown: !!(b && r.width > 0 && getComputedStyle(b).visibility !== 'hidden'), navShown: !!(n && n.width > 0 && n.bottom <= innerHeight),
      vh: innerHeight, overflow: se.scrollWidth - se.clientWidth };
  });
  try {
    for (const [w, h, scale, label] of [[1440, 900, 1, '1440'], [360, 740, 1, '360'], [360, 740, 2, '360 at 200% text']]) {
      const { ctx, page } = await open('/index.html', w, h, { scale });
      const r = await heroBtn(page);
      // At 200% text the hero runs past the first screen: there the hero button must render and the nav one sit on screen.
      const firstScreen = scale === 1 ? r.bottom <= r.vh : true;
      check(r.text === 'Open monitor' && r.inHero && r.shown && r.w >= 44 && firstScreen, `${label}: "Open monitor" in the hero, ${scale === 1 ? 'inside the first screen' : 'rendered'} (bottom ${Math.round(r.bottom)} of ${r.vh})`);
      check(r.navShown, `${label}: "Open monitor" in the nav, on screen`);
      if (w === 360) check(r.overflow <= 0, `${label}: no horizontal scroll (${r.overflow} px)`);
      check(page.errors.length === 0, `${label}: no page errors ${page.errors.slice(0, 2).join(' | ')}`);
      if (SHOTS) {
        if (w === 1440) {
          await page.evaluate(async () => { for (let y = 0; y < document.body.scrollHeight; y += 600) { scrollTo(0, y); await new Promise((r) => setTimeout(r, 60)); } scrollTo(0, 0); });
          await page.waitForTimeout(800);
          await page.screenshot({ path: shotPath('1440-full.png'), fullPage: true });
          await page.locator('#overlay-zone').screenshot({ path: shotPath('hero-widget.png') });
        } else await page.screenshot({ path: shotPath(scale === 2 ? '360-200-top.png' : '360-top.png') });
      }
      await ctx.close();
      if (SHOTS_ONLY && w === 1440) continue;
    }
    if (SHOTS_ONLY) return;

    // Hero widget: real factories, heart-like data, no warning over 20 s and over a full 8 minutes.
    {
      const { ctx, page } = await open('/index.html', 1440, 900, { clock: true });
      const real = await page.evaluate(() => {
        const c = window.Chart && Chart.getChart(document.getElementById('hr-live-trace'));
        const t = window.Chart && Chart.getChart(document.getElementById('compact-chart'));
        const ds = c && c.data.datasets[0];
        return { widget: !!window.HRWidget && !!document.querySelector('script[src="./widget.js"]'), live: !!ds && ds.borderWidth === 1.75 && ds.cubicInterpolationMode === 'monotone', trend: !!t && t.data.datasets.length === 2 && t.data.datasets[1].borderDash.join() === '3,3' };
      });
      check(real.widget && real.live && real.trend, 'hero charts come from widget.js createLiveTraceChart and createCompactTrendChart');
      const hrs = [], warns = [];
      let trendFit = null, liveSpan = 0;
      for (let i = 0; i < 600; i++) {
        await page.clock.runFor(800);
        const s = await page.evaluate(() => ({ hr: +document.getElementById('hr-big').textContent, w: document.getElementById('warning-banner').classList.contains('active') }));
        hrs.push(s.hr);
        if (s.w) warns.push(i);
        if (i === 300) {
          trendFit = await page.evaluate(() => {
            const ys = Chart.getChart(document.getElementById('compact-chart')).data.datasets[0].data.map((p) => p.y);
            const n = ys.length, xm = (n - 1) / 2, ym = ys.reduce((a, b) => a + b, 0) / n;
            let sxy = 0, sxx = 0; ys.forEach((y, x) => { sxy += (x - xm) * (y - ym); sxx += (x - xm) ** 2; });
            const k = sxy / sxx; const res = ys.map((y, x) => y - (ym + k * (x - xm)));
            return { n, rms: Math.sqrt(res.reduce((a, r) => a + r * r, 0) / n), range: Math.max(...ys) - Math.min(...ys) };
          });
          liveSpan = await page.evaluate(() => { const d = Chart.getChart(document.getElementById('hr-live-trace')).data.datasets[0].data.map((p) => p.y); return Math.max(...d) - Math.min(...d); });
        }
      }
      check(!warns.some((i) => i < 25), `no warning in the first 20 s (${warns.filter((i) => i < 25).length} ticks)`);
      check(warns.length === 0, `no warning over 8 minutes of the hero series (${warns.length} ticks)`);
      check(Math.min(...hrs) >= 60 && Math.max(...hrs) < 120, `hero HR stays in 60..119 (${Math.min(...hrs)}..${Math.max(...hrs)})`);
      const win = 13, diffs = [];
      for (let k = 0; k + 2 * win <= hrs.length; k += win) diffs.push(hrs.slice(k, k + win).reduce((a, v, j) => a + Math.abs(v - hrs[k + win + j]), 0) / win);
      check(diffs.every((d) => d > 0.4), `consecutive 10 s windows differ (smallest mean gap ${Math.min(...diffs).toFixed(2)} bpm)`);
      const m = hrs.reduce((a, b) => a + b, 0) / hrs.length, v = hrs.reduce((a, b) => a + (b - m) ** 2, 0);
      let maxAc = 0, lagAt = 0;
      for (let lag = 5; lag <= 120; lag++) { let c = 0; for (let i = 0; i + lag < hrs.length; i++) c += (hrs[i] - m) * (hrs[i + lag] - m); const ac = c / v; if (ac > maxAc) { maxAc = ac; lagAt = lag; } }
      check(maxAc < 0.9, `HR series is not periodic (largest autocorrelation ${maxAc.toFixed(2)} at ${(lagAt * 0.8).toFixed(0)} s)`);
      check(trendFit && trendFit.rms > 0.8 && trendFit.range >= 4, `trend line is not straight (${trendFit && trendFit.n} points, ${trendFit && trendFit.rms.toFixed(2)} bpm off a straight line, range ${trendFit && trendFit.range})`);
      check(liveSpan >= 4, `live trace moves beat to beat (span ${liveSpan.toFixed(1)} bpm over 45 s)`);
      await ctx.close();
    }

    // Widget variants in the stream section.
    {
      const { ctx, page } = await open('/index.html', 1440, 900);
      await page.waitForFunction(() => document.body.classList.contains('variants-ready'), null, { timeout: 15000 }).catch(() => {});
      await page.locator('#stream').scrollIntoViewIfNeeded();
      const sizes = [], bufs = [];
      for (const [label, cls] of VARIANTS) {
        await page.getByRole('button', { name: label, exact: true }).click();
        await page.waitForTimeout(300);
        const r = await page.evaluate(() => {
          const f = document.getElementById('variant-frame'), d = f.contentDocument, w = d.getElementById('hr-widget');
          const b = w.getBoundingClientRect();
          return { body: [...d.body.classList].filter((c) => c.startsWith('no-')).sort().join(' '), w: Math.round(b.width), h: Math.round(b.height),
            text: document.getElementById('variant-size').textContent, pressed: document.querySelector('#variant-seg [aria-pressed="true"]').textContent };
        });
        sizes.push(`${r.w}x${r.h}`);
        check(r.body === [...cls].sort().join(' ') && r.pressed === label, `variant "${label}": body classes "${r.body}"`);
        check(r.text.includes(`${r.w} × ${r.h} px`), `variant "${label}": footprint reads "${r.text}"`);
        if (SHOTS) bufs.push((await page.locator('#stream .split > div:last-child').screenshot()).toString('base64'));
      }
      check(new Set(sizes).size === VARIANTS.length, `each variant changes the widget's size (${sizes.join(', ')})`);
      const heroBody = await page.evaluate(() => [...document.body.classList].filter((c) => c.startsWith('no-')).join(' '));
      check(heroBody === '', 'variant switches leave the hero widget alone');
      if (SHOTS && bufs.length) {
        const png = await page.evaluate(async (list) => {
          const imgs = await Promise.all(list.map((b) => { const i = new Image(); i.src = 'data:image/png;base64,' + b; return i.decode().then(() => i); }));
          const c = document.createElement('canvas'); c.width = Math.max(...imgs.map((i) => i.width)) * 2 + 24; const rowH = Math.max(...imgs.map((i) => i.height));
          c.height = rowH * 2 + 24; const g = c.getContext('2d'); g.fillStyle = '#0a0a0a'; g.fillRect(0, 0, c.width, c.height);
          imgs.forEach((i, k) => g.drawImage(i, (k % 2) * (c.width / 2 + 12), Math.floor(k / 2) * (rowH + 24)));
          return c.toDataURL('image/png').split(',')[1];
        }, bufs);
        fs.writeFileSync(shotPath('variants-1440.png'), Buffer.from(png, 'base64'));
      }
      check(page.errors.length === 0, `variants: no page errors ${page.errors.slice(0, 2).join(' | ')}`);
      await ctx.close();
    }

    // Changelog and legal pages.
    for (const [url, name] of [['/changelog.html', 'changelog'], ['/legal.html', 'legal']]) {
      for (const w of [1440, 360]) {
        const { ctx, page } = await open(url, w, w < 600 ? 740 : 900);
        const r = await page.evaluate(() => ({ o: document.scrollingElement.scrollWidth - document.scrollingElement.clientWidth, n: document.querySelectorAll('.entry').length, back: !!document.querySelector('.ui.app-bar .back-link svg') }));
        check(r.o <= 0, `${name} ${w}: no horizontal scroll (${r.o} px)`);
        if (name === 'changelog' && w === 1440) {
          check(r.n === JSON.parse(read('changelog.json')).items.length, `changelog renders ${r.n} entries`);
          if (SHOTS) await page.screenshot({ path: shotPath('changelog-1440.png'), fullPage: true });
        }
        if (name === 'legal' && w === 1440) {
          check(r.back, 'legal has the app bar and a back link with an SVG chevron');
          if (SHOTS) await page.screenshot({ path: shotPath('legal-1440.png'), fullPage: true });
        }
        await ctx.close();
      }
    }
  } finally {
    await browser.close();
    server.close();
    fs.rmSync(profile, { recursive: true, force: true });
  }
}

const fails = SHOTS_ONLY ? [] : runStatic();
await runtime(fails);
console.log(fails.length ? `FAIL (${fails.length})` : 'PASS');
process.exit(fails.length ? 1 : 0);
