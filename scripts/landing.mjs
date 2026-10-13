// Landing, changelog and legal checks.
// Guards: LANDING-AUDIT 2026-10-11 (eyebrows, Inter + Space Grotesk, hero warnings flashing every loop,
//   legal draft banner, health wording in meta) and Khal's 2026-10-12 calls ("Open monitor" leads the
//   hero, the story line stays in his words, Work Sans, streamers first, a hero widget that looks real,
//   widget variants, one footer with the GitHub link, privacy text that matches the code).
// S40 (AUDIT-NOTES item 35, Khal 2026-10-12): button hover contrast on all three pages (rules.mjs --states,
//   named bug: "Open monitor" hover went dark on dark), hero H1 at most 3 lines with no one-word last line
//   ("records." alone), story logo centred on its text, the 16:9 stream frame with the widget at true scale
//   and a full-width variant row, equal Day and Month shots with one-line captions (before/after moved to new-look.html, Khal 2026-10-12), the logo back-to-top, one
//   shared nav on all three pages, Google sign-in (signed in leads to the viewer, never the monitor), and the
//   changelog: every month git shows activity has entries, area chips filter and the hash keeps the filter,
//   headings are not self-links, a shared link lands below the nav, the copy button copies the right URL.
// S43 (Khal 2026-10-12, brand motion): hovering a .btn runs one 800 ms bell-curve lap of the border trail, then a
//   0.35 resting edge, and leaving fades it; the Android card's lap ends bare; keyboard focus shows the edge with no
//   lap; boxes never move; the head crosses long and short edges at one speed (named bug: the mock's conic ring
//   ran fast on short ends and slow on long edges; that mutant must fail).
// Files: index.html, legal.html, changelog.html, changelog.json, assets/landing/ (site.css, site.js, images),
//   widget.js, overlay.html; rules.mjs from the main checkout's ux-audit folder.
// Runtime: about 75 s (static checks under 5 s; one headless Chromium plus 7 rules.mjs runs; S43 about 20 s).
// Usage: node scripts/landing.mjs [--root <dir>] [--shots <dir>] [--prefix s40-] [--shots-only] [--only-s43] [--ux <dir>]
//        node scripts/landing.mjs --write-changelog   (rewrites the entries in changelog.html from changelog.json)
// Mutants run on every call and must FAIL: story line reworded and Inter loaded (static), the old hover rule
// (rules --states), the old hero column (H1 widow) and a signed-in click that goes to the monitor.

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
const PREFIX = argVal('--prefix') || 's40-';
const SHOTS_ONLY = args.includes('--shots-only');
const ONLY_S43 = args.includes('--only-s43');
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
const AREAS = ['Monitor', 'Viewer', 'Android app', 'Stream overlay', 'Site'];
const COPY_ICON = '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/></svg>';
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
      return `    <article class="entry" id="${id}" data-area="${slug(it.area)}">\n      <h3>${esc(it.title)} <span class="badge">${esc(it.area)}</span></h3>\n      <p>${esc(it.body)}</p>\n    </article>`;
    }).join('\n');
    return `  <section class="day" id="${d.date}">\n    <div class="day-head">\n      <h2><time datetime="${d.date}">${fmtDate(d.date)}</time></h2>\n      <button class="btn icon copy-link" type="button" data-anchor="${d.date}" aria-label="Copy link to this entry">${COPY_ICON}</button>\n    </div>\n    <div>\n${entries}\n    </div>\n  </section>`;
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

