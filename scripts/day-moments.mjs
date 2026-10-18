// Guards: the Day report missing the long high stretches and catching stair climbs (Khal 2026-10-17, S61 study), the dead
// "Noteworthy moments" detector (reads p.v, handed {x,y}), strap junk read as an evening above 100 (false stretches
// without the beat check), start-of-recording posture stamps read as taps, 5 s demo rows finding nothing.
// Files: hrv_viewer.html (S61 moments block, rptBase, rptModel, dayMoments, rptDescribe, renderInsight, the span build in
// summarizeCSV, the two summary cache hit tests, v2SeriesFromRows, buildDaySession). Runtime: golden about 40 s, demo 3 s,
// replay about 30 s, agree and same about 60 s each, copy about 40 s, nav about 30 s.
// Review goldens G20 (two joined rises) and G21 (bridged dip) guard REVIEW-code M1 and S1.
// --part golden,demo,replay,agree,same,copy,nav (default golden,demo,copy). replay needs <ux>/redesign/s61/replay-manifest.json
// and the files it names; agree, same, copy and nav need <ux>/redesign/s54/data (10-13 and 10-14 segments). A missing
// input exits 2 with the missing path, never a pass or a band failure. --mutants runs the negative controls, each must
// FAIL; with --part, only the mutants aimed at those parts. "same" compares against main 38a4d96 (S53 on top of 90c62d6).
// Usage: node scripts/day-moments.mjs [--part <list>] [--mutants] [--ux <dir>] [--shots <dir>]
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { uxDir } from './ux-dir.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');
const args = process.argv.slice(2);
const argVal = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const UX = uxDir(here, argVal('--ux'));
const MUTANTS_ON = args.includes('--mutants');
const PARTS = (argVal('--part') || (MUTANTS_ON ? 'golden,demo,replay,agree,same,copy,nav' : 'golden,demo,copy')).split(',');
const BASE_REF = '38a4d96';
const HOME = 'C:/Users/Khal';
const S54 = path.join(UX, 'redesign', 's54', 'data');
const MANIFEST = path.join(UX, 'redesign', 's61', 'replay-manifest.json');
const CHART = path.join(UX, '..', 'docs', 'audit-2026-10-09', 'harness-DT', 'vendor', 'chart.umd.min.js');
const REAL = fs.readFileSync(path.join(ROOT, 'hrv_viewer.html'), 'utf8').replace(/\r\n/g, '\n');
const T0 = Date.now();
const need = (p) => { if (!fs.existsSync(p)) { console.log('MISSING ' + p); process.exit(2); } };

// ---------- the S61 block, cut at run time ----------
function cut(src) {
  const a = src.indexOf('  // ---- S61 moments ----'), b = src.indexOf('  // ---- S61 moments end ----');
  if (a < 0 || b < a) throw new Error('S61 block markers missing');
  const fns = ['rptAt', 'rptMean', 'rptWindow', 'rptStanding', 'rptDescribe', 's61Describe', 'rptDur', 'rptPad', 'formatClockTime', 'rptBin'].map((n) => fnSrc(src, n)).join('\n');
  const g = globalThis.__s61; globalThis.__s61 = undefined;
  const o = new Function(src.slice(a, b) + fns + ';return { secondsFromPoints, beatJunk, detectStretches, detectRises, detectDayMoments, dayMoments, rptBin, S61_BEAT, s61Settle };')();
  globalThis.__s61 = g;
  return o;
}
// One top-level function's source by name (brace matching outside strings).
function fnSrc(src, name) {
  const i = src.indexOf('\n  function ' + name + '(');
  if (i < 0) throw new Error('function ' + name + ' missing');
  let j = src.indexOf('{', i), depth = 0, q = null;
  for (; j < src.length; j++) {
    const c = src[j];
    if (q) { if (c === '\\') j++; else if (c === q) q = null; continue; }
    if (c === "'" || c === '"' || c === '`') { q = c; continue; }
    if (c === '{') depth++;
    else if (c === '}' && --depth === 0) break;
  }
  return src.slice(i, j + 1);
}

let fails = 0, passes = 0;
const rows = [];
const ok = (cond, msg) => { if (cond) passes++; else fails++; rows.push((cond ? 'PASS ' : 'FAIL ') + msg); if (!QUIET) console.log((cond ? 'PASS ' : 'FAIL ') + msg); return cond; };
let QUIET = false;

// ---------- synthetic data ----------
const SYN = Date.UTC(2026, 4, 4, 6);  // 2026-05-04 00:00 at UTC-6
const DAY = 86400;
function series(fn, from, to, step) { const out = []; for (let t = from; t < to; t += step || 1) { const y = fn(t); if (y != null) out.push({ ep: SYN + Math.round(t * 1000), y }); } return out; }
const hm = (h, m) => h * 3600 + (m || 0) * 60;
function runDetector(D, pts, beats, T) {
  const hr = D.secondsFromPoints(pts, SYN, DAY);
  const junk = D.beatJunk(beats || [], SYN, DAY);
  const st = D.detectStretches(hr, junk, T || 100);
  const r = D.detectRises(hr, junk);
  return { st, rises: r.rises, blips: r.blips, hr };
}
// The G8 stream: one 300 ms beat then four 750 ms beats at HR byte 121, over [from, to) seconds.
function g8Beats(from, to, hrByte) {
  const ep = [], hr = [], rr = [];
  const cyc = [300, 750, 750, 750, 750];
  let tb = from * 1000, k = 0;
  for (let s = from; s < to; s++) {
    const cell = [];
    while (tb < (s + 1) * 1000) { const v = cyc[k++ % 5]; cell.push(v); tb += v; }
    ep.push(SYN + s * 1000); hr.push(hrByte); rr.push(cell.join(';'));
  }
  return { ep: Float64Array.from(ep), hr: Uint16Array.from(hr), rr };
}

// ---------- node goldens (cut block) ----------
const NODE_GOLDENS = {
  // S62 (a moment began 2 min after a reconnect, the strap's high first readings): 3 min after a gap of 60 s or more are left out,
  // and those minutes never split a stretch the gap alone would not split.
  G22: (D) => { const a = hm(12), f = (t) => t >= a && t < a + 300 ? null : t >= a + 300 && t < a + 300 + 720 ? 125 : 70;
    const hr = D.secondsFromPoints(series(f, hm(10), hm(14)), SYN, DAY), junk = D.beatJunk([], SYN, DAY), st = D.s61Settle(hr);
    const raw = D.detectStretches(hr, junk, 100), set = D.detectStretches(st, junk, 100, st.skip);
    return ok(raw.length === 1 && set.length === 0, `G22 12 min at 125 right after a 5 min gap: ${raw.length} unsettled, ${set.length} settled (want 1, 0)`); },
  G23: (D) => { const a = hm(12), f = (t) => t >= a + 1800 && t < a + 1800 + 480 ? null : t >= a && t < a + 3600 ? 110 : 70;
    const hr = D.secondsFromPoints(series(f, hm(10), hm(14)), SYN, DAY), junk = D.beatJunk([], SYN, DAY), st = D.s61Settle(hr);
    const set = D.detectStretches(st, junk, 100, st.skip);
    return ok(set.length === 1, `G23 an hour at 110 with an 8 min gap stays one stretch when settled: ${set.length} (want 1)`); },
  G1: (D) => { const r = runDetector(D, series(() => 70, 0, DAY)); return ok(r.st.length === 0 && r.rises.length === 0 && r.blips === 0, `G1 flat 70: ${r.st.length} stretches, ${r.rises.length} rises, ${r.blips} blips (want 0, 0, 0)`); },
  G3: (D) => { const a = hm(10), r = runDetector(D, series((t) => t < a ? 80 : t < a + 1200 ? 80 + 35 * (t - a) / 1200 : t < a + 4800 ? 115 : 80, hm(8), hm(13))); return ok(r.st.length === 1 && r.rises.length === 0, `G3 slow ramp then hold: ${r.st.length} stretch, ${r.rises.length} rises (want 1, 0)`); },
  G4: (D) => { const a = hm(12), r = runDetector(D, series((t) => t < a ? 70 : t < a + 1200 ? 110 : t < a + 1560 ? 95 : t < a + 2760 ? 110 : 70, hm(10), hm(14))); return ok(r.st.length === 1, `G4 6 min at 95 between two 20 min runs merge: ${r.st.length} (want 1)`); },
  G5: (D) => { const a = hm(12), r = runDetector(D, series((t) => t < a ? 70 : t < a + 1200 ? 110 : t < a + 1560 ? 85 : t < a + 2760 ? 110 : 70, hm(10), hm(14))); return ok(r.st.length === 2, `G5 6 min at 85 keeps them apart: ${r.st.length} (want 2)`); },
  G6: (D) => { const a = hm(12), dips = [7, 15, 23].map((m) => a + m * 60); const r = runDetector(D, series((t) => t < a || t >= a + 1800 ? 70 : dips.some((d) => t >= d && t < d + 60) ? 95 : 110, hm(10), hm(14))); return ok(r.st.length === 1, `G6 three single minutes at 95 bridged: ${r.st.length} (want 1)`); },
  G7: (D) => { const a = hm(12); const r9 = runDetector(D, series((t) => t >= a && t < a + 540 ? 110 : 70, hm(10), hm(14))), r10 = runDetector(D, series((t) => t >= a && t < a + 600 ? 110 : 70, hm(10), hm(14))); return ok(r9.st.length === 0 && r10.st.length === 1, `G7 9 min / 10 min: ${r9.st.length} / ${r10.st.length} (want 0 / 1)`); },
  G7b: (D) => { const a = hm(12), r = runDetector(D, series((t) => t >= a && t < a + 540 ? 110 : t >= a + 540 && t < a + 720 ? 95 : 70, hm(10), hm(14))); return ok(r.st.length === 0, `G7b 9 min at 110 then 3 min at 95: ${r.st.length} (want 0)`); },
  G8: (D) => { const a = hm(19), r = runDetector(D, series((t) => t >= a && t < a + 3600 ? 121 : 70, hm(17), hm(21)), [g8OnlyIn(a, a + 3600)]); return ok(r.st.length === 0, `G8 an hour at HR byte 121 with junk beats: ${r.st.length} stretches (want 0)`); },
  G9: (D) => { const a = hm(19), r = runDetector(D, series((t) => t >= a && t < a + 3600 ? 121 : 70, hm(17), hm(21))); return ok(r.st.length === 1, `G9 the same hour without beats (v1): ${r.st.length} (want 1)`); },
  G10: (D) => { const a = hm(12), r = runDetector(D, series((t) => t >= a && t < a + 30 ? 105 : 75, hm(10), hm(14))); return ok(r.rises.length === 0 && r.blips === 1, `G10 +30 for 30 s: ${r.rises.length} rises, ${r.blips} blips (want 0, 1)`); },
  G11: (D) => { const a = hm(12), r = runDetector(D, series((t) => t < a ? 75 : t < a + 20 ? null : t < a + 1800 ? 115 : 75, hm(10), hm(14))); return ok(r.rises.length === 0 && r.blips === 0, `G11 +40 across a 20 s gap: ${r.rises.length} rises, ${r.blips} blips (want 0, 0)`); },
  G15: (D) => { const a = hm(12), r = runDetector(D, series((t) => t >= a && t < a + 1800 ? 110 : 70, hm(10), hm(14), 4.95)); return ok(r.st.length === 1, `G15 rows every 4.95 s: ${r.st.length} stretch (want 1)`); },
  G15b: (D) => {
    const hr = D.secondsFromPoints(series(() => 80, 100, 200, 9), SYN, DAY);
    let good = true;
    for (let s = 100; s < 190; s += 9) { let c = 0; for (let i = s; i < s + 9; i++) if (hr[i] === hr[i]) c++; if (c !== 6) good = false; }
    return ok(good, 'G15b readings 9 s apart: every gap 6 covered and 3 uncovered seconds');
  },
};
function g8OnlyIn(a, b) { return g8Beats(a, b, 121); }

