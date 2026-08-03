# S1 实施计划 —— Agent Observer 基础设施

> 状态：**已完成（2026-08-03）**。实现与验收见下方 §11 各 P 的勾选与 §12 清单；
> SPEC-S 已回写。S2 Claude Hooks 与 S3 OpenCode Server/SSE 已完成第二协议验证；公共事件与
> Adapter seam 自 2026-08-04 起进入 v1 冻结，后续按跨产品事实做兼容扩展。
>
> 目标：在不解析 xterm 画面、不阻塞 PTY 输入输出、不修改用户全局 CLI 配置的前提下，建立
> 统一的 Agent Event、Observer Adapter seam、主进程状态归约和 renderer 推送链路。
>
> 对应 [SPEC-S.md](./SPEC-S.md) §8–§9。前置：S0 三端扫描与按安装启动逻辑已完成；S0
> 跨平台自动化矩阵仍可独立补齐，不阻塞本计划的接口评审。

---

## 1. 交付边界

### 1.1 S1 交付

- 主进程权威的 `AgentSessionRuntime`，统一负责 AI CLI 会话启动、Observer 生命周期与失败回滚；
- 小型 `AgentObserverAdapter` interface，容纳不同 CLI 的 JSONL、RPC、Hooks、transcript 等差异；
- 结构化 `AgentEvent` 联合类型，覆盖 thinking、tool call、approval、input、usage、turn 和生命周期；
- 主进程纯函数状态归约器，把事件事实投影成现有六态 Session；
- 有界、可降级的 Agent Event 总线；
- 语义事件到既有 `EventLog` / all-time stats 的低敏投影；
- 收窄的 preload IPC：启动/停止 Agent 会话、订阅事件和 Session 投影；
- `LifecycleObserverAdapter` 与可编程 fixture adapter，用于证明深模块 interface 和降级路径；
- Claude Code、OpenCode 两种真实 Adapter 的接口位置与验收合同；真实协议接入分别归 S2/S3。

### 1.2 S1 不交付

- 不接入任何真实 CLI 的 Hooks、JSONL、ACP 或 App Server；
- 不把 thinking 文本、隐藏推理链、完整 prompt、tool 参数或 tool 输出写入历史；
- 不从 PTY 字节、xterm buffer、窗口标题或关键词推导语义；
- 不监听 Vibing 之外启动的外部 CLI；
- 不实现通知、悬浮窗、代批、代答、重试或远程控制；
- 不批量实现产品 Adapter；那是 S2/S3 验证 seam 后的 M6。

### 1.3 完成标志

S1 完成时，使用 fixture adapter 启动一条会话，可以按顺序看到：

```text
session.started
turn.started
thinking.started
thinking.completed
tool.started
approval.requested
approval.resolved
tool.completed
usage.updated
turn.completed
session.exited
```

这些事实能稳定推导 `working → needs-you → working → done → exited`，并且 Observer 失败、事件
突发或 renderer 刷新都不会影响 CLI 的 PTY 会话。

---

## 2. 当前基线与必须修正的职责

| 当前实现 | S1 处理 |
|---|---|
| Renderer 先调用 `cliApi.prepareLaunch`，Terminal 挂载后再调用 `ptyApi.spawn` | CLI 启动编排收进主进程 `AgentSessionRuntime`；普通终端仍直接使用 PTY interface |
| Session 在 renderer Zustand 中维护 | 活跃 Agent Session 的权威投影移到主进程；renderer 只缓存展示副本 |
| `TerminalView` 根据 PTY exit 直接写 Session `exited` | PTYManager 通过内部 seam 通知 Runtime；退出事实只归约一次，再推送 renderer |
| `HistoryEvent` 只有低维 `kind/title/detail` | 保留为历史投影，不把它冒充完整 Agent Event |
| `events:record` 允许 renderer 写生命周期事件 | Agent 语义与生命周期改由主进程写；renderer 不再是语义事实来源 |
| all-time 已预留 toolCalls / blocked / approvals | 由 Agent Event 投影器按稳定去重键累加 |

核心约束：**Agent Event 是事实，SessionStatus 是事实的投影，HistoryEvent 是事实的低敏摘要。**
三者不能合并成一个可选字段大对象。

---

## 3. 模块与 seam

### 3.1 主进程总图

