# 终端组合压力测试流程

> 目标：把“快速 resize 后历史被覆盖、提示符只恢复半行、下一条命令继续覆盖”的人工复现，
> 固化成可重复、可定位的自动化门禁。

## 1. 完全覆盖的边界

这里的“覆盖完全”指：覆盖当前终端实现中所有会改变显示解释方式的状态转换，而不是穷举
无限多组像素尺寸。每条流程同时从 renderer xterm 与主进程原始历史两侧取证。

| 维度 | 已覆盖状态 |
|---|---|
| buffer | normal、alternate、alternate → normal 恢复 |
| 输出 | 已结束输出、持续输出中、resize 后继续输入 |
| 内容 | 短提示符、90+ 字符长行、自动换行、唯一行 token |
| resize | 宽↔窄、高度变化、24+24 步快速拖动、debounce 合并 |
| zoom | 75%、80%、110%、115%、125%、130%、恢复 100% |
| 滚动 | 底部、真实鼠标滚轮离开底部、顶部、中间、返回底部 |
| 恢复 | 提示符完整、下一条命令完整、光标坐标合法、视口回到底部 |
| 数据源 | xterm 逻辑行、xterm 物理视口、主进程 raw history、ED2/ED3 日志 |
| 响应性 | 拖动中 xterm 连续改变列数；空闲终端连续两次 ConPTY resize 均在 400ms 门限内完成 |
| 背压 | 延迟 xterm ack 模拟慢消费者；PTY pause/resume、2MB 输出首尾完整、Renderer animation frame 可响应 |
| 内存 | Main→Renderer 在途+排队字节不超过 1MB；overflow/rejectedBytes 必须为零 |
| 多会话 | 两 Tab 的 xterm/raw history 隔离；normal/alternate 保活；后台 2MB 背压；隐藏 resize；5 Tab 有界基线 |
| 渲染 | 活动 Tab 独占 WebGL；真实 context loss 回退 DOM；100%/125%/80% 连续 `▀` 零缝截图；resize 后网格尺寸/context/renderer 可用；主题/字体运行时切换；内嵌 Maple 加载与连字像素差异；buffer/选区保留原字符 |

暂未包含在本轮门禁中的范围：

- 超过 `PtyHistory` 容量上限后的分页/截断恢复；
- 多窗口并发；
- IME 组合输入与复杂 emoji 宽度；
- Unix PTY 平台矩阵。

这些范围应各自增加独立流程，不能用当前两条 Windows ConPTY 用例假装已经覆盖。

## 2. 自动化流程 A：持续输出背压与内存上限

对应 `e2e/terminal-stress.spec.ts` 第二条用例，队列边界另由
`e2e/pty-data-queue.spec.ts` 以小水位做确定性验证。

1. 把 xterm 解析完成后的 ack 延迟 75ms，模拟 Renderer 消费变慢。
2. PowerShell 连续输出约 2MB 数据，并为首行、末行和完成位置写入唯一 token。
3. 等待主进程背压指标出现 `pauseCount > 0`，证明不是仅凭最终画面推测背压生效。
4. 背压期间请求一个 `requestAnimationFrame`，断言 Renderer 在 1 秒内响应。
5. 恢复正常 ack，等待完成 token 和完整 PowerShell 提示符。
6. 断言：
   - `bufferedBytes` 最终归零；
   - pause 与 resume 都至少发生一次；
   - `maxObservedBufferedBytes <= 1MB`；
   - `overflowed=false`、`rejectedBytes=0`；
   - 权威原始历史包含首行、末行和完成 token。

生产配置采用 256KB/64KB 水位；队列单元测试以缩小水位确定性证明达到配置高水位时
暂停、ack 降至配置低水位后恢复。即便调用方在暂停后继续推送，队列也不会持有超过
硬上限的数据。

## 3. 自动化流程 B：normal buffer 组合压力

对应 `e2e/terminal-stress.spec.ts` 第三条用例。

在组合压力前另有一条响应性守卫：拖动尚未停止时连续采样 xterm 列数，至少应观察到
5 个不同尺寸，防止视觉适配退化成“停手后一次跳变”。随后等待启动输出静默并连续
resize 两次，让第一帧 ConPTY 重画完整返回；第二次 resize 仍必须在 400ms 门限内执行，
防止被过滤的重画错误地重新启动 500ms 输出保护计时。

1. 启动独立 Electron/PowerShell 会话，等待完整提示符。
2. 输出 36 条带唯一 token 的长行，建立可 reflow 的 scrollback。
3. 开始输出 90 条、每条间隔 30ms 的长行。
4. 第 8 条出现后，用真实鼠标滚轮离开底部。
5. 输出继续期间交错执行：
   - 320px / 900px / 420px / 原宽；
   - 480px / 760px / 原高；
   - 125% / 80% / 110% / 原缩放。