// ---------- server and browser ----------
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png', '.woff2': 'font/woff2', '.csv': 'text/csv' };
let SERVED = REAL;
const oldCache = new Map();
function oldFile(rel) {
  if (!oldCache.has(rel)) { try { oldCache.set(rel, execFileSync('git', ['-C', ROOT, 'show', BASE_REF + ':' + rel], { maxBuffer: 64 << 20, stdio: ['ignore', 'pipe', 'ignore'] })); } catch (e) { oldCache.set(rel, null); } }
  return oldCache.get(rel);
}
const server = http.createServer((req, res) => {
  const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (rel.startsWith('/old/')) {
    const body = oldFile(rel.slice(5));
    if (!body) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(rel)] || 'application/octet-stream', 'Cache-Control': 'no-store' }); res.end(body); return;
  }
  if (rel === '/hrv_viewer.html') { res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' }); res.end(SERVED); return; }
  const file = path.join(ROOT, rel);
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  res.end(fs.readFileSync(file));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}`;
let browser = null;
async function getBrowser() {
  if (browser) return browser;
  const { chromium } = createRequire(path.join(UX, 'kit', 'package.json'))('playwright');
  try { browser = await chromium.launch(); } catch (e) { browser = await chromium.launch({ channel: 'chrome' }); }
  return browser;
}
async function newPage(width) {
  const b = await getBrowser();
  const ctx = await b.newContext({ viewport: { width: width || 1440, height: 900 }, timezoneId: 'America/Edmonton' });
  await ctx.route('**/*', (route) => {
    const u = route.request().url();
    if (u.startsWith(BASE) || u.startsWith('data:') || u.startsWith('blob:')) return route.continue();
    if (/chart\.umd(\.min)?\.js/.test(u)) return route.fulfill({ status: 200, contentType: 'text/javascript', body: fs.readFileSync(CHART) });
    return route.fulfill({ status: 204, body: '' });
  });
  const page = await ctx.newPage();
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(e.message));
  page.ctx = ctx;
  return page;
}
const viewerUrl = (old) => BASE + (old ? '/old' : '') + '/hrv_viewer.html';
// Seeds segment texts into the Drive cache, then opens hash from a fresh document.
async function seeded(files, hash, o = {}) {
  const page = await newPage(o.width);
  await page.goto(viewerUrl(o.old) + '#/month', { waitUntil: 'networkidle' });
  await page.evaluate(async (files) => {
    const db = await new Promise((res, rej) => { const q = indexedDB.open('hr_monitor_kv', 2);
      q.onupgradeneeded = () => { for (const s of ['kv', 'drive-cache']) if (!q.result.objectStoreNames.contains(s)) q.result.createObjectStore(s); };
      q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
    await new Promise((res, rej) => { const tx = db.transaction('drive-cache', 'readwrite');
      for (const [k, v] of Object.entries(files)) tx.objectStore('drive-cache').put(v, k);
      tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
    db.close(); localStorage.removeItem('hrv_viewer_index');
  }, files);
  await page.goto('about:blank');
  await page.goto(viewerUrl(o.old) + hash, { waitUntil: 'networkidle' });
  return page;
}
async function demoPage(iso, o = {}) {
  const page = await newPage(o.width);
  await page.goto(viewerUrl(o.old) + '?demo=1#/day/' + iso, { waitUntil: 'networkidle' });
  return page;
}
const chartReady = (page) => page.waitForFunction(() => { const c = document.querySelector('#session-chart'); const ch = c && window.Chart && Chart.getChart(c); return !!(ch && ch.data.datasets.some((d) => d.data && d.data.length > 20)); }, null, { timeout: 60000 });
const momentsReady = (page) => page.waitForSelector('#insight-text [data-key="moments"]', { state: 'attached', timeout: 15000 }).then(() => true, () => false);

// ---------- synthetic v2 segments (real row shape) ----------
const pad = (n, w) => String(n).padStart(w || 2, '0');
function v2Files(iid, sessions) {
  const all = [];
  for (const S of sessions) {
    all.push({ sid: S.sid, ep: S.sid, line: (b) => `g,${S.sid - b},${S.sid},start` });
    for (const r of S.rows) all.push({ sid: S.sid, ep: r.ep, line: (b) => `${r.k},${r.ep - b},${r.f.join(',')}` });
    const end = Math.max(...S.rows.map((r) => r.ep)) + 50;
    all.push({ sid: S.sid, ep: end, line: (b) => `g,${end - b},${S.sid},stop`, stop: true });
  }
  all.sort((a, b) => a.ep - b.ep);
  const hours = new Map();
  for (const r of all) { const h = Math.floor(r.ep / 3600000); if (!hours.has(h)) hours.set(h, []); hours.get(h).push(r); }
  const files = {};
  for (const [h, list] of hours) {
    const base = h * 3600000, d = new Date(base);
    const name = `hrm_${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}Z_${iid}.csv`;
    const lines = ['#hrm,v=2,base=' + base + ',tz=-360,app=1.0,dev=SYN 0000001,flavour=personal'];
    const conts = new Set();
    for (const S of sessions) { const end = Math.max(...S.rows.map((r) => r.ep)) + 50; if (S.sid < base && end >= base) conts.add(S.sid); }
    for (const sid of conts) lines.push(`g,0,${sid},cont`);
    for (const r of list) lines.push(r.line(base));
    files[name] = lines.join('\n') + '\n';
  }
  return files;
}
const hRow = (ep, hr, rr) => ({ k: 'h', ep, f: [String(hr), '40.00', rr != null ? rr : String(Math.round(60000 / hr))] });
function hRows(from, to, hrAt, rrAt) { const out = []; for (let ep = from; ep < to; ep += 1000) out.push(hRow(ep, hrAt(ep), rrAt ? rrAt(ep) : null)); return out; }
const L = (iso, h, m, s) => Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10), h + 6, m || 0, s || 0);

// G14a: one session; the start stamp at sid + 50 ms, first h at sid + 1.5 s, a standing press at 30 min.
function g14a() {
  const sid = L('2026-05-04', 10, 0);
  const rows = [{ k: 'p', ep: sid + 50, f: ['sitting', 'btn'] }, ...hRows(sid + 1500, sid + 3600000, () => 74), { k: 'p', ep: sid + 30 * 60000, f: ['standing', 'btn'] }];
  return v2Files('syna14', [{ sid, rows }]);
}
// G14b: session A ends sitting; B 30 s later with a standing stamp at sid + 50 ms and its first h at sid + 21 s.
function g14b() {
  const a = L('2026-05-04', 10, 0), aEnd = a + 40 * 60000, b = aEnd + 30000;
  return v2Files('synb14', [
    { sid: a, rows: [{ k: 'p', ep: a + 50, f: ['sitting', 'btn'] }, ...hRows(a + 1500, aEnd, () => 74)] },
    { sid: b, rows: [{ k: 'p', ep: b + 50, f: ['standing', 'btn'] }, ...hRows(b + 21000, b + 40 * 60000, () => 76)] },
  ]);
}
// G17's day (2026-05-05): 70, a 60 min stretch at 110 from 14:00 with a symptom mark at 14:15, 20 min of strap junk at 03:00.
// One 1 Hz v2 session from 06:00 to 14:00 on iso with HR from hrAt(seconds of day).
function synDay(iso, iid, hrAt) {
  const sid = L(iso, 6, 0), e0 = L(iso, 0);
  const rows = hRows(sid + 1500, L(iso, 14, 0), (ep) => hrAt((ep - e0) / 1000));
  rows.push({ k: 'p', ep: sid + 40, f: ['sitting', 'btn'] });
  return v2Files(iid, [{ sid, rows }]);
}
// G20 (review M1): two sudden rises joined to one stretch: 70, 125 at 10:00, 8 min at 95, then 126 to 11:00.
const g20 = () => synDay('2026-05-06', 'syn020', (s) => s < hm(10) ? 70 : s < hm(10, 20) ? 125 : s < hm(10, 28) ? 95 : s < hm(11) ? 126 : 70);
// G21 (review S1): peak 130 at 10:05, 2 min at 95 from 10:30 (bridged), stretch to 11:10.
const g21 = () => synDay('2026-05-07', 'syn021', (s) => s < hm(10) ? 70 : s >= hm(10, 5) && s < hm(10, 6) ? 130 : s >= hm(10, 30) && s < hm(10, 32) ? 95 : s < hm(11, 10) ? 110 : 70);
function g17() {
  const iso = '2026-05-05', sid = L(iso, 2, 0), end = L(iso, 20, 0);
  const s0 = L(iso, 14, 0), s1 = L(iso, 15, 0), j0 = L(iso, 3, 0), j1 = L(iso, 3, 20);
  let k = 0;
  const hrAt = (ep) => ep >= s0 && ep < s1 ? 110 + ((k++ % 5) - 2) : 70 + ((k++ % 3) - 1);
  const rows = hRows(sid + 1500, end, hrAt, (ep) => ep >= j0 && ep < j1 ? '500' : null);
  rows.push({ k: 'p', ep: sid + 40, f: ['sitting', 'btn'] });
  rows.push({ k: 's', ep: L(iso, 14, 15), f: ['dizzy'] });
  return v2Files('syn017', [{ sid, rows }]);
}

// ---------- in-page readers ----------
async function dayRows(page) {
  return page.evaluate(() => [...document.querySelectorAll('#insight-text [data-key="moments"] li')].map((li) => ({ s: li.dataset.s, e: li.dataset.e, day: li.dataset.day, kind: li.dataset.kind, text: (li.firstElementChild || li).textContent.trim() })));
}
async function modelOf(page, iso, rec) {
  return page.evaluate(async ({ iso, rec }) => {
    const d = rec ? await window.__aortiReport.recordingModel(rec) : await window.__aortiReport.model(iso);
    if (!d) return null;
    return { blips: d.parts.blips, T: d.parts.T, ticks: d.ticks, taps: d.taps, moments: d.moments.map((x) => ({ kind: x.kind, auto: !!x.auto, s: String(x.ms != null ? x.ms : x.t), e: String(x.me != null ? x.me : x.t), hrText: x.hrText, zoom: x.zoom, when: x.when, e2: x.e, back: x.back })) };
  }, { iso, rec });
}
const nums = (s) => (String(s).replace(/\d{1,2}:\d{2}( [AP]M)?/g, ' ').match(/\d+/g) || []).join(',');

// ---------- parts ----------
async function partGolden(src, only) {
  const want = (g) => !only || only.includes(g);
  const D = cut(src);
  let good = true;
  for (const [g, f] of Object.entries(NODE_GOLDENS)) if (want(g)) good = f(D) && good;
  SERVED = src;
  const synthIds = ['G2', 'G5b', 'G12', 'G13', 'G16', 'G19'];
  if (synthIds.some(want)) {
    const page = await newPage();
    await page.goto(viewerUrl() + '#/month', { waitUntil: 'networkidle' });
    await page.waitForFunction(() => !!window.__s61Test, null, { timeout: 20000 });
    const synth = (pts, o) => page.evaluate(({ pts, o }) => { globalThis.__s61Routed = null; return window.__s61Test.synth(pts, o); }, { pts, o: { ep0: SYN, n: 1440, ...o } });
    const step = (t0, t1, hi, lo) => series((t) => t >= t0 && t < t1 ? hi : lo, hm(t0 / 3600 > 2 ? Math.floor(t0 / 3600) - 2 : 0), Math.min(DAY, hm(Math.floor(t1 / 3600) + 2)));
    if (want('G2')) {
      const r = await synth(step(hm(19), hm(19, 30), 110, 70));
      const m = r.moments;
      good = ok(m.length === 1 && m[0].kind === 'Above 100 · Sudden rise' && m[0].when === '19:00 to 19:30' && m[0].avg === 110 && m[0].window === '18:50 to 19:40',
        `G2 step to 110 for 30 min: ${m.length} moment ${m.map((x) => `"${x.kind}" ${x.when} average ${x.avg} window ${x.window}`).join('; ')} (want 1 "Above 100 · Sudden rise" 19:00 to 19:30 average 110 window 18:50 to 19:40)`) && good;
    }
    if (want('G5b')) {
      const r = await synth(series((t) => t >= hm(18, 55) && t < hm(19, 25) ? 106 : t >= hm(19, 25) && t < hm(19, 36) ? 85 : t >= hm(19, 36) && t < hm(22, 15) ? 108 : 70, hm(16), hm(24)));
      const ab = r.moments.filter((x) => x.kind.startsWith('Above'));
      good = ok(r.stretches === 2 && ab.length === 2 && ab[0].avg === 106 && ab[1].avg === 108, `G5b two stretches 11 min apart:${r.stretches} stretches, ${ab.length} Above moments, averages ${ab.map((x) => x.avg).join(', ')} (want 2, 2, 106 and 108)`) && good;
    }
    if (want('G12')) {
      const lo = await synth(step(hm(12), hm(12, 30), 105, 70), { line: 110 }), hi = await synth(step(hm(12), hm(12, 30), 115, 70), { line: 110 });
      const k = hi.moments.filter((x) => x.kind.startsWith('Above')).map((x) => x.kind);
      good = ok(lo.stretches === 0 && hi.stretches === 1 && k[0] && k[0].startsWith('Above 110'), `G12 line 110: 30 min at 105 / at 115: ${lo.stretches} / ${hi.stretches}, kind "${k[0]}" (want 0 / 1, "Above 110")`) && good;
    }
    if (want('G13')) {
      const r = await synth(series((t) => t >= hm(23, 40) ? 110 : 70, hm(21), DAY));
      const m = r.moments.filter((x) => x.kind.startsWith('Above'));
      good = ok(r.stretches === 1 && m[0] && m[0].when === '23:40 to 24:00', `G13 23:40 to 24:00 at 110: ${r.stretches} stretch, "${m[0] && m[0].when}" (want 1, "23:40 to 24:00")`) && good;
    }
    if (want('G16')) {
      const r = await synth(series((t) => t < hm(11, 45) ? 70 : t < hm(12) ? 97 : t < hm(12, 30) ? 110 : 70, hm(9), hm(14)));
      const m = r.moments;
      good = ok(m.length === 1 && m[0].kind === 'Above 100 · Sudden rise' && m[0].window === '11:35 to 12:40', `G16 rise 15 min before a stretch: ${m.length} moment, ${m.map((x) => `"${x.kind}" window ${x.window}`).join('; ')} (want 1 joined, window 11:35 to 12:40)`) && good;
    }
    if (want('G19')) {
      const pts = series((t) => (t >= hm(19) && t < hm(19, 30)) ? 110 : (t >= hm(12) && t < hm(12) + 30) ? 105 : 75, hm(9), hm(22));
      const r = await synth(pts);
      const z = r.moments.filter((x) => x.zoom).length;
      good = ok(r.moments.length === 1 && z === 1 && r.blips === 1, `G19 production router: ${r.moments.length} moment, ${z} zoomed, ${r.blips} blip (want 1, 1, 1)`) && good;
      await page.ctx.close();
      SERVED = src.replace("function momentRoute(m) { return 'moment'; }", "function momentRoute(m) { if (m.auto && !globalThis.__s61Routed) globalThis.__s61Routed = m; return m === globalThis.__s61Routed ? 'activity' : 'moment'; }");
      const p2 = await newPage();
      await p2.goto(viewerUrl() + '#/month', { waitUntil: 'networkidle' });
      await p2.waitForFunction(() => !!window.__s61Test, null, { timeout: 20000 });
      const r2 = await p2.evaluate(({ pts, o }) => { globalThis.__s61Routed = null; return window.__s61Test.synth(pts, o); }, { pts, o: { ep0: SYN, n: 1440 } });
      const z2 = r2.moments.filter((x) => x.zoom).length;
      good = ok(SERVED !== src && r2.moments.length === 0 && z2 === z - 1, `G19 router stubbed to "activity" for the first auto moment: ${r2.moments.length} listed, ${z2} zoomed (want 0, ${z - 1})`) && good;
      await p2.ctx.close();
      SERVED = src;
    } else await page.ctx.close();
  }
  if (want('G14a')) {
    const page = await seeded(g14a(), '#/day/2026-05-04'); await chartReady(page).catch(() => {});
    const m = await modelOf(page, '2026-05-04');
    const st = m ? m.taps.filter((t) => t.kind === 'Standing') : [];
    good = ok(st.length === 1 && Math.abs(st[0].m - 630) <= 1 && st[0].from === 'sitting', `G14a a press at 30 min after the stamp: ${st.length} Standing tap ${st.map((t) => 'at ' + t.m + ' from ' + t.from).join(', ')} (want 1 at 630 from sitting)`) && good;
    await page.ctx.close();
  }
  if (want('G14b')) {
    const page = await seeded(g14b(), '#/day/2026-05-04'); await chartReady(page).catch(() => {});
    const m = await modelOf(page, '2026-05-04');
    const n = m ? m.taps.filter((t) => t.kind === 'Standing').length : -1;
    good = ok(n === 0, `G14b a standing stamp 30 s after a sitting session: ${n} Standing taps (want 0)`) && good;
    await page.ctx.close();
  }
  if (want('G14c')) {
    const page = await seeded(g14b(), '#/day/2026-05-04'); await chartReady(page).catch(() => {});
    const stripped = await page.evaluate(async () => {
      const db = await new Promise((res) => { const q = indexedDB.open('hrv_viewer_segidx', 1); q.onsuccess = () => res(q.result); });
      const keys = await new Promise((res) => { const r = db.transaction('seg-index').objectStore('seg-index').getAllKeys(); r.onsuccess = () => res(r.result); });
      let n = 0;
      for (const k of keys.filter((k) => String(k).startsWith('sess:'))) {
        const v = await new Promise((res) => { const r = db.transaction('seg-index').objectStore('seg-index').get(k); r.onsuccess = () => res(r.result); });
        if (v && v.summary && v.summary.postureSpans) { v.summary.postureSpans.forEach((sp) => { delete sp.stamp; }); n++; }
        await new Promise((res) => { const tx = db.transaction('seg-index', 'readwrite'); tx.objectStore('seg-index').put(v, k); tx.oncomplete = res; });
      }
      db.close();
      return n;
    });
    const load = async () => {
      await page.goto('about:blank');
      await page.goto(viewerUrl() + '#/day/2026-05-04', { waitUntil: 'networkidle' });
      await chartReady(page).catch(() => {});
      const m = await modelOf(page, '2026-05-04');
      return { taps: m ? m.taps.filter((t) => t.kind === 'Standing').length : -1, re: await page.evaluate(() => globalThis.__s61.v2Resummarized.slice()) };
    };
    const a = await load(), b = await load();
    good = ok(stripped === 2 && a.re.length === 2 && a.taps === 0, `G14c first load after the stamp flag was stripped from ${stripped} cached summaries: ${a.re.length} summarised again, ${a.taps} Standing taps (want 2, 0)`) && good;
    good = ok(b.re.length === 0 && b.taps === 0, `G14c second load: ${b.re.length} summarised again (cache hits), ${b.taps} Standing taps (want 0, 0)`) && good;
    await page.ctx.close();
  }
  if (want('G17')) good = await g17Compare(src) && good;
  if (want('G18')) good = await g18(src) && good;
  if (want('G20')) {
    const page = await seeded(g20(), '#/day/2026-05-06'); await chartReady(page).catch(() => {});
    await page.evaluate(() => window.__aortiReport.prepare('2026-05-06'));
    const r = await page.evaluate(() => { const mo = [...document.querySelectorAll('#report-print .moment')].find((m) => /Sudden rise/.test(m.querySelector('.mhead .kind').textContent) && /^Above/.test(m.querySelector('.mhead .kind').textContent)); return mo ? mo.querySelector('.timeline').textContent : null; });
    const rows = r ? (r.match(/Sudden rise \d+ to \d+, held \d+ min/g) || []).length : 0;
    good = ok(r != null && rows === 2 && !/undefined|NaN|null/.test(r), `G20 two rises joined to one stretch: ${rows} "Sudden rise N to M, held N min" timeline rows, ${r && /undefined|NaN|null/.test(r) ? 'a bad value' : 'no undefined, NaN or null'} (want 2, none)`) && good;
    await page.ctx.close();
  }
  if (want('G21')) {
    const page = await seeded(g21(), '#/day/2026-05-07'); await chartReady(page).catch(() => {});
    const m = await modelOf(page, '2026-05-07');
    const a = m ? m.moments.find((x) => /^Above/.test(x.kind)) : null;
    good = ok(!!a && a.back != null && a.back >= a.e2, `G21 a bridged dip after the peak: "Under 100" at minute ${a && a.back}, stretch ends at ${a && a.e2} (want at or after the end)`) && good;
    await page.ctx.close();
  }
  return good;
}

// Report pieces that S61 must leave as they were: summary, Standing cells (but Moment), Symptom rows (but No., Page), Symptom pages.
const REPORT_PIECES = () => {
  const host = document.getElementById('report-print');
  const txt = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : '');
  const tables = [...host.querySelectorAll('#rpg1 table.t')];
  const stand = tables.find((t) => !t.classList.contains('idx') && !t.classList.contains('sum'));
  const idx = host.querySelector('#rpg1 table.idx');
  return {
    // Label: value per figure, from the S62 row of figures or the older one-column table; Above your line left the summary in S62.
    summary: (() => { const t = host.querySelector('#rpg1 table.sum'); if (!t) return '';
      const pairs = t.classList.contains('readouts') ? [...t.querySelectorAll('th')].map((th, i) => [txt(th), txt(t.querySelectorAll('td')[i])]) : [...t.querySelectorAll('tbody tr')].map((tr) => [txt(tr.children[0]), txt(tr.children[1])]);
      return pairs.filter(([k]) => !/^Above your line/.test(k)).map((p) => p.join(': ')).join(' | '); })(),
    standing: stand ? [...stand.querySelectorAll('tbody tr')].map((tr) => [...tr.children].slice(0, -1).map(txt).join(' | ')) : [],
    symptomRows: idx ? [...idx.querySelectorAll('tbody tr')].filter((tr) => /Symptom/.test(txt(tr.children[2]))).map((tr) => [...tr.children].slice(1, -1).map(txt).join(' | ')) : [],
    symptomPages: [...host.querySelectorAll('.moment')].filter((m) => /Symptom/.test(txt(m.querySelector('.mhead .kind')))).map((m) => ({
      sub: txt(m.querySelector('.msub')), timeline: txt(m.querySelector('.timeline')), readouts: txt(m.querySelector('.readouts')),
      callouts: [...m.querySelectorAll('svg text.callout, svg text.callout-dim')].map(txt).join(' | ') })),
  };
};
async function reportPieces(page, iso) {
  await page.evaluate((iso) => window.__aortiReport.prepare(iso), iso);
  return page.evaluate(REPORT_PIECES);
}
async function g17Compare(src) {
  SERVED = src;
  const files = g17();
  const a = await seeded(files, '#/day/2026-05-05'), b = await seeded(files, '#/day/2026-05-05', { old: true });
  await chartReady(a).catch(() => {}); await chartReady(b).catch(() => {});
  const pa = await reportPieces(a, '2026-05-05'), pb = await reportPieces(b, '2026-05-05');
  const m = await modelOf(a, '2026-05-05');
  const above = m ? m.moments.filter((x) => x.kind.startsWith('Above')).length : 0;
  const same = JSON.stringify([pa.symptomRows, pa.symptomPages]) === JSON.stringify([pb.symptomRows, pb.symptomPages]);
  const r = ok(same && pa.symptomRows.length === 1 && pa.symptomPages.length === 1 && above === 1, `G17 symptom mark inside a stretch: Symptom row and page body equal ${BASE_REF} (${pa.symptomRows.length} row, ${pa.symptomPages.length} page), ${above} separate Above moment${same ? '' : '; differs: ' + JSON.stringify(pa.symptomPages) + ' vs ' + JSON.stringify(pb.symptomPages)}`);
  await a.ctx.close(); await b.ctx.close();
  return r;
}
// Three surfaces of one auto moment: index HR cell, moment page sub line, Day view row.
async function surfaces(page, iso) {
  await momentsReady(page);
  const day = await page.evaluate(() => { const li = [...document.querySelectorAll('#insight-text [data-key="moments"] li[data-s]')].find((l) => /^Above/.test(l.dataset.kind)); return li ? li.firstElementChild.textContent.trim() : null; });
  await page.evaluate((iso) => window.__aortiReport.prepare(iso), iso);
  return page.evaluate((day) => {
    const tr = [...document.querySelectorAll('#rpg1 table.idx tbody tr')].find((r) => /^Above/.test(r.children[2].textContent.trim()));
    const mo = [...document.querySelectorAll('#report-print .moment')].find((m) => /^Above/.test(m.querySelector('.mhead .kind').textContent));
    const sub = mo ? mo.querySelector('.msub').textContent.trim().replace(/ · Window .*$/, '') : null;
    return { index: tr ? tr.children[3].textContent.trim() : null, cells: tr ? tr.children.length : 0, head: document.querySelectorAll('#rpg1 table.idx thead th').length, sub, day };
  }, day);
}
async function g18(src) {
  SERVED = src;
  const files = g17();
  const p = await seeded(files, '#/day/2026-05-05'); await chartReady(p).catch(() => {});
  const s = await surfaces(p, '2026-05-05');
  await p.ctx.close();
  const endOk = (x) => x != null && /[\p{L}\p{N}]$/u.test(x);
  let good = ok(endOk(s.index) && endOk(s.sub) && endOk(s.day) && s.cells === s.head, `G18 context null: index "${s.index}", sub "${s.sub}", Day row "${s.day}" end on a number or word, ${s.cells} of ${s.head} cells`);
  SERVED = src.replace("function momentContextText(m) { return m && m.context ? String(m.context.activity || '') : ''; }", "function momentContextText(m) { return 'still'; }");
  const q = await seeded(files, '#/day/2026-05-05'); await chartReady(q).catch(() => {});
  const t = await surfaces(q, '2026-05-05');
  await q.ctx.close();
  SERVED = src;
  good = ok([t.index, t.sub, t.day].every((x) => x && /still/.test(x)), `G18 context renderer stubbed to "still": index "${t.index}", sub "${t.sub}", Day row "${t.day}" all carry it`) && good;
  return good;
}

// ---------- demo ----------
function partDemo(src) {
  const D = cut(src);
  const dir = path.join(ROOT, 'demo');
  const pts = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.csv')) continue;
    const lines = fs.readFileSync(path.join(dir, f), 'utf8').split(/\r?\n/), h = lines[0].split(',');
    const iE = h.indexOf('epoch_ms'), iH = h.indexOf('hr_bpm');
    for (let i = 1; i < lines.length; i++) { const c = lines[i].split(','); const y = +c[iH], ep = +c[iE]; if (y > 0 && ep > 0) pts.push({ ep, y }); }
  }
  pts.sort((a, b) => a.ep - b.ep);
  let good = true;
  for (const iso of ['2026-04-24', '2026-04-26']) {
    const ep0 = L(iso, 0), list = pts.filter((p) => p.ep >= ep0 - 10000 && p.ep < ep0 + DAY * 1000);
    const hr = D.secondsFromPoints(list, ep0, DAY), junk = new Uint8Array(DAY);
    const st = D.detectStretches(hr, junk, 100), r = D.detectRises(hr, junk);
    good = ok(st.length >= 1 && r.rises.length >= 1, `demo ${iso}: ${st.length} stretches, ${r.rises.length} rises (want at least 1 and 1)`) && good;
  }
  return good;
}

// ---------- replay ----------
let REPLAY_DATA = null;
function replayLoad() {
  if (REPLAY_DATA) return REPLAY_DATA;
  need(MANIFEST);
  const man = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
  const lines = [];
  for (const f of man.files) {
    const p = path.join(HOME, f.from);
    if (!fs.existsSync(p)) { console.log('data changed, re-freeze: missing ' + p); process.exit(2); }
    const buf = fs.readFileSync(p);
    const sha = crypto.createHash('sha1').update(buf).digest('hex');
    if (buf.length !== f.size || sha !== f.sha1) { console.log('data changed, re-freeze: ' + f.name + ' differs'); process.exit(2); }
    lines.push(f.name + ':' + sha);
  }
  const set = crypto.createHash('sha1').update(lines.join('\n')).digest('hex');
  if (set !== man.setSha1) { console.log('data changed, re-freeze: set hash ' + set); process.exit(2); }
  const sa = REAL.indexOf('  const SEG_NAME_RE'), sb = REAL.indexOf('  // Compact span view of one segment');
  const parseSegmentV2 = new Function(REAL.slice(sa, sb) + ';return parseSegmentV2;')();
  const TZ = man.tz * 3600e3;
  const sec = new Map(), beats = [], posture = [];
  const v2 = man.files.filter((f) => f.kind === 'v2'), v1 = man.files.filter((f) => f.kind === 'v1').sort((a, b) => b.size - a.size);
  const sids = new Map();
  for (const f of v2) {
    const seg = parseSegmentV2(fs.readFileSync(path.join(HOME, f.from), 'utf8'), f.name);
    if (!seg) continue;
    let sid = null;
    for (const r of seg.rows) {
      if (r.k === 'g') { sid = +r.f[0]; continue; }
      if (r.k === 'p') { posture.push({ ep: r.ep, posture: r.f[0], sid, first: !sids.has(sid) }); sids.set(sid, true); continue; }
      if (r.k !== 'h') continue;
      beats.push({ ep: r.ep, hr: +r.f[0] || 0, rr: r.f[2] });
      const hr = +r.f[0];
      if (!(hr > 0)) continue;
      const s = Math.round(r.ep / 1000);
      if (!sec.has(s)) sec.set(s, { hr, v: 2, rm: +r.f[1] || null });
    }
  }
  for (const f of v1) {
    const lines2 = fs.readFileSync(path.join(HOME, f.from), 'utf8').split(/\r?\n/);
    const hdr = lines2[0].split(',').map((s) => s.trim());
    const iT = hdr.indexOf('time_min'), iE = hdr.indexOf('epoch_ms'), iH = hdr.indexOf('hr_bpm'), iR = hdr.indexOf('rmssd_ms');
    if (iT < 0 || iH < 0) continue;
    const m = f.name.match(/^hrv_session_(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})(\.\d{3})?\.csv$/);
    const start = !m ? 0 : m[5] ? Date.parse(`${m[1]}T${m[2]}:${m[3]}:${m[4]}${m[5]}Z`) - TZ : Date.parse(`${m[1]}T${m[2]}:${m[3]}:${m[4]}Z`);
    for (let i = 1; i < lines2.length; i++) {
      const c = lines2[i].split(',');
      if (c.length < hdr.length - 1) continue;
      const tm = parseFloat(c[iT]);
      let ep = iE >= 0 && c[iE] !== '' ? parseFloat(c[iE]) : NaN;
      if (!isFinite(ep)) { if (!start || !isFinite(tm)) continue; ep = start + tm * 60000; }
      const hr = c[iH] !== '' ? parseFloat(c[iH]) : NaN;
      if (!(hr > 0)) continue;
      const s = Math.round(ep / 1000);
      if (sec.has(s)) continue;
      sec.set(s, { hr, v: 1, rm: iR >= 0 && c[iR] !== '' ? parseFloat(c[iR]) : null });
    }
  }
  const samples = [...sec.entries()].sort((a, b) => a[0] - b[0]);
  beats.sort((a, b) => a.ep - b.ep);
  posture.sort((a, b) => a.ep - b.ep);
  const dayOf = (ms) => new Date(ms + TZ).toISOString().slice(0, 10);
  const byDay = new Map();
  for (const [s, x] of samples) { const d = dayOf(s * 1000); if (!byDay.has(d)) byDay.set(d, []); byDay.get(d).push({ ep: s * 1000, y: x.hr, rm: x.rm }); }
  REPLAY_DATA = { man, TZ, byDay, beats, posture, dayOf };
  return REPLAY_DATA;
}
function partReplay(src) {
  const R = replayLoad();
  const D = cut(src);
  const t0 = Date.now();
  const days = [...R.byDay.keys()].sort();
  const res = [];
  let bi = 0;
  for (const iso of days) {
    const ep0 = Date.parse(iso + 'T00:00:00Z') - R.TZ, pts = R.byDay.get(iso);
    const hr = D.secondsFromPoints(pts, ep0, DAY);
    let cov = 0; for (let i = 0; i < DAY; i++) if (hr[i] === hr[i]) cov++;
    if (cov < 4 * 3600) continue;
    while (bi < R.beats.length && R.beats[bi].ep < ep0 - 120000) bi++;
    let bj = bi; while (bj < R.beats.length && R.beats[bj].ep < ep0 + DAY * 1000) bj++;
    const bs = R.beats.slice(bi, bj);
    const beats = [{ ep: Float64Array.from(bs.map((b) => b.ep)), hr: Uint16Array.from(bs.map((b) => b.hr)), rr: bs.map((b) => b.rr) }];
    const clock = (m) => { if (m >= 1440) return '24:00'; const t = new Date(ep0 + R.TZ + Math.round(m) * 60000); return pad(t.getUTCHours()) + ':' + pad(t.getUTCMinutes()); };
    const pointsXY = pts.map((p) => ({ x: (p.ep - ep0) / 60000, y: p.y, ep: p.ep }));
    const d = { n: 1440, dayStart: ep0, line: null, personal: false, taps: [], ticks: [], clock, summary: { hrDeltas: [] } };
    d.hr = D.rptBin(pointsXY, 1440);
    d.hrv = D.rptBin(pts.filter((p) => p.rm > 0).map((p) => ({ x: (p.ep - ep0) / 60000, y: p.rm })), 1440);
    const t = process.hrtime.bigint();
    const parts = D.detectDayMoments(d, { hr: pointsXY, beats });
    const ms = Number(process.hrtime.bigint() - t) / 1e6;
    d.parts = parts;
    // Standing taps from v2 posture rows by the shipped rule: the file's first row under 0.02 min is the stamp.
    const pr = R.posture.filter((p) => p.ep >= ep0 && p.ep < ep0 + DAY * 1000);
    let standing = 0;
    pr.forEach((p, i) => { const stamp = p.first && (p.ep - p.sid) / 60000 < 0.02; const prev = pr[i - 1]; if (!stamp && p.posture === 'standing' && prev && prev.posture !== 'standing') standing++; });
    const zoomed = parts.moments.filter((x) => x.zoom).length;
    res.push({ iso, cov, raw: pts.length, st: parts.stretches, rises: parts.rises, blips: parts.blips, moments: parts.moments, zoomed, pages: 1 + Math.ceil(zoomed / 2), joined: parts.moments.filter((x) => x.auto === 'above').reduce((n, x) => n + x.rises.length, 0), standing, ms, clock });
  }
  const sum = (f) => res.reduce((n, r) => n + f(r), 0), max = (f) => Math.max(0, ...res.map(f));
  if (!QUIET) for (const r of res) console.log(`${r.iso} ${(r.cov / 3600).toFixed(1)} h, ${(r.raw / r.cov).toFixed(2)} rows/s, ${r.st.length} stretches ${r.st.reduce((n, s) => n + s.len, 0)} min, rises ${['held', 'slow', 'short'].map((k) => k + ' ' + r.rises.filter((e) => e.kind === k).length).join(' ')}, joined ${r.joined}, blips ${r.blips}, zoomed ${r.zoomed}, pages ${r.pages}, Standing ${r.standing}${r.st.length ? ' :: ' + r.st.map((s) => r.clock(s.s) + ' ' + s.len + ' min').join('; ') : ''}`);
  const S = sum((r) => r.st.length), RI = sum((r) => r.rises.length), J = sum((r) => r.joined);
  const held = res.flatMap((r) => r.rises.filter((e) => e.kind === 'held').map((e) => ({ iso: r.iso, m: e.on / 60, clock: r.clock(e.on / 60) })));
  const pages = {}; res.forEach((r) => { pages[r.pages] = (pages[r.pages] || 0) + 1; });
  const ms = res.map((r) => r.ms).sort((a, b) => a - b), med = ms[ms.length >> 1];
  if (!QUIET) console.log(`totals: days ${res.length}, stretches ${S}, days with one ${res.filter((r) => r.st.length).length}, rises ${RI} (held ${held.length}, slow ${sum((r) => r.rises.filter((e) => e.kind === 'slow').length)}, short ${sum((r) => r.rises.filter((e) => e.kind === 'short').length)}), joined ${J}, blips ${sum((r) => r.blips)}, pages ${JSON.stringify(pages)}, detector median ${med.toFixed(1)} ms max ${ms[ms.length - 1].toFixed(1)} ms, replay ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  const at = (iso) => res.find((r) => r.iso === iso);
  let good = true;
  // Day-specific expectations live in the gitignored manifest (`expect`), so no recording detail ships in this file.
  const X = JSON.parse(fs.readFileSync(MANIFEST, 'utf8')).expect || {};
  if (!Object.keys(X).length) console.log('NOTE replay: manifest has no expect block; day-specific rows skipped');
  if (X.days != null) good = ok(res.length === X.days, `replay days of 4 h or more: ${res.length} (want ${X.days})`) && good;
  good = ok(S >= 112 && S <= 126, `replay stretches total ${S} (band 112 to 126)`) && good;
  good = ok(max((r) => r.st.length) <= 7, `replay stretches on any day at most 7: max ${max((r) => r.st.length)}`) && good;
  const ds = res.filter((r) => r.st.length).length;
  good = ok(ds >= 39 && ds <= 43, `replay days with a stretch ${ds} (band 39 to 43)`) && good;
  for (const iso of X.noStretchDays || []) good = ok(at(iso) && at(iso).st.length === 0, `replay junk day ${iso.slice(5)} stretches ${at(iso) ? at(iso).st.length : 'missing'} (want 0)`) && good;
  for (const L of X.longStretches || []) {
    const e = at(L.iso) && at(L.iso).st.find((s) => s.len >= L.minLen);
    good = ok(!!e && e.s >= L.startFrom && e.s <= L.startTo, `replay ${L.iso.slice(5)} long stretch of ${L.minLen} min or more in its start window: ${e ? at(L.iso).clock(e.s) + ' for ' + e.len + ' min' : 'none'}`) && good;
  }
  good = ok(RI >= 64 && RI <= 72, `replay sudden rises total ${RI} (band 64 to 72)`) && good;
  good = ok(max((r) => r.rises.length) <= 6, `replay rises on any day at most 6: max ${max((r) => r.rises.length)}`) && good;
  const wantHeld = X.heldRises || [];
  const missing = wantHeld.filter(([iso, m]) => !held.some((h) => h.iso === iso && Math.abs(h.m - m) <= 1));
  if (wantHeld.length) good = ok(!missing.length, `replay ${wantHeld.length} known held rises found within 1 min (held: ${held.length})${missing.length ? ' missing ' + missing.map((x) => x[0]).join(', ') : ''}`) && good;
  good = ok(J >= 20 && J <= 28, `replay joined rises ${J} (band 20 to 28)`) && good;
  good = ok(max((r) => r.blips) <= 25, `replay blips on any day at most 25: max ${max((r) => r.blips)}`) && good;
  good = ok(max((r) => r.zoomed) <= 6 && max((r) => r.pages) <= 4, `replay zoomed per day at most 6, pages at most 4: max ${max((r) => r.zoomed)}, ${max((r) => r.pages)}`) && good;
  good = ok(sum((r) => r.standing) === 0, `replay Standing taps from v2 rows: ${sum((r) => r.standing)} (want 0)`) && good;
  const empty = res.filter((r) => (r.st.length || r.rises.length) && !r.moments.some((x) => x.auto && x.zoom));
  good = ok(!empty.length, `replay days with a detector moment but no zoomed auto moment: ${empty.length}${empty.length ? ' ' + empty.map((r) => r.iso).join(', ') : ''}`) && good;
  good = ok(med < 80, `replay detector plus beatJunk per day, median ${med.toFixed(1)} ms (under 80, node)`) && good;
  return good;
}

