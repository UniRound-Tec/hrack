# AI CLI 专用终端 — 总体框架 Spec

> 跨三端（Windows / macOS / Linux）终端应用。
> **产品定位：一个完整、好用的通用终端，同时为 AI CLI（Claude Code / Codex CLI 等）提供专门的运行状态监控**。
> - **普通终端能力是一等公民**：多 Tab、shell、滚动、搜索、复制粘贴、主题、连字、性能——都要做扎实，不是 AI 监控的附属品。用户即便不跑 AI CLI，它也应是一个称手的终端。
> - **AI CLI 监控是差异化能力**：在跑 AI CLI 时，额外实时呈现其状态（思考中 / 等待批准 / 完成 / 上下文用量 / 当前任务）。
> 技术路线：**Electron 原生窗口壳 + React 应用 UI + xterm.js 6.0（WebGL 渲染）+ node-pty 原生 PTY**。
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
│                        xterm.js 6.0  ── addons: fit / webgl / search / ...     │
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
| channel | 参数 | 返回 |
|---|---|---|
| `pty:spawn` | `{shell, args, cwd, env, cols, rows}` | `{ptyId}` |
| `pty:write` | `{ptyId, data}` | `void` |
| `pty:resize` | `{ptyId, cols, rows}` | `void` |
| `pty:kill` | `{ptyId}` | `void` |
| `pty:ack` | `{ptyId, bytes}` | `void` |  ← 背压回执

**Main → Renderer（send，事件流）**
| channel | 载荷 |
|---|---|
| `pty:data:{ptyId}` | `Uint8Array` |
| `pty:exit:{ptyId}` | `{code, signal}` |

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
加载：`fit / search / serialize / unicode11 / image(sixel) / ligatures / webgl / canvas`。

降级路径（Tabby 同款）：
```
WebGL Addon  ──(WebGL 不可用)──►  Canvas Addon  ──(GPU context 丢失且恢复失败)──►  DOM Renderer
```
监听 webgl addon 的 `onContextLoss`，失败即 dispose 并 fallback。

### 5.3 尺寸链路
```
窗口 resize → 容器尺寸变化 → ResizeObserver → FitAddon.fit() → (cols,rows)
           → PtyProxy.resize → IPC → node-pty.resize → ConPTY / Unix PTY
```
保证 shell / vim / tmux 看到的是**终端区域**的行列，而非整窗。

---

## 6. 多 Tab 状态模型

- `tabsStore`（Zustand）：`tabs: {id, title, ptyId, kind}[]`、`activeTabId`。
- **每个 Tab 的 xterm 实例常驻**（用 CSS `display:none` 隐藏非活动 Tab，而非卸载），避免切 Tab 丢失滚动缓冲与渲染上下文。
- 标题来源：xterm 的 `onTitleChange`（OSC 序列）→ 更新 store。
- 关闭 Tab：`term.dispose()` + `pty:kill` + 从 store 移除。

---

## 7. 平台差异一览（大多由底层库抹平）

| 关注点 | Windows | macOS | Linux |
|---|---|---|---|
| 窗口后端 | Win32 (via Chromium) | AppKit | Wayland/X11 |
| PTY | ConPTY (node-pty) | Unix PTY | Unix PTY |
| 窗口效果 | Acrylic/Blur | Vibrancy | 透明 |
| 默认 shell | pwsh / cmd | zsh | bash |
| 打包 | nsis | dmg | AppImage + deb |

上层代码只面对统一的 `spawn/write/resize/kill/data/exit`。

---

## 8. 技术选型

| 关注点 | 选型 | 理由 |
|---|---|---|
| 壳 | Electron | 跨三端、成熟、Chromium 抹平差异 |
| UI | React 18 + TypeScript | 需求指定 |
| 状态 | Zustand | 轻量，可在 hook 外读写，无 re-render 陷阱 |
| 终端 | xterm.js 6.0 + WebGL | 需求指定 |
| PTY | node-pty | 事实标准，封装 ConPTY/Unix PTY |
| 构建 | electron-vite | 一套配置同时构建 main/preload/renderer，HMR |
| 打包 | electron-builder | 三端安装包 |
| 样式 | Tailwind CSS | 原子化、无全局污染、开发快；配 CSS 变量做主题 |

**插件系统**：v1 **不做**。Tabby 的动态模块加载深绑 Angular DI，React 无等价物，强套代价高。若后续需要，用 React Context + 事件总线自建扩展点，届时单独立 Spec。

---

## 9. 里程碑（增量交付）

| 阶段 | 目标 | 完成标志 |
|---|---|---|
| M0 | 脚手架 | electron-vite 起窗口，React 渲染 "hello" |
| **M1** | **最小回显链路** | React 挂 xterm → IPC → node-pty → 能跑 shell、回显正常 |
| **M2** | **resize + 背压** | 窗口缩放行列同步；`yes`/`cat bigfile` 不卡 UI |
| **M3** | **多 Tab** | 新建/切换/关闭 Tab，各自独立 pty 与缓冲 |
| M4 | 渲染与体验 | WebGL + context-loss 降级链；消除 `opencode` 块字符色块网格缝；主题、字体、连字 |
| M5 | App Shell | 侧栏、首页、设置面板 |
| M6 | 窗口质感 | 无边框、vibrancy/acrylic、托盘、全局快捷键 |
| M7 | 打包 | 三端安装包产出 |

