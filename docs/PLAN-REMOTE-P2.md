# P2 — 中继网站（前后端）

> 状态：**独立参考实现、本地真实接口验收与公网部署已完成（2026-08-20）**。对应 [SPEC-REMOTE.md](./SPEC-REMOTE.md) §6、§8、§11 P2。HRack P3 真实联调另见 [PLAN-REMOTE-P3.md](./PLAN-REMOTE-P3.md)。
>
> 目标仓库：新建独立仓库 `hrack-remote-server`。当前 `hrack` 仓库只保存计划和协议来源，不在这里混入中继实现。
>
> 前置：P0/P1 已通过。P2 完成后，P3 才用真实 HRack 对真实部署做端到端列表验收。

**人能验收什么：** 打开网站生成匿名房间，得到完整 HTTPS URL、二维码和复制/吊销操作；两个真实 WebSocket 夹具能占 desktop/phone 座位并按方向转发，第三者不能挤掉原连接，吊销后两端收到确认并断开。

---

## 1. 交付边界

### 做

- 生成页：创建房间、显示完整加入 URL、二维码、复制、吊销。
- 加入页：打开 `{base}/{roomId}` 只显示配对说明/二维码，不提供终端控制台。
- 内存房间与 1:1:1 座位；进程重启后全部失效。
- `{base}/v1/ws`：hello、占座、方向白名单转发、心跳、吊销和有界背压。
- 创建/网页吊销 HTTP 接口；HRack 仍可通过已冻结的 WS `revoke` 吊销。
- 传输层 1 MiB 帧限制、hello/创建限流、连接/房间容量上限和不含秘密的日志。
- localhost 黑盒测试和真实浏览器生成页测试。

### 不做

- 会话列表、catalog、xterm、驾驶、新建 CLI、账号、数据库、Redis、房间恢复。
- 多 desktop、多 phone、围观、排队、自动拉起 HRack。
- E2E 加密、WebRTC、TURN、推送、普通 shell。
- 多副本部署。P2 是单进程内存权威；生产副本数必须为 1。
- 在 P2 内私改 v1 报文。需要协议变化时，先回 `hrack/shared/remote-protocol.ts` 修改、验收和冻结。

### 完成标志

目标仓库至少提供：

```powershell
npm run typecheck
npm test
npm run e2e
npm run build
```

四项全绿，并通过 §9 的真实 HTTP/WebSocket 黑盒验收。只跑纯状态测试或只在浏览器里看见二维码，不算 P2 完成。

---

## 2. 技术与部署选择

- Node.js 22 + TypeScript。
- HTTP 使用 `node:http`；WebSocket 使用 `ws`，禁止另起一套协议解析。
- 生成页使用 Vite 构建静态前端；二维码使用本地依赖生成，不请求第三方二维码服务。
- 测试使用项目自身的单元测试框架 + Playwright；网络黑盒必须监听 localhost 随机端口。
- `PUBLIC_ORIGIN` 是生成加入 URL 的唯一权威，例如 `https://hrack.dev`。
- `BASE_PATH` 可为空或 `/remote`；HTTP、页面资源、加入 URL 和 WS 都必须使用同一个 base。
- 生产 `PUBLIC_ORIGIN` 必须是 HTTPS。明文只允许测试进程显式开启且绑定 loopback。
- 反向代理负责 TLS；应用不从不受信任的 `Host` / `X-Forwarded-*` 猜公开 origin。
- 单进程、单副本。健康检查不得创建房间或改变座位。

删除测试：如果移除本 P2，中继的房间秘密、单连接单席位、方向隔离、吊销顺序、限流、心跳和背压会散回 HTTP/WS 回调及各个测试。这个模块必须把复杂度真正藏住，不能只是路由转发层。

---

## 3. 模块形状

`RelayCore` 是深模块，也是权威状态机。HTTP/WSS 只是适配器；调用方和测试通过同一个 interface，不直接改 `Map` 或 socket 元数据。

```text
HTTP adapter ─┐
              ├─ RelayCore
WS adapter ───┤    createRoom()
              │    revokeRoom(input) → effects
test adapter ─┘    handleSocket(event) → effects
                         │
                         ├─ 房间/座位/连接绑定
                         ├─ v1 守卫与方向白名单
                         ├─ hello/创建限流
                         ├─ 心跳与违规计数
                         └─ send / close / close-after-send effects
```

外部 interface 只暴露三类语义操作：

