// Guards: the first sync on a new device showed nothing until every Drive file had landed, one at a time (Block 4,
// 2026-10-29: months of hourly files, a blank page for minutes on the S8). Files: hrv_viewer.html driveSyncRun,
// ensureFolderSyncAndRender, showSyncLoader, hideLoader, backfillMerge, renderDay, renderMonth, renderWeek, rptOpenMenu.
// A fake Drive holds 62 days of hourly segments plus 10 legacy files; the page opens with a saved sign-in and no cache.
//   paint (T1): today's Day chart shows while completed pulls are within today, yesterday and the legacy files on them.
//   note  (T8): the note's text and aria-busy, never 'Done' while it runs, gone at the end; the cloud fill never drops;
//               a held day shows the stub then the chart; Month and Week pending cells; the Share notice twice.
//   view  (T9): across batch merges and polls the hash, the chart range and scrollY stay; one render after the end;
//               a stale cache keeps Month's scroll and an open editor through the early paint.
//   equiv (T2): after the drain the saved index and every sess: and prec: entry equal a run of c0e5d9b (serial, one stage).
//   abort (T6): signing out with pulls in flight drops the note at once; nothing starts after.
// --base serves c0e5d9b (every part but equiv must FAIL); --mutant <name> serves one mutant (its part must FAIL).
// Runtime: about 65 s for all parts; each part alone under 40 s. Each mutant: --list, then --mutant <name> (about 35 s).
// Usage: node scripts/first-sync.mjs [--part paint|note|view|equiv|abort] [--base] [--mutant <name>] [--list] [--ux <dir>]
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { uxDir } from './ux-dir.mjs';

process.env.TZ = 'America/Denver';
const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const argVal = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const ROOT = path.resolve(here, '..');
const UX = uxDir(here, argVal('--ux'));
const CHART = path.join(here, 'vendor', 'chart.umd.min.js');
const { chromium } = createRequire(path.join(UX, 'kit', 'package.json'))('playwright');
const { FakeDrive } = createRequire(import.meta.url)('./marks-store.test.cjs');
const BASE_REF = 'c0e5d9b';
const norm = (s) => s.replace(/\r\n/g, '\n');
const baseHtml = () => norm(execFileSync('git', ['-C', ROOT, 'show', BASE_REF + ':hrv_viewer.html'], { encoding: 'utf8', maxBuffer: 64 << 20 }));

