# F2 AI CLI 会话分组与侧边栏拖拽实施计划

> 状态：**核心实现完成，自动化验收通过**  
> 设计确认：2026-08-06  
> 依赖：稳定 `terminalId`、AI Session/Terminal 生命周期、侧边栏子终端、注意力优先排序开关  
> 目标：允许用户在侧边栏自由排列 AI CLI 会话，通过约 800ms 悬停拖放创建和扩充分组，
> 并让注意力优先以“未分组会话或整个分组”为最小移动单位。

实施证据（2026-08-06）：

- `sessionNavigation` 深模块已覆盖恢复水位线、重复意图、跨组移动、单成员/空组、坏持久化与注意力提升；
- Electron Pointer E2E 已覆盖 800ms 建组、快速拖动只排序、重命名、移出、解散、reload 恢复与顶部 Tab 平铺；
- 右键启动链路已覆盖取消不建组、成功后等待首个 projection 原子建组、源 workspace 默认继承；
- 定向回归 19 项中旧能力 18 项一次通过；唯一测试时序失败在侧栏宽度动画稳定后复跑通过，最终新功能 3/3、纯模型 6/6 全绿；
- `npm run typecheck` 与 `npm run build` 通过。

---

## 1. 结论先行

首版采用**侧边栏分组、顶部 Tab 平铺**的单一数据模型：

```text
Sidebar                                  Top tabs
┌ Group: Backend ───────────────┐        Claude | Codex | OpenCode | Pi
│ Claude Code                   │             ↑ 分组成员保持相邻，但不显示分组 UI
│   └ child terminal            │
│ Codex                         │
└───────────────────────────────┘
  OpenCode
  Pi
```

- 侧边栏分组**始终展开**，没有展开/收起状态、按钮或持久化字段；
- 顶部 Tab 不显示分组标题、容器、菜单或拖拽分组能力，只把分组成员按顺序平铺；
- 未分组会话和整个分组是侧边栏的一级排序单元；
- 分组内部会话有独立的手动顺序；
- 子终端始终跟随所属 AI Session，不成为可分组成员；
- 默认保持手动顺序；注意力优先开启后，收到新活动的会话所属一级单元移动到顶部；
- 数据以稳定 `terminalId` 关联，不依赖延迟出现或会变化的 native Session ID；
- 首版只改 renderer 导航状态，不新增主进程 IPC，不改变 PTY/Agent 生命周期。

## 2. 已确认需求

### 2.1 必做

1. AI CLI 卡片可上下拖动改变顺序；
2. 分组整体可通过标题栏拖动改变一级顺序；
3. 分组内部卡片可重排；
4. 卡片可拖入已有分组，也可拖出到一级列表；
5. 将一张卡片停在另一张卡片上约 800ms 后进入“可分组”状态，松手创建分组；
6. 后续可继续把更多 AI CLI 拖入已有分组；
7. 分组支持重命名和解散；
8. 卡片右键菜单新增“创建分组并启动新的 CLI”；
9. 已在分组内的卡片使用同一入口时，新 CLI 直接加入当前分组，不创建嵌套分组；
10. 注意力优先关闭时，新事件不改变任何手动位置；
11. 注意力优先开启时，分组内任意成员的新活动将整个分组移动到顶部，组内顺序不变；
12. renderer reload 后恢复仍存活 Session 的顺序、分组和名称；
13. 五语言、深浅主题、子终端、关闭/克隆/重命名现有功能不回归。

### 2.2 明确不做

- 分组展开/收起；
- 嵌套分组；
- 顶部 Tab 的分组容器、分组标题或分组拖拽；
- Home 注意力列表、悬浮窗、历史记录按分组聚合；
- 批量关闭、批量克隆、批量发送 prompt；
- 分组级工作区、运行环境或启动参数；
- 把普通终端或子终端作为分组一级成员；
- 跨窗口拖拽；
- 首版键盘拖拽排序；现有键盘点击、菜单与焦点行为必须保留。

## 3. Domain model 与不变量

新增 `SessionNavigationModule` 深模块。调用方只提交用户意图、活动事实和当前有效
`terminalId`，模块内部负责顺序、成员唯一性、清理、分组命名及平铺投影。

### 3.1 持久化快照

```ts
interface SessionNavigationSnapshot {
  schemaVersion: 1
  root: SessionNavigationRef[]
  groups: Record<string, SessionGroup>
}

type SessionNavigationRef =
  | { kind: 'session'; terminalId: string }
  | { kind: 'group'; groupId: string }

interface SessionGroup {
  id: string
  name: string
  members: string[] // ordered terminalIds
}
```

