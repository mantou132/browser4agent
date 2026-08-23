# Browser for AI Agent

[English](./README.md) | [中文](./README.zh-CN.md)

[![Chrome Web Store](https://img.shields.io/badge/Chrome%20Web%20Store-install-4285F4?style=for-the-badge&logo=googlechrome&logoColor=white)](https://chromewebstore.google.com/detail/cddjomjjojijahpjngcfebapepdecaff)
[![Edge Add-ons](https://img.shields.io/badge/Edge%20Add--ons-install-0078D7?style=for-the-badge&logo=microsoftedge&logoColor=white)](https://microsoftedge.microsoft.com/addons/detail/kgofhkkibnooojbchfppjblmajdcboib)
[![Firefox Add-ons](https://img.shields.io/badge/Firefox%20Add--ons-install-FF7139?style=for-the-badge&logo=firefoxbrowser&logoColor=white)](https://addons.mozilla.org/firefox/addon/browser4agent@xianqiao.wang)
[![GitHub Release](https://img.shields.io/github/v/release/mantou132/browser4agent?style=for-the-badge&logo=github&color=181717)](https://github.com/mantou132/browser4agent/releases/latest)

一个让 AI Agent 读取浏览器标签页内容、操控浏览器的浏览器扩展。

![Claude Code 通过 browser4agent 操控浏览器](./docs/preview.png)

- **读取内容** —— 页面文本、Cookie、localStorage、页面错误、截图等。
- **操控浏览器** —— Agent 自己写后台脚本来管理标签页和窗口。
- **在标签页中执行脚本** —— 简单脚本 Agent 现写现用；复杂流程应做成[页面工具](#页面工具)直接调用。
- **Agent 面板** —— 在 DevTools 或浏览器侧边栏里和本地安装的编码 Agent（如 Claude Code）对话，就在它操作的页面旁边。

> ⚠️ **安全提示**
> - 确保你的 AI Agent 环境不受提示词注入攻击，否则攻击者可以通过扩展读取你的浏览器数据。
> - 只安装来源可信的页面工具，恶意工具可以在你的浏览器中执行任意脚本。

## 页面工具

Agent 可以调用作用于当前标签页的工具。来源有两种：

- **订阅工具集** —— 在扩展内置的市场订阅（也可以在设置里粘贴任意 URL），可用工具会按标签页 URL 自动筛选。
- **开发者提供** —— 页面作者通过 [WebMCP][webmcp] API 主动注册的工具。

[webmcp]: https://webmachinelearning.github.io/webmcp/

## Agent 面板

在 DevTools 打开 **Agent** 面板（或作为浏览器侧边栏），即可和本地安装的编码 Agent（如 Claude Code）聊当前页面。会话实时流式输出，支持附件、权限确认，可以保留多个会话并随时切换。需要安装 Native Host，且对应 Agent 已在本地安装并登录。

![在浏览器侧边栏中和 Claude Code 对话](./docs/agent.png)

## 安装

1. 在浏览器商店安装扩展（[Chrome](https://chromewebstore.google.com/detail/cddjomjjojijahpjngcfebapepdecaff) · [Edge](https://microsoftedge.microsoft.com/addons/detail/kgofhkkibnooojbchfppjblmajdcboib) · [Firefox](https://addons.mozilla.org/firefox/addon/browser4agent@xianqiao.wang)）。
2. 安装完会自动打开欢迎页，引导你完成：
   - 下载并注册 **Native Host**；
   - 可选：为检测到的 Codex、Claude Code、VS Code、Cursor、Zed 配置 **MCP**；
   - 可选：为上述 Agent 安装 **Skill**。

> **注意**：扩展需要监听本地端口，同时在多个浏览器中安装并激活时只有一个会工作。

### 手动安装

不想走商店的话，到 [latest release](https://github.com/mantou132/browser4agent/releases/latest) 下载 `extension-chrome.zip` 或 `extension-firefox.zip`，解压后加载未打包扩展：

- **Chrome / Edge** —— 打开 `chrome://extensions`，开启「开发者模式」，点击「加载已解压的扩展程序」，选解压后的目录。
- **Firefox** —— 打开 `about:debugging`，点击「临时加载附加组件」，选解压目录中的 `manifest.json`。

## 命令行

完成安装后，`browser4agent` 同时也是一个单次调用的 CLI，把一次工具调用转发到运行中的 Native Host —— 适合写脚本或快速验证：

```bash
browser4agent --tool list_tabs
browser4agent --tool read_tab --input '{"tab_id": 123}'
echo '{"tab_id":123}' | browser4agent --tool read_tab --stdin
browser4agent --tool read_tab --help   # 查看工具的入参 schema
```

## 从源码构建

```bash
# 浏览器扩展，产物在 extension/dist/<browser>
pnpm -C extension run build --browser=chrome
# Native Host —— 不带参数运行即进入 setup 模式
cargo run
```

将 `extension/dist/<browser>` 按上文「加载未打包扩展」加载。

## 隐私政策

Browser for AI Agent 仅为提供 MCP 浏览器自动化能力而处理浏览器数据。根据用户请求，扩展可能访问标签页元数据、页面内容、Cookie、localStorage、页面错误、截图和工具集配置。数据只发送给本地的 Native Messaging Host 和用户配置的 MCP 客户端 / AI Agent。我们不会出售用户数据、不会用于广告或其他无关用途。请只连接你信任的 AI Agent，只安装你信任的工具集。
