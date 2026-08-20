# 远程终端呈现契约（P6 预检 / P8 门禁）

> 状态：P8 实现与验收必须遵守。本文记录 2026-08-20 浏览器演示页和 2026-08-21 Android 真实 PTY 暴露的多次渲染、软键盘与 IME 事故，并把修复经验变成手机端约束。

## 1. 为什么需要单独的契约

浏览器演示控制器第一次接通真实 PTY 后，协议、history、`pty-out` 和输入链路都正确，但 Claude Code 的块元素 logo 仍显示成断裂、错位的白块。根因不是 PTY 数据损坏，而是终端呈现层偏离了 HRack 桌面端：页面继承了界面字体，只有不完整的颜色配置，也没有沿用桌面端的 renderer 策略和字体就绪时序。

修正后，演示页复用了桌面端固定的 xterm 版本、Maple Mono 字体、完整 HRack Dark palette，以及 WebGL 失败时退回 DOM 的策略。真实 Chromium → 中继 → Electron → 真实 PTY 的门禁继续通过，块元素夹具也恢复正常。

因此，“收到正确字节”与“终端画得正确”是两个独立验收面。P8 不能只证明协议通了；手机端必须同时满足本文的呈现契约。

## 2. 阶段边界

- **P6 不实现终端。** P6 只做扫码、等待态和会话列表，但关门前必须完成 §8 的手机技术预检，证明所选框架能够承载 P8 所需字体、终端 renderer、IME 和真实设备测试。
- **P8 实现并验收终端。** P8 才接入 `drive`、history、`pty-*`、附加键和 `undrive`，并通过 §7 的全部门禁。
- 若 P6 的技术预检失败，先更换终端承载方案或框架；不得把风险留到 P8 接入真实流量以后再处理。

本文不预先锁死 Flutter、React Native 或原生方案。若使用 WebView/xterm，必须与桌面端保持版本和行为同源；若使用原生终端组件，也必须用同一批字形、颜色、字节和真实 TUI 夹具证明等价，不能仅凭组件名称或截图判断。

## 3. 当前桌面端权威来源

手机仓库独立发布，不代表终端参数可以独立发明。实现时以下文件是当前呈现真值：

| 内容 | HRack 权威来源 |
|---|---|
| xterm core / addon 版本 | `package.json` 与 lockfile |
| 构造、字体就绪、fit、写入及 ack 时序 | `src/terminal/useXterm.ts` |
| WebGL → DOM fallback | `src/terminal/addons.ts` |
| 完整终端 palette | `src/terminal/themes.ts` |
| 默认字体族与字号 | `src/state/settingsStore.ts` |
| Maple Mono 四种字重/样式与 CJK fallback | `src/index.css`、`src/assets/fonts/maple-mono/` |

本文记录时桌面端 core 是 `@xterm/xterm@6.1.0-beta.292`，WebGL addon 是 `@xterm/addon-webgl@0.20.0-beta.291`，默认字号为 14。这里只用于说明事故修复时的基线；P8 开始时必须从 HRack 当时的 lockfile 读取精确版本，不能把本文中的旧数值当成永久最新版。

独立 App 仓库可以发布自己的资源副本，但必须记录来源 HRack commit，并有自动 parity gate 比较版本、palette 和资源清单。不能静默复制一份后任其漂移。

## 4. 必须满足的呈现约束

### 4.1 字体与格子

1. 首选字体必须是随 App 打包的 Maple Mono，不得继承页面/UI 字体，也不得依赖设备恰好安装的系统字体或在线 CDN。
2. Regular、Bold、Italic、BoldItalic 四种资源及其许可证必须一起打包；bold/italic ANSI 不能在首用时换成另一套 metrics。
3. CJK fallback 必须显式定义并在 iOS、Android 各自验证双宽格。不能让 Windows、Android 或 iOS 自由落到不可预期的 proportional font。
4. 必须等首选字体和所需字重就绪后再做最终 cell measurement、fit 和 `drive`。若 renderer 在字体就绪前创建过 glyph atlas，字体就绪后必须清 atlas 并重新 fit。
5. 字体加载失败时页面必须仍可返回列表、释放驾驶并显示可诊断状态；不能白屏，也不能悄悄把 fallback 首帧当成验收通过。

### 4.2 主题

App 至少先支持 HRack Dark，并完整复用 `background`、`foreground`、`cursor`、`cursorAccent`、`selectionBackground`、8 个 ANSI 色及 8 个 bright ANSI 色。只复制前景色和背景色不算复用主题。

