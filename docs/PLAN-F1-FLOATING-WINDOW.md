# F1 — 独立置顶悬浮窗实施计划

> 状态：核心实现完成（Windows 真窗口 E2E 已通过；macOS / Linux 真机与真实 Claude Code / OpenCode smoke 待补）
> 前置：M5.c 系统集成、S1 Agent projection、S2 Claude Code Adapter、S3 OpenCode Adapter  
> 原型依据：`prototype/src/components/FloatWindow.tsx`  
> 目标平台：Windows / macOS / Linux

---

## 1. 目标与完成标志

F1 把原型中的应用内 mock 落成真正的第二个 `BrowserWindow`。主窗口隐藏、最小化或停留在
其他页面时，悬浮窗仍持续显示 Vibing 内正在运行的 AI CLI Session 状态。

完成时应满足：

1. 设置中的“悬浮窗”开关可用，默认关闭，选择会跨重启保存；
2. 开启后全局最多存在一个独立、无边框、置顶、可拖动的小窗；
3. 主窗口隐藏到托盘后悬浮窗仍可见，悬浮窗的状态更新不依赖主窗口 DOM；
4. 默认显示按 `lastActivityAt` 降序排列的前 3 个未退出 Session，可展开查看全部；
5. 头部只显示需要处理的数量；`needs-you` 与 `error` 均计入需要处理；
6. 每行显示品牌图标、六态状态点、最新可展示内容和相对时间；
7. 点击 Session 会显示并聚焦主窗口，进入该 Session 所属终端；
8. v1 只看不操作，不提供批准、回答、重试、停止或终端输入；
9. Session 退出后从悬浮窗移除；没有活跃 Session 时显示紧凑空态，不自动创建 PTY；
10. 快速开关、renderer reload、应用退出均不产生重复窗口、幽灵 Session 或孤儿进程。

---

## 2. 已定产品行为

### 2.1 展示规则

- “活跃”只表示 `status !== 'exited'`，因此 `idle / done / error / needs-you / working`
  都可以继续显示；
- 排序唯一依据是主进程 projection 的 `lastActivityAt`，相同时间以 `sessionId` 稳定排序；
- 收起态显示 3 条；展开态显示全部，但列表有最大高度，超出后只纵向滚动；
- `detail` 使用现有 `renderAgentDetail()` 与五语言文案，不展示原始事件、完整 prompt、工具参数、
  工具输出或隐藏思考文本；
- 状态点、状态色、品牌图标复用正式应用的 `sessionStatus.ts` 与 `adapterIcons.ts`；
- projection 更新只刷新内容，不抢焦点、不弹出已被用户关闭的窗口。

### 2.2 窗口行为

- 默认宽度沿用原型 248px；初始位置为当前主显示器工作区右下角，边距 20px；
- 顶栏为拖动区，关闭按钮、列表行和展开按钮必须标记为 `no-drag`；
- 悬浮窗可交互，不做鼠标穿透；不进入任务栏，不显示系统菜单，不参与主窗口最大化逻辑；
- 拖动结束后保存显示器与位置；屏幕拔插、分辨率或缩放变化后把窗口夹回可见工作区；
- 展开/收起由 renderer 上报内容高度，主进程限制最小/最大高度并保持窗口右下锚点稳定；
- 点击悬浮窗关闭按钮等价于关闭设置开关；应用正常退出只销毁窗口，不把用户偏好改成关闭；
- 不启用 vibrancy、acrylic 或系统模糊；视觉继续使用现有主题 token 和 CSS 阴影。

### 2.3 三端约定

| 平台 | 窗口策略 |
|---|---|
| Windows | `frame: false`、`alwaysOnTop`、`skipTaskbar`；使用 Chromium 透明背景与 CSS 圆角 |
| macOS | 同样使用无边框紧凑窗；置顶层级使用 Electron 的 floating 语义，不占 Dock |
| Linux | X11/Wayland 都走同一接口；透明不可用时允许退化为主题实色背景，但功能不得失效 |