// ---------- real days for agree, same, copy, nav ----------
function realSegments(isos) {
  need(S54);
  const dir = path.join(S54, 'segments');
  need(dir);
  const out = {};
  for (const n of fs.readdirSync(dir)) {
    const m = /^hrm_(\d{4})(\d{2})(\d{2})T(\d{2})Z_[a-z0-9]{6}\.csv$/.exec(n);
    if (!m) continue;
    const ep = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4]);
    if (isos.some((iso) => ep >= L(iso, 0) - 6 * 3600e3 && ep < L(iso, 0) + 30 * 3600e3)) out[n] = fs.readFileSync(path.join(dir, n), 'utf8').replace(/\r\n/g, '\n');
  }
  return out;
}
async function openCase(c) {
  if (c.demo) { const p = await demoPage(c.iso); await chartReady(p).catch(() => {}); return p; }
  const p = await seeded(c.files(), c.rec ? '#/month' : '#/day/' + c.iso);
  if (c.rec) {
    await p.waitForFunction(() => window.__hrmV2 && window.__hrmV2.keys().length > 0, null, { timeout: 30000 });
    const key = await p.evaluate(async (iso) => {
      for (const k of window.__hrmV2.keys()) { const d = await window.__aortiReport.recordingModel(k); if (d && d.moments.some((x) => x.auto) && new Date(d.dayStart).toISOString().slice(0, 10) <= iso) return k; }
      return null;
    }, c.iso);
    c.key = key;
    if (key) await p.evaluate((k) => { location.hash = '#/session/' + encodeURIComponent(k); }, key);
  }
  await chartReady(p).catch(() => {});
  return p;
}
const AGREE_CASES = () => [
  { id: 'demo-04-24', iso: '2026-04-24', demo: true },
  { id: 'demo-04-26', iso: '2026-04-26', demo: true },
  { id: '10-13', iso: '2026-10-13', files: () => realSegments(['2026-10-13']) },
  { id: '10-14', iso: '2026-10-14', files: () => realSegments(['2026-10-14']) },
  { id: 'recording', iso: '2026-10-14', rec: true, files: () => realSegments(['2026-10-14']) },
];
async function partAgree(src, only) {
  SERVED = src;
  let good = ok(!/detectNoteworthyMoments/.test(src), 'agree: detectNoteworthyMoments absent from the served viewer');
  for (const c of AGREE_CASES().filter((c) => !only || only.includes(c.id))) {
    const p = await openCase(c);
    const shown = await momentsReady(p);
    const rowsD = (await dayRows(p)).filter((r) => r.s != null);
    const blipLine = await p.evaluate(() => /Short rises under a minute/.test((document.querySelector('#insight-text [data-key="moments"]') || {}).textContent || ''));
    const m = await modelOf(p, c.iso, c.rec ? c.key : null);
    const mm = m ? m.moments : [];
    const same = rowsD.length === mm.length && rowsD.every((r, i) => r.kind === mm[i].kind && r.s === mm[i].s && r.e === mm[i].e && nums(mm[i].hrText).split(',').every((n) => nums(r.text).split(',').includes(n)));
    good = ok(shown && same, `agree ${c.id}${c.key ? ' ' + c.key : ''}: Day view ${rowsD.length} rows, report ${mm.length} moments, kinds, minutes and HR numbers ${same ? 'equal' : 'differ: ' + JSON.stringify(rowsD.slice(0, 3)) + ' vs ' + JSON.stringify(mm.slice(0, 3))}`) && good;
    good = ok(mm.some((x) => x.auto), `agree ${c.id}: at least one auto moment (${mm.filter((x) => x.auto).length})`) && good;
    good = ok(!mm.some((x) => x.kind === 'Rise' || x.kind === 'Above line'), `agree ${c.id}: no Rise or Above line kind`) && good;
    if (!c.rec) {
      await p.evaluate((iso) => window.__aortiReport.prepare(iso), c.iso);
      const inPdf = await p.evaluate(() => /Short rises under a minute/.test(document.getElementById('report-print').textContent));
      good = ok(!inPdf && (m.blips ? blipLine : !blipLine), `agree ${c.id}: the short-rise line is on the Day view only (${m.blips} short rises, Day view ${blipLine ? 'shows' : 'hides'} it, PDF ${inPdf ? 'shows' : 'hides'} it)`) && good;
    }
    good = ok(!p.errors.length, `agree ${c.id}: no page errors ${p.errors.join(' | ')}`) && good;
    await p.ctx.close();
  }
  if (!only || only.includes('zero')) {
    // Zero input: the 10-14 segments with every p and s row removed.
    const files = Object.fromEntries(Object.entries(realSegments(['2026-10-14'])).map(([k, v]) => [k, v.split('\n').filter((l) => !/^[ps],/.test(l)).join('\n')]));
    const p = await seeded(files, '#/day/2026-10-14'); await chartReady(p).catch(() => {});
    const r = await p.evaluate(async () => { const prep = await window.__aortiReport.prepare('2026-10-14'); const idx = [...document.querySelectorAll('#rpg1 table.idx tbody tr')].map((tr) => tr.children[2].textContent.trim()); return { pages: prep.count, idx }; });
    good = ok(r.idx.some((k) => /^Above/.test(k)) && r.pages >= 2, `agree zero input 10-14 (no p or s rows): page 1 lists ${r.idx.filter((k) => /^Above/.test(k)).length} stretches, ${r.pages} pages`) && good;
    await p.ctx.close();
  }
  return good;
}

