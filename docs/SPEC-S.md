# AI CLI 发现与启动线 — Spec（S 线）

> 状态：**S1 Agent Observer 基础设施已完成（2026-08-03）**；S0 跨平台自动化矩阵仍待补齐。
> 当前交付：**扫描 → 启动列表 → 点击进入配置 → 按所选环境启动 → 主进程归约六态投影**。
> 真实 CLI 语义监听（Hooks/JSONL/ACP）归 S2/S3，见 [PLAN-S2-CLAUDE.md](./PLAN-S2-CLAUDE.md)。
>
> 父文档：[SPEC.md](./SPEC.md)。市场事实基线：[RESEARCH-AI-CLI-MARKET.md](./RESEARCH-AI-CLI-MARKET.md)。

---

## 0. 当前产品闭环

```text
扫描当前主机（Windows / macOS / Linux）
  + Windows 上的每个可用 WSL 发行版
  ↓
只列出已验证、可启动的 AI CLI
  ↓
点击产品
  ↓
进入现有配置层：名称 / 工作区 / 参数 / 安装位置
  ↓
用户确认启动
  ↓
在被扫描到的同一运行环境中创建 PTY 会话
```

本阶段的“点击”不是在卡片上直接执行 CLI，而是进入现有 `NewSessionFlow` 配置层；
真正 spawn 仍由配置层的“启动”按钮触发。

S0 已移除 renderer 中不论安装状态都展示的静态品牌墙，并拆成：

- 产品维护的静态 **CLI 定义**；
- 主进程实际扫描得到的 **CLI 安装**；
- renderer 只展示至少包含一个已验证安装的 **可启动 CLI**。

---

## 1. 领域语言与范围

| 术语 | 定义 |
|---|---|
| **CLI 定义（CliDefinition）** | Vibing 认识的一种 AI CLI 产品及其稳定元数据；不代表用户已安装 |
| **运行环境（CliRuntime）** | 命令解析与执行所在的命名空间；Windows 主机和每个 WSL 发行版是不同环境 |
| **CLI 安装（CliInstallation）** | 某个 CLI 定义在一个运行环境中经身份验证的具体可执行文件 |
| **可启动 CLI（LaunchableCli）** | 至少拥有一个 CLI 安装的产品，是启动列表的一行/一张卡 |
| **启动选择（LaunchSelection）** | 用户选定的 CLI 安装、工作区、显示名称和附加参数 |
| **运行会话（RunningSession）** | 启动后与一个 terminal 关联的 AI CLI 会话；S0 只有壳生命周期，没有语义监听 |

边界：

- 扫“我们可以从 Vibing 启动什么”，不扫外部终端里已经运行的进程；
- 扫描不检查账号是否登录、订阅是否有额度，也不向网络发模型请求；
- WSL 不是一个布尔选项。`Ubuntu`、`Debian` 等发行版分别解析 PATH、分别安装 CLI；
- 云端能力（如 Devin Cloud、Oz cloud run）是产品能力，不是另一个本地安装；S0 不调度云任务；
- ACP wrapper、模型名、API 套餐和仅 IDE 功能不自动成为启动列表产品。

---

## 2. 探测决策：命令解析为主，版本探针确认，目录只作定点补充

### 2.1 不采用单一 `claude -V` 式探测

不同产品的安全版本命令并不统一：可能是 `--version`、`version`、`-v` 或其它形式；
某些短命令还会与系统中无关程序重名。S0 不对所有产品盲跑同一个 `-V`。

每个 `CliDefinition` 必须声明自己的：

1. 可执行名及历史别名；
2. 无交互、无需登录的身份探针；
3. 可接受的退出码和 stdout/stderr 身份特征；
4. 必要时的已知安装位置。

因此，版本命令是**身份确认阶段**，不是寻找命令的第一步。

### 2.2 两阶段算法

| 阶段 | 目的 | 规则 |
|---|---|---|
| **解析（resolve）** | 在目标运行环境中找到实际会被执行的文件 | 主机使用 PATH/PATHEXT 语义；WSL 使用该发行版自己的 shell PATH |
| **验证（verify）** | 证明解析结果属于目标 AI CLI，且能无交互退出 | 对解析到的准确路径运行该产品的身份探针，匹配版本/品牌输出 |

只有 `resolve + verify` 都通过的结果才是 `CliInstallation`，才进入启动列表。
探针失败、超时或身份不匹配都不把该路径暴露为可启动项，但写入扫描诊断供排查。

