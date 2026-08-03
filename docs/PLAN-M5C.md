# M5.c 实施计划 —— App Shell 数据与打磨

> 状态：**已完成**。P0–P4 全部落地（2026-08-03）；决策 1–6 与拟定项 7–11 按本计划执行，
> 决策 7（首装语言跟随系统）、8（greetings 保持英文）、10（演示数据退役）、11（托盘三项）
> 照办；决策 9（Linux 拖拽区双击最大化降范围）维持 M5.b 现状。SPEC 回写见 §8 已执行。
> 目标：完成 App Shell 里程碑线的收尾——真实数据接入（stats / history 持久化管道）、
> 五语言 i18n、系统集成（托盘、全局快捷键、关闭到托盘）、遗留打磨项
> （深色首帧底色、主题热重载、fontFamily 设置 UI 化）、全量回归。
> 对应 [SPEC.md](./SPEC.md) §9 里程碑 M5.c。前置：M5.b 已完成（含完成后补充的
> 深色主题 / 自绘下拉 / 圆角开关 / 环境渐变等视觉打磨轮，commit `35cc4d6`）。
>
> **AI session 真实语义状态不在本里程碑**（归 S 线）：M5.c 只搭好事件持久化管道并
> 记录现阶段唯一可靠的真实事件（会话启动 / 退出）；tool_call、批准等语义事件由
> S2 起沿同一管道写入，renderer 与存储层零改动。

---

## 1. 范围界定

**做**：

- **托盘 + 关闭到托盘**：三端常驻托盘（macOS 为菜单栏状态项）；标题栏关闭键改为
  隐藏窗口，仅托盘「退出」真正退出（决策 2）。
- **全局快捷键**：`Ctrl+Alt+V` 系统级唤起 / 隐藏窗口；固定键位 + 设置开关（决策 3）。
- **stats / history 真实数据**：主进程事件持久化（`<userData>` JSONL + 聚合计数），
  实现 M5.b 定稿的 `stats:all-time` / `events:history` 契约，新增 `events:record`
  写入口；记录会话启动 / 退出两类真实事件；生产构建 Home 切换到真实数据（决策 4）。
- **i18n 五语言**：strings 模块按 locale 拆分（zh-CN / zh-TW / en / ja / ko），
  设置页语言选择即时生效（热切换）；既有 `i18n.ts`（copy toast 四 key）并入统一模块。
- **深色首帧底色**：主进程持久化界面主题的 `bg.app` 色值，建窗前设置
  `BrowserWindow.backgroundColor`，消除深色主题启动白闪（M5.b §4.1 遗留）。
- **主题文件热重载**：watch `<userData>/themes/`，变更后 renderer 自动重载主题注册表
  （M5.b §4.11 遗留）。
- **fontFamily 设置 UI 化**：设置页字体行改为可编辑输入 + 恢复默认（决策 6）。
- **字体子集化扩展**：扫描范围覆盖五语言文案。
- **全量回归**：整套 E2E 一次 + 失败项定向复跑；五语言 × 明暗主题逐页视觉核对。

**不做（明确出局或归后续）**：

- **vibrancy / acrylic / mica 系统窗口材质**：不做（决策 1）。质感目标已由
  屏幕锚定环境渐变（SidebarTint）+ 深浅双主题满足；SPEC §9 M5.c 行随回写修订。
- 终端 16 色并入主题 JSON：继续分离，schema `terminal` 段保持预留（决策 5）。
- 悬浮窗（S3）、AI 语义事件真实来源（S2）、通知系统（S4）、CLI 适配器（M6）。
- 全局快捷键自定义键位录制 UI（只做固定键位 + 开关）。
- Linux 拖拽区双击最大化（决策 9 降范围：显式最大化按钮为唯一确定性入口）。

---

## 2. 现状盘点（M5.b 完成基线对 M5.c 的支撑）

