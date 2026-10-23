// Relay contract check. Usage: node scripts/probe.mjs [wss://host]  (default ws://127.0.0.1:8787)
const host = process.argv[2] || 'ws://127.0.0.1:8787';
const room = 'probe-' + Date.now();
const url = (r, pub) => `${host}/parties/main/${r}${pub ? '?role=publisher' : ''}`;
const open = (u) => new Promise((res, rej) => {
  const s = new WebSocket(u); s.got = [];
  s.onmessage = (m) => s.got.push(String(m.data));
  s.onopen = () => res(s); s.onerror = () => rej(new Error('connect failed: ' + u));
});
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`); };

const pub = await open(url(room, true));
const sub = await open(url(room, false));
const other = await open(url(room + '-other', false));

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

// Subscriber-to-publisher also fans out (old clients without role still broadcast).
sub.send(JSON.stringify({ type: 'from-sub' }));
await wait(800);
check('role-less sender still fans out', pub.got.some((m) => m.includes('from-sub')));

// After a quiet gap the room must still route (hibernation wake path).
await wait(Number(process.env.IDLE_MS || 12000));
pub.send(JSON.stringify({ type: 'after-idle' }));
await wait(1500);
check('fan-out after idle gap', sub.got.some((m) => m.includes('after-idle')));

for (const s of [pub, sub, other]) s.close();
const failed = results.filter((r) => !r).length;
console.log(failed ? `${failed} FAILED` : `all ${results.length} passed`);
process.exit(failed ? 1 : 0);
