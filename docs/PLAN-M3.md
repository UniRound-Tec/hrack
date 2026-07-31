# M3 实施计划 —— 多 Tab

> 目标:新建 / 切换 / 关闭 Tab,各自独立 pty 与缓冲。
> 对应 [SPEC.md](./SPEC.md) §9 里程碑 M3,设计依据 SPEC §6(多 Tab 状态模型)。
> 前置:M0–M2 已完成(`0d67667`),单会话回显 + resize + 背压链路已固化为 E2E 门禁
> (见 [TEST-terminal-stress.md](./TEST-terminal-stress.md))。
> 状态：**已完成（2026-07-31）**。完整 E2E 42/42、压力门禁 5 轮 20/20 通过。

---

## 1. 范围界定

**做**:

- Tab 栏 UI:新建、切换、关闭、标题显示(OSC 标题 → `onTitleChange`)。
- `tabsStore`(Zustand):Tab 元数据 + `activeTabId`,对齐 SPEC §6。
- 每 Tab 一个常驻 xterm + 独立 pty;非活动 Tab 隐藏保活,不卸载。
- 键盘快捷键最小集:新建 / 关闭 / 循环切换。
- 调试桥从单例改为多终端注册表(E2E 基建,M3 必须动)。
- E2E:补上 TEST 文档 §1 明确列为未覆盖的"多会话"流程。

**不做(留给后续里程碑)**:

- Tab 拖拽排序、拆分窗格、多窗口(M5+/未列入)。
- WebGL / 渲染降级链(M4)。
- 侧栏、首页、设置(M5)。
- Tab 恢复(重启后还原会话)、自定义 shell 选择(M5 设置面板)。
- 语义监控的 `sessionId ↔ tabId` 关联(S 线;但本计划的 Tab id 设计为其预留,见 §3.1)。

---

## 2. 现状盘点(M2 基线对 M3 的支撑与阻碍)

**主进程:几乎零改动。**

- `PTYManager` 本就是 `Map<ptyId, ManagedPty>` 多实例设计;每个 pty 独立持有
  `PtyHistory` / `PtyDataQueue`(背压水位独立)/ `ConptyResizeFilter` / 500ms resize
  静默计时。多 Tab 并发不共享任何可变状态。
- IPC 事件 channel 本就按 ptyId 隔离(`pty:data:{ptyId}` 等),preload 的
  `onData/onExit` 返回取消函数,泄漏防护已就位。

**Renderer:所有"单会话假设"集中在这里,是 M3 的全部工作量。**

| 现状 | 对 M3 的阻碍 |
|---|---|
| `App.tsx` 硬编码渲染单个 `<TerminalView/>` | 需改为 TabBar + Tab 内容区 |
| `useXterm` 自己 spawn pty,外界拿不到 ptyId 与标题 | 需向上回报 title / exit,供 Tab 栏显示 |
| `debugBridge` 是模块级单例,`window.__vibingDebug` 只指向唯一终端 | 多 Tab 下后注册者覆盖前者;现有全部 E2E 依赖此 API,必须兼容改造 |
| `fitVisual` 无 0 尺寸防护 | `display:none` 的容器尺寸为 0,fit 会算出垃圾行列并发给 pty |
| 无状态库 | 需引入 `zustand`(SPEC §8 选型,尚未安装) |

---

## 3. 设计

### 3.1 `tabsStore`(Zustand,SPEC §6)

```ts
interface Tab {
  id: string        // crypto.randomUUID();语义线未来用它关联 sessionId
  title: string     // onTitleChange 驱动;初始 "Terminal N"
  exited: boolean   // pty 已退出但 Tab 保留时为 true(见 §3.4)
}
// state: tabs: Tab[], activeTabId: string
// actions: addTab(), closeTab(id), activateTab(id), setTitle(id, t), markExited(id)
```

- **ptyId 不进 store**:spawn 仍发生在 `useXterm` 内部(每个 TerminalView 实例
  拥有自己的 pty 生命周期,cleanup 时 kill)。store 只管 UI 元数据,遵守 SPEC §0
  "PTY 输出不进 React state";Tab 与 pty 的绑定关系就是"组件实例 ↔ 它 spawn 的 pty"。
- 关 Tab = 从 `tabs` 移除 → React 卸载该 TerminalView → `useXterm` cleanup 已有的
  `proxy.kill()` 释放 pty 与主进程权威历史(`PTYManager.kill` 语义不变)。

### 3.2 组件结构与保活

```
App
├── TabBar            (读 tabsStore;新建/关闭/切换按钮)
└── 内容区
    └── tabs.map(tab =>
          <div key={tab.id} style={activeTabId===tab.id ? {} : {display:'none'}}>
            <TerminalView tabId={tab.id}/>
          </div>)
```

- **`key=tab.id` + 全量渲染 + CSS 隐藏**:非活动 Tab 的 xterm 与 pty 常驻,
  切换不卸载,scrollback / 光标 / alternate buffer 状态全保留(SPEC §6)。
  xterm 的 write/解析不依赖可见性,后台 Tab 照常消费数据并 ack,
  **背压在后台 Tab 上继续成立**(E2E 验证,见 §6)。
