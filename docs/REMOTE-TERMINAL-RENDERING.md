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
- renderer 的内部 DOM 是实现细节。协议门禁不能依赖 `.xterm-rows`、`canvas` 数量或其它私有结构；平台视觉门禁则必须同时断言公开的 renderer 状态与最终合成像素，因为 buffer/已解析字节和真实 PTY 权威历史都不能证明块字符、框线或 GPU 合成正确。

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
3. 本地资源必须进入 Android assets 或 iOS 发布 bundle，而不是依赖开发服务器；Android 可复制相对多文件目录，iOS 若用 Metro `require(local.html)` 则必须证明相对目录仍可达，或像当前 App 一样生成自包含单文件；
4. WebView 的顶层加载错误必须回传原生层并显示诊断，不能只呈现空白黑屏；
5. release 包必须在 Metro/开发服务器停止后清数据冷启动，再运行一次预检。

这个门禁检查的是“包内资源可达”，不能被桌面浏览器或 Metro 开发态截图替代。以后调整 Vite、Expo、WebView 或资源目录时必须先过相对路径检查，再做真实安装包冷启动。

2026-08-21 的 iOS 落地审查又补充了一层：React Native WebView 支持在 iOS `require` 本地 HTML，不代表入口旁边的 JS、CSS 和字体目录一定按原结构进入 WKWebView 可读位置。当前 App 因此复用同一个 Vite 产物，但额外生成约 1.04 MB 的 iOS 单文件：JS/CSS 内联、四个字体转 data URI、脚本和样式使用内容 SHA-256 CSP hash。生成器与门禁必须同时满足：

1. 重新计算内联 script/style hash，拒绝残留相对 URL、外部引用和放宽的 `connect-src`；
2. 用 `.gitattributes` 固定生成 HTML 为 LF，因为 Windows 自动 CRLF 转换会改变内联内容字节并让 CSP 在全新检出后失效；
3. 使用 `.ios.ts` / `.android.ts` 平台入口隔离资源，实际 Metro iOS 导出应列出 HTML asset，而 Android 导出、JS bundle 和 APK 不得携带这份额外文件；
4. 在没有 macOS 时应分别用 Chromium 和 Playwright WebKit 真实离线加载该单文件，除字体、块元素、CJK 双宽、renderer fallback 和零网络外，还要走完整 `open/history/live/parsed/input` 桥接并截图最终合成画面；记录仍必须写成“iOS 发布输入/引擎检查点”，不能写成 WKWebView 或真机通过；
5. iOS 最终仍需在 Metro 停止后的安装包上冷启动，并覆盖 safe area、旋转、系统 IME、内容进程终止和真实 PTY。

### 4.7 Renderer 标签、DOM fallback 与静态预检都不能替代真实像素

P8 Android 先后出现了两个相反方向的假结论。第一次把真实会话强制降级为 DOM 后，协议、history、输入、ACK、resize 和文字可见性全部正确，但 Claude Code 的 Block Elements logo 被字体栅格化为错位的大白矩形；xterm WebGL addon 默认提供的 Box Drawing / Block Elements 自定义 glyph 才是 HRack 浏览器和 Android/Chromium 正常路径。DOM 因此只保证紧急可操作与可返回，不能给含块字符/框线的真实 TUI 做视觉放行。

恢复 WebGL 后，同一 release APK 在以 `-gpu swiftshader_indirect` 启动的 Android 16 AVD 上又把复杂 TUI 稳定裁成水平切片；renderer 状态仍为 `WEBGL`，全部数据面断言仍为绿色。`lineHeight`、`preserveDrawingBuffer`、最终 fit、清 glyph atlas 和 history 前后重建 addon 的单变量探针都未改变结果。把同一 AVD 改为 `-gpu host`，确认 GLES 由 NVIDIA RTX 3090 提供后，同一 APK、同一公网 relay 和同一真实 Claude/Codex 会话正确显示，根因由此定位为模拟器软件 GPU 合成路径，而不是协议、history 或 App 初始化顺序。

因此增加以下纪律：

1. WebGL 预检必须分成“孤立固定夹具”和“真实 PTY history + live + resize 后画面”两类；前者不能替代后者；
2. Android/Chromium 正常路径应与 HRack 浏览器实现一致使用 WebGL 自定义 glyph；DOM fallback 必须可观测并保留释放能力，但不得宣称 Claude/Codex 块字符视觉正确；
3. Android 模拟器视觉验收必须记录 GPU 后端。`swiftshader_indirect` 只可承担非视觉协议检查；当前复杂 TUI 的模拟器放行证据使用 `-gpu host`；
4. 必须至少保存真实 AI 启动首屏、交互后画面、持续输出尾部和旋转画面，并同时检查 renderer 状态与最终像素；`renderer=WEBGL` 不是视觉正确证明；
5. 当前真实 AI 像素门禁在终端区域统计连通字形高度：软件 GPU 裁切样本的完整高度比例约 0.153，门禁要求大于 0.7，并要求存在足够多的终端字形；
6. `preserveDrawingBuffer`、清 glyph atlas 或重建 addon 只能作为待验证假设，不能在没有红色复现和截图证据时写成已修复；
7. renderer 降级不得改变数据面、history/live 顺序、解析后 ACK 或 React 外字节通道；Android 物理机仍需复跑同一真实 PTY/AI CLI 视觉门禁。

