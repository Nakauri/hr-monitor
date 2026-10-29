# Relay publish secret

Status: MERGED 2026-10-25 (relay, `relay-link.js`, web monitor, native engine; last relay change 4445f9f). Relay
deploy UNVERIFIED: `wrangler deploy` is manual and no probe has confirmed the live relay checks the proof. The site
and APK work against the old relay too (it ignores the proof).

## The problem it closes

The overlay link carries the room key, and the relay used to let any connection that said `role=publisher`
publish. Anyone who saw a streamer's OBS URL could push fake heart rate onto that overlay and into the monitor's
broadcasters panel.

## The relay: the first proof claims the room

- Publishers connect with `?role=publisher&proof=<secret>`, a random 128-bit secret per account. The overlay
  link never carries it.
- The relay stores the SHA-256 of the first proof it sees for a room (one Durable Object value per room) and
  from then on accepts only publishers showing the same proof.
- It answers every proven publisher with `{"type":"publisher_accepted"}` or `{"type":"publisher_rejected"}`; a
  refused connection stays a subscriber.
- Subscribers never publish. Only the relay sends verdicts: a publisher's message whose `type` starts with
  `publisher_` is dropped.
- An unclaimed room still takes a proofless publisher (installs from before the secret) until a proof claims
  it; then the proofless one is silenced and told `publisher_rejected`.
- The monitor connects with the proof on every load, sharing on or off, so opening it once claims the room.

## The account's link: `relay-link.js`

One module keeps the key, the secret and their copy in the account's Drive config (`.hr-monitor-config.json`,
`{ broadcastKey, publishSecret, linkAt }`). It is the only writer of these values; the page owns the socket and
the screen and tells the module what the socket does. The relay's address lives here once.

State in localStorage: `hr_monitor_broadcast_key`, `hr_monitor_publish_secret`, `hr_monitor_link_at` (when this
device's link was made), `hr_monitor_link_mine` (a link made here that Drive has not shown back),
`hr_monitor_link_account` (the Drive permissionId the key belongs to, or a login tag while that is unknown) and
`hr_monitor_login_tag` (this login's tag, kept until sign-out).

**One sync at a time.** A request while a sync runs is folded into one more run after it. A sync still running
after 60 s is given up (a stalled connection never settles): it acts on nothing it reads after that, and the
folded run starts. Each sync is pinned to
the folder and token it started under and stops without writing if either changes during a Drive call. The
device's own values are read after Drive answers, so a click partway through a sync is what it weighs.

**When the device and the config hold different keys of the same account:**
- The newer link wins: the device writes its own back, or adopts the config's key, time and secret.
- A config with no link time (an older build) is only adopted, unless this device just made a link.
- A restored link carries its secret only when it was made here or the relay accepted this device for it;
  otherwise the key and time alone.

**When the keys match:**
- The accepted owner repairs a different secret in the config; a device the relay refused for that key adopts
  the config's. Before the verdict, neither happens.
- A config with no secret takes the secret only from the device the relay accepted for that key.

**Writes and reads that fail:**
- A failed listing or read fails the sync; it never reads as "no config". A failed write throws.
- An unparseable config is unreadable: a link made here replaces it, anything else leaves it alone.
- The config is reread every minute while refused or while Drive has not shown back a link this device wrote,
  and every 5 minutes otherwise.

**Accounts and logins:**
- A key from another account is never written, owned or seeded under this one. That account's link is adopted,
  or, when it has no readable config, a fresh link of its own is made.
- A key from before the account field binds to the first account that syncs it.
- A click before the account's id is known binds to this login's tag (its email, or a random tag kept until
  sign-out), so only this login's sync claims it. A click signed out keeps the last account.
- Another account signing in over this one drops the old account's folder and account id; the id is asked once
  per token. The folder lookup is pinned to the login.

**A new link** (Make a new link) is a fresh key and secret, both made before either is stored and stored secret
first, stamped later than any link time this device has seen (so it outranks the link it replaces whatever the
clocks say). It goes into the config at once with its secret: no other device knows a room this new. The engine
and this tab's socket follow.

**Other tabs** follow a changed key or secret through the `storage` event, ignoring removals, and drop their old
refusal; the socket they open gets its own verdict.

**Taken:** refused while holding the config's own pair, or refused for 3 minutes with no owner's secret in the
config, means someone else claimed the room. The monitor shows "Another device holds this link" with **Make a
new link**.

**The viewer** only reads. Watch live uses the monitor's key on this browser, else the account's key from the
config kept in the viewer's own slot (`hr_viewer_watch_key`, cleared when the account has no config). The
settings sync never maps the key.

## Native

- The engine takes new credentials mid-session through `setRelayCredentials` (shim, plugin, engine): key and
  secret saved in one `.commit()`, socket reopened. It refuses an empty or malformed secret.
- The page pushes them after a resume and at bootstrap with a live session; prefs from an APK before the secret
  have none.
- The engine reads a verdict by its exact `type` and reports `relayRefused` in its status; the shim copies it into
  its snapshot, so the monitor shows `blocked` instead of `live` while nothing reaches the overlay.
- The engine always sends a `proof` field, empty with no secret yet. In a claimed room the relay closes (code 4001)
  only a publisher with no `proof` field at all: a build older than the proof, which ignores verdicts and would
  otherwise show live. Its reconnect loop then shows connecting. Every refused current build stays open.
- The socket plugin redacts `proof=` from every log line, rejection and status field.

## Accepted limits

- Someone who holds a key and connects with their own proof before the owner's updated install claims that
  room. The way out is a new link, then pasting the new OBS link.
- Anyone the user shares their Drive folder with can read the config and publish.
- The proof travels in the WebSocket query string; only the Cloudflare account owner sees request URLs, and the
  relay logs none. Every claimed room keeps one stored hash, with no expiry.
- Signing out keeps the secret (a signed-out monitor still broadcasts to its own room); a new link retires it.
- Two accounts an older build already pointed at one room keep sharing it until either makes a new link.
- This device holds one link at a time: switching account before a new link reached Drive loses that link here.
- Link times come from device clocks: two devices making new links in the same stretch rank by their clocks.
- Drive has no conditional write for media updates; two devices writing at once is last-writer-wins, and the
  device holding the newer link writes it back on its next sync.
- A record with no email can blur logins: an account whose email changes, or whose record gains one, between a
  click and its first sync loses that click; an email-less login over another with no sign-out between keeps
  the earlier tag. Both sign-in paths fill the email in.
- Diagnostics' Purge clears the credentials; the account adopts its config again, but a new link Drive had not
  taken yet is gone.
- The viewer keeps its folder when another account signs in over this one without a sign-out; it only reads,
  so Watch live falls back to the monitor's key.

## Checks

- `scripts/relay-server.test.mjs`: claim, verdicts, same, wrong and missing proofs, subscribers in claimed and
  unclaimed rooms, forged verdicts, the silenced proofless publisher told, hash never the proof; a mutant each.
- `relay/scripts/probe.mjs`: the same contract against `wrangler dev` or the deployed host, including the claim
  surviving hibernation.
- `scripts/relay-link.test.cjs`: the module run against a fake Drive, every rule above as a case (two devices,
  failed and slow writes, a sync held across the click, late older writes, clocks, account switches, logins,
  unreadable and older configs, verdict timing, one sync at a time), the page wiring, the viewer, and one relay
  address; a mutant each.
- `scripts/engine-boundary.test.cjs` (reads the Java as text): the native credential, verdict, redaction and
  reconnect rules.
