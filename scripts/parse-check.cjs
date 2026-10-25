// Inline-script parse check for the project's single-file HTML pages.
// Catches duplicate-const / bracket / typo errors that would brick the page
// silently in the browser. Run before any push that touches the HTMLs.
// Named bug: a duplicate `const totalSession` in hrv_viewer.html killed Sign In on 2026-04-26. Under 1 s.
//
// Usage: node scripts/parse-check.js
// Exit: 0 = clean (or only the known false-positive on hr_monitor.html), 1 = real failure.

const fs = require('fs');
const { spawnSync } = require('child_process');
const path = require('path');

const TARGETS = ['hr_monitor.html', 'hrv_viewer.html', 'overlay.html', 'index.html', 'legal.html', 'app-home.html', 'changelog.html', 'new-look.html'];
// Shared scripts loaded by those pages; checked with node --check.
// Every shipped script, found by listing, so a new file is never skipped. mobile/src was missing until
// 2026-10-24, when native-relay-socket.js had shipped unparseable for a day (a regex lost its backslashes).
const JS_TARGETS = [
  ...fs.readdirSync(path.resolve(__dirname, '..')).filter((f) => f.endsWith('.js')),
  'assets/landing/site.js',
  ...fs.readdirSync(path.resolve(__dirname, '..', 'mobile', 'src')).filter((f) => f.endsWith('.js')).map((f) => 'mobile/src/' + f),
];
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

for (const file of JS_TARGETS) {
  const full = path.join(ROOT, file);
  if (!fs.existsSync(full)) { console.log(`[skip] ${file} not found`); continue; }
  const r = spawnSync(process.execPath, ['--check', full], { encoding: 'utf8' });
  if (r.status !== 0) {
    realFailures++;
    console.log(`[FAIL] ${file}: node --check
${(r.stderr || '').trim()}`);
  } else {
    console.log(`[ok]   ${file}: node --check`);
  }
}

// A script from a version-pinned CDN path (lib@x.y.z or /x.y.z/) carries an integrity hash, so a
// tampered CDN file is refused instead of run (added 2026-10-24). Evergreen scripts (Google sign-in,
// Vercel analytics) change at the same URL and cannot be pinned.
for (const file of TARGETS) {
  const full = path.join(ROOT, file);
  if (!fs.existsSync(full)) continue;
  // Every src="https://...js", including ones built in strings ('<scr' + 'ipt ...' for an iframe), so the
  // tag is the text from src= to the next '>' rather than a parsed element.
  const text = fs.readFileSync(full, 'utf8');
  const re = /src="(https:\/\/[^"]*\.js)"[^>]*>/g;
  let m;
  while ((m = re.exec(text))) {
    const tag = m[0], src = m[1];
    if (!/@\d+\.\d+\.\d+\/|\/\d+\.\d+\.\d+\//.test(src)) continue;
    if (!/\bintegrity="sha(256|384|512)-[A-Za-z0-9+/=]+"/.test(tag) || !/\bcrossorigin="anonymous"/.test(tag)) {
      realFailures++;
      console.log(`[FAIL] ${file}: pinned CDN script without integrity + crossorigin: ${src}`);
    }
  }
}

if (realFailures > 0) {
  console.log(`\n${realFailures} file(s) failed parse-check. DO NOT PUSH.`);
  process.exit(1);
}
console.log('\nAll inline scripts parse cleanly.');
process.exit(0);
