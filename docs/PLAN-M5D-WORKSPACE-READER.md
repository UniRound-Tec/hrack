# M5.d 工作区只读代码阅读器实施计划

> 状态：**生产实现完成；Windows/WSL 自动化通过，macOS/Linux 发版 smoke 待办**
> 设计确认：2026-08-04
> 依赖：M5.b App Shell、S0 精确工作区启动、M2 resize/ConPTY 保护
> 原型决策：采用 `WorkspaceReaderPrototype` 的 **A「并排工作台」**；B/C 淘汰
> 目标：AI CLI Session 选择工作目录后，在同一终端页右侧提供可折叠、双层可调宽、
> 严格只读的文件树与代码高亮阅读器，覆盖 Windows、macOS、Linux 与 WSL。

---

## 1. 结论先行

首版布局固定为：

```text
┌────────────── Terminal ──────────────┬──────── Workspace Reader ────────┐
│                                      │ File tree │ Read-only code        │
│              xterm                   │           │ line no. + highlight  │
│                                      │           │                       │
└──────────────────────────────────────┴───────────┴───────────────────────┘
                         ↑ 外层拖拽缝       ↑ 内层拖拽缝
```

- 外层拖拽缝调整**整个 Workspace Reader** 宽度；
- 内层拖拽缝调整**文件树**宽度，代码区自动占用剩余空间；
- 阅读器可整体收起；重新展开恢复上次宽度；
- 只读取启动时明确选择的工作区，不允许跳出根目录；
- 只支持浏览、选择、复制，不包含任何编辑、保存或文件修改能力；
- 首版使用手动刷新，不实现文件系统 watcher；
- 只对 AI CLI Session 开放，普通终端保持现状。

该功能建立一个主进程 `WorkspaceReaderModule` 深模块。Renderer 的 Interface 只有
`describe/list/read`，所有 runtime 路径解析、安全校验、编码/大小判断和 Native/WSL 差异均留在
模块内部。

## 2. 产品需求与非目标

### 2.1 首版需求

1. 用户通过 CLI 卡片启动 Session，并选择一个有效工作目录；
2. Terminal Page 右侧出现“代码阅读器”入口，默认是否展开沿用当前 Session UI 状态；
3. 展开后终端与阅读器横向并排，xterm 自动 fit；
4. 文件树以启动工作区为唯一根，目录按需展开，不一次递归扫描整个仓库；
5. 点击文本文件后读取当时磁盘上的最新内容，在代码区显示；
6. 代码区包含路径、语言、行号、语法高亮、横纵滚动、文本选择与复制；
7. 阅读器标题栏提供手动刷新：清目录缓存并重新读取当前文件；
8. 二进制、超限、无权限、已删除或编码不支持的文件显示明确空态；
9. CLI 进程退出后，只要终端历史页尚未关闭，阅读器仍可使用；
10. 用户关闭 Terminal/Session 后释放该终端的 Workspace mount 与缓存；
11. Renderer reload 不重新启动 CLI，也不重复创建 Workspace mount；
12. 深浅主题与五语言 UI 使用现有 token/i18n，不硬编码生产色值或中文。

### 2.2 明确不做

- 编辑、保存、格式化、重命名、创建、删除、拖放；
- Monaco/LSP、定义跳转、引用查找、诊断、补全；
- 多文件 Tab、分屏阅读、Markdown/图片预览；
- Git diff、源代码管理、全局搜索、文件内容搜索；
- 自动跟随 Agent 当前工具调用或自动打开被修改文件；
- 文件系统 watcher、外部变更推送；
- 读取没有通过 Vibing 启动的外部 CLI Session；
- 空工作区自动回退到 home、应用目录或当前进程目录；
- 普通 Terminal 的通用文件管理器。

## 3. 布局、拖拽与响应式规则

### 3.1 默认尺寸

