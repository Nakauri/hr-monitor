#!/usr/bin/env node
// Parity of the numbers both engines compute: RMSSD, SDNN, raw RR to ms, HR and RMSSD stage.
// Reads the REAL functions from hr_monitor.html and HrEngine.java / GattHrDevice.java (the Java is
// compiled into a small harness with javac), runs both on a golden vector plus 300 seeded random
// vectors, then proves itself: a mutated JS copy and a mutated Java copy must each fail.
// Guards the April 2026 bug (relay 133, monitor 86 on the same strap) and RMSSD=36 / HR=93 stage
// colours that differed between the monitor and the overlay.
// Run: node scripts/rmssd-parity.test.js   (exit 0 = parity holds AND every mutant fails; about 3 s)
import fs from 'fs';
import os from 'os';
import path from 'path';
import vm from 'vm';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const JAVA_DIR = path.join(ROOT, 'mobile', 'android-overlay', 'app', 'src', 'main', 'java', 'com', 'nakauri', 'hrmonitor');
const JDK = process.env.JAVA_HOME || 'C:\\Program Files\\Eclipse Adoptium\\jdk-21.0.10.7-hotspot';
const bin = (n) => path.join(JDK, 'bin', n + (process.platform === 'win32' ? '.exe' : ''));
const read = (p) => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');

// Brace-matched block starting at the first line-start match of `head` (a regex source).
function block(src, head, what) {
  const m = new RegExp('^[ \\t]*' + head, 'm').exec(src);
  if (!m) throw new Error('not found: ' + what);
  const i = m.index, j = src.indexOf('{', i);
  let d = 0;
  for (let k = j; k < src.length; k++) {
    if (src[k] === '{') d++;
    else if (src[k] === '}' && --d === 0) return src.slice(i, k + 1);
  }
  throw new Error('unbalanced: ' + what);
}

