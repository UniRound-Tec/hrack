# M5.b 实施计划 —— App Shell 实现

> 状态：**进行中**（P0、P1 已完成，2026-08-02）。
> 目标：按 `/prototype` 定稿原型 **1:1 落地** App Shell——无边框窗口 + 自定义标题栏、
> 三态导航（侧栏展开 / 图标条 / 顶部 Tab）、首页（含空态欢迎页）、设置页、新建会话流；
> 设置面板直读写 `settingsStore`；侧栏 session 区由 mock provider（SPEC §11.5 schema）驱动。
> 对应 [SPEC.md](./SPEC.md) §9 里程碑 M5.b。前置：M4 已完成，M5.a 原型已评审拍板。
>
> **原型即规范**：原型特意使用 React + Tailwind（v4）编写，与主仓库技术栈一致，
> 实现必须与原型**一模一样**——布局、间距、字号、配色 token、动效参数（motion 弹簧
> 刚度/阻尼、延迟、时长）直接照搬原型代码，不做"重新设计"。

---

## 1. 范围界定

**做**：

- 无边框窗口 + 自定义标题栏（新建会话 / 设置入口 + 窗口控制），平台分支见 §4.1。
- 三态导航互斥切换：侧栏展开（默认）/ 侧栏收起图标条 / 顶部 Tab 栏，随 `settingsStore` 持久化。
- 首页：问候语 + 注意力队列（六态过滤）+ quick launch + 历史事件 + all-time 概览；
  无会话且无终端时重排为居中欢迎页。
- 新建会话流：bottom sheet（CLI 列表）→ 终端选择 modal / CLI 配置 modal → **真实 spawn pty**。
- 设置页：外观 / 布局 / 终端 / 会话 四区，直读写 `settingsStore`。
- `settingsStore` 拆分：M4 单一 `themeId` → `uiTheme` + `terminalThemeId`（persist 迁移 v3）。
- `tabsStore` 演进为 `terminalsStore` + `sessionsStore`（§11.5 Session 形状），M3 Tab 栏删除。
- Mock provider：dev/E2E 注入六态演示会话与事件，驱动侧栏 / 首页 / 徽标。
- 新增 IPC：窗口控制、目录选择；**仅定契约不实现**：all-time 统计、跨 session 历史事件。
- 字体管线：PingFang / Ammonite 构建期子集化落地（SPEC §9 M5.a 注记的强制要求）。
- 原型特效组件迁移：ShinyText / TextType / CountUp / ClickSpark / TargetCursor（作用域见 §3 决策 2）。
- **GUI 设计 token 体系**：全部 chrome 界面颜色收敛为语义 token，主题以 JSON 配置
  文件描述、运行期加载应用（VS Code 模式），组件禁止硬编码色值（见 §4.11）。
- 既有 E2E 门禁选择器迁移 + 新交互 E2E（见 §5）。

**不做（留给后续里程碑）**：

- 悬浮窗第二 BrowserWindow（归 S3；设置开关禁用占位）。
- all-time 统计与历史事件的主进程持久化与真实数据（契约本里程碑定稿，实现归 M5.c / S 线）。
- AI session 真实语义状态（归 S 线；本里程碑真实会话只有「运行中/已退出」兜底态）。
- 深色界面主题、五语言 i18n、vibrancy/acrylic、托盘、全局快捷键（归 M5.c）。
- 界面视觉打磨迭代（M5.c）；本里程碑标准是"与原型一致"，不是"比原型更好"。

---

## 2. 现状盘点（M4 基线对 M5.b 的支撑与阻碍）

