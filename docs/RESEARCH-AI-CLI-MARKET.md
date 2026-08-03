# AI Coding CLI / Terminal Agent 市场调研

> 调研快照：**2026-08-03（Asia/Taipei）**
> 用途：为 Vibing 的 S 线“扫 → 列 → 启后挂监听”与后续 M6 适配器矩阵提供产品事实基线。
> 证据标准：只采用厂商官方文档、官方产品页、官方仓库、官方协议注册表；价格、模型和版本是易变信息，实施时应再次验证。

## 1. 范围与分类

“AI CLI”已不是单一类别。本文严格区分：

| 类别 | 判断标准 | 对 Vibing 的意义 |
|---|---|---|
| **本地交互 CLI/TUI** | agent 进程在本机终端运行并直接读写本地工作区 | 可扫描可执行文件、由 PTY 启动、监听本地进程 |
| **本地 headless / SDK / server** | 无 TUI，提供 JSON/JSONL、RPC、ACP、HTTP、SSE 或 SDK | 最适合稳定语义监听，应优先于终端抓屏 |
| **云端代理，可由 CLI 调度** | CLI 只提交/查看远端任务，实际 agent 在云 VM/容器运行 | 必须把“本地 launcher 状态”和“远端 run 状态”拆开 |
| **IDE / 终端产品中的 agent** | agent 主要嵌入编辑器或完整终端产品，CLI 可能只是附属入口 | 只有存在独立可执行入口才进入 S0 扫描候选 |
| **已停运 / 更名 / 迁移** | 旧命令仍可能存在，但官方已给出替代品或停止维护 | 只做别名/历史兼容，不应成为新适配主目标 |

“全量”没有永久边界：新 CLI 与 ACP adapter 会持续出现。本文用两层覆盖降低遗漏：

1. 对 23 个市场重要产品做深度核验；
2. 用 [ACP 官方动态 Registry](https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json) 收录当前可核验的完整 ACP 目录，再补充未进入 ACP 的代表性 CLI。

## 2. 结论先行

### 2.1 对 Vibing 最有价值的不是品牌数量，而是可观测接口

| 优先级 | 监听手段 | 代表产品 |
|---|---|---|
| 1 | 原生 JSONL / stream-json 事件 | Claude Code、Codex、Gemini、Copilot、Cursor、Amp、Cline、Qwen、OpenCode、Grok、Kimi |
| 2 | ACP / RPC / 本地 server API / SSE | OpenCode ACP + `/event`、Pi RPC、Kimi ACP/Web、Grok ACP、Devin ACP、Goose ACP、Qwen daemon |
| 3 | 生命周期 hooks | Claude Code、Codex、Gemini、Cline、Kimi、Grok、Kiro、Amp；Crush 目前仅初步 `PreToolUse` |
| 4 | 本地 session/transcript/数据库旁路 | Crush、Aider、OpenCode、Cline、Qwen、Pi |
| 5 | PTY 文本 / 抓屏兜底 | Aider、Kiro 当前通用 chat、Oz 本地 run、Crush 实时 run |

推荐首批深适配顺序：

1. **P0**：Claude Code、Codex CLI、Gemini CLI、OpenCode、Cursor Agent、Cline CLI、Qwen Code、Amp。
2. **P1**：Kimi Code、Grok Build、Pi、GitHub Copilot CLI、Goose、Crush、Warp/Oz。
3. **P2**：Devin CLI/Cloud、Kiro CLI、Aider。
4. **P3**：Continue CLI（已停止主动维护）以及纯历史别名。

### 2.2 不要默认替用户绕过权限

当前 [launchOptions.ts](../src/app/launchOptions.ts) 把权限绕过参数写进品牌元数据：Codex `--full-auto`、Claude `--dangerously-skip-permissions`、Gemini `--yolo`、Aider `--yes`。这有三项问题：

- 安全语义不应由“品牌”决定，应由独立的启动权限配置决定；
- 最新 Codex 官方手册已把 `--full-auto` 标为 deprecated，新脚本建议显式使用 `--sandbox workspace-write`；
- 多数产品的非交互模式本身已有明确的 permission/approval 参数，默认绕过会掩盖 `needs-you` 状态。

