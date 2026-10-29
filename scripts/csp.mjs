#!/usr/bin/env node
// The site's Content-Security-Policy and security headers, from vercel.json, against the real pages.
// Guards: no CSP on a site that holds a Drive token in the page (report card 2026-10-24, Security); and a
// policy that silently breaks a feature (a missing host blocks Chart.js, the parse worker, the relay or
// Google sign-in with nothing but a console line). Files: vercel.json and every page.
// Serves the repo with the headers vercel.json declares (every matching rule applies, as on Vercel), opens
// each page, drives the paths that reach other hosts (viewer demo through the parse worker, the landing
// preview frame and release check, the overlay's relay socket, the sign-in script), and fails on any CSP
// violation or a missing header. Then each mutant policy must FAIL. Runtime: about 60 s.
// Usage: node scripts/csp.mjs [--ux <ux-audit dir>]
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { uxDir } from './ux-dir.mjs';
import { pageHashes, buildConfig } from './csp-hashes.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const UX = uxDir(ROOT, (() => { const i = args.indexOf('--ux'); return i >= 0 ? args[i + 1] : null; })());
const { chromium } = createRequire(path.join(UX, 'kit', 'package.json'))('playwright');
const REAL = JSON.parse(fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8'));
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.csv': 'text/csv', '.webmanifest': 'application/manifest+json' };

// Rule sources compile the way Vercel compiles them (@vercel/routing-utils sourceToRegex: path-to-regexp,
// strict and case-sensitive). A plain RegExp let "/(index...)?" match "/" here while Vercel sent "/" no CSP.
// relay/node_modules is installed in the main checkout only (the parent of the ux-audit folder), so a worktree finds it there.
const { pathToRegexp } = createRequire(path.join(path.dirname(UX), 'relay', 'package.json'))('path-to-regexp');
export const vercelRegex = (source) => pathToRegexp(source, [], { strict: true, sensitive: true, delimiter: '/' });

function serve(config) {
  const rules = (config.headers || []).map((r) => ({ re: vercelRegex(r.source), headers: r.headers }));
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    let p = decodeURIComponent(url.pathname);
    for (const rule of rules) {
      if (!rule.re.test(p)) continue;
      for (const { key, value } of rule.headers) {
        const prev = res.getHeader(key);
        res.setHeader(key, prev ? [].concat(prev, value) : value);
      }
    }
    if (p === '/') p = '/index.html';
    let file = path.join(ROOT, p);
    if (!path.extname(file) && fs.existsSync(file + '.html')) file += '.html';
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.statusCode = 404; return res.end('not found'); }
    res.setHeader('Content-Type', TYPES[path.extname(file)] || 'application/octet-stream');
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((ok) => server.listen(0, '127.0.0.1', () => ok(server)));
}

