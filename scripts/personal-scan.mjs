#!/usr/bin/env node
// Guards: personal values in this public repo. 2026-10-28: the owner's real strap serial sat in a page comment, two
// Java tests and five browser checks, unnoticed, because "no personal values in tracked files" was a rule with
// nothing running it. Scans every file git would publish (tracked, plus new files not ignored) for:
//   - values on a deny list kept OUTSIDE the repo (the list is itself personal): $HRM_PERSONAL_LIST, else
//     ~/.claude/private/hr-monitor-personal.txt, one value per line, # comments. Missing in CI: generic rules only.
//   - generic shapes: email addresses (not example.com or a no-reply sender), Windows or Git Bash user paths, real
//     MAC addresses (AA:BB:CC:DD:.. is the house fake), strap names with a serial ("808S 0012345" is the house fake).
// A real exception goes in ALLOW below with the reason. Runtime: under 2 s. Usage: node scripts/personal-scan.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SELF = 'scripts/personal-scan.mjs';
const FAKE_SERIAL = '0012345';

export const RULES = [
  ['email', /\b[A-Za-z0-9._%+-]+@(?!example\.(?:com|org|net)\b)[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b/g,
    (m) => !/^(?:noreply|no-reply|git)@/i.test(m) && !/@users\.noreply\.github\.com$/i.test(m)],
  ['user path', /\b[A-Za-z]:[\\/]+Users[\\/]+(?!Public\b)[A-Za-z0-9._ -]+|\/[a-z]\/Users\/(?!Public\b)[A-Za-z0-9._-]+|\/home\/(?!runner\b)[a-z0-9._-]+/g, () => true],
  ['MAC address', /\b(?:[0-9A-F]{2}:){5}[0-9A-F]{2}\b/g, (m) => !/^AA:BB:CC:DD:/.test(m) && !/^00:00:00:00:00:00$/.test(m)],
  ['strap serial', /\b(?:H?808S|H10|H9|HRM-?Pro|TICKR|Polar H\d+)\s+(\d{6,8})\b/g, (m, g1) => g1 !== FAKE_SERIAL],
];
// [file, rule, text] that is public by design, with why.
const ALLOW = [];
// Files whose emails are third-party package metadata (npm authors), public by design.
const EMAIL_EXEMPT = /(^|\/)package-lock\.json$/;

function denyList() {
  const p = process.env.HRM_PERSONAL_LIST || path.join(os.homedir(), '.claude', 'private', 'hr-monitor-personal.txt');
  if (!fs.existsSync(p)) return null;
  return fs.readFileSync(p, 'utf8').split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
}

export function scanText(text, deny) {
  const hits = [];
  const lines = text.split(/\r?\n/);
  lines.forEach((line, i) => {
    for (const [name, re, keep] of RULES) {
      for (const m of line.matchAll(re)) if (keep(m[0], m[1])) hits.push([i + 1, name, m[0]]);
    }
    for (const v of deny || []) if (line.toLowerCase().includes(v.toLowerCase())) hits.push([i + 1, 'deny list', '(listed value)']);
  });
  return hits;
}

// Self-test, every run.
const CASES = [
  ['mail me at someone@gmail.com', 1], ['demo@example.com', 0], ['noreply@anthropic.com', 0],
  ['C:\\Users\\Someone\\Desktop', 1], ['/c/Users/Someone/x', 1], ['C:\\Users\\Public\\x', 0],
  ['mac: 1C:2B:3D:4E:5F:60', 1], ['mac: AA:BB:CC:DD:00:25', 0],
  ["name: '808S 0025153'", 1], ["name: '808S 0012345'", 0], ['Polar H10 9A1B2C3D', 0],
];
const bad = CASES.filter(([s, n]) => scanText(s, []).length !== n);
const denyCase = scanText('a secret-value here', ['Secret-Value']).length === 1;
if (bad.length || !denyCase) {
  console.log('personal-scan: FAIL self-test: ' + bad.map(([s, n]) => JSON.stringify(s) + ' should hit ' + n).join('; ') + (denyCase ? '' : ' deny list'));
  process.exit(1);
}

const deny = denyList();
const files = execFileSync('git', ['-C', ROOT, 'ls-files', '--cached', '--others', '--exclude-standard', '-z'], { encoding: 'utf8' })
  .split('\0').filter(Boolean).filter((f) => f !== SELF && fs.existsSync(path.join(ROOT, f)));
let found = 0;
for (const f of files) {
  const buf = fs.readFileSync(path.join(ROOT, f));
  if (buf.includes(0)) continue;
  for (const [line, rule, text] of scanText(buf.toString('utf8'), deny)) {
    if (ALLOW.some(([af, ar, at]) => af === f && ar === rule && at === text)) continue;
    if (rule === 'email' && EMAIL_EXEMPT.test(f)) continue;
    console.log(`FAIL ${f}:${line} ${rule}: ${text}`);
    found++;
  }
}
const listNote = deny ? `${deny.length} listed values` : (process.env.CI ? 'no deny list in CI: generic rules only' : 'WARNING no local deny list found; generic rules only');
console.log(`personal-scan: ${files.length} files, ${found} hits (${listNote})`);
process.exit(found ? 1 : 0);
