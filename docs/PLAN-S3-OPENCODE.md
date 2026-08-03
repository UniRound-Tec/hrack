# S3 实施计划 —— OpenCode Observer Adapter（Windows + WSL）

> 状态：**核心监听已完成；真实 permission/error 矩阵待补**。
>
> 目标：在 [PLAN-S1.md](./PLAN-S1.md) 已落地的 `AgentObserverAdapter` seam 上，实现第二种
> 真实协议形态：通过 OpenCode TUI 自带的 HTTP Server 与 SSE 事件流，监听 Vibing 启动的
> OpenCode 会话，并把 Windows 与 WSL 的 turn、thinking、tool、approval、input、usage、error
> 翻译成统一 `AgentEvent`。
>
> 协议事实核验日期：**2026-08-03**。本机已验证 Windows OpenCode `1.17.9`、
> WSL Ubuntu-22.04 OpenCode `1.18.11` 均支持 TUI `--hostname` / `--port`。实现仍以每个安装
> 运行时的 `/global/health`、`/doc` 与真实 fixture 为最终依据，不能把 `dev` 分支类型当成稳定 ABI。

---

## 1. 已定方案

OpenCode 本身是 client/server 架构：运行 `opencode` 会同时启动 TUI 和 Server，TUI 只是该
Server 的客户端。S3 不另起 `opencode serve`，不把原生启动改写成 `serve + attach`，只给原 TUI
指定一个仅回环可见的端口，然后只读订阅其 `/global/event` SSE。发布版 `/event` 是需要
`directory/workspace` 参数的 project-scoped 流，不能在无作用域时用于 TUI 监听。

```text
AgentSessionRuntime
  ├─ OpenCodeObserverAdapter.prepare()             spawn 前
  │    ├─ 解析用户网络参数与版本能力
  │    ├─ 选择 host-direct / wsl-stdio transport
  │    └─ 返回 --hostname 127.0.0.1 --port <port>
  ├─ PTYManager.spawn()                             原生 TUI 不变
  └─ PreparedOpenCodeObserver.attach()              spawn 后
       ├─ /global/health 握手
       ├─ GET /global/event SSE
       ├─ OpenCodeEventParser / Projector
       └─ AgentEvent → S1 reducer / history projector
```

关键决策：

1. **只监听 Vibing 自己启动的 OpenCode。** 普通 shell 中手工运行的 `opencode` 不在首版范围；
2. **使用 TUI 自带 Server，不使用独立 `serve + attach`。** 避免改变权限交互、进程归属与退出语义；
3. **首版使用只读 SSE，不注入 Plugin。** Plugin 会在 OpenCode 进程内执行代码、参与用户现有 hook
   顺序，并涉及配置合并与本地模块加载；SSE 已提供同一事件总线，侵入更小；
4. **Windows 由 Electron 主进程直连回环 Server。** 不经过 renderer，不开放 CORS，不绑定局域网；
5. **WSL 在同一 distro 内订阅回环 Server。** 主进程启动一个受控的 `wsl.exe --exec <linux-curl>`
   辅助进程，将原始 SSE 字节通过 stdout 送回；不用 `curl.exe`，也不依赖 WSL NAT、mirrored
   networking 或 Windows 访问 WSL 回环地址；
6. **SSE 是不可信输入。** 有界解析、字段收窄、稳定 id 去重后才进入 S1 Runtime；
7. **Session 关联必须显式锁定。** 不能把 Server 中“最新一个 Session”永久当作当前会话；
8. **`session.idle` 表示一轮完成，不表示进程退出。** PTY exit 仍是唯一 `session.exited` 事实；
9. **thinking 只投影 phase。** OpenCode reasoning part 的正文与 delta 不读取、不广播、不持久化；
10. **观察失败不杀 TUI。** 握手失败、SSE 断开、WSL 缺少 Linux curl 或 schema 漂移时，降级为
    lifecycle-only；
11. **不实现 PTY/OCR 正则监听。** OpenCode 有结构化事件源，屏幕只负责显示，不是权威状态源。
12. **连接必须先对账再放流。** SSE 先建立并暂存新事件，`/session/status` 与 Session 快照完成后，
    先 hydrate projector，再按接收顺序重放暂存事件；对账有硬超时，绝不能无限悬挂；
13. **一个 pane 聚合多个 native Session。** root、child、TUI 内切换后的新 root 都属于同一 OpenCode
    Server；pane 状态按 `needs-you > error > working > idle` 聚合，不能只盯一个“当前 root”。

