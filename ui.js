// Shared component behaviour: sheet, inline confirm, notice, toast, read-only copy field.
// Markup and classes match ui.css. No page state; every call builds its own nodes.
(function () {
  'use strict';
  if (window.UI) return;

  const PATHS = {
    chevron: '<polyline points="6 9 12 15 18 9"/>',
    prev: '<polyline points="15 18 9 12 15 6"/>',
    next: '<polyline points="9 18 15 12 9 6"/>',
    kebab: '<circle cx="12" cy="5" r="1.5" fill="currentColor"/><circle cx="12" cy="12" r="1.5" fill="currentColor"/><circle cx="12" cy="19" r="1.5" fill="currentColor"/>',
    gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
    share: '<path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/><polyline points="16 6 12 2 8 6"/><line x1="12" y1="2" x2="12" y2="15"/>',
    trash: '<polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>',
    undo: '<polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/>',
    external: '<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>',
    close: '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>',
    copy: '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
    refresh: '<polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>',
    plus: '<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>',
    check: '<polyline points="20 6 9 17 4 12"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
    warn: '<path d="M12 9v4"/><path d="M12 17h.01"/><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/>',
  };
  function icon(name) {
    return '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true" focusable="false">' + (PATHS[name] || '') + '</svg>';
  }

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function button(label, cls, iconName) {
    const b = el('button', 'btn' + (cls ? ' ' + cls : ''));
    b.type = 'button';
    if (iconName) b.innerHTML = icon(iconName);
    if (label) b.appendChild(document.createTextNode(label));
    return b;
  }
  function append(parent, content) {
    if (content == null) return;
    if (typeof content === 'string') parent.insertAdjacentHTML('beforeend', content);
    else if (Array.isArray(content)) content.forEach((c) => append(parent, c));
    else parent.appendChild(content);
  }

  // Layers close top first on Escape.
  const layers = [];
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !layers.length) return;
    e.preventDefault();
    e.stopPropagation();
    layers[layers.length - 1].dismiss();
  }, true);
  function pushLayer(l) { layers.push(l); }
  function dropLayer(l) { const i = layers.indexOf(l); if (i >= 0) layers.splice(i, 1); }

  // Pending inline confirms resolve false when their node leaves the page.
  const watched = new Set();
  let observer = null;
  function watch(item) {
    watched.add(item);
    if (!observer) {
      observer = new MutationObserver(() => {
        watched.forEach((w) => { if (!w.node.isConnected) w.dismiss(); });
      });
      observer.observe(document.documentElement, { childList: true, subtree: true });
    }
  }
  function unwatch(item) {
    watched.delete(item);
    if (!watched.size && observer) { observer.disconnect(); observer = null; }
  }

  const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

  function sheet(opts) {
    opts = opts || {};
    const opener = document.activeElement;
    const root = el('div', 'ui sheet-root' + (opts.className ? ' ' + opts.className : ''));
    if (opts.id) root.id = opts.id;
    const scrim = el('div', 'sheet-scrim');
    const panel = el('section', 'sheet');
    panel.setAttribute('role', opts.role || 'dialog');
    panel.setAttribute('aria-modal', 'true');
    panel.tabIndex = -1;
    panel.appendChild(el('div', 'grab'));
    const head = el('div', 'sheet-head');
    const h = el('h2', null, opts.title || '');
    h.id = 'ui-sheet-t-' + Math.random().toString(36).slice(2, 8);
    panel.setAttribute('aria-labelledby', h.id);
    const x = button('', 'icon', 'close');
    x.setAttribute('aria-label', opts.closeLabel || 'Close');
    head.appendChild(h);
    head.appendChild(x);
    const body = el('div', 'sheet-body');
    append(body, opts.body);
    panel.appendChild(head);
    panel.appendChild(body);
    let foot = null;
    if (opts.foot) { foot = el('div', 'sheet-foot'); append(foot, opts.foot); panel.appendChild(foot); }
    root.appendChild(scrim);
    root.appendChild(panel);

    let closed = false;
    const layer = { dismiss: () => api.close('escape') };
    const api = {
      root, sheet: panel, body, foot, head, title: h,
      close(reason) {
        if (closed) return;
        closed = true;
        dropLayer(layer);
        root.remove();
        if (!document.querySelector('.sheet-root')) document.documentElement.classList.remove('ui-locked');
        try { if (opener && opener.focus && opener.isConnected) opener.focus({ preventScroll: true }); } catch (e) {}
        if (typeof opts.onClose === 'function') opts.onClose(reason || 'close');
      },
      get closed() { return closed; },
    };
    scrim.addEventListener('click', () => api.close('scrim'));
    x.addEventListener('click', () => api.close('button'));
    panel.addEventListener('keydown', (e) => {
      if (e.key !== 'Tab') return;
      const f = [...panel.querySelectorAll(FOCUSABLE)].filter((n) => n.offsetParent !== null);
      if (!f.length) return;
      const first = f[0], last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    });
    (opts.parent || document.body).appendChild(root);
    document.documentElement.classList.add('ui-locked');
    pushLayer(layer);
    const target = opts.initialFocus ? panel.querySelector(opts.initialFocus) : null;
    try { (target || panel).focus({ preventScroll: true }); } catch (e) {}
    return api;
  }

  // Inline when given an anchor (inserted after it) or a host (appended); otherwise inside a sheet.
  function confirm(opts) {
    opts = opts || {};
    return new Promise((resolve) => {
      const opener = document.activeElement;
      const box = el('div', 'ui confirm' + (opts.danger ? ' danger' : ''));
      box.setAttribute('role', 'alertdialog');
      if (opts.key) {
        box.dataset.confirmKey = opts.key;
        document.querySelectorAll('.confirm[data-confirm-key="' + opts.key + '"]').forEach((n) => { if (n._dismiss) n._dismiss(); });
      }
      const tid = 'ui-confirm-' + Math.random().toString(36).slice(2, 8);
      if (opts.title) { const t = el('p', 'title', opts.title); t.id = tid; box.appendChild(t); box.setAttribute('aria-labelledby', tid); }
      if (opts.text) { const p = el('p', 'text', opts.text); p.id = tid + '-d'; box.appendChild(p); box.setAttribute(opts.title ? 'aria-describedby' : 'aria-labelledby', p.id); }
      const actions = el('div', 'actions');
      const cancel = button(opts.cancelLabel || 'Cancel', '');
      const ok = button(opts.confirmLabel || 'OK', opts.danger ? 'danger' : 'primary');
      actions.appendChild(cancel);
      actions.appendChild(ok);
      box.appendChild(actions);

      const inline = !!(opts.anchor || opts.host);
      let done = false, host = null;
      const item = { node: box, dismiss: () => finish(false) };
      function onOutside(e) { if (!box.contains(e.target)) finish(false); }
      function finish(v) {
        if (done) return;
        done = true;
        dropLayer(item);
        unwatch(item);
        document.removeEventListener('click', onOutside, true);
        if (host) host.close('confirm');
        else box.remove();
        if (inline) {
          const back = [opener, opts.anchor].find((n) => n && n !== document.body && n.isConnected && n.matches(FOCUSABLE));
          const panel = (opts.anchor || opts.host).isConnected ? (opts.anchor || opts.host).closest('.sheet') : null;
          try { (back || panel || document.body).focus({ preventScroll: true }); } catch (e) {}
        }
        resolve(v);
      }
      box._dismiss = item.dismiss;
      cancel.addEventListener('click', () => finish(false));
      ok.addEventListener('click', () => finish(true));

      if (inline) {
        box.addEventListener('click', (e) => e.stopPropagation());
        if (opts.anchor) opts.anchor.insertAdjacentElement('afterend', box);
        else opts.host.appendChild(box);
        pushLayer(item);
        watch(item);
        document.addEventListener('click', onOutside, true);
        try { box.scrollIntoView({ block: 'nearest' }); } catch (e) {}
      } else {
        box.classList.remove('ui');
        host = sheet({ title: opts.sheetTitle || opts.title || '', body: box, onClose: () => { host = null; finish(false); } });
        if (opts.title) box.querySelector('.title').hidden = true;
      }
      try { cancel.focus({ preventScroll: true }); } catch (e) {}
    });
  }

  let stack = null;
  function notice(opts) {
    opts = typeof opts === 'string' ? { text: opts } : (opts || {});
    const kind = opts.kind || 'info';
    const n = el('div', 'ui notice ' + kind + (opts.bar ? ' bar' : ''));
    n.setAttribute('role', kind === 'error' ? 'alert' : 'status');
    n.innerHTML = icon(kind === 'info' ? 'info' : 'warn');
    const msg = el('div', 'msg');
    if (opts.text != null) msg.textContent = opts.text;
    append(msg, opts.content);
    n.appendChild(msg);
    const acts = el('div', 'acts');
    append(acts, opts.actions);
    if (opts.action) {
      const a = button(opts.action.label, 'ghost');
      a.addEventListener('click', () => opts.action.onClick(close));
      acts.appendChild(a);
    }
    let timer = null;
    function close() {
      if (timer) clearTimeout(timer);
      n.remove();
      if (stack && !stack.children.length) { stack.remove(); stack = null; }
      if (typeof opts.onDismiss === 'function') opts.onDismiss();
    }
    if (opts.dismiss !== false) {
      const x = button(opts.dismissLabel || '', opts.dismissLabel ? 'ghost' : 'icon', opts.dismissLabel ? null : 'close');
      x.setAttribute('aria-label', opts.dismissLabel || 'Dismiss');
      x.addEventListener('click', close);
      acts.appendChild(x);
    }
    if (acts.children.length) n.appendChild(acts);
    n.close = close;
    if (opts.before) opts.before.parentNode.insertBefore(n, opts.before);
    else if (opts.host) opts.host.appendChild(n);
    else {
      if (!stack || !stack.isConnected) { stack = el('div', 'ui notice-stack'); document.body.appendChild(stack); }
      stack.appendChild(n);
      if (opts.timeout !== 0) timer = setTimeout(close, opts.timeout || (kind === 'error' ? 12000 : 6000));
    }
    return n;
  }

  let toastHost = null;
  function toast(text, opts) {
    opts = opts || {};
    if (!toastHost || !toastHost.isConnected) { toastHost = el('div', 'ui toast-host'); document.body.appendChild(toastHost); }
    toastHost.textContent = '';
    const t = el('div', 'toast');
    t.setAttribute('role', 'status');
    t.appendChild(el('span', 'grow', text));
    let timer = null;
    function close() { if (timer) clearTimeout(timer); t.remove(); }
    if (typeof opts.undo === 'function') {
      const u = el('button', 'undo');
      u.type = 'button';
      u.innerHTML = icon('undo');
      u.appendChild(document.createTextNode(opts.undoLabel || 'Undo'));
      u.addEventListener('click', () => { close(); opts.undo(); });
      t.appendChild(u);
    }
    toastHost.appendChild(t);
    timer = setTimeout(close, opts.ms || (opts.undo ? 10000 : 4000));
    return { close };
  }

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).then(() => true, () => execCopy(text));
    }
    return Promise.resolve(execCopy(text));
  }
  function execCopy(text) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch (e) {}
    ta.remove();
    return ok;
  }

  function copyField(value, opts) {
    opts = opts || {};
    const wrap = el('div', 'field field-copy' + (opts.multiline ? ' multiline' : ''));
    const id = 'ui-copy-' + Math.random().toString(36).slice(2, 8);
    if (opts.label) { const l = el('label', null, opts.label); l.htmlFor = id; wrap.appendChild(l); }
    const row = el('div', 'row');
    const input = el(opts.multiline ? 'textarea' : 'input');
    input.id = id;
    input.readOnly = true;
    input.value = value;
    if (!opts.label) input.setAttribute('aria-label', opts.ariaLabel || 'Value');
    input.addEventListener('focus', () => input.select());
    const b = button(opts.copyLabel || 'Copy', '', 'copy');
    b.addEventListener('click', () => {
      input.focus();
      input.select();
      copyText(value).then((ok) => {
        if (!ok) return;
        b.lastChild.textContent = opts.copiedLabel || 'Copied';
        setTimeout(() => { b.lastChild.textContent = opts.copyLabel || 'Copy'; }, 1500);
      });
    });
    row.appendChild(input);
    row.appendChild(b);
    wrap.appendChild(row);
    wrap.input = input;
    return wrap;
  }

  function copySheet(value, opts) {
    opts = opts || {};
    const f = copyField(value, opts);
    const s = sheet({ title: opts.title || '', body: f, className: opts.className, id: opts.id });
    try { f.input.focus({ preventScroll: true }); f.input.select(); } catch (e) {}
    return s;
  }

  function tabFades(nav) {
    function fade() {
      nav.classList.toggle('fade-l', nav.scrollLeft > 1);
      nav.classList.toggle('fade-r', nav.scrollLeft + nav.clientWidth < nav.scrollWidth - 1);
    }
    nav.addEventListener('scroll', fade, { passive: true });
    window.addEventListener('resize', fade);
    fade();
  }

  // A missing stat reads as words; screen readers say "em dash" for the glyph. v is app-built, never user text.
  const KPI_NODATA = '<span class="kpi-nodata">no data</span>';
  function kpi(v, o) {
    if (v == null || v === '' || (typeof v === 'number' && !isFinite(v))) return KPI_NODATA;
    return String(v) + (o && o.pct ? '<span class="kpi-pct">%</span>' : '');
  }
  function setKpi(el, v, o) { if (!el) return; const h = kpi(v, o); if (el.innerHTML !== h) el.innerHTML = h; }
  const UPTIME_TIP = 'Share of session time with live HR data. Low numbers mean the strap dropped beats, so averages are less reliable.';
  // One stat tile (ui.css .kpi). value is HTML from kpi(); every argument is app-built. A no data value drops its unit,
  // unless o.keepUnit (a tile filled later by setKpi, where ui.css hides the unit beside no data).
  function kpiTile(key, label, value, unit, o = {}) {
    if (value === KPI_NODATA && !o.keepUnit) unit = '';
    return `<div class="kpi${o.sm ? ' sm' : ''}" data-stat="${key}"${o.title ? ` title="${o.title}"` : ''}><dt class="kpi-label">${label}</dt>` +
      `<dd class="kpi-value${o.cls ? ' ' + o.cls : ''}"${o.id ? ` id="${o.id}"` : ''}${o.vtitle ? ` title="${o.vtitle}"` : ''}${o.style ? ` style="${o.style}"` : ''}>${value}</dd>` +
      (unit ? `<dd class="kpi-unit">${unit}</dd>` : '') + '</div>';
  }

  window.UI = { icon, sheet, confirm, notice, toast, copyText, copyField, copySheet, tabFades, kpi, setKpi, kpiTile, UPTIME_TIP };
})();
