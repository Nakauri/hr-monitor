#!/usr/bin/env node
// S9 marks store checks (ux-audit/redesign/S9-MARKS-STORE-SPEC.md section 10, as cut by section 16).
// marks-store.js and marks-drive.js run against an in-memory fake Drive with one store per device, each with
// its own device id and clock; viewer functions are pulled out of hrv_viewer.html by name.
// Every check then reruns against a mutated copy of the code, and that mutant must make the check FAIL.
// Run: node scripts/marks-store.test.cjs            (exit 0 = all checks pass and every mutant fails)
//      node scripts/marks-store.test.cjs --only M3  (one check, real code only)
process.env.TZ = 'America/Edmonton';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const SRC = {
  store: fs.readFileSync(path.join(ROOT, 'marks-store.js'), 'utf8'),
  drive: fs.readFileSync(path.join(ROOT, 'marks-drive.js'), 'utf8'),
  viewer: fs.readFileSync(path.join(ROOT, 'hrv_viewer.html'), 'utf8'),
  monitor: fs.readFileSync(path.join(ROOT, 'hr_monitor.html'), 'utf8'),
  diag: fs.readFileSync(path.join(ROOT, 'diagnostics.js'), 'utf8'),
};
const JAVA = path.join(ROOT, 'mobile', 'android-overlay', 'app', 'src', 'main', 'java', 'com', 'nakauri', 'hrmonitor');
const readJava = (f) => fs.readFileSync(path.join(JAVA, f), 'utf8');
// Line endings vary with the checkout; mutation anchors are written with LF.
for (const k of Object.keys(SRC)) SRC[k] = SRC[k].replace(/\r\n/g, '\n');

// ---------------------------------------------------------------- loading
function loadMarks(src) {
  const ctx = vm.createContext({ console, setTimeout, clearTimeout, Promise, Date, Math, JSON, Map, Set, Uint8Array, AbortController });
  ctx.self = ctx;
  vm.runInContext(src.store, ctx, { filename: 'marks-store.js' });
  vm.runInContext(src.drive, ctx, { filename: 'marks-drive.js' });
  return { M: ctx.AortiMarks, D: ctx.AortiMarksDrive };
}

function grabFrom(text, name) {
  let i = text.indexOf('async function ' + name + '(');
  if (i < 0) i = text.indexOf('function ' + name + '(');
  if (i < 0) throw new Error('function not found: ' + name);
  const j = text.indexOf('{', text.indexOf(')', i));
  let d = 0;
  for (let k = j; k < text.length; k++) {
    if (text[k] === '{') d++;
    if (text[k] === '}') { d--; if (!d) return text.slice(i, k + 1); }
  }
  throw new Error('unbalanced: ' + name);
}
function grabConstFrom(text, name) {
  const m = text.match(new RegExp('^\\s*(?:const|let) ' + name + ' = [^\\n]*;', 'm'));
  if (!m) throw new Error('const not found: ' + name);
  return m[0];
}
// Evaluates named functions in a fresh context, pulling missing functions and one-line consts on demand.
function loadPage(text, names, globals, run) {
  let code = names.map(n => grabFrom(text, n)).join('\n');
  const loaded = new Set(names);
  for (let attempt = 0; attempt < 80; attempt++) {
    const ctx = vm.createContext(Object.assign({ console, Map, Set, Date, Math, JSON, Promise, setTimeout, clearTimeout,
      parseFloat, parseInt, isNaN, isFinite, Number, String, Array, Object, Infinity, NaN, encodeURIComponent, Intl }, globals || {}));
    try {
      vm.runInContext(code + '\n;(' + (run || (() => {})).toString() + ')', ctx)();
      return ctx;
    } catch (e) {
      const m = e && e.message ? String(e.message).match(/^(\w+) is not defined$/) : null;
      if (!m || loaded.has(m[1])) throw e;
      loaded.add(m[1]);
      try { code = grabFrom(text, m[1]) + '\n' + code; }
      catch (_) { code = grabConstFrom(text, m[1]) + '\n' + code; }
    }
  }
  throw new Error('dependency resolution did not settle');
}

// ---------------------------------------------------------------- fake Drive
const FOLDER = 'application/vnd.google-apps.folder';
const md5 = (s) => crypto.createHash('md5').update(s, 'utf8').digest('hex');
const tick = (ms) => new Promise(r => setTimeout(r, ms || 0));

class FakeDrive {
  constructor() {
    this.files = new Map();
    this.seq = 0;
    this.t0 = Date.UTC(2026, 0, 1);
    this.calls = [];
    this.down = false;
    this.hang = false;
    this.delay = null;
    this.perFetchDeadline = 0;
  }
  add(f) {
    const id = f.id || 'f' + (++this.seq).toString(36) + 'x';
    const createdTime = f.createdTime || new Date(this.t0 + (++this.seq) * 1000).toISOString();
    const rec = { id, name: f.name, mimeType: f.mimeType || 'application/json', parents: f.parents || [], createdTime, trashed: false, content: f.content || '' };
    rec.md5Checksum = md5(rec.content);
    this.files.set(id, rec);
    return rec;
  }
  folder(name, parent, createdTime, id) { return this.add({ name, mimeType: FOLDER, parents: parent ? [parent] : [], createdTime, id }); }
  byName(name) { return Array.from(this.files.values()).filter(f => f.name === name); }
  childrenOf(id) { return Array.from(this.files.values()).filter(f => f.parents.includes(id)); }
  matches(f, q) {
    for (const clause of q.split(' and ')) {
      let m;
      if ((m = /^'([^']+)' in parents$/.exec(clause))) { if (!f.parents.includes(m[1])) return false; }
      else if ((m = /^name='((?:[^'\\]|\\.)*)'$/.exec(clause))) { if (f.name !== m[1].replace(/\\(.)/g, '$1')) return false; }
      else if ((m = /^name contains '([^']*)'$/.exec(clause))) { if (!f.name.includes(m[1])) return false; }
      else if ((m = /^mimeType='([^']*)'$/.exec(clause))) { if (f.mimeType !== m[1]) return false; }
      else if (clause === 'trashed=false') { if (f.trashed) return false; }
      else throw new Error('fake drive: unknown clause ' + clause);
    }
    return true;
  }
  resp(status, body) {
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    return { ok: status >= 200 && status < 300, status, json: async () => JSON.parse(text), text: async () => text };
  }
  meta(f) { const o = Object.assign({}, f); delete o.content; return o; }
  async fetch(pathOrUrl, init) {
    init = init || {};
    const method = init.method || 'GET';
    const url = new URL(pathOrUrl.startsWith('http') ? pathOrUrl : 'https://www.googleapis.com/drive/v3/' + pathOrUrl);
    this.calls.push({ method, path: url.pathname, q: url.searchParams.get('q') });
    const signal = init.signal;
    const aborted = () => { const e = new Error('aborted'); e.name = 'AbortError'; return e; };
    const work = async () => {
      if (this.hang) return new Promise((_, rej) => { if (signal) signal.addEventListener('abort', () => rej(aborted())); });
      if (this.down) throw new TypeError('Failed to fetch');
      const d = this.delay ? this.delay(method, url) : 0;
      if (d) await tick(d);
      if (signal && signal.aborted) throw aborted();
      return this.route(method, url, init);
    };
    if (!this.perFetchDeadline) return work();
    return Promise.race([work(), new Promise((_, rej) => setTimeout(() => rej(aborted()), this.perFetchDeadline))]);
  }
  route(method, url, init) {
    const p = url.pathname;
    if (this.failUploads && p.startsWith('/upload/')) return this.resp(503, { error: 'backendError' });
    if (p === '/drive/v3/about') return this.resp(200, { user: { permissionId: this.permissionId || 'perm-1' } });
    if (p === '/drive/v3/files' && method === 'GET') {
      const q = url.searchParams.get('q');
      let list = Array.from(this.files.values()).filter(f => this.matches(f, q));
      if (url.searchParams.get('orderBy') === 'createdTime') list.sort((a, b) => Date.parse(a.createdTime) - Date.parse(b.createdTime));
      const size = Math.min(Number(url.searchParams.get('pageSize') || 100), this.pageCap || 1000);
      const from = Number(url.searchParams.get('pageToken') || 0);
      const page = list.slice(from, from + size).map(f => this.meta(f));
      const out = { files: page };
      if (from + size < list.length) out.nextPageToken = String(from + size);
      return this.resp(200, out);
    }
    if (p === '/drive/v3/files' && method === 'POST') {
      const b = JSON.parse(init.body);
      return this.resp(200, { id: this.add({ name: b.name, mimeType: b.mimeType, parents: b.parents || [] }).id });
    }
    if (p === '/upload/drive/v3/files' && method === 'POST') {
      const boundary = /boundary=(.+)$/.exec(init.headers['Content-Type'])[1];
      const parts = init.body.split('--' + boundary).slice(1, -1).map(x => x.slice(x.indexOf('\r\n\r\n') + 4).replace(/\r\n$/, ''));
      const m = JSON.parse(parts[0]);
      const f = this.add({ name: m.name, mimeType: m.mimeType, parents: m.parents, content: parts[1] });
      return this.resp(200, { id: f.id, md5Checksum: f.md5Checksum });
    }
    let m;
    if ((m = /^\/upload\/drive\/v3\/files\/([^/]+)$/.exec(p)) && method === 'PATCH') {
      const f = this.files.get(decodeURIComponent(m[1]));
      if (!f || f.trashed) return this.resp(404, { error: 'notFound' });
      f.content = init.body;
      f.md5Checksum = md5(f.content);
      return this.resp(200, { id: f.id, md5Checksum: f.md5Checksum });
    }
    if ((m = /^\/drive\/v3\/files\/([^/]+)$/.exec(p)) && method === 'GET' && url.searchParams.get('alt') === 'media') {
      const f = this.files.get(decodeURIComponent(m[1]));
      if (!f) return this.resp(404, { error: 'notFound' });
      return this.resp(200, f.content);
    }
    throw new Error('fake drive: no route ' + method + ' ' + p);
  }
}

