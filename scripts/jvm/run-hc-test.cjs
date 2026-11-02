#!/usr/bin/env node
// S65a: compiles HcAwait.java, HcMap.java and scripts/jvm/HcTest.java with JDK 21 against the kotlin-stdlib jar from the
// Gradle cache and runs them, plus wiring text checks on HealthConnectPlugin.java and HcClient.java (they need Android,
// so they are read, not compiled). Then reruns against mutated copies, each of which must FAIL:
//   late-by-kind       a late result clears the kind's slot whatever its token (frees or settles a newer call)
//   no-cap             a timed-out kind stays busy for the process lifetime (the service keeps it alive for days)
//   timeout-frees      a timed-out call frees its kind at once (a second read runs beside the stuck one)
//   light-is-awake     light sleep counted as awake
//   not-installed      a missing Health Connect app reads as "update" (S65 skeptic round 1 finding 3)
//   wiring-no-lease    the plugin reads without taking the kind's slot
//   wiring-no-close    the plugin never frees the slot after a read
//   wiring-client      the plugin imports the client (resolved on API 22 to 27)
// Run: node scripts/jvm/run-hc-test.cjs   (exit 0 = real run passes AND every mutant fails). About 15 s.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const SRC = path.join(ROOT, 'mobile', 'android-overlay', 'app', 'src', 'main', 'java', 'com', 'nakauri', 'hrmonitor');
const FILES = ['HcAwait.java', 'HcMap.java'];
const PLUGIN = 'HealthConnectPlugin.java';
const CLIENT = 'HcClient.java';
const JDK = process.env.JAVA_HOME || 'C:\\Program Files\\Eclipse Adoptium\\jdk-21.0.10.7-hotspot';
const bin = (n) => path.join(JDK, 'bin', n + (process.platform === 'win32' ? '.exe' : ''));
const read = (f) => fs.readFileSync(path.join(SRC, f), 'utf8').replace(/\r\n/g, '\n');
const KOTLIN_DIR = path.join(os.homedir(), '.gradle', 'caches', 'modules-2', 'files-2.1', 'org.jetbrains.kotlin', 'kotlin-stdlib', '1.9.10');

// CI has no Gradle cache: its check job downloads the same jar (sha256 pinned) and names it in KOTLIN_STDLIB_JAR.
function kotlinJar() {
  if (process.env.KOTLIN_STDLIB_JAR && fs.existsSync(process.env.KOTLIN_STDLIB_JAR)) return process.env.KOTLIN_STDLIB_JAR;
  const walk = (d) => fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]) : [];
  const jar = walk(KOTLIN_DIR).find((f) => /kotlin-stdlib-1\.9\.10\.jar$/.test(f));
  if (!jar) { console.log('MISSING kotlin-stdlib-1.9.10.jar under ' + KOTLIN_DIR + ' (run one Gradle build first)'); process.exit(2); }
  return jar;
}

const MUTANTS = {
  'late-by-kind': ['HcAwait.java', 'if (h != null && h[0] == token) held.remove(kind);', 'if (h != null) held.remove(kind);'],
  'no-cap': ['HcAwait.java', 'if (h != null && now - h[1] < BUSY_CAP_MS) return null;', 'if (h != null) return null;'],
  'timeout-frees': ['HcAwait.java', '                lease.late = true;\n', ''],
  'light-is-awake': ['HcMap.java', 'static final int[] AWAKE_TYPES = { 1, 3, 7 };', 'static final int[] AWAKE_TYPES = { 1, 3, 4, 7 };'],
  'not-installed': ['HcMap.java', 'return installed ? "update" : "not-installed";', 'return "update";'],
  'wiring-no-lease': [PLUGIN, 'HcClient.readSleep(getContext(), fromD.longValue(), toD.longValue(), lease)', 'HcClient.readSleep(getContext(), fromD.longValue(), toD.longValue(), null)'],
  'wiring-no-close': [PLUGIN, '            } finally {\n                lease.close();\n            }', '            } finally {\n            }'],
  'wiring-client': [PLUGIN, 'import androidx.activity.result.ActivityResult;', 'import androidx.activity.result.ActivityResult;\nimport androidx.health.connect.client.HealthConnectClient;'],
};

function wiring(plugin, client) {
  const out = [];
  const ok = (name, pass) => out.push((pass ? 'OK    ' : 'FAIL  ') + name);
  const code = (s) => s.replace(/"(?:[^"\\]|\\.)*"/g, '""').replace(/\/\/.*$/gm, '');
  const p = code(plugin), c = code(client);
  ok('W1 the plugin imports no Health Connect client class', !/import androidx\.health\./.test(p));
  ok('W2 read takes the kind\'s slot and refuses a busy kind', /HcAwait\.Lease lease = SLOTS\.take\(kind\);\s*if \(lease == null\) \{ call\.reject\(""\); return; \}/.test(p));
  ok('W3 read passes its lease to every page and frees it in finally', /HcClient\.readSleep\([^;]*, lease\)/.test(p) && /\} finally \{\s*lease\.close\(\);\s*\}/.test(p)
    && /HcAwait\.await\(c -> client\.readRecords\(req, c\), HcAwait\.TIMEOUT_MS, lease\)/.test(c));
  ok('W4 API under 28 never reaches HcClient in status', /if \(!supported\(\)\) return HcMap\.sdkState\(/.test(p));
  return out;
}

function run(mutant) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'hcjvm-'));
  try {
    const srcDir = path.join(work, 'src'), outDir = path.join(work, 'out');
    fs.mkdirSync(srcDir); fs.mkdirSync(outDir);
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
    let plugin = read(PLUGIN), client = read(CLIENT);
    if (mutant && mutant[0] === PLUGIN) {
      if (!plugin.includes(mutant[1])) return { ok: false, out: 'mutation anchor not found: ' + mutant[1], anchorMissing: true };
      plugin = plugin.replace(mutant[1], mutant[2]);
    }
    const w = wiring(plugin, client);
    let out = '== wiring\n' + w.join('\n') + '\n';
    let ok = w.every((l) => l.startsWith('OK'));
    paths.push(path.join(__dirname, 'HcTest.java'));
    const cp = kotlinJar();
    const c = spawnSync(bin('javac'), ['-encoding', 'UTF-8', '-nowarn', '-cp', cp, '-d', outDir].concat(paths), { encoding: 'utf8' });
    if (c.status !== 0) return { ok: false, out: 'javac failed:\n' + c.stdout + c.stderr, compileFail: true };
    const r = spawnSync(bin('java'), ['-cp', outDir + path.delimiter + cp, 'com.nakauri.hrmonitor.HcTest'], { encoding: 'utf8', timeout: 60000 });
    out += '== HcTest\n' + (r.stdout || '') + (r.stderr || '') + (r.error ? 'spawn error: ' + r.error.message + '\n' : '');
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
console.log('\nHcTest and the wiring checks pass; all ' + Object.keys(MUTANTS).length + ' negative controls fail.');
