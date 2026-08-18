import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  type IpcMainInvokeEvent
} from 'electron'
import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { PTYManager } from './pty/PTYManager'
import {
  AppInvokeChannel,
  AppEventChannel,
  ClipboardInvokeChannel,
  CliInvokeChannel,
  DialogInvokeChannel,
  FloatingWindowInvokeChannel,
  PtyInvokeChannel,
  ShellInvokeChannel,
  StatsInvokeChannel,
  ThemeInvokeChannel,
  UpdateInvokeChannel,
  WindowInvokeChannel,
  type CliRuntime,
  type DirectoryPickerRequest,
  type HistoryEvent,
  type CliLaunchSelection,
  type HistoryEventKind,
  type MainPrefsUpdate,
  type RecordEventInput,
  type SpawnOptions
} from '../shared/ipc-contract'
import { AgentInvokeChannel } from '../shared/agent-events'
import type { StartAgentSession } from '../shared/agent-events'
import type { AgentSessionRuntime } from './agents/AgentSessionRuntime'
import { listAvailableShells } from './shells'
import type { AiCliDiscoveryService } from './ai-cli-discovery'
import { displayRelativePosition } from './window'
import { EventLog } from './events/EventLog'
import { persistMainPrefs, sanitizeFloatingAppearance } from './main-prefs'
import {
  BUILTIN_FLOATING_RENDERER_ID,
  type FloatingShapeRect,
  type FloatingWindowState
} from '../shared/floating-window'
import {
  isGlobalShortcutRegistered,
  registerGlobalShortcut,
  unregisterGlobalShortcut
} from './shortcuts'
import type { Tray } from './tray'
import type { FloatingWindowController } from './floating/FloatingWindowController'
import { WorkspaceReaderInvokeChannel } from '../shared/workspace-reader'
import type { WorkspaceReader } from './workspace/WorkspaceReader'
import {
  DshInvokeChannel,
  type DshRetentionPolicy,
  type DshRuntimePreference
} from '../shared/dsh-ipc'
import type { DshHostManager } from './dsh-host/DshHostManager'
import type { DshWireProxy } from './dsh-host/DshWireProxy'
import type { DshProjectionBridge } from './dsh-host/DshProjectionBridge'
import type { DshWebSurfaceController } from './dsh-surface/DshWebSurfaceController'
import type { UpdateService } from './update/UpdateService'
import { UserThemeStore } from './user-themes'
import {
  directoryPickerDefaultPath,
  normalizePickedDirectory
} from './directory-picker'

const MAX_CLIPBOARD_TEXT_LENGTH = 8 * 1024 * 1024
const MAX_EVENT_ADAPTER_ID_LENGTH = 128
const MAX_EVENT_TITLE_LENGTH = 256
const MAX_EVENT_DETAIL_LENGTH = 512

function unavailableFloatingWindowState(): FloatingWindowState {
  return {
    enabled: false,
    selectedRendererId: BUILTIN_FLOATING_RENDERER_ID,
    activeRendererId: null,
    renderers: [],
    rendererErrors: [],
    activeError: null,
    attentionEffectEnabled: true,
    scale: 1
  }
}

function parseFloatingShape(value: unknown): FloatingShapeRect[] | null {
  if (!Array.isArray(value) || value.length > 1_024) return null
  const rects: FloatingShapeRect[] = []
  for (const item of value) {
    if (!item || typeof item !== 'object') return null
    const raw = item as Record<string, unknown>
    const values = [raw.x, raw.y, raw.width, raw.height]
    if (
      values.some(
        (entry) => typeof entry !== 'number' || !Number.isFinite(entry)
      ) ||
      (raw.x as number) < 0 ||
      (raw.y as number) < 0 ||
      (raw.width as number) <= 0 ||
      (raw.height as number) <= 0 ||
      values.some((entry) => (entry as number) > 8_192)
    ) {
      return null
    }
    rects.push({
      x: Math.round(raw.x as number),
      y: Math.round(raw.y as number),
      width: Math.max(1, Math.round(raw.width as number)),
      height: Math.max(1, Math.round(raw.height as number))
    })
  }
  return rects
}

const EVENT_KIND_WHITELIST = new Set<HistoryEventKind>([
  'tool_call',
  'completed',
  'approved',
  'blocked',
  'message',
  'session_start',
  'session_exit'
])

