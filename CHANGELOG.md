# Changelog

本文件记录 Vibing 各公开版本的重要变化。版本号遵循 [Semantic Versioning](https://semver.org/)。

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
