// S15a negative controls for engine-boundary.test.cjs: mutate a copied tree, run --root, each mutant must FAIL an [S15a] check.
// Run: node scripts/pdf-boundary-mutants.cjs   (exit 0 = baseline passes and every mutant is caught)
const fs = require('fs'), os = require('os'), path = require('path'), { spawnSync } = require('child_process');
const WT = path.join(__dirname, '..');
const J = 'mobile/android-overlay/app/src/main/java/com/nakauri/hrmonitor/';
const P = J + 'PdfPrinter.java', S = J + 'NativeHrSessionPlugin.java', JS = 'mobile/src/native-pdf.js';
const FILES = ['.github/workflows/build-android.yml', 'hr_monitor.html', 'mobile/android-overlay/app/src/main/AndroidManifest.xml',
  'mobile/android-overlay/app/test-hooks.gradle', 'mobile/scripts/inject-manifest.js', JS];
const M = {
  'engine-ref': [P, 'private PdfPrinter() {}', 'private PdfPrinter() { HrEngine.peek(); }'],
  'service-ref': [P, 'private PdfPrinter() {}', 'private PdfPrinter() { NativeHrService.logLifecycle(null, "x"); }'],
  'shared-cached-pool': [P, 'Executors.newSingleThreadExecutor(r -> {', 'Executors.newCachedThreadPool(r -> {'],
  'second-executor': [P, 'private PdfPrinter() {}', 'private PdfPrinter() {}\n    private static final ExecutorService X = Executors.newFixedThreadPool(2);'],
  'other-thread': [P, 'EXEC.execute(() -> {', 'new Thread(() -> {'],
  'no-recycle': [P, 'if (bmp != null) { bmp.recycle(); bmp = null; }\n                }', 'bmp = null;\n                }'],
  'no-page-memcheck': [P, 'if (lowMemory(app, n - i)) { s.fail("pdf_low_memory"); return; }\n', ''],
  'page-memcheck-heap-only': [P, 'lowMemory(app, n - i)', 'lowMemory(app, 0)'],
  'heap-formula': [P, 'Plan.heapLow(rt.maxMemory(), rt.totalMemory(), rt.freeMemory())', 'Plan.heapLow(rt.maxMemory(), rt.totalMemory(), 0)'],
  'catch-exception-only': [P, '} catch (Throwable t) {\n            Log.w(TAG, "print failed: " + t);', '} catch (Exception t) {\n            Log.w(TAG, "print failed: " + t);'],
  'oom-uncaught': [P, 'catch (OutOfMemoryError oom) {', 'catch (IllegalStateException oom) {'],
  'settle-before-close': [P, 'failCode = "pdf_low_memory";', 's.fail("pdf_low_memory");'],
  'bare-reject-swapped': [P, 's.fail("pdf_bad_pages"); return;', 'call.reject("pdf_bad_pages"); return;', 'try { call.resolve(ret); }', 'try { }'],
  'busy-leak': [P, '} finally {\n                        BUSY.set(false);\n                    }', '} catch (Throwable ignored) {}'],
  'bare-reject': [P, 's.fail("pdf_bad_pages"); return;', 'call.reject("pdf_bad_pages"); return;'],
  'plugin-uses-engine': [S, 'PdfPrinter.print(getContext(), getActivity(), call);', 'engineOrReject(call);\n            PdfPrinter.print(getContext(), getActivity(), call);'],
  'plugin-catch-exception': [S, '} catch (Throwable t) {\n            call.reject("pdf_failed");', '} catch (Exception t) {\n            call.reject("pdf_failed");'],
  'js-register-plugin': [JS, 'return (cap && cap.Plugins && cap.Plugins.NativeHrSession) || null;', 'return cap.registerPlugin("NativeHrSession");'],
  'js-not-iife': [JS, "})();\n", "})\n"],
};
function copyTree(dst) {
  for (const f of fs.readdirSync(path.join(WT, J))) fs.mkdirSync(path.join(dst, J), { recursive: true }), fs.copyFileSync(path.join(WT, J, f), path.join(dst, J, f));
  for (const f of FILES) { const s = path.join(WT, f); if (!fs.existsSync(s)) continue; fs.mkdirSync(path.dirname(path.join(dst, f)), { recursive: true }); fs.copyFileSync(s, path.join(dst, f)); }
}
let bad = 0;
for (const [name, [file, a, b, c, d]] of Object.entries(M)) {
  const dst = fs.mkdtempSync(path.join(os.tmpdir(), 'bmut-'));
  try {
    copyTree(dst);
    const fp = path.join(dst, file);
    let t = fs.readFileSync(fp, 'utf8').replace(/\r\n/g, '\n');
    if (!t.includes(a)) { console.log('ANCHOR   ' + name); bad++; continue; }
    let u = t.replace(a, b);
    if (c != null) { if (!u.includes(c)) { console.log('ANCHOR   ' + name); bad++; continue; } u = u.replace(c, d); }
    fs.writeFileSync(fp, u);
    const r = spawnSync('node', [path.join(WT, 'scripts/engine-boundary.test.cjs'), '--root=' + dst], { encoding: 'utf8' });
    const fails = (r.stdout.match(/^FAIL .*$/mg) || []);
    const pdfFails = fails.filter(l => l.includes('[S15a]'));
    const caught = r.status !== 0 && pdfFails.length > 0;
    console.log((caught ? 'caught   ' : 'MISSED   ') + name + '  ' + (pdfFails[0] || fails[0] || 'exit ' + r.status));
    if (!caught) bad++;
  } finally { fs.rmSync(dst, { recursive: true, force: true }); }
}
// baseline: unmutated copy passes
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'bmut-'));
copyTree(base);
const r0 = spawnSync('node', [path.join(WT, 'scripts/engine-boundary.test.cjs'), '--root=' + base], { encoding: 'utf8' });
fs.rmSync(base, { recursive: true, force: true });
console.log('baseline copy exit ' + r0.status + (r0.status ? '\n' + r0.stdout.split('\n').filter(l => l.startsWith('FAIL')).join('\n') : ''));
console.log(bad ? bad + ' not caught' : 'all ' + Object.keys(M).length + ' boundary mutants caught');
process.exit(bad || r0.status ? 1 : 0);
