# P1 — HRack 出站 · 控制面推送

> 状态：**已完成并经真实接口复审加固（2026-08-20）**。对应 [SPEC-REMOTE.md](./SPEC-REMOTE.md) §11 P1。仓库：现有 `hrack`。当前分支：`remote`。
>
> 本文件是补写：实现先于计划落地。P2 起仍先计划再动手。
>
> 实现：`electron/remote/RemoteDesktopClient.ts`、设置「远程」、`e2e/helpers/remoteTestRelay.ts`。
> 验收：`npx playwright test e2e/remote-desktop.spec.ts e2e/remote-settings.spec.ts`。

**人能验收什么：** 设置里填完整 URL，确认后出站连测试中继；手机夹具能收到 AI CLI 会话快照和六态增量。没有真中继网站、没有驾驶、没有 App。

---

## 1. 交付边界

### 做

- 设置：完整 URL 输入、连接前确认（终端会送到该源）、连接/断开/吊销、连接状态、已填 URL 的二维码。
- 出站 `hello` `role=desktop`。不自动启动第二份 GUI。
- 手机 `peer-join` 或 `hello-ok.peer.phone === true`（重连时手机已在）后发一次 `sessions-snapshot`；之后投影变化 `session-upsert` / `session-removed`。只含 AI CLI 会话，字段按 §6.2 裁剪。
- 收到 `drive` / `undrive` / `create` / `pty-in` / `pty-resize` / `pty-ack` → `not-implemented`；有 `requestId` 时原样回带。
- CLI 自行退出后推送并稳定保留 `exited`；用户显式关闭 tab/会话才推 `session-removed`。
- 吊销先进入 `revoking`，必须等中继 `revoked` 确认；超时进入 `revoke-unconfirmed`。

### 不做

真中继仓库、驾驶、catalog、新建、App、DSH 会话进远程列表、自动重连、自动拉起 GUI。

### 完成标志

```powershell
npx playwright test e2e/remote-desktop.spec.ts e2e/remote-settings.spec.ts
npm run typecheck
```

SPEC P1 验收都绿，并完成 §7.1 的真实 Electron/PTY/WebSocket 接口验收。完整 `npm run e2e` 不是本期门禁。

---

## 2. 模块形状

出站客户端是深模块。调用方只看到 `connect` / `disconnect` / `revoke` / `getState`。座位、快照时机、未到期报文都藏在里面。

```
RemoteDesktopClient
  connect(joinUrl) / disconnect() / revoke() / getState()
       │
       ├─ parseJoinUrl          P0
       ├─ WebSocket → hello     出站
       ├─ RemoteSessionSource   list + subscribe（已是 RemoteSession，不含 correlation）
       └─ broadcast(state)      给 renderer
```

测试走同一 seam：`MemorySessions` + `RemoteTestRelay`（localhost `ws`，用 P0 `hello` / `occupied` / 转发），不必启动窗口。设置页另用 Electron 定向 e2e 走一遍确认框。

删除测试：拿掉这个客户端，设置页、IPC、测试中继会各自重写 hello/快照/占座。它不是 pass-through。

---

## 3. 关键决定

1. **连接活在主进程。** 投影和 PTY 都在 main；renderer 只填 URL、确认、看状态和码。
2. **会话源先裁再订阅。** `runtimeSessionSource` 把 `AgentSessionRuntime.listRecords()` 映成 `RemoteSession`。DSH 投影不进远程。`workspace` 从 Runtime 记录取，不改六态投影。
3. **快照只在手机在座时发。** `hello-ok.peer.phone` 或 `peer-join role=phone` 发一次 snapshot；`peer-leave phone` 清 `snapshotSent`。增量在 snapshot 之前丢掉，避免手机先看到 upsert。
4. **测试中继不是 P2。** `e2e/helpers/remoteTestRelay.ts`：内存房间 + P0 座位 + 按角色方向白名单转发，只听 `{base}/v1/ws`。它不解析 PTY 正文，但会丢弃伪造的中继控制帧和反向业务帧。P2 网站另起仓库。
5. **QR 用 `uqr`。** 码内容是规范化 `href`。P1 验收看 `data-qr-url`；真解码留给 P3。
6. **`ws` 只进 devDependencies。** 生产客户端用 Node/Electron 全局 `WebSocket`（与 `DshWireProxy` 相同）。
7. **URL 持久化、连接不持久化。** `settingsStore` v16 存 `remoteJoinUrl`。重启后不自动出站。
8. **吊销走 P0 的 WS `revoke`，且以确认帧为准。** 设置页有按钮；发出后不立即报成功，收到 `revoked` 才回 `idle`。真网站 HTTP 吊销是 P2。
9. **退出与关闭分离。** Runtime 清理 observer/run-dir 后保留 exited 记录；`runtimeSessionSource` 用 `includeExited` 对外投影。显式 `agent:stop` 才删除记录并发 `removed`。
10. **产品拒绝公网明文。** `ws/http` 只允许 localhost / loopback 测试；远程必须 `wss/https`。

---

## 4. 连接状态

| phase | 设置页 |
|---|---|
| `idle` | 未连接 |
| `connecting` | 连接中 |
| `waiting-phone` | 已出站，等待手机 |
| `peer-online` | 手机已占座 |
| `revoking` | 已发吊销，等待中继确认；按钮禁用 |
| `error` | `occupied` / `bad-key` / `revoked` / `connect-failed` / `revoke-unconfirmed` / URL 解析失败 |