// name: [part, from, to]
const MUTANTS = {
  'ascending sort': ['paint', '(b.parsed - a.parsed) || (b.key - a.key)', '(b.parsed - a.parsed) || (a.key - b.key)'],
  'back lane opens when the front is empty': ['paint', 'for (const lane of backOpen ? [lanes.front, lanes.back] : [lanes.front]) {', 'for (const lane of [lanes.front, lanes.back]) {'],
  'unchanged showSyncLoader': ['note', 'if (split && recentDone >= recentTotal) showBackfillNote();\n    else if', 'if'],
  'renderDay without the pending check': ['note', "${pending ? 'This day is still loading from Drive.' : 'No recordings on this day'}", 'No recordings on this day'],
  'Share checks only the day': ['note', 'for (let k = -7; day && k <= 1; k++)', 'for (let k = 0; day && k <= 0; k++)'],
  'Share uses only rptDayIso': ['note', "const day = h.view === 'day' && h.arg ? h.arg : rptDayIso();", 'const day = rptDayIso();'],
  'Month selector unchanged': ['note', ".cal-cell.has-sessions, .cal-cell.pending'", ".cal-cell.has-sessions'"],
  'Week template unchanged': ['note', "` : pend ? '' : `<div class=\"week-col-empty\">no sessions</div>`}", "` : `<div class=\"week-col-empty\">no sessions</div>`}"],
  'cloud uses the recent total': ['note', 'if (total > 0) cloud.frac = current / total;\n    paintCloud();\n  }\n  function showBackfillNote', 'if (total > 0) cloud.frac = split ? recentDone / recentTotal : current / total;\n    paintCloud();\n  }\n  function showBackfillNote'],
  'batch merge calls route': ['view', "if (w.poll || (day && w.days.has(day)) || (w.batch && ['month', 'week', 'all', 'index'].includes(view))) await routeKeepScroll();", 'if (w.poll || w.batch || (day && w.days.has(day))) await route();'],
  'autoPollTick hand-off removed': ['view', "if (driveBackfill.active) await backfillMerge('poll');\n        else {", '{'],
  'end adds its own reload': ['view', "    if (st && !st.aborted) backfillStop('done');", "    if (st && !st.aborted) { backfillStop('done'); await loadSessions(); await route(); }"],
  'hideLoader without the flag guard': ['view', '    if (driveBackfill.active) return;\n    const banner = document.getElementById(\'viewer-loading\');\n    if (banner) {', "    const banner = document.getElementById('viewer-loading');\n    if (banner) {"],
  'onRecent uses plain route': ['view', '        await loadSessions();\n        await routeKeepScroll();\n        sessionsPainted', '        await loadSessions();\n        await route();\n        sessionsPainted'],
  'no backfillStop on sign-out': ['abort', "        driveFolderId = null;\n        backfillStop('auth');\n", '        driveFolderId = null;\n'],
  'drop the end reload': ['view', 'if (res && res.changed) { await loadSessions(); await routeKeepScroll(); }', 'if (false) { await loadSessions(); await routeKeepScroll(); }'],
  'skip one file': ['equiv', 'const items = toPull.map(', 'const items = toPull.slice(1).map('],
};
if (args.includes('--list')) { for (const [n, [p]] of Object.entries(MUTANTS)) console.log(p.padEnd(6) + ' ' + n); process.exit(0); }
const MUTANT = argVal('--mutant');
const BASE = args.includes('--base');
let html = BASE ? baseHtml() : norm(fs.readFileSync(path.join(ROOT, 'hrv_viewer.html'), 'utf8'));
let anchorMissing = false;
if (MUTANT) {
  const m = MUTANTS[MUTANT];
  if (!m) { console.log('unknown mutant ' + MUTANT); process.exit(2); }
  if (!html.includes(m[1])) { anchorMissing = true; console.log('MUTANT ANCHOR MISSING: ' + MUTANT); }
  html = html.replace(m[1], m[2]);
}
const PARTS = argVal('--part') ? [argVal('--part')] : MUTANT ? [MUTANTS[MUTANT][0]] : BASE ? ['paint', 'note', 'view', 'abort'] : ['paint', 'note', 'view', 'abort', 'equiv'];

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png', '.woff2': 'font/woff2', '.csv': 'text/csv' };
let serveHtml = html;
const server = http.createServer((req, res) => {
  const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (rel === '/hrv_viewer.html') { res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' }); res.end(serveHtml); return; }
  const file = path.join(ROOT, rel);
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  res.end(fs.readFileSync(file));
});
await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
const ORIGIN = `http://127.0.0.1:${server.address().port}`;

let fails = 0, passes = 0;
const ok = (cond, msg) => { if (cond) { passes++; console.log('PASS ' + msg); } else { fails++; console.log('FAIL ' + msg); } };

// ---- Fixture: 62 days of hourly segments (one session per local day) and 10 legacy files ----
const H = 3600000;
const DAYS = 62;
const pad = (n) => String(n).padStart(2, '0');
const localIso = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const isoAdd = (iso, n) => { const [y, m, d] = iso.split('-').map(Number); return localIso(new Date(y, m - 1, d + n, 12).getTime()); };
const dayStart = (iso) => { const [y, m, d] = iso.split('-').map(Number); return new Date(y, m - 1, d, 0).getTime(); };
const NOW = Date.now();
const HOUR0 = Math.floor(NOW / H) * H;
const TODAY = localIso(NOW);
const segName = (ms) => { const d = new Date(ms); return `hrm_${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}Z_tst001.csv`; };
function segText(start, upto) {
  const tz = -new Date(start).getTimezoneOffset();
  const lines = [`#hrm,v=2,base=${start},tz=${tz},app=1.0,dev=fake,flavour=personal`];
  if (new Date(start).getHours() === 0 || start === HOUR0 - (DAYS * 24 - 1) * H) lines.push(`g,0,${start},start`);
  const k = Math.floor(start / H);
  for (let off = 1000; off < Math.min(H, upto - start); off += 20000) {
    const hr = 80 + Math.round(12 * Math.sin((k * 60 + off / 60000) / 37));
    const rr = Math.round(60000 / hr);
    lines.push(`h,${off},${hr},${(30 + (off / 20000) % 7).toFixed(2)},${rr};${rr + 3}`);
  }
  return lines.join('\n') + '\n';
}
function legacyText(start, min) {
  const lines = ['time_min,epoch_ms,hr_bpm,rmssd_ms,palpitation,event,warning,connection,posture'];
  for (let s = 5; s < min * 60; s += 20) lines.push(`${(s / 60).toFixed(4)},${start + s * 1000},${75 + (s % 9)},${(40 + (s % 5)).toFixed(2)},,,,,`);
  return lines.join('\n') + '\n';
}
const legacyName = (ms) => { const d = new Date(ms); return `hrv_session_${localIso(ms)}T${pad(d.getHours())}-${pad(d.getMinutes())}-00.123.csv`; };

// gap: two of the newest hours are left out and a legacy file sits there (it can grow during a test).
function makeDrive(o) {
  o = o || {};
  const fake = new FakeDrive();
  fake.folder('HR Monitor Sessions', null, '2025-01-01T00:00:00.000Z', 'root1');
  const months = new Map();
  const files = [];
  const add = (name, parent, content) => {
    const rec = fake.add({ name, mimeType: 'text/csv', parents: [parent], content });
    rec.size = String(Buffer.byteLength(content));
    rec.modifiedTime = new Date(NOW).toISOString();
    files.push(rec);
    return rec;
  };
  for (let h = 0; h < DAYS * 24; h++) {
    const start = HOUR0 - h * H;
    if (o.gap && (h === 4 || h === 5)) continue;
    const d = new Date(start);
    const ym = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}`;
    if (!months.has(ym)) months.set(ym, fake.folder(ym, 'root1', '2025-01-01T00:00:00.000Z', 'm' + ym).id);
    add(segName(start), months.get(ym), segText(start, NOW));
  }
  for (const back of [0, 1, 5, 9, 14, 20, 27, 35, 44, 55]) {
    const start = back === 0 ? Math.min(NOW - 3 * H, dayStart(TODAY) + 30 * 60000) : dayStart(isoAdd(TODAY, -back)) + 14 * H;
    add(legacyName(start), 'root1', legacyText(start, 30));
  }
  if (o.gap) { const start = HOUR0 - 5 * H + 5 * 60000; add(legacyName(start), 'root1', legacyText(start, 30)).start = start; }
  return { fake, files };
}

// The independent T1 bound: today's and yesterday's hours by local day, plus the legacy files overlapping them.
function recentBound(files) {
  const yest = isoAdd(TODAY, -1);
  let n = 0;
  for (const f of files) {
    const m = /^hrm_(\d{4})(\d{2})(\d{2})T(\d{2})Z_/.exec(f.name);
    if (m) { const iso = localIso(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4])); if (iso === TODAY || iso === yest) n++; continue; }
    const l = /^hrv_session_(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})/.exec(f.name);
    if (l) { const s = new Date(`${l[1]}T${l[2]}:${l[3]}:00`).getTime(); if (s + 24 * H > dayStart(yest)) n++; }
  }
  return n;
}
const filesOfDay = (files, iso) => files.filter((f) => {
  const m = /^hrm_(\d{4})(\d{2})(\d{2})T(\d{2})Z_/.exec(f.name);
  return m && localIso(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4])) === iso;
}).map((f) => f.name);

let browser;
try { browser = await chromium.launch(); } catch (e) { browser = await chromium.launch({ channel: 'chrome' }); }

// One context = one device. drive.hold: names whose download waits for drive.release(); drive.delay per download.
async function device(opts) {
  opts = opts || {};
  const { fake, files } = opts.drive || makeDrive();
  const drive = { fake, files, media: [], lists: [], hold: new Set(), waiters: [], delay: opts.delay == null ? 8 : opts.delay, script: {} };
  drive.release = () => { const w = drive.waiters; drive.waiters = []; drive.hold.clear(); w.forEach((f) => f()); };
  const ctx = await browser.newContext({ viewport: opts.viewport || { width: 1440, height: 900 }, deviceScaleFactor: 1, timezoneId: 'America/Denver' });
  await ctx.route('**/*', async (route) => {
    const u = route.request().url();
    if (u.startsWith(ORIGIN) || u.startsWith('data:') || u.startsWith('blob:')) return route.continue();
    if (u.startsWith('https://www.googleapis.com/')) {
      const req = route.request();
      const url = new URL(u);
      const mm = /\/drive\/v3\/files\/([^/]+)$/.exec(url.pathname);
      if (mm && url.searchParams.get('alt') === 'media') {
        const rec = fake.files.get(decodeURIComponent(mm[1]));
        const name = rec ? rec.name : '?';
        const at = Date.now();
        if (drive.hold.has(name)) await new Promise((r) => drive.waiters.push(r));
        if (drive.delay) await new Promise((r) => setTimeout(r, drive.delay));
        const s = drive.script[name] && drive.script[name].shift();
        if (s) { drive.media.push({ name, at, done: Date.now(), status: s.status }); return route.fulfill({ status: s.status, headers: s.headers || {}, contentType: 'application/json', body: JSON.stringify({ error: { errors: [{ reason: s.reason || 'x' }] } }) }).catch(() => {}); }
        drive.media.push({ name, at, done: Date.now(), status: 200 });
        return route.fulfill({ status: rec ? 200 : 404, contentType: 'text/csv', body: rec ? rec.content : '' }).catch(() => {});
      }
      if (url.pathname === '/drive/v3/files' && req.method() === 'GET') drive.lists.push({ at: Date.now(), q: url.searchParams.get('q') });
      let status = 200, text = '{"files":[]}';
      try {
        const r = await fake.fetch(u, { method: req.method(), headers: req.headers(), body: req.postData() || undefined });
        status = r.status; text = await r.text();
      } catch (e) { status = 200; }
      return route.fulfill({ status, contentType: 'application/json', body: text }).catch(() => {});
    }
    if (/chart\.umd(\.min)?\.js/.test(u)) return route.fulfill({ status: 200, contentType: 'text/javascript', body: fs.readFileSync(CHART) });
    return route.fulfill({ status: 204, body: '' }).catch(() => {});
  });
  await ctx.addInitScript(({ poll }) => {
    localStorage.setItem('aorti_auth_v2', JSON.stringify({ version: 2, access_token: 'fake', expires_at: Date.now() + 3600000, email: 'a@example.com', scope: 'drive.file', issued_at: Date.now() }));
    // The 60 s poll runs every few seconds here.
    const si = window.setInterval;
    window.setInterval = (f, ms, ...a) => si(f, ms === 60000 ? poll : ms, ...a);
    const t = window.__t = { banner: [], fill: [], noRec: [], stub: [], canvasDays: [], updates: [], empty: [], grid: 0 };
    // Chart updates on #session-chart: one group per render.
    let C;
    Object.defineProperty(window, 'Chart', { configurable: true, get() { return C; }, set(v) {
      C = v;
      const up = v && v.prototype && v.prototype.update;
      if (up) v.prototype.update = function (...a) { if (this.canvas && this.canvas.id === 'session-chart') t.updates.push(Date.now()); return up.apply(this, a); };
    } });
    const sample = () => {
      const b = document.getElementById('viewer-loading');
      if (b) {
        const s = { shown: b.classList.contains('shown'), note: b.classList.contains('note'), text: (document.getElementById('viewer-loading-text') || {}).textContent, busy: b.getAttribute('aria-busy') };
        const last = t.banner[t.banner.length - 1];
        if (!last || last.shown !== s.shown || last.note !== s.note || last.text !== s.text || last.busy !== s.busy) t.banner.push(Object.assign({ at: Date.now() }, s));
      }
      const day = document.getElementById('view-day');
      if (day && day.offsetParent) {
        const txt = day.textContent;
        if (/No recordings on this day/.test(txt)) t.noRec.push(day.dataset.iso);
        if (/This day is still loading from Drive\./.test(txt) && !t.stub.includes(day.dataset.iso)) t.stub.push(day.dataset.iso);
        const cv = document.getElementById('session-chart');
        if (cv && day.contains(cv) && !t.canvasDays.some((c) => c.iso === day.dataset.iso)) t.canvasDays.push({ iso: day.dataset.iso, at: Date.now() });
      }
      const es = document.getElementById('empty-state');
      if (es && es.offsetParent) t.empty.push(Date.now());
    };
    document.addEventListener('DOMContentLoaded', () => {
      new MutationObserver((recs) => {
        // Every value the fill took, also those set twice in one task: the value after a change is the next one's oldValue.
        const fills = recs.filter((r) => r.type === 'attributes' && r.target.id === 'syncbar-fill' && r.attributeName === 'style');
        const sync = document.getElementById('app-bar').classList.contains('syncing');
        fills.forEach((r, i) => t.fill.push({ at: Date.now(), v: i + 1 < fills.length ? fills[i + 1].oldValue || '' : r.target.getAttribute('style') || '', sync }));
        for (const r of recs) {
          for (const n of r.addedNodes || []) if (n.nodeType === 1 && (n.matches('.cal-grid') || n.querySelector('.cal-grid'))) t.grid++;
        }
        sample();
      }).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeOldValue: true, characterData: true, attributeFilter: ['class', 'style', 'aria-busy', 'data-iso'] });
      sample();
    });
  }, { poll: opts.poll || 2500 });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const log = [];
  page.on('console', (m) => { if (/\[sync-phase\]|\[driveSync\]/.test(m.text())) log.push({ at: Date.now(), text: m.text() }); });
  return { ctx, page, drive, errors, log };
}
const t = (page) => page.evaluate(() => window.__t);
const until = async (fn, ms, step) => { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v || Date.now() > end) return v; await new Promise((r) => setTimeout(r, step || 100)); } };
const WAIT = BASE ? 40000 : 120000;
const synced = (dev) => until(() => dev.log.some((l) => /sync done/.test(l.text)), WAIT, 250);
const lastBanner = async (page) => page.evaluate(() => { const b = document.getElementById('viewer-loading'); return { shown: b.classList.contains('shown'), note: b.classList.contains('note'), text: document.getElementById('viewer-loading-text').textContent, busy: b.getAttribute('aria-busy') }; });

async function partPaint() {
  const dev = await device();
  const bound = recentBound(dev.drive.files);
  await dev.page.goto(`${ORIGIN}/hrv_viewer.html`, { waitUntil: 'domcontentloaded' });
  const got = await until(async () => (await t(dev.page)).canvasDays.find((c) => c.iso === TODAY), WAIT, 100);
  const done = got ? dev.drive.media.filter((m) => m.done < got.at).length : Infinity;
  ok(!!got && done <= bound, `T1 today's chart shows with ${done === Infinity ? 'never' : done} pulls done (bound ${bound} of ${dev.drive.files.length})`);
  ok(dev.errors.length === 0, 'T1 no page errors: ' + dev.errors.join(' | '));
  await dev.ctx.close();
}

async function partNote() {
  const dev = await device({ delay: 10 });
  const { page, drive } = dev;
  const yest = isoAdd(TODAY, -1);
  const X = isoAdd(TODAY, -10), D3 = isoAdd(TODAY, -3), Y = isoAdd(TODAY, -40), W = isoAdd(TODAY, -45);
  for (const n of filesOfDay(drive.files, D3)) drive.hold.add(n);
  await page.goto(`${ORIGIN}/hrv_viewer.html`, { waitUntil: 'domcontentloaded' });
  await until(async () => (await t(page)).canvasDays.find((c) => c.iso === TODAY), WAIT);
  // (e) Share on yesterday while D-3 is held.
  await page.evaluate((d) => { location.hash = '#/day/' + d; }, yest);
  await until(async () => (await t(page)).canvasDays.find((c) => c.iso === yest), 30000);
  await page.click('#export-report');
  await page.waitForTimeout(800);
  const e = await page.evaluate(() => ({ notice: [...document.querySelectorAll('.notice .msg')].map((n) => n.textContent), menu: !!document.getElementById('share-menu') }));
  ok(e.notice.includes('This report needs days that are still loading from Drive.') && !e.menu, `T8e Share on yesterday with D-3 loading: notice ${JSON.stringify(e.notice)}, menu ${e.menu}`);
  // (c) A held day shows the stub, never 'No recordings', then the chart once released.
  drive.release();
  for (const n of filesOfDay(drive.files, X)) drive.hold.add(n);
  await page.evaluate((d) => { location.hash = '#/day/' + d; }, X);
  await page.waitForTimeout(1200);
  let s = await t(page);
  ok(s.stub.includes(X) && !s.noRec.includes(X), `T8c held day ${X}: stub shown ${s.stub.includes(X)}, 'No recordings' shown ${s.noRec.includes(X)}`);
  // (g) Share on the held day: the notice, never a menu for another day.
  await page.click('#export-report');
  await page.waitForTimeout(800);
  const g = await page.evaluate(() => ({ notice: [...document.querySelectorAll('.notice .msg')].filter((n) => /still loading/.test(n.textContent)).length, menu: !!document.getElementById('share-menu') }));
  ok(g.notice >= 1 && !g.menu, `T8g Share on a held day: notice ${g.notice}, menu ${g.menu}`);
  drive.release();
  const filled = await until(async () => (await t(page)).canvasDays.find((c) => c.iso === X), 30000);
  s = await t(page);
  ok(!!filled && !s.noRec.includes(X), `T8c the held day's chart replaces the stub without a tap (${!!filled})`);
  // (d) Month: a pending cell has a date and opens the Day; Week: a pending column has no 'no sessions'.
  const ym = Y.slice(0, 7);
  await page.evaluate((m) => { location.hash = '#/month/' + m; }, ym);
  await page.waitForTimeout(400);
  const cell = await page.evaluate(() => { const c = document.querySelector('#view-month .cal-cell.pending[data-date]'); return c ? { iso: c.dataset.date, text: c.textContent.trim() } : null; });
  if (cell) {
    for (const n of filesOfDay(drive.files, cell.iso)) drive.hold.add(n);
    await page.click(`#view-month .cal-cell[data-date="${cell.iso}"]`);
    await page.waitForTimeout(800);
  }
  s = await t(page);
  const hashD = await page.evaluate(() => location.hash);
  ok(!!cell && /^\d+$/.test(cell.text) && hashD === '#/day/' + cell.iso && s.stub.includes(cell.iso) && !s.noRec.includes(cell.iso), `T8d pending Month cell ${cell ? cell.iso : 'none'}: blank, opens the Day stub (${hashD})`);
  drive.release();
  if (cell) await until(async () => (await t(page)).canvasDays.find((c) => c.iso === cell.iso), 30000);
  await page.evaluate((d) => { location.hash = '#/week/' + d; }, W);
  await page.waitForTimeout(300);
  const wk = await page.evaluate(() => [...document.querySelectorAll('#view-week .week-col.pending')].map((c) => c.textContent.includes('no sessions')));
  ok(wk.length > 0 && wk.every((x) => !x), `T8d pending Week columns: ${wk.length}, none reads 'no sessions'`);
  await synced(dev);
  await page.waitForTimeout(1500);
  s = await t(page);
  const tail = await lastBanner(page);
  const noteFrames = s.banner.filter((b) => b.note);
  const firstNote = noteFrames.length ? noteFrames[0] : null;
  ok(!!firstNote && firstNote.text === 'Older days are still loading from Drive.' && firstNote.busy === 'false', 'T8a note: ' + JSON.stringify(firstNote && { text: firstNote.text, busy: firstNote.busy }));
  const doneFrames = s.banner.filter((b) => b.shown && b.text === 'Done');
  ok(doneFrames.length === 0, `T8a the banner never reads Done during the run (${doneFrames.length} frames)`);
  ok(!tail.shown && !tail.note && tail.busy === 'true', 'T8a the note is gone at the end: ' + JSON.stringify(tail));
  const vals = s.fill.filter((f) => f.sync).map((f) => +((/scaleX\(([\d.]+)\)/.exec(f.v) || [])[1] || 0)).filter((v) => v > 0.04);
  let drops = 0;
  for (let i = 1; i < vals.length; i++) if (vals[i] < vals[i - 1] - 1e-9) drops++;
  ok(vals.length > 10 && drops === 0, `T8b the cloud fill never drops (${vals.length} values, ${drops} drops)`);
  ok(dev.errors.length === 0, 'T8 no page errors: ' + dev.errors.join(' | '));
  await dev.ctx.close();
}

async function partView() {
  // Interactive: today zoomed and scrolled while batch merges and polls land; the live hour grows.
  {
    const dev = await device({ drive: makeDrive({ gap: true }), delay: 25, poll: 2500, viewport: { width: 1440, height: 600 } });
    const { page, drive } = dev;
    await page.goto(`${ORIGIN}/hrv_viewer.html`, { waitUntil: 'domcontentloaded' });
    await until(async () => (await t(page)).canvasDays.find((c) => c.iso === TODAY), WAIT);
    await page.waitForTimeout(1500);
    const box = await page.evaluate(() => { const r = document.getElementById('session-chart').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
    await page.mouse.move(box.x, box.y);
    await page.keyboard.down('Control');
    await page.mouse.wheel(0, -400);
    await page.keyboard.up('Control');
    await page.waitForTimeout(500);
    await page.evaluate(() => { window.scrollTo(0, 300); document.querySelector("main").scrollTop = 300; });
    await page.waitForTimeout(300);
    const read = () => page.evaluate(() => { const c = Chart.getChart(document.getElementById('session-chart')); return { hash: location.hash, min: c ? c.scales.x.min : null, max: c ? c.scales.x.max : null, y: Math.round(window.scrollY + document.querySelector("main").scrollTop) }; });
    const v0 = await read();
    const live = drive.files.find((f) => f.name === segName(HOUR0));
    // The legacy file in the gap grows from 30 to 100 min; a poll merge must show the new summary at once.
    const L = drive.files.find((f) => f.start);
    L.content = legacyText(L.start, 100);
    L.size = String(Buffer.byteLength(L.content));
    L.modifiedTime = new Date().toISOString();
    let durAfterPoll = null;
    const noteAt = await until(async () => (await t(page)).banner.find((b) => b.note), 20000);
    const t0 = Date.now();
    const samples = [];
    let grows = 0;
    while (Date.now() - t0 < WAIT && !dev.log.some((l) => l.at > t0 && /sync done/.test(l.text))) {
      if (samples.length % 10 === 0) { live.content += `h,${Math.min(H - 1000, Date.now() - HOUR0 - 500)},90,30.00,666;668\n`; live.size = String(Buffer.byteLength(live.content)); live.modifiedTime = new Date().toISOString(); grows++; }
      samples.push(await read());
      if (durAfterPoll == null && drive.media.some((m) => m.name === L.name && m.at > t0)) {
        await page.waitForTimeout(1500);
        durAfterPoll = await page.evaluate((n) => { try { const e = JSON.parse(localStorage.getItem('hrv_viewer_index') || '{}')[n]; return e ? Math.round(e.duration) : -1; } catch (x) { return -2; } }, L.name);
      }
      await page.waitForTimeout(250);
    }
    // The end is the run's own "sync done" line, not when this loop saw it.
    const doneLine = dev.log.find((l) => l.at > t0 && /sync done/.test(l.text));
    const end = doneLine ? doneLine.at : Date.now();
    await page.waitForTimeout(2500);
    const s = await t(page);
    const moved = samples.filter((x) => x.hash !== v0.hash || x.min !== v0.min || x.max !== v0.max || Math.abs(x.y - v0.y) > 1);
    const polls = drive.lists.filter((l) => l.at > t0 && l.at < end && /hrv_session/.test(l.q || '')).length;
    ok(v0.min != null && v0.y > 0 && samples.length > 20 && moved.length === 0, `T9 interactive: hash, chart range and scroll kept over ${samples.length} samples (${moved.length} moved, first ${JSON.stringify(moved[0] || null)}), ${polls} polls`);
    // Today re-renders only after a poll's listing or at the end: an update group outside both is a batch reload.
    const pollAt = drive.lists.filter((l) => l.at > t0 && /hrv_session/.test(l.q || '')).map((l) => l.at);
    const groups = [];
    for (const u of s.updates.filter((u) => u > t0)) if (!groups.length || u - groups[groups.length - 1].last > 400) groups.push({ first: u, last: u }); else groups[groups.length - 1].last = u;
    const stray = groups.filter((g) => !pollAt.some((p) => g.first >= p && g.first - p < 3000) && g.first < end);
    ok(polls >= 1 && stray.length === 0, `T9 interactive: today re-renders only on polls and at the end (${groups.length} renders, ${stray.length} outside a poll, ${polls} polls)`);
    const after = groups.filter((g) => g.first >= end && !pollAt.some((p) => p >= end && g.first >= p && g.first - p < 3000)).length;
    ok(after === 1, `T9 interactive: one render after the end (${after})`);
    ok(durAfterPoll != null && durAfterPoll >= 90, `T9 interactive: a legacy file grown during the backfill reads ${durAfterPoll} min after the poll merge (100 on Drive)`);
    ok(!!noteAt && dev.errors.length === 0, 'T9 interactive: no page errors: ' + dev.errors.join(' | '));
    await dev.ctx.close();
  }
  // Seeded token, empty cache: no empty state after the first progress call; the banner stays until the note.
  {
    const dev = await device({ delay: 6 });
    const { page } = dev;
    await page.goto(`${ORIGIN}/hrv_viewer.html`, { waitUntil: 'domcontentloaded' });
    await synced(dev);
    await page.waitForTimeout(2500);
    const s = await t(page);
    const firstCount = s.banner.find((b) => b.shown && / of \d+$/.test(b.text || ''));
    const noteAt = s.banner.find((b) => b.note);
    const gap = firstCount && noteAt ? s.banner.filter((b) => b.at >= firstCount.at && b.at < noteAt.at && !b.shown).length : -1;
    const emptyAfter = firstCount ? s.empty.filter((e) => e > firstCount.at).length : -1;
    ok(!!firstCount && !!noteAt && gap === 0, `T9 seeded: banner on every frame from the first count to the note (${gap} gaps)`);
    ok(emptyAfter === 0, `T9 seeded: no empty state after the first progress call (${emptyAfter} frames)`);
    ok(dev.errors.length === 0, 'T9 seeded: no page errors: ' + dev.errors.join(' | '));
    await dev.ctx.close();
  }
  // Stale cache: a device whose cache lacks the newest 30 hours and 40 older ones paints from cache, then splits.
  {
    const built = makeDrive();
    const dev = await device({ drive: built, delay: 3, viewport: { width: 1440, height: 600 } });
    const { page, drive, ctx } = dev;
    await page.goto(`${ORIGIN}/hrv_viewer.html#/month/${TODAY.slice(0, 7)}`, { waitUntil: 'domcontentloaded' });
    await synced(dev);
    await page.waitForTimeout(1500);
    await page.close();
    const segs = drive.files.filter((f) => /^hrm_/.test(f.name)).map((f) => f.name).sort().reverse();
    const drop = segs.slice(0, 30).concat(segs.slice(240, 280));
    const p2 = await ctx.newPage();
    p2.on('pageerror', (e) => dev.errors.push(e.message));
    p2.on('console', (m) => { if (/\[sync-phase\]/.test(m.text())) dev.log.push({ at: Date.now(), text: m.text() }); });
    await p2.goto(`${ORIGIN}/favicon.svg`);
    await p2.evaluate(async (names) => {
      const meta = JSON.parse(localStorage.getItem('hrv_viewer_drive_meta') || '{}');
      for (const n of names) delete meta[n];
      localStorage.setItem('hrv_viewer_drive_meta', JSON.stringify(meta));
      await new Promise((ok, no) => {
        const r = indexedDB.open('hr_monitor_kv', 2);
        r.onsuccess = () => { const tx = r.result.transaction('drive-cache', 'readwrite'); for (const n of names) tx.objectStore('drive-cache').delete(n); tx.oncomplete = () => { r.result.close(); ok(); }; tx.onerror = () => no(tx.error); };
        r.onerror = () => no(r.error);
      });
    }, drop);
    for (const n of drop.slice(0, 30)) drive.hold.add(n);
    const from = dev.log.length;
    await p2.goto(`${ORIGIN}/hrv_viewer.html#/month/${TODAY.slice(0, 7)}`, { waitUntil: 'domcontentloaded' });
    await p2.waitForSelector('#view-month .cal-cell.has-sessions', { timeout: 20000 });
    await p2.evaluate(() => {
      window.scrollTo(0, 200); document.querySelector("main").scrollTop = 200;
      const ed = document.createElement('div');
      ed.className = 'mark-editor ui';
      ed.innerHTML = '<input id="ed-probe">';
      document.querySelector('#view-month .cal-grid').prepend(ed);
      document.getElementById('ed-probe').value = 'typed text';
    });
    const y0 = await p2.evaluate(() => Math.round(window.scrollY + document.querySelector("main").scrollTop));
    drive.release();
    await until(() => dev.log.slice(from).some((l) => /sync done/.test(l.text)), WAIT, 250);
    const s = await p2.evaluate(() => ({ y: Math.round(window.scrollY + document.querySelector("main").scrollTop), ed: (document.getElementById('ed-probe') || {}).value || null, note: window.__t.banner.some((b) => b.note) }));
    ok(s.note, 'T9 stale cache: the run splits after the cached paint and the note shows');
    ok(y0 > 0 && Math.abs(s.y - y0) <= 1 && s.ed === 'typed text', `T9 stale cache: scroll ${y0} to ${s.y}, editor text ${JSON.stringify(s.ed)}`);
    ok(dev.errors.length === 0, 'T9 stale cache: no page errors: ' + dev.errors.join(' | '));
    await ctx.close();
  }
}

async function partAbort() {
  const dev = await device({ delay: 10 });
  const { page, drive } = dev;
  await page.goto(`${ORIGIN}/hrv_viewer.html`, { waitUntil: 'domcontentloaded' });
  await until(async () => (await t(page)).banner.find((b) => b.note), WAIT);
  await page.waitForTimeout(500);
  // Hold everything from now: the pool fills its 4 slots and waits.
  for (const f of drive.files) drive.hold.add(f.name);
  await page.waitForTimeout(800);
  const startsBefore = drive.media.length;
  const held = drive.waiters.length;
  await page.evaluate(() => window.aortiAuth.signOut({ remote: false }));
  await page.waitForTimeout(150);
  const b = await lastBanner(page);
  ok(held >= 1 && !b.note && !b.shown, `T6a sign-out with ${held} pulls held: the note is gone before they settle (${JSON.stringify(b)})`);
  drive.hold.clear();
  drive.release();
  await page.waitForTimeout(3000);
  const after = drive.media.length - startsBefore - held;
  ok(after <= 0, `T6a after sign-out: ${Math.max(0, after)} new pulls`);
  ok(dev.errors.length === 0, 'T6 no page errors: ' + dev.errors.join(' | '));
  await dev.ctx.close();
}

// T2: the build's drained cache equals c0e5d9b's (serial, one stage) on the same Drive.
async function partEquiv() {
  const built = makeDrive();
  const dump = async (h) => {
    serveHtml = h;
    const dev = await device({ drive: built, delay: 0 });
    await dev.page.goto(`${ORIGIN}/hrv_viewer.html#/month/${TODAY.slice(0, 7)}`, { waitUntil: 'domcontentloaded' });
    await synced(dev);
    await dev.page.waitForTimeout(4000);
    const out = await dev.page.evaluate(async () => {
      const idx = localStorage.getItem('hrv_viewer_index');
      const seg = await new Promise((ok) => {
        const r = indexedDB.open('hrv_viewer_segidx', 1);
        r.onsuccess = () => {
          const tx = r.result.transaction('seg-index', 'readonly');
          const st = tx.objectStore('seg-index');
          const keys = st.getAllKeys();
          const vals = st.getAll();
          tx.oncomplete = () => { const o = {}; keys.result.forEach((k, i) => { if (/^(sess|prec):/.test(k)) o[k] = vals.result[i]; }); r.result.close(); ok(o); };
        };
        r.onerror = () => ok({});
      });
      return { idx: JSON.parse(idx || '{}'), seg };
    });
    await dev.ctx.close();
    return out;
  };
  const a = await dump(html);
  const b = await dump(baseHtml());
  serveHtml = html;
  const canon = (o) => JSON.stringify(o, Object.keys(o).sort());
  const diffs = (x, y) => { const ks = new Set([...Object.keys(x), ...Object.keys(y)]); return [...ks].filter((k) => JSON.stringify(x[k]) !== JSON.stringify(y[k])); };
  const di = diffs(a.idx, b.idx), ds = diffs(a.seg, b.seg);
  ok(Object.keys(a.idx).length >= 10 && di.length === 0, `T2 saved index equal to ${BASE_REF} (${Object.keys(a.idx).length} entries, ${di.length} differ ${di.slice(0, 3).join(' ')})`);
  ok(Object.keys(a.seg).length > 60 && ds.length === 0, `T2 sess: and prec: entries equal to ${BASE_REF} (${Object.keys(a.seg).length} entries, ${ds.length} differ ${ds.slice(0, 3).join(' ')})`);
  void canon;
}

const RUN = { paint: partPaint, note: partNote, view: partView, abort: partAbort, equiv: partEquiv };
for (const p of PARTS) { console.log('== ' + p); await RUN[p](); }
await browser.close();
server.close();
if (MUTANT || BASE) {
  const killed = fails > 0 && !anchorMissing;
  console.log(killed ? `${MUTANT ? 'MUTANT' : 'BASE'} FAILED as it should (${fails} failing checks)` : `${MUTANT ? 'MUTANT' : 'BASE'} SURVIVED or anchor missing`);
  process.exit(killed ? 0 : 1);
}
console.log(`\n${passes} passed, ${fails} failed`);
process.exit(fails ? 1 : 0);
