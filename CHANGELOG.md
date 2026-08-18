# Changelog

本文件记录 HRack 各公开版本的重要变化。版本号遵循 [Semantic Versioning](https://semver.org/)。

## [Unreleased]

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
