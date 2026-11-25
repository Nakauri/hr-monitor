// S60: the native strap picker shows heart rate straps first and keeps other Bluetooth devices out of the way.
// Bug it guards (2026-10-16 phone screenshot): "Pair a strap" listed every bonded device (headset, action camera, PC,
// BP cuff) as "paired • HR strap", because BleScanner marked every bonded device isHr, and the text overflowed
// each card. Cases: (a) a mixed scan lists exactly the 3 straps (2 with the HR UUID, 1 known without it), the rest
// in a closed "Other Bluetooth devices" group; (b) rows say Nearby or Paired before, never the MAC or "HR strap";
// (c) every row fits its text at 360 and 430; (d) no strap found: the help line, Scan again rescans, others open;
// (e) BleScanner sets a bonded device's isHr from its cached UUIDs, never true for all (source check).
// Usage: node scripts/strap-picker.mjs [--mutant <name>] [--shots <dir>] [--ux <dir>]. Each mutant must FAIL.
// (g) Bluetooth access (2026-11-25 user email, strap not found): a denied, Location-off or Bluetooth-off check shows what
// to allow and opens that settings page, nothing scans meanwhile, coming back rechecks, a remembered strap goes there too.
// (h) the native side asks for Nearby devices on 12+ and Location below, and the manifest flags neverForLocation.
// (i) Turn on Bluetooth shows Android's box: Allow searches, Deny stays, an app without it opens settings.
// (j) a strap another app holds lists first as "In use by another app" (unpaired straps stop advertising).
// Messages never break a line early or leave one word alone (the 2026-11-25 S8 photo).
// Mutants: all-straps, no-known, no-help, rows-shrink, no-escape, no-focus, bonded-all-hr, no-access-check, no-ask,
// no-return-recheck, wrong-page, memory-skips-access, location-blocks-memory, location-hides-paired, aliases-swapped,
// no-never-for-location, enable-opens-settings, no-scan-after-enable, slow-radio-is-deny, bt-off-searches-old-android,
// no-in-use-label, in-use-last, held-handle-dropped, no-808s-hint, no-held, own-as-held, pretty-wrap, no-glue,
// stale-scanner. Also: focus starts on the first strap
// (or the help line), Tab stays inside, Escape cancels, a hostile name renders as text. Needs mobile/www from `npm run copy-web`.
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
const CHART = path.join(path.dirname(fileURLToPath(import.meta.url)), 'vendor', 'chart.umd.min.js');
const { fakeBridge } = await import(new URL('./fake-bridge.mjs', import.meta.url).href);
const { chromium } = createRequire(path.join(UX, 'kit', 'package.json'))('playwright');
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

