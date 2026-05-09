# Browser MCP

一个让 AI Agent 读取浏览器标签页内容、操控浏览器的 MCP 服务。

**读取内容**：当浏览器中打开了内部系统或包含个人数据的网页时，可以直接读取页面内容、Cookie、localStorage、页面错误等。适用于无法通过普通 HTTP 请求访问的本地服务、内网系统或需要登录的页面。

**操控浏览器**：通过在扩展后台执行脚本，可以管理标签页和窗口、拦截/修改网络请求、操作下载等，实现浏览器自动化。

> ⚠️ **安全警告**：仅在你完全信任的环境中使用，应该避免提示词攻击窃取信息。

## 工作原理

```
Agent (Cursor/Claude Code 等)
    │
    │  MCP over HTTP (本地连接)
    ▼
本地进程 (browser-mcp)
    │
    │  Native Messaging (stdin/stdout)
    ▼
浏览器扩展
    │
    │  Chrome Scripting API / Firefox WebExtensions API
    ▼
标签页内容
```

Agent 通过 MCP 协议与本地进程通信，本地进程将 MCP 消息通过 Native Messaging 透传给浏览器扩展，浏览器扩展通过脚本注入读取标签页内容、在标签页或扩展后台执行脚本，并返回结果。

## 比较

| 工具 | 技术实现 | 操作当前浏览器 | 需要额外配置 |
| --- | --- | --- | --- |
| **browser-mcp** (本项目) | 浏览器扩展 API | ✅ 是 | ⚠️ 否，安装扩展即可 |
| **[Claude for Chrome][1]** | 浏览器扩展 API | ✅ 是 | ⚠️ 否，安装扩展即可 |
| [chrome-devtools-mcp][2] | CDP (Chrome DevTools Protocol) | ❌ 否 | ⚠️ 需开启 Chrome 远程调试 (`--remote-debugging-port`) |
| [playwright-mcp][3] | Playwright (底层 CDP) | ❌ 否 | ⚠️ 否，自动管理浏览器 |
| [browser-use][4] | Playwright (底层 CDP) + Python Agent 框架 | ❌ 否 | ⚠️ 或需提供 CDP endpoint |

[1]: https://claude.com/claude-for-chrome
[2]: https://github.com/executeautomation/chrome-mcp-server
[3]: https://github.com/microsoft/playwright-mcp
[4]: https://github.com/browser-use/browser-use

## 安装与使用

### 1. 下载并安装浏览器扩展

将 `extension/x` 目录作为未打包扩展加载到浏览器中：

- Chrome/Edge：打开 `chrome://extensions`，开启「开发者模式」，点击「加载已解压的扩展程序」，选择 `dist/chrome` 目录
- Firefox：打开 `about:debugging`，点击「临时加载附加组件」，选择 `dist/firefox` 目录中的 `manifest.json`

> 目前仅支持一个浏览器。扩展安装后会自动以 Native Messaging 方式启动本地进程，进程启动后即提供 MCP 服务，无需手动启动。

### 2. 下载可执行程序并初始化

双击可执行程序，将自动注册 Native Messaging Host（写入清单文件，Windows 上还会写入注册表），使浏览器扩展能够找到并连接该程序。完成后按任意键关闭窗口。

初始化会自动在本机的 AI Agent 中配置 MCP，如果没有配置，请自行配置 HTTP MCP：`http://127.0.0.1:39271/mcp`

> **注意：** 初始化完成后，不能再移动或删除可执行文件，因为浏览器会根据注册的路径查找它。

## 工具说明

| 工具名称 | 功能 | 安全等级 |
| --- | --- | --- |
| `list_tabs` | 列出所有打开的标签页 | ✅ 安全 |
| `read_tab` | 读取指定标签页的精简 HTML | ✅ 安全 |
| `read_active_tab` | 读取当前活动标签页的精简 HTML | ✅ 安全 |
| `screenshot_tab` | 对指定标签页进行截图，返回 PNG 图片 | ✅ 安全 |
| `get_cookies` | 获取指定 URL 的 cookie | ⚠️ 敏感 |
| `get_errors` | 获取页面错误信息 | ✅ 安全 |
| `get_local_storage` | 获取页面 localStorage 数据 | ⚠️ 敏感 |
| `execute_script` | 在标签页中执行 JavaScript | 🔴 高风险 |
| `execute_script_in_background` | 在扩展后台执行 JavaScript，操控浏览器 | 🔴 高风险 |
| `list_tab_tools` | 列出指定标签页可用的页面工具 | ✅ 安全 |
| `execute_tab_tool` | 调用页面工具（按 toolsetId + toolName） | ⚠️ 取决于工具实现 |

> `execute_script_in_background` 可以操控浏览器（管理标签页/窗口、拦截请求、操作下载等），`execute_script` 可以在页面中执行任意脚本。两者均可覆盖其他工具的功能，但其他内置工具可以提高正确性、减少 Token 使用。

### 页面工具（Tab Tools）

`list_tab_tools` 返回的工具有两种来源：

- **订阅工具集**：用户在扩展中订阅的工具集（JSON 描述 + `execute` 字符串），按 `pattern` 匹配当前标签页 URL 后暴露。
- **页面 WebMCP 工具**：页面通过 [WebMCP][5] 草案 API `navigator.modelContext.registerTool({ name, description, inputSchema, execute })` 注册的工具。扩展在 `document_start` hook 该 API，把 `execute` 函数引用保存在页面全局对象中，`execute_tab_tool` 调用时通过该引用执行。

两种来源在 `list_tab_tools` 的返回中通过 `toolsetId` 区分（WebMCP 工具的 `toolsetId` 固定为 `webmcp`），Agent 调用方式一致。

[5]: https://webmachinelearning.github.io/webmcp/

## 支持的浏览器

- Base Chromium
- Firefox

## 从源码构建

```bash
cargo build --release
```

构建产物位于 `target/release/browser-mcp`（Windows 上为 `.exe`）。

## Roadmap

- **确保读取用户感官上的数据** — 有些页面是虚拟渲染，需要用 hack 手段读取到全部内容

## 许可证

MIT
