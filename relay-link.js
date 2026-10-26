// Relay link: the broadcast key and publish secret this device publishes with, and their copy in the account's
// Drive config (.hr-monitor-config.json), shared by every device on the Google account. The rules and their
// accepted limits are in docs/relay-publish-secret.md. No DOM, no socket: the page owns the socket and the screen,
// and hears from here through env.onCredentials (the pair changed) and env.onStatus (refused or taken changed).
(function (root) {
  'use strict';

  const RELAY_HOST = 'wss://hr-relay.nakauri.workers.dev';
  const KEY = 'hr_monitor_broadcast_key', SECRET = 'hr_monitor_publish_secret';
  // LINK_AT: when this device's link was made (0 for links older than the field); the config carries the same.
  // LINK_MINE: a link made on this device that Drive has not shown back yet; only it may replace an unreadable
  // config, and it carries its secret into Drive at once (no other device knows a room this new).
  // LINK_ACCOUNT: the Drive permissionId the key belongs to, or a login tag while that id is still unknown.
  // LOGIN_TAG: this login's tag (its email, or a random tag when the record has none), kept until sign-out.
  const LINK_AT = 'hr_monitor_link_at', LINK_MINE = 'hr_monitor_link_mine', LINK_ACCOUNT = 'hr_monitor_link_account';
  const LOGIN_TAG = 'hr_monitor_login_tag';
  const CONFIG_NAME = '.hr-monitor-config.json';
  const KEY_RE = /^[0-9a-f]{16}$/, SECRET_RE = /^[0-9a-f]{32}$/;
  const POLL_MS = 60000, QUIET_SYNC_MS = 300000, TAKEN_AFTER_MS = 180000;
  // A sync still running after this is given up (a stalled connection never settles), so the next one can start.
  const SYNC_LIMIT_MS = 60000;

  function create(env) {
    const store = env.storage;
    const now = env.now || (() => Date.now());
    const hex = (n) => Array.from(env.random(n), (b) => b.toString(16).padStart(2, '0')).join('');

    // refused / accepted: the relay's verdict on this device's proof for socketKey, the key the open socket used,
    // so an acceptance never vouches for a key changed since. taken: refused holding the account's own pair.
    // behind: this device wrote a link and Drive has not shown it back. syncedAt: the last sync that finished,
    // so a failed one is retried on the next tick.
    const s = {
      refused: false, refusedAt: 0, accepted: false, taken: false, socketKey: null,
      behind: false, syncedAt: 0,
      loginEmail: null, loginTag: null,
      account: null, poll: null, running: null, again: false, run: 0,
    };

    // A stored key that is not 16 hex characters is replaced: it goes into the socket URL as the room name.
    function key() {
      let k = store.getItem(KEY);
      if (!k || !KEY_RE.test(k)) { k = hex(8); store.setItem(KEY, k); }
      return k;
    }
    function secret() {
      let p = store.getItem(SECRET);
      if (!p || !SECRET_RE.test(p)) { p = hex(16); store.setItem(SECRET, p); }
      return p;
    }
    function linkAt() {
      const n = Number(store.getItem(LINK_AT));
      return Number.isFinite(n) && n > 0 ? n : 0;
    }

    // A fresh room and secret, stamped later than any link time this device has seen, so it outranks the link it
    // replaces whatever the clocks say. Both are made before either is stored, secret first with no removal: a
    // tab reconnects on each change and must never find the new key beside no secret (it would claim the room).
    // acct: the account's id; null, signed in but the id not known yet (bound to this login's tag); undefined,
    // signed out (the last account keeps it).
    function mint(acct) {
      const at = Math.max(now(), linkAt() + 1);
      const k = hex(8), p = hex(16);
      store.setItem(SECRET, p);
      store.setItem(KEY, k);
      store.setItem(LINK_AT, String(at));
      store.setItem(LINK_MINE, k);
      if (acct) store.setItem(LINK_ACCOUNT, acct);
      else if (acct === null && s.loginTag) store.setItem(LINK_ACCOUNT, s.loginTag);
      else if (acct === null) store.removeItem(LINK_ACCOUNT);
      // Waiting on Drive from the click on, so a sync dropped before it writes still leaves the one-minute recheck.
      s.behind = true;
      return k;
    }

    // One request per token, shared by every sync.
    function accountId() {
      const token = env.token();
      if (s.account && s.account.token === token) return s.account.p;
      const entry = { token, p: null, id: null };
      entry.p = (async () => {
        const resp = await env.driveFetch('about?fields=' + encodeURIComponent('user(permissionId)'));
        if (!resp.ok) throw new Error('about ' + resp.status);
        const d = await resp.json();
        const id = (d.user && d.user.permissionId) || '';
        if (!id) throw new Error('about: no account id');
        entry.id = id;
        return id;
      })();
      s.account = entry;
      entry.p.catch(() => { if (s.account === entry) s.account = null; });
      return entry.p;
    }
    function knownAccount() {
      return s.account && s.account.token === env.token() ? s.account.id : null;
    }

    // The login behind the token: its email, or a random tag kept until sign-out when the record has none.
    function setLogin(record) {
      if (!record) { s.loginEmail = null; s.loginTag = null; store.removeItem(LOGIN_TAG); return; }
      if (record.email) { s.loginEmail = record.email; s.loginTag = 'email:' + record.email; }
      else if (!s.loginTag) s.loginTag = store.getItem(LOGIN_TAG) || 'login:' + hex(8);
      store.setItem(LOGIN_TAG, s.loginTag);
    }

    // A failed listing is not "no config": read that way, the write after it replaced a newer link.
    async function findConfig(folder) {
      const q = encodeURIComponent(`'${folder}' in parents and name='${CONFIG_NAME}' and trashed=false`);
      const resp = await env.driveFetch('files?q=' + q + '&fields=files(id,name)');
      if (!resp.ok) throw new Error('config list ' + resp.status);
      const data = await resp.json();
      return data.files && data.files.length ? data.files[0].id : null;
    }
    // Overwrites the config in place with these fields, or creates it, in the folder the sync started in.
    async function writeConfig(existingId, fields, folder) {
      if (!env.token() || !folder) return;
      const id = existingId || await findConfig(folder);
      const body = JSON.stringify(fields);
      let resp;
      if (id) {
        resp = await env.upload('https://www.googleapis.com/upload/drive/v3/files/' + id + '?uploadType=media', {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body,
        });
      } else {
        const boundary = '-------hrm-config-' + hex(6);
        const mpBody =
          `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n` +
          JSON.stringify({ name: CONFIG_NAME, parents: [folder], mimeType: 'application/json' }) +
          `\r\n--${boundary}\r\nContent-Type: application/json\r\n\r\n${body}\r\n--${boundary}--`;
        resp = await env.upload('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart', {
          method: 'POST', headers: { 'Content-Type': 'multipart/related; boundary=' + boundary }, body: mpBody,
        });
      }
      if (!resp.ok) throw new Error('config write ' + resp.status);
    }

    // One sync at a time; a request while one runs is folded into one more run after it, so no two ever
    // interleave their reads and writes in this tab. A run past SYNC_LIMIT_MS is given up: it acts on nothing it
    // reads after that (its run number is stale), and the folded run starts.
    function sync() {
      if (!env.token() || !env.folder()) return Promise.resolve();
      if (s.running) { s.again = true; return s.running; }
      const run = ++s.run;
      let timer = null;
      const limit = new Promise((_, reject) => {
        timer = (env.setTimeout || setTimeout)(() => { if (s.run === run) s.run++; reject(new Error('config sync timed out')); }, env.syncLimitMs || SYNC_LIMIT_MS);
      });
      limit.catch(() => {});
      s.running = Promise.race([runSync(run), limit]).finally(() => {
        (env.clearTimeout || clearTimeout)(timer);
        s.running = null;
        if (s.again) { s.again = false; sync().catch((e) => env.warn('config sync:', e)); }
      });
      return s.running;
    }

    async function runSync(run) {
      // Pinned to the folder and token it started under: if either changed during a Drive call, what it read
      // belongs to another login, so it stops and the next sync starts over.
      const folder = env.folder(), token = env.token();
      const acct = await accountId();
      const id = await findConfig(folder);
      let cfg = null;
      if (id) {
        const resp = await env.driveFetch('files/' + id + '?alt=media');
        if (!resp.ok) throw new Error('config read ' + resp.status);
        // Unparseable content is an unreadable config, not a failed sync.
        try { cfg = JSON.parse(await resp.text()); } catch (e) { cfg = null; }
      }
      if (s.run !== run || env.folder() !== folder || env.token() !== token) return;
      // Read after the awaits: a new link made meanwhile, here or in another tab, is what this sync weighs.
      let k = key(), p = secret(), at = linkAt();
      // A key from before the account field belongs to the first account that syncs it, as it always did; one made
      // before its login's id was known belongs to that login only, and reads as foreign under any other.
      const bound = store.getItem(LINK_ACCOUNT);
      if (!bound || (s.loginTag && bound === s.loginTag)) store.setItem(LINK_ACCOUNT, acct);
      const foreign = store.getItem(LINK_ACCOUNT) !== acct;
      const valid = !!cfg && typeof cfg.broadcastKey === 'string' && KEY_RE.test(cfg.broadcastKey);
      const cfgAt = valid && Number.isFinite(cfg.linkAt) && cfg.linkAt > 0 ? cfg.linkAt : 0;
      // Another account's key, and this account has no readable link: it gets a fresh one of its own, so no key or
      // secret ever crosses accounts.
      if (foreign && !valid) {
        k = mint(acct); p = secret(); at = linkAt();
        env.onCredentials();
      }
      const mine = store.getItem(LINK_MINE) === k;
      // This account's newer link goes back in whichever device made it, so a late write of an older link is put
      // right; an unreadable config is replaced only by a link made here. A config from before link times is only
      // adopted, unless this device just made a link to replace it. The secret goes with it only for a link made
      // here or one the relay accepted from this device.
      const newer = valid && !foreign && cfg.broadcastKey !== k && at > cfgAt && (cfgAt > 0 || mine);
      if (newer || (mine && !valid)) {
        s.behind = true;
        const proven = mine || (s.accepted && s.socketKey === k && !foreign);
        await writeConfig(id, proven ? { broadcastKey: k, publishSecret: p, linkAt: at } : { broadcastKey: k, linkAt: at }, folder);
        s.syncedAt = now();
        return;
      }
      if (!id) {
        // A first config holds the key; the secret joins once the relay accepted it.
        await writeConfig(null, s.accepted && s.socketKey === k ? { broadcastKey: k, publishSecret: p } : { broadcastKey: k }, folder);
        s.syncedAt = now();
        return;
      }
      // Unreadable and not ours to replace: leave it for the device that wrote it.
      if (!valid) { s.syncedAt = now(); return; }
      s.behind = false;
      const keyChanged = k !== cfg.broadcastKey;
      // Drive shows this link: it is the account's now, and later clicks here must outrank its time.
      if (!keyChanged) {
        store.removeItem(LINK_MINE);
        if (cfgAt > at) store.setItem(LINK_AT, String(cfgAt));
      }
      const secretOk = typeof cfg.publishSecret === 'string' && SECRET_RE.test(cfg.publishSecret);
      // Accepted for this key, this device holds the owner's secret: a different one in the config is the stray.
      const owner = s.accepted && s.socketKey === k && !keyChanged && !foreign;
      // For the same key, a different config secret is adopted only once the relay refused this device's: before
      // its verdict this device may be the owner and the config's the stray.
      const secretChanged = secretOk && p !== cfg.publishSecret && (keyChanged || (s.refused && s.socketKey === k));
      // Secret first: another tab reconnects on each change and must never reach the new room with another secret.
      // A key adopted with no secret beside it takes a fresh one, never the secret of the room left behind.
      if (secretChanged) store.setItem(SECRET, cfg.publishSecret);
      else if (keyChanged && !secretOk) { store.removeItem(SECRET); secret(); }
      if (keyChanged) {
        store.setItem(KEY, cfg.broadcastKey);
        store.setItem(LINK_AT, String(cfgAt));
        store.removeItem(LINK_MINE);
      }
      store.setItem(LINK_ACCOUNT, acct);
      // The config takes this device's secret only once the relay accepted it for this very key.
      if (owner && cfg.publishSecret !== p) {
        await writeConfig(id, { broadcastKey: k, publishSecret: p, linkAt: cfgAt }, folder);
        if (s.run !== run) return;
      }
      // Refused while holding the account's own pair, or refused for 3 min with no owner's secret ever appearing in
      // the config: someone else claimed the room first.
      s.taken = s.refused && !keyChanged && !secretChanged && (secretOk || now() - s.refusedAt > TAKEN_AFTER_MS);
      if (s.taken) env.onStatus();
      if (keyChanged || secretChanged) {
        s.refused = false;
        env.onCredentials();
      }
      s.syncedAt = now();
    }

    // Rereads the config every minute while something waits on it, every 5 min otherwise, so a link made elsewhere
    // arrives and a failed write is retried.
    function startPoll() {
      if (s.poll) return;
      s.poll = env.setInterval(() => {
        if (!env.token() || !env.folder()) return;
        const waiting = (s.refused && !s.taken) || s.behind;
        if (waiting || now() - s.syncedAt > QUIET_SYNC_MS) sync().catch((e) => env.warn('config sync:', e));
      }, POLL_MS);
    }

    // The user's "Make a new link": a fresh room and secret, under the account if known, else this login.
    function newLink() {
      mint(env.token() ? knownAccount() : undefined);
      s.refused = false; s.taken = false;
      startPoll();
      sync().catch((e) => env.warn('config write:', e));
    }

    // The page's socket for this key is opening; any verdict it gets is about this key.
    function connecting(k) { s.accepted = false; s.socketKey = k; }
    // The relay's verdict on this device's proof.
    function verdict(type) {
      if (type === 'publisher_accepted') {
        s.accepted = true; s.refused = false; s.taken = false;
      } else if (type === 'publisher_rejected') {
        if (!s.refused) s.refusedAt = now();
        s.refused = true; s.accepted = false;
        startPoll();
      } else return false;
      env.onStatus();
      sync().catch((e) => env.warn('config sync:', e));
      return true;
    }
    // Another tab changed the pair; true when this tab must follow it. A new link removes nothing, but a removal
    // must not reconnect (the tab would mint its own key). A refusal for the old pair says nothing about the new.
    function otherTabChanged(changedKey, newValue) {
      if (changedKey !== KEY && changedKey !== SECRET) return false;
      if (newValue === null) return false;
      s.refused = false; s.refusedAt = 0; s.taken = false;
      return true;
    }
    // Another account signed in over this one: its id is asked afresh.
    function forgetAccount() { s.account = null; }

    return {
      key, secret, linkAt, mint, newLink, sync, startPoll, accountId, setLogin, connecting, verdict,
      otherTabChanged, forgetAccount, findConfig, writeConfig,
      get state() { return s; },
      get loginTag() { return s.loginTag; },
      get loginEmail() { return s.loginEmail; },
    };
  }

  const api = { RELAY_HOST, KEY, SECRET, LINK_AT, LINK_MINE, LINK_ACCOUNT, LOGIN_TAG, CONFIG_NAME, create };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AortiRelayLink = api;
})(typeof self !== 'undefined' ? self : this);