const navOf = (html) => { const m = html.match(/<nav class="nav"[\s\S]*?<\/nav>/); return m ? m[0] : null; };
const styleOf = (html) => (html.match(/<style>([\s\S]*?)<\/style>/) || [, ''])[1];
const gitMonths = () => {
  const r = spawnSync('git', ['-C', ROOT, 'log', '--since=2026-04-01', '--date=format:%Y-%m', '--format=%ad'], { encoding: 'utf8' });
  return r.status === 0 ? [...new Set(r.stdout.split(/\r?\n/).filter(Boolean))].sort() : null;
};
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
  // S40: one nav on all three pages, shared buttons only, logo back-to-top, Google sign-in, changelog shape.
  const navs = [index, legal, changelog].map(navOf);
  fail(navs.every((n) => n && n === navs[0]) && /class="btn primary"[^>]*>Open monitor</.test(navs[0] || ''), 'index, changelog and legal share one nav with "Open monitor"');
  fail(!/app-bar|back-link/.test(legal + changelog), 'legal and changelog carry no separate back link');
  for (const [n, h] of [['index', index], ['legal', legal], ['changelog', changelog]]) {
    const own = [...styleOf(h).matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter((m) => /\.btn(?![\w-])/.test(m[1]) && /(^|;)\s*(background|border-color|filter)\s*:/.test(m[2])).map((m) => m[1].trim());
    fail(!/btn-primary|btn-sm|class="fab"/.test(h) && own.length === 0, `${n}: buttons use the shared ui.css .btn set (no page .btn fills)${own.length ? ' (' + own.join(', ') + ')' : ''}`);
  }
  for (const [n, h] of [['index', index], ['changelog', changelog]]) {
    const top = (h.match(/<button class="to-top" id="back-to-top"[\s\S]*?<\/button>/) || [''])[0];
    fail(/aria-label="Back to top"/.test(top) && /viewBox="0 0 1779 1642"/.test(top) && (top.match(/<path /g) || []).length === 2, `${n}: back-to-top is the aorti logo`);
  }
  // Khal 2026-10-12: the hero sign-in button sat on its own row; sign-in lives in the nav as "Sign in" with the G.
  const g = (index.match(/<a class="nav-link nav-signin"[\s\S]*?<\/a>/) || [''])[0];
  fail(/>Sign in<\/a>$/.test(g) && /#4285F4/.test(g) && /#EA4335/.test(g) && /#FBBC05/.test(g) && /#34A853/.test(g) && !/id="hero-google"/.test(index), 'nav "Sign in" carries the four-colour G and the hero has no sign-in button');
  fail(!/<h3><a href="#/.test(changelog), 'changelog entry headings are not links to themselves');
  const badArea = json.items.filter((it) => !AREAS.includes(it.area));
  fail(badArea.length === 0, `every changelog entry has an area (${AREAS.join(', ')})${badArea.length ? ' (missing on ' + badArea.map((b) => b.title).join(', ') + ')' : ''}`);
  const months = gitMonths();
  const have = new Set(json.items.map((it) => it.date.slice(0, 7)));
  const empty = (months || []).filter((m) => !have.has(m));
  fail(months && months.length && empty.length === 0, `changelog has entries in every month git shows since April (${(months || []).map((m) => m + ':' + json.items.filter((it) => it.date.startsWith(m)).length).join(' ')})${empty.length ? ' empty: ' + empty.join(', ') : ''}`);
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
  const imgs = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => /\.(webp|png|jpe?g|svg)$/.test(f)) : [];
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
    const b = document.getElementById('hero-open-monitor'), nav = document.querySelector('.nav .btn.primary');
    const r = b && b.getBoundingClientRect(), n = nav && nav.getBoundingClientRect();
    const se = document.scrollingElement;
    return { text: b && b.textContent.trim(), inHero: !!(b && b.closest('.hero')), top: r && r.top, bottom: r && r.bottom, w: r && r.width,
      shown: !!(b && r.width > 0 && getComputedStyle(b).visibility !== 'hidden'), navShown: !!(n && n.width > 0 && n.bottom <= innerHeight),
      vh: innerHeight, overflow: se.scrollWidth - se.clientWidth };
  });
  try {
    if (ONLY_S43) { await s43Checks({ open, check }); return; }
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
        if (SHOTS) bufs.push((await page.locator('#stream-preview').screenshot()).toString('base64'));
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
        const r = await page.evaluate(() => ({ o: document.scrollingElement.scrollWidth - document.scrollingElement.clientWidth, n: document.querySelectorAll('.entry').length, back: !!document.querySelector('.nav .brand[href="/"] svg') && !!document.querySelector('.nav .btn.primary') }));
        check(r.o <= 0, `${name} ${w}: no horizontal scroll (${r.o} px)`);
        if (name === 'changelog' && w === 1440) {
          check(r.n === JSON.parse(read('changelog.json')).items.length, `changelog renders ${r.n} entries`);
          if (SHOTS) await page.screenshot({ path: shotPath('changelog-1440.png') });
        }
        if (name === 'changelog' && w === 360 && SHOTS) await page.screenshot({ path: shotPath('changelog-360.png') });
        if (name === 'legal' && w === 1440) {
          check(r.back, 'legal has the site nav: logo home link and "Open monitor"');
          if (SHOTS) await page.screenshot({ path: shotPath('legal-top.png') });
        }
        await ctx.close();
      }
    }
    await s40Checks({ browser, base, open, check, shotPath });
    await s43Checks({ open, check });
  } finally {
    await browser.close();
    server.close();
    fs.rmSync(profile, { recursive: true, force: true });
  }
}

// ---- S40 checks ----
// The pre-S40 hero column and H1 rule: at 1440 it left "records." alone on a 4th line (Khal 2026-10-12).
const OLD_HERO_CSS = '.hero{grid-template-columns:minmax(0,7fr) minmax(0,5fr)!important}.hero-title{font-size:clamp(36px,4.6vw,60px)!important;line-height:1.06!important;max-width:14em!important;text-wrap:wrap!important}';
// The hover rule behind item 35a, applied to the shared button: dark text on a dark fill.
const OLD_HOVER_CSS = '<style>.btn.primary:hover{background:#0a0a0a!important;border-color:#0a0a0a!important;filter:none!important}</style>';

