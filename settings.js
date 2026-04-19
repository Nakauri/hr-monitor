// settings.js — shared source of truth for the "account-level" subset of
// settings that should follow a signed-in user across devices. Loaded by
// hr_monitor.html and hrv_viewer.html.
//
// Scope (Phase D stage 1): this module does NOT yet replace the existing
// localStorage reads/writes inside the monitor or viewer. It only:
//   1. Defines *which* fields are account-level (the schema).
//   2. Knows how to read every account field out of its current
//      localStorage home into one blob.
//   3. Knows how to apply a blob back into localStorage, so stage 2 can
//      download a blob from Drive and have it take effect across the app
//      on next reload.
//   4. Exposes a schema version so future format changes migrate cleanly.
//
// Fields intentionally excluded (stay local per-device): last-strap,
// Drive access token, installed APK SHA marker, per-device widget-size
// measurements, autosave folder handle.
//
// Zero dependencies. Safe to load in any order — no side effects on
// import, callers drive everything explicitly.

(function () {
  'use strict';

  const SCHEMA_VERSION = 1;

  // Account-level keys and their current localStorage homes. Order here
  // doubles as the export order in the blob so diffs stay readable.
  const FIELD_MAP = {
    // Widget + display prefs (one JSON blob today)
    widgetPrefs:      { lsKey: 'hr_monitor_widget_prefs',       kind: 'json' },
    // Monitor-side threshold inputs (four independent number fields)
    thresholds: {
      high:    { lsKey: 'hr_monitor_thresh_high',       kind: 'number', fallback: 130 },
      low:     { lsKey: 'hr_monitor_thresh_low',        kind: 'number', fallback: 55 },
      rmssd:   { lsKey: 'hr_monitor_thresh_rmssd',      kind: 'number', fallback: 15 },
      palp:    { lsKey: 'hr_monitor_thresh_palp',       kind: 'number', fallback: 5 },
    },
    colorThresholds:  { lsKey: 'hr_monitor_color_thresholds',   kind: 'json' },
    audioConfig:      { lsKey: 'hr_monitor_audio_config',       kind: 'json' },
    broadcastKey:     { lsKey: 'hr_monitor_broadcast_key',      kind: 'string' },
    // Cross-surface toggle (viewer + monitor both honour it)
    autonomicOn:      { lsKey: 'hr_monitor_autonomic_on',       kind: 'bool' },
    // Per-card colour-zone thresholds used by the viewer interp cells
    cardThresholds:   { lsKey: 'hr_monitor_card_thresholds',    kind: 'json' },
    // Quadrant profiles for autonomic classification
    quadrantProfile:  { lsKey: 'hr_monitor_quadrant_profile',   kind: 'string' },
  };

  function readLS(key) {
    try { return localStorage.getItem(key); } catch (e) { return null; }
  }
  function writeLS(key, value) {
    try {
      if (value == null) localStorage.removeItem(key);
      else localStorage.setItem(key, value);
    } catch (e) {}
  }

  function readValue(desc) {
    if (!desc || !desc.lsKey) return undefined;
    const raw = readLS(desc.lsKey);
    if (raw == null) return desc.fallback != null ? desc.fallback : undefined;
    switch (desc.kind) {
      case 'number': {
        const n = parseFloat(raw);
        return Number.isFinite(n) ? n : (desc.fallback != null ? desc.fallback : undefined);
      }
      case 'bool':
        return raw === 'true' || raw === '1';
      case 'json':
        try { return JSON.parse(raw); } catch (e) { return undefined; }
      default:
        return raw;
    }
  }

  function writeValue(desc, value) {
    if (!desc || !desc.lsKey) return;
    if (value === undefined) return; // don't clobber on partial blobs
    switch (desc.kind) {
      case 'number':
        writeLS(desc.lsKey, value == null ? null : String(value));
        break;
      case 'bool':
        writeLS(desc.lsKey, value ? 'true' : 'false');
        break;
      case 'json':
        writeLS(desc.lsKey, value == null ? null : JSON.stringify(value));
        break;
      default:
        writeLS(desc.lsKey, value == null ? null : String(value));
    }
  }

  // Read every account-level field out of localStorage and return a single
  // blob suitable for upload to Drive. Unset fields are omitted (not null)
  // so merging with a remote copy doesn't clobber what's already there.
  function exportAccount() {
    const out = {
      schemaVersion: SCHEMA_VERSION,
      exportedAt: Date.now(),
      data: {},
    };
    for (const [name, desc] of Object.entries(FIELD_MAP)) {
      if (desc && desc.lsKey) {
        const v = readValue(desc);
        if (v !== undefined) out.data[name] = v;
      } else if (typeof desc === 'object') {
        // Nested group (e.g. thresholds). Flatten into its own sub-object.
        const group = {};
        for (const [subName, subDesc] of Object.entries(desc)) {
          const v = readValue(subDesc);
          if (v !== undefined) group[subName] = v;
        }
        if (Object.keys(group).length) out.data[name] = group;
      }
    }
    return out;
  }

  // Apply a blob back into localStorage. Tolerates older schema versions
  // by ignoring unknown fields; aborts cleanly on obviously-malformed input
  // rather than throwing.
  function applyAccount(blob) {
    if (!blob || typeof blob !== 'object' || !blob.data) return false;
    for (const [name, desc] of Object.entries(FIELD_MAP)) {
      const val = blob.data[name];
      if (val === undefined) continue;
      if (desc && desc.lsKey) {
        writeValue(desc, val);
      } else if (typeof desc === 'object' && val && typeof val === 'object') {
        for (const [subName, subDesc] of Object.entries(desc)) {
          if (val[subName] !== undefined) writeValue(subDesc, val[subName]);
        }
      }
    }
    return true;
  }

  function getSchemaVersion() { return SCHEMA_VERSION; }

  // List every localStorage key we ever write to. Useful for a future
  // "sign out + wipe account data" button and for the Drive migration
  // step in stage 2 (so we don't touch keys that aren't ours).
  function getKnownKeys() {
    const keys = [];
    for (const desc of Object.values(FIELD_MAP)) {
      if (desc && desc.lsKey) keys.push(desc.lsKey);
      else if (typeof desc === 'object') {
        for (const sub of Object.values(desc)) if (sub && sub.lsKey) keys.push(sub.lsKey);
      }
    }
    return keys;
  }

  window.HRMSettings = {
    exportAccount,
    applyAccount,
    getSchemaVersion,
    getKnownKeys,
    FIELDS: FIELD_MAP,
  };
})();
