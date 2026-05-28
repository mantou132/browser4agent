import { createStore } from '@mantou/gem/lib/store';
import { marketApi } from './market-api.js';
import { isToolEnabled as isToolEnabledFromState, isToolsetLiked, toolKey } from './toolsets.js';

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
      if (changes.toolsets) patch.toolsets = changes.toolsets.newValue ?? [];
      if (changes.toolStates) patch.toolStates = changes.toolStates.newValue ?? {};
      if (changes.likedToolsets) patch.likedToolsets = changes.likedToolsets.newValue ?? {};
      if (Object.keys(patch).length) toolStore(patch);
    });
  }
  toolStore(await getToolConfig());
}

export async function persist(patch) {
  toolStore(patch);
  await chrome.storage.local.set(patch);
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
  const data = await chrome.storage.local.get(['toolsets', 'toolStates', 'likedToolsets']);
  return {
    toolsets: Array.isArray(data.toolsets) ? data.toolsets : [],
    toolStates: data.toolStates && typeof data.toolStates === 'object' ? data.toolStates : {},
    likedToolsets: data.likedToolsets && typeof data.likedToolsets === 'object' ? data.likedToolsets : {},
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
