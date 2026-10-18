// Guards: the Day chart lagging on drag, zoom, hover and marker ease (ux-audit/redesign/perf-2026-10-12/REPORT.md, Khal 2026-10-11 "barely scroll"). Files: hrv_viewer.html chart, brush, pinch (S32), hover, marker ease, Day route. Runtime: about 70 s per --config; run when the Day chart or its route changes.
// Seeds one realistic 16.5 h day (3 recordings at 1 Hz, gaps, events, palps, warnings, posture, marks)
// into the viewer's Drive cache, opens the Day view headless, runs the REPORT actions with long-task,
// frame and Chart.update counters, then checks the REPORT budgets as PASS/FAIL rows.
// --config desk (1440 at 4x CPU) | phone (360 at 6x) | all (both, about 140 s). --w/--cpu measure any other
// cell without budgets. --mutants drag|hover|marks serves a broken viewer whose budget rows must FAIL (marks runs the phone drags).
// --shots <dir> --tag <name> shoots the chart at 1440: full day, a 10 min window, a marker clicked. --ref <commit>
// serves that commit's viewer instead of the working file (before and after pairs). --counts adds V8 call counts.
// Usage: node scripts/viewer-perf.mjs [--config desk|phone|all] [--mutants drag|hover|marks] [--only a,b] [--ux <dir>]
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { uxDir } from './ux-dir.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');
const args = process.argv.slice(2);
const argVal = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const UX = uxDir(here, argVal('--ux', null));
const CHART = path.join(UX, '..', 'docs', 'audit-2026-10-09', 'harness-DT', 'vendor', 'chart.umd.min.js');
const { chromium } = createRequire(path.join(UX, 'kit', 'package.json'))('playwright');
const OUTDIR = argVal('--out', path.join(UX, 'redesign', 'perf-2026-10-12', 's26'));
const COUNTS = args.includes('--counts');
let ONLY = argVal('--only', null);
const SHOTS = argVal('--shots', null), SHOT_TAG = argVal('--tag', 'shot'), SHOT_PREFIX = argVal('--prefix', 's26');
const MUTANT = argVal('--mutants', null);
const want = (a) => !ONLY || ONLY.split(',').includes(a);
const CONFIGS = { desk: [1440, 4], phone: [360, 6] };
let runs;
if (SHOTS) runs = [['shots', +argVal('--w', 1440), 1]];
else if (args.includes('--w') || args.includes('--cpu')) runs = [['adhoc', +argVal('--w', 1440), +argVal('--cpu', 1)]];
else if (MUTANT) runs = null;
else { const c = argVal('--config', 'all'); runs = (c === 'all' ? ['desk', 'phone'] : [c]).map((k) => [k, ...CONFIGS[k]]); }

const REF = argVal('--ref', null);
const REAL = (REF ? execFileSync('git', ['-C', ROOT, 'show', REF + ':hrv_viewer.html'], { encoding: 'utf8', maxBuffer: 64 << 20 }) : fs.readFileSync(path.join(ROOT, 'hrv_viewer.html'), 'utf8')).replace(/\r\n/g, '\n');
// Each mutant breaks one path; the rows it names must FAIL.
const MUTANTS = {
  drag: { rows: ['brush'], a: '      scheduleChartRange();\n', b: '      applyChartRange();\n', why: 'brush drag calls the chart update from pointermove' },
  hover: { rows: ['hover'], a: '    chart.$hlT = t;\n', b: '    chart.$hlT = t;\n    chart.update(\'none\');\n', why: 'hover highlight runs a chart update' },
  // S28 negative control: chartjs-plugin-annotation re-resolves every mark on each update (BUILD-PLAN S28).
  marks: { rows: ['update'], config: 'phone', only: 'brush', why: 'marks drawn by chartjs-plugin-annotation', pairs: [
    ['<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"></script>\n',
      '<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"></script>\n<script src="https://cdn.jsdelivr.net/npm/chartjs-plugin-annotation@3.0.1/dist/chartjs-plugin-annotation.min.js"></script>\n'],
    ['          hrOverlays: { overlays: hrOverlays },\n', '          annotation: { annotations: marks },\n          hrOverlays: { overlays: hrOverlays },\n'],
    ['RESET_POS_PLUGIN, markLayer, maxMin]', 'RESET_POS_PLUGIN, maxMin]'],
  ] },
};
let SERVED = REAL;
if (MUTANT) {
  const m = MUTANTS[MUTANT];
  if (!m) { console.log('FAIL unknown mutant ' + MUTANT); process.exit(2); }
  for (const [a, b] of m.pairs || [[m.a, m.b]]) {
    if (!SERVED.includes(a)) { console.log('FAIL mutant ' + MUTANT + ': anchor missing'); process.exit(1); }
    SERVED = SERVED.replace(a, b);
  }
  const c = m.config || 'desk';
  runs = [[c, ...CONFIGS[c]]];
  if (m.only && !ONLY) ONLY = m.only;
}

