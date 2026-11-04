import { debuggerDetach, debuggerSendCommand, isDebuggerAttached } from './debugger.js';
import { exec } from './execute-in-bg.js';
import { devtoolsOpenTabs } from './shared/devtools-tracker.js';
import { getAvailableTabTools, getSubscribedTool } from './shared/tool-store.js';

// Surfaces the DevTools-open state in read results so agents can avoid
// debugger tools on that tab before trying them.
function withDevtoolsFlag(result, tabId) {
  if (devtoolsOpenTabs.has(tabId)) {
    return {
      ...result,
      devtoolsOpen: true,
      devtoolsHint: 'DevTools is open on this tab; chrome.debugger cannot attach until it is closed.',
    };
  }
  return result;
}

// Pseudo toolset id used for tools that the page itself registered via
// `document.modelContext.registerTool` (WebMCP). They are not stored in
// chrome.storage; metadata is fetched live from the tab and `execute` is
// invoked through the in-page reference kept on `window.__webmcp_tools__`.
const PAGE_TOOLSET_ID = 'webmcp';
const PAGE_TOOLSET_NAME = 'Page WebMCP Tools';

// All tool functions throw on failure; the peer turns the thrown message
// into an `{ id, error }` response frame.
function scriptResult(results) {
  const { result, error } = results[0] || {};
  if (error) throw new Error(error.message || String(error));
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
  // Chrome freezes tabs in collapsed groups (such as the quiet B4A group) and script injection hangs until
  // they thaw; expanding the group unfreezes them within milliseconds.
  if (tab.frozen && tab.groupId !== chrome.tabGroups.TAB_GROUP_ID_NONE) {
    await chrome.tabGroups.update(tab.groupId, { collapsed: false });
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
    throw new Error(`Failed to get tabs: ${e.message}`);
  }
}

export async function readTab(tabId) {
  if (tabId == null) throw new Error('tabId is required');
  try {
    await ensureTabLoaded(tabId);
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      files: ['serialize.js'],
      world: 'MAIN',
    });
    const content = scriptResult(results) || '';
    const tools = await getTabTools(tabId);
    return withDevtoolsFlag({ tabId, tools, content }, tabId);
  } catch (e) {
    throw new Error(`Failed to read tab ${tabId}: ${e.message}`);
  }
}

export async function readActiveTab() {
  try {
    const [tab] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });
    if (!tab) throw new Error('No active tab');
    await ensureTabLoaded(tab.id);
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['serialize.js'],
      world: 'MAIN',
    });
    const content = scriptResult(results) || '';
    const tools = await getTabTools(tab.id);
    return withDevtoolsFlag({ tabId: tab.id, title: tab.title, url: tab.url, tools, content }, tab.id);
  } catch (e) {
    throw new Error(`Failed to read active tab: ${e.message}`);
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
    throw new Error(`Failed to get cookies: ${e.message}`);
  }
}

export async function getErrors(tabId) {
  if (tabId == null) throw new Error('tabId is required');
  try {
    await ensureTabLoaded(tabId);
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => window.__page_errors || [],
      world: 'MAIN',
    });
    return { messages: scriptResult(results) || [] };
  } catch (e) {
    throw new Error(`Failed to get errors: ${e.message}`);
  }
}

