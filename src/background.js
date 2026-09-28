import { createNotionClient } from './lib/notion.js';
import { describeError, saveClip } from './lib/clip.js';
import { loadSettings as getSettings } from './lib/settings.js';

function isConfigured(settings) {
  return Boolean(settings.token && settings.dataSourceId);
}

// Content scripts open a port per clip and receive progress messages on it.
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'clip') return;
  let open = true;
  port.onDisconnect.addListener(() => {
    open = false;
  });
  const send = (msg) => {
    if (!open) return;
    try {
      port.postMessage(msg);
    } catch {
      open = false;
    }
  };

  port.onMessage.addListener(async (msg) => {
    if (msg?.type !== 'clip') return;
    const settings = await getSettings();
    if (!isConfigured(settings)) {
      send({ type: 'error', code: 'not_configured', message: '还没有连接 Notion 数据库，请先完成扩展设置。' });
      return;
    }
    // Extension API calls reset the service worker's idle timer; long uploads need that.
    const keepAlive = setInterval(() => chrome.runtime.getPlatformInfo(() => {}), 20000);
    try {
      const client = createNotionClient({ token: settings.token });
      const result = await saveClip(msg.clip, settings, {
        client,
        force: Boolean(msg.force),
        onProgress: (text) => text && send({ type: 'progress', text }),
      });
      send({ type: result.duplicate ? 'duplicate' : 'done', ...result });
    } catch (err) {
      console.error('[LinkedIn → Notion] clip failed', err);
      const needsSetup = [401, 403, 404].includes(err?.status);
      send({ type: 'error', code: needsSetup ? 'needs_setup' : err?.code, message: describeError(err) });
    } finally {
      clearInterval(keepAlive);
    }
  });
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'open-options') chrome.runtime.openOptionsPage();
});

// Toolbar button: clip the article, the open post, or the post in view.
chrome.action.onClicked.addListener(async (tab) => {
  const settings = await getSettings();
  if (!isConfigured(settings)) {
    chrome.runtime.openOptionsPage();
    return;
  }
  const flash = (text) => {
    chrome.action.setBadgeBackgroundColor({ color: '#cc1016', tabId: tab.id });
    chrome.action.setBadgeText({ text, tabId: tab.id });
    setTimeout(() => chrome.action.setBadgeText({ text: '', tabId: tab.id }), 4000);
  };
  if (!/^https:\/\/www\.linkedin\.com\//.test(tab.url || '')) {
    flash('?');
    return;
  }
  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'clip-active' });
  } catch {
    // The page was open before the extension was installed/updated.
    flash('↻');
    chrome.action.setTitle({ tabId: tab.id, title: '请刷新 LinkedIn 页面后再试' });
  }
});

chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === 'install') chrome.runtime.openOptionsPage();
});