| 区域 | 默认值 | 约束 |
|---|---:|---|
| Workspace Reader | 内容区宽度的 52% | Terminal 至少 420px；Reader 至少 460px |
| File tree | 220px | 最小 160px；最大 360px；Code 至少 280px |
| 拖拽热区 | 10px（可见线 1px） | hover/drag 显示 `col-resize` |

- 外层宽度以比例保存，窗口 resize 后重新 clamp；
- 文件树宽度以 px 保存；
- 双击任一拖拽缝恢复默认值；
- 收起仅隐藏 Reader，不重置两个宽度；
- 拖拽使用 Pointer Events + pointer capture，更新合并到 animation frame；
- 拖拽期间禁止页面选字，结束后恢复；
- Separator 使用 `role="separator"`、`aria-orientation="vertical"`，左右键每次调整
  16px，`Home/End` 移到允许范围端点。

### 3.2 狭窄窗口

内容宽度无法同时容纳 420px Terminal + 460px Reader 时：

- 默认保持 Reader 收起；
- 用户主动展开则进入 Reader focus mode：Reader 占满内容区，提供“返回终端”按钮；
- xterm 仍保持 mounted，不销毁 PTY、buffer 或 Session；
- 宽度恢复后回到 A 并排布局和之前的比例。

不使用 B 的浮层抽屉作为响应式回退，避免两个正式布局模型。

### 3.3 状态归属

- `readerWidthRatio`、`treeWidthPx` 是全局 UI 偏好，进入现有 settings persistence；
- `open/selectedPath/expandedPaths` 按 `terminalId` 存在 renderer 内存 Store；
- 切换 Session 不丢各自的选择和展开树；
- 首版 renderer reload 可重置选择/展开树，但宽度偏好保留；
- 文件正文不写 localStorage、不进入 Session projection、History 或日志。

## 4. 主进程深模块与 Interface

### 4.1 外部 seam

新增共享只读契约：

```ts
interface WorkspaceReader {
  describe(terminalId: string): Promise<WorkspaceDescriptor | null>
  list(input: WorkspaceListRequest): Promise<WorkspaceEntry[]>
  read(input: WorkspaceReadRequest): Promise<WorkspaceTextFile>
}
```

调用方只传：

- `terminalId`；
- 使用 `/` 分隔的根内相对路径；
- `list` 的目录路径或 `read` 的文件路径。

调用方不传绝对路径、distro、host path、UNC 或权限选项。主进程通过 `terminalId` 查找注册好的
Workspace mount，避免 renderer 伪造另一个根目录。

建议契约：

```ts
interface WorkspaceDescriptor {
  terminalId: string
  label: string
  runtime: 'windows' | 'macos' | 'linux' | 'wsl'
}

interface WorkspaceEntry {
  path: string          // 根内相对路径；统一 `/`
  name: string
  kind: 'file' | 'directory' | 'symlink'
  size?: number
}

interface WorkspaceTextFile {
  path: string
  text: string
  byteLength: number
  languageHint?: string
  eol: 'lf' | 'crlf' | 'mixed' | 'none'
}
```

错误使用稳定 code（`not-found / not-directory / binary / too-large / denied /
outside-root / runtime-unavailable / unsupported-encoding`），不把原始主机路径或 stack 泄漏给 UI。

### 4.2 内部 seam

`WorkspaceReaderModule` 内部有两个真实 Adapter：

```ts
interface WorkspaceFsAdapter {
  list(relativePath: string): Promise<WorkspaceEntry[]>
  read(relativePath: string): Promise<WorkspaceTextFile>
  dispose(): Promise<void>
}
```

- `NativeWorkspaceFsAdapter`：Windows、macOS、Linux host；
- `WslWorkspaceFsAdapter`：Windows 主进程读取 WSL 工作区。

产品 UI、preload 和 Agent Adapter 不知道具体 Adapter。文件读取失败只影响 Reader，不降级或终止
CLI Observer/PTY。

### 4.3 生命周期

