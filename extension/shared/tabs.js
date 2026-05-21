export async function openExtensionPage(path) {
  const url = chrome.runtime.getURL(path);
  const tabs = await chrome.tabs.query({});
  const existingTab = tabs.find((tab) => new URL(tab.url).pathname === new URL(url).pathname);
  if (existingTab) {
    await chrome.tabs.update(existingTab.id, { active: true });
    await chrome.windows.update(existingTab.windowId, { focused: true });
    return;
  }
  chrome.tabs.create({ url });
}
