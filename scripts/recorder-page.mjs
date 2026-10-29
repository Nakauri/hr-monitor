// Guards: the web monitor after Stop on the recorder (docs/web-recorder.md rules 16 and 17): a false "Saved", a lost
// Export, an Export of the wrong text, a mark taken after the final file was built. Scenarios S3, S8, S9, S11, S18
// (rule 18, a held mark at tab close), S21, S25, S26, S31. Files: hr_monitor.html, recorder.js, ui.js. Runtime: about 70 s.
// Harness from monitor-sync.mjs: fake strap, fake folder, fetch spy on Drive, window.__tick from recorderTick with the
// clock 61 s on per tick. Added here: folder writes that hang or fail on demand, uploads held until released, a fake
// relay socket (takeover is a control stop message on it), the recorder instance as window.__rec, and the page's
// 30 s after-stop cap run at 2 s (every setTimeout of exactly 30000 ms).
// Usage: node scripts/recorder-page.mjs [--only S8,S21]

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { uxDir } from './ux-dir.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const argVal = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const ONLY = (argVal('--only') || '').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
const ROOT = path.resolve(here, '..');
const UX = uxDir(here, argVal('--ux'));
const CHART = path.join(path.dirname(fileURLToPath(import.meta.url)), 'vendor', 'chart.umd.min.js');
const { chromium } = createRequire(path.join(UX, 'kit', 'package.json'))('playwright');
const CAP_MS = 2000;

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png', '.woff2': 'font/woff2' };
const server = http.createServer((req, res) => {
  const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const file = path.join(ROOT, rel);
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  fs.createReadStream(file).pipe(res);
});
await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
const BASE = `http://127.0.0.1:${server.address().port}`;
const ALLOW = /^https?:\/\/(127\.0\.0\.1|fonts\.googleapis\.com|fonts\.gstatic\.com)(:|\/)/;

let fails = 0;
const fail = (m) => { fails++; console.log('FAIL ' + m); };
const pass = (m) => console.log('ok   ' + m);
const check = (ok, m, detail) => (ok ? pass(m) : fail(m + (detail ? ': ' + detail : '')));