```text
AgentSessionRuntime resolve installation + workspace
  → PTY spawn 成功
  → WorkspaceReaderModule.mount(terminalId, installation.runtime, workspace)
  → renderer describe/list/read
  → CLI process exit：mount 保留，便于阅读退出后的工作区
  → renderer 明确关闭 terminal / app quit
  → PTYManager terminal removed seam
  → WorkspaceReaderModule.unmount(terminalId)
```

- mount 必须发生在 PTY spawn 成功后，避免启动失败留下幽灵 Workspace；
- mount 失败不 kill 已启动 CLI，只使 `describe()` 返回 unavailable；
- `unmount()` 幂等；stop/exit/close 竞态只清理一次；
- PTYManager 保持品牌无关，只新增通用 terminal-removed 订阅 seam；
- AgentSessionRuntime 只负责把已解析的 installation runtime 与 workspace 交给模块。

## 5. Native / WSL 路径与安全

### 5.1 公共规则

- 相对路径必须非绝对、无 NUL、长度有界；`\` 统一为 `/` 后再校验；
- 拒绝 `..` 越级与 drive/UNC 前缀；
- 每次 list/read 都以 mount root 解析并做 realpath containment；
- symlink 可展示；只有 real target 仍在 root 内才允许跟随；
- 防止 symlink loop、Windows junction/reparse point 与大小检查后的换链竞态；
- 目录按 `directory → file → symlink`、自然名称排序；
- 单目录默认最多返回 5,000 项，超限给出有界错误，不无限分配；
- 单文件上限首版 2 MiB；读取前后都验证大小；
- 检测 NUL/不可打印字节比例，二进制不传 renderer；
- 支持 UTF-8、UTF-8 BOM、UTF-16 LE/BE BOM；其他编码报 unsupported，不猜测；
- 文件正文永不进入 console、诊断日志、事件总线、统计或持久化缓存。

### 5.2 WSL

P0 先在真实 Ubuntu-22.04 验证 Node `fs` 对以下路径的 `opendir/lstat/realpath/readFile`：

- `\\wsl.localhost\<distro>\home\...`；
- WSL 内 Windows mount（如 `/mnt/c/...`）映射后的 host path；
- Unicode、空格、symlink、无权限与已删除文件。

首选实现是主进程通过 UNC/host path 使用 Node `fs`，避免：

- `find/ls` 文本协议无法安全表示任意文件名；
- shell quoting/command injection；
- 假设 distro 安装了 Node/Python；
- 每次展开目录都 spawn `wsl.exe`。

若 P0 证明 UNC realpath/symlink 语义不可靠，再实现长度前缀或 JSON frame 的 WSL helper；不得退回
解析 `ls/find` 人类文本。WSL distro 必须来自 installation runtime，不能从路径猜测或使用默认 distro。

## 6. Renderer 模块

```text
src/workspace-reader/
  WorkspaceReaderLayout.tsx   # A 布局、折叠、focus mode
  SplitHandle.tsx             # pointer/keyboard/clamp
  WorkspaceTree.tsx           # lazy tree、refresh、selection
  ReadOnlyCodeView.tsx        # CodeMirror lifecycle/theme/language
  workspaceReaderStore.ts     # per-terminal UI state
  language.ts                 # filename → lazy language support
