# HRack Remote P5 计划：远程新建并立即驾驶

> 状态：2026-08-21 开始实施。依赖 P4 已关门；P6 App 尚未开始，手机端继续使用协议夹具和浏览器/真机前的公开 WSS seam。

## 1. 目标与关门定义

P5 只完成桌面侧远程新建：手机拿到与首页同源、去敏后的 CLI catalog，提交一个安装、工作区、参数、免审批开关和终端尺寸；HRack 走现有 `AgentSessionRuntime.start` 链创建真实 AI CLI，显示可见 tab，并立即把同一真实 PTY 交给 P4 驾驶。

关门时必须证明：

1. catalog 与首页扫描结果同源，不含 `resolvedExecutable` 或其它本机内部字段；
2. 合法 create 只 spawn 一次，响应严格为 `create-ok` → `drive-ok`；
3. 空白/不存在工作区、未知 installation 和已有驾驶都不 spawn；
4. 免审批参数复用首页的合并规则；
5. 相同 `requestId` 的重试不会重复创建，payload 不同则 `duplicate-mismatch`；
6. 本机测试中继和公网生产中继都用真实 Electron、真实 `AgentSessionRuntime` 和真实 PTY 通过。

P5 不做 App UI、手机 xterm、后台推送、普通 shell 新建或多手机。

---

## 2. P5 开始前的协议勘误

冻结的 v1 有两处只有进入 P5 才暴露的矛盾，必须在还没有 App/P5 客户端时同步修正桌面和中继协议副本：

1. SPEC 要求“按手机尺寸 spawn 后立即 `drive-ok`”，但 `create` 没有尺寸。`create` 增加必填 `cols`、`rows`，沿用 `drive` 的 1–10000 边界。禁止先用桌面估算尺寸启动再 resize，避免真实 TUI 首屏重画。
2. SPEC 验收要求空工作区收到 `create-reject invalid-workspace`，但旧守卫会直接丢弃空字符串。守卫改为接受长度范围内、无 NUL 的字符串；“非空且目录存在”由已占座的桌面业务端判断并给出关联响应。超长、NUL 或非字符串仍在协议边界拒绝。

这不是新增协议版本：P5/App 尚未发布，P2 也只做方向转发；修正后两份 v1 源码和测试必须在同一阶段对齐。

---

## 3. 模块边界

### 3.1 `RemoteDesktopClient`：协议与幂等权威

它只依赖窄 `RemoteLaunchHost`：

```ts
interface RemoteLaunchHost {
  catalog(): Promise<RemoteLaunchable[]>
  create(input: {
    installationId: string
    workspace: string
    args: readonly string[]
    skipApproval: boolean
    cols: number
    rows: number
  }): Promise<
    | { ok: true; sessionId: string; workspace: string }
    | { ok: false; reason: 'invalid-workspace' | 'installation-not-found' | 'launch-failed'; detail?: string }
  >
}
```

`RemoteDesktopClient` 不读取 discovery、BrowserWindow、terminal store 或 runtime 私有状态。它负责：

- 手机入座时发送 snapshot 和 catalog；最近工作区变化或 CLI 重新扫描时刷新 catalog；
- 驾驶 busy 时先拒绝 create，不调用 host；
- 按当前桌面连接生命周期缓存 `requestId → { fingerprint, Promise<responses> }`，把并发重试也合并为一次创建；
- 相同 fingerprint 重发第一次的 `create-*`/`drive-*` 响应，不重新 spawn/open；不同 fingerprint 返回 `duplicate-mismatch`；
- 首次成功发送 `create-ok`，再复用 P4 的 open-drive 路径发送 `drive-ok`。

电脑 socket 断开、主动 disconnect 或改连另一房间时清空幂等表；手机 15 秒短线重连不清空。

### 3.2 `runtimeRemoteLaunchHost`：现有首页能力的 adapter

主进程 adapter 组合 `AiCliDiscoveryService`、`AgentSessionRuntime` 和“显示已启动 terminal”的单向回调：

1. `catalog()` 调用 `scan(false)`，只映射 definition 的 id/adapterId/displayName/iconId、skipApproval label，以及 installation 的 id/runtime/version；绝不复制 `resolvedExecutable`。
2. `create()` 先在同一 scan 中确认 installation，再用 `resolveWorkspace` 验证并规范化 host/WSL 路径。
3. 参数数组直接来自协议；免审批复用与首页同一个共享 helper，避免重复注入或覆盖用户已有等价参数。
4. 生成稳定 terminalId，以手机 `cols/rows` 调用 `AgentSessionRuntime.start`。这条 runtime 内部继续执行 `resolveInstallation → resolveWorkspace → adapter prepare → discovery.prepareLaunch → PTY spawn → observer attach`。
5. start 成功后向现有 renderer 发送一个收窄的 remote-launch 事件，renderer 只新增 attach tab，不再次 spawn；事件不主动拉起新的 HRack GUI 进程。

