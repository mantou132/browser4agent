// 前导 / 表示扩展根目录：Firefox 把相对路径解析到 devtools 页面所在目录
chrome.devtools.panels.create('Agent', '', '/pages/agent-panel.html');

// Tell the background that this tab has DevTools open (read_tab flags it;
// chrome.debugger can't attach while DevTools holds the target). Chromium
// keeps the service worker alive via the native messaging port, so usually
// the initial announce is enough; reconnect covers background restarts.
const tabId = chrome.devtools.inspectedWindow.tabId;

function connect() {
  const port = chrome.runtime.connect({ name: 'devtools-alive' });
  port.onDisconnect.addListener(() => setTimeout(connect, 1000));
  port.postMessage({ tabId });
}

connect();
