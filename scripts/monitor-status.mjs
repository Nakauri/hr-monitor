// Guards: LIVE shown while reconnecting; a snap missing fields breaking syncFromEngine (S4a). Files: hr_monitor.html status line. Runtime: about 35 s.
// S4a monitor checks on the fake phone bridge: the status line text per engine state (live, reconnecting,
// not found, resuming, idle), "LIVE" never shown outside the live state, Stop in the viewport with every
// section collapsed, no posture preselected until the first tap, a snapshot with missing fields leaves
// the status line as it was and refreshFromEngine still resolves, and no page errors or sideways scroll.
// Page errors and console errors fail every case. --shots <dir> also shoots each state at 360, 360 with 200% text and 1440.
// Usage: node scripts/monitor-status.mjs [--shots <dir>] [--ux <ux-audit dir>]
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
const CHART = path.join(UX, '..', 'docs', 'audit-2026-10-09', 'harness-DT', 'vendor', 'chart.umd.min.js');
const { fakeBridge } = await import(pathToFileURL(path.join(UX, 'scripts', 'fake-bridge.mjs')).href);
const { chromium } = createRequire(path.join(UX, 'kit', 'package.json'))('playwright');
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
for (const f of ['ui.css', 'ui.js', 'widget.css', 'tokens.css']) {
  const www = path.join(ROOT, 'mobile', 'www', f);
  if (!fs.existsSync(www) || fs.readFileSync(www, 'utf8') !== fs.readFileSync(path.join(ROOT, f), 'utf8')) {
    console.log(`FAIL mobile/www/${f} is missing or stale: run npm run copy-web in mobile first`); process.exit(1);
  }
}
const wwwMon = path.join(ROOT, 'mobile', 'www', 'hr_monitor.html');
if (!fs.existsSync(wwwMon) || !fs.readFileSync(wwwMon, 'utf8').includes('function renderStatusLine')) {
  console.log('FAIL mobile/www/hr_monitor.html is stale: run npm run copy-web in mobile first'); process.exit(1);
}

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png', '.woff2': 'font/woff2' };
const server = http.createServer((req, res) => {
  let rel = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  let base = ROOT;
  if (rel.startsWith('/www/')) { base = path.join(ROOT, 'mobile', 'www'); rel = rel.slice(4); }
  let file = path.join(base, rel);
  if (!fs.existsSync(file)) file = path.join(ROOT, rel);
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  fs.createReadStream(file).pipe(res);
});
await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
const BASE = `http://127.0.0.1:${server.address().port}`;
const ALLOW = /^https?:\/\/(127\.0\.0\.1|fonts\.googleapis\.com|fonts\.gstatic\.com)(:|\/)/;

const MIN = 60000;
// lostAgoMs: 42 s for reconnecting; 17 min for not found and resuming (the f2 mock's 2:14 against 2:31).
const STATES = {
  live: { scenario: 'live', sessionAgeMs: 72 * MIN + 4000, kind: 'live', head: /^Live · 808S · 1:12:0\d · no gaps$/, stop: true },
  reconnecting: { scenario: 'reconnecting', sessionAgeMs: 72 * MIN, lostAgoMs: 42000, kind: 'reconnecting', head: /^Reconnecting 0:4\d · 808S$/, stop: true },
  not_found: { scenario: 'not_found', sessionAgeMs: 72 * MIN, lostAgoMs: 17 * MIN, kind: 'not_found', head: /^Strap not found since \d{1,2}:\d\d$/, sub: /^2 gaps · 18 min missing · trying every 10 min$/, stop: true },
  resuming: { scenario: 'resuming', sessionAgeMs: 72 * MIN, lostAgoMs: 17 * MIN, kind: 'resuming', head: /^Resuming · last reading \d{1,2}:\d\d$/, stop: true },
  idle: { scenario: 'idle', kind: 'idle', head: null, stop: false },
};
// The page has watched these sessions from their start: one earlier gap of 1 min, plus the open one.
const LEDGER = (cfg) => `(() => {
  const F = window.__fake; if (!F || !F.snapshot.sessionActive) return;
  const s = F.snapshot;
  localStorage.setItem('hr_monitor_status_ledger', JSON.stringify({ start: s.sessionStartMs, gaps: ${cfg.kind === 'live' ? 0 : 1},
    missingMs: ${cfg.kind === 'live' ? 0 : MIN}, open: null, seen: Date.now(), complete: true }));
})();`;

let fails = 0;
const fail = (m) => { fails++; console.log('FAIL ' + m); };
const pass = (m) => console.log('ok   ' + m);

const browser = await chromium.launch().catch(() => chromium.launch({ channel: 'chrome' }));