---

## 2. 为什么这个 Module 足够深

沿用项目的深模块词汇：

- **Module**：`electron/agents/adapters/opencode/`；
- **Interface**：外部仍只有现有 `AgentObserverAdapter.prepare/attach/dispose`；
- **Implementation**：端口、SSE framing、Windows/WSL transport、schema 兼容、Session 关联和事件投影；
- **Seam**：S1 已验证的 `AgentObserverAdapter`，不新增 OpenCode 品牌 IPC；
- **Adapter**：只把 OpenCode native facts 翻译成 `AgentEvent`，不拥有通用 Session 状态机；
- **Depth**：Runtime 只看到少量 launch augmentation 与语义事件，复杂协议全部藏在 Module 内；
- **Leverage**：接入后直接复用 S1 的归约、队列、历史去重、reload 恢复、幽灵 Session 清理和 UI；
- **Locality**：OpenCode schema 漂移只修改该目录的 parser/projector，不扩散到 renderer 或 Runtime。

首版不新造通用 “所有 Server CLI” 抽象。等 Codex 或第三个 Server/RPC Adapter 出现相同需求后，
再提取 SSE/端口公共件，避免用一个产品制造假抽象。

---

## 3. 交付边界

### 3.1 S3 交付

- `OpenCodeObserverAdapter` 注册到 `adapterId: 'opencode'`；
- TUI Server 的回环端口准备、参数冲突检查与启动 augmentation；
- Windows 直连 SSE transport；
- WSL distro 内 Linux curl → `wsl.exe` stdout transport；
- `/global/health` 握手、首个 `server.connected` 门禁、断线与有限重连；
- 有界 SSE parser：支持 CRLF、跨 chunk、多个 `data:` 行、注释/心跳与未知字段；
- OpenCode native event parser 与版本/schema 兼容层；
- 当前私有 Server 内多 root/child native Session 的确定性关联与聚合；
- turn、thinking phase、tool、approval、input、usage、retry/error、idle 映射；
- Windows/WSL 脱敏 fixtures 与真实会话验收；
- Observer 降级原因、清理与无幽灵 Session 门禁。

### 3.2 S3 不交付

- 不监听 Vibing 之外已经运行的 OpenCode；
- 不启动独立 `opencode serve`，不把 TUI 改成 `opencode attach`；
- 不修改全局或项目 `opencode.json`、`.opencode/plugins/`；
- 不设置 `OPENCODE_CONFIG_CONTENT`，不覆盖用户 Plugin；
- 不自动批准/拒绝 permission，不替用户回答 question；
- 不调用 `/tui/*`、`/session/*` 写接口控制会话；
- 不保存 prompt、assistant 正文、reasoning 正文、tool input/output、diff 或文件内容；
- 不支持 `opencode run --format json`、ACP 或远程 Server；
- 不在本阶段承诺 macOS/Linux；Module 不应阻碍后续补 host transport；
- 不实现通知、悬浮窗、代操作或远程控制。

### 3.3 完成标志

Windows 与 WSL 各有一个真实 OpenCode 会话稳定呈现：

```text
TUI 就绪               → idle / 等待你的下一条指令
提交 prompt            → working / 正在分析并规划下一步
reasoning part 活跃     → working / 正在思考
tool running           → working / 正在执行 <Tool>
permission asked       → needs-you / 需要你的确认
permission replied     → working
question asked         → needs-you / 等待你的输入
step finish            → 更新本轮 tokens/cost，不结束整轮
session idle           → done / 本轮任务已完成
session error          → error / 执行遇到问题
PTY exit               → exited / 会话已结束
```

同时，端口准备失败、Server 未就绪、WSL curl 不可用、SSE 半包/超限、schema 漂移、用户秒退、
attach 后立即断线均不能留下 Session、observer helper、timer 或临时目录。

---

## 4. 已核验的官方协议事实

1. `opencode` TUI 自己启动 Server；可以通过 `--hostname`、`--port` 固定监听地址；
2. TUI 未指定端口时默认使用随机端口；S3 因此必须在 spawn 前提供可发现端口；
3. `GET /global/health` 返回健康状态和版本；
4. `GET /global/event` 是覆盖 TUI instance 的 SSE，首事件为 `server.connected`；其余事件使用
   `{ directory, project, payload }` envelope；`GET /event` 则是 project-scoped 流；
5. `GET /session`、`GET /session/status` 可用于首次连接时补齐 Session 关联与当前状态；
6. 当前事件族包含 `session.status`、`session.idle`、`session.error`、`message.updated`、
   `message.part.updated` 与 permission 事件；