选择 `terminalId` 的原因：

- provisional Terminal 在 CLI spawn 前已经拥有该 ID；
- Agent projection 到达后仍使用同一个 ID；
- renderer reload / PTY recover 继续使用该 ID；
- native Session ID 可能延迟、重建或按 Adapter 变化，不适合作为 UI 布局主键。

### 3.2 强制不变量

1. 一个 AI `terminalId` 最多属于一个分组；
2. 未分组 Session 在 `root` 中恰好出现一次；
3. 已分组 Session 只在对应 `members` 中出现，不再单独出现在 `root`；
4. 一个 Group 在 `root` 中恰好出现一次；
5. Group 不能包含 Group；
6. members/root 不允许重复 ID；
7. 空 Group 自动删除；单成员 Group 保留，便于后续继续加入；
8. 子终端、普通终端永远不会写入该快照；
9. 无效/关闭 Session 只在“恢复水位线完成后”清理，不能在启动空窗提前删除；
10. 任意命令重复执行不得生成重复成员或第二个 Group 引用。

### 3.3 默认名称

拖放创建时使用两个成员当时的展示名生成 `A + B`，最长 48 字符；名称重复允许。
用户改名后不随 Session 改名自动变化。名称 trim 后不能为空；空字符显示错误并保持编辑态。

## 4. 深模块 Interface

外部 seam 控制在三个纯入口，调用方和测试使用同一 Interface：

```ts
type SessionNavigationIntent =
  | { kind: 'reorder-root'; sourceId: string; beforeId: string | null }
  | { kind: 'reorder-member'; terminalId: string; groupId: string; beforeTerminalId: string | null }
  | { kind: 'group-pair'; sourceTerminalId: string; targetTerminalId: string; defaultName: string }
  | { kind: 'move-into-group'; terminalId: string; groupId: string; beforeTerminalId: string | null }
  | { kind: 'move-out-of-group'; terminalId: string; beforeId: string | null }
  | { kind: 'rename-group'; groupId: string; name: string }
  | { kind: 'dissolve-group'; groupId: string }
  | { kind: 'activity'; terminalId: string }

applySessionNavigationIntent(
  snapshot: SessionNavigationSnapshot,
  intent: SessionNavigationIntent,
  options: { attentionPriorityEnabled: boolean }
): SessionNavigationResult

reconcileSessionNavigation(
  snapshot: SessionNavigationSnapshot,
  activeTerminalIds: readonly string[],
  options: { recoveryComplete: boolean }
): SessionNavigationSnapshot

projectSessionNavigation(
  snapshot: SessionNavigationSnapshot,
  sessions: readonly SessionEntry[]
): {
  sidebar: readonly SidebarSessionNode[]
  flat: readonly SessionEntry[]
}
```

`sidebar` 返回 `session | group` 节点供侧边栏渲染；`flat` 将每个 Group 的 members 原位展开，
供顶部 Tab 使用。Sidebar/AppShell 不自行拼 Map、去重或修补坏状态。

模块内部可以拆 reducer、normalizer、projector，但它们是 internal seam，不暴露给生产调用方。

## 5. 排序与注意力语义

### 5.1 默认关闭

- 新 Session 追加到一级列表末尾；
- projection 更新状态、detail、时间，但不改变 layout；
- 拖拽结果立即成为新的手动顺序；
- reload reconcile 保留既有顺序，只把首次出现的有效 Session 追加到末尾。

### 5.2 开启注意力优先

注意力排序采用**事件驱动提升**，而不是每次 render 按时间戳重新全量排序：

- 未分组 Session 有新活动：该 Session ref 移到 `root[0]`；
- 分组成员有新活动：其 Group ref 移到 `root[0]`；
- Group 内 members 顺序不变；
- 打开开关时不回溯重排历史 Session，只影响之后的新活动；
- 用户仍可手动拖动；手动结果保持到下一次需要提升的活动发生；
- 同一一级单元已经在顶部时不重复写 persistence。

AppShell 的 Agent projection 订阅在恢复完成后比较 `lastActivityAt/projectionSeq`，只对真正的新增量
派发 `activity`。`listActive()` 恢复快照不得把所有历史 Session 当成新消息。

### 5.3 拖拽期间的活动

拖拽开始后冻结当前导航投影。期间收到的 attention promotion 放入内存队列；pointer up/cancel
完成后再按到达顺序应用，避免拖拽目标在鼠标下突然换位。该队列不持久化。

## 6. 拖拽状态机

