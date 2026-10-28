#!/usr/bin/env node
// Guards: the web recorder (recorder.js), which saves a web session to the user's folder and to Drive. A lost
// recording, or one reported Saved that did not land, is the worst defect this app can have. Every non-PAGE
// scenario of docs/web-recorder.md (S1..S32, S2b, S28b) and every non-PAGE rule runs here; PAGE ones run in the
// page's own check. Files: recorder.js, docs/web-recorder.md, scripts/recorder.mutants.cjs.
// The module runs over a fake env: a hand-advanced clock and timers, a fake folder whose writes resolve, reject or
// hang on command, and a fake Drive (create, PATCH, size) that records each body, file id and login. Each check
// reruns against mutated code from recorder.mutants.cjs, and every mutant must make a check FAIL.
// Run: node scripts/recorder.test.cjs
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
// Mutation anchors are written with LF.
const SRC = fs.readFileSync(path.join(ROOT, 'recorder.js'), 'utf8').replace(/\r\n/g, '\n');
const MB = 1048576;
const T0 = Date.UTC(2026, 9, 27, 12, 0, 0);

function load(text) {
  const ctx = vm.createContext({ console, Promise, Date, Math, JSON, Number, String, Array, Object, Error, TextEncoder, encodeURIComponent });
  ctx.module = { exports: {} };
  vm.runInContext(text, ctx, { filename: 'recorder.js' });
  return ctx.module.exports;
}

function defer() { let resolve, reject; const p = new Promise((a, b) => { resolve = a; reject = b; }); return { p, resolve, reject }; }
// setImmediate runs after the microtask queue drains, so a few rounds settle every chain that is not waiting on us.
async function flush() { for (let i = 0; i < 4; i++) await new Promise((r) => setImmediate(r)); }
function track(rec) { const o = { done: false }; rec.final.then(() => { o.done = true; }); return o; }

// A folder: ensurePermission answers dir.perm (true, false or 'hang'); createFile takes the next of dir.creates
// ('ok', 'fail', 'hang'). A handle's writes take the next of handle.modes ('ok', 'fail', 'hang').
function mkDir(name, o) {
  return Object.assign({ name, perm: true, creates: [], handles: [], hungCreates: [], permCalls: 0, createCalls: 0 }, o || {});
}
function mkHandle(dir, fname) {
  return { dir, fname, content: '', writes: [], landed: [], modes: [], hung: [], inflight: 0, maxInflight: 0 };
}

// One world: the page's data, the clock, a folder system, a Drive, and the recorder over them.
function world(src, opts) {
  const w = { t: T0, timers: [], nextTimer: 1, statuses: [], builds: 0, buildTimes: [], page: { id: 1, text: 'time,hr\n0,80\n', rows: 1 } };
  const d = w.drive = { token: 'tok-A', tag: 'email:A', folderId: 'root', sync: true, files: {}, n: 0, log: [], plan: [], hung: [], late: [],
    inflight: 0, maxInflight: 0, refreshes: 0, lookups: 0, lookupMode: 'ok', headerPlan: [], hungHeaders: [] };
  const add = (fn, ms, repeat) => { const id = w.nextTimer++; w.timers.push({ id, at: w.t + ms, ms, fn, repeat }); if (repeat) w.lastInterval = fn; return id; };
  const remove = (id) => { w.timers = w.timers.filter((x) => x.id !== id); };
  w.intervals = () => w.timers.filter((x) => x.repeat).length;
  w.advance = async (ms) => {
    const end = w.t + ms;
    await flush();
    for (;;) {
      let next = null;
      for (const x of w.timers) if (x.at <= end && (!next || x.at < next.at)) next = x;
      if (!next) break;
      w.t = next.at;
      if (next.repeat) next.at += next.ms; else remove(next.id);
      try { next.fn(); } catch (e) { w.threw = e; }
      await flush();
    }
    w.t = end;
    await flush();
  };
  const owner = (init) => { const m = /tok-(\w+)/.exec((init.headers || {}).Authorization || ''); return m ? m[1] : null; };
  const csvOf = (body) => { const a = String(body).split('Content-Type: text/csv\r\n\r\n')[1]; return a.slice(0, a.lastIndexOf('\r\n--')); };
  const resp = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
  // The real answer, applied to the files.
  const apply = (req) => {
    if (req.kind === 'create') {
      const id = 'f' + (++d.n);
      d.files[id] = { owner: req.owner, content: req.body, name: req.name };
      return resp(200, { id });
    }
    const f = d.files[req.id];
    if (!f || f.owner !== req.owner) return resp(404, {});
    if (req.kind === 'patch') { f.content = req.body; return resp(200, {}); }
    return resp(200, { size: String(Buffer.byteLength(f.content, 'utf8')) });
  };
  const env = Object.assign({
    now: () => w.t,
    setInterval: (fn, ms) => add(fn, ms, true), clearInterval: remove,
    setTimeout: (fn, ms) => add(fn, ms, false), clearTimeout: remove,
    buildCsv: (id) => { w.builds++; w.buildTimes.push(w.t); return w.page.id === id ? w.page.text : null; },
    rowCount: () => w.page.rows,
    ensurePermission: (dir) => { dir.permCalls++; if (dir.perm === 'hang') { const x = defer(); dir.hungPerm = x; return x.p; } return Promise.resolve(dir.perm); },
    createFile: (dir, fname) => {
      dir.createCalls++;
      const mode = dir.creates.shift() || 'ok';
      const h = mkHandle(dir, fname);
      if (mode === 'ok') { dir.handles.push(h); return Promise.resolve(h); }
      if (mode === 'fail') return Promise.reject(new Error('create failed'));
      const x = defer();
      dir.hungCreates.push({ ok: () => { dir.handles.push(h); x.resolve(h); }, fail: () => x.reject(new Error('create failed')), handle: h });
      return x.p;
    },
    writeFile: (h, text) => {
      const mode = h.modes.shift() || 'ok';
      h.writes.push(text);
      h.inflight++; h.maxInflight = Math.max(h.maxInflight, h.inflight);
      const x = defer();
      const ok = () => { h.inflight--; h.content = text; h.landed.push(text); x.resolve(); };
      const fail = () => { h.inflight--; x.reject(new Error('write failed')); };
      if (mode === 'ok') Promise.resolve().then(ok);
      else if (mode === 'fail') Promise.resolve().then(fail);
      else h.hung.push({ ok, fail, text });
      return x.p;
    },
    token: () => d.token, folderId: () => d.folderId, syncOn: () => d.sync, loginTag: () => d.tag,
    ensureFolder: () => { d.lookups++; if (d.lookupMode === 'ok') { d.folderId = 'root'; return Promise.resolve('root'); } return Promise.reject(new Error('lookup failed')); },
    authHeader: () => {
      const mode = d.headerPlan.shift();
      if (mode === 'hang') { const x = defer(); d.hungHeaders.push(() => x.resolve(d.token ? 'Bearer ' + d.token : null)); return x.p; }
      return Promise.resolve(d.token ? 'Bearer ' + d.token : null);
    },
    refresh: () => { d.refreshes++; return Promise.resolve(); },
    fetch: (url, init) => {
      const kind = init.method === 'POST' ? 'create' : init.method === 'PATCH' ? 'patch' : 'size';
      const m = /\/files\/([^?]+)\?/.exec(url);
      const req = { kind, t: w.t, url, owner: owner(init), id: m ? decodeURIComponent(m[1]) : null,
        body: kind === 'create' ? csvOf(init.body) : kind === 'patch' ? init.body : null,
        name: kind === 'create' ? JSON.parse(/\{"name".*?\}(?=\r\n)/.exec(init.body)[0]).name : null };
      d.log.push(req);
      const i = d.plan.findIndex((p) => p.kind === kind || p.kind === '*');
      const act = i < 0 ? 'ok' : d.plan.splice(i, 1)[0].act;
      d.inflight++; d.maxInflight = Math.max(d.maxInflight, d.inflight);
      const x = defer();
      const done = (fn) => { d.inflight--; fn(); };
      const settle = (r) => { req.status = r.status; done(() => x.resolve(r)); };
      const drop = () => { req.status = 'dropped'; done(() => x.reject(new TypeError('Failed to fetch'))); };
      if (act === 'ok') Promise.resolve().then(() => settle(apply(req)));
      else if (typeof act === 'number') Promise.resolve().then(() => settle(resp(act, {})));
      // A size read that reports a byte more than Drive holds.
      else if (act === 'stale') Promise.resolve().then(() => settle(resp(200, { size: String(Buffer.byteLength(d.files[req.id].content, 'utf8') + 1) })));
      else if (act === 'drop') Promise.resolve().then(drop);
      // Dropped now, committed by Drive later when the test says so.
      else if (act === 'dropLate') { d.late.push(() => apply(req)); Promise.resolve().then(drop); }
      else d.hung.push({ req, commit: () => settle(apply(req)), status: (s) => settle(resp(s, {})), drop, dropCommit: () => { apply(req); drop(); } });
      return x.p;
    },
    onStatus: (text, cls) => w.statuses.push(text),
    warn: () => {},
  }, opts || {});
  w.env = env;
  w.R = load(src).create(env);
  w.signIn = (a) => { d.token = 'tok-' + a; d.tag = 'email:' + a; };
  w.signOut = () => { d.token = null; d.tag = null; };
  w.live = async (dir, id) => { const rec = w.R.start(id || w.page.id, w.t, dir || null); await flush(); return rec; };
  w.text = (s) => { w.page.text = 'time,hr\n' + s + '\n'; w.page.rows++; return w.page.text; };
  w.reqs = (kind) => d.log.filter((r) => !kind || r.kind === kind);
  w.status = () => w.statuses[w.statuses.length - 1];
  return w;
}