/** 主进程运行时上下文：窗口 / 托盘由 main.ts 组装后注入。 */
export interface IpcContext {
  eventLog: EventLog
  cliDiscovery: AiCliDiscoveryService
  agentRuntime: AgentSessionRuntime
  workspaceReader: WorkspaceReader
  dshHost: DshHostManager
  dshWire: DshWireProxy
  dshProjections: DshProjectionBridge
  updateService: UpdateService
  getDshSurfaceController(): DshWebSurfaceController | null
  getWindow(): BrowserWindow | null
  getTray(): Tray | null
  getFloatingWindowController(): FloatingWindowController | null
  rebuildTrayMenu(): void
}
function senderWindow(event: IpcMainInvokeEvent): BrowserWindow | null {
  const win = BrowserWindow.fromWebContents(event.sender)
  return win && !win.isDestroyed() ? win : null
}

function requireMainWindow(event: IpcMainInvokeEvent, ctx: IpcContext): void {
  if (senderWindow(event) !== ctx.getWindow()) {
    throw new Error('This API is unavailable for this window')
  }
}

function dshSurfaceController(
  event: IpcMainInvokeEvent,
  ctx: IpcContext
): DshWebSurfaceController {
  const controller = ctx.getDshSurfaceController()
  if (!controller || !controller.owns(senderWindow(event))) {
    throw new Error('DSH surface is unavailable for this window')
  }
  return controller
}

function parseDirectoryPickerRuntime(value: unknown): CliRuntime {
  if (!value || typeof value !== 'object') {
    throw new Error('Invalid directory picker runtime')
  }
  const runtime = value as Record<string, unknown>
  if (runtime.kind === 'wsl') {
    if (
      typeof runtime.distro !== 'string' ||
      !runtime.distro.trim() ||
      runtime.distro.length > 128 ||
      /[\\/\0]/.test(runtime.distro)
    ) {
      throw new Error('Invalid WSL distribution')
    }
    return { kind: 'wsl', distro: runtime.distro }
  }
  if (
    runtime.kind === 'host' &&
    (runtime.platform === 'windows' ||
      runtime.platform === 'macos' ||
      runtime.platform === 'linux')
  ) {
    return { kind: 'host', platform: runtime.platform }
  }
  throw new Error('Invalid directory picker runtime')
}

function parseDshRuntimePreference(value: unknown): DshRuntimePreference {
  if (!value || typeof value !== 'object') {
    throw new Error('invalid dsh runtime preference')
  }
  const raw = value as Record<string, unknown>
  if (raw.kind === 'auto' || raw.kind === 'bundled') {
    return { kind: raw.kind }
  }
  if (
    raw.kind === 'installation' &&
    typeof raw.installationId === 'string' &&
    raw.installationId.length > 0 &&
    raw.installationId.length <= 4_096
  ) {
    return { kind: 'installation', installationId: raw.installationId }
  }
  throw new Error('invalid dsh runtime preference')
}

function parseDirectoryPickerRequest(value: unknown): DirectoryPickerRequest {
  if (!value || typeof value !== 'object') {
    throw new Error('Invalid directory picker request')
  }
  const request = value as Record<string, unknown>
  if (
    request.defaultPath !== undefined &&
    (typeof request.defaultPath !== 'string' ||
      request.defaultPath.length > 32_768 ||
      request.defaultPath.includes('\0'))
  ) {
    throw new Error('Invalid directory picker path')
  }
  return {
    defaultPath: request.defaultPath as string | undefined,
    runtime: parseDirectoryPickerRuntime(request.runtime)
  }
}

