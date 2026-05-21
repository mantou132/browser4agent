// Global state for tab tool UI, backed by chrome.storage.sync.
// Components consume it via @connectStore(toolStore).

import { createStore } from '@mantou/gem';
import { marketApi } from './market-api.js';
import { getToolConfig, isToolEnabled as isToolEnabledFromState, isToolsetLiked, toolKey } from './toolsets.js';

export const toolStore = createStore({
  toolsets: [],
  toolStates: {},
  likedToolsets: {},
});

export async function initStore() {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync') return;
    const patch = {};
    if (changes.toolsets) patch.toolsets = changes.toolsets.newValue ?? [];
    if (changes.toolStates) patch.toolStates = changes.toolStates.newValue ?? {};
    if (changes.likedToolsets) patch.likedToolsets = changes.likedToolsets.newValue ?? {};
    if (Object.keys(patch).length) toolStore(patch);
  });
  toolStore(await getToolConfig());
}

async function persist(patch) {
  toolStore(patch);
  await chrome.storage.sync.set(patch);
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
