// Settings live in chrome.storage.sync so every browser signed into the same
// Chrome account gets them automatically (the manifest "key" pins the extension
// id so all devices share one sync bucket). Without Chrome sync it acts local.

const KEY = 'settings';

export async function loadSettings() {
  const { [KEY]: synced } = await chrome.storage.sync.get(KEY);
  if (synced) return synced;
  // Versions before 1.1 kept settings in local storage: carry them over once.
  const { [KEY]: local } = await chrome.storage.local.get(KEY);
  if (local) {
    await chrome.storage.sync.set({ [KEY]: local });
    return local;
  }
  return {};
}

export async function saveSettings(settings) {
  await chrome.storage.sync.set({ [KEY]: settings });
}
