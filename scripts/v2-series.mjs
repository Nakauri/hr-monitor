// Guards: S50 Day open without the CSV round trip. Named bug: S8 cold Day open 2,531 ms (2026-10-14 trace,
// ux-audit/redesign/perf-2026-10-14/S49-RESULTS.md), a third of it writing v2 rows out as CSV and parsing them back.
// The direct path (v2SeriesFromRows) must give loadFullSession output deep-equal to the CSV path on every v2 key.
// Files: hrv_viewer.html (v2SeriesFromRows, loadFullSession). Runtime: about 60 s; run when either changes.
// Fixtures: the device segments (docs/audit-2026-10-09/device-2026-10-10/segments) and variants built from them:
// first row over 10 min after the session start, rows before it, symptom, event, warning, palpitation and context
// rows at the edges, a second session start mid-way (reset), RR left empty (no SDNN). Mutants that must FAIL:
// SDNN rounding dropped, rowElapsedMinFn bypassed.
// --only <i,j> runs those fixture variants (0 to 5); --mutants runs only the mutants (on variants 0 and 2).
// Usage: node scripts/v2-series.mjs [--only <i,j>] [--mutants] [--ux <ux-audit dir>]
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
const SEGS = path.join(UX, '..', 'docs', 'audit-2026-10-09', 'device-2026-10-10', 'segments');
const { chromium } = createRequire(path.join(UX, 'kit', 'package.json'))('playwright');

let MUTATE = null;
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.csv': 'text/csv', '.woff2': 'font/woff2' };
let anchorMissing = false;
const server = http.createServer((req, res) => {
  const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const file = path.join(ROOT, rel);
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end(); return; }
  let body = fs.readFileSync(file);
  if (MUTATE && rel === '/hrv_viewer.html') {
    const text = body.toString('utf8').replace(/\r\n/g, '\n');
    if (!text.includes(MUTATE[0])) anchorMissing = true;
    body = text.replace(MUTATE[0], MUTATE[1]);
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  res.end(body);
});
await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
const BASE = `http://127.0.0.1:${server.address().port}`;

let fails = 0, passes = 0;
const ok = (cond, msg) => { if (cond) { passes++; console.log('PASS ' + msg); } else { fails++; console.log('FAIL ' + msg); } };

// ---- Fixtures ----
const real = {};
for (const n of fs.readdirSync(SEGS).sort()) if (n.endsWith('.csv')) real[n] = fs.readFileSync(path.join(SEGS, n), 'utf8').replace(/\r\n/g, '\n');
const names = Object.keys(real);
const first = names[0], last = names[names.length - 1];
const startT = +real[first].split('\n').find((l) => /^g,.*,start$/.test(l)).split(',')[1];
const mapLines = (text, fn) => text.split('\n').map(fn).filter((l) => l != null).join('\n');
function variant(name, edit) { const v = { ...real }; edit(v); return [name, v]; }
const VARIANTS = [
  ['device as recorded', { ...real }],
  // Early rows lost: the first written row lands 15 min after the start (S35 rebuilds x from epoch).
  variant('first row 15 min after the start', (v) => { v[first] = mapLines(v[first], (l) => /^[hcp],/.test(l) && +l.split(',')[1] < startT + 15 * 60000 ? null : l); }),
  // Rows stamped before the start: time_min clamps to 0 and the span disagrees with epoch.
  variant('rows before the start', (v) => {
    const hs = v[first].split('\n').filter((l) => l.startsWith('h,')).slice(0, 6);
    const early = hs.map((l, i) => { const c = l.split(','); c[1] = String(startT - (6 - i) * 60000); return c.join(','); });
    v[first] = mapLines(v[first], (l) => /^g,.*,start$/.test(l) ? [l, 'c,' + (startT - 400000) + ',connected', ...early].join('\n') : l);
  }),
  // Non-h rows at both edges: they feed rowElapsedMinFn but add no points.
  variant('symptom, event, warning, palp and context rows at the edges', (v) => {
    const edge = (t) => ['s,' + t + ',dizzy', 'e,' + (t + 5) + ',Lunch', 'w,' + (t + 9) + ',warn-high', 'x,' + (t + 13), 'p,' + (t + 17) + ',standing,btn', 'c,' + (t + 21) + ',disconnect'];
    v[first] = mapLines(v[first], (l) => /^g,.*,start$/.test(l) ? [l, ...edge(startT + 1)].join('\n') : l);
    const lastT = Math.max(...v[last].split('\n').filter((l) => /^[a-z],\d/.test(l)).map((l) => +l.split(',')[1]));
    v[last] = v[last].replace(/\n*$/, '\n') + edge(lastT + 100).join('\n') + '\n';
  }),
  // A second start mid-recording: a reset row between two sessions.
  variant('a second start mid-way', (v) => {
    const mid = names[5];
    const hs = v[mid].split('\n').filter((l) => l.startsWith('h,'));
    const at = hs[Math.floor(hs.length / 2)].split(',')[1];
    const gl = v[mid].split('\n').find((l) => l.startsWith('g,')).split(',');
    v[mid] = mapLines(v[mid], (l) => l.startsWith('h,') && l.split(',')[1] === at ? ['g,' + at + ',' + (+gl[2] + 7) + ',start', l].join('\n') : l);
  }),
  // RR missing for a stretch: SDNN cells stay empty.
  variant('RR missing for an hour', (v) => { v[names[3]] = mapLines(v[names[3]], (l) => { if (!l.startsWith('h,')) return l; const c = l.split(','); c[4] = ''; return c.join(','); }); }),
];