const CHECKS = {};

// ---------------------------------------------------------------- scenarios
CHECKS.S = async (src) => {
  const out = [];
  const row = (label, ok, detail) => out.push([label, !!ok, detail]);
  let w, rec, fin, dir, h;

  // S1: Stop with a routine upload in flight: the final waits, then uploads.
  w = world(src); rec = await w.live();
  w.drive.plan.push({ kind: 'create', act: 'hang' });
  await w.advance(10000);
  let tf = w.text('1,81');
  fin = track(w.R.stop()); await flush();
  const waited = w.reqs().length === 1 && rec.result.drive === 'pending' && !fin.done;
  w.drive.hung.shift().commit(); await flush();
  row('S1 the final waits for the routine create, then uploads; result.drive saved',
    waited && fin.done && rec.result.drive === 'saved' && w.drive.files.f1.content === tf && w.drive.maxInflight === 1
    && w.reqs().map((r) => r.kind).join() === 'create,patch', JSON.stringify([waited, rec.result, w.reqs().map((r) => r.kind)]));

  // S2: a routine folder write slow at Stop: folder and Drive both end with the final text.
  w = world(src); dir = mkDir('X'); rec = await w.live(dir); h = dir.handles[0];
  h.modes.push('hang');
  await w.advance(10000);
  tf = w.text('1,82');
  fin = track(w.R.stop()); await flush();
  const s2mid = rec.result.folder === 'pending' && rec.result.drive === 'saved' && !fin.done;
  h.hung.shift().ok(); await flush();
  row('S2 a slow routine folder write at Stop: folder and Drive both end with the final text',
    s2mid && fin.done && h.content === tf && w.drive.files.f1.content === tf && h.maxInflight === 1 && rec.result.folder === 'saved', JSON.stringify(rec.result));

  // S2b: the routine write runs long after Stop, then succeeds.
  w = world(src); dir = mkDir('X'); rec = await w.live(dir); h = dir.handles[0];
  h.modes.push('hang');
  await w.advance(10000);
  tf = w.text('1,83');
  fin = track(w.R.stop());
  await w.advance(300000);
  const s2bMid = rec.result.folder === 'pending' && !fin.done && h.writes.length === 1;
  h.hung.shift().ok(); await flush();
  row('S2b a routine write long after Stop: pending until it settles, then the final writes; saved',
    s2bMid && fin.done && rec.result.folder === 'saved' && h.content === tf && h.writes.length === 2 && h.maxInflight === 1, JSON.stringify(rec.result));

  // S4: Stop during arming while createFile is pending: no file write, no interval, Drive gets the data.
  w = world(src); dir = mkDir('X', { creates: ['hang'] });
  rec = w.R.start(1, w.t, dir); await flush();
  const arming = rec.state === 'arming';
  tf = w.text('1,84');
  fin = track(w.R.stop()); await flush();
  const hung = dir.hungCreates.shift(); hung.ok(); await flush();
  await w.advance(60000);
  row('S4 Stop while arming: nothing written to the file, no interval, Drive has the data, result.folder unwritten',
    arming && fin.done && w.intervals() === 0 && hung.handle.writes.length === 0 && rec.file === null
    && rec.result.folder === 'unwritten' && rec.result.drive === 'saved' && w.drive.files.f1.content === tf, JSON.stringify(rec.result));

  // S5: Start while the old final is uploading: the old upload lands in the old file only.
  w = world(src); const dA = mkDir('A'), dB = mkDir('B');
  const A5 = await w.live(dA);
  await w.advance(10000);
  let ta = w.text('1,85');
  w.drive.plan.push({ kind: 'patch', act: 'hang' });
  fin = track(w.R.stop()); await flush();
  w.page.id = 2; const tb = w.text('2,90');
  const B5 = await w.live(dB, 2);
  w.drive.hung.shift().commit(); await flush();
  await w.advance(10000);
  const fA = A5.driveFileId, fB = B5.driveFileId;
  row('S5 Start while the old final uploads: the old upload lands in the old file only',
    fin.done && A5.result.drive === 'saved' && fA && fB && fA !== fB && w.drive.files[fA].content === ta && w.drive.files[fB].content === tb
    && w.reqs().filter((r) => r.id === fA || (r.kind === 'create' && r.body === ta)).every((r) => !r.body || !r.body.includes('2,90'))
    && dA.handles[0].writes.every((x) => !x.includes('2,90')) && dB.handles[0].content === tb, JSON.stringify([fA, fB]));

  // S6: an old Recording live, then Start: the old one is stopped first; its file never gets new data.
  w = world(src); const d6a = mkDir('A'), d6b = mkDir('B');
  const A6 = await w.live(d6a);
  await w.advance(10000);
  const B6 = w.R.start(2, w.t, d6b);
  const stoppedFirst = A6.state !== 'live' && A6.interval === null && A6.final !== null;
  w.page.id = 2; w.text('2,91'); await flush();
  await w.advance(30000);
  row('S6 Start with an old Recording live: it stops first, one interval, its file never gets new data',
    stoppedFirst && A6.state === 'done' && w.intervals() === 1 && d6a.handles[0].writes.every((x) => !x.includes('2,91'))
    && d6b.handles[0].content.includes('2,91') && A6.result.folder === 'saved' && w.R.current() === B6, JSON.stringify([A6.state, w.intervals()]));

  // S7: the page resets after the 30 s cap: the final still writes the text built at Stop.
  w = world(src); dir = mkDir('X'); rec = await w.live(dir); h = dir.handles[0];
  await w.advance(10000);
  h.modes.push('hang');
  await w.advance(10000);
  tf = w.text('1,86');
  fin = track(w.R.stop());
  w.page.id = 2; w.page.text = 'time,hr\n';
  await w.advance(40000);
  h.hung.shift().ok(); await flush();
  row('S7 a page reset after the cap: the final writes the text built at Stop',
    fin.done && rec.text === tf && h.content === tf && w.drive.files.f1.content === tf && rec.result.folder === 'saved', JSON.stringify(h.content));

  // S10: the folder lookup failed at load: uploads reach Drive within a minute of the retry; one lookup a minute.
  w = world(src); w.drive.folderId = null; w.drive.lookupMode = 'fail';
  rec = await w.live();
  await w.advance(50000);
  const early10 = w.drive.lookups === 1 && w.reqs().length === 0;
  w.drive.lookupMode = 'ok';
  await w.advance(10000);
  const retryAt = w.drive.lookups === 2 ? w.t : null;
  await w.advance(60000);
  const first = w.reqs('create')[0];
  row('S10 a failed lookup at load: one lookup a minute, uploads reach Drive within a minute of the retry',
    early10 && retryAt && first && first.t - retryAt <= 60000 && w.drive.lookups === 2, JSON.stringify([w.drive.lookups, first && first.t - T0]));

  // S12a: an account switch during the first create: the old id is discarded; uploads go to the new account.
  w = world(src); rec = await w.live();
  w.drive.plan.push({ kind: 'create', act: 'hang' });
  await w.advance(10000);
  w.signIn('B'); w.R.authChanged();
  w.drive.hung.shift().commit(); await flush();
  const discarded = rec.driveFileId === null;
  await w.advance(120000);
  const bFile = rec.driveFileId;
  row('S12 a switch during the first create: the old id is dropped, uploads go to the new account',
    discarded && bFile && w.drive.files[bFile].owner === 'B' && w.reqs().slice(1).every((r) => r.owner === 'B' && r.id !== 'f1')
    && w.reqs('patch').length >= 1 && rec.login === 'email:B', JSON.stringify(w.reqs().map((r) => [r.kind, r.id, r.owner])));

  // S12b: a switch during an old final's create: it creates once under the new login and follows that create.
  w = world(src); rec = await w.live();
  tf = w.text('1,87');
  w.drive.plan.push({ kind: 'create', act: 'hang' });
  fin = track(w.R.stop()); await flush();
  w.signIn('B');
  w.drive.hung.shift().commit(); await flush();
  const creates = w.reqs('create');
  row('S12 a switch during an old final: one create under the new login; result.drive follows it',
    fin.done && rec.result.drive === 'saved' && creates.length === 2 && creates[1].owner === 'B' && w.drive.files[rec.driveFileId].owner === 'B'
    && w.drive.files[rec.driveFileId].content === tf, JSON.stringify([rec.result, creates.map((c) => c.owner)]));

  // S12c: the switch lands before the final's PATCH: the old file is dropped, the final creates under the new login.
  w = world(src); rec = await w.live();
  await w.advance(10000);
  w.signIn('B'); tf = w.text('1,88');
  fin = track(w.R.stop()); await flush();
  row('S12 a switch before the final: no PATCH into the old account\'s file; saved under the new one',
    fin.done && rec.result.drive === 'saved' && w.reqs('patch').length === 0 && w.drive.files[rec.driveFileId].owner === 'B' && w.drive.files.f1.content !== tf,
    JSON.stringify(w.reqs().map((r) => [r.kind, r.id, r.owner])));

  // S13: the same account signs out and back in: the same Drive file keeps being updated.
  w = world(src); rec = await w.live();
  await w.advance(10000);
  w.signOut(); w.R.authChanged();
  await w.advance(60000);
  const quiet = w.reqs().length === 1;
  w.signIn('A'); w.R.authChanged();
  await w.advance(60000);
  row('S13 the same account out and back in: the same file keeps being updated',
    quiet && w.reqs('create').length === 1 && w.reqs('patch').length >= 1 && w.reqs('patch').every((r) => r.id === 'f1'), JSON.stringify(w.reqs().map((r) => [r.kind, r.id])));

  // S14: a PATCH answered 404: one create, then PATCHes to the new file.
  w = world(src); rec = await w.live();
  await w.advance(10000);
  w.drive.plan.push({ kind: 'patch', act: 404 });
  await w.advance(60000);
  await w.advance(60000);
  const k14 = w.reqs().map((r) => r.kind + ':' + (r.id || ''));
  row('S14 a PATCH answered 404: one create, then PATCHes to the new file',
    k14.join() === 'create:,patch:f1,create:,patch:f2' && rec.driveFileId === 'f2', k14.join());

  // S15: a new Start with permission denied after an old final past the cap: nothing written into the old file.
  w = world(src); const d15a = mkDir('A'), d15b = mkDir('B', { perm: false });
  const A15 = await w.live(d15a); h = d15a.handles[0];
  await w.advance(10000);
  h.modes.push('hang');
  await w.advance(10000);
  ta = w.text('1,89');
  fin = track(A15 === w.R.stop() ? A15 : null);
  w.page.id = 2; w.text('2,92');
  await w.advance(40000);
  const B15 = await w.live(d15b, 2);
  const denied = w.status() === 'denied';
  await w.advance(30000);
  h.hung.shift().ok(); await flush();
  row('S15 a denied new Start after an old final past the cap: nothing written into the old file',
    denied && fin.done && h.writes.every((x) => !x.includes('2,92')) && h.content === ta && d15b.createCalls === 0 && B15.file === null
    && !w.R.targets().folder && A15.result.folder === 'saved', JSON.stringify([w.statuses, h.writes.length]));

  // S16: sign in mid-session: routine Drive saves start; targets() reports Drive.
  w = world(src); w.signOut();
  rec = await w.live();
  await w.advance(10000);
  const before16 = !w.R.targets().drive && w.reqs().length === 0;
  w.signIn('A'); w.R.authChanged();
  const after16 = w.R.targets().drive;
  await w.advance(10000);
  fin = track(w.R.stop()); await flush();
  row('S16 sign in mid-session: Drive saves start and targets() reports Drive',
    before16 && after16 && w.reqs('create').length === 1 && rec.seen.drive && rec.result.drive === 'saved', JSON.stringify(rec.result));

  // S17: 20 hides a minute at 48 h: at most one forced rebuild a minute; Drive within its pace.
  w = world(src); dir = mkDir('X'); rec = await w.live(dir);
  w.page.text = 'x'.repeat(3 * MB);
  const forcedAt = [];
  for (let i = 0; i < 100; i++) {
    w.page.rows++;
    const b = w.builds; w.R.hidden();
    if (w.builds > b) forcedAt.push(w.t);
    await flush();
    await w.advance(3000);
  }
  const gapsOk = (ts, min) => ts.every((x, i) => i === 0 || x - ts[i - 1] >= min);
  const driveTimes = w.reqs().map((r) => r.t);
  // Above SAVE_BIG, ticks and forced writes share one limit: every build a minute or more after the last.
  row('S17 20 hides a minute at 48 h: one rebuild a minute at most, ticks and forced alike; Drive at its pace (3 MB: 3 min)',
    forcedAt.length >= 1 && gapsOk(forcedAt, 60000) && gapsOk(w.buildTimes, 60000) && driveTimes.length >= 2 && gapsOk(driveTimes, 180000),
    JSON.stringify([forcedAt.map((x) => (x - T0) / 1000), driveTimes.map((x) => (x - T0) / 1000)]));

  // S18: a hung upload at Stop: pending at 30 s, final unsettled; the result follows when it settles.
  w = world(src); rec = await w.live();
  await w.advance(10000);
  w.drive.plan.push({ kind: 'patch', act: 'hang' });
  tf = w.text('1,93');
  fin = track(w.R.stop());
  await w.advance(30000);
  const pend18 = rec.result.drive === 'pending' && !fin.done && w.status() === 'saving';
  w.drive.hung.shift().commit(); await flush();
  row('S18 a hung final upload: pending at 30 s, then saved when it lands',
    pend18 && fin.done && rec.result.drive === 'saved' && w.drive.files.f1.content === tf, JSON.stringify(rec.result));
  w = world(src); rec = await w.live();
  await w.advance(10000);
  w.drive.plan.push({ kind: 'patch', act: 'hang' }, { kind: 'patch', act: 503 });
  fin = track(w.R.stop());
  await w.advance(30000);
  const pend18b = rec.result.drive === 'pending' && !fin.done;
  w.drive.hung.shift().drop(); await flush();
  row('S18 a hung final upload that then fails: pending, then failed after the one retry',
    pend18b && fin.done && rec.result.drive === 'failed' && w.reqs('patch').length === 2, JSON.stringify([rec.result, w.reqs('patch').length]));

  // S19: signed out, no folder: nothing built or saved.
  w = world(src); w.signOut();
  rec = await w.live();
  await w.advance(60000);
  w.R.hidden();
  const t19 = w.R.targets();
  const nothing = w.builds === 0 && w.reqs().length === 0 && !t19.folder && !t19.drive;
  fin = track(w.R.stop()); await flush();
  row('S19 signed out with no folder: nothing built or saved; both results null; the text kept for Export',
    nothing && fin.done && rec.result.folder === null && rec.result.drive === null && rec.text === w.page.text, JSON.stringify(rec.result));

  // S22: a routine PATCH dropped, Drive commits it late: the final reads the size after settleMs and PATCHes again.
  w = world(src); rec = await w.live();
  await w.advance(10000);
  w.text('1,94,routine-dropped-and-committed-late-with-a-longer-row');
  w.drive.plan.push({ kind: 'patch', act: 'dropLate' });
  await w.advance(60000);
  tf = w.text('1,95');
  fin = track(w.R.stop()); await flush();
  const noReadYet = w.reqs('size').length === 0 && w.drive.files.f1.content === tf;
  w.drive.late.shift()();
  await w.advance(4999);
  const stillWaiting = w.reqs('size').length === 0;
  await w.advance(1);
  const k22 = w.reqs().slice(2).map((r) => r.kind).join();
  row('S22 a dropped routine PATCH committed late: size read after settleMs, one more PATCH, saved on a match',
    noReadYet && stillWaiting && fin.done && k22 === 'patch,size,patch,size' && w.drive.files.f1.content === tf && rec.result.drive === 'saved', k22);
  // Dropped and never committed: one read, it matches, saved.
  w = world(src); rec = await w.live();
  await w.advance(10000);
  w.drive.plan.push({ kind: 'patch', act: 'drop' });
  await w.advance(60000);
  w.text('1,96');
  fin = track(w.R.stop());
  await w.advance(5000);
  row('S22 a dropped routine PATCH not committed: one size read matches; saved',
    fin.done && w.reqs().slice(2).map((r) => r.kind).join() === 'patch,size' && rec.result.drive === 'saved', w.reqs().map((r) => r.kind).join());
  // The size read answered 500: failed.
  w = world(src); rec = await w.live();
  await w.advance(10000);
  w.drive.plan.push({ kind: 'patch', act: 'drop' }, { kind: 'size', act: 500 });
  await w.advance(60000);
  fin = track(w.R.stop());
  await w.advance(5000);
  row('S22 a size read answered 500: result.drive failed', fin.done && rec.result.drive === 'failed', JSON.stringify(rec.result));
  // The size read with no status: failed.
  w = world(src); rec = await w.live();
  await w.advance(10000);
  w.drive.plan.push({ kind: 'patch', act: 'drop' }, { kind: 'size', act: 'drop' });
  await w.advance(60000);
  fin = track(w.R.stop());
  await w.advance(5000);
  row('S22 a size read with no status: result.drive failed', fin.done && rec.result.drive === 'failed', JSON.stringify(rec.result));
  // A size read answered 401: one refresh, one more read.
  w = world(src); rec = await w.live();
  await w.advance(10000);
  w.drive.plan.push({ kind: 'patch', act: 'drop' }, { kind: 'size', act: 401 });
  await w.advance(60000);
  fin = track(w.R.stop());
  await w.advance(5000);
  row('S22 a size read answered 401: one refresh, read again, saved', fin.done && rec.result.drive === 'saved' && w.drive.refreshes === 1 && w.reqs('size').length === 2,
    JSON.stringify([rec.result, w.drive.refreshes]));
  // A size mismatch whose second read still differs: failed.
  w = world(src); rec = await w.live();
  await w.advance(10000);
  w.text('1,97,a-longer-routine-row-than-the-final-one');
  w.drive.plan.push({ kind: 'patch', act: 'dropLate' });
  await w.advance(60000);
  w.text('1,98');
  fin = track(w.R.stop()); await flush();
  w.drive.late.shift()();
  w.drive.plan.push({ kind: 'patch', act: 'dropLate' });
  await w.advance(5000);
  row('S22 the second PATCH dropped: result.drive failed', fin.done && rec.result.drive === 'failed' && w.reqs('size').length === 1, JSON.stringify([rec.result, w.reqs().map((r) => r.kind)]));
  // The second PATCH lands but the second read still differs: failed.
  w = world(src); rec = await w.live();
  await w.advance(10000);
  w.text('1,97,a-longer-routine-row-than-the-final-one');
  w.drive.plan.push({ kind: 'patch', act: 'dropLate' });
  await w.advance(60000);
  w.text('1,98');
  fin = track(w.R.stop()); await flush();
  w.drive.late.shift()();
  w.drive.plan.push({ kind: 'size', act: 'ok' }, { kind: 'size', act: 'stale' });
  await w.advance(5000);
  row('S22 a second read that still differs: result.drive failed', fin.done && rec.result.drive === 'failed' && w.reqs().slice(2).map((r) => r.kind).join() === 'patch,size,patch,size',
    JSON.stringify([rec.result, w.reqs().map((r) => r.kind)]));
  // Signed out during settleMs: failed.
  w = world(src); rec = await w.live();
  await w.advance(10000);
  w.drive.plan.push({ kind: 'patch', act: 'drop' });
  await w.advance(60000);
  fin = track(w.R.stop()); await flush();
  w.signOut();
  await w.advance(5000);
  row('S22 a sign-out during settleMs: result.drive failed, no read', fin.done && rec.result.drive === 'failed' && w.reqs('size').length === 0, JSON.stringify(rec.result));
  // No dropped PATCH: the final reads nothing back.
  w = world(src); rec = await w.live();
  await w.advance(70000);
  fin = track(w.R.stop()); await flush();
  row('S22 with no dropped PATCH the final saves without a size read', fin.done && rec.result.drive === 'saved' && w.reqs('size').length === 0, JSON.stringify(rec.result));

  // S23: a sign-out while the final waits behind a routine upload: failed (or unwritten); final settles.
  w = world(src); rec = await w.live();
  await w.advance(10000);
  w.drive.plan.push({ kind: 'patch', act: 'hang' });
  await w.advance(60000);
  fin = track(w.R.stop()); await flush();
  w.signOut();
  w.drive.hung.shift().commit(); await flush();
  const r23a = rec.result.drive;
  w = world(src); rec = await w.live();
  w.drive.plan.push({ kind: 'create', act: 'hang' });
  await w.advance(10000);
  const fin23 = track(w.R.stop()); await flush();
  w.signOut();
  w.drive.hung.shift().status(500); await flush();
  row('S23 a sign-out while the final waits: failed after a write, unwritten before one; final settles',
    fin.done && r23a === 'failed' && fin23.done && rec.result.drive === 'unwritten' && w.reqs().length === 1, JSON.stringify([r23a, rec.result.drive]));

  // S24: a takeover stop with Drive failing: failed, the final settles, the status names the failure.
  w = world(src); rec = await w.live();
  await w.advance(10000);
  w.drive.plan.push({ kind: 'patch', act: 500 }, { kind: 'patch', act: 500 });
  fin = track(w.R.stop()); await flush();
  row('S24 a stop with Drive failing: result.drive failed after one retry; the status shows the failure',
    fin.done && rec.result.drive === 'failed' && w.reqs('patch').length === 2 && /^drive error/.test(w.status() || ''), JSON.stringify([rec.result, w.statuses]));

  // S27: a folder write hung at Stop with Drive on: Drive's final runs and settles; result.folder stays pending.
  w = world(src); dir = mkDir('X'); rec = await w.live(dir); h = dir.handles[0];
  await w.advance(10000);
  h.modes.push('hang');
  await w.advance(10000);
  tf = w.text('1,99');
  fin = track(w.R.stop());
  await w.advance(60000);
  row('S27 a hung folder write at Stop: Drive saves, folder stays pending, final unsettled',
    rec.result.drive === 'saved' && w.drive.files.f1.content === tf && rec.result.folder === 'pending' && !fin.done, JSON.stringify(rec.result));

  // S28: two quick picks, the first resolving last: the session saves to the second; the first never written.
  w = world(src); const dX = mkDir('X'), d28a = mkDir('A', { creates: ['hang'] }), d28b = mkDir('B', { creates: ['hang'] });
  rec = await w.live(dX);
  await w.advance(10000);
  w.R.folderChanged(d28a); w.R.folderChanged(d28b);
  d28b.hungCreates.shift().ok(); await flush();
  const hA28 = d28a.hungCreates[0].handle;
  d28a.hungCreates.shift().ok(); await flush();
  await w.advance(10000);
  tf = w.text('1,100');
  fin = track(w.R.stop()); await flush();
  const hB28 = d28b.handles[0];
  row('S28 two quick picks, the first resolving last: saves to the second; the first never written',
    rec.file === hB28 && rec.folderName === 'B' && hA28.writes.length === 0 && hB28.content === tf && dX.handles[0].writes.length === 1
    && rec.result.folder === 'saved', JSON.stringify([rec.folderName, hA28.writes.length]));

  // S28b: at two strikes, the third write in flight, the user picks B; the old write then fails, or hangs.
  for (const end of ['fail', 'hang']) {
    w = world(src); const d28x = mkDir('X'), d28y = mkDir('B');
    rec = await w.live(d28x); h = d28x.handles[0];
    h.modes.push('fail', 'fail', 'hang');
    await w.advance(30000);
    const twoStrikes = rec.strikes === 2 && h.hung.length === 1;
    w.R.folderChanged(d28y); await flush();
    const hB = d28y.handles[0];
    if (end === 'fail') h.hung.shift().fail();
    await flush();
    const n = w.statuses.length;
    await w.advance(10000);
    tf = w.text('1,101');
    fin = track(w.R.stop()); await flush();
    row('S28b the old write ' + (end === 'fail' ? 'fails' : 'hangs') + ' after a pick: B keeps its handle, gets routine writes and the final; saved',
      twoStrikes && rec.strikes === 0 && hB.landed.length === 2 && hB.content === tf && fin.done && rec.result.folder === 'saved'
      && !w.statuses.includes('write error (3/3)') && w.statuses[n - 1] === 'writing', JSON.stringify([rec.strikes, hB.landed.length, rec.result, w.statuses]));
  }

  // S29: a folder picked while idle, then Start: saves to it from the first tick.
  w = world(src); dir = mkDir('X');
  w.R.folderChanged(dir);
  const noop29 = w.R.current() === null && w.R.stop() === null;
  rec = await w.live(dir);
  await w.advance(10000);
  row('S29 a folder picked while idle, then Start: written on the first tick', noop29 && dir.handles[0].landed.length === 1, String(dir.handles.length));

  // S30: Stop while the newest pick's createFile is pending: the final waits, then writes the new file.
  w = world(src); const d30x = mkDir('X'), d30b = mkDir('B', { creates: ['hang'] });
  rec = await w.live(d30x);
  await w.advance(10000);
  w.R.folderChanged(d30b);
  tf = w.text('1,102');
  fin = track(w.R.stop());
  await w.advance(60000);
  const mid30 = rec.result.folder === 'pending' && !fin.done;
  d30b.hungCreates.shift().ok(); await flush();
  row('S30 Stop while the newest pick\'s file is being made: the final waits, then writes it; saved',
    mid30 && fin.done && rec.result.folder === 'saved' && d30b.handles[0].content === tf && d30x.handles[0].writes.length === 1, JSON.stringify(rec.result));

  // S31: A hung, Start, a takeover stops B with Drive failing, then A saves.
  w = world(src);
  const A31 = await w.live();
  await w.advance(10000);
  w.drive.plan.push({ kind: 'patch', act: 'hang' });
  const finA = track(w.R.stop()); await flush();
  w.page.id = 2; w.text('2,93');
  const B31 = await w.live(null, 2);
  await w.advance(10000);
  w.drive.plan.push({ kind: 'patch', act: 500 }, { kind: 'patch', act: 500 });
  const finB = track(w.R.stop()); await flush();
  const bFailed = B31.result.drive === 'failed';
  const n31 = w.statuses.length;
  w.drive.hung.shift().commit(); await flush();
  row('S31 B fails while A hangs, then A saves: B stays failed, A saved, A sets no status',
    finB.done && bFailed && B31.result.drive === 'failed' && finA.done && A31.result.drive === 'saved' && w.statuses.length === n31,
    JSON.stringify([A31.result, B31.result, w.statuses.slice(n31)]));

  // S32 (recorder half): the web file name is UTC to the second; the same second twice takes the next one.
  w = world(src);
  const A32 = await w.live();
  const B32 = w.R.start(2, w.t, null);
  row('S32 the file name is the web UTC format; a repeat of the previous name moves on a second',
    A32.filename === 'hrv_session_2026-10-27T12-00-00.csv' && B32.filename === 'hrv_session_2026-10-27T12-00-01.csv', A32.filename + ' ' + B32.filename);
  return out;
};

