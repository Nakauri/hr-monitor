// Marks store on Drive: one JSON per device per month in <root>/marks/, through the page's own driveFetch.
// Spec: ux-audit/redesign/S9-MARKS-STORE-SPEC.md rev 5, sections 3, 6, 8 and 16.
(function (root) {
  'use strict';

  const FOLDER_MIME = 'application/vnd.google-apps.folder';
  const UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';
  const DEBOUNCE_MS = 3000;
  const PURGE_DEADLINE_MS = 5000;
  // A month of one device's marks is a few kB; a larger file is not ours to parse.
  const MAX_FILE_BYTES = 2 * 1024 * 1024;
  const RETRY_MIN_MS = 30000;
  const RETRY_MAX_MS = 10 * 60000;

  function Marks() { return root.AortiMarks || (typeof require === 'function' ? require('./marks-store.js') : null); }

  function olderFirst(a, b) {
    const ta = Date.parse(a.createdTime) || Infinity, tb = Date.parse(b.createdTime) || Infinity;
    if (ta !== tb) return ta - tb;
    return String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0;
  }
  const q = (s) => encodeURIComponent(s);
  const esc = (s) => String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'");

  function httpError(what, resp, body) {
    const e = new Error(what + ' ' + resp.status);
    e.status = resp.status;
    if (/storageQuotaExceeded/.test(body || '')) e.reason = 'drive_full';
    else if (resp.status === 401) e.reason = 'auth';
    return e;
  }

  // opts: { store, driveFetch(path, init), rootId(), rootIds() (reader only), canSync(),
  //         locks (navigator.locks or null), read (true on the viewer) }
  function create(opts) {
    const store = opts.store;
    const M = Marks();
    const locks = opts.locks || null;
    const st = { lastError: '', lastSync: 0, folderId: null, folderRoot: null, blocked: false, running: null, timer: null };

    async function json(resp, what) {
      if (!resp.ok) { let t = ''; try { t = await resp.text(); } catch (e) {} throw httpError(what, resp, t); }
      return resp.json();
    }
    async function listAll(query, fields, signal) {
      const out = [];
      let token = null;
      do {
        const r = await opts.driveFetch('files?q=' + q(query) + '&fields=' + q('files(' + fields + '),nextPageToken') + '&pageSize=1000' +
          (token ? '&pageToken=' + q(token) : ''), { signal });
        const d = await json(r, 'list');
        for (const f of (d.files || [])) out.push(f);
        token = d.nextPageToken || null;
      } while (token);
      return out;
    }
    function marksFoldersUnder(rootId, signal) {
      return listAll(`'${esc(rootId)}' in parents and name='marks' and mimeType='${FOLDER_MIME}' and trashed=false`, 'id,name,createdTime', signal);
    }

    // The oldest marks folder under the picked root; created when there is none, then re-listed.
    async function writeFolder(signal) {
      const rootId = opts.rootId();
      if (!rootId) throw new Error('marks_no_root');
      if (st.folderId && st.folderRoot === rootId) return st.folderId;
      let found = await marksFoldersUnder(rootId, signal);
      if (!found.length) {
        await json(await opts.driveFetch('files?fields=id', {
          method: 'POST', signal, headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'marks', mimeType: FOLDER_MIME, parents: [rootId] }),
        }), 'folder');
        found = await marksFoldersUnder(rootId, signal);
        if (!found.length) throw new Error('marks_folder_missing');
      }
      st.folderId = found.slice().sort(olderFirst)[0].id;
      st.folderRoot = rootId;
      return st.folderId;
    }

    async function createFile(folder, name, body, signal) {
      try { return await createIn(folder, name, body, signal); }
      catch (e) { if (e && e.status === 404) st.folderId = null; throw e; }
    }
    async function createIn(folder, name, body, signal) {
      const boundary = '-------aorti-marks-' + Math.random().toString(36).slice(2);
      const meta = { name, parents: [folder], mimeType: 'application/json' };
      const multipart = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n` +
        `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${body}\r\n--${boundary}--`;
      return json(await opts.driveFetch(UPLOAD + '?uploadType=multipart&fields=id,md5Checksum', {
        method: 'POST', signal, headers: { 'Content-Type': 'multipart/related; boundary=' + boundary }, body: multipart,
      }), 'create');
    }
    async function patchFile(id, body, signal) {
      const r = await opts.driveFetch(UPLOAD + '/' + encodeURIComponent(id) + '?uploadType=media&fields=id,md5Checksum', {
        method: 'PATCH', signal, headers: { 'Content-Type': 'application/json; charset=UTF-8' }, body,
      });
      if (r.status === 404) return null;
      return json(r, 'patch');
    }

    // Inside the month lock: rebuild from mine, PATCH the known id or create, then clear what was carried.
    async function pushMonth(m, signal) {
      let snap = await store.snapshotMonth(m);
      if (!Object.keys(snap.month.pending || {}).length) return 'clean';
      const folder = await writeFolder(signal);
      const name = store.fileName(m);
      let fileId = snap.month.fileId;
      if (!fileId) {
        const found = await listAll(`'${esc(folder)}' in parents and name='${esc(name)}' and trashed=false`, 'id,name,createdTime', signal);
        if (found.length) {
          fileId = found.slice().sort(olderFirst)[0].id;
          await store.setMonthFile(m, fileId);
        }
      }
      let res = null;
      if (fileId) {
        res = await patchFile(fileId, snap.body, signal);
        if (!res) { await store.forgetMonthFile(m); fileId = null; snap = await store.snapshotMonth(m); }
      }
      if (!fileId) res = await createFile(folder, name, snap.body, signal);
      await store.uploaded(m, snap, res.id, res.md5Checksum);
      return 'pushed';
    }

    function withLock(m, lockOpts, fn) {
      return locks.request('aorti-marks:' + m, lockOpts || {}, (lock) => (lock ? fn() : 'busy'));
    }

    // Drive's permissionId: the same key on every page, whichever of them knows the email.
    async function accountOk(signal) {
      const d = await json(await opts.driveFetch('about?fields=' + q('user(permissionId)'), { signal }), 'about');
      const key = (d.user && d.user.permissionId) || '';
      if (!key) return false;
      const bound = await store.bindAccount(key);
      st.blocked = bound !== key;
      return !st.blocked;
    }

    async function push(signal, lockOpts) {
      if (!locks) return 'nolocks';
      let n = 0;
      for (const m of store.dirtyMonths()) {
        const r = await withLock(m, lockOpts, () => pushMonth(m, signal));
        if (r === 'pushed') n++;
      }
      return n;
    }

    // Reader: every marks folder under every root, md5 freshness, own duplicates resolved.
    async function pull(signal) {
      const roots = (opts.rootIds && opts.rootIds()) || [];
      const rootList = roots.length ? roots : (opts.rootId() ? [opts.rootId()] : []);
      const folders = [];
      for (const r of rootList) for (const f of await marksFoldersUnder(r, signal)) folders.push(f);
      if (st.folderId && !folders.some(f => f.id === st.folderId)) st.folderId = null;
      const listed = [];
      for (const f of folders) {
        for (const x of await listAll(`'${esc(f.id)}' in parents and trashed=false`, 'id,name,size,md5Checksum,createdTime', signal)) {
          if (M.FILE_RE.test(x.name)) listed.push(x);
        }
      }
      const cached = store.files();
      const put = new Map(), keep = [];
      for (const f of listed) {
        if (Number(f.size) > MAX_FILE_BYTES) continue;
        const c = cached.get(f.id);
        if (c && c.md5 && c.md5 === f.md5Checksum) { keep.push(f.id); continue; }
        // A network or HTTP failure throws (retried next sync); only a body that will not parse is cached as bad.
        const r = await opts.driveFetch('files/' + encodeURIComponent(f.id) + '?alt=media', { signal });
        if (!r.ok) throw httpError('download', r, '');
        const text = await r.text();
        let entry;
        try {
          const parsed = M.parseFileBody(text);
          entry = { name: f.name, md5: f.md5Checksum || null, records: parsed.records, skipped: parsed.skipped };
        } catch (e) {
          entry = { name: f.name, md5: f.md5Checksum || null, records: [], bad: true };
        }
        put.set(f.id, entry);
      }
      // Own files: the oldest copy of a name is the one this device writes; a vanished own file is recreated.
      const own = new Map();
      for (const f of listed) {
        const mm = M.FILE_RE.exec(f.name);
        if (mm[3] !== store.deviceId) continue;
        const m = mm[1] + '-' + mm[2];
        if (!own.has(m)) own.set(m, []);
        own.get(m).push(f);
      }
      const empties = [];
      const months = store.months();
      for (const [m, list] of own) {
        list.sort(olderFirst);
        const cur = months.get(m);
        if (!cur || cur.fileId !== list[0].id) await store.adoptMonthFile(m, list[0].id);
        for (const extra of list.slice(1)) {
          const e = put.get(extra.id) || cached.get(extra.id);
          if (e && (e.records || []).length) empties.push({ m, id: extra.id });
        }
      }
      const listedIds = new Set(listed.map(f => f.id));
      for (const [m, v] of months) if (v && v.fileId && !listedIds.has(v.fileId) && !own.has(m)) await store.forgetMonthFile(m);
      const changed = await store.applyFiles({ keep, put });
      return { changed, empties };
    }

    // A newer copy of an own file is rewritten once with no records, after the oldest holds them.
    async function emptyDuplicates(empties, signal) {
      for (const d of empties) {
        const body = M.fileBody(store.deviceId, d.m, []);
        await withLock(d.m, {}, async () => {
          const res = await patchFile(d.id, body, signal);
          if (res) await store.cacheFile(d.id, { name: store.fileName(d.m), md5: res.md5Checksum || null, records: [] });
        });
      }
    }

    async function runSync(mode) {
      if (!opts.canSync()) return { changed: false, skipped: 'off' };
      if (!locks) { st.lastError = 'nolocks'; return { changed: false, skipped: 'nolocks' }; }
      try {
        await store.reloadLocal();
        if (!(await accountOk())) return { changed: false, skipped: st.blocked ? 'account' : 'no_account' };
        let changed = false, empties = [];
        if (mode !== 'push' && opts.read) ({ changed, empties } = await pull());
        await push();
        if (empties.length) await emptyDuplicates(empties);
        st.lastError = '';
        st.lastSync = Date.now();
        return { changed };
      } catch (e) {
        st.lastError = (e && (e.reason || e.message)) || 'error';
        throw e;
      }
    }

    // One run at a time per page; a request made during a run queues one more.
    function sync(mode) {
      const p = (st.running || Promise.resolve()).then(() => runSync(mode));
      const settled = p.then(() => {}, () => {});
      st.running = settled;
      settled.then(() => { if (st.running === settled) st.running = null; });
      return p;
    }

    // Debounced push; a failed or signed-out run with marks left retries with a growing delay.
    function schedule(delay) {
      if (st.timer) clearTimeout(st.timer);
      st.timer = setTimeout(() => {
        st.timer = null;
        sync('push').then((r) => (r && (r.skipped === 'off' || r.skipped === 'no_account')) ? 'retry' : 'ok', () => 'retry').then((how) => {
          if (how === 'ok') { st.backoff = 0; return; }
          if (!store.dirtyCount() || st.timer) return;
          st.backoff = Math.min(RETRY_MAX_MS, (st.backoff || RETRY_MIN_MS / 2) * 2);
          schedule(st.backoff);
        });
      }, delay == null ? DEBOUNCE_MS : delay);
    }
    function flushSoon() {
      if (st.timer) { clearTimeout(st.timer); st.timer = null; }
      if (store.dirtyCount()) sync('push').catch(() => {});
    }

    // Purge: upload under a deadline that covers the whole step, token refresh included; then the count left.
    async function beforePurge(deadlineMs) {
      const ms = deadlineMs == null ? PURGE_DEADLINE_MS : deadlineMs;
      try { await store.reloadLocal(); } catch (e) {}
      if (store.dirtyCount() && locks && opts.canSync()) {
        const ctl = typeof AbortController === 'function' ? new AbortController() : null;
        const signal = ctl ? ctl.signal : undefined;
        let timer = null;
        const work = (async () => {
          if (!(await accountOk(signal))) return;
          await push(signal, { ifAvailable: true });
        })().catch(() => {});
        await Promise.race([work, new Promise(r => { timer = setTimeout(r, ms); })]);
        clearTimeout(timer);
        if (ctl) ctl.abort();
      }
      return store.dirtyCount();
    }

    return {
      sync, schedule, flushSoon, beforePurge,
      status() { return { locks: !!locks, lastError: st.lastError, lastSync: st.lastSync, blocked: st.blocked, dirty: store.dirtyCount() }; },
      // The records a page applies: none while another account is signed in.
      records() { return st.blocked ? [] : store.all(); },
      _pushMonth: pushMonth,
    };
  }

  // Page wiring shared by the viewer and the monitor. opts as create(), minus store; plus persist and idb.
  async function attachPage(opts) {
    const M = Marks();
    let store, memoryOnly = false;
    try {
      if (!opts.idb) throw new Error('no_idb');
      store = await M.open({ backend: M.idbBackend(opts.idb), persist: opts.persist });
    } catch (e) {
      memoryOnly = true;
      store = await M.open({ persist: null });
    }
    const drive = create(Object.assign({}, opts, { store }));
    store.onChange(() => { if (store.dirtyCount()) drive.schedule(); });
    if (store.dirtyCount()) drive.schedule();
    if (typeof root.addEventListener === 'function') {
      root.addEventListener('pagehide', () => drive.flushSoon());
      root.addEventListener('online', () => drive.flushSoon());
      if (root.document) root.document.addEventListener('visibilitychange', () => { if (root.document.visibilityState === 'hidden') drive.flushSoon(); });
    }
    const page = {
      store, drive, memoryOnly,
      beforePurge: (ms) => drive.beforePurge(ms),
      // Diagnostics lines: counts and flags only.
      diag() {
        const s = drive.status();
        return {
          device: store.deviceId,
          records: store.all().filter(r => !r.deleted).length,
          dirty: s.dirty,
          badFiles: store.stats.badFiles,
          badRecords: store.stats.badRecords,
          persisted: memoryOnly ? 'memory only' : store.persisted == null ? 'not asked' : store.persisted ? 'yes' : 'no',
          locks: s.locks,
          blocked: s.blocked,
          lastError: s.lastError,
          lastSync: s.lastSync,
        };
      },
    };
    return page;
  }

  const api = { create, attachPage, olderFirst, DEBOUNCE_MS, PURGE_DEADLINE_MS, MAX_FILE_BYTES };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AortiMarksDrive = api;
})(typeof self !== 'undefined' ? self : this);
