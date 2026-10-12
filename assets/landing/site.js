// Shared by index.html, changelog.html and legal.html: sign-in links and the back-to-top button.
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
