// Guards: the monitor drifting off the shared components (CONSISTENCY-2026-10-12, S39; Khal 2026-10-12 "can we make sure our components are consistent?"). Files: hr_monitor.html, ui.css. Runtime: about 40 s; --mutants about 50 s.
// Headless, on the fake phone bridge at 360 (touch) and 1440 (mouse), every section open and every Settings tab shown:
// every visible button in a section body is .btn, .row-btn, .toggle, a segmented button or a tab, inside .ui;
// every visible control meets the page's --target height (44 px on touch; ui.css sets 36 px for a mouse above 600 px), a checkbox measured by its label row;
// no element has accent-color; every select sits in .field .select with appearance none; one switch design (button.toggle[role=switch] with one track size);
// a monitor toast is the shared UI.toast. --mutants serves broken copies (a legacy button outside .ui, the old toggle-switch back) that must FAIL.
// Usage: node scripts/monitor-consistency.mjs [--mutants] [--shots <dir> --tag <before|after> [--root <checkout>]] [--ux <ux-audit dir>]
// --shots alone takes Settings (each tab) and Connection pictures from the web page of --root (default this checkout) and skips the sweep.
// Needs mobile/www from `npm run copy-web` for the sweep.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { uxDir } from './ux-dir.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const argVal = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const ROOT = path.resolve(argVal('--root') || path.resolve(here, '..'));
const UX = uxDir(here, argVal('--ux'));
const SHOTS = argVal('--shots');
const TAG = argVal('--tag') || 'after';
const MUTANTS = args.includes('--mutants');
const CHART = path.join(UX, '..', 'docs', 'audit-2026-10-09', 'harness-DT', 'vendor', 'chart.umd.min.js');
const { fakeBridge } = await import(pathToFileURL(path.join(UX, 'scripts', 'fake-bridge.mjs')).href);
const { chromium } = createRequire(path.join(UX, 'kit', 'package.json'))('playwright');

if (!SHOTS) {
  for (const f of ['ui.css', 'ui.js', 'widget.css', 'tokens.css']) {
    const www = path.join(ROOT, 'mobile', 'www', f);
    if (!fs.existsSync(www) || fs.readFileSync(www, 'utf8') !== fs.readFileSync(path.join(ROOT, f), 'utf8')) {
      console.log(`FAIL mobile/www/${f} is missing or stale: run npm run copy-web in mobile first`); process.exit(1);
    }
  }
  if (!fs.readFileSync(path.join(ROOT, 'mobile', 'www', 'hr_monitor.html'), 'utf8').includes('function wireSwitch')) {
    console.log('FAIL mobile/www/hr_monitor.html is stale: run npm run copy-web in mobile first'); process.exit(1);
  }
}

