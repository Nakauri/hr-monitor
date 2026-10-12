// Guards: AUDIT-NOTES 2026-10-11 items 23 to 26 (Khal 2026-10-12): laptop layer chips, the markers sidebar that resized the chart and repeated the filters, the curved marker strip, uneven Day card padding; plus Reset zoom colliding with Layers, Markers or the open panel, and markers kept out of Layers. Files: hrv_viewer.html. Runtime about 60 s; --mutants about 3 min.
// S31 Day panels, headless.
// 1. Layers (laptop): no layer chips on the page; the Layers popover, by real clicks, toggles every available layer, the
//    chart and the marker list follow, and a second click restores them; groups Lines, Events, Context; no marker rows
//    inside; Escape closes it and focus returns to the button.
// 2. Markers drawer (laptop): the chart canvas keeps its width when the panel opens and closes; the close button and Escape
//    close it, focus returns to the Markers button.
// 3. Reset zoom never intersects Layers, Markers or the open panel, at 1440 (panel open and closed) and 360.
// 4. Marker strip: the inner edge is straight (pixel columns).
// 5. Day cards: one padding and one gap, within 1 px, at 1440 and 360.
// 6. Phone: tools row on one line at 360 and 360 at 200% text; the Layers sheet holds no marker rows; the Markers sheet
//    holds the list, and tapping a marker closes it and changes the chart range.
// --mutants: each named bug is put back into the viewer and its check must FAIL.
// Usage: node scripts/day-panels.mjs [--mutants] [--ux <ux-audit dir>]
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
const VIEWER = fs.readFileSync(path.join(ROOT, 'hrv_viewer.html'), 'utf8');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png', '.woff2': 'font/woff2', '.csv': 'text/csv' };

function serve(viewerHtml) {
  const server = http.createServer((req, res) => {
    const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (rel === '/hrv_viewer.html') { res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' }); res.end(viewerHtml); return; }
    const file = path.join(ROOT, rel);
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(fs.readFileSync(file));
  });
  return new Promise((ok) => server.listen(0, '127.0.0.1', () => ok({ server, base: `http://127.0.0.1:${server.address().port}` })));
}

let browser;
try { browser = await chromium.launch(); } catch (e) { browser = await chromium.launch({ channel: 'chrome' }); }
async function openDay(base, width, scale = 1) {
  const phone = width < 600;
  const ctx = await browser.newContext({ viewport: { width, height: phone ? 740 : 900 }, deviceScaleFactor: 1, isMobile: phone, hasTouch: phone, timezoneId: 'America/Edmonton' });
  await ctx.route('**/*', (route) => {
    const u = route.request().url();
    if (u.startsWith('http://127.0.0.1:') || u.startsWith('data:') || u.startsWith('blob:')) return route.continue();
    if (/chart\.umd(\.min)?\.js/.test(u)) return route.fulfill({ status: 200, contentType: 'text/javascript', body: fs.readFileSync(CHART) });
    if (/fonts\.(googleapis|gstatic)\.com|cdn\.jsdelivr\.net|cdnjs\.cloudflare\.com/.test(u)) return route.continue();
    return route.fulfill({ status: 204, body: '' });
  });
  const page = await ctx.newPage();
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(e.message));
  await page.goto(base + '/hrv_viewer.html?demo=1#/day/2026-04-26', { waitUntil: 'networkidle' });
  await page.waitForSelector('#view-day #session-chart', { timeout: 40000 }).catch(() => {});
  await page.waitForTimeout(1200);
  if (scale !== 1) {
    await page.evaluate((f) => {
      const els = [...document.querySelectorAll('body, body *')].filter((e) => !(e instanceof SVGElement));
      const sizes = els.map((e) => parseFloat(getComputedStyle(e).fontSize));
      els.forEach((e, i) => e.style.setProperty('font-size', sizes[i] * f + 'px', 'important'));
      window.dispatchEvent(new Event('resize'));
    }, scale);
    await page.waitForTimeout(500);
  }
  return { ctx, page };
}
const rect = (page, sel) => page.evaluate((sel) => { const e = document.querySelector(sel); if (!e) return null; const r = e.getBoundingClientRect(); return { l: r.left, t: r.top, r: r.right, b: r.bottom, w: r.width, h: r.height, shown: r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== 'hidden' }; }, sel);
const hits = (a, b) => !!a && !!b && a.shown && b.shown && a.l < b.r && a.r > b.l && a.t < b.b && a.b > b.t;
const chartSig = (page) => page.evaluate(() => {
  const c = Chart.getChart(document.getElementById('session-chart'));
  const ds = c.data.datasets.map((d) => (d.hidden ? 0 : (d.data || []).length)).join(',');
  const ov = ((c.config.options.plugins.hrOverlays || {}).overlays || []).length;
  const an = Object.keys(((c.config.options.plugins.annotation || {}).annotations) || {}).length;
  return ds + '|' + ov + '|' + an + '|' + JSON.stringify(c.$maxMin ? c.$maxMin.length : null);
});
const listSig = (page) => page.evaluate(() => [...document.querySelectorAll('#marker-list .marker-item')].map((m) => m.className).join(';'));
async function dragStrip(page, share) {
  await page.evaluate(() => document.getElementById('context-overlay').scrollIntoView({ block: 'center' }));
  const hb = await page.$eval('#context-brush', (e) => { const r = e.getBoundingClientRect(); return [r.left, r.right, r.top + r.height / 2]; });
  const strip = await rect(page, '#context-overlay');
  await page.mouse.move(hb[1] - 1, hb[2]); await page.mouse.down();
  await page.mouse.move(strip.l + strip.w * share, hb[2], { steps: 6 }); await page.mouse.up();
  await page.waitForTimeout(500);
}
const xRange = (page) => page.evaluate(() => { const c = Chart.getChart(document.getElementById('session-chart')); return [c.scales.x.min, c.scales.x.max]; });

