# 实战案例库 (Case Studies)

[English](./cases.md) | [中文](./cases.zh-CN.md)

本文件收录 AI Agent 借助 `browser4agent` 工具链在真实前端开发、性能调优、自动化 QA 等场景下的完整实战记录。

---

## 案例一：高频 UI 动画性能剖析与逐帧重构（Card 展开动画调优）

### 1. 业务场景与痛点

在基于 Web Components（Gem / Shadow DOM）的移动端应用中，有一个可展开卡片组件 `<tap-card>`。当用户点击卡片时，卡片需在 350ms 内从原始流式卡片位置平滑展开为全屏页面：

- **痛点 1（性能与卡顿）**：展开过程中包含大量长文本与图文内容，动画过程中出现明显的掉帧与掉速。
- **痛点 2（排版抽搐 / Jank）**：卡片宽度在动画过程中实时变大，导致内部段落文字在 350ms 内连续不断地重新计算换行与折行，视觉上呈现剧烈的“抖动/水流灌入”感。
- **痛点 3（复杂手势几何联动）**：右上角关闭按钮必须在展开过程中**相对卡片右上角严格不动**，同时当卡片展开后用户执行**下拉退出手势（Pull-to-dismiss）**时，关闭按钮必须跟随卡片容器一同**等比缩小（`transform: scale(...)`）**。

---

### 2. Agent 的排查与分析工具链

AI Agent 没有依赖人工在浏览器中手动肉眼观察，而是直接调度 `browser4agent` 自动化执行了全套深度性能分析与逐帧几何监测：

#### ① 激活目标标签页与环境探测
通过 `list_tabs` 定位正在本地运行 Rsbuild 开发服务器的页面（`http://localhost:3000/tap-app/cards`），并利用 `execute_script_in_background` 激活该标签页，确保浏览器的渲染引擎处于前台全速运行状态（120Hz ProMotion）。

#### ② 抓取 Chromium 内核级指标（CDP）
在点击卡片展开前后，Agent 通过 `debugger_send_command` 启用并调用 Chrome DevTools Protocol 底层接口：
- `Performance.enable`
- `Performance.getMetrics`：提取 Blink 渲染引擎底层的 `LayoutCount`（排版次数）、`LayoutDuration`（排版累计 CPU 耗时）、`RecalcStyleDuration`（样式重算耗时）、`TaskDuration` 等内核级硬指标。

#### ③ 深度穿透 Shadow DOM 与逐帧采样（rAF + ResizeObserver）
由于卡片嵌套在多层 Shadow DOM 之下（`t-root` → `tap-page` → `tap-route` → `t-cards` → `tap-card`），Agent 向页面注入了深度树遍历脚本（`createTreeWalker`），并在动画期间启动双重监测：
- **`ResizeObserver`**：监听卡片内部展开插槽（`<tap-content slot="expandable">`）的尺寸变化次数。
- **`requestAnimationFrame`**：与屏幕 120Hz 刷新率严格对齐，在每一帧渲染前读取当前帧的 `getBoundingClientRect()`，逐帧计算卡片裁切框 `.clip` 与关闭按钮 `.close` 的相对偏移（`offsetFromTop` 与 `offsetFromRight`）。

---

### 3. 数据诊断结果

优化前的基准测试数据（连续 3 轮平均）：

| 监测维度 | 基准测试数据 | 诊断结论 |
| :--- | :--- | :--- |
| **内部文本尺寸重排 (ResizeObserver)** | **41.7 次** | 在 350ms 内触发了 40 多次完整的文本重新排版（Font Shaping / Line Breaking），这是动画掉帧与抽搐的根本原因。 |
| **Blink 累计排版耗时 (LayoutDuration)** | **7.28 ms** | 主线程大量 CPU 时间被浪费在重排文字布局树上。 |
| **单轮最高排版耗时 (Peak Layout)** | **8.19 ms** | 峰值帧排版接近 120Hz 帧预算上限（8.3ms）。 |

---

### 4. 架构重构与数学补偿优化

#### ① 阻断文本 Reflow（Target-Width Staging）
将内部内容容器 `.card` 的排版宽度直接锁定为最终全屏宽度 `${elementTheme.targetW}`，外层 `.clip` 仅作为视口裁切窗口（`overflow: hidden`）。
- **收益**：内部文章段落从第 0 帧开始就按照全屏版式排版完毕，**动画全程 0 次递归 Reflow**，彻底消灭文字折行抖动。

