# Relay publish secret

Status: BUILT 2026-10-24 on branch grade-a (relay, web monitor, native engine), revised after review rounds 1 and 2.
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
- The config is reread every minute while refused or while a new link waits for Drive, and every 5 minutes
  otherwise, so a new link made on another device arrives and a failed write is retried.
- Refused while holding the config's own pair, or refused for 3 minutes with no owner's secret appearing,
  means someone else claimed the room: the monitor shows "Another device holds this link" with a
  **Make a new link** button.
- A new link (`regenerateBroadcastKey`) mints a fresh key and a fresh secret, hands both to the native engine,
  and marks them pending (`hr_monitor_config_pending`). While pending, a sync writes the pair instead of
  reading the config, and the viewer leaves the key alone; the flag clears only once Drive has it. (Review
  round 2: an acceptance sync could read the old key back before the write landed, or after it failed.)
- A failed config write throws instead of passing silently.

## Native

- The engine takes new credentials mid-session through `setRelayCredentials` (shim, plugin, engine), which
  saves key and secret in one `.commit()` and reopens the socket. It refuses an empty or malformed secret.
- The socket plugin redacts `proof=` from every log line, error and status field.
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
- Until the new relay is deployed, the old one forwards anything, verdicts included; deploy the relay with
  the site.

## Checks

- `scripts/relay-server.test.mjs`: claim, accept and reject notices, same proof, wrong proof, proofless,
  hash never the proof, forged verdicts, the silenced proofless publisher told, with a mutant for each.
- `relay/scripts/probe.mjs`: the same contract against `wrangler dev` or the deployed host, including the
  claim surviving hibernation.
- `scripts/marks-store.test.cjs` K1: no write before acceptance, the two-device race, taken detection, new
  link to Drive and engine with a fresh secret, the pending link through a failed or lagging write and a
  sign-in, the owner repairing a stray secret, retried writes, failed writes.
- `scripts/engine-boundary.test.cjs`: native saves the secret with the key, refuses an empty one, reads the
  verdict, reports it, and no native log line or status field carries the relay URL unredacted.
