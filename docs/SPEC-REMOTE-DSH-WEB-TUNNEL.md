# HRack Remote DSH Web Tunnel — Spec

> 状态：**D0–D5 已关门（2026-08-24；D5 以正式域名 + Android release 模拟器验收，实体设备由项目所有者显式延期并接受风险）。** 本文定义 P0–P8 之后的独立 DSH 远程扩展轨，不表示 Remote P8 已关门或物理真机已经通过。
> 父文档：[HRack 远程控制 Spec](./SPEC-REMOTE.md)、[DSH 官方 Web Surface 隔离嵌入计划](./PLAN-DSH-OFFICIAL-WEB-SURFACE.md)。
> 范围：手机 App 通过现有 1:1:1 房间，打开并操作电脑上真实运行的 DSH 官方 Web UI；不重做 DSH UI，不把 DSH loopback 端口直接暴露到公网。

## 0. 一句话

手机以顶层 WebView 打开一个有独立 HTTPS origin 的 DSH 网关；网关把官方页面的 HTTP、`POST /api/*` 与两条事件 WebSocket，经房间绑定的独立二进制隧道转到 HRack 桌面端，再由桌面端访问 `127.0.0.1:随机端口` 上的真实 `dsh web`。工作区选择使用 DSH 官方 browse picker，不能在远程手机上触发电脑的原生目录对话框。

## 1. 已确认的事实与问题

2026-08-24 对本机实际安装的 DSH `0.1.0-rc.7` 和 HRack 开发进程做了真实接口检查，不是测试夹具：

- HRack 以 `dsh web --host 127.0.0.1 --port <random>` 启动 DSH，只监听 loopback；
- 官方根页面由完整 Vite 页面、动态插件模块和样式组成，本次启动共读取 46 个启动资源，未压缩正文合计 4,495,522 字节；
- 上行 RPC 是同源 `POST /api/<method>`；下行是 `/api/events.mux` 与 `/api/events.host` 两条只下行 WebSocket；插件热更新另有一条长期 `GET /plugins/events` SSE；
- 用 412 × 915 的真实 Chromium 页面加载本机 DSH，全部官方/plugin bundle、上述 SSE 与两条 WebSocket 都实际建立，页面没有 runtime error；启动还会请求 `settings.describe`、`credentials.describe` 等本机特权 RPC，因此 D0 必须证明这些调用在公网 authority 下被拒绝时官方主页面仍能完成普通 session/workspace 流程；
- 用 loopback authority 调用真实 `host.describe`、`session.list` 成功；把 Host/Origin 改成未受信公网 authority 后，静态根页面仍为 200，但 `/api` 为 403；因此“只反代网页文件”会得到不能工作的页面壳；
- 当前 Windows/loopback 启动由 DSH auto picker 选择了 `directory-picker-native`。网页按钮会在电脑上打开 Windows 原生目录对话框，手机看不到也无法操作；
- DSH 官方已经提供 `dsh-host-directory-picker-browse` 与 `dsh-client-ui-directory-picker-browse`，通过 `host.listDirectory` / `host.createDirectory` 在网页内完成目录浏览和创建，明确适用于 remote-browser deployment；
- HRack 已有本地主进程 `DshWireProxy`，掌握 `/api`、插件 bundle 和两条 WebSocket 的真实 wire 形状，但它只服务 Electron IPC，不足以承载完整公网网页、静态资源和手机认证。

本文据此选择“受认证的整站反向隧道”，而不是重做 DSH React UI、远程桌面截图或开放 LAN 监听。

## 2. 目标与非目标

### 2.1 目标

1. 手机 App 的会话页出现一个独立的 **DeepSeek Harness** Web surface 入口；它不是 PTY 会话。
2. 点击入口后加载电脑当前 DSH 版本实际提供的官方 HTML、CSS、JS 和用户插件 client bundle，避免 App 与桌面 DSH 版本错配。
3. 官方页面能列出、打开、新建和操作真实 DSH 会话，接收真实 event stream。
4. 新建工作区必须在手机网页中浏览电脑目录并选择；不得要求操作电脑屏幕上的系统对话框。
5. DSH 进程继续只监听 loopback；电脑不开放入站端口，桌面端只建立到 Relay 的出站 WSS。
6. 公网入口沿用现有房间的 1:1:1、吊销、掉线和 TLS 边界，并增加一次性 Web ticket 与短期 Cookie。
7. 官方部署与自部署都通过显式 `dshPublicOrigin` 工作，不写死 `modplex.app`。
8. DSH 网页流量与 PTY/会话控制流物理分离；加载约 4.5 MB 页面时不能阻塞终端 ACK、状态和输入。

### 2.2 非目标

- 不把 `127.0.0.1:<port>`、`0.0.0.0:<port>`、Cloudflare Tunnel 或任意临时公网端口直接交给手机。
- 不做代理到任意电脑 URL、任意 loopback 服务、文件协议或局域网地址；目标只能来自 `DshHostManager` 当前 ready generation 的 `baseUrl`。
- 不把 DSH 伪装成 xterm/PTY，不复用 `drive`、`pty-in`、`pty-out`、winsize 或 PTY history 协议。
- 不在 App 中重写 DSH 的会话列表、对话、工具、设置和工作区 UI。
- 第一版不支持网页下载、任意文件上传、相机附件、拖放、打印或弹出新窗口；核心文本会话与目录选择先关门。
- 不承诺端到端加密。与现有远控相同，公网 TLS 在 Relay 终止后，Relay 能看到被转发的 HTTP/RPC 内容。
- 不把 DSH 的本机特权配置面开放给手机；凭据读写、设置文件修改、打开电脑本地路径和原生目录选择继续由 DSH 的 trust fence 拒绝。
- 不改变现有 Remote P8 的物理真机关门条件，也不借本扩展宣布 P8 完成。

## 3. 总体架构

```text
HRack Remote App
  ├─ 主 Remote WSS：配对、会话列表、PTY、DSH 状态与 ticket 请求
  └─ 顶层 DSH WebView
          │ HTTPS + WSS（短期 HttpOnly Cookie）
          ▼
https://<dsh-public-origin>/
  DSH Gateway（Relay 的独立 virtual host）
          │ 独立 dsh-tunnel WSS；HTTP/WS 多路复用、信用流控
          ▼
HRack Desktop DshTunnelClient
          │ Node HTTP/WS；目标固定，保留公网 Host/Origin
          ▼
http://127.0.0.1:<random>/ 真实 dsh web
```

### 3.1 为什么必须是独立 origin

DSH 根页面、启动 manifest、插件模块和运行时都使用 `/assets/*`、`/plugins/*`、`/api/*` 等根绝对路径。把它挂到现有 `/remote/<room>/dsh/` 会迫使 HRack 重写 HTML、动态插件 URL、`fetch`、WebSocket 和未来新增的 Worker/EventSource，版本升级极易失效。

因此 DSH Gateway 必须独占一个 origin，例如 `https://dsh.hrack.modplex.app`。不要求每房间一个子域名，也不要求 wildcard 证书；房间映射由该 origin 上的短期 Cookie 完成。自部署者配置自己的单独 origin 和正式 TLS 即可。

### 3.2 顶层页面而不是 iframe

App 使用已经引入的 `react-native-webview` 直接打开 DSH Gateway 顶层页面。禁止把它 iframe 到 Relay dashboard：这样可以保持 DSH 的同源 API/WebSocket、Cookie、CSP、软键盘和 viewport 行为，也避免第三方 Cookie 与 frame-ancestor 差异。

### 3.3 模块所有权