// ---------- same ----------
const VIEW_PIECES = () => {
  const txt = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : '');
  const ch = Chart.getChart(document.querySelector('#view-day #session-chart'));
  const strip = (o) => JSON.stringify(o, (k, v) => typeof v === 'function' ? undefined : v);
  const view = document.querySelector('#view-day').cloneNode(true);
  view.querySelectorAll('#insight-text').forEach((e) => e.remove());
  return {
    tiles: txt(document.querySelector('#view-day #summary-grid')),
    view: txt(view),
    datasets: ch ? ch.data.datasets.map((d) => (d.label || '') + ':' + strip(d.data)) : [],
    overlays: ch ? strip(ch.config.options.plugins.hrOverlays) : '',
    markers: txt(document.querySelector('#view-day #marker-list')),
    insight: [...document.querySelectorAll('#view-day #insight-text .insight-section[data-key]')].filter((s) => s.dataset.key !== 'moments').map((s) => s.dataset.key + ': ' + txt(s)),
  };
};
async function partSame(src, only) {
  SERVED = src;
  const cases = [
    { id: 'demo-04-24', iso: '2026-04-24', demo: true },
    { id: 'demo-04-26', iso: '2026-04-26', demo: true },
    { id: '10-14', iso: '2026-10-14', files: () => realSegments(['2026-10-14']) },
    { id: 'G17', iso: '2026-05-05', files: () => g17() },
  ].filter((c) => !only || only.includes(c.id));
  let good = true;
  for (const c of cases) {
    const open = async (old) => { const p = c.demo ? await demoPage(c.iso, { old }) : await seeded(c.files(), '#/day/' + c.iso, { old }); await chartReady(p).catch(() => {}); await p.waitForTimeout(400); return p; };
    const a = await open(false), b = await open(true);
    const va = await a.evaluate(VIEW_PIECES), vb = await b.evaluate(VIEW_PIECES);
    const ra = await reportPieces(a, c.iso), rb = await reportPieces(b, c.iso);
    for (const k of Object.keys(va)) {
      const eq = JSON.stringify(va[k]) === JSON.stringify(vb[k]);
      let where = '';
      if (!eq) { const x = JSON.stringify(va[k]), y = JSON.stringify(vb[k]); let i = 0; while (i < x.length && x[i] === y[i]) i++; where = ` at ${i}: "${x.slice(Math.max(0, i - 40), i + 60)}" vs "${y.slice(Math.max(0, i - 40), i + 60)}"`; }
      good = ok(eq, `same ${c.id}: ${k} identical to ${BASE_REF}${where}`) && good;
    }
    const firstDiff = (x, y) => { x = [].concat(x); y = [].concat(y); const i = x.findIndex((v, j) => JSON.stringify(v) !== JSON.stringify(y[j])); return i < 0 && x.length === y.length ? '' : `: ${x.length} vs ${y.length} items, first difference at ${i < 0 ? x.length : i}: ${JSON.stringify(x[i < 0 ? x.length : i])} vs ${JSON.stringify(y[i < 0 ? x.length : i])}`; };
    for (const k of Object.keys(ra)) good = ok(JSON.stringify(ra[k]) === JSON.stringify(rb[k]), `same ${c.id}: report ${k} identical to ${BASE_REF}${firstDiff(ra[k], rb[k])}`) && good;
    good = ok(!a.errors.length && !b.errors.length, `same ${c.id}: no page errors ${a.errors.concat(b.errors).join(' | ')}`) && good;
    await a.ctx.close(); await b.ctx.close();
  }
  return good;
}