```ts
interface RelayCore {
  createRoom(input: CreateRoomInput): CreateRoomResult
  roomAvailability(roomId: string): 'open' | 'unavailable'
  revokeRoom(input: RevokeRoomInput): RevokeRoomResult
  handleSocket(event: RelaySocketEvent): RelayEffect[]
}
```

- 构造时注入 `clock` 与 `randomBytes`，测试使用确定性适配器，生产使用系统实现。
- `RelaySocketEvent` 只有 `open` / `text` / `pong` / `close` / `tick`。
- `roomAvailability` 只回答网页渲染所需的通用状态，不返回座位、token digest 或房间元数据。
- `CreateRoomResult` / `RevokeRoomResult` 带 HTTP 适配器需要的机器结果；`RelayEffect` 只有 socket/日志侧可观察结果：`send`、`ping`、`close`、`close-after-send` 和安全日志事件。
- WS 适配器维护实际 socket 句柄并执行 effects；它不得自行判断座位、方向或吊销规则。
- 测试不读取 `RelayCore` 私有 Map；断言 effects 和对端可见结果。

内部可继续拆文件，但不能把 `rooms`、`socketMeta`、违规计数或计时器控制暴露给路由层。

---

## 4. 协议来源与漂移纪律

P2 暂不抽共享 npm 包；该工作按 SPEC 留到 P8 后。目标仓库 vendoring 以下权威文件和黄金夹具：

- 来源提交：`a00bda83d3ead0c89e1e474eacef674015b0fd10`
- `shared/remote-protocol.ts`
- SHA-256：`295c157edd02c7cf6feaa969456822c0a6fe1ec775c99ff1b639f44b3db5f030`
- `e2e/fixtures/remote/{hello,sessions-snapshot,drive-ok}.json`

目标仓库在 vendored 文件头记录来源提交和 hash，并提供 contract test：

- 三份黄金 JSON 通过守卫。
- `REMOTE_PROTOCOL_VERSION === 1`。
- desktop/phone 方向联合与 P0 相同。
- 任何本地修改都先在 `hrack` 权威文件落地；不得只修服务器副本。

中继可以验证报文形状和 PTY payload 的编码/大小，但不得解释终端内容、改写 ANSI、记录正文或依据业务状态做决定。合法业务报文按解析后的安全对象等价转发，不承诺 JSON 字段顺序或逐字节相同。

---

## 5. HTTP interface

所有响应带 `Cache-Control: no-store`。页面使用严格 CSP、`Referrer-Policy: no-referrer`，不加载第三方脚本、字体、统计或二维码服务。

### 5.1 页面

| 方法与路径 | 行为 |
|---|---|
| `GET {base}/` | 生成页；初始不自动创建房间 |
| `GET {base}/{roomId}` | 已开放房间的配对页；未知/已吊销显示通用失效页 |
| `GET {base}/healthz` | 只报告进程存活，不返回房间数或秘密 |

生成页点击“创建”后调用创建接口，展示：

- `joinUrl` 文本。
- 内容严格等于 `joinUrl` 的二维码。
- 复制按钮。
- 吊销按钮。

打开加入 URL 不是控制台，不显示 session、PTY 或 catalog。

### 5.2 创建房间

```http
POST {base}/v1/rooms
Content-Type: application/json

{}
```

成功：

```json
{
  "roomId": "<16 random bytes, url-safe base64 without padding>",
  "joinUrl": "https://example.com/<base>/<roomId>",
  "revokeToken": "<32 random bytes, url-safe base64 without padding>"
}
```

- 返回 `201`。
- `roomId` 必须正好 128 bit，使用 CSPRNG；碰撞则重新生成。
- `revokeToken` 只返回一次，只保存在生成页内存，不进 URL、localStorage、日志或分析事件。
- 服务端只保存 revoke token 的 SHA-256 digest，并用恒定时间比较。
- 达到创建限流返回 `429`；达到 `MAX_ROOMS` 返回 `503`。
- 有 `Origin` 时只接受与 `PUBLIC_ORIGIN` 同源；缺 Origin 的非浏览器客户端仍受 IP 限流。

### 5.3 网页吊销

```http
DELETE {base}/v1/rooms/{roomId}
Authorization: Bearer <revokeToken>
```

- 成功或已经吊销返回 `204`，操作幂等。
- token 缺失/错误与未知 room 都返回相同的通用 `404`，不提供 room 枚举 oracle。
- HTTP `revokeRoom` 与 `handleSocket` 收到的 desktop WS `revoke` 必须进入 RelayCore 内部同一个吊销状态迁移。
- 页面刷新会失去只保存在内存的 revoke token；这是 P2 的明确限制。仍可由已占座 desktop 在 HRack 内吊销。

