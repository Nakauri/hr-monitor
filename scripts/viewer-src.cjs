// The viewer's code as tests read it: hrv_viewer.html followed by viewer-parse.js (its parsing module), LF endings.
// Tests that grab viewer functions by name read this, so a function moved into the module is still found.
// Usage: const { viewerSource, readViewerParts } = require('./viewer-src.cjs'); viewerSource(htmlPath?)
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const norm = (s) => s.replace(/\r\n/g, '\n');

function readViewerParts(htmlPath) {
  const html = norm(fs.readFileSync(htmlPath || path.join(ROOT, 'hrv_viewer.html'), 'utf8'));
  const modPath = path.join(path.dirname(htmlPath || path.join(ROOT, 'hrv_viewer.html')), 'viewer-parse.js');
  const mod = fs.existsSync(modPath) ? norm(fs.readFileSync(modPath, 'utf8')) : '';
  return { html, mod };
}

function viewerSource(htmlPath) {
  const { html, mod } = readViewerParts(htmlPath);
  return mod ? html + '\n' + mod : html;
}

module.exports = { viewerSource, readViewerParts };