### 2.3 为什么不递归扫描目录

S0 **不递归遍历磁盘、Program Files、用户目录或 WSL 文件系统**：

- 慢，且会无谓唤醒磁盘/安全软件；
- 会找到缓存、旧版本、node_modules、卸载残留，误判率高；
- “文件存在”不等于当前环境能按用户预期启动；
- Windows 的 `.exe/.cmd/.ps1` shim 与 WSL 的 shell PATH 只能由各自命令解析语义正确排序。

目录只允许作为**定义内的定点 fallback**：例如某厂商官方安装器的固定位置或某应用捆绑的
可执行文件。仅当 PATH 未解析到结果时检查这些完整路径；检查到后仍必须跑身份探针。

### 2.4 安全与资源限制

- 候选名、探针和已知路径只能来自内置定义，renderer 不得传任意命令给扫描器；
- 主机探针直接执行解析后的文件，不经过 `cmd.exe` / PowerShell 字符串拼接；
- WSL 只有 `command -v` 需要 POSIX shell，参数来自受信定义并以位置参数传入；
- 单探针有短超时、stdout/stderr 字节上限和并发上限；超时后终止整棵子进程；
- 扫描不自动安装、升级、登录或修改任何 CLI 配置；
- `--dangerously-*`、`--yolo`、`--yes` 等权限绕过参数绝不用于探测。

---

## 3. Windows 主机、WSL 与点击启动

### 3.1 Windows 主机扫描

对每个定义的每个 Windows 可执行名：

1. 用 `where.exe <name>` 按当前 Electron 主进程的 PATH/PATHEXT 解析；
2. 保留 PATH 顺序中的首个候选作为实际默认命中，其余路径仅进诊断；
3. 若未命中，检查该定义声明的 Windows 固定路径；
4. 对准确路径运行定义自己的身份探针；
5. 成功后记录为 `runtime: { kind: 'host', platform: 'windows' }` 的安装。

`where.exe` 能覆盖 npm/pnpm/bun 生成的 `.cmd` shim、WindowsApps execution alias 和普通
`.exe`。如个别产品只提供 PowerShell `.ps1`，它必须在定义中显式声明解析方式；不加载
PowerShell profile，也不接受 alias/function 作为可执行安装。

### 3.2 WSL 逐发行版扫描

Windows 上同时扫描 WSL，但不是把 Windows PATH 传给 Linux：

1. 使用 `wsl.exe --list --quiet` 枚举已注册发行版；
2. 过滤 Docker Desktop 等产品管理的系统发行版，只保留用户可启动的开发发行版；
3. 在每个发行版中读取当前用户的登录 shell，并以其 login/interactive PATH 执行
   `command -v <name>`；这要与用户实际打开 WSL 终端后的命令环境一致，而不是裸 `sh` 的最小 PATH；
4. PATH 未提供可验证的原生 Linux 命中时，以 `whereis -b <name>` 和定义内固定路径作为
   有界补充；`/mnt/<drive>/...` 的 Windows 互操作入口排在原生候选之后；
5. 在**同一个发行版**中逐个验证候选的身份，首个通过者成为该发行版的安装；
6. 成功后记录 `runtime: { kind: 'wsl', distro: '<发行版名>' }`。

规则：

- 一个 CLI 可同时有 Windows、Ubuntu、Debian 等多个安装；不能互相去重；
- 一个 WSL 发行版扫描失败不影响主机或其它发行版，错误进入 `runtimeErrors`；
- WSL 未安装或没有任何用户发行版时，主机扫描仍正常完成；
- 每次扫描可能启动休眠中的 WSL 发行版，因此不在每次窗口 focus 时重扫；
- 完整扫描成功后把已验证安装与 WSL 启动 PATH 原子写入
  `<userData>/ai-cli-scan.json`；应用下次启动直接读取并校验该缓存，不重新唤醒 WSL；
- 只有首次无缓存、缓存损坏/版本不兼容，或用户主动点击「重新扫描」时执行完整扫描；
  强制扫描完成后覆盖缓存，手工改坏的条目会被丢弃而不是直接执行；
- 启动 Sheet 只负责选择已发现的 CLI，不显示扫描状态、错误或重新扫描入口；完整扫描入口
  与逐运行时错误详情放在设置页，Home 欢迎页保留轻量「重新扫描」快捷入口；
- 扫描到哪个发行版，启动就必须明确使用哪个发行版，禁止退回 WSL 默认发行版。

