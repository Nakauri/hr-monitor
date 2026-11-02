// Guards (S65a, sleep from Health Connect and the Drive sleep files): a wrong asleep mask (awake stages counted asleep,
// minutes without heart rate counted), our own data feeding back, work before Connect (a plugin call or an hc: read on
// the web or before the person taps Connect), copies kept after a revoke or deleted after a failed status, a night
// printed before its sync passed the day, a band that outlives its night or never appears after a late sync or status,
// and the Drive sleep file: a write when nothing changed or while Drive sync is paused, fields beyond start, end and awake
// stretches, and earlier nights lost on a rewrite.
// Files: hrv_viewer.html (S65 block, rptModel, s64Run, s64Detected, the S65 runtime, the reopen reset), marks-drive.js
// (sleepFiles), mobile/src/health-connect.js. Spec: ux-audit redesign/s65-hc/S65-SPEC.md, sections 3 and 9.
// Parts: node (node goldens, Drive spy, shim; no browser, about 2 s, in ./check), golden (node plus the browser cases,
// about 150 s; run as --only H8,H9,H10,H10b,H11,H12,DR then --only H14,H15,H16,H17 then --only H18,H19,H20,H21).
// --mutants runs the negative controls of spec section 9; each must FAIL (with --part node, only the node ones).
// TZ is America/Denver (as sleep-split.mjs): it still turns back on 2026-11-01, which the 25 h case needs.
// Usage: node scripts/health-connect.mjs [--part node|golden] [--only <ids>] [--mutants] [--ux <dir>]
process.env.TZ = 'America/Denver';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { uxDir } from './ux-dir.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');
const require = createRequire(import.meta.url);
const args = process.argv.slice(2);
const argVal = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const MUTANTS_ON = args.includes('--mutants');
const PART = argVal('--part') || 'node';
const ONLY = argVal('--only') ? argVal('--only').split(',') : null;
const REAL = fs.readFileSync(path.join(ROOT, 'hrv_viewer.html'), 'utf8').replace(/\r\n/g, '\n');
const SHIM = fs.readFileSync(path.join(ROOT, 'mobile', 'src', 'health-connect.js'), 'utf8').replace(/\r\n/g, '\n');
const MARKS_DRIVE = path.join(ROOT, 'marks-drive.js');
const CHART = path.join(here, 'vendor', 'chart.umd.min.js');
const T0 = Date.now();

let fails = 0, passes = 0, QUIET = false, firstFail = null;
const ok = (cond, msg) => { if (cond) passes++; else { fails++; if (!firstFail) firstFail = msg; } if (!QUIET) console.log((cond ? 'PASS ' : 'FAIL ') + msg); return !!cond; };
const want = (id, only) => (!only || only.includes(id)) && (!ONLY || ONLY.includes(id));

// ---------- the S63 and S65 blocks, cut at run time ----------
const PARSE_MOD = fs.readFileSync(path.join(ROOT, 'viewer-parse.js'), 'utf8').replace(/\r\n/g, '\n');
function fnSrc(src, name) {
  if (src.indexOf('\n  function ' + name + '(') < 0) src = PARSE_MOD;
  const i = src.indexOf('\n  function ' + name + '(');
  if (i < 0) throw new Error('function ' + name + ' missing');
  let j = src.indexOf('{', i), depth = 0, q = null;
  for (; j < src.length; j++) {
    const c = src[j];
    if (q) { if (c === '\\') j++; else if (c === q) q = null; continue; }
    if (c === "'" || c === '"' || c === '`') { q = c; continue; }
    if (c === '{') depth++;
    else if (c === '}' && --depth === 0) break;
  }
  return src.slice(i, j + 1);
}
function slice(src, a, b) {
  const i = src.indexOf(a), j = src.indexOf(b);
  if (i < 0 || j < i) throw new Error('markers missing: ' + a.trim());
  return src.slice(i, j);
}
function cut(src) {
  const body = slice(src, '  // ---- S63 sleep ----', '  // ---- S63 sleep end ----') + slice(src, '  // ---- S65 health connect ----', '  // ---- S65 health connect end ----') +
    ['hashStr', 'rptMedian'].map((n) => fnSrc(src, n)).join('\n');
  const g63 = globalThis.__s63;
  globalThis.__s63 = undefined;
  const o = new Function(body + ';return { s63Figures, s65Night, s65Row, s65Origin, s65Chosen, hcSleepMask, s65Overlaps, s65Upsert, s65Month, s65FileName, s65FileBody, s65ParseFile, s65Merge, s65PushMonths, S65_O };')();
  globalThis.__s63 = g63;
  return o;
}

// ---------- synthetic days (all dates synthetic) ----------
const addDays = (iso, k) => { const t = new Date(iso + 'T12:00:00Z'); t.setUTCDate(t.getUTCDate() + k); return t.toISOString().slice(0, 10); };
const dayStart = (iso) => new Date(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)).getTime();
const dayLen = (iso) => Math.round((dayStart(addDays(iso, 1)) - dayStart(iso)) / 60000);
const at = (iso, hh, mm) => dayStart(iso) + (hh * 60 + mm) * 60000;
const D = '2026-05-08';
const SAA = 'com.urbandroid.sleep';
const night = (id, s, e, awake, origin) => ({ id, origin: origin || SAA, s, e, awake: awake || [] });
const sum = (m) => m.reduce((a, b) => a + b, 0);
const fullD = (n, missing) => { const hr = new Array(n).fill(60), hrv = new Array(n).fill(40); for (const m of missing || []) hr[m] = null; return { hr, hrv, recorded: hr.filter((v) => v != null).length }; };

