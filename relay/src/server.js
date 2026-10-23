/**
 * HR Monitor · WebSocket relay (PartyServer on Cloudflare Workers).
 *
 * Each "room" is a user's broadcast key. Publishers (the live-monitor tab and
 * the native foreground service) send tick / presence messages. Read-only
 * surfaces (OBS overlay, viewer watch-live) subscribe and receive them. Zero
 * persistence — messages live only in memory, and only long enough to fan out.
 *
 * The binding is named `Main` so the route is /parties/main/<key>.
 *
 * Deploy: `npx wrangler deploy`
 * Dev:    `npx wrangler dev`
 */
import { routePartykitRequest, Server } from 'partyserver';

// Flip to true only after the role-tagged APK has shipped and old installs are
// retired. Until then non-publisher messages are logged, not dropped, so old
// clients that don't send role=publisher keep broadcasting.
const ENFORCE_PUBLISHER_ROLE = false;
// A tick carries three chart arrays (45 s of live points plus two 3-min trend
// series) and runs past 12 KB late in a session. The cap exists to drop junk,
// so it must stay well clear of our own wire format. See RELAY_TICK.md.
const MAX_MESSAGE_BYTES = 32768;
const encoder = new TextEncoder();

export class Main extends Server {
  // Hibernation keeps idle rooms inside the free plan; fields on `this` do not
  // survive it, so the publisher flag lives on connection state.
  static options = { hibernate: true };

  onConnect(conn, ctx) {
    // Role comes from the connection URL: /parties/main/<key>?role=publisher.
    // Read-only surfaces (overlay, viewer watch-live) connect without it.
    try {
      const url = new URL(ctx.request.url);
      if (url.searchParams.get('role') === 'publisher') {
        conn.setState({ publisher: true });
      }
    } catch (e) { /* malformed URL — treat as subscriber */ }
  }

  // PartyServer order is (connection, message).
  onMessage(sender, message) {
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

    // Role enforcement (flagged). When off, log the would-be-drop only.
    if (!sender.state?.publisher) {
      if (ENFORCE_PUBLISHER_ROLE) return;
      console.log('[relay] non-publisher message (log-only):', sender.id);
    }

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