| 现状 | 对 M5.c 的影响 |
|---|---|
| `stats:all-time` / `events:history` 契约已定稿（`AllTimeStats` / `HistoryEvent` / `HistoryQuery`），主进程无 handler | 补主进程实现 + `events:record` 写入口；`HistoryEventKind` 需扩两类生命周期事件 |
| Home 历史 / 概览曾读取演示数据 | 全部环境统一改走 IPC 真实数据，空库显示零统计与空历史 |
| `strings.ts` 单份 zh-CN const，全组件直接 `import { strings }`；`sessionsStore.markExited` 等非 React 消费者也直接引用 | 拆 locale 字典 + `useStrings()`（组件）/ `getStrings()`（store 等非 React 场景）双入口，全量机械替换 |
| `i18n.ts` 五语言四 key（copy toast），`resolveLocale/detectLocale` 可复用 | 文案并入统一模块；locale 探测函数保留，用于首装默认语言（决策 7） |
| `settingsStore` persist v4；`language` 字段已存偏好但未生效 | v5 迁移：新增 `globalShortcutEnabled`；`language` 开始驱动 UI |
| `electron/main.ts` 无托盘/快捷键；`window-all-closed` 即退出 | 新增 `tray.ts` / `shortcuts.ts`；退出流程改为显式 quitting 标志驱动 |
| `window:close` IPC = `win.close()` | 语义改为隐藏到托盘；`before-quit` 仍 `killAll()` |
| `BrowserWindow.backgroundColor` 写死 `#ffffff` | 从主进程偏好文件读取上次主题的 `bg.app` |
| 主题注册表启动 + 打开设置页时刷新，无 watch | 加 `fs.watch` + 变更事件推送 |
| `scripts/subset-fonts.mjs` 扫描 strings + 组件字面量 + ASCII 全集 | 扫描源改为 `src/app/i18n/*.ts` + 组件 |
| E2E `helpers.ts` 直接用默认 userData，未隔离 | 新增 env 覆盖（`VIBING_USER_DATA_DIR`，主进程 ready 前 `app.setPath`），E2E 每次 launch 建临时目录——stats 从 0 计数、主题热重载写入、重启持久化断言都依赖它 |
| 设置页字体行只读展示 | 改可编辑（走既有 `setFont` → fit → resize 链路，无新机制） |

---

## 3. 决策记录

**已拍板（2026-08-03 评审确认）**：

1. **窗口材质不做**：Windows mica/acrylic 与 macOS vibrancy 均不实现。质感方案
   以已落地的环境渐变 + 双主题为准，不重做。SPEC §9 M5.c 行「含 vibrancy/acrylic」
   随回写清单修订。
2. **关闭到托盘（固定行为，无设置项）**：标题栏 X = 隐藏窗口，PTY / 会话全部保活；
   托盘菜单「退出」才真正退出。macOS 同语义（关闭隐藏窗口，Dock + 菜单栏状态项常驻，
   `activate` 重新显示）。
3. **全局快捷键 `Ctrl+Alt+V`**：切换窗口显示/隐藏（quake 风格：可见且聚焦 → 隐藏，
   否则显示并聚焦）。固定键位 + 设置开关（默认开），不做键位录制 UI。
4. **真实数据边界**：M5.c 落地主进程持久化管道；真实事件仅 `session_start` /
   `session_exit` 两类；生产 Home 切真实数据（早期数值小属预期），语义事件由 S 线
   沿同一 `events:record` 管道补，renderer 与存储层届时零改动。
5. **终端 16 色继续与界面主题分离**：theme JSON `terminal` 段保持预留不实现。
6. **fontFamily UI 化**：设置页字体行改为文本输入 + 恢复默认按钮。

**拟定（评审本计划时确认）**：

7. **首装语言跟随系统**：`defaultSettings.language` 改为 `detectLocale()` 结果
   （复用既有 `resolveLocale`，未支持语言回退 en）；已有用户保留其持久化偏好，
   迁移不动。
8. **Home greetings 保持英文**：问候语池是原型设计元素（配 Maple 字体的英文短句），
   五语言下不翻译。
9. **Linux 拖拽区双击最大化降范围**：Electron drag 区域吞 pointer event 的限制不变，
   窗口层 hack（手动拖拽实现）代价与风险不成比例；显式最大化按钮为唯一确定性入口，
   Windows 双击由系统语义提供。
