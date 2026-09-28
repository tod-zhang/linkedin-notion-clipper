// A fake Notion API for tests: records requests and enforces the request
// limits the real API validates (so payload bugs fail here, not in production).
import assert from 'node:assert/strict';

function checkRichText(rt, where) {
  assert.ok(Array.isArray(rt), `${where}: rich_text must be an array`);
  assert.ok(rt.length <= 100, `${where}: rich_text has ${rt.length} items (max 100)`);
  for (const t of rt) {
    assert.equal(t.type, 'text', `${where}: rich text type`);
    assert.ok(t.text.content.length <= 2000, `${where}: text content ${t.text.content.length} chars (max 2000)`);
    if (t.text.link) assert.match(t.text.link.url, /^https?:\/\//, `${where}: link url`);
  }
}

const TEXT_TYPES = ['paragraph', 'quote', 'heading_2', 'heading_3', 'bulleted_list_item', 'numbered_list_item', 'code'];

function checkBlocks(blocks, where, depth = 0) {
  assert.ok(blocks.length <= 100, `${where}: ${blocks.length} children (max 100)`);
  assert.ok(depth <= 1, `${where}: nesting too deep`);
  for (const [i, b] of blocks.entries()) {
    const w = `${where}[${i}]`;
    assert.equal(b.object, 'block', `${w}: object`);
    const body = b[b.type];
    assert.ok(body, `${w}: missing body for ${b.type}`);
    if (TEXT_TYPES.includes(b.type)) checkRichText(body.rich_text, w);
    if (b.type === 'image') {
      assert.ok(['file_upload', 'external'].includes(body.type), `${w}: image type ${body.type}`);
      if (body.type === 'file_upload') assert.ok(body.file_upload.id, `${w}: file upload id`);
      if (body.caption) checkRichText(body.caption, `${w}.caption`);
    }
    if (b.type === 'bookmark') assert.match(body.url, /^https?:\/\//, `${w}: bookmark url`);
    if (body.children) checkBlocks(body.children, `${w}.children`, depth + 1);
  }
}

export function createMockNotion({ dataSource, existingPage = null, failUploads = false } = {}) {
  const calls = [];
  const uploads = new Map();
  let pageCounter = 0;

  const json = (status, data) =>
    new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

  async function fetchImpl(url, init = {}) {
    const u = new URL(url);
    const path = u.pathname.replace(/^\/v1/, '');
    const method = init.method || 'GET';
    assert.match(init.headers.Authorization, /^Bearer .+/, 'Authorization header');
    assert.ok(init.headers['Notion-Version'], 'Notion-Version header');
    let body = null;
    if (typeof init.body === 'string') body = JSON.parse(init.body);
    calls.push({ method, path, body, form: init.body instanceof FormData ? init.body : null });

    if (method === 'GET' && path.startsWith('/data_sources/')) return json(200, dataSource);
    if (method === 'GET' && path === '/users/me') {
      return json(200, { object: 'user', type: 'bot', bot: { workspace_name: '示例工作区' } });
    }
    if (method === 'POST' && path === '/search') {
      assert.deepEqual(body.filter, { property: 'object', value: 'data_source' });
      // Two pages of results to exercise pagination.
      if (!body.start_cursor) {
        return json(200, { results: [{ ...dataSource, id: 'ds-1' }], has_more: true, next_cursor: 'c2' });
      }
      return json(200, { results: [{ ...dataSource, id: 'ds-2' }], has_more: false, next_cursor: null });
    }
    if (method === 'POST' && /^\/data_sources\/[^/]+\/query$/.test(path)) {
      assert.ok(body.filter.url.equals, 'query filter');
      return json(200, { results: existingPage ? [existingPage] : [] });
    }
    if (method === 'POST' && path === '/file_uploads') {
      assert.equal(body.mode, 'single_part');
      assert.match(body.filename, /^[\w-]+\.(jpg|png|gif|webp|avif|heic)$/, `filename ${body.filename}`);
      assert.match(body.content_type, /^image\//);
      if (failUploads) return json(400, { code: 'validation_error', message: 'upload failed' });
      const id = `upload-${uploads.size + 1}`;
      uploads.set(id, { ...body, sent: false });
      return json(200, { id, status: 'pending', upload_url: `https://api.notion.com/v1/file_uploads/${id}/send` });
    }
    const send = path.match(/^\/file_uploads\/([^/]+)\/send$/);
    if (method === 'POST' && send) {
      const up = uploads.get(send[1]);
      assert.ok(up, 'send for unknown upload');
      const file = init.body.get('file');
      assert.ok(file && file.size > 0, 'multipart field "file" with content');
      assert.equal(file.type, up.content_type, 'blob type matches declared content_type');
      up.sent = true;
      return json(200, { id: send[1], status: 'uploaded' });
    }
    if (method === 'POST' && path === '/pages') {
      assert.equal(body.parent.type, 'data_source_id');
      if (body.icon) assert.match(body.icon.external.url, /^https:\/\//, 'external icon url');
      assert.ok(body.parent.data_source_id);
      checkBlocks(body.children || [], 'create.children');
      for (const [name, value] of Object.entries(body.properties)) {
        assert.ok(dataSource.properties[name], `unknown property ${name}`);
        if (value.title) checkRichText(value.title, `prop ${name}`);
        if (value.rich_text) checkRichText(value.rich_text, `prop ${name}`);
        if (value.files) for (const f of value.files) assert.ok(uploads.get(f.file_upload.id)?.sent, 'files property uses sent upload');
      }
      for (const b of body.children || []) {
        if (b.type === 'image' && b.image.type === 'file_upload') {
          assert.ok(uploads.get(b.image.file_upload.id)?.sent, 'image block uses a sent upload');
        }
      }
      pageCounter++;
      return json(200, { id: `page-${pageCounter}`, url: `https://www.notion.so/page-${pageCounter}` });
    }
    const append = path.match(/^\/blocks\/([^/]+)\/children$/);
    if (method === 'PATCH' && append) {
      checkBlocks(body.children, 'append.children');
      return json(200, { results: [] });
    }
    if (method === 'PATCH' && path.startsWith('/pages/')) {
      if (body.cover) assert.ok(uploads.get(body.cover.file_upload.id)?.sent, 'cover uses a sent upload');
      return json(200, { id: path.split('/')[2] });
    }
    return json(404, { code: 'object_not_found', message: `mock: no route ${method} ${path}` });
  }

  return { fetchImpl, calls, uploads };
}

export const SAMPLE_DATA_SOURCE = {
  object: 'data_source',
  id: 'ds-1',
  title: [{ plain_text: 'LinkedIn 剪藏' }],
  properties: {
    名称: { id: 'title', type: 'title' },
    链接: { id: 'a', type: 'url' },
    作者: { id: 'b', type: 'rich_text' },
    发布时间: { id: 'c', type: 'date' },
    类型: { id: 'd', type: 'select' },
    图片: { id: 'e', type: 'files' },
    剪藏时间: { id: 'f', type: 'created_time' },
  },
};

/** 1×1 PNG. */
export const PNG_BYTES = Uint8Array.from(
  atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='),
  (c) => c.charCodeAt(0),
);