// ---- Fixture: 2026-09-15 in America/Edmonton (UTC-6). 06:30-12:00, 12:15-18:15, 18:40-23:40 local. ----
const DAY = '2026-09-15';
const LOCAL = (h, m) => Date.UTC(2026, 8, 15, h + 6, m, 0);
const SEGS = [[6, 30, 12, 0], [12, 15, 18, 15], [18, 40, 23, 40]];
let rng = 12345; const rnd = () => ((rng = (rng * 1103515245 + 12345) % 2147483648) / 2147483648);
const files = {}; let rows = 0;
const postures = ['sitting', 'standing', 'lying', 'sitting', 'standing'];
const evs = ['sym:dizzy', 'ctx:water', 'Lunch', 'sym:nausea', 'ctx:salt', 'sym:fatigue', 'Walk', 'ctx:meds'];
for (const [h0, m0, h1, m1] of SEGS) {
  const t0 = LOCAL(h0, m0), n = ((h1 * 60 + m1) - (h0 * 60 + m0)) * 60;
  const out = ['time_min,epoch_ms,hr_bpm,rmssd_ms,sdnn_match_ms,sdnn_5min_ms,sdnn_full_ms,palpitation,event,warning,connection,posture'];
  let hr = 80;
  for (let i = 0; i < n; i++) {
    const c = new Array(12).fill('');
    c[0] = (i / 60).toFixed(4); c[1] = String(t0 + i * 1000);
    const drop = (i % 5400) > 5340; // 60 s BLE dropout every 90 min
    hr += (rnd() - 0.5) * 2 + (82 - hr) * 0.01; if (i % 2700 > 2600) hr += 0.6; // tachy bursts
    c[2] = drop ? '' : String(Math.round(hr)); c[3] = drop ? '' : (30 + 10 * Math.sin(i / 500) + rnd() * 4).toFixed(2);
    if (rnd() < 0.0012) c[7] = '1';
    if (i % 2400 === 1200) c[8] = evs[(i / 2400 | 0) % evs.length];
    if (hr > 125 && i % 60 === 0) c[9] = 'warn-high';
    if (i === 0) c[10] = 'connected';
    if (i % 5400 === 5341) c[10] = 'disconnected'; if (i % 5400 === 5399) c[10] = 'connected';
    if (i % 1800 === 0) c[11] = postures[(i / 1800 | 0) % postures.length];
    out.push(c.join(',')); rows++;
  }
  const d = new Date(t0 - 6 * 3600e3).toISOString().slice(0, 19).replace(/:/g, '-');
  files[`hrv_session_${d}.000.csv`] = out.join('\n') + '\n';
}
const mrec = (o) => Object.assign({ v: 1, m: '2026-09', by: 'zzzzzz', createdAt: 1, updatedAt: 1, base: 0, deleted: false }, o);
const marks = [];
for (let k = 0; k < 20; k++) marks.push(mrec({ id: `zzzzzz-t${k}-aaaa`, kind: 'tap', at: LOCAL(7 + (k * 0.8 | 0), (k * 37) % 60), cls: k % 2 ? 'sym' : 'ctx', label: k % 2 ? 'Nausea' : 'Water' }));
marks.push(mrec({ id: 'zzzzzz-s1-aaaa', kind: 'sleep', from: LOCAL(14, 0), to: LOCAL(15, 10) }));

// ---- Server ----
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png', '.woff2': 'font/woff2' };
const server = http.createServer((req, res) => {
  const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname); const file = path.join(ROOT, rel);
  if (rel === '/hrv_viewer.html') { res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' }); res.end(SERVED); return; }
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' }); res.end(fs.readFileSync(file));
});
await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
const base = `http://127.0.0.1:${server.address().port}`;

// ---- In-page instrumentation ----
const INIT = () => {
  const P = window.__perf = { lt: [], cnt: {}, firstMainDraw: null, frames: [], fid: 0, perFrame: {} };
  const inc = (k) => { P.cnt[k] = (P.cnt[k] || 0) + 1; };
  try { new PerformanceObserver((l) => { for (const e of l.getEntries()) P.lt.push([e.startTime, e.duration]); }).observe({ type: 'longtask', buffered: true }); } catch (e) {}
  let C;
  const wrap = (v) => {
    if (!v || !v.prototype || v.prototype.__wrapped) return;
    const pr = v.prototype; pr.__wrapped = true;
    for (const m of ['update', 'draw', 'resize']) {
      const f = pr[m]; if (!f) continue;
      pr[m] = function (...a) {
        const main = this.canvas && this.canvas.id === 'session-chart';
        const tag = main ? ':main' : ':other';
        inc(m + tag);
        if (m === 'update' && main) {
          // An update inside an input handler bypassed the frame path.
          const ev = window.event;
          if (ev && /^(pointer|mouse|touch)/.test(ev.type)) inc('updateInInput:main');
          P.perFrame[P.fid] = (P.perFrame[P.fid] || 0) + 1;
        }
        const t = performance.now(); const r = f.apply(this, a); const dt = performance.now() - t;
        P.cnt[m + 'Ms' + tag] = (P.cnt[m + 'Ms' + tag] || 0) + dt;
        if (m === 'update' && main) P.cnt['updateMaxMs:main'] = Math.max(P.cnt['updateMaxMs:main'] || 0, dt);
        if (m === 'draw' && main && P.firstMainDraw == null) P.firstMainDraw = performance.now();
        return r;
      };
    }
  };
  Object.defineProperty(window, 'Chart', { configurable: true, get() { return C; }, set(v) { C = v; wrap(v); } });
  P.reset = () => { P.lt = []; P.cnt = {}; P.perFrame = {}; };
  P.frameStart = () => { P.frames = []; P.fOn = true; const loop = (t) => { if (!P.fOn) return; P.fid++; P.frames.push(t); requestAnimationFrame(loop); }; requestAnimationFrame(loop); };
  P.frameStop = () => { P.fOn = false; const f = P.frames; const maxPerFrame = Math.max(0, ...Object.values(P.perFrame));
    if (f.length < 2) return { fps: 0, worst: 0, n: f.length, maxPerFrame };
    let worst = 0; for (let i = 1; i < f.length; i++) worst = Math.max(worst, f[i] - f[i - 1]);
    return { fps: +((f.length - 1) / ((f[f.length - 1] - f[0]) / 1000)).toFixed(1), worst: Math.round(worst), n: f.length, maxPerFrame }; };
  window.print = () => {};
};