const MUTANTS = {
  'all-straps': ['const isStrap = function (d) { return !!d.isHr ||', 'const isStrap = function (d) { return true ||'],
  'no-known': ["const known = knownMacs();", 'const known = [];'],
  'no-help': [": 'No heart rate strap found. Wake the strap by wetting the pads, then scan again.';", ": '';"],
  'rows-shrink': ['flex-shrink:0;width:100%;min-height:44px;padding:10px 12px;', 'flex-shrink:1;width:100%;min-height:0;padding:10px 12px;height:20px;overflow:hidden;'],
  'no-escape': ["if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(new Error('cancelled')); return; }", ''],
  'no-focus': ["const first = body.querySelector(':scope > .hrm-pick-row') || body.querySelector('.hrm-pick-help');", 'const first = null;'],
  'bonded-all-hr': ['HrEngine.putSafe(obj, "isHr", hasHrUuid(b) || (!bonded && nameHints(n)));', 'HrEngine.putSafe(obj, "isHr", true);'],
  // The picker scans without checking access: the 2026-11-25 user email, "can't find it on search".
  'no-access-check': ['const stop = a && BLOCKED[a.state];', 'const stop = null;'],
  // The check never shows Android's prompt.
  'no-ask': ['bleAccess({ request: !!ask, forScan: true })', 'bleAccess({ request: false, forScan: true })'],
  // Back from settings the picker sits on the old message.
  'no-return-recheck': ["if (document.visibilityState === 'visible' && blockedShown && !cancelled) runScan(false);", ''],
  // Location off opens the app page, where there is no Location switch.
  'wrong-page': ["button: 'Open Location settings', page: 'location' }", "button: 'Open Location settings', page: 'app' }"],
  // A remembered strap tries to connect without access and fails.
  'memory-skips-access': ['const fromMemory = !!(lastNative && lastNative.mac) && !blocked;', 'const fromMemory = !!(lastNative && lastNative.mac);'],
  // Older Android without Location: a paired strap that connects fine is sent to the picker instead.
  'location-blocks-memory': ["(access.state === 'denied' && access.need === 'nearby')", "access.state === 'denied'"],
  // Older Android without Location: paired straps vanish behind the message.
  'location-hides-paired': ['if (stop && !locationGap)', 'if (stop)'],
  // Older Android with Bluetooth off searches anyway, and the picker closes on the error.
  'bt-off-searches-old-android': ["const locationGap = a.state === 'location_off' || (a.state === 'denied' && a.need === 'location');", "const locationGap = a.need === 'location';"],
  // Android 12+ asks for Location instead of Nearby devices.
  'aliases-swapped': ['nearbyAndroid() ? new String[] { "bluetoothScan", "bluetoothConnect" } : new String[] { "location" }', 'nearbyAndroid() ? new String[] { "location" } : new String[] { "bluetoothScan", "bluetoothConnect" }'],
  // Android 12+ needs Location and its switch for scan results again.
  'no-never-for-location': [' android:usesPermissionFlags="neverForLocation"', ''],
  // Turn on Bluetooth still sends people to settings.
  'enable-opens-settings': ['if (!blocked.enable) { window.HRMNativeHrSession.openSettings(blocked.page); return; }', 'window.HRMNativeHrSession.openSettings(blocked.page); return;'],
  // Allow turns Bluetooth on but the picker sits on the old message.
  'no-scan-after-enable': ['if (r && (r.on || r.allowed)) runScan(true);', 'if (false) runScan(true);'],
  // Allow with a slow radio reads as Deny: the picker sits on the old message.
  'slow-radio-is-deny': ['if (r && (r.on || r.allowed)) runScan(true);', 'if (r && r.on) runScan(true);'],
  // A strap another app holds is listed but not labelled.
  'no-in-use-label': ["if (d.inUse) m.textContent = 'In use by another app';", "if (false) m.textContent = '';"],
  // A strap another app holds sinks to the bottom of the list.
  'in-use-last': ['return (b.inUse ? 1 : 0) - (a.inUse ? 1 : 0) ||', 'return (a.inUse ? 1 : 0) - (b.inUse ? 1 : 0) ||'],
  // The search never asks Android which devices other apps hold (the unpaired busy strap goes missing).
  // A held strap's handle is dropped, so a tap connects with the wrong address type.
  'held-handle-dropped': ['scanResults.add(new DiscoveredDevice(b.getAddress(), obj.optString("name", b.getAddress()), -127, obj.optBoolean("isHr"), b));', ''],
  // An unpaired H808S another app holds falls under Other devices.
  'no-808s-hint': ['|| u.startsWith("808S")', ''],
  'no-held': ['java.util.Map<String, BluetoothDevice> held = heldByOthers(ownMac);', 'java.util.Map<String, BluetoothDevice> held = new java.util.HashMap<>();'],
  // aorti.ca's own strap reads as in use by another app.
  'own-as-held': ['if (ownMac != null && ownMac.equalsIgnoreCase(b.getAddress())) continue;', ''],
  // The page's pretty wrapping breaks the Location message early on a phone.
  'pretty-wrap': ['line-height:1.4;text-wrap:wrap;}', 'line-height:1.4;}'],
  // A message ends with one word alone on its last line.
  'no-glue': ['help.textContent = help.textContent.replace(/ (', 'help.textContent = help.textContent.replace(/^ZZZ ('],
  // Opened with Bluetooth off, every search fails until the app restarts.
  'stale-scanner': ['if (scanner == null && adapter != null) {', 'if (false) {'],
};
const mutant = argVal('--mutant');
if (mutant && !MUTANTS[mutant]) { console.log('FAIL unknown mutant ' + mutant); process.exit(2); }
let hit = 0;
const mutate = (src) => {
  if (!mutant || !src.includes(MUTANTS[mutant][0])) return src;
  hit++;
  return src.replace(MUTANTS[mutant][0], MUTANTS[mutant][1]);
};