```

`TerminalPage` 只决定当前 terminal 是否有 Workspace mount，并把稳定的 xterm subtree 与
`terminalId` 交给 `WorkspaceReaderLayout`。文件树和代码区不直接调用 Node/Electron，只通过
preload 暴露的 `window.workspaceReader` Interface。

### 6.1 文件树

- 首次展开目录时调用 `list`，关闭/重新展开复用内存结果；
- Refresh 清当前 terminal 的目录缓存并重新读取当前文件；
- 展示 dotfiles；`.git`、`node_modules` 不预扫描，但用户可显式展开；
- loading/error/empty 各有独立行，不让整棵树闪退；
- 大目录使用虚拟列表或扁平化 visible-node 列表，避免数千 DOM 节点；
- 单击文件改变 selection；单击目录展开；不提供右键修改菜单。

### 6.2 严格只读代码视图

选用 CodeMirror 6 core，不使用 Monaco，也不直接引入带编辑命令的 `basicSetup`。当前官方 Interface
支持：

- `EditorState.readOnly.of(true)` 表达文档只读；
- `EditorView.editable.of(false)` 移除 contenteditable；
- `lineNumbers()` 提供行号；
- Viewport 只渲染可见文档范围，适合大于普通 `<pre>` 的文件；
- `LanguageDescription.matchFilename(...).load()` 按文件名懒加载语言。

参考：[CodeMirror Reference](https://codemirror.net/docs/ref/)、
[System Guide](https://codemirror.net/docs/guide/)。

首版只装：state、view、language、language-data 与主题需要的最小包。Viewer 保留选择、复制、滚动和
键盘导航，不注册输入、删除、粘贴、undo、format 或写回 handler。语言加载失败回退 plain text。

## 7. 实施阶段与小提交

### P0 — 取证与契约冻结

- [x] 删除 B/C 原型与切换器，只保留 A 的已确认视觉决策作为实现参考；
- [x] 用真实 host/WSL 临时工作区验证 path/realpath/symlink/Unicode；
- [x] 冻结 Workspace shared contract、错误 code、2 MiB/5,000 项限制；
- [x] 确认 CodeMirror 最小包与生产 bundle 增量；
- [x] 产出 Native/WSL fixture matrix。

提交：`docs: freeze read-only workspace reader contract`

### P1 — 主进程 WorkspaceReaderModule

- [x] 实现 mount/describe/list/read/unmount；
- [x] 实现 Native Adapter、安全路径解析、编码/二进制/大小限制；
- [x] 实现 WSL Adapter；
- [x] 新增 IPC/preload 收窄接口；
- [x] Parser 级门禁覆盖 traversal、symlink escape、读取前后校验与超限。

提交：`feat: add sandboxed workspace reader module`

### P2 — 生命周期接入

- [x] AgentSessionRuntime 在 spawn 成功后 mount；
- [x] PTYManager 提供 terminal-removed seam；
- [x] process exit 保留 mount，terminal close/app quit 清理；
- [x] spawn/mount/close/reload 竞态不产生幽灵资源；
- [x] 普通 terminal 与 Agent Observer 能力契约不变。

提交：`feat: bind workspace mounts to terminal lifetime`

### P3 — A 布局与双 Split Handle

- [x] 生产重写 `WorkspaceReaderLayout`，不直接提升原型代码；
- [x] 外层 Reader 比例拖拽、内层 Tree px 拖拽；
- [x] clamp、双击复位、keyboard separator、focus mode；
- [x] 宽度偏好写入 settings persistence；
- [x] 验证连续拖拽时 xterm fit/ConPTY 不丢内容。

提交：`feat: add resizable workspace reader layout`

### P4 — Lazy File Tree

- [x] 实现展开、选择、loading/error/empty；
- [x] 按 terminal 缓存、手动 refresh；
- [x] 大目录 visible-node 虚拟化；
- [x] 文件树没有任何 mutation affordance。

提交：`feat: add lazy read-only workspace tree`

### P5 — CodeMirror Read-only Viewer

- [x] 最小 CodeMirror extension 集；
- [x] line number、selection/copy、横纵滚动、主题；
- [x] filename language match + lazy load + plain-text fallback；
- [x] binary/large/deleted/denied/unsupported 空态；
- [x] 切换文件时销毁旧 View/异步语言加载不覆盖新 selection。

提交：`feat: add syntax-highlighted read-only code viewer`

### P6 — E2E、文档与原型清理

- [x] Workspace Reader 自动化门禁全部通过；
- [x] 删除 `WorkspaceReaderPrototype.tsx`、variant query 与开发切换器；
- [x] SPEC/计划回写完成状态与真机证据；
- [x] 确认生产包不包含 prototype/B/C；
- [x] 构建、类型检查与定向回归通过。

提交：`test: verify workspace reader across terminal runtimes`

## 8. E2E 验收矩阵

### 8.1 UI 与终端共存

- [x] 有工作区的 AI CLI 显示入口；空工作区/普通终端不显示；
- [x] 展开/收起不卸载 TerminalView、不新增 PTY/Session；
- [x] 外层拖拽改变布局，内层拖拽不改变 Reader 总宽；
- [x] 达到 min/max 后 clamp，无横向页面滚动条；
- [x] 双击复位、键盘 separator、窗口缩放/focus mode 正常；
- [ ] Claude/Codex/OpenCode/Pi TUI 在连续开关与拖拽后仍可输入、点击、选择；
- [ ] 切换 Session 保留各自 open/file/tree 状态；
- [x] renderer reload 不 spawn 第二个 CLI 或 Workspace mount。

### 8.2 文件与只读门禁

- [x] lazy list 的目录排序、Unicode/空格/dotfile 正确；
- [x] TypeScript 等已注册语言按文件名懒加载高亮；
- [x] 未知扩展 plain text；
- [x] 行号、选择、复制可用；键入、粘贴、删除不改变 doc；
- [x] Refresh 后可看到 CLI 写入的最新内容；首版不承诺自动变化；
- [x] `../`、absolute、UNC、drive prefix、symlink escape 全部拒绝；
- [x] binary、>2 MiB、>5,000 entries、权限失败显示有界空态；
- [x] 文件正文不出现在 console、event history、Session detail、持久化文件。

### 8.3 平台

| Runtime | 自动化 | 真机 smoke |
|---|---|---|
| Windows host | ✅ Electron + module gate | ✅ 2026-08-04 |
| WSL Ubuntu-22.04 `/home` | ✅ real distro gate | ✅ 2026-08-04 |
| WSL `/mnt/c` | ✅ real distro gate | ✅ 2026-08-04 |
| macOS host | ✅ shared native contract | 发版前必须 |
| Linux host | ✅ shared native contract | 发版前必须 |

### 8.4 实施证据（2026-08-04）

- `e2e/workspace-reader.spec.ts`：Electron 启动、只读 CodeMirror、refresh、双 splitter、
  focus mode、reload、普通终端隔离、自然退出保留与显式关闭清理；
- `e2e/workspace-reader-module.spec.ts`：UTF-8/UTF-16、binary、Unicode/空格/dotfile、
  junction escape，以及真实 Ubuntu-22.04 `/mnt/c` 与 `/home`；
- WSL P0 发现 Node 对 `\\wsl.localhost\<distro>\mnt\c` 的 `realpath` 会返回 `EPERM`。
  正式实现因此在 mount 时用该 distro 的 `wslpath -w` 做一次参数化翻译：`/mnt/c`
  得到原生盘符路径，`/home` 得到 UNC；目录展开和文件读取不再启动 WSL 进程；
- Workspace Reader + settings 定向门禁 22/22 通过；Agent Runtime 30/30、实例生命周期、
  tabs 与其余终端相关回归通过。既有 `render.spec.ts` 字体变更 resize 计数门禁仍稳定复现
  `+2` 而非旧断言 `+1`，与 Reader 路径无关，未在本里程碑扩大修复范围。

## 9. 完成定义

只有同时满足以下条件才可标记 M5.d 完成：

1. A 布局生产重写完成，两个宽度均可鼠标与键盘调整；
2. 只读属性由主进程无写 Interface + CodeMirror 双重只读配置共同保证；
3. Native/WSL 根目录逃逸、symlink 与大小/编码门禁通过；
4. Session/PTY 生命周期没有重复启动、幽灵 Workspace 或关闭后泄漏；
5. Reader resize 不破坏 xterm buffer、输入、鼠标与 Agent Observer；
6. Windows/WSL 真实工作区 smoke 通过，macOS/Linux 代码路径完成并列出真机待办；
7. 原型及 variant switcher 不进入生产构建；
8. `typecheck`、build、Workspace Reader E2E 与相关 terminal 回归全部通过。
