# HRack Remote P8 计划：App 真实终端

> 状态：2026-08-21 已完成 Android 16 模拟器 + 安装版 release App + 公网真实 PTY 检查点；2026-08-24 又把终端软键盘更新为整页平移、PTY 尺寸不变并完成公网真实复验。检查点还包含键盘开关后旋转、离线 Fcitx5 拼音组合提交和 Claude Code/Codex CLI 基础视觉 smoke；iOS 占位路径也已替换为共用终端 runtime 的本地单文件资源，并通过 CSP、Metro iOS 导出、Android 包隔离及 Chromium/Playwright WebKit 的零网络全桥接与像素截图门禁。Android 物理真机、iOS 真机及两款 CLI 的物理设备复验仍未完成，P8 尚未全平台关门。

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

完整发布级 P8 仍遵守 [远程终端呈现契约](./REMOTE-TERMINAL-RENDERING.md)：Android/iOS 物理真机上的中文 IME 和 Claude Code + 另一款 AI CLI 是硬门禁。Windows 主机无法替代 iOS 或物理 Android 证据；若当前环境做不到，状态必须写成“Android 模拟器与 iOS 发布输入实现完成，P8 未全平台关门”。

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

Android/Chromium 实际会话使用与 HRack 浏览器控制页一致的 xterm WebGL 自定义 glyph 路径；DOM 只保留为初始化失败/context loss 后仍可操作和释放的故障降级，不能给 Claude/Codex 的块字符与框线做视觉放行。Android 模拟器还必须使用可验证的硬件 GPU 后端：`swiftshader_indirect` 会让复杂 WebGL TUI 产生稳定水平切片，而同一 AVD、APK 和公网会话切换到 `-gpu host` 后正确。Safari/WKWebView 因已知 WebGL 风险仍从启动使用 DOM，因此当前 iOS 引擎证据只放行资源、桥接和辅助层边界，不放行真实 AI CLI 块字符视觉；原因、性能与截图见 §8。

本地资源按平台装载但不分叉终端逻辑：Android 继续使用 `android_asset` 中的相对多文件 Vite 产物；iOS 使用 Expo/Metro 的本地 HTML asset，把同一产物的 JS、CSS 和四字体折叠成约 1.04 MB 的单文件，避免 WKWebView 只找到入口却丢失相对资源目录。脚本/样式由内容 SHA-256 CSP hash 约束，字体使用 data URI；平台后缀入口保证 Android bundle/APK 不携带这份 iOS 文件。

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
- Vite 相对资源、Android 多文件 bundle、iOS 单文件 asset、CSP 内容 hash 和 bundle 文件存在性；
- Metro iOS 导出必须包含唯一 HTML asset；Android 导出及 release APK 不得包含 iOS 单文件；
- 同一 iOS 单文件要在 Chromium 和 Playwright WebKit 中走完整 `open/history/live/parsed/input` 桥接、零网络与像素截图门禁；测试必须能发现 xterm helper 覆盖层，即使 buffer/DOM 行和 ACK 都正确；
- TypeScript/Jest；Expo Doctor；Android release 构建；停止 Metro 后冷启动。

### C. Android 公网真实接口

1. 公开 relay 创建临时房间，Electron 启动真实 AgentSessionRuntime/PTY 并预写 history marker；
2. 安装版 App 加入，点击真实会话；断言 desktop drive state 尺寸来自 App WebView；
3. App 通过提交后整段发送的原生输入入口发送 `echo <marker>`，PTY 权威 history 出现输入与输出；xterm 解析后 App 已解析字节递增；
4. 可选中文门禁先用 Gboard English (US) 完成配对，再切换已准备好的 Gboard 拼音或离线 Fcitx5 Pinyin；组合串不得进入 PTY，候选提交并点击 App“发送”后 PTY 只出现最终中文；
5. 产生 history 与 live 交界输出，检查顺序和 ack 后桌面队列继续前进；
6. 旋转横屏，只有被驾驶 PTY 尺寸改变；截图终端；
7. 返回列表，断言 desktop drive state idle 且 PTY 恢复桌面 fit；
8. 从 App 新建一条会话，检查 `create` 使用 WebView 尺寸并进入真实终端；
9. revoke 房间并清理。