/** 注册所有 pty 相关的 invoke handler，委托 PTYManager。 */
export function registerIpc(manager: PTYManager, ctx: IpcContext): void {
  const userThemes = new UserThemeStore(
    join(app.getPath('userData'), 'themes')
  )
  ipcMain.handle(WorkspaceReaderInvokeChannel.Describe, (_event, terminalId: unknown) =>
    ctx.workspaceReader.describe(terminalId)
  )
  ipcMain.handle(WorkspaceReaderInvokeChannel.List, (_event, request: unknown) =>
    ctx.workspaceReader.list(request)
  )
  ipcMain.handle(WorkspaceReaderInvokeChannel.Read, (_event, request: unknown) =>
    ctx.workspaceReader.read(request)
  )
  // ───── DSH host 生命周期（内置 agent 运行时）─────────
  ipcMain.handle(DshInvokeChannel.GetStatus, () => ctx.dshHost.getStatus())
  ipcMain.handle(DshInvokeChannel.EnsureStarted, () =>
    ctx.dshHost.ensureStarted()
  )
  ipcMain.handle(DshInvokeChannel.Stop, () => ctx.dshHost.stop())
  ipcMain.handle(DshInvokeChannel.GetConfig, () => ctx.dshHost.getConfig())
  ipcMain.handle(DshInvokeChannel.ScanRuntimes, (_e, force: unknown) =>
    ctx.dshHost.scanRuntimes(force === true)
  )
  ipcMain.handle(DshInvokeChannel.SetRuntime, (_e, preference: unknown) =>
    ctx.dshHost.setRuntime(parseDshRuntimePreference(preference))
  )
  ipcMain.handle(DshInvokeChannel.SetHomeMode, (_e, mode: unknown) => {
    if (mode !== 'isolated' && mode !== 'shared') {
      throw new Error('invalid dsh home mode')
    }
    return ctx.dshHost.setHomeMode(mode)
  })
  ipcMain.handle(DshInvokeChannel.SetRetention, (_e, policy: unknown) => {
    return ctx.dshHost.setRetention(sanitizeRetentionPolicy(policy))
  })
  ipcMain.handle(DshInvokeChannel.WireFetch, (_e, request) =>
    ctx.dshWire.handleFetch(request)
  )
  ipcMain.handle(DshInvokeChannel.GetBootManifest, () =>
    ctx.dshWire.getBootManifest()
  )
  ipcMain.handle(DshInvokeChannel.WireFetchAbort, (_e, requestId) => {
    if (typeof requestId === 'string') ctx.dshWire.abortFetch(requestId)
  })
  ipcMain.handle(DshInvokeChannel.WireStreamOpen, (_e, request) => {
    ctx.dshWire.openStream(request)
  })
  ipcMain.handle(DshInvokeChannel.WireStreamClose, (_e, streamId) => {
    if (typeof streamId === 'string') ctx.dshWire.closeStream(streamId)
  })
  ipcMain.handle(DshInvokeChannel.SurfaceShow, (event, request: unknown) =>
    dshSurfaceController(event, ctx).show(request)
  )
  ipcMain.handle(DshInvokeChannel.SurfaceSetBounds, (event, bounds: unknown) => {
    dshSurfaceController(event, ctx).setBounds(bounds)
  })
  ipcMain.handle(DshInvokeChannel.SurfaceHide, (event) => {
    dshSurfaceController(event, ctx).hide()
  })
  ipcMain.handle(DshInvokeChannel.SurfaceUnfollow, (event, sessionId: unknown) => {
    dshSurfaceController(event, ctx).unfollow(sessionId)
  })

  ipcMain.handle(PtyInvokeChannel.Spawn, (_e, opts: SpawnOptions) =>
    manager.spawn(opts)
  )
  ipcMain.handle(PtyInvokeChannel.Attach, (_e, { ptyId }: { ptyId: string }) =>
    manager.attach(ptyId)
  )
  ipcMain.handle(PtyInvokeChannel.ListRecoverable, () =>
    manager.listRecoverable()
  )
  ipcMain.handle(
    PtyInvokeChannel.Write,
    (_e, { ptyId, data }: { ptyId: string; data: string }) =>
      manager.write(ptyId, data)
  )
  ipcMain.handle(
    PtyInvokeChannel.Resize,
    (
      _e,
      { ptyId, cols, rows }: { ptyId: string; cols: number; rows: number }
    ) => manager.resize(ptyId, cols, rows)
  )
  ipcMain.handle(
    PtyInvokeChannel.Ack,
    (_e, { ptyId, bytes }: { ptyId: string; bytes: number }) =>
      manager.ack(ptyId, bytes)
  )
  ipcMain.handle(PtyInvokeChannel.Kill, (_e, { ptyId }: { ptyId: string }) =>
    manager.kill(ptyId)
  )
  ipcMain.handle(
    PtyInvokeChannel.KillTerminal,
    (_e, { terminalId }: { terminalId: string }) =>
      manager.killTerminal(terminalId)
  )
  ipcMain.handle(PtyInvokeChannel.History, (_e, { ptyId }: { ptyId: string }) =>
    manager.history(ptyId)
  )
  ipcMain.handle(
    PtyInvokeChannel.FlowControl,
    (_e, { ptyId }: { ptyId: string }) => manager.flowControl(ptyId)
  )
  ipcMain.handle(ClipboardInvokeChannel.WriteText, (_e, text: unknown) => {
    if (
      typeof text !== 'string' ||
      text.length === 0 ||
      text.length > MAX_CLIPBOARD_TEXT_LENGTH
    ) {
      return
    }
    clipboard.writeText(text)
  })
  ipcMain.handle(ClipboardInvokeChannel.ReadForTerminalPaste, () => {
    if (!clipboard.readImage().isEmpty()) return { kind: 'image' as const }
    const text = clipboard.readText()
    return text
      ? { kind: 'text' as const, text: text.slice(0, MAX_CLIPBOARD_TEXT_LENGTH) }
      : { kind: 'empty' as const }
  })
  ipcMain.handle(WindowInvokeChannel.Minimize, (event) => {
    senderWindow(event)?.minimize()
  })
  ipcMain.handle(WindowInvokeChannel.ToggleMaximize, (event) => {
    const win = senderWindow(event)
    if (!win) return
    if (win.isMaximized()) win.unmaximize()
    else win.maximize()
  })
  ipcMain.handle(WindowInvokeChannel.Close, (event) => {
    senderWindow(event)?.close()
  })
  ipcMain.handle(WindowInvokeChannel.IsMaximized, (event) =>
    Boolean(senderWindow(event)?.isMaximized())
  )
  ipcMain.handle(WindowInvokeChannel.IsFullScreen, (event) =>
    Boolean(senderWindow(event)?.isFullScreen())
  )
  ipcMain.handle(WindowInvokeChannel.GetPosition, (event) => {
    const win = senderWindow(event)
    if (!win) return { x: 0, y: 0, screenWidth: 1, screenHeight: 1 }
    return displayRelativePosition(win)
  })
  ipcMain.handle(FloatingWindowInvokeChannel.GetState, (event) => {
    requireMainWindow(event, ctx)
    return (
      ctx.getFloatingWindowController()?.getState() ??
      unavailableFloatingWindowState()
    )
  })
  ipcMain.handle(
    FloatingWindowInvokeChannel.SetEnabled,
    (event, enabled: unknown) => {
      const controller = ctx.getFloatingWindowController()
      if (!controller || typeof enabled !== 'boolean') {
        return unavailableFloatingWindowState()
      }
      const isMainSender = senderWindow(event) === ctx.getWindow()
      const isOwnedRenderer = controller.isRendererSender(event.sender)
      if (!isMainSender && !(isOwnedRenderer && enabled === false)) {
        throw new Error('Floating window control is unavailable for this window')
      }
      return controller.setEnabled(enabled)
    }
  )
  ipcMain.handle(
    FloatingWindowInvokeChannel.SetRenderer,
    (event, rendererId: unknown) => {
      requireMainWindow(event, ctx)
      const controller = ctx.getFloatingWindowController()
      if (
        !controller ||
        typeof rendererId !== 'string' ||
        rendererId.length === 0 ||
        rendererId.length > 128
      ) {
        return controller?.getState() ?? unavailableFloatingWindowState()
      }
      return controller.setRenderer(rendererId)
    }
  )
  ipcMain.handle(
    FloatingWindowInvokeChannel.SetAttentionEffect,
    (event, enabled: unknown) => {
      requireMainWindow(event, ctx)
      const controller = ctx.getFloatingWindowController()
      if (!controller || typeof enabled !== 'boolean') {
        return controller?.getState() ?? unavailableFloatingWindowState()
      }
      return controller.setAttentionEffectEnabled(enabled)
    }
  )
  ipcMain.handle(
    FloatingWindowInvokeChannel.SetScale,
    (event, scale: unknown) => {
      requireMainWindow(event, ctx)
      const controller = ctx.getFloatingWindowController()
      if (!controller || typeof scale !== 'number' || !Number.isFinite(scale)) {
        return controller?.getState() ?? unavailableFloatingWindowState()
      }
      return controller.setScale(scale)
    }
  )
  ipcMain.handle(
    FloatingWindowInvokeChannel.OpenRenderersDirectory,
    (event) => {
      requireMainWindow(event, ctx)
      return ctx.getFloatingWindowController()?.openRenderersDirectory()
    }
  )
  ipcMain.handle(
    FloatingWindowInvokeChannel.RefreshRenderers,
    (event) => {
      requireMainWindow(event, ctx)
      return (
        ctx.getFloatingWindowController()?.refreshRenderers() ??
        unavailableFloatingWindowState()
      )
    }
  )
  ipcMain.handle(FloatingWindowInvokeChannel.GetSnapshot, (event) => {
    const controller = ctx.getFloatingWindowController()
    if (!controller || !controller.isRendererSender(event.sender)) {
      throw new Error('Floating renderer API is unavailable for this window')
    }
    return controller.getSnapshot()
  })
  ipcMain.handle(
    FloatingWindowInvokeChannel.ResizeToContent,
    (event, height: unknown) => {
      const controller = ctx.getFloatingWindowController()
      if (
        controller?.isRendererSender(event.sender) &&
        typeof height === 'number' &&
        Number.isFinite(height)
      ) {
        controller.resizeToContent(height)
      }
    }
  )
  ipcMain.handle(
    FloatingWindowInvokeChannel.SetShape,
    (event, value: unknown) => {
      const controller = ctx.getFloatingWindowController()
      if (!controller?.isRendererSender(event.sender)) return
      const rects = parseFloatingShape(value)
      if (rects) controller.setShape(rects)
    }
  )
  ipcMain.handle(
    FloatingWindowInvokeChannel.FocusSession,
    (event, sessionId: unknown) => {
      const controller = ctx.getFloatingWindowController()
      return Boolean(
        controller?.isRendererSender(event.sender) &&
          typeof sessionId === 'string' &&
          sessionId.length <= 128 &&
          controller.focusSession(sessionId)
      )
    }
  )
  ipcMain.handle(ThemeInvokeChannel.ListUser, (event) => {
    requireMainWindow(event, ctx)
    return userThemes.list()
  })
  ipcMain.handle(ThemeInvokeChannel.SaveCustom, (event, source: unknown) => {
    requireMainWindow(event, ctx)
    return userThemes.saveCustom(source)
  })
  ipcMain.handle(
    DialogInvokeChannel.PickDirectory,
    async (event, payload: unknown) => {
      const win = senderWindow(event)
      const request = parseDirectoryPickerRequest(payload)
      const options = {
        defaultPath: directoryPickerDefaultPath(request),
        properties: ['openDirectory' as const]
      }
      const result = win
        ? await dialog.showOpenDialog(win, options)
        : await dialog.showOpenDialog(options)
      const selected = result.filePaths[0]
      return result.canceled || !selected
        ? null
        : normalizePickedDirectory(selected, request.runtime)
    }
  )
  ipcMain.handle(ShellInvokeChannel.ListAvailable, listAvailableShells)
  ipcMain.handle(CliInvokeChannel.Scan, (_event, force: unknown) =>
    ctx.cliDiscovery.scan(force === true)
  )
  ipcMain.handle(
    CliInvokeChannel.ResolveWorkspace,
    (_event, payload: unknown) => {
      if (!payload || typeof payload !== 'object') {
        return Promise.reject(new Error('Invalid workspace request'))
      }
      const { installationId, workspace } = payload as Record<string, unknown>
      if (
        typeof installationId !== 'string' ||
        !installationId ||
        installationId.length > 4_096 ||
        typeof workspace !== 'string' ||
        workspace.length > 32_768
      ) {
        return Promise.reject(new Error('Invalid workspace request'))
      }
      return ctx.cliDiscovery.resolveWorkspace(installationId, workspace)
    }
  )
  ipcMain.handle(CliInvokeChannel.PrepareLaunch, (_event, selection: unknown) =>
    ctx.cliDiscovery.prepareLaunch(selection as CliLaunchSelection)
  )

  ipcMain.handle(AgentInvokeChannel.Start, (_event, input: unknown) => {
    if (!isStartAgentSessionShape(input)) {
      return Promise.reject(new Error('Invalid agent session request'))
    }
    return ctx.agentRuntime.start(input as StartAgentSession)
  })
  ipcMain.handle(AgentInvokeChannel.Stop, (_event, payload: unknown) => {
    const sessionId =
      payload &&
      typeof payload === 'object' &&
      typeof (payload as { sessionId?: unknown }).sessionId === 'string'
        ? (payload as { sessionId: string }).sessionId
        : null
    if (!sessionId || sessionId.length > 128) return Promise.resolve()
    return ctx.agentRuntime.stop(sessionId)
  })
  ipcMain.handle(AgentInvokeChannel.Rename, (_event, payload: unknown) => {
    if (!payload || typeof payload !== 'object') return null
    const raw = payload as Record<string, unknown>
    if (typeof raw.sessionId !== 'string' || typeof raw.name !== 'string') {
      return null
    }
    return ctx.agentRuntime.rename(raw.sessionId, raw.name)
  })
  ipcMain.handle(AgentInvokeChannel.PublishCaption, (_event, input: unknown) =>
    ctx.agentRuntime.publishCaption(input)
  )
  ipcMain.handle(AgentInvokeChannel.ListActive, () => [
    ...ctx.agentRuntime.listActive(),
    ...ctx.dshProjections.listActive()
  ])

  ipcMain.handle(StatsInvokeChannel.AllTime, () => ctx.eventLog.allTimeStats())
  ipcMain.handle(StatsInvokeChannel.HistoryEvents, (_event, query: unknown) => {
    const parsed = parseHistoryQuery(query)
    if (!parsed) return []
    return ctx.eventLog.query(parsed)
  })
  ipcMain.handle(
    StatsInvokeChannel.RecordEvent,
    (_event, input: unknown): Promise<void> => {
      const record = parseRecordEventInput(input)
      if (!record) return Promise.resolve()
      const event: HistoryEvent = {
        id: crypto.randomUUID(),
        kind: record.kind,
        adapterId: record.adapterId,
        occurredAt: Date.now(),
        title: record.title,
        detail: record.detail
      }
      return ctx.eventLog.record(event)
    }
  )

  ipcMain.handle(AppInvokeChannel.SetMainPrefs, (_event, update: unknown) =>
    applyMainPrefsUpdate(ctx, update)
  )
  ipcMain.handle(UpdateInvokeChannel.GetState, (event) => {
    requireMainWindow(event, ctx)
    return ctx.updateService.getState()
  })
  ipcMain.handle(UpdateInvokeChannel.Check, (event) => {
    requireMainWindow(event, ctx)
    return ctx.updateService.check()
  })
  ipcMain.handle(UpdateInvokeChannel.Download, (event) => {
    requireMainWindow(event, ctx)
    return ctx.updateService.download()
  })
  ipcMain.handle(UpdateInvokeChannel.Install, (event) => {
    requireMainWindow(event, ctx)
    return ctx.updateService.install()
  })

  // 诊断：渲染进程把 resize 前后的 buffer 快照写到 logs/resize-diag.log，供离线分析。
  // 只在真实 dev 会话里抓证据用，定位后移除。
  const diagPath = join(process.cwd(), 'logs', 'resize-diag.log')
  ipcMain.handle('diag:log', (_e, line: string) => {
    try {
      appendFileSync(diagPath, `${line}\n`)
    } catch {
      /* logs/ 不存在时忽略；由渲染侧首次调用前主进程已 ensure */
    }
  })
}

