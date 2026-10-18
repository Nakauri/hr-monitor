// Guards (S63 sleep split in the Day report Summary): a split from a baseline not settled (hours over-called before a week
// of history), a clock prior, personal weights or any split reaching other people, printed times, an
// in-progress day cached, a split that moves a moment off page 1, and a digest stored from a day whose file did not load
// (S63-SPEC-skeptic3 MUST 1: the session cache holds 8 files, so a re-read can fail after a first read passed).
// S64 (--part dayview): the Day view and the report disagree on sleep for the same day (S63-SPEC open question 1).
// Files: hrv_viewer.html (S63 sleep block, rptModel, s63DayDigest, s63Sleep, rptSleepFigures, rptSleepRows, rptPage1,
// rptPrepare, buildDaySession loadFailed, S64 s64Run, postureSleepSection), report.css, diagnostics.js. Spec: ux-audit
// redesign/s63-sleep/S63-SPEC.md. Parts golden,replay,same,fit,share,copy,dayview (default golden,copy). Runtime: golden
// about 30 s, copy about 40 s, replay about 30 s, same about 75 s, share about 5 s, dayview about 190 s, run as --only D1,D2,D3 (about 70 s) then
// --only T (about 110 s, needs the manifest), fit about 60 to 150 s a month (--month 2026-08 runs one month).
// replay, same, fit and copy need <ux>/redesign/s63-sleep/replay-manifest.json, replay-expect.json and the files they
// name; a missing input exits 2 with its path, changed data exits 2 with "data changed, re-freeze". Expectations and
// labels stay in those gitignored files; this script holds no personal number, date or time.
// --mutants runs the negative controls of spec 6b, each must FAIL; with --part, only the mutants aimed at those parts;
// --only G2,G13 runs those goldens. "same" and "fit" compare against main 02aef18, "dayview" flag off against 77f8fca.
// --shots <dir> writes page 1 pictures, and with dayview the Day chart of demo 04-24 before (77f8fca) and after.
// Usage: node scripts/sleep-split.mjs [--part <list>] [--mutants] [--only <ids>] [--month <yyyy-mm>] [--ux <dir>] [--shots <dir>]
process.env.TZ = 'America/Edmonton';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
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
const PARTS = (argVal('--part') || (MUTANTS_ON ? 'golden,replay,same,share' : 'golden,copy')).split(',');
const ONLY = argVal('--only') ? argVal('--only').split(',') : null;
const MONTH = argVal('--month');
const SHOTS = argVal('--shots');
const BASE_REF = '02aef18';
const S64_REF = '77f8fca';
const HOME = os.homedir().split(path.sep).join('/');
const S63 = path.join(UX, 'redesign', 's63-sleep');
const MANIFEST = path.join(S63, 'replay-manifest.json');
const EXPECT = path.join(S63, 'replay-expect.json');
const CHART = path.join(UX, '..', 'docs', 'audit-2026-10-09', 'harness-DT', 'vendor', 'chart.umd.min.js');
const REAL = fs.readFileSync(path.join(ROOT, 'hrv_viewer.html'), 'utf8').replace(/\r\n/g, '\n');
const T0 = Date.now();
const need = (p) => { if (!fs.existsSync(p)) { console.log('MISSING ' + p); process.exit(2); } };
const LS_FLAG = 'hrv_viewer_sleep_weights';

let fails = 0, passes = 0, QUIET = false, firstFail = null;
const ok = (cond, msg) => { if (cond) passes++; else { fails++; if (!firstFail) firstFail = msg; } if (!QUIET) console.log((cond ? 'PASS ' : 'FAIL ') + msg); return cond; };

// ---------- the S61 and S63 blocks, cut at run time ----------
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
function slice(src, a, b) {
  const i = src.indexOf(a), j = src.indexOf(b);
  if (i < 0 || j < i) throw new Error('markers missing: ' + a.trim());
  return src.slice(i, j);
}
function cut(src) {
  const body = slice(src, '  // ---- S61 moments ----', '  // ---- S61 moments end ----') + slice(src, '  // ---- S63 sleep ----', '  // ---- S63 sleep end ----') +
    ['rptMedian', 'rptDur', 's63Prints', 'rptSleepFigures'].map((n) => fnSrc(src, n)).join('\n');
  const g61 = globalThis.__s61, g63 = globalThis.__s63;
  globalThis.__s61 = undefined; globalThis.__s63 = undefined;
  const o = new Function(body + ';return { s63Digest, s63Baseline, s63Completed, s63Gate, s63Detect, s63States, s63Figures, rptSleepFigures, rptDur, S63_O, counter: globalThis.__s63 };')();
  globalThis.__s61 = g61; globalThis.__s63 = g63;
  return o;
}

// ---------- synthetic days (all dates synthetic) ----------
const addDays = (iso, k) => { const t = new Date(iso + 'T12:00:00Z'); t.setUTCDate(t.getUTCDate() + k); return t.toISOString().slice(0, 10); };
const dayStart = (iso) => new Date(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)).getTime();
const dayLen = (iso) => Math.round((dayStart(addDays(iso, 1)) - dayStart(iso)) / 60000);
const WEEK0 = '2026-05-01';
const WD = (k) => addDays(WEEK0, k);           // day k + 1 of the week; the report day is WD(7)
// The week: 00:00 to 08:00 HR 55, 08:00 to 12:00 HR 115, 12:00 to 24:00 HR 95; RMSSD 40.
const pat = (i) => i < 480 ? 55 : i < 720 ? 115 : 95;
const rm40 = () => 40;
// Node digest of one day at 1 Hz from minute functions.
function nodeDay(B, iso, fn, rmFn) {
  const ds = dayStart(iso), n = dayLen(iso), hp = [], rp = [];
  for (let s = 0; s < n * 60; s++) {
    const m = Math.floor(s / 60), v = fn(m);
    if (v == null) continue;
    hp.push({ ep: ds + s * 1000, y: v });
    const r = (rmFn || rm40)(m);
    if (r != null) rp.push({ ep: ds + s * 1000, y: r });
  }
  return B.s63Digest(hp, rp, [], ds, n);
}
function nodeWeek(B, over, start) {
  const ds = [];
  for (let k = 0; k < 9; k++) { const o = over && over[k]; ds.push(nodeDay(B, addDays(start || WEEK0, k), o ? o.fn || o : pat, o && o.rm)); }
  return ds;
}
const asD = (g) => { const hr = Array.from(g.hr, (v) => v === v ? v : null), hrv = Array.from(g.rm, (v) => v === v ? v : null); return { hr, hrv, recorded: hr.filter((v) => v != null).length }; };
function nodeRun(B, ds, D, weights) {
  const win = (x) => ds.slice(Math.max(0, x - 6), x + 1);
  const bCur = B.s63Baseline(win(D)), bPrev = D > 0 ? B.s63Baseline(win(D - 1)) : null;
  const gate = B.s63Gate(win(D).map((g) => g ? g.valid : 0).concat(new Array(Math.max(0, 6 - D)).fill(0)));
  const mask = B.s63Detect({ prev: ds[D - 1] || null, cur: ds[D], next: ds[D + 1] || null }, { prev: bPrev, cur: bCur }, weights);
  const d = asD(ds[D]), f = B.s63Figures(d, mask);
  const rows = B.rptSleepFigures(Object.assign(d, { sleep: { source: 'detected', weights, mask } }));
  return { gate, f, mask, bCur, rows };
}
const span = (mask) => { const r = []; let a = -1; for (let i = 0; i <= mask.length; i++) { const x = i < mask.length ? mask[i] : -1; if (x === 1 && a < 0) a = i; if (x !== 1 && a >= 0) { r.push(a + '-' + i); a = -1; } } return r.join(',') || 'none'; };
const anyIn = (mask, a, b) => { for (let i = a; i < b; i++) if (mask[i]) return true; return false; };

// Node goldens: values derived by ux-audit s63-sleep/proto/goldens.cjs from the spec rules.
const NODE_GOLDENS = {
  G1: (B) => { const g = nodeDay(B, WD(0), pat); return ok(B.s63Gate([g.valid]) === false, `G1 day 1 alone: gate ${B.s63Gate([g.valid])} (want false, no rows)`); },
  G2: (B) => {
    const ds = nodeWeek(B), p = nodeRun(B, ds, 7, 'personal'), g = nodeRun(B, ds, 7, 'general'), f = p.f;
    const text = p.rows ? [B.rptDur(p.rows.asleepMin) + ' asleep', B.rptDur(p.rows.awakeMin) + ' awake'] : [];
    return ok(p.gate && p.bCur && p.bCur.p5 === 55 && p.bCur.p50 === 95 && p.bCur.rmd === 40 && f.asleepMin === 487 && f.awakeMin === 953 && f.asleep.hr === 55 && f.asleep.hrv === 40 && f.awake.hr === 95 && f.awake.hrv === 40 && span(p.mask) === '0-486,1439-1440' && text.join(' | ') === '8 h 7 min asleep | 15 h 53 min awake' && g.f.asleepMin === 488 && g.f.awakeMin === 952,
      `G2 the week, personal: baseline ${JSON.stringify(p.bCur)}, Asleep ${f.asleepMin} (${span(p.mask)}), Awake ${f.awakeMin}, asleep ${f.asleep.hr} bpm ${f.asleep.hrv} ms, awake ${f.awake.hr} bpm ${f.awake.hrv} ms, rows "${text.join(' | ')}"; general ${g.f.asleepMin} and ${g.f.awakeMin} (want 55/95/40, 487 (0-486,1439-1440), 953, 55 40, 95 40, "8 h 7 min asleep | 15 h 53 min awake"; 488 and 952)`);
  },
  G3: (B) => { const r = [B.s63Completed('2026-05-08', '2026-05-09', 359), B.s63Completed('2026-05-08', '2026-05-09', 360), B.s63Completed('2026-05-08', '2026-05-08', 900), B.s63Completed('2026-05-07', '2026-05-09', 0)];
    return ok(r.join() === 'false,true,false,true', `G3 completed at 359 / 360 min into the next day, the day itself, two days on: ${r.join(', ')} (want false, true, false, true)`); },
  G4: (B) => { const a = B.s63Gate([240, 240, 240, 239, 0, 0, 0]), b = B.s63Gate([240, 240, 240, 240, 0, 0, 0]); return ok(a === false && b === true, `G4 floor: three days of 4 h plus 239 min / four days of 4 h: ${a}, ${b} (want false, true)`); },
  G5: (B) => { const o = {}; for (let k = 1; k <= 4; k++) o[k] = (i) => i >= 480 && i < 660 ? 115 : null; const r = nodeRun(B, nodeWeek(B, o), 7, 'personal');
    return ok(r.gate === false, `G5 days 2 to 5 hold 08:00 to 11:00 only: day 8 gate ${r.gate} (want false, no rows)`); },
  G6: (B) => {
    const o = { 6: (i) => i >= 1350 ? 55 : pat(i), 7: (i) => i < 40 ? 55 : i < 480 ? 95 : pat(i) };
    const ds = nodeWeek(B, o), p = nodeRun(B, ds, 7, 'personal'), g = nodeRun(B, ds, 7, 'general');
    const none = B.s63Detect({ prev: null, cur: ds[7], next: null }, { prev: null, cur: p.bCur }, 'personal').reduce((s, x) => s + x, 0);
    return ok(p.f.asleepMin === 55 && span(p.mask) === '0-54,1439-1440' && g.f.asleepMin === 56 && none === 0 && !!p.rows, `G6 a night from 22:30 the day before into 00:40: personal ${p.f.asleepMin} (${span(p.mask)}), general ${g.f.asleepMin}, no margins ${none}, rows ${!!p.rows} (want 55 (0-54,1439-1440), 56, 0, true)`);
  },
  G7: (B) => {
    const o = { 7: { fn: (i) => i < 180 ? 95 : i < 360 ? 75 : i < 480 ? 95 : pat(i), rm: (i) => i >= 180 && i < 360 ? 80 : 40 } };
    const ds = nodeWeek(B, o), p = nodeRun(B, ds, 7, 'personal'), g = nodeRun(B, ds, 7, 'general');
    return ok(!anyIn(p.mask, 180, 360) && span(g.mask) === '185-374,1439-1440', `G7 03:00 to 06:00 at HR 75 with RMSSD 80: personal asleep in that block ${anyIn(p.mask, 180, 360)}, general ${span(g.mask)} (want false, 185-374,1439-1440: 03:05 to 06:14 plus the next night's first minute)`);
  },
  G7b: (B) => {
    const o = { 7: { fn: (i) => i < 180 ? 95 : i < 360 ? 85 : i < 480 ? 95 : pat(i), rm: (i) => i >= 180 && i < 360 ? null : 40 } };
    const ds = nodeWeek(B, o), p = nodeRun(B, ds, 7, 'personal'), g = nodeRun(B, ds, 7, 'general');
    return ok(span(p.mask) === '1439-1440' && span(g.mask) === '1439-1440', `G7b the same block at HR 85 without RMSSD: personal ${span(p.mask)}, general ${span(g.mask)} (want 1439-1440 for both, none in the block; lr = 0 would give 186-373)`);
  },
  G8: (B) => { const p = []; for (let i = 0; i < 60; i++) p.push(1); for (let i = 0; i < 120; i++) p.push(i % 2 ? 0.55 : 0.35); const st = B.s63States(Float64Array.from(p)); const n = st.filter((x) => x === 1).length;
    return ok(n === 180, `G8 60 min at 1.0 then 0.35 and 0.55 alternating: ${n} of 180 asleep (want 180)`); },
  G9: (B) => { const ds = nodeWeek(B, { 0: (i) => i >= 494 ? pat(i) : null }), r = nodeRun(B, ds, 7, 'personal');
    return ok(ds[0].valid === 946 && ds[1].hr[0] === 55 && ds[1].hr.length === 1440 && r.f.asleepMin === 487, `G9 day 1 starts 08:14: day 1 valid ${ds[0].valid}, day 2 minute 0 ${ds[1].hr[0]}, length ${ds[1].hr.length}, day 8 Asleep ${r.f.asleepMin} (want 946, 55, 1440, 487)`); },
  G12: (B) => { const start = '2026-10-25', ds = nodeWeek(B, { 7: (i) => i < 540 ? 55 : i < 780 ? 115 : 95 }, start), r = nodeRun(B, ds, 7, 'personal');
    return ok(addDays(start, 7) === '2026-11-01' && ds[7].hr.length === 1500 && r.f.asleepMin === 547, `G12 the 25 h day ${addDays(start, 7)}: digest n ${ds[7].hr.length}, Asleep ${r.f.asleepMin} (want 1500, 547)`); },
  G14: (B) => { const r = nodeRun(B, nodeWeek(B, { 6: (i) => i >= 1300 ? 55 : pat(i), 7: (i) => i < 5 ? 55 : i < 480 ? 95 : pat(i) }), 7, 'personal');
    return ok(r.f.asleepMin === 20 && r.rows === null, `G14 a night from 21:40 the day before ending 00:05: Asleep ${r.f.asleepMin}, rows ${!!r.rows} (want 20, false)`); },
  G14b: (B) => { const r = nodeRun(B, nodeWeek(B, { 7: (i) => i < 490 ? pat(i) : null }), 7, 'personal');
    return ok(r.f.asleepMin === 490 && r.f.awakeMin === 0 && asD(nodeDay(B, WD(7), (i) => i < 490 ? pat(i) : null)).recorded === 490 && r.rows === null, `G14b day 8 recorded 00:00 to 08:10 only: Asleep ${r.f.asleepMin}, Awake ${r.f.awakeMin}, rows ${!!r.rows} (want 490, 0, false)`); },
};