| 现状 | 对 M5.b 的影响 |
|---|---|
| `electron/window.ts` 标准有边框窗口 | 需改 frameless；新增窗口控制 IPC（最小化/最大化/关闭/最大化状态查询） |
| `shared/ipc-contract.ts` 仅 pty/clipboard | 新增 window / dialog 契约；stats / history 契约（仅类型与 channel 名） |
| `src/App.tsx` = TabBar + 多 TerminalView（display:none 切换） | App Shell 整体重写；**TerminalView 挂载/切换机制原样保留**（M3 门禁的核心不变量） |
| `tabsStore`（Tab 元数据） | 拆为 `terminalsStore` + `sessionsStore`；`tabShortcuts` 语义随导航模型调整（§4.7） |
| `settingsStore` persist v2（themeId/fontFamily/fontSize/ligatures） | 加字段 + 拆 themeId，persist 迁移 v3 |
| `themes.ts`：terminal ITheme + chrome 变量绑在同一 ThemeId | terminal 16 色继续用；chrome 部分被原型的 Tailwind token 体系取代（§4.2） |
| Tailwind v4 已接入 renderer（`@tailwindcss/vite`） | 直接可用，原型样式零翻译成本 |
| `i18n.ts` 五语言四个 key（copy toast 等） | 保留不动；新增文案走集中 strings 模块（zh-CN） |
| `debugBridge` 按 tabId 注册表 + settings 调试入口 | 保留；补充 shell 级调试入口（导航/新建面板/mock provider 开关）供 E2E |
| E2E 门禁大量依赖 `tab-item`/`tab-new` testid | Tab 栏删除后必失效；断言保留、选择器迁移（§5） |
| 主进程 PTYManager / 背压 / 历史 | **零改动**；新建会话复用 `pty:spawn`（shell/args/cwd 已支持） |

---

## 3. 决策记录（2026-08-02 评审确认）

1. **E2E 门禁**：保留全部断言与不变量（独立 pty、切换不卸载 buffer、关闭语义、
   历史/背压组合回归），选择器迁移到侧栏对应元素。
2. **特效作用域**：TargetCursor 与 ClickSpark 仅在 chrome 区域（首页/设置/侧栏/弹层）
   生效，**终端视图内禁用**（不干扰 xterm 选区、I-beam 与 WebGL 渲染）。
3. **新建会话真实行为**：按配置（cwd/args/Windows|WSL runtime）真实 spawn pty 跑 CLI；
   侧栏出现真实条目，但语义状态只有「运行中 / 已退出」兜底；六态演示数据仅由
   dev/E2E 的 mock provider 注入。
4. **界面主题**：仅实现浅色；设置里深色选项禁用占位（原型如此），深色归 M5.c。
5. **悬浮窗**：不实现；设置开关禁用 + 提示「随 S3 落地」。
6. **标题栏**：Win/Linux 自绘右侧 最小化/最大化/关闭 三键，**不要左侧三个装饰灰点**
   （原型中的 macOS 样式灰点不落地）；macOS 用原生红绿灯（hiddenInset），隐藏右侧自绘键。
7. **字体**：Geist 移除——查证原型中无任何元素显式使用（仅 html 默认 `font-sans`），
   基础字体栈改为 PingFang 栈；Ammonite（logo）入库内嵌，构建期子集化（仅 v/i/b/n/g 五字形）。
8. **顶部 Tab 溢出**：全量显示，横向滚动 + 边缘渐隐（原型只演示了截断数量，此为补充定稿）。
9. **文案**：集中到 strings 模块，M5.b 仅 zh-CN 生效；设置页语言选择器可选但仅存偏好。
10. **侧栏条目关闭键**（原型未画，已确认补充）：Terminal/Session 条目 hover 时右侧
    出小 X，样式对齐原型 FloatWindow 关闭键规格。
11. **最后一个终端关闭后**：回到 Home，窗口保持打开（M3「关最后一个 Tab → 关窗口」
    语义废止），对应门禁断言同步更新。
12. **GUI 主题 token 化**：chrome 颜色全部走语义 token（CSS 变量 + Tailwind v4
    `@theme inline` 映射），主题 = JSON 配置文件，内置主题与用户主题（userData
    目录）同一 schema、运行期加载热切换；内置浅色主题的 token 值逐一取自原型色板，
    保证「一模一样」不受 token 化影响。深色主题、主题选择 UI 完善归 M5.c，但
    **机制（schema/加载器/映射）必须在 M5.b 一次到位**，避免返工。

---

## 4. 技术方案

### 4.1 无边框窗口与标题栏

- `BrowserWindow`：Win/Linux `frame: false`；macOS `titleBarStyle: 'hiddenInset'`
  （保留原生红绿灯）。Windows 11 圆角由系统提供，不自绘窗口圆角。
- 新 IPC 契约（`shared/ipc-contract.ts`）：

