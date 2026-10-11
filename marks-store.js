// Marks store: viewer-made marks kept beside the recordings, never inside them.
// Spec: ux-audit/redesign/S9-MARKS-STORE-SPEC.md rev 5 (section 16 wins). No DOM.
(function (root) {
  'use strict';

  const SCHEMA_V = 1;
  const KINDS = ['sleep', 'added', 'win', 'removed', 'stand', 'note', 'tap', 'rev'];
  // S9 applies these; the reader keeps the others (S15) untouched.
  const APPLIED = ['sleep', 'tap', 'rev'];
  const COMMON = ['v', 'id', 'kind', 'm', 'by', 'createdAt', 'updatedAt', 'base', 'deleted'];
  const TOMB_KEEP = ['v', 'id', 'kind', 'm', 'by', 'createdAt', 'updatedAt', 'base', 'deleted', 'target', 'row'];
  const FACT_FIELD_MAX = 80;
  // SegmentWriter.FACT_PAST_MS is 15 min; a rev past 14 min could miss the clamped row.
  const UNDO_LIMIT_MS = 14 * 60000;
  const FILE_RE = /^marks_(\d{4})-(\d{2})_([a-z0-9]{6})\.json$/;
  const DB_NAME = 'aorti_marks';
  const STORES = ['records', 'mine', 'files', 'meta'];

  // PARITY CRITICAL: SegmentWriter.clean (Java). Commas, CR and LF to spaces, at most 80 chars.
  function cleanFactField(s) {
    if (s == null) return '';
    const r = String(s).replace(/,/g, ' ').replace(/\r/g, ' ').replace(/\n/g, ' ');
    return r.length > FACT_FIELD_MAX ? r.slice(0, FACT_FIELD_MAX) : r;
  }

  function fnv8(s) {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    return ('0000000' + h.toString(16)).slice(-8);
  }

  function monthOf(ep) {
    const d = new Date(ep);
    return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0');
  }

  function randomId(n) {
    const abc = 'abcdefghijklmnopqrstuvwxyz0123456789';
    let out = '';
    const c = root.crypto && root.crypto.getRandomValues ? root.crypto : null;
    const bytes = c ? c.getRandomValues(new Uint8Array(n)) : null;
    for (let i = 0; i < n; i++) out += abc[(bytes ? bytes[i] : Math.floor(Math.random() * 256)) % 36];
    return out;
  }

  // A rev's kind letter, the same mapping addMarker uses for logFact.
  function factKind(label) { return /^sym:/i.test(String(label == null ? '' : label)) ? 's' : 'e'; }
  function revId(row) { return 'rev:' + row.k + ':' + row.ep + ':' + fnv8(row.label); }

  function isNum(x) { return typeof x === 'number' && Number.isFinite(x); }
  function isStr(x) { return typeof x === 'string'; }

  // Common fields by name, then the applied kinds' own fields on live records.
  // Returns '' when valid, else the reason.
  function invalidReason(r) {
    if (!r || typeof r !== 'object' || Array.isArray(r)) return 'not_object';
    if (r.v !== SCHEMA_V) return 'v';
    if (!isStr(r.id) || !r.id) return 'id';
    if (KINDS.indexOf(r.kind) < 0) return 'kind';
    if (!isStr(r.m) || !/^\d{4}-\d{2}$/.test(r.m)) return 'm';
    if (!isStr(r.by) || !/^[a-z0-9]{6}$/.test(r.by)) return 'by';
    if (!isNum(r.createdAt)) return 'createdAt';
    if (!isNum(r.updatedAt)) return 'updatedAt';
    if (!isNum(r.base)) return 'base';
    if (typeof r.deleted !== 'boolean') return 'deleted';
    if (r.kind === 'rev') {
      const w = r.row;
      if (!w || !isNum(w.ep) || (w.k !== 's' && w.k !== 'e') || !isStr(w.label)) return 'row';
      if (r.id !== revId(w)) return 'rev_id';
    }
    if (r.deleted) return '';
    if (r.kind === 'sleep' && !(isNum(r.from) && isNum(r.to) && r.to > r.from)) return 'sleep_span';
    if (r.kind === 'tap' && !(isNum(r.at) && ['sym', 'ctx', 'note'].indexOf(r.cls) >= 0 && isStr(r.label))) return 'tap_fields';
    return '';
  }

  // Winner per id: higher updatedAt, then higher by, then higher JSON text.
  function beats(a, b) {
    if (!b) return true;
    if (!a) return false;
    if (a.updatedAt !== b.updatedAt) return a.updatedAt > b.updatedAt;
    if (a.by !== b.by) return a.by > b.by;
    return JSON.stringify(a) > JSON.stringify(b);
  }

  function tombstoneOf(r) {
    const t = {};
    for (const k of TOMB_KEEP) if (r[k] !== undefined) t[k] = r[k];
    t.deleted = true;
    return t;
  }

  function anchorOf(kind, fields) {
    if (kind === 'sleep' || kind === 'added' || kind === 'win') return fields.from;
    if (kind === 'tap') return fields.at;
    if (kind === 'rev') return fields.row && fields.row.ep;
    const m = /@(\d+)$/.exec(fields.target || '');
    return m ? Number(m[1]) : NaN;
  }

  function fileBody(by, m, records) {
    const recs = records.filter(r => r.m === m).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return JSON.stringify({ v: SCHEMA_V, by, m, records: recs });
  }

  // Parses a marks file. Throws on a body that is not a v1 marks file; skips bad records and counts them.
  function parseFileBody(text) {
    const o = JSON.parse(text);
    if (!o || typeof o !== 'object' || o.v !== SCHEMA_V || !Array.isArray(o.records)) throw new Error('marks_file_shape');
    const records = [];
    let skipped = 0;
    for (const r of o.records) {
      if (invalidReason(r)) { skipped++; continue; }
      records.push(r);
    }
    return { by: o.by, m: o.m, records, skipped };
  }

  // ---- Backends: get all, and atomic writes (one transaction per call) ----

  function memoryBackend(shared) {
    const data = shared || {};
    for (const s of STORES) if (!data[s]) data[s] = new Map();
    const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
    return {
      kind: 'memory',
      data,
      async getAll(store) { return Array.from(data[store].entries()).map(([k, v]) => [k, clone(v)]); },
      async get(store, key) { return clone(data[store].get(key)); },
      // Several stores read in one transaction: { store: [[key, value], ...] }.
      async readMany(stores) { const o = {}; for (const n of stores) o[n] = Array.from(data[n].entries()).map(([k, v]) => [k, clone(v)]); return o; },
      // ops: [{ store, key, value } | { store, key, del: true } | { store, key, update(prev) -> next }]
      async write(ops) {
        const out = [];
        for (const op of ops) {
          if (op.del) { data[op.store].delete(op.key); out.push(undefined); continue; }
          const v = op.update ? op.update(clone(data[op.store].get(op.key))) : op.value;
          data[op.store].set(op.key, clone(v));
          out.push(clone(v));
        }
        return out;
      },
      async destroy() { for (const s of STORES) data[s].clear(); },
    };
  }

  function idbBackend(idb, name) {
    name = name || DB_NAME;
    let dbp = null;
    function open() {
      if (dbp) return dbp;
      dbp = new Promise((resolve, reject) => {
        const q = idb.open(name, 1);
        q.onupgradeneeded = () => { for (const s of STORES) if (!q.result.objectStoreNames.contains(s)) q.result.createObjectStore(s); };
        q.onsuccess = () => {
          const db = q.result;
          db.onversionchange = () => { try { db.close(); } catch (e) {} dbp = null; };
          resolve(db);
        };
        q.onerror = () => { dbp = null; reject(q.error); };
        q.onblocked = () => { dbp = null; reject(new Error('marks_db_blocked')); };
      });
      return dbp;
    }
    return {
      kind: 'idb',
      async getAll(store) {
        const db = await open();
        return new Promise((resolve, reject) => {
          const tx = db.transaction(store, 'readonly');
          const os = tx.objectStore(store);
          const keys = os.getAllKeys();
          const vals = os.getAll();
          tx.oncomplete = () => resolve(keys.result.map((k, i) => [k, vals.result[i]]));
          tx.onerror = () => reject(tx.error);
        });
      },
      async get(store, key) {
        const db = await open();
        return new Promise((resolve, reject) => {
          const tx = db.transaction(store, 'readonly');
          const q = tx.objectStore(store).get(key);
          tx.oncomplete = () => resolve(q.result);
          tx.onerror = () => reject(tx.error);
        });
      },
      async readMany(stores) {
        const db = await open();
        return new Promise((resolve, reject) => {
          const tx = db.transaction(stores, 'readonly');
          const reqs = stores.map(n => { const os = tx.objectStore(n); return [n, os.getAllKeys(), os.getAll()]; });
          tx.oncomplete = () => { const o = {}; for (const [n, k, v] of reqs) o[n] = k.result.map((key, i) => [key, v.result[i]]); resolve(o); };
          tx.onerror = () => reject(tx.error);
        });
      },
      // Ops on one key run in order on one read, so two updates to one key both apply.
      async write(ops) {
        if (!ops.length) return [];
        const db = await open();
        const names = Array.from(new Set(ops.map(o => o.store)));
        const groups = new Map();
        ops.forEach((op, i) => {
          const key = op.store + '\u0000' + op.key;
          if (!groups.has(key)) groups.set(key, []);
          groups.get(key).push(i);
        });
        return new Promise((resolve, reject) => {
          const tx = db.transaction(names, 'readwrite');
          const out = new Array(ops.length);
          for (const idx of groups.values()) {
            const first = ops[idx[0]];
            const os = tx.objectStore(first.store);
            const apply = (cur) => {
              let gone = false;
              for (const i of idx) {
                const op = ops[i];
                if (op.del) { cur = undefined; gone = true; continue; }
                cur = op.update ? op.update(cur) : op.value;
                gone = false;
                out[i] = cur;
              }
              if (gone) os.delete(first.key); else os.put(cur, first.key);
            };
            if (idx.some(i => ops[i].update)) { const g = os.get(first.key); g.onsuccess = () => apply(g.result); }
            else apply(undefined);
          }
          tx.oncomplete = () => resolve(out);
          tx.onerror = () => reject(tx.error);
          tx.onabort = () => reject(tx.error || new Error('marks_tx_abort'));
        });
      },
      async destroy() {
        try { const db = await open(); db.close(); } catch (e) {}
        dbp = null;
        await new Promise((resolve) => { const q = idb.deleteDatabase(name); q.onsuccess = q.onerror = q.onblocked = () => resolve(); });
      },
    };
  }

  // ---- The store ----

  // opts: { backend, now() (clock, ms), deviceId (tests only), persist() (navigator.storage.persist) }
  async function open(opts) {
    opts = opts || {};
    const backend = opts.backend || memoryBackend();
    const now = opts.now || (() => Date.now());
    const listeners = new Set();
    const lastLive = new Map();
    const s = {
      backend, now,
      deviceId: '',
      records: new Map(),
      mine: new Map(),
      files: new Map(),
      months: new Map(),
      persisted: null,
      memoryOnly: backend.kind === 'memory' && !opts.backend,
    };

    const ids = await backend.write([{ store: 'meta', key: 'deviceId', update: (prev) => prev || opts.deviceId || randomId(6) }]);
    s.deviceId = ids[0];

    // Re-reads what any page on this device wrote; emits when the merged view moved.
    async function reloadLocal(quiet) {
      const all = await backend.readMany(['mine', 'files', 'meta']);
      s.mine = new Map(all.mine);
      s.files = new Map(all.files);
      s.months = new Map();
      for (const [k, v] of all.meta) if (typeof k === 'string' && k.startsWith('month:')) s.months.set(k.slice(6), v);
      const changed = recompute();
      if (changed && !quiet) emit();
      return changed;
    }

    // Winners over mine and every cached file. The records store stays in the schema, unwritten.
    function recompute() {
      const next = new Map();
      const offer = (r) => { if (beats(r, next.get(r.id))) next.set(r.id, r); };
      for (const r of s.mine.values()) offer(r);
      for (const f of s.files.values()) for (const r of (f.records || [])) offer(r);
      const changed = next.size !== s.records.size || Array.from(next).some(([id, r]) => JSON.stringify(s.records.get(id)) !== JSON.stringify(r));
      s.records = next;
      return changed;
    }

    function emit() { for (const fn of listeners) { try { fn(); } catch (e) {} } }

    async function persistOnce() {
      if (s.persisted !== null || !opts.persist) return;
      s.persisted = false;
      try { s.persisted = !!(await opts.persist()); } catch (e) { s.persisted = false; }
    }

    // One version of one id: stamped over the current winner, saved to records and mine, month marked dirty.
    async function put(kind, id, fields, mode) {
      const stored = await backend.get('mine', id);
      const mem = s.records.get(id) || null;
      const prev = stored && beats(stored, mem) ? stored : mem;
      const t = now();
      const rec = {
        v: SCHEMA_V, id, kind,
        m: prev ? prev.m : monthOf(anchorOf(kind, fields)),
        by: s.deviceId,
        createdAt: prev ? prev.createdAt : t,
        updatedAt: prev ? Math.max(t, prev.updatedAt + 1) : t,
        base: prev ? prev.updatedAt : 0,
        deleted: mode === 'delete',
      };
      const body = mode === 'delete' ? tombstoneOf(Object.assign({}, prev || {}, fields, rec)) : Object.assign(rec, fields);
      const out = mode === 'delete' ? body : rec;
      const bad = invalidReason(out);
      if (bad) throw new Error('marks_invalid_' + bad);
      const res = await backend.write([
        { store: 'mine', key: id, update: (cur) => (beats(out, cur) ? out : cur) },
        { store: 'meta', key: 'month:' + out.m, update: (mm) => markDirty(mm, out) },
      ]);
      s.mine.set(id, res[0]);
      if (beats(res[0], s.records.get(id))) s.records.set(id, res[0]);
      s.months.set(out.m, res[1]);
      emit();
      persistOnce();
      return out;
    }

    function markDirty(mm, r) {
      mm = mm || { seq: 0, fileId: null, md5: null, pending: {} };
      mm.seq = (mm.seq || 0) + 1;
      mm.pending = mm.pending || {};
      mm.pending[r.id] = r.updatedAt;
      return mm;
    }

    function live(id) { const r = s.records.get(id); return r && !r.deleted ? r : null; }

    const api = {
      get deviceId() { return s.deviceId; },
      get stats() {
        let badFiles = 0, badRecords = 0;
        for (const f of s.files.values()) { if (f.bad) badFiles++; badRecords += f.skipped || 0; }
        return { badFiles, badRecords };
      },
      get persisted() { return s.persisted; },
      reloadLocal,
      onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },

      get(id) { const r = s.records.get(id); return r ? JSON.parse(JSON.stringify(r)) : null; },
      // Live records, optionally one kind and those whose anchor falls in [from, to].
      list(q) {
        q = q || {};
        const out = [];
        for (const r of s.records.values()) {
          if (r.deleted && !q.withDeleted) continue;
          if (q.kind && r.kind !== q.kind) continue;
          if (q.from != null || q.to != null) {
            const a = r.kind === 'sleep' ? r.to : anchorOf(r.kind, r);
            const b = r.kind === 'sleep' ? r.from : a;
            if (q.from != null && a < q.from) continue;
            if (q.to != null && b > q.to) continue;
          }
          out.push(JSON.parse(JSON.stringify(r)));
        }
        return out;
      },
      all() { return Array.from(s.records.values()); },

      createSleep(span) {
        const from = Number(span && span.from), to = Number(span && span.to);
        return put('sleep', s.deviceId + '-' + now().toString(36) + '-' + randomId(4), { from, to });
      },
      createTap(t) {
        return put('tap', s.deviceId + '-' + now().toString(36) + '-' + randomId(4), tapFields(t));
      },
      // Sleep: { from, to }; tap: { at, cls, label }. Other fields are ignored.
      edit(id, patch) {
        const r = live(id);
        if (!r) return Promise.reject(new Error('marks_no_record'));
        if (r.kind === 'sleep') return put('sleep', id, { from: num(patch.from, r.from), to: num(patch.to, r.to) });
        if (r.kind === 'tap') {
          const f = tapFields(Object.assign({ at: r.at, cls: r.cls, label: r.label }, patch));
          if (r.replaces) f.replaces = r.replaces;
          return put('tap', id, f);
        }
        return Promise.reject(new Error('marks_not_editable'));
      },
      remove(id) {
        const r = s.records.get(id);
        if (!r || r.deleted) return Promise.resolve(r || null);
        lastLive.set(id, r);
        return put(r.kind, id, {}, 'delete');
      },
      // fields: the live fields to bring back; defaults to the version this page deleted, a rev's row or a target.
      restore(id, fields) {
        const r = s.records.get(id);
        if (!r || !r.deleted) return Promise.reject(new Error('marks_not_deleted'));
        let f = fields || null;
        if (!f && r.kind === 'rev') f = { row: r.row };
        if (!f && lastLive.has(id)) {
          const p = lastLive.get(id);
          f = {};
          for (const k of Object.keys(p)) if (COMMON.indexOf(k) < 0) f[k] = p[k];
        }
        if (!f && r.target) f = { target: r.target };
        if (!f) return Promise.reject(new Error('marks_restore_needs_fields'));
        return put(r.kind, id, f);
      },
      // Hides a recorded row: { ep, k?, label, iid? }. A reversed rev is restored, never duplicated.
      reverse(row) {
        const label = cleanFactField(row.label);
        const r = { ep: Number(row.ep), k: row.k || factKind(label), label };
        if (row.iid) r.iid = String(row.iid);
        const id = revId(r);
        const cur = s.records.get(id);
        if (cur && !cur.deleted) return Promise.resolve(cur);
        return put('rev', id, { row: r });
      },
      unreverse(row) {
        const label = cleanFactField(row.label);
        return api.remove(revId({ ep: Number(row.ep), k: row.k || factKind(label), label }));
      },
      // Edit of a recorded mark: a rev of the row plus a tap that replaces it.
      async editRecorded(row, t) {
        const rev = await api.reverse(row);
        const id = s.deviceId + '-' + now().toString(36) + '-' + randomId(4);
        const f = tapFields(t);
        f.replaces = rev.id;
        const tap = await put('tap', id, f);
        return { rev, tap };
      },

      // ---- sync helpers (marks-drive.js) ----
      months() { return new Map(Array.from(s.months, ([m, v]) => [m, JSON.parse(JSON.stringify(v))])); },
      dirtyMonths() { return Array.from(s.months).filter(([, v]) => v && Object.keys(v.pending || {}).length).map(([m]) => m); },
      dirtyCount() { let n = 0; for (const v of s.months.values()) n += Object.keys((v && v.pending) || {}).length; return n; },
      fileName(m) { return 'marks_' + m + '_' + s.deviceId + '.json'; },
      files() { return s.files; },
      // Re-reads mine and the month entry from storage, so another page's writes are included.
      async snapshotMonth(m) {
        const all = await backend.readMany(['mine', 'meta']);
        const mmEntry = all.meta.find(([k]) => k === 'month:' + m);
        const mm = mmEntry ? mmEntry[1] : null;
        const recs = all.mine.map(([, r]) => r).filter(r => r && r.m === m);
        return { body: fileBody(s.deviceId, m, recs), records: recs, month: mm || { seq: 0, fileId: null, md5: null, pending: {} } };
      },
      // After an upload: keep the id and md5; clear pending only for what the body carried, all of it when seq held.
      async uploaded(m, snap, fileId, md5) {
        const carried = {};
        for (const r of snap.records) carried[r.id] = r.updatedAt;
        const res = await backend.write([
          { store: 'meta', key: 'month:' + m, update: (mm) => {
            mm = mm || { seq: 0, pending: {} };
            mm.fileId = fileId;
            mm.md5 = md5 || null;
            if (mm.seq === snap.month.seq) mm.pending = {};
            else for (const id of Object.keys(mm.pending || {})) if (carried[id] === mm.pending[id]) delete mm.pending[id];
            return mm;
          } },
          { store: 'files', key: fileId, value: { name: api.fileName(m), md5: md5 || null, records: snap.records } },
        ]);
        s.months.set(m, res[0]);
        s.files.set(fileId, { name: api.fileName(m), md5: md5 || null, records: snap.records });
        emit();
      },
      async setMonthFile(m, fileId) {
        const res = await backend.write([{ store: 'meta', key: 'month:' + m, update: (mm) => {
          mm = mm || { seq: 0, pending: {} };
          if (mm.fileId !== fileId) { mm.fileId = fileId; mm.md5 = null; }
          return mm;
        } }]);
        s.months.set(m, res[0]);
      },
      // The own file vanished: forget its id; every record of the month is pending again so it is recreated.
      async forgetMonthFile(m) {
        const recs = Array.from(s.mine.values()).filter(r => r.m === m);
        const res = await backend.write([{ store: 'meta', key: 'month:' + m, update: (mm) => {
          mm = mm || { seq: 0, pending: {} };
          mm.fileId = null; mm.md5 = null;
          mm.seq = (mm.seq || 0) + 1;
          mm.pending = mm.pending || {};
          for (const r of recs) mm.pending[r.id] = r.updatedAt;
          return mm;
        } }]);
        s.months.set(m, res[0]);
      },
      // Replaces the cached Drive files with a listing's result; returns true when the merged view changed.
      async applyFiles(entries) {
        const ops = [];
        const keep = new Set(entries.keep || []);
        for (const id of s.files.keys()) if (!keep.has(id) && !(entries.put && entries.put.has(id))) ops.push({ store: 'files', key: id, del: true });
        if (entries.put) for (const [id, f] of entries.put) ops.push({ store: 'files', key: id, value: f });
        if (ops.length) await backend.write(ops);
        for (const op of ops) { if (op.del) s.files.delete(op.key); else s.files.set(op.key, op.value); }
        const changed = recompute();
        const prop = await propagateTombstones();
        if (changed || prop) emit();
        return changed || prop;
      },
      // The oldest own copy on Drive becomes this month's file; every record of the month is pending so it holds all.
      async adoptMonthFile(m, fileId) {
        const recs = Array.from(s.mine.values()).filter(r => r.m === m);
        const res = await backend.write([{ store: 'meta', key: 'month:' + m, update: (mm) => {
          mm = mm || { seq: 0, pending: {} };
          mm.fileId = fileId; mm.md5 = null;
          mm.seq = (mm.seq || 0) + 1;
          mm.pending = mm.pending || {};
          for (const r of recs) mm.pending[r.id] = r.updatedAt;
          return mm;
        } }]);
        s.months.set(m, res[0]);
      },
      async cacheFile(fileId, entry) {
        await backend.write([{ store: 'files', key: fileId, value: entry }]);
        s.files.set(fileId, entry);
      },
      // Marks sync for the first account seen on this device; another account gets none of them.
      async bindAccount(key) {
        const res = await backend.write([{ store: 'meta', key: 'account', update: (prev) => prev || key }]);
        return res[0];
      },
      async destroy() { await backend.destroy(); },
    };

    // A newer tombstone from another device is copied as is into this device's own file.
    async function propagateTombstones() {
      const ops = [];
      for (const r of s.records.values()) {
        if (!r.deleted || r.by === s.deviceId) continue;
        const have = s.mine.get(r.id);
        if (have && !beats(r, have)) continue;
        ops.push({ store: 'mine', key: r.id, update: (cur) => (beats(r, cur) ? r : cur) });
        ops.push({ store: 'meta', key: 'month:' + r.m, update: (mm) => markDirty(mm, r) });
      }
      if (!ops.length) return false;
      const res = await backend.write(ops);
      for (let i = 0; i < ops.length; i += 2) {
        s.mine.set(ops[i].key, res[i]);
        s.months.set(ops[i + 1].key.slice(6), res[i + 1]);
      }
      return true;
    }

    await reloadLocal();
    return api;
  }

  function num(v, d) { const n = Number(v); return v == null || !Number.isFinite(n) ? d : n; }
  function tapFields(t) {
    t = t || {};
    const cls = ['sym', 'ctx', 'note'].indexOf(t.cls) >= 0 ? t.cls : 'note';
    return { at: Number(t.at), cls, label: cleanFactField(t.label == null ? '' : String(t.label)) };
  }

  // The event label a tap shows as, in the recording's own event-cell form.
  function tapEventLabel(r) { return r.cls === 'note' ? r.label : r.cls + ':' + (r.label || (r.cls === 'sym' ? 'symptom' : 'context')); }

  // Display-time composition. events: [{ t, label, ep }] from summarizeCSV (or a day stitch).
  // records: store.all(). scope: { originEp, fromEp, toEp, addTaps (default true) }.
  // Returns { events, sleep: [{ start, end, id }] (minutes from originEp), hidden }.
  function applyMarks(events, records, scope) {
    scope = scope || {};
    const revs = new Set();
    const taps = [], sleeps = [];
    for (const r of (records || [])) {
      if (!r || r.deleted || APPLIED.indexOf(r.kind) < 0) continue;
      if (r.kind === 'rev') revs.add(r.row.ep + '|' + r.row.k + '|' + r.row.label);
      else if (r.kind === 'tap') taps.push(r);
      else sleeps.push(r);
    }
    const origin = Number(scope.originEp) || 0;
    const from = scope.fromEp != null ? scope.fromEp : -Infinity;
    const to = scope.toEp != null ? scope.toEp : Infinity;
    const out = [];
    let hidden = 0;
    for (const e of (events || [])) {
      if (e && e.ep != null && revs.size) {
        const label = cleanFactField(e.label);
        if (revs.has(e.ep + '|' + factKind(label) + '|' + label)) { hidden++; continue; }
      }
      out.push(e);
    }
    if (scope.addTaps !== false) {
      for (const r of taps) {
        if (r.at < from || r.at > to) continue;
        out.push({ t: (r.at - origin) / 60000, ep: r.at, label: tapEventLabel(r), markId: r.id });
      }
      out.sort((a, b) => a.t - b.t);
    }
    const sleep = [];
    for (const r of sleeps) {
      const a = Math.max(r.from, from), b = Math.min(r.to, to);
      if (b <= a) continue;
      sleep.push({ start: (a - origin) / 60000, end: (b - origin) / 60000, markId: r.id, fromMark: true });
    }
    sleep.sort((x, y) => x.start - y.start);
    return { events: out, sleep, hidden };
  }

  // Detected windows stay outside the marked ones; marked windows win inside.
  function composeSleep(detected, marked) {
    if (!marked || !marked.length) return detected;
    const out = [];
    for (const w of (detected || [])) {
      let parts = [[w.start, w.end]];
      for (const m of marked) {
        const next = [];
        for (const [a, b] of parts) {
          if (m.end <= a || m.start >= b) { next.push([a, b]); continue; }
          if (m.start > a) next.push([a, m.start]);
          if (m.end < b) next.push([m.end, b]);
        }
        parts = next;
      }
      for (const [a, b] of parts) if (b - a >= 1) out.push(Object.assign({}, w, { start: a, end: b }));
    }
    return out.concat(marked).sort((x, y) => x.start - y.start);
  }

  const api = {
    SCHEMA_V, KINDS, APPLIED, COMMON, FILE_RE, DB_NAME, UNDO_LIMIT_MS, FACT_FIELD_MAX,
    cleanFactField, fnv8, monthOf, factKind, revId, invalidReason, beats, tombstoneOf,
    fileBody, parseFileBody, applyMarks, composeSleep, tapEventLabel,
    memoryBackend, idbBackend, open,
  };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AortiMarks = api;
})(typeof self !== 'undefined' ? self : this);