| 仓库 | 所有权 |
|---|---|
| HRack Desktop | DSH 启动 overlay、trusted authority、能力预检、surface 状态、独立 tunnel client、固定目标 loopback proxy |
| Remote Server | `dshPublicOrigin`、ticket/Cookie、专用 virtual host、HTTP/WS gateway、独立 tunnel seat、流控/配额/吊销 |
| Remote App | DSH surface 入口、ticket 状态机、隔离 WebView、同源导航栅栏、退出与错误恢复 |
| 三方协议副本 | 主 WSS 的 DSH capability/ticket 报文和 tunnel control/binary framing；继续由 sync/check 门禁保证一致 |

## 4. 启用、身份与生命周期

### 4.1 显式启用

升级后桌面端的“允许当前远控房间打开 DSH”默认关闭。用户显式开启后，HRack 才能：

1. 从 Relay 的能力响应取得规范 `dshPublicOrigin`；
2. 以该 origin 的 authority 配置 DSH trust fence；
3. 启动或重启 HRack 管理的 DSH Web host，并应用 browse picker overlay；
4. 建立独立 DSH tunnel seat；
5. 向手机发布 `dsh-surface-state: ready`。

关闭开关会立即撤销当前 DSH ticket/Cookie、关闭 gateway streams 和 tunnel seat，但不删除、归档或修改 DSH 会话。现有 PTY 远控不受影响。

### 4.2 Relay 能力

Remote Relay 在现有主 WSS `hello-ok` 中携带可选的公开能力：

```ts
interface RemoteRelayCapabilities {
  dshWebTunnel?: {
    origin: string       // 规范 https origin；不得有 path/query/hash/userinfo
    protocol: 1
  }
}
```

未配置、不是 HTTPS、与服务端实际 virtual host 不一致或当前部署不支持时省略该能力。App 与 Desktop 必须把省略解释为 unsupported，不能猜测 `dsh.<remote-host>`。

### 4.3 Tunnel seat 认证

主 Desktop seat 成功后，Relay 只向该桌面连接发一个随机、短期、单连接 `dshSeatToken`。Desktop 用它连接独立：

```text
wss://<relay-origin>/<base>/v1/dsh-tunnel
```

第一帧为 `dsh-tunnel-hello { roomId, dshSeatToken, protocol: 1 }`。Relay 必须同时确认：

- room 仍为 open；
- 颁发 token 的主 Desktop seat 仍是当前 occupant；
- token 未过期、未使用在另一个 tunnel connection；
- 没有第二个 DSH tunnel seat；
- `dshPublicOrigin` 已配置且 authority 精确一致。

主 Desktop seat 离线、被替换、房间吊销、功能关闭或 token generation 变化时，Tunnel seat 和所有 Web sessions 立即关闭。不能仅凭可复制的 roomId 建第二条桌面隧道。

### 4.4 手机 ticket 与 Cookie

手机只能在自己仍占据 Phone seat、Desktop seat 在线、DSH tunnel ready 且 surface generation 一致时，在主 WSS 发送：

```ts
{ v: 1, type: 'dsh-ticket-request', requestId: string }
```

这是 Relay 自己处理的控制报文，不转发给 Desktop。成功返回：

```ts
{
  v: 1
  type: 'dsh-ticket-ok'
  requestId: string
  url: string       // https://<dsh-origin>/_connect/<opaque-ticket>
  expiresAt: number // 最多 30 秒
}
```

失败返回 `dsh-ticket-reject`，reason 只能是 `unsupported`、`disabled`、`desktop-offline`、`tunnel-offline`、`busy`、`revoked` 或 `unavailable`，不得回传本机路径、端口、DSH stderr 或内部连接 id。

`/_connect/<opaque-ticket>` 的 ticket：

- 128 bit 以上 CSPRNG，服务端存摘要；URL 中不编码 roomId、端口或 seat token；
- 一次性、30 秒内使用，使用后立即失效；
- 只接受顶层 GET；响应设置 `Referrer-Policy: no-referrer`、`Cache-Control: no-store`；
- 成功时设置 `__Host-hrack-dsh=<opaque-session>`，必须 `Secure; HttpOnly; SameSite=Strict; Path=/` 且无 Domain，然后 `303 Location: /`；
- ticket 路径、Cookie、query、authorization 和完整 DSH API 路径关闭 access log，应用日志只记录无标识计数和错误类别。

Cookie session 绑定原 Phone seat connection、Room、Desktop tunnel generation 与 DSH host generation。主 Phone WSS 一旦断开就立即停止新请求并失效 Cookie；DSH 第一版不跨连接恢复 Web session，App 重连主房间后必须取得新 ticket。现有 PTY 的 15 秒驾驶释放宽限保持原样，不能套用到权限更宽的 DSH 网页。Cookie 最长 12 小时，且不得写入 App SecureStore、共享浏览器或系统浏览器。

## 5. DSH Host 启动与工作区选择

### 5.1 Loopback 不变

DSH 始终使用：

```text
dsh --profile web --patch <hrack-owned-overlay> \
  --host 127.0.0.1 --port <random> \
  --trusted-host <dsh-public-authority> --no-open
```

不能改成 `0.0.0.0`，不能把随机端口写进 App/Relay 协议，也不能把 `dshPublicOrigin` 写入用户的 `$DSH_HOME/profiles/web/cordis.patch.yml`。overlay 放在 HRack 自己的 userData/runtime 目录，由 HRack 随版本生成和验证；用户 DSH profile、插件和存储仍是权威来源。

### 5.2 强制 browse picker

HRack-owned overlay 必须把默认 `directory-picker` 的 auto backend 替换为官方 browse backend，并同时得到对应 client bundle。不能同时挂载 auto/native/browse 两套插件；发现重复 service 或缺少 client face 时启动失败并把 surface 标为 unavailable。

这是启用远程 DSH 后的全 host 决策：同一个 DSH server 不能对本机 WebContentsView 使用 native picker、同时对手机使用 browse picker，因为 DSH 当前只在 boot 时选择一次 capability，尚无 per-connection picker。故 Desktop 的 DSH surface 也会改用官方网页 browse dialog。这一行为可见但可接受，优先保证本机和远程使用同一官方 Web artifact 与确定性能力。

### 5.3 Ready 门槛

只有以下真实检查全部通过，Desktop 才发布 `ready`：

1. 根 HTML 200，并能解析 `window.__DSH_BOOT__`；
2. boot manifest 含 directory-picker-browse 的 client face，不含 native picker face；
3. `host.describe`、`session.list`、`workspace.list` 成功；
4. `host.listDirectory` 的 schema/方法存在；
5. 用公网 authority 语义做 trust probe：普通会话/工作区 API 可达，本机特权方法仍被拒绝；
6. `/plugins/events` SSE 和两条本地 WebSocket 都能建立，且官方页面在预期的 privileged denial 下没有 fatal runtime error。

静态首页可读但 `/api` 403、只有一条 WebSocket、目录选择仍是 native 或方法版本不兼容，都不能发布 ready。

## 6. Web Gateway 路由与转发规则

### 6.1 公网路由

有有效 Cookie 的 DSH origin 只开放：

| 方法/路径 | 行为 |
|---|---|
| `GET /` | 转发当前 DSH generation 的根 HTML |
| `GET/HEAD /assets/*` | 转发官方前端静态资源 |
| `GET /plugins/events` | 转发当前 profile 的长期 SSE；每个 Web session 最多一条 |
| `GET/HEAD /plugins/*` | 转发当前 profile 的插件 client bundle；不包含上面的 SSE 特例 |
| `GET/HEAD /manifest.webmanifest`、`/favicon.svg` | 转发官方静态文件 |
| `POST /api/*` | 转发 DSH unary/respond RPC |
| WebSocket `/api/events.mux`、`/api/events.host` | 转发两条只下行事件流 |
| `GET /_healthz` | 无 Cookie 的最小 `{ "ok": true }`，不暴露房间/tunnel 数 |