建议把 `defaultArgs` 拆成 `safeDefaultArgs`、用户显式选择的 `permissionProfile` 与 adapter 运行参数；默认保留产品自己的审批机制。Codex 依据：[官方非交互文档](https://developers.openai.com/codex/noninteractive)。

## 3. 深度产品目录

### 3.1 Claude Code（Anthropic）

- **类别 / 状态**：活跃的本地交互 CLI/TUI，也提供 headless 与 Agent SDK；CLI 本体为专有软件，公开仓库的 [LICENSE](https://github.com/anthropics/claude-code/blob/main/LICENSE.md) 为“all rights reserved”，不是开源许可证。
- **命令 / 包 / OS**：`claude`；旧 npm 包 `@anthropic-ai/claude-code` 仍可见但官方已推荐原生安装；macOS 13+、Windows 10/Server 2019+、Ubuntu/Debian/Alpine，支持原生 Windows 与 WSL。[安装与系统要求](https://code.claude.com/docs/en/installation)
- **模型 / 认证 / 价格**：Claude 模型；Claude.ai Pro/Max/Team/Enterprise、Anthropic Console/API，也支持 Amazon Bedrock、Google Vertex AI、Microsoft Foundry。免费 Claude.ai 计划不含 Claude Code；订阅或 API/云厂商按各自费率。[认证](https://code.claude.com/docs/en/authentication)
- **交互 / 非交互 / 会话**：`claude` 交互；`claude -p` headless；支持 `text`、`json`、`stream-json`、JSON Schema 结构化结果，支持 session ID、continue/resume/fork，Agent SDK 提供 TypeScript/Python 编程接口。[headless](https://code.claude.com/docs/en/headless)
- **扩展 / 观测**：最完整的一组 Hooks、Skills、subagents/agent teams、plugins/marketplaces、MCP、LSP 与 monitors；hooks 有结构化 JSON 输入输出并覆盖 tool、permission、notification、session 等生命周期。[Hooks](https://code.claude.com/docs/en/hooks) · [Plugins](https://code.claude.com/docs/en/plugins)
- **Vibing 价值**：**P0**。优先用 stream-json 或 hooks；`Notification`、`PermissionRequest`、`Stop`、`SessionEnd` 可直接映射 `needs-you/done/exited`，无须抓屏。

### 3.2 OpenAI Codex CLI

- **类别 / 状态**：活跃的本地 CLI/TUI，另有 `codex exec`、SDK、App Server、MCP server 和可由 CLI 调度的 Codex cloud；不要把本地 CLI 与云任务混为一类。
- **命令 / 包 / 许可 / OS**：`codex`，npm `@openai/codex`，亦有原生安装器/Homebrew；仓库 [openai/codex](https://github.com/openai/codex) 为 Apache-2.0。macOS、Linux、WSL2、原生 Windows 均有正式路径和 sandbox 实现。
- **模型 / 认证 / 价格**：OpenAI Codex 模型；支持 ChatGPT 登录或 API key，本地 CLI 两者皆可，Codex cloud 需要 ChatGPT。ChatGPT 登录消耗相应计划额度；API key 按 OpenAI API 价格。[认证](https://developers.openai.com/codex/auth)
- **交互 / 非交互 / 会话**：`codex` TUI；`codex exec` headless；`--json` 输出 JSONL，事件含 `thread.started`、`turn.*`、`item.*`、error 与 usage，`--output-schema` 约束最终 JSON；`codex exec resume` 可续接，`--ephemeral` 可不持久化。[非交互模式](https://developers.openai.com/codex/noninteractive)
- **扩展 / 观测**：MCP client、`codex mcp-server`、Skills、Plugins/marketplaces、AGENTS.md、rules、Hooks；App Server 提供 JSONL-over-stdio、WebSocket/Unix socket 的 thread/turn 协议。[MCP](https://developers.openai.com/codex/mcp) · [App Server](https://developers.openai.com/codex/app-server) · [Hooks](https://developers.openai.com/codex/hooks)
- **Vibing 价值**：**P0**。首选 `codex exec --json` 或 App Server；交互 TUI 可接 hooks/session rollout。不要继续把 deprecated `--full-auto` 设为默认。

### 3.3 OpenCode（Anomaly）

- **类别 / 状态**：活跃的开源本地 TUI；本质上是 client/server 架构，同时有 Desktop/Web/ACP。`opencode`、npm `opencode-ai`，MIT；macOS、Linux、Windows（官方建议 Windows 优先 WSL）。[仓库与安装](https://github.com/anomalyco/opencode)
- **模型 / 认证 / 价格**：通过 models.dev 接入大量 provider，也有 OpenCode Zen/Go；支持 provider API key、部分订阅 OAuth 与自定义兼容端点。客户端免费；推理或官方托管按所选 provider/计划计费。[Providers](https://opencode.ai/docs/providers)
- **交互 / 非交互 / 会话**：`opencode` TUI；`opencode run` headless，`--format json` 为原始 JSON 事件；可 `--continue/--session`；`session list --format json`，session 可 export/import JSON。[CLI](https://opencode.ai/docs/cli)
- **扩展 / 观测**：`opencode serve` 暴露 HTTP API，server `/event` 提供 SSE；`opencode acp` 通过 stdin/stdout nd-JSON；MCP、plugins 与 plugin hooks、agents/skills 均是正式扩展面。[Server](https://opencode.ai/docs/server) · [Plugins](https://opencode.ai/docs/plugins) · [MCP](https://opencode.ai/docs/mcp-servers)
- **Vibing 价值**：**P0**。由 Vibing 启动固定 loopback port 的 `serve` 并订阅 event，是比 TUI 文本更稳的长期方案；也可直接使用 ACP。

### 3.4 Pi coding agent

- **类别 / 状态**：活跃的开源、本地、极简交互 coding agent，同时提供 SDK 与 RPC；当前主包 `@earendil-works/pi-coding-agent`，命令 `pi`，MIT；Node.js 跨 macOS/Linux/Windows/Termux。项目在 2026 年迁移到 `earendil-works/pi`，旧 `@mariozechner/pi-coding-agent` / `badlogic/pi-mono` 只应作为历史识别名。[当前官方 monorepo](https://github.com/earendil-works/pi) · [当前 npm 包](https://www.npmjs.com/package/@earendil-works/pi-coding-agent)
- **模型 / 认证 / 价格**：多 provider，含 Anthropic、OpenAI/Codex、Gemini、Bedrock、Vertex、Azure、OpenRouter、xAI、Kimi、MiniMax、Ollama/兼容服务等；支持 API key，也可登录 Claude/ChatGPT/Copilot 订阅。Pi 本身免费，推理按 provider。
- **交互 / 非交互 / 会话**：`pi` TUI；`pi -p` 单次打印；`--mode json` 输出 JSONL 全事件；`--mode rpc` 在 stdin/stdout 提供 JSON 协议；session 文件支持 tree、fork、clone、compact、export。[Usage](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/usage.md) · [RPC](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/rpc.md)
- **扩展 / 观测**：Skills、prompt templates、extensions、themes、Pi packages、自定义 tools/providers；SDK 可直接 subscribe agent events。Pi 不以 MCP 为主要内核扩展面，具体第三方 MCP 能力应按当前 extension 验证，不要凭“多 provider”推断。[SDK](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sdk.md)
- **Vibing 价值**：**P1**。`pi --mode rpc` 是语言无关、进程隔离的理想 adapter；JSON 模式可作为更轻量监听。

### 3.5 Kimi Code（Moonshot AI）

- **类别 / 状态**：活跃的新一代本地 TypeScript CLI/TUI；当前仓库/包为 `MoonshotAI/kimi-code`、`@moonshot-ai/kimi-code`，命令仍为 `kimi`，MIT。旧 Python [MoonshotAI/kimi-cli](https://github.com/MoonshotAI/kimi-cli) 为 Apache-2.0，官方已宣布逐步收尾并自动迁移数据，必须区分新旧实现。
- **OS / 模型 / 认证**：macOS、Linux、Windows PowerShell（Windows 需 Git for Windows）；Kimi OAuth/会员、Kimi Platform API key，也可配置 Anthropic、OpenAI/OpenAI Responses、Gemini/Vertex 及兼容 provider。[安装](https://www.kimi.com/code/docs/en/kimi-code-cli/guides/getting-started.html) · [Providers](https://www.kimi.com/code/docs/en/kimi-code-cli/configuration/providers.html)
- **交互 / 非交互 / 会话**：`kimi` TUI；`kimi -p` headless，`--output-format text|stream-json`；`-S/--session`、`-c/--continue`；`kimi acp` 是 JSON-RPC stdio；`kimi web` 提供带 bearer token 的本地 REST/WebSocket/Web UI，另有 session export/visualizer。[命令参考](https://www.kimi.com/code/docs/en/kimi-code-cli/reference/kimi-command.html)
- **扩展 / 观测**：丰富 hooks、MCP（stdio/HTTP/SSE）、Skills、Agents、Plugins/marketplace；hook stdin 带 `hook_event_name/session_id/cwd`，退出码可允许或阻止。[Hooks](https://www.kimi.com/code/docs/en/kimi-code-cli/customization/hooks.html) · [MCP](https://www.kimi.com/code/docs/en/kimi-code-cli/customization/mcp.html) · [Plugins](https://www.kimi.com/code/docs/en/kimi-code-cli/customization/plugins.html)
- **价格 / Vibing**：Kimi 会员额度或 Kimi Platform 按量；**P1**。stream-json、hooks、ACP 和本地 Web 服务均可做旁路，优先级远高于 TUI 抓屏；扫描需识别同名命令背后的新旧版本。

### 3.6 Grok Build（SpaceXAI / xAI）

- **类别 / 状态**：2026 年活跃发布的本地 TUI + headless + ACP coding agent。命令 `grok`，npm 可用 `@xai-official/grok`；官方仓库 [xai-org/grok-build](https://github.com/xai-org/grok-build) 的一方代码为 Apache-2.0，覆盖 macOS、Linux、WSL 与原生 Windows。
- **模型 / 认证 / 价格**：默认 Grok 4.5，也支持自定义 OpenAI-compatible model/base URL；浏览器 OIDC、device code、企业 OIDC、外部 auth command、`XAI_API_KEY`。Grok 产品可免费试用/用 SuperGrok 额度，API key 按 xAI API 价格。[Overview](https://docs.x.ai/build/overview) · [Enterprise/Auth](https://docs.x.ai/build/enterprise)
- **交互 / 非交互 / 会话**：`grok` TUI；`grok -p` headless；`plain|json|streaming-json`；`--session-id/--resume/--continue`，sessions 存于 `~/.grok/sessions`；`grok agent stdio` 提供 ACP JSON-RPC。[Headless](https://docs.x.ai/build/cli/headless-scripting)
- **扩展 / 观测**：AGENTS.md、Skills、Plugins/marketplaces、Hooks、MCP、LSP、subagents；高度兼容 Claude Code 的 marketplaces/plugins/skills/MCP/hooks/instructions。[扩展](https://docs.x.ai/build/features/skills-plugins-marketplaces) · [CLI](https://docs.x.ai/build/cli/reference)
- **Vibing 价值**：**P1**。streaming-json 或 ACP 均很强；仓库 Apache-2.0 与 ACP Registry 对 Grok entry 的 proprietary 标注存在官方元数据冲突，产品适配应按 CLI 仓库许可证，分发 ACP bundle 时再单独复核。

### 3.7 Devin CLI 与云端 Devin（Cognition）

- **类别 / 状态**：两个不同产品。`devin`/Devin CLI 是直接操作本地文件与环境的本地 terminal agent；云端 Devin 在 Cognition VM 中运行，可由 Web/API/本地 CLI `/handoff` 调度。[官方区分说明](https://cli.devin.ai/reference/commands) · [云端 API](https://docs.devin.ai/api-reference/overview)
- **许可 / OS / 认证 / 价格**：专有；macOS、Linux、WSL、原生 Windows，ACP Registry 还列出 x64/ARM64 二进制；本地登录复用 Devin/企业身份。Free/Pro/Max/Teams 等计划的额度同时覆盖 Devin、Devin CLI/Windsurf，企业功能另议。[计划说明](https://docs.devin.ai/admin/billing/self-serve)
- **交互 / 非交互 / 会话**：`devin` 交互，可在命令后预载 prompt；`devin acp` 在 [ACP Registry](https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json) 注册；本地 `/handoff` 把对话上下文和当前 git 分支交给云端。云 API 可创建、查询、暂停/继续 session，列消息，并在创建时传 `structured_output_schema`。[handoff](https://docs.devin.ai/work-with-devin/devin-cli) · [创建云 session](https://docs.devin.ai/api-reference/v1/sessions/create-a-new-devin-session)
- **扩展 / 观测**：本地 CLI 官方目录包含 MCP、Skills、Plugins、Hooks、ACP；云端则以 API session/status/messages 为观测面。两者不能共用“进程仍活着=agent 仍工作”的判断。
- **Vibing 价值**：**P2**。本地 CLI 用 ACP/hooks；`/handoff` 后建立 `localSessionId ↔ devin_id`，转为轮询/订阅云 API。扫描表里显示 Devin CLI，云 Devin 应是 adapter capability 而不是另一个本地可执行品牌。

### 3.8 Gemini CLI（Google）

- **类别 / 命令 / 许可 / OS**：活跃本地 TUI + headless + ACP；`gemini`、npm `@google/gemini-cli`、Apache-2.0；官方建议 macOS 15+、Windows 11 24H2+、Ubuntu 20.04+、Node 20+。[仓库](https://github.com/google-gemini/gemini-cli) · [安装](https://geminicli.com/docs/get-started/installation/)
- **模型 / 认证 / 价格**：Gemini 系列；个人 Google 登录、Gemini API key 或 Vertex AI。个人/Google AI Pro/Ultra 有不同日配额，付费 API/Vertex 按量；数字易变，见[官方配额与价格](https://geminicli.com/docs/resources/quota-and-pricing/)。
- **模式 / 会话**：`gemini` TUI，`-p` headless；`--output-format json|stream-json`，JSONL 包括 init/message/tool_use/tool_result/error/result；项目级完整 session，支持 `--resume` 与 `--list-sessions`。[Headless schema](https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/headless.md) · [Sessions](https://geminicli.com/docs/cli/session-management/)
- **扩展 / Vibing**：Hooks、extensions、Agent Skills、MCP、commands、ACP、subagents；**P0**，直接消费 stream-json 与 session ID/tool event。当前 `--yolo` 不应作为 Vibing 默认参数。

### 3.9 GitHub Copilot CLI

- **类别 / 命令 / 许可 / OS**：当前产品为独立 `copilot`，npm `@github/copilot`，本地 TUI + programmatic + remote sessions；Linux/macOS/Windows/WSL。仓库公开但使用[自定义专有许可证](https://github.com/github/copilot-cli/blob/main/LICENSE.md)，不是开源。旧 `gh copilot` 扩展是另一代产品，不应再作为主入口。[官方仓库](https://github.com/github/copilot-cli)
- **模型 / 认证 / 价格**：GitHub OAuth/device/browser、GitHub CLI token 或 PAT；模型目录包含 Anthropic、OpenAI、Google、Microsoft 等，随计划动态变化。Free 含有限额度，Pro/Pro+/Max/Business/Enterprise 按订阅与 AI credits。[Plans](https://docs.github.com/en/copilot/get-started/plans)
- **模式 / 会话**：交互；`-p/--prompt` 非交互；`--output-format text|json`，json 为 JSONL，`-s` 只给最终文本；`--resume/--continue/--session-id`，可 share Markdown 与连接 remote。[CLI reference](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-command-reference) · [Programmatic](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-programmatic-reference)
- **扩展 / Vibing**：GitHub MCP、自定义 MCP、Hooks、Plugins/marketplaces、Skills、agents、LSP、ACP；**P1/P0**。协议条件优秀，但许可证、账号和企业策略会影响自动化测试矩阵。

### 3.10 Cursor Agent CLI

- **类别 / 命令 / OS / 许可**：专有本地 terminal agent，可 handoff Cursor Cloud Agent；当前主入口 `agent`，`cursor-agent` 为兼容命令；macOS/Linux/Windows WSL，非原生 PowerShell agent。[安装](https://docs.cursor.com/en/cli/installation) · [条款](https://cursor.com/en-US/terms-of-service)
- **模型 / 认证 / 价格**：Cursor 浏览器登录或 `CURSOR_API_KEY`；Cursor Router/Composer 与多家 frontier models，随计划可用。Hobby 有限免费，Pro 等个人/Teams 套餐与额外用量，见[价格](https://cursor.com/pricing)。
- **模式 / 会话**：交互；`-p/--print` headless，`--output-format text|json|stream-json`；JSONL 有 system init、assistant delta、tool call start/complete、result、session/request ID；支持 resume/ls 与 cloud handoff。[参数](https://docs.cursor.com/en/cli/reference/parameters) · [输出 schema](https://docs.cursor.com/en/cli/reference/output-format)
- **扩展 / Vibing**：MCP、Rules、Hooks（含 Claude Code 兼容）、Skills、subagents、plugins；**P0**。stream-json 是最成熟的可观察面之一；扫描需同时识别 `agent` 与 `cursor-agent`，且要避免把通用的 `agent` 名误判为 Cursor。

### 3.11 Aider

- **类别 / 命令 / 许可 / OS**：活跃的开源本地 terminal pair programmer，偏 Git 编辑工作流；`aider`、PyPI `aider-chat`/`aider-install`、Apache-2.0；Windows/macOS/Linux。[仓库](https://github.com/aider-ai/aider) · [安装](https://aider.chat/docs/install.html)
- **模型 / 认证 / 价格**：支持 OpenAI、Anthropic、Gemini、xAI、DeepSeek、OpenRouter、Bedrock、Vertex、Azure、Ollama、OpenAI-compatible 等；BYOK/本地，Aider 免费、推理按 provider。[Models](https://aider.chat/docs/llms.html)
- **模式 / 会话**：交互；`--message/-m`、`--message-file` 单次脚本；没有官方稳定 JSON/JSONL agent-event 协议。历史主要写 `.aider.chat.history.md`、input history 与可选 LLM history，`--restore-chat-history`，不是现代 session UUID API。[Scripting](https://aider.chat/docs/scripting.html) · [Options](https://aider.chat/docs/config/options.html)
- **扩展 / Vibing**：无原生 MCP、通用 lifecycle hooks 或正式 plugin 协议；`--watch-files`、lint/test、第三方 IDE plugins 不是等价替代。**P2**，做 legacy/text adapter；PTY + history tail + git change 是主要信号。

### 3.12 Goose（Agentic AI Foundation，原 Block）

- **类别 / 许可 / OS**：活跃的开源本地 general-purpose agent，Desktop + CLI + API/ACP；`goose`，Apache-2.0；macOS/Linux/Windows。项目已迁至 Linux Foundation 旗下 AAIF。[官方仓库](https://github.com/aaif-goose/goose)
- **模型 / 认证 / 价格**：Anthropic/OpenAI/Google/Ollama/OpenRouter/Azure/Bedrock 等 15+ provider，也可经 ACP 使用部分现有订阅；客户端免费，推理按 provider。[Providers](https://github.com/aaif-goose/goose/blob/main/documentation/docs/getting-started/providers.md)
- **模式 / 会话**：`goose session` 交互，`goose run` 非交互；源码定义 `text|json|stream-json`、`--no-session`、`--resume`、session id/name；session 可 list/export/import，支持导入 Claude Code/Codex/Pi JSONL。[CLI source](https://github.com/aaif-goose/goose/blob/main/crates/goose-cli/src/cli.rs)
- **扩展 / Vibing**：70+ MCP extensions、Skills、Plugins、Recipes、subagents、ACP；未核实到与 Claude/Cline 等价的通用 lifecycle hooks。**P1**，优先验证 stream-json schema 与 ACP，不要假定 hooks 存在。

### 3.13 Cline CLI

- **类别 / 命令 / 许可 / OS**：活跃开源本地 terminal agent，与 IDE/SDK 共用 core；命令和 npm 包均 `cline`，Apache-2.0；macOS/Linux/Windows arm64/x64。[仓库](https://github.com/cline/cline) · [CLI README](https://github.com/cline/cline/blob/main/apps/cli/README.md)
- **模型 / 认证 / 价格**：Cline OAuth、ChatGPT subscription、Anthropic/OpenAI/Gemini/OpenRouter/Bedrock/Vertex/Cerebras/Groq/兼容与本地 provider；客户端免费，可 BYOK 或使用 Cline Provider 按量，Enterprise 定制。[价格](https://cline.bot/pricing)
- **模式 / 会话**：交互；`cline --json` 或 pipe/redirect headless，NDJSON 含 `ask|say`、reasoning、partial；SQLite session DB、`cline history`，task/session 带 token/cost/checkpoints，可 resume。[CLI overview](https://docs.cline.bot/usage/cli-overview) · [CLI reference](https://docs.cline.bot/cli/cli-reference)
- **扩展 / Vibing**：MCP、8 类 Hooks、Skills、Rules、Plugins（npm/git/local）、ACP、agent teams/scheduling/connectors。**P0**，taskId + NDJSON + hook schema + session DB 足以做深适配。[Hooks](https://docs.cline.bot/customization/hooks)

### 3.14 Kiro CLI（原 Amazon Q Developer CLI）

- **类别 / 状态 / 许可**：AWS 专有本地 terminal agent + IDE/ACP/云服务；主命令 `kiro-cli`。Amazon Q Developer CLI 已正式 rebrand，旧 `q` 不应成为长期独立 adapter；Q IDE plugins/订阅已公布 2027-04-30 EOL，新能力迁入 Kiro。[迁移](https://docs.aws.amazon.com/amazonq/latest/qdeveloper-ug/upgrade-to-kiro.html) · [EOL 公告](https://aws.amazon.com/blogs/devops/amazon-q-developer-end-of-support-announcement/) · [许可](https://kiro.dev/license/)
- **OS / 模型 / 认证 / 价格**：macOS、Windows 11、Linux；GitHub/Google/Builder ID/IAM Identity Center/企业 IdP，headless API key 要付费计划。Auto、Claude 与多种 open-weight 模型，依地区/计划；Free 与多档 Pro/Power credits，见[官方价格](https://kiro.dev/pricing/)。
- **模式 / 会话**：交互；`kiro-cli chat --no-interactive` headless；通用 chat 当前没有官方 JSONL event stream，只有部分管理命令 JSON。逐 turn 保存项目会话，支持 resume/list/save/load。[Headless](https://kiro.dev/docs/cli/headless/) · [Commands](https://kiro.dev/docs/cli/reference/cli-commands/)
- **扩展 / Vibing**：MCP、Smart Hooks、custom agents、steering、Skills、subagents、Powers；**P2**。Windows 原生与 hooks 很有价值，但实时主通道目前仍偏 PTY/hook 辅助。[Hooks](https://kiro.dev/docs/cli/hooks/)

### 3.15 Qwen Code

- **类别 / 命令 / 许可 / OS**：活跃开源本地 TUI/headless，另有 experimental daemon/ACP、IDE/Desktop/SDK；`qwen`、npm `@qwen-code/qwen-code`、Apache-2.0；Linux/macOS/Windows。[仓库](https://github.com/QwenLM/qwen-code)
- **模型 / 认证 / 价格**：Qwen/ModelStudio、OpenAI-compatible、Anthropic、Gemini、Vertex、本地 Ollama/vLLM；原 Qwen OAuth 免费层已结束，现为 Coding/Token Plan、API key/BYOK，以 provider 定价。[Providers](https://qwenlm.github.io/qwen-code-docs/en/users/configuration/model-providers/)
- **模式 / 会话**：`qwen` TUI，`-p` headless；`text|json|stream-json`，支持 `--json-schema`；JSONL 包含 system session_start、assistant、result，可续接 session；项目 JSONL sessions 保存 history/tool output/compaction。双向 `--input-format stream-json` 仍在建设中。[Headless](https://qwenlm.github.io/qwen-code-docs/en/users/features/headless/)
- **扩展 / Vibing**：MCP、Hooks、extensions/plugins、Skills、memory、agents/teams、LSP、worktrees、`qwen serve` HTTP+SSE/ACP。**P0**，结构化输出、session JSONL、daemon/ACP、Windows 均完整；但要给实验输入协议做版本门槛。[Roadmap](https://qwenlm.github.io/qwen-code-docs/en/developers/roadmap/)

### 3.16 Crush（Charm）

- **类别 / 命令 / 许可 / OS**：活跃的本地多模型 TUI agent；`crush`、npm `@charmland/crush`、Homebrew/WinGet/Go；macOS/Linux/Windows/BSD/Android。FSL-1.1-MIT，两年后转 MIT，当前应称 fair-source/source-available。[仓库](https://github.com/charmbracelet/crush)
- **模型 / 认证 / 价格**：覆盖 Anthropic/OpenAI/Gemini/Bedrock/Azure/Vertex/Groq/OpenRouter/Hugging Face/Cerebras/Z.ai/Kimi/OpenCode/本地兼容 provider；Crush 无席位费，按 API 或外部 coding plan。
- **模式 / 会话**：`crush` TUI；`crush run` 非交互，支持 stdin/session/continue，但实时只有文本；本地 SQLite。`crush session list/show/... --json` 可事后取得 cost/token/model/provider/text/reasoning/tool timeline。[run source](https://raw.githubusercontent.com/charmbracelet/crush/main/internal/cmd/run.go) · [session source](https://raw.githubusercontent.com/charmbracelet/crush/main/internal/cmd/session.go)
- **扩展 / Vibing**：MCP、Skills、LSP；Hooks 仍 preliminary 且只有 `PreToolUse`，无独立通用 plugin API。**P1**，采用“实时文本 + 结束后 session JSON 补全”的双阶段 adapter。[Hooks](https://github.com/charmbracelet/crush/blob/main/internal/skills/builtin/crush-config/SKILL.md)

### 3.17 Warp Agent / Oz CLI

- **类别 / 状态 / 命令**：活跃的 Agentic Development Environment 本机/云端运行器；当前命令 `oz`/`oz-preview`，旧 `warp-cli` 已迁移；持续交互主要在 Warp app，`oz agent run` 是本地非交互 run，`run-cloud` 调度云端。[Oz CLI](https://docs.warp.dev/reference/cli)
- **许可 / OS / 价格**：Warp 客户端除 UI 的 MIT 部分外主要为 AGPL-3.0；托管 Oz 服务仍是商业服务。macOS/Linux，Windows 由 Warp app 捆绑 `oz`；Free/Build/Max/Business/Enterprise 计划见[价格](https://www.warp.dev/pricing/)与[仓库](https://github.com/warpdotdev/Warp)。
- **模型 / 认证 / 扩展**：Warp 托管多家模型，Free 可 BYO inference、Enterprise 可 BYOLLM；Warp 登录或 `WARP_API_KEY`；MCP、Skills、Profiles/permissions。未核验到通用 lifecycle hooks/plugin API。[MCP](https://docs.warp.dev/reference/cli/mcp-servers)
- **会话 / Vibing**：CLI 未文档化实时 JSONL；云 run 有 ID/status/session link/transcript 与 API/SDK。**P1**，必须拆成 local process adapter 和 cloud run adapter；扫描识别 `oz`、`oz-preview`，仅兼容旧 `warp-cli`。[API/SDK](https://docs.warp.dev/reference/api-and-sdk/quickstart)

### 3.18 Amp（原 Sourcegraph Amp）

- **类别 / 状态 / 命令 / 许可**：高度活跃的专有 terminal-first coding agent + Web threads/remote runners；`amp`、npm `@ampcode/cli`，旧 `@sourcegraph/amp` 已更名；macOS/Linux/Windows WSL。[Manual](https://ampcode.com/manual) · [License](https://ampcode.com/terms)
- **模型 / 认证 / 价格**：opinionated routing，当前不同 mode 组合 OpenAI、Claude、GLM、Gemini 等模型，也支持部分 BYOK/关联订阅；网页登录，CI 用 `AMP_API_KEY`；PAYG 原价转递并有多档订阅，见[Modes](https://ampcode.com/modes)与[Subscriptions](https://ampcode.com/news/subscriptions)。
- **模式 / 会话**：`amp` TUI；`amp -x/--execute` 非交互；`--stream-json`/`--stream-json-thinking` 实时 JSONL，`--stream-json-input` 支持多轮 stdin，官方说明尽量兼容 Claude Code。Thread 跨 CLI/Web 同步，可 continue/share/archive/remote control。[JSON schema](https://ampcode.com/manual/appendix)
- **扩展 / Vibing**：MCP、Skills、TypeScript Plugins；plugin hooks 覆盖 session.start、agent.start、tool.call/result、agent.end。**P0**，原生 JSONL + 多轮输入 + thread ID + 生命周期事件几乎是理想 adapter。[Plugin API](https://ampcode.com/manual/plugin-api)

### 3.19 Continue CLI

- **类别 / 状态 / 命令 / 许可**：`cn`、npm `@continuedev/cli`、Apache-2.0，macOS/Linux/Windows；官方已发布 final 2.0.0 并停止主动维护，仓库 read-only，因此是历史兼容目标而非增长目标。[当前状态](https://docs.continue.dev/index) · [仓库](https://github.com/continuedev/continue)
- **模型 / 认证 / 价格**：多 provider、Ollama/self-hosted；软件免费、推理按 provider。旧 1.x docs 的 Continue login/credits 与 2.0 “removing authentication” 有冲突，最终版必须实测，不在 adapter 中硬编码旧认证假设。
- **模式 / 会话**：`cn` TUI，`cn -p` headless，`--format json` 为完成态 JSON；`cn ls --json`、resume/fork/compact，未见正式实时 tool-event JSONL。[Quickstart](https://docs.continue.dev/cli/quickstart) · [TUI/session](https://docs.continue.dev/cli/tui-mode)
- **扩展 / Vibing**：MCP、rules、prompts、agent files；未核验正式 pre/post tool hooks。**P3**，保留扫描/基础 JSON 兼容，不投入重型语义解析。[MCP](https://docs.continue.dev/customize/deep-dives/mcp)

### 3.20 Factory Droid

- **类别 / 状态 / 命令 / 许可**：Factory 的活跃商业 coding agent CLI，命令 `droid`，专有许可；官方产品同时面向本地开发与企业软件交付。[Factory CLI](https://factory.ai/product/cli)
- **分发 / OS / 认证与价格**：ACP Registry 以 npm `droid` 分发；账号、模型路由和费用由 Factory 服务/企业计划管理。官方 Registry 没有声明独立开源客户端许可证，不能因 npm 可安装而标成开源。[ACP entry](https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json)
- **模式 / 会话 / 扩展**：Registry 的 ACP 启动参数是 `droid exec --output-format acp-daemon`，证明其具有面向宿主应用的结构化 daemon 模式；产品也提供 CLI 交互/执行工作流。MCP、会话和企业 policy 的精确能力应在购买/安装后按官方 CLI reference 实测。
- **Vibing 价值**：**P2**。先通过 ACP 通用 adapter 接入，不为专有 daemon 重复写品牌协议；扫描 `droid` 时要避免与其他同名工具冲突，必须校验版本输出。

### 3.21 Auggie CLI（Augment Code）

- **类别 / 状态 / 命令 / 许可**：Augment Code 的活跃商业 terminal agent；命令/包为 `auggie`、`@augmentcode/auggie`，专有许可，核心卖点是其 codebase context engine。[Auggie 官方页](https://www.augmentcode.com/product/auggie)
- **分发 / 模型 / 认证与价格**：npm/npx 分发，登录与模型服务由 Augment 账号及相应个人/团队/企业计划提供；Registry 没有给出可再分发的开源许可。[ACP entry](https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json)
- **模式 / 会话 / 扩展**：官方 Registry 用 `@augmentcode/auggie --acp` 启动，故可作为本地 ACP agent；交互 TUI、headless 和会话细节应以安装版本的官方命令参考为准，不从 ACP presence 反推未声明的 hooks/JSONL。
- **Vibing 价值**：**P2**。ACP 通用接入优先，专有账号使 CI/实机回归矩阵成本高于开源 BYOK 工具。

### 3.22 Mistral Vibe

- **类别 / 状态 / 命令 / 许可**：Mistral AI 的开源 terminal coding agent，命令 `vibe`，Apache-2.0；官方仓库提供安装、配置和开发事实。[mistralai/mistral-vibe](https://github.com/mistralai/mistral-vibe)
- **模型 / 认证 / 价格**：面向 Mistral 模型与 Mistral API 认证；客户端开源，推理按 Mistral API/相应计划。具体默认模型和价格易变，实施时从官方模型/价格页动态核验。
- **模式 / 会话 / 扩展**：ACP Registry 以 `mistral-vibe` entry 发布并提供可调用分发，说明存在标准 ACP 集成路径；是否另有稳定 JSONL、hooks、MCP 和 session export，应以实际安装版本的官方文档为准。[ACP entry](https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json)
- **Vibing 价值**：**P2**。模型厂商直营、开源且有 ACP，适合先走通用 ACP adapter，再根据用户安装量决定是否增加原生事件映射。

### 3.23 Snowflake Cortex Code

- **类别 / 状态 / 命令 / 许可**：Snowflake 的活跃企业 coding agent CLI，命令 `cortex`，专有；重点是与 Snowflake/Cortex 企业数据与治理环境集成。[Cortex Code 官方文档](https://docs.snowflake.com/en/user-guide/cortex-code/cortex-code)
- **分发 / OS / 认证与价格**：ACP Registry 提供 macOS、Linux、Windows 的 x64/ARM64 二进制组合（具体架构视 release），认证与计费依 Snowflake 账号/credits；不是可自由再分发的开源 CLI。[ACP entry](https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json)
- **模式 / 会话 / 扩展**：Registry 的标准入口为 `cortex acp serve`，可由 ACP client 通过结构化协议驱动；其主要价值是企业 Snowflake context，而非通用 BYOK provider 路由。
- **Vibing 价值**：**P2**。通过 ACP 通用 adapter 即可获得较好可观测性；是否加入默认品牌墙取决于 Vibing 的企业用户画像。

## 4. ACP 官方 Registry：动态全量快照

在 2026-08-03 拉取时，[ACP 官方 Registry](https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json) 有 **38** 个 entry。Registry 小时级变化，数字不是永久常量；实际实现应动态读取或固定带时间戳的 snapshot。

| Registry ID | 名称 | Registry 许可标注 | 对 Vibing 的建议 |
|---|---|---:|---|
| `agoragentic-acp` | Agoragentic | MIT | 长尾，P3 |
| `amp-acp` | Amp wrapper | Apache-2.0 | adapter 是第三方 wrapper；产品本体优先原生 stream-json |
| `auggie` | Auggie CLI | proprietary | 企业开发工具，P2 |
| `autohand` | Autohand Code | Apache-2.0 | 长尾，P3 |
| `claude-acp` | Claude Agent wrapper | proprietary | 可选 ACP；Claude 原生 hooks/stream-json 优先 |
| `cline` | Cline | Apache-2.0 | P0 |
| `codebuddy-code` | Tencent CodeBuddy Code | Proprietary | 中国市场候选，P2 |
| `codex-acp` | Codex adapter | Apache-2.0 | 可选 ACP；Codex exec/App Server 优先 |
| `cortex-code` | Snowflake Cortex Code | proprietary | 企业数据平台候选，P2 |
| `corust-agent` | Corust Agent | GPL-3.0-or-later | Rust 垂直长尾，P3 |
| `crow-cli` | crow-cli | Apache-2.0 | 长尾，P3 |
| `cursor` | Cursor | proprietary | P0 |
| `deepagents` | DeepAgents | MIT | agent framework/CLI，P2 |
| `devin` | Devin | proprietary | P2 |
| `dimcode` | DimCode | proprietary | 长尾，P3 |
| `dirac` | Dirac | Apache-2.0 | 新兴 agent，P2/P3 |
| `factory-droid` | Factory Droid | proprietary | 商业 CLI，P2 |
| `fast-agent` | fast-agent | Apache 2.0 | framework 型，P3 |
| `gemini` | Gemini CLI | Apache-2.0 | P0 |
| `github-copilot-cli` | GitHub Copilot | proprietary | P1/P0 |
| `glm-acp-agent` | GLM Agent | Apache-2.0 | 中国模型生态候选，P2 |
| `goose` | Goose | Apache-2.0 | P1 |
| `grok-build` | Grok Build | proprietary* | P1；*与产品源码仓 Apache-2.0 标注冲突，见 §3.6 |
| `harn` | Harn | Apache-2.0 | 长尾，P3 |
| `junie` | JetBrains Junie | proprietary | IDE/ACP agent，P2 |
| `kilo` | Kilo | MIT | CLI/IDE agent，P2 |
| `kimi` | Kimi CLI | MIT | P1 |
| `minion-code` | Minion Code | AGPL-3.0 | 长尾，P3 |
| `mistral-vibe` | Mistral Vibe | Apache-2.0 | 模型厂商 CLI，P2 |
| `nova` | Amazon Nova | proprietary | AWS 候选，P2 |
| `opencode` | OpenCode | MIT | P0 |
| `pi-acp` | pi ACP | MIT | P1 |
| `poolside` | Poolside | proprietary | 企业 agent，P2/P3 |
| `qoder` | Qoder CLI | proprietary | 商业 CLI，P2 |
| `qwen-code` | Qwen Code | Apache-2.0 | P0 |
| `sigit` | siGit Code | Apache-2.0 | 长尾，P3 |
| `stakpak` | Stakpak | Apache-2.0 | DevOps 垂直，P3 |
| `vtcode` | VT Code | MIT | 长尾，P3 |

Registry 证明“支持 ACP”不等于“产品本体开源”，也不等于“ACP 是最佳监听面”。例如 Amp、Claude、Codex 都有更直接的原生接口；Registry 中 adapter 的许可与产品许可必须分别记录。

## 5. Registry 外 / 相邻 / 未独立上市的代表性项目

以下项目没有因为未进入 ACP Registry 就被排除；它们适合进入可配置的社区/长尾候选库，但第一阶段不必逐一做专用语义 adapter。

| 项目 | 定位 / 状态 | 官方来源 | 优先级 |
|---|---|---|---|
| OpenHands CLI | 开源本地/云 agent 平台的 CLI，复杂任务可在 sandbox/runtime 中执行 | [All-Hands-AI/OpenHands](https://github.com/All-Hands-AI/OpenHands) | P2 |
| Plandex | 开源 terminal AI coding engine，面向大任务/plan/worktree | [plandex-ai/plandex](https://github.com/plandex-ai/plandex) | P2/P3 |
| gptme | 开源本地 terminal agent/library，BYOK、多工具、可脚本化 | [gptme/gptme](https://github.com/gptme/gptme) | P3 |
| Open Interpreter | 通用本地 computer/code interpreter CLI，不只面向软件工程 | [openinterpreter/open-interpreter](https://github.com/openinterpreter/open-interpreter) | P3，归 general agent |
| SWE-agent | 研究/自动化软件工程 agent harness，偏 benchmark/headless 而非日常 TUI | [SWE-agent/SWE-agent](https://github.com/SWE-agent/SWE-agent) | 不进默认启动墙 |
| Trae Agent | ByteDance 开源的软件工程 agent harness；`trae-cli run` / `trae-cli interactive`，支持多 provider、MCP 与 trajectory 记录 | [bytedance/trae-agent](https://github.com/bytedance/trae-agent) | P2，研究/可观测性价值高 |
| Aider | 重要非 ACP terminal pair programmer | [aider-ai/aider](https://github.com/aider-ai/aider) | P2，已详述 |
| Crush | 重要非 ACP TUI agent | [charmbracelet/crush](https://github.com/charmbracelet/crush) | P1，已详述 |
| Warp/Oz | 重要非 ACP 本地/云 run CLI | [Warp docs](https://docs.warp.dev/reference/cli) | P1，已详述 |
| Continue CLI | 已停止主动维护的开源 CLI | [Continue](https://docs.continue.dev/index) | P3，已详述 |
| iFlow CLI | 曾是 `iflow` / `@iflow-ai/iflow-cli`，但官方已于 2026-04-17 关闭服务 | [iflow-ai/iflow-cli](https://github.com/iflow-ai/iflow-cli) | 仅 legacy 识别，不进入默认候选 |
| Baidu Comate CLI | 官方 4.0 公告仍写“紧张开发中”，当前正式入口是 IDE 插件/Comate IDE | [百度 Comate 4.0 公告](https://cloud.baidu.com/doc/COMATE/s/xmm4hx69k) | 未上市，不扫描 |
| GLM Coding Plan | Z.ai 的模型额度/兼容 API 方案，官方主要指导接入 Claude Code 等现有 harness；它本身不是另一个 CLI | [Z.ai Quick Start](https://docs.z.ai/devpack/quick-start) | 记为 provider/plan，不记品牌 CLI |
| DeepSeek | 模型/API provider；本次未核验到 DeepSeek 官方发布的独立 coding-agent CLI | [DeepSeek 官方仓库组织](https://github.com/deepseek-ai) | 不把第三方同名 CLI 当官方候选 |

“仅 IDE 扩展”不应自动进入扫描候选；必须有独立可执行入口。相反，Cline、Cursor、Copilot、Junie 等即使有强 IDE 身份，只要官方提供 CLI/ACP binary，就可以进入扫描注册表。

对于只有发布预告、候补名单、内部 beta 名称，却没有官方可安装 binary/package 与运行文档的“未上市 CLI”，本文不把它当成扫描候选。可在市场观察表保留名称，但只有满足“官方安装来源 + 可执行入口 + 至少一种可验证运行模式”后才进入内置 registry；这样能避免把模型名、IDE feature 或营销 demo 误当成产品。

## 6. 更名、迁移与停运陷阱

| 旧名称 / 旧入口 | 当前状态 | 扫描策略 |
|---|---|---|
| Amazon Q Developer CLI / `q` | 正式迁移为 Kiro CLI / `kiro-cli` | 主识别 Kiro；`q` 仅 legacy alias，并提示迁移 |
| Kimi CLI（Python `MoonshotAI/kimi-cli`） | 正在迁移为 TypeScript Kimi Code，命令仍 `kimi` | 用 `--version`/安装元数据区分实现，不新增第二个同名品牌 |
| Sourcegraph Amp / `@sourcegraph/amp` | 当前为 Amp / `@ampcode/cli` | 主识别 `amp`，旧包只作兼容 |
| Warp CLI / `warp-cli` | 当前为 Oz / `oz`、`oz-preview` | 主识别 Oz，旧名兼容 |
| GitHub `gh copilot` | 旧 generation，与当前独立 `copilot` 不同 | 默认只展示 `copilot`；旧扩展作为 legacy |
| Continue CLI | final 2.0.0 后停止主动维护 | 可扫描但标记 archived/maintenance-ended，P3 |
| Devin | 同时有本地 Devin CLI 与云端 Devin | UI/adapter capability 分层，不做两个模糊同名启动项 |

## 7. 对 S0 扫描注册表的建议

扫描注册表不应只存一个 executable 字符串。建议至少保存：

```ts
interface CliCandidateDefinition {
  id: string
  displayName: string
  executables: string[]          // 主名 + 安全的历史别名
  packageHints?: string[]        // npm/PyPI/Homebrew/WinGet 等辅助辨认
  runtimes: ('windows' | 'wsl' | 'macos' | 'linux')[]
  status: 'active' | 'legacy' | 'maintenance-ended'
  modes: ('tui' | 'headless' | 'server' | 'acp' | 'cloud')[]
  observerPriority: ('jsonl' | 'acp' | 'rpc' | 'hooks' | 'server' | 'session' | 'pty')[]
  safeDefaultArgs?: string[]
  versionProbe?: string[]
}
```

首版内置候选建议从当前 6 项扩为：

`claude`、`codex`、`gemini`、`opencode`、`cursor-agent/agent`、`cline`、`qwen`、`amp`、`kimi`、`grok`、`pi`、`copilot`、`goose`、`crush`、`oz`、`devin`、`kiro-cli`、`aider`。

注意：

- `agent`、`qwen` 等短名字容易碰撞，必须用 `--version` 输出或安装路径/包提示确认身份；
- Windows 要区分原生 `.exe/.cmd/.ps1` 与 WSL 内 `command -v`；
- 同名 `kimi` 有新旧实现；
- cloud capability 不是另一个可执行文件；
- 未安装项仍可存在于产品维护的候选定义中，但启动列表是否隐藏/灰显由 SPEC-S §6 决定。

## 8. 对监听适配器架构的建议

不要按品牌写 18 套互不相干的解析器。先按传输抽象，再给品牌补 schema mapper：

```text
Process lifecycle
  ├─ JSONL observer       Claude/Codex/Gemini/Cursor/Amp/Cline/Qwen/...
  ├─ ACP/RPC observer     Pi/Kimi/Grok/OpenCode/Devin/Goose/...
  ├─ Server observer      OpenCode SSE/Kimi WS/Qwen daemon/Codex App Server
  ├─ Hook observer        Claude/Codex/Gemini/Cline/Kimi/Grok/Kiro/...
  ├─ Session observer     Crush/Aider/OpenCode/Qwen/Cline/...
  └─ PTY observer         最后兜底
          ↓
      NormalizedAgentEvent
          ↓
      working / needs-you / done / error / idle / exited
```

标准事件至少应覆盖：

```ts
type NormalizedAgentEvent =
  | { type: 'session-start'; externalSessionId?: string }
  | { type: 'turn-start' }
  | { type: 'tool-start'; tool?: string; requiresApproval?: boolean }
  | { type: 'permission-request'; detail?: string }
  | { type: 'user-input-request'; detail?: string }
  | { type: 'tool-end'; ok: boolean }
  | { type: 'turn-end'; ok: boolean; detail?: string }
  | { type: 'session-end'; reason?: string }
  | { type: 'transport-error'; detail?: string }
```

状态推导要与进程生命周期分开：agent 可能在等待用户但进程活着；也可能本地 launcher 已退出而云端 run 仍在工作。

## 9. 仍需在 PLAN-S 前做的实机验证

官方文档足以确定候选与架构，但以下内容必须通过安装矩阵锁定：

1. 每个 CLI 在 Windows 原生、WSL、macOS/Linux 的实际 executable 名与 `--version` 输出；
2. JSONL schema 的首/尾事件、异常退出时是否仍有 terminal event；
3. TUI 交互模式是否能同时开启 JSON side channel，还是必须换成 headless/server；
4. hooks 能否用启动时临时配置或环境变量注入，避免永久改用户全局配置；
5. session 文件/数据库路径是否稳定、是否有文件锁与隐私风险；
6. ACP adapter 是产品原生、官方 wrapper 还是第三方 wrapper；
7. 云端 run 的认证、轮询限流、完成/等待用户状态枚举；
8. `--dangerously-*`、`--yolo`、`--yes` 等权限参数全部改为显式用户选择后的行为。

这份调研支持 S0 先完成“扫描 → 启动列表”，也给 S1/S2 提供了明确路径：第一参考 CLI 可选 Claude Code/Codex，第二参考 CLI 最好选协议形态不同的 OpenCode 或 Pi，以验证 adapter 抽象不是只服务某一家。