优先级：**M1 是地基**，其余按需推进。

**当前进度（2026-07-31）：M3 已完成。**

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

M4 已确认的渲染验收点：

- 当前 DOM renderer 会把 `opencode` 用于色块的连续 `▀` 字符按字体轮廓栅格化，
  在分数 cell 宽与抗锯齿下产生周期性网格缝；更换字体不能可靠消除，缩放可能放大。
- WebGL renderer 对照已确认能把同一色块横条的缝隙像素降为 0。M4 必须以
  WebGL 为首选，并在 context loss / 不支持时安全回退 DOM renderer。
- M4 应把该 `opencode` 场景固化为视觉回归门禁，不能只验证 addon 成功加载。

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
- 用 **`@xterm/headless`**（xterm 官方无渲染构建，同一套 VT 解析器）在主进程为每个被监控会话重建屏幕网格。
- 适配器读 `buffer.active` 的单元格 / 行文本提取状态。
- **放主进程、用独立 headless 实例的理由**：语义层不绑定任何 Tab 的 UI 生命周期，是单一事实来源，且未来扩展后台/未聚焦会话时天然支持。
- **固有成本：同一字节流被 VT 解析两次**（Renderer 的 xterm 一次用于显示、主进程的 headless 一次用于语义）。这是"语义独立于 UI"的代价，**不是主进程方案的缺点**——若改为复用 Renderer buffer 只解析一次，就会把语义绑死在 UI 上。对"几个 AI CLI 会话"量级，多一次解析的开销可忽略（xterm 解析器本就为全屏高刷 TUI 设计）。

**B. SidebandSources —— 旁路结构化信号（比抓屏可靠）**
| 手段 | 可靠性 | 说明 |
|---|---|---|
| **Hooks**（如 Claude Code settings.json 事件钩子） | ★★★★ | CLI 主动上报事件，最稳 |
| **Transcript 日志**（如 `~/.claude/projects/**/*.jsonl`） | ★★★★ | 结构化，可 tail |
| **OSC 标记注入** | ★★★ | 若能包裹/配置 CLI 输出 |
| **屏幕抓取**（HeadlessScreen） | ★★ | 通用兜底，CLI 改 UI 可能失效 |

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

**不设 "Turn / 一轮任务" 这层结构。** 一轮任务的边界（哪开始、哪结束）恰恰最难可靠判断——抓屏时 AI 中途停顿、多步骤、被打断都会导致误切或误并，一旦切错，挂在其上的时间线与"完成"通知全错。因此模型只有两层：**Session（=一个 Tab，长期）+ 扁平事件流**。需要"当前在做什么 prompt"时，取**最近一次 `prompt-submitted` 事件**作为派生字段即可，不建容器去框住它 → 框架永不需要判断任务边界，也就没有误判空间。

#### 事件类型（会话生命周期）

| 事件 type | 触发 | 关键 payload | 注意力事件 |
|---|---|---|---|
| `prompt-submitted` | 用户提交 prompt | prompt 文本 | 否 |
| `thinking` | AI 开始思考 | — | 否 |
| `tool-call` | 调用工具 | 工具名、参数摘要（如 `Bash: npm test`） | 否 |
| `tool-result` | 工具返回 | ok / 失败 | 否 |
| `question` | AI 向用户提问 | 问题文本 | ✅ 需要你 |
| `approval` | 请求批准操作 | 要批准什么 | ✅ 需要你 |
| `completed` | AI 停下、交还控制权 | 结果摘要 | ✅ 完成 |
| `error` | 出错 | 错误信息 | ✅ |
| `exited` | 进程退出 | 退出码 | ✅ |

#### 派生的当前状态：注意力导向

悬浮框真正要回答的是"**这个 session 现在要不要我**"，所以主状态是注意力导向而非技术导向：

| status | 含义 | 归约规则（示例） |
|---|---|---|
| `working` | 在思考/跑工具，别管它 | 最近事件是 thinking / tool-call 且未见 completed |
| `needs-you` | **卡在等你**（批准 / 回答）← 悬浮框存在的意义 | 最近事件是 question / approval |
| `done` | 完成一轮，等你下个 prompt | 最近事件是 completed |
| `error` | 出错 | 最近事件是 error |
| `idle` | 会话开着但无活动 | 无事件 / 久未活动 |
| `exited` | 进程结束 | exited |

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

| 阶段 | 目标 |
|---|---|
| S0 | SemanticTap 分流 + 主进程 HeadlessScreen 重建屏幕（能 dump 出网格文本） |
| S1 | 第一个适配器（claude-code）：抓屏策略识别 working / needs-you / done，归约出 status 推到侧栏 |
| S2 | 加旁路信号（hooks + transcript tail）：拿到可靠的 prompt-submitted / tool-call / approval / completed 事件流 |
| S3 | 第二个适配器（codex）验证抽象是否够用；悬浮框聚合多 session 状态 |
| S4 | 通知系统：注意力事件（needs-you / done / error）按用户规则触发通知（v1 只看不操作，不做反向注入） |

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
