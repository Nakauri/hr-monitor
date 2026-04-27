// Inline-script parse check for the project's single-file HTML pages.
// Catches duplicate-const / bracket / typo errors that would brick the page
// silently in the browser. Run before any push that touches the HTMLs.
//
// Usage: node scripts/parse-check.js
// Exit: 0 = clean (or only the known false-positive on hr_monitor.html), 1 = real failure.

const fs = require('fs');
const path = require('path');

const TARGETS = ['hr_monitor.html', 'hrv_viewer.html', 'overlay.html', 'index.html', 'legal.html'];
// hr_monitor.html has a known false-positive: a CSS comment around line ~176
// contains the literal text "<script>" which the regex treats as a script
// open. The block it captures is CSS, not JS, so it fails to parse. That
// failure is NOT a real bug and is allow-listed below.
const KNOWN_FALSE_POSITIVES = { 'hr_monitor.html': 1 };

const ROOT = path.resolve(__dirname, '..');
let realFailures = 0;

for (const file of TARGETS) {
  const full = path.join(ROOT, file);
  if (!fs.existsSync(full)) { console.log(`[skip] ${file} not found`); continue; }
  const html = fs.readFileSync(full, 'utf8');
  const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g;
  let m, idx = 0, bad = 0;
  while ((m = re.exec(html))) {
    idx++;
    try { new Function(m[1]); }
    catch (e) {
      bad++;
      const lineOfMatch = html.slice(0, m.index).split('\n').length;
      console.log(`  ${file}: block #${idx} (around line ${lineOfMatch}): ${e.message}`);
    }
  }
  const expected = KNOWN_FALSE_POSITIVES[file] || 0;
  if (bad > expected) {
    realFailures++;
    console.log(`[FAIL] ${file}: ${bad} bad / ${idx} blocks (expected ${expected} false-positive)`);
  } else {
    console.log(`[ok]   ${file}: ${idx} blocks (bad=${bad}, allow-listed=${expected})`);
  }
}

if (realFailures > 0) {
  console.log(`\n${realFailures} file(s) failed parse-check. DO NOT PUSH.`);
  process.exit(1);
}
console.log('\nAll inline scripts parse cleanly.');
process.exit(0);