其余路径和方法返回 404/405；`CONNECT`、`TRACE`、任意绝对 URL、反斜杠、NUL、编码后路径穿越、重复解码得到的 `.`/`..` 均在 Relay 侧拒绝。第一版不把 DSH fallback 扩成任意路径代理，新增官方路由必须先进入显式 allowlist 和真实版本验证。

### 6.2 Header 与 authority

Desktop 连接 loopback 时必须保留 DSH 公网信任语义：

- TCP 目标固定为 `DshHostManager.status.baseUrl`；
- HTTP `Host` 设置为配置的 DSH public authority；浏览器存在 `Origin` 时精确保留同一 HTTPS origin；
- 不得把 Host/Origin 重写成 `127.0.0.1:<port>` 来绕过 DSH 的 loopback-only 权限；
- Gateway Cookie、ticket、Authorization、Proxy-*、Forwarded/X-Forwarded-* 和所有 hop-by-hop header 不进入 DSH；
- 只转发显式 allowlist 的 `Accept`、`Accept-Language`、`Content-Type`、条件缓存、Range（若实现）和 DSH 必需请求头；
- 本地响应的 `Set-Cookie` 一律丢弃，不能覆盖 Gateway Cookie；
- `Location` 只允许同一 DSH public origin 或根相对路径，否则拒绝；
- 响应移除 hop-by-hop、Server 和可能暴露 loopback 的诊断 header。

### 6.3 DSH 特权面保持关闭

DSH 将 `host.pickDirectory`、`host.openPath`、settings/credentials 修改和 agent preset authoring 等方法钉在 loopback authority。Gateway 必须让远程页面以配置的 trusted public authority 到达 DSH，使普通 session/workspace/browse API 可用，但上述 privileged methods 继续被 Host fence 拒绝。

不得在 Relay 或 Desktop 重新实现一份易漂移的方法黑名单来替代 DSH 自己的 authority fence；HRack 只增加启动/运行时探针，证明 fence 没有因为 Host 重写而失效。若某个 DSH 版本无法同时满足 browse picker 和非 loopback privileged denial，则该版本不支持远程 DSH。

## 7. 独立 Tunnel 协议与流控

### 7.1 为什么不复用主 Remote WSS

DSH 当前首屏约 4.5 MB，且会并发请求数十个 bundle。把这些正文 base64 塞进现有 JSON Remote WSS 会增加约 33% 体积，并让 PTY input/ACK、`session-upsert` 和吊销控制遭遇同一发送队列的 head-of-line blocking。因此 DSH tunnel 使用独立 WSS、独立字节上限和二进制 body frame。

### 7.2 Control frame

Tunnel 的 control frame 是有界 UTF-8 JSON，最大 32 KiB。至少包含：

- `http-open { streamId, method, path, headers, bodyLength? }`
- `http-head { streamId, status, headers }`
- `http-end { streamId }`
- `http-abort { streamId, reason }`
- `ws-open { streamId, path, headers }`
- `ws-open-ok { streamId, protocol? }`
- `ws-open-reject { streamId, status }`
- `ws-close { streamId, code, reason? }`
- `credit { streamId, bytes }`
- `ping` / `pong`

`streamId` 是单 tunnel generation 内非零 uint32，不能复用仍存活或处于 TIME_WAIT 的 id。未知 type、未知 stream、重复 open/head/end、非法状态转换或多余字段按协议错误关闭 tunnel，不把未验证对象交给 Node HTTP/WS。

### 7.3 Binary frame

正文使用固定 header 的二进制 frame，不用 base64：

```text
byte 0      protocol = 1
byte 1      kind: 1=http-body, 2=ws-text, 3=ws-binary
byte 2..5   streamId uint32 big-endian
byte 6..9   sequence uint32 big-endian
byte 10..   payload，0..65536 bytes
```

HTTP body 双向可流；当前 DSH event WebSocket 只下行文本，公网客户端若发送应用数据，Gateway 直接以 1008 关闭，不转给 DSH。协议保留 `ws-binary` kind 只用于未来显式升级，第一版收到即 1003/协议错误。

### 7.4 有界资源

- 每个 Web session 最多 64 个并发 HTTP stream、最多 1 条 `/plugins/events` SSE、恰好最多 2 个 DSH event WebSocket；64 来自 D4 对官方 40+ plugin boot fanout 的真实测量，不提高既有字节/buffer budget；
- 单 HTTP request body 最多 16 MiB，普通单 response body 最多 32 MiB；超过时返回 413/502 并 abort 对应 stream，不断开 PTY 主通道；SSE 不设累计正文上限，但继续受 credit、buffer、速率和 room 生命周期约束；
- 每 frame payload 最多 64 KiB；初始每 stream credit 256 KiB；任一方向未获 credit 不得发送；
- 单 stream 未消费缓冲最多 512 KiB，单 room tunnel 聚合未消费缓冲最多 2 MiB；达到上限先停读本地 socket/HTTP body，不能继续堆 Relay 内存；
- header 总量 32 KiB、单 header 8 KiB、最多 64 项；
- 建连/首 header 10 秒、普通 HTTP idle 60 秒；SSE 与 event WebSocket 生命周期跟随 Cookie/room，SSE 依赖字节/注释活动检查，WebSocket 继续做 ping/pong 和 90 秒无 transport 活动检查；
- Relay 全局另有 room/tunnel/总内存上限和公平调度；一个房间持续下载不能饿死其它房间。

## 8. App 行为

### 8.1 Surface 能力与 DSH 会话投影

Desktop 通过主 Remote WSS 发布独立的：

```ts
interface RemoteWebSurface {
  id: 'dsh'
  kind: 'dsh-web'
  displayName: 'DeepSeek Harness'
  iconId: 'dsh'
  state: 'starting' | 'ready' | 'unavailable' | 'failed'
  generation: number
}
```

`RemoteWebSurface` 只表达“官方网页是否可打开”和 generation，不再作为手机会话列表中的常驻行，也不出现
`drive` 按钮。Desktop 的 `DshSessionProjector` 用 `session.list` 恢复**已经由 HRack 建立的监听条目**的
初始状态，再以 `events.host/events.mux` 更新这些条目。`session.list` 不是手机端历史会话目录；未被 HRack
监听的历史 DSH session 不得进入 Remote snapshot，即使它仍存在于官方 DSH 数据库：

- `RemoteSession.sessionId` 使用官方 DSH session id，`adapterId` 固定为 `dsh`；桌面本地 slot id、
  `terminalId`、可执行路径、correlation 和 capabilities 不出电脑；
- 名称、六态、可读 detail、待处理数、活动工具数和最后活动时间随普通
  `sessions-snapshot/session-upsert/session-removed` 同步；
- App 点击 `adapterId=dsh` 的会话时不得发送 PTY `drive`，而是唤出唯一 DSH WebView并选择该官方
  session；因此手机和桌面看到同一任务状态，但不会建立第二套 DSH 事件解释器；
- 手机官方页面新建 session 后，Desktop 从 `host/session-added` 建立确定性的 HRack 监听条目；该条目再经
  与桌面 renderer 完全相同的 `DshProjectionBridge` 增量进入手机。手机和桌面均不得依赖轮询刷新；
- Remote Desktop 不得绕过 `DshProjectionBridge` 直接枚举 projector 的完整 session cache。HRack 取消监听
  或 slot 改绑时，手机必须同步移除旧官方 session id，再按需加入新 id。

### 8.2 WebView 状态机

