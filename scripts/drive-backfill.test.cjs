#!/usr/bin/env node
// Guards: the first sync pulled every Drive file one at a time, painted nothing until the last landed, and lost a file
// to a rate limit (Block 4, 2026-10-29). Files: hrv_viewer.html drivePullPool, driveSyncRun, the driveSync poll branch,
// backfillMerge, backfillStop. Runs the real functions in a vm against a fake Drive:
//   T3 pool: at most 4 in flight; 429 and 403 rate limits retried and stored; a plain 403 not retried; a 401 stops.
//   T4 poll mid-backfill: resolves before the tail, pulls the grown files first, a re-pulled file reads new after the merge.
//   T5 a segment a poll added survives the end eviction.
//   T6 abort: a stop with 4 pulls in flight starts nothing more and deletes nothing; a stop during a 32 s hold ends at once.
// --mutants runs each named mutant and requires it to fail. --src <html> runs another copy (c0e5d9b must fail).
// Runtime: about 4 s; --mutants about 30 s.
// Usage: node scripts/drive-backfill.test.cjs [--src <viewer html>] [--mutants]
process.env.TZ = 'America/Edmonton';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const args = process.argv.slice(2);
const SRC = args.includes('--src') ? args[args.indexOf('--src') + 1] : path.join(__dirname, '..', 'hrv_viewer.html');
const norm = (s) => s.replace(/\r\n/g, '\n');
const HTML = norm(fs.readFileSync(SRC, 'utf8'));
const MOD = norm(fs.readFileSync(path.join(path.dirname(SRC), 'viewer-parse.js'), 'utf8'));

function fn(src, name) {
  const m = new RegExp('(?:async\\s+)?function\\s+' + name + '\\s*\\(').exec(src);
  if (!m) return null;
  const open = src.indexOf('{', src.indexOf(')', m.index));
  let d = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') d++;
    else if (src[i] === '}' && --d === 0) return src.slice(m.index, i + 1);
  }
  return null;
}
const line = (src, re) => { const m = src.match(re); return m ? m[0] : ''; };

const MUTANTS = {
  'cap 5': ['const DRIVE_POOL = 4,', 'const DRIVE_POOL = 5,', 'T3'],
  'retry removed': ["if (cls === 'retry' && n < 6 && !o.isAborted()) {", 'if (false) {', 'T3'],
  '401 as a network error': ["if (s === 401) return 'auth';", "if (s === 401) return 'retry';", 'T3'],
  'no persist in backfillMerge': ['    drivePersistMeta();\n    persistIndex();\n    await loadSessions({ reusePhone: true });', '    await loadSessions({ reusePhone: true });', 'T4'],
  'no listing merge': ['          driveFiles.set(name, meta);\n', '', 'T5'],
  'hold ignores abort': ['      if (o.abortWait) o.abortWait.then(() => { clearTimeout(t); r(); });\n', '', 'T6'],
};

function build(html) {
  const parts = [line(MOD, /const DAY_START_HOUR = [^\n]*;/), 'let _dayKeyLast = { start: 0, end: 0, key: "" };'];
  for (const n of ['localDateKeyFromEpoch', 'localDateLabel', 'isoAddDays', 'dayWindow', 'dayKeyOf', 'parseSessionFilename']) parts.push(fn(MOD, n));
  parts.push(line(html, /const DRIVE_POOL = [^\n]*;/), line(html, /const driveBackfill = [^\n]*;/), line(html, /let bfMergeTail = [^\n]*;/));
  for (const n of ['drivePullKey', 'drivePullPlan', 'drivePullDays', 'driveErrorClass', 'drivePullPool', 'dayPending', 'backfillPromote', 'backfillStop', 'backfillMerge', 'backfillMergeRun']) parts.push(fn(html, n) || '');
  parts.push('let driveSyncInFlight = null, driveSyncFolderId = null, driveFilesByName = null;', fn(html, 'driveSync'), fn(html, 'driveSyncRun'));
  parts.push("globalThis.__bf = typeof driveBackfill === 'object' ? driveBackfill : null;");
  return parts.join('\n');
}