7. `ReasoningPart` 带 `time.start/end`，`ToolPart` 有 pending/running/completed/error 状态；
8. `StepFinishPart` 带 input/output/reasoning/cache tokens 与 cost；
9. 官方文档、发布版本 `/doc` 与 `dev` SDK 类型可能不同，例如 permission 历史上出现过
   `permission.updated`，当前文档使用 `permission.asked`。实现必须 fixture-first，不能只复制远端类型。

旧 vibby OpenCode Adapter 还提供了四条已在真实版本中验证、S3 必须保留的实现事实：

- OpenCode `1.17.9` 会在 tool 边界与 idle 后重放相同 user message，必须按 message id 去重；
- `1.18.7` 的 `message.updated` 主要是元数据，正文来自 `message.part.updated`；S3 不需要正文，不能
  因为 metadata-only 就误判消息未完成；
- SSE 连接建立后必须先做 `/session/status` 对账，再处理连接期间排队的 live event；
- `1.17.9` TUI 的 Basic Auth 转发行为不足以作为首版安全基础，因此首版安全边界仍是回环绑定。

旧实现中以下做法不直接迁移：

- **PATH shim 与手动 shell 检测**：Vibing 首版只监听自己启动的精确 installation，现有 Runtime 已在
  spawn 前提供 augmentation seam；
- **reasoning 尾部 48 字符摘要**：即使 OpenCode 公开发送 reasoning text，S1 的隐私契约仍是不采集
  chain-of-thought；S3 只用 reasoning phase 与 `step-finish` token 数；
- **扫描缓存 WSL IP 作为长期地址**：IP 会变化，不能成为 observer identity；
- **无限 SSE 重连**：改成有界退避、明确 stale/degraded 与 Runtime reconnect；
- **持久化 profile 中记住端口/路由标记**：当前 Session/PTY 由主进程 Runtime 持有，renderer reload
  通过 `listActive` 恢复，不需要把临时监听参数写进用户配置；
- **空闲退出时不发 process-exited**：退出事实必须完整进入 Runtime；是否打扰用户属于后续通知策略，
  不能在 Adapter 丢事实。

实施基线来源：