async function compare(files) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, timezoneId: 'America/Edmonton' });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(BASE + '/hrv_viewer.html#/month', { waitUntil: 'networkidle' });
  await page.waitForTimeout(600);
  await page.evaluate(async (files) => {
    const db = await new Promise((res, rej) => { const q = indexedDB.open('hr_monitor_kv', 2);
      q.onupgradeneeded = () => { for (const s of ['kv', 'drive-cache']) if (!q.result.objectStoreNames.contains(s)) q.result.createObjectStore(s); };
      q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
    await new Promise((res, rej) => { const tx = db.transaction('drive-cache', 'readwrite');
      for (const [k, v] of Object.entries(files)) tx.objectStore('drive-cache').put(v, k);
      tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
    db.close();
    localStorage.removeItem('hrv_viewer_index');
  }, files);
  // A same-URL goto keeps the document; leave the page so the viewer reads the seeded cache from scratch.
  await page.goto('about:blank');
  await page.goto(BASE + '/hrv_viewer.html#/month', { waitUntil: 'networkidle' });
  await page.waitForFunction(() => window.__hrmV2 && window.__hrmV2.keys().length > 0, null, { timeout: 30000 }).catch(() => {});
  const r = await page.evaluate(async () => {
    const out = [];
    for (const key of window.__hrmV2.keys()) {
      const a = await window.__hrmV2.load(key, true);
      const b = await window.__hrmV2.load(key, false);
      const sa = JSON.stringify(a), sb = JSON.stringify(b);
      let where = '';
      if (sa !== sb) for (const k of ['hr', 'rmssd', 'sdnnMatch', 'sdnn5min']) {
        if (a[k].length !== b[k].length) { where = `${k} length ${a[k].length} vs ${b[k].length}`; break; }
        const i = a[k].findIndex((p, j) => JSON.stringify(p) !== JSON.stringify(b[k][j]));
        if (i >= 0) { where = `${k}[${i}] ${JSON.stringify(a[k][i])} vs ${JSON.stringify(b[k][i])}`; break; }
      }
      // NaN survives the comparison: JSON writes it as null on both sides, so count it separately.
      const nan = (o) => ['hr', 'rmssd', 'sdnnMatch', 'sdnn5min'].map((k) => o[k].filter((p) => Number.isNaN(p.y) || Number.isNaN(p.x)).length).join('/');
      out.push({ key, same: sa === sb && nan(a) === nan(b), n: ['hr', 'rmssd', 'sdnnMatch', 'sdnn5min'].map((k) => a[k].length).join('/'), where });
    }
    return out;
  });
  await ctx.close();
  return { r, errors };
}

let browser;
try { browser = await chromium.launch(); } catch (e) { browser = await chromium.launch({ channel: 'chrome' }); }
const ONLY = argVal('--only') ? argVal('--only').split(',').map(Number) : null;
const MUT = args.includes('--mutants');
for (const [name, files] of VARIANTS.filter((v, i) => !MUT && (!ONLY || ONLY.includes(i)))) {
  const t0 = Date.now();
  const { r, errors } = await compare(files);
  console.log(`${name}: ${Math.round((Date.now() - t0) / 1000)} s`);
  ok(r.length > 0, `${name}: v2 sessions found (${r.length})`);
  for (const x of r) ok(x.same, `${name}: ${x.key} direct path equals the CSV path (hr/rmssd/sdnnMatch/sdnn5min ${x.n})${x.where ? ' first difference ' + x.where : ''}`);
  ok(!errors.length, `${name}: no page errors ` + errors.join(' | '));
}

// ---- Mutants: each must make at least one comparison fail ----
const MUTANTS = [
  ['SDNN rounding dropped', 'if (s.match != null) { const v = toFixedNum(s.match, 100, 2);', 'if (s.match != null) { const v = s.match;'],
  ['the S35 elapsed rule bypassed', '      const t = elapsed(i);', '      const t = T[i];'],
  ['time rounded by Math.round alone', '    if (!Number.isFinite(y) || y >= 2 ** 52 || Math.abs(f - 0.5) < 1e-6) return parseFloat(x.toFixed(digits));', '    if (!Number.isFinite(y) || y >= 2 ** 52) return parseFloat(x.toFixed(digits));'],
];
for (const [name, a, b] of (MUT ? MUTANTS : [])) {
  MUTATE = [a, b]; anchorMissing = false;
  let caught = false;
  for (const [, files] of [VARIANTS[0], VARIANTS[2]]) { const { r } = await compare(files); if (r.some((x) => !x.same)) { caught = true; break; } }
  ok(!anchorMissing && caught, `MUTANT ${name}: ${anchorMissing ? 'ANCHOR MISSING' : caught ? 'caught' : 'NOT CAUGHT'}`);
}
MUTATE = null;

await browser.close();
server.close();
console.log(`v2-series: ${passes} pass, ${fails} fail`);
process.exit(fails ? 1 : 0);
