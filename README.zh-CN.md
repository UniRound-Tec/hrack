<p align="right">
  <a href="./README.md">English</a>
</p>

<div align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="./assets/readme/vibing-wordmark-dark.png">
    <img src="./assets/readme/vibing-wordmark-light.png" width="370" alt="Vibing">
  </picture>

  <h3>一个专为 Coding CLI 优化的终端</h3>
  <p><sub>解放心智，回到真正的氛围编程</sub></p>

  <p>
    <a href="https://github.com/UniRound-Tec/vibing/releases"><img alt="最新版本" src="https://img.shields.io/github/v/release/UniRound-Tec/vibing?style=flat-square"></a>
    <a href="https://github.com/UniRound-Tec/vibing/releases"><img alt="下载量" src="https://img.shields.io/github/downloads/UniRound-Tec/vibing/total?style=flat-square"></a>
    <img alt="Windows 与 macOS" src="https://img.shields.io/badge/Windows%20%7C%20macOS-ready-5b5b78?style=flat-square">
    <img alt="Electron 43" src="https://img.shields.io/badge/Electron-43-47848F?style=flat-square&logo=electron&logoColor=white">
    <a href="./LICENSE"><img alt="开源协议：Apache-2.0" src="https://img.shields.io/badge/license-Apache--2.0-blue?style=flat-square"></a>
  </p>
</div>

Vibing 是一个给多 Coding Agent 工作流使用的桌面终端。它保留每个 CLI 原本的 TUI，在外层补上会话状态、注意力提醒、悬浮监控和只读工作区浏览。

<div align="center">
  <img src="./assets/readme/vibing-demo.gif" width="1100" alt="Vibing 功能演示">
</div>

## 为什么做 Vibing？

Coding Agent 本来应该帮人省时间，实际用起来却经常卡在这些小事上：

