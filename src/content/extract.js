/*
 * LinkedIn → Notion Clipper: DOM extraction.
 *
 * Pure DOM code with no extension APIs, so the same file can be injected into a
 * page for testing. LinkedIn's feed uses hashed class names that change on every
 * deploy, so post selectors rely only on roles, data-testid, componentkey and
 * media URL patterns (verified against the live site, 2026-09). Article pages
 * (/pulse/) still use the stable `reader-*` class names.
 *
 * Output ("clip") shape, consumed by src/lib/blocks.js:
 *   { kind: 'post'|'article', url, urn, title, author: {name, url}, publishedAt, blocks: [...] }
 * where each block is one of
 *   {type:'paragraph'|'quote'|'heading2'|'heading3', rich}
 *   {type:'bulleted'|'numbered', rich, children}
 *   {type:'image', sources:[url, ...largest first], caption, key}
 *   {type:'bookmark', url} | {type:'divider'} | {type:'code', text}
 * and `rich` is an array of {text, bold?, italic?, underline?, strike?, code?, href?}.
 */
(() => {
  const CARD_SELECTOR = '[role="listitem"][componentkey^="update-card"]';
  const TEXT_BOX_SELECTOR = '[data-testid="expandable-text-box"]';
  const COMMENTARY_KEY_SELECTOR = '[componentkey^="translatable-commentary"]';
  // Comment threads rendered inside a card. Checked only between a node and its
  // card, because on the post detail page the comments container wraps the card.
  const EXCLUDED_ZONE_SELECTOR = [
    '[data-testid*="commentList"]',
    '[componentkey*="commentList"]',
    '[componentkey*="CommentsContainer"]',
  ].join(',');
  const ENTITY_LINK_SELECTOR =
    'a[href*="/in/"], a[href*="/company/"], a[href*="/school/"], a[href*="/showcase/"]';
  const NON_CONTENT_IMAGE_RE =
    /profile-displayphoto|profile-framedphoto|profile-displaybackgroundimage|[-_]logo[-_]|emoji/i;

  const SKIP_TAGS = new Set([
    'BUTTON', 'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG', 'svg', 'IMG', 'IFRAME', 'VIDEO',
    'INPUT', 'TEXTAREA', 'SELECT',
  ]);
  const INLINE_BLOCK_TAGS = new Set([
    'P', 'DIV', 'LI', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'BLOCKQUOTE', 'PRE', 'FIGCAPTION', 'SECTION',
  ]);
  const INLINE_TAGS = new Set([
    'A', 'SPAN', 'STRONG', 'B', 'EM', 'I', 'U', 'S', 'DEL', 'STRIKE', 'CODE', 'MARK', 'SUB', 'SUP',
    'SMALL', 'BR', 'ABBR', 'CITE', 'Q', 'TIME', 'LABEL',
  ]);

  // ---------- generic helpers ----------

  function isExcluded(node, card) {
    let el = node.nodeType === 1 ? node : node.parentElement;
    while (el && el !== card) {
      if (el.matches(EXCLUDED_ZONE_SELECTOR)) return true;
      el = el.parentElement;
    }
    return false;
  }

  function precedes(a, b) {
    return Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
  }

  function firstLine(text) {
    return (
      String(text || '')
        .split('\n')
        .map((s) => s.replace(/\s+/g, ' ').trim())
        .find(Boolean) || ''
    );
  }

  function absoluteUrl(href) {
    try {
      return new URL(href, location.href).href;
    } catch {
      return null;
    }
  }

  function isLinkedInHost(hostname) {
    return /(^|\.)linkedin\.com$/i.test(hostname);
  }

  /** Resolve LinkedIn's /safety/go redirect wrapper and make links absolute. */
  function cleanLink(href) {
    if (!href) return null;
    const abs = absoluteUrl(href);
    if (!abs) return null;
    const u = new URL(abs);
    if (!/^https?:$/.test(u.protocol)) return null;
    if (isLinkedInHost(u.hostname) && u.pathname.startsWith('/safety/go')) {
      const target = u.searchParams.get('url');
      return target && /^https?:\/\//i.test(target) ? target : null;
    }
    return u.href;
  }

  /** Links worth bookmarking: external sites plus LinkedIn articles/newsletters/events. */
  function contentLink(href) {
    const link = cleanLink(href);
    if (!link) return null;
    const u = new URL(link);
    if (!isLinkedInHost(u.hostname)) return link;
    if (/^\/(pulse|newsletters|events)\//.test(u.pathname)) return u.origin + u.pathname;
    return null;
  }

  function stripQuery(href) {
    const abs = absoluteUrl(href);
    if (!abs) return null;
    const u = new URL(abs);
    return u.origin + u.pathname;
  }

  /** Company links in the feed point at /company/x/posts/; keep the profile root. */
  function profileUrl(href) {
    const url = stripQuery(href);
    return url && url.replace(/\/(posts|recent-activity\/[^/]*)\/?$/, '/');
  }

  // ---------- rich text ----------

  function sameMarks(a, b) {
    return (
      !!a.bold === !!b.bold &&
      !!a.italic === !!b.italic &&
      !!a.underline === !!b.underline &&
      !!a.strike === !!b.strike &&
      !!a.code === !!b.code &&
      (a.href || null) === (b.href || null)
    );
  }

  function mergeSegments(segs) {
    const out = [];
    for (const s of segs) {
      if (!s.text) continue;
      const prev = out[out.length - 1];
      if (prev && sameMarks(prev, s)) prev.text += s.text;
      else out.push({ ...s });
    }
    return out;
  }

  /** Merge, then trim whitespace at both ends of the run. */
  function cleanRich(segs) {
    const out = mergeSegments(segs);
    while (out.length && !out[0].text.trim()) out.shift();
    while (out.length && !out[out.length - 1].text.trim()) out.pop();
    if (out.length) {
      out[0].text = out[0].text.replace(/^\s+/, '');
      out[out.length - 1].text = out[out.length - 1].text.replace(/\s+$/, '');
    }
    return out.filter((s) => s.text);
  }

  /**
   * Walk inline content into rich-text segments. <br> and block-level children
   * become "\n". In 'article' mode HTML whitespace is collapsed; in 'post' mode
   * text is kept verbatim (LinkedIn encodes post line breaks as <br>).
   */
  function collectInline(nodes, mode, { skipLists = false } = {}) {
    const out = [];
    const endsWithNewline = () => {
      const last = out[out.length - 1];
      return !last || last.text.endsWith('\n');
    };
    const walk = (node, marks) => {
      if (node.nodeType === Node.TEXT_NODE) {
        let t = node.nodeValue.replace(/\r/g, '');
        if (mode === 'article') t = t.replace(/\s+/g, ' ');
        if (t) out.push({ ...marks, text: t });
        return;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return;
      const tag = node.tagName;
      if (SKIP_TAGS.has(tag)) return;
      if (skipLists && (tag === 'UL' || tag === 'OL')) return;
      if (tag === 'BR') {
        out.push({ ...marks, text: '\n' });
        return;
      }
      const m = { ...marks };
      // LinkedIn wraps every link's text in <strong>; that is link styling, not emphasis.
      if ((tag === 'STRONG' || tag === 'B') && !marks.href) m.bold = true;
      else if (tag === 'EM' || tag === 'I' || tag === 'CITE') m.italic = true;
      else if (tag === 'U') m.underline = true;
      else if (tag === 'S' || tag === 'DEL' || tag === 'STRIKE') m.strike = true;
      else if (tag === 'CODE') m.code = true;
      else if (tag === 'A') {
        const h = cleanLink(node.getAttribute('href'));
        if (h) m.href = h;
      }
      const isBlock = INLINE_BLOCK_TAGS.has(tag);
      if (isBlock && !endsWithNewline()) out.push({ text: '\n' });
      for (const c of node.childNodes) walk(c, m);
      if (isBlock && !endsWithNewline()) out.push({ text: '\n' });
    };
    for (const n of nodes) walk(n, {});
    return out;
  }

  /** Split segments into paragraphs at blank lines; single newlines stay inside. */
  function splitParagraphs(segs) {
    const paras = [];
    let cur = [];
    let newlines = 0;
    const flushNewlines = () => {
      if (newlines >= 2) {
        const p = cleanRich(cur);
        if (p.length) paras.push(p);
        cur = [];
      } else if (newlines === 1 && cur.length) {
        cur.push({ text: '\n' });
      }
      newlines = 0;
    };
    for (const s of segs) {
      const parts = s.text.split('\n');
      parts.forEach((part, i) => {
        if (i > 0) newlines++;
        if (!part) return;
        if (!part.trim() && newlines > 0) return; // whitespace on an otherwise blank line
        flushNewlines();
        cur.push({ ...s, text: part });
      });
    }
    const p = cleanRich(cur);
    if (p.length) paras.push(p);
    return paras;
  }

  function plainText(rich) {
    return rich.map((s) => s.text).join('');
  }

  // ---------- images ----------

  function imageSources(img) {
    if (img.getAttribute('data-media-error')) return [];
    const cands = [];
    const add = (url, w) => {
      if (!url || !/^https?:\/\//i.test(url)) return;
      if (!cands.some((c) => c.url === url)) cands.push({ url, w });
    };
    const srcset = img.getAttribute('srcset') || img.getAttribute('data-srcset') || '';
    for (const part of srcset.split(/,\s+(?=https?:)/)) {
      const m = part.trim().match(/^(\S+)\s+(\d+)w$/);
      if (m) add(m[1], Number(m[2]));
    }
    add(img.currentSrc || img.getAttribute('src'), img.naturalWidth || 0);
    add(img.getAttribute('data-delayed-url'), 0);
    add(img.getAttribute('data-li-src'), 0);
    add(img.getAttribute('data-src'), 0);
    cands.sort((a, b) => b.w - a.w);
    const usable = cands.filter((c) => c.w === 0 || c.w >= 300);
    return (usable.length ? usable : cands).map((c) => c.url);
  }

  function isContentImageUrl(url) {
    return /media\.licdn\.com\/dms\/image\//.test(url) && !NON_CONTENT_IMAGE_RE.test(url);
  }

  function documentPage(url) {
    const m = url.match(/feedshare-document[^/]*\/[^/]+\/(\d+)\//);
    return m ? Number(m[1]) : null;
  }

  /** Stable key for one picture across its srcset sizes (document pages share an id). */
  function mediaKey(url) {
    const id = (url.match(/\/v2\/([^/]+)\//) || [])[1];
    const page = documentPage(url);
    if (id) return page ? `${id}-p${page}` : id;
    return url.split('?')[0];
  }

  // ---------- posts ----------

  function urnFromCommentaryKey(key) {
    const share = key.match(/contentUrnShareUrn=ContentUrnShareUrn\([^)]*?(\d{12,})/);
    if (share) return `urn:li:share:${share[1]}`;
    const ugc = key.match(/contentUrnUgcPostUrn=ContentUrnUgcPostUrn\([^)]*?(\d{12,})/);
    if (ugc) return `urn:li:ugcPost:${ugc[1]}`;
    const group = key.match(/contentUrnGroupPostUrn=ContentUrnGroupPostUrn\((.*?)\)\)/);
    if (group) {
      const nums = (group[1].match(/\d+/g) || []).sort((a, b) => a.length - b.length);
      if (nums.length >= 2) return `urn:li:groupPost:${nums[0]}-${nums[nums.length - 1]}`;
    }
    return null;
  }

  function commentaryUrns(card) {
    return [...card.querySelectorAll(COMMENTARY_KEY_SELECTOR)]
      .filter((el) => !isExcluded(el, card))
      .map((el) => urnFromCommentaryKey(el.getAttribute('componentkey')))
      .filter(Boolean);
  }

  function urnFromLocation() {
    const m = decodeURIComponent(location.pathname).match(
      /urn:li:(?:activity|share|ugcPost|groupPost):[\w-]+/,
    );
    return m ? m[0] : null;
  }

  function getPostUrn(card) {
    const urns = commentaryUrns(card);
    if (urns.length) return urns[0];
    // Posts without text have no commentary key; on a detail page the URL has it.
    if (document.querySelectorAll(CARD_SELECTOR).length === 1) return urnFromLocation();
    return null;
  }

  /** LinkedIn post ids are snowflake-like: the top 41 bits are a Unix ms timestamp. */
  function publishedAtFromUrn(urn) {
    const id = (String(urn || '').match(/(\d{15,})$/) || [])[1];
    if (!id) return null;
    try {
      const ms = Number(BigInt(id) >> 22n);
      if (ms < Date.UTC(2003, 0, 1) || ms > Date.now() + 86400000) return null;
      return new Date(ms).toISOString();
    } catch {
      return null;
    }
  }

  /** The author is the last profile/company link that precedes the given node. */
  function authorBefore(card, node, after = null) {
    let best = null;
    for (const a of card.querySelectorAll(ENTITY_LINK_SELECTOR)) {
      if (isExcluded(a, card)) continue;
      if (node && !precedes(a, node)) break;
      if (after && !precedes(after, a)) continue;
      if (firstLine(a.innerText)) best = a;
    }
    if (!best) return null;
    return {
      name: firstLine(best.innerText).split('•')[0].trim(),
      url: profileUrl(best.getAttribute('href')),
    };
  }

  function makeTitle(text, fallback) {
    const chars = Array.from(firstLine(text)); // code points: never split an emoji
    if (!chars.length) return fallback;
    return chars.length > 100 ? `${chars.slice(0, 99).join('')}…` : chars.join('');
  }

  function extractPost(card) {
    const nodes = [...card.querySelectorAll(`${TEXT_BOX_SELECTOR}, img`)].filter(
      (n) => !isExcluded(n, card),
    );
    const textBoxes = nodes.filter((n) => n.matches(TEXT_BOX_SELECTOR));
    const firstBox = textBoxes[0] || null;
    const firstImage = nodes.find((n) => n.tagName === 'IMG' && !n.closest(TEXT_BOX_SELECTOR));
    const author = authorBefore(card, firstBox || firstImage) || { name: '', url: null };

    const blocks = [];
    const seenImages = new Set();
    const seenLinks = new Set();
    let mainText = '';
    let prevBox = null;
    let hasDocument = false;

    for (const n of nodes) {
      if (n.matches(TEXT_BOX_SELECTOR)) {
        const paras = splitParagraphs(collectInline(n.childNodes, 'post'));
        if (!prevBox) {
          mainText = paras.map(plainText).join('\n');
          for (const rich of paras) blocks.push({ type: 'paragraph', rich });
        } else {
          // A second commentary box is the original post inside a quote-repost.
          const original = authorBefore(card, n, prevBox);
          blocks.push({
            type: 'paragraph',
            rich: [
              { text: '🔁 转发自 ' },
              original
                ? { text: original.name || '原帖', bold: true, href: original.url || undefined }
                : { text: '原帖', bold: true },
            ],
          });
          for (const rich of paras) blocks.push({ type: 'quote', rich });
        }
        prevBox = n;
        continue;
      }
      if (n.closest(TEXT_BOX_SELECTOR)) continue;

      const sources = imageSources(n).filter(isContentImageUrl);
      if (!sources.length) continue;
      const key = mediaKey(sources[0]);
      if (seenImages.has(key)) continue;
      seenImages.add(key);

      const anchor = n.closest('a[href]');
      const link = anchor ? contentLink(anchor.getAttribute('href')) : null;
      const page = documentPage(sources[0]);
      let caption = '';
      if (/videocover|play-button|\/video-/i.test(sources[0])) caption = '🎬 视频封面（视频请在原帖观看）';
      else if (page) {
        caption = hasDocument ? `📄 第 ${page} 页` : `📄 文档第 ${page} 页（仅保存页面上已加载的页）`;
        hasDocument = true;
      } else if (link && anchor) caption = firstLine(anchor.innerText);
      blocks.push({ type: 'image', sources, caption, key });
      if (link && !seenLinks.has(link)) {
        seenLinks.add(link);
        blocks.push({ type: 'bookmark', url: link });
      }
    }

    // Link previews without a thumbnail: external links after the commentary.
    if (firstBox) {
      for (const a of card.querySelectorAll('a[href]')) {
        if (isExcluded(a, card) || a.closest(TEXT_BOX_SELECTOR) || !precedes(firstBox, a)) continue;
        const link = contentLink(a.getAttribute('href'));
        if (!link || seenLinks.has(link)) continue;
        seenLinks.add(link);
        blocks.push({ type: 'bookmark', url: link });
      }
    }

    const urn = getPostUrn(card);
    return {
      kind: 'post',
      urn,
      url: urn ? `https://www.linkedin.com/feed/update/${urn}/` : null,
      title: makeTitle(mainText, author.name ? `${author.name} 的动态` : 'LinkedIn 动态'),
      author,
      publishedAt: publishedAtFromUrn(urn),
      blocks,
    };
  }

  // ---------- articles ----------

  function parseLocalizedDate(text) {
    const t = String(text || '').trim();
    if (!t) return null;
    const pad = (n) => String(n).padStart(2, '0');
    const zh = t.match(/(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/);
    if (zh) return `${zh[1]}-${pad(zh[2])}-${pad(zh[3])}`;
    const iso = t.match(/(\d{4})-(\d{2})-(\d{2})/);
    if (iso) return iso[0];
    const ms = Date.parse(t);
    if (!Number.isNaN(ms)) {
      const d = new Date(ms);
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    }
    return null;
  }

  function articleBlocks(root) {
    const blocks = [];
    let pending = [];

    const flush = () => {
      if (!pending.length) return;
      for (const rich of splitParagraphs(collectInline(pending, 'article'))) {
        blocks.push({ type: 'paragraph', rich });
      }
      pending = [];
    };
    const pushImage = (img, caption) => {
      const sources = imageSources(img);
      if (!sources.length) return;
      blocks.push({ type: 'image', sources, caption: caption || '', key: mediaKey(sources[0]) });
    };
    const pushIframe = (frame) => {
      const src = cleanLink(frame.getAttribute('src') || frame.getAttribute('data-src'));
      if (src && !/chartbeat/i.test(src + frame.className)) blocks.push({ type: 'bookmark', url: src });
    };
    const listItems = (list, depth) => {
      const type = list.tagName === 'OL' ? 'numbered' : 'bulleted';
      const out = [];
      for (const li of list.children) {
        if (li.tagName !== 'LI') continue;
        const rich = cleanRich(collectInline(li.childNodes, 'article', { skipLists: true }));
        const nested = [...li.children]
          .filter((c) => c.tagName === 'UL' || c.tagName === 'OL')
          .flatMap((l) => listItems(l, depth + 1));
        // Notion accepts limited nesting per request; keep one level, flatten the rest.
        if (depth === 0) out.push({ type, rich, children: nested });
        else out.push({ type, rich, children: [] }, ...nested);
      }
      return out;
    };

    const visit = (node) => {
      if (node.nodeType === Node.TEXT_NODE) {
        if (node.nodeValue.trim()) pending.push(node);
        return;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return;
      const tag = node.tagName;
      if (node.getAttribute('aria-hidden') === 'true') return;
      switch (tag) {
        case 'SCRIPT':
        case 'STYLE':
        case 'NOSCRIPT':
        case 'TEMPLATE':
        case 'BUTTON':
        case 'SVG':
        case 'svg':
          return;
        case 'P': {
          flush();
          pending = [...node.childNodes];
          flush();
          node.querySelectorAll('img').forEach((img) => pushImage(img, ''));
          return;
        }
        case 'H1':
        case 'H2':
        case 'H3':
        case 'H4':
        case 'H5':
        case 'H6': {
          flush();
          const rich = cleanRich(collectInline(node.childNodes, 'article'));
          if (rich.length) blocks.push({ type: tag === 'H1' || tag === 'H2' ? 'heading2' : 'heading3', rich });
          return;
        }
        case 'UL':
        case 'OL':
          flush();
          blocks.push(...listItems(node, 0));
          return;
        case 'BLOCKQUOTE': {
          flush();
          const rich = cleanRich(collectInline(node.childNodes, 'article'));
          if (rich.length) blocks.push({ type: 'quote', rich });
          return;
        }
        case 'PRE': {
          flush();
          const text = node.innerText.replace(/\s+$/, '');
          if (text) blocks.push({ type: 'code', text });
          return;
        }
        case 'HR':
          flush();
          blocks.push({ type: 'divider' });
          return;
        case 'FIGURE': {
          flush();
          const caption = firstLine(node.querySelector('figcaption')?.innerText);
          const imgs = [...node.querySelectorAll('img')];
          const frames = [...node.querySelectorAll('iframe')];
          imgs.forEach((img, i) => pushImage(img, i === 0 ? caption : ''));
          frames.forEach(pushIframe);
          if (!imgs.length && !frames.length) [...node.childNodes].forEach(visit);
          return;
        }
        case 'IMG':
          flush();
          pushImage(node, '');
          return;
        case 'IFRAME':
          flush();
          pushIframe(node);
          return;
        default:
          if (INLINE_TAGS.has(tag)) {
            pending.push(node);
            return;
          }
          flush();
          [...node.childNodes].forEach(visit);
          flush();
      }
    };

    [...root.childNodes].forEach(visit);
    flush();
    return blocks;
  }

  function extractArticle(doc = document) {
    const content = doc.querySelector('.reader-article-content');
    if (!content) return null;
    const title =
      firstLine(doc.querySelector('.reader-article-header__title')?.innerText) ||
      doc.title.replace(/^\(\d+\)\s*/, '').replace(/\s*\|\s*LinkedIn\s*$/i, '');
    const info = doc.querySelector('.reader-author-info__container');
    const authorLink = info?.querySelector(ENTITY_LINK_SELECTOR);
    const authorName =
      firstLine(doc.querySelector('.reader-author-info__author-lockup--flex')?.innerText) ||
      firstLine(authorLink?.innerText);
    const time = info?.querySelector('time') || doc.querySelector('main time, time');

    const blocks = [];
    const cover = doc.querySelector('.reader-cover-image__img');
    if (cover) {
      const sources = imageSources(cover);
      if (sources.length) {
        const caption = firstLine(doc.querySelector('.reader-cover-image__caption')?.innerText);
        blocks.push({ type: 'image', sources, caption, key: mediaKey(sources[0]), cover: true });
      }
    }
    blocks.push(...articleBlocks(content));

    return {
      kind: 'article',
      urn: null,
      url: location.origin + location.pathname,
      title: title || 'LinkedIn 文章',
      author: {
        name: (authorName || '').split('•')[0].trim(),
        url: authorLink ? profileUrl(authorLink.getAttribute('href')) : null,
      },
      publishedAt: parseLocalizedDate(time?.getAttribute('datetime') || time?.innerText),
      blocks,
    };
  }

  function isArticlePage() {
    return /^\/pulse\//.test(location.pathname) && !!document.querySelector('.reader-article-content');
  }

  function findCards(root = document) {
    return [...root.querySelectorAll(CARD_SELECTOR)];
  }

  globalThis.__liClipper = {
    CARD_SELECTOR,
    TEXT_BOX_SELECTOR,
    findCards,
    extractPost,
    extractArticle,
    isArticlePage,
    getPostUrn,
    isExcluded,
    // exposed for tests
    _internal: { splitParagraphs, collectInline, urnFromCommentaryKey, publishedAtFromUrn, parseLocalizedDate, imageSources, mediaKey, cleanLink },
  };
})();
