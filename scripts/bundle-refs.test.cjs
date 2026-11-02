// Every ./x.js or ./x.css a shipped page loads is packed, triggers the APK build, and wakes its browser checks.
// Bug it exists for: browser-tier MONITOR lacked auth.js and lifecycle-state.js, VIEWER lacked auth.js and
// diagnostics.js, and the csp rule lacked lifecycle-state.js, so a push touching only those ran no page check.
// Lists: mobile/scripts/copy-web.js PASSTHROUGH, .github/workflows/build-android.yml paths, scripts/browser-tier.mjs.
// Usage: node scripts/bundle-refs.test.cjs [repo root]. Runtime: under 1 s.
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(process.argv[2] || path.join(__dirname, '..'));
const read = (rel) => { try { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); } catch (e) { return null; } };
// Guards: the security audit of 2026-11-01 found Google's script loading in the app, unused, with every plugin in reach.
{
  const src = read('mobile/scripts/copy-web.js') || '';
  const m = src.match(/const STRIP_PATTERNS = \[([\s\S]*?)\n\];/);
  if (!m || !m[1].includes('accounts' + String.fromCharCode(92) + '.google')) { console.log('FAIL copy-web strips the Google sign-in script from the app'); process.exitCode = 1; }
}

let failures = 0;
function check(name, ok, detail) {
  console.log((ok ? 'OK    ' : 'FAIL  ') + name + (detail ? '  ' + detail : ''));
  if (!ok) failures++;
}

const copyWeb = read('mobile/scripts/copy-web.js') || '';
const pass = [...((copyWeb.match(/const PASSTHROUGH = \[([\s\S]*?)\];/) || [])[1] || '').matchAll(/'([^']+)'/g)].map((m) => m[1]);
const quoted = (name) => ((copyWeb.match(new RegExp(name + "\\s*=\\s*'([^']+)'")) || [])[1]);
const appHome = (copyWeb.match(/INDEX_OVERRIDE\s*=\s*\{\s*from:\s*'([^']+)'/) || [])[1];
const MOBILE_PAGES = [...new Set([quoted('INJECT_TARGET'), quoted('VIEWER_INJECT_TARGET'), appHome, ...pass.filter((f) => f.endsWith('.html'))].filter(Boolean))];
check('copy-web names the monitor, viewer, app home and overlay pages', ['hr_monitor.html', 'hrv_viewer.html', 'app-home.html', 'overlay.html'].every((p) => MOBILE_PAGES.includes(p)), MOBILE_PAGES.join(', '));

const yml = read('.github/workflows/build-android.yml') || '';
const block = (yml.match(/\n\s*paths:\s*\n((?:\s*-\s*'[^']*'\s*\n)+)/) || [])[1] || '';
const globRes = [...block.matchAll(/'([^']*)'/g)].map((m) => new RegExp('^' + m[1].replace(/[.+^${}()|[\]\\]/g, '\\$&')
  .replace(/\*\*/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\u0000/g, '.*') + '$'));
check('build-android.yml has a paths list', globRes.length > 5, globRes.length + ' globs');

const tier = read('scripts/browser-tier.mjs') || '';
const tierRe = (name) => {
  const m = tier.match(new RegExp('^const ' + name + ' = /(.+)/;$', 'm'));
  return m ? new RegExp(m[1]) : null;
};
const cspSrc = (tier.match(/^\s*'csp': \[\/(.+)\/, \[\], (?:true|false)\],$/m) || [])[1];
const RULES = { csp: cspSrc ? new RegExp(cspSrc) : null, MONITOR: tierRe('MONITOR'), VIEWER: tierRe('VIEWER') };
for (const [k, re] of Object.entries(RULES)) check(`browser-tier.mjs has the ${k} rule`, !!re);

// Local script and stylesheet refs of a page; a ref without ./ would dodge the list, so it fails too.
function refs(page) {
  const html = read(page) || '';
  const out = [];
  for (const m of html.matchAll(/<(?:script|link)\b[^>]*?\b(?:src|href)="([^"]+)"/g)) {
    const u = m[1].split(/[?#]/)[0];
    if (/^(https?:|data:|blob:|\/\/)/.test(u) || !/\.(js|css)$/.test(u)) continue;
    out.push(u);
  }
  return [...new Set(out)];
}

const WEB_PAGES = fs.readdirSync(ROOT).filter((f) => f.endsWith('.html') && !/^google[0-9a-f]+\.html$/.test(f));
for (const page of WEB_PAGES) {
  const list = refs(page);
  const bad = list.filter((u) => !u.startsWith('./'));
  check(`${page}: every local ref starts with ./`, bad.length === 0, bad.join(', '));
  const files = list.filter((u) => u.startsWith('./')).map((u) => u.slice(2));
  const gone = files.filter((f) => read(f) == null);
  check(`${page}: every ref exists`, gone.length === 0, gone.join(', '));
  if (RULES.csp) {
    const miss = files.filter((f) => !RULES.csp.test(f));
    check(`${page}: browser-tier csp rule covers its refs`, miss.length === 0, miss.length ? 'missing: ' + miss.join(', ') : '');
  }
  if (MOBILE_PAGES.includes(page)) {
    const notPacked = files.filter((f) => !pass.includes(f));
    check(`${page}: copy-web PASSTHROUGH packs its refs`, notPacked.length === 0, notPacked.length ? 'missing: ' + notPacked.join(', ') : '');
    const noBuild = files.filter((f) => !globRes.some((re) => re.test(f)));
    check(`${page}: build-android.yml paths cover its refs`, noBuild.length === 0, noBuild.length ? 'missing: ' + noBuild.join(', ') : '');
  }
  const own = { 'hr_monitor.html': 'MONITOR', 'hrv_viewer.html': 'VIEWER' }[page];
  if (own && RULES[own]) {
    const miss = [page, ...files].filter((f) => !RULES[own].test(f));
    check(`${page}: browser-tier ${own} rule covers it and its refs`, miss.length === 0, miss.length ? 'missing: ' + miss.join(', ') : '');
  }
}

if (failures) { console.log(failures + ' bundle ref check(s) FAILED.'); process.exit(1); }
console.log('All bundle ref checks passed.');
