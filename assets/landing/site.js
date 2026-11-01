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
      el.textContent = 'Your viewer';
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
// one speed along the outline (a rotating conic gradient does not). Plays with reduced motion on (2026-10-12).
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
// ends with one word alone (2026-10-12). CSS text-wrap: pretty does the same where supported.
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

// Picture dialog: click or Enter on a picture opens its full-size file (loaded only then); Tab stays inside;
// Escape or Close shuts it and focus goes back to the picture; arrow keys and swipes move in page order.
(function () {
  if (!document.querySelector('button.zoom')) return;
  document.body.insertAdjacentHTML('beforeend', '<dialog class="lightbox" id="lightbox" tabindex="-1" aria-labelledby="lb-caption"><div class="lb ui"><div class="lb-bar"><span class="lb-count" id="lb-count"></span><button type="button" class="btn icon" id="lb-close" aria-label="Close"><svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg></button></div><div class="lb-stage" id="lb-stage"><img id="lb-img" alt=""></div><div class="lb-foot"><button type="button" class="btn icon" id="lb-prev" aria-label="Previous picture"><svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M10 3 5 8l5 5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg></button><p id="lb-caption"></p><button type="button" class="btn icon" id="lb-next" aria-label="Next picture"><svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="m6 3 5 5-5 5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg></button></div></div></dialog>');
  const dlg = document.getElementById('lightbox');
  const img = document.getElementById('lb-img');
  const cap = document.getElementById('lb-caption');
  const count = document.getElementById('lb-count');
  const stage = document.getElementById('lb-stage');
  let list = [], at = -1, opener = null;
  // Page order is reading order, so on a phone (where Now stacks first) the arrows follow what you see.
  const ordered = () => [...document.querySelectorAll('button.zoom')].filter((b) => b.offsetParent)
    .sort((a, b) => { const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect(); return (ra.top - rb.top) || (ra.left - rb.left); });
  function show(i) {
    at = (i + list.length) % list.length;
    const b = list[at], alt = b.querySelector('img').alt;
    img.src = b.dataset.full; img.alt = alt;
    cap.textContent = alt;
    count.textContent = (at + 1) + ' of ' + list.length;
  }
  function open(b) {
    list = ordered(); opener = b;
    show(list.indexOf(b));
    dlg.showModal();
    document.getElementById('lb-close').focus();
  }
  function close() { if (dlg.open) dlg.close(); }
  dlg.addEventListener('close', () => { img.removeAttribute('src'); if (opener) opener.focus(); });
  document.addEventListener('click', (e) => { const b = e.target.closest('button.zoom'); if (b) open(b); });
  document.getElementById('lb-close').addEventListener('click', close);
  document.getElementById('lb-prev').addEventListener('click', () => show(at - 1));
  document.getElementById('lb-next').addEventListener('click', () => show(at + 1));
  dlg.addEventListener('click', (e) => { if (e.target === dlg || e.target === stage) close(); });
  dlg.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowRight') { e.preventDefault(); show(at + 1); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); show(at - 1); }
    else if (e.key === 'Escape') { e.preventDefault(); close(); }
    else if (e.key === 'Tab') {
      const f = [...dlg.querySelectorAll('button')];
      const i = f.indexOf(document.activeElement);
      if (e.shiftKey && i <= 0) { e.preventDefault(); f[f.length - 1].focus(); }
      else if (!e.shiftKey && (i === f.length - 1 || i < 0)) { e.preventDefault(); f[0].focus(); }
    }
  });
  let sx = null, sy = null;
  stage.addEventListener('touchstart', (e) => {
    if (e.touches.length > 1 || (window.visualViewport && window.visualViewport.scale > 1.01)) { sx = null; return; }
    const t = e.changedTouches[0]; sx = t.clientX; sy = t.clientY;
  }, { passive: true });
  stage.addEventListener('touchend', (e) => {
    if (sx == null) return;
    const t = e.changedTouches[0], dx = t.clientX - sx, dy = t.clientY - sy; sx = null;
    if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) show(at + (dx < 0 ? 1 : -1));
  });
})();
