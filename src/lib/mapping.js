// Which clip fields go into which Notion database properties.

/** Clip fields that can be written to database properties (the title is always filled). */
export const FIELDS = [
  {
    key: 'url',
    label: '原帖链接',
    types: ['url'],
    names: ['链接', '原帖链接', '原文链接', '网址', '来源', 'url', 'link', 'source', 'source url'],
    recommended: { name: '链接', schema: { url: {} } },
  },
  {
    key: 'author',
    label: '作者',
    types: ['rich_text', 'select', 'multi_select'],
    names: ['作者', '发布者', 'author', 'by', 'creator', 'poster'],
    recommended: { name: '作者', schema: { rich_text: {} } },
  },
  {
    key: 'published',
    label: '发布时间',
    types: ['date'],
    names: ['发布时间', '发布日期', '发表时间', 'published', 'publish date', 'posted', 'date', '日期'],
    recommended: { name: '发布时间', schema: { date: {} } },
  },
  {
    key: 'kind',
    label: '类型（动态/文章）',
    types: ['select', 'multi_select'],
    names: ['类型', '分类', 'type', 'kind', 'category', 'format'],
    recommended: {
      name: '类型',
      schema: {
        select: {
          options: [
            { name: '动态', color: 'blue' },
            { name: '文章', color: 'green' },
          ],
        },
      },
    },
  },
  {
    key: 'images',
    label: '图片（文件属性）',
    types: ['files'],
    names: ['图片', '配图', '附件', '媒体', 'images', 'image', 'media', 'files', 'attachments'],
    recommended: { name: '图片', schema: { files: {} } },
  },
  {
    key: 'clipped',
    label: '剪藏时间',
    types: ['date'],
    names: ['剪藏时间', '收藏时间', '保存时间', 'clipped', 'saved', 'clipped at', 'saved at'],
    recommended: null, // the recommended schema uses an automatic created_time property instead
  },
];

/** Extra recommended property that Notion fills by itself. */
export const AUTO_PROPERTIES = { 剪藏时间: { created_time: {} } };

/** Reduce a data source object to {title, titleProp, props: {name: type}}. */
export function summarizeSchema(dataSource) {
  const props = {};
  let titleProp = null;
  for (const [name, p] of Object.entries(dataSource.properties || {})) {
    props[name] = p.type;
    if (p.type === 'title') titleProp = name;
  }
  const title = (dataSource.title || []).map((t) => t.plain_text ?? t.text?.content ?? '').join('');
  return { title, titleProp, props };
}

const norm = (s) => String(s).trim().toLowerCase();

/** Pick a property for each field by name, then by unique type. Never reuse a property. */
export function guessMapping(schema, current = {}) {
  const used = new Set();
  const mapping = {};
  const entries = Object.entries(schema.props);
  // Keep still-valid existing choices first.
  for (const f of FIELDS) {
    const name = current[f.key];
    if (name && f.types.includes(schema.props[name]) && !used.has(name)) {
      mapping[f.key] = name;
      used.add(name);
    }
  }
  for (const f of FIELDS) {
    if (mapping[f.key] || current[f.key] === null) continue; // null = user chose "don't fill"
    const candidates = entries.filter(([n, t]) => f.types.includes(t) && !used.has(n));
    let hit =
      candidates.find(([n]) => f.names.includes(norm(n))) ||
      candidates.find(([n]) => f.names.some((x) => x.length > 2 && norm(n).includes(x)));
    if (!hit && (f.key === 'url' || f.key === 'images') && candidates.length === 1) hit = candidates[0];
    if (hit) {
      mapping[f.key] = hit[0];
      used.add(hit[0]);
    }
  }
  return mapping;
}

/** Drop mappings whose property vanished or changed type since it was configured. */
export function sanitizeMapping(mapping, schema) {
  const out = {};
  for (const f of FIELDS) {
    const name = mapping?.[f.key];
    if (name && f.types.includes(schema.props[name])) out[f.key] = name;
  }
  return out;
}

/** Properties to add so every field has a home. Skips fields that are already mapped. */
export function missingRecommended(schema, mapping) {
  const add = {};
  for (const f of FIELDS) {
    if (mapping[f.key] || !f.recommended) continue;
    if (schema.props[f.recommended.name]) continue; // name taken by an incompatible type
    add[f.recommended.name] = f.recommended.schema;
  }
  for (const [name, def] of Object.entries(AUTO_PROPERTIES)) {
    const hasCreatedTime = Object.values(schema.props).includes('created_time');
    if (!schema.props[name] && !hasCreatedTime && !mapping.clipped) add[name] = def;
  }
  return add;
}
