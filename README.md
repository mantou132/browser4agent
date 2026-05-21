# Browser for AI Agent

[English](./README.md) | [中文](./README.zh-CN.md)

A browser extension that lets AI agents read the contents of browser tabs and control the browser.

**Read content**: AI agents can directly read page content, cookies, localStorage, page errors, and more.

**Control the browser**: by running scripts in the extension's background, AI agents can autonomously manage tabs and windows.

**Run scripts in tabs**: execute scripts inside pages. Simple ones can be written by the AI agent on the fly; complex tasks should be exposed as page tools that the AI agent calls directly. Page tools are described in detail below.

> ⚠️ **Security warning**:
> - Make sure your AI agent environment is not vulnerable to prompt injection — otherwise an attacker can read your browser data through the extension.
> - Make sure page tools come from trusted sources; malicious tools can execute arbitrary scripts in your browser.

## Install and use

### 1. Download and install the browser extension

Load the `dist/xxx` directory as an unpacked extension in your browser:

- Chrome/Edge: open `chrome://extensions`, enable "Developer mode", click "Load unpacked", and choose the `dist/chrome` directory
- Firefox: open `about:debugging`, click "Load Temporary Add-on", and choose `manifest.json` inside the `dist/firefox` directory

> **Note:** Because the extension needs to listen on a local port, only one browser will work if the extension is installed and active in multiple browsers at the same time.

### 2. Download the executable and initialize

Double-click the executable. It will automatically register the Native Messaging Host (a manifest file is written, plus a registry entry on Windows) so the browser extension can locate and connect to it.
It will also configure MCP for the AI agents installed on your machine. Press any key to close the window when finished.
If your AI agent is not configured automatically, set it up manually per the AI agent's documentation. URL: `http://127.0.0.1:39271/mcp`

> **Note:** After initialization, do not move or delete the executable — the browser launches it from the registered path.

### Page tools

AI agents can invoke tools inside a tab to perform specific operations on the page. Tools come from two sources:

- **Subscribed toolsets**: subscribe to toolsets in the extension settings; available tools are filtered by the tab URL.
- **Developer-provided tools**: page developers register tools via the [WebMCP][5] API.

[5]: https://webmachinelearning.github.io/webmcp/

## Supported browsers

- Chromium-based browsers
- Firefox

## Build from source

```bash
# Browser extension, output in dist/xxx
npm run build
# Native Host for the browser extension
# Output at `target/release/browser4agent` (`.exe` on Windows)
cargo build --release
```

# Privacy policy

Browser for AI Agent processes browser data only to provide its core MCP browser automation features. Depending on the user's request, the extension may access tab metadata, page content, cookies, localStorage, page errors, screenshots, and toolset configuration. Data is sent only to the local Native Messaging Host and the user-configured MCP client/AI agent. We do not sell user data, use it for advertising, or use it for unrelated purposes. Users should only connect trusted AI agents and install trusted toolsets.
