# AI CLI 专用终端 — 总体框架 Spec

> 跨三端（Windows / macOS / Linux）终端应用。
> **产品定位：一个完整、好用的通用终端，同时为 AI CLI（Claude Code / Codex CLI 等）提供专门的运行状态监控**。
>
> - **普通终端能力是一等公民**：多 Tab、shell、滚动、搜索、复制粘贴、主题、连字、性能——都要做扎实，不是 AI 监控的附属品。用户即便不跑 AI CLI，它也应是一个称手的终端。
> - **AI CLI 监控是差异化能力**：在跑 AI CLI 时，额外实时呈现其状态（思考中 / 等待批准 / 完成 / 上下文用量 / 当前任务）。
> 技术路线：**Electron 原生窗口壳 + React 应用 UI + xterm.js 6.x（WebGL 渲染）+ node-pty 原生 PTY**。
> 架构参考 Tabby，UI 层由 Angular 换为 React。
>
> **两条能力线并行**：终端功能线（§1–§9）与 AI 语义监控线（§11）正交推进，后者依赖前者的 pty 字节流但不侵入其显示链路。
>
> **监控范围决策（v1）**：**仅监控在本应用终端 Tab 内启动的 AI CLI 会话**。我们拥有这些会话的 pty → 全量字节流 + 可注入，无需进程扫描 / 跨进程日志监视 / ptrace。外部终端（VS Code、系统终端、tmux）里的会话**不在 v1 范围**。
> **监控策略决策**：框架同时提供两套采集基建（headless VT 抓屏 + 旁路结构化信号如 hooks/transcript），**每个 CLI 适配器自行选择并排序**其监控手段。

---



## 0. 设计原则

1. **进程边界清晰**：PTY 只活在主进程；Renderer 通过 IPC 代理访问，永不直接 spawn。
2. **xterm.js 不归 React 管**：React 只提供容器 DOM；终端内部渲染由 xterm 独占，React 不 re-render 它。
3. **PTY 输出不进 React state**：输出直达 `term.write()`；React state 只承载真正的 UI（Tab、侧栏、设置）。
4. **背压优先**：主进程与 Renderer 之间有 ack 流控，防止暴量输出打爆 IPC / 内存 / UI。
5. **最小可跑优先**：先打通单终端回显链路，再逐层加功能。不一次性复刻插件系统。

---



## 1. 进程与模块总览

```
┌─────────────────────────── Electron Main Process ───────────────────────────┐
│  window manager    菜单/托盘/全局快捷键    PTYManager ── node-pty            │
│  (BrowserWindow)         (native)          (背压队列 + ackData)              │
└───────────────────────────────┬──────────────────────────────────────────────┘
                                 │ Electron IPC (contextBridge / preload)
┌───────────────────────────────┴──────────────────────────────────────────────┐
│                          Renderer Process (React)                              │
│  App Shell (Tab 栏 / 侧栏 / 设置 / 首页)   ──   状态：Zustand                  │
│                             │                                                  │
│                  TerminalView (React 容器)                                     │
│                             │  xterm.open(ref)                                 │
│                        xterm.js 6.x  ── addons: fit / webgl / search / ...     │
│                             │  onData ↕ write                                  │
│                        PtyProxy (IPC client)                                   │
└────────────────────────────────────────────────────────────────────────────┘
```



### 目录结构（建议）

```
vibing/
├── electron/                 # 主进程 (Node 环境)
│   ├── main.ts               # app 生命周期、创建窗口
│   ├── window.ts             # BrowserWindow 封装（无边框 / vibrancy / acrylic）
│   ├── pty/
│   │   ├── PTYManager.ts     # 管理所有 pty 实例
│   │   ├── PtyDataQueue.ts   # 背压队列（ackData 流控）
│   │   └── platform.ts       # ConPTY / Unix PTY 差异（node-pty 已抹平）
│   ├── ipc.ts                # IPC channel 定义与注册
│   └── tray.ts / shortcuts.ts
├── preload/
│   └── index.ts              # contextBridge 暴露安全 API
├── src/                      # Renderer (React)
│   ├── main.tsx
│   ├── app/                  # App Shell
│   │   ├── App.tsx
│   │   ├── TabBar.tsx
│   │   ├── SideRail.tsx
│   │   ├── StartPage.tsx
│   │   └── Settings.tsx
│   ├── terminal/
│   │   ├── TerminalView.tsx  # xterm 容器组件
│   │   ├── useXterm.ts       # 挂载/卸载 xterm 的 hook
│   │   ├── addons.ts         # addon 加载 + 渲染降级
│   │   └── PtyProxy.ts       # IPC 客户端
│   ├── state/                # Zustand stores
│   │   ├── tabsStore.ts
│   │   └── settingsStore.ts
│   └── shared/               # 主进程/Renderer 共享类型
│       └── ipc-contract.ts
├── package.json
├── electron.vite.config.ts   # electron-vite：三段构建
└── SPEC.md
```

---



## 2. 分层职责



### 2.1 Electron 主进程

