// Web recorder: one Recording per session, saved to the user's folder and to Drive. Rules, states, results and
// scenarios are in docs/web-recorder.md; the numbers in comments below are its rules. No DOM, no page state: the
// page hands the data, the folder and Drive in through env and reads results off the Recording.
(function (root) {
  'use strict';

  const MB = 1048576;
  const API = 'https://www.googleapis.com/drive/v3';
  const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';

  function create(env) {
    const now = env.now || (() => Date.now());
    const tickMs = env.tickMs || 10000;
    const saveBig = env.saveBig || 512 * 1024;
    const maxStrikes = env.strikes || 3;
    const settleMs = env.settleMs == null ? 5000 : env.settleMs;
    const paceMinMs = env.paceMinMs || 60000, paceMaxMs = env.paceMaxMs || 600000;
    // Above saveBig: one rebuild a minute, for ticks and forced writes alike. Below: forced writes 10 s apart.
    const rebuildMs = env.rebuildMs || 60000, forcedMs = env.forcedMs || 10000;
    const lookupMs = env.lookupMs || 60000;
    const warn = env.warn || (() => {});
    const sleep = (ms) => new Promise((r) => env.setTimeout(r, ms));
    const driveOn = () => !!env.token() && !!env.syncOn();
    const pace = (bytes) => Math.min(paceMaxMs, Math.max(paceMinMs, (bytes / MB) * 60000));

    // The current Recording; the module's only state.
    let cur = null;

    function byteLength(s) {
      if (typeof TextEncoder === 'function') return new TextEncoder().encode(s).length;
      let n = 0;
      for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i);
        if (c < 0x80) n += 1; else if (c < 0x800) n += 2; else if (c >= 0xd800 && c <= 0xdbff) { n += 4; i++; } else n += 3;
      }
      return n;
    }
    function nameAt(ms) { return 'hrv_session_' + new Date(ms).toISOString().slice(0, 19).replace(/:/g, '-') + '.csv'; }
    // 13: a status belongs to the Recording on screen.
    function status(rec, text, cls) { if (cur === rec && env.onStatus) env.onStatus(text, cls || ''); }

    function recording(id, startMs, dir) {
      return {
        id, startMs, filename: null, text: null, dir: dir || null, file: null, driveFileId: null, login: null,
        rows: 0, bytes: 0, builtAt: 0, driveAt: 0, forcedAt: 0, folderBusy: null, upload: null, strikes: 0,
        state: 'arming', seen: { folder: !!dir, drive: false }, folderName: dir ? (dir.name || 'folder') : null,
        wrote: { folder: false, drive: false }, result: { folder: null, drive: null },
        final: null, interval: null,
        // pick: the newest folder pick; pending: its createFile. pendingDir: a pick made while arming (15).
        // noStatus: a routine PATCH on driveFileId ended with no HTTP status (4). finalFailed: a final write was
        // made and did not land (13).
        pick: 0, pending: null, pendingDir: undefined, noStatus: false, lookupAt: 0, finalFailed: false,
      };
    }

    function build(rec) {
      const text = env.buildCsv(rec.id);
      if (text == null) return null;
      rec.rows = env.rowCount ? env.rowCount() : 0;
      rec.bytes = byteLength(text);
      rec.builtAt = now();
      return text;
    }

    // 6: the Drive folder is looked up at Start and at most once a minute after while it is unknown.
    function lookupFolder(rec) {
      if (env.folderId() != null) return;
      rec.lookupAt = now();
      Promise.resolve().then(() => env.ensureFolder()).catch((e) => warn('Drive folder:', e));
    }

    // 2: the previous Recording is stopped first; its final keeps running on its own file and Drive file.
    function start(id, startMs, dir) {
      if (cur && cur.state !== 'done') stop();
      const prev = cur;
      const rec = recording(id, startMs, dir);
      const at = startMs || now();
      let name = nameAt(at);
      if (prev && prev.filename === name) name = nameAt(at + 1000);
      rec.filename = name;
      cur = rec;
      if (driveOn()) { rec.seen.drive = true; lookupFolder(rec); }
      rec.interval = env.setInterval(function recorderTick() { return routine(rec); }, tickMs);
      arm(rec);
      return rec;
    }

    // Arming: the folder permission, then this session's file. A Stop meanwhile drops whatever createFile returns (7).
    async function arm(rec) {
      if (rec.dir) {
        const dir = rec.dir, pick = rec.pick;
        let ok = false;
        try { ok = await env.ensurePermission(dir); } catch (e) { ok = false; }
        if (rec.state !== 'arming') return;
        if (!ok) {
          if (rec.pick === pick) status(rec, 'denied', 'denied');
        } else {
          try {
            const handle = await env.createFile(dir, rec.filename);
            if (rec.state === 'arming' && rec.pick === pick) { rec.file = handle; status(rec, 'writing', 'writing'); }
          } catch (e) {
            warn('folder file:', e);
            if (rec.state === 'arming' && rec.pick === pick) status(rec, 'error', 'error');
          }
        }
      }
      if (rec.state !== 'arming') return;
      rec.state = 'live';
      if (rec.pendingDir !== undefined) { const d = rec.pendingDir; rec.pendingDir = undefined; applyFolder(rec, d); }
    }

    // 15: a pick clears the file and ends the old handle's claim; the newest pick's createFile is the one taken.
    function applyFolder(rec, dir) {
      rec.pick++;
      const pick = rec.pick;
      rec.file = null;
      rec.folderBusy = null;
      rec.strikes = 0;
      rec.dir = dir || null;
      if (!dir) { rec.pending = null; return; }
      rec.seen.folder = true;
      let p;
      p = (async () => {
        try {
          const handle = await env.createFile(dir, rec.filename);
          if (rec.pick !== pick) return;
          rec.file = handle; rec.folderName = dir.name || 'folder';
          if (rec.state === 'live') status(rec, 'writing', 'writing');
        } catch (e) {
          warn('folder file:', e);
          if (rec.pick !== pick) return;
          rec.file = null; rec.folderName = dir.name || 'folder';
          if (rec.state === 'live') status(rec, 'error', 'error');
        } finally { if (rec.pending === p) rec.pending = null; }
      })();
      rec.pending = p;
    }

    function folderChanged(dir) {
      const rec = cur;
      if (!rec || rec.state === 'stopping' || rec.state === 'done') return;
      if (rec.state === 'arming') {
        rec.pick++;
        rec.dir = dir || null;
        if (dir) rec.seen.folder = true;
        rec.pendingDir = dir || null;
        return;
      }
      applyFolder(rec, dir);
    }

    function authChanged() {
      const rec = cur;
      if (!rec || (rec.state !== 'arming' && rec.state !== 'live')) return;
      if (driveOn()) { rec.seen.drive = true; rec.lookupAt = 0; }
    }

    // 3, 11: a tick builds once, for the targets whose pace allows, only while arming (Drive) or live.
    function routine(rec) {
      if (rec.state !== 'arming' && rec.state !== 'live') return Promise.resolve();
      const t = now();
      if (driveOn()) {
        rec.seen.drive = true;
        if (env.folderId() == null && t - rec.lookupAt >= lookupMs) lookupFolder(rec);
      }
      const canBuild = rec.bytes <= saveBig || t - rec.builtAt >= rebuildMs;
      const folderWants = rec.state === 'live' && !!rec.file && !rec.folderBusy && canBuild;
      const driveWants = driveOn() && env.folderId() != null && !rec.upload && t - rec.driveAt >= pace(rec.bytes) && canBuild;
      if (!folderWants && !driveWants) return Promise.resolve();
      const text = build(rec);
      if (text == null) return Promise.resolve();
      const jobs = [];
      if (folderWants) jobs.push(folderWrite(rec, rec.file, text, false));
      if (driveWants) jobs.push(driveUpload(rec, text, rec.bytes, false));
      return Promise.all(jobs).then(() => {});
    }

    // 12: hidden or closing, in live only: a forced write when rows grew, paced.
    function forced(rec) {
      if (!rec || rec.state !== 'live') return;
      const rows = env.rowCount ? env.rowCount() : 0;
      if (rows <= rec.rows) return;
      const t = now();
      if (t - rec.forcedAt < (rec.bytes > saveBig ? rebuildMs : forcedMs)) return;
      const folderWants = !!rec.file && !rec.folderBusy;
      const driveWants = driveOn() && env.folderId() != null && !rec.upload && t - rec.driveAt >= pace(rec.bytes);
      if (!folderWants && !driveWants) return;
      rec.forcedAt = t;
      const text = build(rec);
      if (text == null) return;
      if (folderWants) folderWrite(rec, rec.file, text, false);
      if (driveWants) driveUpload(rec, text, rec.bytes, false);
    }
    function hidden() { forced(cur); }
    function closing() { forced(cur); }

    // 4, 10, 15: the one folder write of a Recording; its outcome counts only while the handle is still the file.
    async function folderWrite(rec, handle, text, final) {
      let p;
      try { p = Promise.resolve(env.writeFile(handle, text)); } catch (e) { p = Promise.reject(e); }
      const job = { p, handle };
      rec.folderBusy = job;
      let ok = false;
      try { await p; ok = true; } catch (e) { warn('folder write:', e); }
      if (rec.folderBusy === job) rec.folderBusy = null;
      if (rec.file !== handle) return undefined;
      if (ok) {
        rec.wrote.folder = true;
        if (rec.strikes) { rec.strikes = 0; if (!final) status(rec, 'writing', 'writing'); }
        return true;
      }
      rec.strikes++;
      status(rec, 'write error (' + rec.strikes + '/' + maxStrikes + ')', 'error');
      if (rec.strikes >= maxStrikes) rec.file = null;
      return false;
    }

    async function header() {
      try { return await env.authHeader(); } catch (e) { warn('Drive auth:', e); return null; }
    }
    // null when the request ended with no HTTP status.
    async function send(url, init) {
      try { return await env.fetch(url, init); } catch (e) { warn('Drive:', e); return null; }
    }

    // 4: the one Drive upload of a Recording at a time. true: the text reached Drive; false: it did not;
    // undefined: nothing was sent (signed out, sync off, no folder, or a routine save whose state has passed).
    function driveUpload(rec, text, bytes, final) {
      let p;
      p = uploadRun(rec, text, bytes, final).catch((e) => { warn('Drive upload:', e); return false; })
        .finally(() => { if (rec.upload === p) rec.upload = null; });
      rec.upload = p;
      return p;
    }

    async function uploadRun(rec, text, bytes, final) {
      const routineOk = () => rec.state === 'live' || rec.state === 'arming';
      if (!final && !routineOk()) return undefined;
      // 9: a routine 5xx waits for the next pace from the attempt.
      if (!final) rec.driveAt = now();
      let refreshed = false, retried = false, recreated = false, created = false;
      for (;;) {
        const h = await header();
        if (!final && !routineOk()) return undefined;
        // 8: token, folder id and login tag read together after the last await before the request.
        const token = env.token(), folderId = env.folderId(), login = env.loginTag();
        if (!token || !env.syncOn()) return undefined;
        if (login != null) {
          if (rec.login != null && login !== rec.login) { rec.driveFileId = null; rec.noStatus = false; }
          rec.login = login;
        }
        if (h == null) {
          if (final && !retried) { retried = true; continue; }
          return fail(rec, final, 'Drive auth failed');
        }
        const patching = !!rec.driveFileId;
        if (!patching && folderId == null) return undefined;
        let url, init;
        if (patching) {
          url = UPLOAD + '/files/' + encodeURIComponent(rec.driveFileId) + '?uploadType=media';
          init = { method: 'PATCH', headers: { 'Authorization': h, 'Content-Type': 'text/csv' }, body: text };
        } else {
          const boundary = '-------hr-monitor-' + Math.random().toString(36).slice(2);
          const meta = JSON.stringify({ name: rec.filename, parents: [folderId], mimeType: 'text/csv' });
          url = UPLOAD + '/files?uploadType=multipart&fields=id';
          init = { method: 'POST', headers: { 'Authorization': h, 'Content-Type': 'multipart/related; boundary=' + boundary },
            body: `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n--${boundary}\r\nContent-Type: text/csv\r\n\r\n${text}\r\n--${boundary}--` };
        }
        const resp = await send(url, init);
        if (resp == null) {
          // 4: a dropped routine PATCH may still commit; the final checks the size after its own.
          if (patching && !final) rec.noStatus = true;
          if (final && !retried) { retried = true; continue; }
          return fail(rec, final, 'Drive ' + (patching ? 'patch' : 'create') + ' failed');
        }
        if (resp.status === 401 && !refreshed) {
          refreshed = true;
          try { await env.refresh(); } catch (e) { warn('Drive refresh:', e); }
          continue;
        }
        if (patching && (resp.status === 403 || resp.status === 404) && !recreated) {
          recreated = true;
          rec.driveFileId = null; rec.noStatus = false;
          continue;
        }
        if (!resp.ok) {
          if (final && !retried && resp.status >= 500) { retried = true; continue; }
          return fail(rec, final, 'Drive ' + (patching ? 'patch' : 'create') + ' HTTP ' + resp.status);
        }
        if (!patching) {
          let id = null;
          try { id = (await resp.json()).id; } catch (e) { id = null; }
          // 8: a create whose login changed in flight belongs to the old login; the final creates once more.
          const after = env.loginTag();
          if (after != null && login != null && after !== login) {
            rec.login = after; rec.driveFileId = null; rec.noStatus = false;
            if (!final) return undefined;
            if (!created) { created = true; continue; }
          } else if (id) { rec.driveFileId = id; rec.noStatus = false; }
        }
        rec.wrote.drive = true;
        if (!final) { status(rec, 'synced', 'ok'); return true; }
        if (patching && rec.noStatus) return verifySize(rec, text, bytes);
        return true;
      }
    }
    function fail(rec, final, msg) {
      if (!final) status(rec, 'drive error: ' + msg, 'error');
      return false;
    }

    // 4: after a dropped routine PATCH, the final's size is read back; a mismatch gets one more PATCH and one more read.
    async function verifySize(rec, text, bytes) {
      await sleep(settleMs);
      if (!driveOn()) return false;
      let size = await readSize(rec);
      if (size == null) return false;
      if (size === bytes) return true;
      if (!(await patchOnce(rec, text))) return false;
      size = await readSize(rec);
      return size === bytes;
    }
    async function readSize(rec) {
      for (let i = 0; i < 2; i++) {
        const h = await header();
        if (h == null || !driveOn()) return null;
        const resp = await send(API + '/files/' + encodeURIComponent(rec.driveFileId) + '?fields=size', { method: 'GET', headers: { 'Authorization': h } });
        if (resp == null) return null;
        if (resp.status === 401 && i === 0) { try { await env.refresh(); } catch (e) {} continue; }
        if (!resp.ok) return null;
        try { const n = Number((await resp.json()).size); return Number.isFinite(n) ? n : null; } catch (e) { return null; }
      }
      return null;
    }
    async function patchOnce(rec, text) {
      for (let i = 0; i < 2; i++) {
        const h = await header();
        if (h == null || !driveOn()) return false;
        const resp = await send(UPLOAD + '/files/' + encodeURIComponent(rec.driveFileId) + '?uploadType=media', { method: 'PATCH', headers: { 'Authorization': h, 'Content-Type': 'text/csv' }, body: text });
        if (resp == null) return false;
        if (resp.status === 401 && i === 0) { try { await env.refresh(); } catch (e) {} continue; }
        return !!resp.ok;
      }
      return false;
    }

    // 14: a target's result once its final write has settled or there was none to make.
    function settle(rec, target, saved, attempted) {
      rec.result[target] = saved ? 'saved' : (rec.wrote[target] ? 'failed' : 'unwritten');
      if (attempted && !saved) rec.finalFailed = true;
    }

    // 4, 5: the folder final waits for the newest pick's file and the write in flight on it, however long.
    async function folderFinal(rec, text) {
      while (rec.pending) { const p = rec.pending; try { await p; } catch (e) {} if (rec.pending === p) rec.pending = null; }
      while (rec.folderBusy) { const b = rec.folderBusy; try { await b.p; } catch (e) {} if (rec.folderBusy === b) rec.folderBusy = null; }
      if (!rec.file) { settle(rec, 'folder', false, false); return; }
      const ok = await folderWrite(rec, rec.file, text, true);
      settle(rec, 'folder', ok === true, true);
    }

    // 4, 5: the Drive final waits for the routine upload in flight, looks the folder up if unknown, then uploads.
    async function driveFinal(rec, text, bytes) {
      while (rec.upload) { const p = rec.upload; try { await p; } catch (e) {} if (rec.upload === p) rec.upload = null; }
      if (!driveOn()) { settle(rec, 'drive', false, false); return; }
      if (env.folderId() == null) { try { await env.ensureFolder(); } catch (e) { warn('Drive folder:', e); } }
      if (!driveOn() || env.folderId() == null) { settle(rec, 'drive', false, false); return; }
      const ok = await driveUpload(rec, text, bytes, true);
      settle(rec, 'drive', ok === true, ok !== undefined);
    }

    function finish(rec) {
      rec.state = 'done';
      if (cur !== rec || rec.finalFailed) return;
      if (rec.dir || rec.seen.folder) status(rec, 'idle', '');
    }

    // The final text is built here, before any await (S7); every later step writes that text.
    function stop() {
      const rec = cur;
      if (!rec) return null;
      if (rec.final) return rec;
      if (rec.interval != null) { env.clearInterval(rec.interval); rec.interval = null; }
      const fromArming = rec.state === 'arming';
      rec.state = 'stopping';
      rec.pendingDir = undefined;
      if (driveOn()) rec.seen.drive = true;
      const text = build(rec);
      rec.text = text;
      rec.result.folder = rec.seen.folder ? (text == null ? 'unwritten' : 'pending') : null;
      rec.result.drive = rec.seen.drive ? (text == null ? 'unwritten' : 'pending') : null;
      const jobs = [];
      if (rec.result.folder === 'pending') {
        // 7: a Stop while arming writes no folder file.
        if (fromArming) settle(rec, 'folder', false, false);
        else jobs.push(folderFinal(rec, text));
      }
      if (rec.result.drive === 'pending') jobs.push(driveFinal(rec, text, rec.bytes));
      if (jobs.length) status(rec, 'saving', 'writing');
      rec.final = Promise.all(jobs).then(() => { finish(rec); return rec; });
      return rec;
    }

    function targets() {
      const rec = cur;
      const on = !!rec && (rec.state === 'arming' || rec.state === 'live');
      return {
        folder: !!(on && (rec.file || rec.pending || (rec.state === 'arming' && rec.dir))),
        drive: !!(on && driveOn() && env.folderId() != null),
      };
    }
    function current() { return cur; }

    return { start, stop, hidden, closing, folderChanged, authChanged, targets, current };
  }

  const api = { create };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AortiRecorder = api;
})(typeof self !== 'undefined' ? self : this);
