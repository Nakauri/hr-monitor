// S60: choose a strap other than the remembered one, from a caret on the Start button.
// Bug it guards (2026-10-16): a strap died and a new one was opened; on Android, Start ("Reconnect to <name>")
// always went to the remembered strap with no picker, and nothing let the person choose another.
// Cases, native fake bridge unless noted: (a) the caret lists known straps; a row connects to its mac, starts,
// and moves to the top; (b) Find a strap opens showPicker, connects and adds the pick; (c) Forget drops a strap
// and the Start label follows; (d) the old single-strap key migrates into the list once; (e) a remembered strap
// that fails to connect opens the picker; (f) web: Find a strap requests the HR service, never the last name;
// (g) the caret is hidden while a session runs.
// Usage: node scripts/strap-switch.mjs [--mutant <name>] [--shots <dir>] [--ux <dir>]. Each mutant must FAIL.
// Mutants: row-ignored, find-no-picker, forget-noop, no-migration, no-fallback, web-name-filter, caret-in-session.
// Needs mobile/www from `npm run copy-web`. Runtime: about 40 seconds.

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

const MUTANTS = {
  'row-ignored': ['const lastNative = (opts && opts.pick === true) ? null : ((opts && opts.strap) || getLastStrap());', 'const lastNative = (opts && opts.pick === true) ? null : getLastStrap();'],
  'find-no-picker': ["startWithStrap({ pick: true })", "startWithStrap({})"],
  'forget-noop': ['        forgetStrap(s);\n', ''],
  'no-migration': ["const old = JSON.parse(localStorage.getItem(LS_LAST_STRAP) || 'null');", 'const old = null;'],
  'no-fallback': ['if (!fromMemory || /already_active/.test(why)) throw e;', 'throw e;'],
  'web-name-filter': ['const last = pick ? null : ((opts && opts.strap) || getLastStrap());', 'const last = getLastStrap();'],
  'caret-in-session': ["const show = !sessionOn && state.connState === 'idle' && !btn.disabled", 'const show = !btn.disabled'],
};
const mutant = argVal('--mutant');
if (mutant && !MUTANTS[mutant]) { console.log('FAIL unknown mutant ' + mutant); process.exit(2); }

