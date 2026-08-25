/**
 * IPC 契约 —— 主进程 / preload / renderer 三方共享的单一事实来源。
 * 对齐 SPEC §3。M2：PTY 输出使用 Uint8Array，并由 renderer 在 xterm
 * 解析完成后 ack，主进程据此执行有界背压。
 */

import type { UserThemeFile } from './theme-schema'
import type { FloatingAppearance } from './floating-window'
import type { TerminalBackgroundPickResult } from './terminal-background'
import type { RemoteWebSurface } from './remote-protocol'
export {
  FloatingWindowEventChannel,
  FloatingWindowInvokeChannel,
  type FloatingRendererApi,
  type FloatingWindowApi,
  type FloatingWindowState
} from './floating-window'

// ───── Renderer → Main（ipcMain.handle，请求-响应）─────────

export interface PtyTerminalIdentity {
  terminalId: string
  kind: 'terminal' | 'agent'
  name: string
  shellId: string
  cwd: string
  /** Ordinary terminal grouped beneath an AI session in the sidebar. */
  parentSessionId?: string
  /** In-memory launch recipe used to clone an AI session after renderer reload. */
  agentSelection?: CliLaunchSelection
}

export interface SpawnOptions {
  /** 未提供时由主进程按平台选默认 shell（Windows→pwsh，类 Unix→$SHELL/bash）。 */
  shell?: string
  /** Windows command shims may require a verbatim command line for node-pty. */
  args?: string[] | string
  cwd?: string
  env?: Record<string, string>
  cols?: number
  rows?: number
  /**
   * Renderer reload 后重建终端的稳定身份。PTYManager 只保存通用终端
   * 元数据，不解析 CLI 品牌或 Agent 事件。
   */
  terminal?: PtyTerminalIdentity
}

export interface SpawnResult {
  ptyId: string
}

