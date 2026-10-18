// Guards: the viewer's beat check (beatJunk, S61) drifting from the monitor's strap check (signalFeed, S59), which
// would let strap junk print as an evening above 100 (false stretches without the check).
// Files: hr_monitor.html (signalFeed block, getEctopicThresholds), hrv_viewer.html (S61 moments block).
// Drives both over scripts/fixtures/s61-beats.json (seeded, no health data): reset at gaps over 10 s, no grace on
// either side; the monitor side reads each packet's share from signal.beats with the viewer's 0.20, then both use the
// per-second rule (first packet per second, fills up to 5 more seconds). Constants are read from the monitor.
// --slow: the same over ux-audit/redesign/s54/data when present (exits 2 when absent). MUTATE=1 sets the viewer's
// long ratio to 0.25; the run must then FAIL. Runtime: fixture under 2 s, --slow about 60 s.
// Usage: node scripts/junk-parity.test.cjs [--slow] [--ux <dir>]
const fs = require('fs'), path = require('path');
const ROOT = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const SLOW = args.includes('--slow');
let fails = 0;
const row = (ok, msg) => { console.log((ok ? 'PASS ' : 'FAIL ') + msg); if (!ok) fails++; return ok; };

const mon = fs.readFileSync(path.join(ROOT, 'hr_monitor.html'), 'utf8').replace(/\r\n/g, '\n');
let view = fs.readFileSync(path.join(ROOT, 'hrv_viewer.html'), 'utf8').replace(/\r\n/g, '\n');
if (process.env.MUTATE === '1') view = view.replace('short: 0.30, long: 0.15, share: 0.20', 'short: 0.30, long: 0.25, share: 0.20');

// Monitor: the S59 block and the sensitivity table, cut at run time.
const ca = mon.indexOf('  const SIGNAL_WINDOW_MS'), cb = mon.indexOf('  function onHRNotification');
const ea = mon.indexOf('  function getEctopicThresholds() {'), eb = mon.indexOf('  // Pending short-beat candidates');
if (ca < 0 || cb < ca || ea < 0 || eb < ea) { console.log('FAIL monitor anchors missing'); process.exit(1); }
const ecto = new Function('widgetPrefs', mon.slice(ea, eb) + ';return getEctopicThresholds;')({});
let now = 0;
const el = { hidden: true, setAttribute() {}, getAttribute() { return 'false'; }, addEventListener() {}, textContent: '' };
const M = new Function('document', 'window', 'state', 'getEctopicThresholds', 'Date', 'setTimeout', 'clearTimeout',
  mon.slice(ca, cb) + ';return { signalFeed, signalReset, signal, SIGNAL_WINDOW_MS, SIGNAL_MIN_BEATS, SIGNAL_TOL_BPM };')(
  { getElementById: () => el, body: { classList: { toggle() {} } } }, { HRMLog: { event() {} } }, { connState: 'live' }, ecto, { now: () => now }, () => 0, () => {});

// Viewer: the S61 block.
const va = view.indexOf('  // ---- S61 moments ----'), vb = view.indexOf('  // ---- S61 moments end ----');
if (va < 0 || vb < va) { console.log('FAIL S61 block markers missing'); process.exit(1); }
const V = new Function(view.slice(va, vb) + ';return { beatJunk, S61_BEAT };')();

const th = ecto();
row(V.S61_BEAT.windowMs === M.SIGNAL_WINDOW_MS && V.S61_BEAT.minBeats === M.SIGNAL_MIN_BEATS && V.S61_BEAT.tolBpm === M.SIGNAL_TOL_BPM
  && V.S61_BEAT.short === th.short && V.S61_BEAT.long === th.long,
  `constants equal: window ${V.S61_BEAT.windowMs}/${M.SIGNAL_WINDOW_MS}, beats ${V.S61_BEAT.minBeats}/${M.SIGNAL_MIN_BEATS}, tol ${V.S61_BEAT.tolBpm}/${M.SIGNAL_TOL_BPM}, short ${V.S61_BEAT.short}/${th.short}, long ${V.S61_BEAT.long}/${th.long}`);

