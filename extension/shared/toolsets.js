import { fnv1a } from 'duoyun-ui/lib/encode';

export function toolKey(toolsetId, toolName) {
  return `${toolsetId}.${toolName}`;
}

export function getToolsetId(url) {
  return String(fnv1a(url));
}

export function isToolEnabled(toolStates, toolsetId, toolName) {
  return toolStates[toolKey(toolsetId, toolName)] !== false;
}

export function isToolsetLiked(likedToolsets, toolsetId) {
  return likedToolsets[toolsetId] === true;
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
      if (!isToolEnabled(toolStates, toolset.id, tool.name)) continue;
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
  if (!isToolEnabled(toolStates, toolsetId, toolName)) throw new Error(`Tool is disabled: ${toolName}`);

  return { toolset, tool };
}
