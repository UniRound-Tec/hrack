# P0 — 远程协议冻结

> 状态：**已完成（2026-08-20）**。对应 [SPEC-REMOTE.md](./SPEC-REMOTE.md) §6、§11 P0。仓库：现有 `hrack`。当前分支：`remote`。
>
> 实现：`shared/remote-protocol.ts`。验收：`npx playwright test e2e/remote-protocol.spec.ts`（15 passed）。

**人能验收什么：** 报文、加入 URL、座位规则有 TypeScript 形状和自动测试；没有窗口、没有网站、没有 WebSocket。

---

## 1. 交付边界

### 做

一个可复制的协议模块，外加定向自动验收：

- `shared/remote-protocol.ts`：§6 全部 `type`、`RemoteSession`、`RemoteLaunchable`、`not-implemented`、加入 URL 解析、座位纯函数。
- 黄金 JSON 夹具：`hello`、`sessions-snapshot`、`drive-ok`。
- `e2e/remote-protocol.spec.ts`：不启动 Electron，只测该模块（同 `e2e/pty-data-queue.spec.ts` / `e2e/agent-session.spec.ts` 里的纯函数块）。

### 不做

网络、设置 UI、二维码、中继仓库、App、投影裁剪、PTY 订阅、`prepareLaunch`、IPC、依赖新增（不引入 vitest / zod）。

P1 才把 `AgentSessionProjection` 映射成 `RemoteSession`。本模块不 import `electron/`，也不 import `shared/ipc-contract.ts`（方便日后整文件复制到 `hrack-remote-server` / `hrack-remote-app`）。

### 完成标志

```powershell
npx playwright test e2e/remote-protocol.spec.ts
npm run typecheck
```

SPEC 三条验收都绿：三个 URL 解析样例、第二 desktop `occupied`、吊销后 `bad-key`、夹具过守卫、非法 `v` 拒绝。

---

## 2. 模块形状

一个文件，一个外部 seam。调用方和测试走同一组函数，内部校验函数不导出。

```
parseJoinUrl(input) → JoinUrl | JoinUrlError
parseRemoteMessage(raw) → RemoteMessage | ParseError
openRoom / hello / disconnect / revoke   // 纯函数，返回新表 + 应答
REMOTE_PROTOCOL_VERSION = 1
types…
```

删除测试：如果拿掉这个模块，URL 规则、报文守卫、1:1:1 占座会散落到 P1 客户端和 P2 中继各写一份。它不是 pass-through。

不另建 `shared/remote-join-url.ts` / `remote-seats.ts`。SPEC 写明权威类型落在 `shared/remote-protocol.ts`，中继与 App 同期复制这一份。

---

## 3. 关键决定

1. **单文件、自包含。** 远程 `CliRuntime` / 历史快照在本文件重声明为 `RemoteRuntime` / `RemotePtyHistorySnapshot`，结构与 `ipc-contract` 对齐，但不 import。P1/P4 做结构兼容映射。
2. **手写守卫，不引入 zod。** 仓库主包没有 schema 库；`shared/theme-schema.ts` 已是 `isRecord` + 字段检查风格。未知字段忽略（可加字段），缺必填或 `v !== 1` 拒绝。
3. **测试跟现有门禁。** 纯逻辑已用 Playwright 直接 import 源文件。P0 不新开测试框架。定向复跑：`npx playwright test e2e/remote-protocol.spec.ts`。
4. **`pty-in.data` 冻结为 UTF-8 文本。** `pty-out.data` 按 SPEC 用 base64。手机 IME 与 xterm `onData` 都是字符串；二进制帧是后续版本的事。两端不得混用。
5. **解析层接受短 `roomId`。** SPEC 验收 URL 是 `…/aK3`。128-bit 生成与长度校验留给 P2。解析只要求最后一段非空。
6. **补上表中缺的 `revoke`。** §6 正文把 `revoke` 与 `hello` 并列排除在转发之外，表 6.1 只列了 `revoked`。P0 类型包含客户端 → 中继 `{ v, type: 'revoke', roomId }`。P2 网站 HTTP 吊销仍可另做，但 HRack 设置吊销需要这条 WS 形状。
7. **房间表是纯数据。** 连接用测试传入的 `connectionId`（不上线）。心跳/限流是 P2；P0 只提供 `disconnect(connectionId)` 作为「死连接腾座」的入口。

