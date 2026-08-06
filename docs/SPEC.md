# AI CLI 专用终端 — 总体框架 Spec

> 跨三端（Windows / macOS / Linux）终端应用。
> **产品定位：一个完整、好用的通用终端，同时为 AI CLI（Claude Code / Codex CLI 等）提供专门的运行状态监控**。
>
> - **普通终端能力是一等公民**：多 Tab、shell、滚动、搜索、复制粘贴、主题、连字、性能——都要做扎实，不是 AI 监控的附属品。用户即便不跑 AI CLI，它也应是一个称手的终端。
> - **AI CLI 监控是差异化能力**：在跑 AI CLI 时，额外实时呈现其状态（思考中 / 等待批准 / 完成 / 上下文用量 / 当前任务）。
> 技术路线：**Electron 原生窗口壳 + React 应用 UI + xterm.js 6.x（WebGL 渲染）+ node-pty 原生 PTY**。
> 架构参考 Tabby，UI 层由 Angular 换为 React。
>
> **两条能力线并行**：终端功能线（§1–§9）与 AI CLI 发现/语义线（[SPEC-S.md](./SPEC-S.md)，原 §11）正交推进；当前 S0 只做发现与启动，后续语义监听才可能依赖 pty 字节流且不得侵入显示链路。
>
> **S 线当前闭环（S0）** 详见 [SPEC-S.md](./SPEC-S.md)：扫描 Windows/macOS/Linux 当前主机，并在 Windows 枚举各 WSL 发行版 → 真启动列表 → 点击进入配置 → 按所选安装启动；扫描与启动逻辑已完成，监听与六态语义后置。

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
  **M5.c 定论：三端系统窗口材质均不实现**（质感由屏幕锚定环境渐变 + 深浅双主题承担）。
- 系统集成（M5.c 已实现）：托盘（Windows/Linux 图标单击切换、菜单：显示/隐藏 / 新建会话 / 退出）、
  全局快捷键 `Ctrl+Alt+V`（quake 式切换，设置开关可关）、关闭到托盘（标题栏 X = 隐藏窗口，
  仅托盘「退出」真正退出）。
- 事件持久化（M5.c）：`<userData>/events/events.jsonl` + `stats.json` 单调计数，写入目标为
  S 线语义事件的共用管道。
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
| `window:get-position`    | —                     | `{x, y, screenWidth, screenHeight}`（相对当前显示器） | M5.b 实现 |
| `dialog:pick-directory`  | `{defaultPath?}`      | `string \| null`                             | M5.b 实现 |
| `theme:list-user`        | —                     | 用户主题 JSON 原文列表（renderer 校验）                | M5.b 实现 |
| `stats:all-time`         | —                     | `{sessions, toolCalls, blocked, approvals}`  | M5.c 实现 |
| `events:history`         | `{limit, before?}`    | `HistoryEvent[]`                             | M5.c 实现 |
| `events:record`          | `{kind, adapterId, title, detail}` | `void`（id/occurredAt 由主进程生成） | M5.c 新增（Renderer→Main） |
| `app:set-main-prefs`     | `{backgroundColor?, globalShortcutEnabled?, language?}` | `void` | M5.c 新增（Renderer→Main） |


**Main → Renderer（send，事件流）**


| channel                    | 载荷               |
| -------------------------- | ---------------- |
| `pty:data:{ptyId}`         | `Uint8Array`     |
| `pty:exit:{ptyId}`         | `{code, signal}` |
| `window:maximized-changed` | `boolean`（M5.b 新增，驱动最大化/还原图标） |
| `window:position-changed`  | `{x, y, screenWidth, screenHeight}`（M5.b 新增，主进程节流 ~30ms；驱动侧栏屏幕锚定环境渐变） |
| `app:open-new-session`     | —（M5.c 新增：托盘「新建会话」菜单 → renderer 打开新建会话面板） |
| `theme:user-themes-changed`| —（M5.c 新增：`<userData>/themes` 变更推送，renderer 重载主题注册表） |


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
animation frame 的稳定结果比较的门禁已降级：该像素时序断言易受 compositor 调度影响，
不能稳定区分产品回归与测试环境抖动。当前 E2E 只验证宽窄 resize 后网格尺寸、WebGL
context 与 renderer 均保持可用；同步重画能力由精确锁定的上游修复版本保证。