let browser; try { browser = await chromium.launch(); } catch (e) { browser = await chromium.launch({ channel: 'chrome' }); }
const lineOf = (cf) => cf.url.endsWith('hrv_viewer.html') ? 'hrv_viewer.html:' + (cf.lineNumber + 1) : (cf.url.split('/').pop() || '(native)') + (cf.url ? ':' + (cf.lineNumber + 1) + ':' + cf.columnNumber : '');
function selfTimes(profile, top = 8) {
  const byId = new Map(profile.nodes.map((n) => [n.id, n])); const self = new Map();
  const dts = profile.timeDeltas;
  for (let i = 0; i < profile.samples.length; i++) {
    const n = byId.get(profile.samples[i]); const cf = n.callFrame;
    if (['(idle)', '(program)', '(root)'].includes(cf.functionName)) continue;
    const k = (cf.functionName || '(anon)') + ' ' + lineOf(cf);
    self.set(k, (self.get(k) || 0) + (dts[i + 1] || dts[i] || 0) / 1000);
  }
  const byFile = {};
  for (const [k, v] of self) { const f = k.split(' ')[1].split(':')[0]; byFile[f] = +((byFile[f] || 0) + v).toFixed(1); }
  return { top: [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, top).map(([k, v]) => [k, +v.toFixed(1)]), byFile };
}

let fails = 0, passes = 0;
const ok = (cond, msg) => { if (cond) { passes++; console.log('PASS ' + msg); } else { fails++; console.log('FAIL ' + msg); } return cond; };

