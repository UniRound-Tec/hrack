# M6 实施计划 —— Codex CLI Observer Adapter

> 状态：**核心 Adapter 已实现并完成 Windows/WSL 真机协议验证；扩展场景继续实施（2026-08-04）**。
>
> 目标：在已冻结的 `AgentObserverAdapter` v1 seam 上，为 Codex CLI 的原生交互 TUI 提供
> Windows、macOS、Linux 与 Windows + WSL 语义监听。首版使用 Codex Stable Hooks，保留用户原有
> TUI、认证、模型、profile、审批与 sandbox 行为；观察失败时诚实降级为 lifecycle-only。
>
> 计划模板：[ADAPTER-ACCEPTANCE-TEMPLATE.md](./ADAPTER-ACCEPTANCE-TEMPLATE.md)。参考实现：
> [Claude Code Hooks](./PLAN-S2-CLAUDE.md) 与 [OpenCode Server/SSE](./PLAN-S3-OPENCODE.md)。
>
> 协议事实核验日期：**2026-08-04**。本机已验证 Windows Codex CLI `0.146.0`、WSL
> Ubuntu-22.04 Codex CLI `0.145.0`；两者均报告 `hooks stable true`，并支持 `-c`、`--profile`、
> `--dangerously-bypass-hook-trust` 与 `--remote`。官方依据：[Hooks](https://learn.chatgpt.com/docs/hooks)、
> [CLI command reference](https://learn.chatgpt.com/docs/developer-commands.md?surface=cli)、
> [App Server](https://learn.chatgpt.com/docs/app-server.md) 与
> [WSL](https://learn.chatgpt.com/docs/windows/wsl.md)。

---

## 1. 结论先行

Codex 首版沿用 S2 已验证的“官方 Hook → 私有 Projector → 统一 AgentEvent”形态，但不照搬旧
vibby 的持久 profile、HTTP endpoint env 和永久 trust bypass：

```text
AgentSessionRuntime.prepare
  → 对所选安装执行有界 hooks capability probe
  → 注入本次启动专属、字节稳定的 inline hook config
  → env 只传 per-session drop 路径和 session route id
  → PTY spawn 原生 codex TUI
  → Hook stdin JSON 原子写入 per-session drop
  → CodexHookDropRoute 消费、限流、清理
  → CodexHookParser → CodexHookProjector
  → AdapterEvent → Runtime normalize/reduce/project
  → Sidebar / Home / History / Floating Window
```

首版的五项架构决策：

1. **Stable Hooks 是主协议。** 不用 transcript 作为稳定接口，不解析 PTY 字节推导权威状态；
2. **保留原生 TUI。** 不在首版把用户会话改造成 `app-server + codex --remote`；
3. **默认不写 `$CODEX_HOME`。** 优先用一次性 `-c hooks=<inline TOML>` 注入，不占用用户唯一
   `--profile`；
4. **默认不绕过 Hook trust。** 不自动附加 `--dangerously-bypass-hook-trust`，更不保存“一次同意、
   永久绕过”的偏好；
5. **全 runtime 统一文件投递。** Windows/macOS/Linux/WSL 都写 per-session 原子 drop，不把
   Ingress token 暴露给 Codex 子进程，也不依赖 `curl.exe`、WSL NAT 或 loopback 转发。

如果 P0 证明 inline hook config 无法在 `/hooks` 中被单独审查并持久信任，则停止 P2，不静默退回
写全局 profile。届时单独评审“带所有权标记、可清理的静态 profile”或“显式每次 bypass”两种例外。

## 2. Adapter 身份与交付边界

| 字段 | 内容 |
|---|---|
| 产品 / `adapterId` | Codex CLI / `codex` |
| 已核验版本 | Windows `0.146.0`；WSL Ubuntu-22.04 `0.145.0` |
| 主协议 | Stable lifecycle Hooks（command handler，stdin JSON） |
| 投递协议 | per-session atomic file drop |
| 后续候选 | App Server JSON-RPC；首版不启用 |
| 实现目标平台 | Windows、macOS、Linux、WSL2 |
| 首版真实门禁 | Windows host + WSL2；macOS/Linux 代码与 fixture 同步完成，真机 smoke 后补 |
| 能力声明 | thinking `phase`；tools `lifecycle`；approvals `structured`；input `none`；usage `none`；messages `none` |
| 明确不做 | 外部 Codex 会话发现、自动审批、Hook 决策、隐藏推理/正文采集、远程控制、全局配置修改 |

没有 Observer 时，Codex 仍由 Runtime 提供 `session.started/session.exited` 生命周期；不能因为 Hook 未
信任、被 policy 禁止或 transport 失败而阻止 TUI 启动。

## 3. 当前官方事实与旧实现取舍

### 3.1 当前可依赖事实

- Hooks 在本机 `0.145.0/0.146.0` 为 `stable true` 且默认开启；prepare 仍需针对所选安装、cwd、
  profile 和 config overrides 做运行时 probe，不能只相信品牌或扫描缓存；
- 当前事件集为 `SessionStart`、`SessionEnd`、`SubagentStart`、`PreToolUse`、
  `PermissionRequest`、`PostToolUse`、`PreCompact`、`PostCompact`、`UserPromptSubmit`、
  `SubagentStop`、`Stop`；
- turn-scoped Hook 提供 `turn_id`，tool lifecycle 提供 `tool_use_id`；`PermissionRequest` 当前没有
  `tool_use_id`，不能假装精确关联；
- `SessionStart.source` 当前为 `startup/resume/clear/compact`；`SessionEnd.reason` 当前只有
  `other`，且 SessionEnd 也可能由 archive/delete、正常关闭或无人连接后超时触发；
- `Stop` 当前官方字段只有 `turn_id`、`stop_hook_active`、`last_assistant_message` 等公共字段，
  **没有**旧实现假设的 `background_tasks`；
- `PostToolUse` 对 Bash 非零退出也会触发，但当前公开字段没有可靠的通用 success/failure 标记；
- Hook command 必须经过信任审查；`--dangerously-bypass-hook-trust` 会绕过本次运行中所有已启用
  Hook source 的审查，不只影响 Vibing；
- Codex `0.134.0+` 的 profile 是 `$CODEX_HOME/<name>.config.toml` 独立层，不再读取旧
  `[profiles.<name>]`；一个进程仍只能选择一个 `--profile`；
- App Server 提供更完整的 thread/turn/item/approval/usage 流，但 Remote TUI 所需 WebSocket
  transport 当前仍被官方标为 experimental/unsupported，不作为首版生产依赖；
- WSL1 自 Codex `0.115` 起不再支持，Vibing 的 WSL Codex 首版只承诺 WSL2。

### 3.2 对旧 vibby 方案的取舍

| 旧实现经验 | 本计划决策 |
|---|---|
| 静态共享 profile 保持 trust hash 稳定 | 保留“Hook definition 字节稳定”原则，但先用一次性 inline config，不默认落盘到 `$CODEX_HOME` |
| endpoint/session 通过 env 传入 | env 只传 drop 路径与 route id；不传 HTTP base token |
| Host curl/PowerShell POST，WSL file drop | 四类 runtime 统一 file drop，Windows 使用原始 stdin bytes |
| 永久记录 trust bypass acknowledgement | 拒绝默认/永久 bypass；首版使用 Codex `/hooks` 正常信任流 |
| 用户带 `-p` 时放弃监听 | inline config 不占 profile；仅在用户显式覆盖/禁用 hooks 时降级 |
| 首轮前合成 SessionStart | 不需要；Runtime 在 PTY spawn 后已有权威 lifecycle `session.started`，Native SessionStart 只做 correlation |
| PreCompact/PostCompact 伪装成 tool call | 不污染 tool 统计；只维护 Adapter 私有 activity，turn 本身保持 working |
| Stop 按 `background_tasks` 判断完成 | 当前 schema 无该字段；禁止依赖，按 `turn_id + stop_hook_active + 后续事件` 收敛 |
| spinner `/esc to interrupt/` 驱动状态 | 权威六态完全不依赖抓屏；可选 caption 必须另做真实 xterm fixture |

## 4. v1 公共契约冻结与模块边界

### 4.1 不增加 Codex 公共接口

Renderer 继续只认识 `AgentApi`、`AgentEvent`、`AgentSessionProjection`。禁止新增：

- `codex:start` / `codex:onHook` / `codex:getStatus` IPC；
- `background_tasks`、`stop_hook_active`、`permission_mode` 等 Codex native 字段；
- Codex 专属 UI status；
- Adapter 直接写 History/Sidebar/Floating store。

`shared/agent-events.ts` 首版不应改动。若真实 fixture 暴露公共模型缺口，必须同时证明 Claude 或
OpenCode 也需要该事实，否则留在 `CodexHookProjector` 私有状态。

### 4.2 建议文件布局

```text
electron/agents/adapters/codex/
  types.ts                    # 不可信 native payload 与私有 fact
  CodexObserverAdapter.ts     # supports / prepare / attach / dispose
  CodexHookConfig.ts          # 稳定 inline TOML、命令与冲突检测
  CodexHookParser.ts          # unknown → validated private fact
  CodexHookProjector.ts       # turn/tool/approval/subagent correlation
  CodexHookDropRoute.ts       # local/WSL drop route、poll、大小限制
  codexSummaries.ts           # basename/command-name 低敏摘要
  index.ts

e2e/fixtures/codex-hooks/
  windows-0.146/
  wsl-0.145/

e2e/
  codex-observer.spec.ts
  codex-real-observer.spec.ts
```

`CodexHookDropRoute` 可以复用 `WslHookDropPoller` 的安全消费逻辑，但先把它泛化为 runtime-neutral
深模块；不得把 Codex 分支塞进 Claude Adapter，也不得提前抽象 Parser/Projector。

## 5. Capability probe、启动参数与冲突

### 5.1 Prepare 时实测

`supports()` 只做廉价品牌/runtime 判断；`prepare()` 对扫描到的准确 executable 执行有界探测：

```text
codex [用户的 profile/config feature 选择] features list
```

规则：

- 严格匹配 `hooks stable true` 才继续；missing/false/timeout → `hooks-unavailable` lifecycle-only；
- Windows/macOS/Linux 直接执行扫描到的绝对路径；WSL 在准确 distro 内执行扫描到的 Linux path；
- probe 最长 3 秒，stderr 只保留有界诊断，不写认证或完整配置；
- 用户显式 `--disable hooks`、`-c features.hooks=false` 或 managed
  `allow_managed_hooks_only=true` 时不覆盖，明确降级；
- 不能只按版本号推断 capability，但把本机版本作为 fixture baseline。

### 5.2 首选 inline config

首版预期通过 `prependArgs` 注入一个字节稳定的 one-off config：

```text
-c <inline hooks table>
```

Hook command 本身只引用固定环境变量名，不包含 session id、端口、drop 实际路径或 workspace，因此
不同 Session 的 Hook hash 保持稳定。用户自己的 `--profile` 继续生效；base/user/project/plugin hooks
仍按 Codex 原生合并规则加载。

P0 必须用真实 `0.145/0.146` 证明：

1. `-c` 可以表达全部 matcher group、`command` 与 `commandWindows`；
2. 该 source 会出现在 `/hooks`，只信任 Vibing source 后下一轮立刻投递；
3. 信任在相同字节定义的下一次启动中保持；
4. 与用户 `--profile`、项目 hook、plugin hook 共存，不覆盖其它 source；
5. 两个并发 Codex Session 使用相同 hook hash、不同 drop route，不串事件。

若任一项不成立，P0 输出证据并回到 §1 的设计检查点；禁止在实现中暗自写
`$CODEX_HOME/vibing.config.toml`。

### 5.3 参数冲突和支持的命令形态

首版监听以下交互入口：

- `codex`；
- `codex resume`；
- `codex fork`。

以下入口保持原生启动但使用 lifecycle-only：

- `exec/review`（后续可单独做 JSONL Adapter）；
- `app-server/mcp-server/exec-server/remote-control/cloud/app/update/login/logout/features/doctor`；
- 用户显式 `--remote` 的外部 App Server；
- 无法安全解析的未知 subcommand；
- 用户自己通过 CLI `-c hooks=...` 覆盖整个 hooks table，且无法证明合并语义。

所有注入参数必须放在真实 `codex` 后、subcommand 前；Windows host 与 WSL argv 分别做结构化插入，
不拼接 shell command string。

## 6. Hook trust 产品策略

### 6.1 默认路径：正常信任，不 bypass

首次启动可能出现 Codex 原生“Hooks need review”提示。Vibing 同时显示非阻塞说明：

```text
Codex 监听等待信任
请在 Codex 中打开 /hooks，只信任 Vibing Observer 后即可开始监听。
CLI 可以继续使用；未信任前仅显示启动/退出状态。
```

Adapter 状态：

- PTY spawn 后 projection 为 `idle + observerHealth=unconfirmed`；
- Runtime 已知首个 input submit，但 10 秒内没有任何 Hook 到达 →
  `observer.degraded(reason=codex-hook-unconfirmed)`，保留已声明 capabilities 但标记
  `observerHealth=stale`，不假装已经连通；
- 后续首个合法 Hook 到达即可把 `observerHealth` 恢复为 `healthy`；已知 hooks 不可用/被禁用时才
  从 prepare 阶段收窄为 lifecycle-only；
- 不读取或修改 Codex 内部 trust 数据库，不模拟键盘替用户选择信任。

### 6.2 明确拒绝的默认行为

首版不自动添加 `--dangerously-bypass-hook-trust`。原因不是命名“dangerously”本身，而是该 flag 会
对本次运行中所有启用的 user/project/plugin hook source 取消审查，Vibing 无法把作用域限制为自己的
Hook。旧实现的“一次弹窗、永久记住”不足以表达这个持续风险。

未来若用户强烈需要零交互模式，只能作为独立高级选项评审：每次启动明确提示作用范围、默认关闭、
不自动勾选、不与权限绕过混淆，并有企业 policy 禁用路径；不属于本计划 DoD。

## 7. 统一原子文件投递

### 7.1 目录与环境

每个 Session 使用 Runtime 已创建的：

```text
<userData>/observer-runs/<sessionId>/codex-drop/
```

Host env：

```text
VIBING_CODEX_HOOK_DROP=<native absolute path>
VIBING_CODEX_HOOK_SESSION=<opaque route id>
```

WSL env 使用同名键，但 drop path 是运行时 `wslpath` 翻译并完成真实 round-trip probe 的 POSIX 路径。
route id 不是 secret，只用于文件名隔离；payload 仍必须从本次 route 目录读取。

### 7.2 POSIX command（macOS/Linux/WSL）

固定 Hook command：

1. 校验 drop path、route id 和生成文件名；
2. `mktemp` 在目标目录创建 `.partial`；
3. stdin 最多写 1 MiB；
4. `chmod 0600`；
5. 同目录 `rename` 为 `.json`；
6. 无论投递是否成功都快速退出 0，不向 stdout/stderr 返回 Hook 决策或上下文。

### 7.3 Windows command

Windows 必须使用 `commandWindows`，从 `[Console]::OpenStandardInput()` 读取原始 bytes，不能让 console
code page 把包含中文的 `last_assistant_message` 重编码。写入顺序同样是：同目录随机 `.partial` →
大小校验 → flush/close → atomic move → `.json`。

不得把 payload 先转成 PowerShell string 再编码，也不得把 JSON 放进命令行或 env。

### 7.4 主进程消费与安全边界

- 150–300ms 有界 poll；按 mtime + filename 稳定排序；单轮消费数量有上限；
- 只接受普通文件、`.json` 后缀、1 MiB 以内、目录 owner/路径符合本次 runDir；
- 读取后立即 unlink；解析失败只记有界 reason，不打印 payload；
- route dispose 后忽略迟到文件并清空生成物；删除不跟随 symlink/reparse point；
- 复用 S1 的 512 items / 4 MiB 队列思想，terminal Hook 优先保留；
- drop path 被同用户进程看到时，理论上可伪造 Dashboard 状态。Ingress 只接收事实、从不返回
  Hook decision/additional context，也不执行 payload，因此影响边界限制为本地 UI/统计污染；文档与诊断
  必须如实说明，不能把 route id 宣称为认证 secret。

相较旧 HTTP env 方案，这一设计不把 App 级 base token 传给 Codex/Bash 子进程，也没有
`curl.exe`/PowerShell HTTP/WSL 网络三套编码和可达性分支。

## 8. Parser、Projector 与事件映射

### 8.1 最小 Hook 集

| Codex Hook | 私有事实 | 公共事件 |
|---|---|---|
| `SessionStart` | native session/source reset | startup/resume/clear 时 correlation reset + high-confidence idle；compact 不清 working |
| `UserPromptSubmit` | turn begin | `turn.started` + `thinking.started`；丢弃 prompt |
| `PreToolUse` | tool begin/replay | `thinking.completed` + 去重后的 `tool.started` |
| `PermissionRequest` | approval pending | 保守关联后的 `approval.requested` |
| `PostToolUse` | tool terminal | `tool.completed`；丢弃 tool_response |
| `PreCompact` | compact begin | 私有 activity；不增加 tool 统计 |
| `PostCompact` | compact end | 私有 activity；turn 继续 working |
| `SubagentStart` | subagent begin | `tool.started(name=Agent, callId=agent_id)` |
| `SubagentStop` | subagent terminal | `tool.completed`，不读取 assistant message |
| `Stop` | turn terminal/possible continuation | 收敛 thinking/tools/requests，按 turn_id 去重后 `turn.completed` |
| `SessionEnd` | native session advisory end | 清 native correlation；不发 `session.exited` |

Runtime 的 PTY exit 仍是唯一 `session.exited` 事实。

### 8.2 Turn 与 Stop

- `turn_id` 是主要关联键；缺失或非法 id 使用 Adapter 私有合成 id，但 capability 降级并记录诊断；
- `UserPromptSubmit` 重复 delivery 不重复开始 turn；
- `Stop` 不读取 `last_assistant_message`；本 Adapter 返回空成功，因此自身不会要求 continuation；
- 其它并发 Hook source 可能让 Stop 继续运行。首次 Stop 可以先形成 done，后续同 turn/new turn 事件必须
  可逆地恢复 working；`stop_hook_active` 只用于去重/诊断，不映射公共字段；
- 当前 schema 没有 `background_tasks`，不为此保留假分支；
- `SessionEnd` 可能在 PTY 仍存活时出现，绝不能销毁 Vibing Session。

### 8.3 Tool 与低敏摘要

`tool_use_id` 是 tool call 稳定键。重复 `PreToolUse`、completed-before-started、poll/write_stdin 导致的
重复边界都必须收敛。公共摘要只允许：

- Bash：首个可执行程序名，如 `git`、`npm`；不保留参数、路径、管道和变量值；
- `apply_patch/Edit/Write`：若能安全取得，只保留 basename；否则仅显示公共类别；
- MCP：工具公开 name，删除 server 参数与 input；
- Subagent：统一为 `Agent`，不读取 prompt/assistant message。

当前 `PostToolUse` 对非零 Bash 也触发，但没有稳定通用 outcome 字段。P0 fixture 未证明前统一发
`tool.completed`，不解析 `tool_response` 猜 `tool.failed`。

### 8.4 PermissionRequest 保守关联

当前 `PermissionRequest` 没有 `tool_use_id`。关联规则：

1. 只在相同 `turn_id`、相同 canonical tool name 下寻找 active tool；
2. 只有恰好一个候选时，才附 `callId`；
3. 多个或零个候选时创建独立 request id，不伪造关联；
4. 只有确定关联的后续 tool terminal 才发 `approval.resolved`；
5. 未确定 request 在 Stop、SessionEnd、PTY exit 或有界 TTL 后清除；TTL 清除不计 approved/denied；
6. Hook 本身永远不返回 allow/deny，用户仍在原生 Codex UI 中审批。

并行同名 Bash 是强制 fixture，宁可暂时多显示一个待处理，也不能误报“已批准”。

### 8.5 Thinking、usage、messages 与 error

- Hooks 没有 hidden reasoning delta；thinking capability 只声明 `phase`；
- `last_assistant_message`、prompt、transcript、tool_response 永不进入 Parser 输出；
- Hooks 当前不提供可靠 token usage；usage 为 `none`；
- 没有 AskUserQuestion 等独立 input hook；inputRequests 为 `none`；
- 当前没有 `StopFailure`，也不从 terminal 文案推断 turn error；PTY 非零退出仍由 Runtime lifecycle 处理；
- 可选 xterm caption 只有真实帧 fixture 后才做，且只发 low-confidence `activity.caption`，不驱动六态。

## 9. Observer watchdog 与降级

Health 状态沿用 S1：

```text
unconfirmed → healthy
unconfirmed → stale / lifecycle-only
healthy → stale → healthy
```

降级原因至少包括：

- `codex-hooks-unavailable`；
- `codex-hooks-disabled-by-user`；
- `codex-managed-hooks-only`；
- `codex-hook-config-conflict`；
- `codex-hook-unconfirmed`；
- `codex-drop-path-unavailable`；
- `codex-drop-overflow`；
- `codex-hook-payload-invalid`；
- `codex-version-unsupported`。

Watchdog 规则：

- 首个 input submit 后 10 秒仍无任何 Hook，仅说明 trust/config/transport 未确认，标记 stale；只有
  prepare 已确认 hooks 不可用/被禁用时才降级 lifecycle-only；
- healthy 状态下，正在 working 且 Hook 长时间静默时，只能发 low-confidence idle（沿用 S1 双时钟
  门槛），不能伪造 `turn.completed`、完成历史或通知；
- 迟到合法 Hook 可恢复 healthy；重复 invalid payload 触发有界降级，不杀 PTY；
- Hook command 是同步扩展点，timeout 固定为短值（计划 3 秒）；投递脚本失败必须快速退出，不能让
  Codex 每个 tool 卡住。

## 10. 生命周期与幽灵 Session 防线

启动顺序：

```text
validate selection
  → provisional terminal
  → adapter.prepare (probe + drop + inline config)
  → PTY spawn
  → adapter.attach (poller + projector)
  → commit Session/projection/history
```

门禁：

- prepare 失败：删除 drop/config 临时资源，原 Codex lifecycle-only 启动；
- spawn 失败/秒退：不提交 Session/历史启动数，prepared route 全回滚；
- attach 失败：不 kill 已启动 Codex，capabilities 清零并发 `observer.degraded`；
- user stop、PTY exit、App quit、stop/exit 竞态：Runtime finalize 一次，poller/timer/drop dispose 幂等；
- renderer reload：只 `listActive` 恢复，不重新 probe、注入、spawn 或创建第二个 terminal；
- Native SessionStart/SessionEnd 只更新 correlation，不创建/删除 Vibing Session；
- 迟到 drop 文件不能跨墓碑恢复 Session；
- 两个 host、host+WSL、两个 WSL distro 同时运行时，route、turn、tool、trust 状态不串线。

## 11. App Server 路线为何后置

App Server 的 JSON-RPC 提供精确 thread/turn/item、approval、usage、reasoning summary 和主动对账，长期
可能优于 Hooks。当前不选它作为 v1，原因是：

1. 为保持原生 TUI，需要先启动 helper App Server，再用 `codex --remote` 连接，改变启动拓扑；
2. Windows 需要 WebSocket；官方当前明确标记 WebSocket transport 为 experimental/unsupported；
3. 需要证明 Observer 作为第二 client 能完整订阅 TUI 创建/切换的 thread，且不会抢 approval request；
4. app-server crash、auth、daemon、remote TUI resume 与进程所有权会扩大幽灵 Session 风险；
5. 当前 v1 Adapter seam 的 prepare 可以创建 helper，但在没有真实原型前不应为 Codex 扩大公共接口。

P6 可做 throwaway prototype：`app-server --listen ws://127.0.0.1:<port>` + capability token +
`codex --remote`，证明多 client 订阅、审批归属、Windows/WSL 生命周期和 usage 价值后，再决定是否成为
Codex v2 transport。不能把实验 transport 静默混入 v1 fallback。

## 12. 实施阶段

### P0 — 协议取证、trust spike 与脱敏 fixture

- [ ] Windows `0.146.0`、WSL `0.145.0` 核对 11 个 Hook 的真实 payload；
- [ ] dotted `-c hooks.<Event>=...` 解析与 `/hooks` 展示已验证；信任持久性、profile 共存待补；
- [ ] 验证 `commandWindows` 原始 bytes，中文 prompt/assistant/tool payload 不损坏 JSON；
- [ ] no-tool、tool、permission 已跑；compact、subagent、resume/clear、exit 待补；
- [x] 仓库只提交脱敏合成 fixture，不保存真实 prompt/tool body/assistant text；
- [x] 真机确认 SessionStart 仍延迟到首轮提交，welcome 阶段保持 unconfirmed idle；
- [ ] 验证 Stop 与其它 continuation Hook 并存时的真实顺序；
- [x] 验证 PermissionRequest/PreToolUse/PostToolUse 的关联、重试与 replay；
- [x] 确认整张 `hooks={...}` override 不生效，改用 11 个 dotted override 后 `/hooks` 显示 11 个待审 Hook。

### P1 — Parser、Projector 与纯函数门禁

- [x] 实现 unknown-safe Parser、字段/长度校验与隐私 canary；
- [x] 实现 native session/turn/tool/subagent/approval correlation；
- [x] 覆盖 duplicate、out-of-order、completed-before-started、并行 tools；
- [x] 覆盖两个并行同名 tool permission，不误关联/approved；
- [x] Stop/SessionEnd 清 pending，不永久 needs-you；TTL 仍待补；
- [x] compact 不增加 tool count、不把 idle turn 错标 done；
- [ ] 5000 facts 合并后不阻塞 Runtime/PTY；
- [x] 证明 prompt、tool input/output、assistant/reasoning body 不离开 Adapter。

### P2 — Inline config 与四端 file-drop transport

- [x] 生成字节稳定的 dotted Hook overrides 与 POSIX/Windows command；
- [x] 解析 argv，只增强 base/resume/fork，正确插到 subcommand 前；
- [x] Host 创建 0700 drop、0600 file、atomic rename；
- [x] WSL `wslpath` + round-trip write probe，不硬编码 `/mnt/c`；
- [x] Windows raw byte stdin、1 MiB cap、中文 fixture；
- [x] runtime-neutral poller 的排序、限流、invalid 清理、symlink 拒绝和 dispose；
- [ ] user disabled/managed-only/config conflict 明确 lifecycle 降级；
- [x] 不修改 `$CODEX_HOME`、项目 `.codex`、managed config 或 trust store。

### P3 — Adapter、Runtime 注册与 trust UX

- [x] 实现并注册 `CodexObserverAdapter`，精确匹配 `adapterId=codex`；
- [x] capabilities 按本次 probe/attach 结果收窄；
- [x] 首投递 watchdog、healthy 恢复和 Runtime queue overflow 降级；
- [ ] 首次信任说明使用现有通用配置/启动 UI，不新增 Codex 专属 IPC；
- [x] 不自动输入 `/hooks`，不添加 trust bypass；
- [x] Runtime input-submit、projection、history、stats、floating 全链路走通；
- [x] 旧 `types.ts` 注释从“Claude/Codex”修正为已验证的“Claude/OpenCode”。

### P4 — 生命周期与失败路径

- [x] prepare/attach/spawn/drop 不可写通过既有 Runtime 回滚与 Adapter dispose 门禁；秒退/invalid config 待补；
- [x] stop、PTY exit、SessionEnd、App quit 复用 Runtime 幂等 finalize；
- [x] renderer reload 原地恢复，无新 PTY/Session；
- [ ] host + WSL、多 WSL、多 Codex Session 不串事件；
- [x] Hook 未信任时显示 Codex 原生 review 页且不产生伪语义；禁用/managed-only 细分待补；
- [ ] trust 后当前或下一轮自动恢复语义，不要求重建 Session；
- [x] 不兼容 subcommand 原样启动，不误武装 observer。

### P5 — 真实 E2E 与 UI 验收

- [x] Windows no-tool：idle → thinking → done；
- [x] Windows tool：thinking → Bash → done；apply_patch 待补；
- [ ] Windows permission：真实 approve → working/done 已通过；deny 待补；
- [x] WSL no-tool 与 Bash tool 主矩阵通过；permission 待补；
- [ ] resume/clear/compact 不创建第二个 Vibing Session；
- [ ] subagent 不提前完成 root turn；
- [ ] Ctrl+C/native exit/user close 正确退出且无幽灵 Session；
- [ ] Sidebar、Home、History、stats、Floating detail 一致，done 覆盖旧 thinking/tool；
- [ ] macOS/Linux 运行路径使用同一 POSIX transport；无机器时保留 opt-in smoke，不宣称真机已验收。

### 2026-08-04 实施证据

- Windows Codex `0.146.0` 与 WSL Ubuntu-22.04 Codex `0.145.0` 均实测
  `SessionStart → UserPromptSubmit → Stop`，侧栏由 idle/working 收敛到 done；
- 两端均实测 Bash `PreToolUse → PostToolUse → Stop`。Windows 额外触发真实 PermissionRequest、
  sandbox 首次失败与第二次执行，验证并行同名 tool 下不猜关联，并在 Stop 清理孤儿 tool/request；
- WSL transport 通过 `wslpath` 和原子 round-trip probe，真实 Hook 使用文件投递，不调用 `curl.exe`；
- Windows PowerShell bridge 用真实子进程验证 UTF-8 中文 JSON 原始字节，事件投影不保留路径/正文；
- Codex `/hooks` 原生页确认 11 个 Hook 可审查。产品与正式 E2E 不注入
  `--dangerously-bypass-hook-trust`；协议开发阶段曾用显式单次 test launch 验证已审查定义的 transport，
  该参数未进入产品代码或最终测试入口；
- 受影响回归共 47 项通过，包含 Runtime 回滚/幂等清理、renderer reload 不新建 PTY、扫描启动与
  observer-run 目录清理。

### P6 — 后续，不阻挡首版

- [ ] App Server + Remote TUI 双 client throwaway prototype；
- [ ] App Server 稳定后评估 usage/context、reasoning summary 与精确 approval；
- [ ] Codex `exec --json` 独立非交互 Adapter；
- [ ] 基于真实 xterm 帧的低置信度 activity/token caption；
- [ ] 设置页展示实际 hooks capability、trust/transport/degraded reason；
- [ ] 经单独安全评审的可选 per-launch trust bypass；
- [ ] macOS/Linux 打包真机 smoke。

## 13. 自动化与真实测试

### 13.1 普通门禁

- fixture tests 不访问网络、不要求 Codex 登录；
- Parser/Projector 测试只用脱敏 payload；
- Adapter interface 测试通过 `AgentSessionRuntime`，不穿透私有 Map；
- transport 使用临时 runDir 和 fake hook writer；
- 普通终端、Claude、OpenCode、悬浮窗门禁必须保持通过。

### 13.2 opt-in 真实 E2E

建议环境变量：

```text
VIBING_E2E_REAL_CODEX=1
VIBING_E2E_REAL_CODEX_WSL_DISTRO=Ubuntu-22.04
```

真实用例只在临时 workspace 操作合成文件，不读取生产仓库 secret，不修改用户 Codex 配置/trust。
Trust 首次交互单独标记为 manual-assisted 或使用预先信任的测试用户目录；禁止测试自动传
`--dangerously-bypass-hook-trust` 掩盖产品路径。

## 14. 平台与场景矩阵

| 场景 | 首版必需 | 当前状态 | 证据 |
|---|---:|---|---|
| Windows host `0.146.0` | yes | ✅ | no-tool、Bash、approve 真机 E2E |
| WSL2 Ubuntu-22.04 `0.145.0` | yes | ✅ | no-tool、Bash 真机 E2E |
| WSL mirrored/custom mount | yes | fixture | `wslpath` + round-trip；自定义 mount 真机待补 |
| macOS host | 实现 yes / 真机后补 | fixture | 共用 POSIX transport，真机 smoke 待补 |
| Linux host | 实现 yes / 真机后补 | fixture | 共用 POSIX transport，真机 smoke 待补 |
| no-tool → done | yes | ✅ | Windows + WSL 真实 trace |
| tool success / non-zero Bash | yes | partial | success + Windows sandbox retry；显式 non-zero 待补 |
| permission approve / deny | yes | partial | approve 真实通过；deny 待补 |
| compact + resume + clear | yes | [ ] | 待真实 trace |
| subagent lifecycle | yes | fixture | 低敏 Agent tool 映射通过；真实 trace 待补 |
| error / Ctrl+C / native exit | yes | [ ] | 待真实 trace |
| host + WSL 并发不串线 | yes | [ ] | 待真实 E2E |
| Hook untrusted/disabled/managed-only | yes | partial | untrusted 原生 review 已验证；disabled/managed-only 待补 |

## 15. Definition of Done

- [ ] Stable Hooks capability 由所选安装运行时实测，不按品牌或版本硬猜；
- [ ] 原生 TUI、用户 profile、审批和 sandbox 行为保持不变；
- [ ] 默认不写 `$CODEX_HOME`，不修改 trust store，不添加 trust/permission bypass；
- [ ] Windows/WSL 真实 no-tool、tool、permission 多轮驱动统一六态；
- [ ] macOS/Linux 使用同一受测 POSIX transport，未真机验收状态明确；
- [ ] prompt、tool body、assistant/reasoning、transcript、认证信息不进入事件/日志/历史/IPC；
- [ ] duplicate/out-of-order/并行 tool/多 approval 不误计数、不提前 done；
- [ ] prepare/attach/spawn/exit/reload 所有门禁无幽灵 Session 和资源泄漏；
- [ ] Observer trust/transport 失败不终止 Codex，支持迟到恢复；
- [ ] Sidebar、Home、History、stats、悬浮窗只消费主进程 projection；
- [ ] typecheck、build、目标 E2E 与既有 Claude/OpenCode/普通终端回归通过；
- [ ] 实施记录回写实际版本、能力、信任流程、降级原因与未覆盖平台。

满足以上阻塞项即可宣布 Codex Adapter 首版完成。App Server、`exec --json`、usage、caption、高级 trust
bypass 和 macOS/Linux 打包真机属于明确后续，不得用未实现能力抬高首版 capability。