首版使用 Pointer Events + pointer capture，不使用浏览器 HTML5 Drag API。实现集中在
`SidebarSessionDragController`，Sidebar 只消费状态与提交最终 intent。

```text
idle
  └─ pointerdown
       └─ pressed (移动 < 5px 仍是普通点击)
            └─ dragging
                 ├─ between target → reorder preview
                 ├─ card/group hover → dwell 800ms → group-armed
                 ├─ Escape/pointercancel → cancelled
                 └─ pointerup → commit one intent
```

规则：

- 从卡片主体开始拖动；菜单、关闭、rename input、子终端行标记 `data-no-session-drag`；
- 5px 移动阈值之前不阻止现有点击导航；
- 拖拽 overlay 通过 portal 渲染，避免被侧边栏 overflow 裁切；
- 原位置显示 placeholder，目标间隙显示插入线；
- 指针稳定停留在另一卡片/Group 容器 800ms 后显示完整包裹高亮；
- 800ms 只“武装”，必须 pointer up 才提交，移出或换目标立即清除 timer；
- 同一 Group 内悬停成员只表示组内重排，不再次创建 Group；
- member 拖到未分组卡片并完成 dwell：从旧 Group 移出，与目标创建新 Group；
- Group 标题栏可拖动整个 Group，但 Group 不能拖进另一个 Group；
- 侧边栏上下 28px 边缘启用有界自动滚动；move 更新合并到 animation frame；
- Escape、窗口 blur、pointercancel、Session 在拖动中关闭都必须无 mutation 收尾。

## 7. 侧边栏 Group UI

Group 始终完整渲染：

```text
┌ Backend · 3                                      ... ┐
│ Claude Code                                          │
│   └ PowerShell child                                 │
│ Codex                                                │
│ OpenCode                                             │
└──────────────────────────────────────────────────────┘
```

- Header：名称、成员数、`...`；整条 header 是 Group 拖动区域；
- Body：复用现有 Session Card，不维护第二套状态/菜单实现；
- Group 使用主题 token 的轻边框/轻背景，不硬编码颜色；
- Group 没有 chevron、折叠高度、collapsed 状态或双击折叠；
- Group menu：重命名、解散分组；解散不关闭任何 CLI；
- Group rename：点击外部保存、Enter 保存、空字符报错；行为与 Session rename 一致；
- grouped Session menu 额外提供“移出分组”和“启动新 CLI 加入分组”。

子终端仍在所属 Session Card 下渲染。移动 Session 时，其全部子终端在视觉和生命周期上一起移动，
但 `parentSessionId`、PTY 与关闭逻辑不改变。

## 8. “创建分组并启动新的 CLI”工作流

### 8.1 菜单语义

- 未分组 Session：显示“创建分组并启动新的 CLI”；
- 已分组 Session：显示“启动新的 CLI 加入此分组”；
- 入口打开现有 New Session Sheet，默认沿用源 Session 的 workspace；CLI、runtime、参数仍可修改；
- 不直接克隆原 CLI，因为用户要求选择新的 CLI。

### 8.2 原子性

`PendingCliLaunch` 增加可选 grouping intent：

```ts
type PendingGroupingIntent =
  | { kind: 'create-with'; sourceTerminalId: string }
  | { kind: 'join'; groupId: string }
```

流程：

1. 打开 Sheet 时只记录 intent，不创建 Group；
2. provisional terminal 创建后，把 intent 绑定到新 `terminalId`；
3. spawn 失败或用户取消：清 intent，不写 layout；
4. spawn 成功但 projection 未到：保留 intent，不显示幽灵卡片；
5. 首个 Session projection 到达后，确认源 Session/Group 仍存在，再一次性创建/加入；
6. 源 Session 在等待期间关闭：新 Session 正常保留为未分组，intent 作废；
7. attention 开启时，分组完成后对新成员派发一次 activity，使整个 Group 到顶部。

该流程禁止以 timeout 猜 Session 已创建，也不能在失败回滚前先写一个空 Group。

## 9. 持久化、恢复与清理

新增独立 Zustand persist store：

```text
localStorage key: vibing-session-navigation
schema version: 1
```

不把 Group 混入 `settingsStore` 或 `sessionsStore`：

- settings 是用户偏好；
- sessions 是主进程 projection 的 renderer 副本；
- navigation layout 是独立的 renderer UI 状态。

恢复顺序：

1. 读取 layout persistence，但标记 `recoveryComplete=false`；
2. 订阅增量 projection；
3. 并行获取 `ptyApi.listRecoverable()` 与 `agentApi.listActive()`；
4. restore 完成后，以有效 AI `terminalId` 一次 reconcile；
5. 删除失效成员/空 Group，补入新 Session；
6. 标记 recovery complete，之后关闭 Session 可即时清理。