const h1Lines = (page) => page.evaluate(() => {
  const h = document.querySelector('.hero-title'), words = [];
  const walk = document.createTreeWalker(h, NodeFilter.SHOW_TEXT);
  for (let n; (n = walk.nextNode());) {
    const re = /\S+/g; let m;
    while ((m = re.exec(n.data))) { const r = document.createRange(); r.setStart(n, m.index); r.setEnd(n, m.index + m[0].length); words.push({ w: m[0], top: r.getBoundingClientRect().top }); }
  }
  const lines = [];
  for (const w of words) { const l = lines[lines.length - 1]; if (l && Math.abs(l.top - w.top) < 8) l.words.push(w.w); else lines.push({ top: w.top, words: [w.w] }); }
  return lines.map((l) => l.words.join(' '));
});
const h1Ok = (lines) => lines.length <= 3 && lines[lines.length - 1].split(' ').length > 1;

async function s40Checks({ browser, base, open, check, shotPath }) {
  // Hero H1: at most 3 lines and no one-word last line at 1440, 1280 and 1024; the old rule must fail.
  for (const w of [1440, 1280, 1024]) {
    const { ctx, page } = await open('/index.html', w, 900);
    const lines = await h1Lines(page);
    check(h1Ok(lines), `${w}: hero H1 in ${lines.length} lines, last line "${lines[lines.length - 1]}"`);
    if (w === 1440) {
      await page.addStyleTag({ content: OLD_HERO_CSS });
      await page.waitForTimeout(200);
      const m = await h1Lines(page);
      check(!h1Ok(m), `mutant "pre-S40 hero column" fails the H1 check (${m.length} lines, last "${m[m.length - 1]}")`);
    }
    await ctx.close();
  }

  // 1440 layout checks and section shots.
  {
    const { ctx, page } = await open('/index.html', 1440, 900);
    await page.waitForFunction(() => document.body.classList.contains('variants-ready'), null, { timeout: 15000 }).catch(() => {});
    await page.evaluate(async () => { for (let y = 0; y < document.body.scrollHeight; y += 600) { scrollTo(0, y); await new Promise((r) => setTimeout(r, 60)); } scrollTo(0, 0); });
    await page.waitForTimeout(800);
    const story = await page.evaluate(() => {
      const t = document.querySelector('.story-text').getBoundingClientRect(), l = document.querySelector('.story-logo svg').getBoundingClientRect();
      return { d: (l.top + l.height / 2) - (t.top + t.height / 2), tw: t.width };
    });
    check(Math.abs(story.d) <= 8, `story logo centred on its text (${story.d.toFixed(1)} px off, text column ${Math.round(story.tw)} px)`);
    const st = await page.evaluate(() => {
      const R = (el) => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; };
      const stage = document.getElementById('stream-frame'), ifr = document.getElementById('variant-frame');
      const btns = [...document.querySelectorAll('#variant-seg > button')].map(R);
      // The frame is a fixed 380 px OBS viewport; the widget inside it is what must sit at true scale.
      const wr = ifr.contentDocument.getElementById('hr-widget').getBoundingClientRect(), s = ifr.getBoundingClientRect().width / ifr.offsetWidth;
      return { f: R(stage), cw: stage.clientWidth, i: { x: ifr.getBoundingClientRect().x + wr.x * s, y: ifr.getBoundingClientRect().y + wr.y * s, w: wr.width * s, h: wr.height * s }, seg: R(document.getElementById('variant-seg')), ww: wr.width, btns };
    });
    const k = st.cw / 1920;
    check(Math.abs(st.f.w / st.f.h - 16 / 9) < 0.02, `stream preview is a 16:9 frame (${Math.round(st.f.w)} x ${Math.round(st.f.h)})`);
    check(st.i.x >= st.f.x && st.i.y >= st.f.y && st.i.x + st.i.w <= st.f.x + st.f.w && st.i.y + st.i.h <= st.f.y + st.f.h && Math.abs(st.i.w - st.ww * k) <= 1.5,
      `widget sits inside the frame at true scale (${st.i.w.toFixed(1)} px for ${Math.round(st.ww)} of 1920)`);
    const bw = st.btns.map((b) => b.w), bt = st.btns.map((b) => Math.round(b.y));
    check(Math.abs(st.seg.w - st.f.w) <= 1 && Math.abs(st.seg.x - st.f.x) <= 1 && Math.max(...bw) - Math.min(...bw) <= 1 && new Set(bt).size === 1,
      `variant row fills the preview width (${Math.round(st.seg.w)} of ${Math.round(st.f.w)} px, buttons ${bw.map(Math.round).join('/')}, one row)`);
    const ba = await page.evaluate(() => {
      const imgs = [...document.querySelectorAll('.ba img')].map((i) => i.getBoundingClientRect().width);
      const caps = [...document.querySelectorAll('.shot figcaption')].map((c) => { const lh = parseFloat(getComputedStyle(c).lineHeight); return { h: c.getBoundingClientRect().height, lh }; });
      return { imgs, caps };
    });
    check(ba.imgs.length === 2 && Math.abs(ba.imgs[0] - ba.imgs[1]) <= 1, `Day and Month shots are the same width (${ba.imgs.map(Math.round).join(' and ')} px)`);
    check(ba.caps.length === 2 && ba.caps.every((c) => c.h < c.lh * 1.5), `viewer captions are one line at 1440 (${ba.caps.map((c) => Math.round(c.h)).join(', ')} px)`);
    if (SHOTS) {
      await page.screenshot({ path: shotPath('hero-1440.png') });
      for (const [sel, n] of [['#story', 'why-1440.png'], ['#stream', 'stream-1440.png'], ['#viewer', 'viewer-1440.png']]) await page.locator(sel).screenshot({ path: shotPath(n) });
      const clip = await page.evaluate(() => { const a = document.getElementById('straps').getBoundingClientRect(), b = document.getElementById('questions').getBoundingClientRect(); return { x: 0, y: a.top + scrollY, width: innerWidth, height: b.bottom - a.top }; });
      await page.screenshot({ path: shotPath('straps-questions-1440.png'), fullPage: true, clip });
    }
    await page.evaluate(() => scrollTo(0, 3000));
    await page.waitForTimeout(500);
    const top = await page.evaluate(() => { const b = document.getElementById('back-to-top'), r = b.getBoundingClientRect(); return { on: b.classList.contains('visible') && getComputedStyle(b).opacity === '1', w: r.width, h: r.height, logo: !!b.querySelector('svg[viewBox="0 0 1779 1642"]'), anim: getComputedStyle(b).animationName }; });
    check(top.on && top.w === 44 && top.h === 44 && top.logo && top.anim === 'none', `back-to-top shows after scrolling: 44 px, the logo, static (${top.w}x${top.h}, animation ${top.anim})`);
    if (SHOTS) await page.screenshot({ path: shotPath('back-to-top.png'), clip: { x: 1440 - 420, y: 900 - 260, width: 420, height: 260 } });
    check(page.errors.length === 0, `1440 layout: no page errors ${page.errors.slice(0, 2).join(' | ')}`);
    await ctx.close();
  }

  // Sign-in: auth.js stubbed. Signed in leads to the viewer; signed out runs signIn then the viewer;
  // a rejected sign-in stays and says so; no auth says sign-in is unavailable.
  async function authPage({ signed = false, mode = 'ok', none = false, site = null }) {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const stub = none ? '' : `window.__calls=0;window.google={accounts:{}};window.aortiAuth={isSignedIn:()=>${signed},signIn:()=>{window.__calls++;return ${mode === 'ok' ? 'Promise.resolve({})' : "Promise.reject(new Error('network'))"};}};`;
    await ctx.route('**/*', (r) => {
      const u = r.request().url();
      if (u.endsWith('/auth.js')) return r.fulfill({ contentType: 'text/javascript', body: stub });
      if (site && u.endsWith('/assets/landing/site.js')) return r.fulfill({ contentType: 'text/javascript', body: site(read('assets/landing/site.js')) });
      return u.startsWith(base) || u.includes('cdnjs.cloudflare.com') ? r.continue() : r.fulfill({ status: 204, body: '' });
    });
    const page = await ctx.newPage();
    await page.goto(base + '/index.html', { waitUntil: 'load' });
    await page.waitForTimeout(300);
    return { ctx, page };
  }
  const goesTo = async (page, sel) => { await page.click(sel); try { await page.waitForURL(/hrv_viewer\.html/, { timeout: 4000 }); return true; } catch { return false; } };
  async function signedInCase(site) {
    const { ctx, page } = await authPage({ signed: true, site });
    const s = await page.evaluate(() => {
      const a = [...document.querySelectorAll('.nav .nav-link')].find((x) => x.textContent.trim() === 'Your sessions');
      const row = document.querySelector('[data-signin-row]');
      return { nav: !!a && a.getAttribute('href') === './hrv_viewer.html', heroHidden: !!row && row.hidden && row.getBoundingClientRect().height === 0 };
    });
    const went = await goesTo(page, '.nav .nav-link >> text=Your sessions').catch(() => false);
    await ctx.close();
    return { ...s, went };
  }
  {
    const s = await signedInCase(null);
    check(s.nav && s.heroHidden && s.went, `signed in: nav reads "Your sessions" to the viewer, hero sign-in hidden, click opens the viewer (${JSON.stringify(s)})`);
    const m = await signedInCase((src) => src.replace("const VIEWER_URL = './hrv_viewer.html';", "const VIEWER_URL = './hr_monitor.html?mode=online';"));
    check(!(m.nav && m.heroHidden && m.went), `mutant "signed-in click goes to the monitor" fails the sign-in check (${JSON.stringify(m)})`);
  }
  {
    const { ctx, page } = await authPage({ signed: false, mode: 'ok' });
    const g = await page.evaluate(() => { const b = document.querySelector('.nav [data-signin]'), r = b.getBoundingClientRect(); return { h: r.height, g: !!b.querySelector('.g-mark svg path[fill="#4285F4"]'), text: b.textContent.trim() }; });
    const went = await goesTo(page, '.nav [data-signin]');
    const calls = await page.evaluate(() => window.__calls).catch(() => null);
    check(g.g && g.text === 'Sign in' && went, `signed out: nav "Sign in" with the G (${Math.round(g.h)} px, G logo ${g.g}) runs sign-in, then opens the viewer (${went})`);
    await ctx.close();
  }
  for (const [label, opts, want] of [['rejected sign-in', { mode: 'fail' }, /did not finish/], ['no auth script', { none: true }, /unavailable/]]) {
    const { ctx, page } = await authPage(opts);
    await page.click('.nav [data-signin]');
    await page.waitForTimeout(600);
    const r = await page.evaluate(() => { const m = document.querySelector('.nav .signin-msg'); return { url: location.pathname, msg: m && !m.hidden ? m.textContent : '' }; });
    check(r.url === '/index.html' && want.test(r.msg), `${label}: stays on the page and says "${r.msg}"`);
    await ctx.close();
  }

  // Changelog: chips filter, the hash keeps the filter, no JS shows everything, shared links land below the nav.
  const json = JSON.parse(read('changelog.json'));
  {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await ctx.addInitScript(() => { Object.defineProperty(navigator, 'clipboard', { value: { writeText: async (t) => { window.__copied = t; } }, configurable: true }); });
    await ctx.route('**/*', (r) => (r.request().url().startsWith(base) ? r.continue() : r.fulfill({ status: 204, body: '' })));
    const page = await ctx.newPage();
    await page.goto(base + '/changelog.html', { waitUntil: 'load' });
    const state = () => page.evaluate(() => ({
      shown: [...document.querySelectorAll('.entry')].filter((e) => e.offsetParent !== null).map((e) => e.dataset.area),
      days: [...document.querySelectorAll('.day')].filter((d) => d.offsetParent !== null && !d.querySelector('.entry:not([hidden])')).length,
      pressed: (document.querySelector('#cl-filters [aria-pressed="true"]') || {}).textContent, hash: location.hash,
      stripTop: document.getElementById('cl-filters').getBoundingClientRect().top, y: scrollY }));
    const all = await state();
    check(all.shown.length === json.items.length && all.pressed === 'All', `changelog shows all ${all.shown.length} entries under "All"`);
    for (const area of AREAS) {
      await page.click(`#cl-filters .chip >> text="${area}"`);
      const s = await state();
      const want = json.items.filter((it) => it.area === area).length;
      check(s.shown.length === want && s.shown.every((a) => a === slug(area)) && s.days === 0 && s.hash === '#area-' + slug(area) && s.stripTop === all.stripTop && s.y === all.y,
        `chip "${area}": ${s.shown.length} of ${want} entries, no empty dates, hash ${s.hash}, strip and scroll unmoved`);
    }
    await page.reload({ waitUntil: 'load' });
    const back = await state();
    check(back.pressed === AREAS[AREAS.length - 1] && back.shown.every((a) => a === slug(AREAS[AREAS.length - 1])), `reload with ${back.hash} keeps the "${back.pressed}" filter`);
    await page.goto(base + '/changelog.html', { waitUntil: 'load' });
    const day = json.items[0].date;
    await page.locator(`[id="${day}"] .copy-link`).click();
    await page.waitForTimeout(200);
    const cp = await page.evaluate(() => ({ url: window.__copied, note: (document.querySelector('.copied') || {}).textContent }));
    check(cp.url === `${base}/changelog.html#${day}` && cp.note === 'Link copied', `copy button copies ${cp.url} and says "${cp.note}"`);
    const mid = json.items[Math.floor(json.items.length / 2)];
    const id = `${mid.date}-${slug(mid.title)}`;
    await page.goto(`${base}/changelog.html#${id}`, { waitUntil: 'load' });
    await page.waitForTimeout(400);
    const land = await page.evaluate((id) => ({ top: document.getElementById(id).getBoundingClientRect().top, nav: document.querySelector('.nav').getBoundingClientRect().bottom }), id);
    check(land.top >= land.nav - 1 && land.top <= land.nav + 48, `changelog.html#${id} lands below the nav (entry at ${Math.round(land.top)}, nav ends ${Math.round(land.nav)})`);
    await ctx.close();
    const noJs = await browser.newContext({ viewport: { width: 1440, height: 900 }, javaScriptEnabled: false });
    const p2 = await noJs.newPage();
    await p2.goto(base + '/changelog.html', { waitUntil: 'load' });
    const nj = await p2.evaluate(() => ({ n: [...document.querySelectorAll('.entry')].filter((e) => e.offsetParent !== null).length, strip: document.getElementById('cl-filters').offsetParent !== null }));
    check(nj.n === json.items.length && !nj.strip, `without JS all ${nj.n} entries show and the filter strip stays hidden`);
    await noJs.close();
  }
}

