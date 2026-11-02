#!/usr/bin/env node
// Guards the published APK's manifest, read from the APK itself with aapt: a debuggable public APK (USB access reads
// app storage, S65 skeptic round 1 finding 11), an exported component nobody reviewed (finding 7), minSdk raised past
// 22 by a library, and any Health Connect write permission (round 2 M3; aorti never writes to Health Connect).
// Usage: node scripts/apk-manifest.test.cjs [--apk <path>] [--variant debug|release] [--self-test]
//   --apk: that file (a release APK unless --variant debug); without it the newest local build of --variant (default release).
//   --self-test: runs the checks on canned aapt output, each mutant must FAIL (no APK needed).
// aapt comes from $ANDROID_HOME/build-tools/<highest>/ (exit 2 naming the path when none). Runtime: seconds.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PKG = 'com.nakauri.hrmonitor';
// Exported components, each with its reason (S65 spec section 2).
const ALLOW = [
  'com.nakauri.hrmonitor.MainActivity',                                       // the launcher
  'com.google.android.gms.auth.api.signin.RevocationBoundService',            // Google sign-in, system permission
  'androidx.work.impl.background.systemjob.SystemJobService',                 // WorkManager, BIND_JOB_SERVICE
  'androidx.work.impl.diagnostics.DiagnosticsReceiver',                       // WorkManager, DUMP permission
  'androidx.profileinstaller.ProfileInstallReceiver',                         // ART profiles, DUMP permission
  'com.nakauri.hrmonitor.HealthRationaleActivity',                            // Health Connect starts it
  'com.nakauri.hrmonitor.ViewPermissionUsageActivity',                        // Android 14+ alias, system-only permission
  'androidx.health.platform.client.impl.sdkservice.HealthDataSdkService',     // Health Connect binds to it
].sort();

const args = process.argv.slice(2);
const argVal = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };

function aaptPath() {
  const home = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || path.join(require('os').homedir(), 'AppData', 'Local', 'Android', 'Sdk');
  const bt = path.join(home, 'build-tools');
  const exe = process.platform === 'win32' ? 'aapt.exe' : 'aapt';
  const vers = fs.existsSync(bt) ? fs.readdirSync(bt).filter((v) => fs.existsSync(path.join(bt, v, exe))) : [];
  vers.sort((a, b) => { const x = a.split('.').map(Number), y = b.split('.').map(Number); for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (y[i] || 0) - (x[i] || 0); return 0; });
  if (!vers.length) { console.log('MISSING aapt under ' + bt); process.exit(2); }
  return path.join(bt, vers[0], exe);
}

// Elements with android:exported true, from `aapt dump xmltree <apk> AndroidManifest.xml`.
function exported(xml) {
  const stack = [], out = [];
  const tags = new Set(['activity', 'activity-alias', 'service', 'receiver', 'provider']);
  for (const line of xml.split(/\r?\n/)) {
    const m = /^(\s*)(E|A): (.*)$/.exec(line);
    if (!m) continue;
    const ind = m[1].length;
    while (stack.length && stack[stack.length - 1].ind >= ind) stack.pop();
    if (m[2] === 'E') { const el = { ind, tag: m[3].split(' ')[0], name: null, exp: false, perm: null }; stack.push(el); if (tags.has(el.tag)) out.push(el); continue; }
    const el = stack[stack.length - 1];
    if (!el || !tags.has(el.tag)) continue;
    const name = /^android:name\(0x01010003\)="([^"]*)"/.exec(m[3]);
    if (name) el.name = name[1];
    const perm = /^android:permission\(0x01010006\)="([^"]*)"/.exec(m[3]);
    if (perm) el.perm = perm[1];
    if (/^android:exported\(0x01010010\)=\(type 0x12\)0xffffffff/.test(m[3])) el.exp = true;
  }
  const full = (n) => !n ? '?' : n.startsWith('.') ? PKG + n : n.includes('.') ? n : PKG + '.' + n;
  const list = [...new Set(out.filter((e) => e.exp).map((e) => full(e.name)))].sort();
  list.perms = Object.fromEntries(out.filter((e) => e.exp).map((e) => [full(e.name), e.perm]));
  return list;
}

