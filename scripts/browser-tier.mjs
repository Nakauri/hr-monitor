#!/usr/bin/env node
// The browser tier: the headless Playwright checks, run by the files they guard. ./check calls it, so the
// pre-push hook runs every check whose guarded file (or whose own script) changed since origin/main.
// Guards: these checks were run by hand only (report card 2026-10-24, Verification held at B+), and checks
// run by hand drift red unnoticed (day-boundary and marks-store were failing on main the same day).
// Needs the gitignored ux-audit kit (Playwright) and, for monitor checks, mobile/www from copy-web, which
// this runner refreshes; so it runs on the machine that pushes, not in CI (CI prints why it skips).
// Left out on purpose: pdf-proof (needs a phone session), shot-diff (a picture tool, not a check),
// viewer-perf (headless timings swing 15% run to run, so a budget there fails without a bug).
// Runtime: 0 s with nothing changed; about 10 to 15 min when hrv_viewer.html changes; about 25 min for --all.
// Usage: node scripts/browser-tier.mjs [--all | --base <ref>] [--list] [--only a,b]
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { uxDir } from './ux-dir.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const val = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };

const VIEWER = /^(hrv_viewer\.html|ui\.(css|js)|tokens\.css|report\.css|marks-(store|drive)\.js|settings\.js)$/;
const MONITOR = /^(hr_monitor\.html|ui\.(css|js)|tokens\.css|widget\.(css|js)|marks-(store|drive)\.js|settings\.js|diagnostics\.js)$/;
const NATIVE = /^mobile\/(src|android-overlay|scripts)\//;
// name: [guarded paths, args, needs mobile/www]
const TIER = {
  'date-nav': [VIEWER, [], false],
  'day-moments': [VIEWER, [], false],
  'day-explorer': [VIEWER, [], false],
  'day-panels': [VIEWER, [], false],
  'day-report': [VIEWER, [], false],
  'parse-worker': [VIEWER, [], false],
  'open-cache': [VIEWER, [], false],
  'session-time': [/^(hrv_viewer|hr_monitor)\.html$/, [], false],
  'sleep-split': [VIEWER, [], false],
  'v2-series': [VIEWER, [], false],
  'viewer-nav': [VIEWER, [], false],
  'trends-widgets': [VIEWER, [], false],
  'touch-zoom': [VIEWER, [], false],
  'symptom-marks': [VIEWER, [], false],
  'marks-pages': [new RegExp(VIEWER.source + '|' + MONITOR.source), ['--checks'], false],
  'kpi-tiles': [new RegExp(VIEWER.source + '|' + MONITOR.source), [], false],
  'monitor-log': [MONITOR, [], true],
  'monitor-controls': [MONITOR, [], true],
  'monitor-consistency': [MONITOR, [], true],
  'monitor-sync': [new RegExp(MONITOR.source + '|^app-home\\.html$'), [], true],
  'monitor-status': [MONITOR, [], true],
  'native-rmssd': [new RegExp(MONITOR.source + '|' + NATIVE.source), [], true],
  'strap-switch': [new RegExp(MONITOR.source + '|' + NATIVE.source), [], true],
  'strap-picker': [new RegExp(MONITOR.source + '|' + NATIVE.source), [], true],
  'signal-chip': [MONITOR, [], true],
  'ui-dialogs': [/\.html$|^ui\.(css|js)$/, [], true],
  'zone-preview': [/^(hr_monitor|overlay)\.html$|^widget\.(css|js)$/, [], false],
  'widget-parity': [/^(hr_monitor|overlay)\.html$|^widget\.(css|js)$/, [], false],
  'overlay-behaviour': [/^overlay\.html$|^widget\.(css|js)$/, [], false],
  'landing': [/^(index|new-look|legal|changelog)\.html$|^assets\/landing\/|^ui\.css$|^tokens\.css$/, [], false],
  'no-widows': [/\.html$|\.css$/, [], false],
  'csp': [/^vercel\.json$|^scripts\/csp(-hashes)?\.mjs$|\.html$|^(ui|widget|auth|diagnostics|settings|marks-store|marks-drive)\.js$/, [], false],
};

const only = (val('--only') || '').split(',').filter(Boolean);
let names = Object.keys(TIER);
if (only.length) names = names.filter((n) => only.includes(n));
else if (!args.includes('--all')) {
  const base = val('--base') || 'origin/main';
  let changed;
  try {
    changed = execFileSync('git', ['-C', ROOT, 'diff', '--name-only', base + '...HEAD'], { encoding: 'utf8' }).split('\n').filter(Boolean);
  } catch (e) {
    console.log(`browser-tier: cannot diff against ${base}; running every check`);
    changed = null;
  }
  if (changed) names = names.filter((n) => changed.includes(`scripts/${n}.mjs`) || changed.includes('scripts/browser-tier.mjs') || changed.some((f) => TIER[n][0].test(f)));
}
if (args.includes('--list')) { console.log(names.join('\n') || '(none)'); process.exit(0); }
if (!names.length) { console.log('browser-tier: no guarded file changed; nothing to run'); process.exit(0); }

let kit;
try { kit = path.join(uxDir(ROOT), 'kit'); } catch (e) { kit = null; }
if (!kit || !fs.existsSync(path.join(kit, 'node_modules', 'playwright'))) {
  console.log(`browser-tier: SKIPPED ${names.length} check(s): the ux-audit kit with Playwright is not on this machine (expected in CI; never on the pushing machine)`);
  process.exit(process.env.CI ? 0 : 2);
}

if (names.some((n) => TIER[n][2])) {
  console.log('== npm run copy-web (monitor checks read mobile/www)');
  const r = spawnSync('npm', ['run', 'copy-web'], { cwd: path.join(ROOT, 'mobile'), encoding: 'utf8', shell: process.platform === 'win32' });
  if (r.status !== 0) { console.log('browser-tier: copy-web failed\n' + (r.stderr || r.stdout)); process.exit(1); }
}

const results = [];
for (const n of names) {
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', n + '.mjs'), ...TIER[n][1]], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const secs = Math.round((Date.now() - t0) / 1000);
  const ok = r.status === 0;
  const tail = ((r.stdout || '') + (r.stderr || '')).trim().split('\n').slice(-3).join(' | ').slice(0, 220);
  results.push([n, ok, secs, tail]);
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${n.padEnd(20)} ${String(secs).padStart(4)} s  ${ok ? '' : tail}`);
}
const failed = results.filter((r) => !r[1]);
console.log(`\nbrowser-tier: ${results.length - failed.length} of ${results.length} passed in ${results.reduce((s, r) => s + r[2], 0)} s`);
process.exit(failed.length ? 1 : 0);