v1 不默认跨虚拟桌面/Space 显示，避免悬浮窗无意出现在用户的全部工作区。该能力以后单独加设置。

---

## 3. 架构：让悬浮窗只消费 projection

```text
Agent Adapter
    ↓
AgentSessionRuntime（主进程权威 projection）
    ├── Main BrowserWindow ── AppShell / sessionsStore
    └── Floating BrowserWindow ── FloatingApp / 只读 Session 列表
                                      │
                                      └── 点击 Session → Main 显示并导航 terminalId
```

悬浮窗不得访问 Claude/OpenCode Adapter，也不得读取 xterm、PTY 字节或主窗口 React state。
它只使用 S1 已冻结的 `AgentSessionProjection`：

- 启动时先订阅 `agent:projection`，再调用 `agent:list-active` 做初始对账；
- 增量与初始列表都按 `lastSeq` 去重，避免“先收到新事件、后返回旧快照”覆盖；
- `AgentSessionRuntime.broadcast()` 已向全部 `BrowserWindow` 广播，F1 不新增第二套事件总线；
- 最终 `exited` projection 到达后立即移除；`listActive()` 本身仍只返回未退出 Session。

### 3.1 深模块：`FloatingWindowController`

新增主进程模块 `electron/floating/FloatingWindowController.ts`，把建窗、单例、偏好、几何、
导航和销毁收在一个实现内。外部接口保持小：

```ts
interface FloatingWindowController {
  setEnabled(enabled: boolean): Promise<void>
  focusSession(sessionId: string): boolean
  resizeToContent(height: number): void
  dispose(): void
}
```

调用方不需要知道 `BrowserWindow` 是否已经创建、正在加载、位于哪个显示器或处于退出流程。
窗口选项与坐标换算放在模块内部纯函数中，供三端单元门禁直接验证。

### 3.2 唯一偏好来源

`floatEnabled` 的持久化权威移到主进程 `<userData>/main-prefs.json`：

- `MainPrefs` 新增 `floatingWindowEnabled` 与经过校验的窗口位置；
- renderer 的 `settingsStore.floatEnabled` 改为主进程状态的展示副本，不再独立持久化；
- 设置页首次进入通过 `floatingWindowApi.getState()` 对账；
- 设置页开关、悬浮窗关闭键均调用同一个 `setEnabled()`；
- 主进程向所有 renderer 广播 enabled 变化，避免主窗与悬浮窗各保存一份后发生分叉；
- `settingsStore` 升级版本并删除“迁移时永远强制 false”的临时逻辑。

### 3.3 重命名同步

目前主窗口重命名只改 renderer 的 `sessionsStore`，第二个 renderer 看不到。F1 实施时必须把
活动 Session 的显示名称写回主进程 projection：

- `AgentApi` 增加受控 `rename(sessionId, name)`；
- 主进程校验非空、长度与 Session 存活状态，更新 projection 的 `name / lastSeq`；
- 重命名不修改 `lastActivityAt`，因此不会伪造活动或改变排序；
- 主窗口和悬浮窗都通过同一 projection 收到新名称；
- 已退出且已脱离 Runtime 的历史 Session 暂维持现有本地重命名行为，不属于悬浮窗范围。

---

## 4. Renderer 与 IPC 设计

### 4.1 独立 renderer 入口

继续复用同一份 Vite renderer 产物，用受控 query（如 `?surface=floating`）选择根应用：

- `surface=main`：现有 `AppShell`，行为不变；
- `surface=floating`：只挂载 `FloatingApp`，不挂载 `AppShell / TerminalPage / xterm`，不调用
  `pty:list-recoverable`，更不创建默认终端；
- 主题注册、五语言、字体 CSS 为共用 bootstrap；终端字体等待与 xterm 初始化只属于主界面；
- 非法 surface 回退主界面，生产环境不接受任意 URL。

这条分流是防幽灵实例门禁：创建悬浮窗本身不能触发任何 shell、CLI 或 PTY 启动链路。

### 4.2 收窄 IPC