export interface RecoverablePty extends PtyTerminalIdentity {
  ptyId: string
  exited: boolean
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

export type PtyHistoryEvent = PtyHistoryOutputEvent | PtyHistoryResizeEvent

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
  | 'blocked'
  | 'message'
  | 'session_start'
  | 'session_exit'

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

export type CliRuntime =
  | { kind: 'host'; platform: 'windows' | 'macos' | 'linux' }
  | { kind: 'wsl'; distro: string }

export interface CliInstallation {
  id: string
  definitionId: string
  runtime: CliRuntime
  resolvedExecutable: string
  detectedVia: 'path' | 'known-path'
  version?: string
  verification: 'verified'
}

/** Interactive skip-approval launch. Injected only when the start-modal checkbox is on. */
export interface CliSkipApprovalLaunch {
  args: string[]
  /**
   * Equivalent or conflicting tokens already in the user's extra args.
   * If any match, do not inject `args` again.
   */
  alreadyPresent?: string[]
  /** Product mode name shown as "Start {label} mode". */
  label: string
}

export interface LaunchableCliDefinition {
  id: string
  adapterId: string
  displayName: string
  hint: string
  iconId: string
  skipApproval?: CliSkipApprovalLaunch
}

export interface LaunchableCli {
  definition: LaunchableCliDefinition
  installations: CliInstallation[]
}

export interface CliRuntimeError {
  runtime: CliRuntime
  /** 探针针对某个产品失败时标出定义；运行环境整体不可用时省略。 */
  definitionId?: string
  code: 'unavailable' | 'timeout' | 'probe-failed'
  detail: string
}

export interface CliScanReport {
  startedAt: number
  finishedAt: number
  launchable: LaunchableCli[]
  runtimeErrors: CliRuntimeError[]
}

export interface CliLaunchSelection {
  installationId: string
  workspace: string
  args: string[]
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
  Attach: 'pty:attach',
  ListRecoverable: 'pty:list-recoverable',
  Write: 'pty:write',
  Resize: 'pty:resize',
  Kill: 'pty:kill',
  KillTerminal: 'pty:kill-terminal',
  Ack: 'pty:ack',
  History: 'pty:history',
  FlowControl: 'pty:flow-control'
} as const

export const ClipboardInvokeChannel = {
  WriteText: 'clipboard:write-text',
  ReadForTerminalPaste: 'clipboard:read-for-terminal-paste'
} as const

export type TerminalClipboardPaste =
  | { kind: 'empty' }
  | { kind: 'image' }
  | { kind: 'text'; text: string }

export const WindowInvokeChannel = {
  Minimize: 'window:minimize',
  ToggleMaximize: 'window:toggle-maximize',
  Close: 'window:close',
  IsMaximized: 'window:is-maximized',
  IsFullScreen: 'window:is-full-screen',
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
  ListUser: 'theme:list-user',
  SaveCustom: 'theme:save-custom'
} as const

export const DialogInvokeChannel = {
  PickDirectory: 'dialog:pick-directory'
} as const

export const TerminalBackgroundInvokeChannel = {
  Pick: 'terminal-background:pick',
  Clear: 'terminal-background:clear'
} as const

export interface DirectoryPickerRequest {
  defaultPath?: string
  runtime: CliRuntime
}

export const ShellInvokeChannel = {
  ListAvailable: 'shell:list-available'
} as const

export const CliInvokeChannel = {
  Scan: 'cli:scan',
  PrepareLaunch: 'cli:prepare-launch',
  ResolveWorkspace: 'cli:resolve-workspace'
} as const

/** M5.c: real persistence behind stats/history; renderer reports lifecycle events. */
export const StatsInvokeChannel = {
  AllTime: 'stats:all-time',
  HistoryEvents: 'events:history',
  RecordEvent: 'events:record'
} as const

export type RecordEventInput = Pick<
  HistoryEvent,
  'kind' | 'adapterId' | 'title' | 'detail'
>

/**
 * 主进程偏好文件 `<userData>/main-prefs.json` 的可写子集。
 * renderer 上报界面主题 bg.app、全局快捷键开关与界面语言。
 */
export type MainPrefsUpdate = Partial<{
  backgroundColor: string
  uiThemeId: string
  globalShortcutEnabled: boolean
  language: string
  floatingAppearance: FloatingAppearance
}>

export interface MainPrefsSnapshot {
  uiThemeId: string
  language: string
}

export type UpdatePhase =
  | 'disabled'
  | 'idle'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'downloaded'
  | 'up-to-date'
  | 'error'

export interface UpdateProgress {
  percent: number
  transferred: number
  total: number
  bytesPerSecond: number
}

/** 主进程持有的应用更新权威快照；每个 updater 事件直接覆盖当前阶段。 */
export interface UpdateSnapshot {
  phase: UpdatePhase
  currentVersion: string
  availableVersion: string | null
  releaseDate: string | null
  releaseNotes: string | null
  progress: UpdateProgress | null
  checkedAt: number | null
  error: string | null
}

export const UpdateInvokeChannel = {
  GetState: 'update:get-state',
  Check: 'update:check',
  Download: 'update:download',
  Install: 'update:install'
} as const

export const UpdateEventChannel = {
  StateChanged: 'update:state-changed'
} as const

export type RemoteDesktopPhase =
  | 'idle'
  | 'connecting'
  | 'waiting-phone'
  | 'peer-online'
  | 'revoking'
  | 'error'

export type RemoteDesktopError =
  | 'invalid-url'
  | 'invalid-scheme'
  | 'insecure-remote'
  | 'invalid-room'
  | 'missing-room'
  | 'occupied'
  | 'bad-key'
  | 'revoked'
  | 'connect-failed'
  | 'not-connected'
  | 'revoke-unconfirmed'

export interface RemoteDesktopState {
  phase: RemoteDesktopPhase
  href: string | null
  origin: string | null
  error: RemoteDesktopError | null
}

export const REMOTE_DESKTOP_IDLE_STATE: RemoteDesktopState = {
  phase: 'idle',
  href: null,
  origin: null,
  error: null
}

export const RemoteInvokeChannel = {
  Connect: 'remote:connect',
  Disconnect: 'remote:disconnect',
  Revoke: 'remote:revoke',
  GetState: 'remote:get-state',
  GetDriveState: 'remote:get-drive-state',
  Reclaim: 'remote:reclaim',
  SetRecentWorkspaces: 'remote:set-recent-workspaces',
  GetDshState: 'remote:get-dsh-state',
  SetDshEnabled: 'remote:set-dsh-enabled'
} as const

export const RemoteEventChannel = {
  StateChanged: 'remote:state-changed',
  DriveChanged: 'remote:drive-changed',
  DshStateChanged: 'remote:dsh-state-changed'
} as const

export interface RemoteDshState {
  enabled: boolean
  relaySupported: boolean
  surface: RemoteWebSurface | null
}

export type RemoteDriveState =
  | {
      phase: 'idle'
      sessionId: null
      terminalId: null
      cols: null
      rows: null
    }
  | {
      phase: 'driven'
      sessionId: string
      terminalId: string
      cols: number
      rows: number
    }

export const REMOTE_DRIVE_IDLE_STATE: RemoteDriveState = {
  phase: 'idle',
  sessionId: null,
  terminalId: null,
  cols: null,
  rows: null
}

export interface RemoteApi {
  connect: (joinUrl: string) => Promise<RemoteDesktopState>
  disconnect: () => Promise<RemoteDesktopState>
  revoke: () => Promise<RemoteDesktopState>
  getState: () => Promise<RemoteDesktopState>
  getDriveState: () => Promise<RemoteDriveState>
  reclaim: (sessionId: string) => Promise<RemoteDriveState>
  setRecentWorkspaces: (workspaces: string[]) => Promise<void>
  getDshState: () => Promise<RemoteDshState>
  setDshEnabled: (enabled: boolean) => Promise<RemoteDshState>
  onStateChange: (cb: (state: RemoteDesktopState) => void) => () => void
  onDriveStateChange: (cb: (state: RemoteDriveState) => void) => () => void
  onDshStateChange: (cb: (state: RemoteDshState) => void) => () => void
}

export const AppInvokeChannel = {
  SetMainPrefs: 'app:set-main-prefs'
} as const

export const AppEventChannel = {
  OpenNewSession: 'app:open-new-session',
  FocusSession: 'app:focus-session',
  MainPrefsChanged: 'app:main-prefs-changed',
  BridgeLaunch: 'bridge:launch',
  RemoteLaunch: 'remote:launch'
} as const

export const BridgeInvokeChannel = {
  LaunchResult: 'bridge:launch-result'
} as const

export interface FocusSessionPayload {
  sessionId: string
  terminalId: string
}

export const ThemeEventChannel = {
  UserThemesChanged: 'theme:user-themes-changed'
} as const

// ───── Main → Renderer（webContents.send，事件流）─────────
export const WindowEventChannel = {
  MaximizedChanged: 'window:maximized-changed',
  FullScreenChanged: 'window:full-screen-changed',
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
  /** 原子重置旧 renderer 的背压账本并取回权威历史。 */
  attach: (ptyId: string) => Promise<PtyHistorySnapshot | null>
  listRecoverable: () => Promise<RecoverablePty[]>
  write: (ptyId: string, data: string) => Promise<void>
  resize: (ptyId: string, cols: number, rows: number) => Promise<void>
  kill: (ptyId: string) => Promise<void>
  killTerminal: (terminalId: string) => Promise<void>
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
  /** 图片只暴露类型事实；文本由 xterm 以 bracketed paste 语义写入 PTY。 */
  readForTerminalPaste: () => Promise<TerminalClipboardPaste>
}

export interface WindowApi {
  /** Renderer uses this only to select native/custom title-bar controls. */
  platform: string
  minimize: () => Promise<void>
  toggleMaximize: () => Promise<void>
  close: () => Promise<void>
  isMaximized: () => Promise<boolean>
  onMaximizedChange: (cb: (maximized: boolean) => void) => () => void
  isFullScreen: () => Promise<boolean>
  onFullScreenChange: (cb: (fullScreen: boolean) => void) => () => void
  getPosition: () => Promise<WindowPositionPayload>
  onPositionChange: (
    cb: (position: WindowPositionPayload) => void
  ) => () => void
}

export interface ThemeApi {
  listUser: () => Promise<UserThemeFile[]>
  saveCustom: (source: string) => Promise<void>
}

export interface DialogApi {
  pickDirectory: (request: DirectoryPickerRequest) => Promise<string | null>
}

export interface TerminalBackgroundApi {
  pick: () => Promise<TerminalBackgroundPickResult | null>
  clear: () => Promise<void>
}

export interface ShellApi {
  listAvailable: () => Promise<ShellOption[]>
}

export interface CliApi {
  scan: (force?: boolean) => Promise<CliScanReport>
  /** Returns a validated explicit workspace, or the selected runtime's Home. */
  resolveWorkspace: (installationId: string, workspace: string) => Promise<string>
  prepareLaunch: (selection: CliLaunchSelection) => Promise<SpawnOptions>
}

export interface StatsApi {
  /** all-time 聚合计数（统计文件单调累加，独立于日志截断）。 */
  allTime: () => Promise<AllTimeStats>
  /** 按 occurredAt 降序查询历史事件，`before` 游标支持分页。 */
  historyEvents: (query: HistoryQuery) => Promise<HistoryEvent[]>
  /** 写入口：id/occurredAt 由主进程生成。 */
  recordEvent: (input: RecordEventInput) => Promise<void>
}

export interface BridgeLaunchRequest {
  requestId: string
  terminalId: string
  name: string
  workspace: string
  selection: CliLaunchSelection
  /** 主进程已 spawn 时带上，renderer 只 attach，不再等 xterm 才 start。 */
  ptyId?: string
}

export interface BridgeLaunchAck {
  requestId: string
  error: string | null
}

export interface RemoteVisibleLaunchRequest {
  terminalId: string
  name: string
  adapterId: string
  workspace: string
  selection: CliLaunchSelection
  ptyId: string
}

export interface AppApi {
  /** 上报主进程偏好（backgroundColor / globalShortcutEnabled / language）。 */
  setMainPrefs: (update: MainPrefsUpdate) => Promise<void>
  /** 托盘「新建会话」菜单触发；与 Ctrl+Shift+T 同路径。 */
  onOpenNewSession: (cb: () => void) => () => void
  /** 悬浮窗条目 → 主窗口恢复并进入既有 Session terminal。 */
  onFocusSession: (cb: (payload: FocusSessionPayload) => void) => () => void
  onMainPrefsChanged: (cb: (prefs: MainPrefsSnapshot) => void) => () => void
  /** Bridge create：主进程请 renderer 打开可见 OpenCode tab。 */
  onBridgeLaunch: (cb: (request: BridgeLaunchRequest) => void) => () => void
  /** Remote create：主进程已 spawn，renderer 只显示并 attach tab。 */
  onRemoteLaunch: (
    cb: (request: RemoteVisibleLaunchRequest) => void
  ) => () => void
  reportBridgeLaunch: (ack: BridgeLaunchAck) => Promise<void>
}

export interface UpdateApi {
  getState: () => Promise<UpdateSnapshot>
  check: () => Promise<UpdateSnapshot>
  download: () => Promise<UpdateSnapshot>
  install: () => Promise<void>
  onStateChanged: (cb: (snapshot: UpdateSnapshot) => void) => () => void
}

export interface AppThemeApi {
  /** 用户主题目录变更（新增/修改/删除）后由主进程推送。 */
  onUserThemesChanged: (cb: () => void) => () => void
}