```text
idle → requesting-ticket → loading → ready
  └──────── reject/HTTP/renderer/tunnel loss ───────→ failed → retry
```

- 每次进入且没有仍有效的内存 Web session 时请求新 ticket；不得根据 roomId 自行拼 URL；
- WebView 使用隔离、非共享且不落盘的 Cookie/storage；禁止第三方 Cookie，不与系统浏览器、Relay dashboard 或终端 WebView 共享数据目录；
- 仅允许顶层导航到精确 `dshPublicOrigin`。其它 `http/https` 链接交系统浏览器前需用户点击；`file:`、`content:`、`intent:`、自定义 scheme 和跨 origin iframe 直接拒绝；
- 禁用网页新窗口、下载、打印、摄像头、麦克风、定位、剪贴板自动读取和不必要权限；
- 官方页面占据除 safe area 和一个最小返回/连接状态浮层外的全部屏幕；不加 HRack 文案卡、重复 header 或第二套工作区选择器；
- 返回会话列表可以暂时隐藏同一个 WebView，保持当前 DSH page/session；主 room 断开、吊销、generation 变化或 App 明确退出 DSH 时销毁 WebView并清 Cookie；
- WebView 在 document-start 捕获官方 Cordis `sessions` service。点击手机列表中的 DSH 会话时调用官方
  `sessions.open(sessionId)`；从 `+` 进入新建时调用官方 `sessions.clear()`。捕获失败、目标不存在或超时必须
  显示可重试错误，不能静默停留在错误会话；
- App 后台时不假装在线。恢复时若主 Phone WSS 或 tunnel WebSocket 已失效，销毁旧 WebView并请求新 ticket；不能把旧页面的重试请求路由到新 room。

### 8.3 新建 DSH 会话

右下角 `+` 是所有新建操作的唯一入口。原生 `CreateSessionScreen` 在 AI CLI 卡片旁展示 DSH 卡片；选择后
立即打开同一个官方 WebView的空白 Home/新建态。工作区和 session 创建仍完全交给官方页面：用户打开
官方 browse dialog、浏览电脑文件系统并确认目录，再由官方 `session.create`/workspace API 建立会话。
HRack App 不提交自己的 `installationId/workspace/skipApproval` payload，也不把现有 CLI filepicker 强套给
DSH。会话列表不再常驻“官方 Web 控制台”装饰行。

## 9. 安全边界

1. **房间 URL 仍是控制权 bearer。** DSH ticket 只授予已经占据 Phone seat 的客户端，且进一步绑定 Desktop tunnel 和 DSH generation；它不是第二套账号登录。
2. **专用 origin 不公开 DSH。** 无有效 Cookie 时 `/`、`/assets`、`/plugins`、`/api` 和 WebSocket 均为 401/404；只有最小 health 可匿名。
3. **不做 SSRF。** path、method、headers 都先 guard；Desktop destination 永远由 ready DSH host 内部状态取得，客户端不得提交 scheme/host/port。
4. **不冒充 loopback。** 公网 Host/Origin 贯穿到 DSH trust fence；真实门禁必须证明 privileged RPC 仍被拒绝。
5. **用户插件代码按 DSH profile 原样送到手机。** 它与电脑本地官方页面具有同级普通 DSH API 权限，因此 bundle 只能私有缓存，不能在不同用户/房间之间共享 CDN cache。
6. **秘密不进日志。** roomId、ticket、Cookie、seat token、本地端口、API request/response body、完整 session/workspace path 均禁止记录；错误只用 request-free 类别和计数。
7. **HTML 与插件不是 Relay 自己的可信 UI。** Gateway 原样转发 DSH CSP/资源并补强 `Referrer-Policy`、`X-Content-Type-Options: nosniff`；不得注入 Relay dashboard token、App bridge secret 或任意管理能力。
8. **Cookie 不送 DSH。** Gateway 身份只在 Relay 终止；Desktop 收不到 ticket/Cookie，DSH 收不到房间信息。
9. **吊销必须贯穿所有层。** revoke 先让 App/Desktop 收到 `revoked`，同时终止 Cookie session、HTTP streams、event WebSocket 和 tunnel seat；旧 Cookie 不能等 TTL 自然过期。
10. **版本 fail closed。** DSH 的 route、trust、picker 或 wire 形状不满足预检时只显示 unavailable，不能通过关闭 Host fence、改成 `0.0.0.0` 或回退原生 picker“修好”。

## 10. 性能与缓存

- DSH tunnel 与主 Remote WSS 使用不同 socket、队列、buffer budget 和 metrics；任何 DSH 限流/断线不得触发 PTY `undrive`。
- Gateway 对可压缩静态正文支持流式 gzip/Brotli，但不能先把整个 4.5 MB 页面聚合进内存。
- 带 `?rev=<content-rev>` 的 `/assets` 与普通 `/plugins/*` bundle 响应可以设置 `Cache-Control: private, max-age=31536000, immutable`；`/plugins/events`、无 rev、根 HTML 和 `/api` 必须 `no-store` 或服从官方 SSE no-cache。
- ETag/If-None-Match 可以穿透，但缓存键至少包含 DSH public origin、Desktop tunnel generation、DSH boot revision 和完整 path；不得仅按包名跨房间缓存用户插件。
- 公网 HTTP/2 可以并发承载 WebView 的资源请求，Relay 到 Desktop 的单条 tunnel WSS 由 streamId 公平轮转；连续大 response 每轮最多发送一个 credit window，避免小 RPC 饥饿。
- 真实验证记录首次/缓存加载时间、传输字节、并发峰值、Relay/桌面最大缓冲和主 PTY ACK 延迟。首版目标是在既定公网实验环境中首次 15 秒内可操作、缓存后 5 秒内恢复；若网络条件不满足，结果必须记录环境与瓶颈，不能只延长测试 timeout。

## 11. 失败与恢复

| 情况 | 行为 |
|---|---|
| Desktop/Phone 主 seat 离线 | 立即关闭 DSH Web session 与 tunnel；App 主房间重连后取新 ticket；PTY 仍走原有 15 秒驾驶释放规则 |
| DSH host 重启/generation 变化 | 关闭旧 streams/Cookie，surface 先 starting；新 generation ready 后 App 请求新 ticket |
| Tunnel WSS 断开 | Gateway 终止对应 HTTP/WS；App 显示可重试错误；Desktop 指数退避重连，不重启 DSH |
| 只有静态页、API 403 | Desktop ready probe 失败，手机不得拿到 ticket |
| browse picker 缺失或仍是 native | surface unavailable；不允许远程创建工作区 |
| 单请求/缓冲超限 | 只 abort 该 stream；重复违规再关闭 Web session/tunnel，不影响主 Remote WSS |
| Relay 重启 | 现有 WebView 失败；主房间恢复并重新建立 Desktop tunnel 后请求新 ticket |
| App renderer 被系统回收 | 清理 Cookie/session，重新取 ticket；不能复用旧 WebView 的内存状态 |
| 房间 revoke | 所有 DSH 层立即关闭，旧 URL/Cookie 后续稳定 401/404 |
| DSH 版本不兼容 | 明确显示“当前 DSH 版本不支持远程网页”，不泄漏原始 stderr/路径 |

恢复永远从新 ticket 和当前 generation 开始；HTTP body、DOM 状态和未完成 RPC 不做跨 generation 重放。DSH 自己持久化的会话仍由 DSH 恢复，HRack 不复制存储。

## 12. 验收与真实测试

### 12.1 静态和自动门禁

