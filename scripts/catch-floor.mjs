#!/usr/bin/env node
// Guards: errors swallowed with no trace. The 10-24 audit found a native relay refusal and a Drive config write
// that failed silently (fixed in grade-a); an empty catch is where that hides. Counts, per shipped file, the catches
// that neither handle nor surface (an empty body or a comment only: `catch (e) {}`, `.catch(() => {})`, Java
// `catch (X e) { }`). Each file has a floor in scripts/catch-floor.json that only goes down; a file not listed has
// floor 0 (recorder.js is at 0). Lowering is `--write`; it refuses to raise a floor. Runtime: under 1 s.
// Usage: node scripts/catch-floor.mjs [--write]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FLOOR_FILE = path.join(ROOT, 'scripts', 'catch-floor.json');
const JAVA = 'mobile/android-overlay/app/src/main/java/com/nakauri/hrmonitor';

function files() {
  const out = [];
  const add = (dir, re) => {
    for (const f of fs.readdirSync(path.join(ROOT, dir))) if (re.test(f)) out.push(path.posix.join(dir, f));
  };
  add('.', /^[a-z_-]+\.(html|js)$/);
  add('mobile/src', /\.js$/);
  add(JAVA, /\.java$/);
  return out.map((f) => f.replace(/^\.\//, '')).sort();
}

// A body that is empty or holds only comments.
const EMPTY = String.raw`\{\s*(?:(?:\/\*[\s\S]*?\*\/|\/\/[^\n]*)\s*)*\}`;
const PATTERNS = [
  // The keyword only; a `.catch(` call is matched by the two below.
  new RegExp(String.raw`(?<!\.)\bcatch\s*(?:\([^)]*\))?\s*` + EMPTY, 'g'),
  new RegExp(String.raw`\.catch\(\s*(?:\(\s*\w*\s*\)|\w+)\s*=>\s*` + EMPTY + String.raw`\s*\)`, 'g'),
  new RegExp(String.raw`\.catch\(\s*function\s*\w*\s*\([^)]*\)\s*` + EMPTY + String.raw`\s*\)`, 'g'),
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
  ['try { a(); } catch (e) { warn(e); }', 0], ['p.catch((e) => console.warn(e))', 0], ['p.catch(() => false)', 0],
];
const wrong = CASES.filter(([s, n]) => countEmptyCatches(s) !== n);
if (wrong.length) { console.log('catch-floor: FAIL self-test: ' + wrong.map(([s, n]) => `${JSON.stringify(s)} should count ${n}`).join('; ')); process.exit(1); }

const counts = {};
for (const f of files()) {
  const n = countEmptyCatches(fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/\r\n/g, '\n'));
  if (n) counts[f] = n;
}
const floor = fs.existsSync(FLOOR_FILE) ? JSON.parse(fs.readFileSync(FLOOR_FILE, 'utf8')) : {};

if (process.argv.includes('--write')) {
  const raised = Object.keys(counts).filter((f) => counts[f] > (floor[f] ?? (fs.existsSync(FLOOR_FILE) ? 0 : Infinity)));
  if (raised.length) { console.log('catch-floor: refusing to raise a floor: ' + raised.map((f) => `${f} ${floor[f] ?? 0} -> ${counts[f]}`).join(', ')); process.exit(1); }
  fs.writeFileSync(FLOOR_FILE, JSON.stringify(counts, null, 2) + '\n');
  console.log('catch-floor: wrote ' + Object.keys(counts).length + ' floors');
  process.exit(0);
}

let bad = 0, total = 0, lower = 0;
for (const f of new Set([...Object.keys(counts), ...Object.keys(floor)])) {
  const n = counts[f] || 0, fl = floor[f] || 0;
  total += n;
  if (n > fl) { console.log(`FAIL ${f}: ${n} empty catches, floor ${fl}`); bad++; }
  else if (n < fl) lower++;
}
console.log(`catch-floor: ${total} empty catches across ${Object.keys(counts).length} files` + (lower ? `; ${lower} below their floor (run --write to lower it)` : ''));
process.exit(bad ? 1 : 0);