- 创建 / 管理 `BrowserWindow`：无边框、可缩放/最大化/全屏。
- 平台窗口效果：macOS Vibrancy、Windows Acrylic/Blur、Linux 透明。
- 系统集成：托盘、全局快捷键、菜单。
- **PTYManager**：唯一持有 node-pty 实例；对外暴露 `spawn / write / resize / kill`，向上发 `data / exit`。
- **PtyDataQueue**：见 §4。
- 打包（electron-builder）：nsis / dmg / AppImage+deb。



### 2.2 Preload（安全边界）

- `contextIsolation: true`、`nodeIntegration: false`。
- 通过 `contextBridge.exposeInMainWorld` 暴露**收窄**的 API，而非整个 ipcRenderer。
- 只暴露 §3 契约里定义的方法。



### 2.3 Renderer（React）

- **App Shell**：Tab 栏、侧栏、首页、设置——全部普通 Web UI，用 React state。
- **TerminalView**：xterm 宿主，见 §5。
- **状态管理**：Zustand（轻、无 Provider 地狱、易在 hook 外读写）。Tab 元数据、活动 Tab、设置存这里；**终端字符流不存这里**。

---



## 3. IPC 契约（单一事实来源）

`src/shared/ipc-contract.ts` 定义类型，主进程与 preload 共用。

**Renderer → Main（invoke，请求-响应）**


| channel      | 参数                                    | 返回        |
| ------------ | ------------------------------------- | --------- |
| `pty:spawn`  | `{shell, args, cwd, env, cols, rows}` | `{ptyId}` |
| `pty:write`  | `{ptyId, data}`                       | `void`    |
| `pty:resize` | `{ptyId, cols, rows}`                 | `void`    |
| `pty:kill`   | `{ptyId}`                             | `void`    |
| `pty:ack`    | `{ptyId, bytes}`                      | `void`    |

M5.b 新增（详见 [PLAN-M5B.md](./PLAN-M5B.md) §4.1/§4.5/§4.6/§4.11）：

| channel                  | 参数                    | 返回                                          | 状态 |
| ------------------------ | --------------------- | ------------------------------------------- | --- |
| `window:minimize`        | —                     | `void`                                       | M5.b 实现 |
| `window:toggle-maximize` | —                     | `void`                                       | M5.b 实现 |
| `window:close`           | —                     | `void`                                       | M5.b 实现 |
| `window:is-maximized`    | —                     | `boolean`                                    | M5.b 实现 |
| `dialog:pick-directory`  | `{defaultPath?}`      | `string \| null`                             | M5.b 实现 |
| `theme:list-user`        | —                     | 用户主题 JSON 原文列表（renderer 校验）                | M5.b 实现 |
| `stats:all-time`         | —                     | `{sessions, toolCalls, blocked, approvals}`  | **仅契约**，实现归 M5.c / S 线 |
| `events:history`         | `{limit, before?}`    | `HistoryEvent[]`                             | **仅契约**，实现归 M5.c / S 线 |


**Main → Renderer（send，事件流）**


| channel                    | 载荷               |
| -------------------------- | ---------------- |
| `pty:data:{ptyId}`         | `Uint8Array`     |
| `pty:exit:{ptyId}`         | `{code, signal}` |
| `window:maximized-changed` | `boolean`（M5.b 新增，驱动最大化/还原图标） |


> 约定：`data` 用二进制传输（`Uint8Array`），避免 UTF-8 字符串在多字节边界被 IPC 序列化切坏。xterm 6.0 支持 `write(Uint8Array)`。

---



## 4. 背压 / 流控（照搬 Tabby，必做）

问题：`cat bigfile`、`yes` 等会让 pty 以远超 Renderer 处理速度的速率吐数据，导致 IPC 堆积、内存暴涨、UI 卡死。

方案：**基于确认窗口的滑动流控**。

```
node-pty 'data'
   → PtyDataQueue.push(chunk)
   → 若 unacked < HIGH_WATER：立即 IPC 发送，unacked += chunk.len
     否则：入队暂存（并对 pty 调用 pause()）
Renderer 处理完一批（term.write 的 flush 回调）
   → pty:ack({bytes})
Main 收到 ack：unacked -= bytes
   → 若低于 LOW_WATER：pty.resume()，继续 flush 队列
```

- 阈值：`HIGH_WATER ≈ 256KB`、`LOW_WATER ≈ 64KB`（可调）。
- Renderer 侧用 `term.write(data, callback)` 的回调作为"已消费"信号再发 ack。
- 结果：pty 产出速率被自动限制到 Renderer 的消费速率。

---



## 5. xterm.js 集成



### 5.1 挂载（React 只挂一次）

```ts
// useXterm.ts —— 空依赖 useEffect，杜绝 React re-render 干扰 xterm
useEffect(() => {
  const term = new Terminal({ /* fontFamily, theme, scrollback ... */ })
  loadAddons(term)                 // fit / webgl / search / unicode11 / ...
  term.open(containerRef.current!)
  fit.fit()

  const proxy = new PtyProxy(ptyId)
  const onData = term.onData(d => proxy.write(d))          // 键盘 → pty
  proxy.onData(bytes => term.write(bytes, () => proxy.ack(bytes.length)))  // pty → 屏幕 + ack

  const ro = new ResizeObserver(() => { fit.fit(); proxy.resize(term.cols, term.rows) })
  ro.observe(containerRef.current!)

  return () => { onData.dispose(); proxy.dispose(); ro.disconnect(); term.dispose() }
}, [])
```



