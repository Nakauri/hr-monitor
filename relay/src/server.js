/**
 * HR Monitor · WebSocket relay (PartyKit / Cloudflare Workers).
 *
 * Each "room" is a user's broadcast key. Publishers (the live-monitor tab and
 * the native foreground service) send tick / presence messages. Read-only
 * surfaces (OBS overlay, viewer watch-live) subscribe and receive them. Zero
 * persistence — messages live only in memory, and only long enough to fan out.
 *
 * Deploy: `npx partykit deploy`
 * Dev:    `npx partykit dev`
 */

// Flip to true only after the role-tagged APK has shipped and old installs are
// retired. Until then non-publisher messages are logged, not dropped, so old
// clients that don't send role=publisher keep broadcasting.
const ENFORCE_PUBLISHER_ROLE = false;
// Inbound messages are tiny JSON ticks; anything larger is junk. Enforced
// regardless of the role flag.
const MAX_MESSAGE_BYTES = 4096;

export default class HRRelay {
  constructor(room) {
    this.room = room;
    // Connection ids that declared role=publisher in their URL.
    this.publishers = new Set();
  }

  onConnect(conn, ctx) {
    // Role comes from the connection URL: /parties/main/<key>?role=publisher.
    // Read-only surfaces (overlay, viewer watch-live) connect without it.
    try {
      const url = new URL(ctx.request.url);
      if (url.searchParams.get('role') === 'publisher') {
        this.publishers.add(conn.id);
      }
    } catch (e) { /* malformed URL — treat as subscriber */ }
  }

  onClose(conn) {
    this.publishers.delete(conn.id);
  }

  onMessage(message, sender) {
    // Size cap + JSON-only, unconditional.
    const size = typeof message === 'string'
      ? message.length
      : (message && typeof message.byteLength === 'number' ? message.byteLength : 0);
    if (size > MAX_MESSAGE_BYTES) return;
    let text;
    try { text = typeof message === 'string' ? message : new TextDecoder().decode(message); }
    catch (e) { return; }
    try {
      const parsed = JSON.parse(text);
      if (!parsed || typeof parsed !== 'object') return;
    } catch (e) { return; } // drop non-JSON

    // Role enforcement (flagged). When off, log the would-be-drop only.
    if (!this.publishers.has(sender.id)) {
      if (ENFORCE_PUBLISHER_ROLE) return;
      console.log('[relay] non-publisher message (log-only):', sender.id);
    }

    // Fan out to every OTHER connection in this room (not back to the sender).
    // Room id === broadcast key, so isolation between users is automatic:
    // different keys = different Durable Object instances = can't see each other.
    this.room.broadcast(message, [sender.id]);
  }

  async onStart() {}
}