// Each mutant: [name, [find, replace] pairs applied to hr_monitor.html as served].
const MUTANT_LIST = [
  ['legacy button outside .ui', [['<div class="ui stats-foot">\n          <button type="button" class="btn" id="btn-export"', '<div class="stats-foot">\n          <button type="button" id="btn-export"']]],
  ['old toggle-switch restored', [['<button type="button" class="toggle" role="switch" id="toggle-broadcast" aria-checked="false">\n            <span class="txt"><span class="t">Share live HR</span><span class="d" id="broadcast-toggle-desc">Publish live HR so other monitors and OBS can read it.</span></span>\n            <span class="streaming-status" id="relay-status">offline</span>\n            <span class="track" aria-hidden="true"></span>\n          </button>',
    '<label class="toggle-switch">\n            <input type="checkbox" id="toggle-broadcast" />\n            <span class="toggle-slider" aria-hidden="true"></span>\n          </label>\n          <div class="toggle-text">\n            <div class="toggle-label">Share live HR</div>\n            <div class="toggle-desc" id="broadcast-toggle-desc">Publish live HR so other monitors and OBS can read it.</div>\n          </div>\n          <span class="streaming-status" id="relay-status">offline</span>']]],
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
    let text = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
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

// Export answers on the fake so Export CSV reaches its "CSV saved." toast; every UI.toast call is counted.
const EXPORT_OK = `(() => { const h = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.NativeHrSession; if (h) h.exportCsv = () => Promise.resolve({ ok: true }); })();`;
const OPEN_ALL = `(() => { try { localStorage.setItem('hr_monitor_sections', JSON.stringify({ controls: true, stats: true, chart: true, events: true, connection: true, settings: true })); } catch (e) {} })();`;

async function newCtx(size, native) {
  const phone = size === '360';
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
    await ctx.addInitScript(fakeBridge({ scenario: 'live', savedStrap: true, signedIn: true, sessionAgeMs: 72 * 60000 }));
    await ctx.addInitScript(EXPORT_OK);
  }
  await ctx.addInitScript(OPEN_ALL);
  const page = await ctx.newPage();
  page.__errs = [];
  page.on('pageerror', (e) => page.__errs.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) page.__errs.push('console: ' + m.text().split('\n')[0]); });
  await page.goto(`${BASE}${native ? '/www' : ''}/hr_monitor.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);
  // Open every closed section with a real click on its header.
  for (const sel of await page.$$eval('.section.collapsed[data-section]', (s) => s.map((x) => x.dataset.section))) {
    await page.click(`.section[data-section="${sel}"] .section-header`).catch(() => {});
  }
  await page.waitForTimeout(300);
  return { ctx, page };
}

// In-page sweep of every section body. Returns the offenders per rule.
const SWEEP = () => {
  const vis = (e) => e.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) && e.getBoundingClientRect().height > 0;
  const name = (e) => (e.id ? '#' + e.id : e.tagName.toLowerCase() + (e.className && typeof e.className === 'string' ? '.' + e.className.trim().split(/\s+/).join('.') : '')) + ' "' + (e.textContent || '').trim().slice(0, 24) + '"';
  const target = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--target')) || 44;
  const scope = [...document.querySelectorAll('.section-body')];
  const inScope = (e) => scope.some((s) => s.contains(e));
  const out = { target, buttons: 0, controls: 0, notShared: [], outsideUi: [], short: [], accent: [], selects: [], switches: [], switchSizes: [] };
  for (const b of document.querySelectorAll('button')) {
    if (!inScope(b) || !vis(b)) continue;
    out.buttons++;
    // Exception: #session-toggle keeps its own Start/Stop look (S24 Controls, one per page, data-state colours).
    const shared = b.matches('.btn, .row-btn, .toggle, .segmented > button, .tabs > button, .toast .undo, .chip-removable > button, #session-toggle.btn-session-toggle');
    if (!shared) out.notShared.push(name(b));
    if (!b.closest('.ui')) out.outsideUi.push(name(b));
  }
  for (const c of document.querySelectorAll('button, select, input, textarea, a[href]')) {
    if (!inScope(c)) continue;
    const box = c.matches('input[type="checkbox"], input[type="radio"]') ? (c.closest('label') || c) : c;
    if (!vis(box) || (c.type === 'hidden')) continue;
    out.controls++;
    const h = box.getBoundingClientRect().height;
    if (h < target - 0.5) out.short.push(name(c) + ' ' + Math.round(h) + 'px');
  }
  for (const e of document.querySelectorAll('*')) { const a = getComputedStyle(e).accentColor; if (a && a !== 'auto') out.accent.push(name(e) + ' ' + a); }
  for (const s of document.querySelectorAll('select')) {
    if (!vis(s)) continue;
    const ap = getComputedStyle(s).appearance;
    if (ap !== 'none' || !s.closest('.field .select')) out.selects.push(name(s) + ' appearance ' + ap);
  }
  const switchy = new Set([...document.querySelectorAll('[role="switch"], [class*="switch"], [class*="slider"]')].filter((e) => !e.closest('#overlay-zone')));
  for (const e of switchy) {
    if (!e.matches('button.toggle[role="switch"]') || !e.querySelector(':scope > .track')) { out.switches.push(name(e)); continue; }
    if (!vis(e)) continue;
    const r = e.querySelector(':scope > .track').getBoundingClientRect();
    out.switchSizes.push(Math.round(r.width) + 'x' + Math.round(r.height));
  }
  for (const id of ['toggle-broadcast', 'audio-on', 'drive-sync-toggle']) {
    const e = document.getElementById(id);
    if (!e || !e.matches('button.toggle[role="switch"]')) out.switches.push('#' + id + ' is not button.toggle[role=switch]');
  }
  return out;
};

async function sweepAll(only) {
  for (const size of ['360', '1440']) {
    const t = `native ${size}`;
    const { ctx, page } = await newCtx(size, true);
    const seen = { notShared: new Set(), outsideUi: new Set(), short: new Set(), accent: new Set(), selects: new Set(), switches: new Set(), switchSizes: new Set() };
    let buttons = 0, controls = 0, target = 0;
    const tabs = await page.$$eval('#sec-settings-body .tabs > button', (b) => b.map((x) => x.dataset.tab));
    check(tabs.length === 3, `${t}: Settings has three tabs`, JSON.stringify(tabs));
    for (const tab of tabs) {
      await page.click(`#sec-settings-body .tabs > button[data-tab="${tab}"]`);
      await page.waitForTimeout(150);
      const sel = await page.$eval(`#sec-settings-body .tabs > button[data-tab="${tab}"]`, (b) => b.getAttribute('aria-selected'));
      if (sel !== 'true') check(false, `${t}: tab ${tab} selected after a click`, sel);
      const r = await page.evaluate(SWEEP);
      buttons += r.buttons; controls += r.controls; target = r.target;
      for (const k of Object.keys(seen)) r[k].forEach((v) => seen[k].add(v));
    }
    const list = (k) => [...seen[k]].join('; ');
    console.log(`     ${t}: ${buttons} buttons and ${controls} controls swept over 3 tabs, target ${target}px`);
    if (!only || only.includes('buttons')) {
      check(!seen.notShared.size, `${t}: every visible button is .btn, .row-btn, .toggle, segmented or a tab`, list('notShared'));
      check(!seen.outsideUi.size, `${t}: every visible button sits inside .ui`, list('outsideUi'));
    }
    if (!only || only.includes('size')) check(!seen.short.size, `${t}: every visible control is at least ${target}px tall`, list('short'));
    if (!only || only.includes('style')) {
      check(!seen.accent.size, `${t}: no element has accent-color`, list('accent'));
      check(!seen.selects.size, `${t}: every select is .field .select with no native arrow`, list('selects'));
    }
    if (!only || only.includes('switch')) check(!seen.switches.size && seen.switchSizes.size === 1, `${t}: one switch design (button.toggle[role=switch], one track size)`, list('switches') + ' | ' + list('switchSizes'));
    if (!only || only.includes('toast')) {
      await page.evaluate(() => { window.__toasts = []; const orig = UI.toast; UI.toast = function (text, opts) { window.__toasts.push(text); return orig.call(this, text, opts); }; });
      await page.click('#btn-export');
      await page.waitForTimeout(600);
      const toast = await page.evaluate(() => { const e = document.querySelector('.toast-host .toast'); return { calls: window.__toasts, shown: !!e && !!e.closest('.ui'), text: e ? e.textContent : null, legacy: !!document.querySelector('.hrm-toast, #hrm-toast') }; });
      check(toast.calls.includes('CSV saved.') && toast.shown && toast.text === 'CSV saved.' && !toast.legacy, `${t}: Export CSV toast goes through UI.toast`, JSON.stringify(toast));
    }
    check(!page.__errs.length, `${t}: no page errors`, page.__errs.join('; '));
    await ctx.close();
  }
}

