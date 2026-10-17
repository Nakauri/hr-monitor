// S60: the native strap picker shows heart rate straps first and keeps other Bluetooth devices out of the way.
// Bug it guards (2026-10-16 phone screenshot): "Pair a strap" listed every bonded device (headset, GoPro, PC,
// BP cuff) as "paired • HR strap", because BleScanner marked every bonded device isHr, and the text overflowed
// each card. Cases: (a) a mixed scan lists exactly the 3 straps (2 with the HR UUID, 1 known without it), the rest
// in a closed "Other Bluetooth devices" group; (b) rows say Nearby or Paired before, never the MAC or "HR strap";
// (c) every row fits its text at 360 and 430; (d) no strap found: the help line, Scan again rescans, others open;
// (e) BleScanner sets a bonded device's isHr from its cached UUIDs, never true for all (source check).
// Usage: node scripts/strap-picker.mjs [--mutant <name>] [--shots <dir>] [--ux <dir>]. Each mutant must FAIL.
// Mutants: all-straps, no-known, no-help, rows-shrink, bonded-all-hr. Needs mobile/www from `npm run copy-web`.
// Runtime: about 15 seconds.

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
  'all-straps': ['const isStrap = function (d) { return !!d.isHr ||', 'const isStrap = function (d) { return true ||'],
  'no-known': ["const known = knownMacs();", 'const known = [];'],
  'no-help': ["help.textContent = 'No heart rate strap found. Wake the strap by wetting the pads, then scan again.';", ''],
  'rows-shrink': ['flex-shrink:0;width:100%;min-height:44px;padding:10px 12px;', 'flex-shrink:1;width:100%;min-height:0;padding:10px 12px;height:20px;overflow:hidden;'],
  'bonded-all-hr': ['HrEngine.putSafe(obj, "isHr", hasHrUuid(b));', 'HrEngine.putSafe(obj, "isHr", true);'],
};
const mutant = argVal('--mutant');
if (mutant && !MUTANTS[mutant]) { console.log('FAIL unknown mutant ' + mutant); process.exit(2); }
const mutate = (src, must) => {
  if (!mutant || !src.includes(MUTANTS[mutant][0])) return src;
  return src.replace(MUTANTS[mutant][0], MUTANTS[mutant][1]);
};

const WWW = path.join(ROOT, 'mobile', 'www');
const shimSrc = mutate(fs.readFileSync(path.join(ROOT, 'mobile', 'src', 'native-hr-session.js'), 'utf8'));
const wwwShim = path.join(WWW, 'native-hr-session.js');
if (!fs.existsSync(wwwShim) || !fs.readFileSync(wwwShim, 'utf8').includes('Other Bluetooth devices')) {
  console.log('FAIL mobile/www is stale: run npm run copy-web in mobile'); process.exit(1);
}
const javaSrc = mutate(fs.readFileSync(path.join(ROOT, 'mobile', 'android-overlay', 'app', 'src', 'main', 'java', 'com', 'nakauri', 'hrmonitor', 'BleScanner.java'), 'utf8').replace(/\r\n/g, '\n'));

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png', '.woff2': 'font/woff2' };
const server = http.createServer((req, res) => {
  const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (rel === '/native-hr-session.js') { res.writeHead(200, { 'Content-Type': 'text/javascript', 'Cache-Control': 'no-store' }); res.end(shimSrc); return; }
  let file = path.join(WWW, rel);
  if (!fs.existsSync(file)) file = path.join(ROOT, rel);
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  fs.createReadStream(file).pipe(res);
});
await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
const BASE = `http://127.0.0.1:${server.address().port}`;
const ALLOW = /^https?:\/\/(127\.0\.0\.1|fonts\.googleapis\.com|fonts\.gstatic\.com)(:|\/)/;

const MIX = [
  { name: '808S 0025153', mac: 'AA:BB:CC:DD:00:25', rssi: -127, isHr: true, bonded: true },
  { name: 'Polar H10 9A1B2C3D', mac: 'AA:BB:CC:DD:00:26', rssi: -64, isHr: true, bonded: false },
  { name: 'Coospo H808S 7F2E', mac: 'AA:BB:CC:DD:00:27', rssi: -127, isHr: false, bonded: true },
  { name: 'Arctis Nova 7 Wireless Gaming Headset With A Very Long Name', mac: 'AA:BB:CC:DD:00:31', rssi: -127, isHr: false, bonded: true },
  { name: 'GoPro 4821', mac: 'AA:BB:CC:DD:00:32', rssi: -127, isHr: false, bonded: true },
  { name: 'DESKTOP-PC', mac: 'AA:BB:CC:DD:00:33', rssi: -71, isHr: false, bonded: false },
];
const STRAP_NAMES = ['Polar H10 9A1B2C3D', '808S 0025153', 'Coospo H808S 7F2E'];

