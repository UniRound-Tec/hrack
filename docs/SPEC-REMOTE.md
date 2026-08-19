# HRack 远程控制 — Spec

> 状态：**讨论结论（2026-08-20），未实施。**
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
| `catalog` | `launchable: RemoteLaunchable[]`, `recentWorkspaces: string[]` | 快照同时发；扫描变化时再发 |
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

## 11. 仓库与落地顺序

三个仓库，发布周期分开：

1. `hrack-remote-server` — 配对页 + 房间 + WSS 转发  
2. `hrack` — 设置里的 URL、占座、快照/catalog、驾驶与 tab 锁、`create`  
3. `hrack-remote-app` — 扫码、列表、新建、xterm  

建议切片（仍不在本文件实施）：

1. 配对：生成 URL+码、两边占座、`occupied`、吊销。  
2. 控制面：快照 + 六态增量，App 只读列表。  
3. 新建：catalog + 最近工作区 + `create`。  
4. 驾驶：历史 + PTY + tab 锁 + 抢回 + 15s 掉线释放。  

App 与中继的语言/框架本 spec 不锁。

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
