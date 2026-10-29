#!/usr/bin/env node
// Guards: errors swallowed with no trace. The 10-24 audit found a native relay refusal and a Drive config write
// that failed silently (fixed in grade-a); an empty handler is where that hides. Counts, per shipped or deployed file,
// the handlers that neither handle nor surface: an empty or comment-only body (`catch (e) {}`, `.catch(() => {})`, a
// `.then(ok, () => {})` rejection handler, Java `catch (A | B e) { }`). A catch that returns a sentinel (`return null`)
// is handling: the caller checks it. Each file has a floor in scripts/catch-floor.json; a file not listed has floor
// 0 (recorder.js is at 0). The ratchet is checked against the committed file: a floor may only go up with a reason in
// "raised" (a detection change, never a new swallow). Runtime: under 1 s.
// Usage: node scripts/catch-floor.mjs [--write (lower floors to the counts) | --seed (first run only)]
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FLOOR_FILE = path.join(ROOT, 'scripts', 'catch-floor.json');
const JAVA = 'mobile/android-overlay/app/src/main/java/com/nakauri/hrmonitor';

function files() {
  const out = [];
  const add = (dir, re) => {
    if (!fs.existsSync(path.join(ROOT, dir))) return;
    for (const f of fs.readdirSync(path.join(ROOT, dir))) if (re.test(f)) out.push(path.posix.join(dir, f));
  };
  add('.', /^[A-Za-z0-9_.-]+\.(html|js)$/);
  add('mobile/src', /\.js$/);
  add(JAVA, /\.java$/);
  add('api/auth', /\.js$/);
  add('lib', /\.js$/);
  add('relay/src', /\.js$/);
  add('assets/landing', /\.js$/);
  return out.map((f) => f.replace(/^\.\//, '')).sort();
}

// A body that is empty, holds only comments, or only a stray semicolon.
const EMPTY = String.raw`\{\s*(?:(?:\/\*[\s\S]*?\*\/|\/\/[^\n]*|;)\s*)*\}`;
const FN = String.raw`(?:async\s+)?(?:\(\s*[^()]*\)|\w+)\s*=>\s*` + EMPTY + String.raw`|(?:async\s+)?function\s*\w*\s*\([^)]*\)\s*` + EMPTY;
const PATTERNS = [
  // The keyword only; `.catch(` calls are matched below.
  new RegExp(String.raw`(?<!\.)\bcatch\s*(?:\([^)]*\))?\s*` + EMPTY, 'g'),
  new RegExp(String.raw`\.catch\s*\(\s*(?:` + FN + String.raw`)\s*\)`, 'g'),
  // A rejection handler as .then's second argument.
  new RegExp(String.raw`\.then\s*\([^;]*?,\s*(?:` + FN + String.raw`)\s*\)`, 'g'),
];
export function countEmptyCatches(src) {
  let n = 0;
  for (const re of PATTERNS) n += (src.match(re) || []).length;
  return n;
}

// Self-test, every run: what counts and what does not.
const CASES = [
  ['try { a(); } catch (e) {}', 1], ['try { a(); } catch {}', 1], ['try { a(); } catch (e) { /* best effort */ }', 1],
  ['p.catch(() => {})', 1], ['p.catch(e => {})', 1], ['p.catch(function () {})', 1], ['} catch (IOException e) { }', 1],
  ['} catch (IOException | JSONException e) {}', 1], ['p.catch(async () => {})', 1], ['p.catch (() => {})', 1],
  ['catch(e){;}', 1], ['const s = p.then(() => {}, () => {});', 1], ['p.then(ok, function () {})', 1],
  ['try { a(); } catch (e) { warn(e); }', 0], ['p.catch((e) => console.warn(e))', 0], ['p.catch(() => false)', 0],
  ['catch (e) { return null; }', 0], ['p.then((v) => use(v), (e) => warn(e))', 0], ['p.then(() => {})', 0],
];
const wrong = CASES.filter(([s, n]) => countEmptyCatches(s) !== n);
if (wrong.length) { console.log('catch-floor: FAIL self-test: ' + wrong.map(([s, n]) => `${JSON.stringify(s)} should count ${countEmptyCatches(s)} -> ${n}`).join('; ')); process.exit(1); }

const counts = {};
for (const f of files()) {
  const n = countEmptyCatches(fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/\r\n/g, '\n'));
  if (n) counts[f] = n;
}
const read = (text) => { const j = JSON.parse(text); return j.floors ? j : { floors: j, raised: {} }; };
const have = fs.existsSync(FLOOR_FILE) ? read(fs.readFileSync(FLOOR_FILE, 'utf8')) : null;
let committed = null;
try { committed = read(execFileSync('git', ['-C', ROOT, 'show', 'HEAD:scripts/catch-floor.json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })); } catch (e) { committed = null; }
const save = (floors, raised) => fs.writeFileSync(FLOOR_FILE, JSON.stringify({ floors, raised }, null, 2) + '\n');

if (process.argv.includes('--seed')) {
  if (committed) { console.log('catch-floor: FAIL --seed is for a repo with no committed floors; use --write, or raise one with a reason in "raised"'); process.exit(1); }
  save(counts, {});
  console.log('catch-floor: seeded ' + Object.keys(counts).length + ' floors');
  process.exit(0);
}
if (!have) { console.log('catch-floor: FAIL scripts/catch-floor.json is missing'); process.exit(1); }
if (process.argv.includes('--write')) {
  const raised = Object.keys(counts).filter((f) => counts[f] > (have.floors[f] || 0));
  if (raised.length) { console.log('catch-floor: refusing to raise a floor: ' + raised.map((f) => `${f} ${have.floors[f] || 0} -> ${counts[f]}`).join(', ')); process.exit(1); }
  save(counts, {});
  console.log('catch-floor: wrote ' + Object.keys(counts).length + ' floors');
  process.exit(0);
}

let bad = 0, total = 0, lower = 0;
// The ratchet: a floor above the committed one needs a reason.
if (committed) {
  for (const [f, fl] of Object.entries(have.floors)) {
    if (fl > (committed.floors[f] || 0) && !(have.raised && have.raised[f])) {
      console.log(`FAIL ${f}: floor raised ${committed.floors[f] || 0} -> ${fl} with no reason in "raised"`); bad++;
    }
  }
}
for (const f of new Set([...Object.keys(counts), ...Object.keys(have.floors)])) {
  const n = counts[f] || 0, fl = have.floors[f] || 0;
  total += n;
  if (n > fl) { console.log(`FAIL ${f}: ${n} empty catches, floor ${fl}`); bad++; }
  else if (n < fl) lower++;
}
console.log(`catch-floor: ${total} empty catches across ${Object.keys(counts).length} files` + (lower ? `; ${lower} below their floor (run --write to lower it)` : ''));
process.exit(bad ? 1 : 0);
