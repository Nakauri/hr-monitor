#!/usr/bin/env node
// Compiles and runs scripts/jvm/ServiceStartPolicyTest.java with plain JDK 21 (no Gradle, no Android),
// then reruns it against mutated copies, each of which must FAIL:
//   resume-on-engine   decide resumes on origin=engine (our own FGS start re-enters onStartCommand) [S3]
//   gate-unlocked      SessionGate.resume drops the lock, so a Stop lands between claim and commit [S1]
//   heartbeat-notfound the heartbeat reconnects in NOT_FOUND [S5]
//   autoend-zero       AUTO_END 0 still ends a session [S15]
//   search-late        NOT_FOUND only after more than 10 min
//   announce-unclaimed a liveStop that lost the claim still logs and posts ENDED [T3, U1]
//   text-leak          a non-RECORDING notification says Recording [S2, C2]
//   review batch: one-133-decides no-retry app-arms-autoend stopping-pre-resume mismatch-cancels-alarm
//   lost-claim-leaks-lock ended-fixed-hours inexact-says-10min
//   audit batch: release-during-other-teardown stale-no-age-limit decline-drops-alarm-on-stopping
//   detangle: wire-name-inactive rearm-unbounded
// Run: node scripts/jvm/run-engine2-test.cjs          (exit 0 = test passes AND every mutant fails)
//      node scripts/jvm/run-engine2-test.cjs none     (the real classes only)

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const SRC = path.join(ROOT, 'mobile', 'android-overlay', 'app', 'src', 'main', 'java', 'com', 'nakauri', 'hrmonitor');
const FILES = ['LinkStatePolicy.java', 'ServiceStartPolicy.java', 'SessionGate.java'];
const TEST = 'ServiceStartPolicyTest';

const JDK = process.env.JAVA_HOME || 'C:\\Program Files\\Eclipse Adoptium\\jdk-21.0.10.7-hotspot';
const bin = (n) => path.join(JDK, 'bin', n + (process.platform === 'win32' ? '.exe' : ''));

const MUTANTS = {
  'resume-on-engine': ['ServiceStartPolicy.java', 'if (prefsLive && !ORIGIN_ENGINE.equals(origin)) return Action.RESUME;',
    'if (prefsLive) return Action.RESUME;'],
  'gate-unlocked': ['SessionGate.java', 'synchronized (lock) {\n            if (active.get()) return already.run();',
    'synchronized (new Object()) {\n            if (active.get()) return already.run();'],
  'heartbeat-notfound': ['LinkStatePolicy.java', 'return s == State.RESUMING || s == State.RECORDING || s == State.RECONNECTING;',
    'return s == State.RESUMING || s == State.RECORDING || s == State.RECONNECTING || s == State.NOT_FOUND;'],
  'autoend-zero': ['LinkStatePolicy.java', 'autoEndArmed = autoEndMs > 0L && nowMs - notFoundSinceMs >= autoEndMs;',
    'autoEndArmed = nowMs - notFoundSinceMs >= autoEndMs;'],
  'search-late': ['LinkStatePolicy.java', 'nowMs - searchFromMs >= STRAP_SEARCH_MS', 'nowMs - searchFromMs > STRAP_SEARCH_MS'],
  'announce-unclaimed': ['ServiceStartPolicy.java', 'return claimed && REASON_AUTO_END.equals(reason);', 'return REASON_AUTO_END.equals(reason);'],
  'text-leak': ['ServiceStartPolicy.java', '"Strap not found. Trying again every 10 minutes."', '"Recording paused. Strap not found."'],
  // Review batch 2026-10-10.
  'one-133-decides': ['LinkStatePolicy.java', 'if (nowMs < attemptUntilMs) return false;\n', ''],
  'no-retry': ['LinkStatePolicy.java', 'return state == State.NOT_FOUND && nowMs < attemptUntilMs;', 'return false;'],
  'app-arms-autoend': ['ServiceStartPolicy.java', 'return ORIGIN_ALARM.equals(wakeOrigin) ? boundMs : 0L;', 'return boundMs;'],
  'stopping-pre-resume': ['ServiceStartPolicy.java', 'if (stopping) return LinkStatePolicy.State.STOPPING;', ''],
  'mismatch-cancels-alarm': ['ServiceStartPolicy.java', 'return !prefsLiveAfterCommit;', 'return true;'],
  'lost-claim-leaks-lock': ['ServiceStartPolicy.java', 'return !newerLive && (stopped || !otherTeardownRunning);',
    'return stopped && !newerLive;'],
  // Audit batch 2026-10-10.
  'release-during-other-teardown': ['ServiceStartPolicy.java', 'return !newerLive && (stopped || !otherTeardownRunning);', 'return !newerLive;'],
  'stale-no-age-limit': ['ServiceStartPolicy.java', 'return nowMs - anchor <= LinkStatePolicy.AUTO_END_NOT_FOUND_MS;', 'return true;'],
  'decline-drops-alarm-on-stopping': ['ServiceStartPolicy.java', 'return "not_live".equals(reason);', 'return !"error".equals(reason);'],
  'ended-fixed-hours': ['ServiceStartPolicy.java', 'String h = hoursLabel(autoEndMs);', 'String h = "12";'],
  // Detangle 2026-10-10.
  'wire-name-inactive': ['LinkStatePolicy.java', 'if (!sessionActive || s == null) return "none";', 'if (s == null) return "none";'],
  'rearm-unbounded': ['LinkStatePolicy.java', 'return Math.min(d, PENDING_REARM_MAX_MS);', 'return d;'],
  'inexact-says-10min': ['ServiceStartPolicy.java', ': "Strap not found. Trying again from time to time."', ': "Strap not found. Trying again every 10 minutes."'],
};