// ---------------------------------------------------------------- rules without a scenario of their own
CHECKS.R = async (src) => {
  const out = [];
  const row = (label, ok, detail) => out.push([label, !!ok, detail]);
  let w, rec, fin, dir, h;

  // Rule 2 and 3: the old Recording's tick does nothing once stopped; stop() hands back the same final.
  w = world(src); dir = mkDir('X'); rec = await w.live(dir);
  await w.advance(10000);
  const oldTick = w.lastInterval;
  const s1 = w.R.stop(); const f1 = s1.final; const s2 = w.R.stop();
  await flush();
  // Past the Drive pace, so only the state guard can stop a build.
  await w.advance(120000);
  const b = w.builds, n = w.reqs().length, writes = dir.handles[0].writes.length;
  await oldTick(); await flush();
  row('R3 a stopped Recording\'s tick builds and writes nothing; stop() gives the same final twice',
    s1 === s2 && s2.final === f1 && w.builds === b && w.reqs().length === n && dir.handles[0].writes.length === writes && w.intervals() === 0, String(w.builds - b));

  // Rule 3: re-checked after every await: a routine upload whose header lands after Stop sends nothing.
  w = world(src); rec = await w.live();
  w.drive.headerPlan.push('hang');
  await w.advance(10000);
  fin = track(w.R.stop()); await flush();
  w.drive.hungHeaders.shift()(); await flush();
  row('R3 a routine upload whose auth lands after Stop sends nothing; the final sends once',
    fin.done && w.reqs().length === 1 && rec.result.drive === 'saved', JSON.stringify(w.reqs().map((r) => r.kind)));

  // Rule 3: Drive saves while arming; the folder only once live.
  w = world(src); dir = mkDir('X', { perm: 'hang' });
  rec = w.R.start(1, w.t, dir); await flush();
  await w.advance(10000);
  row('R3 a tick while arming uploads to Drive', rec.state === 'arming' && w.reqs('create').length === 1, String(w.reqs().length));

  // Rule 4: a routine save skips while one is in flight on its target.
  w = world(src); dir = mkDir('X'); rec = await w.live(dir); h = dir.handles[0];
  h.modes.push('hang');
  w.drive.plan.push({ kind: 'create', act: 'hang' });
  await w.advance(120000);
  // A forced save skips too.
  w.page.rows++; w.R.hidden(); await flush();
  row('R4 one folder write and one upload at a time: ticks and forced saves skip while one is in flight',
    h.writes.length === 1 && w.reqs().length === 1 && h.maxInflight === 1 && w.drive.maxInflight === 1, JSON.stringify([h.writes.length, w.reqs().length]));

  // Rule 1: an old final that waited behind its routine upload still writes only its own Drive file.
  w = world(src);
  const A1 = await w.live();
  w.drive.plan.push({ kind: 'create', act: 'hang' });
  await w.advance(10000);
  const ta1 = w.text('1,7');
  const finA1 = track(w.R.stop()); await flush();
  w.page.id = 2; w.text('2,7');
  const B1 = await w.live(null, 2);
  w.drive.hung.shift().commit(); await flush();
  row('R1 an old final that waited until after a new Start writes only its own Drive file',
    finA1.done && A1.result.drive === 'saved' && w.drive.files[A1.driveFileId].content === ta1 && B1.driveFileId === null && w.reqs().length === 2,
    JSON.stringify([A1.driveFileId, B1.driveFileId, w.reqs().map((r) => [r.kind, r.id])]));

  // Rule 5: the final looks the Drive folder up when unknown, and a failed lookup with a known id does not block.
  w = world(src); w.drive.folderId = null; w.drive.lookupMode = 'fail';
  rec = await w.live();
  w.drive.lookupMode = 'ok';
  const l = w.drive.lookups;
  fin = track(w.R.stop()); await flush();
  const r5a = fin.done && w.drive.lookups === l + 1 && rec.result.drive === 'saved' && w.reqs('create').length === 1;
  w = world(src); w.drive.lookupMode = 'fail';
  rec = await w.live();
  fin = track(w.R.stop()); await flush();
  row('R5 the final looks the folder up only when unknown; a known folder id uploads regardless',
    r5a && fin.done && w.drive.lookups === 0 && rec.result.drive === 'saved', JSON.stringify([r5a, w.drive.lookups]));
  // Rule 5: the final with the folder lookup still failing: nothing to write to; unwritten.
  w = world(src); w.drive.folderId = null; w.drive.lookupMode = 'fail';
  rec = await w.live();
  fin = track(w.R.stop()); await flush();
  row('R5 the final with no Drive folder found: unwritten, settles', fin.done && rec.result.drive === 'unwritten' && w.reqs().length === 0, JSON.stringify(rec.result));
  // Rule 5: a known Drive file needs no folder id, for routine PATCHes and the final alike.
  w = world(src); rec = await w.live();
  await w.advance(10000);
  w.drive.folderId = null; w.drive.lookupMode = 'fail';
  await w.advance(60000);
  const r5k = w.reqs().map((r) => r.kind).join() === 'create,patch';
  fin = track(w.R.stop()); await flush();
  row('R5 a known Drive file with the folder id gone: routine ticks and the final still PATCH it; saved',
    r5k && fin.done && rec.result.drive === 'saved' && w.reqs().map((r) => r.kind).join() === 'create,patch,patch' && w.reqs('patch').every((r) => r.id === 'f1'),
    JSON.stringify([rec.result, w.reqs().map((r) => r.kind)]));
  // Round 2: a final that must create with no folder id looks it up once (an account switch while it waited; a 404).
  w = world(src); rec = await w.live();
  await w.advance(10000); w.text('1,81'); w.drive.plan.push({ kind: 'patch', act: 'hang' });
  await w.advance(60000); w.text('1,82');
  fin = track(w.R.stop()); await flush();
  w.signIn('B'); w.drive.folderId = null; w.R.authChanged();
  w.drive.hung.shift().commit(); await w.advance(10000);
  const sw = w.reqs().map((r) => r.kind + ':' + r.owner).join();
  row('R5 an account switch while the final waits, folder id not yet known: one lookup, then created under B; saved',
    fin.done && rec.result.drive === 'saved' && w.drive.lookups >= 1 && sw === 'create:A,patch:A,create:B', JSON.stringify([rec.result, sw]));
  w = world(src); rec = await w.live();
  await w.advance(10000);
  w.drive.folderId = null; w.drive.plan.push({ kind: 'patch', act: 404 });
  w.text('1,85'); fin = track(w.R.stop()); await w.advance(10000);
  row('R5 a final PATCH answered 404 with no folder id: looked up, created again; saved',
    fin.done && rec.result.drive === 'saved' && w.reqs().map((r) => r.kind + ':' + r.status).join() === 'create:200,patch:404,create:200', JSON.stringify(w.reqs().map((r) => r.kind + ':' + r.status)));
  // Rule 13: signed in, sync on, the folder never found: the final's failure shows, not idle.
  w = world(src); w.drive.folderId = null; w.drive.lookupMode = 'fail';
  rec = await w.live();
  await w.advance(10000); w.text('1,86');
  fin = track(w.R.stop()); await w.advance(10000);
  row('R13 no Drive folder ever found: the Drive result is not saved and the status shows the failure',
    fin.done && rec.result.drive === 'unwritten' && /^drive error/.test(w.status()), JSON.stringify([rec.result, w.status()]));

  // Rule 6: the lookup runs at Start only when the folder id is null.
  w = world(src); rec = await w.live();
  await w.advance(130000);
  row('R6 no lookup while the folder id is known', w.drive.lookups === 0, String(w.drive.lookups));
  w = world(src); w.drive.folderId = null; w.drive.lookupMode = 'fail';
  rec = await w.live();
  await w.advance(185000);
  row('R6 an unknown folder is looked up at Start and once a minute after', w.drive.lookups === 4, String(w.drive.lookups));

  // Rule 8: a PATCH answered 403 clears the id once and creates.
  w = world(src); rec = await w.live();
  await w.advance(10000);
  w.drive.plan.push({ kind: 'patch', act: 403 });
  await w.advance(60000);
  await w.advance(60000);
  let k8 = w.reqs().map((r) => r.kind + ':' + (r.id || '')).join();
  const r8a = k8 === 'create:,patch:f1,create:,patch:f2' && rec.driveFileId === 'f2';
  // The create after a 403 answered 403 too: no second clear in that run.
  w = world(src); rec = await w.live();
  await w.advance(10000);
  w.drive.plan.push({ kind: 'patch', act: 403 }, { kind: 'create', act: 403 });
  await w.advance(60000);
  k8 = w.reqs().map((r) => r.kind + ':' + (r.id || '') + ':' + r.status).join();
  row('R8 a 403 PATCH clears the file id once and creates, then PATCHes the new file; one recreate a run',
    r8a && k8 === 'create::200,patch:f1:403,create::403' && /HTTP 403/.test(w.status()), k8);
  // Rule 8: the login is read after the last await: a switch while the auth header is fetched is seen.
  w = world(src); rec = await w.live();
  await w.advance(10000);
  w.drive.headerPlan.push('hang');
  await w.advance(60000);
  w.signIn('B');
  w.drive.hungHeaders.shift()(); await flush();
  row('R8 a switch while the auth header is fetched: no request into the old file; a new file under the new login',
    w.reqs().slice(1).every((r) => r.id !== 'f1') && w.reqs('create').length === 2 && w.drive.files[rec.driveFileId].owner === 'B',
    JSON.stringify(w.reqs().map((r) => [r.kind, r.id, r.owner])));
  // Rule 8: a null tag with a token (login record not read yet) is not a change.
  w = world(src); rec = await w.live();
  await w.advance(10000);
  w.drive.tag = null;
  await w.advance(60000);
  w.drive.tag = 'email:A';
  await w.advance(60000);
  row('R8 a null login tag is never a change: the same file throughout', w.reqs('create').length === 1 && w.reqs('patch').length === 2 && w.reqs('patch').every((r) => r.id === 'f1'),
    JSON.stringify(w.reqs().map((r) => [r.kind, r.id])));

  // Rule 9: a 401 refreshes once and retries once.
  w = world(src); rec = await w.live();
  w.drive.plan.push({ kind: 'create', act: 401 });
  await w.advance(10000);
  const r9a = w.drive.refreshes === 1 && w.reqs().length === 2 && rec.driveFileId === 'f1' && w.status() === 'synced';
  w = world(src); rec = await w.live();
  w.drive.plan.push({ kind: 'create', act: 401 }, { kind: 'create', act: 401 });
  await w.advance(10000);
  row('R9 a 401 refreshes once and retries once, and gives up after the second',
    r9a && w.drive.refreshes === 1 && w.reqs().length === 2 && w.status() === 'drive error: Drive create HTTP 401', JSON.stringify([r9a, w.statuses]));
  // Rule 9: a routine 5xx waits for the next pace from the attempt.
  w = world(src); rec = await w.live();
  await w.advance(10000);
  w.drive.plan.push({ kind: 'patch', act: 503 });
  await w.advance(60000);
  const at5 = w.reqs()[1].t;
  await w.advance(50000);
  const none = w.reqs().length === 2;
  await w.advance(10000);
  row('R9 a routine 5xx is not retried until the next pace from the attempt',
    none && w.reqs().length === 3 && w.reqs()[2].t - at5 === 60000, JSON.stringify(w.reqs().map((r) => (r.t - T0) / 1000)));
  // Rule 9: the final retries a 5xx once.
  w = world(src); rec = await w.live();
  await w.advance(10000);
  w.drive.plan.push({ kind: 'patch', act: 502 });
  fin = track(w.R.stop()); await flush();
  row('R9 the final retries a 5xx once and saves', fin.done && rec.result.drive === 'saved' && w.reqs('patch').length === 2, JSON.stringify(rec.result));
  // Rule 9: the final retries a dropped request once.
  w = world(src); rec = await w.live();
  await w.advance(10000);
  w.drive.plan.push({ kind: 'patch', act: 'drop' }, { kind: 'patch', act: 'drop' });
  fin = track(w.R.stop()); await flush();
  row('R9 the final retries a dropped request once, then fails', fin.done && rec.result.drive === 'failed' && w.reqs('patch').length === 2, JSON.stringify(rec.result));

  // Rule 10: three folder failures in a row drop the file with write error (3/3); Drive continues.
  w = world(src); dir = mkDir('X'); rec = await w.live(dir); h = dir.handles[0];
  h.modes.push('fail', 'fail', 'fail');
  await w.advance(30000);
  const dropped = rec.file === null && w.status() === 'write error (3/3)';
  await w.advance(60000);
  row('R10 three folder failures drop the file with write error (3/3); Drive goes on',
    dropped && h.writes.length === 3 && w.reqs('patch').length >= 1 && !w.R.targets().folder && w.R.targets().drive, JSON.stringify([w.statuses, h.writes.length]));
  // Rule 10: strikes count in a row; a success clears them.
  w = world(src); dir = mkDir('X'); rec = await w.live(dir); h = dir.handles[0];
  h.modes.push('fail', 'fail', 'ok', 'fail', 'fail');
  await w.advance(50000);
  row('R10 a success between failures resets the count', rec.file === h && rec.strikes === 2 && w.statuses.includes('write error (2/3)') && w.statuses.includes('writing')
    && !w.statuses.includes('write error (3/3)'), JSON.stringify(w.statuses));
  // Rule 10 with 14: a dropped file at Stop: failed (it wrote before), no final write.
  w = world(src); dir = mkDir('X'); rec = await w.live(dir); h = dir.handles[0];
  h.modes.push('ok', 'fail', 'fail', 'fail');
  await w.advance(40000);
  fin = track(w.R.stop()); await flush();
  row('R14 a folder dropped after three strikes: result.folder failed, no final write', fin.done && rec.result.folder === 'failed' && h.writes.length === 4, JSON.stringify(rec.result));

  // Rule 11: below SAVE_BIG the folder is written every tick.
  w = world(src); w.signOut(); dir = mkDir('X'); rec = await w.live(dir);
  await w.advance(60000);
  const every = dir.handles[0].writes.length;
  // Above SAVE_BIG: at most one rebuild a minute.
  w = world(src); w.signOut(); dir = mkDir('X'); rec = await w.live(dir);
  w.page.text = 'x'.repeat(600 * 1024);
  await w.advance(180000);
  row('R11 the folder every tick below SAVE_BIG (6 a minute), one rebuild a minute above it',
    every === 6 && dir.handles[0].writes.length === 3 && w.builds === 3, JSON.stringify([every, dir.handles[0].writes.length, w.builds]));
  // Rule 11: Drive pace = clamp(MB x 60 s, 60 s, 10 min).
  const paceGap = async (bytes, span) => {
    const v = world(src); await v.live();
    v.page.text = 'x'.repeat(bytes);
    await v.advance(span);
    const ts = v.reqs().map((r) => r.t);
    return ts.slice(2).map((x, i) => (x - ts[i + 1]) / 1000);
  };
  const g1 = await paceGap(1000, 250000), g3 = await paceGap(3 * MB, 600000), g12 = await paceGap(12 * MB, 1900000);
  row('R11 Drive pace: 60 s small, 3 min at 3 MB, capped at 10 min at 12 MB',
    g1.length >= 2 && g1.every((x) => x === 60) && g3.length >= 1 && g3.every((x) => x === 180) && g12.length >= 1 && g12.every((x) => x === 600),
    JSON.stringify([g1, g3, g12]));

  // Rule 12: hidden only in live, only when rows grew, at most once per 10 s below SAVE_BIG.
  w = world(src); dir = mkDir('X', { perm: 'hang' }); rec = w.R.start(1, w.t, dir); await flush();
  w.page.rows++; w.R.hidden(); w.R.closing();
  const armQuiet = w.builds === 0;
  dir.hungPerm.resolve(true); await flush();
  h = dir.handles[0];
  w.signOut();
  // Live at T0: rows grew since the last build (none), so a forced write.
  w.R.hidden(); await flush();
  const c = [h.writes.length];
  await w.advance(10000);
  // The tick at 10 s built; no new rows since: nothing.
  w.R.hidden(); await flush(); c.push(h.writes.length);
  w.page.rows++; w.R.hidden(); await flush(); c.push(h.writes.length);
  await w.advance(5000);
  w.page.rows++; w.R.hidden(); await flush(); c.push(h.writes.length);
  await w.advance(4000);
  w.page.rows++; w.R.hidden(); await flush(); c.push(h.writes.length);
  // 20 s: the tick writes, then a forced write 10 s after the last forced one is allowed.
  await w.advance(1000);
  w.page.rows++; w.R.hidden(); await flush(); c.push(h.writes.length);
  row('R12 hidden or closing: nothing while arming or with no new rows; a forced write at most every 10 s',
    armQuiet && c.join() === '1,2,3,3,3,5', JSON.stringify([armQuiet, c]));
  // Rule 18 with 12: a close 2 s after a hidden write still writes the mark pagehide just flushed.
  w = world(src); dir = mkDir('X'); rec = await w.live(dir); h = dir.handles[0];
  await w.advance(10000);
  w.page.rows++; w.R.hidden(); await flush();
  const hw = h.writes.length;
  await w.advance(2000);
  w.page.rows++; w.R.closing(); await flush();
  row('R12 a close right after a hidden write still writes (a mark flushed at close reaches the file)', h.writes.length === hw + 1, JSON.stringify([hw, h.writes.length]));
  // Design pass 2026-10-28: the page commits held marks before hidden(), so the hidden write carries them; a close
  // while that write is in flight writes nothing beside it.
  for (const mode of ['ok', 'hang']) {
    w = world(src); dir = mkDir('X'); rec = await w.live(dir); h = dir.handles[0];
    await w.advance(10000);
    h.modes.push(mode);
    w.t += 3000; w.text('2,90\nMARK'); w.R.hidden();
    const n = h.writes.length;
    w.page.rows++; w.R.closing();
    const overlapFree = h.maxInflight === 1 && h.writes.length === n;
    if (mode === 'hang') { await flush(); h.hung.shift().ok(); }
    await w.advance(1000);
    row('R12 hidden write ' + (mode === 'ok' ? 'landing' : 'hung') + ' at pagehide: it carries the mark; the close writes nothing beside it',
      overlapFree && /MARK/.test(h.content), JSON.stringify({ writes: h.writes.length, content: h.content, max: h.maxInflight }));
  }
  // Rule 21 (rounds 4, 5): something the user entered reaches the folder at hide and close, whenever it was committed.
  const mark = (v, t) => { v.page.text = 'time,hr\n' + t + '\n'; v.page.rows++; v.R.entered(); };
  // Round 5: above SAVE_BIG, a mark the Undo timer committed 15 s after a rebuild, then the tab closes: written.
  w = world(src); dir = mkDir('X'); rec = await w.live(dir); h = dir.handles[0];
  w.page.text = 'x'.repeat(600 * 1024); w.page.rows++;
  await w.advance(10000);
  await w.advance(15000);
  mark(w, 'x'.repeat(600 * 1024) + '\nMARK');
  await w.advance(5000);
  const r5 = h.writes.length;
  w.R.hidden(); w.R.closing(); await flush();
  row('R21 a mark committed while visible, then a close inside the rebuild minute: written at close',
    h.writes.length === r5 + 1 && /MARK/.test(h.content), JSON.stringify([r5, h.writes.length]));
  // A mark counts as saved only when a write carrying it lands: the write in flight carrying it fails, then a close
  // inside the rebuild minute still writes it.
  w = world(src); dir = mkDir('X'); rec = await w.live(dir); h = dir.handles[0];
  w.page.text = 'x'.repeat(600 * 1024); w.page.rows++;
  mark(w, 'x'.repeat(600 * 1024) + '\nMARK');
  h.modes.push('hang');
  await w.advance(10000);
  w.page.rows++; w.R.hidden();
  const owedWhileCarried = rec.owed;
  await flush(); h.hung.shift().fail(); await w.advance(500);
  const f21 = h.writes.length;
  w.page.rows++; w.R.closing(); await w.advance(500);
  // Cost: once a write carrying the mark lands, a hide inside the rebuild minute is plain again.
  {
    const v = world(src); const dv = mkDir('X'); await v.live(dv); const hv = dv.handles[0];
    v.page.text = 'x'.repeat(600 * 1024); v.page.rows++;
    mark(v, 'x'.repeat(600 * 1024) + '\nMARK');
    await v.advance(10000);
    const landed = hv.writes.length;
    await v.advance(5000);
    v.page.rows++; v.R.hidden(); await flush();
    row('R21 a mark already saved makes no later hide urgent', landed >= 1 && hv.writes.length === landed, JSON.stringify([landed, hv.writes.length]));
  }
  row('R21 a mark whose write failed is not counted saved: written at hide or close inside the rebuild minute',
    owedWhileCarried && h.writes.length >= f21 && /MARK/.test(h.content), JSON.stringify({ owedWhileCarried, f21, n: h.writes.length, last: h.content.slice(-6) }));
  // a) The tick's write is in flight at hidden: one owed write after it, fresh text, never beside it.
  w = world(src); dir = mkDir('X'); rec = await w.live(dir); h = dir.handles[0];
  h.modes.push('hang');
  await w.advance(10000);
  mark(w, '2,90\nMARK'); w.R.hidden(); w.R.closing();
  const a21 = h.writes.length;
  await flush(); h.hung.shift().ok(); await w.advance(500);
  row('R21 a write in flight when a mark is committed: one more write after it, with the mark, never beside it',
    h.writes.length === a21 + 1 && /MARK/.test(h.content) && h.maxInflight === 1 && !rec.owed, JSON.stringify({ n: h.writes.length, a21, c: h.content, max: h.maxInflight }));
  // b) Above SAVE_BIG, a rebuild 5 s ago: an urgent save skips the minute; a plain hidden one does not.
  w = world(src); dir = mkDir('X'); rec = await w.live(dir); h = dir.handles[0];
  w.page.text = 'x'.repeat(600 * 1024); w.page.rows++;
  await w.advance(10000);
  await w.advance(5000);
  const b0 = h.writes.length;
  w.page.rows++; w.R.hidden(); await flush();
  const plain = h.writes.length;
  mark(w, 'x'.repeat(600 * 1024) + '\nMARK'); w.R.hidden(); await flush();
  row('R21 above SAVE_BIG an urgent save skips the minute; a plain one waits',
    plain === b0 && h.writes.length === b0 + 1 && /MARK/.test(h.writes[h.writes.length - 1]), JSON.stringify([b0, plain, h.writes.length]));
  // c) The write in flight is the third strike: the owed write never goes to the dropped handle.
  w = world(src); dir = mkDir('X'); rec = await w.live(dir); h = dir.handles[0];
  h.modes.push('fail', 'fail', 'hang');
  await w.advance(30000);
  mark(w, '2,90\nMARK'); w.R.hidden();
  const c21 = h.writes.length;
  await flush(); h.hung.shift().fail(); await w.advance(500);
  row('R21 the write in flight strikes out: nothing owed is written to the dropped handle',
    rec.file === null && h.writes.length === c21 && h.maxInflight === 1, JSON.stringify({ file: !!rec.file, n: h.writes.length, c21 }));
  // d) A pick while the owed write waits: it goes to the new file with fresh text, never to the old one.
  w = world(src); dir = mkDir('A'); rec = await w.live(dir); h = dir.handles[0];
  h.modes.push('hang');
  await w.advance(10000);
  mark(w, '2,90\nMARK'); w.R.hidden();
  // B's file is still being made when A's write settles, so only B's arrival can pay what is owed.
  const d21 = mkDir('B', { creates: ['hang'] }); w.R.folderChanged(d21); await flush();
  const old21 = h.writes.length;
  h.hung.shift().ok(); await flush();
  d21.hungCreates.shift().ok(); await w.advance(500);
  const hb = d21.handles[0];
  row('R21 a pick while owed: the new file gets the mark once it exists; the old handle gets nothing more',
    h.writes.length === old21 && !!hb && hb.writes.length === 1 && /MARK/.test(hb.content) && !rec.owed, JSON.stringify({ old: h.writes.length, old21, b: hb && hb.writes }));
  // e) Stop while owed: nothing owed is written after Stop; the final carries the mark.
  w = world(src); dir = mkDir('X'); rec = await w.live(dir); h = dir.handles[0];
  h.modes.push('hang');
  await w.advance(10000);
  mark(w, '2,90\nMARK'); w.R.hidden();
  fin = track(w.R.stop());
  await flush(); h.hung.shift().ok(); await w.advance(500);
  row('R21 Stop while owed: only the final writes after it, with the mark',
    fin.done && rec.result.folder === 'saved' && /MARK/.test(h.content) && h.writes.length === 2 && h.maxInflight === 1, JSON.stringify({ n: h.writes.length, r: rec.result }));

  // Rule 12: a forced save goes to Drive only when its pace allows.
  w = world(src); rec = await w.live();
  await w.advance(5000);
  w.page.rows++; w.R.hidden(); await flush();
  await w.advance(25000);
  w.page.rows++; w.R.hidden(); await flush();
  const noDrive = w.reqs().length === 1;
  await w.advance(35000);
  w.page.rows++; w.R.hidden(); await flush();
  row('R12 a forced save reaches Drive only once its pace allows', noDrive && w.reqs().map((r) => (r.t - T0) / 1000).join() === '5,65', JSON.stringify(w.reqs().map((r) => (r.t - T0) / 1000)));
  // Rule 12 while stopping: nothing.
  w = world(src); dir = mkDir('X'); rec = await w.live(dir); h = dir.handles[0];
  h.modes.push('hang');
  await w.advance(10000);
  w.R.stop();
  const nb = w.builds;
  w.page.rows++; w.R.hidden(); w.R.closing(); await flush();
  row('R12 hidden while stopping does nothing', w.builds === nb && h.writes.length === 1, String(w.builds - nb));

  // Rule 13: an old Recording sets no status once another is current; Stop shows saving, then idle.
  w = world(src); const dA = mkDir('A'), dB = mkDir('B');
  const A13 = await w.live(dA); h = dA.handles[0];
  h.modes.push('hang', 'fail');
  await w.advance(10000);
  const statusesAtStop = w.statuses.length;
  w.R.stop();
  const saving = w.status() === 'saving';
  w.page.id = 2; w.text('2,1');
  await w.live(dB, 2);
  const nB = w.statuses.length;
  h.hung.shift().fail(); await flush();
  await flush();
  row('R13 the old Recording\'s late failure sets no status once another is current',
    saving && statusesAtStop > 0 && w.statuses.length === nB && A13.state === 'done' && A13.result.folder === 'unwritten', JSON.stringify([w.statuses.slice(nB), A13.result]));
  // A folder final that fails while Drive's is still pending: saving until both settle, then the failure.
  w = world(src); dir = mkDir('X'); rec = await w.live(dir); h = dir.handles[0];
  await w.advance(10000);
  h.modes.push('fail');
  w.drive.plan.push({ kind: 'patch', act: 'hang' });
  fin = track(w.R.stop()); await flush();
  const holds = rec.result.folder === 'failed' && w.status() === 'saving' && !fin.done;
  w.drive.hung.shift().commit(); await flush();
  row('R13 a failed folder final with Drive pending: saving until both settle, then the failure',
    holds && fin.done && w.status() === 'write error (1/3)', JSON.stringify(w.statuses));
  w = world(src); dir = mkDir('X'); rec = await w.live(dir);
  await w.advance(10000);
  fin = track(w.R.stop()); await flush();
  row('R13 after Stop: saving while pending, then idle', fin.done && w.statuses.slice(-2).join() === 'saving,idle', JSON.stringify(w.statuses));
  w = world(src); rec = await w.live();
  await w.advance(10000);
  fin = track(w.R.stop()); await flush();
  row('R13 a Drive-only Stop: saving, then idle', fin.done && w.statuses.slice(-2).join() === 'saving,idle', JSON.stringify(w.statuses));
  // Rule 13: a folder final that fails leaves the failure on screen.
  w = world(src); w.signOut(); dir = mkDir('X'); rec = await w.live(dir); h = dir.handles[0];
  await w.advance(10000);
  h.modes.push('fail');
  fin = track(w.R.stop()); await flush();
  row('R13 a failed folder final leaves its failure, not idle', fin.done && rec.result.folder === 'failed' && w.status() === 'write error (1/3)', JSON.stringify(w.statuses));
  // Rule 13: nothing pending at Stop shows no saving.
  w = world(src); w.signOut();
  await w.live();
  w.R.stop(); await flush();
  row('R13 a Stop with no target shows no saving', !w.statuses.includes('saving'), JSON.stringify(w.statuses));
  // Rule 13: routine outcomes that land after Stop leave "saving" alone.
  w = world(src); dir = mkDir('X'); rec = await w.live(dir); h = dir.handles[0];
  await w.advance(60000);
  h.modes.push('hang');
  w.drive.plan.push({ kind: 'patch', act: 'hang' });
  await w.advance(10000);
  const r13n = w.statuses.length, r13hung = h.hung.length === 1 && w.drive.hung.length === 1;
  fin = track(w.R.stop()); await flush();
  h.hung.shift().fail(); await flush();
  w.drive.hung.shift().commit(); await flush();
  row('R13 a routine folder failure and a routine Drive success after Stop: only saving, then idle',
    r13hung && fin.done && rec.result.folder === 'saved' && rec.result.drive === 'saved' && w.statuses.slice(r13n).join() === 'saving,idle',
    JSON.stringify([r13hung, rec.result, w.statuses.slice(r13n)]));

  // Rule 14: seen-and-gone targets are never saved; a null final text leaves seen targets unwritten.
  w = world(src); dir = mkDir('X'); rec = await w.live(dir);
  await w.advance(10000);
  w.R.folderChanged(null);
  w.signOut();
  fin = track(w.R.stop()); await flush();
  row('R14 a folder cleared and a sign-out before Stop, both written before: failed, failed',
    fin.done && rec.result.folder === 'failed' && rec.result.drive === 'failed' && dir.handles[0].writes.length === 1, JSON.stringify(rec.result));
  w = world(src); dir = mkDir('X'); rec = await w.live(dir);
  w.R.folderChanged(null);
  w.drive.sync = false;
  fin = track(w.R.stop()); await flush();
  row('R14 a folder cleared and sync off before any write: unwritten, unwritten', fin.done && rec.result.folder === 'unwritten' && rec.result.drive === 'unwritten', JSON.stringify(rec.result));
  w = world(src); dir = mkDir('X'); rec = await w.live(dir);
  await w.advance(10000);
  w.page.id = 2;
  fin = track(w.R.stop()); await flush();
  row('R14 a null final text: seen targets unwritten, nothing written', fin.done && rec.text === null && rec.result.folder === 'unwritten' && rec.result.drive === 'unwritten'
    && dir.handles[0].writes.length === 1 && w.reqs().length === 1, JSON.stringify(rec.result));
  w = world(src); w.signOut(); rec = await w.live();
  w.page.id = 2;
  fin = track(w.R.stop()); await flush();
  row('R14 a null final text with no target seen: both null', fin.done && rec.result.folder === null && rec.result.drive === null, JSON.stringify(rec.result));
  w = world(src); w.signOut(); dir = mkDir('X'); rec = await w.live(dir); h = dir.handles[0];
  h.modes.push('hang');
  await w.advance(10000);
  fin = track(w.R.stop());
  w.signIn('A'); w.R.authChanged();
  h.hung.shift().ok(); await flush();
  row('R14 Drive first seen while stopping: not uploaded, result null', fin.done && rec.result.drive === null && w.reqs().length === 0 && rec.result.folder === 'saved', JSON.stringify(rec.result));
  // Rule 14: a final that waits behind a routine upload and finds sync off: no final write; the result settles.
  w = world(src); rec = await w.live();
  w.drive.plan.push({ kind: 'create', act: 'hang' });
  await w.advance(10000);
  fin = track(w.R.stop()); await flush();
  w.drive.sync = false;
  w.drive.hung.shift().commit(); await flush();
  row('R14 sync turned off during the final\'s wait: failed after a landed write, settles', fin.done && rec.result.drive === 'failed' && w.reqs().length === 1, JSON.stringify(rec.result));
  // Rule 14: a sign-out while the final waits on a hung routine PATCH settles at the next tick, not when the PATCH ends.
  w = world(src); rec = await w.live();
  await w.advance(10000);
  w.drive.plan.push({ kind: 'patch', act: 'hang' });
  await w.advance(60000);
  fin = track(w.R.stop()); await flush();
  const r14hung = rec.driveFileId === 'f1' && w.drive.hung.length === 1 && !fin.done;
  w.signOut();
  await w.advance(10000);
  row('R14 a sign-out during the wait on a hung PATCH: failed within a tick, PATCH still hung',
    r14hung && fin.done && rec.result.drive === 'failed' && w.drive.hung.length === 1 && w.reqs().length === 2,
    JSON.stringify([r14hung, fin.done, rec.result, w.drive.hung.length]));
  // Rule 14: a folder final write that fails after earlier writes: failed; one that never wrote: unwritten.
  w = world(src); w.signOut(); dir = mkDir('X'); rec = await w.live(dir); h = dir.handles[0];
  h.modes.push('fail');
  fin = track(w.R.stop()); await flush();
  row('R14 a folder final that fails with no earlier write: unwritten', fin.done && rec.result.folder === 'unwritten', JSON.stringify(rec.result));

  // Rule 15: a cleared folder drops the file; an old handle's late outcome changes nothing.
  w = world(src); dir = mkDir('X'); rec = await w.live(dir); h = dir.handles[0];
  w.R.folderChanged(null);
  await w.advance(30000);
  row('R15 a folder cleared drops the file: no more writes, targets() has no folder', rec.file === null && h.writes.length === 0 && !w.R.targets().folder, String(h.writes.length));
  w = world(src); const d15x = mkDir('X'), d15b = mkDir('B');
  rec = await w.live(d15x); h = d15x.handles[0];
  h.modes.push('hang');
  await w.advance(10000);
  w.R.folderChanged(d15b); await flush();
  const n15 = w.statuses.length;
  h.hung.shift().ok(); await flush();
  row('R15 an old handle\'s late success does not count as wrote or set status', rec.wrote.folder === false && w.statuses.length === n15 && rec.folderName === 'B', JSON.stringify([rec.wrote, w.statuses.slice(n15)]));
  // Rule 15: a pick starts the count over: the new folder's first failure is 1/3, not the old folder's third.
  w = world(src); const d15m = mkDir('X'), d15n = mkDir('B');
  rec = await w.live(d15m); h = d15m.handles[0];
  h.modes.push('fail', 'fail');
  await w.advance(20000);
  w.R.folderChanged(d15n); await flush();
  d15n.handles[0].modes.push('fail');
  await w.advance(10000);
  row('R15 a pick starts the strike count over', rec.file === d15n.handles[0] && rec.strikes === 1 && w.status() === 'write error (1/3)', JSON.stringify([rec.strikes, w.statuses]));
  // Rule 15: a pick while arming is taken at the end of arming.
  w = world(src); const d15p = mkDir('P', { perm: 'hang' }), d15q = mkDir('Q');
  rec = w.R.start(1, w.t, d15p); await flush();
  w.R.folderChanged(d15q);
  d15p.hungPerm.resolve(true); await flush();
  await w.advance(10000);
  row('R15 a pick while arming is taken at the end of arming; the first folder\'s file is never written',
    rec.state === 'live' && rec.file === d15q.handles[0] && d15q.handles[0].landed.length === 1 && d15p.handles.every((x) => x.writes.length === 0) && rec.folderName === 'Q',
    JSON.stringify([rec.folderName, d15p.handles.length]));
  // Rule 15: a pick while arming means the first folder's createFile is never called.
  w = world(src); const d15c = mkDir('A', { perm: 'hang' }), d15d = mkDir('B');
  rec = w.R.start(1, w.t, d15c); await flush();
  w.R.folderChanged(d15d);
  d15c.hungPerm.resolve(true); await flush();
  await w.advance(10000);
  row('R15 a pick while arming: no createFile on the first folder; the session writes the second',
    d15c.createCalls === 0 && d15d.createCalls === 1 && rec.file === d15d.handles[0] && d15d.handles[0].landed.length === 1,
    JSON.stringify([d15c.createCalls, d15d.createCalls]));
  // Rule 15: picks and clears while stopping are ignored.
  w = world(src); dir = mkDir('X'); const d15s = mkDir('S');
  rec = await w.live(dir);
  w.R.stop();
  w.R.folderChanged(d15s); await flush();
  row('R15 a pick while stopping is ignored', d15s.createCalls === 0 && rec.result.folder === 'saved', JSON.stringify(rec.result));
  // Rule 15: a pick whose createFile fails: no file, status error.
  w = world(src); const d15f = mkDir('F', { creates: ['fail'] });
  rec = await w.live(mkDir('X'));
  w.R.folderChanged(d15f); await flush();
  row('R15 a pick whose file cannot be made: no file, status error', rec.file === null && w.status() === 'error' && rec.folderName === 'F', JSON.stringify(w.statuses));

  // Arming: permission denied or creation failed goes live with no file and says so.
  w = world(src); dir = mkDir('X', { creates: ['fail'] });
  rec = await w.live(dir);
  row('States: a file that cannot be made at Start goes live with no file and status error', rec.state === 'live' && rec.file === null && w.status() === 'error', JSON.stringify(w.statuses));
  return out;
};

