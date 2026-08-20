# HRack Remote P7 计划：App 远程新建 AI CLI

> 状态：2026-08-21 已完成 Android 关门并可进入 P8。安装版 release App 已经公网 WSS 使用桌面 catalog 创建真实 `AgentSessionRuntime`/PTY；失败路径、幂等重试和立即释放驾驶均有自动与截图证据。

## 1. 目标与关门定义

P7 让 Android/iOS App 使用桌面发来的安全 catalog 新建 AI CLI：选择 CLI 和 host/WSL installation，选择最近工作区或手工输入路径，填写可选启动参数，并在 catalog 提供能力时选择免审批。App 发送 v1 `create`，电脑继续走 P5 已验证的首页同源启动链。

关门必须证明：

1. App 只显示 `RemoteLaunchable` 安全字段，不猜 executable、不缓存桌面私有 installation 信息；
2. 工作区为空时 App 不发送；最近工作区可一键选中，手打路径原样交给对应 installation 的电脑侧验证；
3. 参数按首页相同的 shell-like 规则拆成字符串数组，但 App 不调用 shell；免审批只发送布尔意图，参数合并仍由桌面权威完成；
4. 每次提交生成 requestId；失败后的“原样重试”复用 requestId 和 payload，修改表单后是新请求；
5. `create-ok` 与关联的 `drive-ok` 都到达后才显示成功。P8 尚未实现时 App 立即发送 `undrive`，避免没有终端画面的手机长期锁住桌面 tab；
6. `invalid-workspace`、`installation-not-found`、`launch-failed`、`busy`、`duplicate-mismatch` 有不同文案，失败不会多出 tab；
7. Android release App 经公开 WSS 使用最近工作区真实创建 Electron `AgentSessionRuntime`/PTY，桌面出现且 App 列表收到新会话；错误路径经同一公网链路被拒绝且不新增会话。

## 2. 状态机边界

`RemotePhoneClient` 继续是唯一 WebSocket/协议状态机，并新增两块不可变状态：

```text
catalog: { launchable, recentWorkspaces }
creation:
  idle
  → submitting(requestId, payload)
  → created(create-ok 已到，等待同 requestId 的 drive-ok)
  → succeeded(sessionId，已立即 undrive)
  ↘ rejected(reason, detail, 可原样 retry)
```

- `catalog` 可以先于 `sessions-snapshot` 到达并暂存，但只有 desktop 在线且 App `ready` 时才开放新建；
- `peer-leave`、revoke、bad-key、离线和忘记房间都清空 catalog 与 creation，防止显示旧电脑的 installation；
- 只接受当前 pending requestId 的 `create-*` / `drive-*`，迟到响应不能覆盖新请求；
- catalog 刷新不重置用户已经选择且仍存在的 installation；若 installation 消失，UI 要求重新选择；
- App 不窥探 `RemoteDesktopClient` 幂等表，也不自行判断 Windows/WSL 路径是否合法。

P7 没有实际终端 cell measurement。`create` 使用经过协议允许的保守 80 × 24 启动尺寸，并在 `drive-ok` 后立即 `undrive`；桌面随后按当前窗口重新 fit。P8 接入字体就绪后的 xterm 测量时，会用真实 cols/rows 取代这个临时过渡，不保留第二套 winsize。

## 3. 原生界面

会话页右上增加“新建”主动作。无 catalog/电脑离线时不显示一个假表单，而是明确等待桌面目录。

新建页使用原生 React Native 控件：

- CLI 卡片：displayName、adapter；
- installation：Windows/macOS/Linux 或 `WSL · distro`，可显示 version，不显示 executable；
- 工作区：最近路径 chips + 必填 TextInput；
- 启动参数：单行 TextInput，使用与桌面相同语义的 parser 形成 `args[]`；
- 免审批：只有 catalog 提供 label 时显示可切换项；
- 提交期间锁定重复提交；错误区保留当前表单，允许修改后新提交或原样重试；
- 成功页明确“已在电脑启动”，返回会话列表后等待权威 `session-upsert`，不伪造本地 session。

按 Expo SDK 55 / React Native 0.83 的版本文档，表单放在有界 `KeyboardAvoidingView` + `ScrollView` 中，iOS 使用 padding、Android 使用 height，`keyboardShouldPersistTaps="handled"`，保证最近路径和提交按钮在软键盘打开时仍可点击。

## 4. 安全与失败

- requestId 仅是相关键，不承载 room secret；日志和 testID 不包含工作区或 installation id；
- args 拆分后仍受协议数量/长度守卫，绝不拼接为命令字符串；
- create detail 只展示桌面协议允许的有限文本，不显示堆栈或 executable；
- submit 前只做 trim/non-empty；路径存在性、host/WSL 语义和 launch 错误由电脑返回；
- `create-ok` 后若关联 `drive-ok` 未到，不显示假成功；掉线后回离线状态，不自动重发可能已执行的请求；
- 原样 retry 复用完整冻结 payload；任何编辑都产生新 requestId，避免 `duplicate-mismatch`。