不能在初始 `sessions=[]` 时 reconcile，否则一次正常 reload 会永久删掉全部分组。

## 10. 文件与职责

### 新增

- `src/session-navigation/sessionNavigation.ts`：深模块 Interface、intent reducer、reconcile、project；
- `src/session-navigation/sessionNavigationStore.ts`：persist adapter、恢复水位线、拖拽期间 deferred activity；
- `src/session-navigation/dragController.ts`：Pointer Events 状态机、dwell、collision、auto-scroll；
- `src/session-navigation/SessionGroup.tsx`：永远展开的 Group chrome 与 rename/menu；
- `e2e/session-grouping.spec.ts`：真实 Electron 拖放、活动提升、reload、launch rollback；
- `e2e/session-navigation-model.spec.ts`：通过深模块 Interface 验证全部不变量。

### 修改

- `src/app/Sidebar.tsx`：改为渲染 projected sidebar nodes，接入 overlay/placeholder/menu；
- `src/app/AppShell.tsx`：恢复水位线、projection activity、pending grouping launch 编排；
- `src/app/TopTabBar.tsx`：接收 flat projection；不增加 Group UI；
- `src/app/NewSessionFlow.tsx` / launch draft：接受可选 workspace 默认值与 grouping context；
- `src/state/sessionsStore.ts`：继续只保留权威 Session 副本，不保存 Group；
- `src/state/settingsStore.ts`：沿用注意力优先开关，不增加 Group 数据；
- `src/app/i18n/*`：Group、菜单、拖拽提示、错误文案五语言；
- `docs/SPEC.md`：实施完成后回写 F2 状态与非目标。

不修改 `AgentSessionRuntime`、Adapter、PTYManager、History schema 或主进程数据库。

## 11. 分阶段实施与小提交

### P0 — 锁定 fixture 与现有排序前置

- [ ] 固化注意力开关默认关闭、打开后活动提升的 Store 门禁；
- [ ] 固化两个存活 Session + reload 的稳定 terminalId fixture；
- [ ] 记录现有 Sidebar/TopTab/child terminal DOM 基线；
- [ ] 不引入 Group UI。

提交：`test: lock session navigation ordering semantics`

### P1 — SessionNavigationModule

- [ ] 完成 snapshot/intent/reconcile/project；
- [ ] 覆盖重复命令、跨组移动、singleton/empty、坏 persistence 归一化；
- [ ] 增加 persist store version 1；
- [ ] sessionsStore 保持 projection 单一职责。

提交：`feat: add persistent session navigation model`

### P2 — 手动根顺序与 Top Tab 平铺

- [ ] Sidebar 使用 projected nodes；
- [ ] TopTab 使用 flat projection，Group members 相邻但无 Group UI；
- [ ] 新 Session append，关闭/reload reconcile；
- [ ] 注意力关闭时事件不改位置。

提交：`feat: preserve manual session navigation order`

### P3 — 拖拽重排

- [ ] Pointer threshold、capture、overlay、placeholder、插入线；
- [ ] root Session、Group header、Group members、移出 Group；
- [ ] auto-scroll、Escape/cancel、点击导航不回归；
- [ ] 拖拽期间冻结 activity promotion。

提交：`feat: add sidebar session drag ordering`

### P4 — Dwell 分组与 Group UI

- [ ] 800ms dwell armed 状态；
- [ ] pair create、move into existing、跨组 pair；
- [ ] Group header/body、rename、dissolve、remove member；
- [ ] 深浅主题和长名称/窄侧栏视觉门禁。

提交：`feat: group ai cli sessions in the sidebar`

### P5 — 启动新 CLI 并原子分组

- [ ] Session 菜单入口与五语言；
- [ ] workspace 默认值；
- [ ] PendingGroupingIntent；
- [ ] success/projection finalize；cancel/spawn failure/source closed rollback；
- [ ] 无幽灵 Terminal/Session/Group。

提交：`feat: launch a new cli into a session group`

### P6 — 注意力、恢复与完整 E2E

- [ ] Group activity 整组提升，组内顺序不变；
- [ ] reload 不提前 GC，关闭成员正确清理；
- [ ] child terminal 随父卡片移动；
- [ ] Sidebar/rail/tabs/Home/Floating 回归；
- [ ] typecheck、build、定向 E2E、Windows 真机拖拽 smoke。

提交：`test: verify session grouping lifecycle and attention`

## 12. E2E 验收矩阵

### 12.1 排序