class FakeLocks {
  constructor() { this.tails = new Map(); }
  request(name, opts, cb) {
    if (typeof opts === 'function') { cb = opts; opts = {}; }
    const held = this.tails.get(name);
    if (opts && opts.ifAvailable && held) return Promise.resolve().then(() => cb(null));
    const run = (held || Promise.resolve()).then(() => cb({ name }));
    const tail = run.then(() => {}, () => {});
    this.tails.set(name, tail);
    tail.then(() => { if (this.tails.get(name) === tail) this.tails.delete(name); });
    return run;
  }
}

// ---------------------------------------------------------------- environment
const T = Date.UTC(2026, 9, 10, 4, 0, 0); // 2026-10-10 04:00Z
const H = 3600000;

function world(src) {
  const { M, D } = loadMarks(src);
  const fake = new FakeDrive();
  const root = fake.folder('HR Monitor Sessions', null, '2025-01-01T00:00:00.000Z', 'root1');
  const w = { M, D, fake, roots: [root.id], rootId: root.id };
  w.device = async (id, o) => {
    o = o || {};
    const data = o.data || {};
    const clock = { t: o.t != null ? o.t : T + 10 * H };
    const locks = o.locks === undefined ? (o.sharedLocks || new FakeLocks()) : o.locks;
    const mk = async () => {
      const store = await M.open({ backend: M.memoryBackend(data), deviceId: id, now: () => clock.t });
      const drive = D.create({
        store, driveFetch: o.driveFetch || ((p, i) => fake.fetch(p, i)),
        rootId: () => w.rootId, rootIds: o.read === false ? null : () => w.roots.slice(),
        canSync: () => true, locks, read: o.read !== false,
      });
      return { id, data, clock, store, drive, locks };
    };
    const dev = await mk();
    dev.reopen = mk;
    return dev;
  };
  w.marksFolders = (rootId) => fake.childrenOf(rootId || w.rootId).filter(f => f.name === 'marks' && f.mimeType === FOLDER);
  w.fileOf = (dev, m) => fake.byName('marks_' + m + '_' + dev.id + '.json');
  w.bodyOf = (f) => JSON.parse(f.content);
  return w;
}
const sortById = (a) => a.slice().sort((x, y) => (x.id < y.id ? -1 : 1));
const liveIds = (store) => sortById(store.all().filter(r => !r.deleted)).map(r => r.id);

// ---------------------------------------------------------------- checks
// Each check returns [[label, ok, detail], ...].
const CHECKS = {};

CHECKS.M1 = async (src) => {
  const w = world(src);
  const out = [];
  const A = await w.device('aaaaaa');
  await A.store.createSleep({ from: T, to: T + 8 * H });
  await A.store.createTap({ at: T + H, cls: 'sym', label: 'dizzy,\ngrey' });
  await A.store.reverse({ ep: T + 2 * H, label: 'sym:symptom', iid: 'abc123' });
  await A.drive.sync();
  // The five S15 kinds, written by another device: read, kept and merged untouched.
  const base = { v: 1, m: '2026-10', by: 'cccccc', createdAt: T, updatedAt: T, base: 0, deleted: false };
  const foreign = [
    Object.assign({ id: 'cccccc-1-aaaa', kind: 'added', from: T, to: T + 60000 }, base),
    Object.assign({ id: 'win:rise@' + T, kind: 'win', target: 'rise@' + T, from: T, to: T + 60000 }, base),
    Object.assign({ id: 'rm:rise@' + T, kind: 'removed', target: 'rise@' + T }, base),
    Object.assign({ id: 'st:tap@' + T, kind: 'stand', target: 'tap@' + T }, base),
    Object.assign({ id: 'note:tap@' + T, kind: 'note', target: 'tap@' + T, text: 'Grey vision on the stairs' }, base),
  ];
  w.fake.add({ name: 'marks_2026-10_cccccc.json', parents: [w.marksFolders()[0].id], content: JSON.stringify({ v: 1, by: 'cccccc', m: '2026-10', records: foreign }) });
  await A.drive.sync();
  const before = JSON.stringify(sortById(A.store.all()));
  const A2 = await A.reopen();
  const after = JSON.stringify(sortById(A2.store.all()));
  out.push(['M1 8 kinds held after a sync (3 written here, 5 read)', A.store.all().length === 8, String(A.store.all().length)]);
  out.push(['M1 reload: records deep-equal', before === after]);
  const own = w.fileOf(A, '2026-10');
  const body = own.length === 1 ? w.bodyOf(own[0]) : null;
  out.push(['M1 own file body is { v, by, m, records } with v 1', !!body && JSON.stringify(Object.keys(body)) === '["v","by","m","records"]' && body.v === 1 && body.by === 'aaaaaa' && body.m === '2026-10']);
  const allCommon = !!body && body.records.length === 3 && body.records.every(r => w.M.COMMON.every(k => Object.prototype.hasOwnProperty.call(r, k)) && w.M.invalidReason(r) === '');
  out.push(['M1 every written record carries every common field by name and validates', allCommon]);
  out.push(['M1 file is UTF-8 JSON with no BOM', own.length === 1 && own[0].content.charCodeAt(0) === 0x7b]);
  const tap = A.store.list({ kind: 'tap' })[0];
  out.push(['M1 tap label stored by the native rule', tap && tap.label === 'dizzy  grey', tap && JSON.stringify(tap.label)]);
  const rev = A.store.list({ kind: 'rev' })[0];
  const s0 = A2.store.list({ kind: 'sleep' })[0];
  A2.clock.t += 1000;
  const s1 = await A2.store.edit(s0.id, { to: T + 9 * H });
  out.push(["M1 an edit's base is the version it was made on; createdAt and m kept", s1.base === s0.updatedAt && s1.updatedAt > s0.updatedAt && s1.createdAt === s0.createdAt && s1.m === s0.m, JSON.stringify([s0.updatedAt, s1.base])]);
  out.push(['M1 rev id is rev:<k>:<ep>:<h8>', rev && rev.id === 'rev:s:' + (T + 2 * H) + ':' + w.M.fnv8('sym:symptom') && rev.row.iid === 'abc123']);
  return out;
};