const FAKE_WEB = (o) => `(() => {
  const o = ${JSON.stringify(o)};
  window.__written = []; window.__drive = []; window.__uploadFail = false; window.__uploadHold = false; window.__held = [];
  window.__folderMode = 'ok'; window.__folderHung = [];
  if (o.signedIn && !sessionStorage.getItem('__seeded')) {
    localStorage.setItem('aorti_auth_v2', JSON.stringify({ version: 2, access_token: 'fake-token', expires_at: Date.now() + 36e5, email: 'demo@example.com', scope: '', issued_at: Date.now() }));
  }
  if (o.seed && !sessionStorage.getItem('__seeded')) Object.entries(o.seed).forEach(([k, v]) => localStorage.setItem(k, v));
  sessionStorage.setItem('__seeded', '1');
  const realST = window.setTimeout;
  window.setTimeout = function (fn, ms, ...a) { if (ms === 30000) ms = ${CAP_MS}; return realST.call(this, fn, ms, ...a); };
  const realFetch = window.fetch.bind(window);
  // A held upload waits for __releaseUploads; its answer is read then (500 while __uploadFail).
  window.__releaseUploads = () => { const h = window.__held.splice(0); h.forEach((r) => r()); return h.length; };
  window.fetch = async (u, init) => {
    const url = String(u && u.url || u);
    if (/googleapis\\.com/.test(url)) {
      const method = (init && init.method) || 'GET';
      const session = /upload\\/drive\\/v3\\/files/.test(url) && (/fields=id/.test(url) || method === 'PATCH');
      const rec = { url, method, session, done: false, held: false };
      window.__drive.push(rec);
      if (session && window.__uploadHold) { rec.held = true; await new Promise((r) => window.__held.push(r)); rec.held = false; }
      rec.done = true;
      if (session && window.__uploadFail) return new Response('{}', { status: 500 });
      return new Response(JSON.stringify({ files: [], id: 'fake-file' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return realFetch(u, init);
  };
  window.open = function () { return null; };
  // The relay: a socket that opens at once; __relaySay delivers a message to the page.
  class FakeWS extends EventTarget {
    constructor(url) { super(); this.url = url; this.readyState = 0; this.sent = []; (window.__ws = window.__ws || []).push(this);
      realST(() => { this.readyState = 1; this.dispatchEvent(new Event('open')); }, 5); }
    send(d) { this.sent.push(d); }
    close() { this.readyState = 3; this.dispatchEvent(new Event('close')); }
  }
  FakeWS.CONNECTING = 0; FakeWS.OPEN = 1; FakeWS.CLOSING = 2; FakeWS.CLOSED = 3;
  window.WebSocket = FakeWS;
  window.__relaySay = (msg) => { const ws = (window.__ws || []).filter((w) => w.readyState === 1).pop(); if (!ws) return false; ws.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(msg) })); return true; };
  // The page's recorder, for reading Recordings (results, text, filename); nothing is changed through it.
  let realRec;
  Object.defineProperty(window, 'AortiRecorder', { configurable: true, get: () => realRec,
    set: (v) => { realRec = { create: (env) => { const r = v.create(env); window.__rec = r; return r; } }; } });
  const realSI = window.setInterval;
  const realNow = Date.now; let skew = 0; Date.now = () => realNow() + skew;
  window.setInterval = function (fn, ms) { if (fn && fn.name === 'recorderTick') { window.__tick = () => { skew += 61000; return fn(); }; return 990001; } return realSI.apply(this, arguments); };
  // Folder: close() lands the write ('ok'), throws ('fail'), or waits for __releaseFolder(ok) ('hang').
  window.__releaseFolder = (ok) => { const h = window.__folderHung.splice(0); h.forEach((x) => x(ok)); return h.length; };
  const file = (n) => ({ createWritable: async () => { let c = ''; return { write: async (x) => { c = String(x); }, close: async () => {
    const mode = window.__folderMode;
    if (mode === 'fail') throw new Error('folder gone');
    if (mode === 'hang') { const ok = await new Promise((r) => window.__folderHung.push(r)); if (!ok) throw new Error('folder gone'); }
    window.__written.push({ n, c, at: Date.now() });
  } }; } });
  window.showDirectoryPicker = async () => ({ name: 'Sessions', kind: 'directory', queryPermission: async () => 'granted', requestPermission: async () => 'granted', getFileHandle: async (n) => file(n) });
  const listeners = [];
  const chr = { value: null, startNotifications: async () => chr, stopNotifications: async () => chr,
    addEventListener: (t, cb) => { if (t === 'characteristicvaluechanged') listeners.push(cb); }, removeEventListener: () => {} };
  let timer = null;
  const gatt = { connected: false,
    connect: async () => { gatt.connected = true; if (!timer) timer = realSI(() => {
      const b = new DataView(new ArrayBuffer(4)); b.setUint8(0, 0x10); b.setUint8(1, 88); b.setUint16(2, 698, true);
      chr.value = b; listeners.forEach((cb) => cb({ target: chr }));
    }, 1000); return server; },
    disconnect: () => { gatt.connected = false; clearInterval(timer); timer = null; } };
  const server = { device: null, connected: true,
    getPrimaryService: async (s) => { if (s === 'heart_rate' || s === 0x180d || s === 0x180D) return { getCharacteristic: async () => chr }; throw new Error('no service'); } };
  const device = { name: '808S Fake', id: 'fake', gatt, addEventListener: () => {}, removeEventListener: () => {}, watchAdvertisements: async () => {} };
  server.device = device;
  Object.defineProperty(navigator, 'bluetooth', { configurable: true, value: { getDevices: async () => [], requestDevice: async () => device, getAvailability: async () => true } });
})();`;

const browser = await chromium.launch().catch(() => chromium.launch({ channel: 'chrome' }));

