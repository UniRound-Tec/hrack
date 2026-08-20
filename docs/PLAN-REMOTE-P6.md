# HRack Remote P6 计划：原生 App 扫码、等待态与会话列表

> 状态：2026-08-21 开始实施。P3 公网列表链路、P4 驾驶与 P5 新建均已关门；本阶段只关闭 P6，并为 P8 完成可运行的终端技术预检。

## 1. 目标与关门定义

在独立仓库 `hrack-remote-app` 建立可发布的 Android/iOS App。用户扫描 relay 或 HRack 显示的完整加入 URL 后，App 作为唯一 phone seat 连接同一 WSS 房间：电脑未连接时显示等待态；电脑已连接时显示真实 AI CLI 会话与六态，并实时处理 snapshot/upsert/remove。

P6 关门必须证明：

1. Camera QR 和手动粘贴都只接受协议允许的完整 HTTP(S)/WS(S) 加入 URL；
2. App 发出的第一帧是 `hello role=phone`，等待电脑时不伪造列表、不尝试拉起 HRack；
3. 真实公网房间中，列表与桌面 `AgentSessionProjection` 一致，六态增量能更新；
4. `occupied`、`bad-key`、`revoked`、电脑离线、网络断开和重连都有互不混淆的 UI；
5. App 的协议副本与 HRack 当前权威源码一致，并有自动 parity gate；
6. Android 模拟器安装的真实 App 经公网 WSS 通过，并保留截图；
7. P8 技术预检能运行固定 xterm/字体/palette/renderer/IME/尺寸诊断。没有 iOS 真机证据前只能记录 Android ready，不能把 P8 标成全平台 ready。

P6 不发送 `create`、`drive` 或任何 `pty-*`。P7/P8 分别在后续计划和提交中开放这些方向。

---

## 2. 框架决定

选择 **Expo SDK 55 + React Native + TypeScript**，不是 Flutter：

- Camera 扫码使用 Expo 官方 `CameraView` 和 barcode scanner，Android/iOS 权限由 config plugin 声明；
- 页面、状态卡、列表和导航使用原生 RN 控件，避免把整个 App 做成网页壳；
- P8 的终端通过 `react-native-webview` 加载 App 内打包的本地 HTML/JS/font 资源；
- WebView 内继续使用 HRack 锁定的 `@xterm/xterm`、WebGL addon、Maple Mono 四字体和完整 palette，复用浏览器控制器已验证的 renderer/字体/ack 经验；
- 原生层与 WebView 只交换有界 JSON envelope。PTY base64 在 WebView 内解为 `Uint8Array`，xterm `write` 回调完成后才回传 ack。

Flutter 本身可用，但 `xterm.dart` 会形成独立 parser、renderer、font metrics 和 IME 行为，需要重新证明与桌面 xterm 等价；当前目标更适合复用已验证实现。Expo 不依赖 EAS 云服务：Android 构建、安装和测试均在本机完成。

冻结版本必须进入 lockfile；P8 开始时 parity gate 从 HRack lockfile 读取权威版本，不自行升级。

---

## 3. 仓库与模块边界

新建独立 Git 仓库：

```text
hrack-remote-app/
  app/                  原生页面与路由
  src/protocol/         HRack remote v1 的字节一致副本与 parser
  src/remote/           phone WebSocket 状态机，不依赖 React
  src/features/pairing/ 扫码、粘贴、敏感 URL 保存/清除
  src/features/sessions/列表投影与六态 UI
  terminal/             P8 WebView 源码；P6 只实现离线技术预检
  scripts/              协议与终端资源 parity gate
  docs/                 阶段验证记录
```

App 不引用 HRack 主进程、Electron IPC 或 relay 内部对象。三个仓库通过冻结协议和 parity 脚本协作，仍可独立发布。

### 3.1 `RemotePhoneClient`

公开接口只暴露：

- `connect(joinUrl)` / `disconnect()` / `retry()`；
- 不可变 `RemotePhoneState` snapshot；
- state subscriber；
- P6 内部只消费 relay control 与 `sessions-*`，未到期的桌面报文通过 parser 后忽略，不触发隐藏功能。

状态至少区分：

```text
idle → connecting → waiting-desktop → ready
                  ↘ occupied | bad-key | revoked | offline
```

`hello-ok.peer.desktop=false` 进入等待；`peer-join desktop` 后仍等待权威 snapshot；只有 `sessions-snapshot` 才进入 ready。`peer-leave desktop` 清空可见会话并返回等待，不保留一份看似在线的旧列表。

