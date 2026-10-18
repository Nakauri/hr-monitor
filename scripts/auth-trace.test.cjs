#!/usr/bin/env node
// Guards: Khal's sign-in lost overnight 10-17 to 10-18 with no log saying why (S62 item C). Files: auth.js. Runtime: under 1 s.
// auth.js runs in a vm with fake storage, fetch and native bridge. Every cleared token leaves a clear_token step with its
// reason (refresh_null, refresh_401, sign_out) in the hrm_auth_trace ring; a native refresh traces start, ok or threw,
// and a throw keeps the token. Then each mutant below must make a check FAIL.
// Run: node scripts/auth-trace.test.cjs
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'auth.js'), 'utf8').replace(/\r\n/g, '\n');

function store() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
}
function load(src, { native, refresh, fetchStatus }) {
  const ls = store(), ss = store();
  const win = {
    localStorage: ls, sessionStorage: ss, location: { origin: 'https://www.aorti.ca', hostname: 'www.aorti.ca' },
    addEventListener() {}, console: { info() {}, warn() {}, error() {}, log() {} },
    fetch: async () => ({ status: fetchStatus || 200, ok: (fetchStatus || 200) < 300, json: async () => ({ access_token: 'w2', expires_in: 3600 }) }),
  };
  if (native) {
    win.Capacitor = { isNativePlatform: () => true };
    win.__hrMonitorNativeDriveRefresh = refresh;
    win.__hrMonitorNativeDriveSignOut = async () => {};
  }
  win.window = win;
  const ctx = vm.createContext(Object.assign(win, { JSON, Date, Math, Error, String, Object, Promise, Set, Map, URL, setTimeout, clearTimeout }));
  vm.runInContext(src, ctx);
  ls.setItem('aorti_auth_v2', JSON.stringify({ version: 2, access_token: 't1', expires_at: Date.now() - 1000, email: 'a@example.com', scope: 's', issued_at: Date.now() - 7200000 }));
  const ring = () => JSON.parse(ls.getItem('hrm_auth_trace') || '[]').map((e) => e.step + (e.payload && e.payload.reason ? ':' + e.payload.reason : ''));
  return { auth: win.aortiAuth, ls, ring };
}

async function checks(src) {
  const rows = [];
  { // native refresh returns null: token cleared with refresh_null
    const t = load(src, { native: true, refresh: async () => null });
    try { await t.auth.refreshIfNeeded(); } catch (e) {}
    const r = t.ring();
    rows.push(['native null refresh traces start then clear_token:refresh_null, token gone', r.includes('auth:native_refresh_start') && r.includes('auth:clear_token:refresh_null') && !t.ls.getItem('aorti_auth_v2'), r.join(' ')]);
  }
  { // native refresh throws: traced, token kept
    const t = load(src, { native: true, refresh: async () => { throw new Error('net down'); } });
    try { await t.auth.refreshIfNeeded(); } catch (e) {}
    const r = t.ring();
    rows.push(['native refresh throw traced, token kept', r.includes('auth:native_refresh_threw') && !r.some((s) => s.startsWith('auth:clear_token')) && !!t.ls.getItem('aorti_auth_v2'), r.join(' ')]);
  }
  { // native refresh succeeds
    const t = load(src, { native: true, refresh: async () => ({ accessToken: 'n2', expiresAt: Date.now() + 3600000 }) });
    await t.auth.refreshIfNeeded();
    const r = t.ring();
    rows.push(['native refresh ok traced', r.includes('auth:native_refresh_start') && r.includes('auth:native_refresh_ok'), r.join(' ')]);
  }
  { // web refresh 401
    const t = load(src, { native: false, fetchStatus: 401 });
    try { await t.auth.refreshIfNeeded(); } catch (e) {}
    const r = t.ring();
    rows.push(['web refresh 401 traces clear_token:refresh_401', r.includes('auth:clear_token:refresh_401') && !t.ls.getItem('aorti_auth_v2'), r.join(' ')]);
  }
  { // sign out
    const t = load(src, { native: false });
    await t.auth.signOut({ remote: false });
    const r = t.ring();
    rows.push(['sign out traces clear_token:sign_out', r.includes('auth:clear_token:sign_out'), r.join(' ')]);
  }
  { // pages share the ring
    const t = load(src, { native: false });
    t.auth.trace('viewer_start', { has: true });
    rows.push(['aortiAuth.trace writes the same ring', t.ring().includes('auth:viewer_start'), t.ring().join(' ')]);
  }
  return rows;
}

const MUTANTS = [
  ['clearToken leaves no trace', ["    trace('clear_token', { reason: reason || 'unknown', had: !!localStorage.getItem(LS_KEY_V2) });\n", '']],
  ['native refresh throw untraced', ["            trace('native_refresh_threw', (e && e.message) ? e.message : String(e));\n", '']],
  ['sign out passes no reason', ["clearToken('sign_out');", 'clearToken();']],
];

(async () => {
  let fails = 0;
  for (const [l, c, d] of await checks(SRC)) { console.log((c ? 'PASS ' : 'FAIL ') + l + (c ? '' : '  [' + d + ']')); if (!c) fails++; }
  for (const [name, [a, b]] of MUTANTS) {
    if (!SRC.includes(a)) { console.log('FAIL MUTANT ' + name + ': ANCHOR MISSING'); fails++; continue; }
    const bad = (await checks(SRC.replace(a, b))).filter((r) => !r[1]);
    if (bad.length) console.log('PASS MUTANT ' + name + ': caught (' + bad.map((r) => r[0]).join(' | ') + ')');
    else { console.log('FAIL MUTANT ' + name + ': NOT CAUGHT'); fails++; }
  }
  console.log(`auth-trace: ${fails ? fails + ' fail' : 'all pass'}`);
  process.exit(fails ? 1 : 0);
})();