async function newPage(web = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, acceptDownloads: true });
  await ctx.route('**/*', (route) => {
    const u = route.request().url();
    if (/chart\.umd(\.min)?\.js/.test(u) && !u.startsWith('http://127.0.0.1')) return route.fulfill({ status: 200, contentType: 'text/javascript', body: fs.readFileSync(CHART) });
    if (ALLOW.test(u) || u.startsWith('data:') || u.startsWith('blob:')) return route.continue();
    const js = /\.js(\?|$)/.test(u) || route.request().resourceType() === 'script';
    return route.fulfill({ status: js ? 200 : 204, contentType: js ? 'text/javascript' : 'text/plain', body: '' });
  });
  await ctx.addInitScript(FAKE_WEB(web));
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errs.push('console: ' + m.text().split('\n')[0]); });
  await page.goto(BASE + '/hr_monitor.html', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1200);
  return { ctx, page, errs };
}

const label = (page) => page.evaluate(() => document.getElementById('session-toggle').textContent.trim());
async function tapToggle(page) {
  if (await page.evaluate(() => { const s = document.getElementById('session-toggle').closest('.section'); return !!s && s.classList.contains('collapsed'); })) {
    await page.click('[data-section="controls"] .section-header');
    await page.waitForTimeout(300);
  }
  await page.click('#session-toggle');
}
const waitLabel = (page, want, timeout = 10000) => page.waitForFunction((w) => document.getElementById('session-toggle').textContent.trim() === w, want, { timeout }).catch(() => {});
async function startWeb(page, { folder = true } = {}) {
  if (folder) { await page.evaluate(() => document.getElementById('autosave-toggle').click()); await page.waitForTimeout(300); }
  await tapToggle(page);
  await waitLabel(page, 'Stop session', 8000);
  await page.waitForTimeout(800);
}
async function settle(page) { for (let i = 0; i < 40 && await page.evaluate(() => window.__drive.some((r) => !r.done && !r.held)); i++) await page.waitForTimeout(100); await page.waitForTimeout(150); }
const tick = async (page) => { await page.evaluate(() => window.__tick()); await settle(page); };
// Takeover: another device's control stop aimed at this tab's sender id.
const takeover = (page) => page.evaluate(() => window.__relaySay({ type: 'control', action: 'stop', senderId: 'other1', targetId: sessionStorage.getItem('hr_monitor_device_id') }));
const unload = (page) => page.evaluate(() => { const e = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(e); return e.defaultPrevented; });
// The after-stop panel: first line without its duration, the second (Drive) line, Export, View session.
async function panel(page) {
  return page.evaluate(() => {
    const vis = (e) => !!e && !e.hidden && getComputedStyle(e).display !== 'none' && e.getBoundingClientRect().height > 0;
    const s = document.getElementById('after-stop-saved'), d = document.getElementById('after-stop-drive');
    return { shown: vis(document.getElementById('after-stop')), first: s.textContent.split(' · ')[0], dur: / · \d+:\d\d$/.test(s.textContent), kind: s.dataset.kind || null,
      drive: vis(d) ? d.textContent : null, exp: vis(document.getElementById('after-stop-export')), view: vis(document.getElementById('after-stop-view')) };
  });
}
const waitFirst = (page, re, timeout = 10000) => page.waitForFunction((src) => { const b = document.getElementById('after-stop'); return !b.hidden && new RegExp(src).test(document.getElementById('after-stop-saved').textContent); }, re.source, { timeout }).catch(() => {});
// Kept-session notice lines (not the running session's unsaved notice).
async function kept(page) {
  return page.evaluate(() => [...document.querySelectorAll('.session-ctl .notice')].filter((n) => n.id !== 'unsaved-notice').map((n) => {
    const b = [...n.querySelectorAll('.acts button')].find((x) => x.textContent === 'Export CSV');
    return { text: n.querySelector('.msg').textContent, kind: n.classList.contains('warning') ? 'warning' : 'info', exp: !!b && !b.hidden && b.getBoundingClientRect().height > 0 };
  }));
}
const waitKept = (page, re, timeout = 10000) => page.waitForFunction((src) => [...document.querySelectorAll('.session-ctl .notice .msg')].some((m) => new RegExp(src).test(m.textContent)), re.source, { timeout }).catch(() => {});
const toastText = (page) => page.evaluate(() => { const t = document.querySelector('.toast-host .toast'); return t ? t.textContent : null; });
const clock12 = (ms) => { const d = new Date(ms); const h = d.getHours(); return (h % 12 || 12) + ':' + String(d.getMinutes()).padStart(2, '0') + ' ' + (h < 12 ? 'am' : 'pm'); };
async function download(page, click) {
  const dl = page.waitForEvent('download', { timeout: 5000 }).catch(() => null);
  await click();
  const d = await dl;
  if (!d) return null;
  return { name: d.suggestedFilename(), text: fs.readFileSync(await d.path(), 'utf8') };
}
// A Recording's facts, read off the recorder: window[key] holds one captured earlier, else the current one.
const recFacts = (page, key) => page.evaluate((k) => { const r = k ? window[k] : window.__rec.current(); return r ? { filename: r.filename, text: r.text, result: r.result, state: r.state, startMs: r.startMs } : null; }, key || null);
const lastWrite = (page, name) => page.evaluate((n) => { const w = window.__written.filter((x) => x.n === n); return w.length ? w[w.length - 1].c : null; }, name);
const pageErrors = (name, errs, expected) => { const left = errs.filter((e) => !expected.test(e)); if (left.length) fail(name + ': page errors ' + left.join('; ')); };
const rows = (t) => (t ? t.split('\n').length - 1 : 0);

