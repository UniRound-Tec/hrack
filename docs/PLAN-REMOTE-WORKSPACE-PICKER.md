# 远程工作区选择器计划

> 状态：已完成（2026-08-24）
> 日期：2026-08-24
> 范围：Android/iOS App 经既有 1:1 房间浏览 HRack 电脑目录并选择新会话工作区。

## 1. 目标

新建会话页不再要求用户记住并手打电脑路径。用户先选 CLI installation，再打开 HRack 自建目录选择器：看到该运行环境中的真实文件夹和文件，逐层进入目录，选择当前文件夹作为 `create.workspace`。

系统原生 DocumentPicker 只能选择手机或手机文件提供方，不能看到配对电脑，因此本功能必须走 HRack 远控协议，不能伪装成本地文件选择。

## 2. 用户体验

1. 工作区输入框仍保留，兼容粘贴、最近工作区和高级手打路径。
2. 输入框右侧增加目录按钮；点击后进入全屏选择器。
3. 首屏显示所选 installation 的 Home 与文件系统根：Windows 为 Home 与磁盘根，WSL/macOS/Linux 为 Home 与 `/`。
4. 点击文件夹按需读取下一层；文件显示但不可选择，符号链接显示但不自动进入。
5. 当前目录页底部固定“选择此文件夹”；根选择页不允许直接选择。
6. 超过一页时显示“加载更多”；读取失败留在当前页并可重试。
7. 切换 installation 后重新从该运行环境根开始，不复用另一运行环境的路径。

## 3. 协议

- 手机 → 电脑：`workspace-list {requestId, installationId, path?, offset?}`。
- 电脑 → 手机：`workspace-list-ok {requestId, installationId, path, parentPath?, entries, nextOffset?}`。
- 电脑 → 手机：`workspace-list-reject {requestId, reason}`。

`path` 省略时列根；成功响应的 `path=null` 表示根选择页。目录单页 256 项，最多枚举 5000 项；条目只有 `name/path/kind`。Server 只执行协议结构守卫和方向转发，不读取或存储目录。

## 4. 桌面边界

- installation 必须来自当前 `CliScanReport`，失效 id 返回 `installation-not-found`。
- 运行环境决定路径规则和枚举方式；WSL 路径由目标 distro 转换后读取，返回给手机的仍是 POSIX 路径。
- 只调用目录枚举，不读取文件内容；错误归一为稳定 reason，不把主机异常栈送给手机。
- 同时最多处理两条目录请求，断线后的迟到结果不能发给新房间。
- 单次枚举、路径、条目名和最终 JSON 继续受 v1 协议帧上限约束。

## 5. 验证门槛

1. 协议守卫接受合法根、子目录和分页报文，拒绝空路径、NUL、越界 offset 和非法 kind。
2. 桌面定向测试在临时目录真实创建文件夹/文件并枚举，验证目录优先排序、分页、非法路径和失效 installation。
3. Relay 定向测试证明新消息只按 phone → desktop / desktop → phone 方向转发。
4. App 单元测试证明根加载、进入目录、文件禁用、分页、选择当前目录和失败重试。
5. 安装 Android release 后，经 `https://hrack.modplex.app/` 的公开 HTTPS/WSS 房间浏览开发机目录，选中真实目录并启动一个真实 CLI/PTY；不得用内存 mock 代替最终门槛。

## 6. 实现与验证记录

- 根协议、桌面端、App 与 Server 的协议副本已经同步；协议 parity/hash 门禁通过。
- 桌面端真实枚举、请求并发/断线隔离、协议结构守卫、Relay 双向转发、App 根加载/逐层进入/文件禁用/分页/重试/选择均有定向自动测试。
- Android release APK 已安装到模拟器；最终门禁没有使用 CLI fixture、内存 relay 或测试目录，而是使用正式 `https://hrack.modplex.app/` TLS/WSS 中继和电脑上实际安装的 Windows Codex CLI。
- 手机从 `Home` 逐层浏览到当前 HRack 仓库，真实看到 `.git`、`AGENTS.md`、`package-lock.json`、`package.json` 等电脑文件；选择当前文件夹后，手机发出的 `create` 在电脑启动了 Codex PTY。
- 桌面权威状态进一步确认新 PTY 的 `adapterId=codex`、`cwd` 等于手机所选目录、进程仍存活、权威 history 已有非零输出，并且远程驾驶状态为 `driven`；Android HUD 同时确认已解析非零 PTY 字节，截图能看到真实 Codex 启动界面。
- 定向真实门禁：`npx playwright test e2e/remote-workspace-picker-android-live.spec.ts -g "browses the real desktop filesystem"`，结果 `1 passed (3.3m)`；门禁复用既有账号房间，不创建、旋转或撤销房间。