const WWW = path.join(ROOT, 'mobile', 'www');
const read = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').replace(/\r\n/g, '\n') : '');
const nativeSrc = read(path.join(WWW, 'hr_monitor.html'));
const webSrc = read(path.join(ROOT, 'hr_monitor.html'));
if (!nativeSrc.includes('function renderStrapMenu')) { console.log('FAIL mobile/www/hr_monitor.html missing or stale: run npm run copy-web in mobile'); process.exit(1); }
const mutate = (html) => {
  if (!mutant) return html;
  const [a, b] = MUTANTS[mutant];
  if (html.split(a).length !== 2) { console.log('FAIL mutant anchor not unique: ' + a); process.exit(1); }
  return html.replace(a, b);
};
const variants = { '/native.html': mutate(nativeSrc), '/web.html': mutate(webSrc) };

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png', '.woff2': 'font/woff2' };
const server = http.createServer((req, res) => {
  const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (variants[rel]) { res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' }); res.end(variants[rel]); return; }
  let file = path.join(WWW, rel);
  if (!fs.existsSync(file)) file = path.join(ROOT, rel);
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  fs.createReadStream(file).pipe(res);
});
await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
const BASE = `http://127.0.0.1:${server.address().port}`;
const ALLOW = /^https?:\/\/(127\.0\.0\.1|fonts\.googleapis\.com|fonts\.gstatic\.com)(:|\/)/;

const OLD = { name: '808S 0025153', mac: 'AA:BB:CC:DD:00:25' };
const POLAR = { name: 'Polar H10 9A1B2C3D', mac: 'AA:BB:CC:DD:00:26' };
const NEW = { name: 'Coospo H808S 7F2E', mac: 'AA:BB:CC:DD:00:27' };

// Records connect macs, fails the macs in __failMacs, and answers showPicker with __pickResult.
const NATIVE_SPY = `(() => {
  window.__connects = []; window.__pickerCalls = 0; window.__failMacs = []; window.__pickResult = ${JSON.stringify(NEW)};
  const h = window.Capacitor && window.Capacitor.Plugins.NativeHrSession; if (!h) return;
  const plugins = window.Capacitor.Plugins;
  const real = h;
  const spy = new Proxy(real, { get: (t, k) => {
    if (k === 'connect') return (o) => { window.__connects.push(o && o.mac); return window.__failMacs.includes(o && o.mac) ? Promise.reject(new Error('connect failed: gatt 133')) : real.connect(o); };
    return t[k];
  } });
  const caps = window.Capacitor;
  window.Capacitor = Object.assign({}, caps, { Plugins: new Proxy({}, { get: (_, k) => (k === 'NativeHrSession' ? spy : plugins[k]) }) });
  let shim;
  Object.defineProperty(window, 'HRMNativeHrSession', { configurable: true, get: () => shim, set: (v) => {
    shim = v;
    if (v && v.showPicker) v.showPicker = () => { window.__pickerCalls++; const p = new Promise((r) => setTimeout(() => r(window.__pickResult), 100)); p.cancel = () => {}; return p; };
  } });
})();`;

// Web: a fake strap behind navigator.bluetooth that records every requestDevice option set.
const WEB = `(() => {
  window.__requests = [];
  const chr = { value: null, startNotifications: async () => chr, stopNotifications: async () => chr, addEventListener: () => {}, removeEventListener: () => {} };
  const gatt = { connected: false, connect: async () => { gatt.connected = true; return server; }, disconnect: () => { gatt.connected = false; } };
  const server = { device: null, connected: true,
    getPrimaryService: async (s) => { if (s === 'heart_rate' || s === 0x180d) return { getCharacteristic: async () => chr }; throw new Error('no service'); } };
  const device = { name: 'Polar H10 9A1B2C3D', id: 'fake', gatt, addEventListener: () => {}, removeEventListener: () => {}, watchAdvertisements: async () => {} };
  server.device = device;
  Object.defineProperty(navigator, 'bluetooth', { configurable: true, value: { getDevices: async () => [],
    requestDevice: async (o) => { window.__requests.push(JSON.parse(JSON.stringify(o))); return device; }, getAvailability: async () => true } });
})();`;

let fails = 0;
const fail = (m) => { fails++; console.log('FAIL ' + m); };
const pass = (m) => console.log('ok   ' + m);
const check = (ok, m, detail) => (ok ? pass(m) : fail(m + (detail ? ': ' + detail : '')));
const browser = await chromium.launch().catch(() => chromium.launch({ channel: 'chrome' }));

async function open({ web = false, scenario = 'start', straps = null, oldKey = true, width = 1440 } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height: 900 } });
  await ctx.route('**/*', (route) => {
    const u = route.request().url();
    if (/chart\.umd(\.min)?\.js/.test(u) && !u.startsWith('http://127.0.0.1')) return route.fulfill({ status: 200, contentType: 'text/javascript', body: fs.readFileSync(CHART) });
    if (ALLOW.test(u) || u.startsWith('data:') || u.startsWith('blob:')) return route.continue();
    const js = /\.js(\?|$)/.test(u) || route.request().resourceType() === 'script';
    return route.fulfill({ status: js ? 200 : 204, contentType: js ? 'text/javascript' : 'text/plain', body: '' });
  });
  const seed = `(() => { if (window.top !== window || localStorage.getItem('__s60')) return; localStorage.setItem('__s60', '1');
    ${straps ? `localStorage.setItem('hr_monitor_straps', ${JSON.stringify(JSON.stringify(straps))});` : ''}
    ${oldKey ? '' : `localStorage.removeItem('hr_monitor_last_strap');`} })();`;
  if (web) {
    await ctx.addInitScript(WEB);
    if (oldKey) await ctx.addInitScript(`localStorage.getItem('__s60') || localStorage.setItem('hr_monitor_last_strap', ${JSON.stringify(JSON.stringify({ name: OLD.name, mac: null }))});`);
  } else {
    await ctx.addInitScript(fakeBridge({ scenario, savedStrap: oldKey, signedIn: true, sessionAgeMs: 600000 }));
    await ctx.addInitScript(NATIVE_SPY);
  }
  await ctx.addInitScript(seed);
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  await page.goto(BASE + (web ? '/web.html' : '/native.html'), { waitUntil: 'load' });
  await page.waitForTimeout(web ? 500 : 1200);
  if (await page.evaluate(() => { const s = document.getElementById('session-toggle').closest('.section'); return !!s && s.classList.contains('collapsed'); })) {
    await page.click('[data-section="controls"] .section-header');
    await page.waitForTimeout(300);
  }
  return { ctx, page, errs };
}
const straps = (page) => page.evaluate(() => JSON.parse(localStorage.getItem('hr_monitor_straps') || 'null'));
const label = (page) => page.evaluate(() => document.getElementById('session-toggle').textContent.trim());
const caretShown = (page) => page.evaluate(() => { const c = document.getElementById('strap-caret'); return !!c && !c.hidden && c.getBoundingClientRect().width >= 44; });
const menuRows = (page) => page.evaluate(() => Array.from(document.querySelectorAll('#strap-menu .strap-pick')).map((b) => b.textContent.trim()));
const live = (page) => page.waitForFunction(() => document.body.classList.contains('conn-live'), null, { timeout: 8000 }).then(() => true, () => false);
const done = async (o, tag) => { if (o.errs.length) fail(tag + ' page errors: ' + o.errs.join(' | ')); await o.ctx.close(); };

