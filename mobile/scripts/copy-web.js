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
const PASSTHROUGH = ['overlay.html', 'hrv_viewer.html', 'widget.css', 'widget.js', 'diagnostics.js', 'settings.js'];
// The Capacitor WebView loads index.html by default; we want it to show the
// dedicated mobile-first landing (app-home.html), not the scrolling public
// landing. Public https://aorti.ca/ keeps the scroll-heavy page because
// Vercel serves the repo-root index.html. See also mobile/README.md.
const INDEX_OVERRIDE = { from: 'app-home.html', to: 'index.html' };
// hr_monitor.html gets the ble-adapter + capacitor-core shims injected just
// before the closing </head> so navigator.bluetooth is patched before any
// page script touches it.
const INJECT_TARGET = 'hr_monitor.html';

const SHIM_TAGS = `
  <!-- Capacitor-only shims loaded before page scripts so they can patch
       navigator.bluetooth, register the native Drive sign-in override,
       monkey-patch WebSocket for the relay (so ws.send doesn't buffer
       when the Activity is paused), and attach the foreground-service
       wrapper before hr_monitor.html's main code runs. Files served
       from the WebView bundle. -->
  <script src="./capacitor-bootstrap.js"></script>
  <script src="./ble-adapter.js"></script>
  <script src="./native-relay-socket.js"></script>
  <script src="./native-hr-session.js"></script>
  <script src="./drive-auth-native.js"></script>
  <script src="./foreground-service.js"></script>
  <script src="./battery-opt.js"></script>
  <script src="./wake-lock.js"></script>
  <script src="./oem-background.js"></script>
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
  const assets = ['ble-adapter.js', 'capacitor-bootstrap.js', 'native-relay-socket.js', 'native-hr-session.js', 'drive-auth-native.js', 'foreground-service.js', 'battery-opt.js', 'wake-lock.js', 'oem-background.js'];
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

function copyIndexOverride() {
  const from = path.join(repoRoot, INDEX_OVERRIDE.from);
  const to = path.join(wwwDir, INDEX_OVERRIDE.to);
  if (!fs.existsSync(from)) {
    console.warn(`[copy-web] skipping ${INDEX_OVERRIDE.from} -> ${INDEX_OVERRIDE.to} (source missing)`);
    return;
  }
  const src = fs.readFileSync(from, 'utf8');
  fs.writeFileSync(to, stripForMobile(src));
  console.log(`[copy-web] ${INDEX_OVERRIDE.from} → www/${INDEX_OVERRIDE.to} (app home, analytics stripped)`);
}

function buildOnce() {
  ensureDir(wwwDir);
  for (const f of PASSTHROUGH) copyFile(f);
  copyWithInject(INJECT_TARGET);
  copyIndexOverride();
  copyMobileAssets();
  console.log('[copy-web] done');
}

function watch() {
  buildOnce();
  const files = [...PASSTHROUGH, INJECT_TARGET, INDEX_OVERRIDE.from].map(f => path.join(repoRoot, f));
  const mobileAssets = ['ble-adapter.js', 'capacitor-bootstrap.js', 'drive-auth-native.js', 'foreground-service.js', 'battery-opt.js', 'wake-lock.js', 'oem-background.js'].map(f => path.join(mobileRoot, 'src', f));
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
