# 方案 2：主进程权威历史源 —— 架构计划

> 状态：**P0 已通过；已知 ConPTY resize 重画已在主进程确定性隔离，REPRO2 转绿；历史分页/回放兜底待实施**。
> 关联：[SPEC-S.md](./SPEC-S.md)（语义监控线）、[SPEC.md](./SPEC.md)、[PLAN-M0-M1.md](./PLAN-M0-M1.md)。
> 起因：resize 时终端历史丢失，经 E2E 逐层排查，**病根锁定为 ConPTY 行为，与 xterm 配置无关**（见 §1）。

---

## 1. 病根（有原始字节证据，非推理）

通过 E2E（`e2e/resize.spec.ts` 的 REPRO / REPRO2）与真实 dev 会话的原始数据抓取，病根已确证：

**ConPTY 在 resize 后，从屏幕左上角重画它当前视口仅有的那几行，并逐行 `ESC[K` 擦除。** 抓到的原始字节：
```
ESC[?25l  ESC[8;43;32t(设为43行)  ESC[H(光标归位)  <当前屏8行内容,每行ESC[K>
```
- ConPTY **不保留 scrollback**，resize 后只会重发"当前这一屏"。
- 全流程 ConPTY **从不**把光标定位到第 1 行以下，**从不**设置滚动区域——它认死了从 home 重画。
- 当 `baseY=0`（视口在顶端）时，这个"从 home 重画"就地覆盖了 buffer 顶部的历史行 → 内容丢失。

**关键实验对照（决定性）：**
| 测试 | resize 路径 | 结果 |
|---|---|---|
| REPRO | `term.resize()` 直接调 xterm，**不通知 pty** | 内容完美来回，**不丢** |
| REPRO2 | 真实窗口 resize → 通知 pty → ConPTY 重绘 | **塌到 8 行，丢**（复现线上 bug） |

结论：**xterm 的 reflow 是无辜且正确的；丢失 100% 由 ConPTY 的 resize 重绘造成。** 任何"消费这条增量字节流"的终端都会丢——包括 windowsPty、包括调 debounce 时序，全都无效，因为它们都在 xterm 侧，而问题在 pty 侧。

> 这也解释了为何这是 VS Code / Windows Terminal 都要专门处理的老问题：Windows Terminal 因为**自己就是 ConPTY 宿主**、有特权处理；普通 xterm.js 消费者（含 VS Code 集成终端）在 ConPTY resize 上丢 scrollback 是长期已知限制。

---

## 2. 为什么选方案 2（而非方案 1 快照/恢复）

**方案 1（SerializeAddon 快照/恢复）的根本弱点**：它让 xterm 仍是历史的唯一持有者，只在 resize 时抢救——**本质是和 ConPTY 的异步重绘赛跑**。ConPTY 的重绘分多个 chunk 异步到达（实测一次 resize 后来 6+ 个 chunk），"何时算重绘完可以安全恢复"无法可靠判定；早了被覆盖、晚了闪烁。赛跑就有失手。鉴于 ConPTY 行为的刁钻程度（本问题排查了 7 轮），我们不采用任何依赖时序精确性的方案。

**方案 2 的核心principle：把"历史真相"与"当前屏显示"彻底分离。**
- **历史真相**放在主进程一个**对 resize 免疫**的结构里（关键，见 §3）。
- **渲染进程的 xterm 退化为纯显示器**——ConPTY 爱怎么覆盖当前屏都行，因为权威历史根本不在 xterm 里，丢了可从主进程重取。

这是结构性根治：不是"抢救"被覆盖的历史，而是"历史压根不放在会被覆盖的地方"。

**未来可一石二鸟**：[SPEC-S.md](./SPEC-S.md) §9 将 PTY/headless 识别列为语义监听的最后兜底。若后续确实采用该路径，历史真相源与语义监控源可共享**同一个 pty 数据 tap**；但 SPEC-S 当前 S0 只做发现与启动，不提前建设 SemanticTap。

---

## 3. ⚠️ 关键陷阱：headless 不能是"再接一遍同样的流"

**这是方案 2 成败的核心，也是最容易做错的地方。**

天真的做法——"主进程再开一个 `@xterm/headless`，接同一条 pty 字节流"——**会和渲染 xterm 一样丢历史**。因为 ConPTY 的 resize 重绘指令是广播给所有消费者的，headless 照样吃到"home + 重画当前屏"，照样被覆盖。**多接一遍流，不解决任何问题。**

