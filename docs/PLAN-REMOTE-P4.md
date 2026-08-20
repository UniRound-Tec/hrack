# P4 — HRack 远程驾驶

> 状态：**计划已批准，实施中（2026-08-20）**。对应 [SPEC-REMOTE.md](./SPEC-REMOTE.md) §6.3、§7.2、§9、§11 P4。
>
> 前置：P0–P3 已关门。P4 只实现桌面驾驶，不实现手机 App、catalog 或远程新建。

**人能验收什么：** 手机 WebSocket 夹具点进真实 HRack AI CLI 会话后，拿到已有 PTY 历史并把该 PTY 改成手机行列；手机输入和 PTY 输出双向真实流动。本机对应 tab 锁输入并显示“手机正在控制”，可点“抢回”；其它 tab 不受影响。返回、断线超时和会话退出都能释放驾驶。

---

## 1. 交付边界

### 做

- 处理 `drive`、`undrive`、`pty-resize`、`pty-in`、`pty-ack`。
- 发出 `drive-ok`、`drive-reject`、`pty-out`、`pty-exit`、`undriven`。
- `drive-ok.history` 来自主进程既有 `PtyHistory`，输出与 resize 顺序不另造。
- 同一时刻只允许一个被驾驶会话；未知、已退出或已有驾驶分别拒绝为 `not-found`、`exited`、`busy`。
- 被驾驶 PTY 的 winsize 只接受手机尺寸；renderer/window fit 在驾驶期间不得覆盖。
- 手机输入写入同一真实 PTY；本机 xterm 输入在驾驶期间被源头阻断。
- PTY 输出经独立 `PtyDataQueue` 和手机 `pty-ack` 做有界背压；底层 PTY pause/resume 使用多消费者租约，renderer 与手机不能互相误恢复。
- 本机 terminal overlay、抢回按钮，以及 sidebar/rail/tabs 驾驶标记。
- 手机 `undrive`、电脑抢回、手机离线 15 秒、PTY 退出、桌面连接结束时释放尺寸和输入锁。

### 不做

- 不实现 React Native/Flutter App 或手机 xterm；P4 手机仍是协议夹具。
- 不实现 `catalog`、`create`、`create-*`；这些属于 P5。
- 不远程驾驶普通 shell、DSH 或本机 OpenCode Bridge，只允许 `AgentSessionRuntime` 中仍存活的 AI CLI 会话。
- 不增加协议报文或私有兼容字段；继续使用已冻结的 v1。
- 不把 `ptyId`、`terminalId`、内部 flow-control snapshot 发到网络。
- 不为远程另建第二套 PTY、历史或启动链。

---

## 2. module、seam 与 interface

### 2.1 `RemoteDesktopClient` 继续是唯一远程桌面 module

外部 interface 仍保持小：连接、断开、吊销、读取连接/驾驶状态、电脑抢回。WSS 报文路由、当前驾驶、15 秒宽限、输出编码和清理顺序都留在实现内部。

新增 renderer 可见状态仅为：

```ts
type RemoteDriveState =
  | { phase: 'idle'; sessionId: null; terminalId: null; cols: null; rows: null }
  | { phase: 'driven'; sessionId: string; terminalId: string; cols: number; rows: number }
```

它只用于锁输入、显示 overlay/角标和同步本地 xterm 格子；不暴露 socket、ptyId 或历史。

### 2.2 `runtimeRemotePtyHost` 是主进程内部 adapter

adapter 在 `AgentSessionRuntime` 与 `PTYManager` 两个既有 module 之间解析 sessionId，向 `RemoteDesktopClient` 返回一次驾驶所需的窄 handle：

```ts
interface RemoteDrivenPty {
  readonly sessionId: string
  readonly terminalId: string
  readonly history: RemotePtyHistorySnapshot
  write(data: string): void
  resize(cols: number, rows: number): void
  acknowledge(bytes: number): void
  release(): void
}

interface RemotePtyHost {
  open(input, observer):
    | { ok: true; target: RemoteDrivenPty }
    | { ok: false; reason: 'not-found' | 'exited' | 'busy' }
}
```

订阅输出/退出、UTF-8 分块、历史裁剪和 `PtyDataQueue` 全在 adapter 内部。调用者只学会 `open` 和驾驶 handle，不拼接 ptyId。

### 2.3 `PTYManager` 仍是 node-pty 唯一持有者

P4 只给它增加主进程内部能力：按 ptyId 订阅原始输出、获取历史、远程尺寸占用/释放、以及按消费者 token 维护 pause 租约。现有 renderer IPC interface 不获得远程专用方法。

本地 `resize` 在存在远程尺寸占用时直接忽略；远程释放后，renderer 收到 `idle` 状态并执行一次当前容器 fit，重新取得 winsize。

---

## 3. 状态与竞态

### 3.1 驾驶状态

```text
idle --drive(valid)--> driven --undrive--------> idle (left)
                           |--local reclaim----> idle (reclaim)
                           |--phone absent 15s-> idle (phone-timeout)
                           |--PTY exit----------> idle (session-exit)
                           `--desktop teardown--> idle (desktop-offline)
