#!/usr/bin/env node
// Guards: strap and relay reconnect cadence (a changed delay or threshold is lost heart rate). Files: ReconnectPolicy.java. Runtime: about 15 s.
// Compiles the real ReconnectPolicy.java and scripts/jvm/ReconnectPolicyTest.java with plain JDK 21 (no Gradle,
// no Android), then reruns the test against mutated copies, each of which must FAIL. Each mutant names its bug.
// Run: node scripts/jvm/run-reconnect-test.cjs          (exit 0 = test passes AND every mutant fails)
//      node scripts/jvm/run-reconnect-test.cjs none     (the real class only)

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const SRC = path.join(ROOT, 'mobile', 'android-overlay', 'app', 'src', 'main', 'java', 'com', 'nakauri', 'hrmonitor');
const FILE = 'ReconnectPolicy.java';
const TEST = 'ReconnectPolicyTest';

const JDK = process.env.JAVA_HOME || 'C:\\Program Files\\Eclipse Adoptium\\jdk-21.0.10.7-hotspot';
const bin = (n) => path.join(JDK, 'bin', n + (process.platform === 'win32' ? '.exe' : ''));

const MUTANTS = {
  // The full reconnect starts one attempt early.
  'gatt-full-at-5': ['return gattAttempts > GATT_FULL_AFTER || !hasHandle;', 'return gattAttempts >= GATT_FULL_AFTER || !hasHandle;'],
  // A fresh process with no gatt handle calls connect() on nothing instead of resolving the strap.
  'gatt-full-ignores-handle': ['return gattAttempts > GATT_FULL_AFTER || !hasHandle;', 'return gattAttempts > GATT_FULL_AFTER;'],
  // The cached gatt is never rebuilt.
  'gatt-never-full': ['return gattAttempts > GATT_FULL_AFTER || !hasHandle;', 'return !hasHandle;'],
  // The strap waits up to a minute between tries.
  'gatt-cap-60': ['static final long GATT_MAX_MS = 30_000L;', 'static final long GATT_MAX_MS = 60_000L;'],
  // The first strap retry waits 4 s.
  'gatt-no-offset': ['(1L << Math.min(gattAttempts - 1, 4))', '(1L << Math.min(gattAttempts, 4))'],
  // The strap retry spread widens to the relay's.
  'gatt-jitter-25': ['(jitter.next() * 0.4 - 0.2)', '(jitter.next() * 0.5 - 0.25)'],
  // Strap retries from many phones line up.
  'gatt-no-jitter': ['(jitter.next() * 0.4 - 0.2)', '(0.5 * 0.4 - 0.2)'],
  // HR arriving never clears the count, so the next drop goes straight to a full reconnect at 30 s.
  'gatt-reset-noop': ['void gattReset() { gattAttempts = 0; }', 'void gattReset() { }'],
  // The relay's first retry drops from 4 s to 2 s.
  'relay-offset': ['(1L << Math.min(relayAttempts, 5))', '(1L << Math.min(relayAttempts - 1, 5))'],
  // The relay waits up to 2 min between tries.
  'relay-cap-120': ['static final long RELAY_MAX_MS = 60_000L;', 'static final long RELAY_MAX_MS = 120_000L;'],
  // Relay retries from every overlay line up after an outage.
  'relay-no-jitter': ['1.0 + (jitter.next() * 0.5 - 0.25)', '1.0 + (0.5 * 0.5 - 0.25)'],
  // Jitter only ever lengthens the relay wait.
  'relay-jitter-one-sided': ['1.0 + (jitter.next() * 0.5 - 0.25)', '1.0 + (jitter.next() * 0.25)'],
  // The count lags the delay, so every relay wait halves.
  'relay-count-after': ['relayAttempts++;\n        long base = Math.min(RELAY_MAX_MS, RELAY_BASE_MS * (1L << Math.min(relayAttempts, 5)));',
    'long base = Math.min(RELAY_MAX_MS, RELAY_BASE_MS * (1L << Math.min(relayAttempts, 5)));\n        relayAttempts++;'],
  // An open relay never clears the count, so the next blip starts at 60 s.
  'relay-reset-noop': ['void relayReset() { relayAttempts = 0; }', 'void relayReset() { }'],
  // The unreachable notice repeats on every attempt past 10.
  'notify-repeats': ['return relayAttempts == RELAY_NOTIFY_AFTER;', 'return relayAttempts >= RELAY_NOTIFY_AFTER;'],
  // The unreachable notice comes one attempt late.
  'notify-late': ['static final int RELAY_NOTIFY_AFTER = 10;', 'static final int RELAY_NOTIFY_AFTER = 11;'],
  // The watchdog opens a second socket on top of a queued retry.
  'watchdog-ignores-retry': ['&& !live && !retryPending &&', '&& !live &&'],
  // The watchdog reopens a live relay.
  'watchdog-ignores-live': ['&& !live && !retryPending &&', '&& !retryPending &&'],
  // The watchdog opens a relay with no key.
  'watchdog-ignores-key': ['return broadcast && hasKey && !live', 'return broadcast && !live'],
  // The watchdog opens a relay the person turned off.
  'watchdog-ignores-broadcast': ['return broadcast && hasKey && !live', 'return hasKey && !live'],
  // The watchdog waits one heartbeat longer at the boundary.
  'watchdog-strict': ['now - lastOpenAtMs >= RELAY_WATCHDOG_MS;', 'now - lastOpenAtMs > RELAY_WATCHDOG_MS;'],
  // The watchdog fires after 1 min, racing the backoff.
  'watchdog-1min': ['static final long RELAY_WATCHDOG_MS = 120_000L;', 'static final long RELAY_WATCHDOG_MS = 60_000L;'],
};