const CHECKS = {
  // Item 23.
  async layers(base) {
    const rows = [];
    const { ctx, page } = await openDay(base, 1440);
    const chips = await page.evaluate(() => [...document.querySelectorAll('#view-day .chip')].filter((c) => c.getBoundingClientRect().height > 0).length);
    rows.push([chips === 0, `1440: no chips left on the Day page with Layers closed (${chips})`]);
    const label = (await page.textContent('#markers-open')).replace(/\s+/g, ' ').trim();
    rows.push([/^Layers · \d+$/.test(label), `1440: the button reads "${label}"`]);
    await page.click('#markers-open'); await page.waitForTimeout(300);
    const pop = await page.evaluate(() => {
      const p = document.querySelector('.layers-pop .sheet');
      if (!p) return null;
      return { heads: [...p.querySelectorAll('.layer-group-head')].map((h) => h.textContent.trim()), rows: p.querySelectorAll('.layer-chip').length, markers: p.querySelectorAll('.marker-item, #marker-list').length, upper: [...p.querySelectorAll('.layer-group-head')].some((h) => getComputedStyle(h).textTransform === 'uppercase') };
    });
    rows.push([!!pop && pop.heads.join() === 'Lines,Events,Context' && pop.rows >= 10 && !pop.markers && !pop.upper, `1440: Layers popover with groups Lines, Events, Context in sentence case, ${pop && pop.rows} rows, no marker rows ${JSON.stringify(pop)}`]);
    const avail = await page.$$eval('.layers-pop .layer-chip:not(:disabled)', (cs) => cs.map((c) => c.dataset.layer));
    const bad = [];
    for (const t of avail) {
      const sel = `.layers-pop .layer-chip[data-layer="${t}"]`;
      const p0 = await page.getAttribute(sel, 'aria-pressed'), c0 = await chartSig(page), l0 = await listSig(page);
      await page.click(sel); await page.waitForTimeout(150);
      const p1 = await page.getAttribute(sel, 'aria-pressed'), c1 = await chartSig(page), l1 = await listSig(page);
      await page.click(sel); await page.waitForTimeout(150);
      const p2 = await page.getAttribute(sel, 'aria-pressed'), c2 = await chartSig(page), l2 = await listSig(page);
      const listType = l0.includes('type-' + t) || l1.includes('type-' + t);
      const ok = p1 !== p0 && p2 === p0 && (c1 !== c0 || l1 !== l0) && c2 === c0 && l2 === l0 && (!listType || l0 !== l1);
      if (!ok) bad.push(t);
    }
    rows.push([avail.length >= 5 && !bad.length, `1440: each of ${avail.length} available layers toggles by a real click, the chart and the list follow, a second click restores (${bad.join(', ') || 'all pass'})`]);
    await page.keyboard.press('Escape'); await page.waitForTimeout(250);
    const after = await page.evaluate(() => ({ open: !!document.querySelector('.layers-pop'), focus: document.activeElement && document.activeElement.id }));
    rows.push([!after.open && after.focus === 'markers-open', `1440: Escape closes Layers and focus returns to it ${JSON.stringify(after)}`]);
    rows.push([!page.errors.length, '1440: no page errors ' + page.errors.join(' | ')]);
    await ctx.close();
    return rows;
  },

  // Item 24.
  async drawer(base) {
    const rows = [];
    const { ctx, page } = await openDay(base, 1440);
    const w0 = (await rect(page, '#session-chart')).w;
    const label = (await page.textContent('#markers-toggle')).replace(/\s+/g, ' ').trim();
    rows.push([/^Markers · \d+$/.test(label) && !(await page.$('#sidebar-toggle')), `1440: "${label}" button, no hamburger`]);
    await page.click('#markers-toggle'); await page.waitForTimeout(400);
    const open = await rect(page, '#markers-panel'), card = await rect(page, '.chart-panel'), w1 = (await rect(page, '#session-chart')).w;
    const pills = await page.evaluate(() => document.querySelectorAll('#markers-panel .chip').length);
    rows.push([open.shown && Math.abs(w1 - w0) < 0.5 && open.r <= card.r && open.r >= card.r - 24 && open.t >= card.t && open.b <= card.b, `1440: the panel opens over the chart card's right edge and the chart keeps its width (${w0} then ${w1})`]);
    rows.push([pills === 0, `1440: no filter pills in the markers panel (${pills})`]);
    await page.click('#markers-close'); await page.waitForTimeout(300);
    const c1 = await page.evaluate(() => ({ shown: getComputedStyle(document.getElementById('markers-panel')).visibility !== 'hidden', focus: document.activeElement.id }));
    const w2 = (await rect(page, '#session-chart')).w;
    rows.push([!c1.shown && c1.focus === 'markers-toggle' && Math.abs(w2 - w0) < 0.5, `1440: the close button closes it, focus returns to Markers, the chart keeps its width ${JSON.stringify(c1)} ${w2}`]);
    await page.click('#markers-toggle'); await page.waitForTimeout(300);
    await page.keyboard.press('Escape'); await page.waitForTimeout(300);
    const c2 = await page.evaluate(() => ({ shown: getComputedStyle(document.getElementById('markers-panel')).visibility !== 'hidden', focus: document.activeElement.id }));
    rows.push([!c2.shown && c2.focus === 'markers-toggle', `1440: Escape closes it and focus returns to Markers ${JSON.stringify(c2)}`]);
    await ctx.close();
    return rows;
  },

  async reset(base) {
    const rows = [];
    for (const width of [1440, 360]) {
      const { ctx, page } = await openDay(base, width);
      await dragStrip(page, 0.3);
      await page.evaluate(() => document.querySelector('.chart-panel').scrollIntoView({ block: 'start' }));
      for (const open of width > 600 ? [false, true] : [false]) {
        if (open) { await page.click('#markers-toggle'); await page.waitForTimeout(400); }
        const rz = await rect(page, '#reset-zoom'), lay = await rect(page, '#markers-open'), mk = await rect(page, '#markers-toggle'), pan = await rect(page, '#markers-panel');
        const clash = [hits(rz, lay) && 'Layers', hits(rz, mk) && 'Markers', hits(rz, pan) && 'panel'].filter(Boolean);
        rows.push([!!rz && rz.shown && !clash.length, `${width}${open ? ' panel open' : ''}: zoomed, Reset zoom clear of Layers, Markers and the panel (${clash.join(', ') || 'clear'})`]);
      }
      await ctx.close();
    }
    return rows;
  },

  // Item 25.
  async strip(base) {
    const rows = [];
    const { ctx, page } = await openDay(base, 1440);
    await page.click('#markers-toggle'); await page.waitForTimeout(400);
    await page.mouse.move(2, 2);
    const r = await rect(page, '#marker-list .marker-item');
    const png = await page.screenshot({ clip: { x: Math.floor(r.l), y: Math.floor(r.t), width: 14, height: Math.floor(r.h) } });
    const edges = await page.evaluate(async (b64) => {
      const img = new Image(); img.src = 'data:image/png;base64,' + b64; await img.decode();
      const cv = document.createElement('canvas'); cv.width = img.width; cv.height = img.height;
      const g = cv.getContext('2d'); g.drawImage(img, 0, 0);
      const d = g.getImageData(0, 0, img.width, img.height).data;
      const px = (x, y) => { const i = (y * img.width + x) * 4; return [d[i], d[i + 1], d[i + 2]]; };
      const out = [];
      for (let y = 0; y < img.height; y++) {
        const bg = px(11, y);
        let last = -1;
        for (let x = 0; x < 10; x++) { const p = px(x, y); if (Math.abs(p[0] - bg[0]) + Math.abs(p[1] - bg[1]) + Math.abs(p[2] - bg[2]) > 90) last = x; }
        if (last >= 0) out.push([y, last]);
      }
      return out;
    }, png.toString('base64'));
    // Every pixel row, the top and bottom 3 px included, carries the strip and its rightmost column is the same.
    const h = Math.floor(r.h), xs = edges.map((e) => e[1]), ys = new Set(edges.map((e) => e[0]));
    const ends = [0, 1, 2, h - 3, h - 2, h - 1].filter((y) => ys.has(y)).length;
    const spread = xs.length ? Math.max(...xs) - Math.min(...xs) : -1;
    rows.push([ends >= 5 && edges.length >= h - 1 && spread >= 0 && spread <= 1 && Math.max(...xs) >= 2, `1440: marker strip inner edge straight top to bottom (strip on ${edges.length} of ${h} pixel rows, ${ends} of the top and bottom 3 px each side, rightmost column spread ${spread} px, x ${Math.min(...xs)}..${Math.max(...xs)})`]);
    await ctx.close();
    return rows;
  },

  // Item 26.
  async cards(base) {
    const rows = [];
    for (const width of [1440, 360]) {
      const { ctx, page } = await openDay(base, width);
      const m = await page.evaluate(() => {
        const pad = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--card-pad')) || 0;
        const gapTok = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--card-gap')) || 0;
        const box = (e) => e && e.getBoundingClientRect();
        const shown = (sel, root = document) => [...root.querySelectorAll(sel)].find((e) => e.getBoundingClientRect().height > 0);
        const inset = (cardSel, contentEls) => {
          const c = document.querySelector(cardSel); const cr = box(c), cs = getComputedStyle(c);
          const els = contentEls.filter(Boolean).map(box);
          return { card: cardSel, l: +(Math.min(...els.map((r) => r.left)) - cr.left - parseFloat(cs.borderLeftWidth)).toFixed(1), t: +(Math.min(...els.map((r) => r.top)) - cr.top - parseFloat(cs.borderTopWidth)).toFixed(1) };
        };
        const sc = document.querySelector('#view-day .session-card');
        const ins = [
          inset('#summary-bar', [shown('.summary-bar-title', document.getElementById('summary-bar')), shown('.summary-grid')]),
          inset('#view-day .chart-panel', [document.getElementById('axis-mode')]),
          inset('#interp-panel', [document.querySelector('#interp-head > span')]),
          inset('#insight-text', [document.querySelector('.insight-master-head > :first-child'), document.querySelector('.insight-master-head > span')]),
          sc ? inset('#view-day .session-card', [[...sc.children].find((e) => !e.classList.contains('card-actions'))]) : null,
        ].filter(Boolean);
        const seq = ['#summary-bar', '#session-layout', '#interp-panel', '#insight-text', '#view-day .day-sessions-head', '#view-day .sessions-grid'].map((s) => box(document.querySelector(s)));
        const gaps = seq.slice(1).map((r, i) => +(r.top - seq[i].bottom).toFixed(1));
        const cards = [...document.querySelectorAll('#view-day .session-card')].map(box);
        if (cards.length > 1) gaps.push(+(cards[1].left > cards[0].right ? cards[1].left - cards[0].right : cards[1].top - cards[0].bottom).toFixed(1));
        return { pad, gapTok, ins, gaps };
      });
      const off = m.ins.filter((i) => Math.abs(i.l - m.pad) > 1 || Math.abs(i.t - m.pad) > 1);
      rows.push([m.pad > 0 && m.ins.length >= 4 && !off.length, `${width}: every Day card's content inset equals the padding token ${m.pad} within 1 px ${JSON.stringify(m.ins.map((i) => [i.card, i.l, i.t]))}`]);
      const badGap = m.gaps.filter((g) => Math.abs(g - m.gapTok) > 1);
      rows.push([m.gapTok > 0 && !badGap.length, `${width}: every gap between Day cards equals the gap token ${m.gapTok} within 1 px (${m.gaps.join(', ')})`]);
      await ctx.close();
    }
    return rows;
  },

  async phone(base) {
    const rows = [];
    for (const scale of [1, 2]) {
      const tag = scale === 1 ? '360' : '360 at 200% text';
      const { ctx, page } = await openDay(base, 360, scale);
      await page.evaluate(() => document.querySelector('.chart-panel').scrollIntoView({ block: 'start' }));
      const seg = await rect(page, '#axis-mode'), lay = await rect(page, '#markers-open'), mk = await rect(page, '#markers-toggle'), card = await rect(page, '.chart-panel');
      const one = seg && lay && mk && Math.abs(seg.t - lay.t) < 2 && Math.abs(lay.t - mk.t) < 2 && seg.r <= lay.l && lay.r <= mk.l && mk.r <= card.r && lay.h >= 43.5 && mk.h >= 43.5;
      const names = await page.evaluate(() => ['markers-open', 'markers-toggle'].map((id) => document.getElementById(id).getAttribute('aria-label')));
      rows.push([one && names.every(Boolean), `${tag}: Clock and Duration, Layers and Markers on one row inside the card, named ${names.join(' and ')} ${JSON.stringify([seg, lay, mk, card].map((r) => r && [r.l, r.t, r.r].map(Math.round)))}`]);
      await page.locator('#markers-open').click(); await page.waitForTimeout(400);
      const ls = await page.evaluate(() => { const s = document.querySelector('.layers-sheet .sheet-body'); return s && { rows: s.querySelectorAll('.layer-chip').length, markers: s.querySelectorAll('.marker-item, #marker-list').length }; });
      rows.push([!!ls && ls.rows >= 10 && !ls.markers, `${tag}: the Layers sheet holds the layer rows and no marker rows ${JSON.stringify(ls)}`]);
      await page.keyboard.press('Escape'); await page.waitForTimeout(300);
      if (scale === 1) {
        const x0 = await xRange(page);
        await page.locator('#markers-toggle').click(); await page.waitForTimeout(400);
        const ms = await page.evaluate(() => !!document.querySelector('.markers-sheet #marker-list .marker-item') && !!document.querySelector('.markers-sheet #chills-tune-slider'));
        await page.locator('.markers-sheet #marker-list .marker-item .mk-go').first().click(); await page.waitForTimeout(1200);
        const after = await page.evaluate(() => !!document.querySelector('.markers-sheet'));
        const x1 = await xRange(page);
        rows.push([ms && !after && (x1[0] !== x0[0] || x1[1] !== x0[1]), `${tag}: the Markers sheet holds the list and chills sensitivity; tapping a marker closes it and zooms the chart (${JSON.stringify(x0)} to ${JSON.stringify(x1)})`]);
      }
      rows.push([!page.errors.length, `${tag}: no page errors ` + page.errors.join(' | ')]);
      await ctx.close();
    }
    return rows;
  },
};