function nodeCases(B, only) {
  let good = true;
  const n = dayLen(D), ds = dayStart(D);
  const N1 = B.s65Night(night('n1', at(D, 0, 30), at(D, 7, 45)));
  if (want('H1', only)) good = ok(sum(B.hcSleepMask([N1], ds, n)) === 435, `H1 a night 00:30 to 07:45, no awake stretch: mask ${sum(B.hcSleepMask([N1], ds, n))} (want 435)`) && good;
  if (want('H2', only)) {
    const x = B.s65Night(night('n1', at(D, 0, 30), at(D, 7, 45), [[at(D, 3, 0), at(D, 3, 20)]]));
    good = ok(sum(B.hcSleepMask([x], ds, n)) === 415, `H2 the same night with an awake stretch 03:00 to 03:20: mask ${sum(B.hcSleepMask([x], ds, n))} (want 415)`) && good;
  }
  if (want('H3', only)) {
    const a = B.s65Night(night('a', at(D, 0, 0), at(D, 2, 0))), b = B.s65Night(night('b', at(D, 2, 10), at(D, 4, 0))), c = B.s65Night(night('c', at(D, 2, 20), at(D, 4, 0)));
    const short = B.s65Night(night('s', at(D, 12, 0), at(D, 12, 15))), shortPair = [B.s65Night(night('p', at(D, 13, 0), at(D, 13, 10))), B.s65Night(night('q', at(D, 13, 20), at(D, 13, 35)))];
    const r = [sum(B.hcSleepMask([a, b], ds, n)), sum(B.hcSleepMask([a, c], ds, n)), sum(B.hcSleepMask([short], ds, n)), sum(B.hcSleepMask(shortPair, ds, n))];
    good = ok(r.join() === '240,220,0,35', `H3 two nights 10 min apart joined, 20 min apart not, a 15 min nap dropped, two short naps joined into 35 min: ${r.join(', ')} (want 240, 220, 0, 35)`) && good;
  }
  if (want('H4', only)) {
    const x = B.s65Night(night('x', at(addDays(D, -1), 22, 0), at(D, 6, 0))), pm = B.hcSleepMask([x], dayStart(addDays(D, -1)), dayLen(addDays(D, -1))), dm = B.hcSleepMask([x], ds, n);
    const firstOn = dm.indexOf(1), lastOn = dm.lastIndexOf(1), pFirst = pm.indexOf(1);
    good = ok(sum(dm) === 360 && firstOn === 0 && lastOn === 359 && sum(pm) === 120 && pFirst === 1320, `H4 22:00 to 06:00: D ${sum(dm)} min from ${firstOn} to ${lastOn}, D-1 ${sum(pm)} min from ${pFirst} (want 360 from 0 to 359, 120 from 1320)`) && good;
  }
  if (want('H5', only)) {
    const iso = '2026-11-01', x = B.s65Night(night('x', at(iso, 0, 0), new Date(2026, 10, 1, 9, 0).getTime()));
    const nn = dayLen(iso), m = B.hcSleepMask([x], dayStart(iso), nn);
    good = ok(nn === 1500 && sum(m) === 600, `H5 the 25 h day 2026-11-01, 00:00 to 09:00 local: n ${nn}, mask ${sum(m)} (want 1500, 600)`) && good;
  }
  const now = at(addDays(D, 2), 12, 0);
  if (want('H6', only)) {
    const own = [night('o1', at(D, 0, 30), at(D, 7, 45), [], 'com.nakauri.hrmonitor')];
    good = ok(B.s65Origin(own, now) === null && B.s65Chosen(own, now).length === 0, `H6 rows from com.nakauri.hrmonitor only: origin ${B.s65Origin(own, now)}, nights ${B.s65Chosen(own, now).length} (want null, 0)`) && good;
  }
  if (want('H7', only)) {
    const rows = [];
    for (let k = 0; k < 20; k++) rows.push(night('a' + k, at(addDays(D, -k), 0, 0), at(addDays(D, -k), 6, 0), [], 'app.a'));
    for (let k = 0; k < 3; k++) rows.push(night('b' + k, at(addDays(D, -k), 13, 0), at(addDays(D, -k), 14, 0), [], 'app.b'));
    const ch = B.s65Chosen(rows, now);
    good = ok(B.s65Origin(rows, now) === 'app.a' && ch.length === 20, `H7 two origins, 20 and 3 sessions: ${B.s65Origin(rows, now)} with ${ch.length} nights (want app.a, 20)`) && good;
  }
  if (want('H13', only)) {
    const m = new Uint8Array(1440); for (let i = 60; i < 480; i++) m[i] = 1;
    const miss = []; for (let i = 100; i < 115; i++) miss.push(i);
    const f = B.s63Figures(fullD(1440, miss), m);
    good = ok(f.asleepMin === 405, `H13 mask 1 on 420 minutes, heart rate missing on 15 of them: Asleep ${f.asleepMin} (want 405)`) && good;
  }
  if (want('E1', only)) {
    // A night across midnight, both days with heart rate on every minute.
    const prev = addDays(D, -1);
    const tot = (awake) => {
      const x = B.s65Night(night('x', at(prev, 23, 40), at(D, 7, 10), awake));
      return [prev, D].reduce((a, iso) => a + B.s63Figures(fullD(dayLen(iso)), B.hcSleepMask([x], dayStart(iso), dayLen(iso))).asleepMin, 0);
    };
    const a = tot([]), b = tot([[at(D, 2, 0), at(D, 2, 40)]]);
    good = ok(a === 450 && b === 410, `E1 a night 23:40 to 07:10 with heart rate present: Asleep ${a} over both days, ${b} with a 40 min awake stretch (want 450, 410)`) && good;
  }
  if (want('U1', only)) {
    // Upserts and the weekly replace: the full read drops a night deleted in Health Connect, an incremental one keeps it.
    const old = [night('a', at(D, 0, 0), at(D, 6, 0)), night('b', at(addDays(D, -1), 0, 0), at(addDays(D, -1), 6, 0)), night('ancient', now - 401 * 86400000, now - 401 * 86400000 + 3600000)];
    const fresh = [night('a', at(D, 0, 0), at(D, 6, 30))];
    const inc = B.s65Upsert(old, fresh, now - 30 * 86400000, now, false, now), full = B.s65Upsert(old, fresh, now - 30 * 86400000, now, true, now);
    const ids = (r) => r.rows.map((x) => x.id).join(',');
    good = ok(ids(inc) === 'b,a' && ids(full) === 'a' && inc.rows.find((x) => x.id === 'a').e === at(D, 6, 30) && inc.touched.length === 2 && full.touched.length === 3,
      `U1 upsert: incremental keeps ${ids(inc)}, full replace keeps ${ids(full)}, the 401-day night dropped, touched ${inc.touched.length} and ${full.touched.length} (want b,a; a; 2 and 3)`) && good;
  }
  if (want('U2', only)) {
    const bad = [{ id: 'x', s: 5, e: 1 }, { id: '', s: 1, e: 5 }, { id: 'y', s: 0, e: 2 * 86400000 }, { id: 'z', s: 0, e: 600000, awake: [[0, 'x'], [-5, 300000]] }].map(B.s65Night);
    good = ok(bad[0] === null && bad[1] === null && bad[2] === null && JSON.stringify(bad[3]) === '{"id":"z","s":0,"e":600000,"awake":[[0,300000]]}', `U2 bad nights refused, awake clipped: ${JSON.stringify(bad)}`) && good;
  }
  return good;
}