手机输入也必须有可验证的组合安全路径。WebView 隐藏 textarea 在自动化环境中可能无法稳定接收系统键盘事件；允许提供原生提交式输入框，组合期间只编辑本地草稿、显式提交后一次发送最终文本和回车。它不能删除 xterm 原生输入，但可以作为中文 IME 安全入口与真实接口自动门禁入口。

### 4.8 xterm 辅助元素也必须进入视觉门禁

2026-08-21 的 Playwright WebKit 全桥接门禁出现过一个典型假绿灯：故意乱序的 history、同时到达的 live、`history-ready → parsed`、ACK 字节数、Native 输入回传、xterm buffer 与 `.xterm-rows` 全部正确，最终截图顶部仍多出约 32 个连续 `W`。即使只统计可见文字带不少于四行，也会因为错误覆盖层自身贡献一行而通过。

定向隐藏第 0 个真实终端行后，`W` 仍在同一位置，证明它不属于 PTY 输出。当前固定 xterm 6 beta 在 Chromium 中使用 OffscreenCanvas font metrics；WebKit 缺少完整指标时退到包含 32 个 `W` 的 `.xterm-char-measure-element` 测宽，而对应 beta CSS 没有把该探针移出画面。App 最终显式把探针绝对定位到屏幕外并设为 `visibility: hidden`，保留布局测量能力；少于 20 cells 的固定夹具又增加“非背景像素不得越过 200 px”的负向断言。修复前 WebKit 稳定为 268 px，修复后 Chromium/WebKit 都通过并人工看图正确。

由此新增以下纪律：

1. 字宽、IME、无障碍和 selection helper 都属于最终合成画面；不能只检查 xterm buffer、`.xterm-rows` 或 canvas；
2. 视觉门禁必须同时验证预期内容与禁止区域/异常延伸，不能只数行或只做事件断言；
3. 升级 xterm 核心或 CSS 时，必须重新检查 helper 隐藏规则；App 自有补丁要保留可测量性，不能用 `display: none` 让 cell measurement 归零；
4. Playwright WebKit 能提前发现 WebKit 引擎问题，但不能替代 iPhone/iPad 安装版 WKWebView 的 safe area、系统 IME、旋转和内容进程恢复；
5. 当前 Safari/WKWebView 从启动即走 DOM，因此现有 WebKit 证据只放行资源、桥接与 helper 边界，不能放行 Claude/Codex 块字符视觉；Android/Chromium 真实会话使用 WebGL，并已在 host GPU 模拟器通过真实 PTY 截图与像素门禁，仍需 Android 物理机复验。

### 4.9 软键盘避让必须同步唯一 winsize

Android 的 `adjustResize`、edge-to-edge 和 React Native `KeyboardAvoidingView` 不是“配置过就算完成”。2026-08-21 的安装版 Android 16 门禁先后发现：过大的终端 `minHeight` 会让系统已显示 IME 但 WebView 不收缩；直接使用 `KeyboardAvoidingView(height)` 又可能在 `keyboardDidHide` 后残留收缩高度。

因此终端页还必须满足：

1. 用系统真实 IME 可见状态证明键盘确实打开/关闭，不能只调用 focus/blur；
2. 键盘打开后 WebView 必须重新 fit，并把新 cols/rows 作为同一个被驾驶 PTY 的唯一 winsize；隐藏后再次 fit 和恢复；
3. App 显示格子、桌面权威 drive state 与截图三者在打开和恢复两个时点一致；
4. 修复避让时不得重挂 WebView，否则会清空 xterm buffer、破坏 history/live 顺序；
5. Gboard 英文键盘证明 43 × 31 → 43 × 16 → 43 × 31；较高的 Fcitx5 Pinyin 又证明 43 × 15。模拟器中文组合通过后仍要在物理设备输入法上复验最终提交前没有 `pty-in`。

键盘打开/关闭通过后还必须继续旋转一次。React Native 0.83 Android 的 `KeyboardAvoidingView(height)` 会在内部 `state.bottom > 0` 时套用 `_initialFrameHeight` 和 `flex: 0`；把 `enabled` 切成 false 只会把本次计算的 `bottomHeight` 变成 0，并不保证旧 state 已清除。实际事故表现为竖屏看似恢复 43 × 31，随后横屏只更新宽度到 97 列，高度仍锁在 31 行并让界面向下溢出。当前 App 仅在 Android 键盘可见时设置 `behavior=height`，隐藏时移除 behavior 来恢复 flex 布局，不重挂 WebView。自动门禁必须等到横屏同时满足“列数增加、行数减少”，人工截图还要确认终端、命令栏和附加键没有溢出屏幕。