// --cold (S50): a cold Day open of the 16 h device recording (v2 segments) at 360 6x, through the direct path and
// through the CSV round trip (window.__hrmV2ViaCsv, the pre-S50 path, which is also the mutant). Named bug: S8 cold
// Day open 2,531 ms (perf-2026-10-14/S49-RESULTS.md). Rows: V8 call counts during the Day open; the direct path
// calls v2SessionCsv and parseCSV zero times, the round trip calls them (so the check can fail). Longest tasks are
// printed, not budgeted: headless timings swing 15% run to run. S8 effect: 22 to 32% (S49-RESULTS.md). Runtime: 30 s.
if (args.includes('--cold')) {
  const SEGS = path.join(UX, '..', 'docs', 'audit-2026-10-09', 'device-2026-10-10', 'segments');
  const segFiles = {};
  for (const n of fs.readdirSync(SEGS)) if (n.endsWith('.csv')) segFiles[n] = fs.readFileSync(SEGS + '/' + n, 'utf8');
  const coldOpen = async (viaCsv) => {
    const ctx = await browser.newContext({ viewport: { width: 360, height: 740 }, isMobile: true, hasTouch: true, timezoneId: 'America/Edmonton' });
    await ctx.route('**/chart.umd*.js', (r) => r.fulfill({ status: 200, contentType: 'text/javascript', body: fs.readFileSync(CHART) }));
    await ctx.addInitScript(INIT);
    if (viaCsv) await ctx.addInitScript(() => { window.__hrmV2ViaCsv = true; });
    // S63: the sleep weights flag on, so a split run on Day open would show in the counters.
    await ctx.addInitScript(() => { try { localStorage.setItem('hrv_viewer_sleep_weights', 'personal'); } catch (e) {} });
    const page = await ctx.newPage();
    const errs = []; page.on('pageerror', (e) => errs.push(e.message));
    await page.goto(base + '/hrv_viewer.html#/month', { waitUntil: 'networkidle' });
    await page.evaluate(async (files) => {
      const db = await new Promise((res, rej) => { const q = indexedDB.open('hr_monitor_kv', 2);
        q.onupgradeneeded = () => { for (const s of ['kv', 'drive-cache']) if (!q.result.objectStoreNames.contains(s)) q.result.createObjectStore(s); };
        q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
      await new Promise((res, rej) => { const tx = db.transaction('drive-cache', 'readwrite');
        for (const [k, v] of Object.entries(files)) tx.objectStore('drive-cache').put(v, k);
        tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
      db.close(); localStorage.removeItem('hrv_viewer_index');
    }, segFiles);
    await page.goto('about:blank');
    await page.goto(base + '/hrv_viewer.html#/month', { waitUntil: 'networkidle' });
    await page.waitForFunction(() => window.__hrmV2 && window.__hrmV2.keys().length > 0, null, { timeout: 30000 });
    await page.waitForTimeout(1500);
    const cdp = await ctx.newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 6 });
    const prof = args.includes('--prof') && !viaCsv;
    if (prof) { await cdp.send('Profiler.enable'); await cdp.send('Profiler.setSamplingInterval', { interval: 200 }); await cdp.send('Profiler.start'); }
    await cdp.send('Profiler.enable'); await cdp.send('Profiler.startPreciseCoverage', { callCount: true, detailed: false });
    await cdp.send('Profiler.takePreciseCoverage'); // resets the counters
    await page.evaluate(() => { window.__perf.reset(); setTimeout(() => { location.hash = '#/day/2026-10-10'; }, 0); });
    await page.waitForFunction(() => { const c = document.querySelector('#view-day #session-chart'); const ch = c && window.Chart && Chart.getChart(c); return !!(ch && ch.data.datasets.some((d) => d.data && d.data.length > 100)); }, null, { timeout: 60000 });
    await page.waitForTimeout(800);
    if (prof) { const { profile } = await cdp.send('Profiler.stop'); const st = selfTimes(profile, 16); console.log('direct self ms: ' + st.top.map(([k, v]) => v + ' ' + k).join(' | ')); }
    const cov = (await cdp.send('Profiler.takePreciseCoverage')).result;
    const calls = {};
    for (const sc of cov) if (sc.url.endsWith('hrv_viewer.html')) for (const f of sc.functions) if (['v2SessionCsv', 'parseCSV', 'v2SeriesFromRows'].includes(f.functionName)) calls[f.functionName] = (calls[f.functionName] || 0) + f.ranges[0].count;
    const longest = await page.evaluate(() => Math.round(Math.max(0, ...window.__perf.lt.map((x) => x[1]))));
    // S61: the entry counter copied at the first paint, then detection within 3 s of it.
    const s61 = await page.evaluate(async () => {
      const c = globalThis.__s61, t0 = performance.now();
      while (c && !c.atPaint && performance.now() - t0 < 5000) await new Promise((r) => setTimeout(r, 50));
      while (c && c.atPaint && !(c.detectDayMoments >= 1 && c.doneT) && performance.now() - c.atPaintT < 3500) await new Promise((r) => setTimeout(r, 50));
      return c ? { atPaint: c.atPaint, key: c.atPaintKey, det: c.detectDayMoments, after: c.doneT ? Math.round(c.doneT - c.atPaintT) : null, taskMs: c.taskMs != null ? Math.round(c.taskMs) : null } : null;
    });
    // S63: no sleep split work on a Day open, at the first paint and 3 s later.
    const s63 = await page.evaluate(async () => {
      const g = () => globalThis.__s63 ? { digest: globalThis.__s63.digest, detect: globalThis.__s63.detect } : null;
      const atOpen = g(), t0 = performance.now();
      while (performance.now() - t0 < 3000) await new Promise((r) => setTimeout(r, 100));
      return { atOpen, later: g() };
    });
    if (args.includes('--tasks')) console.log((viaCsv ? 'csv   ' : 'direct') + ' tasks: ' + (await page.evaluate(() => window.__perf.lt.map((x) => Math.round(x[1])).join(' '))));
    await ctx.close();
    return { longest, errs, calls, s61, s63 };
  };
  const a = await coldOpen(false), b = await coldOpen(true);
  // S61 negative controls: detection work before the first paint must fail the counter row.
  const s61Row = (r) => !!(r.s61 && r.s61.atPaint && r.s61.key === 'day:2026-10-10' && Object.values(r.s61.atPaint).every((v) => v === 0) && r.s61.det >= 1 && r.s61.after != null && r.s61.after <= 3000);
  const S61_MUTANTS = [
    ['beatJunk inside renderSession before the chart', '    drawSessionChart(s, data);\n    s61AfterPaint(s, data, filename);', '    beatJunk(data.beats || [], 0, 60);\n    drawSessionChart(s, data);\n    s61AfterPaint(s, data, filename);'],
    ['rptBase called from renderInsight', '    { const sec = s61Section(s); if (sec) sections.push(sec); }', '    { rptBase(s, currentData); const sec = s61Section(s); if (sec) sections.push(sec); }'],
  ];
  const mres = [];
  for (const [name, x, y] of S61_MUTANTS) {
    if (!REAL.includes(x)) { mres.push([name, null]); continue; }
    SERVED = REAL.replace(x, y);
    mres.push([name, await coldOpen(false)]);
    SERVED = REAL;
  }
  // S63 negative control: the split built on a Day open must fail the S63 row.
  const S63_MUT = ['    drawSessionChart(s, data);\n    s61AfterPaint(s, data, filename);', '    drawSessionChart(s, data);\n    s61AfterPaint(s, data, filename);\n    if (s.__virtualDay) s63Sleep(s.__virtualDay);'];
  let m63 = null;
  if (REAL.includes(S63_MUT[0])) { SERVED = REAL.replace(S63_MUT[0], S63_MUT[1]); m63 = await coldOpen(false); SERVED = REAL; }
  const errs = [...a.errs, ...b.errs];
  console.log(`cold Day open 360 6x, longest task: direct ${a.longest} ms, CSV round trip ${b.longest} ms (information only)`);
  const n = (c, k) => c[k] || 0;
  ok(n(a.calls, 'v2SessionCsv') === 0 && n(a.calls, 'parseCSV') === 0 && n(a.calls, 'v2SeriesFromRows') > 0, `cold v2 Day open builds the series directly: v2SessionCsv ${n(a.calls, 'v2SessionCsv')}, parseCSV ${n(a.calls, 'parseCSV')}, v2SeriesFromRows ${n(a.calls, 'v2SeriesFromRows')} calls`);
  ok(n(b.calls, 'v2SessionCsv') > 0 && n(b.calls, 'parseCSV') > 0, `negative control, the round trip is seen: v2SessionCsv ${n(b.calls, 'v2SessionCsv')}, parseCSV ${n(b.calls, 'parseCSV')} calls`);
  ok(s61Row(a), `S61 counter at the first paint all 0 and detection within 3 s: ${JSON.stringify(a.s61)}`);
  const s63Zero = (x) => !!(x && x.digest === 0 && x.detect === 0);
  ok(!!m63 && !(s63Zero(m63.s63.atOpen) && s63Zero(m63.s63.later)), `S63 mutant split built on a Day open: ${m63 ? 'counter row fails ' + JSON.stringify(m63.s63.later) : 'ANCHOR MISSING'}`);
  ok(s63Zero(a.s63.atOpen) && s63Zero(a.s63.later), `S63 counters 0 after a Day open with the sleep weights flag on (counters only grow, so 0 later means 0 at paint), then 3 s later: ${JSON.stringify(a.s63)}`);
  console.log(`S61 detection task ${a.s61 && a.s61.taskMs} ms at 6x (information only)`);
  for (const [name, r] of mres) ok(r && !s61Row(r), `S61 mutant ${name}: ${r ? 'counter row fails ' + JSON.stringify(r.s61.atPaint) : 'ANCHOR MISSING'}`);
  ok(!errs.length, 'cold: no page errors ' + errs.join(' | '));
  await browser.close(); server.close();
  console.log(`viewer-perf --cold: ${passes} pass, ${fails} fail`);
  process.exit(fails ? 1 : 0);
}

async function runConfig(name, W, CPU) {
  const PHONE = W < 600, H = PHONE ? 740 : 900;
  const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: PHONE ? 2 : 1, isMobile: PHONE, hasTouch: PHONE, timezoneId: 'America/Edmonton' });
  await ctx.route('**/*', (route) => {
    const u = route.request().url();
    if (u.startsWith(base) || u.startsWith('data:') || u.startsWith('blob:')) return route.continue();
    if (/chart\.umd(\.min)?\.js/.test(u)) return route.fulfill({ status: 200, contentType: 'text/javascript', body: fs.readFileSync(CHART) });
    if (/fonts\.(googleapis|gstatic)\.com|cdn\.jsdelivr\.net|cdnjs\.cloudflare\.com/.test(u)) return route.continue();
    return route.fulfill({ status: 204, body: '' });
  });
  await ctx.addInitScript(INIT);
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  const cdp = await ctx.newCDPSession(page);

  // Seed, then a warm-up open so the summary index is built and persisted (Khal's laptop state).
  await page.goto(base + '/hrv_viewer.html#/month', { waitUntil: 'networkidle' });
  await page.evaluate(async ({ files, records }) => {
    const openDb = (name, v, stores) => new Promise((res, rej) => { const q = indexedDB.open(name, v);
      q.onupgradeneeded = () => { for (const s of stores) if (!q.result.objectStoreNames.contains(s)) q.result.createObjectStore(s); };
      q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
    const put = (db, store, entries) => new Promise((res, rej) => { const tx = db.transaction(store, 'readwrite');
      for (const [k, v] of entries) tx.objectStore(store).put(v, k); tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
    const kv = await openDb('hr_monitor_kv', 2, ['kv', 'drive-cache']); await put(kv, 'drive-cache', Object.entries(files)); kv.close();
    const mk = await openDb('aorti_marks', 1, ['records', 'mine', 'files', 'meta']);
    await put(mk, 'mine', records.map((r) => [r.id, r])); await put(mk, 'meta', [['deviceId', 'zzzzzz']]); mk.close();
    localStorage.removeItem('hrv_viewer_index');
  }, { files, records: marks });
  const DAYURL = base + '/hrv_viewer.html#/day/' + DAY;
  await page.goto('about:blank');
  await page.goto(DAYURL, { waitUntil: 'networkidle' });
  await page.waitForSelector('#view-day #session-chart', { timeout: 60000 });
  await page.waitForTimeout(3000);
  await page.goto('about:blank');

  await cdp.send('Emulation.setCPUThrottlingRate', { rate: CPU });
  await cdp.send('Profiler.enable');
  await cdp.send('Profiler.setSamplingInterval', { interval: 250 });
  if (COUNTS) await cdp.send('Profiler.startPreciseCoverage', { callCount: true, detailed: false });
  async function coverage() {
    if (!COUNTS) return null;
    const { result } = await cdp.send('Profiler.takePreciseCoverage');
    const out = {};
    for (const s of result) {
      if (!/hrv_viewer\.html|ui\.js|marks-|chartjs-plugin-annotation/.test(s.url)) continue;
      const short = s.url.split('/').pop();
      for (const f of s.functions) { const c = f.ranges[0].count; if (c > 0 && f.functionName) out[short + ' ' + f.functionName] = (out[short + ' ' + f.functionName] || 0) + c; }
    }
    return Object.fromEntries(Object.entries(out).sort((a, b) => b[1] - a[1]).slice(0, 40));
  }
  const results = { config: { name, W, H, CPU, COUNTS, mutant: MUTANT, rows, marks: marks.length }, actions: {} };
  async function measure(aname, fn, { frames = true } = {}) {
    await page.evaluate(() => window.__perf.reset());
    if (COUNTS) await coverage();
    await cdp.send('Profiler.start');
    if (frames) await page.evaluate(() => window.__perf.frameStart());
    const t = Date.now(); let extra = null;
    try { extra = await fn(); } catch (e) { extra = { error: String(e.message || e).slice(0, 200) }; }
    const wall = Date.now() - t;
    const fr = frames ? await page.evaluate(() => window.__perf.frameStop()) : null;
    const { profile } = await cdp.send('Profiler.stop');
    const p = await page.evaluate(() => ({ lt: window.__perf.lt, cnt: window.__perf.cnt }));
    const lts = p.lt.map((x) => x[1]);
    const cnt = Object.fromEntries(Object.entries(p.cnt).map(([k, v]) => [k, typeof v === 'number' && !Number.isInteger(v) ? +v.toFixed(1) : v]));
    const upd = cnt['update:main'] || 0;
    const r = { wallMs: wall, longTasks: lts.length, longestMs: Math.round(Math.max(0, ...lts)), tbtMs: Math.round(lts.reduce((a, d) => a + Math.max(0, d - 50), 0)),
      frames: fr, counts: cnt, msPerUpdate: upd ? +(cnt['updateMs:main'] / upd).toFixed(1) : null, topSelf: selfTimes(profile, 12), extra };
    if (COUNTS) r.calls = await coverage();
    results.actions[aname] = r;
    console.log(`  ${name} ${aname}`, JSON.stringify({ lt: r.longTasks, longest: r.longestMs, tbt: r.tbtMs, worstFrame: fr && fr.worst, upd, perUpd: r.msPerUpdate, inInput: cnt['updateInInput:main'] || 0, maxPerFrame: fr && fr.maxPerFrame, draw: cnt['draw:main'] || 0 }));
    return r;
  }
  const settle = (ms) => page.waitForTimeout(ms * Math.max(1, CPU / 2));
  // S28: the block-index decimation returns Chart.js 4.4.0 min-max output (mean x to 1e-6 min) on random ranges.
  async function decimationParity() {
    return page.evaluate(() => {
      const c = window.Chart.getChart(document.getElementById('session-chart'));
      const pl = c && c.config.plugins.find((p) => p.id === 'hrDecimation');
      if (!pl) return { ok: false, why: 'no hrDecimation plugin' };
      let rng = 7; const rnd = () => ((rng = (rng * 1103515245 + 12345) % 2147483648) / 2147483648);
      let cases = 0, bad = 0, why = '';
      for (const ds of c.data.datasets.slice(0, 2)) {
        const data = ds._data || ds.data, orig = new Set(data);
        for (let k = 0; k < 150; k++) {
          const a = Math.floor(rnd() * (data.length - 2)), n = 2 + Math.floor(rnd() * (k % 3 ? 2000 : data.length - a - 2));
          const count = Math.min(n, data.length - a), W = [976, 300, 1200][k % 3];
          const fast = pl._parity.fast(data, a, count, W), walk = pl._parity.walk(data, a, count, W); cases++;
          const same = fast && fast.length === walk.length && fast.every((p, i) => orig.has(walk[i]) ? p === walk[i] : !orig.has(p) && p.y === walk[i].y && Math.abs(p.x - walk[i].x) < 1e-6);
          if (!same) {
            bad++;
            const i = fast ? fast.findIndex((p, i) => !(orig.has(walk[i]) ? p === walk[i] : !orig.has(p) && p.y === walk[i].y && Math.abs(p.x - walk[i].x) < 1e-6)) : -1;
            if (!why) why = `${ds.label} start ${a} count ${count} W ${W}: ${fast ? fast.length : 'null'} vs ${walk.length}` + (i >= 0 ? ` at ${i}: ${JSON.stringify(fast[i])} vs ${JSON.stringify(walk[i])} orig ${orig.has(fast[i])}/${orig.has(walk[i])}` : '');
          }
        }
      }
      return { ok: !bad, cases, bad, why };
    });
  }
  const chartRange = () => page.evaluate(() => { const c = window.Chart.getChart(document.getElementById('session-chart')); return c ? [c.scales.x.min, c.scales.x.max] : null; });

  await measure('1-load', async () => {
    await page.goto(DAYURL, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#view-day #session-chart', { timeout: 90000 });
    await page.waitForFunction(() => window.__perf.firstMainDraw != null, null, { timeout: 90000 });
    const first = await page.evaluate(() => Math.round(window.__perf.firstMainDraw));
    await settle(2500);
    return { firstChartDrawMs: first };
  }, { frames: false });

  async function drag(points, gap = 16) {
    const send = (type, x, y) => PHONE
      ? cdp.send('Input.dispatchTouchEvent', { type: { down: 'touchStart', move: 'touchMove', up: 'touchEnd' }[type], touchPoints: type === 'up' ? [] : [{ x, y }] })
      : cdp.send('Input.dispatchMouseEvent', { type: { down: 'mousePressed', move: 'mouseMoved', up: 'mouseReleased' }[type], x, y, button: 'left', buttons: type === 'up' ? 0 : 1, clickCount: 1 });
    await send('down', points[0][0], points[0][1]);
    for (const [x, y] of points.slice(1)) { await send('move', x, y); await page.waitForTimeout(gap); }
    const l = points[points.length - 1]; await send('up', l[0], l[1]);
  }
  const ov = async () => page.evaluate(() => { const o = document.getElementById('context-overlay'); o.scrollIntoView({ block: 'center' }); const r = o.getBoundingClientRect(); const b = document.getElementById('context-brush').getBoundingClientRect(); return { x: r.x, y: r.y + r.height / 2, w: r.width, bx: b.x, bw: b.width }; });
  const line = (x0, x1, y, n) => Array.from({ length: n + 1 }, (_, i) => [Math.round(x0 + (x1 - x0) * i / n), Math.round(y)]);
  // The chart's x range against the brush box: off by under one overlay pixel when the frame path caught up.
  const followGap = () => page.evaluate(() => {
    const c = window.Chart.getChart(document.getElementById('session-chart'));
    const o = document.getElementById('context-overlay'), b = document.getElementById('context-brush');
    const w = o.clientWidth, dur = c.scales.x.max - c.scales.x.min;
    const l = parseFloat(b.style.left), bw = parseFloat(b.style.width);
    return { min: c.scales.x.min, max: c.scales.x.max, left: l, width: bw, w, dur };
  });

  if (SHOTS) {
    const shoot = async (file) => { const el = page.locator('.chart-wrap').first(); await el.scrollIntoViewIfNeeded(); await el.screenshot({ path: path.join(SHOTS, file) }); console.log('shot', file); };
    const reset = async () => { await page.evaluate(() => document.getElementById('context-overlay').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))); await settle(600); };
    await settle(600);
    fs.mkdirSync(SHOTS, { recursive: true });
    await shoot(`${SHOT_PREFIX}-${SHOT_TAG}-${W}-full.png`);
    let o = await ov(); await settle(300); o = await ov();
    const dur = await page.evaluate(() => { const c = window.Chart.getChart(document.getElementById('session-chart')); return c.scales.x.max - c.scales.x.min; });
    await drag(line(o.bx + o.bw - 2, o.bx + Math.max(4, o.w * 10 / dur), o.y, 20)); await settle(600);
    if (!PHONE) await page.mouse.move(1, 1); await settle(300);
    console.log('10 min range', JSON.stringify(await chartRange()));
    await shoot(`${SHOT_PREFIX}-${SHOT_TAG}-${W}-10min.png`);
    await reset();
    if (PHONE) { const btn = page.locator('#markers-open').first(); if (await btn.count()) { await btn.click().catch(() => {}); await settle(600); } }
    const it = page.locator('#marker-list .marker-item').nth(5);
    await it.scrollIntoViewIfNeeded(); await it.click(); await settle(800);
    if (PHONE) { await page.keyboard.press('Escape').catch(() => {}); await settle(600); } else { await page.mouse.move(1, 1); await settle(300); }
    console.log('marker range', JSON.stringify(await chartRange()));
    await shoot(`${SHOT_PREFIX}-${SHOT_TAG}-${W}-marker.png`);
    if (!PHONE) {
      // Hover inside the first mark's label (row 0, 10 px right of its line).
      await reset();
      const p = await page.evaluate(() => {
        const c = window.Chart.getChart(document.getElementById('session-chart'));
        const ts = [...document.querySelectorAll('#marker-list .marker-item.type-event')].map((e) => Number(e.dataset.t)).filter((t) => t >= c.scales.x.min && t <= c.scales.x.max).sort((a, b) => a - b);
        c.canvas.scrollIntoView({ block: 'center' });
        const r = c.canvas.getBoundingClientRect();
        return { x: r.left + c.scales.x.getPixelForValue(ts[0]) + 10, y: r.top + c.chartArea.top + 4 + 11.2 + 18, t: ts[0] };
      });
      await page.mouse.move(p.x - 30, p.y); await settle(100); await page.mouse.move(p.x, p.y); await settle(400);
      const tip = await page.evaluate(() => { const e = document.getElementById('anno-tip'); return e && e.style.display !== 'none' ? e.textContent : null; });
      const hl = await page.evaluate(() => window.Chart.getChart(document.getElementById('session-chart')).$hlT);
      const row = await page.evaluate(() => { const e = document.querySelector('#marker-list .marker-item.chart-hover'); return e ? e.textContent.trim().slice(0, 40) : null; });
      console.log('hover', JSON.stringify({ at: p, tip, hl, listRow: row }));
      await shoot(`${SHOT_PREFIX}-${SHOT_TAG}-${W}-hover.png`);
    }
    if (errors.length) console.log('page errors', JSON.stringify(errors.slice(0, 5)));
    await ctx.close();
    return;
  }

  if (want('scroll')) await measure('2-scroll', async () => {
    const sc = await page.evaluate(() => { const c = [document.querySelector('main'), document.scrollingElement, document.body, ...document.querySelectorAll('[class*=view], section')].filter(Boolean);
      let el = null; for (const e of c) { const t = e.scrollTop; e.scrollTop = t + 50; if (e.scrollTop !== t) { e.scrollTop = 0; el = e; break; } }
      el = el || document.scrollingElement; el.scrollTop = 0; window.__sc = el; return { dist: el.scrollHeight - el.clientHeight }; });
    await cdp.send('Input.synthesizeScrollGesture', { x: PHONE ? W / 2 : 40, y: Math.round(H * 0.7), yDistance: -sc.dist, speed: 1200, gestureSourceType: PHONE ? 'touch' : 'mouse', preventFling: true });
    await settle(400);
    return sc;
  });

  if (want('brush')) {
    let o = await ov(); await settle(300);
    o = await ov();
    const dur = await page.evaluate(() => { const c = window.Chart.getChart(document.getElementById('session-chart')); return c ? c.scales.x.max - c.scales.x.min : 0; });
    const hi = o.bx + o.bw - 2, tgt = o.bx + Math.max(4, o.w * 10 / dur);
    await measure('3a-brush-zoom-10min', async () => { await drag(line(hi, tgt, o.y, 40)); await settle(300); return { follow: await followGap() }; });
    await page.evaluate(() => document.getElementById('context-overlay').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))); await settle(400);
    const o2 = await ov();
    await drag(line(o2.bx + o2.bw - 2, o2.bx + Math.max(60, o.w * 90 / dur), o.y, 6)); await settle(400);
    const o3 = await ov();
    await measure('3b-brush-pan', async () => { const mid = o3.bx + o3.bw / 2; await drag(line(mid, mid + o.w * 0.3, o.y, 40)); await settle(300); return { follow: await followGap() }; });
    await page.evaluate(() => document.getElementById('context-overlay').dispatchEvent(new MouseEvent('dblclick', { bubbles: true })));
    await settle(500);
  }

  // S32: a two-finger pinch on the chart at 360 (AUDIT-NOTES item 28), through the frame path.
  if (want('pinch') && PHONE && !MUTANT) {
    const p = await page.evaluate(() => { const c = window.Chart.getChart(document.getElementById('session-chart')); c.canvas.scrollIntoView({ block: 'center' }); const r = c.canvas.getBoundingClientRect(), a = c.chartArea; return { x: Math.round(r.left + (a.left + a.right) / 2), y: Math.round(r.top + (a.top + a.bottom) / 2) }; });
    await settle(300);
    const tp = (type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map(([x, y], id) => ({ x: Math.round(x), y: Math.round(y), id })) });
    await measure('4-pinch', async () => {
      await tp('touchStart', [[p.x - 15, p.y], [p.x + 15, p.y]]);
      for (let i = 1; i <= 20; i++) { const d = 15 + 150 * i / 20; await tp('touchMove', [[p.x - d, p.y], [p.x + d, p.y]]); await page.waitForTimeout(16); }
      await tp('touchEnd', []); await settle(300);
      return { range: await chartRange() };
    });
    await page.evaluate(() => document.getElementById('context-overlay').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))); await settle(500);
  }

  if (want('marker') && !MUTANT) {
    if (PHONE) { const btn = page.locator('#markers-open').first(); if (await btn.count()) { await btn.click().catch(() => {}); await settle(600); } }
    await measure('5-marker-click', async () => {
      const it = page.locator('#marker-list .marker-item').nth(5);
      await it.scrollIntoViewIfNeeded({ timeout: 5000 }); await it.click({ timeout: 5000 }); await settle(800);
      return { range: await chartRange() };
    });
    await page.keyboard.press('Escape').catch(() => {});
    await page.evaluate(() => { const o = document.getElementById('context-overlay'); o && o.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); });
    await settle(500);
  }

  if (want('hover') && !PHONE) await measure('6-hover-sweep', async () => {
    const r = await page.evaluate(() => { const c = document.getElementById('session-chart'); c.scrollIntoView({ block: 'center' }); const b = c.getBoundingClientRect(); return { x: b.x, y: b.y + b.height / 2, w: b.width }; });
    // Highlight moves: how often the highlight time changed under the sweep (it follows the hovered marks).
    let lit = 0, last;
    for (let i = 0; i <= 60; i++) {
      await page.mouse.move(r.x + 40 + (r.w - 80) * i / 60, r.y); await page.waitForTimeout(16);
      const t = await page.evaluate(() => { const c = window.Chart.getChart(document.getElementById('session-chart')); return c ? c.$hlT : undefined; });
      if (i && t !== last) lit++;
      last = t;
    }
    await settle(200); return { moves: 61, highlightedMoves: lit };
  });

  if (want('views') && !MUTANT) for (const v of ['week', 'month', 'day']) await measure('7-to-' + v, async () => {
    await page.evaluate(() => { const m = document.querySelector('main'); if (m) m.scrollTop = 0; });
    await page.evaluate((h) => { location.hash = h; }, { week: '#/week/2026-09-15', month: '#/month/2026-09', day: '#/day/2026-09-15' }[v]); await settle(2000); return { hash: await page.evaluate(() => location.hash) };
  }, { frames: false });

  if (want('idle') && !MUTANT) await measure('8-idle-10s', async () => { await page.waitForTimeout(10000); return null; });

  // After the timed actions: the check allocates enough to put a GC inside them.
  if (!MUTANT) { results.decimation = await decimationParity(); console.log('  decimation parity', JSON.stringify(results.decimation)); }
  results.errors = errors.slice(0, 10);
  fs.mkdirSync(OUTDIR, { recursive: true });
  const out = path.join(OUTDIR, `result-${name}-${W}-cpu${CPU}${MUTANT ? '-mut-' + MUTANT : ''}${COUNTS ? '-counts' : ''}.json`);
  fs.writeFileSync(out, JSON.stringify(results, null, 1));
  console.log('  wrote', out);
  await ctx.close();
  return results;
}

