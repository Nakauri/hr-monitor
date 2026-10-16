#!/usr/bin/env node
// Ledger 24 (S55): compiles CacheClear.java, SegmentUploadPlan.java and scripts/jvm/CacheClearTest.java with plain
// JDK 21 and runs them, plus wiring text checks on NativeDriveUploader.clearLocalCache (it needs Android, so it is
// read, not compiled). Then reruns against mutated copies, each of which must FAIL:
//   delete-all          Clear cache deletes every non-active CSV again (the bug)
//   no-drive-deletes    a phone without Drive deletes everything
//   name-only           a truncated Drive copy counts as safe
//   skip-ignored        the live or stopping session is deleted
//   wiring-delete       NativeDriveUploader deletes files itself instead of through CacheClear
//   wiring-no-skip      NativeDriveUploader stops passing the live and stopping names
//   wiring-assume-drive NativeDriveUploader hands CacheClear sizes when Drive was not read
//   empty-deletes       an empty local file with no Drive copy counts as on Drive
//   wiring-no-saved     a crashed session not yet resumed (name only in prefs) is deleted
// Run: node scripts/jvm/run-cache-clear-test.cjs   (exit 0 = real run passes AND every mutant fails). About 8 s.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const SRC = path.join(ROOT, 'mobile', 'android-overlay', 'app', 'src', 'main', 'java', 'com', 'nakauri', 'hrmonitor');
const FILES = ['HrSink.java', 'Clock.java', 'TzSource.java', 'LifecycleLog.java', 'SegmentWriter.java', 'SegmentUploadPlan.java', 'CacheClear.java'];
const UPLOADER = 'NativeDriveUploader.java';
const TEST = 'CacheClearTest';
const JDK = process.env.JAVA_HOME || 'C:\\Program Files\\Eclipse Adoptium\\jdk-21.0.10.7-hotspot';
const bin = (n) => path.join(JDK, 'bin', n + (process.platform === 'win32' ? '.exe' : ''));
const read = (f) => fs.readFileSync(path.join(SRC, f), 'utf8').replace(/\r\n/g, '\n');

const MUTANTS = {
  'delete-all': ['CacheClear.java',
    'if (driveMaxSizes != null && driveMaxSizes.containsKey(f.getName())\n                && SegmentUploadPlan.legacyOnDrive(f.length(), driveMaxSizes.get(f.getName()))\n                && f.delete()) {',
    'if (f.delete()) {'],
  'no-drive-deletes': ['CacheClear.java',
    'if (driveMaxSizes != null && driveMaxSizes.containsKey(f.getName())\n                && SegmentUploadPlan.legacyOnDrive(f.length(), driveMaxSizes.get(f.getName()))',
    'if ((driveMaxSizes == null || SegmentUploadPlan.legacyOnDrive(f.length(), driveMaxSizes.get(f.getName())))'],
  'empty-deletes': ['CacheClear.java', 'driveMaxSizes != null && driveMaxSizes.containsKey(f.getName())', 'driveMaxSizes != null'],
  'wiring-no-saved': [UPLOADER, 'if (savedName != null && !savedName.isEmpty()) skip.add(savedName);', ''],
  'name-only': ['SegmentUploadPlan.java', 'return localSize <= (driveMaxSize != null ? driveMaxSize : 0L);', 'return driveMaxSize != null;'],
  'skip-ignored': ['CacheClear.java', 'if (skip != null && skip.contains(f.getName())) continue;', ''],
  'wiring-delete': [UPLOADER, 'int[] r = CacheClear.run(sessionsDir, skip, driveSizes);',
    'int[] r = CacheClear.run(sessionsDir, skip, driveSizes);\n        for (File f : sessionsDir.listFiles()) if (!skip.contains(f.getName())) f.delete();'],
  'wiring-no-skip': [UPLOADER, 'int[] r = CacheClear.run(sessionsDir, skip, driveSizes);', 'int[] r = CacheClear.run(sessionsDir, null, driveSizes);'],
  'wiring-assume-drive': [UPLOADER, 'java.util.Map<String, Long> driveSizes = null;', 'java.util.Map<String, Long> driveSizes = new java.util.HashMap<>();'],
};

// Brace-matched body of the first method whose signature matches sigRe (strings and comments skipped).
function methodBody(src, sigRe) {
  const m = sigRe.exec(src);
  if (!m) return null;
  const open = src.indexOf('{', m.index + m[0].length - 1);
  let depth = 0, q = null;
  for (let i = open; i < src.length; i++) {
    const c = src[i], n = src[i + 1];
    if (q) { if (c === '\\') { i++; continue; } if (c === q) q = null; continue; }
    if (c === '/' && n === '/') { i = src.indexOf('\n', i); continue; }
    if (c === '/' && n === '*') { i = src.indexOf('*/', i + 2) + 1; continue; }
    if (c === '"' || c === "'") { q = c; continue; }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return src.slice(open, i + 1); }
  }
  return null;
}

