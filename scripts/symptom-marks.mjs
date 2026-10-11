// S4b viewer half, headless: a phone symptom (v2 `s` row, prefixed or bare) and a web symptom (legacy event
// cell `sym:symptom`) draw the same mark on the Day chart and in the markers list; a legacy `ctx:water` cell
// draws a context tick. Each case loads only its own synthetic recording.
// Usage: node scripts/symptom-marks.mjs [--ux <ux-audit dir>] [--shots <dir>]
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
const SHOTS = argVal('--shots');
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
const CHART = path.join(UX, '..', 'docs', 'audit-2026-10-09', 'harness-DT', 'vendor', 'chart.umd.min.js');
const { chromium } = createRequire(path.join(UX, 'kit', 'package.json'))('playwright');

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png', '.woff2': 'font/woff2' };
const server = http.createServer((req, res) => {
  const file = path.join(ROOT, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  res.end(fs.readFileSync(file));
});
await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
const base = `http://127.0.0.1:${server.address().port}`;

// 2026-10-05 15:00Z = 09:00 in Edmonton; 20 min of 1 Hz beats, the mark at minute 10.
const BASE = Date.UTC(2026, 9, 5, 15, 0, 0);
const SID = BASE + 5000;
const MARK_T = 10 * 60000;
function segment(sRow) {
  const out = ['#hrm,v=2,base=' + BASE + ',tz=-360,app=1.0,dev=test,flavour=personal', 'g,5000,' + SID + ',start', 'c,5200,connected'];
  for (let t = 6000; t < 20 * 60000; t += 1000) {
    out.push(`h,${t},${80 + Math.round(6 * Math.sin(t / 60000))},${(30 + 5 * Math.cos(t / 90000)).toFixed(2)},750;760`);
    if (t === MARK_T) out.push(sRow.replace('<t>', String(t)));
  }
  out.push('g,' + (20 * 60000) + ',' + SID + ',stop');
  return out.join('\n') + '\n';
}
function legacy(cell) {
  const start = BASE + 86400000;
  const out = ['time_min,epoch_ms,hr_bpm,rmssd_ms,sdnn_match_ms,sdnn_5min_ms,sdnn_full_ms,palpitation,event,warning,connection,posture'];
  for (let i = 0; i < 1200; i++) {
    const ep = start + i * 1000;
    out.push(`${(i / 60).toFixed(4)},${ep},${80 + Math.round(6 * Math.sin(i / 60))},${(30 + 5 * Math.cos(i / 90)).toFixed(2)},,,,,,,,`);
    if (i === 600) out.push(`${(i / 60).toFixed(4)},${ep},,,,,,,${cell},,,`);
  }
  return out.join('\n') + '\n';
}
const CASES = [
  { name: 'phone s row sym:symptom', day: '2026-10-05', files: { 'hrm_20261005T15Z_abc123.csv': segment('s,<t>,sym:symptom') } },
  { name: 'phone s row, bare value', day: '2026-10-05', files: { 'hrm_20261005T15Z_abc123.csv': segment('s,<t>,symptom') } },
  { name: 'web event cell sym:symptom', day: '2026-10-06', files: { 'hrv_session_2026-10-06T15-00-00.000.csv': legacy('sym:symptom') } },
  { name: 'web event cell ctx:water', day: '2026-10-06', files: { 'hrv_session_2026-10-06T15-00-00.000.csv': legacy('ctx:water') } },
];

let fails = 0, passes = 0;
const ok = (cond, msg) => { if (cond) { passes++; console.log('PASS ' + msg); } else { fails++; console.log('FAIL ' + msg); } };
let browser;
try { browser = await chromium.launch(); } catch (e) { browser = await chromium.launch({ channel: 'chrome' }); }

const seen = {};
for (const c of CASES) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, timezoneId: 'America/Edmonton' });
  await ctx.route('**/*', (route) => {
    const u = route.request().url();
    if (u.startsWith(base) || u.startsWith('data:') || u.startsWith('blob:')) return route.continue();
    if (/chart\.umd(\.min)?\.js/.test(u)) return route.fulfill({ status: 200, contentType: 'text/javascript', body: fs.readFileSync(CHART) });
    if (/fonts\.(googleapis|gstatic)\.com|cdn\.jsdelivr\.net|cdnjs\.cloudflare\.com/.test(u)) return route.continue();
    return route.fulfill({ status: 204, body: '' });
  });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  await page.goto(base + '/hrv_viewer.html#/month', { waitUntil: 'networkidle' });
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
  }, c.files);
  await page.goto('about:blank');
  await page.goto(base + '/hrv_viewer.html#/day/' + c.day, { waitUntil: 'networkidle' });
  await page.waitForSelector('#view-day #session-chart', { timeout: 40000 }).catch(() => {});
  await page.waitForTimeout(1200);
  const got = await page.evaluate(() => {
    const ch = window.Chart && Chart.getChart(document.getElementById('session-chart'));
    const ann = ch ? Object.entries((ch.options.plugins.annotation || {}).annotations || {}).filter(([k]) => k.startsWith('ev_')).map(([, a]) => a) : [];
    const list = [...document.querySelectorAll('#marker-list .marker-item.type-event .marker-label')].map((e) => e.textContent.trim());
    return ann.map((a) => ({ kind: a.markKind, label: a.label && a.label.content, colour: a.borderColor, width: a.borderWidth, dash: (a.borderDash || []).join(' '), at: Math.round(a.xMin * 100) / 100 })).concat(list.length ? [{ list }] : []);
  });
  console.log(`  ${c.name}: ${JSON.stringify(got)}`);
  seen[c.name] = got;
  if (SHOTS) { await page.evaluate(() => document.getElementById('session-layout').scrollIntoView()); await page.screenshot({ path: path.join(SHOTS, 'mark-' + c.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase() + '.png') }); }
  if (c === CASES[0]) {
    const count = () => page.evaluate(() => Object.keys((Chart.getChart(document.getElementById('session-chart')).options.plugins.annotation || {}).annotations || {}).filter((k) => k.startsWith('ev_')).length);
    const n0 = await count();
    await page.click('#layer-chips .chip[data-layer="event"]'); await page.waitForTimeout(200);
    const n1 = await count();
    await page.click('#layer-chips .chip[data-layer="event"]'); await page.waitForTimeout(200);
    ok(n0 === 1 && n1 === 0 && (await count()) === 1, `the Marks chip hides and restores the mark (${n0} > ${n1})`);
  }
  ok(!errs.length, `${c.name}: no page errors ${errs.join(' | ')}`);
  await ctx.close();
}