// ---------- copy ----------
const BANNED = [/undefined|NaN|\bnull\b/, /stood up/i, /standing up/i, /\bexercise/i, /\bworkout/i, /tachycardia/i, /\bPOTS\b/, /orthostatic/i, /\bflare/i, /\bepisode/i, /\babnormal/i, /\bcase\b/i, /\bevidence\b/i, /[\u2013\u2014]/, /\b(add|tap|mark|note|choose|check|tell us|what were you)\b/i];
async function partCopy(src) {
  SERVED = src;
  const cases = [{ id: 'demo-04-24', iso: '2026-04-24', demo: true }, { id: 'demo-04-26', iso: '2026-04-26', demo: true }, { id: 'G17', iso: '2026-05-05', files: () => g17() }, { id: 'G20', iso: '2026-05-06', files: () => g20() }];
  if (fs.existsSync(S54)) cases.push({ id: '10-13', iso: '2026-10-13', files: () => realSegments(['2026-10-13']) }, { id: '10-14', iso: '2026-10-14', files: () => realSegments(['2026-10-14']) });
  else { console.log('MISSING ' + S54); process.exit(2); }
  let good = true, n = 0;
  for (const c of cases) {
    const p = await openCase(c);
    await momentsReady(p);
    const m = await modelOf(p, c.iso);
    const day = (await dayRows(p)).map((r) => r.text);
    await p.evaluate((iso) => window.__aortiReport.prepare(iso), c.iso);
    const ticks = (m ? m.ticks : []).map((t) => t.word);
    const rep = await p.evaluate((ticks) => {
      const out = [];
      document.querySelectorAll('#rpg1 table.idx tbody tr').forEach((tr) => { const k = tr.children[2].textContent.trim(); if (/^(Above|Sudden)/.test(k)) out.push(k, tr.children[3].textContent.trim()); });
      document.querySelectorAll('#report-print .moment').forEach((mo) => {
        const k = mo.querySelector('.mhead .kind').textContent.trim();
        if (!/^(Above|Sudden)/.test(k)) return;
        out.push(mo.querySelector('.mhead').textContent.replace(/Page 1$/, '').trim(), mo.querySelector('.msub').textContent.trim());
        const tl = mo.querySelector('.timeline');
        if (tl) [...tl.children].forEach((el, i, all) => { if (el.classList.contains('tm')) return; const w = el.textContent.trim(); if (ticks.some((t) => t.toLowerCase() === w.toLowerCase())) return; out.push(w); });
      });
      return out;
    }, ticks);
    // S62 (REVIEW-code N2): a stretch that runs to the day's end says "to midnight" on the Day view, never "to 12:00 AM".
    // S62: a stretch that stops at a recording gap names the gap, not a later Under minute.
    const gapRows = rep.filter((s) => /^Recording gap \d{2}:\d{2} to \d{2}:\d{2}$/.test(s));
    if (c.id === '10-14') good = ok(gapRows.length > 0, `copy 10-14: moment page timeline names the gap (${gapRows.join(' | ') || 'none'})`) && good;
    const noon = day.filter((s) => /to 12:00 AM/.test(s)), mid = day.filter((s) => /to midnight,/.test(s));
    good = ok(!noon.length && (c.id !== '10-14' || mid.length > 0), `copy ${c.id}: ${mid.length} Day rows to midnight, ${noon.length} to 12:00 AM${noon.length ? ': ' + noon[0] : ''}`) && good;
    const all = day.concat(rep);
    n += all.length;
    const bad = all.filter((s) => BANNED.some((re) => re.test(s)));
    good = ok(!bad.length && all.length > 0, `copy ${c.id}: ${all.length} strings, ${bad.length} with a banned word, dash or ask${bad.length ? ': ' + bad.slice(0, 3).join(' | ') : ''}`) && good;
    await p.ctx.close();
  }
  return good;
}