6. 再做 24 步缩窄和 24 步扩宽，模拟快速拖窗并覆盖 debounce 边界。
7. 等第 90 条落定，依次滚到顶部、中间、底部，验证 `viewportY/baseY`。
8. 再执行一条命令，验证 resize 后的光标没有从旧位置覆盖内容。
9. 逐项断言：
   - 126 个唯一 token 在 xterm 逻辑 buffer 中全部存在；
   - 同样的 token 在主进程原始历史中全部存在；
   - 合并后的 ConPTY resize 已在输出静默后真正执行；
   - renderer 没收到 ED2/ED3 清屏；
   - 最后一行是完整 PowerShell 提示符；
   - 光标行列在当前终端范围内。

逻辑 buffer 会按 xterm 的 `isWrapped` 合并物理行，避免把正常 reflow 换行误判为字符丢失；
当前视口和提示符仍按物理行检查，因此屏幕错位、半行提示符不会被掩盖。

## 4. 自动化流程 C：alternate buffer 恢复

对应 `e2e/terminal-stress.spec.ts` 第四条用例。

1. 在 normal buffer 输出 28 条长行并记录唯一 token。
2. 用标准 `CSI ?1049h` 进入 alternate buffer，并停在 `ReadKey`。
3. 验证 alternate buffer 没有虚假的 scrollback。
4. 在 alternate buffer 内交错改变窗口宽高和 130% / 75% / 115% / 原缩放。
5. 发送按键退出 `CSI ?1049l`，等待 normal buffer 恢复。
6. 断言退出前的 28 条历史全部存在，提示符完整。
7. 再执行一条命令，断言输入、输出、光标和底部视口都正常。

这条流程覆盖 `vim`、`less`、TUI 类程序使用的缓冲区切换语义，不把 normal buffer 的
scrollback 假设错误地套到 alternate buffer。

## 5. 自动化流程 D：多 Tab 并发与生命周期

对应 `e2e/tabs.spec.ts` 的 12 条用例：

1. 从用户可见的 Tab UI 验证初始、新建、激活、关闭与关闭最后窗口。
2. 两个 Tab 各写唯一 token，分别读取 xterm buffer 与主进程 raw history，断言互不串扰。
   PowerShell 预测历史在夹具中关闭，避免把 shell 自身的跨会话建议误判为 PTY 串流。
3. 切换后验证 normal scrollback、视口位置和 alternate buffer 状态完整保留。
4. 后台 Tab 延迟 ack 并输出约 2MB；断言 pause/resume、1MB 上限、首尾 token，
   同时在前台 Tab 执行真实命令并检查 animation frame 响应。
5. 隐藏 Tab 期间改变窗口尺寸，断言没有新增 resize/零尺寸事件；重新激活后只同步
   一次最新正数行列。
6. 验证 OSC 标题及空标题回退、shell `exit` 后保留历史、手动关闭后释放 PTY。
7. 焦点在 xterm 内验证新建、关闭、正反循环快捷键，随后执行命令确认输入链路正常。
8. 打开 5 个 Tab，断言恰有 5 个 xterm/调试注册项，且每个 PTY 的交付上限均为 1MB。

## 6. 自动化流程 E：WebGL 降级与视觉门禁

对应 `e2e/render.spec.ts` 的 10 条用例：

1. 新建、来回切换 Tab，断言只有活动 Tab 是 WebGL，其余均为 DOM。
2. 用 `WEBGL_lose_context` 触发真实 context loss，断言事件记录、DOM 降级、
   降级前后命令与 scrollback 完整；切出再切回后恢复 WebGL。
3. 在 100% / 125% / 80% zoom 下主动 fit，然后写入连续 `▀` 色带与同字符数的
   ANSI 背景参考带；截图解码后要求两者最长水平连续像素宽度完全一致。
4. 强制 DOM 对照只断言色块存在和真实命令可回显，不把 DOM 已知的字体栅格缝误设为
   可达的零缝目标。
5. 用固定文字填满视口并交替 70/120 列网格；resize 后确认目标行列数正确、WebGL
   context 有效且 renderer 未降级。原同步帧亮度比例断言易受 compositor 调度影响，
   已降级为该功能门禁。
6. 切换亮色主题后同时读取 xterm options 与 chrome CSS 变量，重启应用验证持久化。
7. 修改字号/字体后，活动 Tab 立即产生一次新 PTY resize，隐藏 Tab 在激活前不发送。
8. 确认内嵌 Maple Mono 400 字重已加载，默认字体栈包含繁/简中文系统回退；同一操作符
   fixture 在连字关闭/开启时存在稳定像素差，但 xterm buffer 与选择结果仍是原字符串。
9. M3 alternate buffer、后台约 2MB 背压和 5 Tab 基线叠加 renderer kind 断言，
   验证 renderer 迁移不改变 buffer 保活、ack 或 1MB 上限。

视觉门禁使用 PNG 像素扫描而非 golden 全图，因此不受提示符、窗口装饰等无关区域变化
影响；WebGL 不可用时 `rendererKind()` 前置断言会显式失败。

## 7. 运行方式

单轮门禁：

```powershell
npm run e2e:stress
```

同一套流程连续重复 5 次，用于放大时序竞态：

```powershell
npm run e2e:stress:repeat
```