// ---------- browser: server, pages, seeding ----------
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png', '.woff2': 'font/woff2', '.csv': 'text/csv' };
let SERVED = REAL;
const SEED = new Map();   // name -> text or { file }
const oldCache = new Map();
function oldFile(rel, ref = BASE_REF) {
  const k = ref + ':' + rel;
  if (!oldCache.has(k)) { try { oldCache.set(k, execFileSync('git', ['-C', ROOT, 'show', k], { maxBuffer: 64 << 20, stdio: ['ignore', 'pipe', 'ignore'] })); } catch (e) { oldCache.set(k, null); } }
  return oldCache.get(k);
}
let server = null, BASE = null, browser = null;
async function startServer() {
  if (server) return;
  server = http.createServer((req, res) => {
    const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (rel.startsWith('/seed/')) {
      const v = SEED.get(rel.slice(6));
      if (v == null) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' }); res.end(typeof v === 'string' ? v : fs.readFileSync(v.file)); return;
    }
    if (rel.startsWith('/old/') || rel.startsWith('/s64base/')) {
      const s64 = rel.startsWith('/s64base/'), body = oldFile(rel.slice(s64 ? 9 : 5), s64 ? S64_REF : BASE_REF);
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
  BASE = `http://127.0.0.1:${server.address().port}`;
}
async function getBrowser() {
  if (browser) return browser;
  const { chromium } = createRequire(path.join(UX, 'kit', 'package.json'))('playwright');
  try { browser = await chromium.launch(); } catch (e) { browser = await chromium.launch({ channel: 'chrome' }); }
  return browser;
}
const viewerUrl = (old) => BASE + (old === 's64base' ? '/s64base' : old ? '/old' : '') + '/hrv_viewer.html';
async function setupCtx(ctx, o) {
  await ctx.route('**/*', (route) => {
    const u = route.request().url();
    if (u.startsWith(BASE) || u.startsWith('data:') || u.startsWith('blob:')) return route.continue();
    if (/chart\.umd(\.min)?\.js/.test(u)) return route.fulfill({ status: 200, contentType: 'text/javascript', body: fs.readFileSync(CHART) });
    return route.fulfill({ status: 204, body: '' });
  });
  await ctx.addInitScript(({ flag, key }) => { try { if (flag) localStorage.setItem(key, 'personal'); else localStorage.removeItem(key); } catch (e) {} }, { flag: !!o.flag, key: LS_FLAG });
  if (o.init) await ctx.addInitScript(o.init);
}
// o: { width, flag, tz, clock (ms), dir (persistent profile), init }
async function newPage(o = {}) {
  await startServer();
  const opts = { viewport: { width: o.width || 1440, height: 900 }, timezoneId: o.tz || 'America/Edmonton' };
  let ctx;
  if (o.dir) { const { chromium } = createRequire(path.join(UX, 'kit', 'package.json'))('playwright'); try { ctx = await chromium.launchPersistentContext(o.dir, opts); } catch (e) { ctx = await chromium.launchPersistentContext(o.dir, { ...opts, channel: 'chrome' }); } }
  else ctx = await (await getBrowser()).newContext(opts);
  await setupCtx(ctx, o);
  const page = await ctx.newPage();
  if (o.clock) await page.clock.setFixedTime(new Date(o.clock));
  page.errors = []; page.warns = [];
  page.on('pageerror', (e) => page.errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'warning') page.warns.push(m.text()); });
  page.ctx = ctx;
  return page;
}
const SEED_FN = async (names) => {
  const db = await new Promise((res, rej) => { const q = indexedDB.open('hr_monitor_kv', 2);
    q.onupgradeneeded = () => { for (const s of ['kv', 'drive-cache']) if (!q.result.objectStoreNames.contains(s)) q.result.createObjectStore(s); };
    q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
  for (let i = 0; i < names.length; i += 16) {
    const texts = await Promise.all(names.slice(i, i + 16).map(async (n) => [n, await (await fetch('/seed/' + encodeURIComponent(n))).text()]));
    await new Promise((res, rej) => { const tx = db.transaction('drive-cache', 'readwrite'); for (const [k, v] of texts) tx.objectStore('drive-cache').put(v, k); tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
  }
  db.close(); localStorage.removeItem('hrv_viewer_index');
};
// Seeds files into the Drive cache of a new page, then opens hash from a fresh document.
async function seeded(files, hash, o = {}) {
  const page = await newPage(o);
  await seedInto(page, files);
  await page.goto(viewerUrl(o.old) + hash, { waitUntil: 'networkidle' });
  return page;
}
async function seedInto(page, files) {
  for (const [k, v] of Object.entries(files)) SEED.set(k, v);
  await page.goto(viewerUrl() + '#/month', { waitUntil: 'networkidle' });
  await page.evaluate(SEED_FN, Object.keys(files));
  await page.goto('about:blank');
}
async function demoPage(iso, o = {}) {
  const page = await newPage(o);
  await page.goto(viewerUrl(o.old) + '?demo=1#/day/' + iso, { waitUntil: 'networkidle' });
  return page;
}
const chartReady = (page) => page.waitForFunction(() => { const c = document.querySelector('#view-day #session-chart'); const ch = c && window.Chart && Chart.getChart(c); return !!(ch && ch.data.datasets.some((d) => d.data && d.data.length > 20)); }, null, { timeout: 60000 }).catch(() => {});
const close = async (p) => { try { await p.ctx.close(); } catch (e) {} };

// v1 CSV files of a synthetic week, one row every 5 s (each reading covers its 5 s, so minute values equal the 1 Hz goldens).
// o: { over: { k: fn(min) -> hr | null }, rm: { k: fn }, drop: [k], split12: k }
function weekFiles(o = {}) {
  const files = {};
  for (let k = 0; k < 9; k++) {
    if ((o.drop || []).includes(k)) continue;
    const iso = WD(k), ds = dayStart(iso), n = dayLen(iso), fn = (o.over && o.over[k]) || pat, rmFn = (o.rm && o.rm[k]) || rm40;
    const rows = [];
    for (let m = 0; m < n; m++) { const v = fn(m); if (v == null) continue; const r = rmFn(m); for (let j = 0; j < 12; j++) rows.push([ds + m * 60000 + j * 5000, v, r]); }
    if (!rows.length) continue;
    const parts = o.split12 === k ? Array.from({ length: 12 }, (_, i) => rows.filter((r) => r[0] >= ds + i * 7200000 && r[0] < ds + (i + 1) * 7200000)).filter((x) => x.length) : [rows];
    for (const part of parts) {
      const st = part[0][0] - 400, name = 'hrv_session_' + new Date(st).toISOString().slice(0, 19).replace(/:/g, '-') + '.csv';
      const lines = ['time_min,epoch_ms,hr_bpm,rmssd_ms,palpitation,event,warning,connection,posture', `0.0000,${st},,,,,,connected,`];
      for (const [ep, v, r] of part) lines.push(`${((ep - st) / 60000).toFixed(4)},${ep},${v},${r == null ? '' : r.toFixed(2)},,,,,`);
      files[name] = lines.join('\n') + '\n';
    }
  }
  return files;
}
const fileStart = (n) => { const m = /^hrv_session_(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})\.csv$/.exec(n); return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) + 1000 : NaN; };
const fileOfDay = (files, k) => Object.keys(files).filter((n) => fileStart(n) >= dayStart(WD(k)) - 1000 && fileStart(n) < dayStart(WD(k + 1))).sort((a, b) => fileStart(a) - fileStart(b));

// In-page readers.
const KEYS = () => new Promise((res) => { const q = indexedDB.open('hr_monitor_kv', 2); q.onsuccess = () => { const db = q.result; const r = db.transaction('kv').objectStore('kv').getAllKeys(); r.onsuccess = () => { db.close(); res(r.result.filter((k) => typeof k === 'string' && k.startsWith('s63:')).sort()); }; }; q.onerror = () => res(null); });
const s63Keys = (page) => page.evaluate(KEYS);
const ROOM = (pg) => { const foot = pg.querySelector('.foot'), top = pg.getBoundingClientRect().top; let bottom = 0; pg.querySelectorAll('*').forEach((el) => { if (foot.contains(el)) return; const r = el.getBoundingClientRect(); if (r.width || r.height) bottom = Math.max(bottom, r.bottom - top); }); return foot.getBoundingClientRect().top - top - bottom; };
async function prep(page, iso, o) {
  return page.evaluate(async ({ iso, o, ROOM }) => {
    const room = new Function('return ' + ROOM)();
    const p = await window.__aortiReport.prepare(iso, o || undefined);
    if (!p) return null;
    const pg = document.querySelector('#rpg1'), idx = pg.querySelector('table.idx');
    return {
      keep: p.keep, rows: p.rows, recorded: p.d.recorded,
      sleep: p.d.sleep ? { source: p.d.sleep.source, weights: p.d.sleep.weights, n: p.d.sleep.mask.length, asleep: Array.from(p.d.sleep.mask).reduce((a, b) => a + b, 0) } : null,
      slp: [...pg.querySelectorAll('tr.slp')].map((tr) => [...tr.children].map((c) => c.textContent.trim())),
      recCell: (pg.querySelector('table.sum tbody tr td') || {}).textContent || '',
      notZoomed: idx ? [...idx.querySelectorAll('tbody tr')].filter((tr) => /not zoomed/.test(tr.textContent)).length : 0,
      idx: idx ? idx.outerHTML : '', more: [...pg.querySelectorAll('p.more')].map((e) => e.outerHTML).join(''),
      room: room(pg), html: document.getElementById('report-print').innerHTML, count: p.count,
      c: globalThis.__s63 ? { digest: globalThis.__s63.digest, detect: globalThis.__s63.detect } : null,
    };
  }, { iso, o, ROOM: ROOM.toString() });
}
const minsOf = (s) => { const m = /^(?:(\d+) h)?(?: ?(\d+) min)?/.exec(s.trim()); return m ? (+(m[1] || 0)) * 60 + (+(m[2] || 0)) : NaN; };
const counter = (page) => page.evaluate(() => ({ digest: globalThis.__s63.digest, detect: globalThis.__s63.detect }));

// ---------- browser goldens ----------
const D8 = WD(7);
const BROWSER_GOLDENS = {
  // G2 rendered and G16: the rows add up to Recorded on the page.
  G16: async () => {
    let good = true;
    for (const [id, files] of [['G2', weekFiles()], ['G6', weekFiles({ over: { 6: (i) => i >= 1350 ? 55 : pat(i), 7: (i) => i < 40 ? 55 : i < 480 ? 95 : pat(i) } })]]) {
      const p = await seeded(files, '#/day/' + D8, { flag: true }); await chartReady(p);
      const r = await prep(p, D8);
      const a = r && r.slp[0] ? minsOf(r.slp[0][0]) : NaN, w = r && r.slp[1] ? minsOf(r.slp[1][0]) : NaN, rec = r ? minsOf(r.recCell) : NaN;
      const want = id === 'G2' ? r && r.slp.map((x) => x.filter(Boolean).join(' ')).join(' | ') === '8 h 7 min asleep 55 40 | 15 h 53 min awake 95 40' : true;
      good = ok(r && r.rows && a + w === rec && want, `G16 ${id} rendered: rows ${r && r.slp.map((x) => x.filter(Boolean).join(' ')).join(' | ')}; ${a} + ${w} = ${a + w} against Recorded ${rec}`) && good;
      good = ok(!p.errors.length, `G16 ${id}: no page errors ${p.errors.join(' | ')}`) && good;
      await close(p);
    }
    return good;
  },
  // G9: viewer days from local midnight, not from the first recording.
  G9: async () => {
    const p = await seeded(weekFiles({ over: { 0: (i) => i >= 494 ? pat(i) : null } }), '#/day/' + D8, { flag: true }); await chartReady(p);
    const r = await prep(p, D8);
    const g = await p.evaluate(async (isos) => { const q = await new Promise((res) => { const o = indexedDB.open('hr_monitor_kv', 2); o.onsuccess = () => res(o.result); }); const get = (k) => new Promise((res) => { const x = q.transaction('kv').objectStore('kv').get(k); x.onsuccess = () => res(x.result); }); const a = await get('s63:real:' + isos[0]), b = await get('s63:real:' + isos[1]); q.close(); return { v0: a && a.valid, h0: b && b.hr[0], n: b && b.hr.length }; }, [WD(0), WD(1)]);
    const good = ok(g.v0 === 946 && g.h0 === 55 && g.n === 1440 && r && r.sleep && r.sleep.asleep === 487, `G9 day 1 starts 08:14: stored day 1 valid ${g.v0}, day 2 minute 0 ${g.h0}, length ${g.n}, day 8 Asleep ${r && r.sleep && r.sleep.asleep} (want 946, 55, 1440, 487)`);
    await close(p);
    return good;
  },
  // G10: a grown file rebuilds only its day; the same files under a zone one hour east rebuild every digest.
  G10: async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 's63-g10-'));
    let good = true;
    try {
      const base = { over: { 3: (i) => i < 1380 ? pat(i) : null } }, grown = { over: { 3: (i) => i < 1385 ? pat(i) : null } };
      let p = await newPage({ dir, flag: true });
      await seedInto(p, weekFiles(base));
      await p.goto(viewerUrl() + '#/day/' + D8, { waitUntil: 'networkidle' }); await chartReady(p);
      const r1 = await prep(p, D8), c1 = await counter(p);
      const old4 = fileOfDay(weekFiles(base), 3)[0], new4 = weekFiles(grown);
      await p.evaluate(async (n) => { const db = await new Promise((res) => { const q = indexedDB.open('hr_monitor_kv', 2); q.onsuccess = () => res(q.result); }); await new Promise((res) => { const tx = db.transaction('drive-cache', 'readwrite'); tx.objectStore('drive-cache').delete(n); tx.oncomplete = res; }); db.close(); }, old4);
      await seedInto(p, { [fileOfDay(new4, 3)[0]]: new4[fileOfDay(new4, 3)[0]] });
      await p.goto(viewerUrl() + '#/day/' + D8, { waitUntil: 'networkidle' }); await chartReady(p);
      const sigs = async () => p.evaluate(async () => { const db = await new Promise((res) => { const q = indexedDB.open('hr_monitor_kv', 2); q.onsuccess = () => res(q.result); }); const st = db.transaction('kv').objectStore('kv'); const keys = await new Promise((res) => { const r = st.getAllKeys(); r.onsuccess = () => res(r.result.filter((k) => String(k).startsWith('s63:'))); }); const out = {}; for (const k of keys) out[k] = await new Promise((res) => { const r = db.transaction('kv').objectStore('kv').get(k); r.onsuccess = () => res(r.result.sig); }); db.close(); return out; });
      const s1 = await sigs();
      const r2 = await prep(p, D8), c2 = await counter(p), s2 = await sigs();
      const changed = Object.keys(s2).filter((k) => s1[k] !== s2[k]);
      good = ok(r1 && r1.rows && c1.digest === 9 && c2.digest === 1 && changed.length === 1 && changed[0] === 's63:real:' + WD(3), `G10 a day-4 file grows by 60 rows: first report ${c1.digest} digests, second ${c2.digest}, changed keys ${changed.map((k) => k.slice(-5)).join(', ')} (want 9, 1, day 4 only)`) && good;
      await close(p);
      p = await newPage({ dir, flag: true, tz: 'America/Chicago' });
      await p.goto(viewerUrl() + '#/day/' + D8, { waitUntil: 'networkidle' }); await chartReady(p);
      const r3 = await prep(p, D8), c3 = await counter(p);
      good = ok(r3 && c3.digest === 9, `G10 the same files one hour east: ${c3.digest} digests rebuilt (want 9, every one)`) && good;
      good = ok(!p.errors.length, `G10: no page errors ${p.errors.join(' | ')}`) && good;
      await close(p);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    return good;
  },
  // G11: a supplied source prints with the flag cleared.
  G11: async () => {
    const p = await seeded(weekFiles(), '#/day/' + D8, { flag: false }); await chartReady(p);
    const mask = Array.from({ length: 1440 }, (_, i) => i >= 120 && i < 300 ? 1 : 0);
    const r = await p.evaluate(async ({ iso, mask }) => { const x = await window.__aortiReport.prepare(iso, { sleep: { source: 'health-connect', mask: Uint8Array.from(mask) } }); return { rows: x.rows, slp: [...document.querySelectorAll('#rpg1 tr.slp')].map((tr) => tr.children[0].textContent.trim()) }; }, { iso: D8, mask });
    const good = ok(r.rows && r.slp[0] === '3 h asleep', `G11 flag cleared, Health Connect mask 02:00 to 05:00: rows ${r.rows}, first "${r.slp[0]}" (want true, "3 h asleep")`);
    await close(p);
    return good;
  },
  // G13: nobody else pays: flag cleared, Day open then a full report.
  G13: async () => {
    const p = await seeded(weekFiles(), '#/day/' + D8, { flag: false }); await chartReady(p);
    await p.waitForTimeout(500);
    const r = await prep(p, D8), keys = await s63Keys(p);
    const good = ok(r && !r.rows && !r.slp.length && r.c.digest === 0 && r.c.detect === 0 && keys.length === 0, `G13 flag cleared: rows ${r && r.slp.length}, __s63 ${JSON.stringify(r && r.c)}, s63 keys ${keys.length} (want 0, 0 and 0, 0)`);
    await close(p);
    return good;
  },
  // G15: demo digests live in memory; no s63 IndexedDB read or write.
  G15: async () => {
    const init = () => {
      window.__s63Idb = [];
      for (const fn of ['get', 'put', 'delete', 'add']) { const o = IDBObjectStore.prototype[fn]; IDBObjectStore.prototype[fn] = function (...a) { const k = fn === 'put' || fn === 'add' ? a[1] : a[0]; if (typeof k === 'string' && k.startsWith('s63:')) window.__s63Idb.push(fn + ' ' + k); return o.apply(this, a); }; }
    };
    const p = await demoPage('2026-04-24', { flag: true, init }); await chartReady(p);
    const a = await prep(p, '2026-04-24'), b = await prep(p, '2026-04-24'), idb = await p.evaluate(() => window.__s63Idb);
    const good = ok(a && a.rows && b && b.rows && b.c.digest === a.c.digest && idb.length === 0, `G15 demo 04-24 twice with the flag on: rows ${a && a.rows} and ${b && b.rows}, digests ${a && a.c.digest} then ${b && b.c.digest}, s63 IndexedDB calls ${idb.length}${idb.length ? ' (' + idb[0] + ')' : ''} (want rows, no new digest, 0 calls)`);
    await close(p);
    return good;
  },
  // G17: a growing day is never cached; yesterday prints only after its 6 h margin.
  G17: async () => {
    let good = true;
    const at = (h) => dayStart(WD(8)) + h * 3600000;
    const p1 = await seeded(weekFiles({ over: { 8: (i) => i < 60 ? pat(i) : null } }), '#/day/' + D8, { flag: true, clock: at(1) }); await chartReady(p1);
    const r1 = await prep(p1, D8), k1 = await s63Keys(p1);
    await close(p1);
    const p2 = await seeded(weekFiles({ over: { 8: (i) => i < 420 ? pat(i) : null } }), '#/day/' + D8, { flag: true, clock: at(7) }); await chartReady(p2);
    const r2 = await prep(p2, D8), k2 = await s63Keys(p2);
    const today = 's63:real:' + WD(8);
    good = ok(r1 && !r1.rows && r1.c.digest === 0 && r2 && r2.rows && !k1.includes(today) && !k2.includes(today) && k2.length === 8, `G17 report yesterday at 01:00 / at 07:00: rows ${r1 && r1.rows} / ${r2 && r2.rows}, digests ${r1 && r1.c.digest} / ${r2 && r2.c.digest}, today's key written ${k1.includes(today) || k2.includes(today)}, keys ${k2.length} (want false / true, 0 / 9, false, 8)`) && good;
    await close(p2);
    return good;
  },
  // G18: a day with no files is a null digest, nothing stored, no throw.
  G18: async () => {
    const p = await seeded(weekFiles({ drop: [0] }), '#/day/' + D8, { flag: true }); await chartReady(p);
    let r = null, err = null;
    try { r = await prep(p, D8); } catch (e) { err = e.message; }
    const keys = await s63Keys(p);
    const good = ok(!err && r && r.rows && !keys.includes('s63:real:' + WD(0)) && !p.errors.length, `G18 day 1 has no files: ${err ? 'threw ' + err.slice(0, 80) : 'rows ' + (r && r.rows)}, day 1 key ${keys.includes('s63:real:' + WD(0))} (want rows, no key, no throw)`);
    await close(p);
    return good;
  },
  // G19: a day whose file does not load is never stored; the next report after it loads stores it.
  G19: async () => {
    const files = weekFiles(), n4 = fileOfDay(files, 3)[0];
    const p = await seeded(files, '#/day/' + D8, { flag: true }); await chartReady(p);
    const del = (n) => p.evaluate(async (n) => { const db = await new Promise((res) => { const q = indexedDB.open('hr_monitor_kv', 2); q.onsuccess = () => res(q.result); }); await new Promise((res) => { const tx = db.transaction('drive-cache', 'readwrite'); tx.objectStore('drive-cache').delete(n); tx.oncomplete = res; }); db.close(); }, n);
    const put = (n, v) => p.evaluate(async ({ n, v }) => { const db = await new Promise((res) => { const q = indexedDB.open('hr_monitor_kv', 2); q.onsuccess = () => res(q.result); }); await new Promise((res) => { const tx = db.transaction('drive-cache', 'readwrite'); tx.objectStore('drive-cache').put(v, n); tx.oncomplete = res; }); db.close(); }, { n, v });
    await del(n4);
    const r1 = await prep(p, D8), k1 = await s63Keys(p), failedSeen = p.warns.some((w) => w.includes('[buildDaySession] load failed') && w.includes(n4));
    await put(n4, files[n4]);
    const r2 = await prep(p, D8), k2 = await s63Keys(p);
    const key = 's63:real:' + WD(3);
    const good = ok(failedSeen && r1 && !r1.rows && !r1.sleep && !k1.includes(key) && r2 && r2.rows && k2.includes(key), `G19 day 4's file removed from the Drive cache then restored: load failure seen ${failedSeen}, first rows ${r1 && r1.rows} key ${k1.includes(key)}, second rows ${r2 && r2.rows} key ${k2.includes(key)} (want true, false false, true true)`);
    await close(p);
    return good;
  },
  // G19b: a 12-file day; the first file's second read fails (the cache holds 8, so it was evicted after the Day view read it).
  G19b: async () => {
    const files = weekFiles({ split12: 7 }), n1 = fileOfDay(files, 7)[0];
    const p = await seeded(files, '#/day/' + D8, { flag: true }); await chartReady(p);
    await p.evaluate(async (n) => { const db = await new Promise((res) => { const q = indexedDB.open('hr_monitor_kv', 2); q.onsuccess = () => res(q.result); }); await new Promise((res) => { const tx = db.transaction('drive-cache', 'readwrite'); tx.objectStore('drive-cache').delete(n); tx.oncomplete = res; }); db.close(); }, n1);
    const r = await prep(p, D8), keys = await s63Keys(p), failedSeen = p.warns.some((w) => w.includes('[buildDaySession] load failed') && w.includes(n1));
    const key = 's63:real:' + D8;
    const good = ok(fileOfDay(files, 7).length === 12 && failedSeen && r && !r.rows && !keys.includes(key), `G19b day 8 in ${fileOfDay(files, 7).length} files, first file gone before its second read: failure seen ${failedSeen}, rows ${r && r.rows}, day 8 key ${keys.includes(key)} (want 12, true, false, false)`);
    await close(p);
    return good;
  },
  // G20: rows yield to moments at the page-1 limit; the moment list matches 02aef18 exactly. Symptom taps a minute apart
  // at 03:00 stack as chart lanes (11 px each) inside one moment, so the room steps down without merging moments.
  G20: async () => {
    const iso = '2026-04-24', files = {};
    for (const n of JSON.parse(fs.readFileSync(path.join(ROOT, 'demo', 'manifest.json'), 'utf8')).files) files[n] = { file: path.join(ROOT, 'demo', n) };
    const o = await seeded(files, '#/day/' + iso, { flag: true, old: true }); await chartReady(o);
    await o.waitForFunction(() => window.AortiMarksPage && window.AortiMarksPage.store, null, { timeout: 15000 });
    const ds = dayStart(iso);
    let ro = null, n = 0;
    for (; n < 40; n++) {
      ro = await prep(o, iso);
      if (ro && ro.room >= 8 && ro.room <= 29 && n >= 1) break;
      await o.evaluate(({ at }) => window.AortiMarksPage.store.createTap({ at, cls: 'sym', label: 'dizzy' }), { at: ds + 3 * 3600000 + n * 60000 });
      await o.waitForTimeout(150);
    }
    // The working viewer in its own profile, with the same taps.
    const op = o;
    const p = await seeded(files, '#/day/' + iso, { flag: true }); await chartReady(p);
    await p.waitForFunction(() => window.AortiMarksPage && window.AortiMarksPage.store, null, { timeout: 15000 });
    for (let k = 0; k < n; k++) await p.evaluate(({ at }) => window.AortiMarksPage.store.createTap({ at, cls: 'sym', label: 'dizzy' }), { at: ds + 3 * 3600000 + k * 60000 });
    await p.waitForTimeout(300);
    const a = await prep(op, iso), b = await prep(p, iso);
    let good = ok(a && a.room >= 8 && a.room <= 29, `G20 ${n} symptom taps leave 02aef18's page 1 with ${a && Math.round(a.room)} px (want 8 to 29)`);
    good = ok(b && b.sleep && b.sleep.weights === 'personal', `G20 the split is on for this day: d.sleep ${JSON.stringify(b && b.sleep)}`) && good;
    good = ok(b && a && b.keep === a.notZoomed && b.notZoomed === a.notZoomed && norm(b.idx) === norm(a.idx) && norm(b.more) === norm(a.more) && b.rows === false, `G20 keep ${b && b.keep} (02aef18 lists ${a && a.notZoomed} unzoomed), index table ${b && a && norm(b.idx) === norm(a.idx) ? 'equal' : 'differs'}, "Also on this day" ${b && a && norm(b.more) === norm(a.more) ? 'equal' : 'differs'}, rows ${b && b.rows} (want equal, equal, equal, false)`) && good;
    // day-report check 2 rule: page 1 content never reaches the footer.
    good = ok(b && b.room >= 0, `G20 page 1 content clear of the footer: ${b && Math.round(b.room)} px`) && good;
    good = ok(!p.errors.length && !op.errors.length, `G20: no page errors ${p.errors.concat(op.errors).join(' | ')}`) && good;
    await close(p); await close(op);
    return good;
  },
  // G21: a concurrent { sleep: false } model call inside rptPrepare's font wait leaves the prepared rows in place.
  G21: async () => {
    const p = await seeded(weekFiles(), '#/day/' + D8, { flag: true }); await chartReady(p);
    const r = await p.evaluate(async (iso) => {
      const fonts = document.fonts, orig = fonts.load.bind(fonts);
      let fired = 0;
      fonts.load = async (...a) => { if (!fired++) await window.__aortiReport.model(iso, { sleep: false }); return orig(...a); };
      try { const x = await window.__aortiReport.prepare(iso); return { rows: x.rows, slp: document.querySelectorAll('#rpg1 tr.slp').length, fired }; } finally { fonts.load = orig; }
    }, D8);
    const good = ok(r.fired > 0 && r.rows && r.slp === 2, `G21 menu model call resolved inside the font wait: fired ${r.fired}, rows ${r.rows}, ${r.slp} split rows (want rows, 2)`);
    await close(p);
    return good;
  },
};
const norm = (h) => String(h).replace(/\b(rzg|rhx|rlh|rlx|rmg|rmh)\d+\b/g, '$1#');
function normIds(h) {
  const map = new Map();
  return String(h).replace(/\b(rzg|rhx|rlh|rlx|rmg|rmh)(\d+)\b/g, (all, p, d) => { const k = p + d; if (!map.has(k)) map.set(k, p + '_' + map.size); return map.get(k); });
}

async function partGolden(src, only) {
  const want = (g) => (!only || only.includes(g)) && (!ONLY || ONLY.includes(g));
  let good = true;
  const B = cut(src);
  for (const [g, f] of Object.entries(NODE_GOLDENS)) if (want(g)) good = f(B) && good;
  SERVED = src;
  for (const [g, f] of Object.entries(BROWSER_GOLDENS)) if (want(g)) {
    try { good = (await f()) && good; } catch (e) { good = ok(false, `${g} threw ${e.message.split('\n')[0]}`) && good; }
  }
  return good;
}

// ---------- manifest inputs ----------
let MAN = null, EXP = null;
const sha1 = (b) => crypto.createHash('sha1').update(b).digest('hex');
function loadManifest(full) {
  if (MAN) return MAN;
  need(MANIFEST); need(EXPECT);
  MAN = JSON.parse(fs.readFileSync(MANIFEST, 'utf8')); EXP = JSON.parse(fs.readFileSync(EXPECT, 'utf8'));
  const lines = [];
  for (const f of MAN.files) {
    const p = path.join(HOME, f.from);
    if (!fs.existsSync(p)) { console.log('MISSING ' + p); process.exit(2); }
    if (full) { const h = sha1(fs.readFileSync(p)); if (h !== f.sha1) { console.log('data changed, re-freeze: ' + f.name); process.exit(2); } }
    else if (fs.statSync(p).size !== f.size) { console.log('data changed, re-freeze: ' + f.name); process.exit(2); }
    lines.push(f.name + ':' + f.sha1);
  }
  if (sha1(lines.join('\n')) !== MAN.setSha1) { console.log('data changed, re-freeze: set'); process.exit(2); }
  return MAN;
}
function loadKey() {
  loadManifest(false);
  for (const k of [MAN.key, MAN.keyScript]) { const p = path.join(HOME, k.from); need(p); if (sha1(fs.readFileSync(p)) !== k.sha1) { console.log('data changed, re-freeze: ' + k.name); process.exit(2); } }
  return createRequire(import.meta.url)(path.join(HOME, MAN.keyScript.from));
}
// Manifest files whose start falls in [from, to) epochs (v2 by UTC hour, v1 by its name's start).
function filesBetween(fromMs, toMs) {
  const out = {};
  for (const f of loadManifest(false).files) {
    let ep;
    const v2 = /^hrm_(\d{4})(\d{2})(\d{2})T(\d{2})Z_/.exec(f.name);
    if (v2) ep = Date.UTC(+v2[1], +v2[2] - 1, +v2[3], +v2[4]);
    else { const m = /^hrv_session_(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})(\.\d{3})?\.csv$/.exec(f.name); if (!m) continue; ep = m[7] ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime() : Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]); }
    if (ep >= fromMs && ep < toMs) out[f.name] = { file: path.join(HOME, f.from) };
  }
  return out;
}
const realWeek = (iso) => filesBetween(dayStart(addDays(iso, -9)), dayStart(addDays(iso, 2)));

