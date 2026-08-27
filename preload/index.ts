import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import os from 'node:os'
import {
  AppEventChannel,
  AppInvokeChannel,
  BridgeInvokeChannel,
  ClipboardInvokeChannel,
  CliInvokeChannel,
  DialogInvokeChannel,
  TerminalBackgroundInvokeChannel,
  FloatingWindowEventChannel,
  FloatingWindowInvokeChannel,
  PtyInvokeChannel,
  RemoteEventChannel,
  RemoteInvokeChannel,
  ShellInvokeChannel,
  StatsInvokeChannel,
  ThemeEventChannel,
  ThemeInvokeChannel,
  UpdateEventChannel,
  UpdateInvokeChannel,
  WindowEventChannel,
  WindowInvokeChannel,
  ptyDataChannel,
  ptyExitChannel,
  ptyResizeCursorSyncChannel,
  type AppApi,
  type AppThemeApi,
  type BridgeLaunchAck,
  type BridgeLaunchRequest,
  type ClipboardApi,
  type CliApi,
  type CliLaunchSelection,
  type DialogApi,
  type TerminalBackgroundApi,
  type FloatingWindowApi,
  type FloatingWindowState,
  type FocusSessionPayload,
  type ExitPayload,
  type HistoryQuery,
  type MainPrefsUpdate,
  type MainPrefsSnapshot,
  type PtyApi,
  type PtyFlowControlSnapshot,
  type PtyMeta,
  type PtyResizeCursorSync,
  type RecordEventInput,
  type RemoteApi,
  type RemoteDriveState,
  type RemoteDesktopState,
  type RemoteDshState,
  type RemoteVisibleLaunchRequest,
  type ShellApi,
  type SpawnOptions,
  type StatsApi,
  type ThemeApi,
  type UpdateApi,
  type UpdatePhase,
  type UpdateSnapshot,
  type WindowApi,
  type WindowPositionPayload
} from '../shared/ipc-contract'
import {
  AgentEventChannel,
  AgentInvokeChannel,
  type AgentApi,
  type AgentEvent,
  type AgentSessionProjection,
  type PublishAgentCaption,
  type StartAgentSession
} from '../shared/agent-events'
import {
  WorkspaceReaderEventChannel,
  WorkspaceReaderInvokeChannel,
  type WorkspaceChange,
  type WorkspaceReaderApi
} from '../shared/workspace-reader'
import {
  NotificationSoundInvokeChannel,
  type NotificationSoundApi,
  type NotificationSoundPickResult
} from '../shared/notification-sound'
import {
  DshEventChannel,
  DshInvokeChannel,
  type DshApi,
  type DshHostStatus,
  type DshSurfaceApi,
  type DshWireApi,
  type DshWireFetchRequest,
  type DshWireStreamClosedEvent,
  type DshWireStreamMessageEvent,
  type DshWireStreamOpenedEvent,
  type DshWireStreamOpenRequest
} from '../shared/dsh-ipc'
import {
  DiagnosticLogEventChannel,
  DiagnosticLogInvokeChannel,
  type DiagnosticLogApi,
  type DiagnosticLogChange
} from '../shared/diagnostic-log'

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
    return {
      platform,
      windowsPty: { backend: 'conpty', buildNumber: windowsBuildNumber() }
    }
  }
  return { platform }
}

/**
 * preload —— 安全边界。只暴露 SPEC §3 契约里收窄的方法，
 * 绝不把裸 ipcRenderer 交给 renderer。
 */
