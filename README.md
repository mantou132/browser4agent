# Browser for AI Agent

[English](./README.md) | [中文](./README.zh-CN.md)

A browser extension that lets AI agents read the contents of browser tabs and control the browser.

**Read content**: AI agents can directly read page content, cookies, localStorage, page errors, and more.

**Control the browser**: by running scripts in the extension's background, AI agents can autonomously manage tabs and windows.

**Run scripts in tabs**: execute scripts inside pages. Simple ones can be written by the AI agent on the fly; complex tasks should be exposed as page tools that the AI agent calls directly. Page tools are described in detail below.

> ⚠️ **Security warning**:
> - Make sure your AI agent environment is not vulnerable to prompt injection — otherwise an attacker can read your browser data through the extension.
> - Make sure page tools come from trusted sources; malicious tools can execute arbitrary scripts in your browser.

## Page tools

AI agents can invoke tools inside a tab to perform specific operations on the page. Tools come from two sources:

- **Subscribed toolsets**: subscribe to toolsets in the extension settings; available tools are filtered by the tab URL.
- **Developer-provided tools**: page developers register tools via the [WebMCP][5] API.

[5]: https://webmachinelearning.github.io/webmcp/

## Install

Install the browser extension; the welcome page that opens afterwards walks you through downloading and registering the Native Host, plus optional MCP / Skills setup for your AI agent.

- **Chrome Web Store / Firefox Add-ons**: pending review.
- **From the latest release**: download `extension-chrome.zip` or `extension-firefox.zip` from the [latest release](https://github.com/mantou132/browser-data-mcp/releases/latest), unzip it, then load it via "Load an unpacked extension" below.

### Load an unpacked extension

- Chrome / Edge: open `chrome://extensions`, enable "Developer mode", click "Load unpacked", and choose the unzipped extension directory.
- Firefox: open `about:debugging`, click "Load Temporary Add-on", and choose `manifest.json` inside the unzipped directory.

> **Note:** Because the extension needs to listen on a local port, only one browser will work if the extension is installed and active in multiple browsers at the same time.

## Build from source

```bash
# Browser extension, output in extension/dist/<browser>
pnpm -C extension run build --browser=chrome
# Native Host — runs the binary in setup mode after build
cargo run
```

Load `extension/dist/<browser>` via "Load an unpacked extension" above.

# Privacy policy

Browser for AI Agent processes browser data only to provide its core MCP browser automation features. Depending on the user's request, the extension may access tab metadata, page content, cookies, localStorage, page errors, screenshots, and toolset configuration. Data is sent only to the local Native Messaging Host and the user-configured MCP client/AI agent. We do not sell user data, use it for advertising, or use it for unrelated purposes. Users should only connect trusted AI agents and install trusted toolsets.