## 5. 验证层次

### A. 纯状态机

- catalog 接收、刷新、peer-leave 清理；
- create 报文、80 × 24、参数数组和 skipApproval；
- create-ok 等待 drive-ok、成功后立即 undrive；
- 五种 reject、原样 retry requestId、迟到响应隔离。

### B. React 页面

- CLI/installation 选择、host/WSL 标签；
- 最近工作区与手填必填；
- 参数拆分、免审批开关、提交锁；
- 错误/重试/成功/返回；键盘打开后的可点击性由 Android 实际截图检查。

### C. 本机协议门禁

App 的真实 `RemotePhoneClient` 对接构建后的 localhost relay 与桌面；不通过 reducer 注入 catalog/create 响应。

### D. Android 模拟器 + 公网

1. 安装并冷启动 release App；
2. 经 `https://hrack.modplex.app/` 加入临时房间；
3. Electron 通过 P5 fixture installation 提供安全 catalog 和一个真实最近工作区；
4. App 选择最近工作区、开启免审批并填写参数，创建真实会话；
5. 检查唯一 `AgentSessionRuntime`、PTY 参数、App 成功态和权威 session-upsert；
6. 返回列表后桌面 drive state 为 idle；
7. 提交不存在路径，检查关联 `invalid-workspace` 且 runtime/tab 数不变；
8. 截取新建表单、失败、成功和创建后列表；最后 revoke。

## 6. 分段提交

1. HRack `f8e6081`：`docs: plan remote P7 app creation`；
2. App `97442a2`：`feat: add remote session creation`；
3. App `8874d31`：`test: cover P7 creation failures`；
4. HRack `0f864ad`：`test: add P7 Android public gate`；
5. App `70ec379`：`docs: record P7 Android public validation`；
6. HRack：`docs: close remote P7 app creation`（本提交）。

P7 不运行完整 HRack e2e；桌面 P5 已关门，本阶段只定向运行 App 门禁和新增公网 Android 用例。完整回归留到 P8 最终关门，并遵守 `AGENTS.md` 的失败定向复跑纪律。

## 7. 实现与验证记录

### 7.1 实现

- `RemotePhoneClient` 持有安全 catalog 与冻结的 creation 状态，只接受当前 requestId 的 `create-*` / `drive-ok`；掉线、桌面离开、revoke 和忘记房间都会清空目录与 pending 状态；
- 新建页使用原生 `KeyboardAvoidingView`、有界 `ScrollView`、横向 CLI `FlatList`、TextInput 和 switch；Windows 普通反斜杠、引号、空白转义与桌面 parser 语义一致；
- 提交默认使用临时 80 × 24。只有 `create-ok` 与同一请求的 `drive-ok` 都到达才显示成功，随后 App 立即 `undrive`；请求在途时禁用返回，避免丢失关联响应后把桌面留在锁定态；
- 原样重试复用冻结 requestId/payload；用户修改后再次提交生成新请求；五种拒绝原因有独立文案。

### 7.2 自动门禁

App：

```text
npm run check
Protocol parity passed
Terminal parity passed
6 suites / 23 tests passed

npx expo run:android --variant release
BUILD SUCCESSFUL
```

安装完成后停止 Metro，强制结束 App 再由 Launcher 冷启动，配对页正常出现。

公网 Android 定向门禁：

```text
npx playwright test e2e/remote-p7-android-live.spec.ts -g "creates one real Electron PTY"
1 passed (48.8s)
```

真实链路为 Android release App → `https://hrack.modplex.app/` 对应公网 WSS → relay → Electron。手机选择最近工作区、host installation、免审批和启动参数后，桌面只有一个真实 runtime/PTY，最终参数为 `--yolo p7-mobile-model`；App 成功后桌面 drive state 为 idle，列表收到唯一 Codex upsert。不存在的工作区返回 `invalid-workspace`，活动 runtime 与 recoverable PTY 仍各为 1。房间最终撤销。

首次运行只在第二次表单的 fixture 准备处失败：新会话持久化刷新了最近工作区，覆盖预置的错误路径。门禁改为错误检查前重新发布 fixture catalog，随后只定向复跑失败用例并通过，符合 `AGENTS.md` 的复跑纪律。

### 7.3 证据与边界

App 仓库 `docs/P7-ANDROID-VALIDATION.md` 保存表单、成功、权威会话和错误路径四张模拟器截图。它们已人工检查 safe area、长路径裁切、选中态和错误层级，没有房间密钥。

P7 不冒充完成 Android 物理真机、iOS、真实 Claude/Codex 账号会话，也不实现手机终端 history/live/ack/input/resize。以上均是 P8 的实现或最终硬门禁。
