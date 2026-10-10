#!/usr/bin/env node
// Compiles and runs scripts/jvm/UploadPlanTest.java and SegmentUploaderTest.java with plain JDK 21 (no Gradle,
// no Android, no network: Drive is an in-memory fake), then reruns both against mutated copies, each of which
// must FAIL. Each mutant names the bug it stands for.
// Run: node scripts/jvm/run-upload-test.cjs   (exit 0 = tests pass AND every mutant fails)

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const SRC = path.join(ROOT, 'mobile', 'android-overlay', 'app', 'src', 'main', 'java', 'com', 'nakauri', 'hrmonitor');
const FILES = ['HrSink.java', 'Clock.java', 'TzSource.java', 'LifecycleLog.java', 'SegmentWriter.java', 'TeeSink.java',
  'SegmentReader.java', 'SegmentUploadPlan.java', 'MiniJson.java', 'SegmentUploader.java'];
const TESTS = ['UploadPlanTest', 'SegmentUploaderTest'];

const JDK = process.env.JAVA_HOME || 'C:\\Program Files\\Eclipse Adoptium\\jdk-21.0.10.7-hotspot';
const bin = (n) => path.join(JDK, 'bin', n + (process.platform === 'win32' ? '.exe' : ''));

const MUTANTS = {
  // K9: only the first page of a same-name lookup is read, so an older copy on a later page is missed.
  'first-page-only': ['SegmentUploader.java', 'pageToken = MiniJson.str(m, "nextPageToken");', 'pageToken = null;'],
  // K9: the newest copy is PATCHed instead of the oldest the viewer reads.
  'newest-wins': ['SegmentUploadPlan.java', 'if (c != 0) return c < 0;', 'if (c != 0) return c > 0;'],
  // K9: the name lookup is limited to one folder, so a copy in another folder gets a duplicate beside it.
  'parent-filter': ['SegmentUploader.java', 'listQuery("name=\'" + esc(name) + "\' and trashed=false")',
    'listQuery("name=\'" + esc(name) + "\' and \'" + esc(rootFolder()) + "\' in parents and trashed=false")'],
  // Month-folder race: the created folder is used without re-listing for an older one.
  'no-relist': ['SegmentUploader.java', 'SegmentUploadPlan.Remote after = SegmentUploadPlan.oldest(',
    'SegmentUploadPlan.Remote after = null; Object unused = SegmentUploadPlan.oldest('],
  // K10: the whole file is sent, partial last row included.
  'send-whole-file': ['SegmentUploadPlan.java', 'long send = Math.min(Math.max(lastLfLen, 0L), Math.max(localLen, 0L));',
    'long send = Math.max(localLen, 0L);'],
  // K10: the open segment is read past the length captured under the writer lock.
  'no-snapshot': ['SegmentUploader.java', 'long cap = isOpen ? open.readableLength(n) : -1L;', 'long cap = -1L;'],
  // B5: a create when the name already exists.
  'create-when-exists': ['SegmentUploadPlan.java', 'if (oldest == null) return new Plan(Op.CREATE, send, null);',
    'if (true) return new Plan(Op.CREATE, send, null);'],
  // Closed-mode passes upload the growing open segment.
  'open-in-closed': ['SegmentUploadPlan.java', 'if (isOpen && !openTick) return new Plan(Op.SKIP_OPEN, 0L, null);', ''],
  // B-c caveat: a restarted segment of the same size is never re-sent; Drive keeps the stale generation.
  'ignore-bad': ['SegmentUploader.java', 'boolean restarted = SegmentUploadPlan.restarted(st.bad(n), badMs);', 'boolean restarted = false;'],
  // B-c caveat: .bad files are never uploaded, so their bytes never reach Drive.
  'skip-bad-files': ['SegmentUploader.java', 'if (p.op == SegmentUploadPlan.Op.NEED_LIST) out.add(new Item(n, f, false, p.sendLen, false, 0L, null));', ''],
  // B-c caveat: a restart overwrites Drive before its .bad bytes are up.
  'no-bad-pending': ['SegmentUploader.java', 'if (st.len(b) != lastLf(bf, bf.length())) {', 'if (false) {'],
  // Gotcha: 401 retried once with forceRefresh.
  'no-401-refresh': ['SegmentUploader.java', 'if (r.code != 401) return r;', 'if (true) return r;'],
  // L1: the tick waits for the lock behind a slow worker.
  'tick-waits': ['SegmentUploader.java', 'locked = LOCK.tryLock();', 'LOCK.lock(); locked = true;'],
  // Signed out turns into a WorkManager retry storm.
  'signed-out-retry': ['SegmentUploader.java', 'if (countLegacy) log.log("legacy_pending n=unknown");\n            return Result.SIGNED_OUT;',
    'if (countLegacy) log.log("legacy_pending n=unknown");\n            return Result.RETRY;'],
  // L7: a signed-out pass is counted as a zero read.
  'legacy-signed-out-zero': ['SegmentUploader.java', 'if (countLegacy) log.log("legacy_pending n=unknown");', 'if (countLegacy) log.log("legacy_pending n=0");'],
  // L7: a legacy file missing from Drive is not counted.
  'legacy-missing-uncounted': ['SegmentUploadPlan.java', 'if (e.getValue() > (d != null ? d : 0L)) n++;', 'if (d != null && e.getValue() > d) n++;'],
  // L8: the pass is removed while local legacy files still exist.
  'guard-ignores-local': ['SegmentUploadPlan.java', 'return localLegacyFiles > 0 || signedInZeroReads < 2;', 'return signedInZeroReads < 2;'],
  // K11: cleanup trusts the name alone.
  'cleanup-name-only': ['SegmentUploadPlan.java', 'if (sz == s.lastLfLen && sz > 0L) { out.add(s.name); break; }', 'if (sz > 0L) { out.add(s.name); break; }'],
  // Cleanup deletes the open or previous segment.
  'cleanup-open': ['SegmentUploadPlan.java', 'if (s.name.equals(openName) || s.name.equals(previousName)) continue;\n                if (s.hourBase', 'if (s.hourBase'],
  // F4: signed out deletes by age or without the notice.
  'cleanup-signed-out-age': ['SegmentUploadPlan.java', 'if (!noticeShown || totalBytes <= capBytes) return out;', 'if (totalBytes < 0L) return out;'],
  // Every run re-sends every segment because the sent length is never saved.
  'state-not-saved': ['SegmentUploader.java', 'st.save(log);', ''],
  // A revoked grant (401 after a fresh token) retries forever instead of waiting for sign-in.
  'rejected-401-retries': ['SegmentUploader.java', 'if (r.code == 401) throw new SignedOut("auth_rejected");', ''],
  // The roll of hour X clears the id the tick already cached for hour X+1.
  'forget-any-name': ['SegmentUploader.java', 'if (name != null && !name.equals(store.get(K_OPEN_NAME))) return;', ''],
  // KEEP decision: a run that uploads only its named segment loses the enqueue KEEP dropped.
  'named-only': ['SegmentUploader.java', 'if (!uploadItem(st, it)) failed.add(it.name);\n                        else if (it.open) sentOpen.add(it.name);',
    'if (true) { uploadItem(st, it); return Result.OK; }'],
  // KEEP decision: no rescan, so a segment closed mid-run waits for the next trigger.
  'single-pass': ['SegmentUploader.java', 'if (quiet) break;', 'if (true) break;'],
  // KEEP drops an enqueue while a run is RUNNING: a close during legacyPass is never swept.
  'no-closeseq-after-legacy': ['SegmentUploader.java', '                    quiet = CLOSE_SEQ.get() == seq;', '                    quiet = true;'],
  // Endless closes: the run reports success with work left.
  'still-closing-ok': ['SegmentUploader.java', 'log.log("upload_retry reason=still_closing");\n                    return Result.RETRY;',
    'log.log("upload_retry reason=still_closing");\n                    return Result.OK;'],
  // Account switch: the new account never receives segments the old one had.
  'no-account-wipe': ['SegmentUploader.java', '        if (switched) {\n            log.log("upload_account_switch");', '        if (false) {\n            log.log("upload_account_switch");'],
  // Sign-out mid-run is not noticed until a 401.
  'no-midrun-signout': ['SegmentUploader.java', '        if (t == null) throw new SignedOut("signed_out");\n        String a = accountKey', '        String a = accountKey'],
  // Account change mid-run keeps uploading to the old account.
  'no-midrun-account': ['SegmentUploader.java', 'if (a == null ? account != null : !a.equals(account)) throw new AccountChanged();', ''],
  // A stale root 404 on the month list fails the upload instead of re-resolving.
  'no-root-404-retry': ['SegmentUploader.java', 'if (p.code != 404) throw p;', 'if (true) throw p;'],
  // Trashed folders and files are treated as alive.
  'trash-blind': ['SegmentUploader.java', 'return !Boolean.TRUE.equals(m.get("trashed"));', 'return true;'],
  // The cached open id is never re-checked, so PATCHes go into the trash.
  'open-never-checked': ['SegmentUploader.java', 'boolean recent = cachedId.equals(openCheckedId) && now >= openCheckedAt && now - openCheckedAt < OPEN_CHECK_MS;', 'boolean recent = true;'],
  // A corrupt state file triggers a lookup storm.
  'no-relist-cap': ['SegmentUploader.java', 'static final int RELIST_CAP = 200;', 'static final int RELIST_CAP = 1_000_000;'],
  // Root pick: first hit instead of the oldest, so phone and viewer can walk different roots.
  'root-first-hit': ['SegmentUploader.java', 'return best != null ? best.id : null;', 'return l.isEmpty() ? null : l.get(0).id;'],
  // Root pick: no orderBy, so the oldest root may not be on the first page.
  'root-no-order': ['SegmentUploader.java', '"&orderBy=createdTime&fields=" + enc("files(id,name,createdTime)")', '"&fields=" + enc("files(id,name,createdTime)")'],
  // Relist starvation: old names first, so the current hour waits behind the backlog.
  'relist-oldest-first': ['SegmentUploader.java', 'int c = bb.compareTo(ba);', 'int c = ba.compareTo(bb);'],
  // Relist starvation: the open segment is not moved to the front.
  'relist-open-not-first': ['SegmentUploader.java', 'for (Item it : items) if (it.open) out.add(it);\n        List<Item> rest = new ArrayList<>();\n        for (Item it : items) if (!it.open) rest.add(it);',
    'List<Item> rest = new ArrayList<>(items);'],
  // Relist starvation: a capped run reports OK, so the backlog waits for the next trigger.
  'capped-ok': ['SegmentUploader.java', 'log.log("upload_throttle cap=" + RELIST_CAP);\n                    return Result.RETRY;', 'log.log("upload_throttle cap=" + RELIST_CAP);\n                    return Result.OK;'],
  // Relist re-sends every byte Drive already holds.
  'patch-same-size': ['SegmentUploader.java', 'if (!it.restarted && target != null && target.size == it.sendLen) {', 'if (false) {'],
  // A restarted segment of the same size is skipped as a size match and Drive keeps the stale generation.
  'match-ignores-restart': ['SegmentUploader.java', 'if (!it.restarted && target != null && target.size == it.sendLen) {', 'if (target != null && target.size == it.sendLen) {'],
  // K11: rolls and stops never reach the upload worker.
  'no-close-callback': ['SegmentWriter.java', 'notifyClosed(name, reason);', ''],
  // A transient failure is swallowed and the worker reports success.
  'transient-ok': ['SegmentUploader.java', 'log.log("upload_retry reason=" + t.getMessage());\n            return Result.RETRY;',
    'log.log("upload_retry reason=" + t.getMessage());\n            return Result.OK;'],
};