const scenarios = {
  // S3: held marks and an open note reach the final file, from the Stop button and from a takeover (rule 16).
  async S3() {
    for (const via of ['Stop button', 'takeover']) {
      const { ctx, page, errs } = await newPage();
      await startWeb(page);
      await tick(page);
      await page.evaluate(() => document.getElementById('log-symptom').click());
      // Two marks inside one CSV time key (0.0001 min, 6 ms) share a row and the later label wins; a person never taps that fast.
      await page.waitForTimeout(300);
      await page.evaluate(() => document.getElementById('log-note').click());
      await page.waitForSelector('#note-text', { timeout: 3000 }).catch(() => {});
      await page.fill('#note-text', 'dizzy on the stairs');
      if (via === 'Stop button') {
        await page.evaluate(() => document.getElementById('session-toggle').click());
        await waitFirst(page, /^Saved to Sessions/);
      } else {
        check(await takeover(page), 'S3 takeover: the control message reached the page');
        await page.waitForTimeout(1500);
      }
      const r = await recFacts(page);
      const file = r && await lastWrite(page, r.filename);
      check(!!r && /dizzy on the stairs/.test(r.text) && /sym:symptom/.test(r.text), `S3 ${via}: the open note and the held symptom are in the text built at Stop`, r && r.text.slice(-200));
      check(!!file && file === r.text, `S3 ${via}: the folder file ends with that text`, file ? file.slice(-120) : 'no write');
      const p = await panel(page);
      if (via === 'Stop button') check(p.shown && p.first === 'Saved to Sessions' && !p.exp, 'S3 Stop button: panel "Saved to Sessions", no Export', JSON.stringify(p));
      else check(!p.shown && r.result.folder === 'saved', 'S3 takeover, saved: no panel (rule 17 shows it only when not saved)', JSON.stringify({ p, res: r.result }));
      check(!(await page.$('#note-sheet')), `S3 ${via}: the note sheet closed`);
      if (errs.length) fail(`S3 ${via}: page errors ` + errs.join('; '));
      await ctx.close();
    }
  },

  // S8 + S9: a folder final past the 30 s cap reads "Saving to", then follows the final; a mark meanwhile is refused.
  async S8() {
    for (const end of ['saved', 'failed']) {
      const { ctx, page, errs } = await newPage();
      await startWeb(page);
      await tick(page);
      await page.evaluate(() => { window.__folderMode = 'hang'; });
      await tapToggle(page);
      await page.waitForTimeout(300);
      check((await label(page)) === 'Saving', `S8 ${end}: the button reads Saving while the final waits`, await label(page));
      if (end === 'saved') {
        // S9: a mark during Saving.
        await page.evaluate(() => document.getElementById('log-symptom').click());
        check((await toastText(page)) === 'Symptom not logged. The session has ended.', 'S9: a mark during Saving is refused with the ended toast', await toastText(page));
        await page.evaluate(() => document.getElementById('log-note').click());
        await page.waitForTimeout(200);
        check(!(await page.$('#note-sheet')), 'S9: Note does not open during Saving');
      }
      await waitLabel(page, 'Start session', CAP_MS + 6000);
      const p = await panel(page);
      check(p.shown && p.first === 'Saving to Sessions' && p.dur && p.drive === null && p.exp, `S8 ${end}: past the cap the panel reads "Saving to Sessions · m:ss" with Export`, JSON.stringify(p));
      check(await unload(page), `S8 ${end}: the leave guard is on while Saving`);
      if (end === 'saved') {
        await page.evaluate(() => document.getElementById('log-symptom').click());
        check((await toastText(page)) === 'Symptom not logged. The session has ended.', 'S9: a mark after the cap, still Saving, is refused', await toastText(page));
      }
      const r0 = await recFacts(page);
      const n = await page.evaluate((ok) => window.__releaseFolder(ok), end === 'saved');
      await waitFirst(page, end === 'saved' ? /^Saved to Sessions/ : /^Last save to Sessions failed/);
      const q = await panel(page);
      if (end === 'saved') {
        check(n === 1 && q.first === 'Saved to Sessions' && !q.exp, 'S8 saved: the panel follows to "Saved to Sessions", Export leaves', JSON.stringify({ n, q }));
        check(!(await unload(page)), 'S8 saved: the leave guard is off');
        check((await lastWrite(page, r0.filename)) === r0.text, 'S8 saved: the file holds the text built at Stop');
      } else {
        check(n === 1 && q.first === 'Last save to Sessions failed' && q.kind === 'error' && q.exp, 'S8 failed: "Last save to Sessions failed", Export stays', JSON.stringify({ n, q }));
        check(await unload(page), 'S8 failed: the leave guard stays on');
        const d = await download(page, () => page.click('#after-stop-export'));
        check(!!d && d.name === r0.filename && d.text === r0.text && rows(d.text) > 0, 'S8 failed: Export gives the text built at Stop as the session file name', d ? d.name + ' ' + rows(d.text) + ' rows' : 'no download');
        check(!(await panel(page)).exp && !(await unload(page)), 'S8 failed: after Export the button leaves and the guard is off');
      }
      if (errs.length) fail(`S8 ${end}: page errors ` + errs.join('; '));
      await ctx.close();
    }
  },

  // S11: folder unplugged, no Drive: three strikes, then "Last save to Sessions failed" and Export.
  async S11() {
    const { ctx, page, errs } = await newPage();
    await startWeb(page);
    await tick(page);
    await page.evaluate(() => { window.__folderMode = 'fail'; });
    for (let i = 0; i < 3; i++) await tick(page);
    const st = await page.evaluate(() => document.getElementById('autosave-status').textContent);
    check(st === 'write error (3/3)', 'S11: three failed writes show "write error (3/3)"', st);
    await tapToggle(page);
    await waitLabel(page, 'Start session');
    await waitFirst(page, /./);
    const p = await panel(page);
    const r = await recFacts(page);
    check(p.shown && p.first === 'Last save to Sessions failed' && p.kind === 'error' && p.drive === null && p.exp, 'S11: panel "Last save to Sessions failed", no Drive line, Export offered', JSON.stringify(p));
    check(await unload(page), 'S11: the leave guard is on');
    const d = await download(page, () => page.click('#after-stop-export'));
    check(!!d && d.name === r.filename && d.text === r.text && rows(d.text) > 0, 'S11: Export gives the text built at Stop as the session file name', d ? d.name + ' ' + rows(d.text) + ' rows' : 'no download');
    check(!(await panel(page)).exp && !(await unload(page)), 'S11: after Export the button leaves and the guard is off');
    pageErrors('S11', errs, /folder gone/);
    await ctx.close();
  },

  // S21: Start while the old folder final waits past the cap, then it fails: its notice line, its Export, the guard.
  async S21() {
    const { ctx, page, errs } = await newPage();
    await startWeb(page);
    await tick(page);
    await page.evaluate(() => { window.__folderMode = 'hang'; });
    await tapToggle(page);
    await waitLabel(page, 'Start session', CAP_MS + 6000);
    check((await panel(page)).first === 'Saving to Sessions', 'S21: A past the cap reads "Saving to Sessions"');
    await page.evaluate(() => { window.__A = window.__rec.current(); window.__folderMode = 'ok'; });
    const A = await recFacts(page, '__A');
    await tapToggle(page);
    await waitLabel(page, 'Stop session', 8000);
    await page.waitForTimeout(800);
    await tick(page);
    const at = clock12(A.startMs);
    const k0 = await kept(page);
    check(!(await panel(page)).shown && k0.length === 1 && k0[0].text === `Session from ${at}: Saving to Sessions` && k0[0].exp, 'S21: Start hides the panel; A gets its own line "Session from <time>: Saving to Sessions" with Export', JSON.stringify(k0));
    await page.evaluate(() => window.__releaseFolder(false));
    await waitKept(page, /failed/);
    const k1 = await kept(page);
    check(k1.length === 1 && k1[0].text === `Session from ${at}: Last save to Sessions failed` && k1[0].exp, 'S21: A fails; its line reads "Last save to Sessions failed" with Export', JSON.stringify(k1));
    check(await unload(page), 'S21: the leave guard is on while A is kept (B saves to the folder)');
    const B = await recFacts(page);
    const d = await download(page, () => page.locator('.session-ctl .notice:not(#unsaved-notice) .acts button', { hasText: 'Export CSV' }).click());
    check(!!d && d.name === A.filename && d.text === A.text && d.text !== B.text && rows(d.text) > 0, "S21: A's Export gives A's text as A's file name, not B's", d ? d.name + ' ' + rows(d.text) + ' rows' : 'no download');
    check((await kept(page)).length === 0 && !(await unload(page)), 'S21: after Export the line leaves and the guard is off');
    pageErrors('S21', errs, /folder gone/);
    await ctx.close();
  },

  // S25: Stop A with a hung upload, Start and Stop B, then A fails: A's line and A's own Export stay.
  async S25() {
    const { ctx, page, errs } = await newPage({ signedIn: true });
    await page.waitForFunction(() => /Syncing to Drive/.test(document.getElementById('drive-status').textContent), null, { timeout: 6000 }).catch(() => {});
    await startWeb(page, { folder: false });
    await settle(page);
    await tick(page);
    await page.evaluate(() => { window.__uploadHold = true; });
    await tapToggle(page);
    await waitLabel(page, 'Start session', CAP_MS + 6000);
    const p = await panel(page);
    check(p.first === 'Drive upload incomplete' && p.kind === 'error' && p.drive === null && p.exp, 'S25: A past the cap reads "Drive upload incomplete" with Export', JSON.stringify(p));
    check(await unload(page), 'S25: the leave guard is on while A is pending');
    await page.evaluate(() => { window.__A = window.__rec.current(); window.__uploadHold = false; });
    const A = await recFacts(page, '__A');
    await tapToggle(page);
    await waitLabel(page, 'Stop session', 8000);
    await page.waitForTimeout(800);
    await tick(page);
    await tapToggle(page);
    await waitFirst(page, /^Saved to Drive/);
    const pb = await panel(page);
    check(pb.first === 'Saved to Drive' && !pb.exp, 'S25: B saves, its panel reads "Saved to Drive" with no Export', JSON.stringify(pb));
    const at = clock12(A.startMs);
    const k0 = await kept(page);
    check(k0.length === 1 && k0[0].text === `Session from ${at}: Drive upload incomplete` && k0[0].exp, "S25: A's line still reads incomplete, with Export", JSON.stringify(k0));
    await page.evaluate(() => { window.__uploadFail = true; window.__releaseUploads(); });
    await waitKept(page, /Drive upload failed/);
    const k1 = await kept(page);
    check(k1.length === 1 && k1[0].text === `Session from ${at}: Drive upload failed` && k1[0].exp, "S25: A fails; its line reads \"Drive upload failed\", Export still there", JSON.stringify(k1));
    check((await panel(page)).first === 'Saved to Drive', "S25: B's panel is unchanged");
    check(await unload(page), 'S25: the leave guard is on while A is kept');
    const B = await recFacts(page);
    const d = await download(page, () => page.locator('.session-ctl .notice:not(#unsaved-notice) .acts button', { hasText: 'Export CSV' }).click());
    check(!!d && d.name === A.filename && d.text === A.text && d.text !== B.text && rows(d.text) > 0, "S25: A's Export gives A's own text as A's file name", d ? d.name + ' ' + rows(d.text) + ' rows' : 'no download');
    check((await kept(page)).length === 0 && !(await unload(page)), 'S25: after Export the line leaves and the guard is off');
    if (errs.length) fail('S25: page errors ' + errs.join('; '));
    await ctx.close();
  },

  // S26: takeover, and the local broadcast stop, with no folder and no sign-in: the panel, "Not saved", Export.
  async S26() {
    for (const via of ['takeover', 'broadcast stop']) {
      const seed = via === 'broadcast stop' ? { seed: { hr_monitor_widget_prefs: JSON.stringify({ broadcast: true }) } } : {};
      const { ctx, page, errs } = await newPage(seed);
      await startWeb(page, { folder: false });
      await page.waitForTimeout(3000);
      if (via === 'takeover') {
        check(await takeover(page), 'S26 takeover: the control message reached the page');
      } else {
        await page.waitForSelector('.broadcaster-takeover[data-self="1"]', { state: 'attached', timeout: 6000 }).catch(() => {});
        const has = await page.evaluate(() => { const b = document.querySelector('.broadcaster-takeover[data-self="1"]'); if (b) b.click(); return !!b; });
        check(has, 'S26 broadcast stop: this device\'s row in Active broadcasts has Stop session');
      }
      await waitFirst(page, /./, CAP_MS + 4000);
      const p = await panel(page);
      check(p.shown && p.first === 'Not saved' && p.dur && p.drive === null && !p.view && p.exp, `S26 ${via}: the panel shows "Not saved · m:ss" with Export, no View session`, JSON.stringify(p));
      check(await unload(page), `S26 ${via}: the leave guard is on`);
      await page.evaluate(() => document.getElementById('log-symptom').click());
      check((await toastText(page)) === 'Symptom not logged. The session has ended.', `S26 ${via}: a mark after the stop is refused with the ended toast`, await toastText(page));
      const r = await recFacts(page);
      const d = await download(page, () => page.click('#after-stop-export'));
      check(!!d && d.name === r.filename && d.text === r.text && rows(d.text) > 0, `S26 ${via}: Export gives the text built at Stop as the session file name`, d ? d.name + ' ' + rows(d.text) + ' rows' : 'no download');
      check(!(await panel(page)).exp && !(await unload(page)), `S26 ${via}: after Export the button leaves and the guard is off`);
      if (errs.length) fail(`S26 ${via}: page errors ` + errs.join('; '));
      await ctx.close();
    }
  },

  // Rule 18 (design pass 2026-10-28): a held mark, then the tab closes (Chrome fires hidden, then pagehide). The hidden
  // save carries the mark; Undo is gone once the tab is left.
  async S18() {
    const { ctx, page, errs } = await newPage();
    await startWeb(page);
    await tick(page);
    await page.evaluate(() => document.getElementById('log-symptom').click());
    await page.waitForTimeout(300);
    const before = await page.evaluate(() => window.__written.length);
    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
      document.dispatchEvent(new Event('visibilitychange'));
      window.dispatchEvent(new Event('pagehide'));
    });
    await page.waitForTimeout(800);
    const r = await recFacts(page);
    const w = await page.evaluate((b) => window.__written.slice(b).map((x) => x.c), before);
    check(w.length >= 1 && /sym:symptom/.test(w[0]), 'S18 the save on leaving the tab carries the held symptom', JSON.stringify({ n: w.length, tail: w[0] ? w[0].slice(-80) : null, file: r && r.filename }));
    check(!(await page.evaluate(() => [...document.querySelectorAll('.toast-host .toast')].some((t) => /Undo/.test(t.textContent)))), 'S18 the Undo toast is gone once the tab is left');
    if (errs.length) fail('S18: page errors ' + errs.join('; '));
    await ctx.close();
    // Round 4: the 10 s save is mid-write when the tab is left; the mark goes in the write after it (rule 21).
    {
      const { ctx, page, errs } = await newPage();
      await startWeb(page);
      await tick(page);
      await page.evaluate(() => document.getElementById('log-symptom').click());
      await page.waitForTimeout(300);
      await page.evaluate(() => { window.__folderMode = 'hang'; window.__tick(); });
      await page.waitForTimeout(200);
      const before = await page.evaluate(() => window.__written.length);
      await page.evaluate(() => {
        Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
        Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
        document.dispatchEvent(new Event('visibilitychange'));
        window.dispatchEvent(new Event('pagehide'));
      });
      await page.waitForTimeout(300);
      const during = await page.evaluate(() => window.__written.length);
      await page.evaluate(() => { window.__folderMode = 'ok'; window.__releaseFolder(true); });
      await page.waitForTimeout(800);
      const w = await page.evaluate((b) => window.__written.slice(b).map((x) => x.c), before);
      check(during === before && w.length >= 1 && /sym:symptom/.test(w[w.length - 1]),
        'S18 a save mid-write when the tab is left: nothing beside it, then the mark in the write after it', JSON.stringify({ before, during, n: w.length }));
      if (errs.length) fail('S18 mid-write: page errors ' + errs.join('; '));
      await ctx.close();
    }
  },
  // S31: A hung, Start, a takeover stops B with Drive failing, then A saves: B's panel stays failed, A's line saved.
  async S31() {
    const { ctx, page, errs } = await newPage({ signedIn: true });
    await page.waitForFunction(() => /Syncing to Drive/.test(document.getElementById('drive-status').textContent), null, { timeout: 6000 }).catch(() => {});
    await startWeb(page, { folder: false });
    await settle(page);
    await tick(page);
    await page.evaluate(() => { window.__uploadHold = true; });
    await tapToggle(page);
    await waitLabel(page, 'Start session', CAP_MS + 6000);
    await page.evaluate(() => { window.__A = window.__rec.current(); window.__uploadHold = false; });
    const A = await recFacts(page, '__A');
    await tapToggle(page);
    await waitLabel(page, 'Stop session', 8000);
    await page.waitForTimeout(800);
    await tick(page);
    await page.evaluate(() => { window.__uploadFail = true; });
    check(await takeover(page), 'S31: the control message reached the page');
    await waitFirst(page, /^Drive upload failed/, CAP_MS + 6000);
    const pb = await panel(page);
    check(pb.shown && pb.first === 'Drive upload failed' && pb.kind === 'error' && pb.exp, 'S31: the takeover shows B\'s panel "Drive upload failed" with Export', JSON.stringify(pb));
    const at = clock12(A.startMs);
    const k0 = await kept(page);
    check(k0.length === 1 && k0[0].text === `Session from ${at}: Drive upload incomplete`, "S31: A's line reads incomplete", JSON.stringify(k0));
    await page.evaluate(() => { window.__uploadFail = false; window.__releaseUploads(); });
    await waitKept(page, /Saved to Drive/);
    const k1 = await kept(page);
    const a1 = await recFacts(page, '__A');
    check(a1.result.drive === 'saved' && k1.length === 1 && k1[0].text === `Session from ${at}: Saved to Drive` && !k1[0].exp, "S31: A saves; its line reads \"Saved to Drive\" with no Export", JSON.stringify({ k1, res: a1.result }));
    const pb2 = await panel(page);
    check(pb2.shown && pb2.first === 'Drive upload failed' && pb2.exp, "S31: B's panel still reads \"Drive upload failed\" with Export", JSON.stringify(pb2));
    check(await unload(page), 'S31: the leave guard stays on for B');
    pageErrors('S31', errs, /Drive upload failed|drive error/);
    await ctx.close();
  },
};

const t0 = Date.now();
try {
  const names = ONLY.length ? ONLY : Object.keys(scenarios);
  for (const n of names) {
    if (!scenarios[n]) { fail('no scenario ' + n + ' (S9 runs inside S8)'); continue; }
    const s = Date.now();
    await scenarios[n]();
    console.log(`     ${n} ${((Date.now() - s) / 1000).toFixed(1)} s`);
  }
} catch (e) {
  fail('harness: ' + (e && e.stack || e));
} finally {
  await browser.close();
  server.close();
}
console.log(`${fails ? fails + ' FAILED' : 'recorder-page: all pass'} (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
process.exit(fails ? 1 : 0);