### 5.2 Addon 与渲染降级

当前加载 `fit / webgl`；`search / serialize / unicode11 / image(sixel)` 按后续
里程碑需求接入。

渲染降级为两级：

```
WebGL Addon  ──(WebGL2 不可用 / context loss)──►  DOM Renderer
```

监听 WebGL addon 的 `onContextLoss`，失败即 dispose 并 fallback；切出再切回 Tab
后允许重新尝试。xterm.js 6.0 已移除 Canvas addon，因此不再保留旧的
WebGL → Canvas → DOM 三级描述。

为避免 Chromium 的单页 WebGL context 上限，只有活动 Tab 持有 WebGL addon；
隐藏 Tab 同步 dispose 回 DOM，但 xterm buffer 与 PTY 消费/ack 保持常驻。

xterm 6.0 的 WebGL renderer 在 resize 时先清空 canvas，完整重画却延迟到下一帧，
会向 Chromium compositor 提交近空帧并造成拖窗闪烁。上游修复
([xterm.js#5529](https://github.com/xtermjs/xterm.js/pull/5529))改为 resize 调用栈内
同步重画；稳定版尚未包含该补丁，因此当前精确锁定已验证的
`@xterm/xterm@6.1.0-beta.292` + `@xterm/addon-webgl@0.20.0-beta.291`，不使用浮动
beta 标签。E2E 在 xterm 网格连续宽窄 resize 后立即读取 WebGL 主 canvas，并与下一
animation frame 的稳定结果比较，禁止 renderer 再次把重画推迟到下一帧。原生窗口
自身的异步布局阶段不属于该门禁，避免把窗口管理器中间态误判为 renderer 回归。

`@xterm/addon-ligatures` 0.10.0 需要 Node 文件系统定位并解析本机字体，不能用于
`nodeIntegration:false` 的 Renderer；本项目不引入该 addon，也不为字体放宽安全边界。
M4.1 改用 xterm 6 的 character joiner proposed API：应用只识别连续操作符与 Maple
内建标签范围，实际 OpenType `calt` 整形由浏览器和内嵌的标准版 Maple Mono 完成，
不需要文件系统或新 IPC。xterm 会按前景/背景属性切分范围，并在光标进入连字或选区
切开连字时退回逐字符绘制，因此 buffer、复制内容与字符格坐标保持原义。WebGL 与 DOM
降级路径共用同一个 joiner；`ligatures` 设置可即时注册/注销。

默认终端字体为内嵌 Maple Mono v7.9 WOFF2、16px；启动时先等待常规/粗体加载再
创建 xterm，避免首屏用 fallback 尺寸建 atlas。Maple 不含中文，回退栈按平台优先
使用 Microsoft JhengHei/YaHei UI、PingFang TC/SC、Noto Sans (Mono) CJK TC/SC。

### 5.3 尺寸链路

```
窗口 resize → 容器尺寸变化 → ResizeObserver → FitAddon.fit() → (cols,rows)
           → PtyProxy.resize → IPC → node-pty.resize → ConPTY / Unix PTY
```

保证 shell / vim / tmux 看到的是**终端区域**的行列，而非整窗。

---



## 6. 多 Tab 状态模型

- `tabsStore`（Zustand）：`tabs: {id, title, ptyId, kind}[]`、`activeTabId`。
- **每个 Tab 的 xterm 实例常驻**（用 CSS `display:none` 隐藏非活动 Tab，而非卸载），
避免切 Tab 丢失滚动缓冲；WebGL addon 仅在活动 Tab 挂载。
- 标题来源：xterm 的 `onTitleChange`（OSC 序列）→ 更新 store。
- 关闭 Tab：`term.dispose()` + `pty:kill` + 从 store 移除。

**M5.b 演进**（详见 [PLAN-M5B.md](./PLAN-M5B.md) §4.4/§4.7）：M3 Tab 栏被 App
Shell 三态导航取代，`tabsStore` 拆为 `terminalsStore`（终端条目）+
`sessionsStore`（AI CLI 会话，§11.5 Session 形状，`sessionId ↔ terminalId` 固定
归属）。xterm 常驻挂载与隐藏时继续消费/ack 的机制**不变**，仅"是否可见"的判定从
`activeTabId` 换成页面路由 `PageId`（`home | settings | terminal:{id}`）。关闭
最后一个终端回 Home，不再关窗口（M3 语义废止）；`Ctrl+Shift+T` 改为打开新建会话
面板。

---



## 7. 平台差异一览（大多由底层库抹平）


| 关注点      | Windows              | macOS    | Linux          |
| -------- | -------------------- | -------- | -------------- |
| 窗口后端     | Win32 (via Chromium) | AppKit   | Wayland/X11    |
| PTY      | ConPTY (node-pty)    | Unix PTY | Unix PTY       |
| 窗口效果     | Acrylic/Blur         | Vibrancy | 透明             |
| 默认 shell | pwsh / cmd           | zsh      | bash           |
| 打包       | nsis                 | dmg      | AppImage + deb |


上层代码只面对统一的 `spawn/write/resize/kill/data/exit`。

---



## 8. 技术选型


| 关注点 | 选型                    | 理由                                 |
| --- | --------------------- | ---------------------------------- |
| 壳   | Electron              | 跨三端、成熟、Chromium 抹平差异               |
| UI  | React 18 + TypeScript | 需求指定                               |
| 状态  | Zustand               | 轻量，可在 hook 外读写，无 re-render 陷阱      |
| 终端  | xterm.js 6.x + WebGL  | 需求指定；精确 beta pin 含 resize 同步重画修复   |
| PTY | node-pty              | 事实标准，封装 ConPTY/Unix PTY            |
| 构建  | electron-vite         | 一套配置同时构建 main/preload/renderer，HMR |
| 打包  | electron-builder      | 三端安装包                              |
| 样式  | Tailwind CSS          | 原子化、无全局污染、开发快；配 CSS 变量做主题          |
| GUI 主题 | 语义 token（CSS 变量 + Tailwind `@theme inline` 映射）+ JSON 主题配置文件 | VS Code 模式：内置主题与用户主题（`<userData>/themes/*.json`）同一 schema，运行期热切换；组件禁止硬编码色值；界面主题与终端 16 色分开设置（终端配色仍走 `themes.ts`，schema 预留 `terminal` 段）。见 PLAN-M5B §4.11 |
| 字体  | 内嵌 Maple Mono（终端）+ PingFang SC（界面中文）+ Ammonite（logo） | 三端视觉一致、离线可用；PingFang 完整字库入库（`src/assets/fonts/pingfang/`），Ammonite 随 M5.b 入库 `src/assets/fonts/ammonite/`，**构建期子集化后打包，禁止全量打包**（见 §9 M5.a 注记与目录内 NOTICE）；Geist 不引入（原型仅作未显式指定字体的兜底，已查证无实际使用） |


**插件系统**：v1 **不做**。Tabby 的动态模块加载深绑 Angular DI，React 无等价物，强套代价高。若后续需要，用 React Context + 事件总线自建扩展点，届时单独立 Spec。

---



## 9. 里程碑（增量交付）


| 阶段       | 目标                          | 完成标志                                                                                                |
| -------- | --------------------------- | --------------------------------------------------------------------------------------------------- |
| M0       | 脚手架                         | electron-vite 起窗口，React 渲染 "hello"                                                                  |
| **M1**   | **最小回显链路**                  | React 挂 xterm → IPC → node-pty → 能跑 shell、回显正常                                                      |
| **M2**   | **resize + 背压**             | 窗口缩放行列同步；`yes`/`cat bigfile` 不卡 UI                                                                  |
| **M3**   | **多 Tab**                   | 新建/切换/关闭 Tab，各自独立 pty 与缓冲                                                                           |
| **M4**   | **渲染与体验**                   | WebGL + context-loss 降级链；消除 `opencode` 块字符色块网格缝；主题、内嵌字体与连字                                          |
| **M5.a** | **App Shell — UI/UX 设计与原型** | 高保真交互原型（`/prototype` 独立 Vite 工程）评审拍板，不另写 UX 规范文档；设计覆盖侧栏/首页/设置/新建会话流、三态导航（侧栏展开为默认 / 侧栏收起图标条 / 顶部 Tab 栏）、§11 监控界面（侧栏 session 六态徽标、独立置顶悬浮窗、Home 注意力队列），实现归 M5.b / S 线 |
| **M5.b** | **App Shell — 实现**          | 无边框窗口 + 自定义标题栏（原型标题栏设计的前置条件）；侧栏、首页、设置真组件落地；设置面板直读写 `settingsStore`；侧栏 session 区由 mock provider（§11.5 schema）驱动；交互 E2E 全绿且既有门禁不回归 |
| **M5.c** | **App Shell — 数据与打磨**       | 需新 IPC 的真实数据接入（以 M5.a 定稿为准）、i18n 五语言、视觉打磨（含 vibrancy/acrylic，注意平台差异）、托盘与全局快捷键、全量回归；AI session 真数据不在此（归 S 线）                             |
| M6       | CLI 适配器矩阵                   | 依赖 S3 定稿的 adapter 抽象；铺开接入剩余主流 CLI（gemini-cli / opencode / aider / cursor-agent 等），每个适配器带独立状态识别策略与回归夹具    |
| M7       | 打包                          | 三端安装包产出                                                                                             |


优先级：**M1 是地基**，其余按需推进。

**当前进度（2026-08-02）：M4 已完成。M5.a 原型（`/prototype`）已覆盖全部设计范围，待评审拍板后进入 M5.b。已定决策：侧栏替代 M3 Tab 栏，导航三态互斥：侧栏展开 / 侧栏收起（图标条）/ 顶部 Tab 栏（无侧栏，Home 常驻最左、新建常驻 tabs 右、hover 出详情卡）；标题栏左侧以实际功能入口（新建会话 / 设置）取代占位菜单（文件/编辑/视图/帮助），三种导航形态下全局恒定；侧栏底部保留快速收展开关；界面（chrome）主题与终端 16 色配色在设置中分开设置——M4 的单一 `themeId` 于 M5.b 拆分为界面/终端两个字段，`themes.ts` 色值结构不变；session/terminal 归属按启动方式固定不迁移；悬浮窗为独立置顶小窗（第二 BrowserWindow，实现归 S3）；v1 只看不操作（注意力列表仅"查看"跳转，无批准/重试）；all-time 统计与跨 session 历史事件需新增 IPC 契约与主进程持久化（契约定于 M5.b，实现归 M5.c / S 线）；中文 UI 字体内嵌 PingFang——SC 六字重 woff2 已入库 `src/assets/fonts/pingfang/`（完整 CJK 字库约 5MB/字重，共约 30MB，来源与授权见目录内 `NOTICE.md`，版权由项目方自行解决），仓库保存完整字体，**构建时按产物实际用字子集化（如 fonttools `pyftsubset` 生成 woff2 子集，或按 unicode-range 切片），未用字重不进产物，禁止全量打包**（子集化管线随 M5.b 首次接入 UI 字体时落地）；Home 空状态（无会话且无终端）重排为居中欢迎页——logo + 问候 + 快速启动入口保留，注意力队列/历史/统计不渲染，有会话后恢复信息密度布局；悬浮窗为紧凑模式——默认仅显示按最新事件排序的前 3 个活跃（未退出）会话，可展开查看全部，头部仅保留 need-you 计数；里程碑重排——原 M6「窗口质感」拆解并入 M5 线（无边框 + 自定义标题栏归 M5.b，vibrancy/acrylic、托盘、全局快捷键归 M5.c），M6 重定义为「CLI 适配器矩阵」（依赖 S3，见 §11.7）。**

**M5.b 已立项（2026-08-02）**：实施计划与 12 条评审决策见
[PLAN-M5B.md](./PLAN-M5B.md)。对原型/既有约定的修订摘要：标题栏 Win/Linux 自绘右侧
三键、**不落地原型左侧三个装饰灰点**，macOS 用原生红绿灯并隐藏自绘键；Geist 字体
不引入（基础字体栈改 PingFang），Ammonite logo 字体入库内嵌并子集化；顶部 Tab 溢出
全量显示 + 横向滚动；侧栏条目补 hover 关闭键（原型未画，评审确认）；关闭最后一个
终端回 Home 不关窗口、`Ctrl+Shift+T` 改为打开新建会话面板（M3 语义调整）；GUI 全面
token 化 + JSON 主题配置文件（见 §8「GUI 主题」行）；新建 CLI 会话真实 spawn，
语义状态仅 working/exited 兜底，六态演示数据由 dev/E2E mock provider 注入；深色
界面主题、悬浮窗（S3）、统计/历史真数据（M5.c / S 线）均不在 M5.b。

M2 基线：

- Main→Renderer 的 PTY 输出已改为 `Uint8Array`。
- Renderer 在 `term.write(data, callback)` 完成解析后发送 `pty:ack`。
- 主进程采用 256KB 高水位 / 64KB 低水位控制 `node-pty.pause()/resume()`，
在途与排队交付数据硬上限为 1MB；超限会显式记录并终止 PTY，不静默无限增长。
- E2E 会延迟 ack 模拟慢消费者，以约 2MB 持续输出验证 pause/resume、UI 响应、
输出首尾完整和内存上限；原 resize/scrollback 压测继续作为组合回归门禁。

M3 交付：

- Zustand 管理 Tab 元数据和活动项；每个 Tab 常驻独立 xterm/pty，隐藏时继续消费并
ack，切换不会卸载 normal/alternate buffer 或 scrollback。
- 支持新建、切换、关闭、OSC 标题、进程退出保留，以及
`Ctrl+Shift+T` / `Ctrl+Shift+W` / `Ctrl(+Shift)+Tab`。
- 隐藏 Tab 不执行零尺寸 fit/pty resize，重新激活后才同步最新尺寸。
- 调试桥兼容原活动终端 API，并增加按 `tabId` 取证的多终端注册表。
- `e2e/tabs.spec.ts` 以 12 条用例覆盖隔离、保活、生命周期、标题、快捷键、
后台 2MB 背压、隐藏 resize 和 5 Tab 有界基线；完整 E2E 42/42、原压力门禁
5 轮 20/20 通过。

M4 交付：

- `@xterm/addon-webgl` 成为活动 Tab 首选 renderer；快速切换时同步释放旧 context、
rAF 挂载新 context，任意时刻 WebGL context 数量不超过 1。
- WebGL 构造/加载失败或真实 context loss 会回退 DOM；降级事件可取证，PTY、
scrollback 与输入不中断，完成一次 Tab 切出/切回后允许重试。
- `e2e/render.spec.ts` 以连续 `▀` + 同宽 ANSI 背景色带做截图像素对照，在
100% / 125% / 80% zoom 下要求前景连续宽度完全相等，固化 `opencode` 零缝门禁；
DOM 对照只要求内容和输入可用。
- M4.2 精确锁定包含上游同步重画补丁的 xterm 6.1/WebGL 0.20 beta；WebGL resize
不再先提交空 canvas。同步 canvas 门禁要求 `resize()` 返回时的亮度至少保持下一
animation frame 稳定结果的 55%；同一门禁已在 6.0/WebGL 0.19 上反证失败。
- `themes.ts` 集中定义完整 16 色终端主题与 chrome 色值；内置深/亮两套主题。
`settingsStore` 持久化 `themeId / fontFamily / fontSize / ligatures`，主题和字体即时
生效；字体变化仅立即 fit 活动 Tab，隐藏 Tab 激活后再同步 PTY。
- M4.1 内嵌标准版 Maple Mono v7.9 WOFF2，默认 16px，并为繁/简中文配置
Microsoft JhengHei/YaHei UI、PingFang TC/SC、Noto CJK 回退栈；旧 13px 默认值与
临时 Maple Mono NL 默认值会迁移，新用户和默认配置开启连字。
- 连字不采用需要 Node 字体文件访问的 addon；xterm character joiner 只组合相同 ANSI
属性中的操作符/内建标签片段，再由浏览器应用 Maple OpenType `calt`。光标、选区、
buffer 与复制仍保持原始字符；WebGL/DOM 共用，运行时可关闭。
- M4 联调暴露并修复了 ConPTY 退出与延迟 resize 的竞态：native resize 失败现在取消
filter expectation 并安全丢弃，不再以未捕获异常终止主进程。最终完整 E2E 50/50、
压力门禁 5 轮 20/20 通过。
- `opencode` 快速退出还可能让 node-pty 1.1.0 的 ConPTY 输入管道异步返回
`write EAGAIN`；主进程现在为每个 Windows PTY 安装终端级错误边界，同时满足
node-pty 输出管道的 listener-count 兼容约定。管道退出竞态只结束当前终端会话，不再
成为 Electron 主进程的未捕获异常；定向回归和真实 `opencode` 5 轮退出验证通过。
- `opencode /exit` 会在回到 normal buffer 后遗留 `any` mouse tracking，使普通拖拽仍被
当作 TUI 鼠标事件。Renderer 现在在 alternate→normal 切换时显式关闭各类 mouse
tracking；TUI 内鼠标交互不变，退出后立即恢复文案选择。

---



## 10. 明确的非目标（v1）

- 插件生态 / 动态模块加载（**但 AI CLI 适配器注册表是核心扩展点，必做——见 §11.4**）
- **监控外部终端里的 AI CLI 会话**（VS Code / 系统终端 / tmux）——需进程扫描 + 跨进程日志监视，v1 不做；架构在 §11 预留信号来源抽象，未来可加
- SSH / Serial / 其他 session 类型（先只做本地 shell；架构预留 `session kind` 字段）
- 云同步、账户体系
- 移动端

---



## 11. AI CLI 语义监控（核心子系统）

> 这是本产品区别于普通终端的核心。目标：在跑 AI CLI 的同时，把它的运行状态结构化出来，驱动 Dashboard / 侧栏。



### 11.1 根本难点：AI CLI 是 TUI，不是流

Claude Code / Codex CLI 都是**全屏 TUI**——用 alternate screen buffer、光标移动、区域重绘。原始 pty 字节流里全是 `\x1b[2J` / 光标跳转 / 局部重画，**直接正则字节流无法可靠判断状态**。必须先把字节流**重建成屏幕网格**，再从网格读语义。这条决定了下面的架构。

### 11.2 采集点：pty 管道上的语义分流（tap）

由 §4，pty 数据流本就经过主进程 → 主进程是天然分流点。同一份字节流一路发 Renderer 显示，一路喂语义分析：

```
node-pty 'data'
   ├──► PtyDataQueue → IPC → Renderer 的 xterm（显示，原样，带背压）
   └──► SemanticTap ──► HeadlessScreen（屏幕重建）
                   └──► SidebandSources（旁路信号）
                          ↓
                   AiCliAdapter（语义提取）
                          ↓
                   SessionState（归一化模型）→ IPC → Renderer Dashboard/侧栏
```

分流是**非阻塞旁路**：语义分析再慢也不能拖累显示链路与背压。

### 11.3 两套采集基建（适配器按需选用）

**A. HeadlessScreen —— 主进程内的无头终端**

- 用 `@xterm/headless`（xterm 官方无渲染构建，同一套 VT 解析器）在主进程为每个被监控会话重建屏幕网格。
- 适配器读 `buffer.active` 的单元格 / 行文本提取状态。
- **放主进程、用独立 headless 实例的理由**：语义层不绑定任何 Tab 的 UI 生命周期，是单一事实来源，且未来扩展后台/未聚焦会话时天然支持。
- **固有成本：同一字节流被 VT 解析两次**（Renderer 的 xterm 一次用于显示、主进程的 headless 一次用于语义）。这是"语义独立于 UI"的代价，**不是主进程方案的缺点**——若改为复用 Renderer buffer 只解析一次，就会把语义绑死在 UI 上。对"几个 AI CLI 会话"量级，多一次解析的开销可忽略（xterm 解析器本就为全屏高刷 TUI 设计）。

**B. SidebandSources —— 旁路结构化信号（比抓屏可靠）**


| 手段                                                   | 可靠性  | 说明                 |
| ---------------------------------------------------- | ---- | ------------------ |
| **Hooks**（如 Claude Code settings.json 事件钩子）          | ★★★★ | CLI 主动上报事件，最稳      |
| **Transcript 日志**（如 `~/.claude/projects/**/*.jsonl`） | ★★★★ | 结构化，可 tail         |
| **OSC 标记注入**                                         | ★★★  | 若能包裹/配置 CLI 输出     |
| **屏幕抓取**（HeadlessScreen）                             | ★★   | 通用兜底，CLI 改 UI 可能失效 |


原则：**优先旁路信号，抓屏兜底**。旁路信号能拿到屏幕外信息（如 token 用量），抓屏对任意 TUI 都能上手但脆。

### 11.4 CLI 适配器注册表（核心扩展点）

每种 AI CLI 一个适配器；框架启动时注册。**这是本产品真正需要的"插件点"**（区别于 §10 排除的通用 Angular 式动态模块系统）。

```ts
interface AiCliAdapter {
  id: string                          // 'claude-code' | 'codex' | ...
  displayName: string
  detect(ctx: DetectContext): boolean // 靠 argv / 进程名 / 首屏输出特征识别会话类型
  strategies: MonitorStrategy[]       // 按可靠性排序，逐个尝试；此即"按适配器各自决定"的落点
}

interface MonitorStrategy {
  kind: 'sideband-hook' | 'sideband-log' | 'osc' | 'screen-scrape'
  attach(session: MonitoredSession): Disposable
  // 产出 partial SessionState，framework 合并
  onUpdate(patch: Partial<SessionState>): void
}
```

- `detect`：新开 Tab 跑命令时，框架依次问各适配器"这是不是你负责的 CLI"。
- `strategies`：一个适配器可组合多策略（如 claude-code = transcript 日志 + 抓屏兜底）。框架按序 attach，高可靠信号覆盖低可靠信号。



### 11.5 归一化会话状态模型（UI 的唯一数据契约）

> 目标不是抓 model/cwd 这类静态元数据，而是**监听一个 AI CLI 会话正在做什么任务、进行到哪一步、要不要你介入**。用户开一个悬浮框看多个 session 的状态，不必一直盯屏；关键事件绑定通知来提醒。



#### 核心思路：事件流是事实来源，"当前状态"是它的归约结果

适配器只负责**吐事件**（它观察到什么就报什么）；框架把事件流**归约（reduce）**成一个"当前状态"给 UI。UI 只读归约结果。好处：适配器简单无状态、没有多信号覆写的竞态、通知天然挂在事件上。

**不设 "Turn / 一轮任务" 这层结构。** 一轮任务的边界（哪开始、哪结束）恰恰最难可靠判断——抓屏时 AI 中途停顿、多步骤、被打断都会导致误切或误并，一旦切错，挂在其上的时间线与"完成"通知全错。因此模型只有两层：**Session（=一个 Tab，长期）+ 扁平事件流**。需要"当前在做什么 prompt"时，取**最近一次** `prompt-submitted` **事件**作为派生字段即可，不建容器去框住它 → 框架永不需要判断任务边界，也就没有误判空间。

#### 事件类型（会话生命周期）


| 事件 type            | 触发          | 关键 payload                   | 注意力事件 |
| ------------------ | ----------- | ---------------------------- | ----- |
| `prompt-submitted` | 用户提交 prompt | prompt 文本                    | 否     |
| `thinking`         | AI 开始思考     | —                            | 否     |
| `tool-call`        | 调用工具        | 工具名、参数摘要（如 `Bash: npm test`） | 否     |
| `tool-result`      | 工具返回        | ok / 失败                      | 否     |
| `question`         | AI 向用户提问    | 问题文本                         | ✅ 需要你 |
| `approval`         | 请求批准操作      | 要批准什么                        | ✅ 需要你 |
| `completed`        | AI 停下、交还控制权 | 结果摘要                         | ✅ 完成  |
| `error`            | 出错          | 错误信息                         | ✅     |
| `exited`           | 进程退出        | 退出码                          | ✅     |




#### 派生的当前状态：注意力导向

悬浮框真正要回答的是"**这个 session 现在要不要我**"，所以主状态是注意力导向而非技术导向：


| status      | 含义                          | 归约规则（示例）                                 |
| ----------- | --------------------------- | ---------------------------------------- |
| `working`   | 在思考/跑工具，别管它                 | 最近事件是 thinking / tool-call 且未见 completed |
| `needs-you` | **卡在等你**（批准 / 回答）← 悬浮框存在的意义 | 最近事件是 question / approval                |
| `done`      | 完成一轮，等你下个 prompt            | 最近事件是 completed                          |
| `error`     | 出错                          | 最近事件是 error                              |
| `idle`      | 会话开着但无活动                    | 无事件 / 久未活动                               |
| `exited`    | 进程结束                        | exited                                   |




#### Schema（草图，讨论用）

```ts
type SessionStatus = 'working' | 'needs-you' | 'done' | 'error' | 'idle' | 'exited'

interface Session {
  sessionId: string
  tabId: string
  adapterId: string            // 'claude-code' | 'codex' | ...
  status: SessionStatus        // 派生自事件流；悬浮框主状态（颜色/图标）
  detail?: string              // 一行细节："运行 npm test" / "等待批准：写入 src/main.ts"
  lastPrompt?: string          // 最近一次 prompt-submitted（派生，非容器）
  lastActivityAt: number
  recentEvents: SessionEvent[] // 仅保留最近 N 条，用于侧栏展开看细节；非完整历史
}

interface SessionEvent {
  type: 'prompt-submitted' | 'thinking' | 'tool-call' | 'tool-result'
      | 'question' | 'approval' | 'completed' | 'error' | 'exited'
  at: number
  summary: string              // 一行人类可读摘要，UI 直接显示
  attention?: boolean          // 是否"需要你"，驱动状态与通知
  // payload 按 type 细化，后续定
}
```

> **v1：只看不操作。** 悬浮框/侧栏纯展示状态与事件；要批准/回答就回到对应终端 Tab 手动做。**不做**"从悬浮框直接响应 → 反向注入 pty"这条链路，`question`/`approval` 事件只携带"在等什么"用于展示与通知，不携带可点击选项。（反向注入作为未来增强，届时单独设计。）



#### 可靠性：关键事件优先走旁路信号

上表事件几乎一对一映射到 **Claude Code 官方 hook 事件**：

```
UserPromptSubmit → prompt-submitted    PreToolUse  → tool-call
PostToolUse      → tool-result          Notification→ approval / question
Stop             → completed            (进程退出) → exited
```

**通知语义上：误报烦，漏报致命。** "需要你"这类注意力事件应优先从 **hooks / transcript** 拿（CLI 主动上报，稳），抓屏只作没有旁路能力的 CLI 的兜底——抓屏判断"是否在等批准"太脆（TUI 一重绘就可能误判）。这正是 §11.3「优先旁路，抓屏兜底」在状态模型上的体现。

#### 通知绑定

标记了 `attention` 的事件（question / approval / completed / error）可触发通知；用户可配规则，如"needs-you 立即通知""done 仅当 app 不在前台时通知"。

状态推送：主进程维护每 session 的归约状态，变化时 diff 后经 IPC 推给 Renderer（`session:state:{sessionId}`），存入 Zustand 的 `sessionsStore` 驱动悬浮框 / 侧栏 / 通知。

### 11.6 与终端 UI 的关系

- 语义状态**不影响**终端字符显示——xterm 照常原样渲染 CLI 的 TUI。
- 语义状态**额外**驱动：Tab Header 上的状态徽标、侧栏摘要、Dashboard 聚合视图、（可选）系统通知（如"等待你批准"时提醒）。
- 这与 §6 多 Tab 模型正交：`tabsStore` 管 Tab，`sessionsStore` 管语义状态，通过 `sessionId ↔ tabId` 关联。



### 11.7 里程碑增补

语义监控作为独立里程碑线，**依赖 M1（拿到 pty 字节流）后即可起步**，与终端功能线并行：


| 阶段  | 目标                                                                                           |
| --- | -------------------------------------------------------------------------------------------- |
| S0  | SemanticTap 分流 + 主进程 HeadlessScreen 重建屏幕（能 dump 出网格文本）                                       |
| S1  | 第一个适配器（claude-code）：抓屏策略识别 working / needs-you / done，归约出 status 推到侧栏                        |
| S2  | 加旁路信号（hooks + transcript tail）：拿到可靠的 prompt-submitted / tool-call / approval / completed 事件流 |
| S3  | 第二个适配器（codex）验证抽象是否够用；悬浮框聚合多 session 状态                                                      |
| S4  | 通知系统：注意力事件（needs-you / done / error）按用户规则触发通知（v1 只看不操作，不做反向注入）                               |

S 线与 M6 的分工：S 线负责**跑通架构**——分流、抓屏、旁路信号、以 claude-code 与
codex 两个参考适配器验证 adapter 抽象是否够用；M6 负责**铺开覆盖面**——在 S3 抽象
定稿后接入剩余主流 CLI，两者不重叠。适配器接口若在 M6 期间需要变更，属抽象验证失败，
应回溯 S3 而非在 M6 内打补丁。


---



## 附：数据流总图

```
键盘输入
  → xterm.onData
  → PtyProxy.write → IPC(pty:write) → PTYManager → node-pty → ConPTY/Unix PTY

shell 输出
  → node-pty 'data' → PtyDataQueue(背压) → IPC(pty:data)
  → PtyProxy.onData → xterm.write(bytes, cb) → VT 解析 → Buffer → WebGL 渲染
  → cb 触发 → PtyProxy.ack → IPC(pty:ack) → 流控放行

语义监控（旁路，非阻塞）
  → node-pty 'data' → SemanticTap
       ├→ HeadlessScreen(@xterm/headless) → 屏幕网格
       └→ SidebandSources(hooks / transcript / osc)
  → AiCliAdapter.strategies 提取 → SessionState(归一化)
  → diff → IPC(session:state) → Renderer sessionsStore → Dashboard / 侧栏徽标 / 通知
```

