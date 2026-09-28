import { createNotionClient, plainTitle } from '../lib/notion.js';
import { describeError } from '../lib/clip.js';
import { FIELDS, guessMapping, missingRecommended, sanitizeMapping, summarizeSchema } from '../lib/mapping.js';
import { loadSettings, saveSettings } from '../lib/settings.js';

const $ = (id) => document.getElementById(id);
const TYPE_LABELS = {
  url: '网址',
  rich_text: '文本',
  select: '单选',
  multi_select: '多选',
  date: '日期',
  files: '文件和媒体',
};

let settings = {};
let schema = null;
let dataSources = []; // search results for the current token

async function save(patch) {
  settings = { ...settings, ...patch };
  await saveSettings(settings);
}

function setStatus(id, text, kind = '') {
  const el = $(id);
  el.textContent = text;
  el.className = `status ${kind}`;
}

function client(token = settings.token) {
  return createNotionClient({ token });
}

// ---------- step 2: database picker ----------

function dataSourceLabel(ds, duplicateTitles) {
  const title = plainTitle(ds.title) || '未命名数据库';
  return duplicateTitles.has(title) ? `${title} · ${ds.id.slice(0, 8)}` : title;
}

function renderDatabaseSelect() {
  const select = $('database-select');
  select.textContent = '';
  const titles = dataSources.map((ds) => plainTitle(ds.title) || '未命名数据库');
  const duplicates = new Set(titles.filter((t, i) => titles.indexOf(t) !== i));
  const known = dataSources.some((ds) => ds.id === settings.dataSourceId);

  if (!settings.dataSourceId || !known) {
    select.add(new Option(dataSources.length ? '— 请选择数据库 —' : '（没有可用的数据库）', ''));
  }
  if (settings.dataSourceId && !known) {
    // Chosen via a pasted link, or not returned by search: keep it selectable.
    select.add(new Option(settings.dbTitle || '当前数据库', settings.dataSourceId));
  }
  for (const ds of dataSources) select.add(new Option(dataSourceLabel(ds, duplicates), ds.id));
  select.value = settings.dataSourceId || '';
  $('database-card').hidden = false;
}

async function loadDataSources() {
  setStatus('database-status', '正在读取数据库列表…');
  try {
    dataSources = await client().listDataSources();
    dataSources.sort((a, b) => String(b.last_edited_time).localeCompare(String(a.last_edited_time)));
    renderDatabaseSelect();
    setStatus(
      'database-status',
      dataSources.length ? '' : '这个集成还没有连接任何数据库，请先在 Notion 中连接（见上方说明）。',
      dataSources.length ? '' : 'err',
    );
  } catch (err) {
    setStatus('database-status', describeError(err), 'err');
  }
}

/** Use a data source: read its schema, keep or guess the field mapping, save. */
async function chooseDataSource(dataSourceId) {
  if (!dataSourceId) return;
  setStatus('database-status', '正在读取数据库结构…');
  try {
    const ds = await client().getDataSource(dataSourceId);
    const sameTarget = settings.dataSourceId === dataSourceId;
    await save({
      dataSourceId,
      databaseId: ds.parent?.database_id || null,
      mapping: sameTarget ? settings.mapping || {} : {},
    });
    await applySchema(ds);
    renderDatabaseSelect();
    setStatus('database-status', `✓ 将剪藏到「${schema.title || '未命名数据库'}」，设置已自动保存`, 'ok');
  } catch (err) {
    setStatus('database-status', describeError(err), 'err');
  }
}

async function useLink() {
  const link = $('database').value.trim();
  if (!link) return setStatus('database-status', '请粘贴数据库链接', 'err');
  setStatus('database-status', '正在读取…');
  try {
    const target = await client().resolveTarget(link);
    await save({ dbInput: link });
    await chooseDataSource(target.dataSourceId);
  } catch (err) {
    setStatus('database-status', describeError(err), 'err');
  }
}

// ---------- step 1: token ----------

