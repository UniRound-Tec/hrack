# M6 Pi Observer Adapter 实施计划

> 状态：**Windows/WSL 实现完成并通过真实 E2E；macOS/Linux 待真机 smoke**
> 核验日期：2026-08-04
> 依赖：`PLAN-S1.md`、`ADAPTER-ACCEPTANCE-TEMPLATE.md`
> 目标：在不读取 TUI 文本、不改变 Pi 权限/输入行为的前提下，为 Windows、WSL、
> macOS、Linux 提供与 Claude Code 相同的统一 Session 投影体验。

---

## 1. 结论先行

Pi 使用官方 TypeScript Extension API，不使用 Claude/Codex hooks，也不启动第二个 Pi
server。Vibing 在 `prepare()` 阶段生成一份每 Session 独立、无第三方依赖的扩展源码，通过
官方 `--extension/-e <path>` 注入当前 Pi 进程。扩展只在 Pi 进程内把原生事件压缩为低敏事实，
再写入 per-session drop 目录；主进程使用现有 `HookDropPoller` 消费、解析、投影。

```text
点击 Pi 卡片
  → AgentSessionRuntime 创建 runDir
  → PiObserverAdapter.prepare()
      ├─ 精确版本/扩展能力探测
      ├─ 生成 vibing-pi-observer.ts
      ├─ WSL 路径翻译 + 实际原子写入探测
      └─ 返回 -e <runtime extension path> + VIBING_PI_* env
  → 原 Pi PTY spawn（只启动一份）
  → Pi 扩展订阅结构化事件并在进程内脱敏/限流
  → 原子 JSON drop
  → HookDropPoller → PiHookParser → PiEventProjector
  → AgentSessionRuntime → Sidebar / Home / History / Floating Window
```

首版采用**单一 file-drop 传输**，不保留旧实现的 HTTP 分支：

- 没有 loopback 端口、endpoint token、curl/curl.exe、WSL NAT/mirrored 网络差异；
- Pi 的 Bash 子进程最多继承一个无秘密的 drop 路径与随机 Session id；
- 事件顺序由扩展单调 `seq` + 原子 rename 保证；
- WSL 必须在 spawn 前通过真实写入探测；失败就诚实降级 lifecycle-only。

## 2. 官方事实与本机基线

### 2.1 证据

本计划依据以下当前官方资料，而不是旧项目实现推断：