const markOf = (g) => g.filter((x) => x.kind);
const listOf = (g) => (g.find((x) => x.list) || {}).list || [];
const strip = (m) => m.map(({ kind, label, colour, width, dash }) => ({ kind, label, colour, width, dash }));
const ref = strip(markOf(seen['phone s row sym:symptom']));
ok(ref.length === 1 && ref[0].kind === 'symptom' && ref[0].label === 'Symptom', 'a phone s row sym:symptom draws one symptom mark labelled Symptom');
for (const n of ['phone s row, bare value', 'web event cell sym:symptom']) {
  ok(JSON.stringify(strip(markOf(seen[n]))) === JSON.stringify(ref), `${n} draws the same mark as the phone sym:symptom row`);
  ok(JSON.stringify(listOf(seen[n])) === JSON.stringify(listOf(seen['phone s row sym:symptom'])) && listOf(seen[n])[0] === 'Symptom', `${n} lists the same marker text`);
}
const both = markOf(seen['phone s row sym:symptom']).concat(markOf(seen['web event cell sym:symptom']));
ok(both.length === 2 && both.every((m) => Math.abs(m.at - 550) < 0.1), 'both symptom marks sit at their tap time, 09:10 (' + both.map((m) => m.at).join(', ') + ' min)');
const tick = markOf(seen['web event cell ctx:water']);
ok(tick.length === 1 && tick[0].kind === 'context' && tick[0].label === 'Water' && tick[0].dash && tick[0].width === 1 && tick[0].colour !== ref[0].colour, 'a legacy ctx:water cell draws a context tick labelled Water');

await browser.close();
server.close();
console.log(`symptom-marks: ${passes} pass, ${fails} fail`);
process.exit(fails ? 1 : 0);
