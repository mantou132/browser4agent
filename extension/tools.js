import { exec } from './execute-in-bg.js';
import { getAvailableTabTools, getSubscribedTool } from './shared/store.js';

const err = (msg) => ({ type: 'error', error: msg });

// Pseudo toolset id used for tools that the page itself registered via
// `navigator.modelContext.registerTool` (WebMCP). They are not stored in
// chrome.storage; metadata is fetched live from the tab and `execute` is
// invoked through the in-page reference kept on `window.__webmcp_tools__`.
const PAGE_TOOLSET_ID = 'webmcp';
const PAGE_TOOLSET_NAME = 'Page WebMCP Tools';

function scriptResult(results) {
  const { result, error } = results[0] || {};
  if (error) return err(error.message || String(error));
  return result;
}

async function ensureTabLoaded(tabId) {
  const tab = await chrome.tabs.get(tabId);
  if (!tab) throw new Error(`Tab ${tabId} not found`);
  if (tab.discarded) await chrome.tabs.reload(tabId);
  if (tab.discarded || tab.status === 'loading') {
    const { resolve, reject, promise } = Promise.withResolvers();
    const listener = (updatedTabId, changeInfo) => {
      if (updatedTabId !== tabId || changeInfo.status !== 'complete') return;
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    };
    chrome.tabs.onUpdated.addListener(listener);
    setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error(`Tab ${tabId} load timed out, please retry`));
    }, 15_000);
    await promise;
  }
  return tab;
}

export async function getAllTabs() {
  try {
    const tabs = (await chrome.tabs.query({})).map(({ id, title, url, active, lastAccessed, windowId, groupId }) => ({
      id,
      windowId,
      groupId,
      title,
      active,
      url: url.slice(0, 1024),
      lastAccessed: new Date(lastAccessed).toLocaleString(),
    }));
    return { tabs };
  } catch (e) {
    return err(`Failed to get tabs: ${e.message}`);
  }
}

export async function readTab(tabId) {
  if (tabId == null) return err('tabId is required');
  try {
    await ensureTabLoaded(tabId);
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      files: ['serialize.js'],
      world: 'MAIN',
    });
    const content = scriptResult(results) || '';
    return { tabId, content };
  } catch (e) {
    return err(`Failed to read tab ${tabId}: ${e.message}`);
  }
}

export async function readActiveTab() {
  try {
    const [tab] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });
    if (!tab) return err('No active tab');
    await ensureTabLoaded(tab.id);
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['serialize.js'],
      world: 'MAIN',
    });
    const content = scriptResult(results) || '';
    return { tabId: tab.id, title: tab.title, url: tab.url, content };
  } catch (e) {
    return err(`Failed to read active tab: ${e.message}`);
  }
}

export async function getCookies(url) {
  try {
    const cookies = (await chrome.cookies.getAll({ url, partitionKey: {} })).map(({ name, value, domain, path }) => ({
      name,
      value,
      domain,
      path,
    }));
    return { cookies };
  } catch (e) {
    return err(`Failed to get cookies: ${e.message}`);
  }
}

export async function getErrors(tabId) {
  if (tabId == null) return err('tabId is required');
  try {
    await ensureTabLoaded(tabId);
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => window.__page_errors || [],
      world: 'MAIN',
    });
    return { messages: scriptResult(results) || [] };
  } catch (e) {
    return err(`Failed to get errors: ${e.message}`);
  }
}