// ---- S43 checks: brand border trail (Khal 2026-10-12: "it doesnt feel smooth, maybe it needs a bell curve
// animation with 800ms?"). Named bug: the mock's rotating conic ring ran fast on short ends and slow on long
// edges. The even-speed check reads the head off screenshots (brightest red outside the element), maps it onto
// the outline, and compares how fast it crosses a long edge and a short edge per unit of the 800 ms bell curve.
const S43_LAP = 800;
const bell = (x) => {
  const B = (t, a, b) => 3 * a * t * (1 - t) ** 2 + 3 * b * t * t * (1 - t) + t ** 3;
  let lo = 0, hi = 1;
  for (let i = 0; i < 40; i++) { const m = (lo + hi) / 2; if (B(m, 0.37, 0.63) < x) lo = m; else hi = m; }
  return B((lo + hi) / 2, 0, 1);
};
// The mock's technique (brand-motion.html variant A) on the same 800 ms bell curve: must FAIL the even-speed check.
const CONIC_CSS = `@property --a{syntax:'<angle>';inherits:false;initial-value:0deg}
.trail{display:none!important}
.android-card,.btn{position:relative}
.android-card:hover::after,.btn:hover::after{content:'';position:absolute;inset:-3px;border-radius:15px;padding:2px;pointer-events:none;
background:conic-gradient(from var(--a),rgba(226,75,74,0) 0deg 240deg,rgba(226,75,74,.3) 310deg,rgba(226,75,74,1) 357deg,rgba(226,75,74,0) 360deg);
-webkit-mask:linear-gradient(#000 0 0) content-box,linear-gradient(#000 0 0);-webkit-mask-composite:xor;mask:linear-gradient(#000 0 0) content-box,linear-gradient(#000 0 0);mask-composite:exclude;
animation:s43-conic 800ms cubic-bezier(.37,0,.63,1) forwards}
@keyframes s43-conic{from{--a:0deg}to{--a:360deg}}`;

