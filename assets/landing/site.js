// Shared by index.html, changelog.html, legal.html and new-look.html: sign-in links, the back-to-top button,
// the brand border trail and the no-widows join.
(function () {
  const VIEWER_URL = './hrv_viewer.html';
  const native = () => !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
  const auth = () => (window.aortiAuth && typeof window.aortiAuth.signIn === 'function' ? window.aortiAuth : null);
  function say(from, text) {
    const scope = from.closest('[data-signin-scope]') || document;
    const msg = scope.querySelector('.signin-msg');
    if (!msg) return;
    msg.textContent = text;
    msg.hidden = !text;
  }
  // Signed in: the nav link leads to the viewer and the hero sign-in row hides.
  function showSignedIn() {
    const a = auth();
    if (!a || !a.isSignedIn()) return;
    document.body.classList.add('signed-in');
    document.querySelectorAll('.nav [data-signin]').forEach((el) => {
      el.textContent = 'Your sessions';
      el.setAttribute('href', VIEWER_URL);
      el.removeAttribute('data-signin');
    });
    document.querySelectorAll('[data-signin-row]').forEach((el) => { el.hidden = true; });
  }
  async function startSignIn(el) {
    const a = auth();
    if (a && a.isSignedIn()) { location.href = VIEWER_URL; return; }
    if (!a || (!native() && !(window.google && window.google.accounts))) {
      say(el, 'Sign-in is unavailable right now. Open monitor works without it.');
      return;
    }
    say(el, '');
    try {
      await a.signIn();
      location.href = VIEWER_URL;
    } catch (e) {
      const msg = e && e.message ? e.message : String(e);
      if (/popup_closed|cancel/i.test(msg)) return;
      say(el, 'Sign-in did not finish. Try again.');
    }
  }
  document.addEventListener('click', (e) => {
    const el = e.target.closest && e.target.closest('[data-signin]');
    if (!el) return;
    e.preventDefault();
    startSignIn(el);
  }, true);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', showSignedIn); else showSignedIn();

  // Back to top: shows after the first screen.
  const top = document.getElementById('back-to-top');
  if (top) {
    const update = () => top.classList.toggle('visible', window.scrollY > window.innerHeight * 0.6);
    window.addEventListener('scroll', update, { passive: true });
    update();
    top.addEventListener('click', () => {
      const smooth = !(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches);
      window.scrollTo({ top: 0, behavior: smooth ? 'smooth' : 'auto' });
    });
  }
})();