新增独立 `FloatingWindowApi`，不把 `BrowserWindow` 或裸 `ipcRenderer` 暴露给 renderer：

```ts
interface FloatingWindowState {
  enabled: boolean
}

interface FloatingWindowApi {
  getState(): Promise<FloatingWindowState>
  setEnabled(enabled: boolean): Promise<FloatingWindowState>
  resizeToContent(height: number): Promise<void>
  focusSession(sessionId: string): Promise<boolean>
  onStateChanged(cb: (state: FloatingWindowState) => void): () => void
}
```

主进程校验 sender、Session id 与高度范围。导航成功时：

1. 从 `AgentSessionRuntime.listActive()` 找到权威 projection；
2. 显示、恢复并聚焦主窗口；
3. 向主窗口发送 `app:focus-session { sessionId, terminalId }`；
4. `AppShell` 只在 terminal 仍存在时导航，竞态失败则停留 Home，不创建替代终端。

### 4.3 UI 模块

实际实现收在一个小型独立入口 `src/floating/FloatingApp.tsx`：负责 projection 订阅/对账、
稳定排序、attention 计数、相对时间、收起/展开、拖动头部和 `ResizeObserver` 高度上报。
该 surface 不挂载主应用或终端组件；等交互复杂度增长后再按职责拆分，避免当前阶段产生浅模块。

列表动画沿用原型原则：新增/更新可淡入，收起时多余条目立即卸载，外层高度做一次弹簧过渡，
避免退出动画暂时撑大真实窗口。

---

## 5. 实施阶段

### P0 — 契约与纯模型

- [x] 增加 FloatingWindow IPC 类型、channel 与 preload 包装；
- [x] 在独立 `FloatingApp` 固定过滤、排序、attention 与前三条规则；
- [x] 在 Controller 内完成窗口选项、坐标恢复与可见区域夹取；
- [x] 给 Agent projection 增加主进程重命名接口；
- [x] 门禁：迟到 projection、稳定排序、退出移除与重命名同步。

### P1 — 主进程窗口生命周期

- [x] 实现 `FloatingWindowController` 单例；
- [x] 在 `main.ts` 中于主窗口创建后按主进程偏好恢复悬浮窗；
- [x] 实现 always-on-top、skip-taskbar、拖动位置持久化、屏幕变化后夹回；
- [x] 实现内容高度限制、右下锚点与快速开关幂等；
- [x] 应用退出先 dispose 悬浮窗，但保留“下次启动仍开启”的偏好。

### P2 — 独立 renderer

- [x] 拆分 main/floating surface bootstrap；
- [x] Floating surface 只订阅 projection + `listActive` 对账；
- [x] 复用主题、i18n、状态 token 与品牌图标；
- [x] 证明创建 Floating surface 不调用任何 PTY/CLI 启动接口。

### P3 — 悬浮窗 UI

- [x] 还原 248px 紧凑视觉、拖动头部、关闭键、空态；
- [x] 完成前三条/展开全部、最大高度、纵向滚动与无横向溢出；
- [x] 显示最新 detail、状态色、相对时间和需要处理计数；
- [x] projection 更新不抢焦点，展开/收起不卡顿。

### P4 — 设置、重命名与回主窗

- [x] 启用设置页悬浮窗开关并更新五语言 hint，删除“S3 落地”占位文案；
- [x] 主进程成为 enabled 偏好的唯一来源；
- [x] Session 重命名改走主进程 projection，同步两个 renderer；
- [x] 点击条目显示/聚焦主窗口并导航现有 terminal；
- [x] 悬浮窗关闭键同步关闭设置开关，不影响主窗口与正在运行的 CLI。

### P5 — 自动化与真实走查