网络异常保留加入 URL并提供显式重试；revoke/bad-key 清除已保存秘密。P6 不做后台常驻或推送。

### 3.2 React UI

- Pairing：品牌说明、扫码主按钮、手动粘贴备用入口；输入框默认隐藏完整 room secret，只有用户主动编辑时显示；
- Waiting：明确“等待电脑连接”，提供忘记房间；
- Sessions：会话名、CLI 图标/adapter、工作区、六态、attention/tool 摘要和最后活动；
- Error：occupied、无效/已撤销、网络离线分别给出可执行动作；
- Session row 在 P6 不进入驾驶，显示后续阶段提示；终端预检只从开发/诊断入口打开，不冒充真实会话。

所有核心控件提供稳定 testID/accessibilityLabel，供 Android UI 自动化与截图定位。

---

## 4. 安全与数据约束

- 复用 `parseJoinUrl`：生产加入 URL 必须为 HTTPS/WSS；HTTP/WS 只允许 loopback 测试；
- roomId/完整 URL 不写日志、不写截图标题、不放 analytics；
- 若跨启动保存加入 URL，使用系统安全存储，不用 AsyncStorage 明文；
- 外部 WebSocket 帧先检查 1 MiB 上限再 JSON parse，再走完整协议 guard；
- 收到方向不合法或畸形帧不进入 reducer；连续协议错误转为可诊断断开，不展示 payload；
- 列表只保存远程协议允许的低敏字段；电脑离线立即清空；
- Camera 权限拒绝不阻塞手动粘贴；不请求麦克风权限。

---

## 5. P8 技术预检

P6 随 App 打包一个不连接 PTY 的 diagnostics 页面，使用确定性 fixture 验证：

1. Maple Mono Regular/Bold/Italic/BoldItalic 与许可证均离线加载；
2. HRack Dark 完整 palette、xterm core/WebGL addon 精确版本与来源 commit 可读取；
3. 字体 ready 后才 open/fit，报告真实 cols/rows、safe-area/viewport/keyboard/rotation 变化；
4. WebGL 成功、初始化失败和 context loss 后 DOM fallback 均可观测，返回按钮始终在 WebView 外原生层；
5. fixture 覆盖块元素、box drawing、ASCII 列、中文双宽、四种 style、16 色和 alternate screen；
6. IME 记录 composition start/update/end，只把 commit 后文本上报诊断层；Esc/Ctrl/Tab/方向键序列可断言；
7. `scripts/check-parity.mjs` 比较 HRack 协议 SHA、xterm 版本、palette 和字体清单。

Android 模拟器的自动断言与截图是本机检查点；按照呈现契约，iOS 与 Android 物理真机视觉证据仍是 P8 最终关门条件，不用模拟器结果替代。

---

## 6. 验证层次

### A. 纯状态机

- URL parser、帧上限、方向过滤；
- hello/waiting/snapshot/upsert/remove/peer-leave；
- occupied/bad-key/revoked/offline/retry；
- 第二个 phone 被拒绝。

### B. React 页面

- 相机权限、扫码回调和手动 URL；
- waiting/list/error 的可访问状态；
- 六态更新不会重建/错绑其它 session row。

### C. 本机 relay 接口

使用真实构建 relay 与两个真实 WebSocket seat；App 状态机不能用私有字段或 reducer 注入绕过网络。

### D. Android 模拟器 + 公网

1. 启动 Pixel 6 / Android 16 x86_64 AVD；
2. 安装本地构建 App；
3. 公开 relay 建房，真实 HRack Electron 入座并运行至少两个真实 AgentSession；
4. App 经 `https://hrack.modplex.app/` 对应 WSS 加入，UI 显示真实列表；
5. 改变桌面会话状态，App 行状态实时更新；
6. 断开电脑后 App 清空并显示等待；第二 App/夹具 phone 得到 occupied；
7. 截取 pairing、waiting、sessions、状态变化和终端预检页面，并人工检查裁切、safe area、字体和层级。

不能用网页控制器截图、React mock 数据或 Node 夹具列表替代模拟器 App 的最终证据。

---

## 7. 分段提交

1. HRack：`docs: plan remote P6 app`；
2. App：`chore: scaffold remote app`；
3. App：`feat: complete P6 pairing and sessions`；
4. App：`feat: add terminal readiness preflight`；
5. App：`docs: record P6 Android public validation`；
6. HRack：`docs: close remote P6 app`。

每个提交前运行与该切片直接相关的自动门禁。最终完整 App 测试、Android release/debug 构建和公网模拟器验收只在 P6 关门前运行一次。