function monitorSeconds(packets, ep0, secs) {
  const idx = [], val = [];
  let last = null;
  M.signalReset();
  for (const p of packets) {
    if (last != null && p.ep - last > 10000) M.signalReset();
    last = p.ep;
    M.signal.liveSince = -Infinity;
    now = p.ep;
    M.signalFeed(p.hr, p.rr);
    const b = M.signal.beats;
    let j = 0;
    for (const q of b) if (q.junk) j++;
    const flag = b.length >= M.SIGNAL_MIN_BEATS && j / b.length >= V.S61_BEAT.share ? 1 : 0;
    const s = Math.round((p.ep - ep0) / 1000);
    if (idx.length && idx[idx.length - 1] === s) continue;
    idx.push(s); val.push(flag);
  }
  const out = new Uint8Array(secs);
  for (let k = 0; k < idx.length; k++) {
    const end = Math.min(idx[k] + 6, k + 1 < idx.length ? idx[k + 1] : Infinity, secs);
    for (let i = Math.max(0, idx[k]); i < end; i++) out[i] = val[k];
  }
  return out;
}
function compare(name, packets) {
  packets.sort((a, b) => a.ep - b.ep);
  const ep0 = Math.floor(packets[0].ep / 1000) * 1000;
  const secs = Math.ceil((packets[packets.length - 1].ep - ep0) / 1000) + 7;
  const t = process.hrtime.bigint();
  const a = V.beatJunk([{ ep: Float64Array.from(packets.map((p) => p.ep)), hr: Uint16Array.from(packets.map((p) => p.hr)), rr: packets.map((p) => p.rr.join(';')) }], ep0, secs);
  const ms = Number(process.hrtime.bigint() - t) / 1e6;
  const b = monitorSeconds(packets, ep0, secs);
  let diff = 0, flagged = 0, first = -1;
  for (let i = 0; i < secs; i++) { if (a[i]) flagged++; if (a[i] !== b[i]) { diff++; if (first < 0) first = i; } }
  row(diff === 0, `${name}: ${secs} seconds compared, ${flagged} flagged (${Math.round(flagged / secs * 100)}%), ${diff} differences${first >= 0 ? ' first at second ' + first : ''}; beatJunk ${ms.toFixed(0)} ms`);
  return { secs, flagged, diff };
}

const fx = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 's61-beats.json'), 'utf8')).packets;
const r = compare('fixture', fx.map((p) => ({ ...p })));
row(r.flagged > 0 && r.flagged / r.secs >= 0.10 && r.flagged / r.secs <= 0.40, `fixture junk share in 10 to 40%: ${Math.round(r.flagged / r.secs * 100)}%`);

if (SLOW) {
  const uxArg = args.indexOf('--ux');
  let UX;
  if (uxArg >= 0) UX = path.resolve(args[uxArg + 1]);
  else { const common = require('child_process').execFileSync('git', ['-C', __dirname, 'rev-parse', '--git-common-dir'], { encoding: 'utf8' }).trim(); UX = path.join(path.dirname(path.resolve(__dirname, common)), 'ux-audit'); }
  const dir = path.join(UX, 'redesign', 's54', 'data');
  if (!fs.existsSync(dir)) { console.log('MISSING ' + dir); process.exit(2); }
  const sa = view.indexOf('  const SEG_NAME_RE'), sb = view.indexOf('  // Compact span view of one segment');
  const parseSegmentV2 = new Function(view.slice(sa, sb) + ';return parseSegmentV2;')();
  const files = [];
  const walk = (d) => { for (const f of fs.readdirSync(d)) { const p = path.join(d, f); if (fs.statSync(p).isDirectory()) walk(p); else if (/^hrm_\d{8}T\d{2}Z_[a-z0-9]{6}\.csv$/.test(f)) files.push(p); } };
  walk(dir);
  const packets = [];
  for (const f of files) {
    const seg = parseSegmentV2(fs.readFileSync(f, 'utf8'), path.basename(f));
    if (!seg) continue;
    for (const x of seg.rows) if (x.k === 'h') packets.push({ ep: x.ep, hr: +x.f[0] || 0, rr: x.f[2] ? x.f[2].split(';').map(Number).filter((v) => v > 0) : [] });
  }
  console.log(`s54 data: ${files.length} segments, ${packets.length} packets`);
  compare('s54 data', packets);
}
console.log(fails ? `junk-parity: ${fails} FAIL` : 'junk-parity: all pass');
process.exit(fails ? 1 : 0);