function parseHistoryQuery(
  value: unknown
): { limit: number; before?: number } | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as { limit?: unknown; before?: unknown }
  if (typeof raw.limit !== 'number' || !Number.isFinite(raw.limit)) return null
  const before =
    typeof raw.before === 'number' && Number.isFinite(raw.before)
      ? raw.before
      : undefined
  return { limit: Math.max(1, Math.min(500, Math.floor(raw.limit))), before }
}

function parseRecordEventInput(value: unknown): RecordEventInput | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Record<string, unknown>
  if (
    typeof raw.kind !== 'string' ||
    !EVENT_KIND_WHITELIST.has(raw.kind as HistoryEventKind)
  ) {
    return null
  }
  const kind = raw.kind as HistoryEventKind
  const adapterId = boundedString(
    raw.adapterId,
    MAX_EVENT_ADAPTER_ID_LENGTH,
    ''
  )
  const title = boundedString(raw.title, MAX_EVENT_TITLE_LENGTH, '')
  const detail = boundedString(raw.detail, MAX_EVENT_DETAIL_LENGTH, '')
  if (!adapterId && !title && !detail) return null
  return { kind, adapterId, title, detail }
}

function boundedString(
  value: unknown,
  maxLength: number,
  fallback: string
): string {
  if (typeof value !== 'string') return fallback
  const trimmed = value.trim().slice(0, maxLength)
  return trimmed.length > 0 ? trimmed : fallback
}

