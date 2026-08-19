# Changelog

本文件记录 HRack 各公开版本的重要变化。版本号遵循 [Semantic Versioning](https://semver.org/)。

## [Unreleased]

### 新增

- 终端可设置背景图像：从本地选择图片，支持覆盖 / 适应 / 拉伸 / 平铺，默认不透明度 30%，设置页带小预览；背景铺满圆角留白，并隐藏多余滚动条。
- 新增可设置事件提示音：阻塞 / 需要操作、完成、异常时播放，默认内置 `resources/done.mp3`；设置页支持上传本地音频与试听。

### 修复

- 修复悬浮窗在事件更新时因高 DPI 缩放导致窗口逐次下移的问题：改为以稳定底边为锚点，并在系统量化窗口尺寸后纠正位置。

### 改进

- 加强悬浮窗置顶：使用更高置顶层级，并定时重新置顶，减少被其它应用覆盖的可能。
- 悬停方框特效可在设置和首次欢迎页关闭；关掉后不再跟随指针绘制方框。
- 设置页按外观 / 布局 / 终端 / 会话 / 更新分页，左侧分类导航，内容区加宽；去掉叠在真实标题上的装饰性英文眉题。

## [0.3.4] - 2026-08-19

### 新增

- 新建 CLI 会话时记住上次工作区，并用主题化下拉框提供最近 5 条工作区记录。
- 新增 OpenCode Bridge：其它本地 harness 可以创建、发送、监听、审批、回答并关闭 HRack 里已经打开的 OpenCode 标签；设置页可复制用法 Skill。
- 新增 Grok Build 会话监听，覆盖本机与 WSL。
- 支持免审批启动的 CLI 在新建会话时提供勾选，并记住上次选择。

### 修复

- 普通终端未指定工作区时改在用户主目录启动，不再落到安装目录（例如 `AppData\\Local\\Programs\\HRack`）。
- 代码阅读器刷新时不再闪屏，文件树也不会滚回顶部。
- WSL 中启动 CLI 时外层工作目录不再误用 POSIX 路径，避免 Windows `Error 267`。
- DSH 监听器现在跟踪 tool call；本轮结束后显示「本轮任务已完成」，不再直接落到「等待你的下一条指令」。
- 打包版 Windows 任务栏与开始菜单快捷方式在深色主题下改用浅色图标；安装包图标改为含 256px 的浅色 ICO，满足 electron-builder 打包门槛。
- OpenCode Bridge 管道被占用时不再挡住主窗口启动。

### 改进

- 不再随包内置 DeepSeek Harness 兜底运行时。DSH 与其它 CLI 一样先扫描本机 / WSL，没有安装就不展示入口。
- Windows / macOS / Linux 安装包去掉约 250MB 的 `dsh-runtime`，并裁掉未使用的 Electron 语言包，安装包更小、安装更快。

## [0.3.3] - 2026-08-18

### 修复

- 修复打包版内置 DSH 启动失败（HMR 报 `--expose-internals is required`）：内置 host 改以 `ELECTRON_RUN_AS_NODE` 纯 Node 模式启动，`--expose-internals` 在打包产物中同样生效，开发与打包行为一致。

### 改进

- DSH 运行时发现不再锁定唯一兼容版本：扫描如实上报本机 / WSL 安装的实际版本，任意版本均可作为候选并被 auto 优先选中（随包内置版本仅作兜底）；实际兼容性由启动时的控制面能力门禁（`session.list` / `workspace.list`）兜底。

## [0.3.2] - 2026-08-18

### 新增

- 设置页新增「主题 JSON」编辑器，可编辑并保存个人界面主题（固定 `custom.json`），保存后可在主题选择器中选用。
- 新增主题创作 Skill（`create-hrack-theme`）及零依赖校验脚本（`validate-theme.cjs`），附带 WCAG 对比度检查。
- 新增 CLI 会话录制脚本（`npm run record:cli-demo`）。

### 改进

- DSH 默认共享 `~/.dsh` 历史目录，与本机 DeepSeek Harness 复用会话历史。
- DSH 界面圆角改用原生视图圆角（`setBorderRadius`），与侧栏环境色对齐；切换圆角开关不再重开会话。
- 应用深色模式下，窗口与托盘图标自动切换为浅色变体。
- 用户数据目录统一为 HRack / HRack Dev，安装包 appId 更新为 `com.hrack.app`。

### 修复

- 修复 DSH 圆角原先依赖内容留白、关闭后圆角消失的问题，改为原生圆角实现。

## [0.3.0] - 2026-08-16

### 新增

- 产品由 Vibing 更名为 HRack（Harness Rack），更新应用界面、图标、安装包与项目文档。
- 嵌入 DeepSeek Harness 官方 Web 界面，优先使用兼容的本机或 WSL DSH，随包版本仅作为兜底。
- 新增 Kimi Code 会话监听，并统一 Claude Code、Codex、OpenCode、Pi 与 Kimi 的状态覆盖语义。
- 新会话快速启动面板加入 DeepSeek Harness，并补齐已注册 CLI 的品牌图标。
- 新增 Linux x64 AppImage 与 Debian 安装包，以及 Windows、macOS、Linux 并行构建的 GitHub Release 流程。

### 改进

- DSH 侧边栏只关注当前激活会话，支持多个独立 DSH 窗口并避免重复悬浮会话。
- 修复审批完成后仍停留在“需要你的确认”、Kimi thinking 未同步、嵌入页面错位与品牌字体裁切等问题。
- DSH 运行时扫描覆盖 Windows 主机与 WSL，并明确采用“本机优先、随包兜底”的选择策略。

### 发布说明

- Windows x64 提供引导式 NSIS 安装包；macOS 提供 Apple Silicon DMG；Linux x64 提供 AppImage 与 Debian 包。
- Windows 与 macOS 产物尚未进行商业代码签名，系统首次启动时可能显示安全提醒。

## [0.2.2] - 2026-08-07

首个公开的 Windows 预览版本。

### 新增

- 面向 AI Coding CLI 的多会话终端、侧边栏状态聚合与悬浮提醒窗口。
- Claude Code、Codex CLI、OpenCode 与 Pi 的原生事件监听适配器。
- Windows 与 WSL 中的 CLI 扫描、启动、工作区选择和子终端。
- 只读文件树、代码高亮、Markdown 渲染与文件变化自动刷新。
- 深色与浅色 GUI/终端主题，以及可调节的阅读器布局。
- 会话重命名、克隆、排序和注意力优先选项。

### 修复

- 保留 WSL 中通过 NVM、Volta、asdf、mise 等工具配置的运行时环境，避免 Adapter 探测或监听失效。
- Pi 隐藏真实终端光标时，中文输入法预输入框会跟随 Pi 当前绘制的输入光标。
- 改善 TUI 重绘、窗口缩放、鼠标输入、托盘图标与安装包图标的稳定性。

### 发布说明

- 当前仅提供 Windows x64 引导式安装包。
- 安装包尚未进行商业代码签名，Windows 可能显示安全提醒。
