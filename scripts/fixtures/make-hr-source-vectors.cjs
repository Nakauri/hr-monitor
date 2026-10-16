// Writes scripts/fixtures/hr-source-vectors.txt from formulas (synthetic; no recorded rows).
// Shapes and assertions: S54 spec section 8a. Run: node scripts/fixtures/make-hr-source-vectors.cjs
const fs = require('fs');
const path = require('path');

const T0 = 1000000;
const jit = (i, a) => ((i * 37) % 17 - 8) * a / 8;

// Delivery rule: the first beat ends at t0 - 1000 + first interval, each later beat one interval after the
// previous; the packet at T = t0 + i * 1000 carries the beats ending in (T - 1000, T], rounded to whole ms.
function packets(n, beatMs, strapAt, t0 = T0) {
  const ends = [];
  let tb = t0 - 1000, bi = 0;
  while (tb < t0 + n * 1000) { const b = beatMs(bi++, tb); tb += b; ends.push([tb, b]); }
  const out = [];
  let k = 0;
  for (let i = 0; i < n; i++) {
    const T = t0 + i * 1000, rr = [];
    while (k < ends.length && ends[k][0] <= T) { if (ends[k][0] > T - 1000) rr.push(Math.round(ends[k][1])); k++; }
    out.push({ t: T, hr: strapAt(i), rr });
  }
  return out;
}
const literal = (n, rrAt, strapAt) => Array.from({ length: n }, (_, i) => ({ t: T0 + i * 1000, hr: strapAt(i), rr: rrAt(i) }));

const CASES = [];
const add = (name, seq, asserts, marks = {}, flags = () => ({})) => CASES.push({ name, seq, asserts, marks, flags });

add('C1-lag-low-start',
  packets(120, (i) => (i === 5 ? 255 : i === 12 ? 1884 : (i % 4 === 3 ? 750 : 375 + jit(i, 8))),
    (i) => (i < 60 ? 80 + Math.floor(i / 9) * 3 : Math.min(160, 98 + (i - 60) * 5))),
  ['5 59 src B', '5 59 shown 150 170', '70 119 src S', 'switches 1'], {}, (i) => ({ contact: i % 2 ? 'on' : 'off' }));
add('C2-high-start', packets(60, (i) => 770 + jit(i, 10), (i) => (i < 3 ? 121 : Math.max(78, 121 - (i - 2) * 4))),
  ['5 10 src B', '5 10 shown 74 82', '22 59 src S', 'switches 1']);
add('C3-steady-agree', packets(300, (i) => (i % 37 === 36 ? [250, 2000, 1666][(i / 37 | 0) % 3] : 833 + jit(i, 20)), (i) => 72 + (i % 3) - 1),
  ['0 299 src S'], {}, (i) => ({ contact: 'on', b16: i % 5 === 0 }));