function run(label, mutant) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'upjvm-'));
  try {
    const srcDir = path.join(work, 'src');
    const outDir = path.join(work, 'out');
    fs.mkdirSync(srcDir);
    fs.mkdirSync(outDir);
    const paths = [];
    for (const f of FILES) {
      let text = fs.readFileSync(path.join(SRC, f), 'utf8');
      if (mutant && mutant[0] === f) {
        if (!text.includes(mutant[1])) return { ok: false, out: 'mutation anchor not found: ' + mutant[1], anchorMissing: true };
        text = text.replace(mutant[1], mutant[2]);
      }
      const p = path.join(srcDir, f);
      fs.writeFileSync(p, text);
      paths.push(p);
    }
    for (const t of TESTS) paths.push(path.join(__dirname, t + '.java'));
    const c = spawnSync(bin('javac'), ['-encoding', 'UTF-8', '-nowarn', '-d', outDir].concat(paths), { encoding: 'utf8' });
    if (c.status !== 0) return { ok: false, out: 'javac failed:\n' + c.stdout + c.stderr, compileFail: true };
    const tmp = path.join(work, 'tmp');
    fs.mkdirSync(tmp);
    let ok = true;
    let out = '';
    for (const t of TESTS) {
      const r = spawnSync(bin('java'), ['-Djava.io.tmpdir=' + tmp, '-cp', outDir, t], { encoding: 'utf8', timeout: 60000 });
      out += '== ' + t + '\n' + (r.stdout || '') + (r.stderr || '') + (r.error ? 'spawn error: ' + r.error.message + '\n' : '');
      if (r.status !== 0) ok = false;
    }
    return { ok, out };
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

const only = process.argv[2];
let bad = 0;
const real = run('real', null);
process.stdout.write(real.out);
console.log('\nREAL  ' + (real.ok ? 'PASS' : 'FAIL'));
if (!real.ok) bad++;

for (const [name, m] of Object.entries(MUTANTS)) {
  if (only && !only.split(',').includes(name)) continue;
  const r = run(name, m);
  const fails = r.out.split('\n').filter(l => l.startsWith('FAIL')).map(l => l.trim());
  const caught = !r.ok && !r.anchorMissing && !r.compileFail;
  console.log('MUTANT ' + name + ': ' + (caught ? 'FAILED as required' : 'NOT CAUGHT') +
    (fails.length ? '  (' + fails.length + ' failing: ' + fails.slice(0, 2).join(' | ') + ')' : r.anchorMissing || r.compileFail ? '  ' + r.out.split('\n').slice(0, 3).join(' / ') : ''));
  if (!caught) bad++;
}

if (bad) {
  console.error('\n' + bad + ' problem(s): the real run must pass and every mutant must fail.');
  process.exit(1);
}
console.log('\nUploadPlanTest and SegmentUploaderTest pass; ' + (only ? 'the selected' : 'all ' + Object.keys(MUTANTS).length) + ' negative controls fail.');
