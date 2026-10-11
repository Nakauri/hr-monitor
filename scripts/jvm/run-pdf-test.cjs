#!/usr/bin/env node
// Compiles the JVM-PURE block of PdfPrinter.java as a plain class and runs scripts/jvm/PdfPlanTest.java
// on JDK 21 (no Gradle, no Android), then reruns it against mutated copies, each of which must FAIL.
// Run: node scripts/jvm/run-pdf-test.cjs          (exit 0 = test passes AND every mutant fails)
//      node scripts/jvm/run-pdf-test.cjs none     (the real block only)

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const SRC = path.join(ROOT, 'mobile', 'android-overlay', 'app', 'src', 'main', 'java', 'com', 'nakauri', 'hrmonitor', 'PdfPrinter.java');
const TEST = 'PdfPlanTest';

const JDK = process.env.JAVA_HOME || 'C:\\Program Files\\Eclipse Adoptium\\jdk-21.0.10.7-hotspot';
const bin = (n) => path.join(JDK, 'bin', n + (process.platform === 'win32' ? '.exe' : ''));

const MUTANTS = {
  'scale-1x': ['static final int SCALE = 2;', 'static final int SCALE = 1;'],
  'landscape-swapped': ['return landscape ? PAGE_H_PT : PAGE_W_PT;', 'return landscape ? PAGE_W_PT : PAGE_H_PT;'],
  'budget-16mb': ['BUDGET_BYTES = 24L * 1024L * 1024L;', 'BUDGET_BYTES = 16L * 1024L * 1024L;'],
  'budget-boundary': ['return headroom(max, total, free) < BUDGET_BYTES;', 'return headroom(max, total, free) <= BUDGET_BYTES;'],
  'headroom-ignores-free': ['return max - (total - free);', 'return max - total;'],
  'system-one-page': ['pages * rasterBytes() + BUDGET_BYTES', 'rasterBytes() + BUDGET_BYTES'],
  'system-ignores-flag': ['return lowFlag || avail - threshold', 'return avail - threshold'],
  'pages-floor': ['return 1 + (m + 1) / 2 + (week ? 1 : 0);', 'return 1 + m / 2 + (week ? 1 : 0);'],
  'pages-uncapped': ['int m = Math.max(0, Math.min(moments, MAX_MOMENTS));', 'int m = Math.max(0, moments);'],
  'week-ignored': ['return 1 + (m + 1) / 2 + (week ? 1 : 0);', 'return 1 + (m + 1) / 2;'],
  'fits-loose': ['return w == rasterW(landscape) && h == rasterH(landscape);', 'return w <= rasterW(landscape) && h <= rasterH(landscape);'],
  'name-keeps-path': ["s = s.substring(Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\\\')) + 1);", ''],
  'name-keeps-dots': ['.replaceAll("^[.-]+", "")', ''],
};

function extract(text) {
  const a = text.indexOf('// JVM-PURE BEGIN');
  const b = text.indexOf('// JVM-PURE END');
  if (a < 0 || b < a) return null;
  const block = text.slice(text.indexOf('\n', a) + 1, b);
  if (!/static final class Plan\b/.test(block)) return null;
  return 'package com.nakauri.hrmonitor;\n\n' + block.replace(/static final class Plan\b/, 'final class Plan');
}

function run(mutant) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'pdfjvm-'));
  try {
    const srcDir = path.join(work, 'src', 'com', 'nakauri', 'hrmonitor');
    const outDir = path.join(work, 'out');
    fs.mkdirSync(srcDir, { recursive: true });
    fs.mkdirSync(outDir);
    let text = fs.readFileSync(SRC, 'utf8').replace(/\r\n/g, '\n');
    if (mutant) {
      if (!text.includes(mutant[0])) return { ok: false, out: 'mutation anchor not found: ' + mutant[0], anchorMissing: true };
      text = text.replace(mutant[0], mutant[1]);
    }
    const plan = extract(text);
    if (!plan) return { ok: false, out: 'JVM-PURE block or Plan class not found', compileFail: true };
    const p = path.join(srcDir, 'Plan.java');
    fs.writeFileSync(p, plan);
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
if (!real.ok) { console.error('\nPdfPlanTest FAILED on the real block.'); process.exit(1); }
if (only === 'none') { console.log('\nPdfPlanTest passes.'); process.exit(0); }
let bad = 0;
for (const [name, m] of Object.entries(MUTANTS)) {
  if (only && only !== name) continue;
  const r = run(m);
  const caught = !r.ok && !r.anchorMissing && !r.compileFail;
  const failed = (r.out.match(/^\s*FAIL\s+.*$/m) || [''])[0].trim();
  console.log((caught ? 'caught   ' : 'MISSED   ') + name + (caught ? '  (' + failed + ')' : '  ' + r.out.split('\n')[0]));
  if (!caught) bad++;
}
console.log(bad ? '\n' + bad + ' mutant(s) not caught.' : '\nPdfPlanTest passes; all mutants caught.');
process.exit(bad ? 1 : 0);
