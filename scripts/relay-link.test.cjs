#!/usr/bin/env node
// Guards: the relay link (relay-link.js), the broadcast key and publish secret every device on a Google account
// shares through the Drive config. Bugs it caught in review, 2026-10-24 and 25 (docs/relay-publish-secret.md):
// two upgrading devices locking the account out of its room, a new link reverting to the old taken one, a failed
// listing wiping a newer link, one account's key and secret written into another's config, an owner throwing its
// own secret away before the relay's verdict. Files: relay-link.js, the wiring in hr_monitor.html, the watch key in
// hrv_viewer.html. Runtime: about 30 s; ./check runs it.
// The module runs over the fake Drive from marks-store.test.cjs; each check reruns against mutated code, and every
// mutant must make a check FAIL.
// Run: node scripts/relay-link.test.cjs
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');
const { FakeDrive, loadPage } = require('./marks-store.test.cjs');

const ROOT = path.join(__dirname, '..');
const SRC = {
  link: fs.readFileSync(path.join(ROOT, 'relay-link.js'), 'utf8'),
  monitor: fs.readFileSync(path.join(ROOT, 'hr_monitor.html'), 'utf8'),
  viewer: fs.readFileSync(path.join(ROOT, 'hrv_viewer.html'), 'utf8'),
  settings: fs.readFileSync(path.join(ROOT, 'settings.js'), 'utf8'),
  overlay: fs.readFileSync(path.join(ROOT, 'overlay.html'), 'utf8'),
  engine: fs.readFileSync(path.join(ROOT, 'mobile', 'android-overlay', 'app', 'src', 'main', 'java', 'com', 'nakauri', 'hrmonitor', 'HrEngine.java'), 'utf8'),
  csp: fs.readFileSync(path.join(ROOT, 'scripts', 'csp-hashes.mjs'), 'utf8'),
};
// Line endings vary with the checkout; mutation anchors are written with LF.
for (const k of Object.keys(SRC)) SRC[k] = SRC[k].replace(/\r\n/g, '\n');

function loadLink(text) {
  const ctx = vm.createContext({ console, Promise, setTimeout, clearTimeout, Date, Math, JSON, Number, String, Array, Object, Uint8Array, encodeURIComponent, Error });
  ctx.self = ctx;
  vm.runInContext(text, ctx, { filename: 'relay-link.js' });
  return ctx.AortiRelayLink;
}