失败后遵守 `AGENTS.md`：先记录失败步骤，只定向复跑本 P8 用例；通过后最终关门才运行一次完整回归。

## 6. 真实设备与诚实边界

当前 Windows 工作区可自动完成 Android 16 模拟器、release APK、公网 relay、Electron、真实 PTY、离线 Fcitx5 拼音组合提交、本机真实 AI CLI 的基础视觉 smoke，以及 iOS 单文件资源生成、Metro iOS 导出、Chromium/Playwright WebKit 全桥接和最终合成截图。后者证明 iOS 不再是占位实现，并提前覆盖 WebKit 引擎差异，但没有运行 React Native UIKit 容器或设备上的 WKWebView。以下发布证据不能由模拟器、浏览器或 fixture 冒充：

- Android 物理真机上的中文输入法 composition 复验；
- iPhone/iPad 物理真机上的本地 bundle、safe area、WebGL/DOM、旋转和 IME；
- Claude Code 与 Codex 在上述物理设备上的真实视觉、中文输入和长输出 smoke。

实现和 Android 公网门禁通过后，可以提供“可真实远控的 Android 预发布版”；未补齐上述设备矩阵前，`SPEC-REMOTE` 状态不得写成 P8 全部完成。

## 7. 分段提交

1. HRack：`docs: plan remote P8 terminal`；
2. App：`feat: add remote terminal data plane`；
3. App：`feat: drive sessions in mobile terminal`；
4. HRack：`test: add P8 Android public terminal gate`；
5. App：`docs: record P8 Android terminal validation`；
6. HRack：`docs: record remote P8 Android checkpoint`；
7. App：`feat: enable bundled iOS terminal runtime`；
8. HRack：`test: validate P8 iOS terminal bundle`；
9. App / HRack：修复并锁定键盘开关后的旋转布局。
10. App / HRack：增加 WebKit 全桥接与 helper 覆盖层像素门禁。

## 8. 实现与验证记录

### 8.1 已实现

- App `0dbdac7`：终端协议桥、history/live 串行、base64 → `Uint8Array` 与解析后回执；
- App `1ab0f45`：真实会话驾驶、新建后直入终端、尺寸同步、附加键和返回释放；
- App `0774749`：每次终端构建后把相对离线 bundle 同步到既有 Android assets，避免原生工程存在时 Expo 配置插件不再复制新产物；
- App `9f8c77e`：真实 Android PTY 显式 DOM 降级，保留 WebGL 预检与 context-loss 能力；
- App `35130f6`：增加提交后整段发送的原生组合输入路径；
- HRack `b01c7c5`：新增安装版 App → 公网 relay → Electron → 真实 ConPTY 的 P8 门禁；
- App `64d8b81`：验证记录与三张模拟器真实接口截图（文档提交）；
- HRack `4e149d2` / `1270717`：增加真实 Claude Code/Codex CLI 公网门禁，并改用官方本地命令和单次配置覆盖，避免触发模型请求或更新安装；
- App `25781ec`：固化两款真实 CLI 截图及验证记录；
- App `6d99237`：修复 Android 软键盘弹出/隐藏时终端布局收缩和恢复；
- HRack `04d63c0`：门禁同时核对系统 IME、App 格子和桌面唯一 winsize；
- App `9500255`：固化软键盘打开/恢复截图与事故记录；
- App `5f9461d`：Android 命令输入不再设置 `TYPE_TEXT_FLAG_NO_SUGGESTIONS`，允许 IME 组合且不主动请求 shell 命令自动纠正；
- HRack `8831024`：新增可选 Gboard/Fcitx5 中文拼音门禁，逐点证明组合串不进 PTY、候选提交后才发送最终中文。
- App `56e2878`：删除 iOS 占位页，生成带内容 hash CSP 的单文件离线终端资源，并以平台入口隔离 Android/iOS 装载；
- HRack `e36a4a4`：真实加载 iOS 单文件页面，验证字体、块元素、CJK 双宽、renderer fallback 和零网络请求；
- App `e0831e7`：修复 Android 键盘开关后 `KeyboardAvoidingView` 锁住初始竖屏高度；
- HRack `f20907e`：新增快速预检/真实驾驶旋转门禁，并要求横屏列数增加且行数减少。
- App `d3fcb3f`：Safari/WKWebView 从启动使用 DOM，补齐 xterm 6 beta 的隐藏字宽探针规则，避免 32 个测量用 `W` 泄漏到终端画面；
- HRack `06403fc`：把 iOS 单文件门禁扩展为 Chromium + WebKit 的乱序 history、并发 live、ACK、输入回传、零网络和像素截图验证。

