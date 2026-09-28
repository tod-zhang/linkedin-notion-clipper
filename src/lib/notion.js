// Minimal Notion API client for the clipper. Runs in the extension service
// worker and the options page; `fetchImpl` is injectable so Node tests can run
// it without a token.

export const NOTION_VERSION = '2025-09-03';
const API = 'https://api.notion.com/v1';

export class NotionError extends Error {
  constructor(status, code, message) {
    super(message || `Notion API error ${status}`);
    this.name = 'NotionError';
    this.status = status;
    this.code = code;
  }
}

/** Pull a 32-hex Notion id out of a URL or raw id. Query (?v=view id) is ignored. */
export function parseNotionId(input) {
  const raw = String(input || '').trim();
  if (!raw) return null;
  let path = raw;
  try {
    const u = new URL(raw);
    path = u.pathname;
  } catch {
    // not a URL: treat as a bare id
  }
  const ids = path.replace(/-/g, '').match(/[0-9a-f]{32}/gi);
  if (!ids) return null;
  const id = ids[ids.length - 1].toLowerCase();
  return `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}`;
}

export function plainTitle(richText) {
  return (richText || []).map((t) => t.plain_text ?? t.text?.content ?? '').join('');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function createNotionClient({ token, fetchImpl, minIntervalMs = 350 } = {}) {
  const doFetch = fetchImpl || ((...args) => fetch(...args));
  let lastRequestAt = 0;

  async function throttle() {
    // Notion allows ~3 requests/second per integration.
    const wait = lastRequestAt + minIntervalMs - Date.now();
    if (wait > 0) await sleep(wait);
    lastRequestAt = Date.now();
  }

  async function request(method, path, body, { form } = {}) {
    const headers = { Authorization: `Bearer ${token}`, 'Notion-Version': NOTION_VERSION };
    let payload;
    if (form) payload = form; // browser sets the multipart boundary itself
    else if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    }

    for (let attempt = 0; ; attempt++) {
      await throttle();
      let res;
      try {
        res = await doFetch(`${API}${path}`, { method, headers, body: payload });
      } catch (err) {
        if (attempt < 2) {
          await sleep(1000 * (attempt + 1));
          continue;
        }
        throw new NotionError(0, 'network_error', `无法连接 Notion：${err.message}`);
      }
      if (res.status === 429 && attempt < 5) {
        const retryAfter = Number(res.headers.get('Retry-After')) || 1;
        await sleep(retryAfter * 1000);
        continue;
      }
      if (res.status >= 500 && attempt < 2) {
        await sleep(1000 * (attempt + 1));
        continue;
      }
      const text = await res.text();
      let data = null;
      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        data = null;
      }
      if (!res.ok) {
        throw new NotionError(res.status, data?.code || 'http_error', data?.message || text.slice(0, 300));
      }
      return data;
    }
  }

  return {
    request,

    getDatabase: (id) => request('GET', `/databases/${id}`),
    getDataSource: (id) => request('GET', `/data_sources/${id}`),
    updateDataSource: (id, body) => request('PATCH', `/data_sources/${id}`, body),

    /** Accepts a database URL/id (or a data source id) and returns its first data source. */
    async resolveTarget(input) {
      const id = parseNotionId(input);
      if (!id) throw new NotionError(400, 'invalid_id', '无法从链接中识别数据库 ID');
      let databaseId = id;
      let dataSourceId = null;
      let dataSourceCount = 1;
      try {
        const db = await request('GET', `/databases/${id}`);
        const sources = db.data_sources || [];
        if (!sources.length) throw new NotionError(400, 'no_data_source', '该数据库没有数据源');
        dataSourceId = sources[0].id;
        dataSourceCount = sources.length;
      } catch (err) {
        if (!(err instanceof NotionError) || err.status !== 404) throw err;
        // Maybe the id is a data source id already.
        dataSourceId = id;
        databaseId = null;
      }
      const ds = await request('GET', `/data_sources/${dataSourceId}`);
      if (!databaseId) databaseId = ds.parent?.database_id || null;
      return { databaseId, dataSourceId, dataSourceCount, dataSource: ds };
    },

    /** Workspace name the token belongs to (null for some bots). */
    async getWorkspaceName() {
      const me = await request('GET', '/users/me');
      return me.bot?.workspace_name || null;
    },

    /** Every data source (database table) the integration has been connected to. */
    async listDataSources() {
      const results = [];
      let cursor;
      do {
        const res = await request('POST', '/search', {
          filter: { property: 'object', value: 'data_source' },
          page_size: 100,
          ...(cursor ? { start_cursor: cursor } : {}),
        });
        results.push(...(res.results || []));
        cursor = res.has_more ? res.next_cursor : null;
      } while (cursor && results.length < 1000);
      return results;
    },

    async findPageByUrl(dataSourceId, property, url) {
      const res = await request('POST', `/data_sources/${dataSourceId}/query`, {
        filter: { property, url: { equals: url } },
        page_size: 1,
      });
      return res.results?.[0] || null;
    },

    async uploadFile(blob, filename, contentType) {
      const created = await request('POST', '/file_uploads', {
        mode: 'single_part',
        filename,
        content_type: contentType,
      });
      const form = new FormData();
      form.append('file', blob, filename);
      await request('POST', `/file_uploads/${created.id}/send`, undefined, { form });
      return created.id;
    },

    createPage: (body) => request('POST', '/pages', body),
    updatePage: (id, body) => request('PATCH', `/pages/${id}`, body),
    appendChildren: (blockId, children) =>
      request('PATCH', `/blocks/${blockId}/children`, { children }),
  };
}
