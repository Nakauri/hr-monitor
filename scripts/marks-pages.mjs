// S9 marks store on the real pages, headless. Each check also runs against a mutated copy of one shipped file,
// served in place of the real one, and that run must FAIL.
//   M7  a rev hides its recorded mark from the Day chart and the markers list (v2 s row and legacy sym: cell);
//       deleting the rev brings it back; a tap record joins as a mark, a sleep record as a sleep window.
//   M10 the monitor and the viewer, one profile, write one month at once: both records reach the fake Drive.
//   P1  Purge with 3 marks not on Drive: the confirm names 3; Cancel keeps aorti_marks.
//   L1  no navigator.locks: diagnostics says marks sync is unavailable.
//   IDB the IndexedDB backend applies two updates to one key in one write, in order.
//   X1  a sleep mark made with Add sleep on a 1440 profile shows on a 360 profile's Day view after a fake-Drive sync.
//   Page loads: viewer, monitor, index and app home load with 0 page errors.
// Usage: node scripts/marks-pages.mjs [--ux <ux-audit dir>] [--checks | --mutants] (default: both)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { uxDir } from './ux-dir.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const argVal = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const ROOT = path.resolve(here, '..');
const UX = uxDir(here, argVal('--ux'));
const CHART = path.join(UX, '..', 'docs', 'audit-2026-10-09', 'harness-DT', 'vendor', 'chart.umd.min.js');
const require = createRequire(import.meta.url);
const { chromium } = createRequire(path.join(UX, 'kit', 'package.json'))('playwright');
const { FakeDrive } = require('./marks-store.test.cjs');

// Served-file overrides for the negative controls: { '/hrv_viewer.html': [find, replace] }.
let MUTATE = {};
let fake = new FakeDrive();
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png', '.woff2': 'font/woff2' };
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/__fakedrive') {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = chunks.length ? Buffer.concat(chunks).toString('utf8') : undefined;
    try {
      const r = await fake.fetch(u.searchParams.get('u'), { method: req.method, headers: { 'Content-Type': req.headers['content-type'] || '' }, body });
      res.writeHead(r.status, { 'Content-Type': 'application/json' });
      res.end(await r.text());
    } catch (e) { res.writeHead(503); res.end(String(e.message)); }
    return;
  }
  const rel = decodeURIComponent(u.pathname);
  const file = path.join(ROOT, rel);
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end(); return; }
  let body = fs.readFileSync(file);
  if (MUTATE[rel]) {
    const text = body.toString('utf8').replace(/\r\n/g, '\n');
    const [a, b] = MUTATE[rel];
    if (!text.includes(a)) { res.writeHead(500); res.end('mutant anchor missing'); console.log('MUTANT ANCHOR MISSING ' + rel + ': ' + a.slice(0, 60)); return; }
    body = text.replace(a, b);
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  res.end(body);
});
await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
const base = `http://127.0.0.1:${server.address().port}`;

let browser;
try { browser = await chromium.launch(); } catch (e) { browser = await chromium.launch({ channel: 'chrome' }); }

async function context(opts) {
  const w = (opts && opts.width) || 1440;
  const ctx = await browser.newContext({ viewport: { width: w, height: w < 600 ? 740 : 900 }, isMobile: w < 600, hasTouch: w < 600, timezoneId: 'America/Edmonton' });
  await ctx.route('**/*', (route) => {
    const u = route.request().url();
    if (u.startsWith(base) || u.startsWith('data:') || u.startsWith('blob:')) return route.continue();
    if (/chart\.umd(\.min)?\.js/.test(u)) return route.fulfill({ status: 200, contentType: 'text/javascript', body: fs.readFileSync(CHART) });
    if (/fonts\.(googleapis|gstatic)\.com|cdn\.jsdelivr\.net|cdnjs\.cloudflare\.com/.test(u)) return route.continue();
    const js = /\.js(\?|$)/.test(u) || route.request().resourceType() === 'script';
    return route.fulfill({ status: js ? 200 : 204, contentType: js ? 'text/javascript' : 'text/plain', body: '' });
  });
  if (opts && opts.noLocks) await ctx.addInitScript(`Object.defineProperty(Navigator.prototype, 'locks', { configurable: true, get: () => undefined });`);
  return ctx;
}
async function open(ctx, url) {
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  await page.goto(base + url, { waitUntil: 'networkidle' });
  await page.waitForTimeout(500);
  return { page, errs };
}
const waitMarks = (page) => page.waitForFunction(() => window.AortiMarksPage && window.AortiMarksPage.store, null, { timeout: 15000 });

