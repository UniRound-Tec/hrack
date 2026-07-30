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

暂未包含在本轮门禁中的范围：

- 超过 `PtyHistory` 容量上限后的分页/截断恢复；
- 多会话、多窗口并发；
- IME 组合输入与复杂 emoji 宽度；
- Unix PTY 平台矩阵。

这些范围应各自增加独立流程，不能用当前两条 Windows ConPTY 用例假装已经覆盖。

## 2. 自动化流程 A：normal buffer 组合压力

对应 `e2e/terminal-stress.spec.ts` 第二条用例。

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

## 3. 自动化流程 B：alternate buffer 恢复

对应 `e2e/terminal-stress.spec.ts` 第三条用例。

1. 在 normal buffer 输出 28 条长行并记录唯一 token。
2. 用标准 `CSI ?1049h` 进入 alternate buffer，并停在 `ReadKey`。
3. 验证 alternate buffer 没有虚假的 scrollback。
4. 在 alternate buffer 内交错改变窗口宽高和 130% / 75% / 115% / 原缩放。
5. 发送按键退出 `CSI ?1049l`，等待 normal buffer 恢复。
6. 断言退出前的 28 条历史全部存在，提示符完整。
7. 再执行一条命令，断言输入、输出、光标和底部视口都正常。

这条流程覆盖 `vim`、`less`、TUI 类程序使用的缓冲区切换语义，不把 normal buffer 的
scrollback 假设错误地套到 alternate buffer。

## 4. 运行方式

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

建议：

- 每次修改 resize、xterm、PTY 数据链路时至少运行单轮；
- 合并前运行 5 次重复；
- CI 普通门禁运行单轮，Windows 定时任务运行重复模式。

## 5. 失败如何定位

| 失败信号 | 优先检查 |
|---|---|
| renderer 少 token，raw history 不少 | resize 过滤/reflow/光标同步显示链路 |
| renderer 与 raw history 都少 token | node-pty 读取或历史容量/记录链路 |
| ED2/ED3 大于 0 | 新的 ConPTY 重画变体绕过过滤器 |
| 最后一行不是完整提示符 | resize 后 cursor sync 或当前行 reflow |
| alternate 无法退出/normal 历史不恢复 | buffer 切换序列或 resize 对 alternate 的处理 |
| `viewportY !== baseY` | 滚动恢复或用户输入后的自动回底逻辑 |

压力用例失败时不应简单增加固定等待时间。先用上述双数据源判断是“源数据丢失”还是
“显示解释错误”，再针对对应链路修复。