async function openMonitor(cfg, size) {
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
  await ctx.addInitScript(fakeBridge({ scenario: cfg.scenario, savedStrap: true, signedIn: true, sessionAgeMs: cfg.sessionAgeMs, lostAgoMs: cfg.lostAgoMs }));
  if (cfg.kind !== 'idle' && cfg.kind !== 'resuming') await ctx.addInitScript(LEDGER(cfg));
  // No strap readings reach the page, so the engine's lastHrAtMs is the only last-reading time.
  if (cfg.noTicks) await ctx.addInitScript(`(() => { const h = window.Capacitor && window.Capacitor.Plugins.NativeHrSession; if (!h) return;
    const add = h.addListener; h.addListener = (n, cb) => add(n, n === 'hr' ? () => {} : cb); })();`);
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errs.push('console: ' + m.text().split('\n')[0]); });
  await page.goto(`${BASE}/www/hr_monitor.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction((k) => {
    const el = document.getElementById('status-line');
    return el && (k === 'idle' ? el.dataset.kind === 'idle' || /Start session|Reconnect to/.test(document.getElementById('session-toggle').textContent) : el.dataset.kind === k);
  }, cfg.kind, { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(1300);
  return { ctx, page, errs };
}

async function textScale(page, f) {
  await page.evaluate((f) => {
    const els = [...document.querySelectorAll('body, body *')].filter((e) => !e.dataset.uxFs && !(e instanceof SVGElement));
    const sizes = els.map((e) => parseFloat(getComputedStyle(e).fontSize));
    els.forEach((e, i) => { e.dataset.uxFs = String(sizes[i]); e.style.setProperty('font-size', sizes[i] * f + 'px', 'important'); });
  }, f);
}

function readState(page) {
  return page.evaluate(() => {
    const vis = (e) => { if (!e) return false; const cs = getComputedStyle(e); if (cs.display === 'none' || cs.visibility === 'hidden') return false; const b = e.getBoundingClientRect(); return b.width > 0 && b.height > 0; };
    const sl = document.getElementById('status-line');
    const btn = document.getElementById('session-toggle');
    const b = btn.getBoundingClientRect();
    const sections = [...document.querySelectorAll('.section[data-section]')];
    const S = (e) => (e ? e.getBoundingClientRect() : null);
    // Phone rules on the parts this step built: 44 px targets, 12 px text, 14 px icons.
    const scope = [sl, btn.parentElement, document.querySelector('.posture-sticky'), ...sections.map((s) => s.querySelector('.section-header'))].filter(Boolean);
    const tiny = [], small = [];
    for (const root of scope) {
      const targets = root.matches('button') ? [root] : [...root.querySelectorAll('button')];
      targets.filter(vis).forEach((t) => { const r = t.getBoundingClientRect(); if (r.width < 43.5 || r.height < 43.5) tiny.push(Math.round(r.width) + 'x' + Math.round(r.height) + ' ' + t.textContent.trim().slice(0, 20)); });
      const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT); let n;
      while ((n = w.nextNode())) { const t = n.textContent.trim(); const el = n.parentElement; if (!t || !vis(el) || el.closest('.sr-only')) continue; const f = parseFloat(getComputedStyle(el).fontSize); if (f < 11.95) small.push(f + 'px ' + t.slice(0, 20)); }
    }
    const icons = [...document.querySelectorAll('.section-caret, .nav-ext-icon')].filter(vis).map((s) => s.getBoundingClientRect()).filter((r) => r.width < 13.5 || r.height < 13.5).length;
    return {
      kind: sl.dataset.kind || '', shown: vis(sl),
      head: sl.querySelector('.state').textContent, sub: vis(sl.querySelector('.sub')) ? sl.querySelector('.sub').textContent : '',
      legacy: document.getElementById('overlay-status').textContent,
      zoneText: document.getElementById('overlay-zone').innerText,
      bodyText: document.body.innerText,
      stopText: btn.textContent.trim(), stopVisible: vis(btn) && b.top >= 0 && b.bottom <= innerHeight,
      collapsed: sections.every((s) => s.classList.contains('collapsed')),
      inert: sections.every((s) => s.querySelector('.section-body').hasAttribute('inert') && s.querySelector('.section-header').getAttribute('aria-expanded') === 'false'),
      pressed: [...document.querySelectorAll('.posture-btn[aria-pressed="true"]')].map((x) => x.dataset.posture),
      overflow: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) > innerWidth + 1
        || [...document.querySelectorAll('.app-nav > *, #overlay-zone, #control-panel > *')].some((e) => vis(e) && e.getBoundingClientRect().right > innerWidth + 1),
      statusBox: S(sl), widgetBox: S(document.getElementById('hr-widget')),
      tiny, small, icons,
    };
  });
}

function checkState(name, cfg, s, tag) {
  const t = `${name} ${tag}`;
  if (s.kind !== cfg.kind) fail(`${t}: status kind "${s.kind}", want ${cfg.kind}`);
  if (cfg.head) {
    if (!s.shown) fail(`${t}: status line hidden`);
    else if (!cfg.head.test(s.head)) fail(`${t}: status "${s.head}" does not match ${cfg.head}`);
    if (cfg.sub && !cfg.sub.test(s.sub)) fail(`${t}: sub "${s.sub}" does not match ${cfg.sub}`);
  } else if (s.shown && /live/i.test(s.head)) fail(`${t}: idle status reads "${s.head}"`);
  if (/\bLIVE\b/.test(s.bodyText)) fail(`${t}: "LIVE" in the page text`);
  if (cfg.kind !== 'live' && (/\blive\b/i.test(s.head + ' ' + s.sub) || /\blive\b/i.test(s.zoneText))) fail(`${t}: "live" outside the live state: ${s.head}`);
  if (s.legacy) fail(`${t}: the old overlay status still holds "${s.legacy}"`);
  if (cfg.stop && (s.stopText !== 'Stop session' || !s.stopVisible)) fail(`${t}: Stop "${s.stopText}" visible=${s.stopVisible}`);
  if (!s.collapsed || !s.inert) fail(`${t}: sections collapsed=${s.collapsed} inert+aria=${s.inert}`);
  if (s.pressed.length) fail(`${t}: posture preselected ${s.pressed}`);
  if (s.overflow) fail(`${t}: horizontal overflow`);
  if (tag !== '1440' && s.tiny.length) fail(`${t}: targets under 44: ${s.tiny.join('; ')}`);
  if (s.small.length) fail(`${t}: text under 12: ${s.small.join('; ')}`);
  if (s.icons) fail(`${t}: ${s.icons} icons under 14`);
}

try {
  // 1. Each state at each size.
  for (const [name, cfg] of Object.entries(STATES)) {
    for (const size of ['360', '360-text200', '1440']) {
      const { ctx, page, errs } = await openMonitor(cfg, size);
      if (size === '360-text200') { await textScale(page, 2); await page.waitForTimeout(300); }
      const s = await readState(page);
      const before = fails;
      checkState(name, cfg, s, size);
      if (errs.length) fail(`${name} ${size}: page errors ${errs.join('; ')}`);
      if (fails === before) pass(`${name} ${size}: "${s.head}"${s.sub ? ' / "' + s.sub + '"' : ''} stop=${s.stopText}`);
      if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `monitor-${name.replace('_', '-')}-${size}.png`), fullPage: size !== '1440' });
      await ctx.close();
    }
  }

  // 2. One page driven through the engine states, on a session this page has watched since its start.
  {
    const cfg = { scenario: 'live', sessionAgeMs: 120000, kind: 'live', noTicks: true };
    const { ctx, page, errs } = await openMonitor(cfg, '360');
    const drive = (st, lostAgoMs) => page.evaluate(({ st, lostAgoMs }) => {
      const F = window.__fake;
      F.snapshot = Object.assign(JSON.parse(JSON.stringify(F.states[st])), { sessionStartMs: F.snapshot.sessionStartMs, lastHrAtMs: Date.now() - lostAgoMs });
      document.dispatchEvent(new Event('visibilitychange'));
    }, { st, lostAgoMs });
    const want = [
      ['RECONNECTING', 42000, 'reconnecting', /^Reconnecting 0:4\d · 808S$/],
      ['NOT_FOUND', 42000, 'not_found', /^Strap not found since \d{1,2}:\d\d$/],
      ['RESUMING', 42000, 'resuming', /^Resuming · last reading \d{1,2}:\d\d$/],
      ['LIVE', 0, 'live', /^Live · 808S · 2:\d\d$/],
    ];
    for (const [st, lost, kind, re] of want) {
      await drive(st, lost);
      await page.waitForFunction((k) => document.getElementById('status-line').dataset.kind === k, kind, { timeout: 8000 }).catch(() => {});
      const s = await readState(page);
      checkState('drive', { kind, head: re, stop: true }, s, kind);
      if (kind === 'live' && s.sub !== '1 gap · 1 min missing') fail(`drive live: sub "${s.sub}", want the gap just seen`);
      else pass(`drive ${kind}: "${s.head}"${s.sub ? ' / "' + s.sub + '"' : ''}`);
    }
    // Posture: first tap on the default marks it without a duplicate fact; a change writes one.
    await page.click('.posture-btn[data-posture="sitting"]');
    const after1 = await page.evaluate(() => ({ p: [...document.querySelectorAll('.posture-btn[aria-pressed="true"]')].map((x) => x.dataset.posture), n: window.__fake.calls.filter((c) => c === 'logFact:posture').length }));
    await page.click('.posture-btn[data-posture="standing"]');
    const after2 = await page.evaluate(() => ({ p: [...document.querySelectorAll('.posture-btn[aria-pressed="true"]')].map((x) => x.dataset.posture), n: window.__fake.calls.filter((c) => c === 'logFact:posture').length }));
    if (after1.p.join() !== 'sitting' || after2.p.join() !== 'standing' || after2.n !== after1.n + 1) fail(`posture taps: ${JSON.stringify([after1, after2])}`);
    else pass('posture: none pressed until the first tap; a change writes one fact');
    // A collapsed section opens on its header button and its body leaves inert.
    await page.click('[data-section="stats"] .section-header');
    const open = await page.evaluate(() => { const s = document.querySelector('[data-section="stats"]'); return !s.classList.contains('collapsed') && !s.querySelector('.section-body').hasAttribute('inert') && s.querySelector('.section-header').getAttribute('aria-expanded') === 'true'; });
    if (!open) fail('section header did not open its body'); else pass('section header opens its body (aria-expanded, inert removed)');
    if (errs.length) fail('drive: page errors ' + errs.join('; '));
    await ctx.close();
  }

  // 3. Snapshots with missing or odd fields: refreshFromEngine resolves and the status line keeps its text.
  {
    const cfg = STATES.live;
    const { ctx, page, errs } = await openMonitor(cfg, '360');
    for (const [label, bad] of [
      ['odd field types', { sessionActive: true, linkState: 'recording', strapName: '808S 0025153', sessionStartMs: 'x', lastHrAtMs: NaN }],
      ['no linkState, strap or times', { sessionActive: true }],
    ]) {
      const before = await readState(page);
      const res = await page.evaluate(async (bad) => {
        const ns = window.HRMNativeHrSession;
        const orig = ns.refresh;
        let derived = null;
        ns.refresh = function () {
          const p = Promise.resolve(bad);
          const then = p.then.bind(p);
          p.then = function (a, b) { derived = then(a, b); return derived; };
          return p;
        };
        document.dispatchEvent(new Event('visibilitychange'));
        ns.refresh = orig;
        if (!derived) return { called: false };
        try {
          const v = await Promise.race([derived, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 3000))]);
          return { called: true, resolved: true, same: v === bad };
        } catch (e) { return { called: true, resolved: false, err: String(e && e.message || e) }; }
      }, bad);
      const after = await readState(page);
      const keptWord = after.head.split(' ')[0] === before.head.split(' ')[0] && after.kind === before.kind;
      if (!res.called || !res.resolved || !res.same) fail(`missing fields (${label}): refreshFromEngine ${JSON.stringify(res)}`);
      else if (label.startsWith('no') && !keptWord) fail(`missing fields (${label}): status went from "${before.head}" to "${after.head}"`);
      else if (!after.head) fail(`odd fields: status line emptied`);
      else pass(`missing fields (${label}): refreshFromEngine resolved; status "${after.head}"`);
    }
    if (errs.length) fail('missing fields: page errors ' + errs.join('; '));
    await ctx.close();
  }

  // 4. Desktop web monitor, no bridge: idle shows Start, no status-line error, no page errors.
  {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await ctx.route('**/*', (route) => {
      const u = route.request().url();
      if (/chart\.umd(\.min)?\.js/.test(u) && !u.startsWith('http://127.0.0.1')) return route.fulfill({ status: 200, contentType: 'text/javascript', body: fs.readFileSync(CHART) });
      if (ALLOW.test(u) || u.startsWith('data:')) return route.continue();
      return route.fulfill({ status: 204, body: '' });
    });
    const page = await ctx.newPage();
    const errs = [];
    page.on('pageerror', (e) => errs.push(e.message));
    await page.goto(`${BASE}/hr_monitor.html`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1500);
    const s = await page.evaluate(() => ({ btn: document.getElementById('session-toggle').textContent.trim(), kind: document.getElementById('status-line').dataset.kind || '', text: document.body.innerText }));
    if (!/Start session|Reconnect to/.test(s.btn) || /\bLIVE\b/.test(s.text) || s.kind !== 'idle') fail(`web idle: button "${s.btn}", status kind "${s.kind}" (a throwing renderer never sets it)`);
    else pass(`web idle 1440: button "${s.btn}", status kind "${s.kind}"`);
    if (errs.length) fail('web: page errors ' + errs.join('; '));
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'monitor-web-idle-1440.png') });
    await ctx.close();
  }
} finally {
  await browser.close();
  server.close();
}
console.log(fails ? `${fails} FAILED` : 'monitor-status: all pass');
process.exit(fails ? 1 : 0);