```text
Renderer NewSessionFlow / TerminalView
              │ agent:start / agent:stop
              ▼
┌─────────────────────────────────────────────────────────────┐
│ AgentSessionRuntime                                         │
│  validate selection → choose adapter → prepare observation  │
│  → compose safe launch → PTY spawn → attach observer        │
│  → normalize events → reduce state → persist/project        │
│  → rollback / dispose                                       │
└──────────────┬──────────────────────┬───────────────────────┘
               │                      │
      internal Adapter seam     internal PTY seam
               │                      │
    ┌──────────┴──────────┐       PTYManager
    │ Lifecycle Adapter   │          │
    │ Fixture Adapter     │          ├─ data → renderer（原链路）
    │ Claude Adapter (S2) │          └─ exit → Runtime
    │ OpenCode Adapter(S3)│
    └─────────────────────┘
               │ AgentEvent
               ▼
       EventReducer + EventProjector
          │                  │
          ├─ SessionProjection → renderer
          └─ HistoryEvent / stats → EventLog
```

### 3.2 外部 Interface：`AgentSessionRuntime`

调用者只需要知道“启动”和“停止”；安装解析、Adapter 选择、临时资源、Observer attach、降级和清理
全部留在模块实现内部。

```ts
interface AgentSessionRuntime {
  start(input: StartAgentSession): Promise<StartedAgentSession>
  stop(sessionId: string): Promise<void>
}

interface StartAgentSession {
  terminalId: string
  selection: CliLaunchSelection
  cols: number
  rows: number
}

interface StartedAgentSession {
  sessionId: string
  terminalId: string
  ptyId: string
  installationId: string
  adapterId: string
  capabilities: ObserverCapabilities
  projection: AgentSessionProjection
}
```

Interface 合同：

- `start` 成功意味着 PTY 已创建，临时监听资源已准备，Observer 已 attach 或已明确降级为 lifecycle；
- `start` 失败必须清理临时文件、监听进程和已创建的 PTY，不产生 Session 或历史启动计数；
- Observer attach 失败默认**不杀 CLI**，返回 lifecycle-only capabilities，并产生 `observer.degraded`；
- `stop` 幂等；无论手动关闭、进程自行退出还是应用退出，都最多执行一次清理；
- Runtime 不向调用者暴露具体 Adapter、hook 文件、socket、transcript path 或协议连接。

### 3.3 内部 Adapter seam

Claude Hooks 与 OpenCode Server/SSE 提供两种真实协议形态，因此这个 seam 不是为单一实现制造的
假抽象。产品原生字段必须留在各 Adapter 私有层，公共接口只接受跨产品事实。

```ts
interface AgentObserverAdapter {
  readonly id: string
  readonly source: AgentEventSource
  readonly capabilities: ObserverCapabilities

  supports(context: ObserverPreparationContext): boolean
  prepare(context: ObserverPreparationContext): Promise<PreparedObserver>
}

interface PreparedObserver {
  readonly launch: LaunchAugmentation
  readonly capabilities?: ObserverCapabilities

  attach(
    context: RunningAgentContext,
    emit: (event: AdapterEvent) => void
  ): Promise<ObserverHandle>

  dispose(): Promise<void>
}

interface ObserverHandle {
  readonly capabilities?: ObserverCapabilities
  onDisconnect?(listener: (reason: string) => void): () => void
  reconnect?(): Promise<ObserverHandle>
  dispose(): Promise<void>
}
```

`prepare` 与 `attach` 分开是必要的：部分 CLI 必须在 spawn 前通过临时 settings、环境变量或安全参数
启用结构化信号；另一些协议只能在进程创建后连接本地 socket/server。`PreparedObserver.dispose()` 负责
spawn 失败或用户取消时的前置资源回收。

`LaunchAugmentation` 只能表达受控变化：

```ts
interface LaunchAugmentation {
  env?: Record<string, string>
  prependArgs?: string[]
  appendArgs?: string[]
}
```

Adapter 不得自行 spawn 主 CLI，不得替换用户工作区，不得添加权限绕过参数，也不得修改用户全局配置。

### 3.4 Adapter 选择

