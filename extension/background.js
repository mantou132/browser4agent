import { trackDevtoolsPort } from './shared/devtools-tracker.js';
import { t } from './shared/i18n.js';
import { loadToolset } from './shared/loader.js';
import { ensureAuthToken } from './shared/market-api.js';
import { RpcPeer } from './shared/rpc.js';
import { getToolConfig, persist } from './shared/store.js';
import {
  executeScript,
  executeScriptInBackground,
  executeTabTool,
  getAllTabs,
  getCookies,
  getErrors,
  getLocalStorage,
  readActiveTab,
  readTab,
  screenshotTab,
} from './tools.js';

const NATIVE_HOST_NAME = 'browser4agent';
const WELCOME_URL = chrome.runtime.getURL('pages/welcome.html');
const MARKET_URL = chrome.runtime.getURL('pages/market.html');
// Raise when the extension starts relying on host capabilities that older
// native hosts don't have; hosts below this version get flagged incompatible.
const MIN_HOST_VERSION = '0.2.0';

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
  if (!port) throw new Error('Native host not connected, cannot send message');
  port.postMessage(msg);
}

const peer = new RpcPeer(sendToHost, 'e');

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
peer.handle('execute_tab_tool', (p) => executeTabTool(p.tabId, p.toolsetId, p.toolName, p.args));
peer.handle('execute_script_in_background', (p) => executeScriptInBackground(p.funcStr, p.args));
peer.handle('get_local_storage', (p) => getLocalStorage(p.tabId));
peer.handle('screenshot_tab', (p) => screenshotTab(p.tabId));

const agentSessionOwners = new Map();
const agentPanelPeers = new Set();

function compareVersions(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return Math.sign(d);
  }
  return 0;
}

async function updateHostCompat(version) {
  if (typeof version === 'string' && compareVersions(version, MIN_HOST_VERSION) >= 0) {
    await chrome.action.setBadgeText({ text: '' });
    await chrome.action.setTitle({ title: t('actionTitle') });
    return;
  }
  await chrome.action.setBadgeBackgroundColor({ color: '#ef4444' });
  await chrome.action.setBadgeText({ text: '!' });
  chrome.action.setBadgeTextColor?.({ color: '#ffffff' });
  await chrome.action.setTitle({ title: t('hostIncompatTitle') });
}

peer.onNotify('connected', (params) => {
  console.log('Connected to native host:', NATIVE_HOST_NAME);
  updateHostCompat(params?.version).catch((e) => console.error('Failed to check host compat:', e));
  // Tell the host what this engine supports so it can hide MCP tools the
  // browser can't serve. Firefox exposes getBrowserInfo; Chromium doesn't.
  const isFirefox = typeof chrome.runtime.getBrowserInfo === 'function';
  peer.notify('capabilities', {
    browser: isFirefox ? 'firefox' : 'chromium',
    debuggerAvailable: !isFirefox,
  });
  // A (re)connected host process knows no live sessions; panels must drop
  // their cached state.
  for (const panel of agentPanelPeers) panel.notify('host_reconnected', {});
});
peer.onNotify('agent_session_ended', (params) => {
  console.log('Agent session ended:', params?.sessionId);
  agentSessionOwners.delete(params?.sessionId);
  // Panels keep per-session state for live sessions; let them drop dead ones.
  for (const panel of agentPanelPeers) panel.notify('agent_session_ended', params);
});

peer.handle('agent_permission_request', async (params) => {
  const owner = agentSessionOwners.get(params?.sessionId);
  if (!owner) throw new Error('No Agent panel owns this session');
  return owner.call('agent_permission_request', params);
});

/**
 * DevTools panel bridge: the panel (`shared/agent-api.js`) speaks the same
 * RPC protocol over a runtime port named `agent-rpc`. Forward its `agent_*`
 * requests to the native host peer and relay the `{ id, event }` stream
 * frames and final responses back unchanged.
 */
const AGENT_METHODS = [
  'agent_cwd_complete',
  'agent_session_create',
  'agent_session_load',
  'agent_session_list',
  'agent_session_delete',
  'agent_session_close',
  'agent_prompt',
  'agent_prompt_cancel',
  'agent_session_set_mode',
  'agent_session_set_config_option',
];

chrome.runtime.onConnect.addListener((panelPort) => {
  if (panelPort.name === 'devtools-alive') return trackDevtoolsPort(panelPort);
  if (panelPort.name !== 'agent-rpc') return;
  const panel = new RpcPeer((msg) => panelPort.postMessage(msg), 'p');
  panelPort.onMessage.addListener((msg) => panel.dispatch(msg));
  agentPanelPeers.add(panel);
  // Live sessions opened by this panel instance; closed when the panel
  // disconnects (devtools closed) so the agent subprocesses don't leak.
  const liveSessions = new Set();
  let disconnected = false;
  panelPort.onDisconnect.addListener(() => {
    disconnected = true;
    agentPanelPeers.delete(panel);
    panel.rejectAll(new Error('Agent panel disconnected'));
    for (const sessionId of liveSessions) {
      if (agentSessionOwners.get(sessionId) === panel) agentSessionOwners.delete(sessionId);
      peer.call('agent_session_close', { sessionId }).catch(() => {});
    }
  });
  for (const method of AGENT_METHODS) {
    panel.handle(method, async (params, { emit }) => {
      const result = await peer.call(method, params, {
        onEvent: emit,
        timeoutSeconds: params.timeoutSeconds,
      });
      if (method === 'agent_session_create' || method === 'agent_session_load') {
        // A create/load settling after disconnect would leak the session.
        if (disconnected) {
          peer.call('agent_session_close', { sessionId: result.sessionId }).catch(() => {});
        } else {
          liveSessions.add(result.sessionId);
          agentSessionOwners.set(result.sessionId, panel);
        }
      } else if (method === 'agent_session_close') {
        liveSessions.delete(params.sessionId);
        if (agentSessionOwners.get(params.sessionId) === panel) agentSessionOwners.delete(params.sessionId);
      }
      return result;
    });
  }
});

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
