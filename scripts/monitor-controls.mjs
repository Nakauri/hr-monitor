// Guards: accidental pocket taps on Stop, posture, Log or sharing (Khal 2026-10-12, S24). Files: hr_monitor.html Controls section, pop-out hint, Settings diagnostics row. Runtime: about 60 s; --mutants about 60 s.
// S24 checks, headless, on the fake phone bridge at 360 and 1440 and on the bare web page:
// Controls is closed on every load and nothing inside it is hittable (elementFromPoint) until one tap on its header;
// Stop lives inside it while a session runs and still asks to confirm; Start stays in the open when idle;
// the header reads the posture or "No posture", plus "Live" while sharing; the open state is not kept across loads;
// the "Hold the widget to pop it out" line shows in the app until the bubble has opened once, then never, and never on the web;
// the bar has no diagnostics chip and Settings opens diagnostics by real clicks.
// --mutants serves broken copies (Controls open by default, Stop outside the section, hint after the flag, chip back) that must FAIL.
// Usage: node scripts/monitor-controls.mjs [--mutants] [--shots <dir>] [--ux <ux-audit dir>]; each mutant reruns only the part meant to catch it.
// Needs mobile/www from `npm run copy-web` (the app page runs there with the fake bridge).

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
const SHOTS = argVal('--shots');
const MUTANTS = args.includes('--mutants');
const CHART = path.join(UX, '..', 'docs', 'audit-2026-10-09', 'harness-DT', 'vendor', 'chart.umd.min.js');
const { fakeBridge } = await import(pathToFileURL(path.join(UX, 'scripts', 'fake-bridge.mjs')).href);
const { chromium } = createRequire(path.join(UX, 'kit', 'package.json'))('playwright');
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
for (const f of ['ui.css', 'ui.js', 'widget.css', 'tokens.css', 'hr_monitor.html']) {
  const www = path.join(ROOT, 'mobile', 'www', f);
  if (!fs.existsSync(www) || (f !== 'hr_monitor.html' && fs.readFileSync(www, 'utf8') !== fs.readFileSync(path.join(ROOT, f), 'utf8'))) {
    console.log(`FAIL mobile/www/${f} is missing or stale: run npm run copy-web in mobile first`); process.exit(1);
  }
}
if (!fs.readFileSync(path.join(ROOT, 'mobile', 'www', 'hr_monitor.html'), 'utf8').includes('function placeSessionCtl')) {
  console.log('FAIL mobile/www/hr_monitor.html is stale: run npm run copy-web in mobile first'); process.exit(1);
}

// Each mutant: [name, [find, replace] pairs applied to hr_monitor.html as served, the parts of runAll that must catch it].
const MUTANT_LIST = [
  ['Controls open by default', [['<div class="section collapsed" data-section="controls">', '<div class="section" data-section="controls">'], ["if (controls) controls.classList.add('collapsed');", "if (controls) controls.classList.remove('collapsed');"]], ['rec360']],
  ['Stop outside the section', [['if (sessionOn && !inside) body.insertBefore', 'if (false && sessionOn && !inside) body.insertBefore']], ['rec360']],
  ['hint shown after the flag is set', [['h.hidden = !NATIVE || seen;', 'h.hidden = !NATIVE;']], ['hint']],
  ['diagnostics chip back in the bar', [['<span id="hrm-tips-slot" style="margin-left: auto;"></span>\n</nav>', '<span id="hrm-tips-slot" style="margin-left: auto;"></span>\n<span id="hrm-version-chip-slot"></span>\n</nav>'],
    ['<script src="./settings.js"></script>\n', '<script src="./settings.js"></script>\n<script>HRMDiagnostics.mountChip(\'#hrm-version-chip-slot\');</script>\n']], ['bar']],
];
let mutant = null;
let anchorMissing = false;

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png', '.woff2': 'font/woff2' };
const server = http.createServer((req, res) => {
  let rel = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  let base = ROOT;
  if (rel.startsWith('/www/')) { base = path.join(ROOT, 'mobile', 'www'); rel = rel.slice(4); }
  let file = path.join(base, rel);
  if (!fs.existsSync(file)) file = path.join(ROOT, rel);
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end(); return; }
  if (mutant && path.basename(file) === 'hr_monitor.html') {
    let text = fs.readFileSync(file, 'utf8');
    for (const [a, b] of mutant[1]) { if (!text.includes(a)) anchorMissing = true; text = text.split(a).join(b); }
    res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' }); res.end(text); return;
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  fs.createReadStream(file).pipe(res);
});
await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
const BASE = `http://127.0.0.1:${server.address().port}`;
const ALLOW = /^https?:\/\/(127\.0\.0\.1|fonts\.googleapis\.com|fonts\.gstatic\.com)(:|\/)/;