// Brightest red outside the element box in each screenshot: { m: max redness, n: pixels, x, y } in page px.
const redHeads = (page, list, clip, box) => page.evaluate(async ({ list, clip, box }) => Promise.all(list.map(async (b64) => {
  const img = new Image(); img.src = 'data:image/png;base64,' + b64; await img.decode();
  const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
  const g = c.getContext('2d'); g.drawImage(img, 0, 0);
  const d = g.getImageData(0, 0, c.width, c.height).data, red = new Float32Array(c.width * c.height);
  const x0 = box.x - clip.x, y0 = box.y - clip.y, x1 = x0 + box.width, y1 = y0 + box.height;
  let m = 0;
  for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) {
    if (x >= x0 && x + 1 <= x1 && y >= y0 && y + 1 <= y1) continue;
    const i = (y * c.width + x) * 4, v = d[i] - Math.max(d[i + 1], d[i + 2]);
    red[y * c.width + x] = v; if (v > m) m = v;
  }
  let sx = 0, sy = 0, n = 0;
  if (m >= 40) for (let k = 0; k < red.length; k++) if (red[k] >= 0.75 * m) { sx += k % c.width; sy += Math.floor(k / c.width); n++; }
  return { m, n, x: n ? clip.x + sx / n + 0.5 : null, y: n ? clip.y + sy / n + 0.5 : null };
})), { list, clip, box });