let fails = 0;
const fail = (m) => { fails++; console.log('FAIL ' + m); };
const pass = (m) => console.log('ok   ' + m);
const check = (ok, m, detail) => (ok ? pass(m) : fail(m + (detail ? ': ' + detail : '')));
const browser = await chromium.launch().catch(() => chromium.launch({ channel: 'chrome' }));

async function openPicker(width, scans) {
  const ctx = await browser.newContext({ viewport: { width, height: 800 } });
  await ctx.route('**/*', (route) => {
    const u = route.request().url();
    if (/chart\.umd(\.min)?\.js/.test(u) && !u.startsWith('http://127.0.0.1')) return route.fulfill({ status: 200, contentType: 'text/javascript', body: fs.readFileSync(CHART) });
    if (ALLOW.test(u) || u.startsWith('data:') || u.startsWith('blob:')) return route.continue();
    const js = /\.js(\?|$)/.test(u) || route.request().resourceType() === 'script';
    return route.fulfill({ status: js ? 200 : 204, contentType: js ? 'text/javascript' : 'text/plain', body: '' });
  });
  await ctx.addInitScript(fakeBridge({ scenario: 'idle', savedStrap: false, signedIn: true }));
  await ctx.addInitScript(`(() => {
    if (window.top !== window || !window.Capacitor) return;
    localStorage.setItem('hr_monitor_straps', JSON.stringify([{ name: 'Coospo H808S 7F2E', mac: 'aa:bb:cc:dd:00:27' }]));
    window.__scans = ${JSON.stringify(scans)}; window.__scanCalls = 0;
    const h = window.Capacitor.Plugins.NativeHrSession; const plugins = window.Capacitor.Plugins;
    const spy = new Proxy(h, { get: (t, k) => k === 'scan' ? () => { const r = window.__scans[Math.min(window.__scanCalls, window.__scans.length - 1)]; window.__scanCalls++; return Promise.resolve({ devices: r }); } : t[k] });
    window.Capacitor = Object.assign({}, window.Capacitor, { Plugins: new Proxy({}, { get: (_, k) => (k === 'NativeHrSession' ? spy : plugins[k]) }) });
  })();`);
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  await page.goto(BASE + '/hr_monitor.html', { waitUntil: 'load' });
  await page.waitForFunction(() => window.HRMNativeHrSession && window.HRMNativeHrSession.showPicker, null, { timeout: 8000 });
  await page.evaluate(() => { window.__picked = null; window.HRMNativeHrSession.showPicker().then((v) => { window.__picked = v; }, (e) => { window.__picked = 'err:' + e.message; }); });
  await page.waitForSelector('.hrm-pick', { timeout: 5000 }).catch(() => {});
  return { ctx, page, errs };
}
const view = (page) => page.evaluate(() => {
  const body = document.querySelector('.hrm-pick-body');
  if (!body) return null;
  const det = body.querySelector('details');
  const straps = Array.from(body.children).filter((n) => n.classList.contains('hrm-pick-row')).map((b) => b.querySelector('.n').textContent);
  const others = det ? Array.from(det.querySelectorAll('.hrm-pick-row .n')).map((n) => n.textContent) : [];
  const metas = Array.from(document.querySelectorAll('.hrm-pick-row .m')).map((m) => m.textContent.trim());
  return { title: document.querySelector('.hrm-pick h2').textContent, straps, others, othersOpen: det ? det.open : null, metas,
    text: document.querySelector('.hrm-pick').textContent, help: !!body.querySelector('.hrm-pick-help') && body.querySelector('.hrm-pick-help').textContent };
});
const fits = (page) => page.evaluate(() => {
  document.querySelectorAll('.hrm-pick details').forEach((d) => { d.open = true; });
  return Array.from(document.querySelectorAll('.hrm-pick-row')).filter((r) => {
    const n = r.querySelector('.n');
    return r.scrollHeight > r.clientHeight + 1 || r.scrollWidth > r.clientWidth + 1 || r.getBoundingClientRect().height < 44 || n.getBoundingClientRect().right > r.getBoundingClientRect().right;
  }).map((r) => r.textContent);
});