// One mutant per named bug: [check, bug, find, replace].
const MUTANTS = [
  ['layers', 'item 23: layer chips back under the chart', "            ${opts.chartNote || ''}", "            <div class=\"chip-row\"><button type=\"button\" class=\"chip layer-chip\" data-layer=\"hr\">HR</button></div>${opts.chartNote || ''}"],
  ['drawer', 'item 24: opening the panel resizes the chart', '  .session-layout { position: relative; }', '  .session-layout { position: relative; }\n  .session-layout.markers-on > .session-main { margin-right: calc(var(--drawer-w) + var(--s4)); }'],
  ['strip', 'item 25: a 4 px strip under the 8 px row corner (inner edge curves)', '    border-radius: 4px 8px 8px 4px;', '    border-radius: 8px;'],
  ['cards', 'item 26: no gap between the Day cards', '#view-day:not(.hidden) { display: flex; flex-direction: column; gap: var(--card-gap); }', '#view-day:not(.hidden) { display: flex; flex-direction: column; gap: 0; }'],
  ['cards', 'item 26: Autonomic interpretation off the padding token', '.interp-head, .insight-master-head { min-height: 44px; padding: var(--card-pad);', '.interp-head, .insight-master-head { min-height: 44px; padding: 14px 18px;'],
  ['reset', 'Reset zoom under the open panel', '  .session-layout.markers-on .chart-wrap .reset-zoom {', '  .session-layout.markers-on .chart-wrap .reset-zoom-x {'],
  ['phone', 'markers inside the Layers sheet', "className: phone ? 'layers-sheet' : 'layers-pop', body: layerRowsEl(),", "className: phone ? 'layers-sheet' : 'layers-pop', body: [layerRowsEl(), document.getElementById('marker-list').cloneNode(true)],"],
];

