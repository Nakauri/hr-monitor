// App only (mobile/scripts/copy-web.js puts it first in every page). The WebView carries its own zone data, which
// can be older than the phone's, so local time reads wrong after a rule change. When the table from ZoneTable.java
// disagrees with this runtime, local readings of Date follow the table. When they agree, nothing is patched.
// Guards: 2026-10-31, the S8's WebView read noon as 11:00 in January while Android had the current rules.
(function (root) {
  const Native = root.Date;
  const proto = Native.prototype;
  const nativeOffset = proto.getTimezoneOffset;
  const getTime = proto.getTime;
  const setTime = proto.setTime;
  const LOCAL_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?$/;

  function disagrees(table, offsetAt) {
    const native = new Native(0);
    for (let t = table.from; t <= table.to; t += 7 * 864e5) {
      setTime.call(native, t);
      if (offsetAt(t) !== -nativeOffset.call(native)) return true;
    }
    for (const [start] of table.changes) {
      for (const t of [start - 1, start]) {
        if (t < table.from) continue;
        setTime.call(native, t);
        if (offsetAt(t) !== -nativeOffset.call(native)) return true;
      }
    }
    return false;
  }

  let table = null;
  const offsetAt = (ms) => {
    const changes = table.changes;
    let lo = 0, hi = changes.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (changes[mid][0] <= ms) lo = mid; else hi = mid - 1;
    }
    return changes[lo][1];
  };

  // The phone's zone can change while the page lives.
  function refresh(next) {
    if (!next || !next.changes || !next.changes.length) return !!root.__aortiClockActive;
    if (root.__aortiClockActive) { table = next; return true; }
    delete root.__aortiClockActive;
    return install(next);
  }

  function install(next) {
    if (!next || !next.changes || !next.changes.length || root.__aortiClockActive != null) return !!root.__aortiClockActive;
    table = next;
    if (!disagrees(table, offsetAt)) { root.__aortiClockActive = false; return false; }

    // Outside the table the runtime's own answer stands.
    const covered = (ms) => ms >= table.from && ms <= table.to;
    const scratch = new Native(0);
    const offsetFor = (ms) => {
      if (covered(ms)) return offsetAt(ms);
      setTime.call(scratch, ms);
      return -nativeOffset.call(scratch);
    };
    // The instant a wall clock reading happens, read as if UTC. As Date does: an overlap takes the first
    // occurrence, a time skipped by a change moves forward.
    const fromWall = (wall) => {
      const before = offsetFor(wall - 864e5), after = offsetFor(wall + 864e5);
      const first = wall - before * 6e4, second = wall - after * 6e4;
      if (offsetFor(first) === before) return first;
      return offsetFor(second) === after ? second : first;
    };

    for (const part of ['FullYear', 'Month', 'Date', 'Day', 'Hours', 'Minutes', 'Seconds', 'Milliseconds']) {
      const getUtc = proto['getUTC' + part];
      proto['get' + part] = function () {
        const ms = getTime.call(this);
        return ms !== ms ? NaN : getUtc.call(new Native(ms + offsetFor(ms) * 6e4));
      };
      if (part === 'Day') continue;
      const setUtc = proto['setUTC' + part];
      proto['set' + part] = function (...args) {
        const ms = getTime.call(this);
        if (ms !== ms) return NaN;
        const wall = new Native(ms + offsetFor(ms) * 6e4);
        setUtc.apply(wall, args);
        return setTime.call(this, fromWall(getTime.call(wall)));
      };
    }
    proto.getTimezoneOffset = function () {
      const ms = getTime.call(this);
      return ms !== ms ? NaN : -offsetFor(ms);
    };
    for (const name of ['toLocaleString', 'toLocaleDateString', 'toLocaleTimeString']) {
      const format = proto[name];
      proto[name] = function (locales, options) {
        const off = offsetFor(getTime.call(this));
        if ((options && options.timeZone) || off % 60) return format.call(this, locales, options);
        const zone = off === 0 ? 'Etc/GMT' : 'Etc/GMT' + (off < 0 ? '+' : '-') + Math.abs(off / 60);
        return format.call(this, locales, Object.assign({}, options, { timeZone: zone }));
      };
    }

    const parse = (text) => (LOCAL_ISO.test(text) ? fromWall(Native.parse(text + 'Z')) : Native.parse(text));
    function Clock(...args) {
      if (!new.target) return new Clock().toString();
      let ms;
      if (args.length === 0) ms = Native.now();
      else if (args.length === 1) ms = typeof args[0] === 'string' ? parse(args[0]) : new Native(args[0]);
      else {
        const wall = new Native(0);
        const n = (i, missing) => (args.length > i ? Number(args[i]) : missing);
        const year = Math.trunc(Number(args[0]));
        wall.setUTCFullYear(year >= 0 && year <= 99 ? 1900 + year : year, n(1, 0), n(2, 1));
        wall.setUTCHours(n(3, 0), n(4, 0), n(5, 0), n(6, 0));
        ms = fromWall(getTime.call(wall));
      }
      return Reflect.construct(Native, [ms instanceof Native ? getTime.call(ms) : ms], new.target);
    }
    Object.setPrototypeOf(Clock, Native);
    Clock.prototype = proto;
    Clock.parse = parse;
    proto.constructor = Clock;
    root.Date = Clock;
    root.__aortiClockActive = true;
    return true;
  }

  root.AortiLocalClock = { install, refresh };
  if (root.AortiZone && typeof root.AortiZone.table === 'function') {
    try {
      root.__aortiZoneTable = JSON.parse(root.AortiZone.table());
      install(root.__aortiZoneTable);
    } catch (e) {
      root.__aortiClockActive = false;
    }
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState !== 'visible') return;
        try {
          root.__aortiZoneTable = JSON.parse(root.AortiZone.table());
          refresh(root.__aortiZoneTable);
        } catch (e) {
          console.warn('[local-clock] table refresh failed', e);
        }
      });
    }
  }
})(typeof self !== 'undefined' ? self : globalThis);
