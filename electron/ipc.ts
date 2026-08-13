import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  type IpcMainInvokeEvent
} from 'electron'
import { appendFileSync } from 'node:fs'
import { mkdir, readdir, readFile, stat } from 'node:fs/promises'
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
import { persistMainPrefs } from './main-prefs'
import {
  isGlobalShortcutRegistered,
  registerGlobalShortcut,
  unregisterGlobalShortcut
} from './shortcuts'
import type { Tray } from './tray'
import type { FloatingWindowController } from './floating/FloatingWindowController'
import { WorkspaceReaderInvokeChannel } from '../shared/workspace-reader'
import type { WorkspaceReader } from './workspace/WorkspaceReader'
import { DshInvokeChannel } from '../shared/dsh-ipc'
import type { DshHostManager } from './dsh-host/DshHostManager'
import type { DshWireProxy } from './dsh-host/DshWireProxy'
import {
  directoryPickerDefaultPath,
  normalizePickedDirectory
} from './directory-picker'

const MAX_CLIPBOARD_TEXT_LENGTH = 8 * 1024 * 1024
const MAX_USER_THEME_FILES = 128
const MAX_USER_THEME_BYTES = 256 * 1024
const MAX_EVENT_ADAPTER_ID_LENGTH = 128
const MAX_EVENT_TITLE_LENGTH = 256
const MAX_EVENT_DETAIL_LENGTH = 512

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
  getWindow(): BrowserWindow | null
  getTray(): Tray | null
  getFloatingWindowController(): FloatingWindowController | null
  rebuildTrayMenu(): void
}
function senderWindow(event: IpcMainInvokeEvent): BrowserWindow | null {
  const win = BrowserWindow.fromWebContents(event.sender)
  return win && !win.isDestroyed() ? win : null
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

function isFloatingWindowSender(event: IpcMainInvokeEvent): boolean {
  const win = senderWindow(event)
  if (!win) return false
  try {
    return new URL(win.webContents.getURL()).searchParams.get('surface') === 'floating'
  } catch {
    return false
  }
}

async function listUserThemes() {
  const themesDirectory = join(app.getPath('userData'), 'themes')
  await mkdir(themesDirectory, { recursive: true })
  const entries = (await readdir(themesDirectory, { withFileTypes: true }))
    .filter(
      (entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.json')
    )
    .sort((left, right) => left.name.localeCompare(right.name))
    .slice(0, MAX_USER_THEME_FILES)

  const files = await Promise.all(
    entries.map(async (entry) => {
      const path = join(themesDirectory, entry.name)
      const metadata = await stat(path)
      if (metadata.size > MAX_USER_THEME_BYTES) {
        return {
          filename: entry.name,
          error: `文件大小 ${metadata.size} 字节，超过 256 KB 上限`
        }
      }
      return { filename: entry.name, source: await readFile(path, 'utf8') }
    })
  )
  return files
}

/** 注册所有 pty 相关的 invoke handler，委托 PTYManager。 */
export function registerIpc(manager: PTYManager, ctx: IpcContext): void {
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
  ipcMain.handle(FloatingWindowInvokeChannel.GetState, () =>
    ctx.getFloatingWindowController()?.getState() ?? { enabled: false }
  )
  ipcMain.handle(
    FloatingWindowInvokeChannel.SetEnabled,
    (_event, enabled: unknown) => {
      const controller = ctx.getFloatingWindowController()
      if (!controller || typeof enabled !== 'boolean') {
        return { enabled: false }
      }
      return controller.setEnabled(enabled)
    }
  )
  ipcMain.handle(
    FloatingWindowInvokeChannel.ResizeToContent,
    (event, height: unknown) => {
      if (
        isFloatingWindowSender(event) &&
        typeof height === 'number' &&
        Number.isFinite(height)
      ) {
        ctx.getFloatingWindowController()?.resizeToContent(height)
      }
    }
  )
  ipcMain.handle(
    FloatingWindowInvokeChannel.FocusSession,
    (event, sessionId: unknown) =>
      isFloatingWindowSender(event) &&
      typeof sessionId === 'string' &&
      sessionId.length <= 128
        ? Boolean(
            ctx.getFloatingWindowController()?.focusSession(sessionId)
          )
        : false
  )
  ipcMain.handle(ThemeInvokeChannel.ListUser, listUserThemes)
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
  ipcMain.handle(AgentInvokeChannel.ListActive, () =>
    ctx.agentRuntime.listActive()
  )

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

  ipcMain.handle(AppInvokeChannel.SetMainPrefs, (_event, update: unknown) => {
    applyMainPrefsUpdate(ctx, update)
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
  if (Object.keys(patch).length === 0) return

  const merged = await persistMainPrefs(patch)
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
