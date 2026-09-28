// Convert an extracted clip (see src/content/extract.js) into Notion page
// properties and block children, respecting Notion's request limits.

export const MAX_TEXT_LENGTH = 2000; // per rich text object
export const MAX_RICH_ITEMS = 100; // per rich_text array
export const MAX_CHILDREN = 100; // per create/append request

// LinkedIn's own favicon (the feed page's <link rel="icon">), the same icon Notion's
// Web Clipper puts on LinkedIn pages, so clipped rows look alike in the database.
export const LINKEDIN_ICON = {
  type: 'external',
  external: { url: 'https://static.licdn.com/aero-v1/sc/h/akt4ae504epesldzj74dzred8' },
};

export function validUrl(href) {
  if (!href || href.length > 2000) return null;
  try {
    const u = new URL(href);
    return /^https?:$/.test(u.protocol) ? u.href : null;
  } catch {
    return null;
  }
}

function chunkText(text, size) {
  const out = [];
  let rest = text;
  while (rest.length > size) {
    let cut = size;
    const code = rest.charCodeAt(cut - 1);
    if (code >= 0xd800 && code <= 0xdbff) cut -= 1; // don't split a surrogate pair
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest) out.push(rest);
  return out;
}

/** Segments [{text, bold, italic, underline, strike, code, href}] → Notion rich_text. */
export function toRichText(segs, { color } = {}) {
  const out = [];
  for (const s of segs || []) {
    if (!s || !s.text) continue;
    const link = validUrl(s.href);
    const annotations = {};
    if (s.bold) annotations.bold = true;
    if (s.italic) annotations.italic = true;
    if (s.underline) annotations.underline = true;
    if (s.strike) annotations.strikethrough = true;
    if (s.code) annotations.code = true;
    if (color) annotations.color = color;
    for (const content of chunkText(s.text, MAX_TEXT_LENGTH)) {
      const item = { type: 'text', text: { content } };
      if (link) item.text.link = { url: link };
      if (Object.keys(annotations).length) item.annotations = { ...annotations };
      out.push(item);
    }
  }
  return out;
}

/** One logical text block → one or more Notion blocks (rich_text is capped at 100 items). */
function textBlocks(type, segs, extra = {}) {
  const rich = toRichText(segs);
  const blocks = [];
  for (let i = 0; i < rich.length; i += MAX_RICH_ITEMS) {
    blocks.push({ object: 'block', type, [type]: { rich_text: rich.slice(i, i + MAX_RICH_ITEMS), ...extra } });
  }
  return blocks;
}

function pad(n) {
  return String(n).padStart(2, '0');
}

export function formatDate(value) {
  if (!value) return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Gray first line: author · date · link to the original. */
function metaBlock(clip) {
  const segs = [{ text: '✍️ ' }];
  if (clip.author?.name) segs.push({ text: clip.author.name, href: clip.author.url || undefined });
  else segs.push({ text: '未知作者' });
  const date = formatDate(clip.publishedAt);
  if (date) segs.push({ text: ` · ${date}` });
  if (clip.url) segs.push({ text: ' · ' }, { text: clip.kind === 'article' ? '查看原文' : '查看原帖', href: clip.url });
  return { object: 'block', type: 'paragraph', paragraph: { rich_text: toRichText(segs, { color: 'gray' }) } };
}

/**
 * Build page children. `resolveImage(block)` returns a Notion file object
 * ({type:'file_upload', ...} or {type:'external', ...}) or null to drop the image.
 */
export function buildChildren(clip, resolveImage) {
  const convert = (b) => {
    switch (b.type) {
      case 'paragraph':
        return textBlocks('paragraph', b.rich);
      case 'quote':
        return textBlocks('quote', b.rich);
      case 'heading2':
        return textBlocks('heading_2', b.rich);
      case 'heading3':
        return textBlocks('heading_3', b.rich);
      case 'bulleted':
      case 'numbered': {
        const type = b.type === 'bulleted' ? 'bulleted_list_item' : 'numbered_list_item';
        const blocks = textBlocks(type, b.rich);
        if (!blocks.length) blocks.push({ object: 'block', type, [type]: { rich_text: [] } });
        const children = (b.children || []).flatMap(convert).slice(0, MAX_CHILDREN);
        if (children.length) blocks[blocks.length - 1][type].children = children;
        return blocks;
      }
      case 'image': {
        const file = resolveImage(b);
        if (!file) return [];
        const image = { ...file };
        if (b.caption) image.caption = toRichText([{ text: b.caption }]);
        return [{ object: 'block', type: 'image', image }];
      }
      case 'bookmark': {
        const url = validUrl(b.url);
        return url ? [{ object: 'block', type: 'bookmark', bookmark: { url } }] : [];
      }
      case 'divider':
        return [{ object: 'block', type: 'divider', divider: {} }];
      case 'code':
        return [
          {
            object: 'block',
            type: 'code',
            code: { rich_text: toRichText([{ text: b.text }]).slice(0, MAX_RICH_ITEMS), language: 'plain text' },
          },
        ];
      default:
        return [];
    }
  };
  return [metaBlock(clip), ...(clip.blocks || []).flatMap(convert)];
}

function selectName(name) {
  // Select option names cannot contain commas and are capped at 100 characters.
  return Array.from(String(name).replace(/,/g, ' ').trim()).slice(0, 100).join('');
}

function choiceValue(type, name) {
  const value = { name: selectName(name) };
  return type === 'multi_select' ? { multi_select: [value] } : { select: value };
}

/**
 * Page properties. `schema` comes from summarizeSchema(); `mapping` from
 * sanitizeMapping(); `files` are uploaded images [{id, name}].
 */
export function buildProperties(clip, schema, mapping, { files = [], now = new Date() } = {}) {
  const props = {};
  const title = Array.from(clip.title || 'LinkedIn').slice(0, 200).join('');
  props[schema.titleProp] = { title: toRichText([{ text: title }]) };

  if (mapping.url && validUrl(clip.url)) props[mapping.url] = { url: clip.url };

  if (mapping.author && clip.author?.name) {
    const type = schema.props[mapping.author];
    props[mapping.author] =
      type === 'rich_text'
        ? { rich_text: toRichText([{ text: clip.author.name, href: clip.author.url || undefined }]) }
        : choiceValue(type, clip.author.name);
  }

  if (mapping.published && clip.publishedAt) props[mapping.published] = { date: { start: clip.publishedAt } };

  if (mapping.kind) {
    props[mapping.kind] = choiceValue(schema.props[mapping.kind], clip.kind === 'article' ? '文章' : '动态');
  }

  if (mapping.images && files.length) {
    props[mapping.images] = {
      files: files.slice(0, 100).map((f) => ({ type: 'file_upload', file_upload: { id: f.id }, name: f.name })),
    };
  }

  if (mapping.clipped) props[mapping.clipped] = { date: { start: now.toISOString() } };

  return props;
}

export function chunk(list, size = MAX_CHILDREN) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}