终端高频字节没有进入 React session state；WebView 内串行写入，只有 `write` callback 完成才回传 deliveryId，原生 client 匹配后才发送 `pty-ack`。新建与已有会话共用同一个 measured terminal 流程。

### 8.2 公网真实接口结果

最终定向门禁：

```text
[p8-terminal-keyboard] portrait=43x31 keyboard=43x16 restored=43x31
[p8-terminal-burst] renderer=WEBGL bytes=886220 elapsedMs=13538
2 passed (2.2m)
```

App `d3fcb3f` 重新生成并安装 release APK 后，定向公网旋转门禁再次得到：

```text
[p8-terminal-rotation] portrait=43x31 landscape=97x16
1 passed (42.9s)
```

验证使用 Android 16 / API 36 Pixel 6 x86_64 模拟器上的 release APK，停止 Metro 后冷启动，经 `https://hrack.modplex.app/` 的 HTTPS/WSS 和当前公网 relay。最终视觉门禁以 `-gpu host` 启动 AVD，SurfaceFlinger 确认 GLES 由 NVIDIA RTX 3090 提供。已有 PTY 先写 history marker，App 以 43 × 31 驾驶；Gboard 英文键盘弹出后 App 与桌面唯一 PTY 同步收缩为 43 × 16。随后切换到离线 Fcitx5 Pinyin，逐键点按 `zhongwen` 时 `zhong wen` 和候选“中文”只存在于 IME，App 草稿与 PTY history 均没有裸拼音；选择候选后 App 草稿出现“中文”，点击发送后 PTY history 只含最终中文。键盘隐藏后尺寸恢复 43 × 31；6,000 行真实 PTY burst 被 WebGL xterm 解析并 ack 886,220 字节，用时 13.538 秒，约 63.9 KiB/s。键盘开关之后旋转得到稳定的 97 × 15/16，App 和桌面权威尺寸一致且完整界面没有向下溢出；返回后 drive state 为 idle。App 新建第二个真实 PTY 后又以 43 × 31 直接进入终端。房间最终已撤销。

iOS 资源门禁另用 Windows 上可执行的发布输入/引擎验证：生成资源在磁盘上约 1.04 MB，`expo export --platform ios` 列出 1 个 HTML asset，Android 导出 asset 列表为空，release APK 只包含 Android 多文件目录。Playwright 分别以 Chromium 和 WebKit 从本地文件加载同一单文件页面，复读故意乱序的三段 history，把同时注入的 live 严格排在 `history-ready` 后解析，核对字节数，并把真实键盘输入 `ios-input\r` 回传到 Native bridge；字体装载、CJK 双宽、DOM fallback、零网络、helper 边界和像素截图同时通过，最终 `2 passed (2.1s)`。由于 Android 已证明 DOM 会误画真实 Claude/Codex 块元素，这项固定夹具不能继续被描述为 iOS 真实 TUI 视觉放行；它也不是 iOS 模拟器或真机结果。

App 同时通过协议/终端 parity、TypeScript、8 suites / 32 tests、Expo Doctor 20/20、相对离线 bundle 检查和 Android release 构建。完整截图与失败过程记录在 App 仓库 `docs/P8-ANDROID-VALIDATION.md`。

真实 AI CLI 门禁另以同一 release App 和公网房间启动本机真实安装的 Claude Code 2.1.220 与 Codex CLI 0.146.0，最终 `1 passed (1.3m)`。Claude 提交本地 `/help`，Codex 提交官方本地 `/status`；两者均要求 `renderer=WEBGL`，保存启动首屏与命令后画面，验证 PTY 权威 history、解析字节增长、最终合成字形高度和返回 `undrive`，没有提交业务 prompt 或发起模型请求。Codex 用单次 `-c check_for_update_on_startup=false` 关闭启动更新检查，不修改用户安装。四张截图已固化到 App 仓库。