---

## 4. 类型（`shared/remote-protocol.ts`）

`v` 一律字面量 `1`。每条报文是一个 JSON 对象，文本帧。

### 4.1 远程安全子集

`RemoteSession`（相对 `AgentSessionProjection` **只保留这些**）：

| 字段 | 来源 | 说明 |
|---|---|---|
| `sessionId` | 投影 | |
| `name` | 投影 `name` | 字符串；P1 缺省时再填显示名 |
| `adapterId` | 投影 | |
| `status` | 六态 | `working` / `needs-you` / `done` / `error` / `idle` / `exited` |
| `statusConfidence` | 投影 | `high` / `low` |
| `detail?` | 投影 | |
| `pendingAttentionCount` | 投影 | |
| `activeToolCount` | 投影 | |
| `lastActivityAt` | 投影 | |
| `workspace?` | **不在投影里** | SPEC 允许给；P1 从 Runtime 会话取。P0 只定可选字符串 |

**禁止出现在类型上：** `correlation`、`resolvedExecutable`、`adapterSessionId`、`terminalId`、`installationId`、`observerHealth`、`usage`、`capabilities`、`lastSeq`、`activeTurnId`。

`RemoteLaunchable`：

```ts
definition: { id, adapterId, displayName, iconId }
skipApproval?: { label: string }   // 有则表示提供免审批；不发 args
installations: Array<{
  id: string
  runtime: RemoteRuntime            // host 平台或 WSL distro 名
  version?: string
}>
```

不发 `hint`、`resolvedExecutable`、`detectedVia`、`verification`、`skipApproval.args`。

`RemotePtyHistorySnapshot` 与现有快照同构：`complete`、`retainedOutputBytes`、`droppedOutputBytes`、`droppedEvents`、`events`（`output` 的 `data` 为字符串，`resize` 带 `cols`/`rows`）。这是 `drive-ok.history` 的形状。

### 4.2 报文联合

**对中继**

| type | 方向 | 必填 |
|---|---|---|
| `hello` | 客户端 → 中继 | `role: 'desktop' \| 'phone'`, `roomId` |
| `hello-ok` | 中继 → 客户端 | `peer: { desktop: boolean, phone: boolean }`（应答时的占座） |
| `peer-join` / `peer-leave` | 中继 → 对端 | `role` |
| `occupied` | 中继 → 第三者 | 无额外字段 |
| `bad-key` | 中继 → 客户端 | 无额外字段 |
| `revoke` | 客户端 → 中继 | `roomId` |
| `revoked` | 中继 → 两端 | 无额外字段 |

**电脑 → 手机**

| type | 必填 |
|---|---|
| `sessions-snapshot` | `sessions: RemoteSession[]` |
| `session-upsert` | `session: RemoteSession` |
| `session-removed` | `sessionId` |
| `catalog` | `launchable: RemoteLaunchable[]`, `recentWorkspaces: string[]` |
| `drive-ok` | `sessionId`, `cols`, `rows`, `history: RemotePtyHistorySnapshot` |
| `drive-reject` | `reason: 'not-found' \| 'exited' \| 'busy'` |
| `undriven` | `sessionId`, `reason: 'reclaim' \| 'left' \| 'phone-timeout' \| 'session-exit' \| 'desktop-offline'` |
| `create-ok` | `sessionId` |
| `create-reject` | `reason: string`, `detail?: string` |
| `not-implemented` | `for: string` |

**手机 → 电脑**

| type | 必填 |
|---|---|
| `drive` | `sessionId`, `cols`, `rows` |
| `undrive` | `sessionId` |
| `create` | `installationId`, `workspace`（非空）, `skipApproval?: boolean`, `args?: string[]` |
| `pty-resize` | `sessionId`, `cols`, `rows` |

**数据面**