- 注册表以 `adapterId` 为稳定键；扫描定义与 Observer Adapter 仍是两层数据；
- Runtime 只在所选安装、当前平台和 CLI 版本满足 `supports` 时启用对应 Adapter；
- 没有语义 Adapter 时使用 `LifecycleObserverAdapter`，能力声明全部为 `none`；
- 同一会话只允许一个主事件源。辅助源只能补主源缺失的能力，并必须有明确去重规则；
- 禁止同时读取多个来源后用时间近似合并 tool call，避免重复计数和错误状态。

---

## 4. 统一事件模型

### 4.1 公共字段

```ts
type AgentEventSource =
  | 'native-stream'
  | 'jsonl'
  | 'rpc'
  | 'acp'
  | 'hook'
  | 'transcript'
  | 'lifecycle'
  | 'fixture'

interface AgentEventBase {
  id: string                 // Runtime 生成的全局去重 id
  sessionId: string
  adapterId: string
  installationId: string
  seq: number                // Runtime 分配的每 Session 单调序号
  occurredAt: number         // 主进程接收/确认时间
  source: AgentEventSource
  nativeType?: string        // 有界诊断字段，不参与状态逻辑
}

type EventOf<K extends string, P> = AgentEventBase & {
  kind: K
  payload: P
}
```

不能只依赖时间戳排序。Adapter 事件经过 Runtime 后统一获得 `seq`；重复 native id、重复 hook delivery
或 RPC reconnect replay 必须在归约前去重。

### 4.2 事件联合类型

```ts
type AgentEvent =
  | EventOf<'session.started', { cwd?: string }>
  | EventOf<'session.idle', SessionIdlePayload>
  | EventOf<'session.exited', { exitCode?: number; signal?: number }>
  | EventOf<'turn.started', { turnId: string }>
  | EventOf<'turn.completed', { turnId: string; outcome?: 'completed' | 'cancelled' }>
  | EventOf<'turn.failed', { turnId: string; message: string }>
  | EventOf<'thinking.started', { turnId: string }>
  | EventOf<'thinking.completed', { turnId: string; summary?: string }>
  | EventOf<'message.completed', { turnId?: string; role: 'assistant' | 'system'; summary?: string }>
  | EventOf<'tool.started', ToolStartedPayload>
  | EventOf<'tool.progress', ToolProgressPayload>
  | EventOf<'tool.completed', ToolCompletedPayload>
  | EventOf<'tool.failed', ToolFailedPayload>
  | EventOf<'approval.requested', ApprovalRequestedPayload>
  | EventOf<'approval.resolved', ApprovalResolvedPayload>
  | EventOf<'input.requested', InputRequestedPayload>
  | EventOf<'input.resolved', InputResolvedPayload>
  | EventOf<'usage.updated', UsagePayload>
  | EventOf<'observer.degraded', { reason: string; remaining: ObserverCapabilities }>
```

Idle 可以是高置信度协议事实，也可以是 Observer 沉默保护，但必须显式区分：

```ts
interface SessionIdlePayload {
  since: number
  reason: 'protocol-idle' | 'observer-silence' | 'scheduled-wakeup'
  confidence: 'high' | 'low'
}
```

低置信度 idle 是可逆状态覆盖：不等价于 `turn.completed`，不写 completed history；下一条高置信度
Agent Event 清除覆盖并按仍保留的活动事实重新投影。

工具事件至少保留稳定关联：

```ts
interface ToolStartedPayload {
  callId: string
  turnId?: string
  name: string
  category?: 'read' | 'edit' | 'shell' | 'search' | 'network' | 'mcp' | 'other'
}

interface ToolProgressPayload {
  callId: string
  summary?: string
}

interface ToolCompletedPayload {
  callId: string
  durationMs?: number
}

interface ToolFailedPayload {
  callId: string
  durationMs?: number
  message: string
}
```

Approval 与用户输入必须拥有独立 request id，不能只靠最近一个 tool call 猜关联：

```ts
interface ApprovalRequestedPayload {
  requestId: string
  callId?: string
  category: 'tool' | 'command' | 'file-change' | 'network' | 'other'
  summary?: string
}

interface ApprovalResolvedPayload {
  requestId: string
  decision: 'approved' | 'denied' | 'cancelled'
}

interface InputRequestedPayload {
  requestId: string
  prompt?: string
}

interface InputResolvedPayload {
  requestId: string
}
```

Usage 允许不同 CLI 只提供部分字段：