`@xterm/addon-ligatures` 0.10.0 需要 Node 文件系统定位并解析本机字体，不能用于
`nodeIntegration:false` 的 Renderer；本项目不引入该 addon，也不为字体放宽安全边界。
M4.1 改用 xterm 6 的 character joiner proposed API：应用只识别连续操作符与 Maple
内建标签范围，实际 OpenType `calt` 整形由浏览器和内嵌的标准版 Maple Mono 完成，
不需要文件系统或新 IPC。xterm 会按前景/背景属性切分范围，并在光标进入连字或选区
切开连字时退回逐字符绘制，因此 buffer、复制内容与字符格坐标保持原义。WebGL 与 DOM
降级路径共用同一个 joiner；`ligatures` 设置可即时注册/注销。

默认终端字体为内嵌 Maple Mono v7.9 WOFF2、14px（settingsStore v4 起；v3 及以前
默认 16px，迁移时仍停留在旧默认值的用户跟随新默认）；启动时先等待常规/粗体加载再
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
`sessionsStore`（AI CLI 会话，[SPEC-S](./SPEC-S.md) §5 Session 形状，`sessionId ↔ terminalId` 固定
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
| 字体  | 内嵌 Maple Mono（终端）+ PingFang SC（界面中文）+ Ammonite（logo） | 三端视觉一致、离线可用；PingFang 完整字库入库（`src/assets/fonts/pingfang/`），Ammonite 随 M5.b 入库 `src/assets/fonts/ammonite/`，**构建期子集化后打包，禁止全量打包**（见 §9 M5.a 注记与目录内 NOTICE）；Geist 不引入（原型仅作未显式指定字体的兜底，已查证无实际使用）。**M5.c 注记**：子集化扫描覆盖五语言 UI 文案（`src/app/i18n/*.ts`）；PingFang SC 无谚文（Hangul），ko 界面中文字体命中不到的字形回退系统栈（Windows Malgun Gothic / macOS Apple SD Gothic Neo），ja 假名同理回退平台字体 |


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
| **M5.a** | **App Shell — UI/UX 设计与原型** | 高保真交互原型（`/prototype` 独立 Vite 工程）评审拍板，不另写 UX 规范文档；设计覆盖侧栏/首页/设置/新建会话流、三态导航（侧栏展开为默认 / 侧栏收起图标条 / 顶部 Tab 栏）、[SPEC-S](./SPEC-S.md) 监控界面（侧栏 session 六态徽标、独立置顶悬浮窗、Home 注意力队列），实现归 M5.b / S 线 |
| **M5.b** | **App Shell — 实现**          | 无边框窗口 + 自定义标题栏（原型标题栏设计的前置条件）；侧栏、首页、设置真组件落地；设置面板直读写 `settingsStore`；侧栏 session 区读取真实 `sessionsStore`（[SPEC-S](./SPEC-S.md) §5 schema）；交互 E2E 全绿且既有门禁不回归 |
| **M5.c** | **App Shell — 数据与打磨**       | 真实数据接入（stats / history 持久化管道，M5.c 只记生命周期事件，语义事件归 S 线沿同一管道补）、i18n 五语言、托盘 + 全局快捷键 `Ctrl+Alt+V`、关闭到托盘、深色首帧底色、主题热重载；质感由环境渐变 + 双主题承担，**不做 vibrancy/acrylic**；全量回归；AI session 真数据不在此（归 S 线）                             |
| **M5.d ✅** | **工作区只读代码阅读器**          | 有工作区的 AI CLI Terminal 右侧提供 A 并排布局：可折叠、Reader/File tree 双层可调宽、lazy 文件树与 CodeMirror 只读高亮；主进程收窄 Workspace Interface 覆盖 Native/WSL，禁止任何编辑与根目录逃逸。Windows/真实 WSL 自动化已通过，macOS/Linux 发版 smoke 待办。实施见 [PLAN-M5D-WORKSPACE-READER.md](./PLAN-M5D-WORKSPACE-READER.md) |
| **F2 ✅** | **AI CLI 会话分组与手动排序** | 侧边栏 AI Session 以稳定 `terminalId` 持久化手动顺序；Pointer 拖动支持根排序、组内排序、移入移出及 800ms 悬停建组。分组始终展开，顶部 Tab 只平铺成员。注意力优先默认关闭；开启后按整个分组提升且不改变组内顺序。右键启动新 CLI 仅在首个真实 projection 到达后原子建组，失败/取消不留幽灵状态。实施与门禁见 [PLAN-F2-AI-CLI-GROUPS.md](./PLAN-F2-AI-CLI-GROUPS.md) |
| M6       | CLI 适配器矩阵                   | 依赖 [SPEC-S](./SPEC-S.md) S3 定稿的 adapter 抽象；铺开接入剩余主流 CLI（gemini-cli / opencode / aider / cursor-agent 等），每个适配器带独立状态识别策略与回归夹具    |
| M7       | 打包                          | 三端安装包产出                                                                                             |