```ts
export const WindowInvokeChannel = {
  Minimize: 'window:minimize',
  ToggleMaximize: 'window:toggle-maximize',
  Close: 'window:close',
  IsMaximized: 'window:is-maximized'
} as const
// Main → Renderer：'window:maximized-changed'（boolean），驱动最大化/还原图标切换
```

- 标题栏组件 `src/app/TitleBar.tsx`：左侧「新建 / 设置」按钮（照原型 §App.tsx 599–625，
  去掉灰点），中部空白区 `-webkit-app-region: drag`，右侧窗口控制键
  （及所有可点元素）`no-drag`。macOS 下左侧按钮组右移让位红绿灯（`env(titlebar-area-*)`
  不可用时按 78px 固定偏移），右侧控制键不渲染。
- Electron drag 区域会吞掉全部 pointer event，renderer 的 `dblclick` 处理无效，故不挂
  双击监听。拖拽区双击是否最大化由原生窗口管理器决定；Windows 自带该语义，Linux
  依 WM 配置可能不同。跨 Linux WM 的一致双击行为需窗口层方案，归 M5.c；本阶段以
  右侧最大化/还原按钮作为确定性入口。
- `BrowserWindow.backgroundColor` 暂固定为 `#ffffff`，避免浅色主题首帧闪黑；深色主题
  的首帧底色需在主进程可读取界面主题偏好后设置，归 M5.c。

### 4.2 UI 基建迁移

**新增依赖**（dependencies）：`motion`、`gsap`（TargetCursor/CountUp 依赖）、
`lucide-react`、`@lobehub/icons`。原型的 `@base-ui/react`/`shadcn`/`cva`/`clsx`/
`tailwind-merge`/`tw-animate-css` **不引入**——正式 App 未使用其组件
（原型 `ui/button`、`ui/sheet` 无人引用），`index.css` 里的 shadcn token 层不迁移，
只迁移实际用到的 token。

**样式迁移**（`src/index.css`）：

- 保留：Maple Mono @font-face；M4 的 `--app-bg` 等 chrome 变量并入 §4.11 token
  体系后删除旧名。
- 删除：`.tab-bar/.tab-item*` 等 M3 Tab 栏样式。
- 从原型迁入：字体 token（`--font-ammonite/--font-pingfang/--font-maple`）、
  `.sidebar-scroll` 细滚动条、PingFang/Ammonite @font-face。
- **颜色不直接迁入**：原型中的 `neutral-*`、`black/8`、`#f7f7f6`、
  `--color-pending/error/flame` 等全部收敛为 §4.11 的语义 token，组件用 token
  工具类改写；内置浅色主题的 token 值 = 原型色值，渲染结果不变。
- 基础字体：`html` 默认字体栈 = PingFang 栈（决策 7，Geist 移除）。

**特效组件**：`prototype/src/components/` 的 ShinyText/TextType/CountUp/ClickSpark/
TargetCursor 原样拷贝到 `src/app/effects/`（jsx 转 tsx，逻辑与动效参数不动）。
作用域控制（决策 2）：

- `ClickSpark` 只包裹 chrome 布局容器，不包裹终端视图区。
- `TargetCursor` 挂载于 App Shell，terminal 页面激活时卸载（或 `pointer-events`
  区域排除 `.xterm` 容器——实现取更简单者，验收标准：终端区无自定义光标叠层）。
- `TrueFocus`/`FuzzyText` 原型未使用，不迁移。

### 4.3 App Shell 与三态导航

页面模型（renderer 内部状态，不入 persist）：

```ts
type PageId = 'home' | 'settings' | `terminal:${string}`
// 新建会话是覆盖层（bottom sheet），不是页面；打开时不改变底层 PageId
```

组件结构（`src/app/`）：