const s43Clip = (box, pad) => ({ x: Math.floor(box.x) - pad, y: Math.floor(box.y) - pad, width: Math.ceil(box.width) + 2 * pad, height: Math.ceil(box.height) + 2 * pad });
const pauseOn = (page, sel) => page.evaluate((sel) => {
  const el = document.querySelector(sel);
  window.__s43 = document.getAnimations().filter((a) => a.effect && a.effect.target && el.contains(a.effect.target));
  window.__s43.forEach((a) => a.pause());
  return window.__s43.length;
}, sel);
const seek = (page, t) => page.evaluate((t) => window.__s43.forEach((a) => { a.currentTime = t; }), t);

// Hover, pause the lap, step through it, and return the speed ratio between a long and a short edge.
async function evenSpeed(page, sel, n = 80) {
  await page.mouse.move(2, 2);
  await page.waitForTimeout(300);
  await page.locator(sel).hover();
  const paused = await pauseOn(page, sel);
  const box = await page.locator(sel).boundingBox();
  const clip = s43Clip(box, 8), shots = [];
  for (let i = 0; i <= n; i++) {
    const t = S43_LAP * i / n;
    await seek(page, t);
    shots.push({ u: bell(i / n), png: (await page.screenshot({ clip })).toString('base64') });
  }
  const heads = await redHeads(page, shots.map((s) => s.png), clip, box);
  const X0 = box.x - 2, Y0 = box.y - 2, W = box.width + 4, H = box.height + 4, P = 2 * (W + H);
  const perim = (p) => {
    const d = [Math.abs(p.y - Y0), Math.abs(p.x - (X0 + W)), Math.abs(p.y - (Y0 + H)), Math.abs(p.x - X0)];
    const k = d.indexOf(Math.min(...d)), cx = Math.min(Math.max(p.x - X0, 0), W), cy = Math.min(Math.max(p.y - Y0, 0), H);
    return [cx, W + cy, W + H + (W - cx), 2 * W + H + (H - cy)][k];
  };
  const pts = [];
  let off = 0;
  heads.forEach((h, i) => {
    if (h.x === null) return;
    let s = perim(h) + off;
    if (pts.length && s < pts[pts.length - 1].s - P / 2) { off += P; s += P; }
    pts.push({ u: shots[i].u, s });
  });
  const at = (target) => { for (let i = 1; i < pts.length; i++) { const a = pts[i - 1], b = pts[i]; if (a.s <= target && b.s >= target && b.s > a.s) return a.u + (b.u - a.u) * (target - a.s) / (b.s - a.s); } return null; };
  const speed = (from, len) => { const a = at(from + 0.2 * len), b = at(from + 0.8 * len); return a === null || b === null || b <= a ? null : (0.6 * len) / (b - a); };
  const vLong = speed(W + H, W), vShort = speed(W, H);
  await page.evaluate(() => window.__s43.forEach((a) => a.play()));
  return { paused, seen: pts.length, ratio: vLong && vShort ? vLong / vShort : null, W: Math.round(W), H: Math.round(H) };
}
const evenOk = (r) => r.ratio !== null && Math.abs(r.ratio - 1) <= 0.15;

