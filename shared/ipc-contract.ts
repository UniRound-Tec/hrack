/**
 * IPC 契约 —— 主进程 / preload / renderer 三方共享的单一事实来源。
 * 对齐 SPEC §3。M2：PTY 输出使用 Uint8Array，并由 renderer 在 xterm
 * 解析完成后 ack，主进程据此执行有界背压。
 */

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

// ───── Main → Renderer（webContents.send，事件流）─────────
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
