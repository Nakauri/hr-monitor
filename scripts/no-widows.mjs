// Guards: one word alone on the last line of a paragraph ("work." under the Straps lede, Khal 2026-10-12).
// Files: index.html, changelog.html, legal.html, new-look.html (site.css and ui.css `text-wrap: pretty`). Runtime about 30 s.
// Every visible text block (p, li, figcaption, summary, dd, h1 to h3) that wraps to 2 or more lines must end with
// at least 2 words, at 1440, 1024 and 360. --mutants removes the text-wrap rule and must FAIL.
// Usage: node scripts/no-widows.mjs [--mutants]
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(ROOT, 'ux-audit', 'kit', 'package.json'));
const { chromium } = require('playwright');
const MUT = process.argv.includes('--mutants');
const TYPES = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png' };
const server = http.createServer((q, r) => {
  const rel = decodeURIComponent(new URL(q.url, 'http://x').pathname), f = path.join(ROOT, rel);
  if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { r.writeHead(404); return r.end(); }
  let body = fs.readFileSync(f);
  if (MUT && /site\.js$/.test(rel)) body = body.toString('utf8').replace("forEach(join)", "forEach(() => {})");
  if (MUT && /\.css$/.test(rel)) body = body.toString('utf8').replace(/text-wrap:\s*(pretty|balance)/g, 'text-wrap: wrap');
  if (MUT && /\.html$/.test(rel)) body = body.toString('utf8').replace(/text-wrap:\s*(pretty|balance)/g, 'text-wrap: wrap');
  r.writeHead(200, { 'Content-Type': TYPES[path.extname(f)] || 'application/octet-stream' }); r.end(body);
});
await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
const BASE = `http://127.0.0.1:${server.address().port}`;
let browser; try { browser = await chromium.launch(); } catch (e) { browser = await chromium.launch({ channel: 'chrome' }); }
let fails = 0, checked = 0;
for (const page of ['index.html', 'changelog.html', 'legal.html', 'new-look.html']) {
  if (!fs.existsSync(path.join(ROOT, page))) continue;
  for (const w of [1440, 1024, 360]) {
    const ctx = await browser.newContext({ viewport: { width: w, height: 900 } });
    const p = await ctx.newPage();
    await p.route('**/*', (rt) => (rt.request().url().startsWith(BASE) || /fonts\.(googleapis|gstatic)|cdnjs|jsdelivr/.test(rt.request().url())) ? rt.continue() : rt.fulfill({ status: 204, body: '' }));
    await p.goto(`${BASE}/${page}`, { waitUntil: 'networkidle' });
    await p.evaluate(() => document.querySelectorAll('details').forEach((d) => { d.open = true; }));
    await p.waitForTimeout(300);
    const res = await p.evaluate(() => {
      const out = [];
      for (const el of document.querySelectorAll('p, li, figcaption, summary, dd, h1, h2, h3')) {
        if (el.offsetParent === null && getComputedStyle(el).position !== 'fixed') continue;
        if (el.querySelector('p, li, ul, ol, div')) continue;
        const words = [];
        const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
        for (let n = walk.nextNode(); n; n = walk.nextNode()) {
          if (n.parentElement && n.parentElement.closest('[class*="badge"], [class*="chip"], [class*="tag"]') && n.parentElement.closest('[class*="badge"], [class*="chip"], [class*="tag"]') !== el) continue;
          const re = /\S+/g; let m;
          while ((m = re.exec(n.data))) { const r = document.createRange(); r.setStart(n, m.index); r.setEnd(n, m.index + m[0].length); const b = r.getClientRects()[0]; if (b && b.width) words.push({ t: m[0], top: Math.round(b.top) }); }
        }
        if (words.length < 4) continue;
        const lines = [...new Set(words.map((x) => x.top))];
        if (lines.length < 2) continue;
        const last = words.filter((x) => x.top === lines[lines.length - 1]);
        if (last.length < 2) out.push(el.tagName.toLowerCase() + ': "...' + words.slice(-4).map((x) => x.t).join(' ') + '"');
      }
      return { n: document.querySelectorAll('p, li, figcaption, summary, dd, h1, h2, h3').length, widows: out };
    });
    checked++;
    if (res.widows.length) { fails++; console.log(`FAIL ${page} at ${w}: ${res.widows.length} widow(s): ${res.widows.slice(0, 6).join(' | ')}`); }
    else console.log(`ok   ${page} at ${w}: no widows`);
    await ctx.close();
  }
}
await browser.close(); server.close();
if (MUT) { console.log(fails ? `MUTANT caught (${fails} page sizes with widows)` : 'MUTANT NOT CAUGHT'); process.exit(fails ? 0 : 1); }
console.log(fails ? `no-widows: ${fails} of ${checked} FAIL` : `no-widows: all ${checked} pass`);
process.exit(fails ? 1 : 0);