/** 校验并应用主进程偏好更新；快捷键/托盘菜单即时生效。 */
async function applyMainPrefsUpdate(
  ctx: IpcContext,
  update: unknown
): Promise<void> {
  if (!update || typeof update !== 'object') return
  const raw = update as Record<string, unknown>
  const patch: MainPrefsUpdate = {}
  if (typeof raw.backgroundColor === 'string') {
    patch.backgroundColor = raw.backgroundColor.trim()
  }
  if (
    typeof raw.uiThemeId === 'string' &&
    raw.uiThemeId.trim().length <= 128
  ) {
    patch.uiThemeId = raw.uiThemeId.trim()
  }
  if (typeof raw.globalShortcutEnabled === 'boolean') {
    patch.globalShortcutEnabled = raw.globalShortcutEnabled
  }
  if (typeof raw.language === 'string' && raw.language.length <= 16) {
    patch.language = raw.language
  }
  if (raw.floatingAppearance !== undefined) {
    patch.floatingAppearance = sanitizeFloatingAppearance(
      raw.floatingAppearance
    )
  }
  if (Object.keys(patch).length === 0) return

  const merged = await persistMainPrefs(patch)
  if (patch.floatingAppearance !== undefined) {
    ctx
      .getFloatingWindowController()
      ?.setAppearance(merged.floatingAppearance)
  }
  const win = ctx.getWindow()
  if (win) {
    const enabled = merged.globalShortcutEnabled
    if (enabled && !isGlobalShortcutRegistered()) {
      registerGlobalShortcut(win)
    } else if (!enabled && isGlobalShortcutRegistered()) {
      unregisterGlobalShortcut()
    }
  }
  if (patch.language !== undefined) {
    ctx.rebuildTrayMenu()
  }
  if (patch.uiThemeId !== undefined || patch.language !== undefined) {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.webContents.isDestroyed()) {
        window.webContents.send(AppEventChannel.MainPrefsChanged, {
          uiThemeId: merged.uiThemeId,
          language: merged.language
        })
      }
    }
  }
}