const tick = (ms) => new Promise((r) => setTimeout(r, ms));
const pad = (n) => String(n).padStart(2, '0');
const segName = (ms, iid) => { const d = new Date(ms); return `hrm_${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}Z_${iid || 'abc123'}.csv`; };
const H = 3600000;

// A fake Drive and page around the real sync code.
function world(code, nHours) {
  const w = { files: new Map(), script: {}, store: new Map(), starts: [], errors: [], inflight: 0, peak: 0, calls: {}, deletes: 0,
    persisted: {}, hides: [], notices: [], stops: [], painted: 0, gate: null, delay: 4, listings: 0, routes: 0 };
  const now = Date.now();
  let seq = 0;
  const add = (name, content) => { w.files.set(name, { id: 'id' + (++seq), modifiedTime: new Date(now).toISOString(), size: String(content.length), content }); };
  for (let h = 0; h < nHours; h++) add(segName(now - h * H), 'seg ' + h);
  w.add = add;
  w.grow = (name, extra) => { const f = w.files.get(name); f.content += extra; f.size = String(f.content.length); f.modifiedTime = new Date().toISOString(); };
  const byId = (id) => { for (const [n, f] of w.files) if (f.id === id) return [n, f]; return [null, null]; };
  const ctx = {
    console: { info() {}, warn() {}, error: console.error, log: console.log },
    setTimeout, clearTimeout,
    window: {}, localStorage: { setItem() {}, getItem() { return null; } },
    IDB_DRIVE_STORE: 'drive', driveAccessToken: 'tok', driveFolderId: 'folder',
    driveMetaCache: {}, sessionsIndex: {}, legacyShadow: {}, dirHandle: null, shownDay: null,
    driveListSessions: async () => {
      w.listings++;
      await tick(2);
      w.listedAt = Date.now();
      return new Map([...w.files].map(([n, f]) => [n, { id: f.id, modifiedTime: f.modifiedTime, size: f.size }]));
    },
    idbKeys: async () => [...w.store.keys()],
    idbGet: async (k) => w.store.get(k),
    idbSet: async (k, v) => { w.store.set(k, v); },
    idbDelete: async (k) => { w.deletes++; w.store.delete(k); },
    driveDownloadSession: async (id) => {
      const [name, f] = byId(id);
      w.calls[name] = (w.calls[name] || 0) + 1;
      w.starts.push({ at: Date.now(), name });
      w.inflight++;
      w.peak = Math.max(w.peak, w.inflight);
      try {
        if (w.gate) await w.gate;
        await tick(w.delay);
        const s = w.script[name];
        const r = s && (typeof s === 'function' ? s(w.calls[name]) : s.shift());
        if (r) {
          const e = new Error('Drive download ' + r.status);
          Object.assign(e, r);
          w.errors.push({ at: Date.now(), name, status: r.status, retryAfter: r.retryAfter });
          throw e;
        }
        return f.content;
      } finally { w.inflight--; }
    },
    setDriveProgress() {}, drivePersistMeta() {},
    persistIndex: () => { w.persisted = JSON.parse(JSON.stringify(ctx.sessionsIndex)); },
    // Rebuilds the index from the saved copy (loadCachedIndex), reads only files it lacks, then saves it, as loadSessionsRun does.
    loadSessions: async () => {
      const idx = JSON.parse(JSON.stringify(w.persisted));
      for (const k of w.store.keys()) if (!idx[k]) idx[k] = { text: w.store.get(k) };
      ctx.sessionsIndex = idx;
      w.persisted = JSON.parse(JSON.stringify(idx));
    },
    route() { w.routes++; }, routeKeepScroll: async () => { w.routes++; }, routeUnlessEditing() {},
    syncPhase() {}, hideLoader: () => { w.hides.push(Date.now()); },
    UI: { notice: (o) => { w.notices.push(o.text); } },
    parseHash: () => ({ view: 'day', arg: undefined }),
  };
  vm.createContext(ctx);
  vm.runInContext(code, ctx);
  if (typeof ctx.backfillStop === 'function') {
    const real = ctx.backfillStop;
    ctx.backfillStop = (r) => { w.stops.push({ reason: r, at: Date.now() }); return real(r); };
  }
  w.ctx = ctx;
  w.sync = (extra) => ctx.driveSync(Object.assign({
    deferReload: true,
    onRecent: async () => { ctx.persistIndex(); await ctx.loadSessions(); w.painted = Date.now(); },
  }, extra || {}));
  w.older = () => [...w.files.keys()].filter((n) => /^hrm_/.test(n)).sort().reverse().slice(60);
  return w;
}