| 组件 | 来源 | 说明 |
|---|---|---|
| `AppShell.tsx` | 原型 App.tsx 骨架 | 三态分支渲染 + 页面路由 + 弹层编排 |
| `TitleBar.tsx` | 原型标题栏（§4.1 修订） | 全局恒定，三导航形态共用 |
| `Sidebar.tsx` | 原型 aside（652–772 行） | 展开态：logo/导航/Session 区/Terminal 区/底部收起键 |
| `IconRail.tsx` | 原型同名组件 | 收起态：图标 + 状态点，title 提示，底部展开键 |
| `TopTabBar.tsx` | 原型同名组件 | Home 常驻最左、新建常驻最右；溢出横向滚动 + 边缘渐隐（决策 8） |
| `HomePage.tsx` | 原型 Home 两种布局 | 空态欢迎页 ↔ 信息密度布局，条件同原型 `isFreshHome` |
| `SettingsPage.tsx` | 原型同名组件 | 本地 state 换成 settingsStore 绑定（§4.8） |
| `NewSessionSheet.tsx` + `TerminalPickerModal.tsx` + `CliConfigModal.tsx` | 原型三个弹层 | 动效参数照搬；确认动作接真实 spawn（§4.5） |
| `TerminalPage.tsx` | 新增 | 包装既有 `TerminalView`，见 §4.7 |

- 点击侧栏/图标条/顶部 Tab 的 session 或 terminal 条目 → `PageId = terminal:<id>`
  进入对应终端（替代 M3 Tab 栏的核心交互，SPEC 已定）。
- 注意力队列「查看」按钮 → 同上跳转。
- 原型左下角 `mock · 空状态` 开关不进正式 UI，改由调试桥暴露（§5）。
- 导航模式存 `settingsStore.navMode`；侧栏底部收起键 / 图标条展开键只在
  sidebar↔rail 间切换并写回 store（与设置页三段控件同源）。

### 4.4 状态层

**settingsStore persist v3**（迁移：v2 的 `themeId` 同值拆到两个新字段后删除）：

```ts
interface SettingsState {
  uiThemeId: string                    // 主题注册表 id，默认 'light'；M5.b 仅内置浅色，dark 选项禁用
  terminalThemeId: ThemeId             // 原 themeId，驱动 xterm ITheme（themes.ts 色值结构不变）
  fontFamily: string; fontSize: number; ligatures: boolean   // 沿用
  navMode: 'sidebar' | 'rail' | 'tabs' // 默认 'sidebar'
  floatEnabled: boolean                // M5.b 恒 false，开关禁用
  defaultTerminal: string              // 原型 localStorage 方案收编进 store
  language: AppLocale                  // 仅存偏好，M5.c 生效
}
```

**terminalsStore**（`tabsStore` 更名演进）：条目 `{ id, name, cwd, shellId, exited }`；
`addTab()` 改为 `addTerminal(opts: { shellId?, cwd? })`；关闭/激活/标题语义不变
（M3 不变量：每条目常驻独立 xterm/pty，隐藏时继续消费并 ack）。

**sessionsStore**（新增，SPEC §11.5 Session 形状）：

```ts
interface SessionEntry {           // §11.5 Session 的 M5.b 子集
  sessionId: string
  terminalId: string               // ↔ tabId，会话固定归属其终端（不迁移）
  adapterId: string                // 'codex' | 'claude-code' | ...（决定图标）
  name: string                     // 用户在 CLI 配置 modal 里起的名称
  status: SessionStatus            // 六态；真实会话 M5.b 仅 working/exited
  detail?: string; lastActivityAt: number
}
```

排序按 `lastActivityAt` 降序（侧栏/悬浮窗/顶部 Tab 共用约定）。
六态色板/文案 = 原型 `types.ts` 的 `statusDot/statusTone/statusLabel`，迁到
`src/app/sessionStatus.ts`；色值改引 status token 工具类（§4.11），文案出自
strings 模块。

**mock provider**（`src/app/mockSessions.ts`）：dev 或 E2E 标志开启时，向
`sessionsStore` 注入原型 App.tsx 里那 17 条六态数据（含时间字段换算），并周期性
更新 `lastActivityAt`/status 模拟活动；同时提供首页历史事件与 all-time 统计的
mock 数据源。**正式构建默认关闭**，真实会话条目与 mock 条目可共存（E2E 需要）。

**P1 实施结果（2026-08-02）**：persist schema 已升至 v3，保留 v0/v1 字体迁移并
覆盖 v2 `themeId` 拆分；`tabsStore` 已演进为 `terminalsStore`，既有终端常驻挂载行为
保持不变；新增 `sessionsStore`、六态 token/文案映射、17 条 dev/E2E mock 会话、首页
历史与 all-time mock 数据，并定稿 `stats:all-time` / `events:history` 共享契约。正式
构建不注入 mock。状态层与迁移共 7 条定向测试通过，另有 6 条直接受影响的终端回归
通过；按测试纪律未运行整套 E2E。