const CHECKS = {};
CHECKS.K1 = async (src) => {
  const out = [];
  const S1 = '11111111111111111111111111111111', S2 = '22222222222222222222222222222222';
  const KA = 'aaaaaaaaaaaaaaaa';
  const Link = loadLink(src.link);
  // One device's monitor tab: the module, and a stand-in for the page wiring around it, under the names the page
  // used before the module existed, so each case reads as the user's sequence.
  const monitor = (fake, ls, state) => {
    // n.hold: the next config read is answered from Drive as it is now, but only once the promise resolves.
    const n = { reconnects: 0, refreshes: 0, creds: [], intervals: 0, poll: null, hold: null };
    const store = new Map(Object.entries(ls || {}));
    const storage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
    const st = Object.assign({ driveAccessToken: 'tok', driveFolderId: 'root', driveAuthEmail: 'a@example.com', driveLoginTag: 'email:a@example.com' }, state || {});
    const page = {
      driveAccessToken: st.driveAccessToken, driveFolderId: st.driveFolderId,
      driveFetch: (p, i) => {
        const r = fake.fetch(p, i);
        if (!n.hold || !p.includes('alt=media')) return r;
        const hold = n.hold; n.hold = null;
        return hold.then(() => r);
      },
      fetch: (u, i) => fake.fetch(u, i),
    };
    let link;
    const pushCreds = () => n.creds.push({ broadcastKey: link.key(), publishSecret: link.secret() });
    link = Link.create({
      storage, random: (k) => new Uint8Array(crypto.randomBytes(k)),
      token: () => page.driveAccessToken, folder: () => page.driveFolderId,
      driveFetch: (p, i) => page.driveFetch(p, i), upload: (u, i) => page.fetch(u, i),
      onCredentials: () => { pushCreds(); n.reconnects++; },
      onStatus: () => { n.refreshes++; },
      setInterval: (fn) => { n.intervals++; n.poll = fn; return 7; },
      warn: () => {},
      syncLimitMs: (state || {}).syncLimitMs,
    });
    const s = link.state;
    s.loginEmail = st.driveAuthEmail; s.loginTag = st.driveLoginTag;
    s.socketKey = (ls || {}).hr_monitor_broadcast_key || null;
    const map = { relayAccepted: 'accepted', relayRefused: 'refused', relayRefusedAt: 'refusedAt', relayTaken: 'taken', relayKey: 'socketKey',
      configBehind: 'behind', configSyncedAt: 'syncedAt', driveAuthEmail: 'loginEmail', driveLoginTag: 'loginTag' };
    for (const [from, to] of Object.entries(map)) if (state && from in state) s[to] = state[from];
    const ctx = {
      driveSyncConfig: () => link.sync(),
      startConfigPoll: () => link.startPoll(),
      handleRelayMessage: (m) => link.verdict(m.type),
      driveWriteConfig: (id, fields) => link.writeConfig(id, fields, page.driveFolderId),
      driveSignOut: async () => {},
      // The page's "Make a new link": the module, then the engine and this tab's socket.
      regenerateBroadcastKey: () => { link.newLink(); pushCreds(); n.reconnects++; },
      localStorage: storage,
    };
    for (const [from, to] of Object.entries(map)) Object.defineProperty(ctx, from, { get: () => s[to], set: (v) => { s[to] = v; } });
    for (const k of ['driveAccessToken', 'driveFolderId', 'driveFetch', 'fetch']) Object.defineProperty(ctx, k, { get: () => page[k], set: (v) => { page[k] = v; } });
    return { ctx, store, n, link };
  };
  const cfgOf = (fake) => { const f = fake.byName('.hr-monitor-config.json').filter((x) => !x.trashed); return f.length === 1 ? JSON.parse(f[0].content) : null; };
  const oldConfig = () => { const f = new FakeDrive(); f.add({ name: '.hr-monitor-config.json', parents: ['root'], content: JSON.stringify({ broadcastKey: KA }) }); return f; };
  const settle = () => new Promise((r) => setTimeout(r, 20));

  // A config from before the secret, and this device not yet accepted: nothing is written.
  let fake = oldConfig();
  let d = monitor(fake, { hr_monitor_broadcast_key: KA, hr_monitor_publish_secret: S1 });
  await d.ctx.driveSyncConfig();
  out.push(['K1 an old config gets no secret before the relay accepted this device', cfgOf(fake).publishSecret === undefined, JSON.stringify(cfgOf(fake))]);
  // The relay accepts: the accepted handler syncs, and the secret goes in.
  d.ctx.handleRelayMessage({ type: 'publisher_accepted' });
  await settle();
  out.push(['K1 once accepted, the old config gains this device\'s secret and keeps its key', cfgOf(fake).publishSecret === S1 && cfgOf(fake).broadcastKey === KA, JSON.stringify(cfgOf(fake))]);

  // Accepted on a different key than the config's: adopt the key, write nothing (the acceptance was for the old room).
  fake = oldConfig();
  d = monitor(fake, { hr_monitor_broadcast_key: 'bbbbbbbbbbbbbbbb', hr_monitor_publish_secret: S1 }, { relayAccepted: true });
  await d.ctx.driveSyncConfig();
  out.push(['K1 acceptance for another key writes no secret; the device adopts the account key and reconnects',
    cfgOf(fake).publishSecret === undefined && d.store.get('hr_monitor_broadcast_key') === KA && d.n.reconnects === 1, JSON.stringify(cfgOf(fake))]);

  // The 10-24 lock-out: B refused before A's secret lands writes nothing, then adopts A's once it does.
  fake = oldConfig();
  const B = monitor(fake, { hr_monitor_broadcast_key: KA, hr_monitor_publish_secret: S2 });
  B.ctx.handleRelayMessage({ type: 'publisher_rejected' });
  await settle();
  out.push(['K1 a refused device never writes its secret into the config', cfgOf(fake).publishSecret === undefined && B.ctx.relayRefused === true && B.n.intervals === 1, JSON.stringify(cfgOf(fake))]);
  const A = monitor(fake, { hr_monitor_broadcast_key: KA, hr_monitor_publish_secret: S1 }, { relayAccepted: true });
  await A.ctx.driveSyncConfig();
  await B.ctx.driveSyncConfig();
  out.push(['K1 the refused device adopts the owner\'s secret, reconnects and hands it to the engine',
    B.store.get('hr_monitor_publish_secret') === S1 && B.n.reconnects === 1 && B.n.creds.some((c) => c.publishSecret === S1 && c.broadcastKey === KA) && B.ctx.relayRefused === false && cfgOf(fake).publishSecret === S1]);

  // Taken: refused while holding the config's own pair, or refused 3 min with no owner secret appearing.
  d = monitor(fake, { hr_monitor_broadcast_key: KA, hr_monitor_publish_secret: S1 }, { relayRefused: true, relayRefusedAt: Date.now() });
  await d.ctx.driveSyncConfig();
  out.push(['K1 refused with the account\'s own pair shows the link as taken', d.ctx.relayTaken === true && d.n.refreshes >= 1]);
  const lone = oldConfig();
  d = monitor(lone, { hr_monitor_broadcast_key: KA, hr_monitor_publish_secret: S1 }, { relayRefused: true, relayRefusedAt: Date.now() - 60000 });
  await d.ctx.driveSyncConfig();
  const early = d.ctx.relayTaken;
  d.ctx.relayRefusedAt = Date.now() - 200000;
  await d.ctx.driveSyncConfig();
  out.push(['K1 refused with no owner secret: taken only after 3 min', early === false && d.ctx.relayTaken === true]);

  // No config yet: one is created holding the key; the secret joins once the relay accepted it.
  fake = new FakeDrive();
  d = monitor(fake, { hr_monitor_broadcast_key: 'dddddddddddddddd', hr_monitor_publish_secret: S2 });
  await d.ctx.driveSyncConfig();
  out.push(['K1 a first sync creates a config with the key and no unaccepted secret', cfgOf(fake) && cfgOf(fake).broadcastKey === 'dddddddddddddddd' && cfgOf(fake).publishSecret === undefined, JSON.stringify(cfgOf(fake))]);
  d.ctx.handleRelayMessage({ type: 'publisher_accepted' });
  await settle();
  out.push(['K1 once accepted, the new config gains the secret', cfgOf(fake).publishSecret === S2, JSON.stringify(cfgOf(fake))]);

  // A new link reaches Drive and the engine with a fresh secret and its time, so neither keeps the old pair.
  d.ctx.regenerateBroadcastKey();
  await settle();
  const fresh = d.store.get('hr_monitor_broadcast_key'), freshSecret = d.store.get('hr_monitor_publish_secret');
  out.push(['K1 a new link is written to the Drive config with its time and handed to the engine',
    fresh !== 'dddddddddddddddd' && cfgOf(fake) && cfgOf(fake).broadcastKey === fresh && cfgOf(fake).linkAt === Number(d.store.get('hr_monitor_link_at')) && cfgOf(fake).linkAt > 0
    && d.n.creds.some((c) => c.broadcastKey === fresh), JSON.stringify(cfgOf(fake))]);
  out.push(['K1 a new link mints a fresh secret, so the old one cannot claim the new room',
    /^[0-9a-f]{32}$/.test(freshSecret || '') && freshSecret !== S2 && cfgOf(fake).publishSecret === freshSecret]);

  const withConfig = (cfg) => { const f = new FakeDrive(); f.add({ name: '.hr-monitor-config.json', parents: ['root'], content: JSON.stringify(cfg) }); return f; };

  // Round 2: the new room accepts at once, and its sync must not read the old pair back after a failed write.
  fake = withConfig({ broadcastKey: KA, publishSecret: S1 });
  d = monitor(fake, { hr_monitor_broadcast_key: KA, hr_monitor_publish_secret: S1 }, { relayRefused: true, relayTaken: true });
  fake.failUploads = true;
  d.ctx.regenerateBroadcastKey();
  const linkKey = d.store.get('hr_monitor_broadcast_key');
  d.ctx.relayAccepted = true;
  d.ctx.handleRelayMessage({ type: 'publisher_accepted' });
  await settle();
  out.push(['K1 a new link whose Drive write failed keeps its key through an acceptance sync',
    linkKey !== KA && d.store.get('hr_monitor_broadcast_key') === linkKey && d.n.reconnects === 1 && cfgOf(fake).broadcastKey === KA]);
  fake.failUploads = false;
  d.n.poll();
  await settle();
  out.push(['K1 the poll retries the new link until Drive holds it',
    cfgOf(fake).broadcastKey === linkKey && cfgOf(fake).publishSecret === d.store.get('hr_monitor_publish_secret'), JSON.stringify(cfgOf(fake))]);

  // Round 3: a sync already reading the config when the link is made weighs the new link, not the old one.
  // Drive holds another device's earlier link, which this device has not adopted yet.
  fake = withConfig({ broadcastKey: 'bbbbbbbbbbbbbbbb', publishSecret: S2, linkAt: 50 });
  d = monitor(fake, { hr_monitor_broadcast_key: KA, hr_monitor_publish_secret: S1 });
  let release; d.n.hold = new Promise((r) => { release = r; });
  const stale = d.ctx.driveSyncConfig();
  await settle();
  d.ctx.regenerateBroadcastKey();
  await settle();
  const raced = d.store.get('hr_monitor_broadcast_key');
  release();
  await stale; await settle();
  out.push(['K1 a sync in flight across the click keeps the new link, here and in Drive',
    raced !== KA && d.store.get('hr_monitor_broadcast_key') === raced && cfgOf(fake).broadcastKey === raced && cfgOf(fake).publishSecret === d.store.get('hr_monitor_publish_secret'), JSON.stringify(cfgOf(fake))]);

  // Round 3: an older write that lands after the new link's is put right within a minute. (A late write comes
  // from another device of this build, so it carries its older link time; older builds only ever create a config.)
  const at = Number(d.store.get('hr_monitor_link_at'));
  fake.byName('.hr-monitor-config.json')[0].content = JSON.stringify({ broadcastKey: KA, publishSecret: S1, linkAt: 1 });
  await d.ctx.driveSyncConfig();
  const behind = d.ctx.configBehind === true;
  d.ctx.configSyncedAt = Date.now();
  d.ctx.startConfigPoll();
  d.n.poll(); await settle();
  out.push(['K1 an old pair landing after the new link is rewritten, and the poll checks it back',
    cfgOf(fake).broadcastKey === raced && cfgOf(fake).linkAt === at && behind && d.ctx.configBehind === false, JSON.stringify(cfgOf(fake))]);

  // Signed out when the new link is made: it goes in on the first signed-in sync.
  fake = withConfig({ broadcastKey: KA, publishSecret: S1 });
  d = monitor(fake, { hr_monitor_broadcast_key: KA, hr_monitor_publish_secret: S1 }, { driveAccessToken: null });
  d.ctx.regenerateBroadcastKey();
  await settle();
  const outKey = d.store.get('hr_monitor_broadcast_key');
  d.ctx.driveAccessToken = 'tok';
  await d.ctx.driveSyncConfig();
  out.push(['K1 a new link made signed out reaches Drive at the next sign-in instead of reverting',
    outKey !== KA && d.store.get('hr_monitor_broadcast_key') === outKey && cfgOf(fake).broadcastKey === outKey]);

  // Round 3: a link made later on another device wins over this device's older one.
  const later = Number(d.store.get('hr_monitor_link_at')) + 60000;
  fake = withConfig({ broadcastKey: 'cccccccccccccccc', publishSecret: S2, linkAt: later });
  d = monitor(fake, { hr_monitor_broadcast_key: outKey, hr_monitor_publish_secret: S1, hr_monitor_link_at: String(later - 60000), hr_monitor_link_mine: outKey });
  await d.ctx.driveSyncConfig();
  out.push(['K1 an older link here never overwrites a newer one from another device; it adopts the newer',
    cfgOf(fake).broadcastKey === 'cccccccccccccccc' && d.store.get('hr_monitor_broadcast_key') === 'cccccccccccccccc' && d.store.get('hr_monitor_publish_secret') === S2
    && Number(d.store.get('hr_monitor_link_at')) === later, JSON.stringify(cfgOf(fake))]);

  // Accepted for the config's key, this device is the owner: a different secret in the config is repaired.
  fake = withConfig({ broadcastKey: KA, publishSecret: S2, linkAt: 5 });
  d = monitor(fake, { hr_monitor_broadcast_key: KA, hr_monitor_publish_secret: S1, hr_monitor_link_at: '5' }, { relayAccepted: true });
  await d.ctx.driveSyncConfig();
  out.push(['K1 the accepted owner keeps its secret and repairs a stray one, keeping the link time',
    d.store.get('hr_monitor_publish_secret') === S1 && cfgOf(fake).publishSecret === S1 && cfgOf(fake).linkAt === 5 && d.n.reconnects === 0, JSON.stringify(cfgOf(fake))]);

  // The owner's write into an old config fails once: the poll tries again.
  fake = oldConfig();
  d = monitor(fake, { hr_monitor_broadcast_key: KA, hr_monitor_publish_secret: S1 }, { relayAccepted: true });
  fake.failUploads = true;
  let firstFailed = false;
  try { await d.ctx.driveSyncConfig(); } catch (e) { firstFailed = true; }
  fake.failUploads = false;
  d.ctx.startConfigPoll();
  d.n.poll();
  await settle();
  out.push(['K1 a failed owner write is retried by the poll', firstFailed && cfgOf(fake).publishSecret === S1, JSON.stringify(cfgOf(fake))]);

  const switchTo = (dd, drive, token) => {
    dd.ctx.driveFetch = (p, i) => drive.fetch(p, i); dd.ctx.fetch = (u, i) => drive.fetch(u, i); dd.ctx.driveAccessToken = token;
    dd.ctx.driveAuthEmail = (drive.permissionId || 'perm-1') + '@example.com';
    dd.ctx.driveLoginTag = 'email:' + dd.ctx.driveAuthEmail;
  };
  // Round 7: the viewer reads the account's key into its own slot and never writes the monitor's credentials
  // (two pages writing them under different rules put one account's link into another's config).
  const viewer = (vfake, ls) => {
    const store = new Map(Object.entries(ls));
    const ctx = loadPage(src.viewer, ['driveSyncConfig'], {
      localStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) },
      driveAccessToken: 'tok', driveFolderId: 'root', driveFetch: (p, i) => vfake.fetch(p, i), updateWatchLiveUI() {},
      VIEWER_WATCH_KEY: 'hr_viewer_watch_key',
    });
    return { ctx, store };
  };
  const monitorSlots = { hr_monitor_broadcast_key: KA, hr_monitor_publish_secret: S1, hr_monitor_link_at: '1000', hr_monitor_link_mine: KA, hr_monitor_link_account: 'perm-1' };
  let v = viewer(withConfig({ broadcastKey: 'bbbbbbbbbbbbbbbb', publishSecret: S2, linkAt: 5000 }), monitorSlots);
  await v.ctx.driveSyncConfig();
  const untouched = Object.entries(monitorSlots).every(([k, val]) => v.store.get(k) === val);
  out.push(['K1 the viewer keeps the account\'s key in its own slot and leaves the monitor\'s credentials alone',
    untouched && v.store.get('hr_viewer_watch_key') === 'bbbbbbbbbbbbbbbb', JSON.stringify(Array.from(v.store.entries()))]);
  v = viewer(new FakeDrive(), { hr_viewer_watch_key: 'bbbbbbbbbbbbbbbb' });
  await v.ctx.driveSyncConfig();
  out.push(['K1 the viewer forgets the watch key when the account has no config', !v.store.has('hr_viewer_watch_key')]);
  out.push(['K1 the viewer watches the monitor\'s key first, then its own slot',
    /return localStorage\.getItem\('hr_monitor_broadcast_key'\) \|\| localStorage\.getItem\(VIEWER_WATCH_KEY\);/.test(src.viewer)
    && !/localStorage\.(setItem|removeItem)\('hr_monitor_(broadcast_key|publish_secret|link_at|link_mine|link_account)'/.test(src.viewer)]);

  // Round 7: a sync that spans a change of account stops before it writes anything.
  fake = new FakeDrive();
  d = monitor(fake, { hr_monitor_broadcast_key: KA, hr_monitor_publish_secret: S1 }, { relayAccepted: true });
  const bOther = withConfig({ broadcastKey: 'cccccccccccccccc', publishSecret: S2, linkAt: 9 });
  bOther.permissionId = 'perm-2';
  let releaseList; const listHold = new Promise((r) => { releaseList = r; });
  const aFetch = d.ctx.driveFetch;
  let held = false;
  d.ctx.driveFetch = (p, i) => (!held && p.startsWith('files?q=') ? (held = true, listHold.then(() => aFetch(p, i))) : aFetch(p, i));
  const spanning = d.ctx.driveSyncConfig();
  await settle();
  switchTo(d, bOther, 'tok-6');
  d.ctx.driveFolderId = 'root-b';
  releaseList();
  try { await spanning; } catch (e) { /* the B write would fail anyway */ }
  await settle();
  out.push(['K1 a sync spanning a change of account writes nothing to either account',
    JSON.stringify(cfgOf(bOther)) === JSON.stringify({ broadcastKey: 'cccccccccccccccc', publishSecret: S2, linkAt: 9 }) && cfgOf(fake) === null,
    JSON.stringify(cfgOf(bOther)) + ' / ' + JSON.stringify(cfgOf(fake))]);

  // Round 7: a config from before link times is adopted, never overwritten by a device holding a stamped link.
  fake = withConfig({ broadcastKey: 'cccccccccccccccc', publishSecret: S2 });
  d = monitor(fake, { hr_monitor_broadcast_key: KA, hr_monitor_publish_secret: S1, hr_monitor_link_at: '1000', hr_monitor_link_account: 'perm-1' });
  await d.ctx.driveSyncConfig();
  out.push(['K1 a config with no link time is adopted by a device whose link was not made here',
    JSON.stringify(cfgOf(fake)) === JSON.stringify({ broadcastKey: 'cccccccccccccccc', publishSecret: S2 }) && d.store.get('hr_monitor_broadcast_key') === 'cccccccccccccccc', JSON.stringify(cfgOf(fake))]);
  out.push(['K1 the monitor knows the login signed in at load',
    /try \{ setDriveLogin\(window\.aortiAuth\.getCachedToken \? window\.aortiAuth\.getCachedToken\(\) : null\); \}/.test(src.monitor)]);

  // Round 4: a config stamped by a clock running ahead never outranks a click here.
  const ahead = Date.now() + 86400000;
  fake = withConfig({ broadcastKey: 'cccccccccccccccc', publishSecret: S2, linkAt: ahead });
  d = monitor(fake, { hr_monitor_broadcast_key: 'cccccccccccccccc', hr_monitor_publish_secret: S2 }, { relayRefused: true, relayRefusedAt: Date.now() });
  await d.ctx.driveSyncConfig();
  const keptAhead = Number(d.store.get('hr_monitor_link_at')) === ahead;
  d.ctx.regenerateBroadcastKey();
  await settle();
  const clicked = d.store.get('hr_monitor_broadcast_key');
  await d.ctx.driveSyncConfig();
  out.push(['K1 a click outranks a config stamped by a clock running ahead, and stays',
    keptAhead && clicked !== 'cccccccccccccccc' && d.store.get('hr_monitor_broadcast_key') === clicked && cfgOf(fake).broadcastKey === clicked && cfgOf(fake).linkAt > ahead, JSON.stringify(cfgOf(fake))]);

  // Rounds 4 and 5: a link made under one account never lands in another account's config, however the account
  // changes (sign-out, an expired login, a re-sign-in as someone else), and that account's own link is adopted.
  for (const [label, how] of [['a sign-out', 'signout'], ['a new login with no sign-out', 'token']]) {
    fake = withConfig({ broadcastKey: KA, publishSecret: S1 });
    d = monitor(fake, { hr_monitor_broadcast_key: KA, hr_monitor_publish_secret: S1 });
    await d.ctx.driveSyncConfig();
    fake.failUploads = true;
    d.ctx.regenerateBroadcastKey();
    await settle();
    if (how === 'signout') await d.ctx.driveSignOut();
    const other = withConfig({ broadcastKey: 'cccccccccccccccc', publishSecret: S2 });
    other.permissionId = 'perm-2';
    switchTo(d, other, 'tok-2');
    await d.ctx.driveSyncConfig();
    out.push(['K1 after ' + label + ', another account\'s key is adopted and its config left alone',
      JSON.stringify(cfgOf(other)) === JSON.stringify({ broadcastKey: 'cccccccccccccccc', publishSecret: S2 }) && d.store.get('hr_monitor_broadcast_key') === 'cccccccccccccccc'
      && d.store.get('hr_monitor_publish_secret') === S2 && d.store.get('hr_monitor_link_account') === 'perm-2', JSON.stringify(cfgOf(other))]);
  }

  // Round 5: an account with no config gets a fresh link of its own, never the last account's key or secret.
  fake = withConfig({ broadcastKey: KA, publishSecret: S1 });
  d = monitor(fake, { hr_monitor_broadcast_key: KA, hr_monitor_publish_secret: S1 }, { relayAccepted: true });
  await d.ctx.driveSyncConfig();
  const empty = new FakeDrive();
  empty.permissionId = 'perm-2';
  switchTo(d, empty, 'tok-2');
  await d.ctx.driveSyncConfig();
  const fresh2 = cfgOf(empty);
  out.push(['K1 a new account with no config gets its own fresh key and secret',
    fresh2 && fresh2.broadcastKey !== KA && fresh2.publishSecret && fresh2.publishSecret !== S1 && d.store.get('hr_monitor_broadcast_key') === fresh2.broadcastKey
    && d.store.get('hr_monitor_publish_secret') === fresh2.publishSecret && d.n.creds.some((c) => c.broadcastKey === fresh2.broadcastKey), JSON.stringify(fresh2)]);
  out.push(['K1 the first account keeps its config', JSON.stringify(cfgOf(fake)) === JSON.stringify({ broadcastKey: KA, publishSecret: S1 }), JSON.stringify(cfgOf(fake))]);

  // Round 5: a room an older build gave two accounts: under the second, this device is never its owner.
  fake = withConfig({ broadcastKey: KA, publishSecret: S1 });
  d = monitor(fake, { hr_monitor_broadcast_key: KA, hr_monitor_publish_secret: S1 }, { relayAccepted: true });
  await d.ctx.driveSyncConfig();
  const shared = withConfig({ broadcastKey: KA, publishSecret: S2 });
  shared.permissionId = 'perm-2';
  switchTo(d, shared, 'tok-4');
  await d.ctx.driveSyncConfig();
  const heldShared = cfgOf(shared).publishSecret === S2 && d.store.get('hr_monitor_publish_secret') === S1;
  d.ctx.relayAccepted = false; d.ctx.relayRefused = true; d.ctx.relayKey = KA;
  await d.ctx.driveSyncConfig();
  out.push(['K1 under another account sharing the room, the device never writes its secret there, and adopts that config\'s once refused',
    heldShared && cfgOf(shared).publishSecret === S2 && d.store.get('hr_monitor_publish_secret') === S2, JSON.stringify(cfgOf(shared))]);

  // Round 6: a failed listing is never read as "no config", so it never writes over a newer link.
  fake = withConfig({ broadcastKey: 'cccccccccccccccc', publishSecret: S2, linkAt: 500 });
  d = monitor(fake, { hr_monitor_broadcast_key: KA, hr_monitor_publish_secret: S1 });
  const realFetch = d.ctx.driveFetch;
  let failList = true;
  d.ctx.driveFetch = (p, i) => (failList && p.startsWith('files?q=') ? (failList = false, Promise.resolve({ ok: false, status: 500, json: async () => ({}), text: async () => '' })) : realFetch(p, i));
  let listThrew = false;
  try { await d.ctx.driveSyncConfig(); } catch (e) { listThrew = /config list 500/.test(e.message); }
  out.push(['K1 a failed config listing fails the sync and writes nothing',
    listThrew && JSON.stringify(cfgOf(fake)) === JSON.stringify({ broadcastKey: 'cccccccccccccccc', publishSecret: S2, linkAt: 500 }) && fake.byName('.hr-monitor-config.json').length === 1, JSON.stringify(cfgOf(fake))]);

  // Round 6: a key adopted with no secret beside it gets a fresh secret, never the room left behind's.
  fake = withConfig({ broadcastKey: KA, publishSecret: S1 });
  d = monitor(fake, { hr_monitor_broadcast_key: KA, hr_monitor_publish_secret: S1 });
  await d.ctx.driveSyncConfig();
  const bare = withConfig({ broadcastKey: 'bbbbbbbbbbbbbbbb' });
  bare.permissionId = 'perm-2';
  switchTo(d, bare, 'tok-5');
  await d.ctx.driveSyncConfig();
  const bareSecret = d.store.get('hr_monitor_publish_secret');
  d.ctx.relayAccepted = true; d.ctx.relayKey = 'bbbbbbbbbbbbbbbb';
  await d.ctx.driveSyncConfig();
  out.push(['K1 a key adopted without a secret takes a fresh one, and only that one reaches the config',
    d.store.get('hr_monitor_broadcast_key') === 'bbbbbbbbbbbbbbbb' && /^[0-9a-f]{32}$/.test(bareSecret || '') && bareSecret !== S1
    && cfgOf(bare).publishSecret === bareSecret, JSON.stringify(cfgOf(bare))]);

  // Round 6: after the maker read its link back, an older link written late is put right.
  for (const [label, accepted] of [['accepted here: with its secret', true], ['not accepted here: key and time only', false]]) {
    fake = withConfig({ broadcastKey: KA, publishSecret: S1, linkAt: 100 });
    d = monitor(fake, { hr_monitor_broadcast_key: KA, hr_monitor_publish_secret: S1, hr_monitor_link_at: '100' });
    await d.ctx.driveSyncConfig();
    d.ctx.regenerateBroadcastKey();
    await settle();
    await d.ctx.driveSyncConfig();
    const made = d.store.get('hr_monitor_broadcast_key'), madeSecret = d.store.get('hr_monitor_publish_secret'), madeAt = Number(d.store.get('hr_monitor_link_at'));
    const readBack = !d.store.has('hr_monitor_link_mine');
    d.ctx.relayAccepted = accepted; d.ctx.relayKey = made;
    fake.byName('.hr-monitor-config.json')[0].content = JSON.stringify({ broadcastKey: KA, publishSecret: S1, linkAt: 100 });
    await d.ctx.driveSyncConfig();
    const c = cfgOf(fake);
    out.push(['K1 an older link written late after the read-back is put right (' + label + ')',
      readBack && d.store.get('hr_monitor_broadcast_key') === made && c.broadcastKey === made && c.linkAt === madeAt
      && (accepted ? c.publishSecret === madeSecret : c.publishSecret === undefined) && d.ctx.configBehind === true, JSON.stringify(c)]);
  }

  // Round 6: overlapping syncs ask Drive for the account once per token.
  fake = withConfig({ broadcastKey: KA, publishSecret: S1 });
  d = monitor(fake, { hr_monitor_broadcast_key: KA, hr_monitor_publish_secret: S1 });
  let abouts = 0;
  const countFetch = d.ctx.driveFetch;
  d.ctx.driveFetch = (p, i) => { if (p.startsWith('about')) abouts++; return countFetch(p, i); };
  await Promise.all([d.ctx.driveSyncConfig(), d.ctx.driveSyncConfig()]);
  await d.ctx.driveSyncConfig();
  out.push(['K1 overlapping syncs ask for the account once per token', abouts === 1, 'about requests ' + abouts]);

  // The module: one sync at a time. A request while one is held mid-read starts no second listing, and runs once
  // more after it, so a change made meanwhile still lands.
  fake = withConfig({ broadcastKey: KA, publishSecret: S1, linkAt: 3 });
  d = monitor(fake, { hr_monitor_broadcast_key: KA, hr_monitor_publish_secret: S1, hr_monitor_link_at: '3' });
  let lists = 0;
  const listFetch = d.ctx.driveFetch;
  d.ctx.driveFetch = (p, i) => { if (p.startsWith('files?q=')) lists++; return listFetch(p, i); };
  let releaseOne; d.n.hold = new Promise((r) => { releaseOne = r; });
  const first = d.ctx.driveSyncConfig();
  await settle();
  const second = d.ctx.driveSyncConfig();
  await settle();
  const listsWhileHeld = lists;
  releaseOne();
  await first; await second; await settle();
  out.push(['K1 one sync at a time: a second request waits, then runs once more',
    listsWhileHeld === 1 && lists === 2, 'listings while held ' + listsWhileHeld + ', after ' + lists]);

  // A sync whose read never comes back is given up at its limit, so a new link still reaches Drive, and the late
  // answer, when it comes, changes nothing.
  fake = withConfig({ broadcastKey: KA, publishSecret: S1, linkAt: 3 });
  d = monitor(fake, { hr_monitor_broadcast_key: KA, hr_monitor_publish_secret: S1, hr_monitor_link_at: '3' }, { syncLimitMs: 40 });
  let releaseHung; d.n.hold = new Promise((r) => { releaseHung = r; });
  const hung = d.ctx.driveSyncConfig().then(() => false, (e) => /timed out/.test(e.message));
  await new Promise((r) => setTimeout(r, 80));
  const hungGivenUp = await hung;
  d.ctx.regenerateBroadcastKey();
  await settle(); await settle();
  const madeKey = d.store.get('hr_monitor_broadcast_key');
  const reached = cfgOf(fake).broadcastKey === madeKey;
  let lateUploads = 0;
  const upFetch = d.ctx.fetch;
  d.ctx.fetch = (u, i) => { lateUploads++; return upFetch(u, i); };
  releaseHung();
  await settle(); await settle();
  out.push(['K1 a hung sync is given up at its limit; a new link still lands, and the late answer changes nothing',
    hungGivenUp && reached && lateUploads === 0 && d.store.get('hr_monitor_broadcast_key') === madeKey && cfgOf(fake).broadcastKey === madeKey,
    [hungGivenUp, reached, lateUploads].join(',')]);

  // A stored key that is not 16 hex characters never becomes the room name in the socket URL.
  d = monitor(new FakeDrive(), { hr_monitor_broadcast_key: 'room/../x?y', hr_monitor_publish_secret: S1 });
  const fixedKey = d.link.key();
  out.push(['K1 a malformed stored key is replaced before it names a room', /^[0-9a-f]{16}$/.test(fixedKey) && d.store.get('hr_monitor_broadcast_key') === fixedKey, fixedKey]);

  // A sync given up while its owner write hangs acts on nothing once that write lands.
  fake = withConfig({ broadcastKey: KA, publishSecret: S2, linkAt: 7 });
  d = monitor(fake, { hr_monitor_broadcast_key: KA, hr_monitor_publish_secret: S1, hr_monitor_link_at: '7' }, { relayAccepted: true, relayKey: KA, syncLimitMs: 40 });
  let releaseWrite;
  const writeHeld = new Promise((r) => { releaseWrite = r; });
  const realUp = d.ctx.fetch;
  d.ctx.fetch = (u, i) => writeHeld.then(() => realUp(u, i));
  const ownerRun = d.ctx.driveSyncConfig().then(() => false, (e) => /timed out/.test(e.message));
  await new Promise((r) => setTimeout(r, 80));
  const ownerGivenUp = await ownerRun;
  d.ctx.configSyncedAt = 0;
  releaseWrite();
  await settle(); await settle();
  out.push(['K1 a sync given up during its owner write leaves no trace once the write lands',
    ownerGivenUp && d.ctx.configSyncedAt === 0, [ownerGivenUp, d.ctx.configSyncedAt].join(',')]);

  // The page's own wiring, run for real: its create() object, followRelayCredentials and the engine push.
  {
    const M0 = src.monitor;
    const at0 = M0.indexOf('const relayLink = AortiRelayLink.create(');
    let depth = 0, end = -1;
    for (let i = M0.indexOf('(', at0); i < M0.length; i++) {
      if (M0[i] === '(') depth++;
      if (M0[i] === ')') { depth--; if (!depth) { end = i; break; } }
    }
    const grab = (name) => { const m = new RegExp('^  function ' + name + '\\(', 'm').exec(M0); const j = M0.indexOf('\n  }\n', m.index); return M0.slice(m.index, j + 4); };
    const code = M0.slice(at0, end + 1) + ';\n' + ['followRelayCredentials', 'pushRelayCredentialsToEngine', 'getOrCreateBroadcastKey', 'getOrCreatePublishSecret'].map(grab).join('\n')
      + '\n;({ relayLink })';
    const pageDrive = new FakeDrive();
    const pstore = new Map(Object.entries({ hr_monitor_broadcast_key: KA, hr_monitor_publish_secret: S1, hr_monitor_link_account: 'perm-9' }));
    const pn = { reconnects: 0, creds: [], uploads: [] };
    const pctx = vm.createContext({
      AortiRelayLink: Link, console, Promise, setTimeout, clearTimeout, Object, Uint8Array, JSON, Date,
      localStorage: { getItem: (k) => (pstore.has(k) ? pstore.get(k) : null), setItem: (k, v) => pstore.set(k, String(v)), removeItem: (k) => pstore.delete(k) },
      crypto: require('crypto').webcrypto, driveAccessToken: 'tok', driveFolderId: 'root',
      driveFetch: (p, i) => pageDrive.fetch(p, i), driveAuthHeader: async () => 'Bearer page-token',
      fetch: (u, i) => { pn.uploads.push(i); return pageDrive.fetch(u, i); },
      reconnectRelay: () => { pn.reconnects++; }, updateStreamingUI() {}, updateWatchMode() {}, refreshRelayStatus() {},
      watchFrameSrc: 'x', setInterval: () => 7,
      window: { HRMNativeHrSession: { setRelayCredentials: async (o) => { pn.creds.push(o); } } },
    });
    const { relayLink } = vm.runInContext(code, pctx);
    // This key belongs to another account and this one has no config: the page's link mints and the page follows.
    await relayLink.sync();
    const minted = pstore.get('hr_monitor_broadcast_key');
    const up = pn.uploads[0] || { headers: {} };
    out.push(['K1 the page\'s wiring: a fresh link reaches the engine and the socket, and uploads carry the login',
      minted !== KA && pn.reconnects === 1 && pn.creds.length === 1 && pn.creds[0].broadcastKey === minted
      && up.headers.Authorization === 'Bearer page-token' && /^multipart\/related; boundary=/.test(up.headers['Content-Type'] || '')
      && cfgOf(pageDrive) && cfgOf(pageDrive).broadcastKey === minted
      && pageDrive.byName('.hr-monitor-config.json')[0].parents[0] === 'root',
      [minted, pn.reconnects, pn.creds.length, JSON.stringify(up.headers)].join(' | ')]);
  }

  // Round 6: another account signed in over this one drops the old account's folder.
  out.push(['K1 a different account signing in drops the old folder and account id',
    /if \(record && record\.email && relayLink\.loginEmail && record\.email !== relayLink\.loginEmail\) \{\s*driveFolderId = null;\s*relayLink\.forgetAccount\(\);/.test(src.monitor)]);

  // Round 5: signing out and back into the same account before Drive took a new link keeps the link.
  fake = withConfig({ broadcastKey: KA, publishSecret: S1 });
  d = monitor(fake, { hr_monitor_broadcast_key: KA, hr_monitor_publish_secret: S1 });
  await d.ctx.driveSyncConfig();
  fake.failUploads = true;
  d.ctx.regenerateBroadcastKey();
  await settle();
  const kept3 = d.store.get('hr_monitor_broadcast_key');
  await d.ctx.driveSignOut();
  fake.failUploads = false;
  switchTo(d, fake, 'tok-3');
  await d.ctx.driveSyncConfig();
  out.push(['K1 a sign-out and back into the same account keeps a link Drive had not taken yet',
    kept3 !== KA && d.store.get('hr_monitor_broadcast_key') === kept3 && cfgOf(fake).broadcastKey === kept3, JSON.stringify(cfgOf(fake))]);

  // Round 4: a key the viewer adopted, with no config in Drive, gets no unproven secret written next to it.
  for (const [label, state] of [['unaccepted', {}], ['accepted for an older key', { relayAccepted: true, relayKey: 'bbbbbbbbbbbbbbbb' }]]) {
    fake = new FakeDrive();
    d = monitor(fake, { hr_monitor_broadcast_key: KA, hr_monitor_publish_secret: S2, hr_monitor_link_at: '1761400000000' }, state);
    await d.ctx.driveSyncConfig();
    out.push(['K1 a key not made here gets a config without a secret (' + label + ')', cfgOf(fake) && cfgOf(fake).broadcastKey === KA && cfgOf(fake).publishSecret === undefined, JSON.stringify(cfgOf(fake))]);
  }

  // Round 4: an unreadable config is replaced by a link made here, and left alone otherwise.
  const junk = () => { const f = new FakeDrive(); f.add({ name: '.hr-monitor-config.json', parents: ['root'], content: 'not json {' }); return f; };
  fake = junk();
  d = monitor(fake, { hr_monitor_broadcast_key: KA, hr_monitor_publish_secret: S1 });
  d.ctx.regenerateBroadcastKey();
  await settle();
  let junkMine = false;
  try { junkMine = cfgOf(fake).broadcastKey === d.store.get('hr_monitor_broadcast_key'); } catch (e) { /* still junk */ }
  fake = junk();
  d = monitor(fake, { hr_monitor_broadcast_key: KA, hr_monitor_publish_secret: S1, hr_monitor_link_at: '1000' });
  let junkThrew = false;
  try { await d.ctx.driveSyncConfig(); } catch (e) { junkThrew = true; }
  out.push(['K1 an unreadable config takes a new link made here, is left alone otherwise, and counts as synced',
    junkMine && !junkThrew && fake.byName('.hr-monitor-config.json')[0].content === 'not json {' && d.ctx.configSyncedAt > 0]);

  // Round 4: an acceptance for the key the socket used never vouches for a key changed since.
  fake = withConfig({ broadcastKey: KA, publishSecret: S2 });
  d = monitor(fake, { hr_monitor_broadcast_key: KA, hr_monitor_publish_secret: S1 }, { relayAccepted: true, relayKey: 'bbbbbbbbbbbbbbbb' });
  await d.ctx.driveSyncConfig();
  out.push(['K1 a stale acceptance neither overwrites the config secret nor gives up this device\'s before a verdict',
    cfgOf(fake).publishSecret === S2 && d.store.get('hr_monitor_publish_secret') === S1, JSON.stringify(cfgOf(fake))]);

  // Round 8: the owner's sync landing before the relay's verdict keeps its own secret; refused, it adopts.
  fake = withConfig({ broadcastKey: KA, publishSecret: S2, linkAt: 7 });
  d = monitor(fake, { hr_monitor_broadcast_key: KA, hr_monitor_publish_secret: S1, hr_monitor_link_at: '7' });
  await d.ctx.driveSyncConfig();
  const keptOwn = d.store.get('hr_monitor_publish_secret') === S1 && d.n.reconnects === 0;
  d.ctx.handleRelayMessage({ type: 'publisher_accepted' });
  d.ctx.relayAccepted = true; d.ctx.relayKey = KA;
  await settle(); await d.ctx.driveSyncConfig();
  out.push(['K1 an owner whose sync beats the verdict keeps its secret, then repairs the stray',
    keptOwn && cfgOf(fake).publishSecret === S1 && d.store.get('hr_monitor_publish_secret') === S1, JSON.stringify(cfgOf(fake))]);
  fake = withConfig({ broadcastKey: KA, publishSecret: S2, linkAt: 7 });
  d = monitor(fake, { hr_monitor_broadcast_key: KA, hr_monitor_publish_secret: S1, hr_monitor_link_at: '7' }, { relayRefused: true, relayKey: KA, relayRefusedAt: Date.now() });
  await d.ctx.driveSyncConfig();
  out.push(['K1 refused for the key, the device adopts the config secret', d.store.get('hr_monitor_publish_secret') === S2 && d.n.reconnects === 1]);

  // Round 8: a new link is stored secret first, both made before either is stored, with no removal.
  fake = withConfig({ broadcastKey: KA, publishSecret: S1 });
  d = monitor(fake, { hr_monitor_broadcast_key: KA, hr_monitor_publish_secret: S1 }, { driveAccessToken: null });
  const ops = [];
  const realSet = d.ctx.localStorage.setItem, realRemove = d.ctx.localStorage.removeItem;
  d.ctx.localStorage.setItem = (k, val) => { ops.push('set ' + k); realSet(k, val); };
  d.ctx.localStorage.removeItem = (k) => { ops.push('remove ' + k); realRemove(k); };
  d.ctx.regenerateBroadcastKey();
  const credOps = ops.filter((o) => /hr_monitor_(broadcast_key|publish_secret)$/.test(o));
  out.push(['K1 a new link stores its secret before its key and never removes either',
    credOps.join(',') === 'set hr_monitor_publish_secret,set hr_monitor_broadcast_key' && d.ctx.configBehind === true, credOps.join(',')]);

  // Rounds 8 and 9: a click signed in before this account's id is known is bound to its login, so that login keeps
  // it and no other login's sync can claim it.
  fake = withConfig({ broadcastKey: 'cccccccccccccccc', publishSecret: S2, linkAt: 3 });
  fake.permissionId = 'perm-2';
  d = monitor(fake, { hr_monitor_broadcast_key: KA, hr_monitor_publish_secret: S1, hr_monitor_link_account: 'perm-1' }, { driveAuthEmail: 'perm-2@example.com', driveLoginTag: 'email:perm-2@example.com' });
  d.ctx.regenerateBroadcastKey();
  const unboundKey = d.store.get('hr_monitor_broadcast_key');
  const loginBound = d.store.get('hr_monitor_link_account') === 'email:perm-2@example.com';
  await settle(); await d.ctx.driveSyncConfig();
  out.push(['K1 a click before the signed-in account is known stays with that login',
    loginBound && d.store.get('hr_monitor_broadcast_key') === unboundKey && cfgOf(fake).broadcastKey === unboundKey && d.store.get('hr_monitor_link_account') === 'perm-2', JSON.stringify(cfgOf(fake))]);
  fake = withConfig({ broadcastKey: 'cccccccccccccccc', publishSecret: S2, linkAt: 3 });
  fake.permissionId = 'perm-2';
  d = monitor(fake, { hr_monitor_broadcast_key: KA, hr_monitor_publish_secret: S1, hr_monitor_link_account: 'perm-1' }, { driveAuthEmail: 'perm-2@example.com', driveLoginTag: 'email:perm-2@example.com', driveAccessToken: null });
  d.ctx.driveAccessToken = 'tok';
  d.ctx.regenerateBroadcastKey();
  const yDrive = withConfig({ broadcastKey: 'dddddddddddddddd', publishSecret: S1, linkAt: 4 });
  yDrive.permissionId = 'perm-3';
  switchTo(d, yDrive, 'tok-y');
  await settle(); await d.ctx.driveSyncConfig();
  out.push(['K1 another login\'s sync never claims a click bound to the first login',
    JSON.stringify(cfgOf(yDrive)) === JSON.stringify({ broadcastKey: 'dddddddddddddddd', publishSecret: S1, linkAt: 4 }) && d.store.get('hr_monitor_broadcast_key') === 'dddddddddddddddd', JSON.stringify(cfgOf(yDrive))]);
  // Round 10: a login whose record has no email gets a random tag, so another login still reads its click as foreign.
  fake = withConfig({ broadcastKey: 'cccccccccccccccc', publishSecret: S2, linkAt: 3 });
  d = monitor(fake, { hr_monitor_broadcast_key: KA, hr_monitor_publish_secret: S1, hr_monitor_link_account: 'perm-1' }, { driveAuthEmail: null, driveLoginTag: 'login:first', driveAccessToken: null });
  d.ctx.driveAccessToken = 'tok';
  d.ctx.regenerateBroadcastKey();
  const tagged = d.store.get('hr_monitor_link_account') === 'login:first';
  const zDrive = withConfig({ broadcastKey: 'eeeeeeeeeeeeeeee', publishSecret: S2, linkAt: 5 });
  zDrive.permissionId = 'perm-4';
  switchTo(d, zDrive, 'tok-z');
  d.ctx.driveAuthEmail = null; d.ctx.driveLoginTag = 'login:second';
  await settle(); await d.ctx.driveSyncConfig();
  out.push(['K1 a click under a login with no email is foreign to the next login',
    tagged && JSON.stringify(cfgOf(zDrive)) === JSON.stringify({ broadcastKey: 'eeeeeeeeeeeeeeee', publishSecret: S2, linkAt: 5 }), JSON.stringify(cfgOf(zDrive))]);
  const tagStore = new Map();
  const tagLs = { getItem: (k) => (tagStore.has(k) ? tagStore.get(k) : null), setItem: (k, v) => tagStore.set(k, String(v)), removeItem: (k) => tagStore.delete(k) };
  const tagEnv = { storage: tagLs, random: (k) => new Uint8Array(crypto.randomBytes(k)), token: () => null, folder: () => null };
  const login = Link.create(tagEnv);
  login.setLogin({ email: 'a@example.com' });
  login.setLogin(null);
  const cleared = login.loginEmail === null && login.loginTag === null && !tagStore.has('hr_monitor_login_tag');
  login.setLogin({ email: null });
  const randomTag = /^login:/.test(login.loginTag || '');
  const firstTag = login.loginTag;
  login.setLogin({ email: null });
  // A reload: memory starts empty, the stored tag carries the login over.
  const reloaded = Link.create(tagEnv);
  reloaded.setLogin({ email: null });
  out.push(['K1 a sign-out clears the login tag; a login with no email gets one random tag, kept across a reload',
    cleared && randomTag && login.loginTag === firstTag && reloaded.loginTag === firstTag, String(reloaded.loginTag)]);
  const tab = monitor(new FakeDrive(), { hr_monitor_broadcast_key: KA, hr_monitor_publish_secret: S1 }, { relayRefused: true, relayRefusedAt: 5, relayTaken: true });
  const follows = tab.link.otherTabChanged('hr_monitor_publish_secret', S2);
  const removal = tab.link.otherTabChanged('hr_monitor_broadcast_key', null);
  const unrelated = tab.link.otherTabChanged('hr_monitor_widget_prefs', '{}');
  out.push(['K1 a tab following another tab\'s change drops its old refusal, ignores the removal half, and one socket replaces the last',
    follows && !removal && !unrelated && tab.ctx.relayRefused === false && tab.ctx.relayRefusedAt === 0 && tab.ctx.relayTaken === false
    && /window\.addEventListener\('storage', \(e\) => \{\s*if \(relayLink\.otherTabChanged\(e\.key, e\.newValue\)\) followRelayCredentials\(false\);/.test(src.monitor)
    && /function followRelayCredentials\(toEngine\) \{\s*if \(toEngine\) pushRelayCredentialsToEngine\(\);\s*reconnectRelay\(\);/.test(src.monitor)
    && /if \(relaySocket && relaySocket\.readyState !== WebSocket\.CLOSED\) \{\s*const old = relaySocket;\s*relaySocket = null;\s*try \{ old\.close\(\); \} catch \(e\) \{\}/.test(src.monitor)]);
  out.push(['K1 a folder lookup that lands after another account signed in is dropped',
    (src.monitor.match(/if \(relayLink\.loginTag !== login \|\| !driveAccessToken\) return;/g) || []).length === 2]);
  out.push(['K1 settings sync never maps the broadcast key', !/lsKey: 'hr_monitor_broadcast_key'/.test(src.settings)]);
  // A failed config write is an error, not a silent success.
  fake = withConfig({ broadcastKey: KA, publishSecret: S1 });
  d = monitor(fake, { hr_monitor_broadcast_key: KA, hr_monitor_publish_secret: S1 });
  fake.failUploads = true;
  let threw = false;
  try { await d.ctx.driveWriteConfig(undefined, { broadcastKey: KA }); } catch (e) { threw = /config write 503/.test(e.message); }
  out.push(['K1 a failed config write throws', threw]);

  const M = src.monitor;
  out.push(['K1 the monitor socket and the native start both carry the secret',
    /\?role=publisher&proof=' \+ getOrCreatePublishSecret\(\)/.test(M) && /publishSecret: getOrCreatePublishSecret\(\),\s*senderLabel/.test(M)]);
  out.push(['K1 a resumed native session gets the page\'s credentials', /if \(snap\.sessionActive\) pushRelayCredentialsToEngine\(\);/.test(M) && /setItem\('hr_monitor_device_label', r\.senderLabel\);\s*pushRelayCredentialsToEngine\(\);/.test(M)]);
  // The page wiring: the module holds the state; the page only tells it what the socket does, and follows it.
  out.push(['K1 the page hands the socket\'s key, verdicts and status reads to the module, and follows a new link',
    /relayLink\.connecting\(key\);\s*try \{\s*const ws = new WebSocket\(RELAY_HOST \+ '\/parties\/main\/' \+ key/.test(M)
    && /if \(relayLink\.verdict\(msg\.type\)\) return;/.test(M)
    && /taken\.hidden = !\(relayLink\.state\.taken && widgetPrefs\.broadcast\)/.test(M) && /if \(relayLink\.state\.refused \|\| nativeRelayRefused\(\)\)/.test(M)
    && /relayLink\.newLink\(\);\s*followRelayCredentials\(true\);/.test(M)
    && /if \(relayLink\.otherTabChanged\(e\.key, e\.newValue\)\) followRelayCredentials\(false\);/.test(M)
    && /<script src="\.\/relay-link\.js"><\/script>/.test(M)
    // A relay that stays down is retried at 5 s doubling to a minute, not every 5 s for ever (re-grade 2026-10-25).
    // and the backoff starts over only once a socket has stayed open 30 s, or on a deliberate reconnect.
    && /relayRetryMs = Math\.min\(60000, relayRetryMs \* 2\);/.test(M)
    && /relayHealthyTimer = setTimeout\(\(\) => \{ relayHealthyTimer = null; if \(relaySocket === ws\) relayRetryMs = 5000; \}, 30000\);/.test(M)
    && /\/\/ A deliberate reconnect \(a new key or secret\) starts the backoff over\.\s*relayRetryMs = 5000;/.test(M)
    && !/setTimeout\(connectRelay, 5000\)/.test(M)
    && !/let relayRefused|let configBehind|function driveSyncConfig\(\) \{\s*if|const LINK_AT/.test(M)]);
  // One home for the relay's address: the pages read it from the module, the CSP generator reads the module, and
  // the engine's copy (Java cannot load the module) must match it.
  const host = Link.RELAY_HOST;
  const pageCopies = (t) => (t.match(/wss:\/\/[a-z0-9.-]+\.workers\.dev/g) || []);
  out.push(['K1 the relay address lives in the module; pages read it, the engine\'s copy matches',
    /^wss:\/\/[a-z0-9.-]+$/.test(host)
    && pageCopies(M).length === 0 && pageCopies(src.viewer).length === 0 && pageCopies(src.overlay).length === 0
    && /const RELAY_HOST = AortiRelayLink\.RELAY_HOST;/.test(M) && /const RELAY_HOST = AortiRelayLink\.RELAY_HOST;/.test(src.overlay)
    && /new WebSocket\(AortiRelayLink\.RELAY_HOST \+ '\/parties\/main\/'/.test(src.viewer)
    && /readFileSync\([\s\S]{0,140}'relay-link\.js'\)/.test(src.csp) && pageCopies(src.csp).length === 0
    && src.engine.includes('"' + host + '/parties/main/"'), host]);
  return out;
};

// ---------------------------------------------------------------- mutants
const RAW = require('./relay-link.mutants.cjs');
const MUTANTS = RAW.map(([name, key, find, replace]) => ['K1', name, key, find, replace]);
const EXTRA = RAW.EXTRA;

function mutate(name, key, find, replace) {
  const src = Object.assign({}, SRC);
  const edits = [[key, find, replace]].concat(EXTRA[name] || []);
  for (const [k, f, r] of edits) {
    if (!src[k].includes(f)) throw new Error('mutation anchor not found (' + name + '): ' + f.slice(0, 80));
    src[k] = src[k].replace(f, r);
  }
  return src;
}

// ---------------------------------------------------------------- main
// A check left waiting on a promise that never settles would let node exit early with code 0: the run starts as a
// failure and only a full pass clears it, and a check that stalls counts as failed.
process.exitCode = 1;
const STALL_MS = 30000;
const bounded = (p) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('check stalled')), STALL_MS))]);
(async () => {
  let bad = 0;
  for (const [id, fn] of Object.entries(CHECKS)) {
    let rows;
    try { rows = await bounded(fn(SRC)); } catch (e) { rows = [[id + ' threw: ' + (e && e.stack || e), false]]; }
    for (const [label, ok, detail] of rows) {
      console.log((ok ? 'PASS ' : 'FAIL ') + label + (detail && !ok ? '  [' + detail + ']' : ''));
      if (!ok) bad++;
    }
  }
  console.log('\nNegative controls (each must FAIL its check):');
  for (const [check, name, key, find, replace] of MUTANTS) {
    let caught = false, note = '';
    try {
      const rows = await bounded(CHECKS[check](mutate(name, key, find, replace)));
      const fails = rows.filter(r => !r[1]);
      caught = fails.length > 0;
      note = fails.map(r => r[0]).join(' | ');
    } catch (e) {
      if (/mutation anchor not found/.test(e.message)) { note = e.message; caught = false; }
      else { caught = true; note = 'threw: ' + e.message.split('\n')[0]; }
    }
    console.log('MUTANT ' + check + ' ' + name + ': ' + (caught ? 'FAILED as required' : 'NOT CAUGHT') + (note ? '  (' + note + ')' : ''));
    if (!caught) bad++;
  }
  if (bad) { console.log('\n' + bad + ' problem(s)'); process.exit(1); }
  console.log('\nAll relay link checks pass; all ' + MUTANTS.length + ' negative controls fail');
  process.exit(0);
})();