```ts
interface UsagePayload {
  inputTokens?: number
  outputTokens?: number
  cachedInputTokens?: number
  contextTokens?: number
  contextWindow?: number
  costUsd?: number
  scope: 'turn' | 'session'
}
```

### 4.3 Thinking 的隐私规则

- `thinking.started/completed` 表示阶段事实，不代表存储模型隐藏推理；
- 默认不接收、不广播、不持久化 chain-of-thought delta；
- 只有 CLI 明确提供可展示的 reasoning summary 时，才允许写入有界 `summary`；
- summary 必须经过长度限制和控制字符清理，不能包含完整 prompt、环境变量或 tool 原始输出；
- UI 可以显示“思考中”和耗时，但不能声称所有 CLI 都能提供 thinking 内容。

---

## 5. 能力声明

```ts
interface ObserverCapabilities {
  thinking: 'none' | 'phase' | 'summary'
  tools: 'none' | 'lifecycle' | 'progress'
  approvals: 'none' | 'structured'
  inputRequests: 'none' | 'structured'
  usage: 'none' | 'tokens' | 'context' | 'tokens-and-context'
  messages: 'none' | 'summary'
}
```

规则：

- 能力是本次会话真实启用的能力，不是品牌宣传能力；
- Adapter attach 降级后必须返回剩余能力并发出 `observer.degraded`；
- UI 只渲染 capability 支持的数据；不支持时显示缺省或隐藏，禁止补零冒充真实值；
- capability 随安装版本和运行方式变化，例如同一 CLI 的 native stream 与普通 TUI 可能不同。

---

## 6. 状态归约

### 6.1 主进程权威投影

```ts
interface AgentSessionProjection {
  sessionId: string
  terminalId: string
  installationId: string
  adapterId: string
  status: 'working' | 'needs-you' | 'done' | 'error' | 'idle' | 'exited'
  statusConfidence: 'high' | 'low'
  observerHealth: 'unconfirmed' | 'healthy' | 'stale' | 'lifecycle-only'
  detail?: string
  activeTurnId?: string
  activeToolCount: number
  pendingAttentionCount: number
  usage?: UsagePayload
  lastActivityAt: number
  capabilities: ObserverCapabilities
  lastSeq: number
}
```

归约器是纯函数：

```ts
reduceAgentSession(
  previous: AgentSessionProjection,
  event: AgentEvent
): AgentSessionProjection
```

### 6.2 状态优先级

```text
session.exited
  → exited（终态）

未解决 approval/input request > 0
  → needs-you

低置信度 observer-silence idle override
  → idle（可逆，不清除内部 turn/tool correlation）

turn / thinking / active tool > 0
  → working

turn.failed 或 observer 确认的 agent error
  → error

turn.completed
  → done

显式 idle timeout 事件
  → idle
```

- `observer.degraded` 不是 Agent error；CLI 仍可工作，只降低可观测能力；
- 低置信度 idle 只能覆盖 working/普通 idle，不能覆盖 needs-you 或 exited；
- 任意后续高置信度语义事件清除 low-confidence idle override，把 `observerHealth` 恢复为 healthy，
  再按仍保留的 turn/tool/request 事实重新归约；
- tool failed 不必自动令整个 Session 为 error，除非原生协议同时给出 turn/session failure；
- `needs-you` 由未解决 request 集合推导，解决一个 request 不能清掉其它待处理项；
- idle 计时到期时由 Runtime 生成 `session.idle` 事实，再归约；不能在 renderer 用本地时钟猜；
- 所有投影更新按 `seq`，旧序号、重复 id 和 exited 后的迟到事件忽略。

### 6.3 Detail 生成

Detail 由公共投影器生成，不由 Adapter 写任意 UI 文案：

- thinking：`Thinking`；
- tool：优先显示最近活动 tool 的安全名称；
- approval/input：显示有界 summary，没有 summary 时显示通用“等待处理”；
- done/error/exited：使用 i18n key + 结构化参数；
- Adapter 只提供事实字段，renderer 负责最终语言显示。

---

## 7. 启动与清理时序

### 7.1 成功路径