### 4.5 新建会话流（真实 spawn）

- **终端启动**：终端选项按平台探测可用性——Windows：cmd / Windows PowerShell /
  pwsh / Git Bash / WSL（探测 `where`/注册表/`wsl -l`）；macOS/Linux：`$SHELL`、
  zsh、bash、fish（探测 PATH）。不可用项不显示。选择后
  `pty.spawn({ shell, cwd })` → `terminalsStore.addTerminal` → 跳到该终端页。
  「下次默认以该方式启动」写 `settingsStore.defaultTerminal`。
- **CLI 会话**：配置 modal 收集 名称/工作区/启动参数/runtime。spawn 参数组装：
  - Windows runtime：`{ shell: <cli 可执行名>, args: <用户 args>, cwd: <工作区> }`；
  - WSL runtime：`{ shell: 'wsl.exe', args: ['-e', <cli>, ...args], cwd: <工作区> }`
    （cwd 为 Windows 路径时由 WSL 自动映射）。
  - CLI 可执行名映射：codex→`codex`、claude→`claude`、cursor→`cursor-agent`、
    gemini→`gemini`、opencode→`opencode`、aider→`aider`；默认参数照原型
    `cliOptions.defaultArgs`（用户可改）。
  - spawn 成功 → `terminalsStore` + `sessionsStore` 各建一条（session 固定归属该终端），
    status='working'，pty exit → status='exited'（detail=`已退出：exit code N`）。
    启动失败（可执行不存在）→ pty 立即退出，兜底同 exited 路径，终端里可见错误输出。
- **工作区选择**：新增 IPC `dialog:pick-directory`（主进程 `dialog.showOpenDialog`），
  默认值 = 上次使用的工作区（存 settingsStore 之外的普通 localStorage 即可），
  首次为用户主目录。原型里写死的 `C:\Users\Jesse\Desktop\demo` 是演示值，不落地。
- 会话/终端归属按启动方式固定：CLI 配置流出来的进 Session 区，终端流出来的进
  Terminal 区，不迁移（SPEC 已定）。

### 4.6 首页

- 布局照原型两态：`isFreshHome`（无会话且无终端）→ 居中欢迎页；否则信息密度布局。
- 问候语池、`TextType` 打字机、`CountUp`、quick launch 芯片、注意力队列
  （六态过滤 + 折叠 8 行 + 展开）全部照原型参数。
- 数据源：注意力队列/侧栏徽标 ← `sessionsStore`（真实 + mock）；
  历史事件、all-time 概览 ← mock 数据源（M5.b），同时在 `ipc-contract.ts` 定契约：

```ts
export const StatsInvokeChannel = {
  AllTime: 'stats:all-time',       // → { sessions, toolCalls, blocked, approvals }
  HistoryEvents: 'events:history'  // (opts: { limit, before? }) → HistoryEvent[]
} as const
// 实现（主进程持久化与真实事件流）归 M5.c / S 线；M5.b renderer 仍读 mock
```

### 4.7 终端视图整合与快捷键

- `TerminalPage` 包装既有 `TerminalView`：所有已创建终端**常驻挂载**，
  `PageId` 匹配时显示、否则 `display:none`——与 M3 完全相同的 keep-alive 机制，
  只是"是否可见"的判定从 activeTabId 变为当前 PageId。Home/设置页时全部隐藏。
- `debugBridge` 注册表按 terminalId 不变；补 `__vibingDebugShell`：
  `{ navigate(pageId), openNewSession(), setNavMode(mode), setMockSessions(on) }`。
- 快捷键语义调整（原型 TopTabBar 已标注 Ctrl+Shift+T = 新建会话）：
  - `Ctrl+Shift+T`：打开新建会话面板（原：直接新建终端）；
  - `Ctrl+Shift+W`：当前在终端页时关闭该终端；最后一个终端关闭后回 Home，
    窗口保持打开（决策 11）；
  - `Ctrl+Tab` / `Ctrl+Shift+Tab`：在已打开的终端页（session+terminal 合并按
    创建序）间循环。
  - `xterm attachCustomKeyEventHandler` 拦截逻辑沿用 M3。

