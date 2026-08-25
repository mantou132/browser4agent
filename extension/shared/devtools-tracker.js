// Tabs whose DevTools window is currently open. The devtools page announces
// itself over a `devtools-alive` port when DevTools opens; a port dying means
// DevTools closed, crashed, or the background restarted. Shared module so
// background.js (tracking) and tools.js (read_tab readers) see one set.
export const devtoolsOpenTabs = new Set();

const tabByPort = new Map();

export function trackDevtoolsPort(port) {
  port.onMessage.addListener((msg) => {
    if (typeof msg?.tabId !== 'number') return;
    tabByPort.set(port, msg.tabId);
    devtoolsOpenTabs.add(msg.tabId);
  });
  port.onDisconnect.addListener(() => {
    const tabId = tabByPort.get(port);
    tabByPort.delete(port);
    devtoolsOpenTabs.delete(tabId);
  });
}