// (d) migration from the old key, plus the caret at rest.
{
  const o = await open({});
  const list = await straps(o.page);
  const oldLeft = await o.page.evaluate(() => localStorage.getItem('hr_monitor_last_strap'));
  check(Array.isArray(list) && list.length === 1 && list[0].mac === OLD.mac && oldLeft === null, '(d) the old single strap migrates into the list and the old key goes', JSON.stringify(list) + ' old=' + oldLeft);
  check(await label(o.page) === 'Reconnect to ' + OLD.name, '(d) Start still reads Reconnect to the migrated strap', await label(o.page));
  check(await caretShown(o.page), '(a) the caret shows at rest with a 44 px target');
  await done(o, '(d)');
}

// (a) a known row connects to its mac, starts, and moves to the top; (g) hidden while it runs.
{
  const o = await open({ straps: [OLD, POLAR], oldKey: false });
  await o.page.click('#strap-caret');
  const rows = await menuRows(o.page);
  const exp = await o.page.evaluate(() => document.getElementById('strap-caret').getAttribute('aria-expanded'));
  check(rows.join('|') === OLD.name + '|' + POLAR.name && exp === 'true', '(a) the caret opens a menu of known straps, most recent first', rows.join('|') + ' expanded=' + exp);
  if (SHOTS) await o.page.screenshot({ path: path.join(SHOTS, 'menu-1440.png') });
  await o.page.click('#strap-menu .strap-pick >> nth=1');
  const isLive = await live(o.page);
  const conns = await o.page.evaluate(() => window.__connects);
  const list = await straps(o.page);
  check(isLive && conns.length === 1 && conns[0] === POLAR.mac, '(a) the row connects to that strap and starts', 'live=' + isLive + ' connects=' + conns.join(','));
  check(list && list[0].mac === POLAR.mac && list.length === 2, '(a) the chosen strap moves to the top', JSON.stringify(list));
  const hidden = await o.page.evaluate(() => document.getElementById('strap-caret').hidden && document.getElementById('strap-menu').hidden);
  check(hidden, '(g) the caret and menu are hidden while the session runs');
  await done(o, '(a)');
}
{
  const o = await open({ scenario: 'live', straps: [OLD], oldKey: false });
  check(await o.page.evaluate(() => document.getElementById('strap-caret').hidden), '(g) a page opened on a running session shows no caret');
  await done(o, '(g)');
}