- [ ] 默认开关关闭；两个 Session 收到交错事件仍保持创建/手动顺序；
- [ ] root 卡片拖动后顺序立即改变，reload 后恢复；
- [ ] Group header 拖动按整体换位；
- [ ] Group 内卡片重排不改变 Group 的 root 位置；
- [ ] 拖出 Group 后成为一级 Session；singleton Group 保留；
- [ ] 顶部 Tab 平铺全部成员、成员相邻、没有 Group header/toggle/menu。

### 12.2 Dwell 与取消

- [ ] hover 低于阈值不 armed、不分组；
- [ ] hover 达到 800ms 显示 armed 高亮，pointer up 后创建；
- [ ] armed 后移出/换目标取消旧 timer；
- [ ] Escape、pointercancel、window blur 不改变 layout；
- [ ] 同组成员 hover 走 reorder，不创建第二个 Group；
- [ ] Group 拖到 Group 不嵌套、不破坏原状态。

### 12.3 Group 生命周期

- [ ] 两卡创建、第三卡加入、跨组移动均无重复成员；
- [ ] rename 点击外部保存；空名称报错；
- [ ] dissolve 只释放成员，不 stop/kill CLI；
- [ ] 关闭一个成员正确清理；关闭最后成员自动删空 Group；
- [ ] renderer reload 恢复名称/顺序/成员，不 spawn 新 CLI；
- [ ] 恢复列表为空时只在 recovery complete 后 GC 旧布局。

### 12.4 注意力

- [ ] 关闭时 Group 内新活动不移动 Group；
- [ ] 开启后任一成员新活动将 Group 移到 root[0]；
- [ ] Group members 内部顺序不变；
- [ ] 未分组 Session 仍按单体提升；
- [ ] 开启开关不回溯重排历史；
- [ ] 拖拽中活动不移动目标，drop/cancel 后 deferred promotion 生效一次。

### 12.5 启动与回滚

- [ ] 未分组卡片菜单启动成功后创建二成员 Group；
- [ ] grouped 卡片菜单启动成功后加入现有 Group；
- [ ] 默认 workspace 与源 Session 一致但可修改；
- [ ] 用户取消、workspace resolve 失败、spawn 失败均不创建 Group；
- [ ] projection 延迟期间不出现幽灵卡片；
- [ ] 等待期间源 Session 关闭，新 Session 保持独立且无残留 intent。

### 12.6 现有能力回归

- [ ] Session click、右键、rename、clone、close；
- [ ] child terminal create/toggle/close/reload；
- [ ] rail 与 TopTab 导航；
- [ ] Home 注意力列表与 Floating 不读取 Group chrome；
- [ ] 侧边栏内容足够时自然增高，真正超高时只出现预期滚动；
- [ ] 深浅主题、五语言、125%/150% Windows DPI 下 overlay 与 drop target 对齐。

## 13. 风险与防线

| 风险 | 防线 |
|---|---|
| reload 初始空数组清掉全部分组 | recoveryComplete 水位线后才 reconcile |
| projection 晚于 spawn，提前建 Group 留幽灵 | PendingGroupingIntent 等首个 projection 原子 finalize |
| 拖拽中 attention 导致 DOM 换位 | 冻结 projection + deferred promotion |
| 卡片点击被拖拽吞掉 | 5px threshold；未进入 dragging 不 prevent click |
| overflow 中 overlay 被裁切 | portal 到 `document.body`，坐标使用 viewport rect |
| 同一成员重复出现在 root/Group | 所有 mutation 只经 intent reducer + normalize |
| Group 与 native Session ID 恢复错配 | layout 只使用稳定 terminalId |
| 高频 progress 反复写 localStorage | 一级单元已在顶部时 no-op；只持久化真实结构变化 |
| 关闭/移动 Session 时子终端丢关联 | child 仍只认 parentSessionId，布局投影不改生命周期字段 |

## 14. Definition of Done

只有同时满足以下条件才算完成：

1. 侧边栏可自由排序、创建/扩充分组、改名、解散、移入移出；
2. Group 始终展开，代码和 persistence 中不存在 collapsed 状态；
3. 顶部 Tab 平铺展示，未引入 Group chrome 或第二套交互；
4. 默认事件不改位置，注意力开启后以整个 Group 为提升单位；
5. 右键启动成功才分组，所有取消/失败/延迟路径无幽灵状态；
6. reload、关闭、子终端与稳定 terminalId 生命周期门禁通过；
7. 深模块 Interface 测试和真实 Electron Pointer E2E 全绿；
8. `SPEC.md` 回写完成，计划状态改为已实施并附真机证据。