function wiring(uploaderSrc) {
  const out = [];
  const ok = (name, pass) => out.push((pass ? 'OK    ' : 'FAIL  ') + name);
  const b = methodBody(uploaderSrc, /public JSONObject clearLocalCache\(File sessionsDir\)[^{]*\{/);
  ok('W0 NativeDriveUploader.clearLocalCache found', !!b);
  if (!b) return out;
  const code = b.replace(/"(?:[^"\\]|\\.)*"/g, '""').replace(/\/\/.*$/gm, '');
  ok('W1 deletes only through CacheClear.run (no .delete( of its own)', /CacheClear\.run\(/.test(code) && !/\.delete\(/.test(code));
  ok('W2 passes the live, stopping and saved-prefs names', /new java\.util\.HashSet<>\(FINALIZING\)/.test(code) && /skip\.add\(activeName\)/.test(code)
    && /skip\.add\(savedName\)/.test(code) && /CacheClear\.run\(sessionsDir, skip, driveSizes\)/.test(code));
  ok('W3 Drive sizes start null and are set only from a Drive listing',
    /java\.util\.Map<String, Long> driveSizes = null;/.test(code) && (code.match(/driveSizes = /g) || []).length === 2
    && /if \(files != null\) \{\s*driveSizes = new java\.util\.HashMap<>\(\);/.test(code));
  return out;
}

function run(mutant) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ccjvm-'));
  try {
    const srcDir = path.join(work, 'src'), outDir = path.join(work, 'out'), tmp = path.join(work, 'tmp');
    for (const d of [srcDir, outDir, tmp]) fs.mkdirSync(d);
    const paths = [];
    for (const f of FILES) {
      let text = read(f);
      if (mutant && mutant[0] === f) {
        if (!text.includes(mutant[1])) return { ok: false, out: 'mutation anchor not found: ' + mutant[1], anchorMissing: true };
        text = text.replace(mutant[1], mutant[2]);
      }
      const p = path.join(srcDir, f);
      fs.writeFileSync(p, text);
      paths.push(p);
    }
    let up = read(UPLOADER);
    if (mutant && mutant[0] === UPLOADER) {
      if (!up.includes(mutant[1])) return { ok: false, out: 'mutation anchor not found: ' + mutant[1], anchorMissing: true };
      up = up.replace(mutant[1], mutant[2]);
    }
    const w = wiring(up);
    let out = '== wiring\n' + w.join('\n') + '\n';
    let ok = w.every((l) => l.startsWith('OK'));
    paths.push(path.join(__dirname, TEST + '.java'));
    const c = spawnSync(bin('javac'), ['-encoding', 'UTF-8', '-nowarn', '-d', outDir].concat(paths), { encoding: 'utf8' });
    if (c.status !== 0) return { ok: false, out: 'javac failed:\n' + c.stdout + c.stderr, compileFail: true };
    const r = spawnSync(bin('java'), ['-Djava.io.tmpdir=' + tmp, '-cp', outDir, TEST], { encoding: 'utf8', timeout: 60000 });
    out += '== ' + TEST + '\n' + (r.stdout || '') + (r.stderr || '') + (r.error ? 'spawn error: ' + r.error.message + '\n' : '');
    if (r.status !== 0) ok = false;
    return { ok, out };
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

let bad = 0;
const real = run(null);
process.stdout.write(real.out);
console.log('\nREAL  ' + (real.ok ? 'PASS' : 'FAIL'));
if (!real.ok) bad++;
for (const [name, m] of Object.entries(MUTANTS)) {
  const r = run(m);
  const fails = r.out.split('\n').filter((l) => l.startsWith('FAIL')).map((l) => l.trim());
  const caught = !r.ok && !r.anchorMissing && !r.compileFail;
  console.log('MUTANT ' + name + ': ' + (caught ? 'FAILED as required' : 'NOT CAUGHT') +
    (fails.length ? '  (' + fails.length + ' failing: ' + fails.slice(0, 2).join(' | ') + ')' : r.anchorMissing || r.compileFail ? '  ' + r.out.split('\n')[0] : ''));
  if (!caught) bad++;
}
if (bad) {
  console.error('\n' + bad + ' problem(s): the real run must pass and every mutant must fail.');
  process.exit(1);
}
console.log('\nCacheClearTest and the wiring checks pass; all ' + Object.keys(MUTANTS).length + ' negative controls fail.');