### 4.10 原生命令输入必须保留 IME 组合能力

Android 终端输入框不能沿用普通 shell 输入常见的 `autoCorrect={false}`。React Native 0.83 会把它映射为 Android `TYPE_TEXT_FLAG_NO_SUGGESTIONS`，可能同时关闭中文 IME 的候选/组合能力。也不能简单改成 `true`，否则会请求输入法自动纠正英文 shell 命令。Android 应不设置该标志；iOS 可以继续显式关闭纠错。

真实中文门禁还必须区分三层状态：

1. 配对 URL 与终端中文输入不是同一场景。自动输入 URL 前固定英文键盘，避免中文标点把 `https://` 改成全角；进入终端后再切中文 IME；
2. 组合串可能显示在 IME 自己的 preedit 区，而不进入受控 `TextInput`。门禁不能要求 App 草稿一定出现裸拼音；应证明候选提交前 PTY 没有拼音、候选提交后 App 草稿出现最终中文、显式发送后 PTY 只出现最终中文；
3. 输入法语言包缺失是测试设备前置失败，不是 App 协议失败。2026-08-21 预装 Gboard 拼音持续等待下载且 MDD 数据缺失，最终改用核对官方 SHA-256 的离线 Fcitx5 Android 0.1.3 内置 Pinyin 完成证据；验证记录必须写明实际 IME，不能只写“中文键盘已选中”。

### 4.11 点击终端必须进入原生组合安全输入路径

移动端用户的主要输入手势是点击终端画面，不能要求先准确点击屏幕底部的命令框。xterm 会在 pointer down 时聚焦 WebView 内的隐藏 textarea；若 App 的组合安全入口是原生 `TextInput`，两者之间必须有显式、带当前 `sessionId` 的本地桥接，Native 还必须复核会话仍为 `driven`，不能接受旧页面或旧会话的聚焦请求。

桥接同时要保留终端手势：不要在 WebView 外盖住终端，也不要取消 xterm 的 pointer 事件。当前 App 将真实会话的隐藏 textarea 设为 `inputMode=none`，并在捕获阶段把小位移、短时长的 pointer down/up 识别为轻点；拖动继续用于滚动/选择，实体键盘输入也不被禁用。轻点后由 Native 聚焦原生命令草稿，中文仍按“组合只进草稿、显式提交才进 PTY”的规则处理。

Android 门禁必须从点击 `terminal-webview` 开始，至少证明：原生命令框获得焦点、真实 IME 有非零布局影响、WebView/桌面唯一 PTY 的 rows 同步减少，以及最终输入进入同一 PTY。单独的 `mInputShown=true` 不足以放行：模拟器关闭“实体键盘下显示软键盘”时只会出现零 inset 的侧边工具条；Gboard 首次手写引导也会让 IME 标记可见但不产生普通键盘布局事件。测试设备需固定 `show_ime_with_hard_keyboard=1` 和 `stylus_handwriting_enabled=0`，并以焦点、截图和实际 rows 变化交叉验证。

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

结构性断言检查终端 buffer 中的字符、列宽和样式；视觉截图检查字形、基线、裁切、实心异常块与颜色。截图允许按平台维护基线，但不能用大面积容差掩盖一格错位。emoji 不作为跨平台列宽权威夹具，因为平台字体和 Unicode 宽度策略差异过大。

## 7. P8 关门门禁

P8 必须同时满足以下四层证据：

1. **静态 parity：** App 与当时 HRack lockfile 的终端版本一致；字体四件套和许可证存在；HRack Dark 完整 palette 一致；renderer 首选与 fallback 可观测。
2. **确定性呈现：** §6 夹具在至少一台 iOS 和一台 Android 真机上通过 buffer 断言与视觉检查；断网冷启动仍使用打包字体。
3. **真实功能链路：** 真机 App → 公网 HTTPS/WSS/反向代理 → HRack Electron → 真实 PTY。手机输入必须出现在 PTY 权威历史，真实输出必须被手机终端解析后才 ack；旋转只改变被驾驶 PTY，返回列表后桌面解锁并 fit。
4. **真实 AI CLI：** 至少用 Claude Code 和另一个全屏/彩色 AI CLI 各完成一次可见 smoke：logo/box drawing 无错格，历史与 live output 不乱序，中文 IME 不逐键发送，长时间输出没有因错误 ack 造成无界堆积或停顿。

协议和数据面自动门禁应保持 renderer 无关；视觉门禁必须明确期望 renderer，并对最终合成像素做正向/负向检查。一次人工真机视觉验收不能替代自动化；自动化也不能替代真实设备与真实公网接口测试。验证记录必须写明设备/系统、App commit、HRack commit、中继版本、renderer 状态、GPU 后端、是否走公网，以及真实接口结果。

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
