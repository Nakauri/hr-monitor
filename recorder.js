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
    // Waits for a write or create to finish either way; its own path has already counted the outcome.
    const settled = (p) => Promise.resolve(p).then(() => true, () => false);
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
    // 13: after Stop, routine outcomes leave "saving" alone.
    function routineStatus(rec, text, cls) { if (rec.state === 'live' || rec.state === 'arming') status(rec, text, cls); }

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
        pick: 0, pending: null, pendingDir: undefined, noStatus: false, lookupAt: 0, finalFailed: false, failMsg: null, owed: false,
        // enterSeq: entries the page committed (21); builtSeq: as of the last build; folderSavedSeq: as of the last
        // text that landed in the folder file.
        enterSeq: 0, builtSeq: 0, folderSavedSeq: 0,
      };
    }

    function build(rec) {
      const text = env.buildCsv(rec.id);
      if (text == null) return null;
      rec.rows = env.rowCount ? env.rowCount() : 0;
      rec.bytes = byteLength(text);
      rec.builtAt = now();
      rec.builtSeq = rec.enterSeq;
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
      // File names only move forward, so no Start reopens an earlier session's file.
      let sec = Math.floor((startMs || now()) / 1000) * 1000;
      if (prev && sec <= prev.nameSec) sec = prev.nameSec + 1000;
      rec.nameSec = sec;
      rec.filename = nameAt(sec);
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
        } else if (rec.pick === pick) {
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
          payOwed(rec);
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

    // 5: a Drive file already made needs no folder id; only a create does.
    function driveReady(rec) { return driveOn() && (!!rec.driveFileId || env.folderId() != null); }

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
      const driveWants = driveReady(rec) && !rec.upload && t - rec.driveAt >= pace(rec.bytes) && canBuild;
      if (!folderWants && !driveWants) return Promise.resolve();
      const text = build(rec);
      if (text == null) return Promise.resolve();
      const jobs = [];
      if (folderWants) jobs.push(folderWrite(rec, rec.file, text, false));
      if (driveWants) jobs.push(driveUpload(rec, text, rec.bytes, false));
      return Promise.all(jobs).then(() => {});
    }

    // 12: hidden or closing, in live only: a forced write when rows grew, paced. Urgent when the page committed
    // something the user entered (a mark, a note) since the last text sent to the folder: it skips the pacing, and a
    // folder write in flight leaves the folder owed one write of fresh text when it settles (21).
    function forced(rec, atClose) {
      if (!rec || rec.state !== 'live') return;
      const urgent = rec.enterSeq > rec.folderSavedSeq;
      const rows = env.rowCount ? env.rowCount() : 0;
      // An entry not yet landed is written even with no new rows (its last write may have failed).
      if (rows <= rec.rows && !urgent) return;
      const t = now();
      // Above saveBig the tick's limit is shared (builtAt); below it, forced writes 10 s apart, except at close.
      if (!urgent && (rec.bytes > saveBig ? t - rec.builtAt < rebuildMs : !atClose && t - rec.forcedAt < forcedMs)) return;
      if (urgent && rec.file && rec.folderBusy) rec.owed = true;
      const folderWants = !!rec.file && !rec.folderBusy;
      const driveWants = driveReady(rec) && !rec.upload && t - rec.driveAt >= pace(rec.bytes);
      if (!folderWants && !driveWants) return;
      rec.forcedAt = t;
      const text = build(rec);
      if (text == null) return;
      if (folderWants) folderWrite(rec, rec.file, text, false);
      if (driveWants) driveUpload(rec, text, rec.bytes, false);
    }
    function hidden() { forced(cur, false); }
    function closing() { forced(cur, true); }
    // 21: the page committed something the user entered.
    function entered() { if (cur && (cur.state === 'live' || cur.state === 'arming')) cur.enterSeq++; }

    // 21: an owed write goes to whatever the file is now, with text built now, once nothing holds the folder; never
    // after Stop (the final carries everything) and never to a handle that was dropped.
    function payOwed(rec) {
      if (!rec.owed || rec.state !== 'live' || !rec.file || rec.folderBusy) return;
      rec.owed = false;
      const text = build(rec);
      if (text != null) folderWrite(rec, rec.file, text, false);
    }

    // 4, 10, 15: the one folder write of a Recording; then any owed write (21).
    async function folderWrite(rec, handle, text, final) {
      const r = await folderWriteOnce(rec, handle, text, final);
      payOwed(rec);
      return r;
    }
    // Its outcome counts only while the handle is still the file.
    async function folderWriteOnce(rec, handle, text, final) {
      // Every caller built the text just before this call; its entries count as saved only once it lands.
      const seq = rec.builtSeq;
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
        if (seq > rec.folderSavedSeq) rec.folderSavedSeq = seq;
        if (rec.strikes) { rec.strikes = 0; if (!final) routineStatus(rec, 'writing', 'writing'); }
        return true;
      }
      rec.strikes++;
      // 13: a final's failure shows once nothing is pending.
      if (final) rec.failMsg = 'write error (' + rec.strikes + '/' + maxStrikes + ')';
      else routineStatus(rec, 'write error (' + rec.strikes + '/' + maxStrikes + ')', 'error');
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
      let refreshed = false, retried = false, recreated = false, created = false, looked = false, repinned = false;
      for (;;) {
        // 8: the header can belong to the login pinned before its await; a change re-pins once, then nothing is sent.
        const pin = env.loginTag();
        const h = await header();
        if (!final && !routineOk()) return undefined;
        // 8: token, folder id and login tag read together after the last await before the request.
        const token = env.token(), folderId = env.folderId(), login = env.loginTag();
        if (login != null && login !== pin) {
          if (repinned) return undefined;
          repinned = true;
          continue;
        }
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
        if (!patching && folderId == null) {
          // 5, 8: a final that must create (the login changed, or a 403/404 cleared the file) looks the folder up once.
          if (!final) return undefined;
          if (looked) return fail(rec, final, 'Drive folder not found');
          looked = true;
          try { await env.ensureFolder(); } catch (e) { warn('Drive folder:', e); }
          continue;
        }
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
        if (!final) { routineStatus(rec, 'synced', 'ok'); return true; }
        if (patching && rec.noStatus) return verifySize(rec, text, bytes);
        return true;
      }
    }
    function fail(rec, final, msg) {
      if (final) rec.failMsg = 'drive error: ' + msg;
      else routineStatus(rec, 'drive error: ' + msg, 'error');
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
    // 8: a login other than the file's, or one that changed across the header await; its header never reaches the file.
    function loginMoved(rec, pin) {
      const now = env.loginTag();
      return now != null && ((pin != null && now !== pin) || (rec.login != null && now !== rec.login));
    }
    async function readSize(rec) {
      for (let i = 0; i < 2; i++) {
        const pin = env.loginTag();
        const h = await header();
        if (h == null || !driveOn() || loginMoved(rec, pin)) return null;
        const resp = await send(API + '/files/' + encodeURIComponent(rec.driveFileId) + '?fields=size', { method: 'GET', headers: { 'Authorization': h } });
        if (resp == null) return null;
        if (resp.status === 401 && i === 0) { try { await env.refresh(); } catch (e) { warn('Drive refresh:', e); } continue; }
        if (!resp.ok) return null;
        try { const n = Number((await resp.json()).size); return Number.isFinite(n) ? n : null; } catch (e) { return null; }
      }
      return null;
    }
    async function patchOnce(rec, text) {
      for (let i = 0; i < 2; i++) {
        const pin = env.loginTag();
        const h = await header();
        if (h == null || !driveOn() || loginMoved(rec, pin)) return false;
        const resp = await send(UPLOAD + '/files/' + encodeURIComponent(rec.driveFileId) + '?uploadType=media', { method: 'PATCH', headers: { 'Authorization': h, 'Content-Type': 'text/csv' }, body: text });
        if (resp == null) return false;
        if (resp.status === 401 && i === 0) { try { await env.refresh(); } catch (e) { warn('Drive refresh:', e); } continue; }
        return !!resp.ok;
      }
      return false;
    }

    // 14: a target's result once its final write has settled or there was none to make.
    function settle(rec, target, saved, attempted) {
      rec.result[target] = saved ? 'saved' : (rec.wrote[target] ? 'failed' : 'unwritten');
      if (attempted && !saved) {
        rec.finalFailed = true;
        if (!rec.failMsg) rec.failMsg = target === 'drive' ? 'drive error: Drive upload not confirmed' : 'write error';
      }
    }

    // 4, 5: the folder final waits for the newest pick's file and the write in flight on it, however long.
    async function folderFinal(rec, text) {
      while (rec.pending) { const p = rec.pending; await settled(p); if (rec.pending === p) rec.pending = null; }
      while (rec.folderBusy) { const b = rec.folderBusy; await settled(b.p); if (rec.folderBusy === b) rec.folderBusy = null; }
      // 13: a folder dropped by three failed writes is a failure to show, not a quiet idle.
      if (!rec.file) {
        if (rec.dir && rec.strikes >= maxStrikes) rec.failMsg = rec.failMsg || 'write error (' + maxStrikes + '/' + maxStrikes + ')';
        settle(rec, 'folder', false, !!(rec.dir && rec.strikes >= maxStrikes));
        return;
      }
      const ok = await folderWrite(rec, rec.file, text, true);
      settle(rec, 'folder', ok === true, true);
    }

    // 4, 5: the Drive final waits for the routine upload in flight, looks the folder up if unknown, then uploads.
    async function driveFinal(rec, text, bytes) {
      // 14: a sign-out during the wait settles the result then, checked each tick, not when a hung upload ends.
      while (rec.upload) {
        const p = rec.upload;
        const done = await Promise.race([p.then(() => true, () => true), sleep(tickMs).then(() => false)]);
        if (!driveOn()) { settle(rec, 'drive', false, false); return; }
        if (done && rec.upload === p) rec.upload = null;
      }
      if (!driveOn()) { settle(rec, 'drive', false, false); return; }
      if (!rec.driveFileId && env.folderId() == null) { try { await env.ensureFolder(); } catch (e) { warn('Drive folder:', e); } }
      if (!driveReady(rec)) {
        // Signed in with sync on but no Drive folder: a failure to show (rule 13); a sign-out is not (rule 14).
        const shown = driveOn();
        if (shown) rec.failMsg = rec.failMsg || 'drive error: Drive folder not found';
        settle(rec, 'drive', false, shown);
        return;
      }
      const ok = await driveUpload(rec, text, bytes, true);
      settle(rec, 'drive', ok === true, ok !== undefined);
    }

    function finish(rec) {
      rec.state = 'done';
      if (cur !== rec) return;
      if (rec.finalFailed) status(rec, rec.failMsg, 'error');
      else if (rec.dir || rec.seen.folder || rec.seen.drive) status(rec, 'idle', '');
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
        drive: !!(on && driveReady(rec)),
      };
    }
    function current() { return cur; }

    return { start, stop, hidden, closing, entered, folderChanged, authChanged, targets, current };
  }

  const api = { create };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AortiRecorder = api;
})(typeof self !== 'undefined' ? self : this);