// ---------- nav ----------
async function partNav(src, only) {
  SERVED = src;
  let good = true;
  if (!only || only.includes('jump')) {
    const p = await newPage();
    await p.goto(viewerUrl() + '?demo=1#/month', { waitUntil: 'networkidle' });
    await p.waitForTimeout(500);
    await p.evaluate(() => {
      window.__navBad = [];
      const routeDay = () => (location.hash.match(/day\/(\d{4}-\d{2}-\d{2})/) || [])[1];
      new MutationObserver(() => {
        document.querySelectorAll('#insight-text [data-key="moments"] li[data-day]').forEach((li) => { if (li.dataset.day !== routeDay()) window.__navBad.push(li.dataset.day + ' on ' + routeDay()); });
      }).observe(document.body, { subtree: true, childList: true });
      location.hash = '#/day/2026-04-24';
      const tick = () => { const c = document.querySelector('#view-day #session-chart'); const ch = c && Chart.getChart(c); if (ch && ch.data.datasets.some((d) => d.data && d.data.length > 100) && document.getElementById('view-day').dataset.iso === '2026-04-24') { requestAnimationFrame(() => { location.hash = '#/day/2026-04-26'; }); return; } requestAnimationFrame(tick); };
      requestAnimationFrame(tick);
    });
    await p.waitForTimeout(3000);
    await momentsReady(p);
    const r = await p.evaluate(() => ({ bad: window.__navBad, days: [...document.querySelectorAll('#insight-text [data-key="moments"] li[data-day]')].map((li) => li.dataset.day) }));
    good = ok(!r.bad.length && r.days.length > 0 && r.days.every((d) => d === '2026-04-26'), `nav jump 04-24 to 04-26 before idle: ${r.bad.length} wrong-day rows seen${r.bad.length ? ' (' + r.bad[0] + ')' : ''}, final rows ${r.days.length} all 04-26: ${r.days.every((d) => d === '2026-04-26')}`) && good;
    await p.ctx.close();
  }
  if (!only || only.includes('reload')) {
    const files = realSegments(['2026-10-14']);
    const p = await seeded(files, '#/day/2026-10-14');
    await chartReady(p).catch(() => {});
    const shown = await momentsReady(p);
    const last = Object.keys(files).filter((n) => /20261015T0[0-5]Z|20261014T/.test(n)).sort().pop();
    await p.evaluate(() => {
      window.__navNull = 0;
      new MutationObserver(() => { if (!document.querySelector('#insight-text [data-key="moments"]')) window.__navNull++; }).observe(document.body, { subtree: true, childList: true });
    });
    let text = files[last];
    const reloads = [];
    for (let k = 0; k < 2; k++) {
      const lastEp = Math.max(...text.split('\n').filter((l) => /^h,/.test(l)).map((l) => +l.split(',')[1]));
      const add = []; for (let i = 1; i <= 60; i++) add.push(`h,${lastEp + i * 1000},${88 + (i % 3)},35.00,${Math.round(60000 / 88)}`);
      text = text.replace(/\n*$/, '\n') + add.join('\n') + '\n';
      const before = await p.evaluate(() => globalThis.__s61.detectDayMoments);
      await p.evaluate(async ({ name, text }) => {
        const db = await new Promise((res) => { const q = indexedDB.open('hr_monitor_kv', 2); q.onsuccess = () => res(q.result); });
        await new Promise((res) => { const tx = db.transaction('drive-cache', 'readwrite'); tx.objectStore('drive-cache').put(text, name); tx.oncomplete = res; });
        db.close();
      }, { name: last, text });
      const changed = await p.evaluate(() => window.__s61Test.reload());
      const present = await p.evaluate(() => !!document.querySelector('#insight-text [data-key="moments"]'));
      await p.waitForFunction((b) => globalThis.__s61.detectDayMoments > b, before, { timeout: 8000 }).catch(() => {});
      const after = await p.evaluate(() => globalThis.__s61.detectDayMoments);
      reloads.push({ changed, present, ran: after > before });
    }
    await p.waitForTimeout(300);
    const rowsD = (await dayRows(p)).filter((r) => r.s != null);
    const m = await modelOf(p, '2026-10-14');
    const eq = m && rowsD.length === m.moments.length && rowsD.every((r, i) => r.s === m.moments[i].s && r.kind === m.moments[i].kind);
    const nulls = await p.evaluate(() => window.__navNull);
    good = ok(shown && reloads.every((r) => r.changed && r.present && r.ran) && nulls === 0 && eq,
      `nav two reloads with a grown 10-14 segment (${last}): ${reloads.map((r, i) => `reload ${i + 1} data changed ${r.changed}, section present ${r.present}, detection ran ${r.ran}`).join('; ')}; section missing in ${nulls} observer callbacks; final rows equal the report model: ${eq}`) && good;
    await p.ctx.close();
  }
  return good;
}

