// Widget parity: hr_monitor.html vs overlay.html across every body-class toggle combination,
// plus the OBS-size sweep, the phone layout (monitor and landing), the Work Sans load and the trend look.
// Usage: node scripts/widget-parity.mjs [--root <dir>] [--verbose]
// Geometry is measured with each page's own font; the widget sets its face itself (--no-pin is accepted and ignored).
// Exit 0 when the only differences are the ALLOWED list below and every assertion holds; 1 otherwise.

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { uxDir } from './ux-dir.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const argVal = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const ROOT = path.resolve(argVal('--root') || path.join(here, '..'));
const VERBOSE = args.includes('--verbose');
const KIT = argVal('--kit') || path.join(uxDir(here, argVal('--ux')), 'kit', 'package.json');

const TOGGLES = ['no-hr', 'no-hrv', 'no-live-hr', 'no-inline-trends', 'no-palp-chip',
  'no-warning', 'warning-above', 'no-conn-dot', 'conn-live', 'conn-reconnecting'];
const WARNS = ['none', 'warn-high', 'warn-low', 'warn-crash', 'warn-palp'];
const PHONE_WIDTHS = [320, 360, 412];

const ALLOWED = [];

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png', '.woff2': 'font/woff2' };

function serve(root) {
  const server = http.createServer((req, res) => {
    const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    const file = path.join(root, rel);
    if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404); res.end(); return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((ok) => server.listen(0, '127.0.0.1', () => ok(server)));
}

async function launch() {
  const { chromium } = createRequire(KIT)('playwright');
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'widget-parity-'));
  const opts = { headless: true, viewport: { width: 1440, height: 900 } };
  let ctx;
  try { ctx = await chromium.launchPersistentContext(profile, opts); }
  catch { ctx = await chromium.launchPersistentContext(profile, { ...opts, channel: 'chrome' }); }
  return { ctx, profile };
}

