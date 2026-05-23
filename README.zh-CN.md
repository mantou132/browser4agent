# Browser for AI Agent

[English](./README.md) | [中文](./README.zh-CN.md)

一个让 AI Agent 读取浏览器标签页内容、操控浏览器的浏览器扩展。

**读取内容**：可以让 AI Agent 直接读取页面内容、Cookie、localStorage、页面错误等。

**操控浏览器**：通过在扩展后台执行脚本，方便 AI Agent 自主管理标签页和窗口。

**在标签页中执行脚本**：在页面中执行脚本，简单的可以由 AI Agent 直接写，复杂任务应该通过页面标签工具让 AI Agent 直接调用，页面工具在下面有详细说明。

> ⚠️ **安全警告**：
> - 确保你的 AI Agent 环境不受提示词攻击，否则攻击者可以通过扩展读取你的浏览器数据。
> - 确保页面工具来源可信，恶意工具可以在你的浏览器中执行任意脚本。

## 页面工具

AI Agent 可以在标签页中调用工具，比如对页面执行特定操作。工具有两种来源：

- **订阅工具集**：在扩展设置中订阅工具集，根据标签页 URL 从工具集中筛选出可用工具。
- **开发者提供工具**：页面开发者主动通过 [WebMCP][5] API 注册工具。

[5]: https://webmachinelearning.github.io/webmcp/

## 安装

安装浏览器扩展即可；扩展安装完成后会自动打开欢迎页，按页面指引下载并注册 Native Host，并可选地为你检测到的 AI Agent 配置 MCP 或安装 Skills。

- **Chrome 应用商店 / Firefox Add-ons**：审核中。
- **从最新 Release 下载**：在 [latest release](https://github.com/mantou132/browser-data-mcp/releases/latest) 下载 `extension-chrome.zip` 或 `extension-firefox.zip`，解压后按下文「加载未打包扩展」加载。

### 加载未打包扩展

- Chrome / Edge：打开 `chrome://extensions`，开启「开发者模式」，点击「加载已解压的扩展程序」，选择解压后的目录。
- Firefox：打开 `about:debugging`，点击「临时加载附加组件」，选择解压目录中的 `manifest.json`。

> **注意：** 由于扩展需要监听本地端口，所以同时安装到多个浏览器并且都激活时只有一个工作。

## 从源码构建

```bash
# 浏览器扩展，构建产物位于 extension/dist/<browser>
pnpm -C extension run build --browser=chrome
# Native Host —— 构建后直接以 setup 模式运行
cargo run
```

将 `extension/dist/<browser>` 按上文「加载未打包扩展」加载。