真正对 resize 免疫的历史结构，候选两条路（需 spike 验证选型，见 §4）：

**路线 A：append-only 行记录器（line recorder）**
- 主进程维护一个**只追加**的历史行数组。
- 监听 pty 流：当内容因换行自然滚出屏幕顶部时，把滚出的行**追加**到历史记录（这些行此后不可变）。
- ConPTY 的 resize 重绘只影响"当前屏"区域，碰不到已归档的历史行。
- 难点：要正确识别"哪些行是滚出的、已定稿"vs"当前屏可变区"，本质是复刻一部分终端 scrollback 语义。

**路线 B：原始流留存 + 按需重放（raw stream + replay）**
- 主进程把 pty 的**原始字节流全量留存**（append-only，天然不可变）。
- 需要完整历史时（resize 后、滚动回看），把留存的流**从头重放**进一个当前宽度的 fresh headless，得到正确 reflow 的完整 scrollback。
- 优点：留存原始流最简单、最忠实。
- 难点：流里含中途的 resize 重绘指令，重放时如何处理这些"历史上的 resize"需要设计（可能要在留存时打 resize 标记、重放时跳过 ConPTY 的重绘噪声）。长会话流会很大，需截断/分段策略。

> **结论：方案 2 的可行性 100% 取决于 §3 这个历史结构设计对不对。所以落地前必须先做 §4 的 spike，用 E2E 证明它在 REPRO2 场景下真能保住历史，再谈集成。绝不跳过验证直接改架构。**

---

## 4. 落地步骤（验证优先）

### 阶段 P0：可行性 spike（必做，不通过则回退方案 1）
目标：**用 E2E 证明"对 resize 免疫的历史结构"确实成立**，再投入集成。
1. 在主进程 PTYManager 的 pty 数据处加一个 tap（不影响现有显示链路）。
2. 实现路线 A 或 B 的**最小原型**（先选一条，spike 里可都试）。
3. 扩展 E2E：REPRO2 场景下 resize 后，从主进程历史结构取内容，断言 `P2_LINE_1..20` **全部存在**。
4. **通过** → 进 P1；**不通过** → 记录原因，回退方案 1（快照/恢复）并接受其时序风险。

**实施结果（2026-07-31）：通过。**
- 选用路线 B：主进程 `PtyHistory` 有界保存原始 PTY 输出，并按序记录初始尺寸及每次 resize。
- ConPTY resize 重绘只会追加新 output 事件，无法覆盖已有历史；容量达到上限时从最旧端整事件淘汰，并显式返回 `complete=false`。
- E2E `P0: authoritative main-process history survives ConPTY resize reprint` 在真实 PowerShell/ConPTY 下打印 20 条长行，经过 3 轮窄↔宽 resize 后，从主进程读取仍全部存在。
- 原 `REPRO2` 在 Windows 上保留为预期失败，继续证明 renderer xterm 的历史尚未恢复；它将在 P2 完成时转绿。
- P0 只证明权威原始源成立；“过滤历史 resize 重绘并按当前宽度重放”仍属于 P1/P2，不在本阶段假装完成。

### 阶段 P1：历史源与显示分离
- 主进程历史结构成为权威 scrollback 源。
- 渲染 xterm 保留用于"当前屏"实时显示（低延迟；已识别的 ConPTY resize 重画除外）。
- 定义 IPC：渲染进程按需向主进程请求历史区间（如滚动回看时的分页拉取）。

**当前实施进度（2026-07-31）：**
- 主进程原始历史源与只读 IPC 已完成；当前 IPC 返回有界完整快照，区间分页尚未完成。
- 新增 `ConptyResizeFilter`：仅在主进程刚调用过 resize、且后续字节严格匹配
  `CSI ?25l → [可选窗口尺寸] → CSI H → 重画 → CSI ?25h` 时抑制该事务。
- 识别器支持控制序列跨任意 `onData` chunk；头部不匹配或候选超过安全上限时原样放行。
- **过滤仅作用于 Main→Renderer 显示支路；未经修改的原始数据始终先写入权威历史。**
- 快速 resize 采用“最新代次”而非计数，适配 ConPTY 合并 resize 的行为，避免把后续
  PSReadLine 正常重画误判为欠到的 resize 帧。
