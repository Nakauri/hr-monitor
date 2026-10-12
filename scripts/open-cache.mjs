// Guards: reopening the app waited for Drive before showing the saved sessions (AUDIT-NOTES item 32, 2026-10-12). Files: hrv_viewer.html init, ensureFolderSyncAndRender, driveSync result handling. Runtime: about 45 s; --mutants about 25 s.
//
// One browser context (so localStorage and IndexedDB carry over) is seeded by opening the viewer once against a
// fake Drive serving the demo CSVs. Each later page is a reopen of the app:
//   A. Month, every Drive call held 5 s: the cached sessions paint within 1 s and before any Drive answer;
//      no re-render after the sync finds nothing new; no loader banner.
//   B. Day, same hold: the day's sessions paint within 1 s and before any Drive answer.
//   C. Month, Drive answering at once, nothing changed: no syncing state, no re-render, no banner.
//   D. Month, one file grown on Drive (size bump): exactly one re-render, and the new data shows.
// --mutants serves the old order (cache only loaded after the sync) and A must FAIL.
//
// Usage: node scripts/open-cache.mjs [--mutants] [--ux <ux-audit dir>]
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
const { chromium } = createRequire(path.join(UX, 'kit', 'package.json'))('playwright');
const { FakeDrive } = createRequire(import.meta.url)('./marks-store.test.cjs');
const MUTANTS = args.includes('--mutants');

// The negative control: init goes straight to the Drive sync, as before S38.
const MUTANT = ['      if (!dirHandle && await paintFromCache()) painted = true;', ''];
let anchorMissing = false;

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png', '.woff2': 'font/woff2', '.csv': 'text/csv' };
const server = http.createServer((req, res) => {
  const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const file = path.join(ROOT, rel);
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end(); return; }
  let body = fs.readFileSync(file);
  if (MUTANTS && rel === '/hrv_viewer.html') {
    const text = body.toString('utf8').replace(/\r\n/g, '\n');
    if (!text.includes(MUTANT[0])) { anchorMissing = true; console.log('MUTANT ANCHOR MISSING: ' + MUTANT[0]); }
    body = text.replace(MUTANT[0], MUTANT[1]);
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  res.end(body);
});
await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
const BASE = `http://127.0.0.1:${server.address().port}`;

let fails = 0, passes = 0;
const ok = (cond, msg) => { if (cond) { passes++; console.log('PASS ' + msg); } else { fails++; console.log('FAIL ' + msg); } };

// Fake Drive holding the demo CSVs, with the size and modifiedTime driveSync compares.
const fake = new FakeDrive();
fake.folder('HR Monitor Sessions', null, '2025-01-01T00:00:00.000Z', 'root1');
const DEMO = path.join(ROOT, 'demo');
const demoNames = JSON.parse(fs.readFileSync(path.join(DEMO, 'manifest.json'), 'utf8')).files;
for (const name of demoNames) {
  const content = fs.readFileSync(path.join(DEMO, name), 'utf8');
  const rec = fake.add({ name, mimeType: 'text/csv', parents: ['root1'], content });
  rec.size = String(Buffer.byteLength(content));
  rec.modifiedTime = '2026-04-27T01:00:00.000Z';
}

let browser;
try { browser = await chromium.launch(); } catch (e) { browser = await chromium.launch({ channel: 'chrome' }); }
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, timezoneId: 'America/Edmonton' });
// Every Drive call made before the gate opens is held until it does.
const drive = { gate: 0, log: [] };
await ctx.route('**/*', async (route) => {
  const u = route.request().url();
  if (u.startsWith(BASE) || u.startsWith('data:') || u.startsWith('blob:')) return route.continue();
  if (u.startsWith('https://www.googleapis.com/')) {
    const req = route.request();
    drive.log.push({ at: Date.now(), url: u });
    const wait = drive.gate - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    let status = 200, text = '{"files":[]}';
    try {
      const r = await fake.fetch(u, { method: req.method(), headers: req.headers(), body: req.postData() || undefined });
      status = r.status; text = await r.text();
    } catch (e) {}
    drive.log.push({ at: Date.now(), url: u, done: true });
    return route.fulfill({ status, contentType: 'application/json', body: text });
  }
  if (/chart\.umd(\.min)?\.js/.test(u)) return route.fulfill({ status: 200, contentType: 'text/javascript', body: fs.readFileSync(CHART) });
  return route.fulfill({ status: 204, body: '' });
});
await ctx.addInitScript(() => {
  localStorage.setItem('aorti_auth_v2', JSON.stringify({ version: 2, access_token: 'fake', expires_at: Date.now() + 3600000, email: 'a@example.com', scope: 'drive.file', issued_at: Date.now() }));
  // grid: each Month grid build (route render), with how many days had sessions.
  const t = window.__t = { grid: [], monthAt: 0, dayAt: 0, banner: false, syncing: false };
  document.addEventListener('DOMContentLoaded', () => {
    new MutationObserver((recs) => {
      let built = false;
      for (const r of recs) for (const n of r.addedNodes) {
        if (n.nodeType === 1 && (n.matches('.cal-cell') || n.querySelector('.cal-cell'))) built = true;
      }
      const has = document.querySelectorAll('#view-month .cal-cell.has-sessions').length;
      if (built) t.grid.push({ at: Date.now(), has, d27: !!document.querySelector('#view-month .cal-cell.has-sessions[data-date="2026-04-27"]') });
      if (!t.monthAt && has >= 6) t.monthAt = Date.now();
      const day = document.getElementById('view-day');
      if (!t.dayAt && day && day.offsetParent && day.querySelector('canvas, .day-loading') && !/No recordings/.test(day.textContent)) t.dayAt = Date.now();
      const banner = document.getElementById('viewer-loading');
      if (banner && banner.classList.contains('shown')) t.banner = true;
      if (document.getElementById('app-bar').classList.contains('syncing')) t.syncing = true;
    }).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
  });
});