- **`display:none` 的两个必踩坑与对策**:
  1. 隐藏容器尺寸为 0 → `fitVisual` 增加防护:容器 `clientWidth/Height` 为 0 或
     fit 提议的行列非正数时直接跳过,不更新、不发 pty resize。
  2. 重新激活时容器恢复尺寸 → ResizeObserver 自然触发 fit;若窗口在隐藏期间被
     缩放过,此时才把新行列发给 pty(走既有 `sendPtyResize` 去重 + 主进程 500ms
     静默逻辑,无需新机制)。激活同时调用 `term.focus()`。

### 3.3 标题

- `term.onTitleChange(t => setTitle(tabId, t))`;空标题回退 `Terminal N`。
- shell 未发 OSC 标题前显示回退名。不做 cwd 探测(那是 shell 集成话题,超范围)。

### 3.4 生命周期决策

- **启动**:store 初始含一个 Tab(保持现在"打开即有终端"的行为)。
- **pty exit**(shell 里敲 `exit` / 进程崩溃):**保留 Tab,标记 `exited`**,
  终端里已有的 `[process exited with code N]` 提示保持。理由:
  `PTYManager` 在 exit 后特意保留权威历史直到显式 kill——用户最需要回看
  退出前输出的时刻,不能替他把 Tab 关掉。Tab 标题加视觉标记(变灰/徽标)。
  这也与 SPEC §11.5 语义状态 `exited` 的展示语义一致。
- **关闭最后一个 Tab**:关闭窗口(与主流终端一致;窗口生命周期已有
  `window-all-closed` 处理)。若想保窗口,M5 首页落地后再改为"回到首页"。
- **窗口关闭**:主进程既有 `killAll` 兜底,不变。

### 3.5 快捷键(最小集)

| 快捷键 | 动作 |
|---|---|
| `Ctrl+Shift+T` | 新建 Tab |
| `Ctrl+Shift+W` | 关闭当前 Tab |
| `Ctrl+Tab` / `Ctrl+Shift+Tab` | 下一个 / 上一个 Tab(循环) |

- **坑**:焦点在 xterm 内时 keydown 被 xterm 吃掉并编码进 `onData`。
  必须用 `term.attachCustomKeyEventHandler` 拦截上述组合键(返回 `false`
  阻止 xterm 处理),再冒泡/直接调 store action。`window` 级 keydown 只作
  焦点不在终端时的兜底,两处共用同一个判定函数,防止双触发。
- 不做全局(系统级)快捷键,那是 M6。

### 3.6 调试桥改造(E2E 基建)

单例 → 注册表,**保持现有 API 形状不变**以免重写全部既有用例:

- 内部:`Map<tabId, { term, forceResize, ... }>` + "当前活动终端"指针
  (由 TerminalView 在激活时更新)。
- `window.__vibingDebug` 的全部现有方法**代理到活动 Tab 的终端**——
  既有单 Tab 用例(默认只有一个 Tab)行为完全不变。
- 新增多 Tab 专用入口:
  `window.__vibingDebugTabs = { list(): string[], forTab(tabId): VibingDebugApi }`,
  供新 E2E 对非活动 Tab 取证(如后台背压验证)。

### 3.7 i18n

新增 key:`newTab`、`closeTab`(按钮 aria-label / title),五语言补全。

---

## 4. 实施步骤

1. `npm i zustand`。
2. `src/state/tabsStore.ts`:§3.1 的 store + actions；`closeTab` 返回是否为最后一个，
   UI 动作层据此调用 `window.close()`，避免 store 携带窗口副作用。
3. `useXterm` 改造:
   - 增加 `fitVisual` 0 尺寸防护(§3.2);
   - 接受 `tabId` 与回调(`onTitle` / `onExit`),内部接 `term.onTitleChange`、
     在 pty exit 回调里通知 store;
   - `attachCustomKeyEventHandler` 拦截 Tab 快捷键(§3.5);
   - 调试注册改走注册表 API(§3.6)。
4. `debugBridge` 注册表改造(§3.6),先跑通**现有** E2E 全绿再继续。
5. `TabBar.tsx` + `App.tsx` 改造(§3.2 结构),Tailwind 样式对齐现有深色主题;
   Tab 元素带 `data-testid`(`tab-item` / `tab-new` / `tab-close`)供 E2E 用。
6. i18n 补 key。
7. E2E(§6)+ 全量回归 `npm run e2e`、`npm run e2e:stress:repeat`。
8. 更新 SPEC §9 进度注记与 TEST 文档 §1 的"多会话"覆盖状态。

> 步骤 3/4 是既有链路改造,先行并单独验证;5 之后才引入新 UI。
> 任何一步破坏既有压力门禁即停下修复,不带病前进。

---

## 5. 验收标志

