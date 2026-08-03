# M4 实施计划 —— 渲染与体验

> 状态：**已完成（2026-07-31，含 M4.1 字体/连字与 M4.2 resize 闪屏修复）**。

> 目标:WebGL 首选渲染 + context-loss 降级链;消除 `opencode` 块字符色块网格缝;
> 主题、字体、连字。
> 对应 [SPEC.md](./SPEC.md) §9 里程碑 M4,设计依据 SPEC §5.2(Addon 与渲染降级)。
> 前置:M0–M3 已完成(`895e56e`),多 Tab、resize、背压链路已固化为 E2E 门禁
> (见 [TEST-terminal-stress.md](./TEST-terminal-stress.md))。

---

## 1. 范围界定

**做**:

- WebGL renderer 作为首选;WebGL 不可用 / context loss 时安全降级 DOM renderer。
- **仅活动 Tab 持有 WebGL 上下文**:隐藏 Tab 释放 WebGL 回 DOM,规避浏览器
  单页 WebGL 上下文数量上限(M3 计划 §8 明确移交给 M4 的问题)。
- `opencode` 连续 `▀` 色块网格缝固化为**视觉回归门禁**(截图像素断言,
  不是只验证 addon 加载成功——SPEC §9 已明确此验收要求)。
- 主题系统:终端配色由集中 theme 定义驱动,内置深色(现状)+ 至少一套亮色;
  UI chrome(TabBar 等)颜色与终端主题联动。
- `settingsStore`(Zustand + 持久化):`themeId / fontFamily / fontSize / ligatures`,
  变更即时生效(字体变更触发 fit → pty resize 既有链路)。
- 连字:先验证 `@xterm/addon-ligatures` 的安全边界,再以不依赖 Node 的
  character joiner 接入内嵌 Maple Mono(见 §3.5)。
