/**
 * IPC 契约 —— 主进程 / preload / renderer 三方共享的单一事实来源。
 * 对齐 SPEC §3。M2：PTY 输出使用 Uint8Array，并由 renderer 在 xterm
 * 解析完成后 ack，主进程据此执行有界背压。
 */

import type { UserThemeFile } from './theme-schema'

// ───── Renderer → Main（ipcMain.handle，请求-响应）─────────

export interface SpawnOptions {
  /** 未提供时由主进程按平台选默认 shell（Windows→pwsh，类 Unix→$SHELL/bash）。 */
  shell?: string
  args?: string[]
  cwd?: string
  env?: Record<string, string>
  cols?: number
  rows?: number
}

export interface SpawnResult {
  ptyId: string
}

export interface ExitPayload {
  code: number
  signal?: number
}

export interface PtyResizeCursorSync {
  /** ConPTY 当前视口内的 1-based 光标行列。 */
  row: number
  column: number
}

export interface PtyHistoryOutputEvent {
  sequence: number
  kind: 'output'
  data: string
  byteLength: number
}

export interface PtyHistoryResizeEvent {
  sequence: number
  kind: 'resize'
  cols: number
  rows: number
}

export type PtyHistoryEvent =
  | PtyHistoryOutputEvent
  | PtyHistoryResizeEvent

/** 主进程权威历史源的只读快照。P0 保存原始流；后续 P1/P2 在此之上做重放。 */
export interface PtyHistorySnapshot {
  /** false 表示会话超过容量上限，最旧事件已被淘汰。 */
  complete: boolean
  retainedOutputBytes: number
  droppedOutputBytes: number
  droppedEvents: number
  events: PtyHistoryEvent[]
}

export interface PtyFlowControlSnapshot {
  highWaterMarkBytes: number
  lowWaterMarkBytes: number
  maxBufferedBytes: number
  unackedBytes: number
  queuedBytes: number
  bufferedBytes: number
  maxObservedBufferedBytes: number
  paused: boolean
  pauseCount: number
  resumeCount: number
  overflowed: boolean
  rejectedBytes: number
}

export interface AllTimeStats {
  sessions: number
  toolCalls: number
  blocked: number
  approvals: number
}

export type HistoryEventKind =
  | 'tool_call'
  | 'completed'
  | 'approved'
  | 'message'

export interface HistoryEvent {
  id: string
  kind: HistoryEventKind
  adapterId: string
  occurredAt: number
  title: string
  detail: string
}

export interface HistoryQuery {
  limit: number
  before?: number
}

export interface ShellOption {
  id: string
  name: string
  hint: string
  shell: string
  args?: string[]
}

/** 平台元信息。 */
export interface PtyMeta {
  platform: string
  /**
   * 仅 Windows。告知 xterm 当前使用 ConPTY 及系统 build，使其采用对应的 Windows
   * buffer/reflow 兼容路径。它本身不能阻止 ConPTY resize 整屏重画；后者由主进程
   * ConptyResizeFilter 隔离。
   */
  windowsPty?: { backend: 'conpty' | 'winpty'; buildNumber: number }
}

export const PtyInvokeChannel = {
  Spawn: 'pty:spawn',
  Write: 'pty:write',
  Resize: 'pty:resize',
  Kill: 'pty:kill',
  Ack: 'pty:ack',
  History: 'pty:history',
  FlowControl: 'pty:flow-control'
} as const

export const ClipboardInvokeChannel = {
  WriteText: 'clipboard:write-text'
} as const

export const WindowInvokeChannel = {
  Minimize: 'window:minimize',
  ToggleMaximize: 'window:toggle-maximize',
  Close: 'window:close',
  IsMaximized: 'window:is-maximized',
  GetPosition: 'window:get-position'
} as const

/**
 * 窗口左上角相对"当前所在显示器"的位置与该显示器尺寸。
 * 侧栏环境渐变把一张显示器大小的虚拟渐变画布锚定在屏幕上，
 * 用该偏移取窗口对应的切片；跨显示器移动时坐标系自动跟随。
 */
export interface WindowPositionPayload {
  x: number
  y: number
  screenWidth: number
  screenHeight: number
}

export const ThemeInvokeChannel = {
  ListUser: 'theme:list-user'
} as const

export const DialogInvokeChannel = {
  PickDirectory: 'dialog:pick-directory'
} as const

export const ShellInvokeChannel = {
  ListAvailable: 'shell:list-available'
} as const

/** M5.b defines these contracts; persistence/real event handlers land later. */
export const StatsInvokeChannel = {
  AllTime: 'stats:all-time',
  HistoryEvents: 'events:history'
} as const

// ───── Main → Renderer（webContents.send，事件流）─────────
export const WindowEventChannel = {
  MaximizedChanged: 'window:maximized-changed',
  PositionChanged: 'window:position-changed'
} as const

export const ptyDataChannel = (ptyId: string): string => `pty:data:${ptyId}`
export const ptyExitChannel = (ptyId: string): string => `pty:exit:${ptyId}`
export const ptyResizeCursorSyncChannel = (ptyId: string): string =>
  `pty:resize-cursor-sync:${ptyId}`

// ───── preload 暴露给 renderer 的收窄 API 形状 ────────────
export interface PtyApi {
  /** 同步返回平台元信息（Terminal 构造前需要 windowsPty）。 */
  getMeta: () => PtyMeta
  spawn: (opts: SpawnOptions) => Promise<SpawnResult>
  write: (ptyId: string, data: string) => Promise<void>
  resize: (ptyId: string, cols: number, rows: number) => Promise<void>
  kill: (ptyId: string) => Promise<void>
  ack: (ptyId: string, bytes: number) => Promise<void>
  /** 读取主进程中 resize 免疫的原始历史快照。 */
  getHistory: (ptyId: string) => Promise<PtyHistorySnapshot | null>
  /** 读取 M2 背压水位；供诊断与压力测试使用。 */
  getFlowControl: (ptyId: string) => Promise<PtyFlowControlSnapshot | null>
  /** 注册 pty 输出回调，返回取消订阅函数（cleanup 必调，防 channel 泄漏）。 */
  onData: (ptyId: string, cb: (data: Uint8Array) => void) => () => void
  onResizeCursorSync: (
    ptyId: string,
    cb: (payload: PtyResizeCursorSync) => void
  ) => () => void
  onExit: (ptyId: string, cb: (payload: ExitPayload) => void) => () => void
  /** 诊断：把一行文本写到主进程 logs/resize-diag.log（定位 resize 丢内容用，临时）。 */
  diagLog: (line: string) => Promise<void>
}

export interface ClipboardApi {
  /** 把纯文本写入系统剪贴板。 */
  writeText: (text: string) => Promise<void>
}

export interface WindowApi {
  /** Renderer uses this only to select native/custom title-bar controls. */
  platform: string
  minimize: () => Promise<void>
  toggleMaximize: () => Promise<void>
  close: () => Promise<void>
  isMaximized: () => Promise<boolean>
  onMaximizedChange: (cb: (maximized: boolean) => void) => () => void
  getPosition: () => Promise<WindowPositionPayload>
  onPositionChange: (
    cb: (position: WindowPositionPayload) => void
  ) => () => void
}

export interface ThemeApi {
  /** Main only reads files; renderer owns schema and CSS color validation. */
  listUser: () => Promise<UserThemeFile[]>
}

export interface DialogApi {
  pickDirectory: (defaultPath?: string) => Promise<string | null>
}

export interface ShellApi {
  listAvailable: () => Promise<ShellOption[]>
}