// ---------- mutants ----------
const MUT = [
  [1, 'secondsFromPoints reads p.v', [['const y = p && p.y;', 'const y = p && p.v;']], [['replay'], ['agree', ['demo-04-24']]]],
  [2, 'junk all zeros', [['const flag = n >= B.minBeats && jc / n >= B.share ? 1 : 0;', 'const flag = 0;']], [['golden', ['G8']], ['replay']]],
  [3, 'bridge limit 3 to 0', [['bridge: 3,', 'bridge: 0,']], [['golden', ['G6']]]],
  [4, 'merge gap 10 to 0', [['merge: 10 }', 'merge: 0 }']], [['golden', ['G4']], ['replay']]],
  [5, 'T = 100 regardless of the line', [['const T = d.line != null ? d.line : S61_T;', 'const T = S61_T;']], [['golden', ['G12']]]],
  [6, 'stamp threshold 0.02 min to 0', [['stamp: i === 0 && postureLog[i].t < 0.02', 'stamp: i === 0 && postureLog[i].t < 0']], [['golden', ['G14b']]]],
  [7, 'stamp spans removed before the tap rule', [['const spans = (summary.postureSpans || []).slice().sort(', 'const spans = (summary.postureSpans || []).filter(sp => !sp.stamp).sort(']], [['golden', ['G14a']]]],
  [8, 'the hrDeltas Rise slot restored', [['    const all = taps.concat(above, lone).filter(', "    { const h = (d.summary.hrDeltas || []).filter(q => q.direction === 'rise' && q.start >= 0 && q.start < d.n).sort((p, q) => q.delta - p.delta)[0]; if (h) lone.push({ kind: 'Rise', t: Math.round(h.start), a: h.start - 10, b: h.start + 20, taps: [] }); }\n    const all = taps.concat(above, lone).filter("]], [['agree', ['demo-04-24']]]],
  [9, 'the Day view section from a second rule (old detector fed {t,v})', null, [['agree', ['demo-04-24']]]],
  [10, "junk applied to the chart's HR series", [['    drawSessionChart(s, data);\n    s61AfterPaint(s, data, filename);', '    { const p0 = (data.hr || [])[0]; const ep0 = p0 ? Math.round(p0.ep - p0.x * 60000) : 0; const secs = Math.ceil(s.duration) * 60; const jk = beatJunk(data.beats || [], ep0, secs); drawSessionChart(s, Object.assign({}, data, { hr: data.hr.filter(p => !jk[Math.round((p.ep - ep0) / 1000)]) })); }\n    s61AfterPaint(s, data, filename);']], [['same', ['G17']]]],
  [11, "rise sub line 'Sudden rise after standing up'", [["    const riseText = rise ? 'Sudden rise ' + rise.text : '';", "    const riseText = rise ? 'Sudden rise after standing up ' + rise.text : '';"], ["x.dayText = 'Sudden rise ' + rise.start", "x.dayText = 'Sudden rise after standing up ' + rise.start"]], [['copy']]],
  [12, 'coverage counted by readings (fill 6 s to 1 s)', [['const S61_COVER_S = 6;', 'const S61_COVER_S = 1;']], [['golden', ['G15']], ['demo']]],
  [13, 'the Day view row stops calling momentContextText', [['if (x.dayText) return x.dayText + s61Ctx(x);', 'if (x.dayText) return x.dayText;']], [['golden', ['G18']]]],
  [14, 'blip count line printed in #report-print', [["    h += '<h2 class=\"sec\">Moments</h2>';", "    h += '<h2 class=\"sec\">Moments</h2>' + (d.parts && d.parts.blips ? '<p class=\"more\">Short rises under a minute: ' + d.parts.blips + '</p>' : '');"]], [['agree', ['10-14']]]],
  [15, 'idle result rendered without the currentData and route guard', [['      if (stale()) return;\n      if (s61Pointers.size)', '      if (s61Pointers.size)'], ['      if (stale()) return;\n      s61Paint(res, key);', '      s61Paint(res, key);']], [['nav', ['jump']]]],
  [16, "production momentRoute returns 'activity' for the first auto moment", [["function momentRoute(m) { return 'moment'; }", "function momentRoute(m) { if (m.auto && !globalThis.__s61Routed) globalThis.__s61Routed = m; return m === globalThis.__s61Routed ? 'activity' : 'moment'; }"]], [['golden', ['G19']]]],
  [17, 'stretch windows that overlap merged into one moment', [['    const lone = [];\n    parts.rises.forEach', '    for (let i = above.length - 1; i > 0; i--) if (above[i].a <= above[i - 1].b) { above[i - 1].b = Math.max(above[i - 1].b, above[i].b); above[i - 1].e = above[i].e; above.splice(i, 1); }\n    const lone = [];\n    parts.rises.forEach']], [['golden', ['G5b']]]],
  [18, 'trailing bridged minutes counted in the run', [['} else if (s >= 0 && (m - last - sk(last + 1, m + 1) > R.bridge || m === M)) { close(s, last); s = -1; }', '} else if (s >= 0 && (m - last - sk(last + 1, m + 1) > R.bridge || m === M)) { close(s, m - 1); s = -1; }']], [['golden', ['G7b']]]],
  [19, 'auto-poll reload clears the Moments section before the new result', [['    if (s61Shown.key === key) return s61SectionFrom(s61Shown.res, key);\n', '']], [['nav', ['reload']]]],
  [20, 'T used for x.back on Symptom moments', [['const lineFor = x.auto ? x.T : d.line;', 'const lineFor = x.auto ? x.T : S61_T;']], [['same', ['G17']]]],
  [22, 'only the first joined rise described (review M1)', [['    (x.rises || []).forEach(w => {\n      const r = w.r,', '    (x.rises || []).slice(0, 1).forEach(w => {\n      const r = w.r,']], [['golden', ['G20']]]],
  [23, '"Under" searched from the peak on a stretch (review S1)', [["for (let m = x.auto === 'above' ? x.e : x.peak.m + 1;", 'for (let m = x.peak.m + 1;']], [['golden', ['G21']]]],
  [24, 'Day row to midnight printed as 12:00 AM (review N2)', [["(end.getHours() || end.getMinutes() ? formatClockTime(end.getTime()) : 'midnight')", 'formatClockTime(end.getTime())']], [['copy']]],
  [25, 'no settle after gaps', [['const S61_SETTLE = { gapS: 60, skipS: 180 };', 'const S61_SETTLE = { gapS: 60, skipS: 0 };']], [['golden', ['G22']]]],
  [26, 'settled minutes count against the merge', [['if (p && r.s - p.e - 1 - sk(p.e + 1, r.s) <= R.merge', 'if (p && r.s - p.e - 1 <= R.merge']], [['golden', ['G23']]]],
  [27, 'a stretch ending at a gap prints Under', [['    if (x.gapAfter) x.back = null;\n', ''], ["    if (x.gapAfter) rows.push([x.gapAfter[0], 'Recording gap ' + d.clock(x.gapAfter[0]) + ' to ' + d.clock(x.gapAfter[1])]);\n", '']], [['copy']]],
  [21, 'postureStampReady removed from the composeV2Index hit test', [[' && !yFixSuspect(hit.summary) && postureStampReady(hit.summary)) summary = hit.summary;', ' && !yFixSuspect(hit.summary)) summary = hit.summary;']], [['golden', ['G14c']]]],
];
function mutate(n, pairs) {
  let s = REAL;
  if (n === 9) {
    const old = execFileSync('git', ['-C', ROOT, 'show', '90c62d6:hrv_viewer.html'], { encoding: 'utf8', maxBuffer: 64 << 20 }).replace(/\r\n/g, '\n');
    const det = fnSrc(old, 'detectNoteworthyMoments') + fnSrc(old, 'medianOf');
    const alt = "\n  function s61Alt(d) { const pts = currentData.hr.map(p => ({ t: p.x, v: p.y })); return detectNoteworthyMoments(pts, []).map(n => ({ kind: 'Above 100', t: Math.round(n.start), ms: Math.round(n.start), me: Math.round(n.end), dayText: 'HR around ' + Math.round(n.windowMedian), hrText: '' })); }\n";
    const a = '  // The Moments section from a detection result, or null';
    if (!s.includes(a) || !s.includes('    const lines = d.moments.map(x => {')) return null;
    return s.replace(a, det + alt + a).replace('    const lines = d.moments.map(x => {', '    const lines = s61Alt(d).map(x => {');
  }
  for (const [a, b] of pairs) { if (!s.includes(a)) return null; s = s.replace(a, b); }
  return s;
}
async function runPart(name, src, only) {
  QUIET = true; const before = fails, beforeP = passes, r0 = rows.length; let good;
  try {
    if (name === 'golden') good = await partGolden(src, only);
    else if (name === 'demo') good = partDemo(src);
    else if (name === 'replay') good = partReplay(src);
    else if (name === 'agree') good = await partAgree(src, only);
    else if (name === 'same') good = await partSame(src, only);
    else if (name === 'copy') good = await partCopy(src);
    else if (name === 'nav') good = await partNav(src, only);
  } catch (e) { good = false; rows.push('ERROR ' + name + ': ' + e.message); }
  QUIET = false; fails = before; passes = beforeP;
  runPart.why = (rows.slice(r0).find((r) => !r.startsWith('PASS')) || '').slice(0, 160);
  return good;
}

