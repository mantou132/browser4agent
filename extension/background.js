import {
  executeScript,
  getAllTabs,
  getCookies,
  getErrors,
  getLocalStorage,
  readActiveTab,
  readTab,
} from "./tools.js";

const NATIVE_HOST_NAME = "browser_data_mcp";

function sendToHost(msg) {
  if (port) {
    try {
      port.postMessage(msg);
    } catch (e) {
      console.error("Failed to send message to native host:", e);
    }
  } else {
    console.warn("Native host not connected, cannot send message");
  }
}

function handleMessageFromHost(msg) {
  const { request_id, ...rest } = msg;
  switch (msg.type) {
    case "connected":
      console.log("Connected to native host:", NATIVE_HOST_NAME);
      break;
    case "list_tabs":
      getAllTabs().then((result) => {
        sendToHost({ ...result, request_id });
      });
      break;
    case "read_tab":
      readTab(rest.tabId).then((result) => {
        sendToHost({ ...result, request_id });
      });
      break;
    case "read_active_tab":
      readActiveTab().then((result) => {
        sendToHost({ ...result, request_id });
      });
      break;
    case "get_cookies":
      getCookies(rest.url).then((result) => {
        sendToHost({ ...result, request_id });
      });
      break;
    case "get_errors":
      getErrors(rest.tabId).then((result) => {
        sendToHost({ ...result, request_id });
      });
      break;
    case "execute_script":
      executeScript(rest.tabId, rest.funcStr).then((result) => {
        sendToHost({ ...result, request_id });
      });
      break;
    case "get_local_storage":
      getLocalStorage(rest.tabId).then((result) => {
        sendToHost({ ...result, request_id });
      });
      break;
    default:
      console.warn("Unknown message type:", msg.type);
  }
}

let port = null;

function connectNativeHost() {
  try {
    port = chrome.runtime.connectNative(NATIVE_HOST_NAME);

    port.onMessage.addListener((msg) => {
      handleMessageFromHost(msg);
    });

    port.onDisconnect.addListener(() => {
      const error = chrome.runtime.lastError;
      console.error(
        "Native host disconnected:",
        error?.message || "unknown error",
      );
      port = null;
      setTimeout(connectNativeHost, 1000);
    });
  } catch (e) {
    console.error("Failed to connect to native host:", e);
    port = null;
    setTimeout(connectNativeHost, 1000);
  }
}

connectNativeHost();