// Each visit: a page, what to do on it, and a readiness test that proves the feature ran under the policy.
const VISITS = [
  ['/hr_monitor', async () => {}, () => typeof window.Chart === 'function'],
  ['/hrv_viewer?demo=1', async (p) => { await p.waitForTimeout(3500); }, () => typeof window.Chart === 'function' && typeof window.Sortable === 'function'],
  ['/', async (p) => { await p.waitForTimeout(2500); }, () => !!document.querySelector('#variant-frame')],
  // The contact form posts with fetch; the first policy allowed it only in form-action, so every send failed
  // (security audit 2026-10-25). The send goes to a stub, never to web3forms.
  ['/#contact', async (p) => {
    await p.route('https://api.web3forms.com/**', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{"success":true}' }));
    await p.evaluate(() => document.getElementById('contact-form').requestSubmit());
    await p.waitForTimeout(1500);
  }, () => /^Sent\./.test(document.getElementById('contact-status').textContent)],
  ['/overlay?key=csp-test-room', async (p) => { await p.waitForTimeout(2500); }, () => typeof window.Chart === 'function'],
  ['/app-home', async (p) => { await p.waitForTimeout(1500); }, () => true],
  ['/legal', async () => {}, () => true],
  ['/changelog', async () => {}, () => true],
  ['/new-look', async () => {}, () => true],
];

async function run(config) {
  const server = await serve(config);
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch().catch(() => chromium.launch({ channel: 'chrome' }));
  const out = [];
  try {
    for (const [route, act, ready] of VISITS) {
      const ctx = await browser.newContext();
      await ctx.addInitScript(() => {
        window.__csp = [];
        document.addEventListener('securitypolicyviolation', (e) => window.__csp.push(e.violatedDirective + ' ' + (e.blockedURI || 'inline')));
      });
      const page = await ctx.newPage();
      const consoleCsp = [];
      page.on('console', (m) => { if (/Content Security Policy/i.test(m.text())) consoleCsp.push(m.text().slice(0, 160)); });
      const resp = await page.goto(base + route, { waitUntil: 'load' });
      await act(page);
      const v = await page.evaluate(() => window.__csp || []);
      const ok = await page.evaluate(ready).catch(() => false);
      const h = resp.headers();
      const policy = h['content-security-policy'] || '';
      out.push({ route, violations: [...new Set([...v, ...consoleCsp])], ready: ok, csp: !!policy, nosniff: h['x-content-type-options'] === 'nosniff', referrer: !!h['referrer-policy'],
        // Two matching rules would stack two policies, and the browser enforces both.
        policies: policy.split('default-src').length - 1,
        inlineAllowed: /script-src[^;]*'unsafe-inline'/.test(policy) });
      await ctx.close();
    }
  } finally {
    await browser.close();
    server.close();
  }
  return out;
}

const verdict = (rows) => rows.flatMap((r) => [
  ...r.violations.map((x) => `${r.route}: violation ${x}`),
  ...(r.ready ? [] : [`${r.route}: the page's feature did not come up under the policy`]),
  ...(r.csp ? [] : [`${r.route}: no Content-Security-Policy header`]),
  ...(r.nosniff && r.referrer ? [] : [`${r.route}: missing nosniff or Referrer-Policy`]),
  ...(r.policies === 1 ? [] : [`${r.route}: ${r.policies} Content-Security-Policy headers (want exactly 1)`]),
  ...(r.inlineAllowed ? [`${r.route}: script-src allows 'unsafe-inline'`] : []),
]);

let fails = 0;
// vercel.json must hold the hashes of the pages as they are now (scripts/csp-hashes.mjs --write regenerates it).
const fresh = buildConfig(await pageHashes(), REAL);
const current = JSON.stringify(fresh) === JSON.stringify(REAL);
console.log((current ? 'OK    ' : 'FAIL  ') + 'vercel.json holds every page\'s current inline script hashes' + (current ? '' : ' (run node scripts/csp-hashes.mjs --write)'));
if (!current) fails++;
const real = await run(REAL);
for (const r of real) {
  const bad = verdict([r]);
  console.log((bad.length ? 'FAIL  ' : 'OK    ') + r.route.padEnd(24) + (bad.length ? bad.join(' | ') : 'no violations, feature up, headers present'));
  if (bad.length) fails++;
}

const strip = (from) => {
  const c = JSON.parse(JSON.stringify(REAL));
  for (const rule of c.headers) for (const h of rule.headers) if (h.key === 'Content-Security-Policy') h.value = h.value.split(from).join('');
  return c;
};
const swap = (from, to) => {
  const c = JSON.parse(JSON.stringify(REAL));
  for (const rule of c.headers) for (const h of rule.headers) if (h.key === 'Content-Security-Policy') h.value = h.value.split(from).join(to);
  return c;
};
const MUTANTS = [
  ['policy without the Chart.js CDN', strip(' https://cdnjs.cloudflare.com')],
  ['policy with no Worker source (the viewer parse Worker)', swap(" worker-src 'self';", " worker-src 'none';")],
  ['policy without the relay socket', strip(' wss://hr-relay.nakauri.workers.dev')],
  ['policy without the contact form host', strip(' https://api.web3forms.com')],
  // A page script edited without regenerating: its old hash no longer matches, so the script is blocked.
  ['monitor policy missing one script hash', (() => {
    const c = JSON.parse(JSON.stringify(REAL));
    const rule = c.headers.find((r) => r.source.startsWith('/hr_monitor'));
    const h = rule.headers.find((x) => x.key === 'Content-Security-Policy');
    h.value = h.value.replace(/ 'sha256-[^']+'/, '');
    return c;
  })()],
  // The 10-24 bug: Vercel's matcher never sends "/" a policy from this source.
  ['landing rule as "/(index(?:\\.html)?)?"', (() => {
    const c = JSON.parse(JSON.stringify(REAL));
    c.headers.find((r) => r.source === '/').source = '/(index(?:\\.html)?)?';
    return c;
  })()],
  ['Chart.js pinned to the wrong file', strip('/Chart.js/4.4.0/')],
  ['inline scripts allowed again', (() => {
    const c = JSON.parse(JSON.stringify(REAL));
    for (const rule of c.headers) for (const h of rule.headers) if (h.key === 'Content-Security-Policy') h.value = h.value.replace("script-src 'self'", "script-src 'self' 'unsafe-inline'");
    return c;
  })()],
];
console.log('\nNegative controls (each must FAIL):');
for (const [name, cfg] of MUTANTS) {
  const bad = verdict(await run(cfg));
  console.log((bad.length ? 'MUTANT ' : 'MISSED ') + name + (bad.length ? ': FAILED as required  (' + bad[0].slice(0, 120) + ')' : ': no violation seen'));
  if (!bad.length) fails++;
}
console.log(fails ? `\ncsp: ${fails} fail` : '\ncsp: all pass');
process.exit(fails ? 1 : 0);
