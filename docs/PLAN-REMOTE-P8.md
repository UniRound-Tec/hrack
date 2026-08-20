# HRack Remote P8 计划：App 真实终端

> 状态：2026-08-21 开始实施。P4 数据面、P6 Android 终端预检与 P7 App 新建均已关门；本阶段把安装版 App 接到真实 `drive` / history / `pty-*`，但只有满足本文最终设备矩阵后才可把 P8 标为完整关门。

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

## 4. 原生界面与流程

- 会话卡点击：进入 `TerminalScreen` → 等 WebView ready → `drive` → replay → driven；exited 会话禁用；
- 手机新建：提交后先进入同一个 `TerminalScreen` 准备态；WebView ready 的真实 cols/rows 传给 `create`，随后复用 create 自动返回的 `drive-ok`，不再展示 P7 临时成功页；失败回到保留 payload 的新建表单；
- 顶栏始终有“返回会话”；终端区域外显示 renderer、cell size、已解析字节和错误，不泄漏终端正文；
- 底部附加键：Esc、一次性 Ctrl、Tab、四方向。Ctrl 有明确 armed 状态，下一次单字符输入转换为控制字节后自动解除；
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
3. App 通过 WebView 输入 `echo <marker>`，PTY 权威 history 出现输入与输出；App 已解析字节递增；
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