CHECKS.M2 = async (src) => {
  const w = world(src);
  const A = await w.device('aaaaaa'), B = await w.device('bbbbbb');
  await A.store.createSleep({ from: T, to: T + 7 * H });
  await B.store.createTap({ at: T + 3 * H, cls: 'sym', label: 'dizzy' });
  await A.drive.sync(); await B.drive.sync(); await A.drive.sync();
  const out = [];
  out.push(['M2 sleep from A and tap from B show on both', JSON.stringify(liveIds(A.store)) === JSON.stringify(liveIds(B.store)) && liveIds(A.store).length === 2]);
  const id = A.store.list({ kind: 'sleep' })[0].id;
  A.clock.t += 60000; B.clock.t += 120000;
  await A.store.edit(id, { to: T + 8 * H });
  await B.store.edit(id, { to: T + 9 * H });
  await A.drive.sync(); await B.drive.sync(); await A.drive.sync();
  out.push(['M2 same mark edited on both offline: the later stamp (B) wins on both', A.store.get(id).to === T + 9 * H && B.store.get(id).to === T + 9 * H, A.store.get(id).to + ' / ' + B.store.get(id).to]);
  return out;
};

CHECKS.M3 = async (src) => {
  const w = world(src);
  const out = [];
  const A = await w.device('aaaaaa'), B = await w.device('bbbbbb');
  const tap = await A.store.createTap({ at: T + H, cls: 'note', label: 'grey vision' });
  await A.drive.sync(); await B.drive.sync();
  B.clock.t += 1000;
  await B.store.edit(tap.id, { label: 'grey vision on stairs' });
  await B.drive.sync(); await A.drive.sync();
  A.clock.t += 5000;
  await A.store.remove(tap.id);
  await A.drive.sync();
  await B.drive.sync();
  const bFile = w.fileOf(B, '2026-10')[0];
  out.push(['M3 deleted on A shows deleted on both', A.store.list().length === 0 && B.store.list().length === 0]);
  out.push(["M3 B's own file no longer holds the text", !!bFile && !/grey vision/.test(bFile.content)]);
  A.clock.t += 5000;
  await A.store.restore(tap.id);
  await A.drive.sync(); await B.drive.sync();
  out.push(['M3 restore later: restored on both', A.store.list().length === 1 && B.store.list().length === 1 && B.store.get(tap.id).label === 'grey vision on stairs']);
  A.clock.t += 5000;
  await A.store.remove(tap.id);
  await A.drive.sync(); await B.drive.sync();
  for (const f of w.fileOf(A, '2026-10')) w.fake.files.delete(f.id);
  const C = await w.device('cccccc');
  await C.drive.sync(); await B.drive.sync();
  out.push(["M3 deleter's file removed: the record stays deleted (B, and a new device C)", B.store.list().length === 0 && C.store.list().length === 0 && C.store.get(tap.id) && C.store.get(tap.id).deleted === true]);
  return out;
};

CHECKS.M4 = async (src) => {
  const w = world(src);
  const A = await w.device('aaaaaa'), B = await w.device('bbbbbb', { t: T + 10 * H - 2 * H });
  const s = await A.store.createSleep({ from: T, to: T + 6 * H });
  await A.drive.sync(); await B.drive.sync();
  await B.store.edit(s.id, { to: T + 7 * H });
  await B.drive.sync(); await A.drive.sync();
  return [['M4 B (clock 2 h behind) edits on top of A: B wins on both', A.store.get(s.id).to === T + 7 * H && B.store.get(s.id).to === T + 7 * H, A.store.get(s.id).to - T + ' / ' + (B.store.get(s.id).to - T)]];
};

