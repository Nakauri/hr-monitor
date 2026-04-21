/**
 * HR Monitor · WebSocket relay (PartyKit / Cloudflare Workers).
 *
 * Each "room" is a user's broadcast key. The live-monitor tab connects as the
 * publisher and sends tick messages. The OBS Browser Source connects as a
 * subscriber and receives them. Zero persistence — messages live only in
 * memory, and only long enough to fan out.
 *
 * Deploy: `npx partykit deploy`
 * Dev:    `npx partykit dev`
 */
export default class HRRelay {
  constructor(room) {
    this.room = room;
  }

  onConnect(conn, ctx) {
    // Optional: include broadcaster/subscriber role in the URL like
    // /parties/main/<key>?role=publisher — useful for future metrics. Today we
    // treat all connections equivalently; messages just go everywhere except
    // back to the sender.
  }

  onMessage(message, sender) {
    // Fan out to every OTHER connection in this room (not back to the sender).
    // Room id === broadcast key, so isolation between users is automatic:
    // different keys = different Durable Object instances = can't see each other.
    this.room.broadcast(message, [sender.id]);
  }

  // Optional: drop a friendly message to new connections so the overlay knows
  // the relay is alive (useful when the publisher hasn't ticked yet).
  async onStart() {}
}
