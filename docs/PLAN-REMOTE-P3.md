# P3 — 真实列表通路联调

> 状态：**计划已批准，实施中（2026-08-20）**。对应 [SPEC-REMOTE.md](./SPEC-REMOTE.md) §11 P3。
>
> 前置：P0/P1/P2 已关门；P2 公网环境为 `https://hrack.modplex.app/remote/`。P3 只连通既有模块，不扩展 v1 协议。

**人能验收什么：** 在真实中继网页创建房间，把网页给出的完整 URL 粘贴到构建后的 HRack；手机夹具经同一部署的 WSS 加入后，收到真实 Electron/`AgentSessionRuntime`/PTY 会话列表；HRack 页面显示的二维码从像素解码后严格等于该 URL。

---

## 1. 交付边界

### 做

- 用真实中继生成页创建房间，不在测试里伪造 room 或拼接 roomId。
- 构建并启动真实 Electron，通过 Home 正常创建 fixture AI CLI，使会话进入真实 `AgentSessionRuntime` 和 PTY。
- 通过 HRack 设置页粘贴、确认加入 URL，让桌面端使用生产 `RemoteDesktopClient` 出站。
- 手机夹具从同一 URL 推导 WebSocket URL，完成真实 `hello` 并观察 `sessions-snapshot`。
- 对 HRack 设置页二维码截图做独立像素解码，严格比较规范化加入 URL。
- 同一条黑盒门禁分别对本机 HTTP 子路径部署与公网 HTTPS/WSS 部署执行。
- 无论门禁成功或失败都吊销测试房间并关闭 Electron/PTY/手机连接。

### 不做

- 不新增、修改或兼容任何 v1 业务报文。若真实联调发现协议不一致，回退 P0 修权威协议及双仓库 fixture。
- 不做 `drive`、PTY 字节流、远程新建、catalog；这些分别属于 P4/P5。
- 不创建 React Native 或 Flutter App；原生 App 从 P6 开始，技术栈按已确认方案使用 React Native + TypeScript。
- 不把中继实现复制进 HRack，也不把本机 `RemoteTestRelay` 冒充 P2。
- 不用 `MemorySessions`、renderer 注入列表或 DOM 属性代替真实会话与二维码解码。
- 不在默认回归里创建公网房间。公网门禁必须显式给出目标 URL。

---

## 2. 模块、seam 与 interface

P3 不增加新的产品 module。它只通过三个已存在的外部 seam 验证整条纵向切片：

| seam | 使用的公开 interface | 黑盒观察 |
|---|---|---|
| 中继网页 | 生成页按钮、加入 URL、吊销按钮 | 真实 HTTP 创建/吊销与部署给出的规范 URL |
| HRack 设置 | URL 输入、风险确认、连接状态、二维码 | 真实 Electron 发 desktop `hello`；二维码像素解码 |
| 手机协议 | `{base}/v1/ws` + v1 `hello` | `hello-ok` 与来自真实 Runtime 的 `sessions-snapshot` |

`RemoteDesktopClient` 继续是桌面远程 module 的深 interface：URL 解析、WSS 生命周期、会话订阅和 snapshot 发送留在实现内部。测试不得读取它的私有 socket、缓存或订阅器。

---

## 3. 可重复的真实门禁

新增 `e2e/remote-p3-live.spec.ts`，只有设置 `HRACK_REMOTE_P3_URL` 时才执行。变量必须是中继生成页的完整 URL，例如：

```powershell
$env:HRACK_REMOTE_P3_URL = 'http://127.0.0.1:8788/remote/'
npx playwright test e2e/remote-p3-live.spec.ts

$env:HRACK_REMOTE_P3_URL = 'https://hrack.modplex.app/remote/'
npx playwright test e2e/remote-p3-live.spec.ts
```

门禁步骤固定为：

1. Chromium 打开生成页并点击建房，读取页面实际展示的加入 URL；
2. 启动构建后的 Electron，以 fixture observer 和本机真实 PTY 创建一条命名会话；
3. HRack 设置页粘贴同一 URL，独立解码设置页二维码并比较；
4. 用户确认后等待 desktop 占座，手机夹具按 URL 推导的 WSS 地址加入；
5. 断言手机收到的 snapshot 包含刚创建的真实 sessionId、名称、workspace 和非伪造的六态；
6. 网页吊销房间，断言手机收到 `revoked`，再关闭所有进程和连接。

公网门禁不打印加入 URL、roomId 或吊销 token。失败工件若包含页面截图，只允许短期留在本机 `test-results/`，不得提交。

---

## 4. TDD 纵向切片

1. **Red：真实部署列表门禁。** 先提交/运行上述黑盒用例；它必须能因缺少二维码真实解码能力、URL/base 错误、WSS 配对失败或 snapshot 不是实际 Runtime 会话而失败。
2. **Green：只补联调暴露的最小缺口。** 允许修改 URL/base、部署适配和测试依赖；不提前实现 P4/P5。
3. **第二次 Green：本机与公网各跑一次。** 本机验证可重复性，公网验证 CA、反代、WSS 与真实 HRack 的最终路径。
4. **记录结果。** 把日期、目标类型、真实会话来源、二维码解码和 snapshot 结果写回本文件；不保存秘密值。

测试只跨 §2 已确认的 seam，不穿透 RelayCore、RemoteDesktopClient 或 AgentSessionRuntime 私有实现。

---

## 5. 验收矩阵

| SPEC P3 验收 | 本机 HTTP | 公网 HTTPS/WSS | 证据 |
|---|---:|---:|---|
| 网页生成 URL → HRack 粘贴确认 → 手机同 URL 入房 | 必须 | 必须 | 网页、Electron、Node WSS 同一用例 |
| snapshot 来自真实 HRack 会话 | 必须 | 必须 | 正常 UI 创建；按 Runtime 返回的 sessionId 断言 |
| HRack 二维码解码等于输入 URL | 必须 | 必须 | 元素截图 + `jsqr` 独立像素解码 |
| 子路径 base 正确 | `/remote` | `/remote` | 只从加入 URL 推导 WSS，不硬编码 |
| 失败后无遗留房间/进程 | 必须 | 必须 | `finally` 吊销、关闭 socket/Electron |

---

## 6. 关门条件

P3 只有同时满足以下条件才完成：

- 新增门禁先出现有意义的失败，再以最小改动转绿；
- 本机真实 P2 进程执行通过，不使用 HRack 内置测试中继；
- 公网 `https://hrack.modplex.app/remote/` 执行通过，且真实走 TLS/WSS；
- snapshot 可追溯到本次 Electron 正常创建的真实 Runtime/PTY sessionId；
- HRack 二维码经像素解码严格等于网页加入 URL；
- 房间被确认吊销，相关连接和 Electron 均关闭；
- 相关 typecheck/build 与定向回归通过，文档记录真实结果并提交。

P3 关门后进入 P4（桌面驾驶）；P6 才开始 React Native App 的扫码与列表界面。

---

## 7. 实现与验证记录

待执行后填写。未完成本机和公网两档真实门禁前，不得把本节改成“P3 已完成”。