优先级：**M1 是地基**，其余按需推进。

**F1 悬浮窗已完成核心实现（2026-08-03）**：原先暂挂在 S3 名下的独立置顶小窗现单列为
F1，避免与已经用于 OpenCode Adapter 的 S3 重名。悬浮窗是第二个 `BrowserWindow`，只消费
S1 主进程 `AgentSessionProjection`，默认展示最近 3 个未退出 Session，可展开查看全部，
点击只负责恢复主窗口并进入原终端。窗口生命周期、偏好、跨显示器几何、独立 renderer、
设置同步与重命名同步均已落地；Windows 真窗口 7 条 E2E 与全量 151 条门禁通过。三端策略及
待补真机 smoke 见 [PLAN-F1-FLOATING-WINDOW.md](./PLAN-F1-FLOATING-WINDOW.md)。

**当前进度（2026-08-06）：M0–M5.d、F2、S0、S1、S2 Claude Code Adapter 与 S3 OpenCode
Adapter 已完成；跨平台自动化矩阵仍待补。M5.d 已完成生产 A 布局、主进程只读 Interface、
Native/WSL runtime、双层拖拽、lazy/虚拟化文件树与 CodeMirror，并通过 Windows 和真实
Ubuntu-22.04 `/mnt/c`、`/home` 门禁；macOS/Linux 发版真机 smoke 待补。F1 悬浮窗核心实现
与 Windows E2E 已完成；通知、M6 其余 Adapter 矩阵与 M7 三端打包尚未开始。**

**M5.a → M5.b 历史决策记录（2026-08-02）：**M5.a 原型（`/prototype`）已覆盖全部设计范围。已定决策：侧栏替代 M3 Tab 栏，导航三态互斥：侧栏展开 / 侧栏收起（图标条）/ 顶部 Tab 栏（无侧栏，Home 常驻最左、新建常驻 tabs 右、hover 出详情卡）；标题栏左侧以实际功能入口（新建会话 / 设置）取代占位菜单（文件/编辑/视图/帮助），三种导航形态下全局恒定；侧栏底部保留快速收展开关；界面（chrome）主题与终端 16 色配色在设置中分开设置——M4 的单一 `themeId` 于 M5.b 拆分为界面/终端两个字段，`themes.ts` 色值结构不变；session/terminal 归属按启动方式固定不迁移；悬浮窗为独立置顶小窗（第二 BrowserWindow，实现归 S3）；v1 只看不操作（注意力列表仅"查看"跳转，无批准/重试）；all-time 统计与跨 session 历史事件需新增 IPC 契约与主进程持久化（契约定于 M5.b，实现归 M5.c / S 线）；中文 UI 字体内嵌 PingFang——SC 六字重 woff2 已入库 `src/assets/fonts/pingfang/`（完整 CJK 字库约 5MB/字重，共约 30MB，来源与授权见目录内 `NOTICE.md`，版权由项目方自行解决），仓库保存完整字体，**构建时按产物实际用字子集化（如 fonttools `pyftsubset` 生成 woff2 子集，或按 unicode-range 切片），未用字重不进产物，禁止全量打包**（子集化管线随 M5.b 首次接入 UI 字体时落地）；Home 空状态（无会话且无终端）重排为居中欢迎页——logo + 问候 + 快速启动入口保留，注意力队列/历史/统计不渲染，有会话后恢复信息密度布局；悬浮窗为紧凑模式——默认仅显示按最新事件排序的前 3 个活跃（未退出）会话，可展开查看全部，头部仅保留 need-you 计数；里程碑重排——原 M6「窗口质感」拆解并入 M5 线（无边框 + 自定义标题栏归 M5.b，vibrancy/acrylic、托盘、全局快捷键归 M5.c），M6 重定义为「CLI 适配器矩阵」（依赖 S3，见 [SPEC-S.md](./SPEC-S.md) §8）。**