- [x] 真窗口门禁：重复 enable 保持单例、关闭同步设置、应用重启只恢复一个窗口；
- [x] 空态启动：开启悬浮窗后仍为 0 PTY、0 Session；
- [x] fixture 真实 Runtime 走查：working → needs-you → exited，并验证退出移除；
- [ ] Claude Code 与 OpenCode 各跑一次真实多轮会话，确认最新内容与退出移除；
- [x] 主窗隐藏到托盘时悬浮窗持续更新；
- [x] 点击条目只恢复原 Session，不克隆终端；
- [x] 4 个以上 Session 的展开、滚动、动态高度和重命名同步；
- [x] 深浅主题与五语言即时同步；
- [x] Windows E2E 真窗口验证；macOS/Linux 真机与打包 smoke 具备机器后补。

### P6 — 文档与收尾

- [x] 回写 `SPEC.md / SPEC-S.md` 当前进度与 F1 验收结果；
- [x] 删除正式代码中的“S3 落地”禁用占位；原型作为历史稿保留；
- [x] typecheck、build、目标 E2E、全量 E2E 通过；
- [x] production build 已包含第二窗口共用入口、字体和图标资源。

---

## 6. 验收矩阵

| 场景 | 预期 |
|---|---|
| 首装默认设置 | 不创建悬浮窗 |
| 开启且无 Session | 显示空态；PTY 数量仍为 0 |
| 1–3 个活跃 Session | 全部显示，无展开按钮 |
| 4 个以上活跃 Session | 默认 3 条，可展开全部，列表高度受限 |
| `needs-you` / `error` | 头部需要处理计数正确 |
| `done` / `idle` | 保留在活跃列表，展示最后内容 |
| `exited` | 最终 projection 后移除，不复活 |
| 主窗口隐藏 | 悬浮窗继续可见、继续更新 |
| 点击 Session | 主窗口恢复并进入原 terminal，不创建新实例 |
| 点击悬浮窗关闭 | 悬浮窗销毁、设置开关变关、CLI 不受影响 |
| 应用退出再启动 | 若退出前开启，则恢复一个悬浮窗；无重复窗口 |
| 显示器拔插/缩放 | 窗口被夹回可见工作区 |
| Adapter 降级 | 继续显示 lifecycle projection，不假装有完整语义 |

---

## 7. 明确不做

- 不在悬浮窗直接批准命令、回答问题、重试、停止 Session 或输入终端；
- 不展示或持久化隐藏思考链、完整 prompt、工具参数与工具输出；
- 不监听 Vibing 之外启动的 CLI；
- 不把悬浮窗做成主窗口 DOM 的 portal、截图或镜像；
- 不新增 Adapter 专用字段，不让悬浮窗感知 Claude/OpenCode native 协议；
- 不做鼠标穿透、跨全部虚拟桌面、通知中心或硬件提醒；
- 不因悬浮窗加载失败而终止 CLI、关闭主窗口或创建替代终端。

---

## 8. 主要风险与对策

| 风险 | 对策 |
|---|---|
| 第二 renderer 启动时漏掉 projection | 先订阅、后 `listActive`，以 `lastSeq` 对账 |
| 本地重命名在两个窗口分叉 | 活动 Session 重命名回写主进程 projection |
| 开关快速点击创建多个窗口 | controller 内部串行化 create/destroy，单例引用 + pending promise |
| 悬浮窗触发 AppShell 自动恢复/建终端 | 独立 surface 永不挂载 AppShell/xterm，并以 0 PTY E2E 锁死 |
| 退出事件后条目残留 | 最终 exited projection 驱动删除，listActive 只返回未退出 |
| 动画频繁调整原生窗口造成抖动 | `ResizeObserver` 合并上报；主进程夹取并保持锚点 |
| Linux 透明窗依赖 compositor | 功能优先，透明失败退化主题实色，不依赖系统模糊 |
| 窗口掉到已移除显示器 | 保存相对显示器位置，创建/屏幕变化时重新夹取 |
| 关闭应用时错误写回 disabled | quitting dispose 与用户 disable 使用不同路径 |

F1 的核心验收不是“画出一个小卡片”，而是证明第二个窗口能够稳定消费同一份权威
projection，同时完全不介入 Agent Adapter、PTY 和 CLI 生命周期。