async function suite(code, only) {
  let fails = 0;
  const ok = (cond, msg) => { if (!cond) fails++; if (!only) console.log((cond ? 'PASS ' : 'FAIL ') + msg); };
  const has = (id) => !only || only === id;
  const limit = (p, ms) => Promise.race([p, tick(ms).then(() => 'timeout')]);

  if (has('T3')) {
    const w = world(code, 120);
    const old = w.older();
    const [X, Y, Z] = [old[5], old[10], old[15]];
    w.script[X] = [{ status: 429, retryAfter: 80 }, { status: 429, retryAfter: 80 }];
    w.script[Y] = [{ status: 403, reason: 'rateLimitExceeded' }];
    w.script[Z] = () => ({ status: 403, reason: 'forbidden' });
    const r = await limit(w.sync(), 20000);
    ok(r !== 'timeout', 'T3 the run ends');
    ok(w.peak <= 4 && w.peak >= 3, `T3 peak in flight ${w.peak} (3 or 4)`);
    ok(w.store.has(X) && w.calls[X] === 3, `T3 X: two 429s, then stored (${w.calls[X]} calls, stored ${w.store.has(X)})`);
    ok(w.store.has(Y) && w.calls[Y] === 2, `T3 Y: a 403 rateLimitExceeded, then stored (${w.calls[Y]} calls)`);
    ok(!w.store.has(Z) && w.calls[Z] === 1 && !w.ctx.driveMetaCache[Z], `T3 Z: a plain 403, not retried, no meta (${w.calls[Z]} calls)`);
    const inHold = w.errors.filter((e) => e.name !== Z).map((e) => {
      const hold = e.retryAfter != null ? e.retryAfter : 1000;
      return w.starts.filter((s) => s.at > e.at + 5 && s.at < e.at + hold - 5).length;
    }).reduce((a, b) => a + b, 0);
    ok(w.errors.length >= 3 && inHold === 0, `T3 no pull starts inside a hold (${inHold} starts in ${w.errors.length - 1} holds)`);
    ok(w.store.size === 119, `T3 every other file stored (${w.store.size} of 119)`);
    ok(w.notices.length === 1 && w.notices[0] === 'Some older days did not load from Drive. The next sync tries again.', 'T3 failure notice: ' + JSON.stringify(w.notices));

    const v = world(code, 120);
    const W = v.older()[3];
    v.script[W] = () => ({ status: 401 });
    const r2 = await limit(v.sync(), 20000);
    ok(r2 !== 'timeout' && v.calls[W] === 1, `T3 W: a 401 is not retried (${v.calls[W]} calls)`);
    ok(v.stops.length > 0 && v.stops[0].reason === 'auth' && !(v.ctx.__bf && v.ctx.__bf.active), 'T3 W: the 401 calls backfillStop(auth): ' + JSON.stringify(v.stops.map((s) => s.reason)));
    ok(v.notices.length === 0, 'T3 W: no failure notice after a sign-in loss');
  }

  if (has('T4') || has('T5')) {
    const w = world(code, 120);
    const now = Date.now();
    const d = new Date(now - 3 * H);
    const L = `hrv_session_${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}-00-00.123.csv`;
    w.add(L, 'legacy v1');
    w.delay = 6;
    const run = w.sync();
    let runEnd = 0;
    run.then(() => { runEnd = Date.now(); });
    for (let i = 0; i < 400 && !(w.painted && w.store.size >= 75); i++) await tick(5);
    const grown = segName(now);
    const added = segName(now - H, 'zz9999');
    w.grow(grown, ' more');
    w.add(added, 'new hour');
    w.grow(L, ' v2');
    const t0 = Date.now();
    const pr = await limit(w.ctx.driveSync({ poll: true, deferReload: true }), 15000);
    const tPoll = Date.now();
    ok(pr !== 'timeout' && !runEnd && w.store.size < 121, `T4 the poll resolves before the backfill ends (${w.store.size} of 122 stored at the poll's end)`);
    const after = w.starts.filter((s) => s.at >= Math.max(t0, w.listedAt)).map((s) => s.name);
    const firstThree = new Set(after.slice(0, 3));
    ok([grown, added, L].every((n) => firstThree.has(n)), 'T4 the poll pulls its grown and new files next: ' + after.slice(0, 4).join(' '));
    ok(pr && pr.changed === true, 'T4 the poll reports a change');
    if (typeof w.ctx.backfillMerge === 'function') await w.ctx.backfillMerge('poll');
    ok(w.ctx.sessionsIndex[L] && w.ctx.sessionsIndex[L].text === 'legacy v1 v2', 'T4 a re-pulled legacy file reads new after the poll merge: ' + JSON.stringify(w.ctx.sessionsIndex[L]));
    await limit(run, 20000);
    ok(w.peak <= 4, `T4 in flight stayed at most 4 (${w.peak})`);
    ok(tPoll < runEnd, 'T4 the tail ends after the poll');
    if (has('T5')) ok(w.store.has(added) && w.deletes === 0, `T5 the segment a poll added is still stored after the drain (${w.store.has(added)}, ${w.deletes} deletes)`);
  }

  if (has('T6')) {
    // (a) A stop with 4 pulls in flight: the note goes first, then nothing starts and nothing is deleted.
    const w = world(code, 120);
    w.delay = 3;
    const run = w.sync();
    for (let i = 0; i < 400 && !(w.painted && w.store.size >= 70); i++) await tick(5);
    let release;
    w.gate = new Promise((r) => { release = r; });
    for (let i = 0; i < 200 && w.inflight < 4; i++) await tick(5);
    const held = w.inflight;
    const startsBefore = w.starts.length;
    const hidesBefore = w.hides.length;
    if (typeof w.ctx.backfillStop === 'function') w.ctx.backfillStop('auth');
    const noteGone = w.hides.length > hidesBefore && !(w.ctx.__bf && w.ctx.__bf.active);
    ok(held === 4 && noteGone, `T6a stop with ${held} in flight: flag cleared and note hidden before they settle`);
    release();
    w.gate = null;
    const r = await limit(run, 5000);
    ok(r !== 'timeout', 'T6a the run ends after the in-flight pulls settle');
    ok(w.starts.length === startsBefore && w.deletes === 0, `T6a after the stop: ${w.starts.length - startsBefore} new starts, ${w.deletes} deletes`);

    // (b) A stop while a file sits in a 32 s hold: the run ends without waiting it out.
    const v = world(code, 120);
    v.delay = 3;
    const P = v.older()[2];
    v.script[P] = [{ status: 429, retryAfter: 32000 }];
    const run2 = v.sync();
    for (let i = 0; i < 600 && !v.errors.length; i++) await tick(5);
    await tick(20);
    const t = Date.now();
    if (typeof v.ctx.backfillStop === 'function') v.ctx.backfillStop('auth');
    const r2 = await limit(run2, 4000);
    ok(v.errors.length === 1 && r2 !== 'timeout', `T6b stop during a 32 s hold: the run ends in ${r2 === 'timeout' ? 'over 4000' : Date.now() - t} ms`);
  }
  return fails;
}

(async () => {
  const code = build(HTML);
  if (args.includes('--mutants')) {
    let survived = 0;
    for (const [name, [from, to, test]] of Object.entries(MUTANTS)) {
      if (!HTML.includes(from)) { console.log(`MUTANT ANCHOR MISSING  ${name}`); survived++; continue; }
      const f = await suite(build(HTML.replace(from, to)), test);
      console.log(`${f ? 'killed  ' : 'SURVIVED'} ${name} (${test}, ${f} failing checks)`);
      if (!f) survived++;
    }
    console.log(survived ? `\n${survived} mutant(s) survived` : '\nall mutants killed');
    process.exit(survived ? 1 : 0);
  }
  const fails = await suite(code, null);
  console.log(fails ? `\n${fails} failed` : '\nall passed');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