- 三仓协议副本、type guard、方向白名单和未知字段策略一致；主 Remote v1 未支持 DSH 的旧客户端仍可配对和控制 PTY；
- ticket 一次性/过期/重放、Cookie seat/generation 绑定、revoke 立即失效；
- DSH virtual host 的匿名边界、method/path/header allowlist、无 SSRF、无开放代理；
- tunnel control 状态机、binary framing、sequence、credit、并发与聚合 buffer 上限；
- Host/Origin 精确保留，Gateway Cookie/Authorization/Forwarded 不进入 Desktop/DSH；
- Desktop overlay 不写用户 `$DSH_HOME`，browse/native client manifest 门禁；
- App WebView 同源导航、外链、权限、Cookie 隔离、generation 清理；
- DSH 大流量期间现有 PTY ACK/输入定向用例继续通过。

### 12.2 本机真实 DSH 接口门槛

测试必须启动电脑真实安装的 DSH Web profile，不使用假的 HTML、Memory API 或手写 directory fixture：

1. HRack 以随机 loopback 端口、trusted public authority 和 browse overlay 启动 DSH；
2. 用真实浏览器拉取根 HTML、全部 boot entries、assets/plugins，建立 `/plugins/events` SSE 与两条真实 WebSocket upgrade；
3. 用 trusted public authority 调用真实 `host.describe`、`session.list`、`workspace.list`、`host.listDirectory`；
4. 在临时 workspace 父目录中通过 browse API 看到真实目录并创建/选择一个测试子目录；
5. 证明 `host.pickDirectory`、settings/credentials 读写、`host.openPath` 等 privileged 调用仍被拒绝，且电脑没有弹出原生对话框；
6. 在这些预期 denial 存在时，真实官方页面仍无 fatal runtime error，能列出 workspace/session 并创建空白 session；如果当前 DSH 版本做不到，则标为 incompatible，不能改写 Host 为 loopback 放行；
7. Desktop 本机 DSH WebContentsView 同样能使用 browse picker；关闭测试后不残留 DSH 用户配置修改。

### 12.3 公网 Android 真实门槛

1. 使用正式 TLS/WSS 的真实 Remote Relay 与独立 DSH origin 创建临时房间；
2. 安装版 Android release App 加入真实 HRack Desktop，主会话列表出现 DeepSeek Harness 官方图标与 ready 状态；
3. App 请求真实一次性 ticket，顶层 WebView 从公网读取电脑当前 DSH 的真实 HTML、插件和 event WebSocket，不使用打包夹具；
4. 在手机官方 browse dialog 中从电脑 Home/磁盘逐层进入专用临时目录，创建或选择工作区；电脑端不出现原生目录对话框；
5. 在官方网页创建一条真实空白 DSH session，后端 `session.list` 与 workspace 权威状态出现对应 id/path；不提交模型 prompt、不产生模型费用；
6. 执行一个明确不调用模型的官方本地 UI 操作，并证明 event stream 到达手机；模型真实 prompt smoke 另做显式 opt-in；
7. 从公网尝试 privileged RPC，稳定被拒绝；尝试任意 loopback/绝对 URL proxy，稳定 404/400；
8. 同时驾驶一条真实 PTY 并加载/操作 DSH，记录 PTY input/ACK 没有被 DSH 首屏阻塞；
9. 返回列表后重进，缓存资源命中且仍是同一 DSH 会话；吊销房间后 WebView、Cookie、两条 event WS 与 Desktop tunnel 全部失效；
10. 清理测试 DSH session/workspace 只能通过测试明确拥有的临时对象，不能删除用户已有会话或目录。

### 12.4 发布门槛

- Android 物理真机和 iPhone/iPad 物理真机都完成真实公网 WebView、软键盘、safe area、后台恢复和外链测试；
- 自部署使用另一组域名/TLS 配置，证明 `dshPublicOrigin` 可配置且没有 `modplex.app` 硬编码；
- Nginx/上层代理支持 DSH origin 的 HTTP/2、两条公网 WebSocket、长响应流和 access-log off；
- 备份/恢复 Relay 后旧 ticket/Cookie 不复活，新 ticket 能连接恢复后的持久房间；
- 生产监控只记录健康、并发、字节、buffer/timeout/error 类别，不含 secret/path/body。

默认发布门槛仍要求 Android 与 iOS 物理真机。2026-08-24 项目所有者因当前无可用真机，明确将
**本次 DSH D5** 的关门口径改为正式生产域名上的 Android release 模拟器全链，并接受 OEM WebView、
safe area、物理软键盘、蜂窝网络切换、系统回收与 iOS 签名安装尚未覆盖的残余风险。真机项必须
继续标为未完成，后续补测；此例外不修改父 Remote P8 的物理真机关门条件。

不能用 `npm test`、静态截图、直接让手机访问同一局域网端口、把 DSH 改成 `0.0.0.0`、桌面浏览器本地页面或假的 filepicker 替代上述公网真实门槛。

## 13. 分段实施

这是独立 D 轨，不插入或重写 Remote P0–P8：

1. **D0 — Spec 与安全原型**：冻结本文；用真实 DSH 证明 public authority、browse picker、privileged denial 和完整资源/WS 形状。
2. **D1 — Desktop**：HRack-owned overlay、能力预检、surface state、固定目标 tunnel client；本机真实接口门槛通过。
3. **D2 — Server**：独立 origin、ticket/Cookie、tunnel seat、HTTP/WS multiplex、流控和部署路由；黑盒真实进程门槛通过。
4. **D3 — App**：独立 DSH surface、ticket 状态机、隔离 WebView、导航/权限/生命周期；Android 构建与本机 Relay 门槛通过。
5. **D4 — 公网 Android**：真实 TLS、真实 HRack/DSH、browse 工作区、空白 session、event stream、PTY 并行和 revoke 全链通过。
6. **D5 — 发布关门**：默认要求 Android/iOS 物理真机、自部署、监控/日志、备份恢复与发布清单完成；本次可按 12.4 的显式发布风险接受例外关门。

每一阶段失败后遵守根仓库 `AGENTS.md`：记录失败用例，只定向复跑失败项；定向通过且准备合并/发布时才跑一次完整回归。

## 14. 关键决定

1. 复用 DSH 官方完整 Web artifact，不重做 UI。
2. 使用独立 DSH public origin，不做子路径文本重写。
3. 手机使用顶层 WebView，不用 iframe、远程桌面或系统浏览器共享 Cookie。
4. Desktop 只出站连接 Relay；DSH 永远保持 loopback bind。
5. HTTP/API/event WebSocket 走独立 tunnel，不占用 PTY 主 WSS。
6. 公网 Host/Origin 保留到 DSH trust fence，绝不伪装 loopback。
7. 远程启用时统一强制官方 browse picker；不远程操纵电脑原生 file dialog。
8. DSH 网页仍是独立 surface；其被观察会话复用安全 `RemoteSession` 六态流，但点击必须进入官方
   WebView，绝不能落入 PTY `drive` 数据面。
9. ticket/Cookie 与 Phone seat、Room、Desktop tunnel 和 DSH generation 四重绑定；revoke 立即失效。
10. 第一版先放行文本会话和目录选择；附件、下载、原生能力和 privileged settings 后置并重新做威胁审查。

## 15. D0 实现与验证记录

D0 新增显式 opt-in 门禁 `e2e/remote-dsh-d0.spec.ts` 和固定原型 overlay `e2e/fixtures/dsh-remote-browse.patch.yml`。overlay 先禁用 auto picker，再同时挂载官方 browse host backend 与 browse client surface；只挂 host backend 会让 API 能浏览目录但 boot manifest 没有网页 picker，因此不能算远程能力完成。

