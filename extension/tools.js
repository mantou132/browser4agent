import { exec } from './execute-in-bg.js';

const err = (msg) => ({ type: 'error', error: msg });

function scriptResult(results) {
  const { result, error } = results[0] || {};
  if (error) return err(error.message || String(error));
  return result;
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

export async function executeScript(tabId, funcStr) {
  if (tabId == null) return err('tabId is required');
  if (!funcStr) return err('funcStr is required');
  try {
    const nonce = scriptResult(
      await chrome.scripting.executeScript({
        target: { tabId },
        func: () => document.querySelector('script[nonce]')?.nonce,
      }),
    );
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: async (code, nonce) => {
        const { promise, resolve, reject } = Promise.withResolvers();
        const callbackId = `mcp_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
        window[callbackId] = {
          resolve: (val) => resolve(val),
          reject: (err) => reject(err),
        };
        const blobContent = `
          (async () => {
            const cb = window["${callbackId}"];
            try {
              const result = await (${code})();
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
        script.src = blobUrl;
        script.onerror = reject;
        document.head.append(script);
        try {
          return await promise;
        } finally {
          URL.revokeObjectURL(blobUrl);
          script.remove();
          delete window[callbackId];
        }
      },
      args: [funcStr, nonce],
      world: 'MAIN',
    });
    return { result: scriptResult(results) };
  } catch (e) {
    return err(`Failed to execute script: ${e.message}`);
  }
}

export async function executeScriptInBackground(funcStr) {
  if (!funcStr) return err('funcStr is required');
  try {
    const result = await exec(funcStr);
    return { result };
  } catch (e) {
    return err(`Failed to execute script: ${e.message}`);
  }
}

export async function getLocalStorage(tabId) {
  if (tabId == null) return err('tabId is required');
  try {
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
    const tab = await chrome.tabs.get(tabId);
    if (!tab) return err('Tab not found');
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