`error` 是机器码，renderer 用 `strings.settings.remoteError` 翻译。

---

## 5. 文件

| 路径 | 职责 |
|---|---|
| `electron/remote/RemoteDesktopClient.ts` | 出站、hello、快照/增量、方向守卫、`not-implemented`、吊销确认 |
| `electron/remote/toRemoteSession.ts` | `AgentSessionRecord` → `RemoteSession` |
| `electron/remote/runtimeSessionSource.ts` | Runtime（含稳定 exited、显式 removed）→ `RemoteSessionSource` |
| `shared/ipc-contract.ts` | `RemoteApi` / `RemoteDesktopState` / channel |
| `src/app/RemoteSettingsSection.tsx` | URL、确认、连接/断开/吊销、状态 |
| `src/app/RemoteJoinQr.tsx` | 二维码 |
| `src/state/settingsStore.ts` | `remoteJoinUrl`（persist v16） |
| `e2e/helpers/remoteTestRelay.ts` | localhost 测试中继 |
| `e2e/remote-desktop.spec.ts` | SPEC 2–6 + `not-implemented`（不启动窗口） |
| `e2e/remote-settings.spec.ts` | SPEC 1：设置填 URL → 确认 → hello |

不改 `PTYManager`、不改启动链、不改 OpenCode Bridge。

---

## 6. 设置 UI

新分类 `remote`（五语 i18n）。

- 输入框：完整加入 URL。已连接时禁用。
- 连接：先弹确认，正文带 `origin`。取消不出站。
- 断开 / 吊销。
- 状态：`data-testid="settings-remote-status"` + `data-remote-phase`。
- 解析成功即出示二维码，`data-qr-url` 等于规范化 href。

确认文案必须让人看见「终端字节会送到该源」，不能只写「确定连接」。

---

## 7. 验收对照

| SPEC | 怎么关 |
|---|---|
| 1 填 `ws://127.0.0.1:<test>/<room>`，确认后出站，中继收到 desktop hello | `e2e/remote-settings.spec.ts` 真窗口 |
| 2 两条 AI CLI，夹具手机收到 snapshot | `e2e/remote-desktop.spec.ts`：`MemorySessions` + 夹具 phone |
| 3 `needs-you` → `session-upsert` | 同上，source.upsert |
| 4 关掉会话 → `session-removed` | 同上，source.remove |
| 5 未开 HRack 时中继不拉起 GUI | 该文件不调用 `launchApp`；`process.versions.electron` 为空 |
| 6 第二 desktop `occupied`，第一桌面不断 | 两个 `RemoteDesktopClient` 连同一 room |
| 7 手机伪造 `revoked` 等控制帧不会影响 desktop | 测试中继方向白名单 + 有序 drive barrier |
| 8 吊销确认/不确认均不撒谎 | `revoked` 后 idle；超时 `revoke-unconfirmed` |
| 9 CLI 自行退出仍在列表，显式关闭才移除 | `AgentSessionRuntime` 真实 PTY exit seam + `includeExited` / `removed` 阶段 |

`drive` → `not-implemented` 会保留 `requestId`，用于验证 P1 没有假装实现驾驶。

### 7.1 真实接口验收口径

不能只把 `MemorySessions` 当成“实际测过”。最终复审还必须启动构建后的 Electron、使用 fixture CLI 创建真实 `AgentSessionRuntime`/PTY 会话，并用 localhost WebSocket 手机夹具从 `/v1/ws`（另测带 `base` 的路径）加入。至少观察：desktop `hello`、真实 `sessions-snapshot`、进程退出后的 `session-upsert status=exited` 且不会紧接 `session-removed`、显式关闭后才 `session-removed`，以及 `revoke` / `revoked` 往返。验证日期、命令与结果记录在本节下方，未执行前不得写“真实接口已通过”。

> 2026-08-20 复审记录：先执行 `npm run build`，再定向运行 `npx playwright test e2e/remote-settings.spec.ts -g "real Electron session stays exited remotely"`，1 passed。该用例启动构建后的真实 Electron 主进程和 renderer，以 `cmd.exe` fixture 建立真实 `AgentSessionRuntime` + PTY，会话数据不是 `MemorySessions`；手机夹具经 `/remote/v1/ws` 实际握手并观察到 snapshot → `session-upsert(exited)` → 显式关闭后的 `session-removed` → `revoke/revoked`。退出更新后额外观察 300ms，未出现紧随其后的误删。
>
> 最终定向门禁：`remote-protocol` + `remote-desktop` + `agent-session` + `remote-settings` 共 75 passed；另定向运行 `tabs` 的 exited 保留场景，1 passed；`npm run typecheck` 与 `npm run build` 均通过。遵循 `AGENTS.md`，没有为此反复运行完整 `npm run e2e`。

---

## 8. P2 不要提前做的事

P1 PR / 后续提交若出现独立 `hrack-remote-server` 仓库、生成页、房间 TTL、驾驶遮罩、`pty-out`，即范围蔓延。P2 只做中继网站：生成 URL+码、占座转发、occupied、吊销。P2 仍先写 `docs/PLAN-REMOTE-P2.md` 再动手。
