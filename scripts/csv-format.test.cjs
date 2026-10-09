#!/usr/bin/env node
// CSV row-shape test for the native writer (NativeCsvWriter.java).
// Reads the Java source as text, so a column added to the header but not to
// the row format strings (or the reverse) fails here before a build.
// Also checks that a missing RMSSD is written as an empty field, not 0.00.
// Run: node scripts/csv-format.test.cjs (exit 0 = OK).

const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'mobile', 'android-overlay', 'app', 'src', 'main',
  'java', 'com', 'nakauri', 'hrmonitor', 'NativeCsvWriter.java');
const java = fs.readFileSync(SRC, 'utf8');

let failures = 0;
function check(name, ok, detail) {
  console.log((ok ? 'OK    ' : 'FAIL  ') + name + (detail ? '  ' + detail : ''));
  if (!ok) failures++;
}

// Body of a Java method, from its signature to the matching closing brace.
function methodBody(name) {
  const start = java.search(new RegExp('void\\s+' + name + '\\s*\\('));
  if (start < 0) return null;
  const open = java.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < java.length; i++) {
    if (java[i] === '{') depth++;
    else if (java[i] === '}' && --depth === 0) return java.slice(open, i + 1);
  }
  return null;
}

// The row format string passed to writer.write(String.format(Locale.US, "...", ...)).
function rowFormat(body) {
  const m = body && body.match(/writer\.write\(String\.format\(Locale\.US,\s*"([^"]*)"/);
  return m ? m[1] : null;
}

// Minimal java.util.Formatter for the specifiers the writer uses.
function jformat(fmt, args) {
  let i = 0;
  return fmt.replace(/%(\.\d+)?([dfs%])/g, (all, prec, conv) => {
    if (conv === '%') return '%';
    const v = args[i++];
    if (conv === 'd') return String(Math.trunc(v));
    if (conv === 's') return String(v);
    return Number(v).toFixed(prec ? Number(prec.slice(1)) : 6);
  });
}

const headerMatch = java.match(/HEADER\s*=\s*"([^"]+)"/);
check('HEADER found', !!headerMatch);
const header = headerMatch ? headerMatch[1].split(',') : [];
check('HEADER has 12 columns', header.length === 12, 'got ' + header.length);
check('rmssd_ms is column 4', header[3] === 'rmssd_ms', 'got ' + header[3]);

const hrBody = methodBody('appendHrRow');
const hrFmt = rowFormat(hrBody);
check('appendHrRow format found', !!hrFmt);
const connFmt = rowFormat(methodBody('appendConnectionRow'));
check('appendConnectionRow format found', !!connFmt);

// RMSSD is passed as a pre-formatted string so null can become "".
check('RMSSD slot is %s', !!hrFmt && hrFmt.split(',')[3] === '%s', hrFmt || '');
check('RMSSD param is a nullable Double', /appendHrRow\(\s*int\s+hr,\s*Double\s+rmssd/.test(java));
check('null RMSSD maps to empty string',
  /rmssd\s*==\s*null\s*\?\s*""\s*:\s*String\.format\(Locale\.US,\s*"%\.2f",\s*rmssd\)/.test(hrBody || ''));

function emulateHrRow(rmssd) {
  const rmssdField = rmssd == null ? '' : jformat('%.2f', [rmssd]);
  return jformat(hrFmt, [1.25, 1760000000000, 88, rmssdField, 41.5, 52.25, 60]);
}

if (hrFmt) {
  const withValue = emulateHrRow(42.123).split(',');
  const missing = emulateHrRow(null).split(',');
  check('HR row has 12 fields', withValue.length === header.length, 'got ' + withValue.length);
  check('HR row with missing RMSSD has 12 fields', missing.length === header.length, 'got ' + missing.length);
  check('RMSSD value written as %.2f', withValue[3] === '42.12', 'got ' + withValue[3]);
  check('missing RMSSD written empty', missing[3] === '', 'got "' + missing[3] + '"');
  check('hr_bpm intact on missing RMSSD row', missing[2] === '88', 'got ' + missing[2]);
  check('SDNN columns unchanged', missing.slice(4, 7).join('|') === '41.50|52.25|60.00', missing.slice(4, 7).join('|'));
}
if (connFmt) {
  const conn = jformat(connFmt, [1.25, 1760000000000, 'connected']).split(',');
  check('connection row has 12 fields', conn.length === header.length, 'got ' + conn.length);
  check('connection state in connection column', conn[header.indexOf('connection')] === 'connected');
}

if (failures) {
  console.log(failures + ' check(s) failed');
  process.exit(1);
}
console.log('All CSV format checks passed');