for (const width of [360, 430]) {
  const o = await openPicker(width, [MIX]);
  const v = await view(o.page);
  if (!v) { fail(`(a) ${width}: the picker did not open`); await o.ctx.close(); continue; }
  check(v.title === 'Choose a strap', `(a) ${width}: title Choose a strap`, v.title);
  check(v.straps.slice().sort().join('|') === STRAP_NAMES.slice().sort().join('|'), `(a) ${width}: the straps group lists exactly the 3 straps`, v.straps.join('|'));
  check(v.others.length === 3 && v.othersOpen === false, `(a) ${width}: the other 3 devices sit in a closed group`, v.others.join('|') + ' open=' + v.othersOpen);
  check(v.metas.every((m) => /^(Nearby|Paired before)$/.test(m)) && !/AA:BB|HR strap|dBm/.test(v.text), `(b) ${width}: rows read Nearby or Paired before, no MAC, no dBm, no HR strap label`, v.metas.join('|'));
  if (SHOTS) await o.page.screenshot({ path: path.join(SHOTS, `picker-${width}.png`) });
  const bad = await fits(o.page);
  check(bad.length === 0, `(c) ${width}: every row fits its text and is at least 44 px`, bad.join(' / '));
  if (SHOTS) await o.page.screenshot({ path: path.join(SHOTS, `picker-others-${width}.png`) });
  await o.page.click('.hrm-pick-body > .hrm-pick-row >> nth=0');
  await o.page.waitForTimeout(100);
  const { picked, gone } = await o.page.evaluate(() => ({ picked: window.__picked, gone: !document.querySelector('.hrm-pick-back') }));
  check(picked && picked.mac === 'AA:BB:CC:DD:00:26' && gone, `(a) ${width}: tapping the nearest strap resolves its mac and closes`, JSON.stringify(picked));
  if (o.errs.length) fail('page errors: ' + o.errs.join(' | '));
  await o.ctx.close();
}

{
  const NONE = MIX.filter((d) => !d.isHr && d.mac !== 'AA:BB:CC:DD:00:27');
  const o = await openPicker(360, [NONE, MIX]);
  const v = await view(o.page);
  check(v && v.straps.length === 0 && v.help === 'No heart rate strap found. Wake the strap by wetting the pads, then scan again.' && v.othersOpen === true,
    '(d) no strap: the help line shows and the other devices are open', JSON.stringify(v && { help: v.help, open: v.othersOpen }));
  if (SHOTS) await o.page.screenshot({ path: path.join(SHOTS, 'picker-none-360.png') });
  const again = await o.page.$('.hrm-pick-again');
  if (!again) fail('(d) no Scan again button');
  else {
    await again.click();
    await o.page.waitForTimeout(200);
    const v2 = await view(o.page);
    const calls = await o.page.evaluate(() => window.__scanCalls);
    check(calls === 2 && v2 && v2.straps.length === 3, '(d) Scan again rescans and lists the straps it finds', 'scans=' + calls + ' straps=' + (v2 && v2.straps.join('|')));
  }
  if (o.errs.length) fail('page errors: ' + o.errs.join(' | '));
  await o.ctx.close();
}

{
  const fn = javaSrc.slice(javaSrc.indexOf('private void finishScan('));
  const bondedBlock = fn.slice(fn.indexOf('adapter.getBondedDevices()'), fn.indexOf('bonded enumeration failed'));
  const helper = javaSrc.slice(javaSrc.indexOf('private static boolean hasHrUuid('), javaSrc.indexOf('private void finishScan('));
  check(/"isHr", hasHrUuid\(b\)\)/.test(bondedBlock) && !/"isHr", true\)/.test(bondedBlock), '(e) a bonded device is HR only by evidence, never true for all');
  check(/getUuids\(\)/.test(helper) && /HR_SERVICE\.equals\(u\.getUuid\(\)\)/.test(helper) && /return false;/.test(helper), '(e) the evidence is the cached UUID list holding 0x180D');
}

await browser.close();
server.close();
console.log((mutant ? `[mutant ${mutant}] ` : '') + (fails ? `${fails} failed` : 'all passed'));
process.exit(fails ? 1 : 0);
