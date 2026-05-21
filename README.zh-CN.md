# Browser for AI Agent

[English](./README.md) | [中文](./README.zh-CN.md)

一个让 AI Agent 读取浏览器标签页内容、操控浏览器的浏览器扩展。

**读取内容**：可以让 AI Agent 直接读取页面内容、Cookie、localStorage、页面错误等。

**操控浏览器**：通过在扩展后台执行脚本，方便 AI Agent 自主管理标签页和窗口。

**在标签页中执行脚本**：在页面中执行脚本，简单的可以由 AI Agent 直接写，复杂任务应该通过页面标签工具让 AI Agent 直接调用，页面工具在下面有详细说明。

> ⚠️ **安全警告**：
> - 确保你的 AI Agent 环境不受提示词攻击，否则攻击者可以通过扩展读取你的浏览器数据。
> - 确保页面工具来源可信，恶意工具可以在你的浏览器中执行任意脚本。

## 安装与使用

### 1. 下载并安装浏览器扩展

将 `dist/xxx` 目录作为未打包扩展加载到浏览器中：

- Chrome/Edge：打开 `chrome://extensions`，开启「开发者模式」，点击「加载已解压的扩展程序」，选择 `dist/chrome` 目录
- Firefox：打开 `about:debugging`，点击「临时加载附加组件」，选择 `dist/firefox` 目录中的 `manifest.json`

> **注意：** 由于扩展需要监听本地端口，所以同时安装到多个浏览器并且都激活时只有一个工作。

### 2. 下载可执行程序并初始化

双击可执行程序，将自动注册 Native Messaging Host（写入清单文件，Windows 上还会写入注册表），使浏览器扩展能够找到并连接该程序。
并自动在本机的 AI Agent 中配置 MCP，完成后按任意键关闭窗口。
如果没有为你使用的 AI Agent 配置 MCP，请自行根据 AI Agent 文档配置，URL：`http://127.0.0.1:39271/mcp`

> **注意：** 初始化完成后，不能再移动或删除可执行文件，因为浏览器会根据注册的路径启动它。

### 页面工具

AI Agent 可以在标签页中调用工具，比如对页面执行特定操作。工具有两种来源：

- **订阅工具集**：在扩展设置中订阅工具集，根据标签页 URL 从工具集中筛选出可用工具。
- **开发者提供工具**：页面开发者主动通过 [WebMCP][5] API 注册工具。

[5]: https://webmachinelearning.github.io/webmcp/

## 支持的浏览器

- 基于 Chromium 的浏览器
- Firefox

## 从源码构建

```bash
# 浏览器扩展，构建产物位于 dist/xxx
npm run build
# 浏览器扩展 Native Host
# 构建产物位于 `target/release/browser4agent`（Windows 上为 `.exe`）
cargo build --release
```