// ---------- Drive spy: marks-drive.js sleepFiles over a fake Drive ----------
function fakeDrive() {
  const files = new Map();   // id -> { name, parents, mime, body, createdTime }
  let seq = 0;
  const writes = [], reqs = [];
  const add = (name, parents, mime, body) => { const id = 'f' + (++seq); files.set(id, { name, parents, mime, body: body || '', createdTime: new Date(1700000000000 + seq * 1000).toISOString() }); return id; };
  add('HR Monitor Sessions', [], 'application/vnd.google-apps.folder');
  const res = (status, obj) => ({ ok: status < 300, status, json: async () => obj, text: async () => typeof obj === 'string' ? obj : JSON.stringify(obj) });
  const md5 = (s) => String(s.length) + ':' + s.split('').reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7);
  async function driveFetch(p, init = {}) {
    const method = init.method || 'GET';
    reqs.push(method + ' ' + p.split('?')[0]);
    const u = new URL(p, 'https://www.googleapis.com/drive/v3/');
    if (method === 'GET' && /\/files$/.test(u.pathname)) {
      const q = u.searchParams.get('q');
      const parent = (/'([^']+)' in parents/.exec(q) || [])[1], name = (/name='([^']+)'/.exec(q) || [])[1];
      const list = [...files].filter(([, f]) => f.parents.includes(parent) && (!name || f.name === name)).map(([id, f]) => ({ id, name: f.name, createdTime: f.createdTime, size: String(f.body.length), md5Checksum: md5(f.body) }));
      return res(200, { files: list });
    }
    if (method === 'POST' && /\/files$/.test(u.pathname) && !/upload/.test(p)) { const m = JSON.parse(init.body); return res(200, { id: add(m.name, m.parents, m.mimeType) }); }
    const media = /\/files\/([^/]+)$/.exec(u.pathname);
    if (method === 'GET' && media && u.searchParams.get('alt') === 'media') { const f = files.get(decodeURIComponent(media[1])); return f ? res(200, f.body) : res(404, ''); }
    if (method === 'PATCH') { const id = decodeURIComponent(/files\/([^?]+)/.exec(p)[1]); files.get(id).body = init.body; writes.push({ how: 'patch', name: files.get(id).name, body: init.body }); return res(200, { id, md5Checksum: md5(init.body) }); }
    if (method === 'POST' && /upload/.test(p)) {
      const parts = init.body.split(/--[^\r\n]+\r\n/).filter(Boolean);
      const meta = JSON.parse(parts[0].split('\r\n\r\n')[1].trim()), body = parts[1].split('\r\n\r\n')[1].replace(/\r\n--[^\r\n]+--$/, '');
      const id = add(meta.name, meta.parents, meta.mimeType, body);
      writes.push({ how: 'create', name: meta.name, body });
      return res(200, { id, md5Checksum: md5(body) });
    }
    return res(400, 'unhandled ' + method + ' ' + p);
  }
  return { driveFetch, files, writes, reqs, rootId: 'f1' };
}
async function driveCases(B, only, marksSrc) {
  let good = true;
  // A plain script (the repo's package is ESM): run it with a module object, as marks-store.test.cjs does.
  const MD = new Function('module', (marksSrc || fs.readFileSync(MARKS_DRIVE, 'utf8')) + '\n;return module.exports;')({ exports: {} });
  const fd = fakeDrive(), count = {};
  const files = MD.sleepFiles({ driveFetch: fd.driveFetch, rootId: () => fd.rootId, rootIds: () => [fd.rootId], count, body: B.s65FileBody, parse: B.s65ParseFile, merge: B.s65Merge });
  const now = new Date(2026, 10, 10, 12).getTime(), day = 86400000;
  let state = null, paused = false;
  const rows = [];
  for (const k of [12, 15, 20]) rows.push(night('oct' + k, new Date(2026, 9, k, 0, 30).getTime(), new Date(2026, 9, k, 7, 0).getTime(), [[new Date(2026, 9, k, 3).getTime(), new Date(2026, 9, k, 3, 20).getTime()]]));
  for (const k of [2, 5]) rows.push(night('nov' + k, new Date(2026, 10, k, 0, 30).getTime(), new Date(2026, 10, k, 7, 0).getTime()));
  rows.push(night('own', new Date(2026, 10, 6, 0).getTime(), new Date(2026, 10, 6, 6).getTime(), [], 'com.nakauri.hrmonitor'));
  const sync = { sleep: now, cover: now - 30 * day };
  const push = (r) => B.s65PushMonths({ rows: r, sync, state, now, deviceId: 'abc123', canSync: () => !paused, push: files.push, save: (st) => { state = st; } });
  const w0 = fd.writes.length;
  const n1 = await push(rows);
  const first = fd.writes.slice(w0);
  const keysOk = first.every((w) => { const o = JSON.parse(w.body); return JSON.stringify(Object.keys(o)) === '["v","origin","nights"]' && o.nights.every((x) => JSON.stringify(Object.keys(x)) === '["id","s","e","awake"]' && x.awake.every((p) => p.length === 2)); });
  const names = first.map((w) => w.name).sort().join(',');
  if (want('DR1', only)) good = ok(n1 === 2 && first.length === 2 && names === 'sleep_2026-10_abc123.json,sleep_2026-11_abc123.json' && keysOk && !first.some((w) => /nakauri|stage|title|notes/.test(w.body)),
    `DR1 first upload: ${first.length} writes (${names}), only v, origin, nights and per night id, s, e, awake: ${keysOk}, own rows left out (want 2 writes, one per month)`) && good;
  const w1 = fd.writes.length, r1 = fd.reqs.length;
  const n2 = await push(rows);
  if (want('DR2', only)) good = ok(n2 === 0 && fd.writes.length === w1 && fd.reqs.length === r1, `DR2 nothing changed: ${fd.writes.length - w1} writes, ${fd.reqs.length - r1} requests (want 0, 0)`) && good;
  const more = rows.concat([night('nov7', new Date(2026, 10, 7, 0, 30).getTime(), new Date(2026, 10, 7, 7).getTime())]);
  paused = true;
  const w2 = fd.writes.length, r2 = fd.reqs.length;
  await push(more);
  if (want('DR3', only)) good = ok(fd.writes.length === w2 && fd.reqs.length === r2, `DR3 a new night while Drive sync is paused: ${fd.writes.length - w2} writes, ${fd.reqs.length - r2} requests (want 0, 0)`) && good;
  paused = false;
  await push(more);
  const after = fd.writes.slice(w2);
  if (want('DR4', only)) good = ok(after.length === 1 && after[0].name === 'sleep_2026-11_abc123.json' && after[0].how === 'patch' && JSON.parse(after[0].body).nights.length === 3,
    `DR4 one new November night after the pause: ${after.length} write (${after.map((w) => w.how + ' ' + w.name).join(', ')}), ${after[0] ? JSON.parse(after[0].body).nights.length : 0} nights (want 1 patch of November with 3)`) && good;
  // A purge on the phone: the local copy now starts at cover; the file's nights before cover stay on the rewrite.
  const fileId = [...fd.files].find(([, f]) => f.name === 'sleep_2026-11_abc123.json')[0];
  fd.files.get(fileId).body = B.s65FileBody(SAA, [B.s65Night(night('nov1', new Date(2026, 10, 1, 0).getTime(), new Date(2026, 10, 1, 6).getTime()))].concat(more.filter((x) => /^nov/.test(x.id)).map(B.s65Night)));
  state = null;
  const sync2 = { sleep: now, cover: new Date(2026, 10, 1, 12).getTime() };
  const w3 = fd.writes.length;
  await B.s65PushMonths({ rows: more.filter((x) => x.id !== 'nov2'), sync: sync2, state, now, deviceId: 'abc123', canSync: () => true, push: files.push, save: (st) => { state = st; } });
  const nov = fd.writes.slice(w3).find((w) => /2026-11/.test(w.name));
  const ids = nov ? JSON.parse(nov.body).nights.map((x) => x.id).join(',') : '';
  if (want('DR5', only)) good = ok(ids === 'nov1,nov5,nov7', `DR5 rewrite after the phone's copy restarted at Nov 1 12:00: November holds ${ids} (want nov1 kept from the file, nov2 gone, nov5 and nov7 from the phone)`) && good;
  const before = count.down || 0;
  const pulled = await files.pull({});
  const again = await files.pull(pulled.files);
  if (want('DR6', only)) good = ok(Object.keys(pulled.files).length === 2 && pulled.changed && !again.changed && (count.down || 0) - before === 2,
    `DR6 pull: ${Object.keys(pulled.files).length} files read, then unchanged ${!again.changed} with ${(count.down || 0) - before} downloads in all (want 2, true, 2: an unchanged md5 is not downloaded again)`) && good;
  return good;
}