后续若允许用户同步其它主题，仍以 `src/terminal/themes.ts` 的完整定义为真值。UI 外壳可以有自己的 design token，但不得覆盖 xterm screen 的字体或 palette。

### 4.3 Renderer

- WebView/xterm 路线优先尝试 WebGL；不支持 WebGL2、初始化抛错或 context loss 时必须自动退回 DOM/软件 renderer，终端和释放按钮仍可用。
- 原生终端路线必须提供等价的 fallback 和可观测状态，至少能区分“首选 renderer 已启用”和“已降级”。
- renderer 是实现细节。端到端测试不能依赖 `.xterm-rows`、`canvas` 数量或某个 renderer 私有 DOM；应断言终端 buffer/已解析字节和真实 PTY 权威历史。

### 4.4 初始化与数据时序

推荐顺序如下；若框架 API 不同，也必须维持相同因果关系：

1. 加载 CSS、字体、palette 和终端资源，等待字体 ready。
2. 用固定版本和确定配置构造终端，加载 fit 与首选 renderer。
3. 把终端打开到已经可见、可测量并考虑 safe area 的容器。
4. 下一帧测量 cell，得到 `cols` / `rows`，再发送 `drive`；不能用 fallback 字体测出的尺寸先占用 PTY。
5. 收到 `drive-ok` 后按事件顺序 replay history；replay 期间到达的 live `pty-out` 先排队，不能越过 history。
6. `pty-out.data` 从标准 base64 解为 `Uint8Array` 后直接写入终端。不得把每个网络块先单独解成 JavaScript 字符串，否则跨块 UTF-8 字符可能损坏。
7. 只有终端解析回调完成后才发送对应 `pty-ack.bytes`；收到 WebSocket 帧或把数据放入 UI 队列不等于已消费。
8. 旋转屏幕、键盘展开或容器变化时先重新 fit，再发送一个 `pty-resize`。驾驶期间手机是该 PTY 的唯一 winsize 权威。
9. 返回列表、掉线、会话退出和错误路径都必须释放 renderer、监听器与驾驶状态；返回列表必须发送 `undrive`。

### 4.5 手机交互

- safe area、软键盘和横竖屏变化必须进入同一套尺寸计算；不得另建第二套“显示尺寸”和 PTY winsize。
- 缩放只能改变同一格子的显示比例；若缩放导致实际可见行列变化，就必须以新的唯一行列发送一次 `pty-resize`。
- IME 组合阶段不发 `pty-in`，只在 composition commit 后发送最终文本；必须用真实系统中文 IME 验证，不能只模拟 `insertText`，发布前还要在物理设备复验。
- Esc、Ctrl、Tab 和四方向键必须生成与桌面终端一致的输入序列；Ctrl 的锁定/单次模式要有明确反馈。
- 选择、滚动、复制和键盘手势不得误触发页面导航；返回列表必须始终可达。

### 4.6 App 内本地 WebView 资源

P6 Android 预检已经复现过一次“原生外壳正常、WebView 纯黑且没有明显页面错误”的问题。原因是 Vite 默认把入口资源写成 `/assets/...`：浏览器服务器能从站点根目录提供它，但 Android 的 `file:///android_asset/hrack-terminal/index.html` 会把它解析为错误的 `file:///android_asset/assets/...`，因此 JS、CSS 与字体都没有加载。

使用 WebView/xterm 时必须同时满足：

1. 构建显式设置相对 base（当前 App 为 `vite build terminal --base ./`）；
2. 构建后门禁解析 `index.html` 与 CSS，拒绝 `/assets/...`、不存在文件、网络字体和放宽的 CSP；
3. 本地资源由原生打包步骤复制到 Android assets / iOS bundle，而不是开发服务器；
4. WebView 的顶层加载错误必须回传原生层并显示诊断，不能只呈现空白黑屏；
5. release 包必须在 Metro/开发服务器停止后清数据冷启动，再运行一次预检。

这个门禁检查的是“包内资源可达”，不能被桌面浏览器或 Metro 开发态截图替代。以后调整 Vite、Expo、WebView 或资源目录时必须先过相对路径检查，再做真实安装包冷启动。

### 4.7 静态 WebGL 预检不能替代真实 PTY 视觉门禁