// ---------------------------------------------------------------- M7
const BASE = Date.UTC(2026, 9, 5, 15, 0, 0), SID = BASE + 5000;
function segment() {
  const out = ['#hrm,v=2,base=' + BASE + ',tz=-360,app=1.0,dev=test,flavour=personal', 'g,5000,' + SID + ',start', 'c,5200,connected'];
  for (let t = 6000; t < 20 * 60000; t += 1000) {
    out.push(`h,${t},${80 + Math.round(6 * Math.sin(t / 60000))},${(30 + 5 * Math.cos(t / 90000)).toFixed(2)},750;760`);
    if (t === 600000) out.push(`s,${t},sym:dizzy`);
    if (t === 660000) out.push(`s,${t},sym:symptom`);
    if (t === 720000) out.push(`e,${t},water`);
  }
  out.push('g,' + (20 * 60000) + ',' + SID + ',stop');
  return out.join('\n') + '\n';
}
const L0 = BASE + 86400000;
function legacy() {
  const out = ['time_min,epoch_ms,hr_bpm,rmssd_ms,sdnn_match_ms,sdnn_5min_ms,sdnn_full_ms,palpitation,event,warning,connection,posture'];
  for (let i = 0; i < 1200; i++) {
    out.push(`${(i / 60).toFixed(4)},${L0 + i * 1000},${80 + Math.round(6 * Math.sin(i / 60))},${(30 + 5 * Math.cos(i / 90)).toFixed(2)},,,,,,,,`);
    if (i === 600) out.push(`${(i / 60).toFixed(4)},${L0 + i * 1000},,,,,,,sym:symptom,,,`);
  }
  return out.join('\n') + '\n';
}
const rec = (o) => Object.assign({ v: 1, m: '2026-10', by: 'zzzzzz', createdAt: 1, updatedAt: 1, base: 0, deleted: false }, o);
function fnv8(s) { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; } return ('0000000' + h.toString(16)).slice(-8); }
const revRec = (ep, k, label) => rec({ id: 'rev:' + k + ':' + ep + ':' + fnv8(label), kind: 'rev', row: { ep, k, label } });

