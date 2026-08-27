# Agent Rules

1. 遇到没有明确的事情不要自由发挥，应该询问确定
2. 始终根据目的考虑代码，如果有更简洁的方案应该提出来
3. 项目结构或入口有变化时，要同步更新本文件，避免后续 Agent 重新摸索

# 项目结构

这个仓库有 2 部分：

1. `src/` 是 Rust Native Host + MCP Server
2. `extension/` 是浏览器扩展，基于 Gem + duoyun-ui

## 运行链路

1. 浏览器扩展在安装后打开 `extension/pages/welcome.html`
2. 扩展后台在 `extension/background.js` 里连接本地 Native Host
3. Rust 程序在 `src/main.rs` 里判断运行模式
4. Setup 模式（无参数）：
  1. `src/native_message_setup.rs` 负责安装 Native Messaging Host
  2. `src/mcp_setup.rs` 尝试给 Codex / Claude / VS Code / Cursor / Zed 配 MCP
  3. `src/skill_setup.rs` 为检测到的 agent 安装 SKILL
  4. `src/main.rs` 在安装 Native Messaging Host 后让用户选择安装 MCP 或 Skills；
5. MCP 模式：
  1. `src/native_host.rs` 负责本地消息循环和 MCP HTTP 服务；连接后发送的 `connected` 通知携带 host 版本（`CARGO_PKG_VERSION`），`extension/background.js` 的 `updateHostCompat` 用它和 `MIN_HOST_VERSION` 做兼容性检查，不兼容时在 action 图标上加警告徽标；扩展收到 `connected` 后回发 `capabilities` 通知（浏览器内核、debugger 可用性）
  2. `src/mcp_server.rs` MCP 服务端；按上报能力过滤工具列表（`CHROMIUM_ONLY_TOOLS`，能力未上报视为不可用）
6. 浏览器端调用 Agent：
 1. `extension/devtools/` 的 DevTools 面板通过 `extension/shared/agent-api.js` 调用 agent 会话 API
 2. `extension/background.js` 里的 `agent-rpc` 端口桥把面板的 `agent_*` 请求透传给 Native Host，并原样转发流事件和最终响应
 3. `src/native_messaging.rs` 负责 Native Messaging 基础读写
 4. `src/peer.rs` 负责与扩展的双工 RPC 协议（请求/响应、流事件、通知），两端 API 对称
 5. `src/browser_agent.rs` 负责浏览器 agent 协议消息、流式事件转发
  6. `src/acp_agent.rs` 负责 ACP connection 和会话管理，`src/acp_agent/catalog.rs` 声明受支持 Agent，`src/acp_agent/provision.rs` 负责用户 CLI 探测及托管运行时准备；Claude/Codex/pi 的适配器与备用 CLI、Cursor 的原生 ACP 二进制自动安装到应用数据目录，优先使用用户 PATH 中可用的 CLI；Native Host 为用户选择的 Claude/Codex/Cursor/pi 分别复用可重连的长生命周期 ACP connection，每个 ACP session 仍由独立 actor 串行处理
7. CLI 模式：
  1. `src/cli.rs` 解析 `--tool` / `--input`（或 stdin JSON）
  2. 转发单次工具调用到后台 MCP HTTP 服务 `127.0.0.1:39271/mcp`，打印结果后退出

## 目录职责

- `extension/pages/`：欢迎页、市场页、Agent 面板等独立页面
- `extension/devtools/`：DevTools 页面入口，注册 Agent 会话测试面板（面板 UI 在 `pages/agent-panel.*`）
- `extension/options/`：扩展设置页
- `extension/popup/`：工具弹窗
- `extension/shared/`：扩展侧公共状态、工具集加载、市场 API、帮助函数
- `extension/_locales/`：扩展 i18n 文案，默认 `zh_CN`，同时维护英文 `en`
- `extension/public/toolsets/`：内置工具集
- `extension/read-content-hacks/`：特定站点的读取补丁
- `src/acp_agent/`：受支持 Agent 目录以及用户 CLI 探测、托管运行时安装和启动命令准备
- `cf/`：扩展中的工具集市场后端
- `toolset-parser/`：工具集解析器

## 关键文件