// Brand border trail (S43): dashes on a pathLength-100 SVG ring move by stroke-dashoffset, so the light keeps
// one speed along the outline (a rotating conic gradient does not). Plays with reduced motion on (Khal 2026-10-12).
(function () {
  const HOST = '.btn, .android-card, .strap-feature';
  const NS = 'http://www.w3.org/2000/svg';
  const LAP = 800, EASE = 'cubic-bezier(.37, 0, .63, 1)';
  const OUT = 2, M = 4; // ring centre line OUT px outside the border box; the SVG reaches M px past it
  // [length in px, cap as a share of the outline, opacity]: tail 2, tail 1, head.
  const DASHES = [[56, 0.2, 0.18], [40, 0.14, 0.45], [24, 0.08, 1]];
  const sets = new WeakMap();
  const rect = (cls) => { const r = document.createElementNS(NS, 'rect'); r.setAttribute('class', cls); r.setAttribute('pathLength', '100'); return r; };

  function size(s) {
    const el = s.el, w = el.offsetWidth, h = el.offsetHeight;
    if (!w || !h) return;
    s.svg.style.left = -(el.clientLeft + M) + 'px';
    s.svg.style.top = -(el.clientTop + M) + 'px';
    s.svg.setAttribute('width', w + 2 * M);
    s.svg.setAttribute('height', h + 2 * M);
    const W = w + 2 * OUT, H = h + 2 * OUT;
    const rx = Math.min(parseFloat(getComputedStyle(el).borderTopLeftRadius) + OUT || OUT, W / 2, H / 2);
    const P = 2 * (W + H) - (8 - 2 * Math.PI) * rx;
    for (const r of [s.rest, ...s.dashes]) {
      r.setAttribute('x', M - OUT); r.setAttribute('y', M - OUT);
      r.setAttribute('width', W); r.setAttribute('height', H);
      r.setAttribute('rx', rx); r.setAttribute('ry', rx);
    }
    // Head from 0 forward; each tail sits right behind the dash ahead of it.
    let back = 0;
    s.base = [];
    const lens = DASHES.map(([px, cap]) => Math.min(px, cap * P) * 100 / P);
    for (let i = DASHES.length - 1; i >= 0; i--) {
      const len = lens[i];
      s.dashes[i].setAttribute('stroke-dasharray', `${len} ${100 - len}`);
      s.base[i] = i === DASHES.length - 1 ? 0 : (back += len);
      s.dashes[i].style.strokeDashoffset = s.base[i] + 'px';
    }
  }

  function build(el) {
    let s = sets.get(el);
    if (s && el.contains(s.svg)) return s;
    if (getComputedStyle(el).position === 'static') el.classList.add('trail-host');
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('class', 'trail');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    const g = document.createElementNS(NS, 'g');
    const rest = rect('trail-rest');
    const dashes = DASHES.map(([, , op]) => { const r = rect('trail-dash'); r.setAttribute('stroke-opacity', op); return r; });
    const sw = el.classList.contains('btn') ? 2 : 1.5;
    for (const r of [rest, ...dashes]) r.setAttribute('stroke-width', sw);
    g.append(...dashes);
    svg.append(rest, g);
    el.append(svg);
    s = { el, svg, g, rest, dashes, btn: el.classList.contains('btn'), anims: [], t: 0 };
    sets.set(el, s);
    size(s);
    if (window.ResizeObserver) new ResizeObserver(() => size(s)).observe(el);
    return s;
  }

  function stop(s) { s.anims.forEach((a) => a.cancel()); s.anims = []; }

  function lap(s) {
    stop(s);
    const opts = { duration: LAP, easing: EASE };
    s.anims = s.dashes.map((r, i) => r.animate([{ strokeDashoffset: s.base[i] + 'px' }, { strokeDashoffset: s.base[i] - 100 + 'px' }], opts));
    s.anims.push(s.g.animate([{ opacity: 0 }, { opacity: 1, offset: 0.1 }, { opacity: 1, offset: 0.8 }, { opacity: 0 }], { duration: LAP, fill: 'forwards' }));
    if (s.btn) s.anims.push(s.rest.animate([{ opacity: 0 }, { opacity: 0.35 }], { delay: LAP * 0.7, duration: 300, fill: 'forwards' }));
  }

  document.addEventListener('pointerenter', (e) => {
    const el = e.target;
    if (e.pointerType === 'touch' || !el.matches || !el.matches(HOST)) return;
    const s = build(el);
    clearTimeout(s.t);
    el.classList.add('trail-on');
    lap(s);
  }, true);
  document.addEventListener('pointerleave', (e) => {
    const el = e.target, s = el.matches && el.matches(HOST) && sets.get(el);
    if (!s) return;
    el.classList.remove('trail-on');
    clearTimeout(s.t);
    s.t = setTimeout(() => { if (!el.classList.contains('trail-on')) stop(s); }, 200);
  }, true);
  document.addEventListener('focusin', (e) => {
    const el = e.target;
    if (el.matches && el.matches('.btn') && el.matches(':focus-visible')) { build(el); el.classList.add('trail-focus'); }
  });
  document.addEventListener('focusout', (e) => { if (e.target.classList) e.target.classList.remove('trail-focus'); });
})();

// No widows: join the last two words of every text block with a non-breaking space, so a line never
// ends with one word alone (Khal 2026-10-12). CSS text-wrap: pretty does the same where supported.
(function () {
  function join(el) {
    const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let last = null;
    for (let n = walk.nextNode(); n; n = walk.nextNode()) if (/\S/.test(n.data)) last = n;
    if (!last) return;
    const m = /(\S)\s+(\S+\s*)$/.exec(last.data);
    if (m) last.data = last.data.slice(0, m.index + 1) + ' ' + m[2];
  }
  function run() { document.querySelectorAll('p, li, figcaption, summary, dd, .lede').forEach(join); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', run); else run();
})();