10. **演示数据退役**：删除 17 条假会话、8 条假历史、假统计以及运行时注入和调试开关；
    dev/E2E 与正式构建使用同一真实数据路径。
11. **托盘菜单固定三项**：显示/隐藏、新建会话、退出；左键单击托盘图标 = 切换显示
    （Windows/Linux），macOS 点击弹菜单。图标用品牌 v 字形单色 PNG
    （macOS 用 template image 适配深浅菜单栏）。

---

## 4. 技术方案

### 4.1 托盘与关闭语义

- `electron/tray.ts`：`createTray(win, callbacks)`。菜单三项（决策 11），文案由主进程
  内嵌五语言小字典（托盘菜单是原生 UI，取不到 renderer strings；key 仅 4 个，
  语言随主进程偏好文件同步，见 §4.2）。
- 图标资产：`resources/tray/` 提交由 Ammonite 字体生成的黑/白 16/32px v 字形；
  Windows/Linux 随系统深浅色选色，macOS `vibingTemplate.png` 走 template image。electron-builder `extraResources` 归 M7，
  当前 dev/打包均从 `resources/` 读。
- 关闭语义改造（`electron/window.ts` + `main.ts`）：
  - 模块级 `isQuitting` 标志；`win.on('close')` 中若未 quitting → `preventDefault()`
    + `win.hide()`。
  - 托盘「退出」与 `app.before-quit` 置位 quitting；`before-quit` 仍 `killAll()`。
  - `window:close` IPC handler 不改（仍 `win.close()`），拦截统一发生在 `close` 事件，
    保证 Alt+F4 / 系统菜单关闭走同一条路。
  - `window-all-closed` 退出逻辑仅在 quitting 时到达（hide 不触发 close 完成），
    行为保持向后一致。
- 托盘「新建会话」：显示窗口 + 新增 Main → Renderer 事件
  `AppEventChannel.OpenNewSession = 'app:open-new-session'`，renderer 订阅后调用
  既有 `openNewSession()`（与 `Ctrl+Shift+T` 同路径）。

### 4.2 全局快捷键与主进程偏好文件

- `electron/shortcuts.ts`：`globalShortcut.register('Control+Alt+V', toggle)`；
  toggle 语义 = 窗口可见且聚焦 → `hide()`，否则 `show()+focus()`（最小化态先
  `restore()`）。注册失败（被其他应用占用）只 `console.warn`，不弹窗。
- **主进程偏好文件** `<userData>/main-prefs.json`（新增，主进程唯一读写方）：

```jsonc
{
  "backgroundColor": "#1f1f1f",     // 活动界面主题的 bg.app，建窗首帧用
  "globalShortcutEnabled": true,
  "language": "zh-CN"               // 托盘菜单文案用
}
```

- 新 IPC `AppInvokeChannel.SetMainPrefs = 'app:set-main-prefs'`
  （payload 为上述字段的 partial）：renderer 在界面主题应用时上报 `bg.app`、
  设置变更时上报开关与语言；主进程原子写文件并即时生效
  （注销/重注册快捷键、重建托盘菜单文案）。
- `settingsStore` persist **v5**：新增 `globalShortcutEnabled: boolean`（默认 `true`）；
  迁移用例补 v4 → v5。设置页「布局」区加开关，hint 注明键位 `Ctrl+Alt+V`。

### 4.3 深色首帧底色

- `createWindow()` 启动时读 `main-prefs.json` 的 `backgroundColor`
  （缺失 / 非法色值回退 `#ffffff`）设为 `BrowserWindow.backgroundColor`。
- renderer 侧在 `applyUiTheme` 后调 `SetMainPrefs({ backgroundColor: colors['bg.app'] })`；
  主进程校验为合法 hex/rgb 字面量才落盘（首帧底色进主进程，做边界校验）。

### 4.4 统计与历史持久化（真实数据接入）

**存储**（`electron/events/EventLog.ts`，无原生依赖）：