P8 Android 实现再次暴露了一个不同层次的陷阱：同一 release APK、同一 WebView、同一 Maple Mono 和同一固定 xterm 版本，P6 静态夹具在 WebGL 上字形完整；接入真实 history、`terminal.reset()`、记录的 resize 和 live output 后，模拟器截图却出现稳定的 ASCII 纵向裁切。此时协议字节、xterm buffer、输入、解析后 ack、唯一 winsize 和返回释放自动断言全部通过，`renderer` 状态也仍是 `WEBGL`。

因此增加以下纪律：

1. WebGL 预检必须分成“孤立固定夹具”和“真实 PTY history + live + resize 后画面”两类；前者不能替代后者；
2. 必须人工或像素基线检查至少 history 首屏、持续输出尾部和旋转后的画面；`renderer=WEBGL` 不是视觉正确证明；
3. `preserveDrawingBuffer`、清 glyph atlas 或重建 addon 只能作为待验证假设，不能在没有截图证据时写成已修复；
4. 若真实画面损坏，立即走 xterm DOM fallback 并保留可观测原因；数据面、解析后 ack 和 React 外字节通道不得随 renderer 降级改变；
5. DOM fallback 必须附真实 burst 性能数据。2026-08-21 Android 16 模拟器经公网真实 ConPTY 多次实测约为 43.6–49.4 KiB/s；其中中文 IME 最终门禁解析并 ack 886,156 字节/19.872 秒，可作为交互式预发布范围，但不等于物理机最终性能结论；
6. 重新启用 WebGL 必须由 Android 物理机真实 PTY 视觉门禁授权，不能只恢复静态 P6 截图。

手机输入也必须有可验证的组合安全路径。WebView 隐藏 textarea 在自动化环境中可能无法稳定接收系统键盘事件；允许提供原生提交式输入框，组合期间只编辑本地草稿、显式提交后一次发送最终文本和回车。它不能删除 xterm 原生输入，但可以作为中文 IME 安全入口与真实接口自动门禁入口。

### 4.8 软键盘避让必须同步唯一 winsize

Android 的 `adjustResize`、edge-to-edge 和 React Native `KeyboardAvoidingView` 不是“配置过就算完成”。2026-08-21 的安装版 Android 16 门禁先后发现：过大的终端 `minHeight` 会让系统已显示 IME 但 WebView 不收缩；直接使用 `KeyboardAvoidingView(height)` 又可能在 `keyboardDidHide` 后残留收缩高度。

因此终端页还必须满足：

1. 用系统真实 IME 可见状态证明键盘确实打开/关闭，不能只调用 focus/blur；
2. 键盘打开后 WebView 必须重新 fit，并把新 cols/rows 作为同一个被驾驶 PTY 的唯一 winsize；隐藏后再次 fit 和恢复；
3. App 显示格子、桌面权威 drive state 与截图三者在打开和恢复两个时点一致；
4. 修复避让时不得重挂 WebView，否则会清空 xterm buffer、破坏 history/live 顺序；
5. Gboard 英文键盘证明 43 × 31 → 43 × 16 → 43 × 31；较高的 Fcitx5 Pinyin 又证明 43 × 15。模拟器中文组合通过后仍要在物理设备输入法上复验最终提交前没有 `pty-in`。

### 4.9 原生命令输入必须保留 IME 组合能力

Android 终端输入框不能沿用普通 shell 输入常见的 `autoCorrect={false}`。React Native 0.83 会把它映射为 Android `TYPE_TEXT_FLAG_NO_SUGGESTIONS`，可能同时关闭中文 IME 的候选/组合能力。也不能简单改成 `true`，否则会请求输入法自动纠正英文 shell 命令。Android 应不设置该标志；iOS 可以继续显式关闭纠错。

真实中文门禁还必须区分三层状态：

1. 配对 URL 与终端中文输入不是同一场景。自动输入 URL 前固定英文键盘，避免中文标点把 `https://` 改成全角；进入终端后再切中文 IME；
2. 组合串可能显示在 IME 自己的 preedit 区，而不进入受控 `TextInput`。门禁不能要求 App 草稿一定出现裸拼音；应证明候选提交前 PTY 没有拼音、候选提交后 App 草稿出现最终中文、显式发送后 PTY 只出现最终中文；
3. 输入法语言包缺失是测试设备前置失败，不是 App 协议失败。2026-08-21 预装 Gboard 拼音持续等待下载且 MDD 数据缺失，最终改用核对官方 SHA-256 的离线 Fcitx5 Android 0.1.3 内置 Pinyin 完成证据；验证记录必须写明实际 IME，不能只写“中文键盘已选中”。

## 5. 禁止的捷径