### 3.3 启动后的运行态兼容契约

S0 启动成功后仍建立 `sessionId ↔ terminalId`，侧栏/Home 沿用既有六态 UI 数据结构；但
本阶段只由壳生命周期写入 `working` 与 `exited`。`needs-you`、`done`、`error`、`idle`
不得通过猜测终端文案产生，等 §9 的监听阶段实现。

点击已启动的会话仍只聚焦其终端。S0 不在列表或侧栏中批准、代答、重试或远程操控 CLI。

---

## 4. 静态 CLI 定义注册表

扫描器不知道品牌文案、图标和探针规则；这些由内置定义注册表提供。注册表是数据，不是监听
adapter，也不是动态加载第三方代码。

```ts
interface CliDefinition {
  id: string
  adapterId: string
  displayName: string
  hint: string
  iconId: string
  executables: {
    windows?: string[]
    unix?: string[]
  }
  probes: CliIdentityProbe[]
  knownPaths?: {
    windows?: string[]
    unix?: string[]
  }
  launchArgs?: string[]
  status: 'active' | 'legacy' | 'maintenance-ended'
}

interface CliIdentityProbe {
  args: string[]
  outputPattern: string
  acceptedExitCodes?: number[]
}
```

`launchArgs` 只能包含维持正常交互所需的安全参数；默认应为空。权限模式是用户启动选择，不能
继续把 Codex `--full-auto`、Claude `--dangerously-skip-permissions`、Gemini `--yolo`、
Aider `--yes` 固化成品牌默认值。

### 4.1 S0 内置定义范围

第一批必须覆盖市场调研中的主流本地入口：

| 层级 | 产品 |
|---|---|
| **Core（S0 验收）** | Claude Code、Codex、Gemini CLI、OpenCode、Cursor Agent、Cline、Qwen Code、Amp、Kimi Code、Grok Build、Pi、GitHub Copilot CLI、Goose、Crush、Warp/Oz、Devin CLI、Kiro CLI、Aider |
| **Extended（同一数据机制）** | Factory Droid、Auggie、Mistral Vibe、Junie、Qoder CLI、CodeBuddy Code、Kilo、Trae Agent |
| **Legacy metadata（默认隐藏）** | Amazon Q `q`、`warp-cli`、Continue `cn`、旧 `gh copilot`；iFlow 已停运，不作为可启动产品 |

当前内置注册表已覆盖 18 个 Core 与 8 个 Extended 产品。Legacy 只保留调研元数据，尚不进入
默认扫描和启动列表。

Extended 不要求 S0 为其实现监听，只要求一旦定义的身份探针被确认，就能复用同一扫描、列表与
启动数据流。ACP Registry 的 38 个 entry 不直接等于 38 个 TUI 产品；wrapper、framework、
云端代理和垂直工具按 [市场调研](./RESEARCH-AI-CLI-MARKET.md) 的分类决定是否加入定义。

---

## 5. 扫描结果与运行会话数据

### 5.1 运行环境

```ts
type CliRuntime =
  | { kind: 'host'; platform: 'windows' | 'macos' | 'linux' }
  | { kind: 'wsl'; distro: string }
```

### 5.2 已验证安装

```ts
interface CliInstallation {
  id: string                  // definition + runtime + normalized path 的稳定散列
  definitionId: string
  runtime: CliRuntime
  resolvedExecutable: string  // Windows 或对应 WSL 内的准确路径
  detectedVia: 'path' | 'known-path'
  version?: string
  verification: 'verified'
}
```

renderer 只能启动主进程返回的 installation id，不自行拼 executable，也不把扫描诊断中的失败
路径当成安装。

### 5.3 可启动产品与扫描报告

```ts
interface LaunchableCli {
  definition: Pick<
    CliDefinition,
    'id' | 'adapterId' | 'displayName' | 'hint' | 'iconId'
  >
  installations: CliInstallation[]
}

interface CliScanReport {
  startedAt: number
  finishedAt: number
  launchable: LaunchableCli[]
  runtimeErrors: Array<{
    runtime: CliRuntime
    code: 'unavailable' | 'timeout' | 'probe-failed'
    detail: string
  }>
}
```

`available: boolean` 不再放在每一行上：有安装就进入 `launchable`，没有安装就根本不返回到默认
启动列表。静态全量定义只留在主进程，避免 renderer 再造一份品牌墙。

### 5.4 启动选择

