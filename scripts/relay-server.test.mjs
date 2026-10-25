#!/usr/bin/env node
// relay/src/server.js in node, with the partyserver base class stubbed (no Cloudflare, no deps).
// Guards: a size cap that dropped every real tick (4096 against 10851-byte ticks, 2026-07-05 to
// 08-25, silent, OBS showed nothing); a cap measured in UTF-16 units instead of bytes; non-JSON
// or oversize messages fanned out; a sender getting its own message back; anyone holding the
// overlay link publishing fake heart rate (report card 2026-10-24: the role was self-declared).
// Runtime: under 1 s.
// Live behaviour on Cloudflare is relay/scripts/probe.mjs against wrangler dev or the deployed host.
// Then each mutant below must make a check FAIL.
// Run: node scripts/relay-server.test.mjs
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = fs.readFileSync(path.join(ROOT, 'relay', 'src', 'server.js'), 'utf8').replace(/\r\n/g, '\n');
const IMPORT = "import { routePartykitRequest, Server } from 'partyserver';";
// Durable Object storage stand-in: one map per room, async like the real one.
const STUB = `class Server {
  constructor() {
    this.sent = [];
    const m = new Map();
    this.ctx = { storage: { get: async (k) => m.get(k), put: async (k, v) => { m.set(k, v); } } };
  }
  broadcast(msg, without) { this.sent.push({ msg, without }); }
}
async function routePartykitRequest() { return null; }`;