- 被抑制帧末尾的绝对光标坐标通过独立 IPC 送到 renderer；xterm 先用正常 CRLF 滚动
  把多出的当前屏行归档进 scrollback，再与 ConPTY 光标行列对齐。这样下一条命令不会
  从旧坐标覆盖历史。
- 组合压力测试发现：应用持续输出时若恰逢 resize，新输出可能只存在于 ConPTY 的整屏
  重画事务中；直接抑制整帧会随机漏掉一行。现在 renderer 仍立即 fit/reflow，但主进程
  会等 PTY 输出静默 500ms 后才把合并后的最新尺寸送给 ConPTY，避免真实输出混入被过滤
  的重画帧。该静默计时只统计真正转发给 renderer 的输出，不统计被过滤的 ConPTY resize
  重画，因此空闲终端连续拖窗不会重复承担 500ms 等待。回归入口与完整流程见
  [TEST-terminal-stress.md](./TEST-terminal-stress.md)。

### 阶段 P2：resize 后历史恢复
- resize 后，渲染 xterm 的 scrollback 被 ConPTY 冲掉时，从主进程历史源重建 xterm 的 scrollback（按当前宽度 reflow）。
- E2E 覆盖：多轮 resize 后显示层历史完整。

**当前实施进度（2026-07-31）：**
- 已知 Windows ConPTY 重画帧现在不会抵达 renderer，因此 xterm 自己的正确 reflow 得以保留；
  `REPRO2` 经过 6 轮真实 pty resize 后已转绿。
- 用户实测的“三次 `ls` → 快速 resize → 连续回车 → 再输出”已固化为回归测试，覆盖
  提示符完整性、光标同步和后续输出不覆盖。
- 这解决了当前已复现的丢历史路径，但尚未替代“从主进程分页回放”的灾难恢复能力。
  未识别的新 ConPTY 变体会安全放行；若它破坏 renderer 缓存，后续仍需靠回放兜底。

### 阶段 P3：与语义监控合流（[SPEC-S.md](./SPEC-S.md)）
- 同一个 pty tap 同时喂：历史结构（本计划）+ 语义 headless（SPEC-S §9 的 PTY/HeadlessScreen 兜底）。
- 确认二者是否可共用一个 headless 实例，还是需分开的数据结构（很可能：历史=append-only 记录器，语义=当前屏 headless，两者共享 tap 但结构不同）。

---

## 5. 架构影响

```
                    ┌─ 原始历史记录器（先写、未经修改，resize 免疫）── 本计划
node-pty 'data' ──┤
                    ├─ ConptyResizeFilter → PtyDataQueue(背压) → IPC → 渲染 xterm
                    └─ SemanticTap（未来）→ 语义 headless（当前屏状态）── SPEC-S §9
                                              ↑ 共享同一原始 tap
渲染进程滚动回看 / resize 后重建 → IPC 向主进程历史记录器按需取数
```

- 渲染 xterm 从"历史唯一持有者"降级为"当前屏显示器 + 历史缓存视图"。
- 主进程成为历史的单一事实来源（与 SPEC-S「语义放主进程、单一事实来源」一致）。

---

## 6. 落地时机

- **不在 M1**。M1 是最小回显链路，本方案是 M3+ 架构量级。
- 依赖：M1（拿到 pty 字节流）已完成 ✅。
- 不与 [SPEC-S](./SPEC-S.md) 当前 S0 绑定；S0 只做跨环境扫描与按安装启动。等 S1 observer 立项且确认需要 PTY/headless 兜底时，再评估与本计划共用 tap。
- `REPRO2` 已于 2026-07-31 转绿；它继续作为真实 ConPTY 回归测试长期保留。

---

## 7. 当前遗留（需在启动本计划时清理）

排查过程中加入的临时诊断，落地时处理：
- `src/terminal/useXterm.ts`：`diag()` / `pty-raw` / `captureUntil` 已在 P0/P2 验证后移除。
- `src/terminal/debugBridge.ts`：`clearSeqLog` / `setSize` 等诊断 API —— 保留（E2E 长期资产）。
- `electron/ipc.ts` `diag:log` + `logs/` 落盘 —— 保留为通用调试通道，或收敛到 debugBridge。
- `windowsPty` 选项：经证实**对本问题无效**，但它对"rows 增加进 scrollback"仍有正面作用，**保留**（当前 build≥21376 不会禁用 reflow）。