function check(badging, xml, variant) {
  const res = [];
  const ok = (c, msg) => res.push((c ? 'PASS ' : 'FAIL ') + msg);
  ok(/^sdkVersion:'22'$/m.test(badging), `minSdkVersion 22 (badging: ${(/^sdkVersion:'[^']*'$/m.exec(badging) || ['none'])[0]})`);
  const dbg = /^application-debuggable$/m.test(badging);
  ok(variant === 'debug' ? dbg : !dbg, `${variant} APK debuggable ${dbg} (want ${variant === 'debug'})`);
  const writes = (badging.match(/uses-permission: name='android\.permission\.health\.WRITE_[A-Z_]+'/g) || []);
  ok(!writes.length, `no Health Connect write permission (${writes.length})`);
  // legal.html says the app reads sleep and nothing else.
  const reads = (badging.match(/uses-permission: name='android\.permission\.health\.READ_[A-Z_]+'/g) || []).filter((l) => !/READ_SLEEP'$/.test(l));
  ok(!reads.length, `no Health Connect read permission but READ_SLEEP (${reads.join(', ') || 'none'})`);
  const ex = exported(xml), extra = ex.filter((n) => !ALLOW.includes(n)), missing = ALLOW.filter((n) => !ex.includes(n));
  ok(!extra.length && !missing.length, `exported components equal the allow-list (${ex.length}; extra ${extra.join(', ') || 'none'}; missing ${missing.join(', ') || 'none'})`);
  const aliasPerm = ex.perms[PKG + '.ViewPermissionUsageActivity'];
  ok(aliasPerm === 'android.permission.START_VIEW_PERMISSION_USAGE', `the Android 14 alias keeps its system-only permission (${aliasPerm || 'none'})`);
  return res;
}

function selfTest() {
  let aliasPerm = true;
  const permLine = (name) => /UsageActivity$/.test(name) && aliasPerm ? '      A: android:permission(0x01010006)="android.permission.START_VIEW_PERMISSION_USAGE" (Raw: "android.permission.START_VIEW_PERMISSION_USAGE")\n' : '';
  const el = (tag, name, exp) => `    E: ${tag} (line=1)\n      A: android:name(0x01010003)="${name}" (Raw: "${name}")\n${permLine(name)}      A: android:exported(0x01010010)=(type 0x12)${exp ? '0xffffffff' : '0x0'}\n      E: intent-filter (line=2)\n        E: action (line=3)\n          A: android:name(0x01010003)="x.y" (Raw: "x.y")\n`;
  const xmlOf = (names) => 'N: android=http://schemas.android.com/apk/res/android\n  E: manifest (line=2)\n    E: application (line=3)\n' + names.map(([t, n, e]) => el(t, n, e)).join('');
  const good = ALLOW.map((n) => [n.endsWith('Service') ? 'service' : n.endsWith('Receiver') ? 'receiver' : n.endsWith('UsageActivity') ? 'activity-alias' : 'activity', n.replace(PKG + '.ViewPermissionUsageActivity', 'ViewPermissionUsageActivity'), true]).concat([['receiver', 'com.nakauri.hrmonitor.SymptomReceiver', false]]);
  const badging = "package: name='com.nakauri.hrmonitor'\nsdkVersion:'22'\ntargetSdkVersion:'34'\nuses-permission: name='android.permission.health.READ_SLEEP'\n";
  const cases = [
    ['real release', badging, xmlOf(good), 'release', true],
    ['real debug', badging + 'application-debuggable\n', xmlOf(good), 'debug', true],
    ['mutant: release APK debuggable', badging + 'application-debuggable\n', xmlOf(good), 'release', false],
    ['mutant: minSdk raised to 26', badging.replace("sdkVersion:'22'", "sdkVersion:'26'"), xmlOf(good), 'release', false],
    ['mutant: an extra exported receiver', badging, xmlOf(good.concat([['receiver', 'com.nakauri.hrmonitor.SymptomReceiver2', true]])), 'release', false],
    ['mutant: a Health Connect write permission', badging + "uses-permission: name='android.permission.health.WRITE_SLEEP'\n", xmlOf(good), 'release', false],
    ['mutant: another Health Connect read permission', badging + "uses-permission: name='android.permission.health.READ_HEART_RATE'\n", xmlOf(good), 'release', false],
    ['mutant: the alias lost its permission', badging, (aliasPerm = false, xmlOf(good)), 'release', false],
    ['mutant: rationale activity not exported', badging, xmlOf(good.map(([t, n, e]) => [t, n, /HealthRationale/.test(n) ? false : e])), 'release', false],
  ];
  let bad = 0;
  for (const [name, b, x, v, want] of cases) {
    const r = check(b, x, v), pass = r.every((l) => l.startsWith('PASS'));
    const fine = pass === want;
    if (!fine) bad++;
    console.log(`${fine ? 'OK  ' : 'BAD '} ${name}: ${pass ? 'passes' : 'FAILS (' + r.filter((l) => l.startsWith('FAIL')).join(' | ') + ')'}`);
  }
  console.log(bad ? `apk-manifest self-test: ${bad} wrong` : 'apk-manifest self-test: real cases pass, every mutant fails');
  process.exit(bad ? 1 : 0);
}

if (args.includes('--self-test')) selfTest();
const variant = argVal('--variant') || 'release';
let apk = argVal('--apk');
if (!apk) {
  const dir = path.join(ROOT, 'mobile', 'android', 'app', 'build', 'outputs', 'apk', variant);
  const list = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.apk')).map((f) => path.join(dir, f)) : [];
  list.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  if (!list.length) { console.log('MISSING ' + dir + path.sep + '*.apk'); process.exit(2); }
  apk = list[0];
}
if (!fs.existsSync(apk)) { console.log('MISSING ' + apk); process.exit(2); }
const aapt = aaptPath();
const badging = execFileSync(aapt, ['dump', 'badging', apk], { encoding: 'utf8', maxBuffer: 32 << 20 });
const xml = execFileSync(aapt, ['dump', 'xmltree', apk, 'AndroidManifest.xml'], { encoding: 'utf8', maxBuffer: 32 << 20 });
const r = check(badging, xml, variant);
console.log(r.join('\n'));
const fails = r.filter((l) => l.startsWith('FAIL')).length;
console.log(`apk-manifest ${path.basename(apk)} (${variant}): ${r.length - fails} pass, ${fails} fail`);
process.exit(fails ? 1 : 0);
