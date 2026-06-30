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

let nextAgentRequestId = 0;
const pendingAgentRequests = new Map();

function rejectPendingAgentRequests(error) {
  for (const pending of pendingAgentRequests.values()) {
    clearTimeout(pending.timer);
    pending.reject(error);
  }
  pendingAgentRequests.clear();
}

function sendAgentRequest(message, { timeoutSeconds = 600, onEvent } = {}) {
  const request_id = `agent_${++nextAgentRequestId}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => {
        pendingAgentRequests.delete(request_id);
        reject(new Error('Timeout waiting for native host agent response'));
      },
      (timeoutSeconds + 5) * 1000,
    );
    pendingAgentRequests.set(request_id, { resolve, reject, timer, onEvent });
    sendToHost({ timeoutSeconds, stream: Boolean(onEvent), ...message, request_id });
  });
}

export async function createAgentSession(options = {}) {
  const msg = { type: 'agent_session_create', cwd: options.cwd };
  const result = await sendAgentRequest(msg, options);
  return result.sessionId;
}

export async function askAgent(prompt, options = {}) {
  if (typeof prompt !== 'string' || !prompt.trim()) {
    return Promise.reject(new Error('askAgent requires a non-empty prompt'));
  }
  const msg = { type: 'agent_prompt', prompt, cwd: options.cwd, sessionId: options.sessionId };
  const result = await sendAgentRequest(msg, options);
  return result.answer || '';
}

export async function closeAgentSession(sessionId, options = {}) {
  if (typeof sessionId !== 'string' || !sessionId) {
    return Promise.reject(new Error('closeAgentSession requires a sessionId'));
  }
  const msg = { type: 'agent_session_close', sessionId };
  const result = await sendAgentRequest(msg, options);
  return result.closed;
}

globalThis.createAgentSession = createAgentSession;
globalThis.askAgent = askAgent;
globalThis.closeAgentSession = closeAgentSession;

function handleMessageFromHost(msg) {
  const { request_id, ...rest } = msg;
  switch (msg.type) {
    case 'agent_event': {
      pendingAgentRequests.get(request_id)?.onEvent?.(rest.data);
      break;
    }
    case 'agent_session_created':
    case 'agent_response':
    case 'agent_error':
    case 'agent_session_closed': {
      const pending = pendingAgentRequests.get(request_id);
      pendingAgentRequests.delete(request_id);
      clearTimeout(pending?.timer);
      msg.type === 'agent_error' ? pending?.reject(new Error(rest.error)) : pending?.resolve(rest);
      break;
    }

    case 'connected':
      console.log('Connected to native host:', NATIVE_HOST_NAME);
      break;
    case 'get_notifications':
      chrome.notifications.getAll().then((result) => {
        sendToHost({ result, request_id });
      });
      break;
    case 'query_tab_groups':
      chrome.tabGroups.query(rest.query || {}).then((result) => {
        sendToHost({ result, request_id });
      });
      break;
    case 'search_downloads':
      chrome.downloads.search(rest.query || {}).then((result) => {
        sendToHost({ result, request_id });
      });
      break;
    case 'search_history':
      chrome.history.search(rest.query || { text: '' }).then((result) => {
        sendToHost({ result, request_id });
      });
      break;
    case 'search_bookmarks':
      chrome.bookmarks.search(rest.query || '').then((result) => {
        sendToHost({ result, request_id });
      });
      break;
    case 'get_top_sites':
      chrome.topSites.get().then((result) => {
        sendToHost({ result, request_id });
      });
      break;
    case 'get_browsing_data_settings':
      chrome.browsingData.settings().then((result) => {
        sendToHost({ result, request_id });
      });
      break;
    case 'get_recently_closed_sessions':
      chrome.sessions.getRecentlyClosed(rest.filter || {}).then((result) => {
        sendToHost({ result, request_id });
      });
      break;
    case 'get_web_navigation_frames':
      chrome.webNavigation.getAllFrames({ tabId: rest.tabId }).then((result) => {
        sendToHost({ result, request_id });
      });
      break;
    case 'flush_web_request_cache':
      chrome.webRequest.handlerBehaviorChanged().then(() => {
        sendToHost({ result: true, request_id });
      });
      break;
    case 'search_web':
      chrome.search.query(rest.query || { text: 'browser4agent', disposition: 'NEW_TAB' }).then(() => {
        sendToHost({ result: true, request_id });
      });
      break;
    case 'has_offscreen_document':
      chrome.offscreen.hasDocument().then((result) => {
        sendToHost({ result, request_id });
      });
      break;
    case 'save_page_as_mhtml':
      chrome.pageCapture.saveAsMHTML({ tabId: rest.tabId }).then((result) => {
        sendToHost({ result, request_id });
      });
      break;
    case 'get_favicon_url':
      sendToHost({
        result: chrome.runtime.getURL(`/_favicon/?pageUrl=${encodeURIComponent(rest.pageUrl)}&size=${rest.size}`),
        request_id,
      });
      break;
    // below is MCP tools
    case 'list_tabs':
      getAllTabs().then((result) => {
        sendToHost({ ...result, request_id });
      });
      break;
    case 'read_tab':
      readTab(rest.tabId).then((result) => {
        sendToHost({ ...result, request_id });
      });
      break;
    case 'read_active_tab':
      readActiveTab().then((result) => {
        sendToHost({ ...result, request_id });
      });
      break;
    case 'get_cookies':
      getCookies(rest.url).then((result) => {
        sendToHost({ ...result, request_id });
      });
      break;
    case 'get_errors':
      getErrors(rest.tabId).then((result) => {
        sendToHost({ ...result, request_id });
      });
      break;
    case 'execute_script':
      executeScript(rest.tabId, rest.funcStr, rest.args).then((result) => {
        sendToHost({ ...result, request_id });
      });
      break;
    case 'list_tab_tools':
      listTabTools(rest.tabId).then((result) => {
        sendToHost({ ...result, request_id });
      });
      break;
    case 'execute_tab_tool':
      executeTabTool(rest.tabId, rest.toolsetId, rest.toolName, rest.args).then((result) => {
        sendToHost({ ...result, request_id });
      });
      break;
    case 'execute_script_in_background':
      executeScriptInBackground(rest.funcStr, rest.args).then((result) => {
        sendToHost({ ...result, request_id });
      });
      break;
    case 'get_local_storage':
      getLocalStorage(rest.tabId).then((result) => {
        sendToHost({ ...result, request_id });
      });
      break;
    case 'screenshot_tab':
      screenshotTab(rest.tabId).then((result) => {
        sendToHost({ ...result, request_id });
      });
      break;
    default:
      console.warn('Unknown message type:', msg.type);
  }
}

function connectNativeHost() {
  try {
    port = chrome.runtime.connectNative(NATIVE_HOST_NAME);

    port.onMessage.addListener((msg) => {
      handleMessageFromHost(msg);
    });

    port.onDisconnect.addListener(() => {
      const error = chrome.runtime.lastError;
      console.error('Native host disconnected:', error?.message || 'unknown error');
      rejectPendingAgentRequests(new Error(error?.message || 'Native host disconnected'));
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
