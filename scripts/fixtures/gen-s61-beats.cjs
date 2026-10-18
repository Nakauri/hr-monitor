// Writes scripts/fixtures/s61-beats.json: about 40 min of synthetic strap packets (seeded, no health data) for
// scripts/junk-parity.test.cjs. Holds clean runs, short-long pairs at long ratios 0.15 to 0.30, beats under 250 and
// over 2500 ms, off-byte beats, a gap over 10 s, HR 0 packets, a pending short beat followed by an HR 0 packet, and two
// packets inside one second. Usage: node scripts/fixtures/gen-s61-beats.cjs
const fs = require('fs'), path = require('path');
let seed = 61;
const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
const t0 = Date.UTC(2026, 9, 20, 18, 0, 0);
const packets = [];
let t = t0;
const add = (hr, rr, dt) => { packets.push({ ep: t, hr, rr: rr.map(Math.round) }); t += dt == null ? 1000 : dt; };
const clean = (secs, hr) => { for (let i = 0; i < secs; i++) { const base = 60000 / hr; add(hr, i % 4 === 3 ? [] : [base + (rnd() - 0.5) * 40]); } };
clean(300, 75);
// Short-long pairs: a short beat 45% under the HR byte's beat, then a long one at ratio 0.15 to 0.30.
for (let i = 0; i < 300; i++) {
  const base = 60000 / 72;
  if (i % 5 === 0) { const long = i % 25 === 0 ? 0.28 : 0.16 + (i % 9) / 100; add(72, [base * 0.55, base * (1 + long)]); }
  else if (i % 17 === 0) add(72, [base * 0.62, base * 1.1]);
  else add(72, [base + (rnd() - 0.5) * 30]);
}
// Out-of-range beats sprinkled into a clean run.
for (let i = 0; i < 240; i++) { const base = 60000 / 80; add(80, i % 3 === 0 ? [rnd() < 0.5 ? 180 + rnd() * 60 : 2600 + rnd() * 400] : [base]); }
// Off-byte: the HR byte reads 121 while the beats run near 75.
for (let i = 0; i < 200; i++) add(121, i % 5 === 4 ? [500, 495] : [790 + (rnd() - 0.5) * 40]);
clean(120, 78);
t += 15000; // a gap over 10 s
clean(200, 76);
// HR 0 packets inside a run.
for (let i = 0; i < 20; i++) add(0, []);
clean(100, 76);
// A pending short beat, then an HR 0 packet, then the long beat.
{ const base = 60000 / 74; add(74, [base, base * 0.66]); add(0, []); add(74, [base * 1.25]); }
// Two packets inside one second.
for (let i = 0; i < 30; i++) { const base = 60000 / 74; add(74, [base], 400); add(74, [base * 0.6], 600); }
// Mixed tail: bursts of off-byte beats inside clean runs.
for (let i = 0; i < 600; i++) { const off = Math.floor(i / 60) % 3 === 1; add(off ? 118 : 70, [off && i % 2 ? 1250 : 857 + (rnd() - 0.5) * 30]); }
const out = path.join(__dirname, 's61-beats.json');
fs.writeFileSync(out, JSON.stringify({ note: 'Synthetic strap packets for junk-parity.test.cjs; written by gen-s61-beats.cjs, seed 61.', packets }) + '\n');
console.log('wrote', out, packets.length, 'packets,', Math.round((t - t0) / 60000), 'min');
