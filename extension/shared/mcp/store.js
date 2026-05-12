// Global state for the MCP UI, backed by chrome.storage.sync.
// Components consume it via @connectStore(mcpStore).

import { createStore } from '@mantou/gem';
import { getToolConfig, isToolEnabled as isToolEnabledFromState, toolKey } from './toolsets.js';

export const mcpStore = createStore({
  toolsets: [],
  toolStates: {},
});

export async function initStore() {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync') return;
    const patch = {};
    if (changes.toolsets) patch.toolsets = changes.toolsets.newValue ?? [];
    if (changes.toolStates) patch.toolStates = changes.toolStates.newValue ?? {};
    if (Object.keys(patch).length) mcpStore(patch);
  });
  mcpStore(await getToolConfig());
}

async function persist(patch) {
  mcpStore(patch);
  await chrome.storage.sync.set(patch);
}

export async function addToolset(toolset) {
  const existing = mcpStore.toolsets.findIndex((t) => t.id === toolset.id);
  const next = mcpStore.toolsets.slice();
  if (existing >= 0) next[existing] = { ...next[existing], ...toolset };
  else next.push(toolset);
  await persist({ toolsets: next });
}

export async function removeToolset(id) {
  const next = mcpStore.toolsets.filter((t) => t.id !== id);
  const states = { ...mcpStore.toolStates };
  for (const key of Object.keys(states)) {
    if (key.startsWith(`${id}.`)) delete states[key];
  }
  await persist({ toolsets: next, toolStates: states });
}

export async function setToolsetEnabled(id, enabled) {
  const next = mcpStore.toolsets.map((t) => (t.id === id ? { ...t, enabled } : t));
  await persist({ toolsets: next });
}

export function isToolEnabled(toolsetId, toolName) {
  return isToolEnabledFromState(mcpStore.toolStates, toolsetId, toolName);
}

export async function setToolEnabled(toolsetId, toolName, enabled) {
  const next = { ...mcpStore.toolStates, [toolKey(toolsetId, toolName)]: enabled };
  await persist({ toolStates: next });
}