- `extension/extension.config.mjs`：扩展构建配置和 Gem SWC 插件
- `extension/loaders/prism-local.mjs`：构建期把 dy-code-block 的 esm.sh Prism 地址改写为本地 vendor（`extension/public/vendor/prismjs/`），扩展 CSP 不允许远程脚本
- `extension/loaders/diff2html-local.mjs`：构建期把 `@gem-bind/diff2html` 的远程样式地址（jsdelivr 的 diff2html、cdnjs 的 highlight.js 主题）改写为本地 vendor（`extension/public/vendor/`），避免运行时远程依赖
- `extension/theme.js`：duoyun-ui 全局主题
- `extension/tailwind.css`：扩展全局 Tailwind 主题和基础样式
- `extension/shared/i18n.js`：扩展侧 `t()` 翻译帮助函数和页面语言/标题同步
- `extension/shared/diff.js`：ACP tool call 的 diff 内容项转 unified diff 文本，配合 `<gem-bind-diff2html>` 在面板渲染文件编辑
- `extension/shared/icons.js`：通过 `extendIcons` 扩展 duoyun-ui 全局 icon store 的应用自定义图标（send/stop/file/edit/robot…）；Claude/Codex/Cursor/pi 使用 ACP Registry 官方 SVG 的本地快照
- `extension/shared/rpc.js`：对称双工 RPC 对端（`call` / `handle` / `notify`），同时用于 Native Host 链路和面板链路
- `extension/shared/devtools-tracker.js`：追踪开着 DevTools 的 tab（devtools 页经 `devtools-alive` 端口上报，断开即关闭），`read_tab` 结果据此标注 `devtoolsOpen`
- `extension/shared/agent-api.js`：面板侧 agent 会话 async API 客户端（经 background 的 `agent-rpc` 端口转发）
- `extension/shared/storage-keys.js`：扩展全部 `chrome.storage.local` 键的集中注册表；显式列出旧工具键与带功能前缀/schema 版本的新键，并检查重复 value，禁止在功能模块中散落裸字符串键
- `extension/shared/tool-store.js`：工具集、工具启用状态和收藏状态的共享 Store，并负责与 `chrome.storage.local` 双向同步
- `extension/shared/agent-session-store.js`：Agent 面板的 `chrome.storage.local` 会话索引与按 Agent 隔离的 composer 默认配置；本地 session key 由 Agent 和 ACP session id 的 JSON 元组生成，避免跨 Agent 重名
- `extension/pages/agent-panel.js`：DevTools 双栏 Agent 面板和侧边栏单列变体的根元素，仅负责响应式页面状态、功能控制器装配、effect 挂载和模板事件转发
- `extension/pages/agent-panel/`：Agent 面板内部功能模块；`session-runtime.js` 统一 session pane/cache 与 ACP event 落地，`turn-controller.js` 管理发送/队列/取消/权限，`session-controller.js` 管理新建/加载/切换/删除/配置，`effects.js` 挂载初始化和外部订阅
- `extension/pages/elements/` 中的 Agent 面板纯视图：新会话弹窗/选择器 `new-session-modal.js`（`agent-new-session-modal`）和 `new-session-picker.js`（`agent-new-session-picker`）、会话列表 `session-list.js`（`agent-session-list`）、聊天区+滚动跟随+聚焦 `chat-pane.js`（`agent-chat-pane`）、输入区+队列展示 `composer.js`（`agent-composer`）
- `extension/tools.js`：MCP 工具实现
- `extension/sandbox-globals.js`：execute_script_in_background 沙箱的全局安装函数（经 Function.toString() 注入 QuickJS，必须保持自包含，且在 extension.config.mjs 中排除 swc 转译）：`chrome`/`browser`/`debuggerEvents` 统一经单一 `__invoke` 桥、定时器（主函数返回即丢弃未触发的）、console 捕获（随结果以 `logs` 返回）、queueMicrotask、基础 URL/URLSearchParams
- `extension/debugger.js`：CDP 调试会话，per-tab 事件 ring buffer 桥接 chrome.debugger 的 push 和 MCP 的 pull；快照以惰性函数暴露为 execute_script_in_background QuickJS 里的全局 `debuggerEvents()`，脚本调用时才序列化；attach 状态经 storage.session 在 SW 重启后恢复。MCP 侧只有 `debugger_send_command`（自动 attach）和 `debugger_detach` 两个工具（Chromium only，见 `CHROMIUM_ONLY_TOOLS`）
- `src/app_data.rs`：统一解析并创建 `browser4agent` 的跨平台本地应用数据目录；托管 Agent 运行时放在 `agents/`，程序和 ACP 日志放在 `logs/`，安装缓存放在 `npm-cache/`
- `src/native_messaging.rs`：Native Messaging 基础消息读写
- `src/peer.rs`：与扩展的双工消息协议（`{ id, method, params }` 请求、`{ id, result | error }` 响应、`{ id, event }` 流事件、无 id 通知），两端对称的 `call` / `handle` / `notify` API
- `src/browser_agent.rs`：浏览器侧 agent 请求协议、会话创建、流式事件转发
- `src/acp_agent.rs`：共享的长生命周期 ACP connection、持续会话 actor、agent 事件转换
- `src/acp_agent/catalog.rs`：Claude/Codex/Cursor/pi 的展示信息、用户 CLI 名称及 ACP 启动方式声明
- `src/acp_agent/provision.rs`：跨平台用户 CLI 探测、数据目录内 npm 适配器/备用 CLI 与 ACP Registry 二进制自动安装、启动命令准备
- `src/logger.rs`：写入应用数据目录 `logs/browser4agent.log` 的 Native Host 日志
- `src/cli.rs`：命令行单次工具调用入口
- `src/skill.md`：Skill 模板内容，内容应该和 MCP server 的描述语义上同步

