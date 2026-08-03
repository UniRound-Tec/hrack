# S2 实施计划 —— Claude Code Observer Adapter

> 状态：**首版完成（2026-08-04）**。Windows 真实 thinking/tool/permission 多轮与统一投影已验收；
> WSL/更多 host 平台、managed policy 和设置页 capability 展示作为扩展矩阵持续补齐，不阻塞 M6。
>
> 目标：在 [PLAN-S1.md](./PLAN-S1.md) 的 `AgentSessionRuntime` 与 `AgentObserverAdapter`
> seam 上，实现第一个真实 Adapter。通过 Claude Code 官方 Hooks，把 turn、thinking phase、tool、
> approval/input 与结束状态翻译成统一 `AgentEvent`，覆盖 Windows、macOS、Linux 和 Windows + WSL。
>
> 协议事实核验日期：**2026-08-03**。事实基线为 Claude Code 官方
> [Hooks reference](https://code.claude.com/docs/en/hooks)、
> [CLI reference](https://code.claude.com/docs/en/cli-usage) 与
> [Settings](https://code.claude.com/docs/en/settings)。实现时仍需用本机版本 fixture 复核。

---

## 1. 已定方案

S2 不做一个 Claude 专用 Session 系统。它只增加一个位于 S1 内部 seam 的 Adapter：

```text
AgentSessionRuntime
  ├─ ClaudeObserverAdapter.prepare()       spawn 前
  │    ├─ 选择 host / WSL transport
  │    ├─ 创建 per-session settings
  │    └─ 返回 --settings augmentation
  ├─ PTYManager.spawn()
  └─ PreparedClaudeObserver.attach()       spawn 后
       ├─ HookIngress 路由注册
       ├─ ClaudeHookProjector
       └─ AgentEvent → S1 reducer / history projector
```

关键决策：

1. **只监听 Vibing 自己启动的 Claude Code。** 不拦截普通 shell 中手工输入的 `claude`，因此首版
   不做 PATH shim；
2. **主进程只有一个 HookIngress。** 它跟随 App 生命周期，不跟随 BrowserWindow，不为每个 Session
   启一个 HTTP server；
3. **Host 优先用官方 HTTP hook；WSL 按 file → `curl.exe` → 放弃选择。** WSL 内的
   `127.0.0.1` 不是 Windows 主进程，且 PE binfmt interop 可能在冷启动后失效，因此不能把 host
   方案原样复制过去，也不能把 `curl.exe` 当成默认可用；
4. **ClaudeHookProjector 是 Claude Adapter 私有实现。** 并发、重复、乱序、subagent、compact、
   background task 等 Claude 知识不得泄漏进公共 `AgentEvent`；
5. **thinking 只是一段结构化推导出的 phase。** Hooks 不提供隐藏推理内容；不读取、不广播、
   不持久化 chain-of-thought；
6. **Hook 观察失败不影响 CLI。** Adapter 降级成 lifecycle-only，PTY 保持可用；
7. **PTY exit 才是进程退出事实。** `SessionEnd` 可能由 `/clear` 或 `/resume` 触发，不能直接映射成
   `session.exited`；
8. **首版不让 Hook 作任何决策。** Vibing 永远快速返回空 2xx，不批准、不拒绝、不注入 context，
   只观察。

---

## 2. 交付边界

### 2.1 S2 交付

- `ClaudeObserverAdapter`：安装/版本/运行环境判断、临时 settings、启动 augmentation 和清理；
- App 级 `HookIngress`：随机路由、HTTP body 限制、快速确认、异步投递；
- WSL 双通道：Windows 挂载目录的原子 file drop 优先，运行时实测通过的 `curl.exe` interop 回退；
- `ClaudeHookParser`：把不可信 JSON 收窄成 Claude native fact；
- `ClaudeHookProjector`：关联 tool、permission、input、turn、subagent、compact 和 background task；
- Claude native fact → S1 `AgentEvent` 的确定性映射；
- 只含脱敏数据的协议 fixture；
- Observer 降级原因与实际 capability 投影；
- Windows host、macOS、Linux、WSL 的真实会话验收记录模板；
- 可选的低置信度 `LiveCaptionUpdate` 屏幕字幕兜底，但它不能改变权威 SessionStatus。

### 2.2 S2 不交付

- 不监听 Vibing 之外的 Claude Code；
- 不修改 `~/.claude/settings.json`、项目 `.claude/settings*.json` 或 managed settings；
- 不自动批准 PermissionRequest，不替用户回答 AskUserQuestion/Elicitation；
- 不读取 transcript 作为主事件源；
- 不保存 prompt、assistant 正文、tool_input、tool_response、终端画面或隐藏推理；
- 不做通知、悬浮窗、硬件提醒或远程控制；
- 不实现 Codex 或其它 CLI Adapter；
- 不为了抓 `MessageDisplay` 文本给每批渲染增加同步 Hook 延迟；
- 不承诺 Claude Code 所有历史版本；不满足协议能力时明确降级。

### 2.3 完成标志

一个由 Vibing 启动的真实 Claude Code 会话能稳定出现：

```text
启动 CLI       → working
提交 prompt    → working / Thinking
开始 tool      → working / <safe tool summary>
等待权限       → needs-you
权限已处理     → working
本轮结束       → done
CLI 退出       → exited
```

并且以下路径不产生幽灵 Session：settings 创建失败、PTY spawn 失败、Hook attach 失败、WSL transport
不可用、用户启动后立即关闭、Claude 在首个 Hook 前退出。

---

## 3. 官方协议结论与旧实现差异

### 3.1 可以直接依赖的官方能力

- `--settings <file-or-json>` 是单次会话的官方覆盖入口，并与用户/项目 settings 合并；
- Hook 接收结构化 JSON；command hook 从 stdin 读取，HTTP hook接收 POST；
- HTTP hook 的 2xx 空响应等价于成功且无输出，连接失败/超时是非阻塞错误；
- `PreToolUse` / `PostToolUse` 通过 `tool_use_id` 关联；
- `PostToolUse` 可并发触发，`PostToolBatch` 在整批工具完成后触发一次；
- `PermissionRequest` 在即将显示权限询问时触发；
- `Stop` 带 `last_assistant_message`，新版本还带 `background_tasks` 与 `session_crons`；
- `StopFailure` 独立表示 API/执行失败；用户中断不保证触发 `Stop`；
- `SessionEnd` 原因包括 clear、resume、logout 和普通退出，不等价于 PTY 退出；
- `Notification` 可区分 permission、idle、agent needs input 和 agent completed；
- managed policy 可能通过 `allowManagedHooksOnly` 或 HTTP allowlist 阻止 Vibing hook。

兼容约束：当前正式 Hooks reference 与 Context7 官方文档库都声明 `SessionEnd.reason`；旧版 plugin
开发 skill 的字段摘要没有列出它。实现以正式 reference 为基线，但 Parser 把 `reason` 当作可选字段，
缺失或出现未来未知值时走同一条安全 reset 路径，不能因此拒绝整个 payload。

### 3.2 相对旧 vibby 实现的调整

| 旧实现经验 | Vibing S2 决策 |
|---|---|
| PATH shim 包裹任意 `claude` | 首版删除；Vibing 已持有准确 executable 和 args |
| 每窗口一个 HTTP server | 改为 App 主进程单例 |
| command hook 自己 curl HTTP | host 优先官方 `type: http`；WSL 优先 file drop，`curl.exe` 仅回退 |
| 18 个事件全部注入 | 只注入能驱动 S2 状态的最小事件集，减少同步开销 |
| spinner 抓屏可推断 turn completed | 抓屏只更新低置信度 caption，绝不驱动权威状态 |
| env marker 恢复已运行 Session | 当前 App quit 会终止 PTY，不做跨 App 重启认领；renderer reload 用 S1 `listActive()` |
| transcript 辅助最终文案 | `Stop.last_assistant_message` 只在内存中生成可选安全摘要，默认不保存原文 |

---

## 4. 模块与文件布局

S1 合并后按以下位置实现；如果 S1 最终文件名调整，只保持职责，不机械保持路径：

```text
electron/
  agents/
    AgentSessionRuntime.ts
    events.ts
    reducer.ts
    adapters/
      claude/
        ClaudeObserverAdapter.ts
        ClaudeHookParser.ts
        ClaudeHookProjector.ts
        claudeHookSettings.ts
        claudeSummaries.ts
        claudeEnvironment.ts
        types.ts
  hooks/
    HookIngress.ts
    HookRouteRegistry.ts
    WslHookDropPoller.ts
    secureRunDirectory.ts
  pty/
    PTYManager.ts
shared/
  agent-contract.ts
preload/
  index.ts
src/
  state/sessionsStore.ts
  terminal/TerminalView.tsx
```

### 4.1 外部 Interface 不增加 Claude 方法

Renderer 仍只认识 S1 的：

```ts
agentApi.start(...)
agentApi.stop(...)
agentApi.listActive()
agentApi.onEvents(...)
agentApi.onProjection(...)
```

禁止增加 `claude:start`、`claude:onHook`、`claude:getStatus`。删除 Claude Adapter 后，renderer 与
Session UI 不应需要修改。

### 4.2 Adapter 内部 Interface

```ts
interface ClaudeTransportRegistration {
  settingsHooks: ClaudeSettingsHooks
  capability: 'hooks' | 'lifecycle'
  degradedReason?: ClaudeObserverDegradedReason
  attach(emit: (payload: unknown) => void): Promise<Disposable>
  dispose(): Promise<void>
}
```

`ClaudeObserverAdapter.prepare()` 隐藏 transport 选择、settings 文件、路径翻译和临时目录。Runtime 只
拿到 S1 的 `LaunchAugmentation` 与 `PreparedObserver`。

---

## 5. 启动注入

### 5.1 per-session run directory

每次启动在以下位置创建独立目录：

```text
<userData>/observer-runs/<sessionId>/
  owner.json
  claude-settings.json
  drop/                 # 仅 WSL file transport
  bridge.sh             # 仅 WSL file transport
```

约束：

- POSIX 目录 `0700`、文件 `0600`；Windows 依赖 userData ACL，并拒绝重解析点/符号链接；
- `owner.json` 只含 schema、sessionId、pid、createdAt 和随机 nonce，不含 prompt/token；
- 创建路径必须使用不可预测 sessionId/nonce，不接受 renderer 传入路径；
- 清理用 `lstat`，不跟随 symlink；只删除 manifest 中由 Vibing 创建的生成物；
- App 启动时清理 owner pid 已不存在且超过宽限期的 stale run；
- PTY spawn 失败、Session stop、PTY exit、App quit 都走同一个幂等 dispose。

### 5.2 settings 合并策略

生成的 `claude-settings.json` 只写 `hooks`，不复制或修改用户的 permissions、env、model、plugins：

```json
{
  "$schema": "https://json.schemastore.org/claude-code-settings.json",
  "hooks": {
    "UserPromptSubmit": [],
    "PreToolUse": [],
    "PermissionRequest": [],
    "PostToolUse": [],
    "PostToolUseFailure": [],
    "PostToolBatch": [],
    "Stop": [],
    "StopFailure": [],
    "Notification": [],
    "SessionEnd": []
  }
}
```

Claude 官方说明 `--settings` 中未提供的键保留文件 settings 值，因此 Vibing 不替换用户设置；hooks
会跟其它层的 hooks 一起运行。

启动参数由 Runtime 安全组合：

```text
<resolved claude> --settings <runtime-visible temp path> ...definitionArgs ...userArgs
```

规则：

- settings path 作为独立 argv，不经 shell 字符串拼接；
- WSL 使用同一发行版可访问的 `/mnt/<drive>/...` 路径；
- 用户 args 已含 `--settings` 或 `--settings=...` 时不覆盖、不尝试读/合并用户文件；本次会话降级为
  lifecycle-only，并返回 `user-settings-conflict`；
- 不添加 `--dangerously-skip-permissions`、`--permission-mode` 或任何权限改变参数；
- managed policy 拒绝非 managed hooks 时不绕过，进入 lifecycle-only。

### 5.3 环境清理

只删除经当前安装版本的可复现错误确认、会阻止嵌套启动的 sentinel。当前已知候选只有：

```text
CLAUDECODE
```

`CLAUDE_CODE_ENTRYPOINT` 等其它变量必须先通过本机版本复现确认，不能因为名字相似就删除。不得按
`CLAUDE*` 前缀批量清空，否则可能删掉认证、代理、模型、Bedrock/Vertex 或企业配置。Adapter 增加的
路由 token 不放在可被 Claude tool 子进程读取的环境变量里；它只存在临时 settings URL 中。

---

## 6. Transport 设计

### 6.1 App 级 HookIngress

`HookIngress` 在 Electron App ready 后、任何 Agent 启动前按需创建：

```ts
interface HookIngress {
  register(sessionId: string, adapterId: 'claude-code'): HookRoute
  unregister(sessionId: string): void
  dispose(): Promise<void>
}

interface HookRoute {
  url: string
  token: string
  subscribe(listener: (payload: unknown) => void): Disposable
}
```

安全与性能合同：

- 只绑定 `127.0.0.1`，操作系统分配随机端口；
- App 级随机 base token + Session 随机 token，路由 token 恒定时间比较；
- 仅接收 `POST`，`Content-Type` 必须是 JSON，body 硬上限 1 MiB；
- 未注册、token 错误、method 错误或超限请求不进入 parser；
- body 收完并进入有界队列后立即返回 `204 No Content`；
- 不等待 projector、EventLog、IPC 或 renderer；
- route queue 溢出时优先保留 terminal event，并发一次 `observer.degraded`；
- Hook endpoint 永不返回 decision、context、prompt 或用户数据。

### 6.2 Host：官方 HTTP hook

Windows、macOS、Linux 的 Claude 进程与 Electron 主进程处于同一 host network namespace，设置项
使用：

```json
{
  "type": "http",
  "url": "http://127.0.0.1:<port>/v1/claude/<base>/<session>",
  "timeout": 2
}
```

HTTP hook 不装在 `SessionStart`：官方当前只允许 SessionStart 使用 command 或 MCP hook；Runtime 的
PTY spawn 已提供 `session.started`，无需为了重复事实增加 helper。其余已支持 HTTP 的事件复用同一路由，
payload 中的 `hook_event_name` 决定 native type。

若安装版本不支持 HTTP hook，或 settings 被 policy 拒绝：

- 不尝试修改 managed policy；
- 不在首次业务 prompt 时才让 CLI 因配置错误退出；实现阶段须用受控 capability probe 确认该版本接受
  生成的 settings；
- probe 不通过则不注入 settings，直接 lifecycle-only。

HTTP allowlist 采用三态预检，不能假装能完整读取企业最终配置：

```ts
type HttpHookPolicyProbe = 'allowed' | 'denied' | 'unknown'
```

- 对可读的 user/project/local/managed file 与 Windows policy source 做 best-effort 检查；
- 明确发现 `allowedHttpHookUrls` 不匹配回环 URL（包括空数组）时返回 `denied`，不注入 HTTP hooks，
  降级码为 `http-hooks-not-allowed`；
- server-managed 或不可读 policy 令结果为 `unknown`，不能误报 allowed；
- `unknown` 仍可启动 Hook，但 observer health 在首个真实 delivery 前是 `unconfirmed`；
- 是否真正连通最终由 §9 的首次投递 watchdog 判断，而不是仅靠静态 settings 推理。

### 6.3 WSL transport 选择

选择函数是 Claude Adapter 内部 seam，不暴露给 Runtime：

```ts
type WslHookTransport =
  | { kind: 'file'; runtimeDropPath: string }
  | { kind: 'curl'; command: string }
  | { kind: 'none'; reason: 'wsl-transport-unavailable' }

selectWslHookTransport(probes): WslHookTransport
```

固定优先级：

```text
file 投递（Windows drive mount / Plan 9）
  → curl.exe（WSL PE binfmt interop）
  → none（lifecycle-only）
```

两个 probe 在 Adapter 武装阶段并行执行，不能串行等 file 失败后才开始 curl；选择只发生在全部有界
结果返回后。扫描缓存只提供挂载根和历史能力提示，**不作为本次 Session 可用性的证明**。

### 6.4 WSL 首选：原子 file drop

file transport 只依赖 Windows drive mount，不依赖 WSL 注册的 PE `binfmt_misc` handler，因此比
`curl.exe` 稳定。武装阶段必须做真实 capability probe：

1. host 已创建本 Session 的 `drop/` 目录；
2. 从扫描缓存取得该 distro 的 `windowsMountRoot` 提示；同时执行 `wslpath` 翻译实际 run directory；
3. 自定义挂载根如 `/c/` 必须采用 distro 实际结果，不能硬编码 `/mnt/c`；
4. 在 distro 内向 drop 目录写一个小型随机 `.partial`，再原子 rename；
5. Windows 主进程确认最终文件可见并删除；只有完整往返成功才选择 file transport；
6. probe 与 `curl.exe --version`、settings 路径翻译并行，单项最长 3 秒，失败只参与选择，不阻塞
   Claude 原生启动。

正式 Hook 路径：

1. settings 使用 command hook 调用 Vibing 生成的 `bridge.sh`；
2. script 从 stdin 读取 JSON，限制最大字节数；
3. 在 `drop/` 内创建随机 `.partial`；
4. flush/close 后原子 rename 为 `.json`；
5. `WslHookDropPoller` 每 300ms 按 mtime + 文件名顺序消费；
6. host 读取、parse、入队后删除；异常文件隔离并限量清理。

script 不依赖 `jq`、Node、Python 或用户 shell profile。文件名不使用 payload 字段。drop 目录属于当前
Session，Session dispose 后停止 poll 并安全清理。

缓存策略：

- 扫描缓存按 distro 保存 `windowsMountRoot`，只用于缩短路径发现；
- 停止、扫描时被排除或缓存缺字段的 distro 在武装阶段直接探测；
- 即使缓存存在，也必须执行上述本 Session 可写往返 probe，避免 automount 改动或缓存过期误判；
- `automount=false`、Windows drive mount 被禁用、挂载为只读或路径翻译失败都令 file probe 失败，
  然后再考虑 curl；
- `networkingMode=mirrored` 不影响 file transport，也不改变选择顺序。

### 6.5 WSL 回退：运行时实测 `curl.exe` interop

`curl.exe` 不是根据扫描结果或“文件存在”判断。systemd distro 可能在 `systemd-binfmt` 启动时移除
WSL 注册的 PE `binfmt_misc` handler；冷启动期间还可能短暂可用、随后消失。因此扫描时成功不足以
证明武装时可用。

武装阶段在**本次目标 distro** 中实际执行：

```text
curl.exe --version
```

合同：

- 3 秒超时，必须真实启动并成功退出；
- 与 file probe、`wslpath` 翻译并行；
- probe 失败只淘汰 curl transport，不使 Adapter prepare 抛错；
- 只有 file probe 失败且 curl probe 成功时才选择 curl；
- probe 后 hook 执行仍可能遇到 interop 瞬时失效；首次实际投递失败后降级，不假装继续监听。

command hook 从 stdin 把 JSON 原样 POST 到 Windows loopback：

```text
curl.exe --silent --show-error --max-time 2
  --header Content-Type:application/json
  --data-binary @-
  http://127.0.0.1:<port>/v1/claude/<base>/<session>
```

- 用 hook exec form 的 `command + args`，不拼 shell 命令；
- 不在 URL query/header 放 prompt；
- curl 非零退出不能阻止 Claude；hook timeout 保持很短；
- Windows `curl.exe` 在 Windows network namespace 运行，因此可访问只绑定 loopback 的 Ingress。

### 6.6 两条通道都失败

`selectWslHookTransport` 返回 `none` 时：

1. 删除尚未使用的 settings、bridge、drop probe 文件并注销 route；
2. 不给 Claude 启动参数附加 `--settings`；
3. 记录 `wsl-transport-unavailable`，UI/诊断明确显示“Claude 将在无完整监听下启动”；
4. 返回 lifecycle-only capability，继续启动原生 Claude；
5. 不创建 poller，不保留“待恢复”的假监听状态。

### 6.7 明确放弃的 transport

- 不把 Windows Ingress 监听到 `0.0.0.0` 供 WSL 访问；
- 不猜 WSL host gateway IP；
- 不依赖 `localhostForwarding`、防火墙例外或局域网端口；
- 不让 WSL 直接写用户全局 Claude settings；
- interop 与 file mount 都不可用时，明确降级 lifecycle-only。

---

## 7. 最小 Hook 集与映射

### 7.1 首版安装的事件

| Claude native event | 作用 | 公共输出 |
|---|---|---|
| `UserPromptSubmit` | 新一轮开始；丢弃 prompt 正文 | `turn.started` + `thinking.started` |
| `PreToolUse` | tool 已生成，带 `tool_use_id` | `thinking.completed` + `tool.started` |
| `PermissionRequest` | 即将请求批准 | `approval.requested` |
| `PostToolUse` | tool 成功 | `tool.completed`，必要时解决 request |
| `PostToolUseFailure` | tool 失败 | `tool.failed`，必要时解决 request |
| `PostToolBatch` | 并行 tool 整批结束，即将再次请求模型 | `thinking.started` |
| `Stop` | 主 agent 本轮完成 | `thinking.completed` + `turn.completed` 或保持 working |
| `StopFailure` | API/agent loop 失败 | `turn.failed` |
| `Notification` | permission/idle/background fallback | request、done 或 idle 的补充事实 |
| `SessionEnd` | clear/resume/logout/native session 重置 | Adapter 私有 reset；不直接 `session.exited` |

`SessionStart`、`MessageDisplay`、transcript tail 不在首版主链路。`SubagentStart/Stop`、
`PreCompact/PostCompact` 可在 projector fixture 阶段加入，但它们只维护 Claude 私有状态，除非证明有跨
产品价值，否则不扩公共联合类型。

### 7.2 Thinking phase

Claude Hook 没有“隐藏推理 delta”事件。S2 的 `thinking: 'phase'` 定义为：

- `UserPromptSubmit` 后、首个 `PreToolUse` / `Stop` / `StopFailure` 前：thinking；
- `PostToolBatch` 后、下一个 tool/Stop 前：thinking；
- tool 正在执行时：tool activity，不同时宣称 thinking；
- permission/input 未解决时：needs-you 优先；
- 只记录开始/结束时间，不接收 prompt 或 reasoning 文本。

这是由结构化生命周期事实推导的 phase，不是模型内部状态。UI 文案必须是“思考中”，不能显示“思考
内容”。

### 7.3 Tool 摘要

`ClaudeHookParser` 允许读取 tool_name、tool_use_id 和少量白名单字段来生成安全 summary，但不得把
原始 `tool_input` 送出 Adapter：

| Tool | 允许摘要 |
|---|---|
| Read/Write/Edit | basename 或工作区相对路径；越界路径只显示 basename |
| Glob/Grep | 动作名，不保存完整 pattern |
| Bash | 优先官方 description；否则只取 executable 名，不保存参数 |
| WebFetch/WebSearch | 只显示域名或动作名，不保存 query |
| Agent | agent_type / 通用“子任务” |
| MCP | server/tool 名，丢弃 input |
| 未知 | 清理后的 tool_name |

所有 summary 单行、最多 48 字符，移除 ANSI、NUL、控制字符、URL credential 和疑似 secret。

### 7.4 Approval 与 input 关联

- `PreToolUse.tool_use_id` 是 tool lifecycle 的主键；重复 delivery 不重复计数；
- `PermissionRequest` 当前不带 `tool_use_id`，不能用“最新一个 tool”强行关联；
- Projector 先按 tool_name + 安全 fingerprint 找候选，**只有恰好一个未决候选时**才建立关联；零个或
  多个候选都视为不确定，创建独立的 Adapter 私有 request id；
- 匹配成功时 requestId 派生自 tool_use_id；并行同名/同参数 tools 不会互相抢 request；
- `Notification(permission_prompt)` 只是 PermissionRequest 缺失时的 fallback，不与其重复创建 request；
- 只有已确定关联的对应 `PostToolUse` 才表示 request 已通过并完成，发
  `approval.resolved(approved)`；
- 未关联 request 仅在 terminal event 到达时仍能证明“唯一 request ↔ 唯一 tool”才补关联；否则不猜
  decision；
- `PostToolUseFailure` / `PermissionDenied` 只有在有可靠关联时才发 denied/cancelled；不按错误文案猜；
- `Stop`、`StopFailure`、下一个 `UserPromptSubmit` 或 `SessionEnd` 会把本轮仍未解决的独立 request
  收口为 cancelled，避免 `needs-you` 穿越 turn；
- 所有 request 有硬 TTL，默认 24 小时；TTL 不是正常交互计时，只是防止 Hook 丢包或异常退出留下永久
  pending。到期时清除 request 并发 `observer.degraded(stale-request)`，不计 approved；
- `AskUserQuestion` 的 Pre/Post tool lifecycle 映射为 `input.requested/resolved`，不保存 questions/answers；
- MCP `Elicitation/ElicitationResult` 后续若加入，复用 input request，不新增 Claude 专用公共事件。

### 7.5 Stop 与后台任务

`Stop` 的处理必须是有状态的：

- `background_tasks` 有 running 项：关闭当前 thinking phase，但不发 `turn.completed`，保持 working；
- 无 background task：发 `turn.completed`；
- 只有未来 `session_crons`：本轮完成后进入 `idle`，标记“等待计划唤醒”，不长期显示 working；
- 字段在旧版本缺失：按空集合处理，但 capability/诊断记录版本限制；
- `last_assistant_message` 默认直接丢弃；若产品确认要摘要，另加显式、可关闭、严格有界的 summary
  策略，不能自动写原文；
- user interrupt 不保证 Stop，PTY 仍存活时维持最近可信状态，等待下一个 prompt/notification；超时可转
  idle，但不能假造 completed。

### 7.6 SessionEnd 与 PTY exit

| 事实 | 行为 |
|---|---|
| 任意 `SessionEnd` | 清空 native correlation 与本轮 pending request，Session 保持 idle/working，绝不直接 exited |
| `reason=clear/resume/logout/prompt_input_exit/bypass_permissions_disabled/other` | 若存在则只用于 reset 诊断；不改变“等待 PTY exit”的原则 |
| `reason` 缺失或未知 | 按普通 SessionEnd 安全 reset，不拒绝 payload、不猜退出原因 |
| PTY exit | Runtime 唯一生成 `session.exited`，随后 dispose Adapter |

当前正式 Hooks reference 明确声明 `reason`，且说明 `/clear` 与交互式 `/resume` 会触发 SessionEnd；
Parser 仍保持可选兼容，是为了支持旧安装和未来 schema 漂移，而不是否认当前字段。上述统一 reset 语义
可避免 `/clear`、`/resume` 或 Hook 丢包制造假退出/幽灵 Session。

---

## 8. ClaudeHookProjector

### 8.1 私有状态

```ts
interface ClaudeProjectorState {
  nativeSessionId?: string
  turn?: { id: string; phase: 'thinking' | 'tools' | 'waiting' }
  tools: Map<string, ClaudeToolState>
  requests: Map<string, ClaudeRequestState>
  subagents: Map<string, ClaudeSubagentState>
  seenDeliveries: LruSet<string>
  lastHookAt: number
  compacting: boolean
}
```

状态只存在 Adapter 内存中。公共 reducer 不需要理解 `stop_hook_active`、`agent_id`、
`background_tasks`、`session_crons` 或 Claude notification type。

### 8.2 顺序、重复与并发

- Hook 到达顺序不可信，特别是并行 `PostToolUse`；
- `tool_use_id` 的 terminal event 只生效一次；先到 Post、后到 Pre 时 Projector 创建 placeholder，再合并；
- duplicate key 由 `native session + event + tool_use_id + terminal discriminator` 组成；
- 没有 native id 的 Notification/PermissionRequest 使用短时 LRU fingerprint 去重；
- `PostToolBatch` 只负责 phase transition，不重复结束每个 tool；
- Session reset 后旧 native session 的迟到 Hook 丢弃；
- PTY exited 后所有迟到 Hook 丢弃，但记录 bounded diagnostic count。

### 8.3 Parser 与 Projector 分离

```text
unknown JSON
  → ClaudeHookParser（schema 收窄、大小/字符串/数字限制）
  → ClaudeNativeFact（仍是 Claude 私有联合类型）
  → ClaudeHookProjector（关联、去重、乱序修复）
  → AdapterEvent
  → S1 Runtime 分配 id / seq
  → AgentEvent
```

Parser 是纯函数；Projector 是有状态纯投影对象。Ingress、文件系统、HTTP、PTY、EventLog 都不能进入
这两个模块，fixture 可直接驱动它们。

---

## 9. 低置信度兜底与 Observer watchdog

Hook 是 best-effort 通道：进程可能连接失败、HTTP URL 可能被 policy 静默拦截、file/curl 投递也可能
在武装成功后中断。不能因此把 Session 永久卡在 working，也不能把沉默冒充 turn completed。

### 9.1 首次投递 watchdog

Adapter health 使用内部三态：

```text
unconfirmed → healthy → stale
```

- settings 注入后先是 `unconfirmed`，首个合法 Hook delivery 后变 `healthy`；
- PTYManager 只在内部 seam 提供“不含内容的输入提交边界”（写入中出现 CR/LF）和最后输出时间；
- observer 已武装、PTY 存活、发生输入提交后 10 秒仍没有任何 Hook 时，发一次
  `observer.degraded(hook-handshake-timeout)` 并标记 `stale`；
- 只有静态 policy probe 明确为 denied 时才使用 `http-hooks-not-allowed`；超时不能武断归因于 allowlist；
- onboarding/menu 中的 Enter 可能造成误判，因此 watchdog 不 dispose route、不杀 PTY；后续合法 Hook
  到达立即恢复 `healthy`，正常事件覆盖低置信度状态；
- UI 显示“监听尚未确认/监听中断”，不能继续显示已完整监听。

### 9.2 丢失终结事件的沉默兜底

当最后一个可信状态是 working，但 Stop、StopFailure、Notification(idle_prompt) 等终结事件丢失时：

1. 同时观察 `lastHookAt` 与 PTYManager 的 `lastOutputAt`；
2. 两者连续 5 分钟都无活动、PTY 仍存活且没有未解决 approval/input 时，发
   `observer.degraded(silent-session)`；
3. Runtime 生成低置信度 `session.idle(reason='observer-silence')`，状态可被下一条结构化 Hook 回滚；
4. **不发 `turn.completed`，不写 completed history，不触发完成通知，不增加完成统计**；
5. 下一条高置信度 Hook 清除 idle override，并按保留的 tool/turn correlation 重新投影；
6. needs-you 不会被沉默超时清除；request 只按 §7.4 的确定规则或硬 TTL 收口。

默认 5 分钟是首版保守值，作为常量记录诊断；真实会话验收后才能调整。这个兜底解决 stuck working，
但不会把“可能完成”伪装成“确定完成”。

### 9.3 低置信度终端字幕

Hooks 能驱动权威状态，但不保证提供当前 token 进度。PTY 原始字节是 ANSI 差分重绘流，不能当作
可见屏幕做正则；P6 只读取 renderer 已经由 xterm 解析完成的 buffer，并走独立 interface：

```ts
interface LiveCaptionUpdate {
  sessionId: string
  text: string
  source: 'rendered-terminal'
  confidence: 'low'
  observedAt: number
  expiresAt: number
}
```

规则：

- renderer 最多 600ms 读取一次 xterm 当前 viewport 底部 12 行，只匹配结构化 `↓ … tokens`；
- 只把 token 数和规范化后的 `↓ … tokens` caption 送过 IPC；activity word、thinking 正文和屏幕行
  都不离开 renderer；主进程再次按 terminalId 关联权威 Session，并执行长度/数值上限校验；
- 2026-08-03 根据侧边栏“显示最新内容”的产品决策，caption 以可合并的瞬态
  `activity.caption` 进入实时投影；它只更新 `detail/latestDetail`，不参与六态推导、不进 EventLog、
  不触发通知或 attention；
- token marker 消失不能推断 `turn.completed`；权威结束只来自 Hook/PTY；
- Hook 有高置信度 tool/approval/detail 时覆盖 caption；空闲时保留最后一条内容；
- P6 可单独删除且不影响六态。

---

## 10. 降级模型

统一 reason code，不把内部异常字符串直接送 UI：

```ts
type ClaudeObserverDegradedReason =
  | 'unsupported-version'
  | 'user-settings-conflict'
  | 'managed-hooks-only'
  | 'http-hooks-not-allowed'
  | 'wsl-transport-unavailable'
  | 'settings-create-failed'
  | 'hook-ingress-unavailable'
  | 'hook-handshake-timeout'
  | 'hook-timeout'
  | 'silent-session'
  | 'stale-request'
  | 'hook-queue-overflow'
  | 'invalid-payload'
  | 'observer-disconnected'
```

降级原则：

- prepare 前可知的问题：不注入 settings，直接 lifecycle-only；
- spawn 后首个 Hook 超时：按 §9.1 的输入提交边界判断，不能因用户尚未输入 prompt 就误报；
- 中途 transport 断开：只发一次 `observer.degraded`，PTY 保持运行；
- stale 不是永久终态；后续合法 Hook 可以恢复 health 并覆盖低置信度 idle；
- capability 从 `hooks` 降为 lifecycle 后，UI 隐藏不再可信的 thinking/tool/request 数值；
- observer degraded 与 Claude error 分离，不能把 SessionStatus 改成 error；
- 诊断保留 reason、runtime、transport、Claude version 和计数，不保留 Hook payload。

---

## 11. 幽灵 Session 防线

S2 必须沿用并收紧 S0 的“spawn 成功后才提交 Session”原则：

```text
provisional terminal
  → Adapter.prepare
  → PTY spawn
  → Adapter.attach / 明确 lifecycle 降级
  → Runtime 发布 session.started
  → renderer 提交 terminal + Session 展示副本
```

回滚矩阵：

| 失败点 | PTY | Session | history sessions | temp/hooks |
|---|---|---|---|---|
| prepare 失败但可降级 | 继续创建 | spawn 后创建 | +1 | 已清理 |
| settings/transport 不安全 | 原生启动 | spawn 后创建 | +1 | 不注入 |
| PTY spawn 失败 | 不存在 | 不创建 | 不增加 | 全清理 |
| attach 失败 | 保留 | 创建 lifecycle Session | +1 | semantic route 清理 |
| PTY 立即退出 | exited | 创建后立刻 exited | start/exit 各一次 | 全清理 |
| renderer reload | 保留 | main projection 保留 | 不重复 | 保留 |
| 用户关闭 terminal | kill/清历史 | 从 active 移除 | exit 最多一次 | 全清理 |

实现约束：

- `session.started` 与 `session.exited` 都由 Runtime 单写；删除 TerminalView 的 Agent lifecycle 双写；
- Session、PTY、Hook route 使用同一个 Runtime record，不能靠三个 Map 互相猜；
- `stop()`、PTY exit callback、App quit 竞争时用一次性 dispose guard；
- EventLog 按 `sessionId + lifecycle kind` 去重；
- route 注册应在 spawn 前完成以免丢首个事件，但 Session 仍在 spawn 成功后才对外可见；
- spawn 失败时 route 收到的任何意外事件全部丢弃，不得反向创建 Session。

---

## 12. 实施顺序

### P0 — S1 前置落地 ✅（2026-08-03 由 [PLAN-S1.md](./PLAN-S1.md) 完成）

1. 实现 `AgentSessionRuntime`、`AgentEvent`、reducer、projection、fixture adapter；
2. 把 AI CLI spawn 从 renderer 编排收进 Runtime；
3. Runtime 单写 lifecycle 与 EventLog；
4. 证明失败不留幽灵 Session。

验收：不接 Claude 时 fixture 已能驱动六态；普通终端完全不经过 Agent Runtime。

S1 交接给 S2 的起点（按 [PLAN-S1.md](./PLAN-S1.md) §12.2 核对）：

- `shared/agent-events.ts` 的 `AgentEvent` / `ObserverCapabilities` / `AgentSessionProjection` /
  `AgentApi` 契约已固定，S2 不得为 Claude 添加公共字段；
- Adapter seam：`electron/agents/adapters/types.ts`（prepare → LaunchAugmentation，attach →
  AdapterEvent → Runtime envelope）；Claude Adapter 放 `electron/agents/adapters/claude/`；
- `observer.degraded` 的 reason/remaining 由 Runtime 归约，Adapter 只提供事实；
- EventLog 已支持 `blocked` kind；tool/approval 按 `sessionId + callId/requestId` 去重；
- S1 的 interface 门禁（`e2e/agent-session.spec.ts`）是 S2 fixture 重放的测试表面。

### P1 — Claude fixtures、Parser 与 Projector

实现状态：核心代码已完成；脱敏 fixture 与真实版本重放记录待补。

1. 从本机 Claude 版本抓取脱敏 Hook fixture；
2. 复核 `PreToolUse/PostToolUse.tool_use_id`、可选 `SessionEnd.reason` 与本机 payload；
3. 实现 native union、parser 限制和安全 summary；
4. 实现 tool 并发、唯一 permission 关联、request TTL、AskUserQuestion、Stop/background、
   SessionEnd reset；
5. 固化 native fact → AgentEvent 表。

验收：不启动 Electron/PTY 即可用 fixture 重放完整 turn；实现阶段执行何种验证由用户另行决定。

### P2 — App 级 HookIngress

实现状态：已完成单例 loopback server、随机 route、1 MiB body cap、快速 204、
会话级有界队列与 App quit 清理。

1. 单例 loopback server、随机 route、body cap、快速 204；
2. Session route register/unregister；
3. 独立有界队列、dispose 与 App quit；
4. 不可信 JSON 只进入 Parser。

验收：Ingress 不等待 EventLog/renderer，坏请求不能影响其它 Session。

### P3 — Host Claude Adapter

实现状态：已完成 Windows/macOS/Linux 共用 Adapter、HTTP policy best-effort 预检、
per-session settings、`--settings` 注入、10 秒首次投递 watchdog 与 5 分钟双时钟沉默兜底。

1. capability/version probe；
2. HTTP allowlist 三态 policy probe；
3. per-session settings 与 `--settings` augmentation；
4. Windows/macOS/Linux HTTP hook；
5. 首次投递与 silent-session watchdog；
6. observer capabilities/degraded reason；
7. 临时目录与幂等清理。

验收：三个 host 平台使用同一 Adapter，只有路径/权限实现不同。

### P4 — WSL transport

实现状态：已完成运行时 `wslpath`、file 原子往返 probe、`curl.exe --version` 实测、
file-first 选择、300ms drop poller 与 lifecycle-only 降级；真实 distro 验收待补。

1. 扩展按 distro 的 `windowsMountRoot` 扫描缓存，但只把缓存当提示；
2. 武装时并行执行 file 可写往返、`curl.exe --version` 与 settings path 翻译；
3. 实现 file-first 的 drop bridge + 300ms poller；
4. 实现 curl fallback 的 command hook exec form；
5. 自定义挂载根、automount disabled、只读挂载、systemd-binfmt 失效均进入正确分支；
6. 两通道都不可用时删除 settings/route，明确 lifecycle 降级。

验收：Windows host Claude 与每个 WSL Claude 是独立 Session/route，不能串事件。

### P5 — Runtime/UI 收尾

实现状态：Runtime/PTY 的 input-submit seam、统一清理、Claude 注册、Windows 真实会话记录与
Sidebar/悬浮窗投影已完成；设置页 capability/transport 展示及更多平台矩阵转入非阻塞跟进。

1. 删除 renderer Agent lifecycle 双写；
2. SessionStore 只 upsert main projection；
3. Home/Sidebar 展示真实 working/needs-you/done/error/idle/exited；
4. EventLog 低敏投影与去重；
5. 设置页显示 Adapter capability、transport 和降级 reason；
6. 补真实会话验收记录。

M6 起新增或复核场景统一使用 [Adapter 验收模板](./ADAPTER-ACCEPTANCE-TEMPLATE.md)；本节未勾选的
跨平台/策略组合继续保留为覆盖台账，不再代表 S2 首版未完成。

验收：关闭、失败、reload、重复 Hook、WSL 断桥均不留幽灵 Session。

### P6 — 可选 LiveCaption

实现状态：已完成 xterm 已渲染 viewport 尾部状态行白名单解析、600ms 小窗口读取、token caption
合并与侧边栏最新内容保留。PTY 原始差分流不参与解析；展开的 thinking 正文和完整屏幕行不离开
renderer；token 数仅是低置信度 TUI 展示值，不升级 `usage` capability。真实 Claude E2E 通过
渲染 buffer → IPC → Runtime → reducer → Sidebar 全链路验证。

1. 独立低置信度 caption interface；
2. renderer xterm buffer 状态行抽取；
3. latest-detail/覆盖规则；
4. 验证删除 P6 不影响任何权威状态。

2026-08-03 真实 Windows Claude 2.1.220 E2E（Kimi provider）完成两轮对话，采集 86 个 xterm
可见帧和 18 个统一事件：`UserPromptSubmit → thinking → Stop`，以及
`UserPromptSubmit → thinking → PreToolUse(Bash) → PermissionRequest → PostToolUse →
PostToolBatch → thinking → Stop`。观察到的状态行至少包括：

- `Honking…`（无计时、无 token）；
- `Flambéing… (4s · thinking)`；
- `Photosynthesizing… (15s · still thinking)`；
- `Elucidating… (10s · ↓ 844 tokens)`；
- `Baked for 18s`（完成后的 TUI 文案，不作为完成事实）。

侧栏展示优先级必须与状态事实分离：needs-you/error/exited/done 的权威文案优先于 caption；working
时依次显示待审批摘要、活动 tool、白名单状态行、`思考中`；done 必须显示 `已完成`，可附带本轮最后
一次低置信度 token 数，不能只靠绿色圆点，也不能继续显示 working 阶段的 caption。

P6 不阻塞 S2 完成。

---

## 13. 验收矩阵

### 13.1 行为场景

- [ ] 无 tool 的普通问答：working → done；
- [ ] 单 tool：thinking → tool → thinking → done；
- [ ] 并行 tools：全部 call 独立完成，只计数一次；
- [ ] PermissionRequest：needs-you，解决后恢复 working；
- [ ] 两个并行同名 tool 请求权限：不做歧义关联、不误报 approved；
- [ ] 未关联 PermissionRequest：turn terminal event/SessionEnd/TTL 后不会永久 needs-you；
- [ ] AskUserQuestion：needs-you，回答后恢复 working；
- [ ] tool failure：tool failed，但只有 StopFailure 才令 turn error；
- [ ] StopFailure：error；
- [ ] background task：Stop 后保持 working；
- [ ] scheduled cron：本轮完成后 idle，不无限 working；
- [ ] `/clear`：不退出 Session；
- [ ] `/resume`：重置 native correlation，不产生第二个 Vibing Session；
- [ ] Claude 自行退出：exited，history exit 只写一次；
- [ ] 用户关闭：PTY、route、poller、temp 全清理；
- [ ] Hook 重复/乱序/丢失：不重复统计，不杀 PTY；
- [ ] Stop/idle notification 丢失：5 分钟双时钟沉默后 low-confidence idle，不写 completed；
- [ ] HTTP allowlist 明确阻断：启动即 lifecycle-only；
- [ ] HTTP policy unknown 且首个 Hook 未到：watchdog 标记 stale，后续 Hook 可恢复；
- [x] renderer reload：主进程恢复原 terminalId/ptyId 并重放权威历史，Session 投影与 Hook 原地保留，不重新 spawn/注入；
- [ ] managed policy 禁止 Hook：Claude 正常启动，Session lifecycle-only。

### 13.2 平台场景

- [ ] Windows host + HTTP hook；
- [ ] macOS host + HTTP hook；
- [ ] Linux host + HTTP hook；
- [ ] WSL + file drop；
- [ ] WSL file 不可用 + `curl.exe` interop 回退；
- [ ] 扫描时 curl 可用、武装时 systemd-binfmt 已移除 handler → 不选 curl；
- [ ] 自定义 Windows 挂载根 `/c/`，不依赖 `/mnt/c`；
- [ ] 缓存挂载根过期，武装时往返 probe 纠正结果；
- [ ] WSL 无 interop/无 Windows mount → lifecycle-only；
- [ ] Windows host 与 WSL 同时启动 Claude，route 不串线；
- [ ] 两个 WSL distro 同时启动 Claude，route 不串线。

### 13.3 隐私与安全

- [ ] EventLog/IPC/诊断不含 prompt；
- [ ] 不含 tool_input/tool_response；
- [ ] 不含 assistant 正文与 hidden thinking；
- [ ] HTTP 只绑定 loopback，token 不可猜；
- [ ] 1 MiB 以上 body 被拒绝；
- [ ] temp 路径 symlink/reparse point 不被跟随；
- [ ] 不修改任何用户/项目/managed settings；
- [ ] 不返回 Hook decision 或 additional context；
- [ ] 不批量清空认证/代理相关 `CLAUDE*` 环境变量。

---

## 14. S2 能力声明

完成后 Claude Code Adapter 对实际启用 Hook 的会话声明：

```ts
{
  thinking: 'phase',
  tools: 'lifecycle',
  approvals: 'structured',
  inputRequests: 'structured',
  usage: 'none',
  messages: 'none'
}
```

说明：

- Hooks 可可靠表达 thinking phase 与 tool lifecycle，但不提供隐藏 thinking 内容；
- 首版不从 transcript 猜 usage，因此 usage 是 `none`；
- `Stop.last_assistant_message` 可用不代表默认采集 message，首版 messages 是 `none`；
- capability 是本次会话实际结果；任何 transport/policy 降级后返回 lifecycle-only；
- 后续若官方 Hook 提供结构化 usage 或安全 message summary，再通过独立事实核验升级能力。

---

## 15. S3 验证结论与 M6 交接

1. `AgentObserverAdapter.prepare/attach/dispose` 保持小接口，Hook transport、PermissionRequest 关联、
   batch、SessionEnd reset 与 background task 均留在 Claude 私有实现；
2. OpenCode 使用完全不同的 Server/SSE + reconcile 协议复用了同一 Runtime、事件与 projection；
3. Observer 失败与 Agent error 已分离，lifecycle-only 降级不影响可用 CLI；
4. 公共事件没有引入只服务 Claude Hook 的 native 字段；
5. Windows/WSL 已提供真实协议证据，macOS/Linux 与 managed policy 继续作为扩展矩阵，不伪称已验收；
6. S3 OpenCode 已完成第二协议验证，M6 v1 contract 自 2026-08-04 起冻结；Codex 进入 M6 首批。

后续产品统一使用 [Adapter 验收模板](./ADAPTER-ACCEPTANCE-TEMPLATE.md)。如确需修改公共契约，必须
给出至少两个产品的共同事实与现有 Adapter 回归证据。