// ---------- replay ----------
async function partReplay(src) {
  const man = loadManifest(true), exp = EXP, K = loadKey().key();
  const B = cut(src);
  const sa = src.indexOf('  const SEG_NAME_RE'), sb = src.indexOf('  // Compact span view of one segment');
  if (sa < 0 || sb < sa) throw new Error('segment parser markers missing');
  const parseSegmentV2 = new Function(src.slice(sa, sb) + ';return parseSegmentV2;')();
  const t0 = Date.now();
  // Seconds: v2 rows first, then v1 files largest first; the first reading of a second wins.
  const sec = new Map(), beats = [];
  for (const f of man.files.filter((x) => x.kind === 'v2')) {
    const seg = parseSegmentV2(fs.readFileSync(path.join(HOME, f.from), 'utf8'), f.name);
    if (!seg) continue;
    for (const r of seg.rows) {
      if (r.k !== 'h') continue;
      beats.push({ ep: r.ep, hr: +r.f[0] || 0, rr: r.f[2] });
      const hr = +r.f[0]; if (!(hr > 0)) continue;
      const s = Math.round(r.ep / 1000);
      if (!sec.has(s)) sec.set(s, { hr, rm: +r.f[1] > 0 ? +r.f[1] : null });
    }
  }
  for (const f of man.files.filter((x) => x.kind === 'v1').sort((p, q) => q.size - p.size)) {
    const L = fs.readFileSync(path.join(HOME, f.from), 'utf8').split(/\r?\n/);
    const hdr = L[0].split(',').map((s) => s.trim());
    const iT = hdr.indexOf('time_min'), iE = hdr.indexOf('epoch_ms'), iH = hdr.indexOf('hr_bpm'), iR = hdr.indexOf('rmssd_ms');
    if (iT < 0 || iH < 0) continue;
    const m = f.name.match(/^hrv_session_(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})(\.\d{3})?\.csv$/);
    const start = !m ? 0 : m[7] ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6], +m[7].slice(1)).getTime() : Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
    for (let i = 1; i < L.length; i++) {
      const c = L[i].split(','); if (c.length < hdr.length - 1) continue;
      const tm = parseFloat(c[iT]); let ep = iE >= 0 && c[iE] !== '' ? parseFloat(c[iE]) : NaN;
      if (!isFinite(ep)) { if (!start || !isFinite(tm)) continue; ep = start + tm * 60000; }
      const hr = c[iH] !== '' ? parseFloat(c[iH]) : NaN; if (!(hr > 0)) continue;
      const s = Math.round(ep / 1000); if (sec.has(s)) continue;
      const rm = iR >= 0 && c[iR] !== '' ? parseFloat(c[iR]) : NaN;
      sec.set(s, { hr, rm: rm > 0 ? rm : null });
    }
  }
  beats.sort((p, q) => p.ep - q.ep);
  const keys = [...sec.keys()].sort((p, q) => p - q);
  const isoOf = (ms) => { const d = new Date(ms); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
  const first = isoOf(keys[0] * 1000), last = isoOf(keys[keys.length - 1] * 1000);
  const days = []; for (let iso = first; iso <= last; iso = addDays(iso, 1)) days.push(iso);
  // Digests per viewer day through the shipped block.
  const dig = {};
  let ki = 0, bi = 0;
  for (const iso of days) {
    const ds = dayStart(iso), n = dayLen(iso), de = ds + n * 60000;
    while (ki < keys.length && keys[ki] * 1000 < ds) ki++;
    const hp = [], rp = [];
    for (let j = ki; j < keys.length && keys[j] * 1000 < de; j++) { const v = sec.get(keys[j]); hp.push({ ep: keys[j] * 1000, y: v.hr }); if (v.rm != null) rp.push({ ep: keys[j] * 1000, y: v.rm }); }
    while (bi < beats.length && beats[bi].ep < ds - 120000) bi++;
    let bj = bi; while (bj < beats.length && beats[bj].ep < de) bj++;
    const bs = beats.slice(bi, bj);
    dig[iso] = hp.length ? B.s63Digest(hp, rp, bs.length ? [{ ep: Float64Array.from(bs.map((x) => x.ep)), hr: Uint16Array.from(bs.map((x) => x.hr)), rr: bs.map((x) => x.rr) }] : [], ds, n) : null;
  }
  const tDig = Date.now() - t0;
  // Labels from the rules in replay-expect.json and the key read at run time.
  const LB = exp.labels, TZH = LB.tz;
  const loc = (s) => Date.parse(s.replace(' ', 'T') + ':00Z') / 1000 - TZH * 3600;
  const T0s = dayStart(first) / 1000, M = Math.round((dayStart(addDays(last, 1)) / 1000 - T0s) / 60);
  const mOf = (s) => Math.floor((s - T0s) / 60);
  const monthOf = (m) => new Date((T0s + m * 60 + TZH * 3600) * 1000).toISOString().slice(0, 7);
  const split = (m) => { const mo = monthOf(m); return mo >= LB.train[0] && mo <= LB.train[1] ? 'train' : mo >= LB.heldOut[0] && mo <= LB.heldOut[1] ? 'test' : 'none'; };
  const KA = loc(LB.keyFrom), KB = loc(LB.keyTo);
  const lab = new Int8Array(M).fill(-1), valid = new Uint8Array(M);
  for (let m = 0; m < M; m++) { const s = T0s + m * 60; if (s >= KA && s < KB) lab[m] = 0; }
  const P = K.periods.filter((p) => p.b > KA - 86400 && p.a < KB);
  for (let i = 1; i < P.length; i++) if (P[i].a - P[i - 1].b > LB.gapUnlabelledOverH * 3600) for (let m = Math.max(0, mOf(P[i - 1].b)); m < Math.min(M, mOf(P[i].a)); m++) lab[m] = -1;
  for (const p of P) for (let m = Math.max(0, mOf(p.a)); m < Math.min(M, mOf(p.b)); m++) { const s = T0s + m * 60; if (s >= KA && s < KB) lab[m] = 1; }
  for (const [a, b] of LB.unscored) for (let m = mOf(loc(a)); m <= mOf(loc(b)); m++) if (m >= 0 && m < M) lab[m] = -1;
  const idxOf = (iso) => Math.round((dayStart(iso) / 1000 - T0s) / 60);
  for (const iso of days) if (dig[iso]) { const o = idxOf(iso); for (let i = 0; i < dig[iso].hr.length; i++) if (dig[iso].hr[i] === dig[iso].hr[i]) valid[o + i] = 1; }
  // Gate and detector per day, both weight sets.
  const todayIso = LB.keyTo.slice(0, 10);
  const open = {}, shut = [];
  for (const iso of days) {
    const g = dig[iso]; if (!g) continue;
    const back = [-6, -5, -4, -3, -2, -1, 0].map((k) => dig[addDays(iso, k)] || null);
    const base = B.s63Baseline(back);
    open[iso] = B.s63Completed(iso, todayIso, 1440) && B.s63Gate(back.map((x) => x ? x.valid : 0)) && !!base;
    if (!open[iso] && g.valid >= 60 && iso < todayIso) shut.push(iso);
  }
  const res = {}, perDay = [];
  let detMs = 0, detN = 0;
  for (const set of ['personal', 'general']) {
    const st = new Int8Array(M).fill(-1), asl = {};
    for (const iso of days) {
      if (!open[iso]) continue;
      const g = dig[iso], prev = dig[addDays(iso, -1)] || null, next = dig[addDays(iso, 1)] || null;
      const bCur = B.s63Baseline([-6, -5, -4, -3, -2, -1, 0].map((k) => dig[addDays(iso, k)] || null)), bPrev = B.s63Baseline([-7, -6, -5, -4, -3, -2, -1].map((k) => dig[addDays(iso, k)] || null));
      const t = performance.now();
      const mask = B.s63Detect({ prev, cur: g, next }, { prev: bPrev, cur: bCur }, set);
      detMs += performance.now() - t; detN++;
      const o = idxOf(iso);
      let a = 0;
      // Every minute of an open day takes the mask (bridged gaps stay asleep, so bouts run on as in the reference).
      for (let i = 0; i < mask.length; i++) { st[o + i] = mask[i]; if (mask[i] && valid[o + i]) a++; }
      asl[iso] = a;
    }
    res[set] = { st, asl };
  }
  // Scores (the reference's rules, s63-sleep/proto/s63ref.cjs).
  const q = (a, f) => { if (!a.length) return null; const s = a.slice().sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(f * s.length))]; };
  function kappa(st, keep) {
    let tp = 0, fn = 0, tn = 0, fp = 0;
    for (let m = 0; m < M; m++) { if (!valid[m] || lab[m] < 0 || st[m] < 0 || !keep(m)) continue; if (lab[m]) st[m] ? tp++ : fn++; else st[m] ? fp++ : tn++; }
    const n = tp + fn + tn + fp; if (!n) return null; const po = (tp + tn) / n, pe = ((tp + fn) * (tp + fp) + (tn + fp) * (tn + fn)) / (n * n);
    return +((po - pe) / (1 - pe)).toFixed(3);
  }
  const bouts = (st) => { const r = []; let a = -1; for (let m = 0; m <= M; m++) { const v = m < M ? st[m] : 0; if (v === 1 && a < 0) a = m; if (v !== 1 && a >= 0) { r.push([a, m - 1]); a = -1; } } return r; };
  const cov = (a, b) => { let c = 0; for (let m = a; m <= b; m++) if (m >= 0 && m < M && valid[m]) c++; return c / (b - a + 1); };
  function periods(st, which) {
    const Bs = bouts(st), on = [], off = []; let n = 0, hit = 0;
    for (const p of P) {
      const a = mOf(p.a), b = mOf(p.b) - 1;
      if (a < 0 || b >= M || p.fault || split(a) !== which || lab[a] < 0 || cov(a, b) < LB.periodMinCoverage) continue;
      let sl = 0, c = 0, sc = 0; for (let m = a; m <= b; m++) if (valid[m]) { c++; if (st[m] >= 0) sc++; if (st[m] === 1) sl++; }
      if (sc < 0.5 * c) continue;
      n++;
      const ov = Bs.filter(([x, y]) => Math.min(y, b) - Math.max(x, a) > 0);
      if (sl / c >= 0.5 && ov.length) { hit++; if (cov(a - 30, a + 30) >= 0.6) on.push(ov[0][0] - a); if (cov(b - 30, b + 30) >= 0.6) off.push(ov[ov.length - 1][1] + 1 - (b + 1)); }
    }
    let iso = 0, early = 0;
    for (const [x, y] of Bs) {
      if (split(x) !== which || lab[x] < 0) continue;
      let s = 0, c = 0; for (let m = x; m <= y; m++) if (lab[m] >= 0) { c++; if (lab[m] === 1) s++; }
      if (c && s / c < 0.1) { iso++; continue; }
      let r = 0; for (let m = x; m <= y + 1; m++) { if (m <= y && lab[m] === 0 && valid[m]) r++; else { if (r >= 90) early++; r = 0; } }
    }
    return { hit, n, onP90: q(on.map(Math.abs), 0.9), isolated: iso, attached90: early };
  }
  function dayHours(st, which) {
    const by = {};
    for (let m = 0; m < M; m++) { if (!valid[m] || lab[m] < 0 || st[m] < 0 || split(m) !== which) continue; const d = Math.floor(m / 1440); const o = by[d] = by[d] || { n: 0, t: 0, p: 0 }; o.n++; if (lab[m]) o.t++; if (st[m]) o.p++; }
    const e = Object.values(by).filter((o) => o.n >= 1200).map((o) => Math.abs(o.p - o.t) / 60);
    return { days: e.length, medAbs: e.length ? +q(e, 0.5).toFixed(2) : null, within1h: e.filter((x) => x <= 1).length };
  }
  const CA = mOf(loc(LB.calendarWeek[0])), CB = mOf(loc(LB.calendarWeek[1]));
  let good = true;
  const first_green = {};
  for (const set of ['personal', 'general']) {
    const st = res[set].st, b = exp.bands[set];
    const k = { heldOut: kappa(st, (m) => split(m) === 'test'), noCal: kappa(st, (m) => split(m) === 'test' && (m < CA || m >= CB)), train: kappa(st, (m) => split(m) === 'train') };
    const pr = periods(st, 'test'), dh = dayHours(st, 'test');
    first_green[set] = { kappa: k, periods: pr, days: dh };
    const inB = (v, [lo, hi]) => v != null && v >= lo && v <= hi;
    good = ok(inB(k.heldOut, b.heldOutKappa) && inB(k.noCal, b.heldOutNoCalendarWeekKappa) && inB(k.train, b.trainKappa), `replay ${set}: kappa held-out ${k.heldOut}, without the calendar week ${k.noCal}, train ${k.train} inside their bands`) && good;
    good = ok(pr.hit >= b.periodsFoundAtLeast && pr.isolated <= b.isolatedFalseAtMost && pr.attached90 <= b.attached90AtMost && pr.onP90 != null && pr.onP90 <= b.onsetP90AtMostMin, `replay ${set}: periods found ${pr.hit}/${pr.n}, isolated false ${pr.isolated}, attached runs ${pr.attached90}, onset P90 ${pr.onP90} min inside their bands`) && good;
    good = ok(dh.within1h >= b.daysWithin1hAtLeast && dh.medAbs != null && dh.medAbs <= b.daysMedAbsAtMostH, `replay ${set}: days within 1 h ${dh.within1h} of ${dh.days}, median day error ${dh.medAbs} h inside their bands`) && good;
  }
  const mustShut = exp.shutMustInclude || [], [sLo, sHi] = exp.shutCountRange || [0, Infinity];
  good = ok(mustShut.every((x) => shut.includes(x)) && shut.length >= sLo && shut.length <= sHi, `replay: ${shut.length} shut days, the two named in replay-expect.json shut ${mustShut.every((x) => shut.includes(x))} (count band ${sLo} to ${sHi})`) && good;
  // Per-day rows stay in the gitignored ux-audit folder.
  for (const iso of days) if (dig[iso]) {
    const o = idxOf(iso); let key = 0; for (let i = 0; i < dig[iso].hr.length; i++) if (lab[o + i] === 1 && valid[o + i]) key++;
    perDay.push([iso, (dig[iso].valid / 60).toFixed(1), open[iso] ? 'open' : 'shut', res.personal.asl[iso] != null ? (res.personal.asl[iso] / 60).toFixed(1) : '', res.general.asl[iso] != null ? (res.general.asl[iso] / 60).toFixed(1) : '', (key / 60).toFixed(1)].join('\t'));
  }
  if (!QUIET) {
    fs.mkdirSync(path.join(S63, 'out'), { recursive: true });
    fs.writeFileSync(path.join(S63, 'out', 'replay-days.txt'), 'day\tvalid h\tgate\tasleep h personal\tasleep h general\tkey h\n' + perDay.join('\n') + '\n');
    fs.writeFileSync(path.join(S63, 'out', 'replay-first-green.json'), JSON.stringify({ shut: shut.length, ...first_green, digestsMs: tDig, detectMsPerDay: +(detMs / Math.max(1, detN)).toFixed(2) }, null, 1));
    console.log(`replay: ${days.length} days, digests ${(tDig / 1000).toFixed(1)} s, detector ${(detMs / Math.max(1, detN)).toFixed(2)} ms a day; per-day rows in s63-sleep/out/replay-days.txt`);
  }
  return good;
}