function sanitizeRetentionPolicy(value: unknown): DshRetentionPolicy {
  if (!value || typeof value !== 'object') return { kind: 'all' }
  const raw = value as { kind?: unknown; days?: unknown; count?: unknown }
  if (raw.kind === 'days') {
    const days =
      typeof raw.days === 'number' && Number.isFinite(raw.days)
        ? Math.max(1, Math.min(3650, Math.round(raw.days)))
        : 30
    return { kind: 'days', days }
  }
  if (raw.kind === 'count') {
    const count =
      typeof raw.count === 'number' && Number.isFinite(raw.count)
        ? Math.max(1, Math.min(5000, Math.round(raw.count)))
        : 50
    return { kind: 'count', count }
  }
  return { kind: 'all' }
}

/** IPC 层形状校验；字段级清洗与语义校验由 Runtime.start 完成。 */
function isStartAgentSessionShape(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false
  const raw = value as {
    terminalId?: unknown
    selection?: unknown
    cols?: unknown
    rows?: unknown
  }
  if (
    typeof raw.terminalId !== 'string' ||
    raw.terminalId.length === 0 ||
    raw.terminalId.length > 128
  ) {
    return false
  }
  if (!raw.selection || typeof raw.selection !== 'object') return false
  const selection = raw.selection as {
    installationId?: unknown
    workspace?: unknown
    args?: unknown
  }
  if (
    typeof selection.installationId !== 'string' ||
    typeof selection.workspace !== 'string' ||
    !Array.isArray(selection.args)
  ) {
    return false
  }
  return (
    typeof raw.cols === 'number' &&
    typeof raw.rows === 'number' &&
    Number.isFinite(raw.cols) &&
    Number.isFinite(raw.rows)
  )
}
