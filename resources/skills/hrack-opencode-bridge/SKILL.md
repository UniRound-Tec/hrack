---
name: hrack-opencode-bridge
description: Drive a visible OpenCode tab through HRack's local Bridge CLI. Use when another local harness must list models, create an OpenCode session, send, watch, approve, deny, answer questions, or close via `hrack`. Use when the user mentions HRack Bridge, hrack session, opencode create, watch/wait blocked, or collaborating with OpenCode through HRack.
---

# HRack OpenCode Bridge

通过本机 `hrack` CLI 控制 **HRack 已经打开的那条可见 OpenCode tab**。人和 TUI 看见的是同一条会话。不要另起 `opencode serve`，不要抓 PTY，不要在 HRack 未运行时自己拉 GUI。

## 前提

1. **HRack 主窗口必须已经打开**（不能只剩托盘）。未运行时 CLI 退出码 `2`。
2. 只控制 HRack 自己拉起的 OpenCode。Windows 安装和某个 WSL 发行版是不同安装，必须显式选 `--installation`，禁止猜默认 WSL。
3. 对外只认 HRack 的 `sessionId`，以及 watch 事件里的 `requestId`。不要拼 OpenCode 端口或 native id。

## 怎么调用

已安装的产品：

```text
hrack <subcommand>
```

开发仓库（HRack 已在跑）：

```text
npm run hrack -- --hrack-cli <subcommand>
```

PowerShell 里带空格或 JSON 的参数要加引号。`answer` 的 `--json` 建议整段单引号包住，或先写到文件再读进参数。

短请求：成功把 JSON 打到 stdout，退出 `0`；参数/状态不允许退出 `1`；HRack 不在退出 `2`。

## 命令

```text
hrack opencode models [--installation <id>]
hrack opencode create --workspace <绝对路径> --model <provider/model>
                       [--agent plan|build] [--name <标题>]
                       [--installation <id>]
hrack sessions
hrack session send <sessionId> <text>
hrack session turn <sessionId>
hrack session watch <sessionId>
hrack session wait <sessionId> --until blocked|turn|exited
hrack session rename <sessionId> <name>
hrack session mode <sessionId> plan|build
hrack session approve <sessionId> <requestId> [--remember]
hrack session deny <sessionId> <requestId>
hrack session questions <sessionId>
hrack session answer <sessionId> <requestId> --json '<OpenCode 答案 JSON>'
hrack session reject-question <sessionId> <requestId>
hrack session close <sessionId>
```

- `create` 会打开真实可见 tab，立刻返回 `sessionId` / `installationId` / `runtime`。默认 `--agent build`。
- `sessions` 只列出 OpenCode。`runtime` 能区分 Windows host 和每一个 WSL 发行版。
- `send` 只在会话 `idle` 或 `done` 时接受。`working` / `needs-you` 时不要发。
- `turn` 拉最近一轮完整正文和 tool 出入参（不含 thinking）。
- `watch` 进程不退出，**只**在 `blocked` / `turn` / `failed` / `exited` 各打一行 JSON。thinking、tool 进度、working 都保持静默。同一条会话不要开第二个 watch。Ctrl+C 退出 `130`，会话继续。
- `wait` 是 watch 的一次性封装：收到第一条匹配事件后打印该 JSON 并退出。`--until exited` 时 `failed` 也会退出。
- `mode` 会改 TUI 当前 plan/build。失败不要当成功。
- `approve` 默认一次性（`once`），不要加 `--remember`，除非调用方明确要求记住。
- `deny` / `reject-question` 拒绝后这一轮通常直接结束。
- `answer` 的 JSON 原样交给 OpenCode，形状是 `{"answers":[["选项标签"]]}`，整包不超过 64 KiB。
- 人在 TUI 先点过了：再 `approve` / `deny` / `answer` / `reject-question` 会返回 `already: true`，不要当错误。
- `close`（`stop` / `delete` 同义）关掉这条可见会话。

## 典型循环

同一条 `sessionId` 只挂一个 `watch`（或用 `wait` 代替不会读流的步骤）：

```text
hrack opencode models --installation <id>
hrack opencode create --workspace <dir> --model <provider/model> --installation <id> --name "补测试"
hrack session watch <sessionId>
        │
        │  静默：thinking / tools / working
        ▼
  blocked + delta
        │  kind=permission → hrack session approve <id> <requestId>
        │  kind=question   → hrack session questions <id>
        │                    hrack session answer <id> <requestId> --json '{"answers":[["标签"]]}'
        │  或 deny / reject-question
        ▼
  turn + delta          → 读正文和 tools
        │
hrack session send <id> "按这个继续"
        ▼
  blocked / turn / failed / exited
```

需要时在循环里加 `mode`、`rename`。人也可以不走这些命令，直接在可见 TUI 里点。

## 读事件

`blocked.kind`：

- `permission`：用事件里的 `requestId` 去 `approve` 或 `deny`
- `question`：先 `questions` 看选项，再用同一 `requestId` 去 `answer` / `reject-question`

`delta.text` / `delta.tools` 是叫醒时已经提交的完整 B 档（助手正文 + tool 名和出入参）。不必马上再打 `turn`，但 `turn` 仍能拉到同一轮。

## 不要做

- 主窗口没开就 `create`
- `working` 时 `send`
- 同一 `sessionId` 开两个 `watch`
- 把 watch 当心跳
- 默认带 `--remember`
- 改用户的 `opencode.json`、加 `--auto`、另起无头 `opencode serve`
- 给 HRack 新建会话再做一套模型 / plan / build 选择器（人进 TUI 自己调）