- [OpenCode Server](https://opencode.ai/docs/server/)
- [OpenCode CLI](https://opencode.ai/docs/cli/)
- [OpenCode Plugins](https://opencode.ai/docs/plugins/)
- [OpenCode Config](https://opencode.ai/docs/config/)
- [OpenCode generated SDK types](https://github.com/anomalyco/opencode/blob/dev/packages/sdk/js/src/gen/types.gen.ts)

---

## 5. 目录与内部接口

```text
electron/agents/adapters/opencode/
  OpenCodeObserverAdapter.ts       # 唯一对外入口；prepare/attach/dispose
  OpenCodeTransport.ts             # 私有 interface + Windows/WSL transport
  OpenCodeSseParser.ts             # 纯 SSE framing；不懂业务 schema
  OpenCodeEventParser.ts           # unknown JSON → OpenCodeFact
  OpenCodeEventProjector.ts        # native Session 关联/聚合；Fact → AdapterEvent[]
  types.ts                         # native facts / snapshot / degraded reason
  index.ts

e2e/
  opencode-observer.spec.ts
  opencode-real-observer.spec.ts   # opt-in；真实 Windows/WSL
```

实现时将 transport 与端口策略保留在单一深模块内，没有为仅被一个调用方使用的短逻辑拆出浅文件；
公共 `AgentObserverAdapter`、IPC 与 renderer 契约保持不变。

私有 transport interface：

```ts
interface OpenCodeTransport {
  readonly kind: 'host-direct' | 'wsl-stdio'
  health(): Promise<{ version: string }>
  snapshot(): Promise<OpenCodeSnapshot>
  connect(
    onEvent: (raw: unknown) => void,
    onDisconnect: (reason: string) => void
  ): Promise<OpenCodeConnection>
  dispose(): Promise<void>
}
```

约束：

- transport 只负责字节与连接，不判断 turn/tool/approval；
- parser 只收窄数据，不维护会话状态；
- projector 内部维护该私有 Server 的 native Session 集合、每个 Session 生命周期与 pane 聚合状态，
  并生成 `AdapterEvent`；
- Runtime 继续独占 envelope、seq、清洗、队列、统一状态归约和历史投影。

---

## 6. 启动与 Transport

### 6.1 参数策略

`prepare()` 先解析用户 args，禁止盲目重复参数：

| 用户参数 | 处理 |
|---|---|
| 无 `--port/--hostname/--mdns` | Adapter 选择端口，追加 `--hostname 127.0.0.1 --port <port>` |
| 有合法 `--port`，无非回环 hostname | 复用该端口，不追加重复参数 |
| `--hostname localhost/127.0.0.1/::1` | 允许；标准化 observer endpoint |
| 非回环 `--hostname` 或 `--mdns` | 不修改用户启动；observer 降级 `unsafe-server-binding` |
| 重复、缺值、非法端口 | 不猜测；observer 降级 `server-argument-conflict` |
| `attach`、`run`、`serve` 子命令形态 | 首版不接管，降级 lifecycle-only |

Adapter 不能添加 `--auto`，不能改 permission，也不能打开 CORS。

### 6.2 端口策略

- Windows：用 Node `net.Server` 在 `127.0.0.1:0` 获取系统分配端口，关闭后立即进入 PTY spawn；
- WSL：在目标 distro 内对随机高位端口检查 `/proc/net/tcp{,6}`，最多重选 8 次；
- 端口选择必须使用加密随机源，不使用固定 `4096`；
- Adapter 内维护 App 级 `reservedPorts`，从 prepare 起占位，到 dispose 才释放，避免 Vibing
  多 pane 并发选择同一端口；它只解决自家竞争，不能掩盖 OS 级 TOCTOU；
- `attach()` 只连接已选择 endpoint，绝不扫描整段 localhost 端口；
- 端口仍存在极小 TOCTOU 窗口；握手必须同时通过 OpenCode health identity 与
  `server.connected`，否则立即降级，不能把任意 localhost HTTP 服务当成 observer。

若实测 OpenCode 在端口竞争时会直接终止 TUI，则 P1 先补一个通用、极小的
`PreparedObserver.beforeSpawn?()` seam，使端口占用检查紧贴 `pty.spawn()`；该 seam 只表达资源切换，
不能让 Adapter 自行 spawn 主 CLI。

### 6.3 Windows

```text
opencode.exe --hostname 127.0.0.1 --port <p>
          │
          └── Electron main fetch http://127.0.0.1:<p>/global/event
```

握手顺序：

1. 以 50ms → 100ms → 200ms → 400ms 的有界退避探测 `/global/health`，总预算 5s；
2. 校验 `healthy === true` 与版本结构；
3. 订阅 `/global/event`，必须在预算内收到 `server.connected`；
4. 并行读取 `/session` 与 `/session/status` 建立首次快照；
5. snapshot 对账完成后才按到达顺序回放缓冲事件并交给 Runtime。

### 6.4 WSL

WSL 的 TUI Server 在 distro 自己的回环网络中。S3 不要求 Windows 能直接访问它：

```text
WSL: opencode --hostname 127.0.0.1 --port <p>
                         │
WSL: /usr/bin/curl -N http://127.0.0.1:<p>/global/event
                         │ stdout（原始 SSE）
Windows: wsl.exe helper ─┴─> OpenCodeSseParser
```

规则：

- `prepare()` 在目标 distro 运行时实测 Linux `curl --version`，并记录解析到的绝对路径；
- 必须使用 distro 内的 `curl`，不是 `curl.exe`；
- helper 用 `--no-buffer --silent --show-error --fail-with-body`，stderr 有界采样，只用于诊断；
- helper 不经过 shell 拼接 URL；distro、curl 路径、端口均作为独立 argv；
- health/session 快照也通过同 distro 的 Linux curl 获取；
- WSL 网络模式、Windows 防火墙、`curl.exe` binfmt 与 `/mnt/c` 挂载均不影响主通道；
- distro 无 Linux curl 时首版降级 `wsl-sse-client-unavailable`，不临时安装软件；
- dispose 必须终止 helper、关闭 stdout parser、清除 timer；PTY 由 Runtime 单独管理。

首版不使用文件 drop，因为 SSE 是长连接，stdout 已提供天然背压和确定的父子生命周期。若真实
ConPTY/WSL 环境证明 stdout helper 不稳定，再把 Claude 已验证的 file drop 作为第二 transport，
不提前增加双通道复杂度。

旧 vibby 采用“mirrored → Windows `127.0.0.1`，NAT → 扫描缓存中的 distro IPv4”由 Windows
直接订阅。这个实现证明了 direct transport 可行，但也留下 IP 变化后无限重连的问题，而且 NAT 下
若 OpenCode 只绑定 distro 的 `127.0.0.1`，直接访问 distro IPv4 还依赖实际绑定/转发行为。S3 首版
因此选择同 distro 的 Linux curl 作为确定路径。P6 可在运行时重新探测、完成 endpoint identity
校验后增加 `wsl-direct` 快路径，但扫描缓存 IP 不能成为权威地址。

---

## 7. 多 native Session 关联与聚合

这是 S3 最容易产生串线和幽灵状态的部分。一个 TUI Server 可承载多个 root/child native Session，
它们全部折叠为一个 Vibing pane Session；因此 `OpenCodeSessionCorrelator` 维护成员与层级，
`OpenCodeEventProjector` 负责聚合，而不是只过滤出单一 root。

### 7.1 初始 Session 集合与 active root

首次快照与 active root 优先级：

1. 用户传 `--session <id>`：直接以该 id 为候选，服务端查询存在且 workspace 一致后锁定；
2. 用户传 `--continue`：按 OpenCode 当前版本真实行为，从 `/session` 选择最新 root Session，
   必须匹配 workspace；
3. 新会话：优先认领启动时间窗口内、workspace 一致的 `session.created` 为 active root；
4. 若 Session 延迟到首次 prompt 才创建，则等第一个 user `message.updated` / `session.status busy`，
   再用 Server 查询补齐 Session info 后锁定；
5. 同时存在多个 active root 候选时不猜 active root，但把 `/session/status` 中非 idle 的成员继续纳入
   pane 聚合，并发出 `observer.degraded: session-ambiguous`。

active root 不因普通后台更新时间变化而漂移；但 TUI 内显式 `/new` 或 Session selector 切换后，新 root
加入同一个 pane 的 native Session 集合，并成为新的 active root。旧 root 若仍 busy、needs-you 或 error，
仍参与聚合，直到权威事件/对账证明它 idle；不同 root 的 tool/request 集合绝不能互相清除。

### 7.2 child Session

- `session.created/info.parentID` 指向当前 root 或已知 descendant 时加入 child set；
- child 的 tool/thinking/busy 会维持父 Session `working`；
- child 的 idle 只关闭 child 自己的活动，不直接完成 root turn；
- root `session.idle` 只完成该 root 的 turn；只有所有成员都非 busy 且没有未决 request 时，pane 才变
  `done/idle`；
- child 删除/错误后清理其 tool、thinking correlation，避免父会话永久 working。

### 7.3 turn id

- 优先使用本轮 user message id；
- 若先收到 `session.status busy`，生成 `oc:<rootSessionID>:<busyGeneration>`；
- 同一 busy → idle 周期内 turn id 不变；
- `step-start/step-finish` 是同一 turn 内的模型 step，不得每步创建/完成一个 turn；
- 重连后通过 `/session/status` 恢复 busy/idle，但不重放历史计数。

### 7.4 pane 聚合优先级

```text
任一 Session 有 pending permission/question  → needs-you
否则任一 Session 有未恢复的 fatal error       → error
否则任一 Session busy/retry/tool/thinking      → working
否则最近一个 active root 刚完成 turn           → done
否则                                           → idle
```

Projector 内部可以维护多 Session 状态，但不得把这套品牌状态机塞进 S1 reducer。它只输出足以让统一
Reducer 得到相同结果的幂等 `AgentEvent`，并在聚合优先级下降时关闭对应 tool/request/turn facts。

---

## 8. Native Fact 与 AgentEvent 映射

Parser 输出窄类型 `OpenCodeFact`，不得把整个原始 payload 塞进 `AgentEvent`。

| OpenCode 事实 | 统一事件 | 说明 |
|---|---|---|
| `server.connected` | 无业务事件 | 只完成 transport handshake |
| 任一成员 `session.status = busy` | `turn.started` | 按 native Session 的 busy generation 去重 |
| 初始快照全部 `idle` | `session.idle(high)` | 启动后显示“等待你的下一条指令” |
| reasoning part 首次出现 | `thinking.started` | 忽略 text/delta |
| reasoning `time.end` | `thinking.completed` | 不带 summary；后续 tool/text 也可兜底关闭 phase |
| tool pending/running | `tool.started` | `callID` 去重；展示安全 tool 名/title |
| tool running 的安全 title 变化 | `tool.progress` | 不读取 input/output |
| tool completed | `tool.completed` | duration 来自 time.start/end |
| tool error | `tool.failed` | 错误只取有界、单行安全摘要 |
| `permission.asked` / 兼容 `permission.updated` | `approval.requested` | request id；call id 可选；只保留类别/安全 title |
| `permission.replied` | `approval.resolved` | once/always→approved，reject→denied，未知→cancelled |
| `question.asked`（本机 schema 确认后） | `input.requested` | 只保留有界问题标题，不保存选项正文 |
| `question.replied/rejected` | `input.resolved` | request id 去重 |
| `step-finish` | `usage.updated(scope=turn)` | tokens/cost；不结束 turn |
| assistant message completed | `message.completed` | 不采集正文；可用固定安全摘要“回复已生成” |
| 某 root `session.idle` | `turn.completed` | 只完成该 root turn；聚合后全静止才发 pane `session.idle(high)` |
| `session.status = retry` | `activity.caption` | “请求重试中 · 第 N 次”；仍为 working |
| 任一成员 `session.error` | `turn.failed` | abort 映射 cancelled；retryable error 不抢先终结 |
| `session.deleted/compacted` | native correlation 清理 | 不等价 PTY exit |
| PTY exit | Runtime `session.exited` | 唯一进程退出事实 |

### 8.1 顺序、重复和重连

- native id 由 `event.type + sessionID + messageID/partID/callID/requestID + state` 组成；
- 同一 ToolPart 会以不同 state 多次更新，projector 只允许合法前进，重复 state 不重复计数；
- completed/error 到达而 started 丢失时，先合成一次 started 再结束；
- permission reply 先于 asked 时记录 tombstone，后到 asked 不再制造 `needs-you`；
- 某 root idle 到达时只关闭该 root/descendant 的残留 thinking/tool，不清理别的 root；
- SSE 重连后先取 `/session/status`，只恢复当前状态，不把 `/session/:id/message` 历史重新投影成事件；
- 未知 event/part/state 计入有界诊断，不能让整个连接崩溃。

### 8.2 连接对账协议

```text
connect /global/event
  → 暂存 live SSE（有界）
  → GET /session + GET /session/status
  → hydrate 多 Session projector
  → 按接收顺序 replay 暂存 SSE
  → 切换 live passthrough
```

- 对账总预算 3s，buffer 同时受 event count 与 byte 双上限约束；
- snapshot 成功后必须先 hydrate、后 replay，防止旧 snapshot 覆盖较新的 live event；
- snapshot 最终失败时不能永远悬挂：发 `observer.degraded: reconcile-unavailable`，从本次连接起点
  重放 buffer 并继续 live，状态保持低置信度，下一次重连再次尝试对账；
- snapshot 期间 SSE EOF 时丢弃本轮未确认 buffer，重新建立完整连接/对账，不能跨连接混排；
- user message replay 按 `messageID` 去重，1.17.9 在 tool/idle 边界重放不会重复创建 turn/timeline。

### 8.3 Capability

完整 SSE 会话预期能力：

```ts
{
  thinking: 'phase',
  tools: 'progress',
  approvals: 'structured',
  inputRequests: 'structured', // 仅本机 /doc 确认 question 事件后开启
  usage: 'tokens',
  messages: 'summary'
}
```

Capability 按实际安装与握手结果收窄，不按产品宣传写死：

- 没有 question schema → `inputRequests: 'none'`；
- 没有 step-finish tokens → `usage: 'none'`；
- reasoning part 无时间字段但可识别 phase → 仍为 `thinking: 'phase'`；
- 只拿到 lifecycle → 全部 `none`。

---

## 9. 安全、隐私与资源上限

### 9.1 网络

- Adapter 只追加 `127.0.0.1`，绝不追加 `0.0.0.0`；
- 不开启 mDNS/CORS；
- 不连接用户未明确指定的远程 URL；
- endpoint 必须同时通过 health version、workspace 与 Session 认领检查；
- 首版不强行覆盖用户的 `OPENCODE_SERVER_PASSWORD`。若 endpoint 返回 401 且 Adapter 无法以同一
  会话凭据读取，则诚实降级 `server-auth-required`，不记录或打印凭据；
- 后续若需自动 Basic Auth，必须先增加 WSL runtime env 的安全传递 seam，不能把密码放命令行。

### 9.2 数据

禁止进入 Runtime/日志/fixture 的字段：

- user prompt、assistant text、reasoning text/delta；
- tool input/raw/output、patch/diff、file contents；
- provider credentials、环境变量、HTTP Authorization；
- OpenCode 完整 message/session dump。

允许字段：稳定 id、事件类型、tool 名、安全 title、状态、duration、token/cost 数值、经清洗的错误摘要。

### 9.3 上限

- 单个 SSE event：1 MiB；
- 单行：256 KiB；
- 未完成 frame 缓冲：1 MiB；
- stderr 诊断：最后 8 KiB；
- health/session HTTP body：1 MiB；
- 连接超时 5s，单次 HTTP 3s；
- 连接内重试使用 250ms 起、最大 5s 的指数退避与 jitter，但最多持续 30s；到期后发 disconnect，
  交给 Runtime 的有界 reconnect seam，不能像旧实现一样每 pane 永久 5s 空转；
- 超限或持续断线发 `observer.degraded`，终止 observer helper，不终止 PTY；
- 后续事件洪峰继续由 S1 `AgentEventQueue` 双上限兜底。

---

## 10. 降级与清理

```ts
type OpenCodeObserverDegradedReason =
  | 'unsupported-version'
  | 'unsupported-command-shape'
  | 'server-argument-conflict'
  | 'unsafe-server-binding'
  | 'port-unavailable'
  | 'server-not-ready'
  | 'server-auth-required'
  | 'server-identity-mismatch'
  | 'sse-handshake-timeout'
  | 'sse-protocol-invalid'
  | 'sse-event-too-large'
  | 'schema-unsupported'
  | 'reconcile-unavailable'
  | 'session-not-found'
  | 'session-ambiguous'
  | 'wsl-sse-client-unavailable'
  | 'wsl-helper-exited'
  | 'reconnect-exhausted'
  | 'observer-disconnected'
```

清理顺序：

1. Abort health/session/SSE 请求；
2. 终止 WSL helper，并等待有界退出；
3. 取消 disconnect/reconnect timers；
4. 清空 parser buffer 与 projector native correlation；
5. dispose prepared resources；
6. 由 Runtime 处理 PTY exit、墓碑、Session finalize 与 `observer-runs/<sessionId>` 删除。

所有 dispose/finalize 必须幂等。`session.idle`、`session.deleted`、SSE EOF 都不能自行删除 Vibing
Session；只有用户 stop 或 PTY exit 进入 Runtime finalize。

---

## 11. 实施阶段

### P0 — 本机协议取证与脱敏 fixture

- [x] Windows `1.17.9` 固定端口启动并核对 health/session/status/global-event；
- [x] WSL `1.18.11` 同样取证；
- [ ] 各跑一次真实多轮：idle → reasoning → tool → permission → reply → idle → exit；
- [ ] 配置 question 工具路径，确认 `question.*` 是否存在；
- [ ] 捕获原始 SSE 后立即脱敏，只保留结构与合成 id；
- [ ] 记录 permission 命名与字段差异，确定版本能力矩阵；
- [x] 固化 1.17.9 user message replay 与 metadata-only message 结构门禁；
- [ ] 复核 1.17.9 TUI Basic Auth 行为，首版不得假设可用；
- [ ] 验证显式端口占用时 OpenCode 的真实退出行为。

### P1 — 纯解析与投影

- [x] `OpenCodeSseParser`：chunk/framing/limit tests；
- [x] `OpenCodeEventParser`：unknown input、版本别名、敏感字段丢弃；
- [x] Projector 内部 native Session 关联：多 root、child 与聚合完成边界；
- [x] `OpenCodeEventProjector`：多 Session 聚合、重复、并行 tool、多 permission、retry、idle；
- [x] connect → buffer → reconcile → replay 的顺序与失败超时；
- [x] 证明 reasoning/tool/prompt 正文永不进入 AdapterEvent。

### P2 — Windows transport

- [x] 参数解析与端口选择；
- [x] health + `server.connected` handshake；
- [x] Fetch SSE、EOF、AbortController、有界握手重试与 Runtime 单次重连；
- [x] 注册 `OpenCodeObserverAdapter`；
- [x] attach 失败降级且 TUI 继续可用；
- [ ] 秒退、spawn 失败、端口冲突无资源泄漏。

### P3 — WSL transport

- [x] 在扫描到的 distro 内解析并实测 Linux curl；
- [x] health/session 短请求；
- [x] SSE stdout helper 与 stderr 有界诊断；
- [x] helper crash/EOF/stop 幂等清理；
- [ ] 验证 WSL NAT、mirrored networking 下行为一致；
- [x] 明确证明实现未调用 `curl.exe`、未依赖 Windows→WSL localhost。

### P4 — 应用级集成

- [x] projection 进入现有 Sidebar/Home attention/history；
- [x] 初始 idle 不误显示“运行中”；
- [x] tool/approval/completion 文案复用现有统一契约；
- [x] 完成事件覆盖旧 thinking/tool detail；
- [x] renderer reload 通过 `listActive` 恢复；
- [x] OpenCode 普通 TUI 渲染与产品关闭回归保持通过。

### P5 — 真实验收与文档回写

- [x] Windows `1.17.9` 真实 TUI：健康空闲投影与 stop 清理；
- [x] WSL `1.18.11` 真实 TUI：健康空闲投影与 stop 清理；
- [x] Windows 与 WSL 各完成真实两轮：thinking → reply → done；thinking → Bash tool → reply → done；
- [ ] Windows 与 WSL 各做一次 permission ask/approve/deny；
- [ ] 各做一次 tool success/failure、retry/error、Ctrl+C、`/exit`；
- [x] stop 后无 active/幽灵 Session，transport/helper/端口/runDir 进入幂等清理；
- [x] 回写 [SPEC-S.md](./SPEC-S.md) 与本计划门禁。

### P6 — 后续，不阻挡首版

- [ ] 经运行时 endpoint identity 校验的 `wsl-direct` 快路径；
- [ ] WSL file-drop 备选 transport（仅 stdout helper 有真实缺陷时）；
- [ ] macOS/Linux host 验收；
- [ ] 复用证据充分后提取通用 SSE Module；
- [ ] 设置页展示 OpenCode 真实 capability / degraded reason。

---

## 12. 自动化门禁

### 12.1 纯函数与 fixture

- SSE 一个 event 被拆成任意 chunk 仍只产出一次；
- CRLF、多 `data:`、心跳、空行、UTF-8 边界正确；
- 1 MiB 超限立即断 observer，不增长内存；
- 未知 event/part/state 安全忽略；
- Windows/WSL 两版 permission schema 都映射同一事实；
- 1.17.9 同一 user message 重放不重复创建 turn/timeline；
- 对账成功时 snapshot 先于 live replay，失败时 3s 内降级放流而非永久挂起；
- reasoning text、tool input/output、prompt 的 canary 不出现在事件、projection、history、日志；
- busy 重复不重复 `turn.started`；
- tool pending→running→completed 只计一次；
- completed-before-running 可收敛；
- 两个并行 tool 完成一个时仍 working；
- 多 approval resolve 一个时仍 needs-you；
- child idle 不完成 root turn；
- 一个 root idle 不清除另一个 busy root；所有成员空闲才完成 pane；
- PTY exit 后迟到 SSE 不复活 Session。

### 12.2 interface 级

- prepare 失败 → lifecycle-only，原始启动仍成功；
- attach 失败 → PTY 不被 kill；
- WSL curl 缺失 → 不安装软件、不调用 curl.exe；
- helper crash → 有界重连后降级；
- 旧 WSL IP、停止的 distro、持续拒绝连接不会形成永久重试循环；
- spawn 失败 → prepared transport/helper/timer 全清；
- stop 与 PTY exit 竞态 → finalize 一次；
- 5000 native updates 经状态合并后不阻塞 PTY 字节链路。

### 12.3 真实 E2E（opt-in）

环境变量：

```text
VIBING_E2E_REAL_OPENCODE=1
VIBING_E2E_REAL_OPENCODE_WSL_DISTRO=Ubuntu-22.04
```

真实测试必须使用临时 workspace 与安全只读/临时文件工具，不依赖真实生产仓库。审批自动化只操作
测试会话 UI，不改变用户 OpenCode 全局 permission。

---

## 13. Definition of Done

- [x] `opencode` 精确命中真实 Adapter，未知/不兼容安装诚实降级；
- [x] Windows 与 WSL 都由结构化 SSE 驱动六态，不靠屏幕正则；
- [x] WSL 不使用 `curl.exe`，不依赖跨 WSL localhost；
- [x] 初始空闲、thinking、tool、approval/input、完成、错误、退出文案符合现有契约；
- [x] turn/tool/approval/input/usage 去重与聚合门禁通过；
- [x] reasoning/prompt/tool body 隐私门禁通过；
- [x] observer 故障不终止可用 TUI；
- [ ] spawn/attach/helper/reconnect/exit 所有失败路径无幽灵 Session 与资源泄漏；
- [x] 定向 E2E、typecheck、build 通过；
- [x] Windows `1.17.9` 与 WSL `1.18.11` 真实 thinking/tool 多轮验收记录完成。