- `<userData>/events/events.jsonl`：逐行 append `HistoryEvent`；启动时加载 +
  超过 5,000 条时压缩重写（保留最新 5,000）。查询在内存索引上做
  （`limit` + `before` 游标，按 `occurredAt` 降序），量级下无性能问题。
- `<userData>/events/stats.json`：单调聚合计数 `{sessions, toolCalls, blocked,
  approvals}`，事件写入时同步累加——**计数独立于日志截断**，all-time 语义不受
  5,000 条上限影响。sessions 由 `session_start` 累加；toolCalls/blocked/approvals
  的累加规则随事件写入方（S 线）定义，M5.c 保持 0。
- 写入失败（磁盘/权限）：记录错误并降级为内存态，不阻断会话流程。

**契约扩展**（`shared/ipc-contract.ts`）：

```ts
export type HistoryEventKind =
  | 'tool_call' | 'completed' | 'approved' | 'message'
  | 'session_start' | 'session_exit'          // M5.c 新增：生命周期事件

export const StatsInvokeChannel = {
  AllTime: 'stats:all-time',                   // 实现：读 stats.json
  HistoryEvents: 'events:history',             // 实现：查询 events.jsonl
  RecordEvent: 'events:record'                 // 新增：写入口（M5.c renderer 上报；S 线主进程 SemanticTap 直写同一 EventLog，不经 IPC）
} as const
```

- `events:record` 主进程校验 payload 形状（kind 白名单、字符串字段长度上限），
  id / occurredAt 由主进程生成，防 renderer 伪造时间线。
- preload 暴露 `statsApi = { allTime, historyEvents, recordEvent }`。

**Renderer 接线**：

- 新建 CLI 会话 spawn 成功 → `recordEvent({ kind: 'session_start', adapterId,
  title: 会话名, detail: 工作区 })`；pty exit → `session_exit`（detail 带 exit code）。
  纯终端（非 CLI 会话）不记录——历史流语义是 AI 会话事件，与 [SPEC-S](./SPEC-S.md) §5 对齐。
- Home 的历史 / 概览统一走 IPC 真实数据。历史列表新 kind 的图标 / 标签映射补进
  `HomePage` 渲染表（五语言文案）。

### 4.5 i18n 五语言

**模块结构**：

- `src/app/i18n/` 新目录：`zh-CN.ts`（现 strings.ts 内容，去掉 mock 段）、
  `zh-TW.ts`、`en.ts`、`ja.ts`、`ko.ts`。类型 `AppStrings = typeof zhCN`，
  其余 locale `satisfies AppStrings` 保证 key 完整性（含函数型条目：
  `minutesAgo` / `showAll` / `exitedDetail` 等逐语言实现，语序差异由函数体内消化）。
- 入口 `src/app/i18n/index.ts`：`getStrings(locale)` + `useStrings()`
  （zustand hook 订阅 `settingsStore.language`，语言切换即触发订阅组件重渲染，
  无需刷新）。旧 `src/app/strings.ts` 删除，`appLocales` / `AppLocale` 迁到入口。
- 消费方替换：组件改 `useStrings()`；`sessionsStore.markExited`、`shellShortcuts`
  等非 React 消费者改 `getStrings(useSettingsStore.getState().language)`。
  机械替换约 15 个文件，typecheck 兜底。
- 既有 `src/i18n.ts`：四条 copy toast 文案并入各 locale 字典（`terminal.copied` 等
  新分组）；`resolveLocale` / `detectLocale` 迁到 `i18n/locale.ts` 保留，
  服务于首装默认语言（决策 7）。既有 i18n E2E 门禁断言不变、选择器不变，
  仅 helper 里的取文案路径调整。
- 删除演示数据与其专用文案（决策 10）。
- 设置页语言下拉：去掉「归 M5.c」hint，选择即时生效；`common.disabledUntilM5c`
  等失效占位文案清理。
- 语言变更同时上报 `SetMainPrefs({ language })` 驱动托盘菜单文案（§4.1）。

