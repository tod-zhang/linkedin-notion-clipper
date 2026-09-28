import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildChildren, buildProperties, toRichText } from '../src/lib/blocks.js';
import { saveClip } from '../src/lib/clip.js';
import { downloadImage, sniffImageType } from '../src/lib/images.js';
import { FIELDS, guessMapping, missingRecommended, summarizeSchema } from '../src/lib/mapping.js';
import { createNotionClient, parseNotionId } from '../src/lib/notion.js';
import { createMockNotion, PNG_BYTES, SAMPLE_DATA_SOURCE } from './mock-notion.mjs';

const imageResponse = (bytes = PNG_BYTES, type = 'image/png') =>
  new Response(bytes, { status: 200, headers: { 'Content-Type': type } });

/** Route LinkedIn media to fake images and everything else to the mock Notion API. */
function combinedFetch(notion, { imageFetch } = {}) {
  return (url, init) =>
    String(url).includes('licdn.com') ? (imageFetch ? imageFetch(url) : imageResponse()) : notion.fetchImpl(url, init);
}

function samplePost(paragraphs = 3) {
  return {
    kind: 'post',
    urn: 'urn:li:share:7510134046337798144',
    url: 'https://www.linkedin.com/feed/update/urn:li:share:7510134046337798144/',
    title: 'Hello world',
    author: { name: 'Jane Doe', url: 'https://www.linkedin.com/in/janedoe/' },
    publishedAt: '2026-09-28T00:31:28.190Z',
    blocks: [
      ...Array.from({ length: paragraphs }, (_, i) => ({
        type: 'paragraph',
        rich: [{ text: `Paragraph ${i} ` }, { text: '#tag', href: 'https://www.linkedin.com/search/?k=%23tag' }],
      })),
      { type: 'image', sources: ['https://media.licdn.com/dms/image/v2/A/feedshare-shrink_1280/x'], caption: '', key: 'A' },
      { type: 'image', sources: ['https://media.licdn.com/dms/image/v2/B/feedshare-shrink_1280/y'], caption: '', key: 'B' },
      { type: 'bookmark', url: 'https://example.com/article' },
    ],
  };
}

const MAPPING = { url: '链接', author: '作者', published: '发布时间', kind: '类型', images: '图片' };
const SETTINGS = { token: 'ntn_test', dataSourceId: 'ds-1', mapping: MAPPING };

test('parseNotionId ignores the view id and accepts bare ids', () => {
  assert.equal(
    parseNotionId('https://www.notion.so/me/LinkedIn-1a2b3c4d5e6f47a8b9c0d1e2f3a4b5c6?v=ffffffffffffffffffffffffffffffff'),
    '1a2b3c4d-5e6f-47a8-b9c0-d1e2f3a4b5c6',
  );
  assert.equal(parseNotionId('1a2b3c4d-5e6f-47a8-b9c0-d1e2f3a4b5c6'), '1a2b3c4d-5e6f-47a8-b9c0-d1e2f3a4b5c6');
  assert.equal(parseNotionId('not an id'), null);
});

test('toRichText splits long text without breaking emoji and drops bad links', () => {
  const text = `${'a'.repeat(1999)}😀${'b'.repeat(10)}`;
  const rt = toRichText([{ text, href: 'javascript:alert(1)' }]);
  assert.equal(rt.length, 2);
  assert.equal(rt[0].text.content.length, 1999);
  assert.ok(rt[1].text.content.startsWith('😀'));
  assert.equal(rt[0].text.link, undefined);
});

test('buildChildren splits blocks with more than 100 rich text items', () => {
  const rich = Array.from({ length: 250 }, (_, i) => ({ text: `w${i} `, bold: i % 2 === 0 }));
  const blocks = buildChildren({ kind: 'post', blocks: [{ type: 'paragraph', rich }] }, () => null);
  const paragraphs = blocks.slice(1); // first block is the author/date line
  assert.equal(paragraphs.length, 3);
  assert.ok(paragraphs.every((b) => b.paragraph.rich_text.length <= 100));
});

test('buildChildren keeps one level of list nesting', () => {
  const blocks = buildChildren(
    {
      kind: 'article',
      blocks: [{ type: 'bulleted', rich: [{ text: 'parent' }], children: [{ type: 'bulleted', rich: [{ text: 'child' }], children: [] }] }],
    },
    () => null,
  );
  assert.equal(blocks[1].bulleted_list_item.children[0].bulleted_list_item.rich_text[0].text.content, 'child');
});

test('guessMapping matches Chinese and English names without reusing a property', () => {
  const schema = summarizeSchema(SAMPLE_DATA_SOURCE);
  assert.deepEqual(guessMapping(schema), MAPPING);

  const english = summarizeSchema({
    properties: {
      Name: { type: 'title' },
      URL: { type: 'url' },
      Author: { type: 'select' },
      'Published date': { type: 'date' },
      Files: { type: 'files' },
    },
  });
  assert.deepEqual(guessMapping(english), { url: 'URL', author: 'Author', published: 'Published date', images: 'Files' });
  // An explicit "don't fill" (null) is respected.
  assert.equal(guessMapping(english, { author: null }).author, undefined);
});

test('missingRecommended proposes every field for an empty database', () => {
  const schema = summarizeSchema({ properties: { Name: { type: 'title' } } });
  const add = missingRecommended(schema, {});
  assert.deepEqual(Object.keys(add).sort(), ['作者', '剪藏时间', '发布时间', '图片', '类型', '链接'].sort());
  assert.equal(FIELDS.length, 6);
});

