# HRack 远程控制 — Spec

> 状态：**讨论结论（2026-08-20），未实施。** 落地按 [§11](#11-分批实施-p0p8) P0–P8 分模块关门，整份契约都有效，但未到期的报文必须 `not-implemented`，不得假装成功。
> 范围：一部手机远程看见、新建、驾驶 HRack 里已经在跑（或由手机新建）的 CLI 会话。
> 父文档：[SPEC.md](./SPEC.md)、[SPEC-S.md](./SPEC-S.md)。
> 本机 OpenCode Bridge 仍只活在本机，见 [SPEC-OPENCODE-BRIDGE.md](./SPEC-OPENCODE-BRIDGE.md)。远程不走那条套接字。

---

## 0. 一句话

人离开电脑时，用原生 App 扫码连上一个房间：看到 HRack 里所有已启动的 AI CLI 会话和六态，能按首页同样的信息新建 CLI，能点进某一条用 xterm 真操作。电脑上**只有被驾驶的那一个 tab** 锁输入并改成手机尺寸，其它 tab 照常。中继是可自建的网页项目，打开网址不等于能控机。

---

## 1. 目标与非目标

### 1.1 目标

- 电脑和手机用**同一条完整 URL** 配成 1:1:1 房间。
- App 打开后能看到全部已启动的 **AI CLI 会话**及其六态（`working` / `needs-you` / `done` / `error` / `idle` / `exited`）。
- 点进一条会话，在手机上真渲染该 PTY（xterm 复读 ANSI），能键入。
- 手机能新建 CLI：列出电脑上可启动的 CLI，工作区必填（最近列表或手打）。
- 网页生成房间时同时给出完整 URL 和二维码；HRack 对已填 URL 可再出示二维码。
- 服务器可自建。客户端不写死 `hrack.dev`。

### 1.2 非目标（本 spec 范围外）

- 账号体系、多电脑、多手机、围观座位。
- 端到端加密（见 §8：TLS 卸掉后中继能看见终端）。
- 后台/锁屏推送策略（在线能看到状态即可；响不响以后用设置调）。
- 把 DSH 官方网页表面送到手机。
- 把本机 OpenCode Bridge 暴露到公网。
- 为 Claude / Codex / OpenCode 等各自重做一套假 UI。
- 整窗远程桌面、文件传输、摄像头。
- 手机关掉会话、改设置、管主题。
- HRack 未运行时由 App 或中继自动拉起 GUI。
- 普通 shell tab：第一期不远程新建。列表与驾驶只针对 AI CLI 会话（agent tab）。

---

## 2. 角色

永远 **1 电脑 : 1 手机 : 1 房间**。没有第三者、没有围观、没有账号下的设备列表。

| 角色 | 仓库 | 职责 |
|---|---|---|
| 中继 | 独立项目 `hrack-remote-server` | 生成完整 URL + 二维码、吊销房间、按房间转发 WebSocket。不跑 xterm，不持久化 PTY 正文。 |
| 桌面 | 现有 `hrack` | 填完整 URL、复示二维码、出站连接。PTY、扫描、启动、投影仍是唯一真相源。被驾驶 tab 的遮罩与抢回。 |
| 手机 | 独立项目 `hrack-remote-app` | 扫码（读完整 URL）。会话列表、新建、xterm。 |

打开 `https://…/{room}` 只是配对页，不是控制台。真界面在原生 App。

---

## 3. 配对

### 3.1 URL 是唯一配置

房间的对外形态是一条 **HTTPS URL**，不是裸 key。客户端（HRack 与 App）都不写死官方域名。

约定：

- 加入 URL：`{origin}{base}/{roomId}`  
  例：`https://hrack.dev/aK3…`、`https://my.box:8443/remote/aK3…`
- `roomId` 为路径最后一段；其余为该部署的 `base`。
- WebSocket：同 host、同 `base`，路径 `{base}/v1/ws`，TLS 时用 `wss:`。
- `roomId`：128 bit，url-safe base64（无填充），不可猜测。
- 有效期：直到被吊销。第一期不做空闲 TTL。

二维码的内容就是这条加入 URL。

### 3.2 流程

1. 在官方或自建的中继网站生成房间 → 同一屏展示完整 URL 和二维码。
2. **电脑**：HRack 设置里粘贴完整 URL，出站连 WSS。设置页对已填 URL 再画一份码，供网页关掉后补扫。
3. **手机**：App 扫描二维码（网页上的或 HRack 里的），解析同一条 URL，出站连同一个源。
4. 两边 `hello` 占座。每个角色一个座位。座位空着（从未连过，或旧套接字已断）才能占；该角色座位上还有活连接 → `occupied`，**不踢**。掉线重连的前提是旧连接已经断。中继对套接字做心跳，死连接尽快腾座。
5. 吊销（网页或 HRack）：房间作废，两个座位都断开。

HRack 填入 URL 时必须确认：这会把终端字节送到该 URL 所在的服务器。

### 3.3 座位

| 事件 | 结果 |
|---|---|
| 电脑未连 | App 停在「等待电脑」。不能列表、不能新建、不能驾驶。 |
| 手机未连 | HRack 只显示「已填 URL，等待手机」。本地照常使用。 |
| 第三者（第二台电脑或第二部手机） | `occupied`。不排队。 |
| HRack 没开 / 没填 URL | App 进不去。任何一端都不得自动启动 GUI。 |

---

## 4. 生命周期

**连上 ≠ 驾驶。**

```text
生成 URL+码
  → 电脑填 URL，手机扫码
  → 两边 hello 占座
  → 电脑推：会话快照 + 可启动目录 + 最近工作区
  → App 列表显示全部 AI CLI 会话和六态（之后增量）
  → 点进会话 S 或新建成功
       → 申请驾驶 S
       → 只对 S 的 PTY 按手机 cols/rows SIGWINCH
       → 下发 PtyHistory 快照，随后转发字节与按键
       → S 所在 tab：遮罩「手机正在控制 · 抢回」，不接收电脑键入，窗口 resize 不 fit 这条 PTY
       → 其它 tab：电脑照常，尺寸与输入不受影响
  → 返回列表 / 电脑抢回 / 手机掉线超时 / 会话退出
       → 驾驶结束，S 按电脑当前窗口 fit，tab 解锁
```

规则：

- 同一时刻只驾驶一条会话。点另一条 = 先释放当前，再驾驶新的。
- 驾驶中电脑遮罩是 **tab 级**，不是整窗。侧栏可切走，其它会话可继续在电脑上用。
- 被驾驶 tab 在侧栏上有角标，即使当前没在看也能认出。
- 抢回与点进冲突时，**电脑说了算**。
- 新建成功后按手机尺寸 spawn，并直接进入驾驶，避免先大后小闪一屏。

同一条 PTY 可以同时画在电脑 xterm 和手机 xterm 上（字节流复制）。PTY 的 winsize 只有一套：驾驶期间以手机为准。

---

## 5. 传输

全部经中继 WebSocket 转发（方案 A）。控制面和数据面都走同一条连接，用 `type` 区分。

选择原因：最好写、最好查。代价：TLS 终止后中继能看见会话元数据和 PTY 正文。`{roomId}` / 加入 URL 按远程桌面密码对待。

以后若改为端到端，应把 `pty-out` / `pty-in` 换成密文 blob，控制面消息形状保持可加字段。本 spec 不要求第一期做。

两端都出站。家里电脑不必开入站端口。

---

## 6. 报文

协议版本 `v = 1`。文本帧，每条一个 JSON 对象。PTY 字节用 base64。后续可用二进制帧替换 `pty-out` / `pty-in` 的 payload，不改语义。

中继只按 `roomId` 把一端的消息交给另一端（`hello` / `revoke` / 占座错误除外）。不解析 PTY 字段，不写入日志。

### 6.1 连接与房间（对中继）

| type | 方向 | 字段 | 说明 |
|---|---|---|---|
| `hello` | 客户端 → 中继 | `v`, `role` (`desktop` \| `phone`), `roomId` | 占座 |
| `hello-ok` | 中继 → 客户端 | `peer: { desktop, phone }` | 当前座位 |
| `peer-join` / `peer-leave` | 中继 → 另一端 | `role` | |
| `occupied` | 中继 → 第三者 | | 该角色已有人 |
| `bad-key` | 中继 → 客户端 | | 房间不存在或已吊销 |
| `revoked` | 中继 → 两端 | | 立即断开 |

hello 限流，防止扫 `roomId`。

### 6.2 控制面（电脑 ↔ 手机，经中继）

会话列表用观察器投影的**远程安全子集**，不把 `correlation` 内部结构或本机可执行路径送出去。

**电脑 → 手机**

| type | 字段 | 何时 |
|---|---|---|
| `sessions-snapshot` | `sessions: RemoteSession[]` | 手机连上或电脑重连成功后一次 |
| `session-upsert` | `session: RemoteSession` | 投影变化 |
| `session-removed` | `sessionId` | tab/会话关掉 |
| `catalog` | `launchable: RemoteLaunchable[]`, `recentWorkspaces: string[]` | **P5 起**：手机加入时发；扫描/最近工作区变化时再发 |
| `drive-ok` | `sessionId`, `cols`, `rows`, `history` | 同意驾驶；`history` 为现有 `PtyHistorySnapshot` 的远程表示 |
| `drive-reject` | `reason` | `not-found` / `exited` / `busy` |
| `undriven` | `sessionId`, `reason` | `reclaim` / `left` / `phone-timeout` / `session-exit` / `desktop-offline` |
| `create-ok` | `sessionId` | 随后立刻按驾驶该 id 处理（再发 `drive-ok`） |
| `create-reject` | `reason`, `detail?` | 路径不存在、安装不可用等 |

`RemoteSession` 至少包含：`sessionId`, `name`, `adapterId`, `status`, `statusConfidence`, `detail?`, `pendingAttentionCount`, `activeToolCount`, `lastActivityAt`。不要 `correlation`，不要本机绝对路径以外的敏感字段；`workspace` 可以给（用户本来就要在手机上填路径）。

`RemoteLaunchable` 来自现有 `LaunchableCli`，但：

- 保留 `definition.{id,adapterId,displayName,iconId}` 和「是否提供免审批」以及免审批的 **label**。
- 每条 installation 只发 `id`、`runtime`（host 平台或 WSL distro 名）、`version?`。
- **不发** `resolvedExecutable`。

**手机 → 电脑**

| type | 字段 | 何时 |
|---|---|---|
| `drive` | `sessionId`, `cols`, `rows` | 点进一条已有会话 |
| `undrive` | `sessionId` | 返回列表 |
| `create` | `installationId`, `workspace`, `skipApproval?`, `args?` | 对齐首页；`workspace` 必填非空 |
| `pty-resize` | `sessionId`, `cols`, `rows` | 驾驶中旋转/键盘改变可视行列 |

`create.workspace` 必须是电脑能理解的路径。手打错误 → `create-reject`，不在手机上 CreateProcess，也不把 POSIX 路径交给 Windows `CreateProcess`。WSL 安装仍由电脑按 `installationId` 的 `runtime` 启动。

### 6.3 数据面（仅驾驶中）

| type | 方向 | 字段 |
|---|---|---|
| `pty-out` | 电脑 → 手机 | `sessionId`, `data`（base64）, `byteLength` |
| `pty-in` | 手机 → 电脑 | `sessionId`, `data`（UTF-8 文本或 base64 二进制；实现选一种并在该端点固定） |
| `pty-ack` | 手机 → 电脑 | `sessionId`, `bytes` |
| `pty-exit` | 电脑 → 手机 | `sessionId`, `code?`, `signal?` |

背压：复用主进程 `PtyDataQueue`。手机 ack 之前电脑不得无界堆积到中继。中继对单房间缓冲有上限，超出则断开该房间（优于撑爆内存）。

历史：`drive-ok.history` 复用现有 PTY 历史上限；`complete: false` 表示已截断。手机 xterm 先 replay 再接 `pty-out`。

驾驶中电脑 **不得** 因窗口 fit 对这条 PTY 发 resize。手机的 `pty-resize` 才是这条 PTY 的 winsize 来源。释放后由电脑按当前窗口 fit 一次。

### 6.4 报文按阶段生效

| 阶段 | 允许发出或必须正确处理的 type |
|---|---|
| P0 | 全部 type 的 TypeScript 形状与 URL 解析；还没有真实连接 |
| P1 | `hello` / `hello-ok` / `peer-join` / `peer-leave` / `occupied` / `bad-key` / `revoked`；电脑 → `sessions-snapshot` / `session-upsert` / `session-removed` |
| P2 | 中继转发任意 JSON；占座与吊销。不理解控制面语义 |
| P4 | `drive` / `drive-ok` / `drive-reject` / `undrive` / `undriven` / `pty-*` |
| P5 | `catalog` / `create` / `create-ok` / `create-reject` |

未到期：收到后回 `{ type: 'not-implemented', for: '<type>' }`（控制面）或忽略（中继不当业务端）。不得半套成功。

本地测试允许 `http://` / `ws://`。产品默认仍是 `https://` / `wss://`。加入 URL 的 scheme 决定 WebSocket scheme。

---

## 7. 三端界面

### 7.1 中继网站

- 生成房间：完整 URL + 二维码 + 复制。
- 吊销。
- 不是会话列表，不是终端。

### 7.2 HRack

- 设置：一个 URL 输入框、连接/断开、吊销、已填 URL 的二维码。
- 被驾驶 tab：终端上遮罩「手机正在控制 · 抢回」；该 tab 不接收本机键入。
- 侧栏角标标出被驾驶项。
- 本地首页、扫描、启动路径不变。手机 `create` 走同一条 `prepareLaunch` → spawn → agent start，不得另写一套启动。

### 7.3 App

- 扫码进入房间（可提供「等待电脑」空态）。
- 列表：所有 AI CLI 会话 + 六态。
- 新建：列 CLI（含多 installation / WSL），工作区必填（最近或手打）；桌面该 CLI 有免审批则同样给出开关。
- 终端：xterm 画与电脑同一套格子；附加键至少 Esc / Ctrl / Tab / 方向。中文组字不得把拼音逐键送进 PTY。
- 返回列表 = `undrive`。

后台推送：本 spec 不规定。在线时列表和六态必须是活的。

---

## 8. 安全

本方案第一期是 **TLS + 房间秘密**，不是端到端。

必须：

- 全程 HTTPS / WSS。
- `roomId` 不可猜测；hello 限流。
- 中继默认日志不含 PTY 正文、`pty-in`、工作区以外的密钥。
- 中继不落盘终端历史。
- HRack 连接前明确确认目标源。
- 吊销立即生效。
- 远程 catalog 不含本机可执行文件路径。

接受的风险：

- 谁持有加入 URL，谁就能在房间空位上占座（1:1:1 下第二部设备会被 `occupied`，但电脑断开后手机侧 URL 仍能在电脑重新填入后控机）。
- 中继进程能看见终端内容。自建时用户信任自己的服务器；用官方 `hrack.dev` 时用户信任运营方。

---

## 9. 失败

| 情况 | 行为 |
|---|---|
| 电脑没连 | App 等待。不自动开 HRack。 |
| 手机没连 | 电脑本地正常。 |
| 驾驶中手机掉线 | **15 秒**内重连则保持驾驶；超时则电脑释放该 tab（解锁 + 按窗口 fit）。避免会话永远停在 40×18。 |
| 驾驶中电脑掉线 | App 冻结并标断开，退出驾驶画面。重连后重新快照，**不**自动恢复驾驶。 |
| 驾驶中会话退出 | `pty-exit` → 驾驶结束，列表该项 `exited`。 |
| 抢回 vs 点进 | 电脑赢。 |
| 中继重启 | 房间是内存态；两边重连、重新 `hello`。 |
| 历史过大 | 截断 + `complete: false`。 |
| 输出暴量 | `PtyDataQueue` + 中继有界缓冲；越界断开房间。 |
| `create` 路径非法 | `create-reject`，电脑不 spawn。 |

---

## 10. 与现有能力的关系

| 现有 | 远程怎么用 |
|---|---|
| `AgentSessionProjection` / 六态 | 控制面列表的来源 |
| `PTYManager` + `PtyHistory` + `PtyDataQueue` | 数据面唯一来源；多一个订阅者（中继）不得打穿背压 |
| `CliScanReport` / `CliLaunchSelection` / `prepareLaunch` | 手机新建的目录与启动 |
| 最近工作区 | 推到 App，供点选 |
| 本机 OpenCode Bridge | **不动**。远程不是 Bridge 的公网版 |
| DSH `WebContentsView` | **不进**本远程 |
| 悬浮窗 attention | 与六态同源；本 spec 不规定推送，但 `needs-you` / `done` / `error` 已在列表里 |

观察器事件很多。列表展示完整六态；不要把每条 `tool.started` 做成独立远程通知。

---

## 11. 分批实施（P0–P8）

三个仓库，发布周期分开：`hrack`、`hrack-remote-server`、`hrack-remote-app`。App 与中继的语言/框架本 spec 不锁。

**纪律**

- 一期一个模块，过验收再开下一期。不要在 P1 里顺手做驾驶。
- 每期必须有**自动验收**（单测或定向 e2e）。完整 `npm run e2e` 不是每期门禁（见 `AGENTS.md`）。
- 对端用**测试替身**即可关门：P1/P4/P5 用进程内或 localhost WSS 冒充手机/中继；P2 用两个夹具客户端，不必等真 App。
- 未到期报文 `not-implemented`。不自动拉起 HRack GUI。
- 协议权威类型先落在 `hrack/shared/remote-protocol.ts`。中继与 App 同期复制，抽出独立包不是开门条件。

```text
P0 协议
 └─ P1 HRack 出站：控制面推送（测试中继验收，不依赖网站）
      ├─ P4 HRack 驾驶（继续用测试中继即可关门）
      │    └─ P5 HRack 新建
      └─ P2 中继网站：生成 URL/码 + 占座转发
           └─ P3 列表通路：HRack + 真中继 + 夹具手机
                └─ P6 App 扫码 + 列表
                     ├─ P7 App 新建  ← 还依赖 P5
                     └─ P8 App 终端  ← 还依赖 P4
```

默认顺序：**P0 → P1 → P2 → P3**，与「先协议、再桌面出站、再网页」一致。P2 技术上只依赖 P0，可以和 P1 并行，但验收排在 P1 之后，避免中继和桌面客户端同时调试协议分歧。

P4 不需要网站：夹具直接连 P1 的测试中继。P6 必须等 P3。P7 等 P5+P6。P8 等 P4+P6。

### 总表

| 期 | 模块 | 仓库 | 这一期结束时人能验收什么 |
|---|---|---|---|
| **P0** | 协议 | `hrack` | 报文、URL、座位规则有类型和单测，还没有窗口、没有网站 |
| **P1** | 桌面出站 · 控制面 | `hrack` | 设置里填 URL，连上测试中继，会话列表和六态会推出去 |
| **P2** | 中继网站 | `hrack-remote-server` | 浏览器生成 URL+二维码；两个夹具客户端能占座、转发、occupied、吊销 |
| **P3** | 列表打通 | `hrack` + server | 网页生成 → HRack 填 URL → 夹具手机经真中继收到真实会话快照 |
| **P4** | 桌面驾驶 | `hrack` | 夹具发 `drive`，该 tab 锁住并改尺寸，抢回/掉线按 §9 释放，有 PTY 进出 |
| **P5** | 桌面新建 | `hrack` | 夹具发 `create`，电脑按首页同一条链拉起 AI CLI 并自动驾驶 |
| **P6** | App 列表 | `hrack-remote-app` | 扫码进入，看到真实会话和六态；电脑未连时等待，不拉起 GUI |
| **P7** | App 新建 | app | 选 CLI、必填工作区、免审批开关，能在电脑上拉起并进入驾驶 |
| **P8** | App 终端 | app | 手机 xterm 复读被驾驶 PTY，能键入；返回列表 = undrive |

系统推送、E2E 加密、多设备不在 P0–P8。

---

### P0 — 协议冻结

**做**

- `shared/remote-protocol.ts`：§6 全部 type、`RemoteSession`、`RemoteLaunchable`、`not-implemented`。
- 加入 URL 解析：`{origin, base, roomId, wsUrl}`；`http`↔`ws`、`https`↔`wss`；`base` 含子路径。
- 房间座位状态机（纯函数）：空座占上、活连接 `occupied`、死连接腾座、吊销。
- 若干黄金 JSON 夹具（hello、snapshot、drive-ok）。

**不做：** 网络、设置 UI、网站、App。

**验收**

- 单测：解析 `https://hrack.dev/aK3`、`https://my.box:8443/remote/aK3`、`http://127.0.0.1:9/aK3`。
- 单测：第二台 desktop `occupied`；吊销后 `bad-key`。
- 夹具 JSON 能通过类型守卫。非法 `v` 拒绝。

---

### P1 — HRack 出站 · 控制面推送

依赖 P0。对端是 **测试中继**（e2e/单测里起的 localhost WSS），不是 P2 网站。

**做**

- 设置：完整 URL 输入、连接前确认（终端会送到该源）、连接/断开、连接状态（未填 / 连接中 / 已出站等待手机 / 对端已占座 / 失败原因）、已填 URL 的二维码。
- 出站 `hello` `role=desktop`。不自动启动第二份 GUI。
- 手机 `peer-join` 或重连成功后发一次 `sessions-snapshot`；之后投影变化 `session-upsert` / `session-removed`。只含 AI CLI 会话，字段按 §6.2 裁剪。
- 收到 `drive` / `create` / `pty-in` → `not-implemented`。

**不做：** 真中继仓库、驾驶、catalog、新建、App。

**验收（定向，必须自动）**

1. 填 `ws://127.0.0.1:<test>/<room>`，确认后出站；测试中继收到 `hello` desktop。
2. 有两条 AI CLI 时，夹具手机连上后收到 `sessions-snapshot`，`sessionId` / `status` 与桌面投影一致。
3. 夹具连上后把一条会话打成 `needs-you`（或等价夹具），中继侧收到 `session-upsert`。
4. 关掉该会话 → `session-removed`。
5. 未开 HRack 时测试中继不会被「自动拉起 GUI」。本条是负面：本功能不得 spawn 新的官方/开发实例。
6. 第二桌面连同一 room → `occupied`，第一桌面不断。

---

### P2 — 中继网站（前后端）

依赖 P0。不依赖 HRack 窗口。新建 `hrack-remote-server`。

**做**

- 生成页：完整加入 URL、二维码（内容=URL）、复制、吊销。
- 内存房间；`{base}/v1/ws`；心跳腾座；hello 限流。
- 按 room 转发 JSON。不解析 `pty-*` 正文，日志不记 PTY / `pty-in`。
- 1:1:1 占座、`hello-ok.peer`、`peer-join` / `peer-leave`、`occupied`、`bad-key`、`revoked`。
- 单房间缓冲上限，超出断开该房间。

**不做：** 会话列表 UI、xterm、账号、持久化终端、HRack 设置。

**验收**

1. 打开生成页，URL 最后一段是 128-bit url-safe；码解码等于该 URL。
2. 夹具 desktop + phone 先后 `hello`，双方收到 `hello-ok` 与 `peer-join`。
3. desktop 发任意 JSON，phone 原样收到（证明中继不改业务帧）。
4. 第二个 desktop `occupied`；吊销后两端 `revoked`，再 hello 为 `bad-key`。
5. 进程重启后房间空，旧 roomId `bad-key`。

---

### P3 — 列表通路打通

依赖 P1 + P2。第一次把真 HRack 和真中继接在一起。夹具仍可冒充手机。

**做**

- HRack 对 P2 的真实 URL 出站（含 https 自建与 http 本地）。
- 必要时修 URL/`base` 与 cookie/跨域等部署问题。不新加业务报文。

**验收**

1. 本地起 P2 → 生成 URL → HRack 粘贴确认 → 夹具手机扫不了码也可以手动用同一 URL 连 WSS。
2. 夹具收到的 snapshot 来自**真实** HRack 会话，不是 P1 测试中继灌的假数据。
3. HRack 设置里的二维码解码等于所填 URL。

P3 关门 = 「电脑把列表送到公网房间」成立。此后 App 和驾驶可以并行。

---

### P4 — HRack 驾驶

依赖 P1（连接）。验收可用测试中继或 P2。

**做**

- 处理 `drive` / `undrive` / `pty-resize`；回复 `drive-ok`（含 history）或 `drive-reject`。
- 只 SIGWINCH 被驾驶的那条 PTY；该 tab 遮罩「手机正在控制 · 抢回」；侧栏角标；其它 tab 不锁。
- 窗口 resize 不 fit 被驾驶 PTY。
- `pty-out` / `pty-in` / `pty-ack` / `pty-exit`；接入 `PtyDataQueue` 与 `PtyHistory`。
- 抢回、返回、15s 手机掉线、会话退出 → §9。抢回优先。

**不做：** App xterm、新建、catalog。

**验收**

1. 夹具 `drive` 已知 `sessionId` + 40×18 → 该 PTY 变为 40×18，其它 PTY 行列不变。
2. 被驾驶 tab 本机键入进不了 PTY；点抢回后恢复窗口 fit，夹具收到 `undriven reason=reclaim`。
3. `drive-ok.history` 非空（该会话已有输出时）；随后夹具写入 `pty-in`，桌面 PTY 收到相同字节。
4. 夹具断 15s+ → 自动释放。
5. 对非 AI CLI / 未知 id → `drive-reject`。
6. 暴量输出时队列有界，HRack 不炸进程。

---

### P5 — HRack 新建

依赖 P4（建成后要直接驾驶）。

**做**

- 推 `catalog`（`RemoteLaunchable` + `recentWorkspaces`，无 `resolvedExecutable`）。
- 处理 `create`：走现有 `prepareLaunch` → spawn → agent start，`workspace` 必填。
- 成功：`create-ok` + 按请求尺寸 spawn + `drive-ok`。失败：`create-reject`，不 spawn。
- WSL 只按 `installationId` 的 runtime 在电脑上启动。

**验收**

1. 夹具收到的 catalog 与首页可启动列表一致，且无本机 exe 路径。
2. 合法 `installationId` + 存在的工作区 → 电脑出现新 AI CLI tab，并进入驾驶。
3. 空工作区或不存在路径 → `create-reject`，不新开 tab。
4. 免审批开关与首页同一套 `skipApproval` 注入。

---

### P6 — App 扫码 + 列表

依赖 P3。

**做**

- 扫码（完整 URL）；等待电脑空态；列表绑 `sessions-*`。
- 电脑未连不得假装有会话。不自动拉起 GUI。

**不做：** 新建表单、xterm、系统推送。点进会话若 P4 已上可显示「即将支持」或进入 P8；P6 关门不要求终端。

**验收**

1. 扫网页或 HRack 上的码，进同一房间。
2. 电脑已连：列表与桌面 AI CLI 一致，六态会变。
3. 电脑未连：等待态。第二部手机 `occupied`。

---

### P7 — App 新建

依赖 P5 + P6。

**做：** 与首页同构的新建：CLI 列表、installation/WSL、工作区必填（最近+手打）、免审批。提交 `create`，成功则进入驾驶（若 P8 未到，至少电脑侧 tab 已出现）。

**验收：** 手机填最近工作区能在电脑拉起对应 CLI；手打错误路径看到失败，电脑不多 tab。

---

### P8 — App 终端

依赖 P4 + P6。

**做：** xterm 复读 history + `pty-out`；附加键 Esc/Ctrl/Tab/方向；IME 组字后再 `pty-in`；返回列表 `undrive`。

**验收**

1. 点进已有会话，手机看到与电脑被驾驶 tab 同一套格子（可缩放显示，不改第二套 winsize）。
2. 手机键入出现在电脑 PTY；返回列表后电脑 tab 解锁并 fit。
3. 中文输入不把拼音逐键送进 PTY。

---

### 每期完成后再做的事

P8 之后才考虑：后台推送、E2E 加密、普通 shell 驾驶、抽出共享协议包。不插入 P0–P8 中间。

---

## 12. 关键决定

1. **中继转发一切（WSS）**，不在第一期做 WebRTC / 端到端。换数据面时控制面形状保持可扩展。  
2. **1:1:1**，永远没有围观和多机。  
3. **加入 URL 是唯一配置**，可自建；网页出码，电脑填完整 URL 并可复示码，手机只扫码。  
4. **连上只同步列表；点进或新建成功才驾驶。**  
5. **同一 PTY 两份 xterm、一套 winsize**；驾驶时 winsize 归手机。  
6. **只锁被驾驶的 tab**，其它 tab 电脑还能用；不是整窗 ToDesk。  
7. **手机可新建 AI CLI**，工作区必填，走电脑现有启动链。  
8. **不自动启动 HRack。**  
9. **本机 Bridge 与 DSH 不进远程。**  
10. **后台推送策略后置**；在线必须能看到全部 AI CLI 会话状态。

---

## 13. 实现时再选、不影响本结论的项

- App：Flutter / RN / 双原生。  
- 中继：Node / Go / 其它，只要能 HTTPS + WSS + 内存房间。  
- `pty-in` 用 UTF-8 还是 base64。  
- 官方部署是否提供 TURN：方案 A 不需要。  
- 房间空闲 TTL、更短/更长的 15 秒掉线宽限。  
- 普通 shell tab 是否允许驾驶。  
