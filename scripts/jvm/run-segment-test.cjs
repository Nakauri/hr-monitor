#!/usr/bin/env node
// Compiles and runs scripts/jvm/SegmentWriterTest.java with plain JDK 21 (no Gradle, no Android),
// then reruns it against mutated copies of the writer, each of which must FAIL:
//   trim-off       SegmentWriter keeps a partial last line on reopen [K10]
//   tee-getfile    TeeSink.getFile answers from the segment, not the legacy writer [K1]
//   no-cont        a rolled segment lacks its g,cont row [K10]
//   no-jump        clock jumps go undetected [K11]
//   close-reopens-writer / close-reopens-tee   a write after close reopens a segment
//   no-clamp       a fact stamped 50 h ahead opens a future hour
//   header-tz-reopen   a same-hour reopen compares the offset with the header, not the last z row
//   no-drop        a failed write keeps its buffer and writes it twice (ENOSPC)
//   skip-uncounted / stop-obeys-backoff   rows refused in the backoff go unlogged, or g,stop is lost
// Run: node scripts/jvm/run-segment-test.cjs   (exit 0 = test passes AND every mutant fails)

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const SRC = path.join(ROOT, 'mobile', 'android-overlay', 'app', 'src', 'main', 'java', 'com', 'nakauri', 'hrmonitor');
const FILES = ['HrSink.java', 'Clock.java', 'TzSource.java', 'LifecycleLog.java', 'SegmentWriter.java', 'TeeSink.java'];
const TEST = path.join(__dirname, 'SegmentWriterTest.java');

const JDK = process.env.JAVA_HOME || 'C:\\Program Files\\Eclipse Adoptium\\jdk-21.0.10.7-hotspot';
const bin = (n) => path.join(JDK, 'bin', n + (process.platform === 'win32' ? '.exe' : ''));

const MUTANTS = {
  'trim-off': ['SegmentWriter.java', 'truncate(f, lastLf + 1);', '/* trim disabled */'],
  'tee-getfile': ['TeeSink.java', '@Override public File getFile() { return legacy.getFile(); }',
    '@Override public File getFile() { return segment != null ? segment.getFile() : legacy.getFile(); }'],
  'no-cont': ['SegmentWriter.java', 'rawRow("g", contTs, String.valueOf(liveSessionId), "cont");', '/* cont disabled */'],
  'no-jump': ['SegmentWriter.java', 'static final long CLOCK_JUMP_MS = 2_000L;', 'static final long CLOCK_JUMP_MS = Long.MAX_VALUE / 4;'],
  'close-reopens-writer': ['SegmentWriter.java', 'if (closed) return false;', ''],
  'close-reopens-tee': ['TeeSink.java', 'if (closed) return null;', ''],
  'no-clamp': ['SegmentWriter.java', 'return (tsMs < nowMs - FACT_PAST_MS || tsMs > nowMs + FACT_FUTURE_MS) ? nowMs : tsMs;', 'return tsMs;'],
  'header-tz-reopen': ['SegmentWriter.java', 'int prevTz = append ? lastTzInFile(f) : lastTz;', 'int prevTz = append ? headerTz(firstLine(f)) : lastTz;'],
  'no-drop': ['SegmentWriter.java', 'private void dropStream(String why) {', 'private void dropStream(String why) { if (true) return;'],
  'skip-uncounted': ['SegmentWriter.java', 'skippedRows++;', ''],
  'stop-obeys-backoff': ['SegmentWriter.java', 'if (!sessionRow && reopenNotBeforeMono', 'if (reopenNotBeforeMono'],
};

function run(label, mutant) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'segjvm-'));
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
    paths.push(TEST);
    const c = spawnSync(bin('javac'), ['-encoding', 'UTF-8', '-nowarn', '-d', outDir].concat(paths), { encoding: 'utf8' });
    if (c.status !== 0) return { ok: false, out: 'javac failed:\n' + c.stdout + c.stderr, compileFail: true };
    // The test's temp folders live under work, so a mutant that aborts mid-test leaves nothing behind.
    const tmp = path.join(work, 'tmp');
    fs.mkdirSync(tmp);
    const r = spawnSync(bin('java'), ['-Djava.io.tmpdir=' + tmp, '-cp', outDir, 'SegmentWriterTest'],
      { encoding: 'utf8', timeout: 120000 });
    return { ok: r.status === 0, out: (r.stdout || '') + (r.stderr || '') };
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

let bad = 0;
const real = run('real', null);
process.stdout.write(real.out);
console.log('\nREAL  ' + (real.ok ? 'PASS' : 'FAIL'));
if (!real.ok) bad++;

for (const [name, m] of Object.entries(MUTANTS)) {
  const r = run(name, m);
  const fails = r.out.split('\n').filter(l => l.startsWith('FAIL')).map(l => l.trim());
  const caught = !r.ok && !r.anchorMissing && !r.compileFail;
  console.log('MUTANT ' + name + ': ' + (caught ? 'FAILED as required' : 'NOT CAUGHT') +
    (fails.length ? '  (' + fails.length + ' failing: ' + fails.slice(0, 3).join(' | ') + ')' : r.anchorMissing || r.compileFail ? '  ' + r.out.split('\n')[0] : ''));
  if (!caught) bad++;
}

if (bad) {
  console.error('\n' + bad + ' problem(s): the real run must pass and every mutant must fail.');
  process.exit(1);
}
console.log('\nSegmentWriterTest passes; all ' + Object.keys(MUTANTS).length + ' negative controls fail.');