const WWW = path.join(ROOT, 'mobile', 'www');
const shimSrc = mutate(fs.readFileSync(path.join(ROOT, 'mobile', 'src', 'native-hr-session.js'), 'utf8'));
const wwwShim = path.join(WWW, 'native-hr-session.js');
const wwwPage = path.join(WWW, 'hr_monitor.html');
if (!fs.existsSync(wwwShim) || !fs.readFileSync(wwwShim, 'utf8').includes('bleAccess') || !fs.existsSync(wwwPage) || !fs.readFileSync(wwwPage, 'utf8').includes('bleAccess')) {
  console.log('FAIL mobile/www is stale: run npm run copy-web in mobile'); process.exit(1);
}
const javaSrc0 = mutate(fs.readFileSync(path.join(ROOT, 'mobile', 'android-overlay', 'app', 'src', 'main', 'java', 'com', 'nakauri', 'hrmonitor', 'BleScanner.java'), 'utf8').replace(/\r\n/g, '\n'));
const javaSrc = javaSrc0;
const JAVA_DIR = path.join(ROOT, 'mobile', 'android-overlay', 'app', 'src', 'main');
const pluginSrc = mutate(fs.readFileSync(path.join(JAVA_DIR, 'java', 'com', 'nakauri', 'hrmonitor', 'NativeHrSessionPlugin.java'), 'utf8').replace(/\r\n/g, '\n'));
const manifestSrc = mutate(fs.readFileSync(path.join(JAVA_DIR, 'AndroidManifest.xml'), 'utf8').replace(/\r\n/g, '\n'));
const engineSrc = mutate(fs.readFileSync(path.join(JAVA_DIR, 'java', 'com', 'nakauri', 'hrmonitor', 'HrEngine.java'), 'utf8').replace(/\r\n/g, '\n'));
const pageSrc = mutate(fs.readFileSync(path.join(ROOT, 'mobile', 'www', 'hr_monitor.html'), 'utf8'));
if (mutant && hit !== 1) { console.log('FAIL mutant anchor lost or doubled: ' + MUTANTS[mutant][0]); process.exit(1); }

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png', '.woff2': 'font/woff2' };
const server = http.createServer((req, res) => {
  const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (rel === '/native-hr-session.js') { res.writeHead(200, { 'Content-Type': 'text/javascript', 'Cache-Control': 'no-store' }); res.end(shimSrc); return; }
  if (rel === '/hr_monitor.html') { res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' }); res.end(pageSrc); return; }
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
  { name: '808S 0012345', mac: 'AA:BB:CC:DD:00:25', rssi: -127, isHr: true, bonded: true },
  { name: 'Polar H10 9A1B2C3D', mac: 'AA:BB:CC:DD:00:26', rssi: -64, isHr: true, bonded: false },
  { name: 'Coospo H808S 7F2E', mac: 'AA:BB:CC:DD:00:27', rssi: -127, isHr: false, bonded: true },
  { name: 'Wireless Headset 01 With A Very Long Device Name', mac: 'AA:BB:CC:DD:00:31', rssi: -127, isHr: false, bonded: true },
  { name: 'Action Camera 02', mac: 'AA:BB:CC:DD:00:32', rssi: -127, isHr: false, bonded: true },
  { name: 'Desktop 03', mac: 'AA:BB:CC:DD:00:33', rssi: -71, isHr: false, bonded: false },
];
const STRAP_NAMES = ['Polar H10 9A1B2C3D', '808S 0012345', 'Coospo H808S 7F2E'];

let fails = 0;
const fail = (m) => { fails++; console.log('FAIL ' + m); };
const pass = (m) => console.log('ok   ' + m);
const check = (ok, m, detail) => (ok ? pass(m) : fail(m + (detail ? ': ' + detail : '')));
const browser = await chromium.launch().catch(() => chromium.launch({ channel: 'chrome' }));

// access: bleAccess replies in order (the last repeats); omitted = the fake bridge's {} (counts as ok).
async function openPicker(width, scans, access, opts = {}) {
  const ctx = await browser.newContext({ viewport: { width, height: 800 } });
  await ctx.route('**/*', (route) => {
    const u = route.request().url();
    if (/chart\.umd(\.min)?\.js/.test(u) && !u.startsWith('http://127.0.0.1')) return route.fulfill({ status: 200, contentType: 'text/javascript', body: fs.readFileSync(CHART) });
    if (ALLOW.test(u) || u.startsWith('data:') || u.startsWith('blob:')) return route.continue();
    const js = /\.js(\?|$)/.test(u) || route.request().resourceType() === 'script';
    return route.fulfill({ status: js ? 200 : 204, contentType: js ? 'text/javascript' : 'text/plain', body: '' });
  });
  await ctx.addInitScript(fakeBridge({ scenario: 'idle', savedStrap: !!opts.savedStrap, signedIn: true }));
  await ctx.addInitScript(`(() => {
    if (window.top !== window || !window.Capacitor) return;
    localStorage.setItem('hr_monitor_straps', JSON.stringify([{ name: 'Coospo H808S 7F2E', mac: 'aa:bb:cc:dd:00:27' }]));
    window.__scans = ${JSON.stringify(scans)}; window.__scanCalls = 0;
    window.__access = ${JSON.stringify(access || null)}; window.__accessCalls = []; window.__settings = []; window.__connects = 0;
    const h = window.Capacitor.Plugins.NativeHrSession; const plugins = window.Capacitor.Plugins;
    const spy = new Proxy(h, { get: (t, k) => {
      if (k === 'scan') return () => { const r = window.__scans[Math.min(window.__scanCalls, window.__scans.length - 1)]; window.__scanCalls++; return Promise.resolve({ devices: r }); };
      if (k === 'bleAccess' && window.__access) return (o) => { window.__accessCalls.push(o || {}); return Promise.resolve(window.__access[Math.min(window.__accessCalls.length - 1, window.__access.length - 1)]); };
      if (k === 'openSettings') return (o) => { window.__settings.push(o && o.page); return Promise.resolve({ opened: true }); };
      if (k === 'enableBluetooth') return ${opts.noEnable ? 'undefined' : `() => { window.__enables = (window.__enables || 0) + 1; return Promise.resolve(${JSON.stringify(opts.enableReply || { on: false })}); }`};
      if (k === 'connect') return (o) => { window.__connects++; return t.connect(o); };
      return t[k];
    } });
    window.Capacitor = Object.assign({}, window.Capacitor, { Plugins: new Proxy({}, { get: (_, k) => (k === 'NativeHrSession' ? spy : plugins[k]) }) });
  })();`);
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  await page.goto(BASE + '/hr_monitor.html', { waitUntil: 'load' });
  await page.waitForFunction(() => window.HRMNativeHrSession && window.HRMNativeHrSession.showPicker, null, { timeout: 8000 });
  if (opts.viaStart) {
    await page.waitForFunction(() => /Start session|Reconnect to/.test(document.getElementById('session-toggle').textContent), null, { timeout: 10000 }).catch(() => {});
    await page.click('#session-toggle');
  } else await page.evaluate(() => { window.__picked = null; window.HRMNativeHrSession.showPicker().then((v) => { window.__picked = v; }, (e) => { window.__picked = 'err:' + e.message; }); });
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
    text: document.querySelector('.hrm-pick').textContent, help: !!body.querySelector('.hrm-pick-help') && body.querySelector('.hrm-pick-help').textContent.replace(/\u00a0/g, ' ') };
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

// (f) focus, Tab trap, Escape, hostile name.
{
  const EVIL = { name: '<img src=x onerror="window.__pwned=1">Evil', mac: 'AA:BB:CC:DD:00:66', rssi: -60, isHr: true, bonded: false };
  const o = await openPicker(430, [[EVIL].concat(MIX)]);
  await o.page.waitForTimeout(200);
  const f0 = await o.page.evaluate(() => ({ cls: document.activeElement && document.activeElement.className, idx: Array.from(document.querySelectorAll('.hrm-pick-body > .hrm-pick-row')).indexOf(document.activeElement),
    imgs: document.querySelectorAll('.hrm-pick img').length, pwned: !!window.__pwned, first: document.querySelector('.hrm-pick-row .n').textContent }));
  check(f0.cls === 'hrm-pick-row' && f0.idx === 0, '(f) focus starts on the first strap', JSON.stringify(f0));
  check(f0.imgs === 0 && !f0.pwned && f0.first === EVIL.name, '(f) a hostile name renders as text', JSON.stringify(f0));
  await o.page.focus('.hrm-pick-cancel');
  await o.page.keyboard.press('Tab');
  const inside = await o.page.evaluate(() => !!document.activeElement && !!document.activeElement.closest('.hrm-pick'));
  check(inside, '(f) Tab from the last control stays inside the picker');
  await o.page.keyboard.press('Escape');
  await o.page.waitForTimeout(150);
  const esc = await o.page.evaluate(() => ({ picked: window.__picked, open: !!document.querySelector('.hrm-pick-back') }));
  check(esc.picked === 'err:cancelled' && !esc.open, '(f) Escape cancels and closes the picker', JSON.stringify(esc));
  if (o.errs.length) fail('page errors: ' + o.errs.join(' | '));
  await o.ctx.close();
}
{
  const NONE = MIX.filter((d) => !d.isHr && d.mac !== 'AA:BB:CC:DD:00:27');
  const o = await openPicker(360, [NONE]);
  await o.page.waitForTimeout(200);
  const cls = await o.page.evaluate(() => document.activeElement && document.activeElement.className);
  check(cls === 'hrm-pick-help', '(f) with no strap, focus starts on the help line', cls);
  await o.ctx.close();
}

// (g) Bluetooth access: each blocked state says what to allow and opens the page that fixes it; nothing scans until access is fine.
const BLOCK_CASES = [
  { state: 'denied', need: 'nearby', text: 'Allow Nearby devices for aorti.ca to find your strap.', button: 'Open settings', page: 'app' },
  { state: 'denied', need: 'location', text: 'Allow Location for aorti.ca to find your strap. Android needs it for Bluetooth searches.', button: 'Open settings', page: 'app' },
  { state: 'location_off', need: 'location', text: 'Turn on Location to find your strap. Android needs it for Bluetooth searches.', button: 'Open Location settings', page: 'location' },
  { state: 'bluetooth_off', need: 'nearby', text: 'Turn on Bluetooth to find your strap.', button: 'Turn on Bluetooth', enable: true },
  // Older Android (the S8) reports need: location with Bluetooth off; it must block too.
  { state: 'bluetooth_off', need: 'location', text: 'Turn on Bluetooth to find your strap.', button: 'Turn on Bluetooth', enable: true },
];
const blockedView = (page) => page.evaluate(() => {
  const help = document.querySelector('.hrm-pick-help');
  const fix = document.querySelector('.hrm-pick-fix');
  const btns = Array.from(document.querySelectorAll('.hrm-pick-btn'));
  const vw = document.documentElement.clientWidth;
  return { help: help && help.textContent.replace(/\u00a0/g, ' '), fix: fix && fix.textContent, again: !!document.querySelector('.hrm-pick-again'),
    rows: document.querySelectorAll('.hrm-pick-row').length, scans: window.__scanCalls, calls: window.__accessCalls,
    small: btns.filter((b) => b.getBoundingClientRect().height < 44 || b.scrollWidth > b.clientWidth + 1).map((b) => b.textContent),
    outside: btns.concat(help ? [help] : []).filter((n) => { const r = n.getBoundingClientRect(); return r.left < 0 || r.right > vw; }).map((n) => n.textContent) };
});
for (const c of BLOCK_CASES) {
  for (const width of [360, 430]) {
    const o = await openPicker(width, [MIX], [{ state: c.state, need: c.need }]);
    await o.page.waitForTimeout(200);
    const v = await blockedView(o.page);
    const tag = `(g) ${c.state}/${c.need} ${width}`;
    check(v.help === c.text && v.fix === c.button && v.again, `${tag}: says what to allow, with ${c.button} and Scan again`, JSON.stringify({ help: v.help, fix: v.fix }));
    if (c.state === 'location_off' || (c.state === 'denied' && c.need === 'location')) {
      // Older Android lists paired straps without Location, so they stay pickable under the message.
      const order = await o.page.evaluate(() => { const h = document.querySelector('.hrm-pick-help'); const r = document.querySelector('.hrm-pick-body > .hrm-pick-row');
        return !!h && !!r && !!(h.compareDocumentPosition(r) & Node.DOCUMENT_POSITION_FOLLOWING); });
      check(v.scans === 1 && v.rows > 0 && order, `${tag}: paired straps still list, below the message`, 'scans=' + v.scans + ' rows=' + v.rows + ' below=' + order);
    } else check(v.scans === 0 && v.rows === 0, `${tag}: nothing scans while access is missing`, 'scans=' + v.scans);
    check(v.calls.length === 1 && v.calls[0].request === true && v.calls[0].forScan === true, `${tag}: the first check asks Android for access`, JSON.stringify(v.calls));
    check(v.small.length === 0 && v.outside.length === 0, `${tag}: buttons are 44 px, nothing leaves the screen`, JSON.stringify(v));
    // The S8 showed the Location message breaking with a fifth of its first line empty (11-25).
    // Early = a line ends with room left for the next line's first word.
    const early = await o.page.evaluate(() => {
      const h = document.querySelector('.hrm-pick-help');
      if (!h || !h.firstChild) return { bad: ['no message shown'], widow: '' };
      const t = h.firstChild; const s = t.textContent; const box = h.getBoundingClientRect();
      const rectAt = (i) => { const r = document.createRange(); r.setStart(t, i); r.setEnd(t, i + 1); return r.getBoundingClientRect(); };
      const space = rectAt(s.indexOf(' ')).width;
      const bad = [];
      let lastStart = 0;
      for (let i = 1; i < s.length; i++) {
        if (s[i - 1] !== ' ' || Math.round(rectAt(i).top) === Math.round(rectAt(i - 1).top)) continue;
        lastStart = i;
        let j = i; while (j < s.length && s[j] !== ' ') j++;
        const w = document.createRange(); w.setStart(t, i); w.setEnd(t, j);
        let k = i - 2; while (k > 0 && s[k] === ' ') k--;
        const room = box.right - rectAt(k).right - space;
        if (w.getBoundingClientRect().width < room) bad.push(s.slice(i, j) + ' fits in ' + Math.round(room) + 'px');
      }
      return { bad, widow: lastStart > 0 && !/\s/.test(s.slice(lastStart).trim()) ? s.slice(lastStart) : '' };
    });
    check(early.bad.length === 0, `${tag}: no line breaks early`, early.bad.join(', '));
    check(!early.widow, `${tag}: no single word alone on the last line`, early.widow);
    if (SHOTS) await o.page.screenshot({ path: path.join(SHOTS, `picker-${c.state}-${c.need}-${width}.png`) });
    const fixBtn = await o.page.$('.hrm-pick-fix');
    if (!fixBtn) fail(`${tag}: no ${c.button} button`);
    else {
      await fixBtn.click();
      await o.page.waitForTimeout(100);
      const r = await o.page.evaluate(() => ({ pages: window.__settings, enables: window.__enables || 0 }));
      if (c.enable) check(r.enables === 1 && r.pages.length === 0, `${tag}: ${c.button} shows Android's own box, no settings page`, JSON.stringify(r));
      else check(r.pages.length === 1 && r.pages[0] === c.page && r.enables === 0, `${tag}: ${c.button} opens the ${c.page} settings page`, JSON.stringify(r));
    }
    if (o.errs.length) fail('page errors: ' + o.errs.join(' | '));
    await o.ctx.close();
  }
}
{
  // Back from settings: recheck without a second prompt, then search.
  const o = await openPicker(360, [MIX], [{ state: 'location_off', need: 'location' }, { state: 'ok', need: 'location' }]);
  await o.page.waitForTimeout(200);
  await o.page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await o.page.waitForTimeout(300);
  const v = await view(o.page);
  const calls = await o.page.evaluate(() => window.__accessCalls);
  check(calls.length === 2 && calls[1].request === false && v && v.straps.length === 3, '(g) back from settings: rechecks without asking, then lists the straps', JSON.stringify({ calls, straps: v && v.straps }));
  if (o.errs.length) fail('page errors: ' + o.errs.join(' | '));
  await o.ctx.close();
}
{
  // Scan again asks again, then searches.
  const o = await openPicker(360, [MIX], [{ state: 'denied', need: 'nearby' }, { state: 'ok', need: 'nearby' }]);
  await o.page.waitForTimeout(200);
  const againBtn = await o.page.$('.hrm-pick-again');
  if (againBtn) await againBtn.click();
  await o.page.waitForTimeout(300);
  const v = await view(o.page);
  const calls = await o.page.evaluate(() => window.__accessCalls);
  check(calls.length === 2 && calls[1].request === true && v && v.straps.length === 3, '(g) Scan again asks again, then lists the straps', JSON.stringify({ calls, straps: v && v.straps }));
  await o.ctx.close();
}
{
  // A remembered strap with access missing opens the picker's message instead of trying to connect.
  const o = await openPicker(430, [MIX], [{ state: 'denied', need: 'nearby' }], { savedStrap: true, viaStart: true });
  await o.page.waitForSelector('.hrm-pick-help', { timeout: 5000 }).catch(() => {});
  const v = await blockedView(o.page);
  const connects = await o.page.evaluate(() => window.__connects);
  check(v.help === BLOCK_CASES[0].text && connects === 0, '(g) a remembered strap without access shows the message, no connect', JSON.stringify({ help: v.help, connects }));
  if (o.errs.length) fail('page errors: ' + o.errs.join(' | '));
  await o.ctx.close();
}
{
  // Older Android without Location still connects a remembered strap directly.
  const o = await openPicker(430, [MIX], [{ state: 'denied', need: 'location' }], { savedStrap: true, viaStart: true });
  await o.page.waitForTimeout(1500);
  const r = await o.page.evaluate(() => ({ connects: window.__connects, picker: !!document.querySelector('.hrm-pick') }));
  check(r.connects === 1 && !r.picker, '(g) older Android without Location connects a remembered strap, no picker', JSON.stringify(r));
  if (o.errs.length) fail('page errors: ' + o.errs.join(' | '));
  await o.ctx.close();
}
// (i) Turn on Bluetooth: Allow searches by itself, Deny leaves the message, an older app falls back to settings.
{
  const BT_OFF = { state: 'bluetooth_off', need: 'nearby' };
  const o = await openPicker(360, [MIX], [BT_OFF, { state: 'ok', need: 'nearby' }], { enableReply: { on: true } });
  await o.page.waitForTimeout(200);
  await o.page.click('.hrm-pick-fix').catch(() => {});
  await o.page.waitForTimeout(300);
  const v = await view(o.page);
  const r = await o.page.evaluate(() => ({ calls: window.__accessCalls, scans: window.__scanCalls, settings: window.__settings }));
  check(v && v.straps.length === 3 && !v.help && r.scans === 1 && r.calls.length === 2 && r.settings.length === 0,
    '(i) Allow: the picker searches by itself and lists the straps', JSON.stringify({ r, straps: v && v.straps, help: v && v.help }));
  if (o.errs.length) fail('page errors: ' + o.errs.join(' | '));
  await o.ctx.close();
}
{
  // Allow while the radio is still turning on: search anyway, and the check then finds it on.
  const o = await openPicker(360, [MIX], [{ state: 'bluetooth_off', need: 'location' }, { state: 'ok', need: 'location' }], { enableReply: { on: false, allowed: true } });
  await o.page.waitForTimeout(200);
  await o.page.click('.hrm-pick-fix').catch(() => {});
  await o.page.waitForTimeout(300);
  const v = await view(o.page);
  check(v && v.straps.length === 3 && !v.help, '(i) Allow with a slow radio still searches and lists the straps (older Android)', JSON.stringify({ straps: v && v.straps, help: v && v.help }));
  await o.ctx.close();
}
{
  const o = await openPicker(360, [MIX], [{ state: 'bluetooth_off', need: 'nearby' }], { enableReply: { on: false } });
  await o.page.waitForTimeout(200);
  await o.page.click('.hrm-pick-fix').catch(() => {});
  await o.page.waitForTimeout(300);
  const r = await o.page.evaluate(() => { const f = document.querySelector('.hrm-pick-fix');
    return { help: ((document.querySelector('.hrm-pick-help') || {}).textContent || '').replace(/\u00a0/g, ' '), fix: f && f.textContent, enabled: !!f && !f.disabled, scans: window.__scanCalls, enables: window.__enables }; });
  check(r.help === 'Turn on Bluetooth to find your strap.' && r.fix === 'Turn on Bluetooth' && r.enabled && r.scans === 0 && r.enables === 1,
    '(i) Deny: the message and an active Turn on Bluetooth stay, nothing scans', JSON.stringify(r));
  await o.ctx.close();
}
{
  const o = await openPicker(360, [MIX], [{ state: 'bluetooth_off', need: 'nearby' }], { noEnable: true });
  await o.page.waitForTimeout(200);
  await o.page.click('.hrm-pick-fix').catch(() => {});
  await o.page.waitForTimeout(200);
  const pages = await o.page.evaluate(() => window.__settings);
  check(pages.length === 1 && pages[0] === 'bluetooth', '(i) an app without the box opens Bluetooth settings instead', JSON.stringify(pages));
  await o.ctx.close();
}

// (j) A strap another app holds: listed first and labelled; a held non-strap waits under Other devices; tapping connects.
{
  const HELD = { name: 'Polar H10 5E6F7A8B', mac: 'AA:BB:CC:DD:00:41', rssi: -127, isHr: true, bonded: false, inUse: true };
  const WATCH = { name: 'Galaxy Watch', mac: 'AA:BB:CC:DD:00:42', rssi: -127, isHr: false, bonded: false, inUse: true };
  const o = await openPicker(360, [MIX.concat([HELD, WATCH])]);
  await o.page.waitForTimeout(200);
  const r = await o.page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('.hrm-pick-body > .hrm-pick-row'));
    const other = Array.from(document.querySelectorAll('.hrm-pick-others .hrm-pick-row'));
    const pair = (b) => [b.querySelector('.n').textContent, b.querySelector('.m').textContent.trim()];
    return { straps: rows.map(pair), others: other.map(pair) };
  });
  check(r.straps.length === 4 && r.straps[0][0] === HELD.name && r.straps[0][1] === 'In use by another app',
    '(j) a strap another app holds lists first, as In use by another app', JSON.stringify(r.straps));
  check(r.straps.slice(1).every((s) => s[1] !== 'In use by another app') && r.others.some((s) => s[0] === WATCH.name && s[1] === 'In use by another app') && !r.straps.some((s) => s[0] === WATCH.name),
    '(j) a held device that is not a strap sits under Other devices with the same line', JSON.stringify(r));
  if (SHOTS) await o.page.screenshot({ path: path.join(SHOTS, 'picker-held-360.png') });
  await o.page.click('.hrm-pick-body > .hrm-pick-row >> nth=0');
  await o.page.waitForTimeout(100);
  const picked = await o.page.evaluate(() => window.__picked);
  check(picked && picked.mac === HELD.mac, '(j) tapping the held strap connects to it', JSON.stringify(picked));
  if (o.errs.length) fail('page errors: ' + o.errs.join(' | '));
  await o.ctx.close();
}
{
  // A strap used before in aorti.ca counts as a strap even when Android has no service list for it.
  const KNOWN_HELD = MIX.map((d) => (d.mac === 'AA:BB:CC:DD:00:27' ? Object.assign({}, d, { inUse: true, bonded: false }) : d));
  const o = await openPicker(430, [KNOWN_HELD]);
  await o.page.waitForTimeout(200);
  const first = await o.page.evaluate(() => { const b = document.querySelector('.hrm-pick-body > .hrm-pick-row'); return b && [b.querySelector('.n').textContent, b.querySelector('.m').textContent.trim()]; });
  check(first && first[0] === 'Coospo H808S 7F2E' && first[1] === 'In use by another app', '(j) a strap used before, held by another app, lists first', JSON.stringify(first));
  await o.ctx.close();
}
{
  // Native side: the held list, aorti.ca's own strap left out of it, and a scanner fetched again once Bluetooth is on.
  const held = javaSrc.slice(javaSrc.indexOf('private java.util.Map<String, BluetoothDevice> heldByOthers('), javaSrc.indexOf('// Runs on the main looper'));
  check(/getConnectedDevices\(BluetoothProfile\.GATT\)/.test(held) && /ownMac != null && ownMac\.equalsIgnoreCase\(b\.getAddress\(\)\)\) continue;/.test(held),
    '(h) the held list is LE devices connected to this phone, without aorti.ca\'s own strap');
  check(/held = heldByOthers\(ownMac\)/.test(javaSrc) && /ownMac = job\.own != null \? job\.own\.mac\(\) : null;/.test(javaSrc) && /for \(BluetoothDevice b : held\.values\(\)\)/.test(javaSrc),
    '(h) the search adds held devices it could not see, naming its own strap when the scan ends');
  check(/scanResults\.add\(new DiscoveredDevice\(b\.getAddress\(\), [^;]*, b\)\);/.test(javaSrc.slice(javaSrc.indexOf('for (BluetoothDevice b : held.values())'))),
    '(h) a held strap\'s own handle is kept, so a tap connects with its real address type');
  check(/bleScanner\.scan\(timeoutMs, mainHandler, \(\) -> device\.isLinkUp\(\) \? targetMac : null, done\)/.test(engineSrc),
    '(h) the engine names its own strap only while its link is up');
  check(/u\.startsWith\("808S"\)/.test(javaSrc) && /"isHr", hasHrUuid\(b\) \|\| \(!bonded && nameHints\(n\)\)\)/.test(javaSrc),
    '(h) an unpaired held strap counts as a strap by its maker\'s name, H808S ("808S ...") included');
  const live = javaSrc.slice(javaSrc.indexOf('private BluetoothLeScanner liveScanner('), javaSrc.indexOf('private void ensureScanCallback('));
  check(/if \(scanner == null && adapter != null\)/.test(live) && /scanner = adapter\.getBluetoothLeScanner\(\)/.test(live) && /if \(liveScanner\(\) == null\) \{ done\.fail/.test(javaSrc),
    '(h) a search fetches the scanner again when the app opened with Bluetooth off');
  check(/ACTION_REQUEST_ENABLE/.test(pluginSrc) && /@ActivityCallback\s+private void bluetoothAnswered/.test(pluginSrc), '(h) Turn on Bluetooth uses Android\'s own enable box');
}
{
  // Native side: which permissions each Android asks for, and the manifest flag that keeps Location out on 12+.
  const aliases = pluginSrc.slice(pluginSrc.indexOf('private static String[] bleAliases('), pluginSrc.indexOf('private boolean bleGranted('));
  check(/nearbyAndroid\(\) \? new String\[\] \{ "bluetoothScan", "bluetoothConnect" \} : new String\[\] \{ "location" \}/.test(aliases)
    && /Build\.VERSION\.SDK_INT >= Build\.VERSION_CODES\.S/.test(pluginSrc), '(h) Android 12+ asks for Nearby devices, older Android for Location');
  check(/alias = "location"/.test(pluginSrc) && /ACCESS_FINE_LOCATION \}, alias = "location"/.test(pluginSrc), '(h) the location alias is fine location');
  check(/forScan && !nearbyAndroid\(\) && !locationOn\(\)/.test(pluginSrc), '(h) the Location switch counts only for a search on older Android');
  check(/BLUETOOTH_SCAN" android:usesPermissionFlags="neverForLocation"/.test(manifestSrc), '(h) the manifest says the scan never derives location');
}