async function connect({ silent = false } = {}) {
  const token = $('token').value.trim();
  if (!token) return setStatus('connect-status', '请先填写集成令牌', 'err');
  const button = $('connect');
  button.disabled = true;
  if (!silent) setStatus('connect-status', '正在连接…');
  try {
    const workspace = await client(token).getWorkspaceName();
    if (token !== settings.token) await save({ token });
    setStatus('connect-status', `✓ 已连接${workspace ? `工作区：${workspace}` : ' Notion'}`, 'ok');
    await loadDataSources();
    if (settings.dataSourceId) await chooseDataSource(settings.dataSourceId);
  } catch (err) {
    setStatus('connect-status', describeError(err), 'err');
  } finally {
    button.disabled = false;
  }
}

// ---------- step 3: field mapping ----------

function renderMapping() {
  $('mapping-card').hidden = false;
  $('options-card').hidden = false;
  $('title-prop').textContent = `${schema.titleProp}（标题属性，自动填写）`;

  const mapping = sanitizeMapping(settings.mapping, schema);
  const rows = $('map-rows');
  rows.textContent = '';
  for (const f of FIELDS) {
    const row = document.createElement('div');
    row.className = 'map-row';
    const label = document.createElement('label');
    label.className = 'map-label';
    label.textContent = f.label;
    label.htmlFor = `map-${f.key}`;
    const select = document.createElement('select');
    select.id = `map-${f.key}`;
    select.add(new Option('— 不填写 —', ''));
    for (const [name, type] of Object.entries(schema.props)) {
      if (f.types.includes(type)) select.add(new Option(`${name}（${TYPE_LABELS[type] || type}）`, name));
    }
    select.value = mapping[f.key] || '';
    select.addEventListener('change', async () => {
      await save({ mapping: { ...settings.mapping, [f.key]: select.value || null } });
      renderRecommended();
    });
    row.append(label, select);
    rows.appendChild(row);
  }
  renderRecommended();
}

function renderRecommended() {
  const add = missingRecommended(schema, sanitizeMapping(settings.mapping, schema));
  const names = Object.keys(add);
  $('recommend-row').hidden = names.length === 0;
  $('recommend-text').textContent = names.length ? `将在数据库中新建：${names.join('、')}` : '';
}

async function applySchema(dataSource, { remap = false } = {}) {
  schema = summarizeSchema(dataSource);
  let current = settings.mapping || {};
  if (remap) current = Object.fromEntries(Object.entries(current).filter(([, v]) => v));
  await save({ dbTitle: schema.title, mapping: guessMapping(schema, current) });
  renderMapping();
}

async function addRecommended() {
  const add = missingRecommended(schema, sanitizeMapping(settings.mapping, schema));
  if (!Object.keys(add).length) return;
  const button = $('add-recommended');
  button.disabled = true;
  try {
    await client().updateDataSource(settings.dataSourceId, { properties: add });
    await applySchema(await client().getDataSource(settings.dataSourceId), { remap: true });
    setStatus('database-status', `✓ 已添加属性：${Object.keys(add).join('、')}`, 'ok');
  } catch (err) {
    setStatus('database-status', describeError(err), 'err');
  } finally {
    button.disabled = false;
  }
}

// ---------- init ----------

async function init() {
  settings = await loadSettings();
  $('token').value = settings.token || '';
  $('database').value = settings.dbInput || '';
  $('use-cover').checked = settings.useCover === true;
  $('dedupe').checked = settings.dedupe !== false;

  $('toggle-token').addEventListener('click', () => {
    const input = $('token');
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    $('toggle-token').textContent = show ? '隐藏' : '显示';
  });
  $('connect').addEventListener('click', () => connect());
  $('token').addEventListener('keydown', (e) => e.key === 'Enter' && connect());
  $('database-select').addEventListener('change', (e) => chooseDataSource(e.target.value));
  $('refresh-databases').addEventListener('click', loadDataSources);
  $('use-link').addEventListener('click', useLink);
  $('database').addEventListener('keydown', (e) => e.key === 'Enter' && useLink());
  $('add-recommended').addEventListener('click', addRecommended);
  $('use-cover').addEventListener('change', (e) => save({ useCover: e.target.checked }));
  $('dedupe').addEventListener('change', (e) => save({ dedupe: e.target.checked }));

  // Settings synced from another device: verify and show everything straight away.
  if (settings.token) await connect({ silent: true });
}

init();