**翻译产出**：zh-TW / en / ja / ko 由实现时一次性给出，评审走 code review；
术语基线：Session / Terminal / quick launch 等原型英文微标签在各语言下保持英文
（原型设计元素，同决策 8 的 greetings 处理一致）。

### 4.6 字体子集化扩展

- `scripts/subset-fonts.mjs` 扫描源改为 `src/app/i18n/*.ts` + 组件字面量 + ASCII
  全集；五语言 UI 文案加入后子集仍远小于 1 MB 门禁（维持断言不放宽）。
- **字形覆盖边界**：PingFang SC 无谚文（Hangul），ko 界面中文字体命中不到的字形
  回退系统栈（Windows Malgun Gothic / macOS Apple SD Gothic Neo）；ja 假名若
  PingFang 子集缺失同样回退。`--font-pingfang` 栈补 ja/ko 平台回退字体，
  验收时逐语言截图检查无豆腐块。

### 4.7 主题热重载

- 主进程 `fs.watch(<userData>/themes)`（300ms debounce，目录不存在时先建），
  变更推 `ThemeEventChannel.UserThemesChanged = 'theme:user-themes-changed'`
  （无 payload，renderer 收到后重新 `loadUiThemeRegistry()`）。
- renderer：重载后若当前 `uiThemeId` 主题仍存在 → 重新 `applyUiTheme`（色值热更）；
  被删除 → 回退内置 light 并在设置页错误区提示。设置页打开时的既有刷新逻辑保留。

### 4.8 设置页增补

| 控件 | 绑定 |
|---|---|
| 字体（原只读展示行） | 文本输入 + 「恢复默认」按钮 → `setFont(family, fontSize)`，走既有即时生效链路；空值提交回落默认栈 |
| 全局快捷键开关（布局区新增） | `globalShortcutEnabled`（v5），变更即上报 SetMainPrefs 生效 |
| 界面语言 | `language` 即时热切换（§4.5） |

---

## 5. E2E 与门禁

**既有门禁**：终端链路（stress / resize / render / clipboard / tabs）零改动预期；
shell-nav / settings / home-empty / new-session 因 strings 模块重构只动 helper 取文案
路径，断言不变。i18n.spec.ts 的 copy toast 断言随文案并入调整 import，语义不变。

**新增 / 扩展**：

- **userData 隔离（新增前置）**：主进程在 app ready 前识别
  `VIBING_USER_DATA_DIR` 环境变量（仅 dev/E2E 生效）并 `app.setPath('userData', …)`；
  helpers 每次 launch 创建临时目录并注入。现状 E2E 直接共享默认 userData，
  持久化类断言无法从干净状态出发。
- `events-log.spec.ts`：spawn 快速退出的 CLI 会话（复用 new-session 的
  `cmd /c echo` 模式）→ `events:history` 出现 `session_start` / `session_exit` →
  `stats:all-time.sessions` 递增；重复查询验证 `before` 游标分页；独立 userData
  保证计数从 0 起。
- `settings.spec.ts` 扩展：语言切换后断言侧栏 / 设置页关键文案变为目标语言并
  即时生效；fontFamily 输入 → `terminalAppearance()` 调试断言字体已应用；
  快捷键开关写回 store。
- `window-shell.spec.ts` 扩展：点标题栏 X → 窗口 `isVisible() === false` 且未销毁、
  PTY 存活（再 show 后 buffer 完整）；通过 `electronApp.evaluate` 断言
  `globalShortcut.isRegistered('Control+Alt+V')` 随开关注册 / 注销、触发 toggle
  回调后可见性翻转（Playwright 无法注入系统级按键，托盘菜单同理走 evaluate 调用
  菜单项 click 回调）。
- 主题热重载：evaluate 向临时 userData 写主题 JSON → 断言注册表出现新主题、
  修改色值后活动主题 CSS 变量热更。
- 持久化重启验证（首帧底色 / stats 跨启动累计）：同一 userData 二次
  `electron.launch` 断言。
- **收尾全量回归**：整套 E2E 执行一次；失败 / 中断项按测试纪律单用例定向复跑，
  不重复跑整套。五语言 × 明暗主题的设置页 / Home 截图逐一目检。