const ptyApi: PtyApi = {
  getMeta,
  spawn: (opts: SpawnOptions) =>
    ipcRenderer.invoke(PtyInvokeChannel.Spawn, opts),
  attach: (ptyId) => ipcRenderer.invoke(PtyInvokeChannel.Attach, { ptyId }),
  listRecoverable: () => ipcRenderer.invoke(PtyInvokeChannel.ListRecoverable),
  write: (ptyId, data) =>
    ipcRenderer.invoke(PtyInvokeChannel.Write, { ptyId, data }),
  resize: (ptyId, cols, rows) =>
    ipcRenderer.invoke(PtyInvokeChannel.Resize, { ptyId, cols, rows }),
  kill: (ptyId) => ipcRenderer.invoke(PtyInvokeChannel.Kill, { ptyId }),
  killTerminal: (terminalId) =>
    ipcRenderer.invoke(PtyInvokeChannel.KillTerminal, { terminalId }),
  ack: (ptyId, bytes) =>
    ipcRenderer.invoke(PtyInvokeChannel.Ack, { ptyId, bytes }),
  getHistory: (ptyId) =>
    ipcRenderer.invoke(PtyInvokeChannel.History, { ptyId }),
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
    const handler = (_e: IpcRendererEvent, payload: ExitPayload): void =>
      cb(payload)
    ipcRenderer.on(ch, handler)
    return () => ipcRenderer.removeListener(ch, handler)
  },

  diagLog: (line: string) => ipcRenderer.invoke('diag:log', line)
}

const clipboardApi: ClipboardApi = {
  writeText: (text) =>
    ipcRenderer.invoke(ClipboardInvokeChannel.WriteText, text),
  readForTerminalPaste: () =>
    ipcRenderer.invoke(ClipboardInvokeChannel.ReadForTerminalPaste)
}

