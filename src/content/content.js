/*
 * LinkedIn → Notion Clipper: in-page UI.
 * Adds a clip button to every feed post and a floating button on articles,
 * then streams the extracted clip to the service worker over a port.
 * All UI lives in shadow roots so LinkedIn's CSS and ours never mix.
 */
(() => {
  const X = globalThis.__liClipper;
  if (!X || globalThis.__liClipperUi) return;
  globalThis.__liClipperUi = true;

  const HOST_ATTR = 'data-li-clipper';
  const results = new Map(); // card componentkey → {state, pageUrl}, survives re-renders

  // UI is built with DOM APIs only: LinkedIn enforces Trusted Types with a
  // sanitizing default policy, so HTML strings assigned to the DOM get stripped.
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const BOOKMARK = 'M6 3.5h12a1 1 0 0 1 1 1V21l-7-4.5L5 21V4.5a1 1 0 0 1 1-1z';
  const ICONS = {
    idle: { width: 1.8, shapes: [['path', { d: BOOKMARK }], ['path', { d: 'M12 7.5v6M9 10.5h6' }]] },
    loading: { width: 2, spin: true, shapes: [['path', { d: 'M12 3a9 9 0 1 1-9 9' }]] },
    done: { width: 2.2, shapes: [['path', { d: BOOKMARK }], ['path', { d: 'M8.8 10.3l2.2 2.2 4.2-4.3' }]] },
    error: { width: 2, shapes: [['circle', { cx: 12, cy: 12, r: 9 }], ['path', { d: 'M12 7.5v5.5M12 16.5v.01' }]] },
  };

  function icon(name) {
    const spec = ICONS[name] || ICONS.idle;
    const svg = document.createElementNS(SVG_NS, 'svg');
    const attrs = {
      viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': spec.width,
      'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true',
    };
    for (const [k, v] of Object.entries(attrs)) svg.setAttribute(k, String(v));
    if (spec.spin) svg.setAttribute('class', 'spin');
    for (const [tag, shapeAttrs] of spec.shapes) {
      const shape = document.createElementNS(SVG_NS, tag);
      for (const [k, v] of Object.entries(shapeAttrs)) shape.setAttribute(k, String(v));
      svg.appendChild(shape);
    }
    return svg;
  }

  /** h('div', {class, text, ...attrs}, ...children) */
  function h(tag, props = {}, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else el.setAttribute(k, v);
    }
    for (const c of children) if (c) el.append(c);
    return el;
  }

  function styleSheet(css) {
    const el = document.createElement('style');
    el.textContent = css;
    return el;
  }

  const TITLES = {
    idle: '剪藏到 Notion',
    loading: '正在剪藏…',
    done: '已剪藏 · 点击在 Notion 中打开',
    error: '剪藏失败 · 点击重试',
  };

  const BUTTON_CSS = `
    :host { display: inline-flex; align-items: center; flex: none; }
    button { all: unset; box-sizing: border-box; width: 32px; height: 32px; border-radius: 50%;
      display: inline-flex; align-items: center; justify-content: center; cursor: pointer;
      color: inherit; opacity: .72; transition: background-color .15s, opacity .15s; }
    button:hover { background: rgba(128,128,128,.16); opacity: 1; }
    button:focus-visible { outline: 2px solid #0a66c2; outline-offset: 1px; }
    button[data-state="loading"] { cursor: progress; opacity: 1; }
    button[data-state="done"] { color: #057642; opacity: 1; }
    button[data-state="error"] { color: #cc1016; opacity: 1; }
    svg { width: 20px; height: 20px; display: block; }
    .spin { animation: spin .8s linear infinite; }
    @keyframes spin { to { transform: rotate(360deg); } }
    @media (prefers-color-scheme: dark) { button[data-state="done"] { color: #5fcf8f; } button[data-state="error"] { color: #ff8080; } }
  `;

  // ---------- toasts & floating article button ----------

  let overlay = null;
  function getOverlay() {
    if (overlay && overlay.host.isConnected) return overlay;
    const host = document.createElement('div');
    host.setAttribute(HOST_ATTR, 'overlay');
    const root = host.attachShadow({ mode: 'open' });
    root.append(
      styleSheet(`
        :host { all: initial; }
        .stack { position: fixed; left: 24px; bottom: 24px; z-index: 2147483000; display: flex;
          flex-direction: column; align-items: flex-start; gap: 8px; pointer-events: none;
          font: 14px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; }
        .toast, .pill { pointer-events: auto; }
        .toast { display: flex; gap: 10px; align-items: flex-start; max-width: 380px; padding: 10px 12px;
          border-radius: 10px; background: #1d2226; color: #fff; box-shadow: 0 6px 24px rgba(0,0,0,.28);
          animation: in .18s ease-out; }
        .toast .icon { flex: none; width: 18px; height: 18px; margin-top: 1px; }
        .toast .icon svg { width: 18px; height: 18px; }
        .toast[data-kind="done"] .icon { color: #5fcf8f; }
        .toast[data-kind="error"] .icon { color: #ff8080; }
        .toast[data-kind="info"] .icon { color: #8ab4f8; }
        .body { flex: 1; min-width: 0; }
        .text { word-break: break-word; }
        .sub { color: rgba(255,255,255,.7); font-size: 12.5px; margin-top: 2px; word-break: break-word; }
        .actions { display: flex; gap: 14px; margin-top: 6px; }
        .actions button { all: unset; cursor: pointer; color: #8ab4f8; font-weight: 600; font-size: 13px; }
        .actions button:hover { text-decoration: underline; }
        .close { all: unset; cursor: pointer; color: rgba(255,255,255,.55); font-size: 16px; line-height: 1; padding: 0 2px; }
        .close:hover { color: #fff; }
        .pill { all: unset; box-sizing: border-box; cursor: pointer; display: inline-flex; align-items: center; gap: 8px;
          padding: 10px 16px; border-radius: 999px; background: #0a66c2; color: #fff; font-weight: 600;
          box-shadow: 0 6px 20px rgba(10,102,194,.35); transition: background-color .15s, transform .15s; }
        .pill:hover { background: #004182; transform: translateY(-1px); }
        .pill:focus-visible { outline: 2px solid #fff; outline-offset: 2px; }
        .pill svg { width: 18px; height: 18px; }
        .pill .spin { animation: spin .8s linear infinite; }
        .pill[data-state="done"] { background: #057642; }
        .pill[data-state="error"] { background: #cc1016; }
        @keyframes spin { to { transform: rotate(360deg); } }
        .toasts { display: flex; flex-direction: column; gap: 8px; align-items: flex-start; }
        @keyframes in { from { opacity: 0; transform: translateY(6px); } }
      `),
    );
    const toasts = h('div', { class: 'toasts' });
    const stack = h('div', { class: 'stack' }, toasts);
    root.append(stack);
    document.documentElement.appendChild(host);
    overlay = { host, root, stack, toasts, pill: null };
    return overlay;
  }

  /** Show or update a toast. Returns a handle with update() and close(). */
  function toast({ kind = 'info', text, sub, actions = [], timeout }) {
    const { toasts } = getOverlay();
    const el = document.createElement('div');
    el.className = 'toast';
    toasts.appendChild(el);
    let timer = null;
    const handle = {
      update(next) {
        const k = next.kind || kind;
        el.dataset.kind = k;
        const bar = (next.actions || []).length ? h('div', { class: 'actions' }) : null;
        for (const a of next.actions || []) {
          const b = h('button', { type: 'button', text: a.label });
          b.addEventListener('click', () => {
            a.onClick();
            if (a.close !== false) handle.close();
          });
          bar.appendChild(b);
        }
        const close = h('button', { type: 'button', class: 'close', title: '关闭', text: '×' });
        close.addEventListener('click', () => handle.close());
        el.replaceChildren(
          h('span', { class: 'icon' }, icon(k === 'done' ? 'done' : k === 'error' ? 'error' : 'loading')),
          h(
            'div',
            { class: 'body' },
            h('div', { class: 'text', text: next.text }),
            next.sub ? h('div', { class: 'sub', text: next.sub }) : null,
            bar,
          ),
          close,
        );
        clearTimeout(timer);
        if (next.timeout) timer = setTimeout(() => handle.close(), next.timeout);
        return handle;
      },
      close() {
        clearTimeout(timer);
        el.remove();
      },
    };
    return handle.update({ kind, text, sub, actions, timeout });
  }

  function openUrl(url) {
    window.open(url, '_blank', 'noopener');
  }

  function openOptions() {
    try {
      chrome.runtime.sendMessage({ type: 'open-options' });
    } catch {
      // extension reloaded; nothing to do
    }
  }

  // ---------- clipping ----------

  /**
   * Send a clip to the service worker. `view` renders state changes for the
   * button that started it: view(state, pageUrl?).
   */
  function sendClip(clip, view, { force = false } = {}) {
    const t = toast({ kind: 'info', text: '正在剪藏到 Notion…', sub: clip.title });
    view('loading');

    let port;
    try {
      port = chrome.runtime.connect({ name: 'clip' });
    } catch {
      view('error');
      t.update({ kind: 'error', text: '扩展已更新，请刷新页面后再试。', timeout: 8000 });
      return;
    }
    let finished = false;
    port.onMessage.addListener((msg) => {
      if (msg.type === 'progress') {
        t.update({ kind: 'info', text: '正在剪藏到 Notion…', sub: msg.text });
        return;
      }
      finished = true;
      port.disconnect();
      if (msg.type === 'done') {
        view('done', msg.pageUrl);
        const extra = msg.imageCount ? `（含 ${msg.imageCount} 张图片）` : '';
        t.update({
          kind: 'done',
          text: `已保存到 Notion${extra}`,
          sub: msg.warnings?.length ? msg.warnings.join('；') : clip.title,
          actions: [{ label: '打开', onClick: () => openUrl(msg.pageUrl) }],
          timeout: msg.warnings?.length ? 12000 : 6000,
        });
      } else if (msg.type === 'duplicate') {
        view('done', msg.pageUrl);
        t.update({
          kind: 'done',
          text: '这条之前已经剪藏过了',
          sub: clip.title,
          actions: [
            { label: '打开', onClick: () => openUrl(msg.pageUrl) },
            { label: '再存一份', onClick: () => sendClip(clip, view, { force: true }) },
          ],
          timeout: 10000,
        });
      } else {
        view('error');
        const setup = msg.code === 'not_configured' || msg.code === 'needs_setup';
        t.update({
          kind: 'error',
          text: '剪藏失败',
          sub: msg.message,
          actions: setup
            ? [{ label: '打开设置', onClick: openOptions }]
            : [{ label: '重试', onClick: () => sendClip(clip, view, { force }) }],
        });
      }
    });
    port.onDisconnect.addListener(() => {
      if (finished) return;
      view('error');
      t.update({ kind: 'error', text: '与扩展的连接中断，请重试。', timeout: 8000 });
    });
    port.postMessage({ type: 'clip', clip, force });
  }

  function extractOrReport(fn) {
    try {
      const clip = fn();
      if (!clip || !clip.blocks.length) {
        toast({ kind: 'error', text: '没有找到可剪藏的内容', timeout: 5000 });
        return null;
      }
      return clip;
    } catch (err) {
      console.error('[LinkedIn → Notion] extraction failed', err);
      toast({ kind: 'error', text: '读取页面内容失败', sub: String(err?.message || err), timeout: 8000 });
      return null;
    }
  }

  function clipCard(card) {
    const host = card.querySelector(`[${HOST_ATTR}="button"]`);
    const view = (state, pageUrl) => {
      const key = cardKey(card);
      if (state === 'done') results.set(key, { state, pageUrl });
      else if (state !== 'loading') results.delete(key);
      if (host) setButtonState(host, state, pageUrl);
    };
    const clip = extractOrReport(() => X.extractPost(card));
    if (!clip) return;
    sendClip(clip, view);
  }

  function clipArticle() {
    const clip = extractOrReport(() => X.extractArticle());
    if (!clip) return;
    const pill = getOverlay().pill;
    sendClip(clip, (state, pageUrl) => pill && setPillState(pill, state, pageUrl));
  }

  // ---------- per-post buttons ----------

  function cardKey(card) {
    return card.getAttribute('componentkey') || '';
  }

  function setButtonState(host, state, pageUrl) {
    const btn = host.shadowRoot.querySelector('button');
    btn.dataset.state = state;
    btn.replaceChildren(icon(state));
    btn.title = TITLES[state] || TITLES.idle;
    btn.setAttribute('aria-label', btn.title);
    if (pageUrl) host.dataset.pageUrl = pageUrl;
  }

  function makeButton(card) {
    const host = document.createElement('span');
    host.setAttribute(HOST_ATTR, 'button');
    const root = host.attachShadow({ mode: 'open' });
    root.append(styleSheet(BUTTON_CSS), h('button', { type: 'button' }));
    const saved = results.get(cardKey(card));
    setButtonState(host, saved?.state || 'idle', saved?.pageUrl);
    root.querySelector('button').addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const state = root.querySelector('button').dataset.state;
      if (state === 'loading') return;
      if (state === 'done' && host.dataset.pageUrl && !e.shiftKey) {
        openUrl(host.dataset.pageUrl);
        return;
      }
      clipCard(card);
    });
    return host;
  }

  /** The "…" menu button in the card's top-right corner (found by geometry, not class names). */
  function findHeaderControl(card) {
    const cr = card.getBoundingClientRect();
    if (!cr.width || !cr.height) return null;
    const candidates = [];
    for (const b of card.querySelectorAll('button')) {
      if (X.isExcluded(b, card) || b.closest(`[${HOST_ATTR}]`)) continue;
      const r = b.getBoundingClientRect();
      if (r.width < 20 || r.width > 48 || r.height < 20 || r.height > 48) continue;
      if (r.top - cr.top > 72 || cr.right - r.right > 100) continue;
      candidates.push({ b, left: r.left });
    }
    candidates.sort((a, b) => a.left - b.left);
    return candidates[0]?.b || null;
  }

  function hasClippableContent(card) {
    return Boolean(card.querySelector(`${X.TEXT_BOX_SELECTOR}, img[src*="media.licdn.com/dms/image"]`));
  }

  function inViewport(el) {
    const r = el.getBoundingClientRect();
    return r.height > 0 && r.bottom > 0 && r.top < window.innerHeight;
  }

  function ensureButton(card) {
    if (card.querySelector(`[${HOST_ATTR}="button"]`) || !hasClippableContent(card)) return;
    const control = findHeaderControl(card);
    if (control) {
      const host = makeButton(card);
      host.style.marginTop = getComputedStyle(control).marginTop; // sit on the same line as "…"
      control.parentElement.insertBefore(host, control);
      return;
    }
    // Layout without a recognizable menu button: pin to the top-right corner once visible.
    if (!inViewport(card)) return;
    const host = makeButton(card);
    if (getComputedStyle(card).position === 'static') card.style.position = 'relative';
    Object.assign(host.style, { position: 'absolute', top: '10px', right: '84px', zIndex: '2' });
    card.appendChild(host);
  }

  // ---------- floating article button ----------

  function setPillState(pill, state, pageUrl) {
    pill.dataset.state = state;
    const label = { idle: '剪藏文章到 Notion', loading: '正在剪藏…', done: '已剪藏 · 打开', error: '剪藏失败 · 重试' }[state];
    pill.replaceChildren(icon(state), h('span', { text: label }));
    if (pageUrl) pill.dataset.pageUrl = pageUrl;
  }

  function ensureArticlePill() {
    const ov = X.isArticlePage() ? getOverlay() : overlay;
    if (!ov) return;
    if (!X.isArticlePage()) {
      ov.pill?.remove();
      ov.pill = null;
      return;
    }
    if (ov.pill) return;
    const pill = document.createElement('button');
    pill.className = 'pill';
    pill.type = 'button';
    setPillState(pill, 'idle');
    pill.addEventListener('click', () => {
      if (pill.dataset.state === 'loading') return;
      if (pill.dataset.state === 'done' && pill.dataset.pageUrl) openUrl(pill.dataset.pageUrl);
      else clipArticle();
    });
    ov.stack.appendChild(pill);
    ov.pill = pill;
  }

  // ---------- toolbar button ----------

  function mostVisibleCard(cards) {
    let best = null;
    let bestArea = 0;
    for (const c of cards) {
      const r = c.getBoundingClientRect();
      const visible = Math.min(r.bottom, window.innerHeight) - Math.max(r.top, 0);
      if (visible > bestArea) {
        bestArea = visible;
        best = c;
      }
    }
    return best;
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type !== 'clip-active') return;
    if (X.isArticlePage()) {
      clipArticle();
      return;
    }
    const cards = X.findCards().filter(hasClippableContent);
    const card = cards.length === 1 ? cards[0] : mostVisibleCard(cards);
    if (card) clipCard(card);
    else toast({ kind: 'error', text: '当前页面没有找到可剪藏的动态或文章', timeout: 5000 });
  });

  // ---------- keep buttons in place as LinkedIn re-renders ----------

  let scheduled = false;
  function scan() {
    scheduled = false;
    for (const card of X.findCards()) ensureButton(card);
    ensureArticlePill();
  }
  function schedule() {
    if (scheduled) return;
    scheduled = true;
    setTimeout(scan, 300);
  }
  new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true });
  window.addEventListener('scroll', schedule, { passive: true });
  scan();
})();