if (MUTANTS_ON) {
  const list = MUT.filter(([, , , parts]) => parts.some(([p]) => PARTS.includes(p)));
  const baseOk = new Map();
  for (const [n, name, pairs, parts] of list) {
    const src = mutate(n, pairs);
    if (!src) { ok(false, `MUTANT ${n} ${name}: ANCHOR MISSING`); continue; }
    const res = [];
    for (const [p, only] of parts.filter(([p]) => PARTS.includes(p))) {
      const key = p + ':' + (only || []).join(',');
      if (!baseOk.has(key)) baseOk.set(key, await runPart(p, REAL, only));
      if (!baseOk.get(key)) { res.push(`${key} does not pass unmutated`); continue; }
      const caught = !(await runPart(p, src, only));
      res.push(`${key} ${caught ? 'FAILED (caught)' : 'passed (NOT caught)'}`);
      if (caught) console.log(`   mutant ${n} ${key}: ${runPart.why}`);
    }
    ok(res.every((r) => r.endsWith('FAILED (caught)')), `MUTANT ${n} ${name}: ${res.join('; ')}`);
  }
} else {
  for (const p of PARTS) {
    const t = Date.now();
    let good;
    if (p === 'golden') good = await partGolden(REAL);
    else if (p === 'demo') good = partDemo(REAL);
    else if (p === 'replay') good = partReplay(REAL);
    else if (p === 'agree') good = await partAgree(REAL);
    else if (p === 'same') good = await partSame(REAL);
    else if (p === 'copy') good = await partCopy(REAL);
    else if (p === 'nav') good = await partNav(REAL);
    else { console.log('unknown part ' + p); process.exit(2); }
    console.log(`-- ${p}: ${good ? 'pass' : 'FAIL'} in ${((Date.now() - t) / 1000).toFixed(1)} s`);
  }
}
if (browser) await browser.close();
server.close();
console.log(`day-moments ${PARTS.join(',')}${MUTANTS_ON ? ' --mutants' : ''}: ${passes} pass, ${fails} fail, ${((Date.now() - T0) / 1000).toFixed(0)} s`);
process.exit(fails ? 1 : 0);