- [Pi Extensions](https://pi.dev/docs/latest/extensions)：`-e/--extension`、扩展生命周期、
  `agent_settled`、tool execution 与 mutation hook 契约；
- [Pi SDK](https://pi.dev/docs/latest/sdk)：Extension factory 与 resource loader；
- [Pi JSON mode](https://pi.dev/docs/latest/json)：核心 agent/message/tool 事件序列；
- [当前官方仓库](https://github.com/earendil-works/pi)：包已迁移为
  `@earendil-works/pi-coding-agent`；
- 本机安装包 `dist/core/extensions/types.d.ts` 与 `@earendil-works/pi-ai` 类型声明。

Context7 与本机类型核验得到的当前事件顺序是：

```text
project_trust
session_start
input → before_agent_start → agent_start
  → turn_start
  → message_start / message_update / message_end
  → tool_execution_start → tool_call → tool_result → tool_execution_end
  → turn_end（一次 LLM response；工具循环可重复）
agent_end（低层 agent run 已结束，但仍可能 retry/compact/follow-up）
agent_settled（没有自动 continuation 后的真正完成边界）
session_shutdown
```

### 2.2 本机目标版本

| Runtime | 安装 | 版本 | 首版要求 |
|---|---|---:|---|
| Windows host | `%APPDATA%/npm/node_modules/@earendil-works/pi-coding-agent` | `0.82.1` | full |
| WSL Ubuntu-22.04 | `~/.local/share/pi-node/node-v22.22.3-linux-x64/.../pi` | `0.80.3` | compatibility-full |
| macOS host | 待真机 | 未定 | 代码完成，真机 smoke 待补 |
| Linux host | 待真机 | 未定 | 代码完成，真机 smoke 待补 |

关键版本差异：

- `0.82.1` 有 `agent_settled`，它才是 retry、auto-compaction、queued follow-up 全部结束后的
  权威完成事实；
- 本机 WSL `0.80.3` 没有 `agent_settled`，不能照抄 Windows 事件表；
- `0.80.x` 兼容模式在 `agent_end` 后延迟检查 `ctx.isIdle()`、
  `ctx.hasPendingMessages()`、active tool 与 generation；只有全部稳定才发兼容 settle；
- 兼容检查超时不猜 done，发送 `observer.degraded(pi-settle-ambiguous)`，保留 CLI；
- `<0.80.0` 或版本无法确认时首版降级 lifecycle-only，不假装完整监听。

### 2.3 对旧实现报告的修正

1. 不能只订阅旧报告里的 9 个事件。当前权威工具生命周期是
   `tool_execution_start/update/end`；`tool_call/tool_result` 是可修改执行结果的 mutation hook；
2. `agent_end` 与 `agent_settled` 不是别名。`agent_end` 不能在 0.82+ 直接投影为 done；
3. `input` 必须返回 mutation result，但监听不需要它。首版完全不注册 `input`，从根上消除
   “返回错值导致 composer 被拦截”的风险；
4. Pi 没有面向第三方观察器的通用 permission/input-request 事件。不能伪造与 Claude 一样的
   approval 能力；
5. Pi 的 `session_shutdown(reason=reload/new/resume/fork)` 不是 PTY 退出，不能生成
   `session.exited` 或销毁 Vibing Session。

## 3. Adapter 身份与边界

| 字段 | 内容 |
|---|---|
| 产品 / `adapterId` | Pi / `pi` |
| 主协议 | 官方 TypeScript Extension API |
| 传输 | per-session atomic file drop |
| 事件源 | `native-stream` |
| 首版平台 | Windows、WSL；macOS/Linux 代码路径同时完成 |
| 支持版本 | `0.82.x` full；`0.80.x–0.81.x` compatibility-full |
| thinking | phase；不传 reasoning 文本 |
| tools | progress（限流）；不传 args/result |
| approvals | none（Pi 无通用只读 approval event） |
| input requests | none（extension UI 请求无全局 observer event） |
| usage | tokens-and-context；仅数值 |
| messages | none；只发 responding phase，不传助手正文 |

### 3.1 明确不做

- 不使用 OCR、spinner 正则、PTY 输出解析推断权威状态；
- 不读取/发送 thinking delta、assistant text、prompt、tool args、tool output；
- 不替用户增加 tool approval policy，不接管 `project_trust`；
- 不订阅会改变 Pi 行为的 `input/tool_call/tool_result/project_trust` handler；
- 不修改 `~/.pi`、项目 `.pi`、用户 extensions/settings/trust 配置；
- 不用 `--approve`、`--no-approve` 或任何权限绕过参数；
- 不支持从普通 shell 手工键入 `pi` 的 PATH shim，首版只监听由 Vibing Pi 卡片直接启动的会话；
- 不在一个 Pi 进程内部切换 `/new`、`/resume`、`/fork` 时创建新的 Vibing Session。

“达到 Claude Code 一样的监听效果”定义为：所有 Pi **原生可只读观测**的 phase、tool、
usage、error、turn completion、session lifecycle 都进入同一公共投影；Pi 没有的通用 approval/
input-request 事实保持 capability=`none`，不通过改写产品行为制造假能力。

## 4. 模块设计

```text
electron/agents/adapters/pi/
  types.ts                 # PiWireEvent / PiNativeFact / capabilities
  PiExtensionSource.ts     # 生成自包含、版本分支扩展源码
  PiHookParser.ts          # untrusted drop JSON → PiNativeFact
  PiEventProjector.ts      # Pi run/turn/tool/thinking/usage → AdapterEvent
  PiObserverAdapter.ts     # probe / prepare / paths / attach / dispose
  index.ts

e2e/fixtures/pi/
  extension-events-080.json
  extension-events-082.json
  pi-faux-provider.ts      # 测试专用离线 provider，不进入产品包

e2e/pi-observer.spec.ts
e2e/pi-real-observer.spec.ts
```

公共 `shared/agent-events.ts` 与 Adapter seam 不需要新增字段。Pi 的 `responding`、native
turn index、session generation、settle compatibility 全留在私有 Projector。

## 5. 生成扩展：只压缩事实，不改变 Pi

### 5.1 注入

`PiObserverAdapter.prepare()` 生成：

```text
<runDir>/pi-observer.ts
<runDir>/pi-drop/
```

并返回：

```ts
{
  prependArgs: ['--extension', runtimeExtensionPath],
  env: {
    VIBING_PI_DROP_DIR: runtimeDropDir,
    VIBING_PI_SESSION_ID: sessionId,
    VIBING_PI_SCHEMA: '1'
  }
}
```

官方保证即使用户传 `--no-extensions`，显式 `-e` 仍会加载。用户自己的 `-e` 不冲突；
Vibing 扩展不导入 Pi 包，只接收 runtime 传入的 `pi` 对象，避免 Windows/WSL 包解析差异。

以下管理/一次性命令不注入，直接 lifecycle-only：

```text
install remove uninstall update list config --help --version --export --list-models
```

`--mode json/rpc`、`--print` 仍可加载扩展，但首版 UI 真机验收以默认 TUI 为准。

### 5.2 Wire envelope

扩展只写最小、版本化 envelope：

```ts
interface PiWireEvent {
  schema: 1
  sessionId: string
  generation: string
  seq: number
  emittedAt: number
  type: string
  payload?: Record<string, string | number | boolean | null>
}
```

限制：

- 单事件 JSON ≤ 64 KiB；字段长度与数字范围在扩展内先钳制；
- `generation` 在扩展实例加载时随机生成；`/reload /new /resume /fork` 即使 seq 从 1
  重启，也不会与旧实例 nativeId 冲突；
- temp 文件 `0600`、目录 `0700`（POSIX），同目录原子 rename；
- 文件名包含 zero-padded seq + random nonce，mtime 只作次排序；
- 写入串行化；`session_shutdown` handler 等待队列 drain；
- process crash 丢失最后一个事件时由 PTY exit 作为唯一退出事实；
- 首个 transport 错误只记录一次，避免污染 TUI/日志；
- 扩展不把 endpoint token、认证、工作区内容写入 env 或文件。

### 5.3 订阅事件

| Pi event | 扩展读取字段 | 输出 fact | 说明 |
|---|---|---|---|
| `session_start` | `reason` | `session-start` | reset native generation，发 idle |
| `session_shutdown` | `reason` | `session-shutdown` | 不等于 PTY exit |
| `agent_start` | 无 | `run-start` | 一个用户任务/continuation 开始 |
| `agent_end` | 只读 stop/usage 数字 | `run-end` | 0.82+ 不直接 done |
| `agent_settled` | 无 | `run-settled` | 0.82+ 权威 done |
| `turn_start` | `turnIndex/timestamp` | `native-turn-start` | 私有关联，不重复公开 turn |
| `turn_end` | message usage/stopReason | `native-turn-end` | 只传数字与枚举 |
| `message_update` | event type + partial usage | `thinking/responding/error/usage` | delta 内容不读取、不序列化 |
| `tool_execution_start` | id/name | `tool-start` | args 不离开 Pi |
| `tool_execution_update` | id/name | `tool-progress` | 每 call 最多 4Hz，无 output |
| `tool_execution_end` | id/name/isError | `tool-end` | result 不离开 Pi |
| `session_before_compact` | reason/willRetry | `compact-start` | 保持 working |
| `session_compact` | reason/willRetry | `compact-end` | retry 时不 done |

扩展**不注册**：`input`、`before_agent_start`、`tool_call`、`tool_result`、
`project_trust`、provider request/header hooks。它们包含敏感正文或具备 mutation 语义，不是监听所需。

### 5.4 thinking 与 token

- `thinking_start` → `thinking-start`；
- `thinking_end/text_start/done/error` → `thinking-end`；
- `text_start` → `responding`，UI 显示“正在整理回复”；
- `thinking_delta/text_delta` 的字符串永远不读取、不发出；
- 若 `event.message.usage.output` 是有限、单调数字，可每 1 秒最多发一次 usage sample；
- `turn_end.message.usage` 发最终 input/output/cache/cost 数字；
- `ctx.getContextUsage()` 在 settle 时只取 context tokens/window 数字；
- provider 不提供实时 usage 时，思考阶段只显示 elapsed，不伪造 token。

## 6. Parser 与 Projector

### 6.1 Parser

`PiHookParser` 将文件视为不可信输入：

- schema/sessionId/generation/seq/type 必须精确；
- 不认识的 type 忽略并计有界诊断，不降级整个会话；
- 字符串最长 128，错误类别使用 allowlist，不接受原始 stack/message；
- usage 只接受非负有限数，过大钳制；
- tool name 只保留安全短名，args/result/content 字段即使出现也丢弃；
- 同一 generation 内 seq 重复/倒退与跨 Session envelope 不进入 Projector；新 generation
  只允许从 `session-start` 建立。

### 6.2 统一 turn 定义

Pi 原生 `turn_start/end` 是“一次 LLM response”，工具循环时会重复；公共
`AgentEvent.turn.*` 是“一次用户任务/自动 continuation”。因此：

- `agent_start` 开一个公共 turnId：`pi:<generation>:<runCounter>`；
- 原生 turnIndex 只用于 correlation/usage nativeId；
- 多个原生 turn、并行 tool 都聚合到当前公共 turn；
- `agent_end` 只关闭低层 run，不提前完成；
- `agent_settled` 或 0.80 compatibility settle 才发公共 `turn.completed`；
- error/aborted 在确定不会自动 retry 后发 `turn.failed` 或 cancelled completed；
- settle 前必须 active tools=0、thinking=false、无 compaction/retry 标记。

### 6.3 映射表

| Pi fact | AdapterEvent | UI 结果 |
|---|---|---|
| `session-start` | `session.idle(high)` | 等待你的下一条指令 |
| `run-start` | `turn.started` | 正在分析并规划下一步 |
| `thinking-start` | `thinking.started` | 正在思考 · elapsed / tokens（有则显示） |
| `thinking-end` | `thinking.completed` | 保留最新内容，不清空卡片 |
| `responding` | `activity.caption` | 正在整理回复 |
| `tool-start` | `tool.started` | 正在执行 Bash/Read/Edit/... |
| `tool-progress` | `tool.progress` | 保持工具 phase，不显示输出 |
| `tool-end ok` | `tool.completed` | 回到 working，等待后续 response |
| `tool-end error` | `tool.failed` | 工具执行失败（通用低敏文案） |
| `run-settled` | `usage.updated` + `turn.completed` | 本轮任务已完成 · N tokens |
| terminal error | `turn.failed` | 执行遇到问题 · Pi 返回错误 |
| observer issue | `observer.degraded` | 监听已降级；不伪装 Agent 错误 |
| PTY exit | Runtime `session.exited` | 会话已结束 |

### 6.4 session replacement

`session_shutdown(reason=reload/new/resume/fork)`：

- 关闭当前 native correlation 与 active tools；
- 等后续 `session_start`，发新的 high-confidence idle；
- 保持同一 Vibing `sessionId/terminalId/PTY`；
- 不写第二次历史启动，不产生 exited，不创建幽灵 Session；
- `reason=quit` 仍不直接 exited，PTY exit 是唯一进程退出事实。

## 7. 平台与路径

### 7.1 Windows / macOS / Linux host

- 扩展与 drop 目录直接使用 host `runDir`；
- Windows npm `.cmd/.ps1` 包装由现有 `prepareLaunch()` 统一序列化；
- macOS/Linux 用同一参数数组与 Node 扩展源码；
- 不修改 PATH，不生成 shim，不写用户 home。

### 7.2 WSL

prepare 阶段使用本次安装记录中的**精确 distro 与 resolvedExecutable**：

1. 执行该 Pi 的 `--version`，不使用 Windows Pi 代替；probe 复用扫描/正式启动的完整
   WSL `PATH`，避免 NVM/pi-node 的 `#!/usr/bin/env node` 包装器误用系统旧 Node；
2. `wslpath -a -u <runDir>` 得到 runtime path，不硬编码 `/mnt/c`；
3. 用 `/bin/sh` 在 runtime drop 目录写 partial + rename；
4. Windows 主进程读取同一 nonce，验证内容后删除 probe；
5. 只有真实往返成功才声明 observer capabilities；
6. env 由现有 WSL `env KEY=value executable` wrapper 注入，不依赖 WSLENV/curl.exe/binfmt；
7. automount 关闭、custom mount 不可写或路径翻译失败 →
   `observer.degraded(pi-wsl-drop-unavailable)` + lifecycle-only。

WSL default NAT、mirrored networking 对 file drop 无影响。custom mount 由 `wslpath` 实测，
不依赖扫描缓存。

若旧缓存暂时没有 WSL 环境记录，probe 会把 `resolvedExecutable` 所在目录前置为保守
fallback；这只用于恢复能力探测，正式启动仍以 Discovery 的统一环境契约为权威。

## 8. 生命周期与资源回收

`PiObserverAdapter` 必须满足：

- `prepare()` 在 spawn 前完成所有 probe/写文件；不在 attach 后追加启动参数；
- prepare 失败删除 extension/drop，返回 degraded prepared observer；
- spawn 失败调用 prepared dispose，`runDir` 最终由 Runtime 删除；
- attach 只创建 `HookDropPoller + Parser + Projector`，不 spawn helper；
- attach 失败不 kill Pi PTY；
- dispose 幂等，先停 poller，再删 extension/drop；
- App quit、用户关闭、Pi 自退、Ctrl+C、迟到 drop 竞态只 finalize 一次；
- renderer reload 只 `listActive`，不会重写扩展、重新 spawn Pi 或复制终端；
- 迟到文件不能复活墓碑 Session；
- 两个 Pi Session 各自 runDir/sessionId/seq，绝不串流。

安全删除沿用 Runtime 的 per-session runDir 边界；Adapter 只删除自己创建且经过 lstat 校验的
`pi-observer.ts` 与 `pi-drop`，不跟随 symlink/reparse point。

## 9. 实施阶段

### P0 — 契约取证与双版本 fixture

- [x] Context7 核对当前官方 Extensions/SDK/JSON 文档；
- [x] 核对 Windows `0.82.1` 类型与 CLI help；
- [x] 核对 WSL Ubuntu-22.04 `0.80.3` 的实际 binary 与类型；
- [x] 采集两版本 session/thinking/tool/error/settle 的原始结构；
- [x] 原始 trace 立即脱敏，只提交最小 fixture；
- [x] 验证 `agent_settled` 的版本边界与 0.80 compatibility settle；
- [ ] 验证 Pi 扩展加载错误不会影响 composer 与普通 TUI 输入。

### P1 — Source、Parser、Projector

- [x] 实现版本化 `buildPiExtensionSource()`；
- [x] 实现 64KiB envelope、原子写、顺序与限流；
- [x] 实现严格 Parser 与低敏 tool/usage/error 分类；
- [x] 实现 generation/run/native-turn/tool/thinking/settle correlation；
- [x] 覆盖重复、乱序、缺失、并行 tools、compaction/retry；
- [x] 证明 reasoning/text/prompt/args/result 不出扩展。

### P2 — Prepare 与跨平台 transport

- [x] 精确版本 probe 与 unsupported command 检测；
- [x] host extension/drop 创建与权限；
- [x] WSL wslpath + 原子写读 probe；
- [x] 返回 `-e` 与无秘密 env；
- [x] transport 失败 lifecycle-only；
- [x] 注册 `PiObserverAdapter` 到 `ObserverRegistry`。

### P3 — 生命周期/幽灵 Session

- [x] prepare/attach/spawn 各失败点零泄漏；
- [x] `/reload /new /resume /fork` 不退出、不克隆（Projector generation 门禁）；
- [x] PTY exit 唯一退出事实；
- [x] renderer reload 不重启（沿用 Runtime `listActive` 恢复）；
- [ ] 两实例隔离与 late drop 墓碑门禁；
- [x] 关闭后 poller/timer/file/runDir 全清零。

### P4 — UI 投影

- [x] 启动 Pi 后稳定显示 idle，不显示“运行中”；
- [x] thinking/responding/tool/done/error/exit 文案与 Claude 共用公共 i18n；
- [x] 完成覆盖旧 thinking/tool caption；
- [x] usage token 与 context 数值正确，无值时不留空占位；
- [x] Sidebar、Home、History、悬浮窗复用同一权威 Projection；
- [x] Pi capability 不显示虚假的 approval/input support。

### P5 — 自动化与真实 E2E

详见下一节。全部硬门禁通过才交付，不以截图或人工“看起来正常”代替状态断言。

## 10. E2E 验证设计

### 10.1 三层测试

1. **Fixture/Projector gate**：提交脱敏的 0.80/0.82 原生事件序列，直接验证 Parser、
   Projector、去重、隐私与最终六态；
2. **真实 Pi + 离线 faux provider gate**：启动本机真实 Pi binary，同时加载测试专用 provider
   extension，确定 Pi Extension API、参数注入、file drop 与 TUI 全链路真实工作；
3. **真实 provider opt-in gate**：使用用户现有 Pi 认证做一轮普通问答 + tool，多轮只用于发布前
   smoke，不进入默认 CI、不写生产 workspace。

测试专用 faux provider 固定产生 thinking、text、usage、tool call、tool failure、retry/error；它只在
`e2e/fixtures/pi/`，不会被产品构建或用户会话加载。

### 10.2 断言原则

- E2E 用真实键盘输入驱动 Pi TUI，但状态断言读取主进程 projection / DOM test id；
- 不对终端截图做 OCR，不用 spinner/英文文案正则判断监听成功；
- 每一步同时断言 `status/detail/capabilities/activeToolCount/usage`；
- drop 原始 payload 只在临时目录，测试结束删除；
- workspace 由测试创建，只允许读写指定临时文件。

### 10.3 Windows host 必过场景（0.82.1）

- [x] 从欢迎页点 Pi 卡片 → 只有一个 Session/PTY，初始 idle；
- [ ] 普通问答：working → thinking → responding → done；
- [x] thinking 无文本泄漏，elapsed/live usage 有则显示；
- [x] tool success：tool.started/progress/completed → done；
- [x] tool failure：tool.failed，后续 agent 可继续并正确 done；
- [ ] 两个 tool 同时/同轮：activeToolCount 不提前归零；
- [x] provider error + automatic retry：`agent_end` 不提前 done，最终 settled 才 done；
- [ ] Ctrl+C/aborted：旧 thinking/tool 清空，状态为 cancelled/error 后仍可下一轮；
- [ ] `/new`、`/resume` 或 `/reload`：同一 Vibing Session，不新增 Terminal；
- [x] 关闭 Session → 无幽灵 terminal；刷新 renderer → 不重启 Pi；
- [ ] 两个并发 Pi：事件、usage、关闭互不串流。

### 10.4 WSL Ubuntu-22.04 必过场景（0.80.3）

- [x] 扫描选中的 executable 必须是 WSL native Pi，不得落到 `/mnt/c/.../pi`；
- [x] `-e` 与 drop path 都是 distro 可访问路径；
- [x] 真实原子 probe 成功后才声明 capabilities；
- [x] 普通问答：working → thinking → responding → compatibility done；
- [x] tool success/failure 与 usage；
- [x] queued continuation/retry 期间 compatibility settle 不提前完成；
- [x] close/reload/no ghost 与 Windows 相同；
- [x] 模拟 wslpath/drop 不可写时 Pi 仍启动，observer 显示 lifecycle-only。

### 10.5 macOS / Linux

- [x] 默认自动化覆盖 host 参数、path、权限、Parser/Projector；
- [ ] 发布“全平台已验证”前必须各补一台真实机器的 launch + no-tool + tool + exit smoke；
- [x] 没有真机证据前文档只写“代码路径支持”，不写“已验证”。

### 10.6 approval/input 的验收边界

Pi 官方 Extension API 允许某个 extension 自己调用 `ctx.ui.confirm/input/select`，但没有把这些
请求广播为全局只读 observer event。Vibing 扩展无法可靠知道另一个 extension 的请求和结果。

因此首版：

- `approvals='none'`、`inputRequests='none'`；
- 不写无法实现的 approve/deny/reply/reject E2E；
- `project_trust` 不映射 approval，因为返回 `undecided` 后观察器拿不到内建 prompt 的最终决定；
- 若未来要提供 needs-you，必须单独设计“Vibing 托管 Pi permission policy”，明确告知它会改变
Pi 行为，不能混进只读监听 Adapter。

### 10.7 2026-08-04 实施证据

实际验证版本：Windows `0.82.1`、WSL Ubuntu-22.04 `0.80.3`。真实 E2E 使用本机
Pi binary 与 Pi 自己的 Extension loader；测试专用离线 provider 只负责确定性地产生
thinking、Bash success/failure、usage、provider error/retry 和最终响应，不绕过 Pi 的
Agent/Tool/Extension 事件链。

```text
npx playwright test e2e/pi-observer.spec.ts --workers=1
  13 passed

$env:VIBING_E2E_REAL_PI='1'; npx playwright test e2e/pi-real-observer.spec.ts --workers=1
  Windows 0.82.1 passed
  WSL 0.80.3 passed

npx playwright test e2e/agent-observer.spec.ts e2e/agent-session.spec.ts \
  e2e/ai-cli-discovery.spec.ts e2e/pty-data-queue.spec.ts \
  e2e/pty-error-guard.spec.ts --workers=1
  38 passed；1 个瞬时 fixture UI 采样失败，单独复跑 agent-observer 2/2 passed

npm run typecheck
npm run build
  passed
```

真实 DOM trace 在 Windows/WSL 两端都捕获到：`正在思考 · N秒`、`正在执行 bash`、
`正在整理回复`、`本轮任务已完成`。未覆盖项保持明确：当前机器没有 Pi provider 凭据，
因此未跑真实在线 provider smoke；macOS/Linux 只有 host 代码路径自动化门禁，没有真机结论。

## 11. Definition of Done

- [x] Windows 0.82.1 与 WSL 0.80.3 的真实 Pi Extension API 全链路通过；
- [ ] no-tool、thinking、responding、tool success/failure、usage、error/retry、done、exit 齐全；
- [x] 0.82 `agent_settled` 与 0.80 compatibility settle 都不提前完成；
- [x] startup idle、完成覆盖旧 caption、退出终态与 Claude UI 一致；
- [x] 无 reasoning/assistant/prompt/tool args/output 泄漏；
- [x] 无 input/tool/trust mutation，无权限策略改变；
- [ ] Windows + WSL 两实例隔离、reload、close、late event、ghost Session 门禁通过；
- [x] transport 失败诚实降级且不修改 Pi 启动参数；
- [x] `pi-observer.spec.ts`、`pi-real-observer.spec.ts`、AgentSession/PTY 回归通过；
- [x] typecheck、build、目标 E2E 通过；
- [x] 本文回写实际 trace、版本、测试命令、未覆盖平台；
- [ ] 没有以上真实证据前不向用户宣称“监听完成”。

## 12. 建议提交拆分

1. `test: capture Pi extension contracts for 0.80 and 0.82`
2. `feat: add low-sensitivity Pi extension source and parser`
3. `feat: project Pi lifecycle tools thinking and usage`
4. `feat: wire Pi observer across host and WSL runtimes`
5. `test: verify real Pi observer on Windows and WSL`
6. `docs: record Pi adapter evidence and capability limits`

每个提交都保持 typecheck 可通过；真实 E2E 失败时修复同一阶段，不把“先写完再人工试”作为交付路径。
