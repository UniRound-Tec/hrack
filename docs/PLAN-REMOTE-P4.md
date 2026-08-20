# P4 — HRack 远程驾驶

> 状态：**已实现并经本机/公网真实接口验收（2026-08-20）**。对应 [SPEC-REMOTE.md](./SPEC-REMOTE.md) §6.3、§7.2、§9、§11 P4。
>
> 前置：P0–P4 已关门，下一阶段为 P5。P4 只实现桌面驾驶，不实现手机 App、catalog 或远程新建。

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

$env:HRACK_REMOTE_P4_URL = 'https://hrack.modplex.app/'
npx playwright test e2e/remote-p4-live.spec.ts
```

P4 关门后另补了一个同协议的浏览器演示控制器。它不扩大 P4 协议，也不提前实现 P5：

```powershell
$env:HRACK_REMOTE_DEMO_URL = 'http://127.0.0.1:8788/remote/'
npx playwright test e2e/remote-browser-demo-live.spec.ts
```

该门禁不使用 Node 手机夹具；它在真实 Chromium 中打开中继的 `/demo/` 页面，选择会话、通过 xterm 输入并检查真实 Electron PTY 输出，再从页面释放控制权。

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

2026-08-20 已完成 P4 并关门。实现保持计划中的模块边界：`RemoteDesktopClient` 持有驾驶状态机，`runtimeRemotePtyHost` 只把 `AgentSessionRuntime` 的 session 映射到 `PTYManager` 的真实 PTY；renderer 只消费收窄后的 `RemoteDriveState`，没有读取主进程私有状态。

实现结果：

- `drive` 对真实、未知、已退出和并发会话分别产生 `drive-ok`、`not-found`、`exited`、`busy`；`requestId` 原样返回。
- 远程尺寸所有权落在 `PTYManager`。被驾驶 PTY 忽略本机 fit，手机 `pty-resize` 是唯一 winsize 来源；其它 PTY 不受影响，释放后 renderer 立即按当前窗口重新 fit。
- `pty-in` 写入同一个 node-pty，原始输出经独立 `PtyDataQueue` 变成 base64 `pty-out`，手机 `pty-ack` 归还额度。renderer 与手机的 pause 使用独立租约，只有最后一个租约释放才 resume。
- 远程队列沿用 256 KiB/64 KiB/1 MiB 水位；release/dispose 会清空在途与排队字节。单块不超过 256 KiB。
- `drive-ok.history` 取主进程权威历史的最新完整事件，并按实际 JSON UTF-8 大小保证整帧不超过 1 MiB；远程额外截断会正确累计 dropped 字段。由此修正了“本机历史可到 16 MiB、协议单帧只有 1 MiB”的原计划歧义。
- 被驾驶 tab 有全屏输入遮罩和「抢回」，sidebar/rail/tabs 均显示手机角标。本机 xterm 输入、图片粘贴和 resize 在源头阻断，主进程尺寸所有权再做第二道保护。
- 手机 `undrive`、桌面抢回、短线重连、15 秒离线、PTY 退出、桌面 WSS 意外断开和主动断开均释放输出/退出订阅、队列、pause 租约、尺寸所有权和 UI 锁。PTY 退出严格先发 `pty-exit`，再发 `undriven reason=session-exit`。

TDD 记录没有跳过失败：最初 `drive` 仍回 `not-implemented`；真实 PTY 用例随后分别因缺少数据面、缺少 UI 遮罩/抢回、缺少 WebSocket 意外断开释放，以及长 history 超出 1 MiB 后被中继丢弃而失败。每项只补对应 seam 后定向转绿。

真实接口证据：

- `e2e/remote-driving.spec.ts` 使用真实构建后的 Electron、正常 UI 创建的两个 Agent session、`AgentSessionRuntime`、两个真实 `cmd.exe` PTY 和 localhost WebSocket 中继。门禁确认 40×18/52×20 只作用于目标 PTY、history 非空、手机合成输入进入真实 PTY、真实输出回手机、本机输入被挡、抢回后 fit 与本机输入恢复、真实 `exit` 的 `pty-exit → undriven` 顺序；目标用例通过（约 6.6s）。
- 同文件的独立生命周期门禁关闭手机真实 WebSocket，1 秒时仍保持驾驶，完整 15 秒宽限后自动释放真实 PTY；目标用例通过（约 16.7s）。
- 独立本机生产 P2：`http://127.0.0.1:8788/remote/`。`e2e/remote-p4-live.spec.ts` 通过网页真实建房、Electron 真实 Agent/PTY、手机 WS 驾驶、双向合成字节、桌面抢回和网页吊销，`1 passed`（测试体约 3.1s）。
- 公网生产 P2：`https://hrack.modplex.app/`。同一 live gate 真实经过公网 CA、HTTPS、反向代理和 WSS，`1 passed`（测试体约 5.6s）。没有打印或提交 roomId、加入 URL、PTY 正文或吊销 token；房间由成功路径或 `finally` 吊销。
- 后续浏览器演示控制器本机门禁：真实 Chromium 打开中继生成的 `/demo/{roomId}`，与真实 Electron HRack/`AgentSessionRuntime`/`cmd.exe` PTY 配对。浏览器 xterm 输入的合成标记同时出现在主进程 PTY 权威历史和浏览器终端，桌面远控锁可见，页面返回会话列表后锁解除；`1 passed`（测试体约 2.1s）。
- 同一浏览器演示门禁随后指向 `https://hrack.modplex.app/`：真实 Chromium → 公网 CA/HTTPS/WSS/反向代理 → HRack Electron → 真实 `cmd.exe` PTY 的全链路通过；输入、输出、桌面锁与页面释放均成立，房间最终吊销，`1 passed`（测试体约 6.5s）。
- 浏览器演示的后续渲染修正复用了桌面端的固定 xterm 版本、Maple Mono、HRack Dark palette 与 WebGL→DOM fallback；真实 Electron PTY 门禁改为 renderer 无关的“PTY 权威历史含标记 + 浏览器完成解析字节”断言后再次通过（约 5.3s）。
- 修正版部署后，同一 renderer 无关门禁再次通过公网 HTTPS/WSS（测试体约 7.1s）；原问题 Chrome 标签刷新后确认 Maple Mono 已就绪、WebGL 已激活、HRack Dark 背景生效。

最终门禁：

- `npm run typecheck`：通过。
- `npm run build`：通过，包含 DSH surface 与字体体积门禁。
- 相关定向回归：protocol、queue、pause lease、desktop state machine、remote settings、真实 Electron driving 共 `47 passed`（约 36.9s）。
- 另行执行本机和公网 live gate，各 `1 passed`。遵循 `AGENTS.md`，没有用反复运行完整 `npm run e2e` 代替失败定位。

结论：SPEC P4 六项验收与补充的整帧历史边界均有自动化和真实接口证据，P4 可以进入 P5（HRack 远程新建）；React Native App 仍从 P6 开始。