// Runs in the page. Same DOM writes on both pages; the pages' own scripts are IIFEs.
// phone: also record the declared first grid track, the number size and overflow per combination.
function measureAll({ toggles, warns, phone }) {
  const ICON = '<svg viewBox="0 0 24 24"><polyline points="17 11 12 6 7 11"></polyline></svg>';
  const body = document.body;
  const widget = document.getElementById('hr-widget');
  const big = document.getElementById('hr-big');
  document.getElementById('compact-hrv-value').textContent = '42';
  big.textContent = '128';
  const banners = ['warning-banner', 'warning-banner-above'].map((id) => document.getElementById(id));
  const root = getComputedStyle(document.documentElement);
  const label = widget.querySelector('.widget-label');
  const range = document.createRange();
  range.setStart(big.firstChild, 0); range.setEnd(big.firstChild, 1);
  const r1 = (v) => Math.round(v * 10) / 10;
  const once = {
    'colour --warn-high': root.getPropertyValue('--warn-high').trim(),
    'colour --warn-low': root.getPropertyValue('--warn-low').trim(),
    'colour --warn-crash': root.getPropertyValue('--warn-crash').trim(),
    'colour --warn-palp': root.getPropertyValue('--warn-palp').trim(),
    'label font-family': getComputedStyle(label).fontFamily,
    'glyph width': String(r1(range.getBoundingClientRect().width)),
  };
  // Winning grid-template-columns declaration for the widget: !important first, then source order.
  const gridRules = [];
  const walk = (rules) => {
    for (const r of rules) {
      if (r.media && r.cssRules) { if (matchMedia(r.media.mediaText).matches) walk(r.cssRules); continue; }
      if (r.conditionText != null && r.cssRules) { if (CSS.supports(r.conditionText)) walk(r.cssRules); continue; }
      if (r.style && r.style.gridTemplateColumns) gridRules.push(r);
    }
  };
  if (phone) for (const sheet of document.styleSheets) { try { walk(sheet.cssRules); } catch { /* cross-origin */ } }
  // Specificity of a simple selector list part: [ids, classes and attributes and pseudo-classes, types].
  const spec = (sel) => {
    const s = sel.replace(/::?[a-z-]+\([^)]*\)/g, (m) => (m.startsWith('::') ? ' ' : '.x ')).replace(/::[a-z-]+/g, ' t');
    return [(s.match(/#[\w-]+/g) || []).length, (s.match(/\.[\w-]+|\[[^\]]*\]|:[a-z-]+/g) || []).length,
      (s.replace(/#[\w-]+|\.[\w-]+|\[[^\]]*\]|:[a-z-]+/g, ' ').match(/(^|[\s>+~])[a-z][\w-]*/gi) || []).length];
  };
  const cmp = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
  const lexGreater = (a, b) => { for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] > b[i]; return false; };
  const declared = () => {
    let win = null, winKey = null;
    gridRules.forEach((r, order) => {
      const parts = r.selectorText.split(',').map((x) => x.trim()).filter((x) => widget.matches(x));
      if (!parts.length) return;
      const sp = parts.map(spec).sort(cmp).pop();
      const key = [r.style.getPropertyPriority('grid-template-columns') === 'important' ? 1 : 0, ...sp, order];
      if (!winKey || lexGreater(key, winKey)) { win = r; winKey = key; }
    });
    return win ? win.style.gridTemplateColumns : '';
  };
  const rows = {};
  const n = 1 << toggles.length;
  for (let mask = 0; mask < n; mask++) {
    toggles.forEach((t, i) => body.classList.toggle(t, !!(mask & (1 << i))));
    for (const w of warns) {
      const type = body.classList.contains('conn-reconnecting') ? 'status-reconnecting' : w;
      for (const b of banners) {
        b.classList.remove('warn-high', 'warn-low', 'warn-crash', 'warn-palp', 'status-reconnecting', 'active');
        b.querySelector('.warning-banner-icon').innerHTML = '';
        b.querySelector('.warning-banner-text').textContent = '';
        if (type !== 'none') {
          b.classList.add(type, 'active');
          b.querySelector('.warning-banner-icon').innerHTML = ICON;
          b.querySelector('.warning-banner-text').textContent = type;
        }
      }
      const r = widget.getBoundingClientRect();
      const cs = getComputedStyle(widget);
      const row = { rect: `${r1(r.width)}x${r1(r.height)}`, gridTemplateColumns: cs.gridTemplateColumns, padding: cs.padding };
      if (phone) {
        const se = document.scrollingElement;
        row.numberSize = getComputedStyle(big).fontSize;
        row.declaredCols = declared();
        row.pageOverflow = se.scrollWidth > se.clientWidth;
        row.widgetOverflow = widget.scrollWidth > widget.clientWidth;
      }
      rows[`${mask}|${w}`] = row;
    }
  }
  return { once, rows };
}

const settle = (page) => page.evaluate(() => new Promise((ok) => {
  let n = 0; const tick = () => (++n < 4 ? requestAnimationFrame(tick) : ok()); requestAnimationFrame(tick);
}));

const freeze = (page) => page.evaluate(() => {
  const style = document.createElement('style');
  style.textContent = '*, *::before, *::after { animation: none !important; transition: none !important; }';
  document.head.appendChild(style);
});

// The overlay gets the monitor's --full-widgets-width over the relay; the zone width stands in for the monitor's 340 px column.
async function load(page, url, from) {
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForFunction(() => typeof Chart !== 'undefined' && document.fonts.status === 'loaded', null, { timeout: 15000 }).catch(() => {});
  if (!from) {
    await page.waitForFunction(() => document.documentElement.style.getPropertyValue('--full-widgets-width'), null, { timeout: 10000 }).catch(() => {});
  } else {
    await page.evaluate((f) => {
      document.documentElement.style.setProperty('--full-widgets-width', f.full);
      if (f.zoneWidth) document.getElementById('overlay-zone').style.width = f.zoneWidth + 'px';
    }, from);
  }
  const labelFont = await page.evaluate(() => getComputedStyle(document.querySelector('#hr-widget .widget-label')).fontFamily);
  await freeze(page);
  await settle(page);
  const out = await page.evaluate(() => {
    const z = document.getElementById('overlay-zone'), cs = getComputedStyle(z);
    const w = document.getElementById('hr-widget'), ws = getComputedStyle(w);
    const big = getComputedStyle(document.getElementById('hr-big'));
    const num = (id) => parseInt((document.getElementById(id) || {}).value, 10) || 0;
    return {
      layout: `big-number ${big.fontSize}, padding ${ws.padding}`,
      obs: { w: num('obs-size-w'), h: num('obs-size-h') },
      full: document.documentElement.style.getPropertyValue('--full-widgets-width'),
      zoneWidth: z.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight),
    };
  });
  return { ...out, labelFont };
}

// Same emulation as ux-audit/scripts/env.mjs textScale: every element's computed font size times f, once.
const textScale = (page, f) => page.evaluate((k) => {
  const els = [...document.querySelectorAll('body, body *')].filter((e) => !(e instanceof SVGElement));
  const sizes = els.map((e) => parseFloat(getComputedStyle(e).fontSize));
  els.forEach((e, i) => e.style.setProperty('font-size', sizes[i] * k + 'px', 'important'));
}, f);

// Every Work Sans face loads, and a test string set in it measures differently from the fallback face.
const fontCheck = (page) => page.evaluate(async () => {
  const faces = [...document.fonts].filter((f) => /Work Sans/.test(f.family));
  const before = faces.map((f) => f.status);
  const label = getComputedStyle(document.querySelector('#hr-widget .widget-label')).fontFamily;
  const usedBefore = /^"?Work Sans/.test(label) && document.fonts.check('600 12px "Work Sans"', 'bpm');
  await Promise.all(faces.map((f) => f.load().catch(() => {})));
  const span = (fam) => {
    const s = document.createElement('span');
    s.textContent = 'Heart rate high, HRV crashed 0123456789';
    s.style.cssText = `position:absolute;visibility:hidden;white-space:nowrap;font:600 12px ${fam}`;
    document.body.appendChild(s); const w = s.getBoundingClientRect().width; s.remove(); return w;
  };
  const work = span("'Work Sans', -apple-system, 'Segoe UI', Roboto, sans-serif");
  const fallback = span("-apple-system, 'Segoe UI', Roboto, sans-serif");
  return { faces: faces.length, before, after: faces.map((f) => f.status), work, fallback, label, usedBefore };
});

// HR trend coloured per segment by zone, HRV line dashed: feed the page's own compact chart a ramp and read pixels.
const trendCheck = (page) => page.evaluate(async () => {
  document.body.classList.remove('no-hr', 'no-hrv', 'no-live-hr', 'no-inline-trends', 'no-palp-chip', 'no-warning', 'warning-above', 'no-conn-dot', 'conn-reconnecting');
  document.body.classList.add('conn-live', 'connected');
  const canvas = document.getElementById('compact-chart');
  const chart = Chart.getChart(canvas);
  if (!chart) return { error: 'no chart' };
  const hr = [], rm = [];
  for (let i = 0; i <= 60; i++) { hr.push({ x: i * 0.05, y: 60 + i * (85 / 60) }); rm.push({ x: i * 0.05, y: 30 }); }
  chart.data.datasets[0].data = hr; chart.data.datasets[1].data = rm;
  chart.options.scales.x.min = 0; chart.options.scales.x.max = 3;
  chart.options.scales.y1.min = 0; chart.options.scales.y1.max = 60;
  chart.resize(); chart.update('none');
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  const st = getComputedStyle(document.getElementById('hr-widget'));
  const hex = (n) => { const v = st.getPropertyValue(n).trim(); const k = parseInt(v.slice(1), 16); return [(k >> 16) & 255, (k >> 8) & 255, k & 255]; };
  const stages = ['--stage-1', '--stage-2', '--stage-3', '--stage-4', '--stage-5'].map(hex);
  const text = hex('--text');
  const ctx = canvas.getContext('2d');
  const { width: W, height: H } = canvas;
  const img = ctx.getImageData(0, 0, W, H).data;
  const near = (i, c) => Math.abs(img[i] - c[0]) < 40 && Math.abs(img[i + 1] - c[1]) < 40 && Math.abs(img[i + 2] - c[2]) < 40 && img[i + 3] > 120;
  const seen = new Set();
  for (let p = 0; p < W * H * 4; p += 4) stages.forEach((c, k) => { if (near(p, c)) seen.add(k + 1); });
  const y1 = chart.scales.y1; const ratio = W / canvas.clientWidth;
  const yRow = Math.round(y1.getPixelForValue(30) * ratio);
  let runs = 0, on = false, best = { runs: 0 };
  for (const y of [yRow - 2, yRow - 1, yRow, yRow + 1, yRow + 2]) {
    runs = 0; on = false;
    for (let x = Math.round(W * 0.05); x < Math.round(W * 0.95); x++) {
      const hit = near((y * W + x) * 4, text);
      if (hit && !on) runs++;
      on = hit;
    }
    if (runs > best.runs) best = { runs, y };
  }
  return { size: `${W}x${H}`, yRow, stagesSeen: [...seen].sort(), hrvRuns: best.runs, hrvDash: JSON.stringify(chart.data.datasets[1].borderDash), hrvColour: chart.data.datasets[1].borderColor };
});

const hex = (v) => v.toUpperCase();

function compare(mon, ovl, fields) {
  const out = [];
  for (const k of Object.keys(mon)) {
    for (const f of fields) {
      if (mon[k][f] !== ovl[k][f]) {
        const [mask, w] = k.split('|');
        const on = TOGGLES.filter((_, i) => mask & (1 << i)).join(' ') || '(none)';
        out.push({ key: `${f} [${on}] warn=${w}`, monitor: mon[k][f], overlay: ovl[k][f] });
      }
    }
  }
  return out;
}

async function main() {
  const t0 = Date.now();
  const server = await serve(ROOT);
  const base = `http://127.0.0.1:${server.address().port}`;
  const { ctx, profile } = await launch();
  let code = 1;
  try {
    await ctx.route('**/*', (route) => {
      const u = route.request().url();
      if (u.startsWith(base) || u.includes('cdnjs.cloudflare.com') || u.includes('fonts.googleapis.com') || u.includes('fonts.gstatic.com')) return route.continue();
      return route.abort();
    });
    const errors = [];
    const pageFor = async () => {
      const p = await ctx.newPage();
      p.on('pageerror', (e) => errors.push(`${p.url().split('/').pop()}: ${e.message}`));
      return p;
    };
    const fails = [];
    const check = (ok, what) => { if (!ok) fails.push(what); };

    const [pm, po, pobs] = await Promise.all([pageFor(), pageFor(), pageFor()]);
    const overlayUrl = `${base}/overlay.html?bg=transparent&autoreload=0`;
    const shared = await load(pm, `${base}/hr_monitor.html?mode=offline`);
    const ovlInfo = await load(po, overlayUrl, shared);
    const obsW = shared.obs.w || 380, obsH = shared.obs.h || 260;
    await pobs.setViewportSize({ width: obsW, height: obsH });
    const obsInfo = await load(pobs, overlayUrl, { full: shared.full, zoneWidth: 0 });
    const mon = await pm.evaluate(measureAll, { toggles: TOGGLES, warns: WARNS });
    const ovl = await po.evaluate(measureAll, { toggles: TOGGLES, warns: WARNS });
    const obs = await pobs.evaluate(measureAll, { toggles: TOGGLES, warns: WARNS });
    mon.once['label font-family'] = shared.labelFont;
    ovl.once['label font-family'] = ovlInfo.labelFont;
    mon.once['OBS layout'] = shared.layout;
    ovl.once['OBS layout'] = obsInfo.layout;

    const diffs = [];
    for (const k of Object.keys(mon.once)) {
      const a = mon.once[k], b = ovl.once[k];
      if ((k.startsWith('colour') ? hex(a) !== hex(b) : a !== b)) diffs.push({ key: k, monitor: a, overlay: b });
    }
    const keys = Object.keys(mon.rows);
    diffs.push(...compare(mon.rows, ovl.rows, ['rect', 'gridTemplateColumns', 'padding']));
    const obsDiffs = compare(mon.rows, obs.rows, ['rect', 'gridTemplateColumns', 'padding']);
    diffs.push(...obsDiffs.map((d) => ({ ...d, key: `OBS ${d.key}` })));

    // Phone layout on the monitor, then at 200% text; landing and overlay classes and overflow.
    const phone = {};
    for (const scale of [1, 2]) {
      for (const w of PHONE_WIDTHS) {
        const p = await pageFor();
        await p.setViewportSize({ width: w, height: 800 });
        await load(p, `${base}/hr_monitor.html?mode=offline`);
        if (scale !== 1) { await textScale(p, scale); await settle(p); }
        const hasClass = await p.evaluate(() => document.body.classList.contains('phone-widget'));
        const res = await p.evaluate(measureAll, { toggles: TOGGLES, warns: WARNS, phone: true });
        const tag = `monitor ${w}${scale !== 1 ? ' 200%' : ''}`;
        check(hasClass, `${tag}: body.phone-widget missing`);
        let bad = { padding: 0, size: 0, col: 0, page: 0, widget: 0 }, colChecked = 0;
        const want = `${56 * scale}px`;
        for (const [k, r] of Object.entries(res.rows)) {
          const mask = +k.split('|')[0];
          const has = (t) => !!(mask & (1 << TOGGLES.indexOf(t)));
          if (r.padding !== '12px 14px') bad.padding++;
          if (!has('no-hr') && r.numberSize !== want) bad.size++;
          colChecked++; if (!/^minmax\(/.test(r.declaredCols)) bad.col++;
          if (r.pageOverflow) bad.page++;
          if (r.widgetOverflow) { bad.widget++; if (bad.widget <= 3) fails.push(`${tag}: widget overflows with [${TOGGLES.filter((t) => has(t)).join(' ') || '(none)'}] warn=${k.split('|')[1]}`); }
        }
        phone[tag] = { combos: keys.length, colChecked, ...bad };
        for (const [f, n] of Object.entries(bad)) check(n === 0, `${tag}: ${f} wrong in ${n} of ${keys.length}`);
        await p.close();
      }
    }
    const landing = {}, overlayClass = {};
    for (const w of PHONE_WIDTHS) {
      const p = await pageFor();
      await p.setViewportSize({ width: w, height: 800 });
      await p.goto(`${base}/index.html`, { waitUntil: 'load' });
      await settle(p);
      const r = await p.evaluate(() => {
        const se = document.scrollingElement, wd = document.getElementById('hr-widget');
        return { cls: document.body.classList.contains('phone-widget'), page: se.scrollWidth > se.clientWidth, widget: wd.scrollWidth > wd.clientWidth };
      });
      landing[w] = r;
      check(r.cls, `landing ${w}: body.phone-widget missing`);
      check(!r.page, `landing ${w}: page overflows horizontally`);
      check(!r.widget, `landing ${w}: widget overflows horizontally`);
      await p.close();
    }
    for (const w of [...PHONE_WIDTHS, obsW]) {
      const p = await pageFor();
      await p.setViewportSize({ width: w, height: 400 });
      await p.goto(overlayUrl, { waitUntil: 'load' });
      const cls = await p.evaluate(() => document.body.classList.contains('phone-widget') || document.documentElement.classList.contains('phone-widget'));
      overlayClass[w] = cls;
      check(!cls, `overlay ${w}: carries phone-widget`);
      await p.close();
    }

    // Work Sans on all three pages; trend look on monitor and overlay.
    const pl = await pageFor();
    await pl.goto(`${base}/index.html`, { waitUntil: 'load' });
    const fonts = { monitor: await fontCheck(pm), overlay: await fontCheck(po), landing: await fontCheck(pl) };
    for (const [pg, f] of Object.entries(fonts)) {
      check(f.usedBefore, `${pg}: label face is ${f.label}, or Work Sans was not loaded before the check forced it`);
      check(f.faces > 0 && f.after.every((s) => s === 'loaded'), `${pg}: Work Sans faces not all loadable (${f.after.join(',')})`);
      check(Math.abs(f.work - f.fallback) > 0.5, `${pg}: Work Sans width equals fallback (${f.work} vs ${f.fallback})`);
    }
    await pl.close();
    const trend = { monitor: await trendCheck(pm), overlay: await trendCheck(po) };
    for (const [pg, t] of Object.entries(trend)) {
      check(!t.error && t.stagesSeen.length >= 4, `${pg}: HR trend shows ${t.error || t.stagesSeen.length} stage colours, want >= 4`);
      check(!t.error && t.hrvRuns >= 10, `${pg}: HRV line ${t.error || t.hrvRuns + ' dash runs'}, want a dashed line`);
    }

    console.log(`widget-parity: root ${ROOT}`);
    console.log(`combinations: ${1 << TOGGLES.length} toggle sets x ${WARNS.length} warning states = ${keys.length} per page`);
    console.log(`viewport 1440x900, overlay zone ${shared.zoneWidth}px, --full-widgets-width ${shared.full || 'unset'}`);
    console.log(`OBS case: overlay at ${obsW}x${obsH} (monitor OBS size fields${shared.obs.w ? '' : ' empty, default used'}), full sweep against the monitor preview, ${obsDiffs.length} differences`);
    console.log(`OBS layout: monitor ${shared.layout} | overlay ${obsInfo.layout}`);
    console.log(`geometry measured with each page's own font: monitor label ${shared.labelFont} | overlay label ${ovlInfo.labelFont}`);
    console.log(`allow-list (known differences): ${ALLOWED.length ? '' : 'empty'}`);
    for (const a of ALLOWED) console.log(`  ${a.key}: monitor ${a.monitor}, overlay ${a.overlay} (${a.where})`);
    for (const [tag, r] of Object.entries(phone)) console.log(`phone ${tag}: ${r.combos} combos, column checked in ${r.colChecked}; wrong padding ${r.padding}, number ${r.size}, column ${r.col}, page overflow ${r.page}, widget overflow ${r.widget}`);
    for (const [w, r] of Object.entries(landing)) console.log(`landing ${w}: phone-widget ${r.cls}, page overflow ${r.page}, widget overflow ${r.widget}`);
    console.log(`overlay phone-widget at ${Object.entries(overlayClass).map(([w, c]) => `${w} ${c}`).join(', ')}`);
    for (const [pg, f] of Object.entries(fonts)) console.log(`Work Sans ${pg}: ${f.faces} faces, label ${f.label}, in use before forcing ${f.usedBefore}, status before ${f.before.join(',')}, after load() ${f.after.join(',')}; test string ${f.work.toFixed(1)} px vs fallback ${f.fallback.toFixed(1)} px`);
    for (const [pg, t] of Object.entries(trend)) console.log(`trend ${pg} (canvas ${t.size}, HRV row ${t.yRow}): stage colours seen ${t.error || t.stagesSeen.join(',')}; HRV ${t.hrvColour} dash ${t.hrvDash}, ${t.hrvRuns} dash runs`);

    const allowedSeen = [], unexpected = [];
    for (const d of diffs) {
      const a = ALLOWED.find((x) => x.key === d.key && hex(x.monitor) === hex(d.monitor) && hex(x.overlay) === hex(d.overlay));
      (a ? allowedSeen : unexpected).push(d);
    }
    const missing = ALLOWED.filter((a) => !allowedSeen.some((d) => d.key === a.key));
    console.log(`allowed differences seen: ${allowedSeen.length} of ${ALLOWED.length}`);
    if (missing.length) console.log(`allow-list entries no longer differing (update the list): ${missing.map((m) => m.key).join(', ')}`);
    if (errors.length) console.log(`page errors: ${errors.length}\n  ${errors.slice(0, 5).join('\n  ')}`);
    if (unexpected.length) {
      const byField = {};
      for (const d of unexpected) { const f = d.key.split(' [')[0]; byField[f] = (byField[f] || 0) + 1; }
      console.log(`UNEXPECTED differences: ${unexpected.length} (${Object.entries(byField).map(([f, n]) => `${f} ${n}`).join(', ')})`);
      for (const d of unexpected.slice(0, VERBOSE ? Infinity : 25)) console.log(`  ${d.key}: monitor ${d.monitor} | overlay ${d.overlay}`);
      if (!VERBOSE && unexpected.length > 25) console.log(`  ... ${unexpected.length - 25} more (--verbose)`);
    }
    if (fails.length) { console.log(`FAILED assertions: ${fails.length}`); for (const f of fails) console.log(`  ${f}`); }
    code = unexpected.length || missing.length || fails.length || errors.length ? 1 : 0;
    console.log(`${code ? 'FAIL' : 'PASS'} in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  } finally {
    await ctx.close();
    server.close();
    fs.rmSync(profile, { recursive: true, force: true });
  }
  process.exit(code);
}

main().catch((e) => { console.error(e); process.exit(1); });
