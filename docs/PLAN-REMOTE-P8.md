# HRack Remote P8 计划：App 真实终端

> 状态：2026-08-21 已完成 Android 16 模拟器 + 安装版 release App + 公网真实 PTY 检查点；Android 物理真机中文 IME、iOS 真机和两款真实 AI CLI 仍未完成，P8 尚未全平台关门。

## 1. 目标与关门定义

P8 让用户从 App 会话列表点进真实终端，也让手机新建的会话直接进入同一终端：WebView 中固定版本 xterm 复读桌面 PTY history 和 live output，手机输入写回同一 PTY，旋转/键盘变化更新唯一 winsize，返回列表可靠 `undrive`。

实现关门必须证明：

1. 字体 ready、WebGL/DOM renderer 和真实 cell measurement 完成后才发送 `drive`；不再用 P7 的 80 × 24 过渡尺寸；
2. `drive-ok.history` 严格按 sequence 复读；复读期间到达的 live `pty-out` 留在 WebView 有界队列中，不能越过 history；
3. live base64 直接解为 `Uint8Array` 写入 xterm，不逐块转 UTF-8 字符串；只有 xterm `write` callback 完成后，原生层才发送同字节数 `pty-ack`；
4. xterm `onData`、附加键与中文 composition commit 经 `pty-in` 回到真实 PTY；组合阶段不发送拼音逐键；
5. WebView fit 报告的 cols/rows 是显示和 PTY 的唯一尺寸；容器、键盘或旋转变化只在尺寸实际改变时发送 `pty-resize`；
6. 返回、桌面抢回、session exit、peer leave、revoke、WebView 失败都会结束本地 terminal 状态；能发送时返回必须先 `undrive`；
7. 高频 PTY 数据不进入 React session state、不触发每块 React render；桌面的既有 `PtyDataQueue` 继续提供高低水位和总上限；
8. Android release App 经公网 WSS 驾驶真实 Electron PTY，输入标记出现在 PTY 权威 history，真实输出由 WebView 解析后 ack，旋转改变尺寸，返回后桌面解锁；保留截图与提交基线。

完整发布级 P8 仍遵守 [远程终端呈现契约](./REMOTE-TERMINAL-RENDERING.md)：Android/iOS 物理真机、中文 IME 和 Claude Code + 另一款 AI CLI 是硬门禁。Windows 主机无法替代 iOS 证据；若当前环境做不到，状态必须写成“Android 模拟器实现完成，P8 未全平台关门”。

## 2. 数据面与性能边界

`RemotePhoneClient` 继续独占 WebSocket，但终端字节使用独立 subscriber，不放进 `RemotePhoneState`：

```text
React control state: idle → requesting → replaying → driven → exited/rejected
terminal event lane: drive-ok(history) | pty-out(deliveryId, bytes) | pty-exit | undriven
```

- state snapshot 只含 sessionId、requestId、尺寸、阶段、错误和累计已解析字节；
- history 只在 `drive-ok` 事件中传一次，不被深拷贝进 React；live chunk 最大值继续由 v1 协议限制为 256 KiB；
- 每个 live chunk 生成仅进程内 deliveryId。WebView 回传匹配 id 后，client 才删除 pending 记录并发送 `pty-ack`；重复、未知、错误 session 的 parsed 回执无效；
- WebView 内只有一个串行 writer。history 写完前 live chunk 只排队；写完后逐个 `Uint8Array` 解析并逐个回执；
- native UI 只在阶段、尺寸或节流后的累计字节变化时刷新，不承载终端文本；
- resize 由 WebView 的 `ResizeObserver` / `visualViewport` 合并到 animation frame，原生层再按“尺寸变化才发送”去重。

这条路径没有第二个无限缓冲：当 App/WebView 变慢而不 ack，桌面 `PtyDataQueue` 会暂停 PTY 输出读取并受既有最大缓冲保护；App 不提前 ack 来换取表面流畅。

## 3. WebView 终端运行时

P6 的 `terminal/` 本地页面升级为同时支持预检和真实会话的 runtime，继续使用相对资源、离线 Maple Mono 四字体、完整 HRack Dark palette与固定 xterm/WebGL 版本。

原生 → WebView 命令：

- `open`：sessionId、`drive-ok` 尺寸和 history；reset 后按 sequence replay；
- `live`：deliveryId、标准 base64、byteLength；
- `focus`：恢复终端输入；
- `force-fallback`：诊断 WebGL → DOM；
- `close`：清空当前 session 与 pending live，不销毁原生返回按钮。

WebView → 原生事件：

