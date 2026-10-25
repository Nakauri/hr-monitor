# Relay publish secret

Status: BUILT 2026-10-24 on branch grade-a (relay, web monitor, native engine), revised after review rounds 1 to 3.
Live once the relay is deployed; the site and APK work against the old relay too (it ignores the proof).

## The problem it closes

The overlay link carries the room key, and the relay used to let any connection that said `role=publisher`
publish. Anyone who saw a streamer's OBS URL could push fake heart rate onto that overlay and into the
monitor's broadcasters panel.

## How it works: the first proof claims the room

- Each account keeps a random 128-bit **publish secret** (`hr_monitor_publish_secret` in localStorage; native
  keeps it in the session prefs, saved in the same `.commit()` as the key).
- Publishers connect with `?role=publisher&proof=<secret>`. The overlay link never carries the secret.
- The relay stores the SHA-256 of the first proof it sees for a room (Durable Object storage, one value per
  room) and from then on accepts only publishers showing the same proof.
- The relay answers every proven publisher: `{"type":"publisher_accepted"}` when the proof claims or matches
  the room, `{"type":"publisher_rejected"}` when it does not. A refused connection stays as a subscriber.
- Subscribers never publish: their messages are dropped.
- Only the relay sends verdicts: a publisher's message whose `type` starts with `publisher_` is dropped, so no
  peer can fake "refused" or "accepted".
- An unclaimed room still takes a proofless publisher, so installs from before the secret keep working until
  an updated one claims the room; from then on the proofless one is silenced and told `publisher_rejected`.
- Opening the updated monitor once claims the room: `connectRelay()` runs with the proof on every load,
  sharing on or off.

## Every device on the account shares the secret

The broadcast key already syncs through `.hr-monitor-config.json` in the user's Drive folder; the secret
rides in the same file (`{ broadcastKey, publishSecret }`). The rules keep the config's secret equal to the
room owner's:

- A device adopts the config's key and secret, reconnects, and hands both to a running native session.
- A config's secret is written only by a device the relay sent `publisher_accepted` for that same key. That
  device holds the owner's secret, so it fills in a config with none and repairs a different one, and never
  adopts it. (Review round 1: writing on first sync let two devices upgrading together lock the account out.)
- A new config holds only the key until the relay accepts this device.
- Each link carries when it was made (`linkAt`, in the config and in `hr_monitor_link_at`; 0 for links older
  than the field). A link made on this device is marked (`hr_monitor_link_mine`) until Drive shows it back.
  Only a marked link is ever written over the config, and only over an older or unreadable one; every other
  difference adopts the config's. The device's values are read after Drive answers, so a sync already under
  way when the user makes a new link weighs the new one. (Review rounds 2 to 4: an acceptance sync, or one in
  flight across the click, read the old key back; a waiting link overwrote a newer one made elsewhere; "newer"
  without "made here" let a viewer-adopted key or another account's config be overwritten.)
- A click is stamped later than any link time this device has seen, and a matching config raises the
  device's time to the config's, so a click always outranks the link it replaces, whatever the clocks say.
- Each key belongs to one Google account (`hr_monitor_link_account`, Drive's permissionId; a key from before
  the field binds to the first account that syncs it). Under any other account, however the account changed
  (sign-out, an expired login, a re-sign-in as someone else), the device adopts that account's link, or makes
  that account a fresh link of its own when it has none; it never writes, owns or seeds the other account's
  key or secret. Signing back into the same account keeps a link Drive had not taken yet. (Review round 5.)
- Key and secret are stored secret first, so another tab that reconnects on each change never reaches a new
  room holding a different secret.
- An unparseable config counts as unreadable: a marked link replaces it, anything else leaves it alone.
- The relay acceptance only vouches for the key the socket connected with (`relayKey`).
- The config is reread every minute while refused or until Drive shows back a link this device wrote, and
  every 5 minutes otherwise, so a new link made on another device arrives and a failed write is retried.
- Another tab of the monitor follows a new key or secret through the `storage` event, ignoring the removal
  half of a new link.
- Refused while holding the config's own pair, or refused for 3 minutes with no owner's secret appearing,
  means someone else claimed the room: the monitor shows "Another device holds this link" with a
  **Make a new link** button.
- A new link (`regenerateBroadcastKey`) mints a fresh key, a fresh secret and its time, and hands the pair
  to the native engine. Its secret goes into the config at once: no other device knows a room this new.
- The viewer shares the monitor's storage and follows the same rule: it keeps a newer link made here, and
  adopts a key together with its secret.
- A failed config write throws instead of passing silently.

## Native

- The engine takes new credentials mid-session through `setRelayCredentials` (shim, plugin, engine), which
  saves key and secret in one `.commit()` and reopens the socket. It refuses an empty or malformed secret.
- The socket plugin redacts `proof=` from every log line, error and status field.
- The engine reads a verdict by its exact `type`, as the page does.
- The page pushes them after a resume and at bootstrap with a live session: prefs written by an APK from
  before the secret have none.
- The engine reads the relay's verdict and reports `relayRefused` in its snapshot, so the monitor shows
  `blocked` instead of `live` while nothing reaches the overlay.

## Accepted limits

- Someone who already holds a key and connects with their own proof before the owner's updated install does
  claims that room. The way out is a new link, which makes a fresh, unclaimed room, then pasting the new OBS
  link.
- Anyone the user shares their Drive folder with can read the config and publish.
- The proof travels in the WebSocket query string; only the Cloudflare account owner can see request URLs,
  and the relay logs none.
- Every claimed room keeps one stored hash, with no expiry.
- Signing out keeps the secret, because a signed-out monitor still broadcasts to its own room; a new link
  is the way to retire a secret.
- Two accounts an older build already pointed at one room keep sharing it until either makes a new link.
- Until the new relay is deployed, the old one forwards anything, verdicts included; deploy the relay with
  the site.
- Link times come from device clocks. A click always outranks the link it replaced, but two devices making
  new links within the same stretch rank by their clocks.
- Drive has no conditional write for media updates, so two devices writing at once is last-writer-wins; the
  maker's one-minute recheck puts its link back.

## Checks

- `scripts/relay-server.test.mjs`: claim, accept and reject notices, same proof, wrong proof, proofless,
  hash never the proof, forged verdicts, the silenced proofless publisher told, with a mutant for each.
- `relay/scripts/probe.mjs`: the same contract against `wrangler dev` or the deployed host, including the
  claim surviving hibernation.
- `scripts/marks-store.test.cjs` K1: no write before acceptance, the two-device race, taken detection, new
  link to Drive and engine with a fresh secret and its time, a new link through a failed write, a sync held
  in flight across the click, an older write landing late, a sign-in, a newer link from another device, a
  clock running ahead, account switches (sign-out, new login, a new account with no config, a shared room,
  back to the same account), a key the viewer adopted, unreadable configs, a stale acceptance, the
  owner repairing a stray secret, retried writes, failed writes, and the viewer run for real.
- `scripts/engine-boundary.test.cjs` (reads the Java as text): native saves the secret with the key, refuses
  an empty one, reads the verdict by exact type, reports it, and no native log line, rejection or status
  field carries the relay URL unredacted.
