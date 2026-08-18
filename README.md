<p align="right">
  <a href="./README.zh-CN.md">简体中文</a>
</p>

<div align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="./assets/readme/hrack-wordmark-dark.png">
    <img src="./assets/readme/hrack-wordmark-light.png" width="370" alt="HRack">
  </picture>

  <h3>One rack for every coding agent</h3>
  <p>Keep the native TUI. Stop babysitting terminal tabs.</p>

  <p>
    <a href="https://github.com/UniRound-Tec/HRack/releases"><img alt="Latest release" src="https://img.shields.io/github/v/release/UniRound-Tec/HRack?style=flat-square"></a>
    <a href="https://github.com/UniRound-Tec/HRack/releases"><img alt="Release downloads" src="https://img.shields.io/github/downloads/UniRound-Tec/HRack/total?style=flat-square"></a>
    <img alt="Windows, macOS, and Linux" src="https://img.shields.io/badge/Windows%20%7C%20macOS%20%7C%20Linux-ready-5b5b78?style=flat-square">
    <a href="./LICENSE"><img alt="License: Apache-2.0" src="https://img.shields.io/badge/license-Apache--2.0-blue?style=flat-square"></a>
  </p>
</div>

**HRack** — short for **Harness Rack** — is a desktop terminal for multi-agent coding workflows. It keeps every CLI's native TUI intact, then adds the layer that is usually missing around it: session status, attention cues, a floating monitor, quick launch, and a read-only workspace viewer.

<div align="center">
  <img src="./assets/readme/home-launcher.png" width="1100" alt="HRack home screen with detected coding CLIs">
</div>

## The problem

Different coding agents are useful for different jobs, so one terminal quickly becomes several. The friction is not starting them — it is keeping track of them:

- You switch away, come back later, and discover that an agent has been waiting on a permission prompt the whole time. Codex and Gemini CLI users have both asked for better attention signals ([Codex](https://github.com/openai/codex/issues/10081), [Gemini CLI](https://github.com/google-gemini/gemini-cli/issues/14696)).
- Once several agents run in parallel, you start hunting through tabs for the one that needs you. The same problem shows up in [multi-agent workflow discussions](https://news.ycombinator.com/item?id=47268777) and tools such as [tmux-claude-session-manager](https://github.com/craftzdog/tmux-claude-session-manager).
- A notification alone is not enough if it never fires ([Codex #8929](https://github.com/openai/codex/issues/8929)), cannot tell that the agent is waiting for an answer ([Codex #13478](https://github.com/openai/codex/issues/13478)), or misses an interactive shell waiting for input ([Gemini CLI #19527](https://github.com/google-gemini/gemini-cli/issues/19527)).

HRack keeps those sessions together, tells you which one needs attention, and takes you back to the right place. The original CLI still does all the work; HRack simply means you do not have to stare at it.

## How it works

On first launch, HRack discovers compatible CLIs on the host and in WSL. The result is cached for fast startup and can be rescanned manually. Each supported harness has an adapter that turns its official Hooks, SSE stream, extension API, or runtime events into a small shared vocabulary:

```text
thinking · tool call · needs you · completed · error
```

Those facts drive the sidebar, the floating window, and the history view without touching terminal bytes:

```text
CLI ── PTY ──────────────────────────────> native TUI
 └── Hooks / SSE / extension events ──> adapter ──> status and alerts

workspace ── read-only access ──────────> file tree and viewer
```

If an observer fails, the PTY keeps running. HRack degrades the status display instead of breaking the CLI session.

## Highlights

### Know what every agent is doing

Run different agents side by side and see which one is thinking, using a tool, waiting for you, finished, or no longer fully observed.

<div align="center">
  <img src="./assets/readme/multi-agent-status.png" width="1100" alt="Multiple coding agents and their live statuses in HRack">
</div>

### Collapse the shell, keep the signal

The main sidebar can collapse into a compact rail. The built-in monitor still shows every followed session and brings you back to the correct one.

<div align="center">
  <img src="./assets/readme/collapsed-sidebar-monitor.png" width="1100" alt="Collapsed HRack sidebar with the session monitor">
</div>

### Make the floating window yours

The default floating monitor is itself a built-in renderer. Custom renderers use the same public interface and can be built with HTML, CSS, JavaScript, animation libraries, canvas, or Live2D. Settings include a short built-in skill that you can copy and give to your coding agent to create and install a renderer.

<p align="center">
  <img src="./assets/readme/live2d-floating-window.png" width="32%" alt="Live2D floating renderer">
  &nbsp;&nbsp;
  <img src="./assets/readme/custom-floating-window.png" width="31%" alt="Custom mascot floating renderer">
</p>

### Read the workspace without leaving the session

Open a read-only file tree beside the terminal, inspect highlighted source, and preview Markdown while the agent keeps its native TUI.

<div align="center">
  <img src="./assets/readme/workspace-reader.png" width="1200" alt="HRack read-only workspace viewer beside OpenCode">
</div>

### Themes, fonts, and layout

Choose independent application and terminal themes, adjust terminal fonts and sizing, switch navigation modes, and configure the floating renderer from one settings page.

<div align="center">
  <img src="./assets/readme/settings-themes.png" width="1100" alt="HRack theme and floating renderer settings">
</div>

### Fast launch across runtimes

Start a shell or detected coding CLI from the Home screen or quick-launch panel. HRack supports host installations and compatible WSL distributions. DeepSeek Harness appears only after a local or WSL install is found.

<div align="center">
  <img src="./assets/readme/quick-launch.png" width="950" alt="HRack quick-launch panel">
</div>

## Supported harnesses

| Harness | Integration | Status available to HRack | Runtimes |
| --- | --- | --- | --- |
| DeepSeek Harness | Official Web surface + runtime bridge | Followed session and lifecycle | Host, WSL |
| Claude Code | Official Hooks | Thinking, tools, approvals, completion | Host, WSL |
| Codex CLI | Stable Hooks | Turns, tools, approvals, compaction | Host, WSL |
| OpenCode | Server + SSE | Sessions, thinking, tools, questions, permissions | Host, WSL |
| Pi | Extension API | Thinking, responses, tools, turns | Host, WSL |
| Kimi Code | Official Hooks | Turns, thinking, tools, approvals | Host, WSL |
| Grok Build | Official Hooks | Turns, thinking, tools, approvals | Host, WSL |

HRack can also discover and launch Devin CLI, Cline, Qwen Code, Amp, Aider, Goose, Kiro CLI, GitHub Copilot CLI, and other registered CLIs. Launch-only integrations do not expose the same level of status detail yet.

## Install

Download the latest build from [GitHub Releases](https://github.com/UniRound-Tec/HRack/releases):

- Windows x64: `HRack-Setup-*.exe`
- macOS Apple Silicon: `HRack-*-macos-arm64.dmg`
- Linux x64: `HRack-*-linux-x64.AppImage` or `HRack-*-linux-x64.deb`

The builds are not commercially code-signed yet, so the operating system may show a security prompt on first launch.

### First run

1. Start HRack and let the initial CLI scan finish.
2. Pick a terminal or coding CLI.
3. Choose its runtime and workspace.
4. Start the session. HRack keeps the native TUI in the main pane and publishes its status around it.

If Codex asks you to review Hooks, open `/hooks`, inspect the HRack definition, and trust it. For Kimi Code, HRack maintains a versioned managed block in the effective user `config.toml`; content outside that block is preserved. Grok Build installs a dedicated `hrack-observer.json` under `~/.grok/hooks/` (or `$GROK_HOME/hooks` / the matching WSL home), which Grok treats as a trusted user hook.

## Development

```bash
npm install
npm run dev
```

Useful checks:

```bash
npm run typecheck
npm run build
npm run e2e:only
```

Windows, macOS, and Linux release packages must be built on their matching operating systems through `npm run release:win`, `npm run release:mac`, and `npm run release:linux`. DSH e2e tests install an isolated, gitignored `dsh-runtime` fixture via `npm run ensure:dsh`; it is not packaged into releases.

## Contributing

Bug reports, reproducible edge cases, and focused pull requests are welcome. Observer changes should include a fixture or runtime test that proves event ordering and fallback behavior. Please open an [issue](https://github.com/UniRound-Tec/HRack/issues) before starting a large feature.

## Friends

- [LINUX DO](https://linux.do/)

## License

HRack is licensed under the [Apache License 2.0](./LICENSE).

---

<div align="center">
  <sub>Free your mind. Get back to vibe coding.</sub>
</div>