// (b) Find a strap: showPicker, connect, start, added to the top.
{
  const o = await open({ straps: [OLD, POLAR], oldKey: false });
  await o.page.click('#strap-caret');
  await o.page.click('#strap-menu .strap-find');
  const isLive = await live(o.page);
  const r = await o.page.evaluate(() => ({ picks: window.__pickerCalls, conns: window.__connects }));
  const list = await straps(o.page);
  check(r.picks === 1 && r.conns.join(',') === NEW.mac && isLive, '(b) Find a strap opens the picker and connects to the pick', JSON.stringify(r) + ' live=' + isLive);
  check(list && list.length === 3 && list[0].mac === NEW.mac, '(b) the found strap is added at the top', JSON.stringify(list));
  await done(o, '(b)');
}

// (c) Forget removes a strap and the Start label follows.
{
  const o = await open({ straps: [OLD, POLAR], oldKey: false });
  await o.page.click('#strap-caret');
  await o.page.click('#strap-menu .strap-forget >> nth=0');
  const list = await straps(o.page);
  const lab = await label(o.page);
  const rows = await menuRows(o.page);
  check(list && list.length === 1 && list[0].mac === POLAR.mac && rows.join('|') === POLAR.name, '(c) Forget drops the strap from the list and the menu', JSON.stringify(list));
  check(lab === 'Reconnect to ' + POLAR.name, '(c) Start now names the next strap', lab);
  await o.page.click('#strap-menu .strap-forget >> nth=0');
  check(await label(o.page) === 'Start session', '(c) with none left, Start reads Start session', await label(o.page));
  await done(o, '(c)');
}

// (e) the remembered strap fails to connect: the picker opens and the pick starts.
{
  const o = await open({ straps: [OLD], oldKey: false });
  await o.page.evaluate((m) => { window.__failMacs = [m]; window.__pickResult = { name: 'Polar H10 9A1B2C3D', mac: 'AA:BB:CC:DD:00:26' }; }, OLD.mac);
  await o.page.click('#session-toggle');
  const isLive = await live(o.page);
  const r = await o.page.evaluate(() => ({ picks: window.__pickerCalls, conns: window.__connects }));
  const list = await straps(o.page);
  check(r.picks === 1 && r.conns.join(',') === OLD.mac + ',' + POLAR.mac && isLive, '(e) a failed remembered strap opens the picker and starts with the pick', JSON.stringify(r) + ' live=' + isLive);
  check(list && list[0].mac === POLAR.mac, '(e) the pick becomes the remembered strap', JSON.stringify(list));
  await done(o, '(e)');
}

// (f) web: Find a strap requests the HR service only; a known row keeps its name filter.
{
  const o = await open({ web: true, straps: [{ name: OLD.name, mac: null }], oldKey: false });
  check(await caretShown(o.page), '(f) web: the caret shows at rest');
  await o.page.click('#strap-caret');
  await o.page.click('#strap-menu .strap-find');
  const isLive = await live(o.page);
  const req = await o.page.evaluate(() => window.__requests);
  const f = req[0] && req[0].filters;
  const hrOnly = !!f && f.length === 1 && Array.isArray(f[0].services) && f[0].services.includes(0x180d) && !f.some((x) => 'name' in x);
  check(req.length === 1 && hrOnly && isLive, '(f) web: Find a strap requests the HR service, not the last name', JSON.stringify(req));
  const list = await straps(o.page);
  check(list && list[0].name === 'Polar H10 9A1B2C3D' && list.length === 2, '(f) web: the found strap is remembered at the top', JSON.stringify(list));
  await done(o, '(f)');
}

if (SHOTS) {
  for (const w of [430, 1440]) {
    const o = await open({ straps: [OLD, POLAR], oldKey: false, width: w });
    await o.page.screenshot({ path: path.join(SHOTS, `idle-${w}.png`) });
    await o.page.click('#strap-caret');
    await o.page.waitForTimeout(250);
    await o.page.screenshot({ path: path.join(SHOTS, `menu-open-${w}.png`) });
    await o.ctx.close();
  }
}

await browser.close();
server.close();
console.log((mutant ? `[mutant ${mutant}] ` : '') + (fails ? `${fails} failed` : 'all passed'));
process.exit(fails ? 1 : 0);
