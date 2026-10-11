// Widget parity: hr_monitor.html vs overlay.html across every body-class toggle combination.
// Usage: node scripts/widget-parity.mjs [--root <dir>] [--verbose]
// Exit 0 when the only differences are the ALLOWED list below; 1 otherwise.

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const argVal = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const ROOT = path.resolve(argVal('--root') || path.join(here, '..'));
const VERBOSE = args.includes('--verbose');
const KIT = argVal('--kit') || 'C:/Users/Khal/Desktop/Mine/HR Monitor/ux-audit/kit/package.json';

const TOGGLES = ['no-hr', 'no-hrv', 'no-live-hr', 'no-inline-trends', 'no-palp-chip',
  'no-warning', 'warning-above', 'no-conn-dot', 'conn-live', 'conn-reconnecting'];
const WARNS = ['none', 'warn-high', 'warn-low', 'warn-crash', 'warn-palp'];

const ALLOWED = [
  { key: 'colour --warn-high', monitor: '#E24B4A', overlay: '#E89858', where: 'hr_monitor.html:62 vs overlay.html:18' },
  { key: 'colour --warn-low', monitor: '#85B7EB', overlay: '#7DB8E8', where: 'hr_monitor.html:63 vs overlay.html:19' },
  { key: 'colour --warn-crash', monitor: '#BA7517', overlay: '#E24B4A', where: 'hr_monitor.html:64 vs overlay.html:20' },
];

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
function measureAll({ toggles, warns }) {
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
      rows[`${mask}|${w}`] = {
        rect: `${r1(r.width)}x${r1(r.height)}`,
        gridTemplateColumns: cs.gridTemplateColumns,
        padding: cs.padding,
      };
    }
  }
  return { once, rows };
}

const settle = (page) => page.evaluate(() => new Promise((ok) => {
  let n = 0; const tick = () => (++n < 4 ? requestAnimationFrame(tick) : ok()); requestAnimationFrame(tick);
}));

// The overlay gets the monitor's --full-widgets-width over the relay; the zone width stands in for the monitor's 340 px column.
async function load(page, url, from) {
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForFunction(() => typeof Chart !== 'undefined' && document.fonts.status === 'loaded', null, { timeout: 15000 }).catch(() => {});
  if (!from) {
    await page.waitForFunction(() => document.documentElement.style.getPropertyValue('--full-widgets-width'), null, { timeout: 10000 }).catch(() => {});
  } else {
    await page.evaluate((f) => {
      document.documentElement.style.setProperty('--full-widgets-width', f.full);
      document.getElementById('overlay-zone').style.width = f.zoneWidth + 'px';
    }, from);
  }
  await page.evaluate(() => {
    const style = document.createElement('style');
    style.textContent = '*, *::before, *::after { animation: none !important; transition: none !important; }';
    document.head.appendChild(style);
  });
  await settle(page);
  return page.evaluate(() => {
    const z = document.getElementById('overlay-zone'), cs = getComputedStyle(z);
    return {
      full: document.documentElement.style.getPropertyValue('--full-widgets-width'),
      zoneWidth: z.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight),
    };
  });
}

const hex = (v) => v.toUpperCase();

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
      p.on('pageerror', (e) => errors.push(e.message));
      return p;
    };
    const [pm, po] = await Promise.all([pageFor(), pageFor()]);
    const shared = await load(pm, `${base}/hr_monitor.html?mode=offline`);
    await load(po, `${base}/overlay.html?bg=transparent&autoreload=0`, shared);
    const mon = await pm.evaluate(measureAll, { toggles: TOGGLES, warns: WARNS });
    const ovl = await po.evaluate(measureAll, { toggles: TOGGLES, warns: WARNS });

    const diffs = [];
    for (const k of Object.keys(mon.once)) {
      const a = mon.once[k], b = ovl.once[k];
      if ((k.startsWith('colour') ? hex(a) !== hex(b) : a !== b)) diffs.push({ key: k, monitor: a, overlay: b });
    }
    const keys = Object.keys(mon.rows);
    for (const k of keys) {
      for (const f of Object.keys(mon.rows[k])) {
        if (mon.rows[k][f] !== ovl.rows[k][f]) {
          const [mask, w] = k.split('|');
          const on = TOGGLES.filter((_, i) => mask & (1 << i)).join(' ') || '(none)';
          diffs.push({ key: `${f} [${on}] warn=${w}`, monitor: mon.rows[k][f], overlay: ovl.rows[k][f] });
        }
      }
    }

    console.log(`widget-parity: root ${ROOT}`);
    console.log(`combinations: ${1 << TOGGLES.length} toggle sets x ${WARNS.length} warning states = ${keys.length} per page`);
    console.log(`viewport 1440x900, overlay zone ${shared.zoneWidth}px, --full-widgets-width ${shared.full || 'unset'}`);
    console.log('allow-list (known differences):');
    for (const a of ALLOWED) console.log(`  ${a.key}: monitor ${a.monitor}, overlay ${a.overlay} (${a.where})`);

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
    code = unexpected.length || missing.length ? 1 : 0;
    console.log(`${code ? 'FAIL' : 'PASS'} in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  } finally {
    await ctx.close();
    server.close();
    fs.rmSync(profile, { recursive: true, force: true });
  }
  process.exit(code);
}

main().catch((e) => { console.error(e); process.exit(1); });