```text
1. Renderer 建立 provisional terminal，保存 CliLaunchSelection
2. TerminalView fit 后调用 agent:start(selection, terminalId, cols, rows)
3. Runtime 重新校验 installation id
4. Runtime 选择 Adapter，调用 prepare
5. Runtime 把安全 LaunchAugmentation 合并进扫描得到的 SpawnOptions
6. PTYManager 创建真实 PTY
7. Runtime 调用 PreparedObserver.attach
8. attach 成功或明确降级后，Runtime 生成 session.started
9. Runtime 返回 ptyId/sessionId/projection/capabilities
10. Renderer wire `PtyProxy`，提交 Session 展示副本
```

步骤 8 之前不得写 `session_start` 计数；步骤 9 失败必须走统一回滚。

### 7.2 失败与降级

| 失败点 | 行为 |
|---|---|
| installation 已失效 | 不创建 PTY，提示重新扫描 |
| Adapter `prepare` 失败 | 默认降级 lifecycle；若产生不完整 launch augmentation，则清理后继续原生 CLI |
| PTY spawn 失败 | dispose prepared observer，删除临时资源，不创建 Session |
| Observer attach 失败 | CLI 保持运行，发 `observer.degraded`，能力降为 lifecycle |
| Event source 中途断开 | 尝试一次有界重连；失败后降级，不杀 PTY |
| renderer 刷新/窗口隐藏 | Observer 继续在主进程运行；重新订阅后用当前 projection 补状态 |
| CLI exit | 先生成 `session.exited`，再 dispose observer 和临时资源 |
| app quit | Runtime 对所有会话幂等 stop；不能遗留 hook server、socket 或 temp settings |

### 7.3 全局配置零修改

- Adapter 临时文件统一放在 `<userData>/observer-runs/<sessionId>/`；
- 目录与文件使用仅当前用户可读写的权限；
- 需要 CLI settings 时通过该 CLI 官方支持的显式参数或环境变量指向临时文件；
- 不编辑 `~/.claude`、`~/.codex`、`~/.config`、Windows AppData 内的用户原文件；
- stop、spawn failure、超时和下次启动清理 stale run directory 都必须覆盖。

---

## 8. 事件总线、背压与持久化

### 8.1 有界队列

Agent Event 与 PTY 字节使用完全独立的队列。Observer 卡顿不能调用 `pty.pause()`，PTY 背压也不能阻塞
Observer。

- 每 Session 队列按事件数和编码后字节数双上限；
- `tool.progress`、重复 usage update 等可合并事件先丢弃或覆盖旧值；
- approval/input、tool terminal、turn terminal、session exit 永不因 progress 洪峰被静默丢弃；
- 超限必须发一个去重的 `observer.degraded`，而不是无限打印错误；
- IPC 推送批处理，避免每个 token/progress delta 都触发 React render。

### 8.2 持久化投影

不把全部 Agent Event 原样塞进现有 `events.jsonl`。`AgentEventProjector` 只投影低频、低敏事件：

| Agent Event | HistoryEvent / stats |
|---|---|
| `session.started` | `session_start`，sessions +1 |
| `tool.started` | `tool_call`，按 `sessionId + callId` 去重，toolCalls +1 |
| `approval.requested` | `blocked`，按 requestId 去重，blocked +1 |
| `approval.resolved(approved)` | `approved`，按 requestId 去重，approvals +1 |
| `turn.completed` | `completed` |
| `message.completed` | 可选 `message`，只保存安全 summary |
| `session.exited` | `session_exit` |

thinking phase、tool progress、usage 高频更新只用于实时投影；S1 不默认持久化完整原始流。未来如果需要
回放，另立带隐私与容量策略的 Agent Journal 规格，不能悄悄扩大 M5.c EventLog 的含义。

### 8.3 输入校验

- Adapter 输出一律视为不可信输入；
- 所有 id、name、summary、message 都有长度上限并清理 NUL/控制字符；
- usage 数值必须有限、非负，并设置合理上限；
- 未知 native event 允许计入诊断，不进入状态归约；
- event payload 绝不能被拼接后执行成命令、路径或参数。

---

## 9. IPC 与 Renderer

### 9.1 IPC

新增收窄 interface：

```ts
interface AgentApi {
  start(input: StartAgentSession): Promise<StartedAgentSession>
  stop(sessionId: string): Promise<void>
  listActive(): Promise<AgentSessionProjection[]>
  onEvents(cb: (events: AgentEvent[]) => void): () => void
  onProjection(cb: (projection: AgentSessionProjection) => void): () => void
}
```