// ---- Budgets (REPORT.md "Budgets for checks") ----
function budgetRows(res) {
  const A = res.actions, { name, W, CPU } = res.config, rowsOut = [];
  const add = (group, cond, msg) => rowsOut.push({ group, cond, msg: `${W} ${CPU}x: ${msg}` });
  const cell = (a, f) => (A[a] ? f(A[a]) : null);
  for (const a of ['3a-brush-zoom-10min', '3b-brush-pan']) {
    const r = A[a]; if (!r) continue;
    const inInput = r.counts['updateInInput:main'] || 0, perFrame = r.frames ? r.frames.maxPerFrame : 99;
    add('brush', inInput === 0 && perFrame <= 1, `${a} at most 1 chart update per frame, none from pointermove (${perFrame} max per frame, ${inInput} from input, ${r.counts['update:main'] || 0} updates)`);
    const f = r.extra && r.extra.follow;
    // The fixture day has no DST change: 1440 minutes on the strip.
    if (f) { const lo = f.left / f.w * 1440, hi = (f.left + f.width) / f.w * 1440, tol = 1440 / f.w;
      add('brush', Math.abs(f.min - lo) < tol && Math.abs(f.max - hi) < tol, `${a} chart range follows the brush within one strip pixel ([${f.min.toFixed(2)}, ${f.max.toFixed(2)}] against [${lo.toFixed(2)}, ${hi.toFixed(2)}])`); }
    if (name === 'desk') add('brush', r.longestMs <= 50, `${a} no task over 50 ms (${r.longestMs} ms)`);
  }
  if (name === 'phone') {
    let ms = 0, n = 0;
    for (const a of ['3a-brush-zoom-10min', '3b-brush-pan']) if (A[a]) { ms += A[a].counts['updateMs:main'] || 0; n += A[a].counts['update:main'] || 0; }
    if (n) add('update', ms / n < 16, `one chart update under 16 ms in the drags (${(ms / n).toFixed(1)} ms over ${n})`);
    const d = A['7-to-day'];
    if (d) add('route', d.longestMs < 200, `Month to Day longest task under 200 ms (${d.longestMs} ms)`);
  }
  const pz = A['4-pinch'];
  if (pz) add('pinch', pz.longestMs <= 50 && pz.frames && pz.frames.maxPerFrame <= 1 && !(pz.counts['updateInInput:main'] || 0), `4-pinch no task over 50 ms, at most 1 chart update per frame (${pz.longestMs} ms, ${pz.frames && pz.frames.maxPerFrame} max per frame, ${pz.counts['update:main'] || 0} updates)`);
  const h = A['6-hover-sweep'];
  if (h) add('hover', (h.counts['update:main'] || 0) === 0 && h.extra && h.extra.highlightedMoves > 0, `hover sweep runs 0 chart updates (${h.counts['update:main'] || 0} over 61 moves, highlight moved ${h.extra && h.extra.highlightedMoves} times)`);
  const m = A['5-marker-click'];
  if (m && name === 'desk') add('marker', m.frames.worst < 50, `marker ease worst frame under 50 ms (${m.frames.worst} ms, ${m.counts['update:main'] || 0} updates)`);
  for (const a of ['2-scroll', '8-idle-10s']) {
    const r = A[a]; if (!r) continue;
    add('floor', r.longTasks === 0 && (r.counts['update:main'] || 0) === 0, `${a} 0 long tasks and 0 chart updates (${r.longTasks}, ${r.counts['update:main'] || 0})`);
  }
  const dp = res.decimation;
  if (dp) add('decimation', dp.ok, `decimation matches Chart.js min-max on ${dp.cases} random ranges (${dp.bad} differ${dp.why ? ': ' + dp.why : ''})`);
  add('errors', !res.errors.length, `no page errors ${res.errors.join(' | ')}`);
  return rowsOut;
}

for (const [name, W, CPU] of runs) {
  console.log(`== ${name} ${W} at ${CPU}x${MUTANT ? ' mutant ' + MUTANT : ''}`);
  const res = await runConfig(name, W, CPU);
  if (!res || name === 'adhoc') continue;
  const br = budgetRows(res);
  if (MUTANT) {
    const mine = br.filter((r) => MUTANTS[MUTANT].rows.includes(r.group));
    const failed = mine.filter((r) => !r.cond);
    for (const r of mine) console.log('  ' + (r.cond ? 'ok   ' : 'fail ') + r.msg);
    ok(mine.length > 0 && failed.length > 0, `MUTANT ${MUTANT}: ${MUTANTS[MUTANT].why}: ` + (failed.length ? 'FAILED as required' : 'NOT CAUGHT'));
  } else for (const r of br) ok(r.cond, r.msg);
}
console.log(`viewer-perf: ${passes} pass, ${fails} fail`);
await browser.close(); server.close();
process.exit(fails ? 1 : 0);