准备提交时又执行了一次 HRack 检查点完整回归：`328 passed / 18 skipped`，耗时 3.5 分钟，无失败。18 个 skip 均有显式外部环境条件；新增的 Chromium/WebKit 两个 iOS 单文件门禁已在带 App 路径的环境中定向得到 `2 passed`，公网 P7/P8、Android 预检/真实旋转和 P8 完整终端也已按各自条件定向真实运行，不能把完整回归中的条件跳过误读成未测。物理设备矩阵完成后仍要再做 P8 最终关门回归。

### 8.3 视觉事故与性能结论

第一次数据面定向门禁在历史、drive 和尺寸处通过，但 ADB 无法把键盘事件可靠送进 WebView 隐藏 textarea；改用提交式原生输入后输入链路通过。随后人工看截图发现 WebGL 字形裁切，而自动断言仍为绿色。尝试 `lineHeight`、`preserveDrawingBuffer`、最终 fit 后清 atlas，以及 history 前释放/后重建 WebGL，均未修复；当时切到 DOM 后普通 ASCII 看似完整，于是错误地写成了“DOM 视觉完成”。用户后续真实 Claude Code 截图显示块状 logo 变成错位大白矩形，回看旧归档图确认旧结论本身就是假绿灯：DOM 没有复用 WebGL addon 的 Box Drawing / Block Elements 自定义 glyph，不能作为真实 TUI 视觉路径。

恢复 WebGL 后，裁切只在 AVD 的 `-gpu swiftshader_indirect` 下出现；同一 AVD、release APK、公网房间和真实 CLI 改为 `-gpu host`，并确认 GLES 由 NVIDIA RTX 3090 提供后，Claude/Codex 启动与交互截图均完整。最终实现与 HRack 浏览器控制页一样在 Android/Chromium 真实会话启用 WebGL，DOM 只作可操作/可释放的故障降级。真实 AI 门禁新增 `WEBGL` 状态断言、启动截图和最终像素结构检查；软件 GPU 坏图的完整高度字形比例约 0.153，门禁要求大于 0.7。WebGL 最新公网 burst 为 886,220 字节/13.538 秒，约 63.9 KiB/s；旧 DOM 43.5–49.4 KiB/s 仅保留作诊断数据，不再是 Android 正常路径的性能结论。

WebKit 门禁还复现了另一类“数据面全绿、画面仍错”的事故：终端 buffer、`.xterm-rows`、history/live 顺序、ACK 和输入回传均正确，但画面顶部出现 32 个连续 `W`。隐藏真实第 0 行后它们仍存在，最终定位为 xterm 在 WebKit 缺少完整 OffscreenCanvas font metrics 时创建的 `.xterm-char-measure-element`；固定 beta CSS 没有把探针隐藏。App 把探针绝对定位到屏幕外并设为 `visibility:hidden`，保留尺寸测量；测试则在不少于四个文字带之外，增加少于 20 cells 的夹具不得把非背景像素画到 200 px 以外。修复前 WebKit 稳定为 268 px，修复后双内核通过。此后手机端不能只检查 xterm 行/canvas，字宽、IME、无障碍 helper 也必须纳入最终合成截图。

软键盘门禁又发现另一处只看数据面无法发现的问题：`minHeight: 260` 阻止 Android 16 edge-to-edge 页面收缩；直接使用 `KeyboardAvoidingView(height)` 又在 `keyboardDidHide` 后残留收缩高度。第一版用真实 show/hide 状态切换 `enabled`，确实在竖屏完成了 43 × 31 → 43 × 16 → 43 × 31，却遗漏了“随后旋转”：React Native 0.83 仍会因旧 `state.bottom > 0` 套用 `_initialFrameHeight` / `flex: 0`，产生 97 × 31 的竖屏高度锁定。最终实现不再切 `enabled`；Android 仅在键盘显示时设置 `behavior=height`，隐藏时移除 behavior 以恢复 flex 布局，同时保持 WebView 不重挂。最小公网复现由红色 `43 × 31 → 97 × 31` 变为 `43 × 31 → 97 × 16`，完整中文/burst 门禁最终得到 97 × 15。门禁必须同时断言横屏列数增加、行数减少，并人工查看界面没有溢出。Fcitx5 的 43 × 15 仍沿用同一尺寸通道。

