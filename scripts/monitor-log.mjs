// S4b Log row checks, headless. Web monitor on a fake Web Bluetooth strap and a fake auto-save folder:
// a Symptom tap then Undo writes no row; a held Symptom flushes into the CSV written on Stop, at its tap time;
// a Note starting sym: or ctx: (any case) is rejected; a held Note flushes on pagehide, sanitised.
// Phone app on the fake bridge: Symptom and Note write at once through logFact (symptom / marker), no Undo.
// Also: the Log row is hidden with no session and in watch mode, 44 px targets at 360, stacked at 200% text,
// the phone widget fills the width. Page errors fail every case.
// Usage: node scripts/monitor-log.mjs [--shots <dir>] [--ux <ux-audit dir>]
// Needs mobile/www from `npm run copy-web` (the app page runs there with the fake bridge).

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const argVal = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const ROOT = path.resolve(here, '..');
const UX = path.resolve(argVal('--ux') || 'C:/Users/Khal/Desktop/Mine/HR Monitor/ux-audit');
const SHOTS = argVal('--shots');
const CHART = path.join(UX, '..', 'docs', 'audit-2026-10-09', 'harness-DT', 'vendor', 'chart.umd.min.js');
const { fakeBridge } = await import(pathToFileURL(path.join(UX, 'scripts', 'fake-bridge.mjs')).href);
const { chromium } = createRequire(path.join(UX, 'kit', 'package.json'))('playwright');
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
const wwwMon = path.join(ROOT, 'mobile', 'www', 'hr_monitor.html');
if (!fs.existsSync(wwwMon) || !fs.readFileSync(wwwMon, 'utf8').includes('function openNoteComposer')) {
  console.log('FAIL mobile/www/hr_monitor.html is stale: run npm run copy-web in mobile first'); process.exit(1);
}
for (const f of ['ui.css', 'ui.js', 'widget.css', 'tokens.css']) {
  const www = path.join(ROOT, 'mobile', 'www', f);
  if (!fs.existsSync(www) || fs.readFileSync(www, 'utf8') !== fs.readFileSync(path.join(ROOT, f), 'utf8')) {
    console.log(`FAIL mobile/www/${f} is missing or stale: run npm run copy-web in mobile first`); process.exit(1);
  }
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

let fails = 0;
const fail = (m) => { fails++; console.log('FAIL ' + m); };
const pass = (m) => console.log('ok   ' + m);
const check = (ok, m, detail) => (ok ? pass(m) : fail(m + (detail ? ': ' + detail : '')));

// A strap that ticks HR 88 with one RR per second, and a folder that keeps every auto-save write.
const FAKE_WEB = `(() => {
  window.__written = [];
  const file = (n) => ({ createWritable: async () => ({ write: async (c) => { window.__written.push({ n, c: String(c), at: Date.now() }); }, close: async () => {} }) });
  window.showDirectoryPicker = async () => ({ name: 'fake', kind: 'directory', queryPermission: async () => 'granted', requestPermission: async () => 'granted', getFileHandle: async (n) => file(n) });
  const listeners = [];
  const chr = { value: null, startNotifications: async () => chr, stopNotifications: async () => chr,
    addEventListener: (t, cb) => { if (t === 'characteristicvaluechanged') listeners.push(cb); }, removeEventListener: () => {} };
  let timer = null;
  const gatt = { connected: false,
    connect: async () => { gatt.connected = true; if (!timer) timer = setInterval(() => {
      const b = new DataView(new ArrayBuffer(4)); b.setUint8(0, 0x10); b.setUint8(1, 88); b.setUint16(2, 698, true);
      chr.value = b; listeners.forEach((cb) => cb({ target: chr }));
    }, 1000); return server; },
    disconnect: () => { gatt.connected = false; clearInterval(timer); timer = null; } };
  const server = { device: null, connected: true,
    getPrimaryService: async (s) => { if (s === 'heart_rate' || s === 0x180d || s === 0x180D) return { getCharacteristic: async () => chr }; throw new Error('no service'); } };
  const device = { name: '808S Fake', id: 'fake', gatt, addEventListener: () => {}, removeEventListener: () => {}, watchAdvertisements: async () => {} };
  server.device = device;
  Object.defineProperty(navigator, 'bluetooth', { configurable: true, value: { getDevices: async () => [], requestDevice: async () => device, getAvailability: async () => true } });
})();`;

// Records each logFact payload the app page sends to the fake bridge.
const FACT_SPY = `(() => {
  window.__facts = [];
  const p = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.NativeHrSession;
  if (!p) return;
  const orig = p.logFact;
  p.logFact = (o) => { window.__facts.push(JSON.parse(JSON.stringify(o || {}))); return orig(o); };
})();`;

async function textScale(page, f) {
  await page.evaluate((f) => {
    const els = [...document.querySelectorAll('body, body *')].filter((e) => !e.dataset.uxFs && !(e instanceof SVGElement));
    const sizes = els.map((e) => parseFloat(getComputedStyle(e).fontSize));
    els.forEach((e, i) => { e.dataset.uxFs = String(sizes[i]); e.style.setProperty('font-size', sizes[i] * f + 'px', 'important'); });
  }, f);
}

const browser = await chromium.launch().catch(() => chromium.launch({ channel: 'chrome' }));

async function newPage({ phone, native }) {
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
    await ctx.addInitScript(fakeBridge({ scenario: 'live', savedStrap: true, signedIn: true, sessionAgeMs: 5 * 60000 }));
    await ctx.addInitScript(`(() => { if (!localStorage.getItem('hr_monitor_widget_prefs')) localStorage.setItem('hr_monitor_widget_prefs', JSON.stringify({ customWidth: 263, customHeight: 208, fullWidgetsWidth: 263 })); })();`);
    await ctx.addInitScript(FACT_SPY);
  } else {
    await ctx.addInitScript(FAKE_WEB);
  }
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errs.push('console: ' + m.text().split('\n')[0]); });
  await page.goto(`${BASE}${native ? '/www' : ''}/hr_monitor.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1200);
  return { ctx, page, errs };
}

const logShown = (page) => page.evaluate(() => { const e = document.getElementById('log-block'); if (!e) return false; const cs = getComputedStyle(e); const b = e.getBoundingClientRect(); return cs.display !== 'none' && b.height > 0; });
const lastCsv = (page) => page.evaluate(() => (window.__written.length ? window.__written[window.__written.length - 1].c : ''));
function eventCells(csv) {
  const lines = csv.split('\n');
  const head = lines[0].split(',');
  const ei = head.indexOf('event');
  return { cols: head.length, rows: lines.slice(1).map((l) => l.split(',')).filter((r) => r[ei]).map((r) => ({ n: r.length, ep: Number(r[1]), ev: r[ei] })), bad: lines.slice(1).filter((l) => l && l.split(',').length !== head.length).length };
}
async function startWeb(page) {
  await page.evaluate(() => document.getElementById('autosave-toggle').click());
  await page.waitForTimeout(300);
  await page.click('#session-toggle');
  await page.waitForFunction(() => document.getElementById('session-toggle').textContent.trim() === 'Stop session', null, { timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(1500);
}
async function toast(page) {
  return page.evaluate(() => { const t = document.querySelector('.toast-host .toast'); return t ? { text: t.querySelector('.grow').textContent, undo: !!t.querySelector('.undo') } : null; });
}

try {
  // 1. Web: no session hides the row; Symptom then Undo writes nothing; a held Symptom lands at its tap time on Stop.
  {
    const { ctx, page, errs } = await newPage({ phone: true, native: false });
    check(!(await logShown(page)), 'web idle: Log row hidden with no session');
    await startWeb(page);
    check(await logShown(page), 'web live: Log row shown');
    const n0 = await page.evaluate(() => window.__written.length);
    check(n0 > 0, 'web live: the fake folder receives auto-save writes', 'writes ' + n0);
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'web-live-360.png'), fullPage: false });

    await page.click('#log-symptom');
    const t1 = await toast(page);
    check(t1 && t1.text === 'Symptom logged' && t1.undo, 'web Symptom: toast "Symptom logged" with Undo', JSON.stringify(t1));
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'web-symptom-toast-360.png') });
    await page.click('.toast-host .undo');
    await page.waitForTimeout(10800);
    const afterUndo = eventCells(await lastCsv(page));
    const listUndo = await page.evaluate(() => document.querySelectorAll('#events .event').length);
    check(afterUndo.rows.length === 0 && listUndo === 0, 'web Symptom then Undo: no event row in the CSV written after the hold, Marks list empty', JSON.stringify(afterUndo.rows));

    const tapAt = await page.evaluate(() => Date.now());
    await page.click('#log-symptom');
    await page.waitForTimeout(3000);
    const held = eventCells(await lastCsv(page));
    check(held.rows.length === 0, 'web Symptom held: not written during the Undo window');
    await page.click('#session-toggle');
    await page.waitForTimeout(1500);
    const final = eventCells(await lastCsv(page));
    const row = final.rows.find((r) => r.ev === 'sym:symptom');
    check(!!row && final.rows.length === 1 && Math.abs(row.ep - tapAt) < 1500 && final.bad === 0 && final.cols === 12,
      'web Stop: the final CSV holds one event, the held Symptom as sym:symptom at its tap time (the undone tap never written), every row 12 fields',
      JSON.stringify({ rows: final.rows, bad: final.bad, tapAt }));
    check(!(await logShown(page)), 'web after Stop: Log row hidden');
    if (errs.length) fail('web 1: page errors ' + errs.join('; '));
    await ctx.close();
  }

  // 2. Web: Note rejection, sanitising, pagehide flush, watch mode.
  {
    const { ctx, page, errs } = await newPage({ phone: true, native: false });
    await startWeb(page);
    await page.click('#log-note');
    await page.waitForSelector('#note-sheet #note-text', { timeout: 3000 });
    const focused = await page.evaluate(() => document.activeElement && document.activeElement.id);
    check(focused === 'note-text', 'Note: composer opens with the text field focused', focused);
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'web-note-composer-360.png') });
    const geo = await page.evaluate(() => { const s = document.querySelector('#note-sheet .sheet').getBoundingClientRect(); return { h: Math.round(s.height), top: Math.round(s.top) }; });
    check(geo.top <= 1 && geo.h >= 739, 'Note: full sheet on the phone', JSON.stringify(geo));
    for (const bad of ['sym:dizzy', 'CTX:water', '  Sym:x', 'ctx:']) {
      await page.fill('#note-text', bad);
      const r = await page.evaluate(() => ({ dis: document.querySelector('#note-sheet .btn.primary').disabled, err: document.getElementById('note-error').hidden ? '' : document.getElementById('note-error').textContent }));
      check(r.dis && r.err === 'A note cannot start with sym: or ctx:', `Note "${bad}": rejected inline, Done disabled`, JSON.stringify(r));
    }
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'web-note-rejected-360.png') });
    await page.keyboard.press('Enter');
    check(!!(await page.$('#note-sheet')), 'Note: Enter on a rejected note keeps the composer open');
    await page.fill('#note-text', 'felt odd,\nthen   fine');
    await page.click('#note-sheet .btn.primary');
    check(!(await page.$('#note-sheet')), 'Note: Done closes the composer');
    const t2 = await toast(page);
    check(t2 && t2.text === 'Note logged' && t2.undo, 'web Note: toast "Note logged" with Undo', JSON.stringify(t2));
    const before = eventCells(await lastCsv(page));
    check(before.rows.length === 0, 'web Note held: not written yet');
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: false })));
    await page.waitForTimeout(800);
    const after = eventCells(await lastCsv(page));
    check(after.rows.some((r) => r.ev === 'felt odd then fine') && after.bad === 0, 'web pagehide: the held Note flushes, commas and line breaks to spaces, 12 fields', JSON.stringify(after.rows));
    const toastGone = await toast(page);
    check(!toastGone, 'web pagehide: the Undo toast closes once its mark is written');
    const list = await page.evaluate(() => [...document.querySelectorAll('#events .event-label')].map((e) => e.textContent));
    check(list.join('|') === 'felt odd then fine', 'Marks list shows the note', list.join('|'));
    // A long note keeps 80 characters.
    await page.click('#log-note');
    await page.fill('#note-text', 'x'.repeat(120));
    const len = await page.evaluate(() => document.getElementById('note-text').value.length);
    check(len === 80, 'Note: 80 characters at most', String(len));
    await page.click('#note-sheet .sheet-foot .btn:not(.primary)');
    check(!(await page.$('#note-sheet')) && !(await toast(page)), 'Note: Cancel closes with no toast');
    await page.click('#log-note');
    await page.keyboard.press('Escape');
    const esc = await page.evaluate(() => ({ open: !!document.getElementById('note-sheet'), focus: document.activeElement && document.activeElement.id }));
    check(!esc.open && esc.focus === 'log-note', 'Note: Escape closes and focus returns to Note', JSON.stringify(esc));
    // Symptom shows as a word in the Marks list.
    await page.click('#log-symptom');
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: false })));
    await page.waitForTimeout(300);
    const list2 = await page.evaluate(() => [...document.querySelectorAll('#events .event-label')].map((e) => e.textContent));
    check(list2[0] === 'Symptom', 'Marks list shows sym:symptom as "Symptom"', list2.join('|'));
    await page.evaluate(() => document.body.classList.add('watch-mode'));
    check(!(await logShown(page)), 'watch mode: Log row hidden');
    await page.evaluate(() => document.body.classList.remove('watch-mode'));
    if (errs.length) fail('web 2: page errors ' + errs.join('; '));
    await ctx.close();
  }

  // 3. Phone app on the fake bridge: writes at once, no Undo; layout at 360, 200% text and 1440.
  for (const size of ['360', '360-text200', '1440']) {
    const { ctx, page, errs } = await newPage({ phone: size !== '1440', native: true });
    await page.waitForFunction(() => document.getElementById('session-toggle').textContent.trim() === 'Stop session', null, { timeout: 10000 }).catch(() => {});
    await page.waitForTimeout(800);
    if (size === '360-text200') { await textScale(page, 2); await page.waitForTimeout(300); }
    check(await logShown(page), `native ${size}: Log row shown while recording`);
    const lay = await page.evaluate(() => {
      const bs = [...document.querySelectorAll('#log-block .btn-log')].map((b) => b.getBoundingClientRect());
      const zone = document.getElementById('overlay-zone');
      const cs = getComputedStyle(zone);
      const inner = zone.getBoundingClientRect().width - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
      const row = document.querySelector('#overlay-zone .widget-row').getBoundingClientRect();
      const ico = [...document.querySelectorAll('#log-block .ico')].map((i) => i.getBoundingClientRect().width);
      const fs = [...document.querySelectorAll('#log-block .btn-log, #log-block .row-label')].map((e) => parseFloat(getComputedStyle(e).fontSize));
      return { w: bs.map((b) => Math.round(b.width)), h: bs.map((b) => Math.round(b.height)), stacked: bs.length === 2 && bs[1].top >= bs[0].bottom - 1,
        rowW: Math.round(row.width), inner: Math.round(inner), phone: document.body.classList.contains('phone-widget'), ico, fs,
        overflow: document.documentElement.scrollWidth > innerWidth + 1 };
    });
    if (size === '360') {
      // The phone row fills the screen, so the phone never writes the OBS size it sends to the overlay:
      // a stored size stays as it was (seeded 263 x 208 here), and none is invented.
      const obs = await page.evaluate(() => { const p = JSON.parse(localStorage.getItem('hr_monitor_widget_prefs') || '{}'); return { cw: p.customWidth, ch: p.customHeight, full: p.fullWidgetsWidth }; });
      check(obs.cw === 263 && obs.ch === 208 && obs.full === 263 && lay.rowW > 263, 'native 360: the stored OBS size stays 263 x 208 while the row fills the screen', JSON.stringify(obs));
    }
    if (size !== '1440') {
      check(lay.h.every((h) => h >= 44), `native ${size}: Log buttons at least 44 px tall`, lay.h.join(','));
      check(lay.phone && Math.abs(lay.rowW - lay.inner) <= 1, `native ${size}: widget fills the width`, `${lay.rowW} vs ${lay.inner}`);
    }
    check(size === '360-text200' ? lay.stacked : !lay.stacked, `native ${size}: buttons ${size === '360-text200' ? 'stacked' : 'side by side'}`, JSON.stringify(lay.w));
    check(lay.ico.every((w) => w >= 14) && lay.fs.every((f) => f >= 12), `native ${size}: icons 14 px and text 12 px or more`, JSON.stringify([lay.ico, lay.fs]));
    check(!lay.overflow, `native ${size}: no sideways scroll`);
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `native-live-${size}.png`), fullPage: size !== '1440' });
    if (size === '360') {
      await page.click('#log-symptom');
      const t = await toast(page);
      const facts = await page.evaluate(() => window.__facts.filter((f) => f.kind !== 'posture'));
      check(t && t.text === 'Symptom logged' && !t.undo, 'native Symptom: toast without Undo', JSON.stringify(t));
      check(facts.length === 1 && facts[0].kind === 'symptom' && facts[0].text === 'sym:symptom', 'native Symptom: logFact symptom sym:symptom at once', JSON.stringify(facts));
      if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'native-symptom-toast-360.png') });
      await page.click('#log-note');
      await page.fill('#note-text', 'drank water, sat down');
      await page.keyboard.press('Enter');
      const facts2 = await page.evaluate(() => window.__facts.filter((f) => f.kind !== 'posture'));
      check(facts2.length === 2 && facts2[1].kind === 'marker' && facts2[1].text === 'drank water sat down', 'native Note: logFact marker with the sanitised text at once', JSON.stringify(facts2));
      // The session ends elsewhere (notification Stop) while the composer is open: Done says so and writes nothing.
      await page.click('#log-note');
      await page.fill('#note-text', 'late note');
      await page.evaluate(() => { const F = window.__fake; F.snapshot = JSON.parse(JSON.stringify(F.states.IDLE)); document.dispatchEvent(new Event('visibilitychange')); });
      await page.waitForFunction(() => document.getElementById('log-block').hidden, null, { timeout: 8000 }).catch(() => {});
      await page.click('#note-sheet .btn.primary');
      const late = await toast(page);
      const facts3 = await page.evaluate(() => window.__facts.filter((f) => f.kind !== 'posture').length);
      check(late && late.text === 'Note not logged. The session has ended.' && facts3 === 2, 'native Note after the session ended elsewhere: not logged, toast says so', JSON.stringify([late, facts3]));
    }
    if (size === '1440') {
      await page.click('#log-note');
      await page.waitForSelector('#note-sheet #note-text', { timeout: 3000 });
      const g = await page.evaluate(() => { const r = document.querySelector('#note-sheet .sheet').getBoundingClientRect(); return { w: Math.round(r.width), cx: Math.round(r.left + r.width / 2) }; });
      check(g.w <= 560 && Math.abs(g.cx - 720) <= 1, 'native 1440: composer is a centred sheet', JSON.stringify(g));
      if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'native-note-composer-1440.png') });
    }
    if (size === '360-text200') {
      await page.click('#log-note');
      await page.waitForSelector('#note-sheet #note-text', { timeout: 3000 });
      await textScale(page, 2);
      if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'native-note-composer-360-text200.png') });
    }
    if (errs.length) fail(`native ${size}: page errors ` + errs.join('; '));
    await ctx.close();
  }
} finally {
  await browser.close();
  server.close();
}
console.log(fails ? `${fails} FAILED` : 'monitor-log: all pass');
process.exit(fails ? 1 : 0);