门禁使用系统真实安装的 DSH `0.1.0-rc.7`，为每次运行创建独立临时 `DSH_HOME` 和随机 loopback 端口，不读取/修改用户现有 DSH profile、session 或 workspace。Chromium 通过 host resolver 以 `dsh.remote.test:<random>` 这个非 loopback authority 访问真实页面，DSH 以 `--trusted-host dsh.remote.test` 启动；Node HTTP 探针使用相同 Host/Origin 语义。

最终定向结果：

```text
[dsh-d0] version=real resources=46 bytes=4541867 http=50 ws=2 privileged=denied
1 passed (2.8s)
```

已证明：

- boot manifest 只有 `dsh-client-ui-directory-picker-browse`，没有 native picker；
- 46 个真实官方/插件资源全部通过 public authority 返回，合计 4,541,867 字节；
- `/plugins/events` SSE 和 `/api/events.host`、`/api/events.mux` 两条 WebSocket 都真实建立；
- `host.describe`、`session.list`、`workspace.list`、`host.listDirectory` 通过同一 public authority 成功；
- `host.pickDirectory`、`host.openPath`、`settings.describe`、`credentials.describe` 稳定为 403 `forbidden`，没有弹出电脑原生对话框；
- 412 × 915 官方页面在上述 authority 和权限边界下完成启动，body 可见且无 page runtime error；
- 根仓库 `npm run typecheck` 通过。

真实门禁命令：

```powershell
$env:HRACK_E2E_REAL_DSH=(Get-Command dsh.cmd).Source
npx playwright test e2e/remote-dsh-d0.spec.ts -g "D0 real DSH supports a trusted public browser without loopback privilege"
```

未设置 `HRACK_E2E_REAL_DSH` 时该用例明确 skip，普通开发机不会悄悄使用 fixture 冒充真实 DSH。D0 只冻结安全与 carrier 可行性；Desktop 产品实现、持久设置和 tunnel client 在 D1 完成。

## 16. D1 Desktop 实现与验证记录

D1 已实现桌面端产品链，而不是把 D0 测试脚本直接搬进产品：

- Remote 设置新增默认关闭、主进程原子持久化的“允许当前远控房间打开 DSH”显式开关；关闭时独立 tunnel 立即终止，PTY 主通道不受影响；
- 主 WSS `hello-ok` 可选携带规范 HTTPS `relayCapabilities.dshWebTunnel` 与 Desktop-only `dshSeatToken`；旧 Relay 省略字段时仍可照常完成 PTY 配对；
- HRack 在 `<userData>/dsh-runtime/remote-web.patch.yml` 生成自己拥有的顶层 YAML patch 数组，不写用户 DSH profile；启动参数固定为随机 loopback、browse overlay、Relay 公网 authority 和 `--no-open`；
- 产品 ready 门槛真实解析 boot manifest，验证 browse client 唯一且 native/auto 不存在，再调用普通 API、directory browse、4 个 privileged denial、SSE 与两条 event WebSocket；任一步不符只发布 unavailable/failed；
- `DshTunnelClient` 只消费当前 `DshHostManager` ready `baseUrl`，远端报文不能选择 scheme/host/port；HTTP/WS 路由与 header 均为 allowlist，公网 Host/Origin 保留，Cookie/Authorization/Forwarded/Set-Cookie 不进入另一侧；
- tunnel 使用独立 `ws` 产品依赖、32 KiB control frame、10-byte binary header、64 KiB payload、sequence、credit、16 MiB request、32 MiB response、512 KiB/stream 与 2 MiB/room buffer、HTTP/SSE/WS 并发上限及 stream generation 防复用；
- `RemoteWebSurface` 作为独立 `dsh-web` surface 发布，不混入 PTY session 或六态。

真实门槛使用系统安装的 DSH `0.1.0-rc.7`、独立临时 `DSH_HOME`、真实 Electron 主进程和本机测试 Relay。Relay 只模拟尚未进入 D2 的公网侧 carrier；HTML、插件、RPC、SSE、WebSocket、目录与 session 状态全部来自真实 DSH 进程。最终定向结果：

```text
[dsh-d1] runtime=real resources=46 bytes=4541867 privileged=denied session=blank tunnel=fixed
1 passed (6.2s)
```

这条门槛实际完成：

- 通过产品独立 tunnel 读取真实根 HTML、46 个 boot/assets/plugin 资源，共 4,541,867 字节；
- 建立 `/plugins/events` 长期 SSE 与 `/api/events.host`、`/api/events.mux` 两条真实本地 WebSocket；
- 通过公网 authority 调用 `host.describe`、`session.list`、`workspace.list`、`host.listDirectory`；
- 证明 `host.pickDirectory`、`host.openPath`、`settings.describe`、`credentials.describe` 仍为 403 `forbidden`；
- 在测试拥有的临时 workspace 创建真实空白 DSH session，不提交 prompt、不产生模型费用；
- 证明 overlay 位于 HRack userData runtime 目录、开关已落入 `main-prefs.json`，选定 DSH_HOME 没有新增 patch；
- `npm run typecheck`、产品 build、协议/allowlist 门禁、Remote 设置显式 opt-in 回归通过。

真实门禁命令：

```powershell
$env:HRACK_E2E_REAL_DSH=(Get-Command dsh.cmd).Source
npx playwright test e2e/remote-dsh-d1.spec.ts -g "D1 Desktop carries real DSH"
```

D1 真实复跑还捕获并修复了三个不能由普通 mock 暴露的问题：产品 overlay 必须是顶层 patch 数组；`ws` 必须作为产品依赖被 externalize，不能由主进程 bundler 错误内联 optional buffer adapter；最后一个 response frame 的反向 credit 可能晚于 `http-end` 到达，必须由 TIME_WAIT stream 吸收，不能误判成未知流关闭整条 tunnel。

## 17. D2 Server 实现与验证记录

D2 已在 `hrack-remote-server` 完成独立 Server carrier：

- `DSH_PUBLIC_ORIGIN` 为显式可选、规范 HTTPS 且必须不同于平台 origin；未配置时旧客户端、旧房间和 PTY Relay 行为不变，也不发布 DSH capability；
- Desktop 主 seat 获得短期、绑定当前 connection 的随机 `dshSeatToken`，专用 `{base}/v1/dsh-tunnel` 第一帧完成 room/seat/token/唯一 tunnel 校验；
- Phone 的 `dsh-ticket-request` 由 Relay 自己消费，不转发 Desktop；ticket 为 256-bit CSPRNG、摘要存储、一次性且最长 30 秒；
- 独立 DSH virtual host 的 `/_connect/<ticket>` 设置 `__Host-hrack-dsh`（`Secure; HttpOnly; SameSite=Strict; Path=/`）并 303 到根页面；Cookie 同时绑定 Phone connection、Room、Desktop connection、tunnel generation 和 DSH surface generation，掉线、generation 变化与 revoke 都立即失效；
- 公网 route/method/header 为双层 allowlist；匿名只开放 `/_healthz`，绝对 URL、重复编码穿越、反斜杠、NUL、`CONNECT`/`TRACE` 和未知 route fail closed；Cookie、Authorization、Forwarded 与本地 `Set-Cookie`/Server 不穿 tunnel；
- HTTP、SSE 和两条 event WebSocket 经独立二进制 tunnel 多路复用，落实 32 KiB control、64 KiB frame、sequence、credit、16 MiB request、32 MiB普通 response、64 HTTP/1 SSE/2 WS、512 KiB/stream、2 MiB/room 及 header/idle/首响应超时；
- 带 content revision 的静态资源只允许 `private, immutable`，其余根页面/API 为 `no-store`、SSE 为 `no-cache`；`Accept-Encoding` 可穿透到真实 DSH，正文保持流式而不在 Relay 聚合；
- Compose/TLS 示例增加第二 DSH virtual host；宿主反代模式使用独立 8789 loopback 入口，整段 access log off，不能把 DSH 退回 `/remote/...` 子路径。

