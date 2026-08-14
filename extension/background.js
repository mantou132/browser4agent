import { t } from './shared/i18n.js';
import { loadToolset } from './shared/loader.js';
import { ensureAuthToken } from './shared/market-api.js';
import { getToolConfig, persist } from './shared/store.js';
import {
  executeScript,
  executeScriptInBackground,
  executeTabTool,
  getAllTabs,
  getCookies,
  getErrors,
  getLocalStorage,
  listTabTools,
  readActiveTab,
  readTab,
  screenshotTab,
} from './tools.js';

const NATIVE_HOST_NAME = 'browser4agent';
const WELCOME_URL = chrome.runtime.getURL('pages/welcome.html');
const MARKET_URL = chrome.runtime.getURL('pages/market.html');

chrome.runtime.onInstalled.addListener((details) => {
  ensureAuthToken();
  if (details.reason === 'install') {
    chrome.tabs.create({ url: WELCOME_URL });
  }
  if (details.reason === 'update') {
    refreshBuiltinToolsets();
  }
});

async function refreshBuiltinToolsets() {
  const { toolsets } = await getToolConfig();
  const officialToolsets = toolsets.filter((t) => t.type === 'official');
  if (!officialToolsets.length) return;

  const next = toolsets.slice();
  for (const ts of officialToolsets) {
    try {
      const { meta, tools } = await loadToolset(ts.url);
      const idx = next.findIndex((t) => t.id === ts.id);
      if (idx >= 0) {
        next[idx] = { ...next[idx], ...meta, tools };
      }
    } catch {
      // skip toolsets that fail to load
    }
  }
  await persist({ toolsets: next });
}

chrome.contextMenus.create({
  id: 'open-welcome',
  title: t('contextWelcomePage'),
  contexts: ['action'],
});

chrome.contextMenus.create({
  id: 'open-market',
  title: t('contextToolsetMarket'),
  contexts: ['action'],
});

chrome.contextMenus.onClicked.addListener((info) => {
  switch (info.menuItemId) {
    case 'open-welcome':
      chrome.tabs.create({ url: WELCOME_URL });
      break;
    case 'open-market':
      chrome.tabs.create({ url: MARKET_URL });
      break;
  }
});

let port = null;

function sendToHost(msg) {
  if (port) {
    try {
      port.postMessage(msg);
    } catch (e) {
      console.error('Failed to send message to native host:', e);
    }
  } else {
    console.warn('Native host not connected, cannot send message');
  }
}

/**
 * Symmetric duplex RPC peer shared with the native host.
 *
 * Every message is a plain object, classified by shape:
 * - request:      `{ id, method, params? }`
 * - response:     `{ id, result }` or `{ id, error }`
 * - stream event: `{ id, event }` — intermediate frame tied to a request
 * - notification: `{ method, params? }` — no id, fire and forget
 *
 * Both sides use the same API: `call` / `notify` to initiate,
 * `handle` / `onNotify` to serve.
 */
class HostPeer {
  #nextId = 0;
  #pending = new Map();
  #handlers = new Map();
  #notifyHandlers = new Map();