function run(mutant) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'reconjvm-'));
  try {
    const srcDir = path.join(work, 'src', 'com', 'nakauri', 'hrmonitor');
    const outDir = path.join(work, 'out');
    fs.mkdirSync(srcDir, { recursive: true });
    fs.mkdirSync(outDir);
    let text = fs.readFileSync(path.join(SRC, FILE), 'utf8').replace(/\r\n/g, '\n');
    if (mutant) {
      if (!text.includes(mutant[0])) return { ok: false, out: 'mutation anchor not found: ' + mutant[0], anchorMissing: true };
      text = text.replace(mutant[0], mutant[1]);
    }
    const p = path.join(srcDir, FILE);
    fs.writeFileSync(p, text);
    const c = spawnSync(bin('javac'), ['-encoding', 'UTF-8', '-nowarn', '-d', outDir, p, path.join(__dirname, TEST + '.java')], { encoding: 'utf8' });
    if (c.status !== 0) return { ok: false, out: 'javac failed:\n' + c.stdout + c.stderr, compileFail: true };
    const r = spawnSync(bin('java'), ['-cp', outDir, 'com.nakauri.hrmonitor.' + TEST], { encoding: 'utf8', timeout: 60000 });
    return { ok: r.status === 0, out: (r.stdout || '') + (r.stderr || '') };
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

const only = process.argv[2];
const real = run(null);
console.log(real.out.trim());
if (!real.ok) { console.error('\n' + TEST + ' FAILED on the real class.'); process.exit(1); }
if (only === 'none') { console.log('\n' + TEST + ' passes.'); process.exit(0); }
let bad = 0;
for (const [name, m] of Object.entries(MUTANTS)) {
  if (only && only !== name) continue;
  const r = run(m);
  const caught = !r.ok && !r.anchorMissing && !r.compileFail;
  const failed = (r.out.match(/^\s*FAIL\s+.*$/m) || [''])[0].trim();
  console.log((caught ? 'caught   ' : 'MISSED   ') + name + (caught ? '  (' + failed + ')' : '  ' + r.out.split('\n')[0]));
  if (!caught) bad++;
}
console.log(bad ? '\n' + bad + ' mutant(s) not caught.' : '\n' + TEST + ' passes; all ' + Object.keys(MUTANTS).length + ' mutants caught.');
process.exit(bad ? 1 : 0);
