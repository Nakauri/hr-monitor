/**
 * HR Monitor · WebSocket relay (PartyServer on Cloudflare Workers).
 *
 * Each "room" is a user's broadcast key. Publishers (the live-monitor tab and
 * the native foreground service) send tick / presence messages. Read-only
 * surfaces (OBS overlay, viewer watch-live) subscribe and receive them.
 * Messages live only in memory, and only long enough to fan out; the one
 * stored value per room is the hash of its publisher's proof.
 *
 * The binding is named `Main` so the route is /parties/main/<key>.
 *
 * Deploy: `npx wrangler deploy`
 * Dev:    `npx wrangler dev`
 */
import { routePartykitRequest, Server } from 'partyserver';

// The first publisher to show a proof claims the room: only the proof's hash is
// stored, and later publishers must show the same proof. The overlay link holds
// the key, never the proof. See docs/relay-publish-secret.md.
const OWNER_KEY = 'publisherHash';
const PROOF = /^[0-9a-f]{32}$/;
// A tick carries three chart arrays (45 s of live points plus two 3-min trend
// series) and runs past 12 KB late in a session. The cap exists to drop junk,
// so it must stay well clear of our own wire format. See RELAY_TICK.md.
const MAX_MESSAGE_BYTES = 32768;
const encoder = new TextEncoder();

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

export class Main extends Server {
  // Hibernation keeps idle rooms inside the free plan; fields on `this` do not
  // survive it, so the publisher flag lives on connection state.
  static options = { hibernate: true };

  // PartyServer awaits onConnect before the socket can deliver a message.
  async onConnect(conn, ctx) {
    // /parties/main/<key>?role=publisher&proof=<secret>. Read-only surfaces
    // (overlay, viewer watch-live) connect without either.
    let role = null, proof = null;
    try {
      const url = new URL(ctx.request.url);
      role = url.searchParams.get('role');
      proof = url.searchParams.get('proof');
    } catch (e) { /* malformed URL — treat as subscriber */ }
    if (role !== 'publisher') return;
    // Hash before touching storage: the digest await would open the input gate
    // between the owner read and the claim.
    const hash = proof && PROOF.test(proof) ? await sha256Hex(proof) : null;
    const owner = await this.ctx.storage.get(OWNER_KEY);
    if (!owner && hash) await this.ctx.storage.put(OWNER_KEY, hash);
    // An unclaimed room still takes a proofless publisher (installs older than
    // the proof); the first proof locks them out.
    if (!owner || hash === owner) conn.setState({ publisher: true, proven: !!hash });
    else conn.send(JSON.stringify({ type: 'publisher_rejected' }));
  }

  // PartyServer order is (connection, message).
  async onMessage(sender, message) {
    // Size cap + JSON-only, unconditional. String length counts UTF-16 units,
    // which undercounts non-ASCII, so measure encoded bytes. UTF-16 length is
    // never greater than the byte count, so it screens oversized junk first.
    let size;
    if (typeof message === 'string') {
      if (message.length > MAX_MESSAGE_BYTES) return;
      size = encoder.encode(message).length;
    } else {
      size = message && typeof message.byteLength === 'number' ? message.byteLength : 0;
    }
    if (size > MAX_MESSAGE_BYTES) return;
    let text;
    try { text = typeof message === 'string' ? message : new TextDecoder().decode(message); }
    catch (e) { return; }
    try {
      const parsed = JSON.parse(text);
      if (!parsed || typeof parsed !== 'object') return;
    } catch (e) { return; } // drop non-JSON

    // Subscribers never publish.
    if (!sender.state?.publisher) return;
    // A proofless publisher let in before the room was claimed loses its voice once it is.
    if (!sender.state.proven && await this.ctx.storage.get(OWNER_KEY)) return;

    // Fan out to every OTHER connection in this room (not back to the sender).
    // Room id === broadcast key, so isolation between users is automatic:
    // different keys = different Durable Object instances = can't see each other.
    this.broadcast(message, [sender.id]);
  }
}

export default {
  async fetch(request, env) {
    return (
      (await routePartykitRequest(request, env)) ||
      new Response('Not Found', { status: 404 })
    );
  },
};