- `agent:start/stop/list-active` 使用 invoke；
- `agent:events` 与 `agent:projection` 使用 Main → Renderer send；
- payload 在 main 和 preload 两侧都收窄，不暴露 ipcRenderer；
- renderer reload 后先 `listActive`，再订阅增量；Runtime 保持权威状态；
- Agent 的 `session_start/session_exit` 不再通过 renderer 的 `statsApi.recordEvent` 写入。

### 9.2 Renderer 职责

- `TerminalView` 只选择普通 `ptyApi.spawn` 或 AI `agentApi.start`，两者最终都得到 `ptyId` 给 `PtyProxy`；
- `sessionsStore` 只 upsert 主进程 projection，不在组件中自行推导 thinking/tool/approval 状态；
- Home、Sidebar、TopTabBar 继续消费既有 Session 形状；新增 tool/usage 细节时消费 projection 字段；
- 高频 AgentEvent 放入独立有界 store，仅当前页面需要时订阅；不能把完整事件数组塞进 Session 条目；
- UI 必须依据 capabilities 隐藏不支持的字段。

---

## 10. 建议目录

```text
shared/
  agent-events.ts              # AgentEvent / capabilities / projection / AgentApi contract

electron/agents/
  AgentSessionRuntime.ts       # 对外深模块 interface 的实现
  AgentEventReducer.ts         # 纯状态归约
  AgentEventProjector.ts       # HistoryEvent / stats 低敏投影
  AgentEventQueue.ts           # 有界批处理与降级
  ObserverRegistry.ts          # adapterId → Adapter
  adapters/
    types.ts                   # 内部 Adapter seam
    lifecycle.ts               # 无语义能力的默认 Adapter
    fixture.ts                 # S1 验证夹具
    claude/                    # S2 Claude Code Hooks
    opencode/                  # S3 OpenCode Server/SSE

preload/
  index.ts                     # agentApi contextBridge

src/state/
  sessionsStore.ts             # 接收 projection
  agentEventsStore.ts          # 仅实时详情所需的有界事件
```

PTYManager 只增加主进程内部生命周期订阅 seam，不引入 AgentEvent 或品牌判断。Agent 语义不能渗透到
通用终端模块。

---

## 11. 实施步骤

> 以下 P0–P5 均已按计划完成；实现记录见 §12.2。

### P0 — 契约与纯归约器 ✅

1. 新建 `shared/agent-events.ts`，固定事件、能力、projection 与 AgentApi 类型；
2. 实现输入校验与规范化；
3. 实现 `reduceAgentSession`，覆盖乱序、重复、并行 tool、多 approval、退出终态；
4. 明确 thinking 隐私规则和 HistoryEvent 投影白名单。

验收：纯事件序列可以确定性重放为相同 projection；所有现有六态都有事实来源。

### P1 — Runtime 与 PTY 内部 seam ✅

1. PTYManager 增加主进程内部 exit 订阅和幂等 kill/lookup；
2. 实现 `AgentSessionRuntime.start/stop`；
3. 把 CLI 的 installation resolve、PTY spawn 和 ghost rollback 收进 Runtime；
4. 保留普通终端原链路，禁止品牌逻辑进入 PTYManager。

验收：fixture Adapter 的 prepare/attach/dispose 顺序可取证；任一步失败无 PTY、Session、temp 泄漏。

### P2 — 事件队列、投影与持久化 ✅

1. 实现每 Session 有界队列、批处理和 progress 合并；
2. 实现主进程 projection 广播；
3. 为 `HistoryEventKind` 补入当前 stats 已预留但事件联合缺失的 `blocked`，实现
   AgentEvent → HistoryEvent/stats 投影与去重；
4. Observer 断开降级时 CLI 输入输出继续正常。

验收：事件洪峰不阻塞 PTY；tool/approval all-time 只计一次；高优先级终态不丢。

### P3 — IPC 与 Renderer 迁移 ✅

1. 增加 AgentApi IPC/preload；
2. TerminalView 的 AI 启动改走 `agent:start`，普通终端不变；
3. sessionsStore 改为接收主进程 projection；
4. 移除 renderer 对 AI 生命周期的重复 `recordEvent` 和语义推导；
5. renderer reload 通过 `listActive` 恢复展示副本。