- [x] 启动出现 1 个 Tab;`+` 或 `Ctrl+Shift+T` 新建 Tab,新 Tab 有独立 shell 提示符。
- [x] 两个 Tab 各跑不同命令,输出互不串扰(Tab A 的 token 不出现在 Tab B)。
- [x] 切走再切回,scrollback、光标位置、alternate buffer 状态(如 Tab 里开着 `vim`)完整保留。
- [x] 隐藏期间缩放窗口,切回后行列正确(`vim` 重画区域 = 当前终端区域),且隐藏期间未向 pty 发过 0/垃圾尺寸。
- [x] 后台 Tab 跑 2MB 级持续输出:前台 Tab 输入不卡;后台背压指标 `pauseCount>0`、`overflowed=false`;切回后首尾 token 完整。
- [x] 关闭 Tab 后对应 shell 进程消失(无残留),主进程 `ptys` Map 收缩。
- [x] shell 内 `exit`:Tab 保留并显示退出标记,历史可回看;手动关 Tab 才释放。
- [x] 关闭最后一个 Tab 关闭窗口,`killAll` 无残留进程。
- [x] 标题:`ssh` / 改 window title 的命令能更新 Tab 标题。
- [x] 快捷键三组全部生效,且焦点在终端内时不会漏字符进 shell。
- [x] **既有 E2E 全绿**(`npm run e2e`),压力门禁 `e2e:stress:repeat` 通过——多 Tab 改造不许回归单会话质量。

---

## 6. E2E 计划(`e2e/tabs.spec.ts`)

对应 TEST 文档 §1 中"多会话并发"这条已声明的空白:

1. **独立性**:两 Tab 各写唯一 token,分别经 `forTab()` 断言 xterm buffer 与
   主进程 raw history 都只含自己的 token。
2. **保活**:Tab A 建 36 行 scrollback → 切到 B → 切回 A,逻辑 buffer 逐 token 完整,
   `viewportY/baseY` 不变。
3. **后台背压**:B 激活时让 A 持续输出 ~2MB(复用流程 A 的 token 方案),
   断言 A 的 `flowControl` 出现 pause/resume、`maxObservedBufferedBytes<=1MB`,
   期间 B 中 `requestAnimationFrame` 1 秒内响应。
4. **隐藏期 resize**:A 隐藏期间改窗口尺寸 → 激活 A → 断言 fit 后行列与容器一致、
   pty 收到且仅收到一次新尺寸、无 0 尺寸记录(可查 resize 历史事件)。
5. **生命周期**:关 Tab → 主进程 `history()` 返回 null(已释放);`exit` → Tab 保留
   且历史仍可读;关最后一个 Tab → 窗口关闭。
6. **标题**:发 OSC 0 序列,断言 Tab 栏文本更新。

`e2e/helpers.ts` 增加 Tab 操作辅助(点 `data-testid`、读 `__vibingDebugTabs`)。

---

## 7. 风险与对策

| 风险 | 影响 | 对策 |
|---|---|---|
| `display:none` 下 fit 算出 0/垃圾行列发给 ConPTY | 隐藏 Tab 的 shell 布局被打乱,切回花屏 | §3.2 防护是硬性要求,E2E 用例 4 专门断言 |
| 调试桥改造破坏既有 E2E | 全部回归门禁失效,后续改动盲飞 | §4 步骤 4 单独落地、先全绿再继续;API 形状不变 |
| xterm 吞快捷键 / 双触发 | 快捷键失效或漏字符进 shell | `attachCustomKeyEventHandler` 为主、window 兜底,共用判定;验收项覆盖 |
| 多 Tab 各 256KB 高水位 + 各自 scrollback | 内存随 Tab 数线性涨 | 属预期设计(每会话有界:交付≤1MB + 历史有界);验收记录 5 Tab 基线,不额外设全局上限 |
| React StrictMode/HMR 下 TerminalView 双挂载 → 双 spawn | 幽灵 pty | 既有 `disposed` 防护已处理 spawn 竞态;E2E 断言 spawn 数=Tab 数 |
| 快速连点新建/关闭的竞态 | kill 到错误 pty / 监听泄漏 | pty 生命周期封闭在组件实例内(§3.1),React 卸载语义天然串行;泄漏由既有取消函数机制兜住 |

---

## 8. 与后续里程碑的衔接

- **M4(渲染)**:WebGL addon 按终端实例加载,多 Tab 结构不需要重构;
  注意隐藏 Tab 的 WebGL 上下文数量上限问题,届时在 M4 计划里处理(如非活动降级)。
  已确认当前 DOM renderer 会让 `opencode` 的连续 `▀` 色块出现网格缝；M4 的
  WebGL 首选路径必须消除此现象，并为 context loss 提供 DOM 降级和视觉回归测试。
- **M5(App Shell)**:TabBar 归入 Shell 布局;"关最后一个 Tab"改为回首页。
- **S 线(语义监控)**:`tab.id` 即 SPEC §11.6 `sessionId ↔ tabId` 关联键;
  Tab 栏状态徽标的挂载点在本计划的 TabBar 上预留(仅 DOM 结构,不实现)。