const windowApi: WindowApi = {
  platform: process.platform,
  minimize: () => ipcRenderer.invoke(WindowInvokeChannel.Minimize),
  toggleMaximize: () => ipcRenderer.invoke(WindowInvokeChannel.ToggleMaximize),
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
  isFullScreen: () => ipcRenderer.invoke(WindowInvokeChannel.IsFullScreen),
  onFullScreenChange: (cb) => {
    const handler = (_event: IpcRendererEvent, fullScreen: unknown): void => {
      if (typeof fullScreen === 'boolean') cb(fullScreen)
    }
    ipcRenderer.on(WindowEventChannel.FullScreenChanged, handler)
    return () =>
      ipcRenderer.removeListener(WindowEventChannel.FullScreenChanged, handler)
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

const floatingWindowApi: FloatingWindowApi = {
  getState: () => ipcRenderer.invoke(FloatingWindowInvokeChannel.GetState),
  setEnabled: (enabled) =>
    ipcRenderer.invoke(FloatingWindowInvokeChannel.SetEnabled, enabled),
  setRenderer: (rendererId) =>
    ipcRenderer.invoke(FloatingWindowInvokeChannel.SetRenderer, rendererId),
  setAttentionEffectEnabled: (enabled) =>
    ipcRenderer.invoke(FloatingWindowInvokeChannel.SetAttentionEffect, enabled),
  setScale: (scale) =>
    ipcRenderer.invoke(FloatingWindowInvokeChannel.SetScale, scale),
  openRenderersDirectory: () =>
    ipcRenderer.invoke(FloatingWindowInvokeChannel.OpenRenderersDirectory),
  refreshRenderers: () =>
    ipcRenderer.invoke(FloatingWindowInvokeChannel.RefreshRenderers),
  onStateChanged: (cb) => {
    const handler = (
      _event: IpcRendererEvent,
      state: FloatingWindowState
    ): void => {
      if (state && typeof state.enabled === 'boolean') cb(state)
    }
    ipcRenderer.on(FloatingWindowEventChannel.StateChanged, handler)
    return () =>
      ipcRenderer.removeListener(FloatingWindowEventChannel.StateChanged, handler)
  }
}

const themeApi: ThemeApi = {
  listUser: () => ipcRenderer.invoke(ThemeInvokeChannel.ListUser),
  saveCustom: (source) =>
    ipcRenderer.invoke(ThemeInvokeChannel.SaveCustom, source)
}

const dialogApi: DialogApi = {
  pickDirectory: (request) =>
    ipcRenderer.invoke(DialogInvokeChannel.PickDirectory, request)
}

const terminalBackgroundApi: TerminalBackgroundApi = {
  pick: () => ipcRenderer.invoke(TerminalBackgroundInvokeChannel.Pick),
  clear: () => ipcRenderer.invoke(TerminalBackgroundInvokeChannel.Clear)
}

const notificationSoundApi: NotificationSoundApi = {
  pick: (): Promise<NotificationSoundPickResult | null> =>
    ipcRenderer.invoke(NotificationSoundInvokeChannel.Pick),
  clear: () => ipcRenderer.invoke(NotificationSoundInvokeChannel.Clear)
}

const shellApi: ShellApi = {
  listAvailable: () => ipcRenderer.invoke(ShellInvokeChannel.ListAvailable)
}

const cliApi: CliApi = {
  scan: (force = false) => ipcRenderer.invoke(CliInvokeChannel.Scan, force),
  resolveWorkspace: (installationId: string, workspace: string) =>
    ipcRenderer.invoke(CliInvokeChannel.ResolveWorkspace, {
      installationId,
      workspace
    }),
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
  rename: (sessionId: string, name: string) =>
    ipcRenderer.invoke(AgentInvokeChannel.Rename, { sessionId, name }),
  publishCaption: (input: PublishAgentCaption) =>
    ipcRenderer.invoke(AgentInvokeChannel.PublishCaption, input),
  listActive: () => ipcRenderer.invoke(AgentInvokeChannel.ListActive),
  onEvents: (cb) => {
    const handler = (_event: IpcRendererEvent, events: unknown): void => {
      if (Array.isArray(events) && events.length <= 500) {
        cb(events as AgentEvent[])
      }
    }
    ipcRenderer.on(AgentEventChannel.Events, handler)
    return () => ipcRenderer.removeListener(AgentEventChannel.Events, handler)
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

const workspaceReader: WorkspaceReaderApi = {
  describe: (terminalId) =>
    ipcRenderer.invoke(WorkspaceReaderInvokeChannel.Describe, terminalId),
  list: (input) => ipcRenderer.invoke(WorkspaceReaderInvokeChannel.List, input),
  read: (input) => ipcRenderer.invoke(WorkspaceReaderInvokeChannel.Read, input),
  onChanged: (callback) => {
    const handler = (_event: IpcRendererEvent, change: WorkspaceChange): void => {
      if (
        change &&
        typeof change === 'object' &&
        typeof change.terminalId === 'string' &&
        (typeof change.path === 'string' || change.path === null)
      ) {
        callback(change)
      }
    }
    ipcRenderer.on(WorkspaceReaderEventChannel.Changed, handler)
    return () =>
      ipcRenderer.removeListener(WorkspaceReaderEventChannel.Changed, handler)
  }
}

const remoteApi: RemoteApi = {
  connect: (joinUrl) => ipcRenderer.invoke(RemoteInvokeChannel.Connect, joinUrl),
  disconnect: () => ipcRenderer.invoke(RemoteInvokeChannel.Disconnect),
  revoke: () => ipcRenderer.invoke(RemoteInvokeChannel.Revoke),
  getState: () => ipcRenderer.invoke(RemoteInvokeChannel.GetState),
  getDriveState: () => ipcRenderer.invoke(RemoteInvokeChannel.GetDriveState),
  reclaim: (sessionId) =>
    ipcRenderer.invoke(RemoteInvokeChannel.Reclaim, sessionId),
  setRecentWorkspaces: (workspaces) =>
    ipcRenderer.invoke(RemoteInvokeChannel.SetRecentWorkspaces, workspaces),
  getDshState: () => ipcRenderer.invoke(RemoteInvokeChannel.GetDshState),
  setDshEnabled: (enabled) =>
    ipcRenderer.invoke(RemoteInvokeChannel.SetDshEnabled, enabled),
  onStateChange: (cb) => {
    const handler = (
      _event: IpcRendererEvent,
      state: RemoteDesktopState
    ): void => {
      if (state && typeof state === 'object' && typeof state.phase === 'string') {
        cb(state)
      }
    }
    ipcRenderer.on(RemoteEventChannel.StateChanged, handler)
    return () =>
      ipcRenderer.removeListener(RemoteEventChannel.StateChanged, handler)
  },
  onDriveStateChange: (cb) => {
    const handler = (
      _event: IpcRendererEvent,
      state: RemoteDriveState
    ): void => {
      if (
        state &&
        typeof state === 'object' &&
        (state.phase === 'idle' || state.phase === 'driven')
      ) {
        cb(state)
      }
    }
    ipcRenderer.on(RemoteEventChannel.DriveChanged, handler)
    return () =>
      ipcRenderer.removeListener(RemoteEventChannel.DriveChanged, handler)
  },
  onDshStateChange: (cb) => {
    const handler = (_event: IpcRendererEvent, state: RemoteDshState): void => {
      if (
        state &&
        typeof state === 'object' &&
        typeof state.enabled === 'boolean' &&
        typeof state.relaySupported === 'boolean'
      ) {
        cb(state)
      }
    }
    ipcRenderer.on(RemoteEventChannel.DshStateChanged, handler)
    return () =>
      ipcRenderer.removeListener(RemoteEventChannel.DshStateChanged, handler)
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
  },
  onFocusSession: (cb) => {
    const handler = (
      _event: IpcRendererEvent,
      payload: FocusSessionPayload
    ): void => {
      if (
        payload &&
        typeof payload.sessionId === 'string' &&
        typeof payload.terminalId === 'string'
      ) {
        cb(payload)
      }
    }
    ipcRenderer.on(AppEventChannel.FocusSession, handler)
    return () =>
      ipcRenderer.removeListener(AppEventChannel.FocusSession, handler)
  },
  onBridgeLaunch: (cb) => {
    const handler = (
      _event: IpcRendererEvent,
      request: BridgeLaunchRequest
    ): void => {
      if (
        request &&
        typeof request.requestId === 'string' &&
        typeof request.terminalId === 'string' &&
        typeof request.workspace === 'string' &&
        request.selection &&
        typeof request.selection.installationId === 'string'
      ) {
        cb({
          ...request,
          ...(typeof request.ptyId === 'string' ? { ptyId: request.ptyId } : {})
        })
      }
    }
    ipcRenderer.on(AppEventChannel.BridgeLaunch, handler)
    return () =>
      ipcRenderer.removeListener(AppEventChannel.BridgeLaunch, handler)
  },
  onRemoteLaunch: (cb) => {
    const handler = (
      _event: IpcRendererEvent,
      request: RemoteVisibleLaunchRequest
    ): void => {
      if (
        request &&
        typeof request.terminalId === 'string' &&
        typeof request.name === 'string' &&
        typeof request.adapterId === 'string' &&
        typeof request.workspace === 'string' &&
        typeof request.ptyId === 'string' &&
        request.selection &&
        typeof request.selection.installationId === 'string' &&
        typeof request.selection.workspace === 'string' &&
        Array.isArray(request.selection.args) &&
        request.selection.args.every((arg) => typeof arg === 'string')
      ) {
        cb({
          terminalId: request.terminalId,
          name: request.name,
          adapterId: request.adapterId,
          workspace: request.workspace,
          ptyId: request.ptyId,
          selection: {
            installationId: request.selection.installationId,
            workspace: request.selection.workspace,
            args: [...request.selection.args]
          }
        })
      }
    }
    ipcRenderer.on(AppEventChannel.RemoteLaunch, handler)
    return () =>
      ipcRenderer.removeListener(AppEventChannel.RemoteLaunch, handler)
  },
  reportBridgeLaunch: (ack: BridgeLaunchAck) =>
    ipcRenderer.invoke(BridgeInvokeChannel.LaunchResult, ack),
  onMainPrefsChanged: (cb) => {
    const handler = (
      _event: IpcRendererEvent,
      prefs: MainPrefsSnapshot
    ): void => {
      if (
        prefs &&
        typeof prefs.uiThemeId === 'string' &&
        typeof prefs.language === 'string'
      ) {
        cb(prefs)
      }
    }
    ipcRenderer.on(AppEventChannel.MainPrefsChanged, handler)
    return () =>
      ipcRenderer.removeListener(AppEventChannel.MainPrefsChanged, handler)
  }
}

const updatePhases = new Set<UpdatePhase>([
  'disabled',
  'idle',
  'checking',
  'available',
  'downloading',
  'downloaded',
  'up-to-date',
  'error'
])

function isUpdateSnapshot(value: unknown): value is UpdateSnapshot {
  if (!value || typeof value !== 'object') return false
  const snapshot = value as Partial<UpdateSnapshot>
  const progress = snapshot.progress
  return (
    typeof snapshot.phase === 'string' &&
    updatePhases.has(snapshot.phase as UpdatePhase) &&
    typeof snapshot.currentVersion === 'string' &&
    (snapshot.availableVersion === null ||
      typeof snapshot.availableVersion === 'string') &&
    (snapshot.releaseDate === null || typeof snapshot.releaseDate === 'string') &&
    (snapshot.releaseNotes === null ||
      typeof snapshot.releaseNotes === 'string') &&
    (snapshot.checkedAt === null || typeof snapshot.checkedAt === 'number') &&
    (snapshot.error === null || typeof snapshot.error === 'string') &&
    (progress === null ||
      (typeof progress === 'object' &&
        typeof progress.percent === 'number' &&
        typeof progress.transferred === 'number' &&
        typeof progress.total === 'number' &&
        typeof progress.bytesPerSecond === 'number'))
  )
}

const updateApi: UpdateApi = {
  getState: () => ipcRenderer.invoke(UpdateInvokeChannel.GetState),
  check: () => ipcRenderer.invoke(UpdateInvokeChannel.Check),
  download: () => ipcRenderer.invoke(UpdateInvokeChannel.Download),
  install: () => ipcRenderer.invoke(UpdateInvokeChannel.Install),
  onStateChanged: (cb) => {
    const handler = (_event: IpcRendererEvent, snapshot: unknown): void => {
      if (isUpdateSnapshot(snapshot)) cb(snapshot)
    }
    ipcRenderer.on(UpdateEventChannel.StateChanged, handler)
    return () =>
      ipcRenderer.removeListener(UpdateEventChannel.StateChanged, handler)
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

const dshApi: DshApi = {
  getStatus: () => ipcRenderer.invoke(DshInvokeChannel.GetStatus),
  ensureStarted: () => ipcRenderer.invoke(DshInvokeChannel.EnsureStarted),
  restart: () => ipcRenderer.invoke(DshInvokeChannel.Restart),
  stop: () => ipcRenderer.invoke(DshInvokeChannel.Stop),
  getConfig: () => ipcRenderer.invoke(DshInvokeChannel.GetConfig),
  scanRuntimes: (force = false) =>
    ipcRenderer.invoke(DshInvokeChannel.ScanRuntimes, force),
  setRuntime: (preference) =>
    ipcRenderer.invoke(DshInvokeChannel.SetRuntime, preference),
  setHomeMode: (mode) => ipcRenderer.invoke(DshInvokeChannel.SetHomeMode, mode),
  setRetention: (policy) =>
    ipcRenderer.invoke(DshInvokeChannel.SetRetention, policy),
  getBootManifest: () =>
    ipcRenderer.invoke(DshInvokeChannel.GetBootManifest),
  onStatusChanged: (cb) => {
    const handler = (
      _event: IpcRendererEvent,
      status: DshHostStatus
    ): void => {
      if (status && typeof status === 'object' && typeof status.state === 'string') {
        cb(status)
      }
    }
    ipcRenderer.on(DshEventChannel.StatusChanged, handler)
    return () =>
      ipcRenderer.removeListener(DshEventChannel.StatusChanged, handler)
  }
}

const dshWireApi: DshWireApi = {
  fetch: (request: DshWireFetchRequest) =>
    ipcRenderer.invoke(DshInvokeChannel.WireFetch, request),
  abortFetch: (requestId) =>
    ipcRenderer.invoke(DshInvokeChannel.WireFetchAbort, requestId),
  openStream: (request: DshWireStreamOpenRequest) =>
    ipcRenderer.invoke(DshInvokeChannel.WireStreamOpen, request),
  closeStream: (streamId) =>
    ipcRenderer.invoke(DshInvokeChannel.WireStreamClose, streamId),
  onStreamOpened: (cb) => {
    const handler = (
      _event: IpcRendererEvent,
      payload: DshWireStreamOpenedEvent
    ): void => {
      if (payload && typeof payload.streamId === 'string') cb(payload)
    }
    ipcRenderer.on(DshEventChannel.WireStreamOpened, handler)
    return () =>
      ipcRenderer.removeListener(DshEventChannel.WireStreamOpened, handler)
  },
  onStreamMessage: (cb) => {
    const handler = (
      _event: IpcRendererEvent,
      payload: DshWireStreamMessageEvent
    ): void => {
      if (
        payload &&
        typeof payload.streamId === 'string' &&
        typeof payload.data === 'string'
      ) {
        cb(payload)
      }
    }
    ipcRenderer.on(DshEventChannel.WireStreamMessage, handler)
    return () =>
      ipcRenderer.removeListener(DshEventChannel.WireStreamMessage, handler)
  },
  onStreamClosed: (cb) => {
    const handler = (
      _event: IpcRendererEvent,
      payload: DshWireStreamClosedEvent
    ): void => {
      if (payload && typeof payload.streamId === 'string') cb(payload)
    }
    ipcRenderer.on(DshEventChannel.WireStreamClosed, handler)
    return () =>
      ipcRenderer.removeListener(DshEventChannel.WireStreamClosed, handler)
  }
}

const dshSurfaceApi: DshSurfaceApi = {
  show: (request) => ipcRenderer.invoke(DshInvokeChannel.SurfaceShow, request),
  setBounds: (bounds) =>
    ipcRenderer.invoke(DshInvokeChannel.SurfaceSetBounds, bounds),
  hide: () => ipcRenderer.invoke(DshInvokeChannel.SurfaceHide),
  restart: () => ipcRenderer.invoke(DshInvokeChannel.SurfaceRestart),
  unfollow: (slotId) =>
    ipcRenderer.invoke(DshInvokeChannel.SurfaceUnfollow, slotId)
}

const diagnosticLogApi: DiagnosticLogApi = {
  getSnapshot: () => ipcRenderer.invoke(DiagnosticLogInvokeChannel.GetSnapshot),
  clear: () => ipcRenderer.invoke(DiagnosticLogInvokeChannel.Clear),
  onChanged: (cb) => {
    const handler = (
      _event: IpcRendererEvent,
      change: DiagnosticLogChange
    ): void => cb(change)
    ipcRenderer.on(DiagnosticLogEventChannel.Changed, handler)
    return () => ipcRenderer.removeListener(DiagnosticLogEventChannel.Changed, handler)
  }
}

try {
  contextBridge.exposeInMainWorld('ptyApi', ptyApi)
  contextBridge.exposeInMainWorld('clipboardApi', clipboardApi)
  contextBridge.exposeInMainWorld('windowApi', windowApi)
  contextBridge.exposeInMainWorld('floatingWindowApi', floatingWindowApi)
  contextBridge.exposeInMainWorld('themeApi', themeApi)
  contextBridge.exposeInMainWorld('dialogApi', dialogApi)
  contextBridge.exposeInMainWorld('terminalBackgroundApi', terminalBackgroundApi)
  contextBridge.exposeInMainWorld('notificationSoundApi', notificationSoundApi)
  contextBridge.exposeInMainWorld('shellApi', shellApi)
  contextBridge.exposeInMainWorld('cliApi', cliApi)
  contextBridge.exposeInMainWorld('statsApi', statsApi)
  contextBridge.exposeInMainWorld('agentApi', agentApi)
  contextBridge.exposeInMainWorld('workspaceReader', workspaceReader)
  contextBridge.exposeInMainWorld('appApi', appApi)
  contextBridge.exposeInMainWorld('updateApi', updateApi)
  contextBridge.exposeInMainWorld('remoteApi', remoteApi)
  contextBridge.exposeInMainWorld('appThemeApi', appThemeApi)
  contextBridge.exposeInMainWorld('dshApi', dshApi)
  contextBridge.exposeInMainWorld('dshWireApi', dshWireApi)
  contextBridge.exposeInMainWorld('dshSurfaceApi', dshSurfaceApi)
  contextBridge.exposeInMainWorld('diagnosticLogApi', diagnosticLogApi)
  // E2E：主进程设置 HRACK_E2E 时，向渲染进程注入标记，激活 debugBridge（即便是生产构建）
  if (process.env['HRACK_E2E']) {
    contextBridge.exposeInMainWorld('__HRACK_E2E__', true)
  }
} catch (err) {
  console.error('[preload] exposeInMainWorld failed:', err)
}