---

## 6. 任务分解

| 阶段 | 内容 | 验收 |
|---|---|---|
| P0 系统集成 | tray.ts / shortcuts.ts / 关闭到托盘 / main-prefs.json / 深色首帧 / `app:*` 契约与 preload / E2E userData 隔离（`VIBING_USER_DATA_DIR`） | X 隐藏不退出、托盘三项可用、`Ctrl+Alt+V` 切换、深色主题重启无白闪、E2E 从干净 userData 启动 |
| P1 数据层 | EventLog + stats.json / `events:record` 与查询 handler / renderer 生命周期上报 + Home 真实数据切换 | events-log.spec 绿；所有环境的 Home 显示真实（含空态）数据 |
| P2 i18n | i18n 目录五语言字典 / useStrings 全量替换 / i18n.ts 合并 / 语言热切换 + 托盘文案联动 / 子集化扩展 | typecheck 过；语言切换即时生效；五语言截图无豆腐块；字体门禁 < 1 MB 不放宽 |
| P3 设置与主题收尾 | fontFamily 编辑 UI / 快捷键开关（v5 迁移）/ 主题热重载 | settings.spec 扩展项绿；v4→v5 迁移用例过；watch 热更断言过 |
| P4 全量回归 | 整套 E2E 一次 + 定向复跑 / 五语言 × 明暗视觉核对 / SPEC 回写 | 全部用例取得通过结果；SPEC §9 M5.c 标记完成 |

---

## 7. 风险与对策

| 风险 | 对策 |
|---|---|
| 关闭到托盘改变既有「关窗即退出」语义，用户丢失退出入口 | 托盘常驻 + 菜单「退出」；E2E 断言 hide 不杀 PTY、quit 路径 killAll 仍触发 |
| `Ctrl+Alt+V` 被其他应用占用注册失败 | 注册结果写日志；设置开关重开时重试；不做弹窗打扰 |
| strings → useStrings 大范围机械替换引入漏改 | typecheck（删除旧导出后漏改必报错）+ 全量回归 |
| 函数型文案条目逐语言实现出错（复数 / 语序） | locale 字典 `satisfies AppStrings` 保 key 完整；E2E 语言切换断言覆盖代表性条目 |
| PingFang 缺谚文/假名字形导致 ko/ja 豆腐块 | 回退栈补平台字体；逐语言截图验收（§4.6） |
| events.jsonl 损坏（断电截断） | 逐行解析跳过坏行；stats.json 写入用临时文件 + rename 原子替换 |
| 主进程偏好文件被手工改坏 | 读取时逐字段校验，非法即回默认值，不崩溃 |
| 托盘菜单文案与 renderer 语言不同步 | 语言变更即上报 SetMainPrefs；启动时以偏好文件为准 |
| E2E 无法注入系统级快捷键 / 点击托盘 | 统一走 `electronApp.evaluate` 调用注册的回调，断言行为而非输入路径 |

---

## 8. SPEC 回写清单（本计划评审通过后执行）

- §9 M5.c 行修订：删除「vibrancy/acrylic」（决策 1，质感由环境渐变 + 双主题承担，
  已随 M5.b 补充落地）；补关闭到托盘、`Ctrl+Alt+V`、真实数据边界
  （生命周期事件 + S 线共用管道）。
- §3 IPC 表：`stats:all-time` / `events:history` 状态改「M5.c 实现」；新增
  `events:record`、`app:set-main-prefs`（Renderer → Main）与
  `app:open-new-session`、`theme:user-themes-changed`（Main → Renderer）。
- §2.1 主进程职责：托盘、全局快捷键从「(native)」占位变为已实现描述；
  关闭到托盘语义入档。
- §5.2 字体注记：界面字体子集化扫描扩展到五语言；ja/ko 回退栈补充。
- [SPEC-S](./SPEC-S.md) §5/§6 注记：`HistoryEventKind` 扩 `session_start` / `session_exit`；
  事件持久化管道（EventLog）为 S 线语义事件的写入目标。
- §9 进度注记：记录决策 1–11。
