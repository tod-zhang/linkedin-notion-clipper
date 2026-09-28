// Save one extracted clip into the configured Notion data source.

import { buildChildren, buildProperties, chunk, LINKEDIN_ICON, validUrl } from './blocks.js';
import { downloadImage } from './images.js';
import { sanitizeMapping, summarizeSchema } from './mapping.js';

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

function safeName(key, i) {
  return `linkedin-${String(key || i).replace(/[^\w-]+/g, '').slice(0, 60) || i}`;
}

/** Errors that mean the whole clip cannot succeed, so don't fall back per image. */
function isFatal(err) {
  return err && [401, 403, 404].includes(err.status);
}

/**
 * @returns {Promise<{duplicate?: boolean, pageUrl: string, warnings?: string[], imageCount?: number}>}
 */
export async function saveClip(clip, settings, { client, fetchImpl, onProgress = () => {}, force = false }) {
  onProgress('读取数据库结构…');
  const dataSource = await client.getDataSource(settings.dataSourceId);
  const schema = summarizeSchema(dataSource);
  if (!schema.titleProp) throw new Error('数据库缺少标题属性');
  const mapping = sanitizeMapping(settings.mapping || {}, schema);
  const warnings = [];

  if (!force && settings.dedupe !== false && mapping.url && validUrl(clip.url)) {
    onProgress('检查是否已剪藏…');
    const existing = await client.findPageByUrl(settings.dataSourceId, mapping.url, clip.url);
    if (existing) return { duplicate: true, pageUrl: existing.url };
  }

  // Images: download in parallel, upload one by one (Notion rate limit).
  const images = (clip.blocks || []).filter((b) => b.type === 'image');
  let downloaded = 0;
  if (images.length) onProgress(`下载图片 0/${images.length}`);
  const downloads = await mapLimit(images, 4, async (img, i) => {
    const result = await downloadImage(img.sources, safeName(img.key, i), { fetchImpl });
    downloaded++;
    onProgress(`下载图片 ${downloaded}/${images.length}`);
    return result;
  });

  const resolved = new Map();
  const files = [];
  let fallbacks = 0;
  for (const [i, img] of images.entries()) {
    onProgress(`上传图片 ${i + 1}/${images.length}`);
    const file = downloads[i];
    if (file) {
      try {
        const id = await client.uploadFile(file.blob, file.filename, file.contentType);
        resolved.set(img, { type: 'file_upload', file_upload: { id } });
        files.push({ id, name: file.filename, block: img });
        continue;
      } catch (err) {
        if (isFatal(err)) throw err;
      }
    }
    const url = validUrl(img.sources[0]);
    if (url) {
      resolved.set(img, { type: 'external', external: { url } });
      fallbacks++;
    }
  }
  if (fallbacks) warnings.push(`${fallbacks} 张图片未能上传到 Notion（可能超过大小上限），改用 LinkedIn 外链，日后可能失效`);

  // Page cover (off unless enabled in settings): an article's cover image, otherwise the first image.
  const coverFile = settings.useCover === true ? files.find((f) => f.block.cover) || files[0] || null : null;
  const children = buildChildren(clip, (b) => {
    if (coverFile && b.cover && coverFile.block === b) return null; // shown as the page cover instead
    return resolved.get(b) || null;
  });
  const properties = buildProperties(clip, schema, mapping, { files });
  const [firstBatch = [], ...rest] = chunk(children);

  onProgress('创建 Notion 页面…');
  const body = {
    parent: { type: 'data_source_id', data_source_id: settings.dataSourceId },
    icon: LINKEDIN_ICON,
    properties,
    children: firstBatch,
  };
  let page;
  try {
    page = await client.createPage(body);
  } catch (err) {
    // A property value may be rejected (e.g. the schema changed); still save the content.
    if (err.code !== 'validation_error' || Object.keys(properties).length <= 1) throw err;
    warnings.push(`部分属性未能写入：${err.message}`);
    page = await client.createPage({ ...body, properties: { [schema.titleProp]: properties[schema.titleProp] } });
  }

  for (const [i, part] of rest.entries()) {
    onProgress(`写入正文 ${i + 2}/${rest.length + 1}`);
    await client.appendChildren(page.id, part);
  }

  if (coverFile) {
    try {
      await client.updatePage(page.id, { cover: { type: 'file_upload', file_upload: { id: coverFile.id } } });
    } catch {
      warnings.push('设置封面失败');
    }
  }

  return { pageUrl: page.url, warnings, imageCount: files.length };
}

/** Turn API errors into something a user can act on. */
export function describeError(err) {
  if (!err) return '未知错误';
  switch (err.status) {
    case 401:
      return 'Notion 令牌无效或已失效，请在扩展设置中重新填写。';
    case 403:
      return 'Notion 集成没有权限：请确认集成已开启「读取 / 插入 / 更新内容」能力。';
    case 404:
      return '找不到数据库：请在 Notion 中打开该数据库 → 右上角 ··· → 连接（Connections）→ 添加你的集成。';
    case 409:
      return 'Notion 数据冲突，请稍后重试。';
    default:
      break;
  }
  if (err.code === 'validation_error') return `Notion 拒绝了请求：${err.message}`;
  return err.message || String(err);
}