function jsEngine(html) {
  const conv = /rrs\.push\((Math\.round\(raw[^;]*)\);/.exec(html);
  if (!conv) throw new Error('not found: JS raw RR conversion');
  const code = ['computeRMSSD', 'computeSDNN', 'getHRStage', 'getRMSSDStage'].map((n) => block(html, 'function ' + n + '\\(', n)).join('\n') +
    '\nfunction rrConv(raw) { return ' + conv[1] + '; }';
  const ctx = { Math, colorThresholds: {}, thresholds: {} };
  vm.runInNewContext(code, ctx);
  return {
    rr: (rrs) => [ctx.computeRMSSD(rrs), ctx.computeSDNN(rrs)],
    conv: (raw) => ctx.rrConv(raw),
    hrStage: (hr, t) => { Object.assign(ctx.colorThresholds, { low: t.low, normal: t.normal, elevated: t.elevated }); ctx.thresholds.high = t.high; return ctx.getHRStage(hr); },
    rmStage: (v, crit) => { ctx.thresholds.rmssd = crit; return ctx.getRMSSDStage(v); },
  };
}

function javaHarness(engine, gatt) {
  const conv = /rrs\.add\(((?:\(int\) )?(?:Math\.round)?\(raw[^;]*)\);/.exec(gatt);
  if (!conv) throw new Error('not found: Java raw RR conversion');
  const parts = [
    block(engine, 'private static final class RrEntry', 'RrEntry'),
    block(engine, 'private static Double computeRmssd\\(', 'computeRmssd'),
    block(engine, 'private static Double computeSdnn\\(', 'computeSdnn'),
    block(engine, 'private String hrStage\\(', 'hrStage').replace('private String', 'static String'),
    block(engine, 'private String rmssdStage\\(', 'rmssdStage').replace('private String', 'static String'),
  ];
  return `import java.util.*;
import java.io.*;
public class ParityHarness {
  static int stageLow, stageNormal, stageElevated, stageHigh, stageRmssdCritical;
  static int rrConv(int raw) { return ${conv[1]}; }
${parts.join('\n')}
  public static void main(String[] args) throws Exception {
    BufferedReader in = new BufferedReader(new InputStreamReader(System.in));
    StringBuilder out = new StringBuilder();
    String line;
    while ((line = in.readLine()) != null) {
      String[] p = line.split(" ");
      if (p[0].equals("rr")) {
        ArrayDeque<RrEntry> w = new ArrayDeque<>();
        if (p.length > 1 && !p[1].isEmpty()) for (String s : p[1].split(",")) w.addLast(new RrEntry(Integer.parseInt(s), 0L));
        out.append(computeRmssd(w)).append(' ').append(computeSdnn(w)).append('\\n');
      } else if (p[0].equals("conv")) {
        out.append(rrConv(Integer.parseInt(p[1]))).append('\\n');
      } else if (p[0].equals("hr")) {
        stageLow = Integer.parseInt(p[2]); stageNormal = Integer.parseInt(p[3]); stageElevated = Integer.parseInt(p[4]); stageHigh = Integer.parseInt(p[5]);
        out.append(hrStage(Integer.parseInt(p[1]))).append('\\n');
      } else if (p[0].equals("rm")) {
        stageRmssdCritical = Integer.parseInt(p[2]);
        out.append(rmssdStage(Double.parseDouble(p[1]))).append('\\n');
      }
    }
    System.out.print(out);
  }
}
`;
}

// The cases: golden RR (normal, RSA, ectopic pair, out-of-range high and low), 300 seeded random
// vectors, raw values where rounding and truncation disagree, and the stage boundaries.
const GOLDEN = [800, 810, 790, 820, 805, 400, 1200, 810, 795, 805, 2500, 200, 820, 815, 800, 810, 790, 805];
const EXPECTED_RMSSD = 16.2018517460; // sqrt(3150 / 12), worked by hand in the history of this file
let seed = 20261024;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const vectors = [GOLDEN, [], [800], [800, 2500], [800, 1100]];
for (let v = 0; v < 300; v++) {
  const n = Math.floor(rnd() * 60), a = [];
  let base = 600 + Math.floor(rnd() * 500);
  for (let i = 0; i < n; i++) {
    const r = rnd();
    if (r < 0.08) a.push(100 + Math.floor(rnd() * 2600));          // out of range or ectopic-sized
    else if (r < 0.14) a.push(base + (rnd() < 0.5 ? -1 : 1) * (190 + Math.floor(rnd() * 30))); // around the 200 ms diff edge
    else { base += Math.floor(rnd() * 41) - 20; a.push(base); }
  }
  vectors.push(a);
}
const RAWS = [819, 820, 821, 1000, 1023, 1025, 512, 305, 2047, 410, 833, 847];
const T = { low: 70, normal: 90, elevated: 110, high: 130 };
const HRS = [50, 69, 70, 71, 89, 90, 93, 109, 110, 115, 129, 130, 180];
const RMS = [[10, 15], [14.99, 15], [15, 15], [16, 15], [19.99, 15], [20, 15], [22, 15], [34.9, 15], [35, 15], [36, 15], [55, 15], [59.99, 15], [60, 15], [80, 15], [12, 10]];

function compare(js, javaOut) {
  const lines = javaOut.trim().split('\n');
  const bad = [];
  let k = 0;
  const num = (s) => (s === 'null' ? null : parseFloat(s));
  const same = (a, b) => (a == null || b == null ? a == null && b == null : Math.abs(a - b) < 1e-9);
  for (const v of vectors) {
    const [jr, js2] = js.rr(v), [xr, xs] = lines[k++].split(' ').map(num);
    if (!same(jr, xr) || !same(js2, xs)) bad.push(`RR [${v.slice(0, 8).join(',')}${v.length > 8 ? ',...' : ''}] js=${jr},${js2} java=${xr},${xs}`);
  }
  for (const r of RAWS) { const a = js.conv(r), b = +lines[k++]; if (a !== b) bad.push(`raw ${r}: js=${a} java=${b}`); }
  for (const h of HRS) { const a = js.hrStage(h, T), b = lines[k++]; if (a !== b) bad.push(`HR ${h}: js=${a} java=${b}`); }
  for (const [v, c] of RMS) { const a = js.rmStage(v, c), b = lines[k++]; if (a !== b) bad.push(`RMSSD ${v} (critical ${c}): js=${a} java=${b}`); }
  return bad;
}

function run(html, engine, gatt) {
  const js = jsEngine(html);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rmssd-parity-'));
  try {
    fs.writeFileSync(path.join(dir, 'ParityHarness.java'), javaHarness(engine, gatt));
    const c = spawnSync(bin('javac'), ['-nowarn', '-d', dir, path.join(dir, 'ParityHarness.java')], { encoding: 'utf8' });
    if (c.status !== 0) throw new Error('javac failed:\n' + c.stderr);
    const input = [
      ...vectors.map((v) => 'rr ' + v.join(',')),
      ...RAWS.map((r) => 'conv ' + r),
      ...HRS.map((h) => `hr ${h} ${T.low} ${T.normal} ${T.elevated} ${T.high}`),
      ...RMS.map(([v, c]) => `rm ${v} ${c}`),
    ].join('\n') + '\n';
    const r = spawnSync(bin('java'), ['-cp', dir, 'ParityHarness'], { input, encoding: 'utf8' });
    if (r.status !== 0) throw new Error('java failed:\n' + r.stderr);
    return { js, bad: compare(js, r.stdout) };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const html = read(path.join(ROOT, 'hr_monitor.html'));
const engine = read(path.join(JAVA_DIR, 'HrEngine.java'));
const gatt = read(path.join(JAVA_DIR, 'GattHrDevice.java'));
let failed = 0;

const real = run(html, engine, gatt);
const golden = real.js.rr(GOLDEN)[0];
const goldenOk = Math.abs(golden - EXPECTED_RMSSD) < 1e-6;
console.log((goldenOk ? 'OK    ' : 'FAIL  ') + `golden RMSSD ${golden} (expected ${EXPECTED_RMSSD})`);
if (!goldenOk) failed++;
const bites = RAWS.some((r) => real.js.conv(r) !== Math.trunc(r * 1000 / 1024));
console.log((bites ? 'OK    ' : 'FAIL  ') + 'raw RR values exercise rounding against truncation');
if (!bites) failed++;
console.log((real.bad.length ? 'FAIL  ' : 'OK    ') + `real JS against real Java: ${vectors.length} RR vectors, ${RAWS.length} raw values, ${HRS.length + RMS.length} stages` + (real.bad.length ? '\n        ' + real.bad.slice(0, 6).join('\n        ') : ''));
if (real.bad.length) failed++;

// Negative controls: each mutated source must make parity FAIL.
const MUTANTS = [
  ['Java RR floor 300 -> 250', html, engine.replace('e.rrMs >= 300 && e.rrMs <= 2000) clean.add(e.rrMs);', 'e.rrMs >= 250 && e.rrMs <= 2000) clean.add(e.rrMs);'), gatt],
  ['JS ectopic gate 200 -> 250', html.replace('if (Math.abs(d) < 200) {', 'if (Math.abs(d) < 250) {'), engine, gatt],
  ['Java SDNN population (n)', html, engine.replace('return Math.sqrt(sumSq / (clean.size() - 1));', 'return Math.sqrt(sumSq / clean.size());'), gatt],
  ['Java raw RR truncates', html, engine, gatt.replace('(int) Math.round(raw * 1000.0 / 1024.0)', '(int) (raw * 1000 / 1024)')],
  ['JS HR low boundary exclusive', html.replace('if (hr <= colorThresholds.low)', 'if (hr < colorThresholds.low)'), engine, gatt],
  ['Java RMSSD stage 35 -> 36', html, engine.replace('if (rmssd < 35) return "stage-elevated";', 'if (rmssd < 36) return "stage-elevated";'), gatt],
];
for (const [name, h, e, g] of MUTANTS) {
  if (h === html && e === engine && g === gatt) { console.log(`FAIL  mutant "${name}" did not apply (source changed; update the mutant)`); failed++; continue; }
  const { bad } = run(h, e, g);
  console.log((bad.length ? 'OK    ' : 'FAIL  ') + `mutant "${name}" ${bad.length ? 'caught' : 'NOT caught'}`);
  if (!bad.length) failed++;
}

if (failed) {
  console.error(`\n${failed} check(s) failed. Mirror the change in the other engine (both carry PARITY CRITICAL), or update a mutant whose anchor moved.`);
  process.exit(1);
}
console.log('\nOK: JS and Java RMSSD, SDNN, RR conversion and stages match from source.');