验收：现有 Home/Sidebar/TopTabBar 不需要知道 Observer Adapter；CLI 启动失败仍无幽灵 Session。

### P4 — Fixture Adapter 与跨 seam 门禁 ✅

1. Fixture 支持定时/手动发完整事件序列；
2. 覆盖 Adapter prepare failure、attach failure、disconnect、duplicate、out-of-order、event flood；
3. 测试只跨 `AgentSessionRuntime` interface，不直接断言内部 Adapter 私有状态；
4. 保留少量 Adapter contract fixtures，为 S2/S3 共用。

验收：删除 Runtime 后复杂度会回流到 IPC、PTY、store 和每个 Adapter；说明该深模块确实提供 leverage。

### P5 — 文档与 S2 入口 ✅

1. SPEC-S S1 标记完成；
2. 把真实协议事实核验任务放入 `PLAN-S2-CLAUDE.md`；
3. 固定 Claude Adapter 必须满足的 thinking/tool/approval/usage contract；
4. S2 完成前不宣布六态为全产品通用能力；S2/S3 完成第二协议验证后按能力声明启用。

---

## 12. S1 验收清单

- [x] `AgentSessionRuntime` 对 renderer 只暴露 start/stop/list/events/projection；
- [x] Observer Adapter seam 同时容纳启动前 augmentation 与启动后 attach；
- [x] thinking、tool、approval、input、usage、turn、lifecycle 均有结构化事件；
- [x] thinking 内容默认不采集、不持久化；
- [x] SessionStatus 完全由主进程纯归约器生成；
- [x] 并行 tool 与多 pending request 不会错误清除 `needs-you`；
- [x] Observer prepare/attach/disconnect 失败不会终止 CLI PTY；
- [x] spawn 失败不会留下 PTY、Session、历史计数或 temp 文件；
- [x] Agent Event 队列有界，洪峰不影响 PTY 字节链路；
- [x] tool/approval 统计按稳定 id 去重；
- [x] renderer reload 后可以恢复活动 Session 投影；
- [x] 普通终端启动、输入、resize、背压与退出链路不引入 Agent 依赖；
- [x] Fixture Adapter 完整事件序列驱动六态并通过 interface 级门禁；
- [x] SPEC-S 与 IPC 文档回写完成。

### 12.1 实现时的契约调整

按实现与 S1 审查需要对本计划接口做了以下最小扩展：

1. `StartAgentSession` 增加可选 `name`，使历史标题与 reload 恢复有主进程权威的显示名称；
2. `AgentSessionProjection` 增加 `name?` 与 reducer 内部 `correlation` 字段（pending request
   集合、active tool 表、idle override、退出终态），保持 `reduceAgentSession(previous, event)`
   纯函数签名；renderer 不依赖 `correlation` 展示；
3. Adapter 声明事件 `source`，`PreparedObserver` / `ObserverHandle` 可返回本次运行的实际
   capabilities；Handle 可报告 disconnect 并由 Runtime 最多执行一次 Adapter 自管重连；
4. `prepareLaunch` 在 Windows verbatim command line 序列化前接收受控参数 augmentation，
   避免 `.cmd` shim 静默丢失 `--settings` 等 Adapter 参数；
5. renderer 展示副本保存 projection seq，仅用于拒绝 reload 期间迟到的旧 `listActive` 快照。

### 12.2 实施记录

- `electron/agents/`：AgentSessionRuntime / AgentEventReducer / AgentEventProjector /
  AgentEventQueue / AgentEventNormalizer / ObserverRegistry / adapters（lifecycle、fixture）；
- `shared/agent-events.ts`：事件、能力、投影、AgentApi 与 IPC channel 契约；
- PTYManager 增加主进程内部 exit 订阅 seam（缓存已退出 payload，幂等）；
- AiCliDiscoveryService 增加 `resolveInstallation` / `definitionAdapterId`；
- renderer：sessionsStore 只 upsert 投影（含关闭墓碑）、agentEventsStore 有界事件窗口、
  TerminalView 的 AI 启动改走 `agent:start`，普通终端原链路不变；
