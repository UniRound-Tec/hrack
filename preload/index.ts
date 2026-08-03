import {
  contextBridge,
  ipcRenderer,
  type IpcRendererEvent
} from 'electron'
import os from 'node:os'
import {
  AppEventChannel,
  AppInvokeChannel,
  ClipboardInvokeChannel,
  CliInvokeChannel,
  DialogInvokeChannel,
  PtyInvokeChannel,
  ShellInvokeChannel,
  StatsInvokeChannel,
  ThemeEventChannel,
  ThemeInvokeChannel,
  WindowEventChannel,
  WindowInvokeChannel,
  ptyDataChannel,
  ptyExitChannel,
  ptyResizeCursorSyncChannel,
  type AppApi,
  type AppThemeApi,
  type ClipboardApi,
  type CliApi,
  type CliLaunchSelection,
  type DialogApi,
  type ExitPayload,
  type HistoryQuery,
  type MainPrefsUpdate,
  type PtyApi,
  type PtyFlowControlSnapshot,
  type PtyMeta,
  type PtyResizeCursorSync,
  type RecordEventInput,
  type ShellApi,
  type SpawnOptions,
  type StatsApi,
  type ThemeApi,
  type WindowApi,
  type WindowPositionPayload
} from '../shared/ipc-contract'
import {
  AgentEventChannel,
  AgentInvokeChannel,
  type AgentApi,
  type AgentEvent,
  type AgentSessionProjection,
  type StartAgentSession
} from '../shared/agent-events'

/** 推算 Windows build 号（os.release() 形如 "10.0.26200"）。 */
function windowsBuildNumber(): number {
  const parts = os.release().split('.')
  const n = Number(parts[parts.length - 1])
  return Number.isFinite(n) ? n : 0
}

/**
 * 平台元信息。Windows 下提供 windowsPty（backend + buildNumber）。
 *
 * windowsPty 让 xterm 使用与 ConPTY/build 对应的 buffer 兼容路径；本机 build≥21376
 * 时仍保留 reflow。它不能单独解决 ConPTY resize 整屏重画覆盖 scrollback，
 * 该问题由主进程 ConptyResizeFilter 处理。
 */
function getMeta(): PtyMeta {
  const platform = process.platform
  if (platform === 'win32') {
    return { platform, windowsPty: { backend: 'conpty', buildNumber: windowsBuildNumber() } }
  }
  return { platform }
}

/**
 * preload —— 安全边界。只暴露 SPEC §3 契约里收窄的方法，
 * 绝不把裸 ipcRenderer 交给 renderer。
 */
const ptyApi: PtyApi = {
  getMeta,
  spawn: (opts: SpawnOptions) => ipcRenderer.invoke(PtyInvokeChannel.Spawn, opts),
  write: (ptyId, data) => ipcRenderer.invoke(PtyInvokeChannel.Write, { ptyId, data }),
  resize: (ptyId, cols, rows) =>
    ipcRenderer.invoke(PtyInvokeChannel.Resize, { ptyId, cols, rows }),
  kill: (ptyId) => ipcRenderer.invoke(PtyInvokeChannel.Kill, { ptyId }),
  ack: (ptyId, bytes) => ipcRenderer.invoke(PtyInvokeChannel.Ack, { ptyId, bytes }),
  getHistory: (ptyId) => ipcRenderer.invoke(PtyInvokeChannel.History, { ptyId }),
  getFlowControl: (ptyId): Promise<PtyFlowControlSnapshot | null> =>
    ipcRenderer.invoke(PtyInvokeChannel.FlowControl, { ptyId }),

  onData: (ptyId, cb) => {
    const ch = ptyDataChannel(ptyId)
    const handler = (_e: IpcRendererEvent, data: Uint8Array): void => cb(data)
    ipcRenderer.on(ch, handler)
    return () => ipcRenderer.removeListener(ch, handler)
  },

  onResizeCursorSync: (ptyId, cb) => {
    const ch = ptyResizeCursorSyncChannel(ptyId)
    const handler = (
      _e: IpcRendererEvent,
      payload: PtyResizeCursorSync
    ): void => cb(payload)
    ipcRenderer.on(ch, handler)
    return () => ipcRenderer.removeListener(ch, handler)
  },

  onExit: (ptyId, cb) => {
    const ch = ptyExitChannel(ptyId)
    const handler = (_e: IpcRendererEvent, payload: ExitPayload): void => cb(payload)
    ipcRenderer.on(ch, handler)
    return () => ipcRenderer.removeListener(ch, handler)
  },

  diagLog: (line: string) => ipcRenderer.invoke('diag:log', line)
}

const clipboardApi: ClipboardApi = {
  writeText: (text) => ipcRenderer.invoke(ClipboardInvokeChannel.WriteText, text)
}

