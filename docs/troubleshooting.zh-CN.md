# 常见问题与故障排查 (Troubleshooting)

[English](./troubleshooting.md) | [中文](./troubleshooting.zh-CN.md)

本文档整理使用 `browser4agent` 过程中的典型环境问题、系统安全拦截现象与对应解决方案。

---

## 目录

- [1. macOS: 发送图片附件时弹出「Apple could not verify ".<hash>-0.node"」安全警告](#1-macos-发送图片附件时弹出-apple-could-not-verify-hash-0node-安全警告)
  - [现象与症状](#现象与症状)
  - [深度原因剖析](#深度原因剖析)
  - [为什么对「远程设备」尤为致命？](#为什么对远程设备尤为致命)
  - [推荐解决方案（最彻底）](#推荐解决方案最彻底)
  - [替代备用方案](#替代备用方案)

---

## 1. macOS: 发送图片附件时弹出「Apple could not verify ".<hash>-0.node"」安全警告

### 现象与症状

在 DevTools **Agent 面板** 或通过 **远程设备**（如手机端 AgentDeck）给 Agent 发送带有图片附件的消息时：

1. macOS 屏幕中央弹出系统模态安全拦截对话框：
   > **“.<hash>-0.node” Not Opened**  
   > Apple could not verify ".\<hash\>-0.node" is free of malware that may harm your Mac or compromise your privacy.  
   > `[Done]` `[Move to Trash]`
2. **如果不点击任何按钮，回合会无限期挂起卡住**；
3. 点击“完成 (Done)”或“移到废纸篓 (Move to Trash)”，任务都能继续进行；
4. **不同图片或下次重试时，弹窗提示的文件名会变**（例如 `.99dec9ff...-0.node`、`.99dfbbe9...-0.node` 等）。

---

### 深度原因剖析

该现象发生在底层运行 **Claude Code**（`claude`）作为 ACP Agent 的场景下，具体触发链路如下：

```text
Chrome / Chrome Canary (浏览器宿主)
  └─ browser4agent (Native Messaging Host, 继承浏览器 Quarantine/Provenance 隔离责任)
       └─ claude-agent-acp (Node.js 适配器)
            └─ claude (Claude Code CLI, 由 Bun 编译打包的独立二进制)
                 ├─ 处理图片附件时调用 require("/$bunfs/root/image-processor.node")
                 ├─ Bun 将原生库动态释放到临时目录: TMPDIR/.<hash>-0.node
                 └─ 系统内核为新文件打上 com.apple.quarantine: 0081;...;Chrome Canary;
                      └─ dlopen() 动态加载未公证的 ad-hoc 签名动态库
                           └─ 触发 macOS Gatekeeper 模态安全弹窗拦截
```

1. **Claude Code 与 Bun 的原生依赖释放**：
   Claude Code 官方 CLI 使用 Bun 编译打包。为了在本地快速读取与缩放图片，它内嵌了 Apple AppKit/ImageIO 的原生模块 `image-processor.node`。操作系统无法直接从内存映射加载动态链接库（`dlopen` 需要真实磁盘路径），因此 Bun 在收到图片附件时会临时将其动态释放到系统临时目录下，赋予随机哈希命名的隐藏文件名（如 `.<hash>-0.node`）。
2. **浏览器 Native Messaging 的安全隔离继承**：
   本地 Native Host（`browser4agent`）是由 Chrome 浏览器通过 Native Messaging 协议启动的子进程。在 macOS 安全机制下，由浏览器派生的子进程树在磁盘上创建可执行文件或动态库时，会被内核自动标记来源隔离扩展属性（`com.apple.quarantine: ...;Chrome Canary;`）。
3. **Gatekeeper 门禁触发**：
   Anthropic 打包的 `image-processor.node` 仅为本地链接器 ad-hoc 签名，并未包含 Apple 官方公证（Notarization）。当 `dlopen()` 尝试加载一个**带有浏览器隔离属性**且**未受公证**的动态链接库时，macOS Gatekeeper（`syspolicyd`）会强制拦截并阻塞等待用户确认。
4. **为什么“不点卡死，点任意一个都能继续”**：
   - Gatekeeper 拦截发生在 `dlopen()` 系统调用处，主线程被系统直接挂起，必须等待用户响应。
   - 点“完成”解除挂起；点“移到废纸篓”会将临时文件移动至 `~/.Trash`，虽然 `dlopen()` 会找不到文件，但 Claude Code 内部对图像预处理器做了 `try...catch` 容错，捕获失败后降级跳过本地预处理，直接将原始图片 Base64 送往云端模型，因此也能继续。
5. **为什么不同图片文件名不同**：
   Bun 内部使用动态哈希算法生成临时文件名（`tmpname`）。当上一个文件被删掉或图片/上下文变更时，Bun 重新生成新的文件名，Gatekeeper 视其为从未见过的全新未知二进制，因此会重新弹窗。

---

### 为什么对「远程设备」尤为致命？

在通过远程设备（如手机运行 AgentDeck 通过 Relay WebSocket 连接本地 Mac）的场景下：

- Agent 依然运行在 Mac 本地的 `browser4agent` 进程中。
- 当用户在手机上发送一张照片或截图时，Mac 端若触发系统模态弹窗，**手机端完全看不到弹窗，也无法远程点击**。
- 这会导致手机端的会话无限期处于等待中（永久卡死）。因此必须保证 Mac 端在处理图片时**完全静默放行**。

---

### 推荐解决方案（最彻底）

#### 方案一：为浏览器授予「开发者工具」系统权限（强烈推荐）

macOS 自带针对本地开发工具动态编译/释放未公证动态库的豁免机制（**Developer Tools** 权限）：

1. 打开 Mac 的 **系统设置 (System Settings)**；
2. 进入左侧导航栏的 **隐私与安全性 (Privacy & Security)**；
3. 向下滚动，点击 **开发者工具 (Developer Tools)**；
4. 点击列表底部的 **`+`** 号：
   - 找到并添加你日常使用的浏览器（例如 **Google Chrome** 或 **Google Chrome Canary**）；
   - 确保开关处于**开启状态**；
5. **退出并重新启动该浏览器**（`Cmd + Q` 后重新打开）。

> **原理**：一旦宿主浏览器获得“开发者工具”权限，由其派生的整个子进程树在本地 `dlopen()` 未经公证的动态库时，macOS 安全子系统会直接放行，**本地面板和远程手机发图均可彻底避免弹窗卡死**。

---

### 替代备用方案

#### 方案二：切换底层 Agent 为 Codex 或 Cursor

如果处于无法修改系统设置的环境，可在 Agent 面板或远程配置中切换使用 **Codex** 或 **Cursor**：
- **Codex** 的 CLI 运行时为纯 JavaScript / 预安装结构，没有 Bun 动态解压未公证 `.node` 模块的机制；
- 发送图片附件时不会在临时目录释放动态库，天然不会触发 Gatekeeper 弹窗。

#### 方案三：清理历史缓存隔离属性

如果曾有历史安装文件残留隔离标记，可在终端执行：

```bash
xattr -dr com.apple.quarantine ~/Library/Application\ Support/browser4agent
```