```ts
interface LaunchSelection {
  installationId: string
  name: string
  workspace: string
  args: string[]
}
```

### 5.5 运行会话（兼容既有 UI）

```ts
interface RunningSession {
  sessionId: string
  terminalId: string
  adapterId: string
  installationId?: string
  name: string
  status: 'working' | 'needs-you' | 'done' | 'error' | 'idle' | 'exited'
  detail?: string
  lastActivityAt: number
}
```

S0 新会话应保存 `installationId`，使历史/诊断知道它来自 Windows 还是具体 WSL 发行版；现有旧
会话允许没有该字段。

---

## 6. 启动列表与点击体验

已定 UX：

1. **未安装的产品默认隐藏**，不在启动列表展示灰色品牌墙；未来可另做“发现/安装 CLI”目录；
2. 同一产品只展示一张卡，卡上用标签说明 `Windows`、`WSL · Ubuntu` 等已验证位置；
3. 只有一个安装时，点击卡片进入配置层并预选它；
4. 有多个安装时，配置层必须显示安装位置选择器，不再只显示 `Windows / WSL` 二选一；
5. Home 快速启动与新建会话必须消费同一份 `LaunchableCli[]`，不能各自维护品牌数组；
6. 扫描尚未完成时显示加载态；没有任何命中时展示“未发现可启动 AI CLI”与刷新入口；
7. 扫描部分失败时仍展示成功项，并在非阻塞诊断入口列出失败运行环境；
8. 手动刷新会重新扫描 Windows 与全部 WSL 发行版。

### 6.1 扫描时机与缓存

- App 启动后先读取带 schema version 的 `<userData>/ai-cli-scan.json`，缓存缺失、损坏或版本
  不兼容时才后台完整扫描；
- Home 与新建会话读取主进程同一份缓存；无结果时等待同一正在进行的扫描，不重复发起；
- 用户点击刷新时强制新一轮扫描；同一时间只允许一个扫描任务；
- 不因窗口 focus 自动重扫，避免反复启动 WSL；
- 完整扫描结果与 WSL 登录 PATH 原子覆盖持久化缓存；卸载或 PATH 变化后由用户主动重新扫描刷新。

---

## 7. 从安装到 PTY 启动

启动必须消费扫描得到的准确 installation，而不是再次按名称解析：

| 环境 | 启动规则 |
|---|---|
| Windows 主机 | 直接以 `resolvedExecutable` 创建 PTY，参数为安全 `launchArgs + 用户 args` |
| WSL | `wsl.exe --distribution <distro> --exec env PATH=<login-path> <resolvedExecutable> ...args`，发行版和 PATH 均来自同次扫描 |

工作区也必须属于同一环境：

- Windows 安装使用 Windows 绝对路径；
- WSL 安装启动前把 Windows 路径转换为该发行版可访问的 WSL 路径，并在目标发行版中设置 cwd；
- `\\wsl.localhost\<distro>\...` 路径只能交给同名发行版；不匹配时阻止启动并提示用户重选；
- 路径转换失败时不退回 home 或默认发行版，避免在错误仓库执行 agent。

启动成功后：

1. 建立 terminal；
2. 建立 `sessionId ↔ terminalId ↔ installationId`；
3. 写既有 `session_start` 生命周期事件；
4. 进入 terminal page。

本阶段不安装 Hooks、不 tail transcript、不订阅 ACP/JSONL，也不根据 TUI 文本更新语义状态。

---

## 8. 里程碑与验收

### S0.1 — 注册表与跨环境扫描

- [x] 静态 CLI 定义与扫描结果分离；
- [x] Windows 主机按 PATH/PATHEXT 解析并运行品牌探针；
- [x] macOS/Linux 合并登录 Shell PATH、进程 PATH 与标准 bin 目录后逐候选 resolve + verify；
- [x] 枚举每个用户 WSL 发行版，分别 resolve + verify；
- [x] PATH 未命中时仅检查定义声明的固定路径；
- [x] 超时、重名、错误发行版不会产生假安装；
- [x] 扫描结果包含准确 runtime、distro、path、version（若可取得）。

### S0.2 — 真启动列表与点击进入

- [x] Home 与新建会话不再直接读取静态 `cliOptions`；
- [x] 只展示至少有一个 verified installation 的产品；
- [x] 点击产品进入现有配置层；
- [x] 多安装产品可以选择 Windows 或具体 WSL 发行版；
- [x] 无结果、扫描中、部分失败和手动刷新状态可见。