let fails = 0;
let results = [];
const check = (ok, label, detail) => { results.push([label, !!ok]); if (ok) console.log('ok   ' + label); else { fails++; console.log('FAIL ' + label + (detail ? '  ' + detail : '')); } };

const browser = await chromium.launch().catch(() => chromium.launch({ channel: 'chrome' }));

// The bubble opens on the fake: overlay permission granted, start answers ok.
const BUBBLE_OK = `(() => { const h = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.NativeHrSession; if (!h) return;
  h.hasOverlayPermission = () => Promise.resolve({ granted: true });
  h.startFloatingOverlay = () => { window.__bubbleOpened = (window.__bubbleOpened || 0) + 1; return Promise.resolve({ ok: true }); }; })();`;

// A returning user whose saved section states (from any build) say Controls was open.
const RETURNING = `(() => { if (!localStorage.getItem('hr_monitor_sections')) localStorage.setItem('hr_monitor_sections', JSON.stringify({ controls: false, stats: true, chart: true, events: true, connection: true, settings: true })); })();`;

async function newCtx(size, native, scenario, returning) {
  const phone = size !== '1440';
  const ctx = await browser.newContext({ viewport: phone ? { width: 360, height: 740 } : { width: 1440, height: 900 }, deviceScaleFactor: 1, isMobile: phone, hasTouch: phone });
  await ctx.route('**/*', (route) => {
    const u = route.request().url();
    if (/chart\.umd(\.min)?\.js/.test(u) && !u.startsWith('http://127.0.0.1')) return route.fulfill({ status: 200, contentType: 'text/javascript', body: fs.readFileSync(CHART) });
    if (/googleapis\.com\/(drive|upload)\//.test(u)) return route.fulfill({ status: 200, contentType: 'application/json', body: '{"files":[],"id":"fake-folder"}' });
    if (ALLOW.test(u) || u.startsWith('data:') || u.startsWith('blob:')) return route.continue();
    const js = /\.js(\?|$)/.test(u) || route.request().resourceType() === 'script';
    return route.fulfill({ status: js ? 200 : 204, contentType: js ? 'text/javascript' : 'text/plain', body: '' });
  });
  if (native) {
    await ctx.addInitScript(fakeBridge({ scenario, savedStrap: true, signedIn: true, sessionAgeMs: 72 * 60000 }));
    await ctx.addInitScript(BUBBLE_OK);
  }
  if (returning) await ctx.addInitScript(RETURNING);
  return ctx;
}
async function load(ctx, native, page) {
  page = page || await ctx.newPage();
  if (!page.__errs) {
    page.__errs = [];
    page.on('pageerror', (e) => page.__errs.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) page.__errs.push('console: ' + m.text().split('\n')[0]); });
  }
  await page.goto(`${BASE}${native ? '/www' : ''}/hr_monitor.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);
  return page;
}
const waitStop = (page) => page.waitForFunction(() => document.getElementById('session-toggle').textContent.trim() === 'Stop session', null, { timeout: 10000 }).catch(() => {});

// Hit test: scroll the target's centre into the viewport, then ask the page what a finger there would touch.
function hits(page) {
  return page.evaluate(() => {
    const T = { stop: '#session-toggle', lying: '.posture-btn[data-posture="lying"]', sitting: '.posture-btn[data-posture="sitting"]', standing: '.posture-btn[data-posture="standing"]',
      symptom: '#log-symptom', note: '#log-note', share: '#toggle-broadcast' };
    const out = {};
    for (const [k, sel] of Object.entries(T)) {
      const el = document.querySelector(sel);
      if (!el) { out[k] = 'missing'; continue; }
      let r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) { out[k] = false; continue; }
      if (r.top < 0 || r.bottom > innerHeight) { window.scrollBy(0, r.top - innerHeight / 2); r = el.getBoundingClientRect(); }
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      out[k] = !!hit && (hit === el || el.contains(hit));
    }
    window.scrollTo(0, 0);
    return out;
  });
}
const controls = (page) => page.evaluate(() => {
  const s = document.querySelector('[data-section="controls"]');
  const h = s.querySelector('.section-header');
  const r = h.getBoundingClientRect();
  return { closed: s.classList.contains('collapsed'), inert: s.querySelector('.section-body').hasAttribute('inert'), expanded: h.getAttribute('aria-expanded'),
    meta: document.getElementById('controls-meta').textContent, headH: Math.round(r.height), headInView: r.top >= 0 && r.bottom <= innerHeight,
    stopInside: !!document.getElementById('session-toggle').closest('#sec-controls-body') };
});
const hint = (page) => page.evaluate(() => {
  const h = document.getElementById('popout-hint');
  if (!h) return { shown: false, missing: true };
  const r = h.getBoundingClientRect();
  const w = document.querySelector('#overlay-zone .widget-row').getBoundingClientRect();
  return { shown: !h.hidden && getComputedStyle(h).display !== 'none' && r.height > 0, below: r.top >= w.bottom - 1, text: h.textContent.trim(), flag: localStorage.getItem('hr_monitor_popout_seen') };
});
const chipGone = (page) => page.evaluate(() => ({ chip: !!document.querySelector('#hrm-version-chip-slot, .app-nav .hrm-user-chip, .app-nav .hrm-diag-pill'), nav: document.querySelector('.app-nav').innerText }));
async function openSection(page, name) {
  if (await page.evaluate((n) => document.querySelector(`[data-section="${n}"]`).classList.contains('collapsed'), name)) await page.click(`[data-section="${name}"] .section-header`);
  await page.waitForTimeout(350);
}
async function diagnosticsBySettings(page, shot) {
  await openSection(page, 'settings');
  if (shot) { await page.locator('#open-diagnostics').scrollIntoViewIfNeeded(); await page.screenshot({ path: shot }); }
  await page.click('#open-diagnostics');
  return page.waitForSelector('.hrm-diag-section', { timeout: 5000 }).then(() => true).catch(() => false);
}

async function runAll(parts) {
  const want = (p) => !parts || parts.includes(p);
  // 1. Recording, at 360 and 1440.
  for (const size of ['360', '1440'].filter((z) => want('rec' + z))) {
    const t = `native ${size}`;
    const ctx = await newCtx(size, true, 'live', size === '360');
    const page = await load(ctx, true);
    if (MUTANTS) page.setDefaultTimeout(4000);
    await waitStop(page);
    await page.waitForTimeout(300);
    let c = await controls(page);
    check(c.closed && c.inert && c.expanded === 'false', `${t}: Controls closed on load${size === '360' ? ' for a returning user whose saved states say open' : ' on a fresh install'} (inert body, aria-expanded false)`, JSON.stringify(c));
    check(c.stopInside, `${t}: Stop session sits inside Controls while recording`);
    check(c.headInView && (size === '1440' || c.headH >= 44), `${t}: Controls header in view on load, ${c.headH} px tall`);
    check(c.meta === 'No posture', `${t}: header reads "No posture" before any posture tap`, c.meta);
    const closedHits = await hits(page);
    check(Object.values(closedHits).every((v) => v === false), `${t}: nothing in Controls is hittable while closed`, JSON.stringify(closedHits));
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `s24-recording-closed-${size}.png`) });
    await page.click('[data-section="controls"] .section-header');
    await page.waitForTimeout(400);
    c = await controls(page);
    const openHits = await hits(page);
    check(!c.closed && !c.inert && c.expanded === 'true', `${t}: one tap opens Controls`, JSON.stringify(c));
    check(Object.values(openHits).every((v) => v === true), `${t}: Stop, posture, Log and sharing all hittable once open`, JSON.stringify(openHits));
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `s24-recording-open-${size}.png`), fullPage: size !== '1440' });
    // Header follows posture and sharing.
    await page.click('.posture-btn[data-posture="sitting"]');
    check((await controls(page)).meta === 'Sitting', `${t}: header reads "Sitting" after the tap`, (await controls(page)).meta);
    await page.click('#toggle-broadcast');
    await page.waitForTimeout(300);
    const on = await page.evaluate(() => document.getElementById('toggle-broadcast').checked);
    check(on && (await controls(page)).meta === 'Sitting · Live', `${t}: header reads "Sitting · Live" while sharing`, (await controls(page)).meta);
    await page.click('#toggle-broadcast');
    await page.waitForTimeout(300);
    check((await controls(page)).meta === 'Sitting', `${t}: "Live" leaves the header when sharing stops`, (await controls(page)).meta);
    // Stop still confirms (the session is 72 min old).
    await page.click('#session-toggle');
    await page.waitForTimeout(300);
    const conf = await page.evaluate(() => ({ shown: !document.getElementById('stop-confirm').hidden, stopped: window.__fake.calls.includes('stopSession') }));
    check(conf.shown && !conf.stopped, `${t}: Stop asks to confirm and stops nothing yet`, JSON.stringify(conf));
    if (SHOTS && size === '360') await page.screenshot({ path: path.join(SHOTS, `s24-stop-confirm-${size}.png`), fullPage: true });
    await page.click('#stop-confirm-keep');
    await page.waitForTimeout(200);
    check(await page.evaluate(() => document.getElementById('stop-confirm').hidden && !window.__fake.calls.includes('stopSession')), `${t}: Keep recording closes the confirm`);
    if (SHOTS && size === '360') {
      await page.evaluate(() => { const els = [...document.querySelectorAll('body, body *')].filter((e) => !(e instanceof SVGElement)); const fs = els.map((e) => parseFloat(getComputedStyle(e).fontSize)); els.forEach((e, i) => e.style.setProperty('font-size', fs[i] * 2 + 'px', 'important')); });
      await page.waitForTimeout(300);
      await page.screenshot({ path: path.join(SHOTS, 's24-recording-open-360-text200.png'), fullPage: true });
    }
    // The open state is not kept: a reload starts closed.
    await load(ctx, true, page);
    await waitStop(page);
    c = await controls(page);
    check(c.closed && c.inert, `${t}: Controls closed again after a reload`, JSON.stringify(c));
    if (size === '360') {
      // Confirmed Stop: Stop leaves the section, Start and the after-stop lines are in the open.
      await page.click('[data-section="controls"] .section-header');
      await page.waitForTimeout(300);
      await page.click('#session-toggle');
      await page.click('#stop-confirm-stop');
      await page.waitForFunction(() => !/Stop session/.test(document.getElementById('session-toggle').textContent), null, { timeout: 8000 }).catch(() => {});
      await page.waitForTimeout(500);
      const after = await page.evaluate(() => ({ stopped: window.__fake.calls.includes('stopSession'), inside: !!document.getElementById('session-toggle').closest('.section'), afterStop: !document.getElementById('after-stop').hidden }));
      check(after.stopped && !after.inside && after.afterStop, `${t}: confirmed Stop ends the session; the button and its after-stop lines leave Controls`, JSON.stringify(after));
    }
    check(!page.__errs.length, `${t}: no page errors`, page.__errs.join('; '));
    await ctx.close();
  }

  // 2. Idle app: Start stays in the open, one tap away.
  if (want('idle')) {
    const ctx = await newCtx('360', true, 'idle');
    const page = await load(ctx, true);
    await page.waitForFunction(() => /Start session|Reconnect to/.test(document.getElementById('session-toggle').textContent), null, { timeout: 10000 }).catch(() => {});
    const s = await page.evaluate(() => { const b = document.getElementById('session-toggle'); const r = b.getBoundingClientRect(); const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return { text: b.textContent.trim(), inside: !!b.closest('.section'), hit: !!hit && (hit === b || b.contains(hit)), logHidden: document.getElementById('log-block').hidden }; });
    check(!s.inside && s.hit && s.logHidden, 'native idle 360: Start stays outside Controls and hittable; no Log row', JSON.stringify(s));
    check(!page.__errs.length, 'native idle 360: no page errors', page.__errs.join('; '));
    await ctx.close();
  }

  // 3. Pop-out hint: shown in the app before the first pop-out, gone once the bubble opens, gone after a reload.
  if (want('hint')) {
    const ctx = await newCtx('360', true, 'live');
    const page = await load(ctx, true);
    await waitStop(page);
    let h = await hint(page);
    check(h.shown && h.below && h.text === 'Hold the widget to pop it out', 'native 360: hint shown under the widget before any pop-out', JSON.stringify(h));
    const box = await page.locator('#hr-widget').boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.waitForTimeout(900);
    await page.mouse.up();
    await page.waitForTimeout(400);
    h = await hint(page);
    const opened = await page.evaluate(() => window.__bubbleOpened || 0);
    check(opened === 1 && !h.shown && h.flag === '1', 'native 360: holding the widget opens the bubble, sets the flag and hides the hint', JSON.stringify({ opened, h }));
    await load(ctx, true, page);
    h = await hint(page);
    check(!h.shown, 'native 360: hint stays hidden after a reload once the flag is set', JSON.stringify(h));
    check(!page.__errs.length, 'native hint: no page errors', page.__errs.join('; '));
    await ctx.close();
  }

  // 4. Bar and diagnostics: no chip on the app or the web; Settings opens diagnostics by real clicks. The web shows no hint.
  for (const [label, size, native] of want('bar') ? [['native 360', '360', true], ['web 1440', '1440', false]] : []) {
    const ctx = await newCtx(size, native, 'live');
    const page = await load(ctx, native);
    const g = await chipGone(page);
    check(!g.chip && !/v0\.5|\bdiag\b/i.test(g.nav), `${label}: no diagnostics chip or version in the bar`, JSON.stringify(g));
    if (!native) { const h = await hint(page); check(!h.shown, 'web 1440: no pop-out hint', JSON.stringify(h)); }
    const row = await page.evaluate(() => { const b = document.getElementById('open-diagnostics'); return b ? [...b.children].map((c) => c.textContent.trim()).join(' ') : null; });
    check(row === 'Diagnostics Version 0.5', `${label}: Settings has a Diagnostics row with the version`, row);
    check(await diagnosticsBySettings(page, SHOTS && size === '360' ? path.join(SHOTS, 's24-settings-diagnostics-row-360.png') : null), `${label}: Settings > Diagnostics opens the diagnostics panel`);
    if (SHOTS && size === '360') await page.screenshot({ path: path.join(SHOTS, 's24-diagnostics-360.png') });
    check(!page.__errs.length, `${label}: no page errors`, page.__errs.join('; '));
    await ctx.close();
  }
}

let mutantFails = 0;
try {
  if (!MUTANTS) {
    await runAll();
  } else {
    for (const m of MUTANT_LIST) {
      mutant = m; anchorMissing = false; results = []; fails = 0;
      console.log(`--- mutant: ${m[0]}`);
      try { await runAll(m[2]); } catch (e) { check(false, 'run threw', String(e && e.message || e).split(String.fromCharCode(10))[0]); }
      const bad = results.filter((r) => !r[1]);
      if (bad.length && !anchorMissing) console.log(`MUTANT ${m[0]}: FAILED as required (${bad.length} checks)`);
      else { mutantFails++; console.log(`MUTANT ${m[0]}: NOT CAUGHT${anchorMissing ? ' (anchor missing)' : ''}`); }
    }
  }
} finally {
  await browser.close();
  server.close();
}
if (MUTANTS) {
  console.log(mutantFails ? `${mutantFails} mutant(s) NOT CAUGHT` : `monitor-controls --mutants: all ${MUTANT_LIST.length} caught`);
  process.exit(mutantFails ? 1 : 0);
}
console.log(fails ? `${fails} FAILED` : 'monitor-controls: all pass');
process.exit(fails ? 1 : 0);