// ---------- the shim, in node with a fake window ----------
function shimCases(src, only) {
  let good = true;
  const run = (o) => {
    const ls = new Map(o.asked ? [['aorti_hc_asked', '1']] : []), calls = [];
    const plugin = { status: () => { calls.push('status'); return Promise.resolve({ sdk: 'available', granted: [] }); }, read: () => { calls.push('read'); return Promise.resolve({ rows: [] }); } };
    const g = { __s65: undefined };
    const win = { Capacitor: o.native ? { isNativePlatform: () => true, Plugins: { HealthConnect: plugin } } : undefined };
    const fn = new Function('window', 'globalThis', 'localStorage', 'navigator', 'document', src);
    fn(win, g, { getItem: (k) => ls.has(k) ? ls.get(k) : null, setItem: (k, v) => ls.set(k, String(v)) }, { userAgent: o.ua || 'Mozilla/5.0 (Linux; Android 9; SM-G950W)' }, { readyState: 'complete', addEventListener() {} });
    return { hc: win.__aortiHC, calls, g, ls };
  };
  if (want('SH1', only)) {
    const web = run({ native: false, asked: true }), before = run({ native: true, asked: false }), old = run({ native: true, asked: true, ua: 'Mozilla/5.0 (Linux; Android 8.1.0; X)' }), on = run({ native: true, asked: true });
    good = ok(!web.hc.available() && !before.hc.available() && before.hc.native() && !old.hc.native() && on.hc.available(),
      `SH1 available(): web ${web.hc.available()}, native before Connect ${before.hc.available()} (native ${before.hc.native()}), Android 8 native ${old.hc.native()}, native after Connect ${on.hc.available()} (want false, false (true), false, true)`) && good;
  }
  return good;
}