{
  const fn = javaSrc.slice(javaSrc.indexOf('private void finishScan('));
  const bondedBlock = fn.slice(fn.indexOf('adapter.getBondedDevices()'), fn.indexOf('bonded enumeration failed'));
  const helper = javaSrc.slice(javaSrc.indexOf('private static boolean hasHrUuid('), javaSrc.indexOf('private static JSONObject unscanned('));
  const unscanned = javaSrc.slice(javaSrc.indexOf('private static JSONObject unscanned('), javaSrc.indexOf('private java.util.Map<String, BluetoothDevice> heldByOthers('));
  check(/unscanned\(b, true, /.test(bondedBlock) && /"isHr", hasHrUuid\(b\) \|\| \(!bonded && nameHints\(n\)\)\)/.test(unscanned) && !/"isHr", true\)/.test(unscanned),
    '(e) a bonded device is HR only by its service list, an unpaired held one also by name, never true for all');
  check(/getUuids\(\)/.test(helper) && /HR_SERVICE\.equals\(u\.getUuid\(\)\)/.test(helper) && /return false;/.test(helper), '(e) the evidence is the cached UUID list holding 0x180D');
}

await browser.close();
server.close();
console.log((mutant ? `[mutant ${mutant}] ` : '') + (fails ? `${fails} failed` : 'all passed'));
process.exit(fails ? 1 : 0);