构建后真实进程门禁不是进程内 mock：它启动 `dist/server/cli.js`，建立主 Desktop/Phone seat 和独立 tunnel，消费一次性 ticket/Cookie，经 tunnel 传输与 D1 实测首屏同量级的 4,541,867 字节正文，建立两条公网 event WebSocket，随后 revoke 并扫描日志：

```text
[dsh-d2] process=dist httpBytes=4541867 websocket=2 ticket=one-use revoke=closed logs=clean
```

合并门禁结果：Server `npm test` 为 Relay 39 项、Web 131 项、Nginx 5 项、Ops 4 项全绿；Server `npm run typecheck`、完整 build、`docker compose --profile host-edge config --quiet`、真实 Nginx `-t` 与根仓 DSH protocol 4 项门禁均通过。Nginx 第一次隔离校验因测试容器没有 `relay` DNS 记录失败，使用同一配置并只补测试解析后 `nginx -t` 成功；没有通过改写配置掩盖问题。

D2 证明的是 Server carrier 和边界，不把 fixture Desktop 冒充真实 DSH。真实 DSH HTML/API/SSE/两条 WS/privileged denial 已由 D1 关门；App 控制面、本机真实 Relay 与 Android release 构建已由 D3 关门，完整公网真 DSH 手机链仍只属于 D4。

## 18. D3 App 实现与验证记录

D3 已在 `hrack-remote-app` 完成手机产品控制面与原生 WebView 边界：

- App 同步 D2 协议后，只从认证 `hello-ok.relayCapabilities` 接受规范 DSH public origin；D3 当时把
  `RemoteWebSurface` 作为独立列表入口。该早期展示模型已由 2026-08-25 增量勘误替代：surface 只保留
  capability/generation，DSH 会话进入安全六态流，官方新建入口进入右下角 `+`；
- `RemotePhoneClient` 维护 capability/surface generation 与唯一 pending ticket；只有主 Phone seat ready、Desktop 在线且 surface ready 时才能向 Relay 发送 `dsh-ticket-request`，响应必须 requestId 关联、未过期、与精确 public origin 和当前 generation 一致；跨 origin、过期、断线或 generation 变化全部 fail closed，票据不落入 SecureStore、配对记录或 preference；
- 顶层 WebView 使用 incognito/non-shared Cookie、禁止第三方 Cookie、mixed content、file/content/intent/custom scheme、下载、新窗口、全屏媒体、摄像头、麦克风、定位、打印和剪贴板自动读；精确 origin 由 App 自己的 navigation callback 执行，不能使用库的窄 `originWhitelist`，因为后者会在 callback 之前把拒绝 URL 自动交给系统浏览器；
- 外部 HTTP(S) 链接只有网页真实 click 被注入 guard 捕获后，才出现 native 确认；普通 JS 跳转、iframe 或自定义 scheme 不能借系统浏览器逃逸；
- 返回列表只隐藏并保持同一个 WebView；主房间断开/revoke、surface unavailable/generation 变化、renderer 失败、明确长按退出或 App 进入后台都会销毁 WebView；
- Android App 本身已有扫码 `CAMERA` 权限，而 stock `react-native-webview` 会把已授予权限交给网页，且 incognito 只在创建时清 Cookie。仓库 patch 因此在原生层拒绝 incognito 下载/媒体授权，并在创建和销毁时清 Cookie、WebStorage、cache/history/form data；`postinstall` 自动应用，release 构建实际编译该 Java/Kotlin 代码。

最终 App 门禁：

```text
Protocol parity passed
Terminal parity passed
HRack UI parity passed
11 Jest suites / 51 tests passed
[dsh-d3] app=RemotePhoneClient relay=dist surface=independent ticket=one-use page=82 revoke=cleared logs=clean
Android assembleRelease: BUILD SUCCESSFUL
```

`npm run verify:dsh-d3` 不是进程内 mock：它构建并启动 Server 子模块的 `dist/server/cli.js`，用产品 `RemotePhoneClient` 建立 Phone seat，用独立 Desktop tunnel 发布 DSH surface，申请并消费真实一次性 ticket/Cookie，经实际 Relay HTTP/tunnel 路径读取 HTML，重放 ticket 得到 404，随后 revoke 并证明 App DSH state、Cookie session 和 tunnel 一起失效，日志中没有 room/token/ticket/Cookie。Android release 门禁产出约 93 MB 的 `app-release.apk`，原生 WebView patch 编译通过。

D3 的 HTML tunnel 端使用确定性 fixture，只证明 App + 真实 Server carrier，不把它冒充“手机已访问真实 DSH”；真实 DSH 资源/API/SSE/两条 WS 与安全拒绝已在 D1 验证。D4 必须在真实 TLS 公网域名上，用 Android App、真实 HRack Desktop 和真实 DSH 完成二者的组合链，才能宣称手机远程 DSH 可用。

## 19. D4 公网 Android 实现与验证记录

D4 使用已安装 Android release App、Android x64 模拟器、真实 Electron 主进程、系统安装的 DSH `0.1.0-rc.7`、生产 Remote WSS 与独立公网 TLS DSH origin 完成组合链。DSH 临时 origin 使用公开受信的 Let's Encrypt 证书；最终 `dsh.hrack.modplex.app` 在服务器公共解析器上仍无记录，因此本节不把临时 origin 冒充最终生产域名，正式域名切换保留到 D5。

定向门禁 `e2e/remote-dsh-d4-android-live.spec.ts` 实际完成：

- Android 从认证会话列表进入 `DeepSeek Harness`，经一次性 ticket/Cookie 从公网加载电脑上真实 DSH 的官方 HTML、插件、SSE 和两条 event WebSocket，没有使用 App 内置 HTML 或测试网页；
- 官方 browse picker 在手机上浏览电脑目录，选择测试拥有的临时 workspace；电脑没有出现原生目录对话框；随后创建真实空白 DSH session，并用本地权威 `session.list` 核对 id/cwd，不提交模型 prompt；
- ticket 首次顶层导航得到 303 与 `Secure; HttpOnly; SameSite=Strict` Cookie，重放得到 404；公网 `settings.describe` 为 403，伪造 loopback/绝对 URL proxy 为 404；
- 返回列表再进仍是同一个 WebView/DSH workspace，缓存恢复为 4,462 ms，低于 5 秒目标；首次免责声明到可操作 Home 为 15,852 ms，含 Android UIAutomator 轮询与一次人工式 Continue 操作，略高于 15 秒目标，按实记录且未扩大 timeout 冒充性能通过；
- 保持两条 DSH event WebSocket 打开时，同一个 Phone seat 同时 drive 一条真实 ConPTY，远程输入到桌面权威 history/ACK 为 393 ms，ACK 385 字节；DSH 数据面没有阻塞 PTY 主 WSS；
- 关闭 Desktop 的 DSH opt-in 后，现有 Cookie 变为 401、两条 event WebSocket 均以 1001 关闭、Desktop tunnel/surface 进入 unavailable，而 PTY 仍保持 driven，证明两条数据面和失效边界独立；D2 构建后黑盒另已用真实 room revoke 证明 seat/ticket/Cookie/tunnel 全关。2026-08-24 又在已登录生产控制台执行了当前账号稳定 URL 的真实轮换：旧地址立即返回 `Room unavailable`，新地址进入有效配对页，证明账号级 revoke/rotate 已贯穿公网入口；完整 URL 未写入日志、文档或提交。

最终真实输出：