async function shots() {
  fs.mkdirSync(SHOTS, { recursive: true });
  for (const size of ['360', '1440']) {
    const { ctx, page } = await newCtx(size, false);
    const tabs = await page.$$eval('#sec-settings-body .tabs > button', (b) => b.map((x) => x.dataset.tab));
    for (const tab of tabs) {
      await page.click(`#sec-settings-body .tabs > button[data-tab="${tab}"]`);
      await page.waitForTimeout(200);
      await page.locator('[data-section="settings"]').screenshot({ path: path.join(SHOTS, `s39-${TAG}-settings-${tab}-${size}.png`) });
    }
    await page.locator('[data-section="connection"]').screenshot({ path: path.join(SHOTS, `s39-${TAG}-connection-${size}.png`) });
    await ctx.close();
  }
  console.log(`shots: ${SHOTS} (${TAG})`);
}

let mutantFails = 0;
try {
  if (SHOTS) await shots();
  else if (!MUTANTS) await sweepAll();
  else {
    for (const m of MUTANT_LIST) {
      mutant = m; anchorMissing = false; results = []; fails = 0;
      console.log(`--- mutant: ${m[0]}`);
      try { await sweepAll(m[0].startsWith('legacy') ? ['buttons'] : ['switch']); } catch (e) { check(false, 'run threw', String(e && e.message || e).split('\n')[0]); }
      const bad = results.filter((r) => !r[1]);
      if (bad.length && !anchorMissing) console.log(`MUTANT ${m[0]}: FAILED as required (${bad.length} checks)`);
      else { mutantFails++; console.log(`MUTANT ${m[0]}: NOT CAUGHT${anchorMissing ? ' (anchor missing)' : ''}`); }
    }
  }
} finally {
  await browser.close();
  server.close();
}
if (SHOTS) process.exit(0);
if (MUTANTS) {
  console.log(mutantFails ? `${mutantFails} mutant(s) NOT CAUGHT` : `monitor-consistency --mutants: all ${MUTANT_LIST.length} caught`);
  process.exit(mutantFails ? 1 : 0);
}
console.log(fails ? `${fails} FAILED` : 'monitor-consistency: all pass');
process.exit(fails ? 1 : 0);
