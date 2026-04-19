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
  <!-- Capacitor-only: loaded before page scripts so ble-adapter.js can
       monkey-patch navigator.bluetooth before hr_monitor.html's BLE code
       runs, and drive-auth-native.js can register its sign-in override
       before the Drive Sign In button is wired. Files served from the
       WebView bundle. -->
  <script src="./capacitor-bootstrap.js"></script>
  <script src="./ble-adapter.js"></script>
  <script src="./drive-auth-native.js"></script>
`;

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function copyFile(relative) {
  const from = path.join(repoRoot, relative);
  const to = path.join(wwwDir, relative);
  ensureDir(path.dirname(to));
  if (!fs.existsSync(from)) {
    console.warn(`[copy-web] skipping ${relative} (not found at repo root)`);
    return;
  }
  fs.copyFileSync(from, to);
  console.log(`[copy-web] ${relative} → www/${relative}`);
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
  if (!/ble-adapter\.js/.test(html)) {
    html = html.replace(/<\/head>/i, `${SHIM_TAGS}</head>`);
  }
  fs.writeFileSync(to, html);
  console.log(`[copy-web] ${relative} → www/${relative} (shim injected)`);
}

// copy-web also drops the mobile-only bootstrap + adapter files next to the
// web files so relative paths just work.
function copyMobileAssets() {
  const assets = ['ble-adapter.js', 'capacitor-bootstrap.js', 'drive-auth-native.js'];
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
  const mobileAssets = ['ble-adapter.js', 'capacitor-bootstrap.js', 'drive-auth-native.js'].map(f => path.join(mobileRoot, 'src', f));
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