// ---------------------------------------------------------------- mutants
const MUTANTS = require('./recorder.mutants.cjs');

function mutate(name, find, replace) {
  if (!SRC.includes(find)) throw new Error('mutation anchor not found (' + name + '): ' + find.slice(0, 80));
  return SRC.replace(find, replace);
}

// Runs the checks in order and stops at the first failing one (mutants only need one).
async function runChecks(src, stopEarly) {
  const rows = [];
  for (const [id, fn] of Object.entries(CHECKS)) {
    let r;
    try { r = await bounded(fn(src)); } catch (e) { r = [[id + ' threw: ' + (e && e.stack || e), false]]; }
    rows.push(...r);
    if (stopEarly && r.some((x) => !x[1])) break;
  }
  return rows;
}

// ---------------------------------------------------------------- main
// A check left waiting on a promise that never settles would let node exit early with code 0: the run starts as a
// failure and only a full pass clears it, and a check that stalls counts as failed.
process.exitCode = 1;
const STALL_MS = 30000;
const bounded = (p) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('check stalled')), STALL_MS).unref())]);
(async () => {
  let bad = 0;
  const rows = await runChecks(SRC, false);
  for (const [label, ok, detail] of rows) {
    console.log((ok ? 'PASS ' : 'FAIL ') + label + (detail && !ok ? '  [' + detail + ']' : ''));
    if (!ok) bad++;
  }
  console.log('\nNegative controls (each must FAIL a check):');
  for (const [name, find, replace] of MUTANTS) {
    let caught = false, note = '';
    try {
      const fails = (await runChecks(mutate(name, find, replace), true)).filter((r) => !r[1]);
      caught = fails.length > 0;
      note = fails.map((r) => r[0]).slice(0, 2).join(' | ');
    } catch (e) {
      note = e.message; caught = false;
    }
    console.log('MUTANT ' + name + ': ' + (caught ? 'FAILED as required' : 'NOT CAUGHT') + (note ? '  (' + note + ')' : ''));
    if (!caught) bad++;
  }
  if (bad) { console.log('\n' + bad + ' problem(s)'); process.exit(1); }
  console.log('\nAll ' + rows.length + ' recorder checks pass; all ' + MUTANTS.length + ' negative controls fail');
  process.exit(0);
})();