// ---------- same: 02aef18 beside the working file ----------
// noSleep: the S64 sleep band, its markers and the Posture & sleep section left out (flag on, where S64 changes them).
const VIEW_PIECES = (noSleep) => {
  const txt = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : '');
  const ch = Chart.getChart(document.querySelector('#view-day #session-chart'));
  const strip = (o) => JSON.stringify(o, (k, v) => typeof v === 'function' ? undefined : v);
  const view = document.querySelector('#view-day').cloneNode(true);
  view.querySelectorAll('#insight-text').forEach((e) => e.remove());
  if (noSleep) view.querySelectorAll('#marker-list, #markers-toggle .n, #markers-open .n').forEach((e) => e.remove());
  const ov = ch ? ch.config.options.plugins.hrOverlays : null;
  return {
    tiles: txt(document.querySelector('#view-day #summary-grid')),
    view: txt(view),
    datasets: ch ? ch.data.datasets.map((d) => (d.label || '') + ':' + strip(d.data)) : [],
    overlays: !ov ? '' : noSleep ? strip({ overlays: (ov.overlays || []).filter((o) => !/^<b>Sleep window/.test(o.html)) }) : strip(ov),
    insight: [...document.querySelectorAll('#view-day #insight-text .insight-section[data-key]')].filter((s) => !noSleep || s.dataset.key !== 'posture').map((s) => s.dataset.key + ': ' + txt(s)),
  };
};
// Waits for the S64 task of this Day to finish (applied, kept, cancelled or skipped); returns its outcome.
const s64Done = (page, iso) => page.waitForFunction((k) => { const c = globalThis.__s64; return !!(c && c.done && c.done.startsWith(k + ' ')); }, 'day:' + iso, { timeout: 120000 }).then(() => page.evaluate(() => globalThis.__s64.done)).catch(() => null);
const reportNoSplit = (html) => normIds(String(html).replace(/<tr class="slp">.*?<\/tr>/g, ''));
async function partSame(src) {
  SERVED = src;
  const cases = [{ id: 'demo-04-24', iso: '2026-04-24', demo: true }, { id: 'demo-04-26', iso: '2026-04-26', demo: true }];
  for (const iso of ['2026-10-13', '2026-10-14']) cases.push({ id: iso.slice(5), iso, files: () => realWeek(iso) });
  let good = true;
  for (const c of cases) {
    const open = async (old, flag) => { const p = c.demo ? await demoPage(c.iso, { old, flag }) : await seeded(c.files(), '#/day/' + c.iso, { old, flag }); await chartReady(p); await p.waitForTimeout(600); if (!old) await s64Done(p, c.iso); return p; };
    const a = await open(false, true), b = await open(true, false);
    const va = await a.evaluate(VIEW_PIECES, true), vb = await b.evaluate(VIEW_PIECES, true);
    for (const k of Object.keys(va)) {
      const x = JSON.stringify(va[k]), y = JSON.stringify(vb[k]);
      let i = 0; while (i < x.length && x[i] === y[i]) i++;
      good = ok(x === y, `same ${c.id}: Day view ${k} (sleep band, its markers and Posture & sleep left out, S64) identical to ${BASE_REF}${x === y ? '' : ` at ${i}: "${x.slice(Math.max(0, i - 40), i + 60)}" vs "${y.slice(Math.max(0, i - 40), i + 60)}"`}`) && good;
    }
    const ra = await prep(a, c.iso), rb = await prep(b, c.iso);
    const x = reportNoSplit(ra.html), y = normIds(rb.html);
    let i = 0; while (i < x.length && x[i] === y[i]) i++;
    good = ok(x === y, `same ${c.id} flag on: report without the split rows byte-identical to ${BASE_REF} (split ${ra.rows ? 'printed, ' + ra.slp.map((r) => r[0]).join(' / ') : 'not printed'})${x === y ? '' : ` at ${i}: "${x.slice(Math.max(0, i - 60), i + 60)}" vs "${y.slice(Math.max(0, i - 60), i + 60)}"`}`) && good;
    good = ok(!/class="slp-shade"|<rect[^>]*class="slp/.test(ra.html), `same ${c.id}: no sleep shading on the report Day chart`) && good;
    good = ok(!a.errors.length && !b.errors.length, `same ${c.id}: no page errors ${a.errors.concat(b.errors).join(' | ')}`) && good;
    await close(a);
    if (c.id === 'demo-04-24' || c.id === '10-14') {
      const z = await open(false, false), rz = await prep(z, c.iso);
      good = ok(normIds(rz.html) === y && rz.c.digest === 0, `same ${c.id} flag cleared: whole report identical to ${BASE_REF}, ${rz.c.digest} digests`) && good;
      await close(z);
    }
    await close(b);
  }
  return good;
}

// ---------- fit: page 1 moments on every replay day with a moment ----------
async function partFit(src) {
  SERVED = src;
  const man = loadManifest(false);
  const exp = EXP;
  const months = [...new Set(man.files.map((f) => { const v2 = /^hrm_(\d{4})(\d{2})/.exec(f.name), v1 = /^hrv_session_(\d{4})-(\d{2})/.exec(f.name); return v2 ? v2[1] + '-' + v2[2] : v1 ? v1[1] + '-' + v1[2] : null; }).filter(Boolean))].sort();
  const todayIso = exp.labels.keyTo.slice(0, 10);
  let good = true, days = 0, yielded = 0, printed = 0;
  for (const mo of months.filter((m) => !MONTH || m === MONTH)) {
    const first = mo + '-01', next = addDays(mo + '-28', 4).slice(0, 7) + '-01';
    const files = filesBetween(dayStart(addDays(first, -9)), dayStart(addDays(next, 2)));
    const p = await seeded(files, '#/month', { flag: true });
    const ready = (pg) => pg.waitForFunction(() => window.__aortiReport && window.__aortiReport.dayIso(), null, { timeout: 90000 }).then(() => pg.waitForTimeout(1500)).catch(() => {});
    await ready(p);
    const list = []; for (let d = first; d < next && d < todayIso; d = addDays(d, 1)) list.push(d);
    const o = await newPage({ flag: true });
    // The old viewer reads the same profile only in its own context: seed it once.
    await seedInto(o, files);
    await o.goto(viewerUrl(true) + '#/month', { waitUntil: 'networkidle' });
    await ready(o);
    for (const iso of list) {
      const has = await p.evaluate(async (iso) => { const d = await window.__aortiReport.model(iso, { sleep: false }); return d ? d.moments.length : 0; }, iso);
      if (!has) continue;
      const b = await prep(p, iso), a = await prep(o, iso);
      if (!a || !b) { good = ok(false, `fit ${mo}: a day with a moment has no report on one side`) && good; continue; }
      days++;
      if (b.rows) printed++;
      if (b.sleep && !b.rows && b.slp.length === 0 && b.sleep.asleep >= 30) yielded++;
      const same = b.keep === a.notZoomed && norm(b.idx) === norm(a.idx) && norm(b.more) === norm(a.more);
      if (!same) good = ok(false, `fit ${mo}: one day's page 1 moments differ from ${BASE_REF} (keep ${b.keep} against ${a.notZoomed})`) && good;
      await p.evaluate(() => window.__aortiReport.clear()); await o.evaluate(() => window.__aortiReport.clear());
    }
    good = ok(!p.errors.length && !o.errors.length, `fit ${mo}: no page errors ${p.errors.concat(o.errors).slice(0, 2).join(' | ')}`) && good;
    await close(p); await close(o);
    for (const k of Object.keys(files)) SEED.delete(k);
  }
  good = ok(days > 0, `fit: ${days} days with a moment, keep, index table and "Also on this day" equal to ${BASE_REF} on every one; split printed on ${printed}, yielded to moments on ${yielded}`) && good;
  return good;
}

// ---------- share: the busy toast while digests build ----------
async function partShare(src) {
  SERVED = src;
  const p = await seeded(weekFiles(), '#/day/' + D8, { flag: true, init: () => { window.print = () => { window.__printed = (window.__printed || 0) + 1; }; } });
  await chartReady(p);
  await p.click('#export-report');
  await p.waitForSelector('#share-menu [data-act="download"]', { timeout: 10000 });
  const pre = await p.evaluate(() => [...document.querySelectorAll('.toast')].map((t) => t.textContent));
  await p.evaluate(() => {
    window.__toastAt = null;
    new MutationObserver(() => { if (window.__toastAt == null && [...document.querySelectorAll('.toast')].some((t) => /Making the report/.test(t.textContent))) window.__toastAt = performance.now(); }).observe(document.body, { subtree: true, childList: true, characterData: true });
    window.__tapAt = performance.now();
    document.querySelector('#share-menu [data-act="download"]').click();
  });
  await p.waitForFunction(() => window.__printed > 0, null, { timeout: 60000 }).catch(() => {});
  const r = await p.evaluate(() => ({ dt: window.__toastAt == null ? null : Math.round(window.__toastAt - window.__tapAt), printed: window.__printed || 0, c: globalThis.__s63.digest }));
  const good = ok(!pre.some((t) => /Making the report/.test(t)) && r.dt != null && r.dt <= 300 && r.c > 0 && r.printed === 1, `share: Making the report shown ${r.dt} ms after the Download tap while ${r.c} digests built, print called ${r.printed} (want 300 ms or less, digests, 1)`);
  await close(p);
  return good;
}

// ---------- copy ----------
const FORBIDDEN = [/\bcase\b/i, /\bevidence\b/i, /\bflare/i, /diagnos/i, /sympathetic/i, /\bclinician/i, /\bdisorder\b/i, /\babnormal/i, /stood up/i, /standing up/i, /\bexercise/i, /tachycardia/i, /orthostatic/i, /\bepisode/i, /\bPOTS\b/, /fell asleep/i, /\bwoke/i, /bedtime/i, /quality/i, /[\u2013\u2014]/, /\b\d{1,2}:\d{2}\b/, /undefined|NaN|\bnull\b/];
function keyDateCheck(src) {
  const K = loadKey().key();
  const pad = (n) => String(n).padStart(2, '0');
  const forms = (s) => { const d = new Date(s * 1000); const Y = d.getFullYear(), Mo = pad(d.getMonth() + 1), D = pad(d.getDate()), h = d.getHours(), mi = pad(d.getMinutes());
    return { full: [`${Y}-${Mo}-${D} ${pad(h)}:${mi}`, `${Y}-${Mo}-${D}T${pad(h)}:${mi}`, `${D}. ${Mo}. ${Y} ${h}:${mi}`], dates: [`${Y}-${Mo}-${D}`, `${D}. ${Mo}. ${Y}`], hm: [`${pad(h)}:${mi}`, `${h}:${mi}`] }; };
  const lines = src.split('\n');
  const hits = [];
  for (const r of K.rows) for (const s of [r.a, r.b]) {
    const f = forms(s);
    for (const x of f.full) if (src.includes(x)) hits.push(x);
    for (const ln of lines) if (f.dates.some((d) => ln.includes(d)) && f.hm.some((t) => new RegExp('(^|[^0-9])' + t.replace(':', '\\:') + '([^0-9]|$)').test(ln))) hits.push('line ' + ln.slice(0, 40));
  }
  return { hits: [...new Set(hits)], plant: forms(K.rows[0].a).full[0], rows: K.rows.length };
}
async function partCopy(src) {
  SERVED = src;
  const me = fs.readFileSync(fileURLToPath(import.meta.url), 'utf8');
  const kc = keyDateCheck(me), planted = keyDateCheck(me + '\n// ' + kc.plant);
  let good = ok(kc.rows > 0 && kc.hits.length === 0 && planted.hits.length > 0, `copy: this script holds no answer-key date-time (${kc.hits.length} found over ${kc.rows} key rows; a planted one is caught: ${planted.hits.length > 0})`);
  const cases = [{ id: 'G2', iso: D8, files: () => weekFiles() }, { id: 'demo-04-24', iso: '2026-04-24', demo: true }, { id: '10-14', iso: '2026-10-14', files: () => realWeek('2026-10-14') }];
  for (const c of cases) {
    const p = c.demo ? await demoPage(c.iso, { flag: true }) : await seeded(c.files(), '#/day/' + c.iso, { flag: true });
    await chartReady(p);
    const r = await prep(p, c.iso);
    const strings = r ? r.slp.flat().filter(Boolean) : [];
    const shape = r && r.slp.length === 2 && /^\d+ (h|min)( \d+ min)? asleep$/.test(r.slp[0][0]) && /^\d+ (h|min)( \d+ min)? awake$/.test(r.slp[1][0]) && r.slp.every((row) => row.slice(1).every((x) => x === '' || /^\d+$/.test(x)));
    const bad = strings.filter((s) => FORBIDDEN.some((re) => re.test(s)));
    good = ok(shape && !bad.length, `copy ${c.id}: split rows ${r && r.slp.length}, labels and numbers only ${!!shape}, ${bad.length} with a time, dash or banned word${bad.length ? ': ' + bad[0] : ''}`) && good;
    if (SHOTS && r && r.rows) {
      fs.mkdirSync(SHOTS, { recursive: true });
      await p.evaluate(() => { const h = document.getElementById('report-print'); h.style.position = 'static'; h.style.left = 'auto'; [...document.body.children].forEach((x) => { if (x !== h) x.style.display = 'none'; }); });
      await p.setViewportSize({ width: 1440, height: 1200 });
      await p.locator('#rpg1').screenshot({ path: path.join(SHOTS, 's63-page1-' + c.id + '.png') });
    }
    await close(p);
  }
  return good;
}

// ---------- dayview (S64): the Day view and the report disagree on sleep for the same day ----------
// Flag on and the split printing: after a report has stored the digests, the Day view band (chart overlays) adds up to the
// report's Asleep minutes, one Posture and sleep line per run. Flag cleared after a report stored digests: the Day view is byte-identical to S64_REF. The Day
// view never builds a digest: with nothing stored it keeps the old band and the S63 counters stay 0. Synthetic multi-sleep
// day: the week with day 8 also at 55 from 14:00 to 16:00. Timing: a 6x Day open of the 10-14 week with nothing stored,
// longest task against S64_REF (needs the gitignored manifest; skipped without it).
// rec: the band's recorded minutes (report minutes with a mean); min: its span, which takes in joined strap gaps.
const BAND = async () => {
  const dm = await window.__aortiReport.model(null, { sleep: false });
  const ch = Chart.getChart(document.querySelector('#view-day #session-chart'));
  const ov = ((ch && ch.config.options.plugins.hrOverlays) || {}).overlays || [];
  const band = ov.filter((o) => /^<b>Sleep window/.test(o.html));
  const lines = [...document.querySelectorAll('#view-day #insight-text .insight-section[data-key="posture"] li')].map((li) => li.firstElementChild.textContent.trim()).filter((t) => /^Sleep window/.test(t));
  const c = globalThis.__s64;
  let rec = 0;
  for (const o of band) for (let m = Math.round(o.xMin); m < Math.round(o.xMax); m++) if (dm && dm.hr[m] != null) rec++;
  return { runs: band.length, min: Math.round(band.reduce((a, o) => a + (o.xMax - o.xMin), 0)), rec, lines, atPaint: c.atPaint, done: c.done, s63: { digest: globalThis.__s63.digest, detect: globalThis.__s63.detect } };
};
// Day 8: a 5 min strap gap at 02:00 inside the night, and a second sleep from 14:00 to 16:00.
const multiSleep = () => weekFiles({ over: { 7: (i) => i >= 120 && i < 125 ? null : i < 480 ? 55 : i >= 840 && i < 960 ? 55 : pat(i) } });
// Leaves the Day and comes back in the same document (demo digests live in that document's memory).
async function reopenDay(p, iso) {
  await p.evaluate(() => { globalThis.__s64.done = null; location.hash = '#/month'; });
  await p.waitForTimeout(800);
  await p.evaluate((d) => { location.hash = '#/day/' + d; }, iso);
  await chartReady(p);
  return s64Done(p, iso);
}
async function partDayview(src, only) {
  SERVED = src;
  const want = (g) => (!only || only.includes(g)) && (!ONLY || ONLY.includes(g));
  let good = true;
  if (want('D1')) for (const c of [{ id: 'demo 04-24', iso: '2026-04-24', demo: true }, { id: 'synthetic multi-sleep day', iso: D8, files: multiSleep }]) {
    const p = c.demo ? await demoPage(c.iso, { flag: true }) : await seeded(c.files(), '#/day/' + c.iso, { flag: true });
    await chartReady(p);
    const first = await s64Done(p, c.iso), r = await prep(p, c.iso);
    const done = await reopenDay(p, c.iso), b = await p.evaluate(BAND);
    const asleep = r && r.slp[0] ? minsOf(r.slp[0][0]) : NaN;
    const lineMin = b.lines.reduce((a, t) => { const m = /(\d+):(\d{2}):(\d{2})$/.exec(t) || /(\d+):(\d{2})$/.exec(t); return a + (m ? (m.length === 4 ? +m[1] * 60 + +m[2] + +m[3] / 60 : +m[1] + +m[2] / 60) : NaN); }, 0);
    good = ok(first === 'day:' + c.iso + ' missing' && done === 'day:' + c.iso + ' applied' && r && r.rows && b.rec === asleep && b.min >= b.rec && (c.demo ? b.runs >= 1 : b.runs === 3 && b.min === b.rec + 5) && b.lines.length === b.runs && Math.round(lineMin) === b.min, `dayview D1 ${c.id}, flag on: first open ${first}, report made, reopened ${done}; Day view band ${b.rec} recorded min over a ${b.min} min span in ${b.runs} runs, ${b.lines.length} Sleep window lines (${Math.round(lineMin)} min); report Asleep ${asleep} min (want missing, applied, recorded = Asleep, ${c.demo ? '1 or more runs' : '3 runs, the 5 min strap gap joined into the night'}, one line per run)`) && good;
    good = ok(!p.errors.length, `dayview D1 ${c.id}: no page errors ${p.errors.join(' | ')}`) && good;
    if (SHOTS && c.demo) {
      fs.mkdirSync(SHOTS, { recursive: true });
      const shot = async (pg, name) => { await pg.evaluate(() => window.scrollTo(0, 0)); await pg.locator('#view-day .chart-panel').screenshot({ path: path.join(SHOTS, name) }); };
      await shot(p, 's64-day-04-24-after.png');
      const o = await demoPage(c.iso, { flag: true, old: 's64base' }); await chartReady(o);
      await prep(o, c.iso); await o.evaluate(() => { location.hash = '#/month'; }); await o.waitForTimeout(800);
      await o.evaluate((d) => { location.hash = '#/day/' + d; }, c.iso); await chartReady(o); await o.waitForTimeout(1500);
      await shot(o, 's64-day-04-24-before.png');
      await close(o);
    }
    await close(p);
  }
  if (want('D2')) {
    // D2b: the band shown first, then the flag cleared and the Day reopened in the same page: back to the old band.
    const iso = '2026-04-24';
    const seq = async (old) => {
      const p = await demoPage(iso, { old, flag: true }); await chartReady(p);
      if (!old) await s64Done(p, iso);
      await prep(p, iso);
      const done1 = old ? null : await reopenDay(p, iso);
      if (old) { await p.evaluate(() => { location.hash = '#/month'; }); await p.waitForTimeout(800); await p.evaluate((d) => { location.hash = '#/day/' + d; }, iso); await chartReady(p); }
      await p.evaluate((k) => { localStorage.removeItem(k); if (globalThis.__s64) globalThis.__s64.done = null; location.hash = '#/month'; }, LS_FLAG);
      await p.waitForTimeout(800);
      await p.evaluate((d) => { location.hash = '#/day/' + d; }, iso); await chartReady(p); await p.waitForTimeout(1500);
      p.done1 = done1;
      return p;
    };
    const a = await seq(false), b = await seq('s64base');
    const done = await s64Done(a, iso), va = await a.evaluate(VIEW_PIECES, false), vb = await b.evaluate(VIEW_PIECES, false);
    const diff = Object.keys(va).filter((k) => JSON.stringify(va[k]) !== JSON.stringify(vb[k]));
    good = ok(a.done1 === 'day:' + iso + ' applied' && done === 'day:' + iso + ' flag' && !diff.length, `dayview D2b demo 04-24: band ${a.done1}, then the flag cleared and the Day reopened: S64 ${done}, Day view differs from ${S64_REF} in ${diff.join(', ') || 'nothing'} (want applied, flag, nothing)`) && good;
    good = ok(!a.errors.length && !b.errors.length, `dayview D2b: no page errors ${a.errors.concat(b.errors).join(' | ')}`) && good;
    await close(a); await close(b);
  }
  if (want('D2')) for (const c of [{ id: 'demo 04-24', iso: '2026-04-24', demo: true }, { id: 'synthetic multi-sleep day', iso: D8, files: multiSleep }]) {
    // A report with the flag on stores the digests, then the flag is cleared and the Day reopened: stored digests must not
    // reach a flag-off Day view.
    const open = async (old) => {
      const p = c.demo ? await demoPage(c.iso, { old, flag: true }) : await seeded(c.files(), '#/day/' + c.iso, { old, flag: true });
      await chartReady(p); await prep(p, c.iso);
      p.c0 = await p.evaluate(() => globalThis.__s63 ? globalThis.__s63.digest : null);
      await p.evaluate((k) => { localStorage.removeItem(k); if (globalThis.__s64) globalThis.__s64.done = null; location.hash = '#/month'; }, LS_FLAG);
      await p.waitForTimeout(800);
      await p.evaluate((d) => { location.hash = '#/day/' + d; }, c.iso); await chartReady(p); await p.waitForTimeout(1500);
      return p;
    };
    const a = await open(false), b = await open('s64base');
    const done = await s64Done(a, c.iso);
    const va = await a.evaluate(VIEW_PIECES, false), vb = await b.evaluate(VIEW_PIECES, false);
    for (const k of Object.keys(va)) {
      const x = JSON.stringify(va[k]), y = JSON.stringify(vb[k]);
      let i = 0; while (i < x.length && x[i] === y[i]) i++;
      good = ok(x === y, `dayview D2 ${c.id}, flag off: Day view ${k} byte-identical to ${S64_REF}${x === y ? '' : ` at ${i}: "${x.slice(Math.max(0, i - 40), i + 60)}" vs "${y.slice(Math.max(0, i - 40), i + 60)}"`}`) && good;
    }
    const c63 = await a.evaluate(() => globalThis.__s63.digest);
    good = ok(done === 'day:' + c.iso + ' flag' && a.c0 > 0 && c63 === a.c0, `dayview D2 ${c.id}, flag cleared after a report stored ${a.c0} digests: S64 ${done}, digests after the reopen ${c63} (want flag, no new digest)`) && good;
    good = ok(!a.errors.length && !b.errors.length, `dayview D2 ${c.id}: no page errors ${a.errors.concat(b.errors).join(' | ')}`) && good;
    await close(a); await close(b);
  }
  if (want('D3')) {
    const p = await seeded(multiSleep(), '#/day/' + D8, { flag: true });
    await chartReady(p);
    const done = await s64Done(p, D8);
    await p.waitForTimeout(3000);
    const b = await p.evaluate(BAND), keys = await s63Keys(p);
    const zero = (x) => !!(x && x.digest === 0 && x.detect === 0);
    good = ok(zero(b.atPaint) && zero(b.s63) && keys.length === 0 && done === 'day:' + D8 + ' missing', `dayview D3 Day open with nothing stored, flag on: S63 counters at paint ${JSON.stringify(b.atPaint)}, 3 s later ${JSON.stringify(b.s63)}, s63 keys ${keys.length}, S64 ${done} (want 0 and 0, 0 and 0, 0, missing: no build, old band)`) && good;
    const r = await prep(p, D8);
    // A fresh document after the report: the stored digests give the band, still with no build.
    await p.goto('about:blank'); await p.goto(viewerUrl() + '#/day/' + D8, { waitUntil: 'networkidle' });
    await chartReady(p);
    const done2 = await s64Done(p, D8), b2 = await p.evaluate(BAND);
    const asleep = r && r.slp[0] ? minsOf(r.slp[0][0]) : NaN;
    good = ok(done2 === 'day:' + D8 + ' applied' && zero(b2.atPaint) && b2.s63.digest === 0 && b2.s63.detect === 1 && b2.rec === asleep, `dayview D3 reopened after a report: S64 ${done2}, S63 counters ${JSON.stringify(b2.s63)}, band ${b2.rec} recorded min against Asleep ${asleep} (want applied, 0 digests and 1 detector run from the stored digests, equal)`) && good;
    // A stored digest no longer matching (here deleted): the reopened Day goes back to the old band, not "kept".
    await p.evaluate(async (k) => { const db = await new Promise((res) => { const q = indexedDB.open('hr_monitor_kv', 2); q.onsuccess = () => res(q.result); }); await new Promise((res) => { const tx = db.transaction('kv', 'readwrite'); tx.objectStore('kv').delete(k); tx.oncomplete = res; }); db.close(); }, 's63:real:' + D8);
    const done3 = await reopenDay(p, D8), b3 = await p.evaluate(BAND);
    const desc = await p.evaluate(() => { const e = document.querySelector('#view-day #insight-text .insight-section[data-key="posture"] .insight-desc'); return e ? e.textContent : ''; });
    good = ok(done3 === 'day:' + D8 + ' missing' && b3.runs <= 1 && !/against its usual range/.test(desc), `dayview D3 band shown, then a stored digest gone and the Day reopened: S64 ${done3}, ${b3.runs} band runs (the old detector's), S64 description ${/against its usual range/.test(desc)} (want missing, 1 or fewer, false)`) && good;
    good = ok(!p.errors.length, `dayview D3: no page errors ${p.errors.join(' | ')}`) && good;
    await close(p);
  }
  if (want('T') && !QUIET && fs.existsSync(MANIFEST)) {
    // 6x CPU Day open with nothing stored, flag on, working file against S64_REF, alternating, three opens each.
    const iso = '2026-10-14', files = realWeek(iso);
    const openAt6x = async (old) => {
      const p = await newPage({ flag: true, init: () => { window.__lt = []; try { new PerformanceObserver((l) => l.getEntries().forEach((e) => window.__lt.push([e.startTime, e.duration]))).observe({ type: 'longtask', buffered: true }); } catch (e) {} } });
      await seedInto(p, files);
      await p.goto(viewerUrl(old) + '#/month', { waitUntil: 'networkidle' });
      await p.waitForTimeout(1500);
      const cdp = await p.ctx.newCDPSession(p);
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: 6 });
      const t0 = await p.evaluate((d) => { const t = performance.now(); location.hash = '#/day/' + d; return t; }, iso);
      await chartReady(p);
      await p.waitForTimeout(4000);
      const r = await p.evaluate((t0) => ({ lt: window.__lt.filter(([t]) => t >= t0).map(([, d]) => Math.round(d)), done: globalThis.__s64 ? globalThis.__s64.done : null, c: globalThis.__s63 ? globalThis.__s63.digest : null }), t0);
      await close(p);
      return { longest: r.lt.length ? Math.max(...r.lt) : 0, n: r.lt.length, done: r.done, digest: r.c };
    };
    const runs = { now: [], base: [] };
    for (let k = 0; k < 3; k++) { runs.base.push(await openAt6x('s64base')); runs.now.push(await openAt6x(false)); }
    const mean = (a) => Math.round(a.reduce((s, x) => s + x.longest, 0) / a.length);
    const mNow = mean(runs.now), mBase = mean(runs.base);
    good = ok(mNow <= mBase * 1.2 + 50 && runs.now.every((x) => x.digest === 0), `dayview timing, 10-14 Day open with nothing stored, 1440 at 6x: longest task ${runs.now.map((x) => x.longest).join(' / ')} ms (mean ${mNow}) against ${S64_REF} ${runs.base.map((x) => x.longest).join(' / ')} ms (mean ${mBase}); S64 ${runs.now[0].done}, digests built ${runs.now.map((x) => x.digest).join(' / ')} (want within 20% plus 50 ms, 0 builds)`) && good;
  }
  return good;
}