| type | 必填 |
|---|---|
| `pty-out` | `sessionId`, `data`（base64）, `byteLength` |
| `pty-in` | `sessionId`, `data`（UTF-8 文本） |
| `pty-ack` | `sessionId`, `bytes` |
| `pty-exit` | `sessionId`, `code?: number`, `signal?: number` |

`parseRemoteMessage`：输入 `unknown`（测试里对 JSON.parse 结果调用）。`v` 不是 `1` → 拒绝。`create.workspace` 空字符串 → 拒绝。合法对象上的多余键忽略。

---

## 5. 加入 URL

`parseJoinUrl(input: string)` 用 WHATWG `URL`（主进程与日后 renderer 都有）。

返回成功时：

```ts
{
  origin: string    // URL.origin，含 scheme/host/port
  base: string      // pathname 去掉最后一段，无尾斜杠；根路径为 ''
  roomId: string    // 最后一段，非空
  wsUrl: string     // 同 host、同 base，路径 {base}/v1/ws
  href: string      // 规范化后的加入 URL：origin + (base 或 '') + '/' + roomId
}
```

Scheme 映射：

| 加入 URL | `wsUrl` scheme |
|---|---|
| `https:` | `wss:` |
| `http:` | `ws:` |
| `wss:` / `ws:` | 保持（P1 测试中继填 `ws://127.0.0.1:<port>/<room>`） |

其它 scheme → 失败。

路径规则：

- `https://hrack.dev/aK3` → `{ origin: 'https://hrack.dev', base: '', roomId: 'aK3', wsUrl: 'wss://hrack.dev/v1/ws' }`
- `https://my.box:8443/remote/aK3` → `{ origin: 'https://my.box:8443', base: '/remote', roomId: 'aK3', wsUrl: 'wss://my.box:8443/remote/v1/ws' }`
- `http://127.0.0.1:9/aK3` → `{ origin: 'http://127.0.0.1:9', base: '', roomId: 'aK3', wsUrl: 'ws://127.0.0.1:9/v1/ws' }`

补测（SPEC 未点名但解析必须稳定）：

- 尾斜杠：`https://hrack.dev/aK3/` 与无斜杠等价。
- 缺 room：`https://hrack.dev`、`https://hrack.dev/` → 失败。
- query / hash 忽略，不进入 `href`。
- 更深子路径：`https://my.box/remote/foo/aK3` → `base: '/remote/foo'`。

不在 P0 校验 22 字符 url-safe 长度。

---

## 6. 座位状态机

不可变纯函数。`RoomTable` 为 `Record<string, RoomRecord>`。

```ts
type SeatOwner = string | null  // connectionId，不上线
type RoomRecord =
  | { status: 'open'; desktop: SeatOwner; phone: SeatOwner }
  | { status: 'revoked' }
```

| 函数 | 行为 |
|---|---|
| `openRoom(rooms, roomId)` | 写入空座开放房间。已存在则原样返回（不复活已吊销 id）。 |
| `hello(rooms, { roomId, role, connectionId })` | 见下 |
| `disconnect(rooms, connectionId)` | 找到该连接所在座位并清空；若对端仍在，返回 `peer-leave` |
| `revoke(rooms, roomId)` | 标 `revoked`；返回应发给两端的 `revoked`（若座位上有连接） |

`hello`：

| 条件 | 应答 | 表是否变 |
|---|---|---|
| 无此 room 或 `revoked` | `bad-key` | 否 |
| 该 `role` 座位上有**另一个**活 `connectionId` | `occupied` | 否（不踢） |
| 座位空 | `hello-ok`（`peer` 为占座后快照） | 写入该连接。对端已占则另给对端 `peer-join` |
| 同一 `connectionId` 重复 hello | `hello-ok` | 否 |

掉线重连：必须先 `disconnect` 旧连接，新 `connectionId` 才能占同一角色。这就是 SPEC「旧套接字已断才能占」。

不实现计时器、hello 限流、单房间缓冲上限。

---

## 7. 黄金 JSON

路径：`e2e/fixtures/remote/`（与 `e2e/fixtures/pi/*.json` 一样当夹具，不进协议复制集）。

