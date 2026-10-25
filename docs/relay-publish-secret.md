# Relay publish secret

Status: BUILT 2026-10-24 on branch grade-a (relay, web monitor, native engine). Live once the relay is
deployed; the site and APK work against the old relay too (it ignores the proof).

## The problem it closes

The overlay link carries the room key, and the relay used to let any connection that said `role=publisher`
publish. Anyone who saw a streamer's OBS URL could push fake heart rate onto that overlay and into the
monitor's broadcasters panel.

## How it works: the first proof claims the room

- Each account keeps a random 128-bit **publish secret** (`hr_monitor_publish_secret` in localStorage; native
  keeps it in the session prefs, saved in the same `.commit()` as the key).
- Publishers connect with `?role=publisher&proof=<secret>`. The overlay link never carries the secret.
- The relay stores the SHA-256 of the first proof it sees for a room (Durable Object storage, one value per
  room) and from then on accepts only publishers showing the same proof. A wrong proof connects as a
  subscriber and is sent `{"type":"publisher_rejected"}`.
- Subscribers never publish: their messages are dropped.
- An unclaimed room still takes a proofless publisher, so installs from before the secret keep working until
  an updated one claims the room; from then on the proofless one is silenced.

## Every device on the account shares the secret

The broadcast key already syncs through `.hr-monitor-config.json` in the user's Drive folder; the secret
rides in the same file (`{ broadcastKey, publishSecret }`):

- A device adopts the config's pair. A config from before the secret gets this device's secret written in.
- A new link (`regenerateBroadcastKey`) writes the config too, so a later sync does not bring the old key back.
- A refused device shows the relay status `blocked` and rereads the config.

## Accepted limits

- Someone who already holds a key and connects with their own proof before the owner's updated install does
  claims that room. The fix is a new link, which makes a fresh, unclaimed room.
- Two devices that both upgrade before either has synced can race to write the config secret; the loser
  is refused until it rereads the config.

## Checks

- `scripts/relay-server.test.mjs`: claim, same proof, wrong proof, proofless, hash never the proof, with a
  mutant for each.
- `relay/scripts/probe.mjs`: the same contract against `wrangler dev` or the deployed host, including the
  claim surviving hibernation.
- `scripts/marks-store.test.cjs` K1: the Drive config carries, adopts and writes back the secret.
- `scripts/engine-boundary.test.cjs`: native saves the secret with the key and never logs it.