---

## 6. WebSocket interface 与生命周期

唯一端点：`{base}/v1/ws`。

### 6.1 传输门禁

- `maxPayload = 1_048_576` bytes，在 WebSocket 库读取完整消息前生效。
- `perMessageDeflate = false`，避免压缩炸弹和不必要的秘密压缩侧信道。
- 只接受文本帧；二进制帧用 `1003` 关闭。
- 文本仍必须走 `parseRemoteFrame`；非法 JSON、非法 v1 或越界 payload 不进入房间状态。
- 新连接 5 秒内必须发送合法 `hello`；超时关闭。
- 未占座连接发送任何非 hello 报文，一律不转发。

### 6.2 占座

- 一个 socket 只能绑定一个 room 的一个 role。
- 完全相同的重复 hello 幂等返回 `hello-ok`。
- 同 socket 改 room/role、同角色已有另一活连接 → `occupied`；不踢原连接。
- 成功占座后向 caller 发 `hello-ok.peer`；另一座已有人时向对端发 `peer-join`。
- socket 关闭/心跳死亡时防御性清理其全部遗留座位，并向仍在的对端发 `peer-leave`。
- 未知或已吊销 room → `bad-key`，随后关闭请求连接。

### 6.3 方向白名单

| 来源 | 允许转发 |
|---|---|
| desktop | `RemoteDesktopToPhoneMessage` |
| phone | `RemotePhoneToDesktopMessage` |

`hello-ok`、`peer-join`、`peer-leave`、`occupied`、`bad-key`、`revoked` 只能由中继产生。客户端发送这些 type 时丢弃，不得影响对端状态。单连接 10 秒内累计 3 次非法方向/协议违规后，以 policy violation 关闭；计数和关闭不包含 payload 日志。

### 6.4 心跳

- 每 30 秒 ping；10 秒内没有 pong 视为死连接并 `terminate`。
- 时间参数可注入，黑盒测试使用短间隔，不等待真实 40 秒。
- 心跳只负责连接存活，不延长/缩短 room 有效期。房间直到吊销或进程重启才失效。

### 6.5 吊销顺序

1. 原子地把 room 标为 revoked，后续 hello/业务帧立即失败。
2. 对两个座位排队发送 `{ v: 1, type: 'revoked' }`。
3. 每个 socket 在 send callback 后关闭；最迟 500ms 强制关闭，不能先 close 再碰运气发送。
4. 清理座位和缓冲；重复吊销不重复产生业务副作用。

客户端以 `revoked` 报文确认成功，不依赖 WebSocket close code。close code 只用于诊断，不属于 v1 跨端契约。

---

## 7. 资源与安全限制

默认值必须集中在一处配置并可通过环境变量收紧：

| 限制 | 默认 |
|---|---:|
| `MAX_ROOMS` | 10,000（含进程生命周期内的 revoked tombstone） |
| `MAX_CONNECTIONS` | 20,000 |
| `MAX_RATE_LIMIT_KEYS` | 50,000 |
| 单帧 | 1 MiB |
| 单 room 两端合计 `bufferedAmount` | 1 MiB |
| 创建房间/IP | burst 3，持续 10/min |
| hello/IP | burst 5，持续 20/min |
| hello deadline | 5s |
| ping / pong timeout | 30s / 10s |
| revoke drain deadline | 500ms |

- `MAX_ROOMS` / `MAX_CONNECTIONS` 是拒绝新资源的**安全上限**，不是已验证容量或性能承诺。
- 转发前若目标 socket 或该 room 的累计 `bufferedAmount` 超限，关闭该 room 的两端并清空缓冲；不在 JavaScript 层另建无界队列。
- 不记录 roomId、joinUrl、revokeToken、Authorization、workspace、`pty-in`、`pty-out` 或完整原始帧。
- 安全日志只含随机 connectionId、角色、结果机器码、帧长度、时间和使用每日轮换密钥生成的截断 IP HMAC。
- 错误响应不回显原始 payload。
- 所有 HTML 文本转义；二维码输入只来自服务端生成的规范化 `joinUrl`。
- 生成页和 API 不启用宽泛 CORS。
- 反向代理访问日志也必须配置为不记录加入 URL 路径；部署文档必须给出示例。
- 房间永不 TTL 与有限 `MAX_ROOMS` 存在容量权衡：P2 达上限后明确 `503`，不偷偷复活/驱逐现有房间。TTL 留到 P8 后评估。

---

## 8. 目标仓库文件