export async function executeScript(tabId, funcStr, args) {
  if (tabId == null) throw new Error('tabId is required');
  if (!funcStr) throw new Error('funcStr is required');
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
        const { promise, resolve: resolvePromise, reject: rejectPromise } = Promise.withResolvers();
        let settled = false;
        const resolve = (value) => {
          settled = true;
          resolvePromise(value);
        };
        const reject = (reason) => {
          settled = true;
          rejectPromise(reason);
        };
        const callbackId = `agent_tool_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
        const cb = { started: false, resolve, reject };
        window[callbackId] = cb;
        // The first statement marks the script as running, so a launcher can tell whether CSP blocked it:
        // blocked inline scripts fire neither `error` on the element nor a window error event.
        const blobContent = `
          (async () => {
            const cb = window["${callbackId}"];
            cb.started = true;
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
        const trusted = (method, value) => {
          try {
            const result = window.__firstPolicy[method](value);
            if (result.toString() !== value) throw new Error('invalid policy');
            return result;
          } catch {
            return window.__browser4agentPolicy[method](value);
          }
        };
        let scriptSrc;
        const onViolation = (e) => {
          if (e.effectiveDirective.startsWith('script-src')) {
            scriptSrc ??= e.originalPolicy
              .split(';')
              .find((d) => /^\s*script-src(-elem)?\s/.test(d))
              ?.trim();
          }
        };
        document.addEventListener('securitypolicyviolation', onViolation);
        const scripts = [];
        const createScript = () => {
          const script = document.createElement('script');
          if (nonce) script.setAttribute('nonce', nonce);
          scripts.push(script);
          return script;
        };
        const launchInline = () => {
          const script = createScript();
          script.textContent = trusted('createScript', blobContent);
          // A script that fails to parse never fires onerror; the browser reports it synchronously as a
          // window error event during insertion.
          const onParseError = (e) => reject(e.message);
          window.addEventListener('error', onParseError);
          document.head.append(script);
          window.removeEventListener('error', onParseError);
        };
        // Allowed by CSPs that list `blob:` in script-src without 'unsafe-inline'.
        const launchBlob = () => {
          const { promise: loaded, resolve: done } = Promise.withResolvers();
          const script = createScript();
          script.onload = done;
          script.onerror = done;
          const onParseError = (e) => {
            if (e.filename === blobUrl) reject(e.message);
          };
          window.addEventListener('error', onParseError);
          script.src = trusted('createScriptURL', blobUrl);
          document.head.append(script);
          return loaded.finally(() => window.removeEventListener('error', onParseError));
        };
        // Allowed by CSPs with 'unsafe-eval'; throws EvalError when CSP blocks it.
        const launchEval = () => {
          try {
            // biome-ignore lint/security/noGlobalEval: last-resort launcher for pages whose CSP blocks scripts
            window.eval(trusted('createScript', blobContent));
          } catch (e) {
            if (!(e instanceof EvalError)) reject(e.message);
          }
        };
        // Chrome reports neither `result` nor `error` for an injected function whose promise rejects,
        // so failures are returned as data and rethrown on the extension side.
        try {
          for (const launch of [launchInline, launchBlob, launchEval]) {
            await launch();
            if (cb.started || settled) break;
          }
          if (!cb.started && !settled) {
            const policy = scriptSrc ? ` (${scriptSrc})` : '';
            throw new Error(
              `The page's Content-Security-Policy${policy} blocks inline scripts, blob: scripts and eval, so the script cannot run on this page`,
            );
          }
          return { value: await promise };
        } catch (error) {
          return { error: error instanceof Error ? { name: error.name, message: error.message } : error };
        } finally {
          document.removeEventListener('securitypolicyviolation', onViolation);
          URL.revokeObjectURL(blobUrl);
          for (const script of scripts) script.remove();
          delete window[callbackId];
        }
      },
      args: [funcStr, argsJson, nonce],
      world: 'MAIN',
    });
    const { value, error } = scriptResult(results);
    if (error) throw new Error(typeof error === 'string' ? error : `${error.name ?? 'Error'}: ${error.message}`);
    return { result: value ?? null };
  } catch (e) {
    throw new Error(`Failed to execute script: ${e.message}`);
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

async function getTabTools(tabId) {
  const [subscribed, pageTools] = await Promise.all([getAvailableTabTools(tabId), getPageWebmcpTools(tabId)]);
  return [
    ...subscribed.tools,
    ...pageTools.map((t) => ({
      toolsetId: PAGE_TOOLSET_ID,
      toolsetName: PAGE_TOOLSET_NAME,
      toolsetUrl: subscribed.url,
      ...t,
    })),
  ];
}

export async function executeTabTool(tabId, toolsetId, toolName, args) {
  if (tabId == null) throw new Error('tabId is required');
  if (!toolsetId) throw new Error('toolsetId is required');
  if (!toolName) throw new Error('toolName is required');
  try {
    const tab = await ensureTabLoaded(tabId);
    if (toolsetId === PAGE_TOOLSET_ID) {
      const result = await executeScript(
        tabId,
        `async (name, args) => {
          const tool = window.__webmcp_tools__?.get(name);
          if (!tool) throw new Error('Page WebMCP tool not found: ' + name);
          return await tool.execute(args, { signal: new AbortController().signal });
        }`,
        [toolName, args || {}],
      );
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
      throw new Error(`Tool ${toolName} does not match tab URL`);
    }
    const result = await executeScript(tabId, tool.execute, [args || {}]);
    return {
      tabId,
      toolsetId,
      toolsetName: toolset.name,
      toolName,
      result: result.result,
    };
  } catch (e) {
    throw new Error(`Failed to execute tab tool: ${e.message}`);
  }
}

export async function executeScriptInBackground(funcStr, args) {
  if (!funcStr) throw new Error('funcStr is required');
  try {
    const { value: result, logs } = await exec(funcStr, args);
    return { result, logs };
  } catch (e) {
    throw new Error(`Failed to execute script: ${e.message}`);
  }
}

export async function getLocalStorage(tabId) {
  if (tabId == null) throw new Error('tabId is required');
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
    throw new Error(`Failed to get localStorage: ${e.message}`);
  }
}

export async function screenshotTab(tabId) {
  if (tabId == null) throw new Error('tabId is required');
  try {
    const tab = await ensureTabLoaded(tabId);
    // Background tabs are hidden too, so this also covers windows that are not visible (screen locked, minimized, covered)
    let hidden = await isTabHidden(tabId);
    // CDP renders hidden tabs without switching the user's view away
    if (hidden && chrome.debugger) {
      try {
        return { image: await captureWithDebugger(tabId) };
      } catch {
        // Tabs with DevTools open can't be attached; activate them instead
      }
    }
    if (!tab.active) {
      await chrome.tabs.update(tabId, { active: true });
      await new Promise((resolve) => setTimeout(resolve, 300));
      hidden = await isTabHidden(tabId);
    }
    // captureVisibleTab silently returns the last stale frame while the window is not visible
    if (hidden) {
      throw new Error(
        'the browser window is not visible (screen locked, minimized or covered); retry once it is shown',
      );
    }
    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
    return { image: dataUrl.replace(/^data:image\/png;base64,/, '') };
  } catch (e) {
    throw new Error(`Failed to screenshot tab ${tabId}: ${e.message}`);
  }
}

async function isTabHidden(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => document.visibilityState,
    });
    return scriptResult(results) === 'hidden';
  } catch {
    // Pages that reject injection go on to captureVisibleTab, which either captures them or reports why it can't
    return false;
  }
}

async function captureWithDebugger(tabId) {
  const wasAttached = await isDebuggerAttached(tabId);
  try {
    const { data } = await debuggerSendCommand(tabId, 'Page.captureScreenshot');
    return data;
  } finally {
    if (!wasAttached) await debuggerDetach(tabId);
  }
}
