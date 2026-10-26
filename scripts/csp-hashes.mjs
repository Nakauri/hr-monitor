#!/usr/bin/env node
// Writes the site's Content-Security-Policy into vercel.json: one rule per page whose script-src allows exactly
// that page's own inline scripts by sha256 hash, so no injected inline script runs ('unsafe-inline' is gone).
// The browser's HTML parser finds the scripts (a "<script>" inside a CSS comment is not a script) and they are
// hashed as the browser hashes them: text after line-ending normalisation, UTF-8.
// Guards: report card 2026-10-24 (Security): 'unsafe-inline' let any injected script read the Drive token.
// Any edit to an inline script changes its hash: rerun with --write; scripts/csp.mjs fails while vercel.json is
// stale, and fails on any violation. Runtime: about 5 s.
// Usage: node scripts/csp-hashes.mjs [--write | --check] [--ux <ux-audit dir>]
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { uxDir } from './ux-dir.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);

// Each page's own rules. cleanUrls means /x and /x.html both reach x.html; "/" is index.html and needs its
// own rule: Vercel compiles sources with path-to-regexp, where "/(index...)?" matches "" but never "/".
const NAMES = ['index', 'hr_monitor', 'hrv_viewer', 'app-home', 'legal', 'changelog', 'new-look', 'overlay'];
export const PAGES = [['/', 'index.html'], ...NAMES.map((n) => [`/${n}(\\.html)?`, n + '.html'])];

// Exact scripts, not whole hosts: a host allowlist lets injected markup pull in any library the CDN serves
// (an AngularJS gadget on cdnjs, for one). Google's sign-in needs only its client script (Google's CSP guide).
const CHART = 'https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.0/chart.umd.min.js';
const SORTABLE = 'https://cdnjs.cloudflare.com/ajax/libs/Sortable/1.15.6/Sortable.min.js';
const INSIGHTS = 'https://cdn.vercel-insights.com/v1/script.js';
const GSI = 'https://accounts.google.com/gsi/client';
const HOSTS_SCRIPT = `${CHART} ${SORTABLE} ${GSI} ${INSIGHTS}`;
// The relay's address has one home, relay-link.js (a page script, so read as text, not imported).
const RELAY = (() => {
  const src = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'relay-link.js'), 'utf8');
  const m = src.match(/const RELAY_HOST = '(wss:\/\/[a-z0-9.-]+)';/);
  if (!m) throw new Error('csp-hashes: RELAY_HOST not found in relay-link.js');
  return m[1];
})();
const BASE = (scriptExtra) => [
  "default-src 'self'",
  `script-src 'self' ${HOSTS_SCRIPT}${scriptExtra}`,
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://accounts.google.com",
  "font-src 'self' data: https://fonts.gstatic.com",
  "img-src 'self' data: blob: https://api.qrserver.com https://*.googleusercontent.com",
  // web3forms: the landing page's contact form posts with fetch, which connect-src governs (form-action does not).
  `connect-src 'self' https://www.googleapis.com https://accounts.google.com https://api.github.com https://api.web3forms.com ${RELAY} https://*.vercel-insights.com`,
  "worker-src 'self' blob:",
  "frame-src 'self' https://accounts.google.com",
  "media-src 'self' data: blob:",
  "manifest-src 'self'",
  "form-action 'self' https://api.web3forms.com",
  "base-uri 'self'",
  "object-src 'none'",
];
// The overlay is a stream widget other sites may embed: no frame-ancestors, fewer hosts.
const OVERLAY = (scriptExtra) => [
  "default-src 'self'",
  `script-src 'self' ${CHART} ${INSIGHTS}${scriptExtra}`,
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' data: https://fonts.gstatic.com",
  "img-src 'self' data: blob:",
  `connect-src 'self' ${RELAY} https://*.vercel-insights.com`,
  "base-uri 'self'",
  "object-src 'none'",
  "form-action 'none'",
];

export async function pageHashes() {
  const { chromium } = createRequire(path.join(uxDir(ROOT, null), 'kit', 'package.json'))('playwright');
  const browser = await chromium.launch().catch(() => chromium.launch({ channel: 'chrome' }));
  const page = await browser.newPage();
  const out = {};
  try {
    for (const file of new Set(PAGES.map(([, f]) => f))) {
      const html = fs.readFileSync(path.join(ROOT, file), 'utf8');
      const texts = await page.evaluate((h) => [...new DOMParser().parseFromString(h, 'text/html').querySelectorAll('script:not([src])')].map((s) => s.textContent), html);
      out[file] = [...new Set(texts.map((t) => "'sha256-" + crypto.createHash('sha256').update(t, 'utf8').digest('base64') + "'"))];
    }
  } finally {
    await browser.close();
  }
  return out;
}

export function buildConfig(hashes, current) {
  const headers = [];
  for (const [source, file] of PAGES) {
    const extra = hashes[file].length ? ' ' + hashes[file].join(' ') : '';
    const policy = (file === 'overlay.html' ? OVERLAY(extra) : [...BASE(extra), "frame-ancestors 'self'"]).join('; ');
    headers.push({ source, headers: [{ key: 'Content-Security-Policy', value: policy }] });
  }
  // Everything that is not a page (scripts, styles, JSON, the API): no inline scripts at all.
  const pages = NAMES.map((n) => `${n}(?:\\.html)?$`).join('|');
  headers.push({ source: `/((?!${pages}).+)`, headers: [{ key: 'Content-Security-Policy', value: [...BASE(''), "frame-ancestors 'self'"].join('; ') }] });
  headers.push({ source: '/(.*)', headers: [
    { key: 'X-Content-Type-Options', value: 'nosniff' },
    { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
    { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=(), usb=()' },
  ] });
  return { ...current, headers };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const file = path.join(ROOT, 'vercel.json');
  const current = JSON.parse(fs.readFileSync(file, 'utf8'));
  const next = buildConfig(await pageHashes(), current);
  const text = JSON.stringify(next, null, 2) + '\n';
  if (args.includes('--write')) { fs.writeFileSync(file, text); console.log('vercel.json written: ' + next.headers.length + ' rules'); }
  else {
    const same = JSON.stringify(current) === JSON.stringify(next);
    console.log(same ? 'csp-hashes: vercel.json is current' : 'csp-hashes: vercel.json is STALE (an inline script changed): run node scripts/csp-hashes.mjs --write');
    process.exit(same ? 0 : 1);
  }
}
