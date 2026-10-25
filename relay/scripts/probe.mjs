// Relay contract check. Usage: node scripts/probe.mjs [wss://host]  (default ws://127.0.0.1:8787)
const host = process.argv[2] || 'ws://127.0.0.1:8787';
const room = 'probe-' + Date.now();
// A publisher shows a proof; the first proof claims the room (docs/relay-publish-secret.md).
const PROOF = [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join('');
const WRONG = 'f'.repeat(32);
const url = (r, proof) => `${host}/parties/main/${r}${proof ? '?role=publisher&proof=' + proof : ''}`;
const open = (u) => new Promise((res, rej) => {
  const s = new WebSocket(u); s.got = [];
  s.onmessage = (m) => s.got.push(String(m.data));
  s.onopen = () => res(s); s.onerror = () => rej(new Error('connect failed: ' + u));
});
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`); };

const pub = await open(url(room, PROOF));
const sub = await open(url(room));
const other = await open(url(room + '-other'));

const tick = JSON.stringify({ type: 'tick', senderId: 'probe', pad: 'x'.repeat(11000) });
pub.send(JSON.stringify({ type: 'presence', senderId: 'probe' }));
pub.send(tick);
pub.send('not json');
pub.send(JSON.stringify({ type: 'big', pad: 'x'.repeat(40000) }));
pub.send(JSON.stringify({ type: 'multibyte', pad: 'é'.repeat(17000) })); // 34000 bytes, 17000 chars
await wait(1500);

check('subscriber gets presence', sub.got.some((m) => m.includes('"presence"')));
check('subscriber gets 11 KB tick', sub.got.some((m) => m.length === tick.length), `bytes=${tick.length}`);
check('non-JSON dropped', !sub.got.includes('not json'));
check('40 KB message dropped', !sub.got.some((m) => m.includes('"big"')));
check('34000-byte multibyte message dropped', !sub.got.some((m) => m.includes('"multibyte"')));
check('no echo to sender', pub.got.length === 0, `sender got ${pub.got.length}`);
check('other room isolated', other.got.length === 0, `other got ${other.got.length}`);

sub.send(JSON.stringify({ type: 'from-sub' }));
await wait(800);
check('a subscriber message is dropped', !pub.got.some((m) => m.includes('from-sub')));
const evil = await open(url(room, WRONG));
const bare = await open(`${host}/parties/main/${room}?role=publisher`);
await wait(500);
check('a wrong proof is told it was refused', evil.got.some((m) => m.includes('publisher_rejected')));
evil.send(JSON.stringify({ type: 'from-evil' }));
bare.send(JSON.stringify({ type: 'from-bare' }));
await wait(800);
check('a wrong proof cannot publish', !sub.got.some((m) => m.includes('from-evil')));
check('a proofless publisher cannot publish in a claimed room', !sub.got.some((m) => m.includes('from-bare')));
evil.close(); bare.close();

// After a quiet gap the room must still route (hibernation wake path).
await wait(Number(process.env.IDLE_MS || 12000));
pub.send(JSON.stringify({ type: 'after-idle' }));
await wait(1500);
check('fan-out after idle gap', sub.got.some((m) => m.includes('after-idle')));
// The claim lives in storage, so it outlasts hibernation and a fresh connection.
const again = await open(url(room, PROOF));
const late = await open(url(room, WRONG));
await wait(500);
again.send(JSON.stringify({ type: 'owner-again' }));
late.send(JSON.stringify({ type: 'late-evil' }));
await wait(1000);
check('the owner publishes again after the idle gap', sub.got.some((m) => m.includes('owner-again')));
check('a wrong proof is still refused after the idle gap', !sub.got.some((m) => m.includes('late-evil')) && late.got.some((m) => m.includes('publisher_rejected')));
again.close(); late.close();

for (const s of [pub, sub, other]) s.close();
const failed = results.filter((r) => !r).length;
console.log(failed ? `${failed} FAILED` : `all ${results.length} passed`);
process.exit(failed ? 1 : 0);
