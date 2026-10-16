// Guards: the restore overlay shown on a resume with no real stop, which the page never hides (stuck "Restoring session" after a short screen-off, 2026-10-15 21:49). Files: MainActivity.java, lifecycle-state.js. Runtime: about 2 s.
// S56 negative controls for engine-boundary.test.cjs: mutate a copied tree, run --root, each mutant must FAIL an [S56] check.
// Run: node scripts/overlay-resume-mutants.cjs   (exit 0 = baseline passes and every mutant is caught)
const fs = require('fs'), os = require('os'), path = require('path'), { spawnSync } = require('child_process');
const WT = path.join(__dirname, '..');
const J = 'mobile/android-overlay/app/src/main/java/com/nakauri/hrmonitor/';
const A = J + 'MainActivity.java', L = 'lifecycle-state.js';
const FILES = ['.github/workflows/build-android.yml', 'hr_monitor.html', 'mobile/android-overlay/app/src/main/AndroidManifest.xml',
  'mobile/android-overlay/app/test-hooks.gradle', 'mobile/scripts/inject-manifest.js', 'mobile/src/native-pdf.js', L];
const M = {
  'show-every-resume': [A, 'boolean show = active && !cleanly && stoppedForMs > RESUME_OVERLAY_MIN_STOP_MS;', 'boolean show = active && !cleanly;'],
  'show-ungated': [A, 'if (show) showRestoreOverlay();', 'showRestoreOverlay();'],
  'second-show': [A, 'if (show) showRestoreOverlay();', 'if (show) showRestoreOverlay();\n            else if (active) showRestoreOverlay();'],
  'stop-wall-clock': [A, 'stoppedAtMs = SystemClock.elapsedRealtime();', 'stoppedAtMs = System.currentTimeMillis();'],
  'stop-not-recorded': [A, 'stoppedAtMs = SystemClock.elapsedRealtime();', ''],
  'stop-never-cleared': [A, '            stoppedAtMs = 0L;\n', ''],
  'threshold-drift': [A, 'RESUME_OVERLAY_MIN_STOP_MS = 60000L;', 'RESUME_OVERLAY_MIN_STOP_MS = 5000L;'],
  'js-threshold-drift': [L, "opts.resumeOverlayMs : 60000;", "opts.resumeOverlayMs : 30000;"],
  'cold-start-gated': [A, '\n        showRestoreOverlay();', '\n        if (stoppedAtMs > 0L) showRestoreOverlay();'],
  'fence-moved': [A, 'OVERLAY_SAFETY_MS = 60000L;', 'OVERLAY_SAFETY_MS = 120000L;'],
  'no-decision-line': [A, 'logLifecycleAsync("overlay_resume show=" + show + " stopped_ms="', 'Log.d(TAG, "overlay_resume show=" + show + " stopped_ms="'],
  'log-on-ui-thread': [A, 'logLifecycleAsync("overlay_shown");', 'NativeHrService.logLifecycle(MainActivity.this, "overlay_shown");'],
  'show-outside-try': [A, '            if (show) showRestoreOverlay();\n        } catch (Throwable t) {\n            Log.w(TAG, "onResume overlay check failed: " + t.getMessage());\n        }',
    '        } catch (Throwable t) {\n            Log.w(TAG, "onResume overlay check failed: " + t.getMessage());\n        }\n        if (stoppedAtMs == 0L) showRestoreOverlay();'],
};
function copyTree(dst) {
  for (const f of fs.readdirSync(path.join(WT, J))) fs.mkdirSync(path.join(dst, J), { recursive: true }), fs.copyFileSync(path.join(WT, J, f), path.join(dst, J, f));
  for (const f of FILES) { const s = path.join(WT, f); if (!fs.existsSync(s)) continue; fs.mkdirSync(path.dirname(path.join(dst, f)), { recursive: true }); fs.copyFileSync(s, path.join(dst, f)); }
}
let bad = 0;
for (const [name, [file, a, b]] of Object.entries(M)) {
  const dst = fs.mkdtempSync(path.join(os.tmpdir(), 'omut-'));
  try {
    copyTree(dst);
    const fp = path.join(dst, file);
    const t = fs.readFileSync(fp, 'utf8').replace(/\r\n/g, '\n');
    if (!t.includes(a)) { console.log('ANCHOR   ' + name); bad++; continue; }
    fs.writeFileSync(fp, t.replace(a, b));
    const r = spawnSync('node', [path.join(WT, 'scripts/engine-boundary.test.cjs'), '--root=' + dst], { encoding: 'utf8' });
    const fails = (r.stdout.match(/^FAIL .*$/mg) || []);
    const hit = fails.filter(l => l.includes('[S56]'));
    const caught = r.status !== 0 && hit.length > 0;
    console.log((caught ? 'caught   ' : 'MISSED   ') + name + '  ' + (hit[0] || fails[0] || 'exit ' + r.status));
    if (!caught) bad++;
  } finally { fs.rmSync(dst, { recursive: true, force: true }); }
}
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'omut-'));
copyTree(base);
const r0 = spawnSync('node', [path.join(WT, 'scripts/engine-boundary.test.cjs'), '--root=' + base], { encoding: 'utf8' });
fs.rmSync(base, { recursive: true, force: true });
console.log('baseline copy exit ' + r0.status + (r0.status ? '\n' + r0.stdout.split('\n').filter(l => l.startsWith('FAIL')).join('\n') : ''));
console.log(bad ? bad + ' not caught' : 'all ' + Object.keys(M).length + ' overlay resume mutants caught');
process.exit(bad || r0.status ? 1 : 0);