## 常用命令

- `pnpm --dir extension build`：构建扩展
- `pnpm --dir extension test`：跑扩展测试（node 内置 test runner，当前覆盖 execute_script_in_background 沙箱）
- `pnpm --dir extension dev`：开发模式
- `pnpm lint`：格式化 JS/TS/HTML
- `cargo build --release`：构建 Native Host

## 维护要求

- 改入口、目录职责、运行链路、构建方式时，优先同步更新这里
- 如果新增页面、模块或目录，先判断是否需要补到“目录职责”和“关键文件”
- 这里不写细节实现，只写后续 Agent 需要的导航信息

# 前端开发

使用 [`@mantou/gem`](https://gemjs.org/) 框架，[`duoyun-ui`](https://duoyun-ui.gemjs.org/) UI 库，使用了自动导入插件，不需要再导入 `@mantou/gem` 成员和 `duoyun-ui` 元素。用 ECMAScript 最新的规范写，样式尽量使用 TailwindCSS（注意：ShadowDOM 元素内不能使用；Preflight 已启用，`patches/tailwindcss.patch` 用 `:not(:state(gem-element))` 把 gem 元素排除在重置之外）。

## Gem Element Development

Files in `elements` folder are for Gem elements. One file contains one or more elements. Filename is the prefix-less element name. Gem elements extend GemElement or its derived classes.

### Gem Syntax Example

```ts
// 如果需要全局状态，就可以创建一个 Store
// 也许是从其他模块中导入的
const store = createStore({
  globalCount: 1,
  text: '',
});

// 一个更新 Store 的函数，Store 即是个数据对象，也可以用来更新内容
// 一般和 Store 的定义写在模块中，也可能没有这样的函数，因为可以直接调用 `store({})` 更新
const addCount = () => store({ globalCount: store.globalCount + 1 });

// 创建一个给元素实例用的主题
// 当元素的样式基于元素的属性时使用这种方法
// 这是个特殊的主题，在应用到元素时他也是个装饰器，作用是用来反应元素属性的变化来更改主题值
const elementTheme = createDecoratorTheme({ color: 'red' });

// 用 `css` 创建 Gem 元素可挂载的样式表，可以使用 CSS 嵌套语法
// 只有元素通过 `@shadow` 定义成了 Shadow DOM，CSS 中才能使用 `:host`
// 否则使用 `:scope`，请注意区分它们的使用方法而不是简单的替换
// 不要在模板内写内联样式，以这种方式定义的样式可以共享，而且和 DOM 分离
// 如果项目定义了主题，CSS 规则值可以从主题读取
const style = css`
  :scope {
    display: block;
    color: ${theme.textColor};
  }
`;

// 复杂的元素，可以使用这个方案编写样式表，在模板中用 `style1.header` 来引用类名
const style1 = css({
  // `$` 表示 `:host` 或 `:scope`
  $: `
    font-size: small;
  `,
  content: `
    font-size: 24px;
    color: ${elementTheme.color};
  `,
});

// 自定义元素标签名，使用统一的 `dy` 命名空间
@customElement('dy-test')
// 将创建的样式表挂载到元素上，使用多次就可以挂载多个样式表
@adoptedStyle(style)
@adoptedStyle(style1)
// 将全局 store 链接到元素上，store 更新时驱动元素更新，使用多次就可以链接多个 store
@connectStore(store)
// 默认是 Light DOM，只有使用了 `@shadow()` 才是 Shadow DOM，参数是 `ShadowRootInit`
@shadow()
// 一般不需要使用，只有该元素的内容需要能被外部样式化时才使用
@light({ penetrable: true })
// 指定元素渲染不会阻塞主线程，如果这个元素需要一次渲染很多个实例，可以使用
@async()
// 用来指定元素的 ARIA 属性，加强元素的可访问性
@aria({ role: 'region' })
// 这里的元素类名，`Duoyun` 是 `dy` 的全称，后面要加 `Element`，类似原生 HTML 元素类名
class DuoyunTestElement extends GemElement {
  // 定义元素的 part，使用静态字段可以让外部引用 part 名称，不需要设置初始值，状态器会提供一个同名初始值
  static @part img: string;
  // 定义元素的 slot，和 `@part` 一样的原则
  static @slot content: string;
  // 指定一个称为 `src` 的 Attribute，当没有赋值时默认解析成空字符串
  @attribute src: string;
  // 指定一个称为 `count` 的 Attribute，但解析成数字，当没有赋值时默认解析成 `0`
  @numattribute count: number;
  // 指定一个称为 `show` 的 Attribute，但解析成布尔值，当没有赋值时默认解析成 `false`
  @boolattribute show: boolean;
  // 当 Attribute 不能表示的属性时用 Property 表示，由于用户可以不传递属性，所以总要处理为空的情况，更改时会触发元素重新渲染
  @property data?: {};
  // 定义了一个 `display-content` 事件，直接调用触发，参数是自定义事件的 `detail` 属性
  // 只需要指定类型，类型中的参数是自定义事件的 `detail` 属性，`this.displayContent(true)` 触发
  // 很多时候传递数据，就使用 `null` 占位
  // `@globalemitter` 可以穿透 ShadowDOM 进行冒泡
  @emitter displayContent: Emitter<boolean>;
  // 定义 CSS 状态，仅仅是用来供外部 CSS 选择器使用，例如 `dy-test:state(open)`
  // 修改方法：`this.open = true`，没有特别的限制
  @state open: boolean;

  // 创建一个 { value?: HTMLImageElement } 对象，用来访问 DOM
  #imgRef = createRef<HTMLImageElement>();
  // 创建一个内部状态对象，`this.#state({ ... })` 来更新状态
  // 元素内部不应该更新元素的 Attribute/Property，就像原生元素一样
  // 注意和 CSS 状态 `@state` 无关
  #state = createState({ internalCount: 1 });

  // Attribute 不要赋初始值，因为 DOM 序列化会多出以内容，如果需要默认值，可以定义一个 `getter`
  // Property 可以赋初始值，但也可以同样用 `getter`
  get #src() {
    return this.src || 'test';
  }

  // 一些复杂计算可以使用 `@memo`，他的参数是一个函数，参数是当前实例，返回一个依赖数组
  // 在元素每次渲染前执行，只有依赖数组有更改时才会执行函数内容
  // 基于 `@memo` 实现了 `@willMount`
  @memo((i) => [i.src])
  get #text() {
    return i.src.repeat(10);
  }

  // 每次渲染后的副作用，参数和 `@memo` 一样，没有参数时每次都执行
  // 返回的函数会作为清理函数，在下次调用前执行
  // 类似 React 的 `useLayoutEffect`
  // 基于 `@effect` 实现了 `@mounted` `@unmounted`
  @effect()
  #print = () => {
    console.log('updated');
    return () => console.log('clear');
  }

  // `@template` 指定模板渲染函数，参数是一个条件函数，可以为不同条件指定不同渲染内容
  // 不提供条件函数时直接认为满足条件
  @template()
  #content = () => {
    const imgProps = { dataTest: 1 };
    // 模板语法基于 lit-html，添加了 Vue 的 `v-if` 语法、Ref 语法和剩余属性语法
    // 必要时候使用 `classMap` `styleMap` `partMap` `exportPartsMap`
    return html`
      <img ${this.#imgRef} ${imgProps} src=${this.#src} part=${DuoyunTestElement.part} />
      <div class=${classMap({ div: true })} v-if=${this.show}>Show</div>
      <div v-else class=${style1.content} style=${styleMap({ fontSize: '10px' })}>None</div>
    `;
  }

  // 当元素更新后，会根据依赖是否变化重新计算主题，不提供依赖函数则每次更新都更新主题
  @elementTheme((i) => [i.show])
  #updateTheme = () => ({ color: this.show ? 'red' : 'blue' });

  // 渲染出错时的后备内容，只有可能会渲染出错时才需要提供后备模板内容
  @fallback()
  #errorContent = (err) => {
    return html`Error: ${err}`;
  }

  // Gem 元素使用 ES 装饰器定义特性，装饰器本身就完整的表示了意义，所以不需要额外写自定义元素声明
  // Gem 元素不要使用生命周期函数，应该使用各种装饰器装饰普通函数，生命周期已经弃用了!!!
  // 应该尽量使用 ES 私有字段（`#aaa`）来替代类方法，这样没有 `this` 指向的问题
}

```

### Gem Best Practices

- [other](packages/gem/docs/en/004-blog/001-create-standard-element.md)