async function s43Checks({ open, check }) {
  const shot = (n) => { fs.mkdirSync(SHOTS, { recursive: true }); return path.join(SHOTS, 's43-' + n); };
  const { ctx, page } = await open('/index.html', 1440, 900);
  const BTN = '#hero-open-monitor', CARD = '#android-app .android-card';
  const state = (sel) => page.evaluate((sel) => {
    const el = document.querySelector(sel), svg = el.querySelector(':scope > svg.trail'), r = el.getBoundingClientRect();
    const anims = document.getAnimations().filter((a) => a.effect && a.effect.target && el.contains(a.effect.target) && a.playState === 'running');
    const laps = anims.filter((a) => a.effect.getKeyframes().some((k) => 'strokeDashoffset' in k)).map((a) => {
      const k = a.effect.getKeyframes(), t = a.effect.getTiming();
      return { d: t.duration, e: t.easing, span: parseFloat(k[0].strokeDashoffset) - parseFloat(k[k.length - 1].strokeDashoffset) };
    });
    return { box: [r.x, r.y, r.width, r.height], laps, svg: svg ? +getComputedStyle(svg).opacity : null,
      rest: svg ? +getComputedStyle(svg.querySelector('.trail-rest')).opacity : null, group: svg ? +getComputedStyle(svg.querySelector('g')).opacity : null };
  }, sel);
  const sameBox = (a, b) => a.every((v, i) => Math.abs(v - b[i]) <= 0.5);
  const lapOk = (laps) => laps.length === 3 && laps.every((l) => l.d === S43_LAP && /cubic-bezier\(0?\.37, 0, 0?\.63, 1\)/.test(l.e) && Math.abs(l.span - 100) < 0.01);
  try {
    for (const [sel, name, isBtn] of [[BTN, 'primary button', true], [CARD, 'Android card', false]]) {
      await page.locator(sel).scrollIntoViewIfNeeded();
      await page.mouse.move(2, 2);
      await page.waitForTimeout(300);
      const before = (await state(sel)).box;
      await page.locator(sel).hover();
      const s0 = await state(sel);
      const boxes = [s0.box];
      for (const t of [200, 200, 200]) { await page.waitForTimeout(t); boxes.push((await state(sel)).box); }
      check(lapOk(s0.laps), `${name} hover: one lap of 800 ms on cubic-bezier(.37, 0, .63, 1) (${s0.laps.length} dashes, ${s0.laps.map((l) => l.d + ' ms ' + l.e + ' span ' + l.span.toFixed(1)).join('; ')})`);
      check(boxes.every((b) => sameBox(b, before)), `${name}: box unchanged during the lap (${before.map(Math.round).join(',')})`);
      await page.waitForTimeout(500);
      const end = await state(sel);
      const box = await page.locator(sel).boundingBox(), clip = s43Clip(box, 24);
      const [px] = await redHeads(page, [(await page.screenshot({ clip })).toString('base64')], clip, box);
      if (isBtn) {
        check(end.laps.length === 0 && Math.abs(end.rest - 0.35) < 0.01 && end.svg === 1 && px.m >= 40, `${name}: after the lap the resting edge holds at ${end.rest} opacity (red on screen ${px.m})`);
        if (SHOTS) await page.screenshot({ path: shot('btn-rest.png'), clip });
        await page.mouse.move(2, 2);
        await page.waitForTimeout(300);
        const gone = await state(sel);
        check(gone.svg === 0, `${name}: leaving fades the trail out (opacity ${gone.svg})`);
      } else {
        check(end.laps.length === 0 && end.rest === 0 && px.m < 40, `${name}: the lap ends with no edge (rest ${end.rest}, trail ${end.group}, red on screen ${px.m})`);
      }
      if (SHOTS) {
        await page.mouse.move(2, 2);
        await page.waitForTimeout(300);
        await page.locator(sel).hover();
        await pauseOn(page, sel);
        await seek(page, 400);
        await page.screenshot({ path: shot(isBtn ? 'btn-mid.png' : 'card-mid.png'), clip });
        await page.evaluate(() => window.__s43.forEach((a) => a.play()));
      }
    }
    // Keyboard focus on a button: the resting edge, no lap.
    await page.mouse.move(2, 2);
    await page.evaluate(() => document.activeElement && document.activeElement.blur());
    let hit = false;
    for (let i = 0; i < 30 && !hit; i++) { await page.keyboard.press('Tab'); hit = await page.evaluate((s) => document.activeElement === document.querySelector(s), BTN); }
    await page.waitForTimeout(200);
    const f = await state(BTN);
    check(hit && f.laps.length === 0 && Math.abs(f.rest - 0.35) < 0.01 && f.svg === 1, `keyboard focus on the primary button shows the resting edge without a lap (rest ${f.rest}, laps ${f.laps.length})`);
    await page.evaluate(() => document.activeElement.blur());
    // Even speed along the outline, then the conic mutant on the card.
    for (const [sel, name] of [[CARD, 'Android card'], [BTN, 'primary button']]) {
      await page.locator(sel).scrollIntoViewIfNeeded();
      const r = await evenSpeed(page, sel);
      check(evenOk(r), `${name}: the head crosses a long edge and a short edge at the same speed (long/short ${r.ratio && r.ratio.toFixed(2)}, ${r.W}x${r.H}, ${r.seen} frames with a head, ${r.paused} animations)`);
    }
    await page.addStyleTag({ content: CONIC_CSS });
    await page.locator(CARD).scrollIntoViewIfNeeded();
    const m = await evenSpeed(page, CARD);
    check(!evenOk(m), `mutant "conic rotation" fails the even-speed check (long/short ${m.ratio && m.ratio.toFixed(2)}, ${m.seen} frames)`);
    check(page.errors.length === 0, `S43: no page errors ${page.errors.slice(0, 2).join(' | ')}`);
  } finally { await ctx.close(); }
}

