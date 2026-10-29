// Doc claims that a code change can silently falsify, checked against the code.
// Bugs it exists for: the contract's CSV header lost the three sdnn columns both writers had; README called
// the pages self-contained after they began loading shared scripts; a Status line still said "on branch
// grade-a" after the work merged.
// Usage: node scripts/docs-truth.test.cjs [repo root]. Runtime: under 1 s.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(process.argv[2] || path.join(__dirname, '..'));
const read = (rel) => { try { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); } catch (e) { return null; } };

let failures = 0;
function check(name, ok, detail) {
  console.log((ok ? 'OK    ' : 'FAIL  ') + name + (detail ? '  ' + detail : ''));
  if (!ok) failures++;
}

// 1. The contract's CSV header is the header both writers write.
const contract = read('docs/cross_surface_contract.md') || '';
const row = contract.split('\n').find((l) => /^\|\s*CSV header order\s*\|/.test(l)) || '';
const docHeader = ([...row.matchAll(/`([a-z0-9_]+(?:,[a-z0-9_]+)+)`/g)].pop() || [])[1] || '';
const mon = read('hr_monitor.html') || '';
const fnAt = mon.indexOf('function buildSessionCSV()');
const jsRow = fnAt < 0 ? null : (mon.slice(fnAt, fnAt + 2000).match(/const rows = \[\[([^\]]+)\]\]/) || [])[1];
const jsHeader = jsRow ? [...jsRow.matchAll(/'([^']+)'/g)].map((m) => m[1]).join(',') : '';
const java = read('mobile/android-overlay/app/src/main/java/com/nakauri/hrmonitor/NativeCsvWriter.java') || '';
const javaHeader = (java.match(/HEADER\s*=\s*"([^"]+)"/) || [])[1] || '';
check('contract has a CSV header order row', !!docHeader);
check('web writer header found (buildSessionCSV)', !!jsHeader);
check('native writer header found (NativeCsvWriter.HEADER)', !!javaHeader);
check('contract CSV header = web writer header', docHeader === jsHeader, `doc ${docHeader} | web ${jsHeader}`);
check('contract CSV header = native writer header', docHeader === javaHeader, `doc ${docHeader} | native ${javaHeader}`);

// 2. The pages load shared scripts and stylesheets, so the README never calls them self-contained.
for (const f of ['README.md', 'mobile/README.md']) {
  const t = read(f);
  if (t == null) continue;
  const hit = t.split('\n').findIndex((l) => /self-contained/i.test(l));
  check(`${f} does not call the pages self-contained`, hit < 0, hit >= 0 ? `line ${hit + 1}` : '');
}

// 3. A Status line states the current verdict; a branch name in it goes stale the day the branch merges.
let branches = [];
try {
  branches = execFileSync('git', ['-C', ROOT, 'for-each-ref', '--format=%(refname:lstrip=-1)', 'refs/heads', 'refs/remotes'], { encoding: 'utf8' })
    .split('\n').map((s) => s.trim()).filter((s) => s && s !== 'HEAD');
} catch (e) { console.log('note  git refs unreadable; checking the word "branch" only'); }
const docs = ['README.md', 'mobile/README.md', ...fs.readdirSync(path.join(ROOT, 'docs')).filter((f) => f.endsWith('.md')).map((f) => 'docs/' + f)];
let statusLines = 0;
for (const f of docs) {
  const lines = (read(f) || '').split('\n');
  lines.forEach((l, i) => {
    if (!/^\W*Status\W*:/i.test(l) && !/\bStatus:\s/.test(l)) return;
    statusLines++;
    const words = l.split(/[^\w./-]+/);
    const named = words.filter((w) => /^branch(es)?$/i.test(w) || branches.includes(w));
    check(`${f}:${i + 1} Status line names no branch`, named.length === 0, named.length ? 'names: ' + [...new Set(named)].join(', ') : '');
  });
}
check('found Status lines to check', statusLines > 0, statusLines + ' lines');

if (failures) { console.log(failures + ' docs truth check(s) FAILED.'); process.exit(1); }
console.log('All docs truth checks passed.');