```

- `drive-ok` 只有在 PTY 远程尺寸已占用、输出/退出订阅已建立且历史已取得后发送。
- `drive` 在已有驾驶时返回 `busy`，不隐式切换或释放旧会话。
- `undrive`、`pty-*` 的 sessionId 与当前驾驶不符时忽略，不允许操作另一条 PTY。
- 电脑抢回同步清除权威驾驶；随后到达的旧会话 `pty-*` 无效。
- 会话退出先发 `pty-exit`，再发 `undriven reason=session-exit` 并释放。

### 3.2 手机离线宽限

- `peer-leave phone` 时保持尺寸和锁定，启动 15 秒 timer。
- 同一房间手机在 timer 内重新 `peer-join` 时取消 timer，驾驶不变，避免网络抖动重排终端。
- timer 到期释放、恢复本机 fit；重连后的手机只收到列表 snapshot，不自动恢复驾驶。
- desktop socket 关闭/换房/吊销/应用退出不等待宽限，立即本地释放。

### 3.3 背压

- PTY 原始输出编码为 UTF-8 bytes，单个 `pty-out` 最多 256 KiB，再 base64 发送。
- 手机每解析一批后以 `pty-ack.bytes` 归还额度。
- 远程队列沿用 256 KiB high-water、64 KiB low-water、1 MiB hard cap。
- `PTYManager` 只有所有消费者 pause 租约都释放后才 resume node-pty，避免 renderer ack 提前解除手机背压。
- hard cap 触发时终止该桌面传输并释放驾驶，不能继续占内存或杀 HRack 主进程。

---

## 4. TDD 纵向切片

每次只加一个公开行为，再补最小实现：

1. **drive/reject/history：** 现有 `not-implemented` 用例先改为期待 `drive-ok`；补有效/unknown/exited/busy 和 history 转换。
2. **尺寸权威：** 驱驶一条 PTY 后本机 resize 不生效，另一条 PTY 正常；释放后本机 fit 可恢复。
3. **数据面：** 真实手机 `pty-in` 进入同一 PTY，真实 `pty-out` 回手机，`pty-ack` 驱动队列。
4. **本机 UX/抢回：** overlay 阻断 xterm 输入；sidebar/rail/tabs 有标记；抢回发 `undriven reclaim` 并 fit。
5. **生命周期：** `undrive`、手机短暂重连、15 秒超时、PTY exit、桌面断开。
6. **有界输出：** 不 ack 的输出达到水位会 pause；恶意 producer 越过 hard cap 时安全断开/释放，不产生无界数组。

测试只跨 WSS、remote/PTY host interface 和真实 renderer UI，不检查 `RemoteDesktopClient` 私有字段。

---

## 5. 测试矩阵

| 层级 | 必测行为 | 是否真实流量 |
|---|---|---:|
| `remote-desktop` 定向门禁 | drive/reject、history、ack、错误 sessionId、reclaim、timeout、exit、overflow | 真实 localhost WS；PTY adapter 可控 |
| `PTYManager` 定向门禁 | pause 租约、远程尺寸挡住本机 fit、释放 | node-pty seam / 既有 PTY 门禁 |
| Electron P4 live | 网页建房、真实 Agent Runtime/PTY、40×18、双向字节、本机锁、抢回、另一 PTY不变 | 真实独立 P2 + Electron + WS |
| 公网 P4 live | 同一 live gate 指向公网 HTTPS/WSS | 真实公网流量 |
| 现有回归 | protocol、remote settings/desktop、terminal resize/input | 定向 |

真实门禁继续用显式变量，不让默认回归创建公网房间：

```powershell
$env:HRACK_REMOTE_P4_URL = 'http://127.0.0.1:8788/remote/'
npx playwright test e2e/remote-p4-live.spec.ts

$env:HRACK_REMOTE_P4_URL = 'https://hrack.modplex.app/remote/'
npx playwright test e2e/remote-p4-live.spec.ts
```

所有网页房间都在 `finally` 吊销；测试不输出 roomId、加入 URL、PTY 输入正文或吊销 token。

---

## 6. 关门条件

- SPEC P4 六项验收全部有自动化证据。
- 至少一次独立本机 P2 + 真实 Electron/`AgentSessionRuntime`/PTY/WSS 驾驶通过。
- 至少一次公网 HTTPS/WSS 驾驶通过，真实发送合成测试字节并收到真实 PTY 输出。
- 驾驶期间本机输入和 fit 均不能写入被驾驶 PTY，电脑抢回后两者恢复。
- 手机离线 15 秒后真实释放；会话退出发 `pty-exit` 并释放。
- 不 ack 输出的内存有硬上限，相关 queue/PTY/WS 资源在所有退出路径清理。
- typecheck、build、定向相关回归通过；失败后遵守 `AGENTS.md`，不反复跑整套 E2E。
- 实现与真实验证记录写回本文件并提交。

P4 关门后进入 P5（HRack 远程新建）；React Native App 仍从 P6 开始。

---

## 7. 实现与验证记录

待执行后填写。未完成真实 PTY 双向字节和生命周期门禁前，不得把 P4 标为完成。