完整回归（压力测试已自动包含在全部 E2E 中）：

```powershell
npm run e2e
```

仅运行 M3 多 Tab 门禁：

```powershell
npx playwright test e2e/tabs.spec.ts
```

仅运行 M4 renderer / 主题 / 字体门禁（需要 WebGL2 runner；无 WebGL 时显式失败）：

```powershell
npx playwright test e2e/render.spec.ts
```

仅运行 Windows PTY 退出错误边界门禁：

```powershell
npx playwright test e2e/pty-error-guard.spec.ts
```

建议：

- 每次修改 resize、xterm、PTY 数据链路时至少运行单轮；
- 合并前运行 5 次重复；
- CI 普通门禁运行单轮，Windows 定时任务运行重复模式。

### 7.1 失败后的复跑纪律

- 完整回归出现失败后，**不要立即再次运行整套 `npm run e2e`**；先记录失败用例，
  只复跑该用例并定位根因。
- 单用例复跑使用 Playwright 的文件路径和标题过滤，例如：

  ```powershell
  npx playwright test e2e/render.spec.ts -g "失败用例标题"
  ```

- 若怀疑测试间状态污染，只补跑失败用例及其直接相关的前置用例或同一测试文件；
  不以反复运行整套测试代替定位。
- 定向用例通过后，仅在准备合并或明确需要最终门禁时，再运行一次完整回归。
- App Shell 会压缩终端可用宽度；长 PowerShell 提示符可合法地软换行，完整性
  必须按 xterm 逻辑行断言，不能因最后一个物理行只有 `> ` 误报失败。
- 「resize 后可继续输入」门禁要求输出 token 至少出现一次，并独立断言后续
  提示符完整；不再要求 PSReadLine/ConPTY 一定额外回显一次命令文本。
- 压力组在「侧栏收起」导航模式下执行：260px 窗口宽度是终端极窄 resize 输入，
  若同时保留 280px 展开侧栏，内容区会接近零宽，长行被人为放大成上千软换行并
  正常触发 xterm scrollback 淘汰，偏离了该组要验证的 PTY/resize 不变量。

## 8. 失败如何定位

| 失败信号 | 优先检查 |
|---|---|
| renderer 少 token，raw history 不少 | resize 过滤/reflow/光标同步显示链路 |
| renderer 与 raw history 都少 token | node-pty 读取或历史容量/记录链路 |
| ED2/ED3 大于 0 | 新的 ConPTY 重画变体绕过过滤器 |
| 最后一行不是完整提示符 | resize 后 cursor sync 或当前行 reflow |
| alternate 无法退出/normal 历史不恢复 | buffer 切换序列或 resize 对 alternate 的处理 |
| `viewportY !== baseY` | 滚动恢复或用户输入后的自动回底逻辑 |
| `pauseCount === 0` | ack 是否在 xterm write callback 后发送；持续输出是否真正超过高水位 |
| `overflowed` / `rejectedBytes > 0` | node-pty pause 是否生效；单个 chunk 或水位配置是否超过 1MB 硬上限 |
| `bufferedBytes` 无法归零 | ack 字节数、IPC handler 或低水位排队 flush 链路 |
| 后台 Tab 出现前台 token | `tabId → PtyProxy/debug registration` 绑定或测试 shell 预测历史 |
| 隐藏期出现 resize / 非正数行列 | `fitVisual` 的容器尺寸防护或激活后的 ResizeObserver 时序 |
| 一次快捷键执行两次 | xterm keydown 与 window 兜底是否重复处理同一终端焦点事件 |
| 活动 Tab 不是 WebGL / 多个 Tab 同时是 WebGL | `active` effect 的 rAF 校验、旧 addon dispose 与调试注册绑定 |
| context loss 后仍报告 WebGL | `onContextLoss` 是否 dispose 当前 addon；canvas 是否支持 `WEBGL_lose_context` |
| 连续 `▀` 色带宽度小于 ANSI 参考带 | WebGL custom glyph、zoom 后 fit/renderer 尺寸同步或截图扫描坐标 |
| 主题只改终端或只改 TabBar | `settingsStore` 订阅与 `applyChromeTheme` CSS 变量链路 |
| 字体变化时隐藏 Tab 收到 resize | `activeRef` 在 fit 与最终 `sendPtyResize` 两处的防护 |
| shell `exit` 时主进程弹出 `Cannot resize a pty that has already exited` | pending resize 是否在退出时清理；native resize 失败是否被当作 best-effort 丢弃 |
| `opencode` 退出时主进程弹出 `write EAGAIN` | `PtyErrorGuard` 是否在 spawn 后立即安装；ConPTY `inSocket` error listener 与 node-pty 输出管道 listener-count 约定是否仍满足 |
| TUI 退出后无法拖选文案 | alternate→normal 时是否仍残留非 `none` mouse tracking；`bufferChangeDisposable` 是否关闭全部鼠标协议 |

压力用例失败时不应简单增加固定等待时间。先用上述双数据源判断是“源数据丢失”还是
“显示解释错误”，再针对对应链路修复。