async function seed(page, files, records, dev = 'zzzzzz') {
  await page.evaluate(async ({ files, records, dev }) => {
    const openDb = (name, v, stores) => new Promise((res, rej) => { const q = indexedDB.open(name, v);
      q.onupgradeneeded = () => { for (const s of stores) if (!q.result.objectStoreNames.contains(s)) q.result.createObjectStore(s); };
      q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
    const put = (db, store, entries) => new Promise((res, rej) => { const tx = db.transaction(store, 'readwrite');
      for (const [k, v] of entries) tx.objectStore(store).put(v, k); tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
    const kv = await openDb('hr_monitor_kv', 2, ['kv', 'drive-cache']);
    await put(kv, 'drive-cache', Object.entries(files)); kv.close();
    const mk = await openDb('aorti_marks', 1, ['records', 'mine', 'files', 'meta']);
    await put(mk, 'mine', records.map((r) => [r.id, r]));
    await put(mk, 'meta', [['deviceId', dev]]); mk.close();
    localStorage.removeItem('hrv_viewer_index');
  }, { files, records, dev });
}
async function dayView(page, day) {
  const got = await page.evaluate(() => {
    const ch = window.Chart && Chart.getChart(document.getElementById('session-chart'));
    const ann = ch ? Object.entries((ch.options.plugins.annotation || {}).annotations || {}).filter(([k]) => k.startsWith('ev_')).map(([, a]) => a.label && a.label.content) : null;
    const list = [...document.querySelectorAll('#marker-list .marker-item.type-event .marker-label')].map((e) => e.textContent.trim());
    const sleep = document.querySelectorAll('#marker-list .marker-item.type-sleep').length;
    return { ann, list, sleep };
  });
  return got;
}
async function gotoDay(page, day) {
  await page.goto('about:blank');
  await page.goto(base + '/hrv_viewer.html#/day/' + day, { waitUntil: 'networkidle' });
  await page.waitForSelector('#view-day #session-chart', { timeout: 40000 }).catch(() => {});
  await page.waitForTimeout(1200);
}
async function rerouteDay(page, day) {
  await page.evaluate(() => { location.hash = '#/month'; });
  await page.waitForTimeout(600);
  await page.evaluate((d) => { location.hash = '#/day/' + d; }, day);
  await page.waitForSelector('#view-day #session-chart', { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(1200);
}

async function checkM7() {
  const rows = [];
  const ctx = await context();
  const { page, errs } = await open(ctx, '/hrv_viewer.html#/month');
  const dizzy = revRec(BASE + 600000, 's', 'sym:dizzy');
  await seed(page, { 'hrm_20261005T15Z_abc123.csv': segment(), 'hrv_session_2026-10-06T15-00-00.000.csv': legacy() }, [
    dizzy,
    revRec(L0 + 600000, 's', 'sym:symptom'),
    rec({ id: 'zzzzzz-t1-aaaa', kind: 'tap', at: SID + 5 * 60000, cls: 'ctx', label: 'tea' }),
    rec({ id: 'zzzzzz-s1-aaaa', kind: 'sleep', from: SID + 13 * 60000, to: SID + 17 * 60000 }),
  ]);
  await gotoDay(page, '2026-10-05');
  const a = await dayView(page);
  rows.push(['M7 page: the reversed sym:dizzy row is off the chart and the markers list; the others stay; the tap joins',
    !!a.ann && JSON.stringify(a.ann) === '["Tea","Symptom","water"]' && JSON.stringify(a.list) === '["Tea","Symptom","water"]', JSON.stringify(a)]);
  rows.push(['M7 page: the sleep record shows as a sleep window in the markers list', a.sleep === 1, String(a.sleep)]);
  await page.evaluate(() => window.AortiMarksPage.store.unreverse({ ep: Date.UTC(2026, 9, 5, 15, 0, 0) + 600000, label: 'sym:dizzy' }));
  await rerouteDay(page, '2026-10-05');
  const b = await dayView(page);
  rows.push(['M7 page: deleting the rev brings the mark back', !!b.ann && b.ann.includes('Dizzy') && b.list.includes('Dizzy'), JSON.stringify(b)]);
  await rerouteDay(page, '2026-10-06');
  const c = await dayView(page);
  rows.push(['M7 page: a rev hides a legacy sym:symptom cell', !!c.ann && c.ann.length === 0 && c.list.length === 0, JSON.stringify(c)]);
  rows.push(['M7 page: no page errors', !errs.length, errs.join(' | ')]);
  await ctx.close();
  return rows;
}

// ---------------------------------------------------------------- M10
async function checkM10() {
  fake = new FakeDrive();
  fake.folder('HR Monitor Sessions', null, '2025-01-01T00:00:00.000Z', 'root1');
  const ctx = await context();
  const mon = await open(ctx, '/hr_monitor.html');
  const vw = await open(ctx, '/hrv_viewer.html#/month');
  await waitMarks(mon.page); await waitMarks(vw.page);
  const mkDrive = (page) => page.evaluate(() => {
    window.__drive = window.AortiMarksDrive.create({
      store: window.AortiMarksPage.store, locks: navigator.locks, read: false,
      driveFetch: (p, init) => fetch('/__fakedrive?u=' + encodeURIComponent(p.startsWith('http') ? p : 'https://www.googleapis.com/drive/v3/' + p),
        { method: (init && init.method) || 'GET', headers: (init && init.headers) || {}, body: init && init.body, signal: init && init.signal }),
      rootId: () => 'root1', canSync: () => true,
    });
  });
  await mkDrive(mon.page); await mkDrive(vw.page);
  await vw.page.evaluate(async () => { await window.AortiMarksPage.store.createTap({ at: Date.UTC(2026, 9, 10), cls: 'note', label: 'seed' }); await window.__drive.sync('push'); });
  let patches = 0;
  fake.delay = (method) => (method === 'PATCH' ? (++patches === 1 ? 600 : 10) : 1);
  const id1 = await mon.page.evaluate(async () => {
    const r = await window.AortiMarksPage.store.createTap({ at: Date.UTC(2026, 9, 10, 1), cls: 'note', label: 'from monitor' });
    window.__p = window.__drive.sync('push');
    return r.id;
  });
  for (let i = 0; i < 400 && !fake.calls.some((c) => c.method === 'PATCH'); i++) await new Promise((r) => setTimeout(r, 5));
  const id2 = await vw.page.evaluate(async () => {
    const r = await window.AortiMarksPage.store.createTap({ at: Date.UTC(2026, 9, 10, 2), cls: 'note', label: 'from viewer' });
    window.__p = window.__drive.sync('push');
    return r.id;
  });
  await mon.page.evaluate(() => window.__p.catch(() => {}));
  await vw.page.evaluate(() => window.__p.catch(() => {}));
  const files = fake.byName('marks_2026-10_' + await vw.page.evaluate(() => window.AortiMarksPage.store.deviceId) + '.json');
  const ids = files.length === 1 ? JSON.parse(files[0].content).records.map((r) => r.id) : [];
  const devs = [await mon.page.evaluate(() => window.AortiMarksPage.store.deviceId), await vw.page.evaluate(() => window.AortiMarksPage.store.deviceId)];
  const rows = [
    ['M10 page: monitor and viewer share one device id', devs[0] === devs[1], devs.join(' ')],
    ['M10 page: both records are on Drive after both uploads', ids.includes(id1) && ids.includes(id2), files.length + ' files, ' + ids.length + ' records'],
    ['M10 page: no page errors', !mon.errs.length && !vw.errs.length, mon.errs.concat(vw.errs).join(' | ')],
  ];
  await ctx.close();
  return rows;
}

// ---------------------------------------------------------------- X1
// A sleep mark made with Add sleep on the laptop (1440, one profile) reaches the phone viewer (360, another
// profile) through the fake Drive: laptop pushes, phone pulls, the Day view shows it as the person's sleep.
async function checkX1() {
  fake = new FakeDrive();
  fake.folder('HR Monitor Sessions', null, '2025-01-01T00:00:00.000Z', 'root1');
  const driveFor = (page, read) => page.evaluate((read) => {
    window.__drive = window.AortiMarksDrive.create({
      store: window.AortiMarksPage.store, locks: navigator.locks, read,
      driveFetch: (p, init) => fetch('/__fakedrive?u=' + encodeURIComponent(p.startsWith('http') ? p : 'https://www.googleapis.com/drive/v3/' + p),
        { method: (init && init.method) || 'GET', headers: (init && init.headers) || {}, body: init && init.body, signal: init && init.signal }),
      rootId: () => 'root1', rootIds: () => ['root1'], canSync: () => true,
    });
  }, read);
  const sleepRows = (page) => page.evaluate(() => [...document.querySelectorAll('#marker-list .marker-item.type-sleep.mine')].map((e) => e.querySelector('.marker-time').textContent.trim()));
  const rows = [];
  const lap = await context({ width: 1440 });
  const a = await open(lap, '/hrv_viewer.html#/month');
  await seed(a.page, { 'hrm_20261005T15Z_abc123.csv': segment() }, [], 'lap001');
  await gotoDay(a.page, '2026-10-05');
  await a.page.waitForSelector('#markers-actions:not([hidden])', { state: 'attached', timeout: 15000 }).catch(() => {});
  // 2026-10-05 15:00Z is 09:00 in Edmonton; the sleep runs 09:05 to 09:15.
  await a.page.click('#add-sleep', { timeout: 4000 }).catch(() => {});
  await a.page.fill('#sl-from', '2026-10-05T09:05', { timeout: 4000 }).catch(() => {});
  await a.page.fill('#sl-to', '2026-10-05T09:15', { timeout: 4000 }).catch(() => {});
  await a.page.click('.mark-editor [data-act="save"]', { timeout: 4000 }).catch(() => {});
  await a.page.waitForTimeout(1200);
  const made = await sleepRows(a.page);
  await driveFor(a.page, false);
  await a.page.evaluate(() => window.__drive.sync('push')).catch(() => {});
  const devA = await a.page.evaluate(() => window.AortiMarksPage.store.deviceId);
  const onDrive = fake.byName('marks_2026-10_' + devA + '.json');
  const body = onDrive.length ? JSON.parse(onDrive[0].content).records.filter((r) => r.kind === 'sleep') : [];
  rows.push(['X1 laptop: Add sleep makes a sleep mark and it is on Drive after a push', made.length === 1 && body.length === 1 && body[0].from === BASE + 5 * 60000 && body[0].to === BASE + 15 * 60000, JSON.stringify({ made, body: body.length })]);

  const ph = await context({ width: 360 });
  const b = await open(ph, '/hrv_viewer.html#/month');
  await seed(b.page, { 'hrm_20261005T15Z_abc123.csv': segment() }, [], 'phn001');
  await gotoDay(b.page, '2026-10-05');
  const before = await sleepRows(b.page);
  await driveFor(b.page, true);
  await b.page.evaluate(() => window.__drive.sync()).catch(() => {});
  await rerouteDay(b.page, '2026-10-05');
  const after = await sleepRows(b.page);
  const drawn = await b.page.evaluate(() => (Chart.getChart(document.getElementById('session-chart')).options.plugins.hrOverlays.overlays || []).filter((o) => o.borderDash).map((o) => [Math.round(o.xMin), Math.round(o.xMax)]));
  // Day origin is local midnight (06:00Z); 15:05Z to 15:15Z is minute 545 to 555.
  rows.push(['X1 phone: the laptop sleep mark shows after a sync, in the list and on the chart', before.length === 0 && after.length === 1 && drawn.some(([x, y]) => x === 545 && y === 555), JSON.stringify({ before, after, drawn })]);
  rows.push(['X1: no page errors', !a.errs.length && !b.errs.length, a.errs.concat(b.errs).join(' | ')]);
  await lap.close(); await ph.close();
  return rows;
}

// ---------------------------------------------------------------- P1, L1
async function checkP1() {
  const ctx = await context();
  const { page, errs } = await open(ctx, '/hrv_viewer.html#/month');
  await waitMarks(page);
  await page.evaluate(async () => { for (let i = 0; i < 3; i++) await window.AortiMarksPage.store.createTap({ at: Date.UTC(2026, 9, 10, i), cls: 'note', label: 'p' + i }); });
  await page.evaluate(() => window.HRMDiagnostics.open());
  await page.waitForSelector('#hrm-diag-purge', { timeout: 10000 });
  await page.click('#hrm-diag-purge');
  await page.waitForFunction(() => /Purge app data/.test(document.body.innerText) && [...document.querySelectorAll('button')].some((b) => b.textContent.trim() === 'Purge' && b.offsetParent), null, { timeout: 8000 }).catch(() => {});
  const text = await page.evaluate(() => document.body.innerText);
  const named = /3 marks not on Drive will be deleted\./.test(text);
  await page.evaluate(() => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === 'Cancel' && x.offsetParent); if (b) b.click(); });
  await page.waitForTimeout(500);
  const kept = await page.evaluate(() => new Promise((res) => { const q = indexedDB.open('aorti_marks'); q.onsuccess = () => { const tx = q.result.transaction('mine'); const g = tx.objectStore('mine').count(); tx.oncomplete = () => { res(g.result); q.result.close(); }; }; q.onerror = () => res(-1); }));
  const rows = [
    ['P1 page: Purge with 3 marks not on Drive, the confirm names 3', named, (text.match(/Clears sign-in[^\n]*/) || [''])[0]],
    ['P1 page: Cancel keeps aorti_marks', kept === 3, String(kept)],
    ['P1 page: no page errors', !errs.length, errs.join(' | ')],
  ];
  await ctx.close();
  return rows;
}
async function checkL1(noLocks) {
  const ctx = await context({ noLocks });
  const { page, errs } = await open(ctx, '/hrv_viewer.html#/month');
  await waitMarks(page);
  await page.evaluate(() => window.HRMDiagnostics.open());
  await page.waitForTimeout(500);
  const text = await page.evaluate(() => document.body.textContent);
  await ctx.close();
  return { line: /Marks sync unavailable on this browser/.test(text), errs };
}

async function checkIdb() {
  const ctx = await context();
  const { page, errs } = await open(ctx, '/hrv_viewer.html#/month');
  const got = await page.evaluate(async () => {
    const b = window.AortiMarks.idbBackend(indexedDB, 'aorti_marks_contract');
    const inc = (id) => (mm) => { mm = mm || { seq: 0, pending: {} }; mm.seq++; mm.pending[id] = 1; return mm; };
    const res = await b.write([{ store: 'meta', key: 'month:x', update: inc('a') }, { store: 'mine', key: 'a', value: 1 }, { store: 'meta', key: 'month:x', update: inc('b') }]);
    const all = await b.readMany(['meta', 'mine']);
    await b.destroy();
    return { res: res[2], stored: all.meta.find(([k]) => k === 'month:x')[1], mine: all.mine.length };
  });
  await ctx.close();
  return [['IDB two updates to one key in one write both apply', got.stored.seq === 2 && Object.keys(got.stored.pending).join() === 'a,b' && got.res.seq === 2 && got.mine === 1 && !errs.length, JSON.stringify(got)]];
}

async function pageLoads() {
  const rows = [];
  for (const url of ['/hrv_viewer.html', '/hr_monitor.html', '/index.html', '/app-home.html']) {
    const ctx = await context();
    const { errs } = await open(ctx, url);
    rows.push(['page load ' + url + ': 0 page errors', !errs.length, errs.join(' | ')]);
    await ctx.close();
  }
  return rows;
}

// ---------------------------------------------------------------- main
let bad = 0;
const RUN_CHECKS = !args.includes('--mutants'), RUN_MUTANTS = !args.includes('--checks');
const report = (rows) => { for (const [l, ok, d] of rows) { console.log((ok ? 'PASS ' : 'FAIL ') + l + (!ok && d ? '  [' + d + ']' : '')); if (!ok) bad++; } return rows; };
if (RUN_CHECKS) {
report(await pageLoads());
report(await checkM7());
report(await checkM10());
report(await checkX1());
report(await checkP1());
report(await checkIdb());
const l1 = await checkL1(true), l1c = await checkL1(false);
report([['L1 page: without navigator.locks diagnostics says marks sync is unavailable', l1.line && !l1.errs.length, l1.errs.join(' | ')],
  ['L1 page control: with navigator.locks the line is absent', !l1c.line]]);
}

console.log('\nNegative controls (each must FAIL):');
const MUTANTS = [
  ['M7', 'summarizeCSV drops ep', { '/hrv_viewer.html': ['events.push({ t, label: r[idx.event], ep });', 'events.push({ t, label: r[idx.event] });'] }, checkM7],
  ['M7', 'markers list ignores marks', { '/hrv_viewer.html': ["      for (const e of viewMarks(s).events) {\n        items.push({ type: 'event'", "      for (const e of s.events) {\n        items.push({ type: 'event'"] }, checkM7],
  ['M10', 'no month lock', { '/marks-drive.js': ["      return locks.request('aorti-marks:' + m, lockOpts || {}, (lock) => (lock ? fn() : 'busy'));", '      return fn();'] }, checkM10],
  ['X1', 'the Day view ignores sleep marks', { '/hrv_viewer.html': ['    const marked = viewMarks(s).sleep;', '    const marked = [];'] }, checkX1],
  ['X1', 'Add sleep writes nothing', { '/hrv_viewer.html': [': store.createSleep({ from: a, to: b }), box);', ': Promise.resolve(), box);'] }, checkX1],
  ['IDB', 'same-key ops not grouped', { '/marks-store.js': ["const key = op.store + '\\u0000' + op.key;", 'const key = String(i);'] }, checkIdb],
  ['P1', 'Purge without the marks step', { '/diagnostics.js': ["      if (mp && typeof mp.beforePurge === 'function') {", '      if (false) {'] }, checkP1],
];
for (const [id, name, mut, fn] of (RUN_MUTANTS ? MUTANTS : [])) {
  MUTATE = mut;
  const rows = await fn();
  MUTATE = {};
  const fails = rows.filter((r) => !r[1]);
  console.log('MUTANT ' + id + ' ' + name + ': ' + (fails.length ? 'FAILED as required  (' + fails.map((r) => r[0]).join(' | ') + ')' : 'NOT CAUGHT'));
  if (!fails.length) bad++;
}

await browser.close();
server.close();
console.log(bad ? '\nmarks-pages: ' + bad + ' problem(s)' : '\nmarks-pages: all pass; every negative control fails');
process.exit(bad ? 1 : 0);