// ---------- browser ----------
let server = null, BASE = null, browser = null, SERVED = REAL, SERVED_SHIM = SHIM;
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png', '.woff2': 'font/woff2' };
const SEED = new Map();
async function startServer() {
  if (server) return;
  server = http.createServer((req, res) => {
    const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (rel.startsWith('/seed/')) { const v = SEED.get(rel.slice(6)); res.writeHead(v == null ? 404 : 200, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' }); res.end(v == null ? '' : v); return; }
    if (rel === '/hrv_viewer.html') { res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' }); res.end(SERVED); return; }
    const file = path.join(ROOT, rel);
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(fs.readFileSync(file));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  BASE = `http://127.0.0.1:${server.address().port}`;
}
async function getBrowser() {
  if (browser) return browser;
  const { chromium } = createRequire(path.join(uxDir(here, argVal('--ux')), 'kit', 'package.json'))('playwright');
  try { browser = await chromium.launch(); } catch (e) { browser = await chromium.launch({ channel: 'chrome' }); }
  return browser;
}
// The fake HealthConnect plugin, installed only on the test's own page loads (never on #/seed).
const FAKE = (cfg) => {
  if (location.hash === '#/seed') return;
  const F = Object.assign({ sdk: 'available', granted: ['sleep'], statusDelay: 0, statusReject: false, rows: [], readReject: false, more: false, hidden: false }, cfg);
  window.__hcFake = F; F.calls = { status: 0, read: 0, request: 0 };
  if (F.hidden) { Object.defineProperty(document, 'hidden', { configurable: true, get: () => window.__hcFake.hidden }); Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (window.__hcFake.hidden ? 'hidden' : 'visible') }); }
  if (!F.native) return;
  window.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'android', Plugins: { HealthConnect: {
    status: () => { F.calls.status++; const d = F.statusDelay, rej = F.statusReject, st = { sdk: F.sdk, granted: F.sdk === 'available' ? F.granted.slice() : [] }; return new Promise((res, no) => setTimeout(() => (rej ? no(new Error('hc_status_fail')) : res(st)), d)); },
    read: (o) => { F.calls.read++; return F.readReject ? Promise.reject(new Error('hc_read_fail')) : Promise.resolve({ rows: F.rows.filter((r) => r.e > o.from && r.s < o.to), more: F.more }); },
    request: () => { F.calls.request++; return Promise.resolve({ granted: F.granted, changed: false }); },
    openSettings: () => Promise.resolve({}),
  } } };
  try { if (F.asked) localStorage.setItem('aorti_hc_asked', '1'); else localStorage.removeItem('aorti_hc_asked'); } catch (e) { console.warn('ls', e); }
};
async function newPage(cfg) {
  await startServer();
  const ctx = await (await getBrowser()).newContext({ viewport: { width: 1440, height: 900 }, timezoneId: 'America/Denver', userAgent: 'Mozilla/5.0 (Linux; Android 10; SM-G950W) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36' });
  await ctx.route('**/*', (route) => {
    const u = route.request().url();
    if (u.startsWith(BASE) || u.startsWith('data:') || u.startsWith('blob:')) return route.continue();
    if (/chart\.umd(\.min)?\.js/.test(u)) return route.fulfill({ status: 200, contentType: 'text/javascript', body: fs.readFileSync(CHART) });
    return route.fulfill({ status: 204, body: '' });
  });
  await ctx.addInitScript(() => { try { localStorage.removeItem('hrv_viewer_sleep_weights'); } catch (e) { console.warn('ls', e); } });
  await ctx.addInitScript(FAKE, cfg);
  if (cfg.native) await ctx.addInitScript({ content: 'if (location.hash !== "#/seed") {\n' + SERVED_SHIM + '\n}' });
  const page = await ctx.newPage();
  await page.clock.setFixedTime(new Date(at(addDays(D, 2), 12, 0)));
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(e.message));
  page.ctx = ctx;
  return page;
}
const close = async (p) => { try { await p.ctx.close(); } catch (e) { console.warn('close', e.message); } };
// One recording of D (heart rate every minute, 55 at night, 95 by day) as a v1 CSV, one row every 5 s.
function dayFiles() {
  const ds = dayStart(D), n = dayLen(D), rows = [];
  for (let m = 0; m < n; m++) for (let j = 0; j < 12; j++) rows.push([ds + m * 60000 + j * 5000, m < 480 ? 55 : 95, 40]);
  const st = rows[0][0] - 400, name = 'hrv_session_' + new Date(st).toISOString().slice(0, 19).replace(/:/g, '-') + '.csv';
  const lines = ['time_min,epoch_ms,hr_bpm,rmssd_ms,palpitation,event,warning,connection,posture', `0.0000,${st},,,,,,connected,`];
  for (const [ep, v, r] of rows) lines.push(`${((ep - st) / 60000).toFixed(4)},${ep},${v},${r.toFixed(2)},,,,,`);
  return { [name]: lines.join('\n') + '\n' };
}
const SEED_FN = async ({ names, kv }) => {
  const db = await new Promise((res, rej) => { const q = indexedDB.open('hr_monitor_kv', 2);
    q.onupgradeneeded = () => { for (const s of ['kv', 'drive-cache']) if (!q.result.objectStoreNames.contains(s)) q.result.createObjectStore(s); };
    q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
  const texts = await Promise.all(names.map(async (n) => [n, await (await fetch('/seed/' + encodeURIComponent(n))).text()]));
  await new Promise((res, rej) => { const tx = db.transaction(['drive-cache', 'kv'], 'readwrite'); for (const [k, v] of texts) tx.objectStore('drive-cache').put(v, k); for (const [k, v] of Object.entries(kv)) tx.objectStore('kv').put(v, k); tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
  db.close(); localStorage.removeItem('hrv_viewer_index');
};
const KV = (keys) => new Promise((res) => { const q = indexedDB.open('hr_monitor_kv', 2); q.onsuccess = () => { const db = q.result; const tx = db.transaction('kv'); const out = {}; let left = keys.length; if (!left) { db.close(); res(out); } for (const k of keys) { const r = tx.objectStore('kv').get(k); r.onsuccess = () => { out[k] = r.result === undefined ? null : r.result; if (--left === 0) { db.close(); res(out); } }; } }; q.onerror = () => res(null); });
const KV_SET = ({ k, v }) => new Promise((res) => { const q = indexedDB.open('hr_monitor_kv', 2); q.onsuccess = () => { const db = q.result; const tx = db.transaction('kv', 'readwrite'); if (v === null) tx.objectStore('kv').delete(k); else tx.objectStore('kv').put(v, k); tx.oncomplete = () => { db.close(); res(true); }; }; });
// Opens D in a new page: files and kv seeded first from a #/seed load without the fake.
async function openDay(cfg, kv) {
  const page = await newPage(cfg);
  const files = dayFiles();
  for (const [k, v] of Object.entries(files)) SEED.set(k, v);
  await page.goto(BASE + '/hrv_viewer.html#/seed', { waitUntil: 'networkidle' });
  await page.evaluate(SEED_FN, { names: Object.keys(files), kv: kv || {} });
  await page.goto('about:blank');
  await page.goto(BASE + '/hrv_viewer.html#/day/' + D, { waitUntil: 'networkidle' });
  await chartReady(page);
  return page;
}
const chartReady = (page) => page.waitForFunction(() => { const c = document.querySelector('#view-day #session-chart'); const ch = c && window.Chart && Chart.getChart(c); return !!(ch && ch.data.datasets.some((d) => d.data && d.data.length > 20)); }, null, { timeout: 60000 }).catch(() => {});
const s64Done = (page, test) => page.waitForFunction((t) => { const c = globalThis.__s64; return !!(c && c.done && new RegExp(t).test(c.done)); }, test || '^day:', { timeout: 30000 }).then(() => page.evaluate(() => globalThis.__s64.done)).catch(() => page.evaluate(() => globalThis.__s64 && globalThis.__s64.done));
const counters = (page) => page.evaluate(() => ({ s65: globalThis.__s65 ? Object.assign({}, globalThis.__s65) : null, fake: window.__hcFake ? Object.assign({}, window.__hcFake.calls) : null }));
const zero = (c) => !c.s65 || (c.s65.status === 0 && c.s65.read === 0 && c.s65.idb === 0 && c.s65.up === 0);
// The report's sleep for D: source, asleep minutes over recorded minutes, and the printed rows.
const REPORT = async (iso) => {
  const p = await window.__aortiReport.prepare(iso);
  if (!p) return null;
  const s = p.d.sleep;
  let asl = 0;
  if (s) for (let m = 0; m < p.d.hr.length; m++) if (s.mask[m] === 1 && p.d.hr[m] != null) asl++;
  return { source: s ? s.source : null, asleep: s ? asl : null, slp: [...document.querySelectorAll('#rpg1 tr.slp')].map((tr) => tr.children[0].textContent.trim()) };
};
const BAND = async () => {
  const dm = await window.__aortiReport.model(null, { sleep: false });
  const ch = Chart.getChart(document.querySelector('#view-day #session-chart'));
  const ov = ((ch && ch.config.options.plugins.hrOverlays) || {}).overlays || [];
  const band = ov.filter((o) => /^<b>Sleep window/.test(o.html));
  let rec = 0;
  for (const o of band) for (let m = Math.round(o.xMin); m < Math.round(o.xMax); m++) if (dm && dm.hr[m] != null) rec++;
  return { runs: band.length, rec, done: globalThis.__s64.done };
};
const reopen = async (p) => {
  await p.evaluate(() => { globalThis.__s64.done = null; location.hash = '#/month'; });
  await p.waitForTimeout(800);
  await p.evaluate((d) => { location.hash = '#/day/' + d; }, D);
  await chartReady(p);
};
const visible = (p, hidden) => p.evaluate((h) => { window.__hcFake.hidden = h; document.dispatchEvent(new Event('visibilitychange')); }, hidden);

const N1 = night('n1', at(D, 0, 30), at(D, 7, 45));
const NOW = at(addDays(D, 2), 12, 0);
const SYNCED = { sleep: NOW, sleepTry: NOW, sleepFull: NOW, cover: NOW - 30 * 86400000 };
const HC = (rows, sync) => ({ 'hc:sleep': rows, 'hc:sync': sync });

const BROWSER = {
  H10: async () => {
    let good = true;
    for (const [id, cfg] of [['web', { native: false }], ['native before Connect', { native: true, asked: false }]]) {
      const p = await openDay(cfg);
      await s64Done(p);
      const r = await p.evaluate(REPORT, D);
      await p.waitForTimeout(1500);
      const c = await counters(p);
      good = ok(zero(c) && (!c.fake || (c.fake.status === 0 && c.fake.read === 0)) && r && r.source === null, `H10 ${id}: Day open and a report: __s65 ${JSON.stringify(c.s65)}, plugin calls ${JSON.stringify(c.fake)}, report sleep ${r && r.source} (want all 0, no call, none)`) && good;
      good = ok(!p.errors.length, `H10 ${id}: no page errors ${p.errors.join(' | ')}`) && good;
      await close(p);
    }
    return good;
  },
  H10b: async () => {
    const p = await openDay({ native: true, asked: true });
    await p.waitForTimeout(1500);
    const c = await counters(p);
    const good = ok(c.s65.status === 1 && c.fake.status === 1 && c.fake.read === 0, `H10b asked, viewer open 1.5 s: status() ${c.s65.status} (plugin ${c.fake.status}), reads ${c.fake.read} (want 1, 0 before the 10 s sync)`);
    await close(p);
    return good;
  },
  H11: async () => {
    let good = true;
    for (const [id, cfg, want] of [['status drops sleep', { granted: [] }, 'deleted'], ['status rejects', { statusReject: true }, 'kept'], ['Health Connect not installed', { sdk: 'not-installed' }, 'deleted']]) {
      const p = await openDay(Object.assign({ native: true, asked: true }, cfg), Object.assign(HC([N1], SYNCED), { 'hc:drive': { months: {} } }));
      await p.waitForTimeout(1500);
      const kv = await p.evaluate(KV, ['hc:sleep', 'hc:sync', 'hc:drive']);
      const left = Object.values(kv).filter((v) => v != null).length;
      const r = await p.evaluate(REPORT, D);
      const hcId = id === 'status drops sleep' ? 'H11' : id === 'status rejects' ? 'H11b' : 'H11c';
      good = ok(want === 'kept' ? left === 3 && r.source === null : left === 0, `${hcId} ${id}: hc: keys left ${left} of 3, report sleep ${r && r.source} (want ${want === 'kept' ? '3 and none: copies kept, resolver null' : '0'})`) && good;
      await close(p);
    }
    return good;
  },
  H8: async () => {
    const p = await openDay({ native: true, asked: true }, HC([N1], Object.assign({}, SYNCED, { sleep: dayStart(addDays(D, 1)) + 3600000 })));
    const done = await s64Done(p);
    const r = await p.evaluate(REPORT, D);
    const good = ok(r && r.source === null && /flag$/.test(done), `H8 sync 1 h after the day's end: report sleep ${r && r.source}, S64 ${done} (want none, flag)`);
    await close(p);
    return good;
  },
  H9: async () => {
    const other = night('n0', at(addDays(D, -2), 0, 30), at(addDays(D, -2), 7, 45));
    const p = await openDay({ native: true, asked: true }, HC([other], SYNCED));
    const r = await p.evaluate(REPORT, D);
    const good = ok(r && r.source === null, `H9 completed day with no session (the only night two days before): report sleep ${r && r.source} (want none)`);
    await close(p);
    return good;
  },
  H12: async () => {
    const p = await openDay({ native: true, asked: true }, HC([N1], SYNCED));
    const r = await p.evaluate(REPORT, D);
    const before = (await counters(p)).s65.idb;
    await p.evaluate((d) => window.__aortiReport.model(d, { sleep: false }), D);
    const after = (await counters(p)).s65.idb;
    const good = ok(r && r.source === 'health-connect' && r.asleep === 435 && r.slp[0] === '7 h 15 min asleep' && after === before,
      `H12 report from Health Connect, flag off: source ${r && r.source}, Asleep ${r && r.asleep}, row "${r && r.slp[0]}"; { sleep: false } read ${after - before} hc: keys (want health-connect, 435, "7 h 15 min asleep", 0)`);
    await close(p);
    return good;
  },
  DR: async () => {
    // Web viewer (no plugin), the night only in the cached Drive sleep files.
    const p = await openDay({ native: false }, { sleepdrive: { files: { f9: { name: 'sleep_2026-05_abc123.json', md5: 'x', origin: SAA, nights: [{ id: 'n1', s: N1.s, e: N1.e, awake: [] }] } } } });
    const done = await s64Done(p, 'applied|flag|old');
    const r = await p.evaluate(REPORT, D), b = await p.evaluate(BAND), c = await counters(p);
    console.log(`INFO DR report sleep source: '${r && r.source}'`);
    const good = ok(r && r.source === 'drive' && r.asleep === 435 && /applied$/.test(done) && b.rec === 435 && zero(c), `DR web viewer, nights from the Drive sleep files: source ${r && r.source}, Asleep ${r && r.asleep}, S64 ${done}, band ${b.rec} recorded min, __s65 ${JSON.stringify(c.s65)} (want drive, 435, applied, 435, all 0)`);
    await close(p);
    return good;
  },
  H14: async () => {
    let good = true;
    const kv = HC([N1], Object.assign({}, SYNCED, { sleep: NOW - 3600000, sleepFull: NOW - 3600000, sleepTry: NOW - 3600000 }));
    const p = await openDay({ native: true, asked: true, readReject: true }, kv);
    await p.waitForFunction(() => window.__hcFake.calls.read >= 1, null, { timeout: 20000 }).catch(() => {});
    await p.waitForTimeout(500);
    const k = await p.evaluate(KV, ['hc:sleep', 'hc:sync']), c = await counters(p);
    good = ok(c.fake.read === 1 && JSON.stringify(k['hc:sleep']) === JSON.stringify([N1]) && k['hc:sync'].sleep === NOW - 3600000, `H14 read rejects: reads ${c.fake.read}, hc:sleep kept ${JSON.stringify(k['hc:sleep']) === JSON.stringify([N1])}, hc:sync.sleep kept ${k['hc:sync'] && k['hc:sync'].sleep === NOW - 3600000} (want 1, true, true)`) && good;
    await close(p);
    const h = await openDay({ native: true, asked: true, hidden: true }, kv);
    await h.waitForTimeout(12000);
    const ch = await counters(h);
    good = ok(ch.fake.read === 0, `H14 hidden at 10 s: reads ${ch.fake.read} (want 0)`) && good;
    await close(h);
    return good;
  },
  H15: async () => {
    const p = await openDay({ native: true, asked: true }, HC([N1], SYNCED));
    const done = await s64Done(p, 'applied|flag|old');
    const b = await p.evaluate(BAND), r = await p.evaluate(REPORT, D);
    const good = ok(/applied$/.test(done) && b.rec === r.asleep && b.rec === 435, `H15 flag off, Health Connect granted: S64 ${done}, band ${b.rec} recorded min, report Asleep ${r.asleep} (want applied, equal, 435)`);
    await close(p);
    return good;
  },
  H16: async () => {
    const p = await openDay({ native: true, asked: true, rows: [N1] }, HC([], Object.assign({}, SYNCED, { sleep: dayStart(addDays(D, 1)) + 3600000, sleepFull: NOW })));
    const first = await s64Done(p);
    await p.evaluate(() => { globalThis.__s64.done = null; });
    const second = await s64Done(p, 'applied');
    const b = await p.evaluate(BAND);
    const good = ok(/flag$/.test(first) && /applied$/.test(second) && b.rec === 435, `H16 Day open before the sync passed the day, then the 10 s sync lands its night: first ${first}, then ${second} with ${b.rec} min, no reopen (want flag, applied, 435)`);
    await close(p);
    return good;
  },
  H17: async () => {
    let good = true;
    for (const [id, cfg, tryAt, want] of [['last attempt 7 h ago', {}, NOW - 7 * 3600000, [1, 1]], ['failed read 1 h ago', {}, NOW - 3600000, [0, 0]], ['sleep not granted', { granted: [] }, NOW - 7 * 3600000, [0, 0]]]) {
      const p = await openDay(Object.assign({ native: true, asked: true, hidden: true }, cfg), HC([N1], Object.assign({}, SYNCED, { sleep: tryAt, sleepTry: tryAt })));
      await p.waitForTimeout(1500);
      const c0 = await counters(p);
      await visible(p, false);
      await p.waitForTimeout(1500);
      const c1 = await counters(p);
      const d = [c1.fake.status - c0.fake.status, c1.fake.read - c0.fake.read];
      good = ok(d.join() === want.join(), `H17 hidden then visible, ${id}: ${d[0]} more status(), ${d[1]} more reads (want ${want.join(', ')})`) && good;
      await close(p);
    }
    return good;
  },
  H18: async () => {
    const p = await openDay({ native: true, asked: true }, HC([N1], SYNCED));
    const d0 = await s64Done(p, 'applied|flag');
    await reopen(p);
    const d1 = await s64Done(p);
    const b1 = await p.evaluate(BAND);
    // Sleep revoked: the next return asks again and the status no longer lists it.
    await p.evaluate(() => { window.__hcFake.granted = []; });
    await p.evaluate(KV_SET, { k: 'hc:sync', v: Object.assign({}, SYNCED, { sleepTry: NOW - 7 * 3600000 }) });
    await visible(p, false);
    await p.waitForTimeout(1000);
    await reopen(p);
    const d2 = await s64Done(p);
    const b2 = await p.evaluate(BAND);
    const good = ok(/applied$/.test(d0) && /kept$/.test(d1) && b1.rec === 435 && /flag$/.test(d2) && b2.runs <= 1 && b2.rec !== 435,
      `H18 Health Connect band, flag off, same data reopened: ${d1} (${b1.rec} min); then sleep revoked and reopened: ${d2}, ${b2.runs} band runs (want kept with 435, then flag and the old detector)`);
    await close(p);
    return good;
  },
  H19: async () => {
    const p = await openDay({ native: true, asked: true, statusDelay: 5000 }, HC([N1], SYNCED));
    const t0 = Date.now();
    const r = await p.evaluate(REPORT, D);
    const ms = Date.now() - t0;
    const first = await s64Done(p, 'flag|applied|kept');
    await p.evaluate(() => { globalThis.__s64.done = null; });
    const second = await s64Done(p, 'applied');
    const good = ok(r && r.source === null && ms < 4800 && /flag$/.test(first) && /applied$/.test(second) && !p.errors.length,
      `H19 status settles at 5 s: report after ${ms} ms with sleep ${r && r.source}, S64 first ${first}, after the settle ${second}, errors ${p.errors.length} (want under 4.8 s, none, flag, applied, 0)`);
    await close(p);
    return good;
  },
  H20: async () => {
    const p = await openDay({ native: true, asked: true }, HC([N1], SYNCED));
    const d0 = await s64Done(p, 'applied|flag');
    await p.evaluate(KV_SET, { k: 'hc:sleep', v: [] });
    await reopen(p);
    const d1 = await s64Done(p);
    const b = await p.evaluate(BAND), r = await p.evaluate(REPORT, D);
    const good = ok(/applied$/.test(d0) && /hc gone$/.test(d1) && b.rec !== 435 && r.source === null, `H20 the night deleted (weekly full read), reopened: ${d0} then ${d1}, band ${b.rec} min, report sleep ${r.source} (want applied, hc gone, the old band, none)`);
    await close(p);
    return good;
  },
  H21: async () => {
    const p = await openDay({ native: true, asked: true }, HC([N1], SYNCED));
    const d0 = await s64Done(p, 'applied|flag');
    // A stale return asks again; this status takes 6 s, so the next run gives up at 3 s.
    await p.evaluate(() => { window.__hcFake.statusDelay = 6000; });
    await p.evaluate(KV_SET, { k: 'hc:sync', v: Object.assign({}, SYNCED, { sleepTry: NOW - 7 * 3600000 }) });
    await visible(p, false);
    await p.waitForTimeout(300);
    await reopen(p);
    const d1 = await s64Done(p);
    const b = await p.evaluate(BAND);
    const good = ok(/applied$/.test(d0) && /kept$/.test(d1) && b.rec === 435, `H21 band shown, a later status times out: ${d0} then ${d1} with ${b.rec} min (want applied, kept, 435)`);
    await close(p);
    return good;
  },
};

async function partGolden(src, only, shim) {
  SERVED = src; SERVED_SHIM = shim || SHIM;
  let good = nodeCases(cut(src), only);
  good = (await driveCases(cut(src), only)) && good;
  good = shimCases(shim || SHIM, only) && good;
  if (PART !== 'golden' && !only) return good;
  for (const [id, f] of Object.entries(BROWSER)) if (want(id, only)) good = (await f()) && good;
  return good;
}

// ---------- mutants (spec section 9) ----------
const R = (a, b) => [a, b];
const MUT = [
  ['awake stages asleep', 'viewer', [R('      for (const [a, b] of sp.awake) for (let m = first(a); m < stop(b); m++) mask[m] = 0;\n', '')], ['H2', 'E1']],
  ['own origin not filtered', 'viewer', [R("if (!r || !r.origin || r.origin === S65_OWN) continue;", 'if (!r || !r.origin) continue;')], ['H6']],
  ['short nights kept', 'viewer', [R('      if (sp.e - sp.s < S65_O.minLen * 60000) continue;\n', '')], ['H3']],
  ['upload with nothing changed', 'viewer', [R('      if (state.months[m] && state.months[m].h === h) continue;\n', '')], ['DR2']],
  ['upload while paused', 'viewer', [R("    if (!o.canSync() || !o.deviceId || !o.rows || !o.sync) return 0;", '    if (!o.deviceId || !o.rows || !o.sync) return 0;'), R('      if (!o.canSync()) break;\n', '')], ['DR3']],
  ['whole body from this phone only', 'viewer', [R('    return fileNights.filter(x => x.s < cover && !ids.has(x.id)).concat(local);', '    return local;')], ['DR5']],
  ['file body carries every row field', 'viewer', [R('nights: list.map(x => ({ id: x.id, s: x.s, e: x.e, awake: x.awake.map(p => [p[0], p[1]]) }))', 'nights: list.map(x => Object.assign({ stages: [] }, x))')], ['DR1']],
  ['pull downloads every file every time', 'drive', [R('if (c && c.md5 && c.md5 === f.md5Checksum) { files[f.id] = c; continue; }', '')], ['DR6']],
  ['plugin called before Connect', 'shim', [R("available: function () { return native() && asked(); },", 'available: function () { return native(); },')], ['SH1', 'H10']],
  ['revoke keeps copies', 'viewer', [R("    if (!granted.includes('sleep')) for (const k of ['hc:sleep', 'hc:sync', 'hc:drive']) await s65Del(k);\n", '')], ['H11']],
  ['a rejected status treated as revoke', 'viewer', [R("(e) => { console.warn('[S65] status failed, copies kept', e && (e.code || e.message)); s65Visit.status = null; return null; })", "async (e) => { await hcApplyStatus({ granted: [] }); s65Visit.status = null; return null; })")], ['H11']],
  ['sync time ignored', 'viewer', [R('        if (sync && sync.sleep >= w.end + S65_O.settleMs) {', '        if (sync) {')], ['H8']],
  ['Drive files ignored', 'viewer', [R("    if (s65Overlaps(dn, w.start, w.end)) return { source: 'drive', mask: hcSleepMask(dn, w.start, n) };\n", '')], ['DR']],
  ['Asleep from the mask alone', 'viewer', [R('      if (d.hr[m] == null) continue;\n      const on = mask[m] === 1;', '      const on = mask[m] === 1;\n      if (d.hr[m] == null && !on) continue;')], ['H13']],
  ['read failure replaces the copies', 'viewer', [R("    catch (e) { console.warn('[S65] sleep read failed, copies kept', e && (e.code || e.message)); return; }", "    catch (e) { res = { rows: [], more: false }; }")], ['H14']],
  ['sync while hidden', 'viewer', [R("    if (!s65Avail() || document.hidden) return;\n    const st = await s65Status(false);\n    if (!s65Granted(st) || document.hidden) return;", "    if (!s65Avail()) return;\n    const st = await s65Status(false);\n    if (!s65Granted(st)) return;"), R('requestAnimationFrame(() => setTimeout(() => { if (!document.hidden) s65Sync(); }, S65_O.delayMs));', 'requestAnimationFrame(() => setTimeout(() => { s65Sync(); }, S65_O.delayMs));')], ['H14']],
  ['resolver after the flag gate', 'viewer', [R('    // Nights from Health Connect or Drive first (S65): no flag, history gate or digest needed.\n', "    if (!(s63Weights() === 'personal' || S63_PRINT_GENERAL)) return end('flag');\n")], ['H15']],
  ['no re-run after a sync', 'viewer', [R('    s65AfterSync(up.touched, before, now);\n', '')], ['H16']],
  ['no stale-return sync', 'viewer', [R("    document.addEventListener('visibilitychange', () => { s65OnVisible().catch(e => console.warn('[S65] return sync failed', e)); });\n", '')], ['H17']],
  ['reopen reset on the flag alone', 'viewer', [R("(s.__s64For && s.__s64Src === 'detected' && !(s63Weights() === 'personal' || S63_PRINT_GENERAL))", "(s.__s64For && !(s63Weights() === 'personal' || S63_PRINT_GENERAL))")], ['H18']],
  ['no re-run when status settles', 'viewer', [R('        if (iso) s65RerunDay(iso);\n', '')], ['H19']],
  ['resolver waits on status with no cap', 'viewer', [R('    if (s65Visit.settled) return p;\n', '    return p;\n')], ['H19']],
  ['a null source falls to the flag with a Health Connect band shown', 'viewer', [R("    if (!sleep && shown && s.__s64Src && s.__s64Src !== 'detected') return hc === S65_TIMEOUT ? end('kept') : back('hc gone');\n", '')], ['H20']],
  ['a status timeout drops the band', 'viewer', [R("return hc === S65_TIMEOUT ? end('kept') : back('hc gone');", "return back('hc gone');")], ['H21']],
];
async function runMutants() {
  let good = true;
  const nodeIds = new Set(['H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'H7', 'H13', 'E1', 'U1', 'U2', 'DR1', 'DR2', 'DR3', 'DR4', 'DR5', 'DR6', 'SH1']);
  for (const [name, where, reps, ids] of MUT) {
    if (PART === 'node' && !ids.some((i) => nodeIds.has(i))) continue;
    if (ONLY && !ids.some((i) => ONLY.includes(i))) continue;
    let src = REAL, shim = SHIM, marks = fs.readFileSync(MARKS_DRIVE, 'utf8').replace(/\r\n/g, '\n'), anchored = true;
    for (const [a, b] of reps) {
      if (where === 'viewer') { if (!src.includes(a)) anchored = false; src = src.replace(a, b); }
      else if (where === 'shim') { if (!shim.includes(a)) anchored = false; shim = shim.replace(a, b); }
      else { if (!marks.includes(a)) anchored = false; marks = marks.replace(a, b); }
    }
    if (!anchored) { good = ok(false, `mutant ${name}: ANCHOR MISSING`) && good; continue; }
    const f0 = fails, p0 = passes;
    QUIET = true; firstFail = null;
    let killed = false, why = '';
    const run = PART === 'node' ? ids.filter((i) => nodeIds.has(i)) : ids;
    try {
      let r;
      if (where === 'drive') r = await driveCases(cut(src), run, marks);
      else r = await partGolden(src, run, shim);
      if (!r) { killed = true; why = firstFail || ''; }
    } catch (e) { killed = true; why = 'threw ' + e.message.split('\n')[0]; }
    QUIET = false;
    fails = f0; passes = p0;
    good = ok(killed, `mutant ${name} (${run.join(',')}): ${killed ? 'FAILS as it must: ' + why.slice(0, 150) : 'SURVIVED'}`) && good;
  }
  return good;
}

try {
  if (MUTANTS_ON) await runMutants();
  else await partGolden(REAL, null);
} finally {
  if (browser) await browser.close();
  if (server) server.close();
}
console.log(`health-connect ${PART}${MUTANTS_ON ? ' --mutants' : ''}${ONLY ? ' --only ' + ONLY.join(',') : ''}: ${passes} pass, ${fails} fail, ${((Date.now() - T0) / 1000).toFixed(0)} s`);
process.exit(fails ? 1 : 0);
