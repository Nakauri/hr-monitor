#!/usr/bin/env node
// Copy the repo-root web files into mobile/www/ with the BLE adapter shim
// injected so hr_monitor.html's existing navigator.bluetooth code runs
// unmodified against the Capacitor BLE plugin.
//
// Run manually: `npm run copy-web`
// Or watch mode: `npm run dev` (re-runs on any web-file change)

const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..', '..');
const mobileRoot = path.resolve(__dirname, '..');
const wwwDir = path.join(mobileRoot, 'www');

// Files copied as-is.
const PASSTHROUGH = ['overlay.html', 'hrv_viewer.html', 'index.html', 'widget.css', 'widget.js', 'diagnostics.js'];
// hr_monitor.html gets the ble-adapter + capacitor-core shims injected just
// before the closing </head> so navigator.bluetooth is patched before any
// page script touches it.
const INJECT_TARGET = 'hr_monitor.html';

const SHIM_TAGS = `
  <!-- Capacitor-only shims loaded before page scripts so they can patch
       navigator.bluetooth, register the native Drive sign-in override, and
       attach the foreground-service wrapper before hr_monitor.html's main
       code runs. Files served from the WebView bundle. -->
  <script src="./capacitor-bootstrap.js"></script>
  <script src="./ble-adapter.js"></script>
  <script src="./drive-auth-native.js"></script>
  <script src="./foreground-service.js"></script>
  <script src="./battery-opt.js"></script>
`;

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// Lines matching this regex are stripped from every HTML copied into the
// mobile bundle. Currently: Vercel Web Analytics (loaded from an external
// CDN — doesn't reach cleanly from Capacitor's https://localhost scheme,
// and we don't want native app installs firing web analytics anyway).
// If the vendor-injected markup changes, add another pattern here.
const STRIP_PATTERNS = [
  /^\s*<!--\s*Vercel Web Analytics[\s\S]*?-->\s*\n?/m,
  /^\s*<script\s+defer\s+src="https:\/\/cdn\.vercel-insights\.com[^>]*><\/script>\s*\n?/m,
];

function stripForMobile(html) {
  let out = html;
  for (const re of STRIP_PATTERNS) out = out.replace(re, '');
  return out;
}

function copyFile(relative) {
  const from = path.join(repoRoot, relative);
  const to = path.join(wwwDir, relative);
  ensureDir(path.dirname(to));
  if (!fs.existsSync(from)) {
    console.warn(`[copy-web] skipping ${relative} (not found at repo root)`);
    return;
  }
  // Strip analytics from any HTML we copy. Passthrough for non-HTML.
  if (relative.endsWith('.html')) {
    const src = fs.readFileSync(from, 'utf8');
    fs.writeFileSync(to, stripForMobile(src));
    console.log(`[copy-web] ${relative} → www/${relative} (analytics stripped)`);
  } else {
    fs.copyFileSync(from, to);
    console.log(`[copy-web] ${relative} → www/${relative}`);
  }
}

function copyWithInject(relative) {
  const from = path.join(repoRoot, relative);
  const to = path.join(wwwDir, relative);
  ensureDir(path.dirname(to));
  if (!fs.existsSync(from)) {
    console.warn(`[copy-web] skipping ${relative} (not found at repo root)`);
    return;
  }
  let html = fs.readFileSync(from, 'utf8');
  html = stripForMobile(html);
  if (!/ble-adapter\.js/.test(html)) {
    html = html.replace(/<\/head>/i, `${SHIM_TAGS}</head>`);
  }
  fs.writeFileSync(to, html);
  console.log(`[copy-web] ${relative} → www/${relative} (shim injected, analytics stripped)`);
}

// copy-web also drops the mobile-only bootstrap + adapter files next to the
// web files so relative paths just work.
function copyMobileAssets() {
  const assets = ['ble-adapter.js', 'capacitor-bootstrap.js', 'drive-auth-native.js', 'foreground-service.js', 'battery-opt.js'];
  for (const name of assets) {
    const from = path.join(mobileRoot, 'src', name);
    const to = path.join(wwwDir, name);
    if (!fs.existsSync(from)) {
      console.warn(`[copy-web] WARN: mobile/src/${name} missing — stage 2 hasn't landed yet`);
      continue;
    }
    fs.copyFileSync(from, to);
    console.log(`[copy-web] mobile/src/${name} → www/${name}`);
  }
}

function buildOnce() {
  ensureDir(wwwDir);
  for (const f of PASSTHROUGH) copyFile(f);
  copyWithInject(INJECT_TARGET);
  copyMobileAssets();
  console.log('[copy-web] done');
}

function watch() {
  buildOnce();
  const files = [...PASSTHROUGH, INJECT_TARGET].map(f => path.join(repoRoot, f));
  const mobileAssets = ['ble-adapter.js', 'capacitor-bootstrap.js', 'drive-auth-native.js', 'foreground-service.js', 'battery-opt.js'].map(f => path.join(mobileRoot, 'src', f));
  const watched = [...files, ...mobileAssets].filter(f => fs.existsSync(f));
  console.log(`[copy-web] watching ${watched.length} files…`);
  let pending = null;
  for (const f of watched) {
    fs.watch(f, () => {
      clearTimeout(pending);
      pending = setTimeout(buildOnce, 120);
    });
  }
}

if (process.argv.includes('--watch')) watch();
else buildOnce();