### 3.3 首页 workspace 是 catalog 的单一真值

最近工作区当前保存在 renderer localStorage。P5 不另建第二份磁盘数据库：

- AppShell 启动和首页 history 变化时，通过收窄 IPC 上报最多 5 个字符串；
- `RemoteDesktopClient` 只持有本次应用进程内的安全副本，并在手机在线时重发 catalog；
- 远程 create 成功后 renderer 用既有 `saveWorkspace` 写回首页 history，再上报同一列表。

IPC 必须重建数组并限制数量、单项长度和 NUL；不接受任意对象。

---

## 4. 响应与幂等状态机

| 输入 | 是否调用 create host | 响应 |
|---|---:|---|
| 正在驾驶 | 否 | `create-reject busy` |
| 新 requestId + 空/不存在 workspace | 是（只校验，不 spawn） | `create-reject invalid-workspace` |
| 新 requestId + 未知 installation | 是（不 spawn） | `create-reject installation-not-found` |
| 新 requestId + launch/spawn 失败 | 是 | `create-reject launch-failed` |
| 新 requestId + 成功 | 一次 | `create-ok` → `drive-ok` |
| 相同 id + 相同 payload（含并发） | 不重复 | 重发第一次完整响应 |
| 相同 id + 不同任一字段 | 否 | `create-reject duplicate-mismatch` |

fingerprint 包含 `installationId`、原始 `workspace`、`args`、`skipApproval`、`cols`、`rows`。结果缓存存协议响应，不读取客户端私有字段。成功后若手机重发，缓存的 `drive-ok` 只作为关联响应重放，不能再次占用/resize PTY。

---

## 5. 安全与失败

- `workspace` 只在电脑上验证；WSL 路径只交给 installation 对应的 distro，手机不执行路径转换或 CreateProcess。
- `args` 是字符串数组，继续受数量和单项长度限制，不拼成 shell 字符串；最终 quoting 仍由 `AiCliDiscoveryService.prepareLaunch` 负责。
- create 错误 detail 只返回有限、可理解的类别说明，不回传 executable、runDir、环境变量或堆栈。
- catalog 失败不能断开远程会话；可以稍后 refresh。create 失败不能留下 provisional tab。
- renderer attach 失败不重复 spawn；真实会话/PTY 仍由主进程权威持有并可经远程释放或本机恢复。

---

## 6. TDD 垂直切片与测试 seam

已确认的 seam 是公开 WSS、远程 IPC 和真实 UI/PTY；测试不读取 `RemoteDesktopClient` 的私有 Map，也不 mock 自有类内部调用。

### Slice A：协议勘误

- `create` 缺 cols/rows、尺寸越界仍失败；合法尺寸被保留。
- 空字符串 workspace 可通过结构守卫，交给桌面产生 `invalid-workspace`；NUL、超长仍失败。
- 桌面与中继协议副本跑同一组契约例子。

### Slice B：catalog 与失败路径

- 内存 launch host + localhost WSS：手机入座收到安全 catalog 和最近工作区。
- 空/不存在、未知 installation、busy 各自收到关联 reject，host 没有产生会话。

### Slice C：成功、免审批和幂等

- localhost WSS：一次 create 得到有序的 `create-ok`/`drive-ok`。
- 同 payload 顺序与并发重试都只有一个会话；不同 payload 为 `duplicate-mismatch`。
- adapter 测试用已知 literal 证明 `skipApproval` 与首页 helper 结果一致。

### Slice D：真实 Electron

新增定向 e2e，从手机 WSS 读取真实 catalog，选择其中 host Codex fixture，创建到真实 `process.cwd()`：

- `AgentSessionRuntime.listActive()` 出现一个新会话；
- renderer 出现同 terminalId 的可见 tab；
- recoverable PTY 的 selection 含首页同款 `--yolo`，但没有重复；
- PTY 初始尺寸来自 create，手机输入得到真实 `pty-out`，解析后 ack；
- 重试不增加 session/tab，返回列表后桌面解锁并 fit；
- 空/不存在 workspace 不增加 session/tab。

### Slice E：真实部署接口

同一 live gate 先指向本机生产中继，再指向 `https://hrack.modplex.app/`。真实链路必须是浏览器建房/吊销 → HTTPS/WSS/反向代理 → Electron → `AgentSessionRuntime` → 真实 PTY，不能用 Node 内存 relay 冒充最终验证。

完整 `npm run e2e` 只在所有定向用例转绿、准备关门时运行一次；若失败，遵守 `AGENTS.md` 和 `docs/TEST-terminal-stress.md` 的定向复跑纪律。

---

## 7. 提交顺序

1. `docs: plan remote P5 creation`：本计划与协议勘误。
2. `feat: complete remote P5 creation`：协议副本、实现、定向/真实门禁与验证记录。

中继仓库的协议副本、契约测试和部署记录单独提交，部署镜像保留上一版本以便回滚。
