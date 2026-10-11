#!/usr/bin/env node
// Device tool, not a gate: proves a print while recording leaves no gap over 3 s. Files: PdfPrinter.java, native-pdf.js. Runtime: one phone session.
// S15a device proof for the native report PDF. No page loads native-pdf.js yet, so this injects it over CDP.
//   drive: node scripts/pdf-proof.mjs drive --port 9334 [--no-share]
//          needs `adb forward tcp:9334 localabstract:webview_devtools_remote_<pid>` (debug build).
//          Prints the printPdf result with the phone-clock window; exit 0 = 4 pages and a content:// uri.
//   gaps:  node scripts/pdf-proof.mjs gaps --segments <dir> --lifecycle <file> --from <ms> --to <ms>
//          exit 0 = h rows cover the window with no gap over 3 s and no GATT drop or link change in it.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const mode = args[0];
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 && args[i + 1] != null ? args[i + 1] : d; };
const GAP_MS = 3000;
const PAD_MS = 10000;

async function drive() {
  const port = Number(opt('port', '9334'));
  const share = !args.includes('--no-share');
  const list = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json();
  const match = new RegExp(opt('match', '^https://localhost/'));
  const pages = list.filter(t => t.type === 'page' && match.test(t.url || ''));
  if (!pages.length) { console.error('no app page on port ' + port + ': ' + list.map(t => t.url).join(', ')); process.exit(1); }
  const target = pages[0];
  console.log('target ' + target.url);
  const shim = fs.readFileSync(path.join(ROOT, 'mobile', 'src', 'native-pdf.js'), 'utf8');
  const expr = shim + '\n;(async () => { const t0 = Date.now(); const r = await window.__aortiNativePdf.proof({ share: ' + share
    + ' }); r.windowFromMs = t0; r.windowToMs = Date.now(); return r; })()';
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('websocket failed')); });
  const reply = await new Promise((res, rej) => {
    const timer = setTimeout(() => rej(new Error('no reply in 120 s')), 120000);
    ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id === 1) { clearTimeout(timer); res(m); } };
    ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: expr, awaitPromise: true, returnByValue: true } }));
  });
  ws.close();
  const r = reply.result || {};
  if (r.exceptionDetails || !r.result) {
    console.error('proof failed: ' + JSON.stringify(r.exceptionDetails || reply.error || reply));
    process.exit(1);
  }
  const v = r.result.value || {};
  console.log(JSON.stringify(v, null, 1));
  const ok = v.pages === 4 && v.expectedPages === 4 && /^content:\/\//.test(v.uri || '');
  console.log(ok ? 'PASS 4 pages, ' + v.bytes + ' bytes in ' + v.ms + ' ms' : 'FAIL expected 4 pages and a content:// uri');
  process.exit(ok ? 0 : 1);
}

function gaps() {
  const dir = opt('segments');
  const life = opt('lifecycle');
  const from = Number(opt('from'));
  const to = Number(opt('to'));
  if (!dir || !life || !(from > 0) || !(to >= from)) { console.error('need --segments --lifecycle --from --to'); process.exit(2); }
  const a = from - PAD_MS, b = to + PAD_MS;
  const eps = [];
  for (const f of fs.readdirSync(dir).filter(n => /^hrm_\d{8}T\d{2}Z_[a-z0-9]{6}\.csv$/.test(n))) {
    const lines = fs.readFileSync(path.join(dir, f), 'utf8').split(/\r?\n/);
    const base = Number((/base=(-?\d+)/.exec(lines[0] || '') || [])[1]);
    if (!Number.isFinite(base)) continue;
    for (const l of lines.slice(1)) {
      if (!l.startsWith('h,')) continue;
      const ep = base + Number(l.split(',')[1]);
      if (ep >= a && ep <= b) eps.push(ep);
    }
  }
  eps.sort((x, y) => x - y);
  let maxGap = 0, at = 0;
  for (let i = 1; i < eps.length; i++) if (eps[i] - eps[i - 1] > maxGap) { maxGap = eps[i] - eps[i - 1]; at = eps[i - 1]; }
  const covers = eps.length > 0 && eps[0] <= from && eps[eps.length - 1] >= to;
  const drops = fs.readFileSync(life, 'utf8').split(/\r?\n/).filter(l => {
    const i = l.indexOf(','); const ep = Number(l.slice(0, i));
    return ep >= a && ep <= b && /^(gatt_disconnected|link_state|process_start|engine_create)/.test(l.slice(i + 1));
  });
  console.log('window ' + new Date(from).toISOString() + ' to ' + new Date(to).toISOString() + ' (+/- ' + PAD_MS / 1000 + ' s)');
  console.log('h rows ' + eps.length + ', covers window ' + covers + ', max gap ' + maxGap + ' ms' + (at ? ' after ' + new Date(at).toISOString() : ''));
  console.log('lifecycle drops in window ' + drops.length + (drops.length ? '\n  ' + drops.join('\n  ') : ''));
  const ok = covers && maxGap <= GAP_MS && drops.length === 0;
  console.log(ok ? 'PASS' : 'FAIL');
  process.exit(ok ? 0 : 1);
}

if (mode === 'drive') drive().catch(e => { console.error(String(e)); process.exit(1); });
else if (mode === 'gaps') gaps();
else { console.error('usage: pdf-proof.mjs drive|gaps ...'); process.exit(2); }
