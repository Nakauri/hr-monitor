#!/usr/bin/env node
// relay/src/server.js in node, with the partyserver base class stubbed (no Cloudflare, no deps).
// Guards: a size cap that dropped every real tick (4096 against 10851-byte ticks, 2026-07-05 to
// 08-25, silent, OBS showed nothing); a cap measured in UTF-16 units instead of bytes; non-JSON
// or oversize messages fanned out; a sender getting its own message back. Runtime: under 1 s.
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
const STUB = `class Server {
  constructor() { this.sent = []; }
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

function conn(id, role) {
  const c = { id, state: null, setState(s) { this.state = s; } };
  return { c, ctx: { request: { url: `https://relay.example/parties/main/room${role ? '?role=' + role : ''}` } } };
}

async function suite(mod) {
  const out = [];
  const check = (name, ok, detail) => out.push([name, !!ok, detail || '']);
  const s = new mod.Main();
  const pub = conn('pub', 'publisher'), sub = conn('sub');
  s.onConnect(pub.c, pub.ctx);
  s.onConnect(sub.c, sub.ctx);
  check('a role=publisher connection is marked publisher', pub.c.state && pub.c.state.publisher === true);
  check('a plain connection is not a publisher', !(sub.c.state && sub.c.state.publisher));
  const bad = conn('bad'); bad.ctx.request.url = 'not a url';
  let threw = false;
  try { s.onConnect(bad.c, bad.ctx); } catch (e) { threw = true; }
  check('a malformed connect URL does not throw', !threw);

  const send = (sender, msg) => { s.sent = []; s.onMessage(sender, msg); return s.sent; };
  // A real tick is about 10851 bytes (livePoints plus two trend arrays).
  const tick = JSON.stringify({ type: 'tick', senderId: 'a', hr: 88, trendHR: Array.from({ length: 900 }, (_, i) => 80 + (i % 9)), trendRmssd: Array.from({ length: 900 }, (_, i) => 30 + (i % 7)), livePoints: 'x'.repeat(5400) });
  const r1 = send(pub.c, tick);
  check(`a real-size tick (${tick.length} bytes) is fanned out`, tick.length > 10000 && r1.length === 1, `sent ${r1.length}`);
  check('the sender is excluded from its own fan-out', r1[0] && Array.isArray(r1[0].without) && r1[0].without.includes('pub'));
  check('a tick just under the cap is fanned out', send(pub.c, JSON.stringify({ p: 'x'.repeat(32700) })).length === 1);
  check('a message over the cap is dropped', send(pub.c, JSON.stringify({ p: 'x'.repeat(33000) })).length === 0);
  // 12000 three-byte characters: 12000 UTF-16 units but 36000 bytes.
  const wide = JSON.stringify({ p: '€'.repeat(12000) });
  check('the cap counts bytes, not characters (12000 x 3-byte chars dropped)', wide.length < 32768 && send(pub.c, wide).length === 0);
  check('binary over the cap is dropped', send(pub.c, new Uint8Array(40000)).length === 0);
  check('binary JSON under the cap is fanned out', send(pub.c, new TextEncoder().encode('{"type":"presence"}')).length === 1);
  check('non-JSON text is dropped', send(pub.c, 'hello').length === 0);
  check('a JSON primitive is dropped', send(pub.c, '42').length === 0 && send(pub.c, 'null').length === 0);
  // Recorded decision 2026-07-05: the publisher role is log-only until a real publisher secret exists.
  const r2 = send(sub.c, '{"type":"tick"}');
  check('a subscriber message is still fanned out (role is log-only by decision)', r2.length === 1);
  check('the fetch handler answers 404 for an unknown path', (await mod.default.fetch(new Request('https://relay.example/nope'), {})).status === 404);
  return out;
}

const MUTANTS = [
  ['cap back to 4096 (the July bug)', 'const MAX_MESSAGE_BYTES = 32768;', 'const MAX_MESSAGE_BYTES = 4096;'],
  ['cap measured in characters', 'size = encoder.encode(message).length;', 'size = message.length;'],
  ['non-JSON fanned out', "    } catch (e) { return; } // drop non-JSON", '    } catch (e) { } // drop non-JSON'],
  ['sender gets its own message', 'this.broadcast(message, [sender.id]);', 'this.broadcast(message, []);'],
  ['publisher role never set', "conn.setState({ publisher: true });", '/* no role */'],
];

let fails = 0;
const say = console.log;
console.log = () => {}; // the relay logs every non-publisher message
const realOut = await suite(await load(SRC, 'real'));
const mutantOut = [];
for (const [i, [name, a, b]] of MUTANTS.entries()) {
  mutantOut.push([name, SRC.includes(a) ? (await suite(await load(SRC.replace(a, b), 'm' + i))).filter(([, ok]) => !ok).map(([n]) => n) : null]);
}
console.log = say;
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
