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

function handleMessageFromHost(msg) {
  const { request_id, ...rest } = msg;
  switch (msg.type) {
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
    case 'get_alarm':
      chrome.alarms.get(rest.name || 'browser4agent').then((result) => {
        sendToHost({ result, request_id });
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
      port = null;
      setTimeout(connectNativeHost, 1000);
    });
  } catch (e) {
    console.error('Failed to connect to native host:', e);
    port = null;
    setTimeout(connectNativeHost, 1000);
  }
}

connectNativeHost();