export async function executeScript(tabId, funcStr, args) {
  if (tabId == null) return err('tabId is required');
  if (!funcStr) return err('funcStr is required');
  const argsJson = JSON.stringify(args || []);
  try {
    await ensureTabLoaded(tabId);
    const nonce = scriptResult(
      await chrome.scripting.executeScript({
        target: { tabId },
        func: () => document.querySelector('script[nonce]')?.nonce,
      }),
    );
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: async (code, argsStr, nonce) => {
        const { promise, resolve, reject } = Promise.withResolvers();
        const callbackId = `agent_tool_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
        window[callbackId] = {
          resolve: (val) => resolve(val),
          reject: (err) => reject(err),
        };
        const blobContent = `
          (async () => {
            const cb = window["${callbackId}"];
            try {
              const args = JSON.parse(${JSON.stringify(argsStr)});
              const result = await (${code})(...args);
              cb.resolve(result);
            } catch(e) {
              cb.reject(e instanceof Error ? { name: e.name, message: e.message, stack: e.stack } : String(e));
            }
          })();
        `;
        const blob = new Blob([blobContent], { type: 'text/javascript' });
        const blobUrl = URL.createObjectURL(blob);
        const script = document.createElement('script');
        if (nonce) script.setAttribute('nonce', nonce);
        script.onerror = reject;
        try {
          script.textContent = window.__firstPolicy.createScript(blobContent);
        } catch {
          script.textContent = window.__browser4agentPolicy.createScript(blobContent);
        }
        document.head.append(script);
        try {
          return await promise;
        } finally {
          URL.revokeObjectURL(blobUrl);
          script.remove();
          delete window[callbackId];
        }
      },
      args: [funcStr, argsJson, nonce],
      world: 'MAIN',
    });
    return { result: scriptResult(results) };
  } catch (e) {
    return err(`Failed to execute script: ${e.message}`);
  }
}

async function getPageWebmcpTools(tabId) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      const tools = window.__webmcp_tools__;
      if (!(tools instanceof Map)) return [];
      return Array.from(tools.values()).map(({ name, description, inputSchema }) => ({
        name: name,
        description: typeof description === 'string' ? description : '',
        inputSchema: inputSchema || { type: 'object', properties: {} },
      }));
    },
    world: 'MAIN',
  });
  return scriptResult(results) || [];
}

export async function listTabTools(tabId) {
  if (tabId == null) return err('tabId is required');
  try {
    const tab = await ensureTabLoaded(tabId);
    const subscribed = await getAvailableTabTools(tabId);
    const pageTools = await getPageWebmcpTools(tabId);
    const tools = [
      ...subscribed.tools,
      ...pageTools.map((t) => ({
        toolsetId: PAGE_TOOLSET_ID,
        toolsetName: PAGE_TOOLSET_NAME,
        toolsetUrl: tab.url,
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      })),
    ];
    return { ...subscribed, tools };
  } catch (e) {
    return err(`Failed to list tab tools: ${e.message}`);
  }
}

export async function executeTabTool(tabId, toolsetId, toolName, args) {
  if (tabId == null) return err('tabId is required');
  if (!toolsetId) return err('toolsetId is required');
  if (!toolName) return err('toolName is required');
  try {
    const tab = await ensureTabLoaded(tabId);
    if (toolsetId === PAGE_TOOLSET_ID) {
      const result = await executeScript(
        tabId,
        `async (name, args) => {
          const tool = window.__webmcp_tools__?.get(name);
          if (!tool) throw new Error('Page WebMCP tool not found: ' + name);
          return await tool.execute(args);
        }`,
        [toolName, args || {}],
      );
      if (result.type === 'error') return result;
      return {
        tabId,
        toolsetId,
        toolsetName: PAGE_TOOLSET_NAME,
        toolName,
        result: result.result,
      };
    }
    const { toolset, tool } = await getSubscribedTool(toolsetId, toolName);
    if (!tool.pattern || !new URLPattern(tool.pattern).test(tab.url)) {
      return err(`Tool ${toolName} does not match tab URL`);
    }
    const result = await executeScript(tabId, tool.execute, [args || {}]);
    if (result.type === 'error') return result;
    return {
      tabId,
      toolsetId,
      toolsetName: toolset.name,
      toolName,
      result: result.result,
    };
  } catch (e) {
    return err(`Failed to execute tab tool: ${e.message}`);
  }
}

export async function executeScriptInBackground(funcStr, args) {
  if (!funcStr) return err('funcStr is required');
  try {
    const result = await exec(funcStr, args);
    return { result };
  } catch (e) {
    return err(`Failed to execute script: ${e.message}`);
  }
}

export async function getLocalStorage(tabId) {
  if (tabId == null) return err('tabId is required');
  try {
    await ensureTabLoaded(tabId);
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: () =>
        Object.fromEntries(
          Object.entries(localStorage).map(([k, v]) => [k, v.length > 1024 ? `... (${v.length} chars)` : v]),
        ),
      world: 'MAIN',
    });
    return { data: scriptResult(results) || {} };
  } catch (e) {
    return err(`Failed to get localStorage: ${e.message}`);
  }
}

export async function screenshotTab(tabId) {
  if (tabId == null) return err('tabId is required');
  try {
    const tab = await ensureTabLoaded(tabId);
    if (!tab.active) {
      await chrome.tabs.update(tabId, { active: true });
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    const format = 'png';
    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format });
    const base64Data = dataUrl.replace(/^data:image\/png;base64,/, '');
    return { tabId, image: base64Data, format };
  } catch (e) {
    return err(`Failed to screenshot tab ${tabId}: ${e.message}`);
  }
}