  /** Call the native host and await its final result. */
  call(method, params = {}, { onEvent, timeoutSeconds = 600 } = {}) {
    if (!port) {
      return Promise.reject(new Error(`Native host not connected, cannot call: ${method}`));
    }
    const id = `e${++this.#nextId}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => {
          this.#pending.delete(id);
          reject(new Error(`Timeout waiting for native host response: ${method}`));
        },
        (timeoutSeconds + 5) * 1000,
      );
      this.#pending.set(id, { resolve, reject, timer, onEvent });
      sendToHost({ id, method, params });
    });
  }

  /** Send a fire-and-forget notification to the native host. */
  notify(method, params = {}) {
    sendToHost({ method, params });
  }

  /**
   * Register an async handler for requests from the native host. Its return
   * value becomes the response; a thrown error is reported back as `{ error }`.
   * `ctx.emit(event)` streams intermediate frames before the final result.
   */
  handle(method, handler) {
    this.#handlers.set(method, handler);
  }

  /** Register a handler for notifications from the native host. */
  onNotify(method, handler) {
    this.#notifyHandlers.set(method, handler);
  }

  /** Route one incoming message from the native host. */
  async dispatch(msg) {
    const { id, method } = msg;
    if (id !== undefined && method !== undefined) {
      this.#dispatchRequest(id, method, msg.params);
    } else if (id !== undefined) {
      this.#dispatchReply(id, msg);
    } else if (method !== undefined) {
      const handler = this.#notifyHandlers.get(method);
      if (handler) {
        handler(msg.params);
      } else {
        console.warn('Unhandled notification:', method);
      }
    } else {
      console.warn('Message without id or method:', msg);
    }
  }

  /** Reject all in-flight requests (native host disconnected). */
  rejectAll(error) {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
  }

  async #dispatchRequest(id, method, params) {
    const handler = this.#handlers.get(method);
    if (!handler) {
      sendToHost({ id, error: `Unknown method: ${method}` });
      return;
    }
    try {
      const result = await handler(params ?? {}, { emit: (event) => sendToHost({ id, event }) });
      sendToHost({ id, result: result ?? null });
    } catch (e) {
      sendToHost({ id, error: e?.message || String(e) });
    }
  }

  #dispatchReply(id, msg) {
    // Stream event frame: keep the pending request alive.
    if ('event' in msg) {
      this.#pending.get(id)?.onEvent?.(msg.event);
      return;
    }
    const pending = this.#pending.get(id);
    this.#pending.delete(id);
    if (!pending) return;
    clearTimeout(pending.timer);
    if ('error' in msg) {
      pending.reject(new Error(msg.error));
    } else {
      pending.resolve(msg.result);
    }
  }
}

const peer = new HostPeer();

// chrome.* API handlers served to the native host
peer.handle('get_notifications', () => chrome.notifications.getAll());
peer.handle('query_tab_groups', (p) => chrome.tabGroups.query(p.query || {}));
peer.handle('search_downloads', (p) => chrome.downloads.search(p.query || {}));
peer.handle('search_history', (p) => chrome.history.search(p.query || { text: '' }));
peer.handle('search_bookmarks', (p) => chrome.bookmarks.search(p.query || ''));
peer.handle('get_top_sites', () => chrome.topSites.get());
peer.handle('get_browsing_data_settings', () => chrome.browsingData.settings());
peer.handle('get_recently_closed_sessions', (p) => chrome.sessions.getRecentlyClosed(p.filter || {}));
peer.handle('get_web_navigation_frames', (p) => chrome.webNavigation.getAllFrames({ tabId: p.tabId }));
peer.handle('flush_web_request_cache', async () => {
  await chrome.webRequest.handlerBehaviorChanged();
  return true;
});
peer.handle('search_web', async (p) => {
  await chrome.search.query(p.query || { text: 'browser4agent', disposition: 'NEW_TAB' });
  return true;
});
peer.handle('has_offscreen_document', () => chrome.offscreen.hasDocument());
peer.handle('save_page_as_mhtml', (p) => chrome.pageCapture.saveAsMHTML({ tabId: p.tabId }));
peer.handle('get_favicon_url', (p) =>
  chrome.runtime.getURL(`/_favicon/?pageUrl=${encodeURIComponent(p.pageUrl)}&size=${p.size}`),
);

// MCP tool handlers served to the native host
peer.handle('list_tabs', () => getAllTabs());
peer.handle('read_tab', (p) => readTab(p.tabId));
peer.handle('read_active_tab', () => readActiveTab());
peer.handle('get_cookies', (p) => getCookies(p.url));
peer.handle('get_errors', (p) => getErrors(p.tabId));
peer.handle('execute_script', (p) => executeScript(p.tabId, p.funcStr, p.args));
peer.handle('list_tab_tools', (p) => listTabTools(p.tabId));
peer.handle('execute_tab_tool', (p) => executeTabTool(p.tabId, p.toolsetId, p.toolName, p.args));
peer.handle('execute_script_in_background', (p) => executeScriptInBackground(p.funcStr, p.args));
peer.handle('get_local_storage', (p) => getLocalStorage(p.tabId));
peer.handle('screenshot_tab', (p) => screenshotTab(p.tabId));

peer.onNotify('connected', () => console.log('Connected to native host:', NATIVE_HOST_NAME));
peer.onNotify('agent_session_ended', (params) => {
  console.log('Agent session ended:', params?.sessionId);
});

export async function createAgentSession(options = {}) {
  const params = { cwd: options.cwd, timeoutSeconds: options.timeoutSeconds };
  const result = await peer.call('agent_session_create', params, options);
  return result.sessionId;
}

export async function askAgent(prompt, options = {}) {
  if (typeof prompt !== 'string' || !prompt.trim()) {
    return Promise.reject(new Error('askAgent requires a non-empty prompt'));
  }
  const params = {
    prompt,
    cwd: options.cwd,
    sessionId: options.sessionId,
    timeoutSeconds: options.timeoutSeconds,
    stream: Boolean(options.onEvent),
  };
  const result = await peer.call('agent_prompt', params, options);
  return result.answer || '';
}

/**
 * Ask the agent and stream events like a fetch() response body.
 * Returns `{ body, result }`:
 * - `body` is a ReadableStream of agent events (text deltas, session
 *   updates, stop reason), consumable via `getReader()` or `for await`.
 * - `result` resolves to `{ answer, sessionId }`, or rejects if the prompt
 *   failed — the stream is errored in that case too.
 */
export function askAgentStream(prompt, options = {}) {
  if (typeof prompt !== 'string' || !prompt.trim()) {
    throw new Error('askAgentStream requires a non-empty prompt');
  }
  const { promise: result, resolve, reject } = Promise.withResolvers();
  let controller;
  const body = new ReadableStream({
    start(c) {
      controller = c;
    },
  });
  const params = {
    prompt,
    cwd: options.cwd,
    sessionId: options.sessionId,
    timeoutSeconds: options.timeoutSeconds,
    stream: true,
  };
  peer
    .call('agent_prompt', params, {
      timeoutSeconds: options.timeoutSeconds,
      // The reader may cancel the stream early; don't let enqueue throw
      // back into message dispatch.
      onEvent: (event) => {
        try {
          controller.enqueue(event);
        } catch {
          // stream already cancelled or errored
        }
      },
    })
    .then(
      (r) => {
        controller.close();
        resolve(r);
      },
      (e) => {
        controller.error(e);
        reject(e);
      },
    );
  // Avoid unhandled-rejection when callers only consume `body`.
  result.catch(() => {});
  return { body, result };
}

/**
 * Cancel the in-flight prompt of a session. The pending `askAgent` /
 * `askAgentStream` call settles with the partial answer, and the stream
 * ends with a `stop` event carrying the cancel reason. Returns false when
 * the session is unknown.
 */
export async function cancelAgentPrompt(sessionId, options = {}) {
  if (typeof sessionId !== 'string' || !sessionId) {
    return Promise.reject(new Error('cancelAgentPrompt requires a sessionId'));
  }
  const result = await peer.call('agent_prompt_cancel', { sessionId }, options);
  return result.cancelled;
}

export async function closeAgentSession(sessionId, options = {}) {
  if (typeof sessionId !== 'string' || !sessionId) {
    return Promise.reject(new Error('closeAgentSession requires a sessionId'));
  }
  const params = { sessionId, timeoutSeconds: options.timeoutSeconds };
  const result = await peer.call('agent_session_close', params, options);
  return result.closed;
}

globalThis.createAgentSession = createAgentSession;
globalThis.askAgent = askAgent;
globalThis.askAgentStream = askAgentStream;
globalThis.cancelAgentPrompt = cancelAgentPrompt;
globalThis.closeAgentSession = closeAgentSession;

function connectNativeHost() {
  try {
    port = chrome.runtime.connectNative(NATIVE_HOST_NAME);

    port.onMessage.addListener((msg) => {
      peer.dispatch(msg);
    });

    port.onDisconnect.addListener(() => {
      const error = chrome.runtime.lastError;
      console.error('Native host disconnected:', error?.message || 'unknown error');
      peer.rejectAll(new Error(error?.message || 'Native host disconnected'));
      port = null;
    });
  } catch (e) {
    console.error('Failed to connect to native host:', e);
    port = null;
  }
}

connectNativeHost();

chrome.alarms.create({ periodInMinutes: 0.1 });
chrome.alarms.onAlarm.addListener(async () => {
  if (!port) connectNativeHost();
});

// https://bugzilla.mozilla.org/show_bug.cgi?id=1995451#c3
chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create({ periodInMinutes: 0.1 });
});
