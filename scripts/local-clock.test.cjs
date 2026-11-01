#!/usr/bin/env node
// Guards: 2026-10-31, the S8's WebView read noon as 11:00 in January while Android had the current rules, so in-app
// clocks and day cuts ran an hour behind. Runs under a zone that still changes clocks, with a table that stopped
// changing them on 2026-11-01. Skips if this machine's runtime cannot show that zone. Runtime: under 1 s.
process.env.TZ = 'America/Denver';
const Original = Date;
const utc = (s) => Original.parse(s);
const CUT = utc('2026-11-01T08:00:00Z');
const FROM = utc('2020-01-01T00:00:00Z');
const TO = utc('2032-01-01T00:00:00Z');
if (new Original(utc('2027-01-15T18:00:00Z')).getHours() !== 11) {
  console.log('local-clock: SKIPPED, runtime is not on UTC-7 in January');
  process.exit(0);
}

// The runtime's own changes up to the cut, then UTC-6 for good.
function tableUpTo(end) {
  const changes = [[FROM, -new Original(FROM).getTimezoneOffset()]];
  for (let t = FROM; t < end; t += 36e5) {
    const off = -new Original(t).getTimezoneOffset();
    if (off !== changes[changes.length - 1][1]) changes.push([t, off]);
  }
  return changes;
}

let failed = 0, passed = 0;
const check = (name, got, want) => {
  if (got === want) { passed++; return; }
  failed++;
  console.log('FAIL ' + name + ': got ' + got + ', want ' + want);
};

require('../local-clock.js');
const clock = globalThis.AortiLocalClock;

// A table that agrees with the runtime leaves everything alone.
const getHours = Original.prototype.getHours;
check('an agreeing table installs nothing', clock.install({ from: FROM, to: TO, changes: tableUpTo(TO) }), false);
check('getters untouched', Original.prototype.getHours, getHours);
check('Date untouched', globalThis.Date, Original);
delete globalThis.__aortiClockActive;

const changes = tableUpTo(CUT);
if (changes[changes.length - 1][1] !== -360) changes.push([CUT, -360]);
check('a disagreeing table installs', clock.install({ from: FROM, to: TO, changes }), true);

const hm = (d) => d.getHours() + ':' + String(d.getMinutes()).padStart(2, '0');
const day = (d) => d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate();

check('before the change', hm(new Date('2026-10-31T18:00:00Z')), '12:00');
check('one second before the change', hm(new Date('2026-11-01T07:59:59Z')), '1:59');
check('at the change', hm(new Date('2026-11-01T08:00:00Z')), '2:00');
check('noon in January', hm(new Date('2027-01-15T18:00:00Z')), '12:00');
check('summer after the change', hm(new Date('2027-07-15T18:00:00Z')), '12:00');
check('past recording, winter 2025', hm(new Date('2025-01-15T18:00:00Z')), '11:00');
check('before the table', hm(new Date('2019-01-15T18:00:00Z')), '11:00');
check('late evening keeps its day', day(new Date('2027-01-16T05:30:00Z')), '2027-1-15');
check('midnight starts the next day', day(new Date('2027-01-16T06:00:00Z')), '2027-1-16');
check('day of week', new Date('2027-01-16T05:30:00Z').getDay(), 5);
check('offset', new Date('2027-01-15T18:00:00Z').getTimezoneOffset(), 360);

check('local parts', new Date(2027, 0, 15, 12).getTime(), utc('2027-01-15T18:00:00Z'));
check('local parts, day only', new Date(2027, 0, 15).getTime(), utc('2027-01-15T06:00:00Z'));
check('month overflow', new Date(2027, 12, 1).getTime(), utc('2028-01-01T06:00:00Z'));
check('last of the month', new Date(2027, 2, 0).getDate(), 28);
check('local ISO', new Date('2027-01-15T00:00:00').getTime(), utc('2027-01-15T06:00:00Z'));
check('parse local ISO', Date.parse('2027-01-15T12:00:00'), utc('2027-01-15T18:00:00Z'));
check('parse with a zone', Date.parse('2027-01-15T12:00:00Z'), utc('2027-01-15T12:00:00Z'));
check('date only ISO stays UTC', new Date('2027-01-15').getTime(), utc('2027-01-15T00:00:00Z'));
check('copy of a Date', new Date(new Date(5000)).getTime(), 5000);
check('from a number', new Date(5000).getTime(), 5000);

const start = new Date('2027-01-15T18:00:00Z');
start.setHours(0, 0, 0, 0);
check('setHours to day start', start.getTime(), utc('2027-01-15T06:00:00Z'));
const next = new Date('2027-01-31T18:00:00Z');
next.setDate(next.getDate() + 1);
check('setDate across a month', day(next) + ' ' + hm(next), '2027-2-1 12:00');
const across = new Date('2026-10-31T18:00:00Z');
across.setDate(across.getDate() + 3);
check('setDate across the change keeps the clock', hm(across), '12:00');
check('invalid stays invalid', Number.isNaN(new Date('nope').getHours()), true);

check('a skipped spring time moves forward', hm(new Date(2026, 2, 8, 2, 30)), '3:30');
check('an autumn overlap takes the first', new Date(2025, 10, 2, 1, 30).getTime(), utc('2025-11-02T07:30:00Z'));
check('an undefined day is invalid', Number.isNaN(new Date(2026, 0, undefined).getTime()), true);

check('instanceof both ways', new Date() instanceof Original && new Original() instanceof Date, true);
check('now', typeof Date.now(), 'number');
check('UTC', Date.UTC(2027, 0, 1), utc('2027-01-01T00:00:00Z'));
check('called without new', typeof Date(), 'string');
check('toLocaleTimeString', new Date('2027-01-15T18:00:00Z').toLocaleTimeString('en-CA', { hour: 'numeric', hour12: false }), '12');
check('toLocaleDateString near midnight', new Date('2027-01-16T05:30:00Z').toLocaleDateString('en-CA'), '2027-01-15');
check('an explicit zone wins', new Date('2027-01-15T18:00:00Z').toLocaleTimeString('en-CA', { hour: 'numeric', hour12: false, timeZone: 'UTC' }), '18');

check('refresh follows a new zone', clock.refresh({ from: FROM, to: TO, changes: [[FROM, -300]] }), true);
check('after a zone change', hm(new Date('2027-01-15T18:00:00Z')), '13:00');

console.log('local-clock: ' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