### 4.8 设置页绑定

| 原型控件 | M5.b 绑定 |
|---|---|
| 界面主题（浅色/深色） | `uiThemeId`；深色禁用占位（决策 4）；用户主题目录发现的合法主题追加为选项（§4.11） |
| 界面语言 | `language` 仅存偏好；hint 已注明归 M5.c |
| 导航模式三段 | `navMode`，即时生效 |
| 悬浮窗开关 | 禁用 + hint「随 S3 落地」（决策 5） |
| 终端配色（16 色预览） | `terminalThemeId`，色板从 `themes.ts` 读取（替换原型 mock 色值），即时应用到所有 xterm 实例（M4 链路） |
| 字体（Maple Mono 展示行） | 只读展示（fontFamily 编辑入口维持调试桥，M5.c 再考虑 UI 化） |
| 字号 stepper | `fontSize`（10–24 边界照原型），即时生效触发 fit→resize 链路 |
| 连字开关 | `ligatures` |
| 默认终端 select | `defaultTerminal` |

### 4.9 字体子集化管线（SPEC 强制项）

- 工具：`subset-font`（npm，harfbuzz-wasm，免 Python 工具链）+ 构建脚本
  `scripts/subset-fonts.mjs`。
- 输入 → 输出：
  - PingFang SC：仓库完整六字重 woff2（`src/assets/fonts/pingfang/`）→ 按 strings
    模块 + 组件内字面量扫描出的实际用字生成子集 woff2；M5.b 实际使用字重预计
    Regular/Medium/Semibold 三档，未用字重不进产物。
  - Ammonite：`Ammonite-2.otf` 入库 `src/assets/fonts/ammonite/`（NOTICE 照 PingFang
    模式补授权说明）→ 子集仅 `vibing` 五字形，输出 woff2。
  - Maple Mono：终端字体需覆盖任意输出，**不子集化**，维持现状四文件。
- 接入方式：`npm run build` 前置 `subset-fonts` 步骤，产物写
  `src/assets/fonts/.subset/`（gitignore），@font-face 在构建时经 vite alias 指向
  子集目录；dev 直接用完整字体（免每次扫描）。产物体积断言：子集后中文字体总量
  < 1 MB（完整字库约 30 MB，**禁止全量打包**）。

### 4.10 文案组织

- `src/app/strings.ts`：M5.b 全部新增界面文案（zh-CN）集中于此，key 按页面分组；
  组件禁止内联中文字面量（子集化扫描与 M5.c i18n 迁移都依赖这一点）。
- 既有 `i18n.ts`（copy toast 等四 key）不动，既有 i18n E2E 门禁不受影响。

### 4.11 GUI 设计 token 与主题配置文件（决策 12）

**目标**：chrome 界面所有颜色经语义 token 间接引用；主题是描述 token 值的 JSON
配置文件，运行期加载、热切换——为 M5.c 深色及后续任意主题铺路，组件层零改动换肤。

**主题文件 schema**（`shared/theme-schema.ts` 定类型 + 校验）：

```jsonc
// 内置：src/themes/light.json；用户：<userData>/themes/*.json
{
  "id": "light",
  "name": "Vibing Light",
  "type": "light",                    // light | dark，供派生默认值与对比度判断
  "colors": {
    // —— 背景层级 ——
    "bg.app": "#ffffff",              // 窗体/侧栏底
    "bg.content": "#f7f7f6",          // 主内容区
    "bg.surface": "#ffffff",          // 卡片/弹层
    "bg.surface.hover": "#fafafa",    // = 原型 neutral-50
    "bg.control": "…", "bg.control.active": "…",   // segmented/芯片底
    "bg.backdrop": "rgb(0 0 0 / 25%)",
    // —— 文本层级 ——
    "text.primary": "…", "text.secondary": "…", "text.muted": "…",
    "text.faint": "…", "text.inverse": "…",
    // —— 边框/分隔 ——
    "border.default": "rgb(0 0 0 / 8%)", "border.subtle": "rgb(0 0 0 / 5%)",
    // —— 品牌/强调 ——
    "accent.flame": "#ff4500", "brand.logo": "#7a7a7a", "brand.logoShine": "#1a1a1a",
    // —— 会话六态（决定 statusDot/statusTone 渲染） ——
    "status.working": "…", "status.needsYou": "…", "status.needsYou.dot": "…",
    "status.done": "…", "status.error": "…", "status.idle": "…", "status.exited": "…",
    // —— 组件专项 ——
    "titlebar.fg": "…", "scrollbar.thumb": "…", "shadow.window": "…",
    "button.primary.bg": "…", "button.primary.fg": "…"
  },
  "terminal": null                    // 预留：终端 16 色段；M5.b 终端配色仍走 themes.ts
}
```