// rules.mjs --states on the three pages at 1440 and 360, plus the hover mutant that must fail.
function rulesStates(fails) {
  const RULES = path.join(uxDir(here, argVal('--ux')), 'redesign', 'checks', 'rules.mjs');
  const run = (page, width, root, extra = []) => {
    const r = spawnSync(process.execPath, [RULES, page, '--root', root, '--width', String(width), '--states', ...extra], { encoding: 'utf8', timeout: 120000 });
    const out = (r.stdout || '') + (r.stderr || '');
    const m = out.match(/state contrast: (\d+) button states on (\d+) buttons[^;]*; (\d+) under/);
    return { states: m ? +m[1] : 0, btns: m ? +m[2] : 0, under: m ? +m[3] : -1, other: out.split('\n').filter((l) => /^\s+(targets under 44|text under 12|icons under 14|glyph|wrapped)/.test(l) && !/: (0|n\/a)/.test(l)).map((l) => l.trim()) };
  };
  for (const pg of ['index.html', 'changelog.html', 'legal.html']) {
    for (const w of [1440, 360]) {
      const r = run(pg, w, ROOT);
      const ok = r.under === 0 && r.states > 0;
      console.log(`${ok ? 'ok  ' : 'FAIL'} rules --states ${pg} ${w}: ${r.states} button states on ${r.btns} buttons, ${r.under} under contrast${r.other.length ? ' (also: ' + r.other.join('; ') + ')' : ''}`);
      if (!ok) fails.push(`rules --states ${pg} ${w}`);
    }
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'landing-mutant-'));
  try {
    fs.writeFileSync(path.join(tmp, 'index.html'), read('index.html').replace('</head>', OLD_HOVER_CSS + '\n</head>'));
    const m = run('index.html', 1440, tmp, ['--fallback', ROOT]);
    const caught = m.under > 0;
    console.log(`${caught ? 'ok  ' : 'FAIL'} mutant "old hover rule" fails rules --states (${m.under} under)`);
    if (!caught) fails.push('mutant old hover rule passed');
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

const fails = SHOTS_ONLY || ONLY_S43 ? [] : runStatic();
await runtime(fails);
if (!SHOTS_ONLY && !ONLY_S43) rulesStates(fails);
console.log(fails.length ? `FAIL (${fails.length})` : 'PASS');
process.exit(fails.length ? 1 : 0);
