// Guards: a drawing refactor moving or restyling what the chart shows (S28 marks plugin). Files: any PNG pair. Runtime: about 3 s per pair.
// Compares PNG pairs pixel by pixel in headless Chromium (no image library needed). Prints, per pair, the pixels that
// differ at all, the pixels over the threshold (max channel delta), and their bounding box; --out writes a diff image.
// Usage: node scripts/shot-diff.mjs <a.png> <b.png> [<a2.png> <b2.png> ...] [--threshold 48] [--max 50] [--out <dir>] [--ux <dir>]
// Exit 1 when a pair differs in size or has more than --max pixels over the threshold.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { uxDir } from './ux-dir.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf(n); if (i < 0) return d; const v = args[i + 1]; args.splice(i, 2); return v; };
const UX = uxDir(here, flag('--ux', null));
const TH = +flag('--threshold', 48), MAX = +flag('--max', 50), OUT = flag('--out', null);
const { chromium } = createRequire(path.join(UX, 'kit', 'package.json'))('playwright');
if (args.length < 2 || args.length % 2) { console.log('usage: shot-diff.mjs a.png b.png [...]'); process.exit(2); }

let browser; try { browser = await chromium.launch(); } catch (e) { browser = await chromium.launch({ channel: 'chrome' }); }
const page = await browser.newPage();
let bad = 0;
for (let i = 0; i < args.length; i += 2) {
  const [a, b] = [args[i], args[i + 1]].map((f) => 'data:image/png;base64,' + fs.readFileSync(f).toString('base64'));
  const r = await page.evaluate(async ({ a, b, TH, wantDiff }) => {
    const load = (src) => new Promise((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = rej; im.src = src; });
    const [ia, ib] = await Promise.all([load(a), load(b)]);
    if (ia.width !== ib.width || ia.height !== ib.height) return { size: [ia.width, ia.height, ib.width, ib.height] };
    const px = (im) => { const c = document.createElement('canvas'); c.width = im.width; c.height = im.height; const x = c.getContext('2d'); x.drawImage(im, 0, 0); return x.getImageData(0, 0, im.width, im.height); };
    const da = px(ia), db = px(ib), w = ia.width, out = new ImageData(w, ia.height);
    let any = 0, over = 0, box = null;
    for (let k = 0; k < da.data.length; k += 4) {
      const d = Math.max(Math.abs(da.data[k] - db.data[k]), Math.abs(da.data[k + 1] - db.data[k + 1]), Math.abs(da.data[k + 2] - db.data[k + 2]), Math.abs(da.data[k + 3] - db.data[k + 3]));
      const g = da.data[k] * 0.25;
      out.data[k] = d > TH ? 255 : g; out.data[k + 1] = d && d <= TH ? 200 : g; out.data[k + 2] = g; out.data[k + 3] = 255;
      if (!d) continue;
      any++;
      if (d <= TH) continue;
      over++;
      const p = k / 4, x = p % w, y = (p / w) | 0;
      box = box ? [Math.min(box[0], x), Math.min(box[1], y), Math.max(box[2], x), Math.max(box[3], y)] : [x, y, x, y];
    }
    let diff = null;
    if (wantDiff) { const c = document.createElement('canvas'); c.width = w; c.height = ia.height; c.getContext('2d').putImageData(out, 0, 0); diff = c.toDataURL('image/png'); }
    return { w, h: ia.height, any, over, box, diff };
  }, { a, b, TH, wantDiff: !!OUT });
  const name = path.basename(args[i]) + ' vs ' + path.basename(args[i + 1]);
  if (r.size) { bad++; console.log(`FAIL ${name}: sizes differ ${r.size.join(' ')}`); continue; }
  if (OUT && r.diff) { fs.mkdirSync(OUT, { recursive: true }); fs.writeFileSync(path.join(OUT, 'diff-' + path.basename(args[i + 1])), Buffer.from(r.diff.split(',')[1], 'base64')); }
  const pass = r.over <= MAX;
  if (!pass) bad++;
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}: ${r.w}x${r.h}, ${r.any} pixels differ, ${r.over} over delta ${TH}${r.box ? ' in box ' + r.box.join(',') : ''}`);
}
await browser.close();
process.exit(bad ? 1 : 0);