const windowApi: WindowApi = {
  platform: process.platform,
  minimize: () => ipcRenderer.invoke(WindowInvokeChannel.Minimize),
  toggleMaximize: () =>
    ipcRenderer.invoke(WindowInvokeChannel.ToggleMaximize),
  close: () => ipcRenderer.invoke(WindowInvokeChannel.Close),
  isMaximized: () => ipcRenderer.invoke(WindowInvokeChannel.IsMaximized),
  onMaximizedChange: (cb) => {
    const handler = (_event: IpcRendererEvent, maximized: unknown): void => {
      if (typeof maximized === 'boolean') cb(maximized)
    }
    ipcRenderer.on(WindowEventChannel.MaximizedChanged, handler)
    return () =>
      ipcRenderer.removeListener(WindowEventChannel.MaximizedChanged, handler)
  },
  getPosition: () => ipcRenderer.invoke(WindowInvokeChannel.GetPosition),
  onPositionChange: (cb) => {
    const handler = (
      _event: IpcRendererEvent,
      position: WindowPositionPayload
    ): void => {
      if (
        position &&
        typeof position.x === 'number' &&
        typeof position.y === 'number' &&
        typeof position.screenWidth === 'number' &&
        typeof position.screenHeight === 'number'
      ) {
        cb(position)
      }
    }
    ipcRenderer.on(WindowEventChannel.PositionChanged, handler)
    return () =>
      ipcRenderer.removeListener(WindowEventChannel.PositionChanged, handler)
  }
}

const themeApi: ThemeApi = {
  listUser: () => ipcRenderer.invoke(ThemeInvokeChannel.ListUser)
}

const dialogApi: DialogApi = {
  pickDirectory: (defaultPath) =>
    ipcRenderer.invoke(DialogInvokeChannel.PickDirectory, { defaultPath })
}

const shellApi: ShellApi = {
  listAvailable: () => ipcRenderer.invoke(ShellInvokeChannel.ListAvailable)
}

const cliApi: CliApi = {
  scan: (force = false) => ipcRenderer.invoke(CliInvokeChannel.Scan, force),
  prepareLaunch: (selection: CliLaunchSelection) =>
    ipcRenderer.invoke(CliInvokeChannel.PrepareLaunch, selection)
}

const statsApi: StatsApi = {
  allTime: () => ipcRenderer.invoke(StatsInvokeChannel.AllTime),
  historyEvents: (query: HistoryQuery) =>
    ipcRenderer.invoke(StatsInvokeChannel.HistoryEvents, query),
  recordEvent: (input: RecordEventInput) =>
    ipcRenderer.invoke(StatsInvokeChannel.RecordEvent, input)
}

const agentApi: AgentApi = {
  start: (input: StartAgentSession) =>
    ipcRenderer.invoke(AgentInvokeChannel.Start, input),
  stop: (sessionId: string) =>
    ipcRenderer.invoke(AgentInvokeChannel.Stop, { sessionId }),
  listActive: () => ipcRenderer.invoke(AgentInvokeChannel.ListActive),
  onEvents: (cb) => {
    const handler = (_event: IpcRendererEvent, events: unknown): void => {
      if (Array.isArray(events) && events.length <= 500) {
        cb(events as AgentEvent[])
      }
    }
    ipcRenderer.on(AgentEventChannel.Events, handler)
    return () =>
      ipcRenderer.removeListener(AgentEventChannel.Events, handler)
  },
  onProjection: (cb) => {
    const handler = (
      _event: IpcRendererEvent,
      projection: AgentSessionProjection
    ): void => {
      if (
        projection &&
        typeof projection === 'object' &&
        typeof projection.sessionId === 'string'
      ) {
        cb(projection)
      }
    }
    ipcRenderer.on(AgentEventChannel.Projection, handler)
    return () =>
      ipcRenderer.removeListener(AgentEventChannel.Projection, handler)
  }
}

const appApi: AppApi = {
  setMainPrefs: (update: MainPrefsUpdate) =>
    ipcRenderer.invoke(AppInvokeChannel.SetMainPrefs, update),
  onOpenNewSession: (cb) => {
    const handler = (_event: IpcRendererEvent): void => cb()
    ipcRenderer.on(AppEventChannel.OpenNewSession, handler)
    return () =>
      ipcRenderer.removeListener(AppEventChannel.OpenNewSession, handler)
  }
}

const appThemeApi: AppThemeApi = {
  onUserThemesChanged: (cb) => {
    const handler = (_event: IpcRendererEvent): void => cb()
    ipcRenderer.on(ThemeEventChannel.UserThemesChanged, handler)
    return () =>
      ipcRenderer.removeListener(ThemeEventChannel.UserThemesChanged, handler)
  }
}

try {
  contextBridge.exposeInMainWorld('ptyApi', ptyApi)
  contextBridge.exposeInMainWorld('clipboardApi', clipboardApi)
  contextBridge.exposeInMainWorld('windowApi', windowApi)
  contextBridge.exposeInMainWorld('themeApi', themeApi)
  contextBridge.exposeInMainWorld('dialogApi', dialogApi)
  contextBridge.exposeInMainWorld('shellApi', shellApi)
  contextBridge.exposeInMainWorld('cliApi', cliApi)
  contextBridge.exposeInMainWorld('statsApi', statsApi)
  contextBridge.exposeInMainWorld('agentApi', agentApi)
  contextBridge.exposeInMainWorld('appApi', appApi)
  contextBridge.exposeInMainWorld('appThemeApi', appThemeApi)
  // E2E：主进程设置 VIBING_E2E 时，向渲染进程注入标记，激活 debugBridge（即便是生产构建）
  if (process.env['VIBING_E2E']) {
    contextBridge.exposeInMainWorld('__VIBING_E2E__', true)
  }
} catch (err) {
  console.error('[preload] exposeInMainWorld failed:', err)
}