- `ready`：字体、renderer、初始 cols/rows；原生据此发 `drive` 或 `create`；
- `history-ready`：history 已解析、最终 fit 尺寸；原生转入 driven 并发必要的 `pty-resize`；
- `parsed`：某 live deliveryId 已完成 xterm 解析；原生据此 ack；
- `input`：xterm commit 后的数据；
- `size` / `renderer` / `fatal`：尺寸、降级和错误。

所有 envelope 先做类型、长度、sessionId 与阶段校验。注入脚本只使用 `JSON.stringify` 的数据字面量，不执行来自 PTY 的代码；CSP 继续禁止网络、内联脚本和外部字体。

Android 实际会话当前固定使用 xterm DOM fallback。P6 孤立夹具的 WebGL 能力仍保留，但真实 history/reset/resize 后的模拟器画面出现可重复字形裁切，不能用 `renderer=WEBGL` 或数据面绿灯掩盖。物理机视觉门禁通过前不重新启用；原因、性能与截图见 §8。

## 4. 原生界面与流程

- 会话卡点击：进入 `TerminalScreen` → 等 WebView ready → `drive` → replay → driven；exited 会话禁用；
- 手机新建：提交后先进入同一个 `TerminalScreen` 准备态；WebView ready 的真实 cols/rows 传给 `create`，随后复用 create 自动返回的 `drive-ok`，不再展示 P7 临时成功页；失败回到保留 payload 的新建表单；
- 顶栏始终有“返回会话”；终端区域外显示 renderer、cell size、已解析字节和错误，不泄漏终端正文；
- 底部附加键：Esc、一次性 Ctrl、Tab、四方向。Ctrl 有明确 armed 状态，下一次单字符输入转换为控制字节后自动解除；
- 另有原生“命令输入（提交后发送）”入口：编辑/IME 组合期间只更新本地草稿，用户提交后才一次发送最终文本和回车。它既是中文组合安全路径，也是无法可靠向 WebView 隐藏 textarea 注入自动化键盘事件时的可测入口；xterm 自身焦点输入仍保留；
- App 生命周期不做后台常驻。进入后台/组件卸载时尽力 `undrive`；socket 离线则依赖桌面 `peer-leave`/15 秒兜底释放。

## 5. 自动验证

### A. App 状态机/桥接

- 真实尺寸 drive、关联 drive-ok、busy/exited/not-found；
- history 事件只交付一次；live deliveryId 重复/错 session 不 ack；parsed 后才发 `pty-ack`；
- input/附加键、resize 去重、undrive、pty-exit/undriven/peer-leave 清理；
- create 使用 WebView 实测尺寸并直接进入相同 replay/driven 状态；
- WebView envelope guard、base64 byteLength、history-before-live 串行与 fatal 返回能力。

### B. 静态与构建

- 协议、xterm、palette、字体 parity；
- Vite 相对资源、CSP 和 bundle 文件存在性；
- TypeScript/Jest；Expo Doctor；Android release 构建；停止 Metro 后冷启动。

### C. Android 公网真实接口

1. 公开 relay 创建临时房间，Electron 启动真实 AgentSessionRuntime/PTY 并预写 history marker；
2. 安装版 App 加入，点击真实会话；断言 desktop drive state 尺寸来自 App WebView；
3. App 通过提交后整段发送的原生输入入口发送 `echo <marker>`，PTY 权威 history 出现输入与输出；xterm 解析后 App 已解析字节递增；
4. 产生 history 与 live 交界输出，检查顺序和 ack 后桌面队列继续前进；
5. 旋转横屏，只有被驾驶 PTY 尺寸改变；截图终端；
6. 返回列表，断言 desktop drive state idle 且 PTY 恢复桌面 fit；
7. 从 App 新建一条会话，检查 `create` 使用 WebView 尺寸并进入真实终端；
8. revoke 房间并清理。

失败后遵守 `AGENTS.md`：先记录失败步骤，只定向复跑本 P8 用例；通过后最终关门才运行一次完整回归。

## 6. 真实设备与诚实边界

当前 Windows 工作区可自动完成 Android 16 模拟器、release APK、公网 relay、Electron 与真实 PTY。以下证据不能由模拟器或 fixture 冒充：

- Android 物理真机与中文输入法 composition；
- iPhone/iPad 物理真机上的本地 bundle、safe area、WebGL/DOM、旋转和 IME；
- 登录态 Claude Code 与另一款真实全屏/彩色 AI CLI 的长输出 smoke。