add('C4-no-rr', literal(60, () => [], () => 90), ['0 59 src S', '0 59 shown 90 90'], {},
  (i) => ({ noRr: true, b16: i % 3 === 1, energy: i % 3 === 2 }));
{
  const q = packets(60, (i) => 770 + jit(i, 10), () => 121);
  for (let i = 12; i < 20; i++) q[i].rr = [];
  add('C5-rr-stops', q, ['5 18 src B', '19 23 src S'], {}, (i) => ({ noRr: i >= 12 && i < 20 }));
}
{
  const a = packets(70, (i) => 770 + jit(i, 10), (i) => (i < 3 ? 121 : 78));
  const b = packets(30, (i) => 770 + jit(i, 10), () => 121, T0 + 85000);
  add('C6-gap', a.concat(b), ['70 74 src S', '75 99 src B']);
}
add('C7-link', packets(100, (i, t) => ((t >= T0 + 69000 && i % 3 === 2) ? 1540 : 770 + jit(i, 10)), (i) => (i < 3 ? 121 : i < 70 ? 78 : 121)),
  ['70 72 src S', '80 99 src B'], { 70: 'link' });
{
  const a = packets(10, (i) => 770 + jit(i, 10), () => 121);
  const b = packets(30, (i) => 857 + jit(i, 10), () => 70, T0 + 10000);
  add('C8-reset', a.concat(b), ['5 9 src B', '10 39 src S'], { 10: 'reset' });
}
add('C9-alternating', packets(120, (i) => (i % 2 ? 400 : 800), () => 149), ['0 119 src S']);
add('C10-strap-zero', packets(90, (i) => 750 + jit(i, 6), (i) => (i < 70 ? 80 : 0)), ['70 74 src S', '75 89 src B'], {}, (i) => ({ energy: i >= 70 }));
{
  const q = packets(60, (i) => 770 + jit(i, 10), () => 121);
  q[8].t -= 500;
  for (let i = 30; i < 60; i++) q[i].t -= 20000;
  add('C11-clock-back', q, ['5 29 src B', '30 34 src S', '35 59 src B']);
}
{
  const bpm = (s) => (s < 120 ? 80 : s < 130 ? 80 + (s - 120) * 5 : 130);
  add('C12-fast-rise', packets(200, (i, t) => 60000 / bpm((t - T0) / 1000), (i) => Math.round(bpm(i - 6))), ['switches 1', '190 199 src S']);
}
add('C13-hover', packets(110, (i) => 600 + jit(i, 6), (i) => (i < 70 ? 100 : i < 76 ? 86 : i < 96 ? 90 : 100)), ['0 74 src S', '75 95 src B']);
add('C14-burst', packets(110, (i, t) => ((t > T0 + 70000 && t < T0 + 73000) ? 500 : 600), () => 100), ['0 109 src S']);
// Two equal clusters (smaller wins the tie) and even-count medians; golden only.
add('C15-ties', literal(60, (i) => (i % 4 < 2 ? [700, 700] : [800, 800]).concat(i % 7 === 3 ? [750] : []), (i) => (i < 20 ? 110 : 80)), []);
add('C16-half-rate-lock', literal(600, () => [800, 800, 400], () => 150), ['0 599 src S', '0 599 shown 150 150']);
for (const [nm, pat] of [['C16b1', [800, 800, 800, 400]], ['C16b2', [800, 800, 800, 800, 400]], ['C16b3', [800, 800, 400]]]) {
  add(nm + '-half-rate-delivered', packets(300, (i) => pat[i % pat.length], () => 150), ['0 299 src S', '0 299 shown 150 150']);
}
{
  const q = packets(40, (i) => 620 + jit(i, 8), () => 97);
  // Start fragments: two near-double fragments, two short beats, one normal (made up, not a recorded packet).
  q[0].rr = [540, 530, 330, 310, 620];
  add('C17-start-fragments', q, ['0 39 src S', '0 39 shown 97 97']);
}
add('C18-alternating-steady', literal(130, (i) => (i < 100 ? (i % 3 ? [660] : [660, 660]) : (i % 2 ? [1150] : [445, 445])), () => 91), ['0 129 src S']);
add('C19-splits-carry-count', packets(40, (i) => (i % 2 ? 1800 : 900), () => 110), ['0 9 src S', '10 39 src B', '10 39 shown 67 67']);
add('C20-blind-band', packets(120, () => 1000, () => 120), ['0 119 src S', '0 119 shown 120 120']);
add('C20b-band-edge-flap', packets(300, (i) => 909 + jit(i, 10), () => 120), ['0 15 src S', 'switches 13']);

// A real 0x2A37 payload: flags, HR (8 or 16 bit), energy, RR in 1/1024 s.
function encode(hr, rr, f) {
  let flags = 0;
  if (f.b16 || hr > 255) flags |= 0x01;
  if (f.contact === 'on') flags |= 0x06;
  if (f.contact === 'off') flags |= 0x04;
  if (f.energy) flags |= 0x08;
  if (!f.noRr) flags |= 0x10;
  const bytes = [flags];
  if (flags & 0x01) bytes.push(hr & 0xff, hr >> 8); else bytes.push(hr & 0xff);
  if (flags & 0x08) bytes.push(0x34, 0x12);
  if (!f.noRr) for (const ms of rr) { const raw = Math.round(ms * 1024 / 1000); bytes.push(raw & 0xff, raw >> 8); }
  return bytes.map((b) => b.toString(16).padStart(2, '0')).join('');
}
const decodeRr = (raw) => Math.round(raw * 1000 / 1024);

const lines = ['# hr-source vectors v1, synthetic. Inputs only; golden outputs in hr-source-golden.txt.'];
for (const c of CASES) {
  lines.push('case ' + c.name);
  c.seq.forEach((p, i) => {
    if (c.marks[i]) lines.push(c.marks[i]);
    const f = c.flags(i);
    const rr = f.noRr ? [] : p.rr;
    const roundTrip = rr.map((ms) => decodeRr(Math.round(ms * 1024 / 1000)));
    if (roundTrip.some((v, j) => v !== rr[j])) throw new Error(c.name + ' ' + i + ': RR does not survive the 1/1024 s encoding');
    lines.push('p ' + p.t + ' ' + encode(p.hr, rr, f) + ' ' + p.hr + ' ' + (rr.length ? rr.join(';') : '-'));
  });
  for (const a of c.asserts) lines.push('a ' + a);
}
const OUT = path.join(__dirname, 'hr-source-vectors.txt');
fs.writeFileSync(OUT, lines.join('\n') + '\n');
console.log('wrote ' + OUT + ': ' + CASES.length + ' cases, ' + lines.filter((l) => l.startsWith('p ')).length + ' packets');