### S0.3 — 按所选安装启动

- [x] Windows/macOS/Linux 使用扫描到的准确路径；
- [x] WSL 使用扫描到的准确发行版、路径与转换后的 cwd；
- [x] 默认不附加任何权限绕过参数；
- [x] PTY 创建成功后才建立 terminal/session/installation 关联；
- [x] PTY 创建失败会移除临时 terminal，不创建 session，并在配置层返回可理解错误；
- [ ] 覆盖 Windows-only、WSL-only、双环境、多 WSL、重名、probe timeout 的自动化测试。

### S1.0 — Agent Observer 基础设施（实施见 [PLAN-S1.md](./PLAN-S1.md)）

- [x] `AgentSessionRuntime` 对 renderer 只暴露 start/stop/list/events/projection；
- [x] Observer Adapter seam 同时容纳启动前 augmentation 与启动后 attach；
- [x] thinking、tool、approval、input、usage、turn、lifecycle 均有结构化事件；
- [x] thinking 内容默认不采集、不持久化；
- [x] SessionStatus 完全由主进程纯归约器生成，renderer 只 upsert 展示副本；
- [x] 并行 tool 与多 pending request 不会错误清除 `needs-you`；
- [x] Observer prepare/attach 失败不终止 CLI PTY，降级为 lifecycle-only；
- [x] spawn 失败不留下 PTY、Session、历史计数或 temp 文件；
- [x] Agent Event 队列有界，洪峰不影响 PTY 字节链路；
- [x] tool/approval 统计按稳定 id 去重；
- [x] renderer reload 通过 `listActive` 恢复活动 Session 投影；
- [x] 普通终端启动、输入、resize、背压与退出链路不引入 Agent 依赖；
- [x] Fixture Adapter 完整事件序列驱动六态并通过 interface 级门禁。

### 后续（不属于当前实现）

| 阶段 | 结果 |
|---|---|
| **S1** | ✅ 结构化 observer 基础设施（事件、能力、归约、投影、IPC、fixture 门禁）已完成 |
| **S2** | ✅ Claude Code 参考 Adapter 驱动真实 `working / needs-you / done`；实施见 [PLAN-S2-CLAUDE.md](./PLAN-S2-CLAUDE.md) |
| **S3** | ✅ OpenCode Server/SSE Adapter（Windows + WSL）验证第二种协议形态；实施见 [PLAN-S3-OPENCODE.md](./PLAN-S3-OPENCODE.md) |
| **S4** | 注意力通知，仍只看不操作 |
| **F1** | 独立置顶悬浮窗，只消费 Agent projection；实施见 [PLAN-F1-FLOATING-WINDOW.md](./PLAN-F1-FLOATING-WINDOW.md) |
| **M6** | 在 S3 抽象上铺开更多产品的语义 adapter；扫描定义不需要等到 M6 |

---

## 9. 监听与六态语义（明确后置）

S0 只解决“机器上有什么、从哪里启动、用户点哪个”。通用监听基础设施已由 S1 落地（
[PLAN-S1.md](./PLAN-S1.md)：事件、能力、归约、投影、IPC 与 fixture 门禁），Claude Code
参考 Adapter 见 [PLAN-S2-CLAUDE.md](./PLAN-S2-CLAUDE.md)。S2 完成前，六态不宣布为
全产品通用能力——没有语义 Adapter 的 CLI 只有 lifecycle 观察。

后续 observer 优先级依据市场调研：

```text
JSONL / native event stream
  → ACP / RPC / local server / SSE
  → lifecycle Hooks
  → session / transcript
  → PTY tap / HeadlessScreen（最后兜底）
```

未来 observer 输出统一事件，再推导六态；进程生命周期与语义状态必须分开。Devin/Oz 等云端任务还需
把本地 launcher 与远端 run 分开建模。

S0 明确不做：

- 注入或修改任何 CLI Hooks；
- 读取用户全局 transcript/session 数据；
- 启动 ACP/RPC/server 代替原生 TUI；
- PTY 抓屏、HeadlessScreen 或关键词识别；
- `needs-you/done/error/idle` 的真实推导；
- 通知、悬浮窗、代批、代答或远程操控；
- 扫描 Vibing 之外已经运行的外部 AI CLI 会话。

历史源与 PTY tap 的讨论仍见 [PLAN-history-source.md](./PLAN-history-source.md)，但不阻挡 S0。