test('buildProperties fills mapped fields', () => {
  const schema = summarizeSchema(SAMPLE_DATA_SOURCE);
  const props = buildProperties(samplePost(), schema, MAPPING, { files: [{ id: 'u1', name: 'a.png' }] });
  assert.equal(props.名称.title[0].text.content, 'Hello world');
  assert.equal(props.链接.url, samplePost().url);
  assert.equal(props.作者.rich_text[0].text.link.url, 'https://www.linkedin.com/in/janedoe/');
  assert.equal(props.类型.select.name, '动态');
  assert.equal(props.图片.files[0].file_upload.id, 'u1');
});

test('saveClip uploads images, creates the page with the LinkedIn icon, appends overflow', async () => {
  const notion = createMockNotion({ dataSource: SAMPLE_DATA_SOURCE });
  const client = createNotionClient({ token: 'ntn_test', fetchImpl: notion.fetchImpl, minIntervalMs: 0 });
  const progress = [];
  const result = await saveClip(samplePost(150), SETTINGS, {
    client,
    fetchImpl: combinedFetch(notion),
    onProgress: (t) => progress.push(t),
  });
  assert.equal(result.pageUrl, 'https://www.notion.so/page-1');
  assert.equal(result.imageCount, 2);
  assert.deepEqual(result.warnings, []);
  const paths = notion.calls.map((c) => `${c.method} ${c.path}`);
  assert.equal(paths.filter((p) => p === 'POST /file_uploads').length, 2);
  assert.equal(paths.filter((p) => p === 'PATCH /blocks/page-1/children').length, 1); // 1 meta + 150 + 2 images + 1 bookmark = 154
  assert.ok(!paths.includes('PATCH /pages/page-1'), 'no cover by default');
  assert.ok(progress.some((p) => p.startsWith('上传图片')));
  const create = notion.calls.find((c) => c.path === '/pages');
  assert.match(create.body.icon.external.url, /static\.licdn\.com/);
  assert.equal(create.body.cover, undefined);
});

test('saveClip sets the cover only when enabled', async () => {
  const notion = createMockNotion({ dataSource: SAMPLE_DATA_SOURCE });
  const client = createNotionClient({ token: 'ntn_test', fetchImpl: notion.fetchImpl, minIntervalMs: 0 });
  await saveClip(samplePost(), { ...SETTINGS, useCover: true }, { client, fetchImpl: combinedFetch(notion) });
  const cover = notion.calls.find((c) => c.method === 'PATCH' && c.path === '/pages/page-1');
  assert.equal(cover.body.cover.file_upload.id, 'upload-1');
});

test('saveClip reports duplicates without writing', async () => {
  const notion = createMockNotion({ dataSource: SAMPLE_DATA_SOURCE, existingPage: { id: 'p0', url: 'https://www.notion.so/p0' } });
  const client = createNotionClient({ token: 'ntn_test', fetchImpl: notion.fetchImpl, minIntervalMs: 0 });
  const result = await saveClip(samplePost(), SETTINGS, { client, fetchImpl: combinedFetch(notion) });
  assert.deepEqual(result, { duplicate: true, pageUrl: 'https://www.notion.so/p0' });
  assert.ok(!notion.calls.some((c) => c.path === '/pages'));
});

test('saveClip falls back to external image links when uploads fail', async () => {
  const notion = createMockNotion({ dataSource: SAMPLE_DATA_SOURCE, failUploads: true });
  const client = createNotionClient({ token: 'ntn_test', fetchImpl: notion.fetchImpl, minIntervalMs: 0 });
  const result = await saveClip(samplePost(), { ...SETTINGS, dedupe: false }, { client, fetchImpl: combinedFetch(notion) });
  assert.equal(result.warnings.length, 1);
  const create = notion.calls.find((c) => c.path === '/pages');
  const images = create.body.children.filter((b) => b.type === 'image');
  assert.equal(images.length, 2);
  assert.ok(images.every((b) => b.image.type === 'external'));
});

test('downloadImage skips oversized candidates and sniffs the type', async () => {
  const big = new Uint8Array(6 * 1024 * 1024);
  const fetchImpl = async (url) =>
    url.endsWith('big') ? imageResponse(big, 'image/jpeg') : imageResponse(PNG_BYTES, 'application/octet-stream');
  const file = await downloadImage(['https://x/big', 'https://x/small'], 'linkedin-A', { fetchImpl });
  assert.equal(file.url, 'https://x/small');
  assert.equal(file.contentType, 'image/png');
  assert.equal(file.filename, 'linkedin-A.png');
  assert.equal(sniffImageType(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0])), 'image/jpeg');

  // Nothing under 5 MiB: fall back to the smallest candidate that a paid plan accepts.
  const only = await downloadImage(['https://x/big'], 'linkedin-B', { fetchImpl });
  assert.equal(only.blob.size, big.length);
});

test('client lists every data source across search pages and reads the workspace name', async () => {
  const notion = createMockNotion({ dataSource: SAMPLE_DATA_SOURCE });
  const client = createNotionClient({ token: 'ntn_test', fetchImpl: notion.fetchImpl, minIntervalMs: 0 });
  assert.deepEqual((await client.listDataSources()).map((d) => d.id), ['ds-1', 'ds-2']);
  assert.equal(await client.getWorkspaceName(), '示例工作区');
});

test('client retries on 429 with Retry-After', async () => {
  let n = 0;
  const fetchImpl = async () => {
    n++;
    if (n === 1) return new Response('{}', { status: 429, headers: { 'Retry-After': '0' } });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };
  const client = createNotionClient({ token: 't', fetchImpl, minIntervalMs: 0 });
  assert.deepEqual(await client.request('GET', '/users/me'), { ok: true });
  assert.equal(n, 2);
});
