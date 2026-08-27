import { createStore } from '@mantou/gem/lib/store';
import { marketApi } from './market-api.js';
import { localStorageKeys } from './storage-keys.js';
import { isToolEnabled as isToolEnabledFromState, isToolsetLiked, toolKey } from './toolsets.js';

const toolStorageKeys = Object.freeze({
  toolsets: localStorageKeys.toolsets,
  toolStates: localStorageKeys.toolStates,
  likedToolsets: localStorageKeys.likedToolsets,
});

export const toolStore = createStore({
  toolsets: [],
  toolStates: {},
  likedToolsets: {},
});

let storageListenerBound = false;

export async function initStore() {
  if (!storageListenerBound) {
    storageListenerBound = true;
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      const patch = {};
      if (changes[toolStorageKeys.toolsets]) patch.toolsets = changes[toolStorageKeys.toolsets].newValue ?? [];
      if (changes[toolStorageKeys.toolStates]) patch.toolStates = changes[toolStorageKeys.toolStates].newValue ?? {};
      if (changes[toolStorageKeys.likedToolsets])
        patch.likedToolsets = changes[toolStorageKeys.likedToolsets].newValue ?? {};
      if (Object.keys(patch).length) toolStore(patch);
    });
  }
  toolStore(await getToolConfig());
}

export async function persist(patch) {
  const storagePatch = {};
  for (const [field, value] of Object.entries(patch)) {
    const key = toolStorageKeys[field];
    if (!key) throw new TypeError(`Unknown tool storage field: ${field}`);
    storagePatch[key] = value;
  }
  toolStore(patch);
  await chrome.storage.local.set(storagePatch);
}

export async function addToolset(toolset) {
  const existing = toolStore.toolsets.findIndex((t) => t.id === toolset.id);
  const next = toolStore.toolsets.slice();
  if (existing >= 0) next[existing] = { ...next[existing], ...toolset };
  else next.push(toolset);
  await persist({ toolsets: next });
}

export async function removeToolset(id) {
  const next = toolStore.toolsets.filter((t) => t.id !== id);
  const states = { ...toolStore.toolStates };
  for (const key of Object.keys(states)) {
    if (key.startsWith(`${id}.`)) delete states[key];
  }
  await persist({ toolsets: next, toolStates: states });
}

export async function setToolsetEnabled(id, enabled) {
  const next = toolStore.toolsets.map((t) => (t.id === id ? { ...t, enabled } : t));
  await persist({ toolsets: next });
}

export function isToolEnabled(toolsetId, toolName) {
  return isToolEnabledFromState(toolStore.toolStates, toolsetId, toolName);
}

export async function setToolEnabled(toolsetId, toolName, enabled) {
  const next = { ...toolStore.toolStates, [toolKey(toolsetId, toolName)]: enabled };
  await persist({ toolStates: next });
}

export async function likeToolset(toolsetId, name) {
  if (isToolsetLiked(toolStore.likedToolsets, toolsetId)) return;
  const nextLiked = { ...toolStore.likedToolsets, [toolsetId]: true };
  await persist({ likedToolsets: nextLiked });
  try {
    await marketApi.post(`/api/toolsets/${encodeURIComponent(name)}/like`);
  } catch (e) {
    const reverted = { ...toolStore.likedToolsets };
    delete reverted[toolsetId];
    await persist({ likedToolsets: reverted });
    throw e;
  }
}

export async function getToolConfig() {
  const data = await chrome.storage.local.get(Object.values(toolStorageKeys));
  return {
    toolsets: Array.isArray(data[toolStorageKeys.toolsets]) ? data[toolStorageKeys.toolsets] : [],
    toolStates:
      data[toolStorageKeys.toolStates] && typeof data[toolStorageKeys.toolStates] === 'object'
        ? data[toolStorageKeys.toolStates]
        : {},
    likedToolsets:
      data[toolStorageKeys.likedToolsets] && typeof data[toolStorageKeys.likedToolsets] === 'object'
        ? data[toolStorageKeys.likedToolsets]
        : {},
  };
}

export async function getAvailableTabTools(tabId) {
  const tab = await chrome.tabs.get(tabId);
  if (!tab?.url) return { tabId, url: tab?.url || '', tools: [] };

  const { toolsets, toolStates } = await getToolConfig();
  const tools = [];
  for (const toolset of toolsets) {
    if (!toolset.enabled) continue;
    for (const tool of toolset.tools || []) {
      if (!isToolEnabledFromState(toolStates, toolset.id, tool.name)) continue;
      if (!new URLPattern(tool.pattern).test(tab.url)) continue;
      tools.push({
        toolsetId: toolset.id,
        toolsetName: toolset.name,
        toolsetUrl: toolset.url,
        name: tool.name,
        description: tool.description,
        pattern: tool.pattern,
        inputSchema: tool.inputSchema,
      });
    }
  }
  return { tabId, url: tab.url, title: tab.title, tools };
}

export async function getSubscribedTool(toolsetId, toolName) {
  const { toolsets, toolStates } = await getToolConfig();
  const toolset = toolsets.find((t) => t.id === toolsetId);
  if (!toolset) throw new Error(`Toolset not found: ${toolsetId}`);
  if (!toolset.enabled) throw new Error(`Toolset is disabled: ${toolset.name}`);

  const tool = (toolset.tools || []).find((t) => t.name === toolName);
  if (!tool) throw new Error(`Tool not found: ${toolName}`);
  if (!isToolEnabledFromState(toolStates, toolsetId, toolName)) throw new Error(`Tool is disabled: ${toolName}`);

  return { toolset, tool };
}

export async function unlikeToolset(toolsetId, name) {
  if (!isToolsetLiked(toolStore.likedToolsets, toolsetId)) return;
  const reverted = { ...toolStore.likedToolsets };
  delete reverted[toolsetId];
  await persist({ likedToolsets: reverted });
  try {
    await marketApi.del(`/api/toolsets/${encodeURIComponent(name)}/like`);
  } catch (e) {
    await persist({ likedToolsets: { ...toolStore.likedToolsets, [toolsetId]: true } });
    throw e;
  }
}