- 切去做别的事，过一会儿回来，才发现 Agent 一直停在权限确认上白等。这个问题在 [Codex](https://github.com/openai/codex/issues/10081) 和 [Gemini CLI](https://github.com/google-gemini/gemini-cli/issues/14696) 的官方 Issue 里都有人提过。
- 同时跑几个 Agent 以后，人又开始在终端标签页之间来回找：“到底哪个在等我？”这也是 [HN 多 Agent 工作流讨论](https://news.ycombinator.com/item?id=47268777) 和 [tmux-claude-session-manager](https://github.com/craftzdog/tmux-claude-session-manager) 这类工具出现的原因。
- 有通知也不一定管用。它可能根本没触发（[Codex #8929](https://github.com/openai/codex/issues/8929)），可能不知道 Agent 正在等回答（[Codex #13478](https://github.com/openai/codex/issues/13478)），也可能漏掉交互式 Shell 的输入等待（[Gemini CLI #19527](https://github.com/google-gemini/gemini-cli/issues/19527)）。

Vibing 想解决的就是这些每天都会碰到的小麻烦：把会话放在一起，告诉你谁需要处理，再把你带回正确的位置。真正干活的还是原来的 CLI，Vibing 只是让你不用一直盯着它。

## 能做什么

- **汇总会话状态**：查看 CLI 正在工作、等待确认、已经完成，还是监听能力发生了降级。
- **在需要时提醒你**：悬浮窗持续显示活跃会话和待处理事项。
- **统一启动入口**：从一个地方启动普通 Shell，或 Windows、WSL、macOS 中检测到的 Coding CLI。
- **随手查看代码**：用只读文件树浏览工作区、阅读高亮代码并预览 Markdown。
- **保留终端体验**：原生 TUI 输入、鼠标、滚动、复制粘贴、主题、字体和 GPU 渲染都不打折。

## 界面

<table>
  <tr>
    <td width="46%">
      <strong>原生 TUI 外的会话状态</strong><br><br>
      <img src="./assets/readme/terminal-session.png" alt="Claude Code 终端旁的会话状态">
    </td>
    <td width="54%">
      <strong>只读工作区阅读器</strong><br><br>
      <img src="./assets/readme/workspace-reader.png" alt="工作区文件树和代码阅读器">
    </td>
  </tr>
</table>

## 开始使用

### 安装

从 [GitHub Releases](https://github.com/UniRound-Tec/vibing/releases) 下载最新版本：

- Windows x64：`Vibing-Setup-*.exe`
- macOS Apple Silicon：`Vibing-*-macos-arm64.dmg`

安装包暂时没有商业代码签名，首次启动时系统可能显示安全提醒。

### 第一次启动

1. 启动 Vibing，等待 CLI 扫描完成。
2. 从首页选择普通终端或 Coding CLI。
3. 选择运行环境和工作区。
4. 创建会话。原生 TUI 会显示在主区域，Vibing 负责在外围同步状态。

如果 Codex 提示 Hook 尚未授权，请在 Codex 中打开 `/hooks`，检查并信任 Vibing 注入的 Hook。监听失败不会结束 CLI 会话，Vibing 只会退回基础生命周期状态。

对于 Kimi Code，Vibing 会在当前生效的用户 `config.toml`（`KIMI_CODE_HOME` 或 `~/.kimi-code`）中维护一个有版本及清晰标记的 Hook 托管块。候选配置经 `kimi doctor config` 校验后才会安装；托管块之外的内容逐字节保留；从 Vibing 之外启动 Kimi 时，这些 Hook 会静默退出且不产生副作用。

## CLI 支持

| CLI | 监听方式 | Vibing 可获得的状态 |
| --- | --- | --- |
| Claude Code | 官方 Hooks | 思考阶段、工具、审批、完成状态 |
| Codex CLI | Stable Hooks | 回合、工具、审批、上下文压缩 |
| OpenCode | Server + SSE | 会话、思考、工具、问题、权限 |
| Pi | Extension API | 思考、回复、工具、回合 |
| Kimi Code | 官方 Hooks | 回合、思考阶段、工具、审批 |

Vibing 也可以扫描并启动 Grok Build、Devin CLI、Cline、Qwen Code、Amp、Aider、Goose、Kiro CLI 等入口。仅启动接入的 CLI 不会提供同等级别的状态细节。

## 状态如何进入界面

```text
CLI ── PTY ──────────────────────────────> 终端
 └── Hooks / SSE / Extension 事件 ────> Adapter ──> 会话状态与提醒

工作区 ── 只读访问 ─────────────────────> 文件树与阅读器
```

终端字符流始终走 PTY。Adapter 只发布有界的结构化事实，例如回合开始、工具结束或正在等待审批。即使 Observer 失效，PTY 也会继续运行。

## 本地开发

```bash
npm install
npm run dev
```

`npm install` 会同时初始化内置 DSH 运行时：`dsh-runtime/` 隔离依赖树不入库（约 254 MiB），由 `postinstall`（以及 `predev` / `pretypecheck` / `build` 钩子）执行 `npm run ensure:dsh` 首次安装，之后是毫秒级 no-op。

常用检查：

```bash
npm run typecheck
npm run build
npm run e2e:only
```

Windows 安装包需要在 Windows 上构建，macOS 安装包需要在 macOS 上构建。

## 参与贡献

欢迎提交 Bug、可复现的边界情况和范围明确的 Pull Request。修改 Observer 时，请补充 fixture 或 Runtime 测试，用来证明事件顺序和降级行为。

Vibing 仍处于预览阶段。相比一次覆盖很多模块的大改动，小而清晰的提交更容易讨论和合并。大型功能建议先开一个 [Issue](https://github.com/UniRound-Tec/vibing/issues)。

## 开源协议

Vibing 使用 [Apache License 2.0](./LICENSE) 开源。

---

<div align="center">
  <sub>为每天生活在 Coding CLI 里的人而做。</sub>
</div>
