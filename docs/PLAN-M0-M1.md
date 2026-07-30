# M0–M1 实施计划

> 目标：从空目录，到**能在应用里真正跑起 shell 并正常回显**的最小可跑链路。
> 对应 [SPEC.md](./SPEC.md) §9 里程碑的 M0、M1。
> 原则见 SPEC §0，尤其：xterm 不归 React 管、PTY 输出不进 React state、PTY 只活在主进程。

---

## 范围界定

**M0 — 脚手架**：electron-vite 起窗口，React 渲染出内容，三段构建（main / preload / renderer）跑通，HMR 可用。

**M1 — 最小回显链路**：React 挂一个 xterm → IPC → 主进程 node-pty → 跑本地 shell，键盘输入与输出正常回显、能执行命令。

**本阶段明确不做**（留给 M2+）：背压/ackData、resize 同步的健壮化（M1 先做最简 resize）、多 Tab、WebGL/降级链、App Shell、语义监控、打包。M1 就是一条单会话直链。

---

## 前置环境（已确认）

- Node v24.11.1 / npm 11.6.2
- 目录 `C:/Users/Jesse/Desktop/vibing/vibing`，**当前非 git 仓库** → M0 第一步 `git init`
- 平台 Windows 11 → M1 默认 shell 用 `pwsh`（或 `powershell.exe` 兜底）

### ⚠️ 已知最大坑：node-pty 是原生模块，需匹配 Electron 的 ABI
node-pty 含 C++ 原生代码，必须针对 **Electron 内置的 Node ABI** 编译，而非系统 Node 24。不处理会报 `NODE_MODULE_VERSION mismatch`。
- 方案：用 `@electron/rebuild`（或 electron-builder 的 `postinstall` 自动 rebuild）。
- Windows 还需 C++ 构建工具链（VS Build Tools / `windows-build-tools`）。**M0 阶段就要验证 node-pty 能 rebuild 成功**，别拖到 M1 才发现编译不过。

---

## M0：脚手架

### 技术选型（落实 SPEC §8）
| 项 | 选择 |
|---|---|
| 构建 | electron-vite（同时构建 main/preload/renderer + HMR） |
| UI | React 18 + TypeScript |
| 样式 | Tailwind CSS |
| 打包 | electron-builder（M0 只装依赖、配好，不出包） |

### 依赖
```
# 运行时
electron  react  react-dom
@xterm/xterm  @xterm/addon-fit
node-pty

# 开发
electron-vite  vite  typescript
@vitejs/plugin-react
@types/react  @types/react-dom
tailwindcss  @tailwindcss/vite   (Tailwind v4 走 vite 插件)
electron-builder  @electron/rebuild
```

### 目录（本阶段只建必要部分，对齐 SPEC §1）
```
vibing/
├── docs/
├── electron/
│   ├── main.ts
│   ├── window.ts
│   └── pty/PTYManager.ts          # M1 才填实质内容
├── preload/index.ts
├── src/
│   ├── main.tsx
│   ├── App.tsx
│   ├── index.css                   # Tailwind 入口
│   └── terminal/
│       ├── TerminalView.tsx        # M1
│       ├── useXterm.ts             # M1
│       └── PtyProxy.ts             # M1
├── shared/ipc-contract.ts          # 主/preload/renderer 共享类型
├── electron.vite.config.ts
├── tsconfig.json  tsconfig.node.json
├── tailwind 配置（v4 主要在 vite 插件 + css）
├── package.json
└── index.html
```

### 步骤
1. `git init` + `.gitignore`（`node_modules` `dist` `out` `*.log`）。
2. `npm init -y`，装上述依赖。
3. 写 `electron.vite.config.ts`：三段（main / preload / renderer）入口；renderer 挂 `@vitejs/plugin-react` + Tailwind vite 插件。
4. `index.html` + `src/main.tsx`（`createRoot`）+ `src/App.tsx`（先渲染一行 "Vibing Terminal — M0 OK"）。
5. `electron/window.ts`：封装创建 `BrowserWindow`。**安全基线**：`contextIsolation: true`、`nodeIntegration: false`、`sandbox` 视 preload 需要设定；`preload` 指向构建产物。开发环境 `loadURL(devServer)`，生产 `loadFile(dist/index.html)`。
6. `electron/main.ts`：`app.whenReady` → 创建窗口；`window-all-closed` / `activate` 生命周期。
7. `preload/index.ts`：先空壳（M1 填 API），验证 `contextBridge` 能注入。
8. `package.json` scripts：`dev`（electron-vite dev）、`build`（electron-vite build）。配 `postinstall: electron-rebuild -f -w node-pty`（即便 M0 还没用 node-pty，先把 rebuild 流程验证通）。
9. `@electron/rebuild` 针对 node-pty 跑一次，确认编译通过。

### M0 完成标志（验收）
- [ ] `npm run dev` 弹出 Electron 窗口，显示 React 渲染的 "M0 OK"。
- [ ] 改 `App.tsx` 文案，HMR 即时刷新（不重启进程）。
- [ ] Tailwind class（如 `text-red-500`）生效。
- [ ] `require('node-pty')` 在主进程能成功加载（rebuild 已匹配 Electron ABI）——**这是 M0 最关键的验收项**，用一行主进程日志验证。
- [ ] devtools 无 contextIsolation / CSP 报错。

---

## M1：最小回显链路

### 数据流（本阶段实现的子集，见 SPEC 附录）
```
键盘 → xterm.onData → PtyProxy.write → IPC(pty:write) → PTYManager → node-pty
shell 输出 → node-pty 'data' → IPC(pty:data) → PtyProxy.onData → xterm.write
```
> M1 **不加背压**：先 `xterm.write(data)` 直写。背压是 M2。