**M5.b 已立项（2026-08-02）**：实施计划与 12 条评审决策见
[PLAN-M5B.md](./PLAN-M5B.md)。对原型/既有约定的修订摘要：标题栏 Win/Linux 自绘右侧
三键、**不落地原型左侧三个装饰灰点**，macOS 用原生红绿灯并隐藏自绘键；Geist 字体
不引入（基础字体栈改 PingFang），Ammonite logo 字体入库内嵌并子集化；顶部 Tab 溢出
全量显示 + 横向滚动；侧栏条目补 hover 关闭键（原型未画，评审确认）；关闭最后一个
终端回 Home 不关窗口、`Ctrl+Shift+T` 改为打开新建会话面板（M3 语义调整）；GUI 全面
token 化 + JSON 主题配置文件（见 §8「GUI 主题」行）；新建 CLI 会话真实 spawn，
语义状态仅 working/exited 兜底，侧栏只显示真实启动的 CLI 会话；深色
界面主题、悬浮窗（S3）、统计/历史真数据（M5.c / S 线）均不在 M5.b。

**Home 欢迎态修订（2026-08-03）**：欢迎态只以 AI CLI session 是否存在为判断依据；
普通终端不计入，因此只有普通终端时 Home 仍显示居中欢迎页。欢迎页启动卡上方不显示
Quick Launch 标签，仅在右侧提供「重新扫描」；扫描期间图标持续旋转并禁用重复点击。
欢迎页每页最多显示 8 个启动入口，超过时在卡片下方显示上一页、页码与下一页控件；
扫描结果数量变化时自动将当前页校正到有效范围。

**导航条目去重（2026-08-03）**：AI CLI session 底层仍绑定一个 PTY terminal，但该
terminal 只作为运行载体，不在 Terminal 区重复显示；Session 区显示 CLI 会话，Terminal
区仅显示用户直接创建的普通终端。侧栏、图标栏与顶部 Tab 使用同一过滤规则。

**Home Session 队列（2026-08-03）**：注意力区域默认展示全部现存 Session，不再只显示
待处理与出错项；排序优先级为待处理 → 出错 → 运行中 → 空闲 → 完成 → 已退出，同一状态
内按最近活动时间降序。顶部「全部 / 待处理 / 出错」仍作为快速筛选。Session 队列与
历史事件列表均使用统一最小高度与最大高度，内容超出后仅纵向滚动并强制隐藏横向溢出；
不使用“展开全部”继续撑高 Home 页面。

**侧栏长列表与 Session 操作（2026-08-03）**：Session / Terminal 两区按内容紧邻排列，
不均分侧栏高度；每个列表达到高度上限后独立滚动，侧栏本身不被无限撑长。Session 条目
保留独立关闭图标，并新增 `…` 操作入口；附加操作显示在 portal 化悬浮下拉菜单中，不改变
条目或列表高度，后续克隆、分屏等操作沿同一菜单扩展。首批附加操作为重命名。
重命名编辑器不提供取消 `×`：回车、确认按钮或点击编辑区外均保存；仅空白名称保持
编辑状态并显示必填错误。条目右侧用于关闭 Session 的独立 `×` 不受此规则影响。

**M5.b 已完成（2026-08-02）**：无边框 Shell、三态导航、Home 两态、完整设置页与
新建会话三层流已落地；可用终端按平台探测，目录选择和 CLI 的 Windows/WSL 参数会
真实传入 PTY，退出状态同步回 session。PingFang 三个实际字重与 Ammonite logo 已由
构建期 HarfBuzz 子集化，打包产物有 < 1 MB 硬门禁。P5 已完成 App Shell 选择器迁移、
79 条 E2E 回归和逐页视觉核对；一次整套中的失败/跳过项均按单用例定向复跑通过，未重复
执行整套。独立置顶悬浮窗仍按既定范围归 S3。

**M5.b 完成后补充（2026-08-03，评审反馈）**：深色界面主题提前落地（内置
`src/themes/dark.json`，与浅色同为 built-in，用户 dark 主题可省略 token 回退到
内置 dark）；设置页原生 `<select>` 换成 token 化自绘下拉框；新增「圆角」开关
（settingsStore v4 `terminalRounded`，默认开）——开时内容区保留 20px 圆角且终端
两侧加留白防裁字，关时终端贴边直角；终端默认字号 16px → 14px（v4 迁移）；修复
标题栏关闭键 X 图标的 CSS 旋转错误。