const errors = [];
async function reopen(hash, holdMs, settleMs) {
  const from = drive.log.length;
  drive.gate = Date.now() + holdMs;
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(hash + ': ' + e.message));
  await page.goto(`${BASE}/hrv_viewer.html?x=1${hash}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(holdMs + settleMs);
  const t = await page.evaluate(() => Object.assign({ origin: performance.timeOrigin }, window.__t));
  await page.close();
  const mine = drive.log.slice(from);
  const done = mine.filter((x) => x.done).map((x) => x.at);
  return { t, calls: mine.filter((x) => !x.done).length, firstDone: done.length ? Math.min(...done) : Infinity };
}

// Seed: the first open of the app syncs every demo file and saves the index.
{
  drive.gate = 0;
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push('seed: ' + e.message));
  await page.goto(`${BASE}/hrv_viewer.html?x=1#/month/2026-04`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction((n) => {
    try { return Object.keys(JSON.parse(localStorage.getItem('hrv_viewer_index') || '{}')).length >= n && !!localStorage.getItem('hrv_viewer_drive_lastsync'); } catch (e) { return false; }
  }, demoNames.length, { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(2500);
  const n = await page.evaluate(() => Object.keys(JSON.parse(localStorage.getItem('hrv_viewer_index') || '{}')).length);
  ok(n >= demoNames.length, `seed: first open saved ${n} of ${demoNames.length} sessions to the index`);
  await page.close();
}

const ms = (x) => (Number.isFinite(x) ? Math.round(x) + ' ms' : 'never');
{
  const r = await reopen('#/month/2026-04', 5000, 3000);
  const paint = r.t.monthAt - r.t.origin;
  ok(r.t.monthAt > 0 && paint <= 1000 && r.t.monthAt < r.firstDone,
    `A Month: cached sessions paint ${ms(r.t.monthAt ? paint : NaN)} after open, first Drive answer at ${ms(r.firstDone - r.t.origin)} (${r.calls} Drive calls)`);
  const after = r.t.grid.filter((g) => g.at > r.firstDone).length;
  ok(after === 0, `A Month: ${after} re-renders after a sync that found nothing new`);
  ok(!r.t.banner, 'A Month: no loader banner on a reopen with saved sessions');
}
if (!MUTANTS) {
  const r = await reopen('#/day/2026-04-26', 5000, 2500);
  const paint = r.t.dayAt - r.t.origin;
  ok(r.t.dayAt > 0 && paint <= 1000 && r.t.dayAt < r.firstDone,
    `B Day: the day's sessions paint ${ms(r.t.dayAt ? paint : NaN)} after open, first Drive answer at ${ms(r.firstDone - r.t.origin)}`);
  ok(!r.t.banner, 'B Day: no loader banner');

  const c = await reopen('#/month/2026-04', 0, 3000);
  // With Drive answering at once, count the renders after the first one that showed the saved sessions.
  const after = c.t.grid.filter((g) => g.at > c.t.monthAt).length;
  ok(c.calls > 0 && after === 0 && !c.t.syncing && !c.t.banner,
    `C Month, quick sync with nothing new: ${after} re-renders, syncing shown ${c.t.syncing}, banner ${c.t.banner} (${c.calls} Drive calls)`);

  // D: the 04-26 afternoon session grows on Drive past local midnight, so 04-27 gains a session.
  const rec = fake.byName('hrv_session_2026-04-26T14-59-55.csv')[0];
  const last = rec.content.trim().split('\n').pop().split(',');
  let t0 = parseFloat(last[0]), e0 = Number(last[1]), extra = '';
  for (let k = 1; k <= 6300; k++) extra += `${(t0 + k * 4 / 60).toFixed(4)},${e0 + k * 4000},${90 + (k % 7)},${(20 + (k % 5)).toFixed(2)},,,,,\n`;
  rec.content = rec.content.replace(/\n?$/, '\n') + extra;
  rec.size = String(Buffer.byteLength(rec.content));
  rec.modifiedTime = '2026-10-12T12:00:00.000Z';
  const d = await reopen('#/month/2026-04', 0, 4000);
  const before = d.t.grid.filter((g) => g.at <= d.t.monthAt);
  const after2 = d.t.grid.filter((g) => g.at > d.t.monthAt);
  if (after2.length !== 1 || !after2.length || !after2[after2.length - 1].d27) console.log('  D grid builds: ' + JSON.stringify(d.t.grid.map((g) => [g.at - d.t.origin, g.has, g.d27])));
  ok(after2.length === 1, `D Month, one file grown on Drive: ${after2.length} re-renders after the sync (${before.length} before)`);
  ok(before.length > 0 && !before.some((g) => g.d27) && after2.length > 0 && after2[after2.length - 1].d27,
    'D Month: 04-27 gains the grown session only after the sync');
  ok(!d.t.banner, 'D Month: no loader banner');
}
ok(errors.length === 0, 'no page errors: ' + errors.join(' | '));

await ctx.close();
await browser.close();
server.close();
if (MUTANTS) {
  const killed = fails > 0 && !anchorMissing;
  console.log(killed ? 'MUTANT FAILED as it should (old order caught)' : 'MUTANT SURVIVED or anchor missing');
  process.exit(killed ? 0 : 1);
}
console.log(`\n${passes} passed, ${fails} failed`);
process.exit(fails ? 1 : 0);