- token 清单以**原型实际用到的颜色角色**为准穷举（迁移每个组件时把出现的原始色值
  归入既有 token 或新增 token，禁止漏网），预计 40–60 个；上表为示意非全集。
- 缺省回退：用户主题缺失的 key 回退到同 `type` 的内置主题值（VS Code 同款行为），
  校验失败（非法色值/未知 id 冲突）该文件整体拒载并在设置页提示。

**运行期接线**：

- Tailwind v4 `@theme inline` 把工具类映射到 CSS 变量：
  `--color-surface: var(--vib-bg-surface)` → 组件写 `bg-surface`、`text-muted`、
  `border-border-subtle` 等语义工具类，**不写 `neutral-*`/字面色值**（Code review
  检查项 + oxlint/grep 脚本兜底）。
- `src/app/themeRuntime.ts`：`applyUiTheme(theme)` 将 `colors.*` 写入
  `document.documentElement` 的 `--vib-*` 变量（key 的 `.` 转 `-`），替代 M4
  `applyChromeTheme`；切换无需重载。
- 主题注册表：内置 JSON 打包进 renderer；用户主题经新 IPC
  `theme:list-user`（主进程枚举并读取 `<userData>/themes/*.json`，返回原文由
  renderer 校验）在启动与设置页打开时刷新。单文件上限 256 KB，超限返回明确的
  尺寸拒载错误，不进入 JSON 解析；内置主题校验失败时记录错误并启用安全浅色回退，
  不阻断 renderer 启动。热重载（watch 文件变更）不做，归 M5.c。
- `statusDot/statusTone/statusLabel`（§4.4）改为引用 status token 工具类，
  色值随主题走；label 文案仍出自 strings 模块。
- 终端 16 色暂不并入（SPEC 已定 `themes.ts` 色值结构不变）；schema 预留
  `terminal` 段，M5.c 评估统一。

---

## 5. E2E 与门禁

**迁移原则（决策 1）**：断言与不变量全保留，选择器迁移；测试意图不变的改动尽量
只动 helpers。

| 旧入口 | 新入口 |
|---|---|
| `tab-new` 点击新建终端 | `Ctrl+Shift+T` 或标题栏「新建」→ sheet 内「终端」条目（helper 封装 `openDefaultTerminal(page)`） |
| `tab-item` 列表/点击切换 | 侧栏 Terminal 区条目 `data-testid="sidebar-terminal-item"`（顶部 Tab 模式另有 `toptab-item`，门禁默认跑 sidebar 模式） |
| `tab-item` 标题断言（OSC 标题） | 同一 testid 的文本断言 |
| 关闭按钮/关闭语义 | 侧栏条目 hover 关闭键 `data-testid="sidebar-terminal-close"`（决策 10）；最后一个终端关闭后回 Home 不关窗口（决策 11），对应断言更新 |

**新增 E2E**：

- `shell-nav.spec.ts`：三态导航切换、侧栏收起/展开、顶部 Tab 溢出滚动、
  Home/设置/终端页路由、终端页切换后 buffer 不丢（复用 M3 断言模式）。
- `new-session.spec.ts`：sheet → 终端选择 → 真实 spawn（以 `cmd /c echo` 类
  快速命令替代真 CLI）→ 侧栏条目出现 → exit → exited 态展示；CLI 配置 modal
  表单与 WSL 参数组装（组装函数单测 + UI 冒烟）。
- `settings.spec.ts`：各控件读写 settingsStore、terminalThemeId 即时应用
  （复用 M4 `terminalAppearance()` 调试断言）、navMode 持久化重启生效。