let fails = 0, passes = 0;
const crlf = VIEWER.includes('\r\n');
if (args.includes('--mutants')) {
  for (const [check, bug, find, repl] of MUTANTS) {
    const f = crlf ? find.replace(/\n/g, '\r\n') : find, r = crlf ? repl.replace(/\n/g, '\r\n') : repl;
    if (!VIEWER.includes(f)) { fails++; console.log(`FAIL mutant "${bug}": its text is no longer in the viewer`); continue; }
    const srv = await serve(VIEWER.replace(f, r));
    const rows = await CHECKS[check](srv.base);
    srv.server.close();
    const caught = rows.filter((x) => !x[0]).map((x) => x[1]);
    if (caught.length) { passes++; console.log(`PASS mutant "${bug}" FAILS: ${caught[0]}`); } else { fails++; console.log(`FAIL mutant "${bug}" passed every ${check} check`); }
  }
} else {
  const srv = await serve(VIEWER);
  for (const name of Object.keys(CHECKS)) {
    for (const [ok, msg] of await CHECKS[name](srv.base)) { if (ok) passes++; else fails++; console.log((ok ? 'PASS ' : 'FAIL ') + msg); }
  }
  srv.server.close();
}
await browser.close();
console.log(`\n${passes} passed, ${fails} failed`);
process.exit(fails ? 1 : 0);