- **SPEC 修正**:xterm.js 6.0 已移除 Canvas addon
  ([xtermjs/xterm.js#5105](https://github.com/xtermjs/xterm.js/pull/5105),
  breaking change),SPEC §5.2 的"WebGL → Canvas → DOM"三级降级链改为
  **两级:WebGL → DOM**。

**不做(留给后续里程碑)**:

- 设置 UI 面板(M5;M4 只做 store + 应用链路,变更入口走调试桥供 E2E 与开发用)。
- search / serialize / image / web-links / unicode11 等其他 addon(非 M4 验收点,
  按需求在 M5+ 逐个立项)。
- 窗口透明 / vibrancy / acrylic(原 M6,里程碑重排后归 M5.c;但 theme 结构为背景
  alpha 预留字段,见 §8)。
- IME 组合输入与复杂 emoji 宽度(TEST 文档 §1 已声明的独立空白,不借 M4 夹带)。
- 渲染帧率性能门禁(WebGL 带来的吞吐提升只做记录,不设硬性 fps 断言)。

---

## 2. 现状盘点(M3 基线对 M4 的支撑与阻碍)

**主进程:零改动。** 渲染完全是 Renderer 侧话题;背压、历史、resize 过滤不动。

**Renderer 现状与阻碍**:

| 现状 | 对 M4 的影响 |
|---|---|
| `useXterm` 只加载 FitAddon,DOM renderer | 需引入 `addons.ts`(SPEC 目录规划中已有此文件位置)承载 renderer 装载与降级 |
| 主题 / 字体硬编码在 `useXterm` 的 `new Terminal({...})` | 需抽到 `themes.ts` + `settingsStore`,并支持运行期变更 |
| 每 Tab xterm 常驻、`display:none` 隐藏(M3 设计) | 若每实例各挂 WebGL,上下文数随 Tab 数线性增长,超过浏览器上限(约 8–16)时最旧 context 被强制丢弃 → 必须"仅活动 Tab 持有" |
| `debugBridge` 已是按 `tabId` 的注册表 | 直接扩展 renderer 取证入口,E2E 基建可复用 |
| 无 `settingsStore`;`zustand` 已安装 | 新建 store 即可,无依赖变更 |
| 诊断用例 `render-gap-diagnostic.spec.ts` 已完成使命并移除 | 其结论已写入 SPEC §9(DOM 有周期性网格缝、WebGL 缝隙像素为 0);M4 需以正式门禁形态重建,而非恢复旧诊断脚本 |

**已确认的问题机理**(SPEC §9,M4 验收基线):

- DOM renderer 把连续 `▀` 按字体轮廓栅格化,在分数 cell 宽 + 抗锯齿下产生
  周期性网格缝;换字体不能可靠消除,缩放可能放大。
- WebGL renderer 对照实验已确认同一场景缝隙像素为 0。
- 因此**零缝断言只绑定 WebGL 路径**;DOM 作为降级路径只要求"功能正常",
  不要求零缝(那是已证明达不到的)。

---

## 3. 设计

### 3.1 `addons.ts`:renderer 装载与降级链

```ts
// src/terminal/addons.ts
type RendererKind = 'webgl' | 'dom'

interface RendererController {
  kind(): RendererKind
  activate(): void      // 尝试挂 WebGL(幂等;失败留在 DOM)
  deactivate(): void    // dispose WebGL,回 DOM(幂等)
  dispose(): void
}

function createRendererController(term: Terminal): RendererController
```

- `activate()`:`new WebglAddon()` → `term.loadAddon()`。构造或加载抛错
  (无 WebGL2、GPU 黑名单)→ 捕获、记录原因、保持 DOM。
- 订阅 `webglAddon.onContextLoss`:触发即 `dispose()` 该 addon 回 DOM,
  并标记该终端**本会话内不再自动重试 WebGL**(SPEC §5.2"失败即 dispose 并
  fallback"语义;驱动重置引发的反复丢失不值得追,DOM 是正确性兜底)。
  下次 Tab 重新激活时允许再试一次——覆盖"切走时 GPU 抖动、切回已恢复"的常见场景。
- 降级事件写入调试桥(kind、原因、时间),供 E2E 与问题定位。

### 3.2 仅活动 Tab 持有 WebGL

- `useXterm` 已接收 `active`;在 `active` 变化的 effect 中调用
  `activate()/deactivate()`(与既有 `term.focus()` 同处)。
- 隐藏 Tab 回 DOM 后照常解析、write、ack——**背压链路与 renderer 无关**,
  M2/M3 门禁语义不变;不可见时 DOM 渲染开销可忽略。
- 结果:全应用终端 WebGL 上下文数 ≤ 1,与 Tab 数解耦,5 Tab 有界基线
  (TEST §5)天然成立。
- 切换时序:`deactivate()` 同步执行;`activate()` 放入 requestAnimationFrame,
  与既有 fit 节奏对齐——快速循环切 Tab 时中间态只发生"卸载",避免
  attach/dispose 风暴。rAF 回调里须校验 Tab 仍为活动。

### 3.3 视觉回归门禁(`opencode` 缝场景)

复刻机理而非复刻 opencode:向终端写入 N 行连续 `▀`(前景/背景设为两种
不同的纯色),构成一个纯色矩形区域——这正是 opencode 用块字符拼色块的方式。

- 等待渲染稳定后对终端元素截图(Playwright `screenshot({ clip })`)。
- 断言:色块内部(裁掉边缘 1–2px)不存在任何一行/一列像素偏离两种预期
  纯色超过容差——即"零缝"。
- 至少在 100%、125%、80% 三档 zoom 各跑一次(分数 cell 宽是缝的诱因,
  zoom 档位复用既有压力测试基建)。
- 前置断言 `rendererKind === 'webgl'`:若环境无 WebGL 导致降级,用例**显式失败**
  而非静默跳过——门禁跑在无 GPU 环境等于没跑,必须暴露。
- 对照用例:强制 DOM(调试桥开关)后同样截图,只断言色块存在、终端功能正常,
  不断言零缝;该用例同时充当"DOM 路径始终可用"的回归。

### 3.4 主题与 `settingsStore`

```ts
// src/terminal/themes.ts —— 每套主题:xterm ITheme 完整 16 色 + bg/fg/cursor/selection
//                          + chrome 变量(TabBar 背景、边框、前景)
// src/state/settingsStore.ts(Zustand + localStorage persist)
// state:  themeId, fontFamily, fontSize, ligatures
// action: setTheme(id), setFont(family, size), setLigatures(on)
```

- 内置主题:`dark`(把现有硬编码色值原样搬入,默认值,像素级不变)+ `light`
  (新增,验证主题链路不是摆设)。
- 应用链路:store 订阅 → 对每个注册的 term 设 `term.options.theme`(xterm 6
  运行期改 options 即时重绘,WebGL 纹理缓存由 xterm 内部失效重建);chrome 侧
  用 CSS 变量,主题切换时改 `:root` 变量,Tailwind 任意值引用变量。
- 字体:`setFont` → `term.options.fontFamily/fontSize` → 对活动终端触发既有
  `fitVisual`(行列变化走既有 `sendPtyResize` 去重链路);隐藏终端由
  §3.2 既有机制在重新激活时同步,**不需要新机制**。
- 持久化用 zustand persist 中间件(localStorage);M5 设置面板直接读写此 store。
- M4 的变更入口:调试桥暴露 `setTheme/setFont`(E2E 与开发自用),
  不做用户可见 UI。

### 3.5 连字(M4 spike + M4.1 补充实现)

原 spike 确认 `@xterm/addon-ligatures` 通过 `font-ligatures` 解析本机字体文件，
需要 Node `fs`；本项目 Renderer 是 `contextIsolation:true、nodeIntegration:false`，
因此不采用 addon，也不新增字体解析 IPC。

M4.1 使用 xterm 6 已有的 character joiner proposed API：

1. 内嵌标准 Maple Mono v7.9 WOFF2，而不是无连字的 NL 变体；启动时等待字体加载。
2. joiner 识别连续 ASCII 操作符及 Maple 内建标签，返回有序字符串区间；浏览器对
   整段应用字体自身的 OpenType `calt`，不在应用中复制字体的 GSUB 规则。
3. xterm 的 CharacterJoinerService 会先按相同前景/背景属性切段；renderer 在选区
   切开范围或光标进入范围时不合并，所以 ANSI 配色、选择和字符格语义不改变。
4. WebGL 和 DOM renderer 都消费同一 CharacterJoinerService；设置变化即时
   `registerCharacterJoiner` / `deregisterCharacterJoiner`，默认开启。
5. 默认字体栈在 Maple 后按系统回退到 JhengHei/YaHei UI、PingFang、Noto CJK，
   仅让中文等缺失字形走回退字体。设置 UI 仍归 M5。

### 3.6 WebGL resize 同步重画(M4.2)

xterm 6.0 在 `WebglRenderer.handleResize` 中立即改变 canvas 尺寸并清空 glyph model，
但完整 refresh 由 `RenderDebouncer` 放到下一帧，Chromium 可能在两者之间合成近空帧。
上游 PR [#5529](https://github.com/xtermjs/xterm.js/pull/5529) 已改为 resize 后同步
`renderRows`。稳定版未发布该修复，故精确锁定已验证的配对 beta 版本，不使用 `@beta`
浮动标签；稳定版发布后再切回 stable。

回归门禁使用固定文字填满视口，直接快速交替 xterm 的 70/120 列网格尺寸；每次
`resize()` 后验证目标行列数、WebGL context 与 renderer 仍有效。原“同步帧与下一
animation frame 亮度比例”断言在 2026-08-02 降级，因为 compositor 调度会让该断言
产生环境相关的假失败；同步重画能力继续由精确锁定的上游修复版本保证。

### 3.7 调试桥扩展(E2E 基建)

`forTab(tabId)` 增加:

- `rendererKind(): 'webgl' | 'dom'`
- `forceContextLoss(): boolean` —— 经 `WEBGL_lose_context` 扩展触发真实
  context loss(非 mock),返回是否成功触发。
- `rendererEvents(): {kind, reason, at}[]` —— 降级/升级历史。
- 全局:`setTheme / setFont`(代理 store action)。

现有 API 形状不变,既有 42 条 E2E 不受影响。

### 3.8 文档修正

- SPEC §5.2:降级链改两级(WebGL → DOM),注明 Canvas addon 已在 xterm 6.0
  移除;§8 表格与附图涉及 canvas 处同步修正。
- TEST 文档 §1 增加"渲染"维度行,§6/§7 增加渲染门禁运行方式与失败定位。

---

## 4. 实施步骤

1. `npm i @xterm/addon-webgl`（与 `@xterm/xterm` 6.x 成对锁定）；当前因 M4.2
   同步重画修复精确锁定 6.1/WebGL 0.20 beta。SPEC §5.2 降级链修正一并提交。
2. 调试桥扩展(§3.7),现有 E2E 全绿再继续。
3. `addons.ts` + `useXterm` 集成:默认挂 WebGL(活动 Tab)、context loss 降级、
   Tab 切换 activate/deactivate(§3.1–§3.2)。跑全量既有 E2E + 压力门禁,
   **确认 WebGL 化不回归 M2/M3 任何指标**——这是本里程碑最大的回归面。
4. 视觉回归门禁 `e2e/render.spec.ts`(§3.3 + §6 用例 1–4)。
5. `themes.ts` + `settingsStore` + 应用链路(§3.4),含 chrome CSS 变量改造;
   默认主题像素级等于现状。
6. 字体变更链路 + E2E(§6 用例 6)。
7. 完成连字 spike,并在 M4.1 接入标准 Maple Mono + character joiner(§3.5)。
8. i18n:若本阶段新增用户可见文案则补五语言(预期没有,设置入口在 M5)。
9. 全量回归 `npm run e2e`、`npm run e2e:stress:repeat`;
   更新 SPEC §9 进度注记与 TEST 文档(§3.8)。

> 步骤 3 是全部后续工作的地基且回归面最大,单独验证、先全绿再继续。
> 任何一步破坏既有压力门禁即停下修复,不带病前进(与 M3 同纪律)。

---

## 5. 验收标志

- [x] 活动 Tab 默认 renderer 为 WebGL(`rendererKind()` 取证),隐藏 Tab 为 DOM;
      任意时刻终端 WebGL 上下文数 ≤ 1。
- [x] `opencode` 场景(连续 `▀` 色块)在 100% / 125% / 80% zoom 下截图零缝,
      固化为 E2E 门禁;无 WebGL 环境下该门禁显式失败而非跳过。
- [x] 强制 context loss:自动降级 DOM,会话不中断——降级前的 scrollback 完整、
      降级后输入回显正常;降级事件可取证。
- [x] 切 Tab 时 WebGL 正确迁移:切走的 Tab 释放上下文,切回后 scrollback /
      alternate buffer 完整(vim 场景),M3 保活语义不变。
- [x] 主题切换即时生效:终端 16 色 + bg/fg/cursor/selection 与 chrome 同步变化;
      重启后保持;默认主题与 M3 版本像素级一致。
- [x] 字体大小 / 字族变更即时生效,行列重算并同步 pty(vim 重画区域正确),
      隐藏 Tab 激活后才同步(复用 M3 语义)。
- [x] 内嵌标准 Maple Mono,WebGL/DOM 均支持可动态开关的连字;选区、复制与
      字符格坐标保持原义,不放宽 Renderer 安全边界。
- [x] **既有 E2E 全绿**(`npm run e2e`),压力门禁 `e2e:stress:repeat` 通过——
      WebGL 化不许回归背压、resize、多 Tab 任何一项质量。

---

## 6. E2E 计划(`e2e/render.spec.ts`)

1. **默认 renderer**:启动后活动 Tab `rendererKind()==='webgl'`;新建第二个 Tab,
   断言旧 Tab 降为 `dom`、新 Tab 为 `webgl`;来回切换后各自状态正确。
2. **零缝门禁**:写入 `▀` 色块 → 三档 zoom 分别截图 → 逐像素断言无缝(§3.3);
   每档前置断言 renderer 为 WebGL。
3. **DOM 对照**:调试桥强制 DOM → 色块正常显示、命令回显正常(不断言零缝)。
4. **context loss 降级**:`forceContextLoss()` → 断言 `rendererKind()` 变为 `dom`、
   `rendererEvents()` 记录 loss;随后执行真实命令验证输入输出;切走再切回,
   断言允许重试 WebGL(§3.1)。
5. **保活回归**:Tab A 开 `vim`(alternate buffer)→ 切到 B → 切回 A,
   断言 renderer 迁移后 alternate 内容与光标完整(叠加 M3 用例的渲染维度)。
6. **主题与字体**:`setTheme('light')` → 断言 `term.options.theme` 与 chrome CSS
   变量已更新、重启(重开窗口)后保持;`setFont` 改字号 → 断言 cols/rows 变化
   且 pty 收到一次新尺寸(复用 resize 取证)。
7. **内嵌字体与连字**:确认 Maple WOFF2 已加载、默认 CJK 回退栈存在;对同一
   操作符 fixture 开关连字并做像素差异断言,同时验证 buffer/选择仍是原字符串。
8. **背压叠加**:后台 Tab(DOM)跑 2MB 输出、前台 Tab(WebGL)保持交互——
   复用 tabs.spec 流程加 renderer 断言,确认 renderer 迁移不影响 ack 链路。

`e2e/helpers.ts` 增加截图裁剪与像素扫描辅助(读 PNG、按行/列扫描偏离色)。

---

## 7. 风险与对策

| 风险 | 影响 | 对策 |
|---|---|---|
| 截图像素断言脆(抗锯齿、DPI、平台差异) | 门禁误报,团队失去信任后被禁用 | 只断言纯色块内部、裁边 1–2px、明确容差;固定窗口尺寸;断言"行/列级缝",不做全图 golden 比对 |
| CI / 无 GPU 环境 WebGL 不可用 | 零缝门禁形同虚设 | 用例前置断言 renderer 为 WebGL,不满足即失败(§3.3);渲染门禁标注需在有 GPU 的 runner 执行 |
| 快速切 Tab 的 attach/dispose 风暴 | 卡顿或 WebGL 资源竞态 | activate 走 rAF 且回调校验仍为活动 Tab(§3.2);E2E 用例 1 覆盖来回快速切换 |
| WebGL dispose 时机与 `term.write` 并发 | 渲染异常或崩溃 | renderer 与 buffer 在 xterm 内部解耦,addon dispose 是官方支持路径;用例 7 以背压场景验证 |
| context loss 后自动重试造成 loss 循环 | GPU 驱动异常时反复闪烁 | 会话内不自动重试,仅 Tab 重新激活时再试一次(§3.1);`rendererEvents` 留证 |
| `options.theme/font` 运行期变更触发全量重绘 | 大 scrollback 下切主题瞬时卡顿 | xterm 6 官方支持路径,预期可接受;验收时在 36 行+ scrollback 场景人工确认,异常再议 |
| 连字 addon 与安全边界冲突 | 功能承诺落空 | 不使用 addon;内嵌字体 + xterm character joiner,浏览器完成 OpenType 整形(§3.5) |
| 默认主题抽取时色值漂移 | 用户可感知的视觉回归 | 验收明确"像素级一致";零缝截图基建顺手可做主题回归比对 |

---

## 8. 与后续里程碑的衔接

- **M5(App Shell / 设置面板)**:设置 UI 直接读写本计划的 `settingsStore`
  (themeId / fontFamily / fontSize / ligatures),不需要新状态层;
  主题的 chrome CSS 变量即侧栏 / 首页的配色基础。
- **M5.c(窗口质感,原 M6)**:vibrancy / acrylic 需要终端背景透明 → theme 结构中
  background 保留 alpha 通道语义;届时评估 xterm `allowTransparency` 的
  WebGL 性能成本,在 M5.c 计划里处理。
- **S 线(语义监控)**:不受影响——渲染是纯 Renderer 显示话题,SemanticTap
  在主进程,正交([SPEC-S](./SPEC-S.md) §9)。
- **打包(M7)**:WebGL 在各平台打包产物中的可用性(GPU 黑名单、软件渲染)
  届时纳入冒烟清单;降级链保证最坏情况仍是可用的 DOM 终端。