#### ② 关闭按钮几何动态补偿（保持相对卡片 0 位移）
当 `.card` 固定为全屏宽后，如果关闭按钮在 `.card` 内部使用静态 `right: 1rem`，它会被推到全屏右侧，随外层裁切窗口展开产生滑动。为了**既让按钮留在卡片内支持下拉缩放，又让展开时相对卡片右上角保持不动**，Agent 推导了动态差量补偿公式：

- 展开裁切框当前宽度：$W_{\text{clip}}(t) = W_{\text{init}} + (W_{\text{target}} - W_{\text{init}}) \times t$
- 内部卡片固定总宽度：$W_{\text{card}} = W_{\text{target}}$
- 距离可视右边缘的内部右边距偏移量 $R(t)$：
  $$R(t) = W_{\text{target}} - W_{\text{clip}}(t) + 1\text{rem} = (W_{\text{target}} - W_{\text{init}}) \times (1 - t) + 1\text{rem}$$

在 CSS 中直接落地该公式：
```css
.close {
  position: absolute;
  right: calc((${elementTheme.targetW} - ${elementTheme.width}) * (1 - ${elementTheme.progress}) + 1rem);
  top: 1rem;
}
```

---

### 5. 优化后实机验证数据对比

改动生效后，Agent 再次驱动自动化测试套件进行实测比对：

| 性能指标 | 优化前 (Baseline) | 优化后 (Optimized) | 优化成效 |
| :--- | :--- | :--- | :--- |
| **内部文本重排次数 (ResizeObserver)** | **41.7 次** | **1 次**（仅初始化 1 次） | **↓ 97.6% (彻底消除重排)** |
| **排版累计耗时 (LayoutDuration)** | **7.28 ms** | **5.61 ms** | **↓ 23.0% (CPU 排版负担下降)** |
| **单轮最高排版耗时 (Peak Layout)** | **8.19 ms** | **5.42 ms** | **↓ 33.8% (削平峰值卡顿)** |
| **展开全过程相对位移 (54 帧连续追踪)** | 发生明显滑动漂移 | **恒定 16px (0 像素漂移)** | **与卡片右上角 100% 同频** |
| **下拉手势联动测试 (`scale: 0.84`)** | - | **按钮同步缩小至 25.60px** | **成功联动缩放，松手即复原** |
| **单元测试套件** | 全部通过 | 全部通过 (35/35) | 零功能退化 |

---

### 6. 核心启示

这个实战案例展示了 `browser4agent` 区别于传统“截图型”或“简单 DOM 点击型”浏览器工具的本质不同：
- **可执行复杂的长周期调试流水线**：包括 CDP 协议采集、rAF 帧率监测、Shadow DOM 穿透、手势事件合成调度；
- **为代码重构提供硬核数据支撑**：优化不是凭直觉猜测，而是用毫秒级排版耗时与帧位移数据验证结论；
- **全流程无需人手介入**：Agent 自行发现标签页、分析瓶颈、修改源码、运行测试并输出量化报告。

---

## 案例二：一句需求，串起 Firebase 配置与推送服务部署

用户希望 Android App 在后台时，也能收到 agent 响应完成的通知，并让 Agent 帮忙配置 Firebase、下载凭据、部署推送服务。

用户接受条款并创建项目后，Agent 通过 `browser4agent` 接着操作已登录的 Firebase Console：

- **复用现有登录状态**：直接进入用户的浏览器会话，注册 Android 应用并下载客户端配置。
- **完成真实控制台操作**：填写动态表单、切换设置页面、生成服务端凭据，并查询浏览器下载记录确认文件到位。
- **衔接服务器部署**：拿到凭据后，Agent 通过 SSH 将 Gorush 接入已有 Docker Compose 和 Nginx 配置，修复旧版 Compose 兼容问题，并验证服务端到 FCM 的请求链路。

从需要登录的网页控制台，到本地下载文件，再到服务器部署，browser4agent 让浏览器操作成为 Agent 完成实际任务的一环。本次完成了配置与服务端链路验证，手机实际收取通知仍待真机验证。