实现和 Android 公网门禁通过后，可以提供“可真实远控的 Android 预发布版”；未补齐上述设备矩阵前，`SPEC-REMOTE` 状态不得写成 P8 全部完成。

## 7. 分段提交

1. HRack：`docs: plan remote P8 terminal`；
2. App：`feat: add remote terminal data plane`；
3. App：`feat: drive sessions in mobile terminal`；
4. HRack：`test: add P8 Android public terminal gate`；
5. App：`docs: record P8 Android terminal validation`；
6. HRack：`docs: record remote P8 Android checkpoint`。

## 8. 实现与验证记录

### 8.1 已实现

- App `0dbdac7`：终端协议桥、history/live 串行、base64 → `Uint8Array` 与解析后回执；
- App `1ab0f45`：真实会话驾驶、新建后直入终端、尺寸同步、附加键和返回释放；
- App `0774749`：每次终端构建后把相对离线 bundle 同步到既有 Android assets，避免原生工程存在时 Expo 配置插件不再复制新产物；
- App `9f8c77e`：真实 Android PTY 显式 DOM 降级，保留 WebGL 预检与 context-loss 能力；
- App `35130f6`：增加提交后整段发送的原生组合输入路径；
- HRack `b01c7c5`：新增安装版 App → 公网 relay → Electron → 真实 ConPTY 的 P8 门禁；
- App `64d8b81`：验证记录与三张实机界面截图（文档提交）。

终端高频字节没有进入 React session state；WebView 内串行写入，只有 `write` callback 完成才回传 deliveryId，原生 client 匹配后才发送 `pty-ack`。新建与已有会话共用同一个 measured terminal 流程。

### 8.2 公网真实接口结果

最终定向门禁：

```text
[p8-terminal-burst] renderer=DOM bytes=886380 elapsedMs=17514
1 passed (1.4m)
```

验证使用 Android 16 / API 36 Pixel 6 x86_64 模拟器上的 release APK，停止 Metro 后冷启动，经 `https://hrack.modplex.app/` 的 HTTPS/WSS 和当前公网 relay。已有 PTY 先写 history marker，App 以 43 × 31 驾驶；原生提交入口的唯一输入 marker 出现在 PTY 权威 history；随后 6,000 行真实 PTY burst 被 xterm 解析并 ack 886,380 字节，约 49.4 KiB/s。旋转得到 97 × 12 且桌面权威尺寸一致，返回后 drive state 为 idle；App 新建第二个真实 PTY 后又以 43 × 31 直接进入终端。房间最终已撤销。

App 同时通过协议/终端 parity、TypeScript、8 suites / 31 tests、Expo Doctor 20/20、相对离线 bundle 检查和 Android release 构建。完整截图与失败过程记录在 App 仓库 `docs/P8-ANDROID-VALIDATION.md`。

准备提交时又执行了一次 HRack 最终完整回归：`328 passed / 13 skipped`，耗时 3.8 分钟，无失败。13 个 skip 均有显式外部环境条件；其中公网 P7、P8 Android 用例已在本轮分别定向真实运行并通过，不能把完整回归中的条件跳过误读成未测。

### 8.3 视觉事故与性能结论

第一次数据面定向门禁在历史、drive 和尺寸处通过，但 ADB 无法把键盘事件可靠送进 WebView 隐藏 textarea；改用提交式原生输入后输入链路通过。随后人工看截图发现 WebGL 字形裁切，而自动断言仍为绿色。尝试 `preserveDrawingBuffer`、最终 fit 后清 atlas，以及 history 前释放/后重建 WebGL，均未修复。切换到 HRack 已有的 xterm DOM fallback 后，竖屏、横屏 burst 尾部和新建终端截图字形均完整。

49.4 KiB/s 足以作为当前交互式 AI CLI 的 Android 预发布检查点，但不是最终高吞吐目标。后续只能在 Android 物理机真实 PTY 视觉门禁通过后恢复 WebGL；若物理机同样失败，则保持 DOM 并针对串行写入/scrollback 做性能优化，不能牺牲字形正确性。

### 8.4 未关门项

- Android 物理真机：中文输入法 composition、软键盘、safe area 与旋转；
- iPhone/iPad 物理真机：本地 bundle、renderer/fallback、IME 与旋转；
- 登录态 Claude Code 与另一款全屏/彩色 AI CLI 的真实视觉和长输出 smoke；
- 上述设备矩阵完成后的最终完整回归。

在这些证据补齐前，状态只能是“P8 Android 模拟器实现检查点完成”，不能写成 P8 全部完成，也不能宣布进入 P8 之后的阶段。