- 用页面/UI 的 sans-serif 或系统默认 `monospace` 代替打包字体。
- 只设置前景、背景两种颜色。
- App 自行选择“最新 xterm”或不兼容的 addon 组合。
- 字体未 ready 就 fit、`drive`，随后只用 CSS 纠正视觉。
- 把 base64 PTY 块逐块转成字符串后再写终端。
- WebSocket 收包后立即 ack，未等待终端解析完成。
- 只用假数据截图、单元测试或 Node 手机夹具宣称手机终端完成。
- 用某个 renderer 的 DOM 结构作为端到端成功条件。
- 只测 ASCII prompt；不测块元素、box drawing、ANSI 样式、CJK 双宽和真实全屏 TUI。

## 6. 固定视觉夹具

P8 应保留一个确定性 PTY 夹具，至少输出：

- 块元素：`▐▛███▜▌`，覆盖本次事故暴露的字形；
- box drawing：`┌─┬─┐`、`│ │`、`└─┴─┘`；
- ASCII 等宽列和光标定位；
- 中文双宽文本，例如 `中文终端`；
- normal / bold / italic / bold-italic；
- 8 色与 bright 8 色；
- alternate screen 的真实 TUI 刷新、清屏和退出。

结构性断言检查终端 buffer 中的字符、列宽和样式；视觉截图检查字形、基线、裁切与颜色。截图允许按平台维护基线，但不能用大面积容差掩盖一格错位。emoji 不作为跨平台列宽权威夹具，因为平台字体和 Unicode 宽度策略差异过大。

## 7. P8 关门门禁

P8 必须同时满足以下四层证据：

1. **静态 parity：** App 与当时 HRack lockfile 的终端版本一致；字体四件套和许可证存在；HRack Dark 完整 palette 一致；renderer 首选与 fallback 可观测。
2. **确定性呈现：** §6 夹具在至少一台 iOS 和一台 Android 真机上通过 buffer 断言与视觉检查；断网冷启动仍使用打包字体。
3. **真实功能链路：** 真机 App → 公网 HTTPS/WSS/反向代理 → HRack Electron → 真实 PTY。手机输入必须出现在 PTY 权威历史，真实输出必须被手机终端解析后才 ack；旋转只改变被驾驶 PTY，返回列表后桌面解锁并 fit。
4. **真实 AI CLI：** 至少用 Claude Code 和另一个全屏/彩色 AI CLI 各完成一次可见 smoke：logo/box drawing 无错格，历史与 live output 不乱序，中文 IME 不逐键发送，长时间输出没有因错误 ack 造成无界堆积或停顿。

自动门禁应保持 renderer 无关。一次人工真机视觉验收不能替代自动化；自动化也不能替代真实设备与真实公网接口测试。验证记录必须写明设备/系统、App commit、HRack commit、中继版本、renderer 状态、是否走公网，以及真实接口结果。

## 8. P6 关门前的 P8 技术预检

P6 虽然没有终端页面，但所选 App 技术路线必须在真机 spike 中回答并留下证据：

1. Maple Mono 四种样式能随包离线加载，块元素和 CJK 双宽格不漂移。
2. 选定终端组件能固定版本，并说明与 HRack xterm 的复用或等价策略。
3. 首选 renderer、降级路径和 context-loss/组件失效后的返回列表能力可实现。
4. 字体 ready → 测量 → fit → `drive` 的时序可控，而不是只能在终端创建后异步换字体。
5. 中文 IME composition commit、附加键、safe area、软键盘及旋转尺寸变化可以被自动或真机测试观测。
6. App 仓库已经有 parity gate 的入口；P8 只补真实终端，不再重新决定字体、palette 和 renderer。

任一项答不出来，P6 可以完成列表功能，但不得标记“P8 ready”。这不是要求 P6 提前连接 PTY，而是防止在终端阶段才发现框架无法落实呈现契约。

## 9. 变更纪律

凡修改 HRack 的 xterm core/addon、`useXterm.ts` 初始化时序、renderer fallback、主题、默认字体或字体资源，都要同时检查：

1. App 的来源 commit / parity gate 是否需要更新；
2. §6 固定夹具是否需要新增覆盖；
3. P8 的 iOS、Android 视觉基线是否需要重新确认；
4. 浏览器演示控制器是否仍与桌面端同源。

反过来，手机端为适配平台做出的修正若会影响格子、字节或 ack 语义，必须回写本文；不能只留在 App 私有代码注释或一次聊天记录里。
