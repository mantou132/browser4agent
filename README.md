# Browser Data MCP

一个可以直接获取浏览器打开标签页数据的 MCP 服务。例如，当浏览器中打开了内部系统或包含个人数据的网页时，可以通过该 MCP 直接读取页面内容。也可以用于读取本地服务页面的控制台信息、Cookie、localStorage 数据，辅助 bug 修复。

## 工作原理

```
Agent (Cursor/Claude Code 等)
    │
    │  MCP over HTTP
    ▼
本地进程 (browser-data-mcp)
    │
    │  Native Messaging (stdin/stdout)
    ▼
浏览器扩展
    │
    │  Chrome Scripting API
    ▼
标签页内容
```

Agent 通过 MCP 协议与本地进程通信，本地进程将 MCP 消息通过 Native Messaging 透传给浏览器扩展，浏览器扩展通过脚本注入读取标签页内容并返回。

## 安装与使用

### 1. 下载并安装浏览器扩展

将 `extension/` 目录作为未打包扩展加载到浏览器中：

- Chrome/Edge：打开 `chrome://extensions`，开启「开发者模式」，点击「加载已解压的扩展程序」，选择 `extension` 目录
- Firefox：打开 `about:debugging`，点击「临时加载附加组件」，选择 `extension` 目录中的 `manifest.json`

> 目前仅支持一个浏览器。扩展安装后会自动以 Native Messaging 方式启动本地进程，进程启动后即提供 MCP 服务，无需手动启动。

### 2. 下载可执行程序并初始化

双击可执行程序，将自动注册 Native Messaging Host（写入清单文件，Windows 上还会写入注册表），使浏览器扩展能够找到并连接该程序。完成后按任意键关闭窗口。

> **注意：** 初始化完成后，不能再移动或删除可执行文件，因为浏览器会根据注册的路径查找它。

### 3. 在 AI Agent 中配置 MCP

Cursor：

```json
{
  "browser": {
    "url": "http://127.0.0.1:39271/mcp"
  }
}
```

Claude Code：

```bash
claude mcp add --transport http --scope user browser http://127.0.0.1:39271/mcp
```

配置完 MCP 之后，AI Agent 会在需要时自动调用 MCP 的工具，读取浏览器中的数据

## 支持的浏览器

- Base Chromium
- Firefox

## 从源码构建

```bash
cargo build --release
```

构建产物位于 `target/release/browser-data-mcp`（Windows 上为 `.exe`）。

## Roadmap

- **精准读取页面内容** — 用最少的 token 准确提取页面关键信息，而非返回整个 HTML
- **确保读取用户感官上的数据** — 有些页面是虚拟渲染，需要用 hack 手段读取到全部内容
- **操控页面** — 直接操作页面元素（点击、输入、滚动等），实现浏览器自动化

## 许可证

MIT