| 文件 | 必须能过 `parseRemoteMessage` 的要点 |
|---|---|
| `hello.json` | `{ v: 1, type: 'hello', role: 'desktop', roomId: 'aK3' }` |
| `sessions-snapshot.json` | 一条六态齐全的 `RemoteSession`，**没有** `correlation` / 本机路径 |
| `drive-ok.json` | 含 `history.complete` 与至少一条 `output` 事件 |

测试：`JSON.parse` → `parseRemoteMessage` 成功，且结果的 `type` 匹配。另用内联对象测非法 `v`（`0`、`2`、缺 `v`、`v: '1'`）。

---

## 8. 测试清单（`e2e/remote-protocol.spec.ts`）

不 launch Electron。从 `../shared/remote-protocol` import。

**URL**

- SPEC 三个样例 origin/base/roomId/wsUrl 精确相等。
- `http`→`ws`、`https`→`wss`；`ws://127.0.0.1:9/aK3` 的 `wsUrl` 为 `ws://127.0.0.1:9/v1/ws`（给 P1 铺路）。
- 尾斜杠、缺 room、非法 scheme。

**守卫**

- 三份黄金 JSON 通过。
- 非法 `v` 拒绝。
- snapshot 夹具若被塞入 `correlation` 或 `resolvedExecutable`，守卫失败（证明远程子集真的窄）。
- 空 `create.workspace` 拒绝。
- `not-implemented` 形状 `{ v: 1, type: 'not-implemented', for: 'drive' }` 通过。

**座位**

- 未 `openRoom` 的 hello → `bad-key`。
- desktop hello → `hello-ok` 且 `peer.desktop === true`、`peer.phone === false`。
- 第二台 desktop（不同 connectionId）→ `occupied`，第一台座位不变。
- 第一台 `disconnect` 后再 hello → `hello-ok`。
- phone 加入已有 desktop → 双方：caller `hello-ok.peer.phone === true`，desktop 收到 `peer-join`。
- `revoke` 后两端会拿到 `revoked`；再 hello → `bad-key`。
- 对已吊销 id `openRoom` 不得重新开放。

---

## 9. 落地步骤

顺序可审、每步可测：

1. 写 `shared/remote-protocol.ts` 的常量与类型（空实现的 parse/hello 先返回失败也可，但本 P0 小，建议类型和实现一次写完）。
2. 实现 `parseJoinUrl`，补 URL 测。
3. 实现 `parseRemoteMessage` + 三份 JSON 夹具，补守卫测。
4. 实现 `openRoom` / `hello` / `disconnect` / `revoke`，补座位测。
5. `npx playwright test e2e/remote-protocol.spec.ts` 全绿。
6. `npm run typecheck`。`shared/` 已在 `tsconfig.node.json` 与 `tsconfig.web.json` 的 `include` 里，不必改 tsconfig。
7. 把本计划落到 `docs/PLAN-REMOTE-P0.md`，便于 P1 对照。不改 SPEC 正文；P0 完成后可把 SPEC 文首状态改成「P0 已冻结，P1 未做」（实施时再改）。

不改 `electron/`、`preload/`、`src/`、`package.json`。

---

## 10. 风险与非风险

- **Playwright 跑纯函数：** 仓库已这样做，60s timeout 对 CPU 测试无影响。
- **短 roomId vs 128-bit：** 解析放宽是为对齐 SPEC 样例；P2 生成必须用 128-bit url-safe 无填充。不要在 P0 解析里突然收紧，否则验收 URL 失败。
- **workspace 不在投影上：** P0 只定可选字段。P1 映射时从 `AgentSessionRuntime` 会话记录取，不要为了远程去改六态投影。
- **`revoke` 是否 HTTP：** 即使 P2 网站用 HTTP 吊销，WS `revoke` 形状仍要冻住，HRack 设置才能发。

---

## 11. P1 不要提前做的事

收到本模块之后 P1 才做：出站 WSS、设置页 URL 框、确认文案、二维码、把投影裁成 `RemoteSession`、对 `drive`/`create`/`pty-in` 回 `not-implemented`。P0 PR 若出现 `WebSocket`、`BrowserWindow` 或设置 store 字段，即范围蔓延。