// ---------- mutants (spec 6b) ----------
const R = (a, b) => [a, b];
const MUT = [
  ['1 S63_PRINT_GENERAL true', [R('const S63_PRINT_GENERAL = false;', 'const S63_PRINT_GENERAL = true;')], [['golden', ['G13']]]],
  ['2 gate always true', [R('function s63Gate(validMins) { return validMins.filter(v => v >= S63_O.floorMin).length >= S63_O.floorDays; }', 'function s63Gate(validMins) { return true; }')], [['golden', ['G1']], ['replay']]],
  ['3 floor 4 of 7 to 1 of 7', [R('floorDays: 4,', 'floorDays: 1,')], [['golden', ['G4', 'G5']]]],
  ['4 completed check removed', [R('    if (!(iso < todayIso)) return false;\n    const t = new Date', '    return true;\n    const t = new Date')], [['golden', ['G3', 'G17']]]],
  ['5 margins 360 to 0', [R('margin: 360,', 'margin: 0,')], [['golden', ['G6']]]],
  ['6 flag ignored, always personal', [R("if (weights === 'personal' && r10.length >= 5 && b.rmd)", 'if (r10.length >= 5 && b.rmd)')], [['golden', ['G7']], ['replay']]],
  ['7 RMSSD weight sign flipped', [R('personal: [7.65, -8.67, -7.13]', 'personal: [7.65, -8.67, 7.13]')], [['replay']]],
  ['8 personal minute without RMSSD scored with lr = 0', [R('      else z = S63_W.general[0] + S63_W.general[1] * rel;', "      else if (weights === 'personal') z = S63_W.personal[0] + S63_W.personal[1] * rel;\n      else z = S63_W.general[0] + S63_W.general[1] * rel;")], [['golden', ['G7b']]]],
  ['9 single threshold 0.5', [R('hi: 0.6, lo: 0.3,', 'hi: 0.5, lo: 0.5,')], [['golden', ['G8']]]],
  ['10 buckets from the first recording', [R('    const w = dayWindow(iso), n = Math.round((w.end - w.start) / 60000);', "    const k0 = Object.keys(sessionsByDate).filter(x => (sessionsByDate[x] || []).length).sort()[0];\n    const f0 = Math.min(...sessionsByDate[k0].map(fn => (sessionsIndex[fn] || {}).startEpoch || Infinity));\n    const w0 = f0 + Math.round((dayWindow(iso).start - dayWindow(k0).start) / 86400000) * 86400000, w = { start: w0, end: w0 + 86400000 }, n = 1440;")], [['golden', ['G9']]]],
  ['11 sig without the day start', [R('JSON.stringify([S63_V, w.start, files.map(', 'JSON.stringify([S63_V, files.map(')], [['golden', ['G10']]]],
  ['12 Summary reads the detector, not d.sleep', [R('    if (!s63Prints(d.sleep)) return null;\n    const f = s63Figures(d, d.sleep.mask);', "    if (!d.sleep || d.sleep.source !== 'detected' || s63Weights() !== 'personal') return null;\n    const f = s63Figures(d, d.sleep.mask);")], [['golden', ['G11']]]],
  ['13 Asleep and Awake rounded to 10 min', [R("return '<th scope=\"row\">' + rptDur(min) + ' <span", "return '<th scope=\"row\">' + rptDur(Math.round(min / 10) * 10) + ' <span")], [['golden', ['G16']]]],
  ['14 sleep shading on the report Day chart', [R("    h += '<h2 class=\"sec\">The day</h2><div class=\"chart\">' + rptDayChart(d, listed) + '</div>' + rptLegend(d);", "    h += '<h2 class=\"sec\">The day</h2><div class=\"chart\">' + rptDayChart(d, listed).replace('</svg>', (d.sleep ? '<rect class=\"slp-shade\" x=\"30\" y=\"0\" width=\"100\" height=\"10\"/>' : '') + '</svg>') + '</div>' + rptLegend(d);")], [['same']]],
  ['15 today\'s digest stored', [R("store = iso < run.todayIso;", 'store = true;')], [['golden', ['G17']]]],
  ['16 rows inside the fit loop', [R('      host.innerHTML = rptPagesHtml(d, keep);', '      host.innerHTML = rptPagesHtml(d, keep, !!rptSleepFigures(d));')], [['golden', ['G20']]]],
  ['16b rows at keep0 without the room check', [R("      rows = rptRoom(host.querySelector('#rpg1')) >= 8;", '      rows = true;')], [['golden', ['G20']]]],
  ['17 demo writes IndexedDB', [R("    const demo = isDemoMode(), key = (demo ? 's63:demo:' : 's63:real:') + iso", "    const demo = false, key = (demo ? 's63:demo:' : 's63:real:') + iso")], [['golden', ['G15']]]],
  ['18 no toast before the first digest build', [R("    if (!run.toasted) { run.toasted = true; s63Toast = UI.toast('Making the report', { ms: 30000 }); }\n", '')], [['share']]],
  ['19 Awake floor removed', [R('f.asleepMin >= S63_O.rowMin && f.awakeMin >= S63_O.rowMin ? f : null', 'f.asleepMin >= S63_O.rowMin ? f : null')], [['golden', ['G14b']]]],
  ['20 failed load still stored', [R("      if (!entry || entry.loadFailed) return 'failed';", "      if (!entry) return 'failed';")], [['golden', ['G19', 'G19b']]]],
  ['21 sig without the empty file-list guard', [R('    const files = sessionsByDate[iso] || [];\n    if (!files.length) return null;\n    const w = dayWindow', '    const files = sessionsByDate[iso];\n    const w = dayWindow')], [['golden', ['G18']]]],
  ['22 d.sleep set on the shared memo', [R('    return Object.assign({}, d, { sleep });', '    d.sleep = sleep;\n    return d;')], [['golden', ['G21']]]],
  // S64 (--part dayview).
  ['S64a Day view keeps the longest sleep run only', [R('    const windows = s64Runs(sleep.mask, d.hr);', '    const windows = s64Runs(sleep.mask, d.hr).sort((p, q) => (q.end - q.start) - (p.end - p.start)).slice(0, 1);')], [['dayview', ['D1']]]],
  ['S64b band from the mask whatever the flag and the print rule', [R("    if (!(s63Weights() === 'personal' || S63_PRINT_GENERAL)) return end('flag');\n", ''), R('    if (!d || !rptSleepFigures(Object.assign({}, d, { sleep }))) return back(\'old\');', "    if (!d) return back('old');")], [['dayview', ['D2']]]],
  ['S64c an S63 digest of the open day before the chart draws', [R('    drawSessionChart(s, data);\n    s61AfterPaint(s, data, filename);', "    if (s.__virtualDay && s63Weights() === 'personal') s63Digest(data.hr, data.rmssd, data.beats || [], 0, 60);\n    drawSessionChart(s, data);\n    s61AfterPaint(s, data, filename);")], [['dayview', ['D3']]]],
  ['S64e a cleared flag keeps the band on the same data', [R("    if (s.__detectedFor !== data || (s.__s64For && !(s63Weights() === 'personal' || S63_PRINT_GENERAL))) {", '    if (s.__detectedFor !== data) {')], [['dayview', ['D2']]]],
  ['S64f strap gaps not joined', [R('  const S64_JOIN = 10;', '  const S64_JOIN = 0;')], [['dayview', ['D1']]]],
  ['S64g a band kept after its digests stop matching', [R('    const shown = s.__s64For === data;', '    const shown = false;')], [['dayview', ['D3']]]],
  ['S64d the Day view builds a missing digest', [R('      const hit = await s63DayDigest(day, Object.assign({ cacheOnly: true }, run));', '      const hit = await s63DayDigest(day, run);')], [['dayview', ['D3']]]],
];
const PART_FN = { golden: partGolden, replay: partReplay, same: partSame, fit: partFit, share: partShare, copy: partCopy, dayview: partDayview };
async function runMutants() {
  let good = true;
  const list = MUT.filter(([, , parts]) => parts.some(([p]) => PARTS.includes(p)));
  for (const [name, reps, parts] of list) {
    let src = REAL, anchored = true;
    for (const [a, b] of reps) { if (!src.includes(a)) anchored = false; src = src.replace(a, b); }
    if (!anchored) { good = ok(false, `mutant ${name}: ANCHOR MISSING`) && good; continue; }
    // A mutant that breaks the parse would fail for the wrong reason.
    const bad = [...src.matchAll(/<script>([\s\S]*?)<\/script>/g)].filter((m) => { try { new Function(m[1]); return false; } catch (e) { return true; } });
    if (bad.length) { good = ok(false, `mutant ${name}: does not parse`) && good; continue; }
    const f0 = fails, p0 = passes;
    QUIET = true; firstFail = null;
    let killed = false, why = '';
    for (const [p, only] of parts.filter(([p]) => PARTS.includes(p))) {
      try { const r = await PART_FN[p](src, only); if (!r) { killed = true; why = firstFail || p; } } catch (e) { killed = true; why = 'threw ' + e.message.split('\n')[0]; }
      if (killed) break;
    }
    QUIET = false;
    fails = f0; passes = p0;
    good = ok(killed, `mutant ${name}: ${killed ? 'FAILS as it must: ' + why.slice(0, 160) : 'SURVIVED'}`) && good;
  }
  return good;
}

// ---------- main ----------
try {
  if (MUTANTS_ON) await runMutants();
  else for (const p of PARTS) {
    if (!PART_FN[p]) { console.log('unknown part ' + p); process.exit(2); }
    await PART_FN[p](REAL);
  }
} finally {
  if (browser) await browser.close();
  if (server) server.close();
}
console.log(`sleep-split ${PARTS.join(',')}${MUTANTS_ON ? ' --mutants' : ''}: ${passes} pass, ${fails} fail, ${((Date.now() - T0) / 1000).toFixed(0)} s`);
process.exit(fails ? 1 : 0);