- 门禁：`e2e/agent-session.spec.ts`（reducer/queue/Runtime interface 级，29 例）、
  `e2e/agent-observer.spec.ts`（fixture adapter 应用级六态走查 + 临时目录清理）。
  审查修订新增的 6 例按用户要求未执行；已通过 typecheck 与构建级静态验证。
  全量 e2e 中仅 opencode-exit / window-shell / render / tabs / terminal-stress 的 7 个
  环境性用例在基线即失败（global shortcut 占用、真实 opencode+网络、GPU/ConPTY 时序），
  与本计划无关。

---

## 13. S2 / S3 / M6 衔接

### S2 — Claude Code 参考 Adapter

- 详细实施见 [PLAN-S2-CLAUDE.md](./PLAN-S2-CLAUDE.md)；
- 实施前重新核验当前安装版本的官方 Hooks、结构化输出、settings 注入与 transcript 契约；
- 只使用 per-session 临时配置，不修改用户全局配置；
- 至少真实提供 turn、thinking phase、tool lifecycle、approval/input 和可取得的 usage；
- 原生事实缺失时 capability 标 `none`，不从 TUI 文本补猜；
- 用 Claude fixture 固化 native event → AgentEvent 映射。

### S3 — OpenCode 第二协议 Adapter

- 详细实施见 [PLAN-S3-OPENCODE.md](./PLAN-S3-OPENCODE.md)；
- 使用与 Claude 不同的 Server/SSE 协议形态验证 seam；
- Windows 与 WSL 真实 thinking/tool 多轮已验收，permission/error 与更多 host 平台作为扩展矩阵；
- 两个真实 Adapter 已稳定，M6 Adapter contract 自 2026-08-04 起进入 v1 冻结；
- 独立置顶悬浮窗只消费 projection/event，不访问 Adapter。

### M6 — 批量 Adapter

按市场优先级接入 Codex、Pi、Kimi、Grok、Gemini CLI、Cline 等。每个 Adapter 必须使用
[Adapter 验收模板](./ADAPTER-ACCEPTANCE-TEMPLATE.md)，并至少提交：

- 支持的平台、安装版本与能力声明；
- native event → AgentEvent 映射表；
- 启动 augmentation 与清理策略；
- 断线/降级行为；
- 脱敏规则；
- contract fixture 与至少一个真实会话验收记录。

---

## 14. 风险与约束

| 风险 | 约束 |
|---|---|
| 为 Claude 先写出 Claude 专用“通用接口” | S1 fixture 固定事实模型，S2 Claude Hooks 与 S3 OpenCode SSE 完成第二协议验证后冻结 v1 seam |
| Adapter 修改用户 Hooks/settings | 只允许 `<userData>/observer-runs` 临时资源和官方显式覆盖入口 |
| thinking 变成隐私/合规风险 | 只记录 phase；隐藏推理默认丢弃，summary 白名单化 |
| 高频 delta 卡 UI 或挤压 PTY | 独立有界队列、合并 progress、批量 IPC，绝不调用 PTY pause |
| 多信号源重复 tool/approval | 单主源；辅助源必须有稳定关联 id 和明确去重规则 |
| Adapter 断开导致 Session error | observer degradation 与 agent failure 分开；CLI 保持 lifecycle 可见 |
| renderer 与 main 双写状态 | main projection 唯一权威；renderer 只 upsert |
| 事件 schema 变成可选字段垃圾袋 | discriminated union；未知 native payload 留在 Adapter 内部 |
| 测试穿透实现导致每次重构全改 | interface 是测试表面；用 fixture adapter 替换外部协议，不断言内部私有状态 |

---

## 15. 评审时必须确认的决策

1. S1 是否接受把 AI CLI 的 PTY spawn 编排收进 `AgentSessionRuntime`，普通终端保持原链路？
2. thinking 是否确认只存阶段与官方 summary，永不存隐藏推理 delta？
3. 原始 Agent Event 是否确认 S1 不做完整持久化，只投影低敏 HistoryEvent？
4. Observer attach 失败是否确认默认降级、不中止 CLI？
5. Claude Code 作为 S2 第一 Adapter、OpenCode 作为 S3 第二协议验证（已决）；Codex 进入 M6 首批。
6. idle 是否由主进程显式生成确定性事件，而不是 renderer 各自计时？
7. 通知、悬浮窗和批准操作是否继续严格后置，不混入 S1？
