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
  ClipboardInvokeChannel,
  CliInvokeChannel,
  DialogInvokeChannel,
  PtyInvokeChannel,
  ShellInvokeChannel,
  StatsInvokeChannel,
  ThemeInvokeChannel,
  WindowInvokeChannel,
  type HistoryEvent,
  type CliLaunchSelection,
  type HistoryEventKind,
  type MainPrefsUpdate,
  type RecordEventInput,
  type SpawnOptions
} from '../shared/ipc-contract'
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
  'message',
  'session_start',
  'session_exit'
])

/** 主进程运行时上下文：窗口 / 托盘由 main.ts 组装后注入。 */
export interface IpcContext {
  eventLog: EventLog
  cliDiscovery: AiCliDiscoveryService
  getWindow(): BrowserWindow | null
  getTray(): Tray | null
  rebuildTrayMenu(): void
}
function senderWindow(event: IpcMainInvokeEvent): BrowserWindow | null {
  const win = BrowserWindow.fromWebContents(event.sender)
  return win && !win.isDestroyed() ? win : null
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
  ipcMain.handle(PtyInvokeChannel.Spawn, (_e, opts: SpawnOptions) =>
    manager.spawn(opts)
  )
  ipcMain.handle(
    PtyInvokeChannel.Write,
    (_e, { ptyId, data }: { ptyId: string; data: string }) =>
      manager.write(ptyId, data)
  )
  ipcMain.handle(
    PtyInvokeChannel.Resize,
    (_e, { ptyId, cols, rows }: { ptyId: string; cols: number; rows: number }) =>
      manager.resize(ptyId, cols, rows)
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
    PtyInvokeChannel.History,
    (_e, { ptyId }: { ptyId: string }) => manager.history(ptyId)
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
  ipcMain.handle(WindowInvokeChannel.GetPosition, (event) => {
    const win = senderWindow(event)
    if (!win) return { x: 0, y: 0, screenWidth: 1, screenHeight: 1 }
    return displayRelativePosition(win)
  })
  ipcMain.handle(ThemeInvokeChannel.ListUser, listUserThemes)
  ipcMain.handle(
    DialogInvokeChannel.PickDirectory,
    async (event, payload: { defaultPath?: unknown } | undefined) => {
      const win = senderWindow(event)
      const defaultPath =
        typeof payload?.defaultPath === 'string'
          ? payload.defaultPath
          : undefined
      const options = {
        defaultPath,
        properties: ['openDirectory' as const]
      }
      const result = win
        ? await dialog.showOpenDialog(win, options)
        : await dialog.showOpenDialog(options)
      return result.canceled ? null : result.filePaths[0] ?? null
    }
  )
  ipcMain.handle(ShellInvokeChannel.ListAvailable, listAvailableShells)
  ipcMain.handle(CliInvokeChannel.Scan, (_event, force: unknown) =>
    ctx.cliDiscovery.scan(force === true)
  )
  ipcMain.handle(CliInvokeChannel.PrepareLaunch, (_event, selection: unknown) =>
    ctx.cliDiscovery.prepareLaunch(selection as CliLaunchSelection)
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

function parseHistoryQuery(value: unknown): { limit: number; before?: number } | null {
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
  if (typeof raw.kind !== 'string' || !EVENT_KIND_WHITELIST.has(raw.kind as HistoryEventKind)) {
    return null
  }
  const kind = raw.kind as HistoryEventKind
  const adapterId = boundedString(raw.adapterId, MAX_EVENT_ADAPTER_ID_LENGTH, '')
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
}