CHECKS.M5 = async (src) => {
  const out = [];
  const fake = new FakeDrive();
  const root = fake.folder('HR Monitor Sessions', null, '2025-01-01T00:00:00.000Z', 'root1');
  const marks = fake.folder('marks', root.id);
  fake.add({ name: 'marks_2026-10_abc123.json', parents: [marks.id], content: '{}' });
  fake.add({ name: 'marks_2026-10_abc123.json', parents: [root.id], content: '{}' });
  fake.add({ name: '.hr-monitor-config.json', parents: [root.id], content: '{}' });
  fake.add({ name: 'hrv_session_2026-10-01T10-00-00.000.csv', parents: [root.id], content: 'x' });
  const month = fake.folder('2026-10', root.id);
  fake.add({ name: 'hrm_20261001T10Z_abc123.csv', parents: [month.id], content: 'x' });
  fake.add({ name: 'marks_2026-10_abc123.json', parents: [month.id], content: '{}' });
  const ctx = loadPage(src.viewer, ['driveListSessions'], {
    driveFolderId: root.id, driveRootIds: [root.id], driveFilesByName: new Map(),
    driveFetch: (p, i) => fake.fetch(p, i), segIdxGet: async () => null, segIdxPut: async () => {},
  });
  const files = await ctx.driveListSessions({});
  const names = Array.from(files.keys()).sort();
  out.push(['M5 viewer listing returns only recording names', JSON.stringify(names) === JSON.stringify(['hrm_20261001T10Z_abc123.csv', 'hrv_session_2026-10-01T10-00-00.000.csv']), names.join(',')]);
  const U = readJava('NativeDriveUploader.java');
  const gets = U.match(/driveFiles\.get\([^;]*?\);/g) || [];
  out.push(['M5 NativeDriveUploader looks Drive names up only by local file names', gets.length >= 3 && gets.every(g => /^driveFiles\.get\((f\.getName\(\)|filename)\);$/.test(g)), gets.join(' ')]);
  out.push(['M5 NativeDriveUploader never iterates the Drive listing', !/for\s*\([^)]*:\s*driveFiles\b/.test(U) && (U.match(/\.keySet\(\)/g) || []).length === 1]);
  out.push(['M5 NativeDriveUploader local loops keep .csv names only', (U.match(/getName\(\)\.endsWith\("\.csv"\)/g) || []).length >= 5]);
  const SU = readJava('SegmentUploader.java');
  const qLines = SU.split('\n').filter(l => /trashed=false/.test(l));
  out.push(['M5 every SegmentUploader query names a file or hrv_session', qLines.length >= 4 && qLines.every(l => /name='|name contains 'hrv_session'/.test(l)), qLines.length + ' queries']);
  return out;
};

// Grabbed viewer pipeline: segment text -> parseSegmentV2 -> v2SessionCsv -> summarizeCSV, and a legacy CSV.
// Runs inside the load so a missing helper is pulled in and the run retried.
function viewerPipeline(src, input) {
  const ctx = loadPage(src.viewer, ['parseSegmentV2', 'v2SessionCsv', 'summarizeCSV'], {
    localStorage: { getItem() { return null; }, setItem() {} },
    document: { getElementById() { return null; }, documentElement: {}, body: { classList: { contains() { return false; } } } },
    window: {}, getComputedStyle: () => ({ getPropertyValue: () => '' }), __in: input,
  }, function () {
    const seg = parseSegmentV2(__in.segment, __in.segName);
    globalThis.__v2 = summarizeCSV('v2:test', v2SessionCsv(__in.sid, seg.rows));
    globalThis.__legacy = summarizeCSV(__in.legacyName, __in.legacy);
  });
  return { v2: ctx.__v2, legacy: ctx.__legacy };
}

CHECKS.M7 = async (src) => {
  const out = [];
  const { M } = loadMarks(src);
  const BASE = Date.UTC(2026, 9, 5, 15, 0, 0), SID = BASE + 5000;
  const lines = ['#hrm,v=2,base=' + BASE + ',tz=-360,app=1.0,dev=test,flavour=personal', 'g,5000,' + SID + ',start', 'c,5200,connected'];
  for (let t = 6000; t < 20 * 60000; t += 1000) {
    lines.push(`h,${t},${80 + (t % 7)},30.00,750;760`);
    if (t === 600000) { lines.push('s,600000,sym:dizzy'); lines.push('s,600000,sym:symptom'); lines.push('e,600000,water glass'); }
  }
  lines.push('g,1200000,' + SID + ',stop');
  const legacy = ['time_min,epoch_ms,hr_bpm,rmssd_ms,sdnn_match_ms,sdnn_5min_ms,sdnn_full_ms,palpitation,event,warning,connection,posture'];
  const L0 = BASE + 86400000;
  for (let i = 0; i < 600; i++) {
    legacy.push(`${(i / 60).toFixed(4)},${L0 + i * 1000},80,30,,,,,,,,`);
    if (i === 300) legacy.push(`${(i / 60).toFixed(4)},${L0 + i * 1000},,,,,,,sym:symptom,,,`);
  }
  const res = viewerPipeline(src, { segment: lines.join('\n') + '\n', segName: 'hrm_20261005T15Z_abc123.csv', sid: SID,
    legacy: legacy.join('\n') + '\n', legacyName: 'hrv_session_2026-10-06T15-00-00.000.csv' });
  const sum = res.v2, ls = res.legacy;
  const ep = BASE + 600000;
  out.push(['M7 summarizeCSV events carry the exact row epoch', sum.events.length === 3 && sum.events.every(e => e.ep === ep), JSON.stringify(sum.events.map(e => e.ep))]);
  const rev = { v: 1, id: M.revId({ ep, k: 's', label: 'sym:dizzy' }), kind: 'rev', m: '2026-10', by: 'aaaaaa', createdAt: 1, updatedAt: 1, base: 0, deleted: false, row: { ep, k: 's', label: 'sym:dizzy' } };
  const scope = { originEp: SID, fromEp: SID, toEp: SID + 20 * 60000 };
  const hid = M.applyMarks(sum.events, [rev], scope);
  out.push(['M7 a rev hides exactly its row (same ep, kind and label); the others stay', hid.hidden === 1 && hid.events.map(e => e.label).join('|') === 'sym:symptom|water glass', hid.events.map(e => e.label).join('|')]);
  const back = M.applyMarks(sum.events, [Object.assign({}, rev, { deleted: true })], scope);
  out.push(['M7 deleting the rev brings the row back', back.hidden === 0 && back.events.length === 3]);
  const lrev = { v: 1, id: M.revId({ ep: L0 + 300000, k: 's', label: 'sym:symptom' }), kind: 'rev', m: '2026-10', by: 'aaaaaa', createdAt: 1, updatedAt: 1, base: 0, deleted: false, row: { ep: L0 + 300000, k: 's', label: 'sym:symptom' } };
  const lh = M.applyMarks(ls.events, [lrev], { originEp: L0 });
  out.push(['M7 the same rev rule hides a legacy sym: cell', ls.events.length === 1 && lh.events.length === 0]);
  const tap = { v: 1, id: 'aaaaaa-x-1234', kind: 'tap', m: '2026-10', by: 'aaaaaa', createdAt: 1, updatedAt: 1, base: 0, deleted: false, at: SID + 120000, cls: 'sym', label: 'chest' };
  const sl = { v: 1, id: 'aaaaaa-y-1234', kind: 'sleep', m: '2026-10', by: 'aaaaaa', createdAt: 1, updatedAt: 1, base: 0, deleted: false, from: SID - 60000, to: SID + 300000 };
  const add = M.applyMarks(sum.events, [tap, sl], scope);
  out.push(['M7 a tap record joins as a mark at its minute; a sleep record clips to the view', add.events[0].label === 'sym:chest' && add.events[0].t === 2 && add.sleep.length === 1 && add.sleep[0].start === 0 && add.sleep[0].end === 5]);
  out.push(['M7 summary schema is 16', /const SUMMARY_SCHEMA_V = 16;/.test(src.viewer) && sum.__schemaV === 16]);
  return out;
};

CHECKS.M6 = async (src) => {
  const w = world(src);
  const out = [];
  const A = await w.device('aaaaaa');
  w.fake.down = true;
  for (let i = 0; i < 5; i++) await A.store.createTap({ at: T + i * 60000, cls: 'note', label: 'n' + i });
  let threw = false;
  try { await A.drive.sync('push'); } catch (e) { threw = true; }
  out.push(['M6 Drive unreachable, 5 edits: 5 not on Drive', A.store.dirtyCount() === 5 && threw, 'dirty=' + A.store.dirtyCount()]);
  w.fake.down = false;
  w.fake.failUploads = true;
  threw = false;
  try { await A.drive.sync(); } catch (e) { threw = true; }
  out.push(['M6 Drive answers 5xx to the upload: still 5 not on Drive', A.store.dirtyCount() === 5 && threw, 'dirty=' + A.store.dirtyCount()]);
  w.fake.failUploads = false;
  await A.drive.sync();
  const f = w.fileOf(A, '2026-10');
  out.push(['M6 Drive back: 0 not on Drive and the file holds all 5', A.store.dirtyCount() === 0 && f.length === 1 && w.bodyOf(f[0]).records.length === 5]);
  // The viewer's Drive cloud reads syncing while marks wait, signed in; off stays off. shown: the 1 s delay has
  // passed (viewer-nav S23 checks the delay itself).
  const el = () => { const c = new Set(); return { classList: { contains: (k) => c.has(k), toggle: (k, on) => { if (on) c.add(k); else c.delete(k); } }, setAttribute() {}, style: {}, has: (k) => c.has(k) }; };
  const els = { 'app-bar': el(), 'drive-cloud': el(), 'syncbar-fill': el() };
  const paint = (cloud) => {
    loadPage(src.viewer, ['paintCloud'], { document: { getElementById: (id) => els[id] || null }, fitBar() {}, cloud }, function () { paintCloud(); });
    return els['app-bar'].has('syncing');
  };
  out.push(['M6 cloud reads syncing while marks are not on Drive (signed in), off when signed out',
    paint({ conn: 'synced', label: 'synced', sync: false, loader: false, marks: true, frac: 0, shown: true }) === true
    && paint({ conn: 'off', label: 'off', sync: false, loader: false, marks: true, frac: 0, shown: true }) === false
    && paint({ conn: 'synced', label: 'synced', sync: false, loader: false, marks: false, frac: 0, shown: true }) === false]);
  return out;
};

CHECKS.M8 = async (src, mutant) => {
  const files = ['auth.js', 'mobile/src/drive-auth-native.js', 'mobile/android-overlay/app/src/main/res/values/strings.xml'];
  const ids = [];
  for (const f of files) for (const m of fs.readFileSync(path.join(ROOT, f), 'utf8').matchAll(/\d{12}-[a-z0-9]{32}\.apps\.googleusercontent\.com/g)) ids.push(m[0]);
  if (mutant === 'second-client') ids.push('103129946542-ffffffffffffffffffffffffffffffff.apps.googleusercontent.com');
  return [['M8 one OAuth client id across auth.js, drive-auth-native.js, strings.xml', ids.length >= 3 && new Set(ids).size === 1, ids.length + ' ids, ' + new Set(ids).size + ' distinct']];
};

CHECKS.M9 = async (src) => {
  const w = world(src);
  const A = await w.device('aaaaaa'), B = await w.device('bbbbbb');
  await B.store.createTap({ at: T, cls: 'sym', label: 'x' });
  await B.drive.sync();
  w.fake.add({ name: 'marks_2026-10_dddddd.json', parents: [w.marksFolders()[0].id], content: 'not json {' });
  let threw = false;
  try { await A.drive.sync(); } catch (e) { threw = true; }
  const out = [['M9 one garbage file: others merge, sync completes, 1 counted', !threw && A.store.list().length === 1 && A.store.stats.badFiles === 1, 'threw=' + threw + ' bad=' + A.store.stats.badFiles]];
  // A download that fails in transit is retried on the next sync, never cached as an empty bad file.
  const C = await w.device('cccccc');
  const orig = w.fake.route.bind(w.fake);
  let once = true;
  w.fake.route = (method, url, init) => {
    if (once && url.searchParams.get('alt') === 'media') { once = false; throw new TypeError('Failed to fetch'); }
    return orig(method, url, init);
  };
  try { await C.drive.sync(); } catch (e) {}
  w.fake.route = orig;
  await C.drive.sync();
  out.push(['M9 a download that fails in transit is retried, not cached as bad', C.store.list().length === 1 && C.store.stats.badFiles === 1, 'live=' + C.store.list().length + ' bad=' + C.store.stats.badFiles]);
  return out;
};

CHECKS.M10 = async (src) => {
  const w = world(src);
  const data = {}, locks = new FakeLocks();
  const P1 = await w.device('aaaaaa', { data, sharedLocks: locks, read: false });
  const P2 = await w.device('aaaaaa', { data, sharedLocks: locks });
  await P1.store.createTap({ at: T, cls: 'note', label: 'seed' });
  await P1.drive.sync('push');
  let patches = 0;
  w.fake.delay = (method) => (method === 'PATCH' ? (++patches === 1 ? 80 : 5) : 1);
  const r1 = await P1.store.createTap({ at: T + 60000, cls: 'note', label: 'from monitor' });
  const a = P1.drive.sync('push');
  while (!w.fake.calls.some(c => c.method === 'PATCH' && patches >= 1)) await tick(1);
  const r2 = await P2.store.createTap({ at: T + 120000, cls: 'note', label: 'from viewer' });
  const b = P2.drive.sync('push');
  await Promise.all([a, b]);
  await tick(100);
  await P1.store.reloadLocal();
  const f = w.fileOf(P1, '2026-10');
  const ids = f.length === 1 ? w.bodyOf(f[0]).records.map(r => r.id) : [];
  return [['M10 two pages, one device, one month at once: both records are on Drive', ids.includes(r1.id) && ids.includes(r2.id), ids.length + ' records, files ' + f.length]];
};

CHECKS.P1 = async (src) => {
  const out = [];
  const w = world(src);
  const A = await w.device('aaaaaa');
  for (let i = 0; i < 3; i++) await A.store.createTap({ at: T + i, cls: 'note', label: 'p' + i });
  w.fake.down = true;
  out.push(['P1 offline, 3 not on Drive: the confirm names 3', (await A.drive.beforePurge(5000)) === 3]);
  w.fake.down = false;
  const B = await w.device('bbbbbb');
  for (let i = 0; i < 3; i++) await B.store.createTap({ at: T + i, cls: 'note', label: 'q' + i });
  out.push(['P1 online, upload succeeds: the confirm names 0', (await B.drive.beforePurge(5000)) === 0]);
  return out;
};

async function timed(p, limit) {
  const t0 = Date.now();
  const r = await Promise.race([p.then(v => ({ v })), new Promise(res => setTimeout(() => res({ timeout: true }), limit))]);
  return Object.assign(r, { ms: Date.now() - t0 });
}

CHECKS.P2 = async (src, mutant) => {
  const out = [];
  {
    const w = world(src);
    const A = await w.device('aaaaaa');
    for (let i = 0; i < 3; i++) await A.store.createTap({ at: T + i, cls: 'note', label: 'h' + i });
    w.fake.hang = true;
    if (mutant === 'per-fetch-only') w.fake.perFetchDeadline = 5000;
    const r = await timed(A.drive.beforePurge(), 7000);
    out.push(['P2 Drive never answers: the confirm shows within 6 s, naming 3', !r.timeout && r.ms <= 6000 && r.v === 3, r.timeout ? 'timed out' : r.ms + ' ms, ' + r.v]);
  }
  {
    const w = world(src);
    const locks = new FakeLocks();
    const A = await w.device('aaaaaa', { sharedLocks: locks });
    for (let i = 0; i < 2; i++) await A.store.createTap({ at: T + i, cls: 'note', label: 'l' + i });
    w.fake.hang = true;
    locks.request('aorti-marks:2026-10', {}, () => new Promise(() => {}));
    const r = await timed(A.drive.beforePurge(), 7000);
    out.push(['P2 another page holds the month lock: the confirm shows within 6 s', !r.timeout && r.ms <= 6000 && r.v === 2, r.timeout ? 'timed out' : r.ms + ' ms']);
  }
  {
    const w = world(src);
    // An expired token whose refresh never answers: driveFetch awaits it before any fetch, with no signal.
    const A = await w.device('aaaaaa', { driveFetch: async () => { await new Promise(() => {}); } });
    for (let i = 0; i < 3; i++) await A.store.createTap({ at: T + i, cls: 'note', label: 'r' + i });
    const r = await timed(A.drive.beforePurge(), 7000);
    out.push(['P2 token refresh never answers: the confirm shows within 6 s', !r.timeout && r.ms <= 6000 && r.v === 3, r.timeout ? 'timed out' : r.ms + ' ms']);
  }
  return out;
};

CHECKS.R1 = async (src) => {
  const w = world(src);
  const newer = w.fake.folder('HR Monitor Sessions', null, '2025-06-01T00:00:00.000Z', 'root2');
  w.roots = ['root1', 'root2'];
  const mk = w.fake.folder('marks', newer.id);
  const rec = { v: 1, id: 'cccccc-r1-abcd', kind: 'tap', m: '2026-10', by: 'cccccc', createdAt: T, updatedAt: T, base: 0, deleted: false, at: T, cls: 'sym', label: 'from the newer root' };
  w.fake.add({ name: 'marks_2026-10_cccccc.json', parents: [mk.id], content: JSON.stringify({ v: 1, by: 'cccccc', m: '2026-10', records: [rec] }) });
  const A = await w.device('aaaaaa');
  await A.drive.sync();
  return [['R1 a record under a newer, non-picked root shows in the viewer', !!A.store.get(rec.id)]];
};

CHECKS.R2 = async (src) => {
  const out = [];
  {
    const w = world(src);
    w.fake.folder('HR Monitor Sessions', null, '2025-06-01T00:00:00.000Z', 'root2');
    w.roots = ['root1', 'root2'];
    const f1 = w.fake.folder('marks', 'root1', '2025-02-01T00:00:00.000Z', 'mk-old');
    w.fake.folder('marks', 'root1', '2025-03-01T00:00:00.000Z', 'mk-new');
    const V = await w.device('aaaaaa');
    const Mo = await w.device('bbbbbb', { read: false });
    await V.store.createTap({ at: T, cls: 'note', label: 'v' });
    await Mo.store.reverse({ ep: T, label: 'sym:symptom' });
    await V.drive.sync(); await Mo.drive.sync('push');
    const vf = w.fileOf(V, '2026-10'), mf = w.fileOf(Mo, '2026-10');
    out.push(['R2 viewer and monitor both write into the oldest marks folder of the oldest root',
      vf.length === 1 && mf.length === 1 && vf[0].parents[0] === f1.id && mf[0].parents[0] === f1.id, (vf[0] || {}).parents + ' ' + (mf[0] || {}).parents]);
  }
  {
    const w = world(src);
    const A = await w.device('aaaaaa', { read: false });
    await A.store.createTap({ at: T, cls: 'note', label: 'v' });
    await A.drive.sync('push');
    const folders = w.marksFolders('root1');
    const f = w.fileOf(A, '2026-10');
    out.push(['R2 with no marks folder, one is created under the picked root and used', folders.length === 1 && f.length === 1 && f[0].parents[0] === folders[0].id]);
  }
  return out;
};

CHECKS.R3 = async (src) => {
  const out = [];
  const fx = () => {
    const fake = new FakeDrive();
    fake.folder('HR Monitor Sessions', null, '2025-05-01T00:00:00.000Z', 'r-newer');
    fake.folder('HR Monitor Sessions', null, '2025-01-01T00:00:00.000Z', 'r-b');
    fake.folder('HR Monitor Sessions', null, '2025-01-01T00:00:00.000Z', 'r-a');
    return fake;
  };
  const vf = fx();
  const v = loadPage(src.viewer, ['driveEnsureFolder', 'driveFileIsOlder'], { driveFetch: (p, i) => vf.fetch(p, i), driveSyncConfig: async () => {}, DRIVE_FOLDER_NAME: 'HR Monitor Sessions' },
    function () { globalThis.__get = () => driveFolderId; });
  await v.driveEnsureFolder();
  const mf = fx();
  const m = loadPage(src.monitor, ['driveEnsureFolder'], { driveFetch: (p, i) => mf.fetch(p, i), driveSyncConfig: async () => {}, driveUpdateUI() {}, DRIVE_FOLDER_NAME: 'HR Monitor Sessions' },
    function () { globalThis.__get = () => driveFolderId; });
  await m.driveEnsureFolder();
  out.push(['R3 viewer and monitor root pickers agree on the oldest root, id breaking the tie', v.__get() === 'r-a' && m.__get() === 'r-a', v.__get() + ' / ' + m.__get()]);
  const U = readJava('NativeDriveUploader.java');
  out.push(['R3 NativeDriveUploader orders by createdTime with the id tie-break', /addQueryParameter\("orderBy",\s*"createdTime"\)/.test(U) && /t\.equals\(bestTime\)\s*&&\s*id\.compareTo\(bestId\)\s*<\s*0/.test(U)]);
  const SU = readJava('SegmentUploader.java');
  const P = readJava('SegmentUploadPlan.java');
  const older = grabFrom(P.replace(/static boolean older/, 'function older'), 'older');
  out.push(['R3 SegmentUploader orders by createdTime; SegmentUploadPlan.older breaks ties by id', /ROOT_NAME[\s\S]{0,200}orderBy=createdTime/.test(SU) && /SegmentUploadPlan\.oldest\(/.test(SU) && /a\.id\.compareTo\(b\.id\)\s*<\s*0/.test(older)]);
  return out;
};

CHECKS.D1 = async (src) => {
  const w = world(src);
  const A = await w.device('aaaaaa'), B = await w.device('bbbbbb');
  for (let i = 0; i < 3; i++) await A.store.createTap({ at: T + i * 60000, cls: 'note', label: 'live ' + i });
  await A.drive.sync();
  const known = w.fileOf(A, '2026-10')[0];
  // A create whose response was lost: an older copy of the same name.
  const older = w.fake.add({ name: known.name, parents: known.parents, createdTime: '2025-12-31T00:00:00.000Z', content: JSON.stringify({ v: 1, by: 'aaaaaa', m: '2026-10', records: [] }) });
  await A.drive.sync();
  await B.drive.sync();
  const newer = w.fake.files.get(known.id);
  return [
    ['D1 a doubled own file: all 3 marks still show on both devices', A.store.list().length === 3 && B.store.list().length === 3, A.store.list().length + ' / ' + B.store.list().length],
    ['D1 the oldest copy holds the 3 and the newer copy holds no records', w.bodyOf(older).records.length === 3 && w.bodyOf(newer).records.length === 0 && !/live/.test(newer.content)],
  ];
};

CHECKS.L1 = async (src) => {
  const w = world(src);
  const A = await w.device('aaaaaa', { locks: null });
  await A.store.createTap({ at: T, cls: 'note', label: 'local only' });
  let r = null;
  try { r = await A.drive.sync(); } catch (e) { r = { error: e.message }; }
  const n = await A.drive.beforePurge(100);
  return [
    ['L1 no navigator.locks: the write stays local and nothing reaches Drive', w.fake.calls.length === 0 && A.store.dirtyCount() === 1 && n === 1, 'calls=' + w.fake.calls.length + ' ' + JSON.stringify(r)],
    ['L1 diagnostics names it', /'Marks sync unavailable on this browser'/.test(src.diag) && /d\.marks\.locks \?/.test(src.diag) && A.drive.status().locks === false],
  ];
};

// Section 16 M3: the marks pass runs after driveSync resolves and never changes the sync result.
CHECKS.S16 = async (src) => {
  const out = [];
  const run = async (fnName, marksThrows, driveChanged) => {
    const calls = { load: 0, route: 0 };
    const ctx = loadPage(src.viewer, [fnName, 'marksSyncPass'], {
      driveAccessToken: 'tok', driveFolderId: 'root1', autoPollBusy: false, _ensureRunning: false,
      marksPage: marksThrows == null ? null : { drive: { sync: async () => { if (marksThrows) throw new Error('boom'); return { changed: false }; } } },
      driveSync: async () => ({ changed: driveChanged }), phonePollUpdate: async () => false,
      loadSessions: async () => { calls.load++; }, route: () => { calls.route++; },
      driveEnsureFolder: async () => {}, driveUpdateUI() {}, hideLoader() {}, showSyncLoader() {},
    });
    let threw = false, unhandled = 0;
    const onU = () => { unhandled++; };
    process.on('unhandledRejection', onU);
    try { await ctx[fnName](); } catch (e) { threw = true; }
    await tick(20);
    process.off('unhandledRejection', onU);
    return JSON.stringify({ threw, unhandled, calls });
  };
  for (const changed of [false, true]) {
    const base = await run('autoPollTick', null, changed);
    const bad = await run('autoPollTick', true, changed);
    out.push(['S16 a throwing marks pass leaves the poll result unchanged (driveSync changed=' + changed + ')', base === bad, base + ' vs ' + bad]);
  }
  const eb = await run('ensureFolderSyncAndRender', null, false), ex = await run('ensureFolderSyncAndRender', true, false);
  out.push(['S16 a throwing marks pass leaves sign-in sync and render unchanged', eb === ex, eb + ' vs ' + ex]);
  const body = grabFrom(src.viewer, 'driveSyncRun');
  out.push(['S16 the marks pass is not inside driveSyncRun', !/marks/i.test(body)]);
  return out;
};

// Section 8 Q4 (cut down): marks sync only with the account this device first synced with.
CHECKS.A1 = async (src) => {
  const w = world(src);
  const A = await w.device('aaaaaa');
  await A.store.createTap({ at: T, cls: 'note', label: 'first account' });
  await A.drive.sync();
  w.fake.permissionId = 'perm-2';
  await A.store.createTap({ at: T + 1, cls: 'note', label: 'second' });
  const before = w.fake.calls.filter(c => c.method !== 'GET').length;
  const r = await A.drive.sync();
  const after = w.fake.calls.filter(c => c.method !== 'GET').length;
  return [['A1 signed in to another account: no marks are read or written there', r.skipped === 'account' && before === after && A.store.dirtyCount() === 1 && A.drive.status().blocked, JSON.stringify(r)]];
};

// Security L1 (S23): viewer marks sync honours the web Drive sync setting, as the monitor's driveSyncOn; the app always syncs.
CHECKS.SL1 = async (src) => {
  const can = (stored, native, signedIn = true) => loadPage(src.viewer, ['marksCanSync'], {
    driveAccessToken: signedIn ? 'tok' : null, driveFolderId: 'root1',
    localStorage: { getItem: (k) => (k === 'hr_monitor_drive_sync' ? stored : null) },
    window: native ? { Capacitor: { isNativePlatform: () => true } } : {},
    Capacitor: native ? { isNativePlatform: () => true } : undefined,
  }).marksCanSync();
  const waiting = (stored) => {
    const cloud = { marks: false };
    loadPage(src.viewer, ['marksChanged', 'marksCanSync'], {
      driveAccessToken: 'tok', driveFolderId: 'root1', marksVersion: 0, cloud, paintCloud() {},
      localStorage: { getItem: (k) => (k === 'hr_monitor_drive_sync' ? stored : null) }, window: {},
      marksPage: { drive: { status: () => ({ dirty: 1, locks: true, blocked: false }) } },
    }, function () { marksChanged(); });
    return cloud.marks;
  };
  return [
    ['SL1 web, Drive sync off: no marks sync', can('0', false) === false],
    ['SL1 web, Drive sync on or never set: marks sync', can('1', false) === true && can(null, false) === true],
    ['SL1 app, the setting is ignored: marks sync', can('0', true) === true],
    ['SL1 signed out: no marks sync', can('1', false, false) === false],
    ['SL1 web, Drive sync off, a mark waiting: the cloud does not count it as sync work', waiting('0') === false && waiting('1') === true],
  ];
};

// Security L2 (S23): another account signed in, the page applies none of the stored marks.
CHECKS.SL2 = async (src) => {
  const w = world(src);
  const A = await w.device('aaaaaa');
  const tap = await A.store.createTap({ at: T + H, cls: 'sym', label: 'dizzy' });
  await A.drive.sync();
  const shown = () => {
    const ctx = loadPage(src.viewer, ['viewMarks'], {
      marksPage: { store: A.store, drive: A.drive }, AortiMarks: w.M, marksMemo: new WeakMap(), marksVersion: 1,
      marksScope: () => ({ originEp: T, fromEp: T - H, toEp: T + 10 * H }),
    });
    return ctx.viewMarks({ events: [] }).events.filter(e => e.markId === tap.id).length;
  };
  const before = shown(), recsBefore = A.drive.records().length;
  w.fake.permissionId = 'perm-2';
  await A.drive.sync();
  const after = shown();
  return [
    ['SL2 own account: the stored tap shows', before === 1 && recsBefore === 1, before + ' / ' + recsBefore],
    ['SL2 another account: records() is empty and the tap does not show; the store still holds it', A.drive.status().blocked && A.drive.records().length === 0 && after === 0 && !!A.store.get(tap.id), JSON.stringify({ after, recs: A.drive.records().length })],
  ];
};

// Security L4 (S23): a marks file over 2 MB is never downloaded; a label longer than FACT_FIELD_MAX is rejected on read.
CHECKS.SL4 = async (src) => {
  const w = world(src);
  const A = await w.device('aaaaaa');
  await A.store.createSleep({ from: T, to: T + H });
  await A.drive.sync();
  const folder = w.marksFolders()[0].id;
  const base = { v: 1, m: '2026-10', createdAt: T, updatedAt: T, base: 0, deleted: false };
  const tapRec = (by, n, label) => Object.assign({ id: by + '-' + n + '-tap', kind: 'tap', by, at: T + n * 60000, cls: 'note', label }, base);
  const big = w.fake.add({ name: 'marks_2026-10_cccccc.json', parents: [folder], content: JSON.stringify({ v: 1, by: 'cccccc', m: '2026-10', records: [tapRec('cccccc', 1, 'big file')] }) });
  big.size = String(w.D.MAX_FILE_BYTES + 1);
  const small = w.fake.add({ name: 'marks_2026-10_dddddd.json', parents: [folder], content: JSON.stringify({ v: 1, by: 'dddddd', m: '2026-10', records: [tapRec('dddddd', 2, 'small file'), tapRec('dddddd', 3, 'x'.repeat(w.M.FACT_FIELD_MAX + 1))] }) });
  small.size = String(small.content.length);
  const calls0 = w.fake.calls.length;
  await A.drive.sync();
  const fetched = w.fake.calls.slice(calls0).map(c => c.path);
  const M = w.M;
  const rev = (label) => Object.assign({ id: M.revId({ ep: T, k: 'e', label }), kind: 'rev', by: 'dddddd', row: { ep: T, k: 'e', label } }, base);
  return [
    ['SL4 a marks file over 2 MB is not downloaded and adds nothing', !fetched.some(p => p.endsWith('/' + big.id)) && !A.store.get('cccccc-1-tap'), fetched.join(' ')],
    ['SL4 a small file beside it still reads', !!A.store.get('dddddd-2-tap')],
    ['SL4 a tap label one past the limit is rejected on read; at the limit it is kept', !A.store.get('dddddd-3-tap')
      && M.invalidReason(tapRec('dddddd', 4, 'x'.repeat(M.FACT_FIELD_MAX))) === '' && M.invalidReason(tapRec('dddddd', 4, 'x'.repeat(M.FACT_FIELD_MAX + 1))) === 'tap_fields'],
    ['SL4 a rev row label one past the limit is rejected; at the limit it is kept', M.invalidReason(rev('y'.repeat(M.FACT_FIELD_MAX))) === '' && M.invalidReason(rev('y'.repeat(M.FACT_FIELD_MAX + 1))) === 'row'],
  ];
};

// Section 16 M1: no Undo slot past 14 min (the native clamp is 15), so no rev is written that cannot match.
CHECKS.U1 = async (src) => {
  const { M } = loadMarks(src);
  const now = T + 20 * H;
  const ctx = loadPage(src.monitor, ['canUndoNative'], {
    marksPage: { memoryOnly: false }, window: { AortiMarks: M }, Date: { now: () => now },
  });
  const at = (min) => ctx.canUndoNative({ at: now - min * 60000 });
  return [
    ['U1 the Undo limit is 14 min', M.UNDO_LIMIT_MS === 14 * 60000],
    ['U1 a native mark 13 min old offers Undo; 14 min 1 s old does not', at(13) === true && at(14 + 1 / 60) === false && at(16) === false, [at(13), at(14 + 1 / 60), at(16)].join(',')],
    ['U1 no Undo when the store is memory only', loadPage(src.monitor, ['canUndoNative'], { marksPage: { memoryOnly: true }, window: { AortiMarks: M }, Date: { now: () => now } }).canUndoNative({ at: now }) === false],
  ];
};

// ---------------------------------------------------------------- mutants
// [check, name, file key, find, replace]. Each must make its check fail.
const MUTANTS = [
  ['M1', 'writer drops base', 'store', "        base: prev ? prev.updatedAt : 0,\n", ''],
  ['M1', 'base always 0', 'store', "        base: prev ? prev.updatedAt : 0,", "        base: 0,"],
  ['M2', 'merge ignores other devices', 'store', '      for (const f of s.files.values()) for (const r of (f.records || [])) offer(r);\n', ''],
  ['M3', 'merge ignores deleted', 'store', '          if (r.deleted && !q.withDeleted) continue;\n', ''],
  ['M3', 'no tombstone propagation', 'store', "        if (!r.deleted || r.by === s.deviceId) continue;", '        continue;'],
  ['M4', 'no +1 stamp', 'store', 'updatedAt: prev ? Math.max(t, prev.updatedAt + 1) : t,', 'updatedAt: t,'],
  ['M5', 'month listing keeps every name', 'viewer', 'if (/^hrm_(\\d{8})T(\\d{2})Z_([a-z0-9]{6})\\.csv$/.test(f.name)) {', 'if (true) {'],
  ['M6', 'dirty cleared before the PATCH', 'drive', "      if (!Object.keys(snap.month.pending || {}).length) return 'clean';\n",
    "      if (!Object.keys(snap.month.pending || {}).length) return 'clean';\n      await store.uploaded(m, snap, snap.month.fileId || 'pending', null);\n"],
  ['M6', 'cloud ignores waiting marks', 'viewer', '((cloud.loader || cloud.marks) && cloud.conn', '((cloud.loader) && cloud.conn'],
  ['M7', 'rev key without the label', 'store', "        if (revs.has(e.ep + '|' + factKind(label) + '|' + label)) { hidden++; continue; }", "        if (revs.has(e.ep + '|' + factKind(label) + '|')) { hidden++; continue; }"],
  ['M7', 'rev key without the label (both sides)', 'store', "      if (r.kind === 'rev') revs.add(r.row.ep + '|' + r.row.k + '|' + r.row.label);", "      if (r.kind === 'rev') revs.add(r.row.ep + '|' + r.row.k);"],
  ['M7', 'summarizeCSV drops ep from the event push', 'viewer', "events.push({ t, label: r[idx.event], ep });", "events.push({ t, label: r[idx.event] });"],
  ['M8', 'a second client id', null, null, 'second-client'],
  ['M9', 'a parse throw escapes', 'drive', "          entry = { name: f.name, md5: f.md5Checksum || null, records: [], bad: true };", '          throw e;'],
  ['M9', 'a transit failure is cached as bad', 'drive', "        const r = await opts.driveFetch('files/' + encodeURIComponent(f.id) + '?alt=media', { signal });\n        if (!r.ok) throw httpError('download', r, '');\n        const text = await r.text();",
    "        let text = '';\n        try { const r = await opts.driveFetch('files/' + encodeURIComponent(f.id) + '?alt=media', { signal }); text = await r.text(); } catch (e) {}"],
  ['M10', 'no month lock', 'drive', "      return locks.request('aorti-marks:' + m, lockOpts || {}, (lock) => (lock ? fn() : 'busy'));", '      return fn();'],
  ['P1', 'purge skips the upload', 'drive', "          await push(signal, { ifAvailable: true });", ''],
  ['P2', 'no deadline', 'drive', '        await Promise.race([work, new Promise(r => { timer = setTimeout(r, ms); })]);', '        await work;'],
  ['P2', 'per-fetch deadline only', 'drive', '        await Promise.race([work, new Promise(r => { timer = setTimeout(r, ms); })]);', '        await work;', 'per-fetch-only'],
  ['R1', 'marks read only under the picked root', 'drive', '      const roots = (opts.rootIds && opts.rootIds()) || [];', '      const roots = [];'],
  ['R2', 'newest marks folder', 'drive', '      st.folderId = found.slice().sort(olderFirst)[0].id;', '      st.folderId = found.slice().sort(olderFirst).pop().id;'],
  ['R3', 'viewer picker without the id tie-break', 'viewer', '    if (ta !== tb) return ta < tb;\n    return String(a.id) < String(b.id);', '    return ta < tb;'],
  ['D1', 'newer copy rewritten as fresh tombstones', 'drive', '        const body = M.fileBody(store.deviceId, d.m, []);',
    '        const body = M.fileBody(store.deviceId, d.m, store.all().filter(r => r.m === d.m).map(r => Object.assign(M.tombstoneOf(r), { by: store.deviceId, updatedAt: r.updatedAt + 1, base: r.updatedAt })));'],
  ['L1', 'sync without the lock', 'drive', "      if (!locks) { st.lastError = 'nolocks'; return { changed: false, skipped: 'nolocks' }; }", "      if (!locks) st.lastError = 'nolocks';"],
  ['A1', 'any account syncs', 'drive', '      st.blocked = bound !== key;', '      st.blocked = false;'],
  ['U1', 'no time limit on Undo', 'monitor', ' && Date.now() - m.at <= window.AortiMarks.UNDO_LIMIT_MS);', ');'],
  ['SL1', 'viewer marks ignore the Drive sync setting', 'viewer', "    try { return localStorage.getItem('hr_monitor_drive_sync') !== '0'; } catch (e) { return true; }", '    return true;'],
  ['SL1', 'the app obeys the web setting', 'viewer', '    if (window.Capacitor && Capacitor.isNativePlatform && Capacitor.isNativePlatform()) return true;\n', ''],
  ['SL1', 'waiting marks count as sync work with sync off', 'viewer', ' && !st.blocked && marksCanSync());', ' && !st.blocked);'],
  ['SL2', 'records() ignores the account guard', 'drive', '      records() { return st.blocked ? [] : store.all(); },', '      records() { return store.all(); },'],
  ['SL2', 'the viewer applies the raw store', 'viewer', 'AortiMarks.applyMarks(raw, marksPage.drive.records(), marksScope(s))', 'AortiMarks.applyMarks(raw, marksPage.store.all(), marksScope(s))'],
  ['SL4', 'no size cap', 'drive', '        if (Number(f.size) > MAX_FILE_BYTES) continue;\n', ''],
  ['SL4', 'tap label length unchecked', 'store', ' && isStr(r.label) && r.label.length <= FACT_FIELD_MAX)) return', ' && isStr(r.label))) return'],
  ['SL4', 'rev label length unchecked', 'store', " || !isStr(w.label) || w.label.length > FACT_FIELD_MAX) return 'row';", " || !isStr(w.label)) return 'row';"],
  ['S16', 'marks pass not caught', 'viewer', "    try {\n      const r = await marksPage.drive.sync();\n      return !!(r && r.changed);\n    } catch (e) {\n      console.warn('[marks] sync failed', e && e.message);\n      return false;\n    }",
    '    const r = await marksPage.drive.sync();\n    return !!(r && r.changed);'],
];

// The L1 mutant also needs the lock call itself to pass through when there is no lock manager.
const EXTRA = { 'sync without the lock': [['drive', '    async function push(signal, lockOpts) {\n      if (!locks) return \'nolocks\';', '    async function push(signal, lockOpts) {'],
  ['drive', "      return locks.request('aorti-marks:' + m, lockOpts || {}, (lock) => (lock ? fn() : 'busy'));", "      return locks ? locks.request('aorti-marks:' + m, lockOpts || {}, (lock) => (lock ? fn() : 'busy')) : fn();"]] };

function mutate(name, key, find, replace) {
  const src = Object.assign({}, SRC);
  const edits = [[key, find, replace]].concat(EXTRA[name] || []);
  for (const [k, f, r] of edits) {
    if (!k) continue;
    if (!src[k].includes(f)) throw new Error('mutation anchor not found (' + name + '): ' + f.slice(0, 80));
    src[k] = src[k].replace(f, r);
  }
  return src;
}

// ---------------------------------------------------------------- main
module.exports = { FakeDrive, FakeLocks };
if (require.main === module) (async () => {
  const oi = process.argv.indexOf('--only');
  const only = oi > 0 ? process.argv[oi + 1] : null;
  let bad = 0;
  for (const [id, fn] of Object.entries(CHECKS)) {
    if (only && id !== only) continue;
    let rows;
    try { rows = await fn(SRC); } catch (e) { rows = [[id + ' threw: ' + (e && e.stack || e), false]]; }
    for (const [label, ok, detail] of rows) {
      console.log((ok ? 'PASS ' : 'FAIL ') + label + (detail && !ok ? '  [' + detail + ']' : ''));
      if (!ok) bad++;
    }
  }
  if (!only) {
    console.log('\nNegative controls (each must FAIL its check):');
    for (const [check, name, key, find, replace, flag] of MUTANTS) {
      let caught = false, note = '';
      try {
        const src = key ? mutate(name, key, find, replace) : SRC;
        const rows = await CHECKS[check](src, key ? flag : replace);
        const fails = rows.filter(r => !r[1]);
        caught = fails.length > 0;
        note = fails.map(r => r[0]).join(' | ');
      } catch (e) {
        if (/mutation anchor not found/.test(e.message)) { note = e.message; caught = false; }
        else { caught = true; note = 'threw: ' + e.message.split('\n')[0]; }
      }
      console.log('MUTANT ' + check + ' ' + name + ': ' + (caught ? 'FAILED as required' : 'NOT CAUGHT') + (note ? '  (' + note + ')' : ''));
      if (!caught) bad++;
    }
  }
  if (bad) { console.log('\n' + bad + ' problem(s)'); process.exit(1); }
  console.log('\nAll marks store checks pass' + (only ? '' : '; all ' + MUTANTS.length + ' negative controls fail'));
})();