async function load(src, tag) {
  if (!src.includes(IMPORT)) throw new Error('partyserver import line changed; update the stub');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-' + tag + '-'));
  const file = path.join(dir, 'server.mjs');
  fs.writeFileSync(file, src.replace(IMPORT, STUB));
  try { return await import(pathToFileURL(file).href); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

const P1 = '0123456789abcdef0123456789abcdef';
const P2 = 'fedcba9876543210fedcba9876543210';
function conn(id, query) {
  const c = { id, state: null, got: [], setState(s) { this.state = s; }, send(m) { this.got.push(m); } };
  return { c, ctx: { request: { url: `https://relay.example/parties/main/room${query ? '?' + query : ''}` } } };
}

async function suite(mod) {
  const out = [];
  const check = (name, ok, detail) => out.push([name, !!ok, detail || '']);
  const s = new mod.Main();
  const join = async (id, query) => { const x = conn(id, query); await s.onConnect(x.c, x.ctx); return x.c; };
  const send = async (sender, msg) => { s.sent = []; await s.onMessage(sender, msg); return s.sent; };

  const pub = await join('pub', 'role=publisher&proof=' + P1);
  const sub = await join('sub');
  check('a publisher with a proof is a publisher', pub.state && pub.state.publisher === true);
  check('a publisher whose proof claims the room is told it was accepted', pub.got.some((m) => /publisher_accepted/.test(m)));
  check('a plain connection is not a publisher', !(sub.state && sub.state.publisher));
  const bad = conn('bad'); bad.ctx.request.url = 'not a url';
  let threw = false;
  try { await s.onConnect(bad.c, bad.ctx); } catch (e) { threw = true; }
  check('a malformed connect URL does not throw', !threw);

  // A real tick is about 10851 bytes (livePoints plus two trend arrays).
  const tick = JSON.stringify({ type: 'tick', senderId: 'a', hr: 88, trendHR: Array.from({ length: 900 }, (_, i) => 80 + (i % 9)), trendRmssd: Array.from({ length: 900 }, (_, i) => 30 + (i % 7)), livePoints: 'x'.repeat(5400) });
  const r1 = await send(pub, tick);
  check(`a real-size tick (${tick.length} bytes) is fanned out`, tick.length > 10000 && r1.length === 1, `sent ${r1.length}`);
  check('the sender is excluded from its own fan-out', r1[0] && Array.isArray(r1[0].without) && r1[0].without.includes('pub'));
  check('a tick just under the cap is fanned out', (await send(pub, JSON.stringify({ p: 'x'.repeat(32700) }))).length === 1);
  check('a message over the cap is dropped', (await send(pub, JSON.stringify({ p: 'x'.repeat(33000) }))).length === 0);
  // 12000 three-byte characters: 12000 UTF-16 units but 36000 bytes.
  const wide = JSON.stringify({ p: '€'.repeat(12000) });
  check('the cap counts bytes, not characters (12000 x 3-byte chars dropped)', wide.length < 32768 && (await send(pub, wide)).length === 0);
  check('binary over the cap is dropped', (await send(pub, new Uint8Array(40000))).length === 0);
  check('binary JSON under the cap is fanned out', (await send(pub, new TextEncoder().encode('{"type":"presence"}'))).length === 1);
  check('non-JSON text is dropped', (await send(pub, 'hello')).length === 0);
  check('a JSON primitive is dropped', (await send(pub, '42')).length === 0 && (await send(pub, 'null')).length === 0);

  // The publish proof (docs/relay-publish-secret.md).
  check('a subscriber message is dropped', (await send(sub, '{"type":"tick"}')).length === 0);
  const stored = await s.ctx.storage.get('publisherHash');
  check('the room stores the proof\'s hash, never the proof', typeof stored === 'string' && stored.length === 64 && !stored.includes(P1));
  const same = await join('pub2', 'role=publisher&proof=' + P1);
  check('a second device with the same proof publishes', same.state && same.state.publisher && (await send(same, '{"type":"tick"}')).length === 1);
  const wrong = await join('evil', 'role=publisher&proof=' + P2);
  check('a wrong proof cannot publish', !(wrong.state && wrong.state.publisher) && (await send(wrong, '{"type":"tick"}')).length === 0);
  check('a wrong proof is told it was refused, never accepted', wrong.got.some((m) => /publisher_rejected/.test(m)) && !wrong.got.some((m) => /publisher_accepted/.test(m)));
  check('a second device with the same proof is told it was accepted', same.got.some((m) => /publisher_accepted/.test(m)));
  const bare = await join('bare', 'role=publisher');
  check('role=publisher without a proof cannot publish in a claimed room', (await send(bare, '{"type":"tick"}')).length === 0);
  check('a proof is never fanned out to subscribers', !JSON.stringify(s.sent).includes(P1));

  // An unclaimed room keeps working for installs that send no proof, until a proof claims it.
  const s2 = new mod.Main();
  const legacy = conn('old', 'role=publisher'); await s2.onConnect(legacy.c, legacy.ctx);
  s2.sent = []; await s2.onMessage(legacy.c, '{"type":"tick"}');
  check('an unclaimed room takes a proofless publisher (older installs)', s2.sent.length === 1);
  check('a proofless publisher is never told it was accepted', !legacy.c.got.some((m) => /publisher_accepted/.test(m)));
  check('a proofless publisher does not claim the room', (await s2.ctx.storage.get('publisherHash')) === undefined);
  const owner = conn('new', 'role=publisher&proof=' + P2); await s2.onConnect(owner.c, owner.ctx);
  s2.sent = []; await s2.onMessage(legacy.c, '{"type":"tick"}');
  check('once claimed, the proofless publisher is silenced without reconnecting', s2.sent.length === 0);
  s2.sent = []; await s2.onMessage(owner.c, '{"type":"tick"}');
  check('the claiming publisher publishes', s2.sent.length === 1);
  const junk = conn('junk', 'role=publisher&proof=short'); await s2.onConnect(junk.c, junk.ctx);
  check('a malformed proof is no proof', !(junk.c.state && junk.c.state.publisher));

  check('the fetch handler answers 404 for an unknown path', (await mod.default.fetch(new Request('https://relay.example/nope'), {})).status === 404);
  return out;
}

const MUTANTS = [
  ['cap back to 4096 (the July bug)', 'const MAX_MESSAGE_BYTES = 32768;', 'const MAX_MESSAGE_BYTES = 4096;'],
  ['cap measured in characters', 'size = encoder.encode(message).length;', 'size = message.length;'],
  ['non-JSON fanned out', "    } catch (e) { return; } // drop non-JSON", '    } catch (e) { } // drop non-JSON'],
  ['sender gets its own message', 'this.broadcast(message, [sender.id]);', 'this.broadcast(message, []);'],
  ['subscribers publish again', '    if (!sender.state?.publisher) return;', ''],
  ['any proof accepted', "if (!owner || hash === owner)", "if (true)"],
  ['the raw proof stored', 'await this.ctx.storage.put(OWNER_KEY, hash);', 'await this.ctx.storage.put(OWNER_KEY, proof);'],
  ['proofless publishers kept after the claim', "    if (!sender.state.proven && await this.ctx.storage.get(OWNER_KEY)) return;", ''],
  ['a proofless publisher claims the room', 'if (!owner && hash) await', 'if (!owner) await'],
  ['no refusal notice', "      conn.send(JSON.stringify({ type: 'publisher_rejected' }));", ''],
  ['no acceptance notice', "      if (hash) conn.send(JSON.stringify({ type: 'publisher_accepted' }));", ''],
  ['proofless publishers told accepted', "      if (hash) conn.send(JSON.stringify({ type: 'publisher_accepted' }));", "      conn.send(JSON.stringify({ type: 'publisher_accepted' }));"],
];

let fails = 0;
const realOut = await suite(await load(SRC, 'real'));
const mutantOut = [];
for (const [i, [name, a, b]] of MUTANTS.entries()) {
  let caught = null;
  if (SRC.includes(a)) {
    try { caught = (await suite(await load(SRC.replace(a, b), 'm' + i))).filter(([, ok]) => !ok).map(([n]) => n); }
    catch (e) { caught = ['threw: ' + e.message]; }
  }
  mutantOut.push([name, caught]);
}
for (const [name, ok, detail] of realOut) {
  console.log((ok ? 'OK    ' : 'FAIL  ') + name + (ok || !detail ? '' : '  ' + detail));
  if (!ok) fails++;
}
console.log('\nNegative controls (each must FAIL a check):');
for (const [name, caught] of mutantOut) {
  if (!caught) { console.log(`MISSED ${name}: anchor not found (source changed; update the mutant)`); fails++; continue; }
  console.log((caught.length ? 'MUTANT ' : 'MISSED ') + name + (caught.length ? ': FAILED as required  (' + caught[0] + ')' : ': passed every check'));
  if (!caught.length) fails++;
}
console.log(fails ? `\nrelay-server: ${fails} fail` : '\nrelay-server: all pass');
process.exit(fails ? 1 : 0);