```text
[dsh-d4-red] webview=ready firstLoadMs=15852 cacheReentryMs=4462
blankSession=created ticket=one-use privileged=denied websocket=2
pty=driven ptyAckBytes=385 ptyInputAckMs=393
invalidation=cookie+websocket+tunnel ptyAfterInvalidation=driven
1 passed (1.5m)
root full regression: 339 passed / 22 skipped / 0 failed (4.6m)
```

D4 真实复跑额外捕获并修复了普通 mock 无法暴露的协议问题：官方 boot graph 同时请求 40+ plugin bundle，原 16 HTTP stream 上限会让页面报 `Failed to load plugins`，现调整为 64 且不扩大字节预算；Phone teardown 与已完成 stream 的迟到帧必须按本代 tombstone 幂等丢弃，未知 id 仍 fail closed；真正协议错误必须走有界重连；WebSocket 的 1005/1006 等保留关闭码不能传给 Node `ws.close()`，Relay 与 Desktop 现统一归一为 1001，协议解析器拒绝 1004/1005/1006/1015 和 1016–2999。对应确定性回归在 `e2e/remote-dsh-protocol.spec.ts` 与 Server `relay/test/dsh-gateway.spec.ts`。

## 20. D5 发布关门执行记录

D5 已在 2026-08-24 按 12.4 的显式发布风险接受例外关门，逐项状态见
[D5 发布清单](./CHECKLIST-REMOTE-DSH-D5.md)。Server `e5453ca` 已部署到生产主机：

- `production-monitor` 同时检查平台与独立 DSH origin 的受信 TLS/健康接口，现网连续报告 `ok=true`；Relay `runtime-metrics.dsh` 只含健康、并发、buffer、双向字节和五类错误计数，不含 origin/path/room/ticket/Cookie/body；
- 使用与 `modplex.app` 无关的公开 sslip.io 域名、Let's Encrypt 证书和 `DSH_PUBLIC_ORIGIN` 完成另一组真实域名/TLS 配置验证；生产 DSH 实现未硬编码 `modplex.app`；
- `dsh.hrack.modplex.app` 公共 DNS 已指向生产主机，正式 ECDSA 证书有效期至 2026-11-22；主机名校验、ALPN `h2`、证书续期复制/配置检查/热重载钩子均实跑通过；
- Relay 与生产监控已切换到正式 `DSH_PUBLIC_ORIGIN`；正式域名 `/_healthz` 返回 200，匿名根路径返回 401，监控的 `public-dsh-tls` 与 `public-dsh-health` 均为 `ok=true`；
- 运行中的 OpenResty 配置在 server/location 两层均为 `access_log off`，并关闭 request/response buffering、保留一小时流超时；正式入口已真实承载完整 boot graph 与两条 event WebSocket；
- 新增重启组合门禁：恢复同一持久房间后，上一代未消费 ticket 为 404、Cookie 为 401，重连 Desktop/Phone/Tunnel 后新 ticket 为 303；生产又创建 32,597 字节备份并在隔离卷通过 SHA-256、SQLite `integrity_check=ok` 与 11 张表检查；
- 当前账号轮换后的稳定房间在新 Relay 与协调器恢复后仍进入有效配对页，完整地址未写入文档或日志。
- App `1c427d0` 修复了后台生命周期：进入后台不再无条件销毁仍有效的 DSH WebView，回到前台只在主 Phone 状态、Desktop seat、origin、surface state 或 generation 已失效时退出；`6104b20` 又验证只有用户确认后才调用系统外链。重新构建安装的 Android release 在正式生产公网完成同一全链，增强门禁明确指定设备、确认官方路径框唤起系统软键盘，并以 `device=emulator` 标记证据；Home 退后台再恢复到同一 WebView/工作区为 5,003 ms，本轮首次加载 18,378 ms、列表重进 4,519 ms；两条 event WebSocket 与真实 PTY 并行，PTY 输入 ACK 为 375 ms、385 字节。
- 物理模式会强制拒绝 `ro.kernel.qemu=1`，因此仍不把模拟器冒充物理真机。iOS Hermes/资源导出另已通过，共 5 个产物、3,638,632 字节；它只证明跨平台 bundle 可生成，不代替 Xcode 签名安装和 iOS 真机行为。

正式域名最终门禁输出：

```text
[dsh-d4-red] origin=https://dsh.hrack.modplex.app device=emulator
firstLoadMs=18378 cacheReentryMs=4519 backgroundResumeMs=5003
blankSession=created ticket=one-use privileged=denied websocket=2
pty=driven ptyAckBytes=385 ptyInputAckMs=375
invalidation=cookie+websocket+tunnel ptyAfterInvalidation=driven
1 passed (2.0m)
```

当前仍没有 Android 物理真机和 iPhone/iPad，实体设备条目保持未完成。项目所有者已明确要求本次以
模拟器收尾并接受 12.4 所列残余风险，因此 D5 按发布决策关门；这不构成 Android/iOS 真机通过声明，
也不改变父 Remote P8 的物理真机关门条件。后续取得设备后应补跑同一门禁和 iOS 人工矩阵。

## 21. 手机与桌面 DSH 会话统一投影（2026-08-25）

本轮修正了 D3 的“手机只常驻一个官方控制台入口”模型，同时保留单 WebView 的性能边界。实现过程中曾把
完整 `session.list` 误当成手机目录；该语义会重放全部历史会话，已在同日审查中撤回并改为桌面监听镜像：

- `DshSessionProjector` 的 `session.list` 只恢复已监听 slot 的状态，`events.host/events.mux` 只更新这些
  slot；Remote Desktop 直接订阅桌面 renderer 同源的 `DshProjectionBridge`，不会枚举 projector cache；
- 手机会话列表展示真实 DSH session、官方图标、六态和桌面同源 detail；点击 DSH 行不会误入 PTY
  `drive`，而是让常驻 WebView 的官方 `sessions.open` 选择对应 session；
- 原“官方 Web 控制台”常驻行已删除。右下角 `+` 的新建页把 DSH 放在第一张卡片；进入时执行官方
  `sessions.clear`，目录选择和创建仍由官方网页完成；
- 手机创建产生的 `host/session-added` 会为桌面建立确定性展示项，并同时经远程会话增量回到手机；
  手机不重复直连另一套 host/mux 监听器。

原先“手机先看到既有历史会话”的验证结果正是错误语义的证据，不计入通过项。勘误后的真实门禁已重新使用
生产 Remote WSS、正式 DSH TLS origin、最新 Electron dev 与 Android 模拟器执行：连接时电脑保存了多条
官方历史 session，但 HRack 监听投影为 0，App 明确显示“暂无会话”；随后从手机 `+` 第一张 DSH 卡进入
官方 Home 并新建最小任务，`host/session-added` 使桌面只建立该条监听，App 也只出现这一行并显示
`已完成`、`本轮任务已完成 · 46 tokens`。再次点击该行后，单例 WebView 的官方 `sessions.current` 精确等于
新 session id。

本次全新 WebView 首次加载还暴露了 Android 注入时序：官方内联 bootstrap 可能先创建
`window.__ModuleLoader__`，旧捕获脚本随后会用空 getter 覆盖它。现改为保留并补丁已经存在的 loader，并加入
确定性回归；官方插件完整启动且 Cordis sessions capture ready。最终根仓 projector/remote source 11 项、
根仓 node/web typecheck、App DSH WebView 9 项与 App typecheck 均通过。Electron 视觉与 DOM 证据由
Playwright 直接附着主 renderer 取得；Android 页面状态由 App UI tree 与该 WebView 自身 CDP 取得，没有
使用整桌面截图或无关窗口作为证据。