```text
hrack-remote-server/
  src/
    protocol/remote-protocol.ts      # vendored v1 权威协议
    relay/RelayCore.ts               # 唯一房间/连接状态机
    relay/relay-config.ts             # 所有限制默认值与校验
    transport/http-server.ts          # HTTP + ws adapter，执行 effects
    web/                              # 生成页/加入页
  test/
    protocol-contract.spec.ts
    relay-core.spec.ts
    server-blackbox.spec.ts
    web.spec.ts
  fixtures/remote/
  docs/
    DEPLOYMENT.md
    PROTOCOL-UPSTREAM.md
```

允许因脚手架调整文件名，但职责不能倒置：路由/WS 回调不得持有第二份房间状态或复制方向判断。

---

## 9. 验收清单

### 9.1 协议 contract

- vendored 文件来源 commit/hash 与 §4 一致，三份黄金 JSON 通过。
- 非法版本、超大帧、非法 base64、敏感字段、错误方向被拒绝或丢弃。
- 服务器产生的控制帧能通过同一守卫。

### 9.2 RelayCore interface

- create 生成 16-byte url-safe roomId 和独立 revoke token。
- desktop + phone 占座；第二个同角色 `occupied`，原连接不掉。
- 同连接改 role/room 失败；close 清除全部遗留座位。
- 未 hello、伪造控制帧、反向业务帧不转发。
- desktop/HTTP 吊销走同一状态迁移，先 `revoked` effect 再 close effect。
- rate、capacity、hello deadline、heartbeat、buffer 上限使用注入时钟可确定复现。

### 9.3 真实 HTTP/WebSocket 黑盒

用监听随机 localhost 端口的真实服务器，不直接调用 RelayCore：

1. `POST {base}/v1/rooms` 返回 `201`；roomId 解码为 16 bytes，joinUrl 的 origin/base/path 正确。
2. 浏览器打开生成页，二维码真实解码后严格等于 joinUrl；复制内容相同。
3. 两个真实 WS 客户端 hello 后收到正确 `hello-ok` / `peer-join`。
4. desktop 发允许业务帧，phone 收到语义等价 JSON；反方向与伪 `revoked` 不到对端。
5. 第二 desktop 收到 `occupied`，第一 desktop 仍可继续转发。
6. 关闭 phone 后 desktop 收到 `peer-leave`；心跳杀死的无响应连接也会腾座。
7. 网页 token 和 desktop WS 两种吊销都让两端先收到 `revoked`，再断开；后续 hello 为 `bad-key`。
8. 1 MiB+、二进制、未 hello、慢消费者和限流路径不会造成无界内存。
9. 以 `/remote` 启动后，页面、API、joinUrl、WS 全部带相同 base。
10. 重启进程后旧 roomId 为 `bad-key`。
11. 捕获应用日志与 HTTP access log，断言不出现 roomId、revoke token、Authorization 或 PTY fixture 正文。

P2 不用 `MemorySessions`，也不启动 Electron；它验收真实服务器网络 interface。P3 再把已通过的 HRack P1 客户端接到该服务器，验证真实会话 snapshot。

### 9.4 真实性能门禁

负载发生器必须是服务器之外的独立进程，走真实 HTTP + WebSocket；发布环境还要走真实 TLS/WSS。不能用直接调用 `RelayCore` 的循环代替容量验证。

| 门禁 | 连接与流量 | 必须观测 |
|---|---|---|
| P2 必达 | 2,000 个并发连接、其中 100 个房间持续双向活动，30 分钟 soak | relay p99、event-loop delay p99、CPU、RSS/heap、GC、异常断线、`bufferedAmount` |
| 扩展档 | 20,000 个并发连接、其中 1,000 个房间持续双向活动并带 256 KiB 突发 | 同上；结果只形成容量报告，不因设置了 `MAX_CONNECTIONS` 就宣称通过 |

- P2 必达档要求：正常业务帧 relay p99 < 100ms、event-loop delay p99 < 50ms、无异常断线、RSS 在 soak 期间无持续线性增长、房间缓冲不越过配置上限。
- CI 可跑缩小版冒烟；完整 30 分钟与扩展档必须保存机器、Node 版本、负载参数和原始摘要，不能只写“压测通过”。
- 若必达档失败，先在保持 v1 interface 不变的前提下定位解析、序列化、对象分配和 WS adapter；只有真实数据表明 adapter/运行时是瓶颈时，才比较 Go 或其他 adapter。
- 绑定完成后的业务帧由 `RelayCore` 内部热路径完成方向守卫和路由；不额外暴露第二套公开 interface，也不允许 adapter 绕过 `parseRemoteFrame` 转发原始文本。
- 多副本不是换语言即可解决的问题；若产品目标要求水平扩展，必须另立房间归属、跨实例协调和路由计划，不能把 P2 单副本容量测试当成多副本设计。