- `home-empty.spec.ts`：mock off + 无终端 → 欢迎页；开终端 → 信息密度布局。
- 既有 `terminal-stress / resize / render / clipboard / pty-*` 门禁在新 Shell 下
  全量回归（terminal 挂载机制未变，预期仅 helpers 改动）。

---

## 6. 任务分解

| 阶段 | 内容 | 验收 |
|---|---|---|
| P0 基建（**已完成**） | frameless + TitleBar + 窗口控制 IPC；依赖引入；**token 体系 + 主题 schema/加载器/运行期接线（§4.11）**；字体迁移；特效组件迁移 | 窗口可拖动/最大化/关闭；内置 light.json 驱动全部 chrome 颜色；typecheck 过 |
| P1 状态层（**已完成**） | settingsStore v3 迁移；terminalsStore/sessionsStore；mock provider；strings.ts | store 单测 + 迁移用例（v0/v1/v2→v3）通过 |
| P2 Shell | AppShell/Sidebar/IconRail/TopTabBar/页面路由；TerminalPage 整合；快捷键 | 三态导航可用；既有终端门禁回归绿 |
| P3 流程页 | 新建会话流（真实 spawn + dialog IPC）；HomePage 两态；SettingsPage 绑定 | new-session/home-empty/settings E2E 绿 |
| P4 字体管线 | subset-fonts 脚本 + 构建接入 + NOTICE | 构建产物中文字体 < 1 MB 断言 |
| P5 收尾 | E2E 选择器迁移全量回归；与原型逐页视觉比对（截图并排） | 全部 E2E 绿；视觉比对无差异项 |

视觉比对基准：原型跑 `prototype && vite dev`，与实现并排截屏逐页核对
（Home 有/无会话、设置、三态导航、三个弹层、六态徽标色板）。

---

## 7. 风险与对策

| 风险 | 对策 |
|---|---|
| frameless 拖拽区与可点元素冲突（drag region 吃掉点击） | 所有交互元素显式 `no-drag`；E2E 冒烟点一遍标题栏按钮 |
| Linux WM 不提供拖拽区双击最大化 | P0 保留显式最大化按钮；跨 WM 一致的窗口层双击方案归 M5.c |
| 深色主题启动首帧仍为白底 | 当前仅启用浅色 GUI 主题；主进程读取主题偏好并设置窗口底色归 M5.c |
| TargetCursor（gsap 全局 mousemove）与 xterm WebGL 同屏性能 | 决策 2 已隔离终端区；chrome 区若仍掉帧，降级为仅 Home/设置启用 |
| `@lobehub/icons` 包体大 | 按名导入 + vite tree-shaking；构建后检查 renderer chunk，必要时改 deep import |
| WSL runtime 参数组装边界（路径映射/无发行版） | 组装函数纯函数化 + 单测；`wsl -l` 探测失败则隐藏 WSL 选项 |
| persist v3 迁移丢设置 | 迁移单测覆盖 v0/v1/v2 各版本输入 |
| 子集化漏字形（动态文案/数字/CLI 名） | 扫描范围 = strings.ts + 常用 ASCII 全集 + 数字/标点白名单；E2E 截图比对兜底 |
| token 化引入视觉偏差，破坏「一模一样」 | light.json 色值逐一取自原型；P5 逐页截图比对是硬门禁 |
| 组件里漏网的硬编码色值绕过主题 | grep/oxlint 脚本禁 `neutral-*` 与十六进制字面量进 `src/app/**`（特效组件的动画常量白名单除外） |

---

## 8. SPEC 回写清单（本计划评审通过后执行）

- §9 进度注记：M5.b 启动；记录决策 6（标题栏无左侧灰点）、决策 7（Geist 移除、
  Ammonite 入库）、决策 8（顶部 Tab 溢出滚动）、决策 12（GUI token 化 + JSON
  主题配置文件）、快捷键语义调整（§4.7）。
- §3 IPC 契约章节：补 window / dialog / theme / stats / history channel。
- §8 技术选型：补「GUI 主题」行——语义 token + JSON 主题文件（VS Code 模式），
  界面与终端配色分治。
- §6 多 Tab 状态模型：注明 tabsStore → terminalsStore + sessionsStore 演进。
- 字体行（§8 技术选型）：补 Ammonite，删除 Geist 相关（SPEC 未提过 Geist，无需动）。