### 1) 共享 IPC 契约 `shared/ipc-contract.ts`
定义 M1 需要的最小 channel（对齐 SPEC §3，先不含 ack）：
```ts
// Renderer → Main (invoke)
'pty:spawn'   {shell,args,cwd,cols,rows} -> {ptyId}
'pty:write'   {ptyId,data:string}        -> void
'pty:resize'  {ptyId,cols,rows}          -> void
'pty:kill'    {ptyId}                     -> void
// Main → Renderer (send)
'pty:data:{ptyId}'  Uint8Array | string
'pty:exit:{ptyId}'  {code,signal}
```
> M1 数据先用 string 简化；SPEC 约定的 `Uint8Array` 二进制传输（防多字节截断）放到 M2 与背压一起做，并在此处留 TODO 注释。

### 2) 主进程 `electron/pty/PTYManager.ts`
- `spawn()`：`pty.spawn(shell, args, {cols, rows, cwd, env})`，存入 `Map<ptyId, IPty>`，返回 `ptyId`。
- 监听每个 pty 的 `onData` → `webContents.send('pty:data:'+ptyId, data)`。
- 监听 `onExit` → send `pty:exit`，从 Map 删除。
- `write / resize / kill` 转发到对应 IPty。
- Windows：shell 默认 `pwsh.exe`，回退 `powershell.exe`；`useConpty` 交给 node-pty 默认（系统支持即启用）。

### 3) IPC 注册 `electron/ipc.ts`
- `ipcMain.handle('pty:spawn'|'pty:write'|'pty:resize'|'pty:kill', ...)` 委托 PTYManager。
- 在 `main.ts` 启动时注册。

### 4) preload `preload/index.ts`
`contextBridge.exposeInMainWorld('ptyApi', {...})` 暴露**收窄**的方法（不暴露裸 ipcRenderer）：
```ts
spawn(opts) -> invoke('pty:spawn')
write(id,data), resize(id,c,r), kill(id)
onData(id, cb): 注册 ipcRenderer.on('pty:data:'+id), 返回取消函数
onExit(id, cb): 同上
```

### 5) Renderer `src/terminal/PtyProxy.ts`
薄封装 `window.ptyApi`，面向单个 ptyId 提供 `write / resize / onData / onExit / dispose`。

### 6) Renderer `src/terminal/useXterm.ts`（核心，落实 SPEC §5.1）
- **空依赖 `useEffect`，只挂载一次**，杜绝 React re-render 干扰 xterm。
- 内部：`new Terminal()` → `loadAddons`(仅 fit) → `term.open(ref)` → `fit.fit()`。
- `spawn` 得到 ptyId → 建 PtyProxy。
- `term.onData(d => proxy.write(d))`（键盘 → pty）。
- `proxy.onData(d => term.write(d))`（pty → 屏幕；M1 无 ack）。
- 最简 resize：`ResizeObserver → fit.fit() → proxy.resize(cols,rows)`。
- cleanup：dispose 所有订阅、`proxy.kill`、`term.dispose`、断开 observer。

### 7) `src/terminal/TerminalView.tsx` + 挂到 `App.tsx`
- `TerminalView`：一个 `div ref` 容器 + `useXterm`。容器用 Tailwind 占满、深色背景。
- `App.tsx`：渲染单个 `<TerminalView/>`。

### M1 完成标志（验收）
- [ ] 启动后终端出现 shell 提示符。
- [ ] 键盘输入实时回显；`echo hello`、`ls`/`dir`、`cd` 正常执行并显示输出。
- [ ] 方向键、退格、Ctrl+C 等控制键行为正常（走 onData 编码）。
- [ ] 拖动窗口改变大小，`vim` 或 `htop`（有的话）的显示区域随之变化（cols/rows 已同步到 pty）。
- [ ] 关闭窗口时 pty 进程被 kill（无残留 shell 进程）。
- [ ] 大量输出（如 `ls -R` 大目录 / 打印长文件）能显示——**M1 允许卡顿**，卡顿正是 M2 背压要解决的问题，此处仅确认链路不崩。

---

## 风险与对策

| 风险 | 影响 | 对策 |
|---|---|---|
| node-pty ABI 不匹配 | M0 就卡死 | **M0 首要验收项**，先 rebuild 通过再往下 |
| Windows 缺 C++ 构建工具 | node-pty 编译失败 | 装 VS Build Tools（含 C++ 桌面负载） |
| Electron 安全配置导致 preload/IPC 不通 | M1 IPC 失败 | 严格按 §M1-4 收窄暴露；devtools 查报错 |
| `pty:data:{ptyId}` 动态 channel 泄漏监听 | 多次 spawn 后内存涨 | onData 返回取消函数，cleanup 必调 |
| 多字节 UTF-8 被 string IPC 截断 | 中文/emoji 花屏（偶发） | M1 记为已知限制，M2 换 Uint8Array 传输解决 |

---

## 与后续里程碑的衔接

M1 完成后，这条直链就是所有后续功能的地基：
- **M2**：在 PTYManager↔PtyProxy 之间插入 `PtyDataQueue` + `pty:ack`（背压）；数据传输换 `Uint8Array`。
- **M3**：`tabsStore`（Zustand）+ 多 TerminalView 实例；非活动 Tab 用 `display:none` 保活。
- **S0（语义线）**：M1 拿到 pty 字节流后即可在 PTYManager 处加 SemanticTap 分流——**不影响 M1 显示链路**。