中文门禁先暴露了两类外部前置问题：中文子类型会把 ADB 注入的配对 URL 改成全角标点，所以配对必须先固定英文；预装 Gboard 拼音则因模拟器镜像语言包缺失持续等待下载，不能把这个外部失败误判为 App 组合失败。最终门禁安装并核对官方 SHA-256 的 Fcitx5 Android 0.1.3 x86_64 APK，只保留内置 Pinyin，并用真实键盘逐键/候选点击证明组合串在最终 App 提交前从未进入 PTY。Android 命令框不设置 `autoCorrect=false`，避免 React Native 映射为 `TYPE_TEXT_FLAG_NO_SUGGESTIONS`；同时不设置 `true`，避免请求英文 shell 命令自动纠正。

用户复测又发现点击终端画面不能弹出原生命令输入。根因是 xterm 只聚焦 WebView 隐藏 textarea，而组合安全输入属于 React Native `TextInput`；两者此前没有明确的轻点桥接。当前实现保留 xterm 物理键盘和拖动手势，真实会话把隐藏 textarea 设为 `inputMode=none`，短距离 pointer 轻点才发送带当前 `sessionId` 的 `input-request`，Native 仅在同一会话仍为 `driven` 时聚焦命令草稿。真实门禁改为从点击 `terminal-webview` 开始，证明原生焦点、IME、43 × 31 → 43 × 16、桌面 winsize、输入、中文组合、886,316 字节 burst、恢复、旋转、释放与新建全链路通过。

定位过程中还抓到两种设备假阳性：模拟器 `show_ime_with_hard_keyboard=0` 时只出现零 inset 的侧边工具条；清理 Gboard 后首次聚焦可能出现 “Try out your stylus” 引导层。两者都会让 `mInputShown=true`，却不是普通软键盘。Android 门禁现在固定 `show_ime_with_hard_keyboard=1`、`stylus_handwriting_enabled=0`，并要求原生命令框焦点与终端 rows 实际减少，不能只看 IME 标志。

**2026-08-24 键盘与横向 fit 勘误：** 上述 43 × 31 → 43 × 16 与 rows 减少是 2026-08-21 `adjustResize` 策略的历史验收，不再约束当前实现。用户确认终端页应保持原尺寸并由系统整体上移后，Android 改为 Expo SDK 55 `softwareKeyboardLayoutMode="pan"` / 原生 `adjustPan`，移除 Android `KeyboardAvoidingView(height)` 和键盘态终端 padding，命令附件保留固定底部坐标。随后 OpenCode 截图发现 xterm 6 beta 已隐藏滚动条，但 FitAddon 0.11 仍按旧 API 预留 14 px；锁版本兼容补丁让 FitAddon 尊重 `scrollbar.showScrollbar=false`，并增加“host 与网格余量小于一个字符格”的 Chromium/WebKit 门禁。安装版 release App 又经公网真实 HRack、Codex CLI、ConPTY 和 Gboard 定向验证，修复前为 45 × 38，修复后键盘前/中/后 App 与桌面唯一 PTY 均保持 47 × 38，Activity 内容发生上移并在隐藏后回位。后续门禁应断言 IME 可见、窗口坐标上移、横向网格余量和 winsize 不变；旋转仍按真实容器 resize 单独验证。

### 8.4 未关门项

- Android 物理真机：中文输入法 composition、软键盘、safe area 与旋转复验；
- iPhone/iPad 物理真机：已生成/导出的本地 bundle 在 WKWebView 中的 renderer/fallback、safe area、IME 与旋转；
- 在上述物理设备上复跑 Claude Code 与 Codex 的真实视觉、中文输入和长输出 smoke；
- 上述设备矩阵完成后的最终完整回归。

在这些证据补齐前，状态只能是“P8 Android 模拟器实现检查点完成”，不能写成 P8 全部完成，也不能宣布进入 P8 之后的阶段。