---

## 10. 落地顺序（小提交）

1. `docs: scaffold remote relay plan and deployment contract`
2. `chore: scaffold TypeScript relay server`
3. `test: vendor v1 protocol fixtures and contract gate`
4. `feat: add RelayCore room and seat state machine`
5. `feat: enforce role direction and connection lifecycle`
6. `feat: add room create and authenticated web revoke`
7. `feat: add WebSocket adapter heartbeat and bounded backpressure`
8. `feat: add generate and pairing pages`
9. `test: add real HTTP WebSocket and browser blackbox gates`
10. `docs: add single-process TLS reverse-proxy deployment`

每步先跑直接相关用例；失败后按 `AGENTS.md` 定向复跑，最终关门时再跑目标仓库完整门禁。

---

## 11. 明确风险

- **协议复制漂移：** P8 前用来源 commit/hash + fixtures 约束；任何协议修改先回权威仓库。
- **单进程：** 内存房间不能跨副本，部署必须 replicas=1；P2 不用 sticky session 假装解决权威分裂。
- **无 TTL：** 长期运行会到容量上限；按 SPEC 返回 503，不静默删除未吊销房间。
- **中继可见明文：** TLS 终止后服务器能看见 PTY；页面确认、自建部署和无正文日志不能把它变成 E2E。
- **吊销确认竞态：** 必须 send/drain 后 close，真实客户端黑盒覆盖，不能只断言 room 状态已改。
- **反向代理泄密：** 默认 access log 会记录带 roomId 的路径；部署文档不处理就不能上线。

---

## 12. P3 入口条件

满足以下条件才进入 P3：

- §9 全部通过并有一次真实浏览器 + 两个真实 WS 客户端的验收记录。
- 有一个 HTTPS/WSS 单副本环境，支持空 base 和至少一个子路径 base 的配置证据。
- HRack P1 无需改协议即可连接；若需要改报文才能互通，退回 P0 修协议，不在 P3 打补丁。
- 部署日志已证明不记录加入 URL、roomId、token 和 PTY 正文。

---

## 13. 实现与验证记录（2026-08-20）

独立仓库 `hrack-remote-server` 已实现 RelayCore、HTTP/WS adapter、生成/加入页、二维码、本地部署文档、真实接口验收脚本和独立进程负载发生器。

已实际完成：

- 生产构建子进程的真实 HTTP + WebSocket 创建、配对、方向隔离、占座保护、吊销顺序、重启失效和日志脱敏。
- 真实 Chromium 创建房间、二维码截图独立解码、剪贴板、加入页和吊销。
- 真实 Nginx 容器终止自签名 TLS；HTTPS/WSS 协商 TLS 1.3，验证子路径、Upgrade、转发和吊销。
- Node 24 必达档：2,000 连接、1,000 房间、100 个双向活跃房间、30 分钟，3,310,400/3,310,400 帧送达，p99 4ms、无断线、无客户端积压，内存没有持续线性增长。
- Node 22.23.0 校准档：相同并发/活跃规模跑 60 秒，110,600/110,600 帧送达，p99 13ms、无断线。

没有把失败藏掉：100 个活跃房间每 5 秒同时做 256 KiB 双向突发时，60 秒内帧仍 100% 送达且无断线，但 p99 为 189ms，未通过 100ms 扩展门禁。该结果不影响不含人工同步大突发的 P2 必达档，也不能被写成扩展档通过。

公网部署已在 `https://hrack.modplex.app/remote/` 完成：公网 CA 证书、HTTPS 建房、规范化加入 URL、WSS 双端配对/双向转发/吊销均经真实请求验证；公网反向代理关闭 `/remote/` access log，Node 只输出无 roomId、token、加入 URL和 PTY 正文的结构化运行指标。远端主机另以 200 个真实 WSS 连接、100 个双向活跃房间运行 30 秒，59,600/59,600 帧送达、p99 19ms、无断线。

仍不宣称：公网证书自动续期已经跨周期验证、20,000 连接实测容量、多副本。`MAX_CONNECTIONS=20,000` 继续只是安全上限。真实 HRack P3 联调已在后续阶段独立关门，证据见 [PLAN-REMOTE-P3.md](./PLAN-REMOTE-P3.md)，不倒算成 P2 的服务器容量证据。