**M5.c 已完成（2026-08-03）**：主进程事件持久化管道（`<userData>/events/events.jsonl`
逐行 append + 5,000 条压缩、`stats.json` 单调计数，计数独立于日志截断）落地
`stats:all-time` / `events:history`，新增 `events:record` 写入口（id/occurredAt 主进程
生成、payload 校验）；现阶段真实事件仅 `session_start` / `session_exit` 两类，由
renderer 在 CLI 会话启动与 pty 退出时上报，Home 在所有环境均读取真实 IPC 数据，
语义事件由 S 线沿同一管道补写、renderer 与存储层零改动。i18n 五语言
（zh-CN / zh-TW / en / ja / ko）统一模块化（`src/app/i18n/`，`useStrings` /
`getStrings` 双入口，`settingsStore` v5 `language` 驱动即时热切换，首装语言跟随
系统），既有 copy toast 四 key 并入。
系统集成：三端托盘常驻（菜单：显示/隐藏、新建会话、退出；macOS template image），
标题栏 X 改为隐藏到托盘（PTY 保活，托盘「退出」才真正退出）；全局快捷键
`Ctrl+Alt+V` quake 式切换（设置开关，v5 `globalShortcutEnabled`，占用时仅告警）；
深色首帧底色（renderer 上报活动主题 `bg.app` → `<userData>/main-prefs.json` →
建窗前 `BrowserWindow.backgroundColor`）；主题热重载（主进程 `fs.watch`
`<userData>/themes`，300ms debounce 推送，删除当前主题回退内置浅色并提示）。
字体子集化扫描扩展覆盖五语言文案（ja/ko 缺字形回退平台系统栈）。
Windows 下 node-pty 裸命令名解析修正（`where.exe`），CLI 会话可真实 spawn。
E2E：userData 按 launch 隔离（`VIBING_USER_DATA_DIR`），新增 events-log /
托盘 / 快捷键 / 主题热重载 / 重启持久化用例，整套 94 条通过；已知 flake
`render.spec.ts`「keeps the terminal functional when WebGL falls back to DOM」
为 M5.b 基线既有（stash 验证 1/3 复现），定向复跑即绿。

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
不再先提交空 canvas。原同步 canvas 亮度比例门禁因 compositor 时序抖动降级为
功能门禁：resize 后要求目标网格尺寸正确、WebGL context 有效且 renderer 不降级。
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

- 插件生态 / 动态模块加载（**但 AI CLI 适配器注册表是核心扩展点，必做——见 [SPEC-S.md](./SPEC-S.md) §4**）
- **监控外部终端里的 AI CLI 会话**（VS Code / 系统终端 / tmux）——需进程扫描 + 跨进程日志监视，v1 不做；架构在 [SPEC-S](./SPEC-S.md) 预留信号来源抽象，未来可加
- SSH / Serial / 其他 session 类型（先只做本地 shell；架构预留 `session kind` 字段）
- 云同步、账户体系
- 移动端

---



## 11. AI CLI 语义监控（已拆出）

> 本产品区别于普通终端的核心子系统。**完整规格见 [SPEC-S.md](./SPEC-S.md)**（S 线）。
>
> 体验主循环：**扫可启动 CLI → 启动列表 → 点启动后再挂 Hooks/监听**（v1 只看不操作）。

**衔接摘要：**

- 扫：本机哪些 AI CLI **装了、能拉起来**（不是扫已有进程）。
- 列：**启动列表**只展示扫到的候选（M5 静态 `cliOptions` 将被替换）。
- 启：用户点启动并 spawn 成功后，才按 adapter 注入 Hooks / 其它监听；运行态侧栏在后。
- M6 依赖 S 线先完成 S0「扫 / 列 / 按安装启动」，再由 S3 用第二种协议形态验证 observer 抽象（见 SPEC-S §8）。


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

语义监控（旁路，非阻塞）——详见 [SPEC-S.md](./SPEC-S.md)
  → node-pty 'data' → SemanticTap
       ├→ HeadlessScreen(@xterm/headless) → 屏幕网格
       └→ SidebandSources(hooks / transcript / osc)
  → AiCliAdapter.strategies 提取 → SessionState(归一化)
  → diff → IPC(session:state) → Renderer sessionsStore → Dashboard / 侧栏徽标 / 通知
```