function run(label, mutant) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'eng2jvm-'));
  try {
    const srcDir = path.join(work, 'src', 'com', 'nakauri', 'hrmonitor');
    const outDir = path.join(work, 'out');
    fs.mkdirSync(srcDir, { recursive: true });
    fs.mkdirSync(outDir);
    const paths = [];
    for (const f of FILES) {
      let text = fs.readFileSync(path.join(SRC, f), 'utf8').replace(/\r\n/g, '\n');
      if (mutant && mutant[0] === f) {
        if (!text.includes(mutant[1])) return { ok: false, out: 'mutation anchor not found: ' + mutant[1], anchorMissing: true };
        text = text.replace(mutant[1], mutant[2]);
      }
      const p = path.join(srcDir, f);
      fs.writeFileSync(p, text);
      paths.push(p);
    }
    paths.push(path.join(__dirname, TEST + '.java'));
    const c = spawnSync(bin('javac'), ['-encoding', 'UTF-8', '-nowarn', '-d', outDir].concat(paths), { encoding: 'utf8' });
    if (c.status !== 0) return { ok: false, out: 'javac failed:\n' + c.stdout + c.stderr, compileFail: true };
    const r = spawnSync(bin('java'), ['-cp', outDir, TEST], { encoding: 'utf8', timeout: 60000 });
    return { ok: r.status === 0, out: (r.stdout || '') + (r.stderr || '') };
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

const only = process.argv[2];
const real = run('real', null);
console.log(real.out.trim());
if (!real.ok) { console.error('\nServiceStartPolicyTest FAILED on the real classes.'); process.exit(1); }
if (only === 'none') { console.log('\nServiceStartPolicyTest passes.'); process.exit(0); }
let bad = 0;
for (const [name, m] of Object.entries(MUTANTS)) {
  if (only && only !== name) continue;
  const r = run(name, m);
  const caught = !r.ok && !r.anchorMissing && !r.compileFail;
  const failed = (r.out.match(/^\s*FAIL\s+.*$/m) || [''])[0].trim();
  console.log((caught ? 'caught   ' : 'MISSED   ') + name + (caught ? '  (' + failed + ')' : '  ' + r.out.split('\n')[0]));
  if (!caught) bad++;
}
console.log(bad ? '\n' + bad + ' mutant(s) not caught.' : '\nServiceStartPolicyTest passes; all mutants caught.');
process.exit(bad ? 1 : 0);
