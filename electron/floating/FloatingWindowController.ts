import { BrowserWindow, screen, session, shell, type WebContents } from 'electron'
import { isAbsolute, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { AgentEventChannel, type AgentSessionProjection } from '../../shared/agent-events'
import {
  BUILTIN_FLOATING_RENDERER_ID,
  FLOATING_WINDOW_SCALE_MAX,
  FLOATING_WINDOW_SCALE_MIN,
  FloatingWindowEventChannel,
  type FloatingAppearance,
  type FloatingAttentionKind,
  type FloatingAttentionSignal,
  type FloatingRendererSnapshot,
  type FloatingSession,
  type FloatingShapeRect,
  type FloatingWindowState
} from '../../shared/floating-window'
import { AppEventChannel } from '../../shared/ipc-contract'
import { getMainPrefs, persistMainPrefs } from '../main-prefs'
import {
  FloatingRendererRegistry,
  type FloatingRendererDefinition,
  type FloatingRendererRegistrySnapshot
} from './FloatingRendererRegistry'
import {
  FLOATING_RENDERER_SCHEME,
  installFloatingRendererProtocol
} from './FloatingRendererProtocol'

const EDGE_GAP = 20
const FLOATING_PARTITION = 'hrack-floating-renderers'
/** Highest practical always-on-top level; macOS maps this above normal apps. */
const FLOATING_ALWAYS_ON_TOP_LEVEL = 'screen-saver' as const
/** Re-assert topmost periodically so other topmost/fullscreen apps cannot keep it buried. */
const FLOATING_TOPMOST_REFRESH_MS = 8_000

export interface FloatingWindowController {
  getState(): FloatingWindowState
  setEnabled(enabled: boolean): Promise<FloatingWindowState>
  setRenderer(rendererId: string): Promise<FloatingWindowState>
  setAttentionEffectEnabled(enabled: boolean): Promise<FloatingWindowState>
  setScale(scale: number): Promise<FloatingWindowState>
  openRenderersDirectory(): Promise<void>
  refreshRenderers(): Promise<FloatingWindowState>
  setAppearance(appearance: FloatingAppearance): void
  publishProjection(projection: AgentSessionProjection): void
  getSnapshot(): FloatingRendererSnapshot
  resizeToContent(height: number): void
  setShape(rects: FloatingShapeRect[]): void
  focusSession(sessionId: string): boolean
  isRendererSender(sender: WebContents): boolean
  inspect(): unknown
  dispose(): void
}

interface FloatingWindowControllerDeps {
  getMainWindow(): BrowserWindow | null
  listActiveSessions(): AgentSessionProjection[]
  renderersDirectory: string
  builtinRendererRoot: string
  builtinLive2dRoot: string
}

function attentionKind(status: AgentSessionProjection['status']): FloatingAttentionKind | null {
  return status === 'needs-you' || status === 'done' || status === 'error'
    ? status
    : null
}

function toFloatingSession(projection: AgentSessionProjection): FloatingSession {
  return {
    sessionId: projection.sessionId,
    adapterId: projection.adapterId,
    name: projection.name,
    status: projection.status,
    statusConfidence: projection.statusConfidence,
    observerHealth: projection.observerHealth,
    detail: projection.detail,
    pendingAttentionCount: projection.pendingAttentionCount,
    lastActivityAt: projection.lastActivityAt,
    lastSeq: projection.lastSeq,
    activeTurnId: projection.activeTurnId,
    activeToolCount: projection.activeToolCount ?? 0,
    lastTurnOutcome: projection.correlation?.lastTurnOutcome
  }
}

/**
 * Owns the complete floating renderer lifecycle. Built-in and user renderers
 * receive the same snapshot through the same minimal preload; callers never
 * manage BrowserWindow, protocol, filesystem watching or fallback races.
 */
export class ElectronFloatingWindowController
  implements FloatingWindowController
{
  private readonly registry: FloatingRendererRegistry
  private readonly sessions = new Map<string, AgentSessionProjection>()
  private window: BrowserWindow | null = null
  private activeDefinition: FloatingRendererDefinition | null = null
  private enabled = false
  private disposed = false
  private initialized = false
  private operation: Promise<void> = Promise.resolve()
  private moveTimer: NodeJS.Timeout | null = null
  private topmostTimer: NodeJS.Timeout | null = null
  private uninstallProtocol: (() => void) | null = null
  private selectedRendererId = BUILTIN_FLOATING_RENDERER_ID
  private attentionEffectEnabled = true
  private scale = 1
  private appearance: FloatingAppearance
  private attention: FloatingAttentionSignal | null = null
  private attentionSequence = 0
  private activeError: string | null = null
  private shapeRectCount = 0
  private lastContentHeight: number | null = null
  private lastShapeRects: FloatingShapeRect[] = []
  private suppressWindowRecovery = false
  /** Bottom edge used as the stable anchor across programmatic resizes. */
  private anchorBottom: number | null = null
  /** True while this controller is moving/resizing the window itself. */
  private suppressAnchorUpdate = false
  private readonly handleDisplayChange = (): void => this.clampToVisibleArea()

  constructor(private readonly deps: FloatingWindowControllerDeps) {
    const prefs = getMainPrefs()
    this.selectedRendererId = prefs.floatingRendererId
    this.attentionEffectEnabled = prefs.floatingAttentionEffectEnabled
    this.scale = prefs.floatingWindowScale
    this.appearance = prefs.floatingAppearance
    for (const projection of deps.listActiveSessions()) {
      if (projection.status !== 'exited') this.sessions.set(projection.sessionId, projection)
    }
    this.registry = new FloatingRendererRegistry({
      userDirectory: deps.renderersDirectory,
      builtinRoot: deps.builtinRendererRoot,
      builtinLive2dRoot: deps.builtinLive2dRoot,
      onChanged: (snapshot) => this.handleRegistryChanged(snapshot)
    })
    screen.on('display-removed', this.handleDisplayChange)
    screen.on('display-metrics-changed', this.handleDisplayChange)
  }

  getState(): FloatingWindowState {
    const registry = this.registry.snapshot()
    return {
      enabled: this.enabled,
      selectedRendererId: this.selectedRendererId,
      activeRendererId: this.activeDefinition?.id ?? null,
      renderers: registry.definitions.map(({ id, name, version, source }) => ({
        id,
        name,
        version,
        source
      })),
      rendererErrors: [...registry.errors],
      activeError: this.activeError,
      attentionEffectEnabled: this.attentionEffectEnabled,
      scale: this.scale
    }
  }

  setEnabled(enabled: boolean): Promise<FloatingWindowState> {
    return this.enqueue(async () => {
      await this.ensureInitialized()
      if (enabled === this.enabled) {
        if (enabled) await this.ensureWindow()
        return
      }
      this.enabled = enabled
      await persistMainPrefs({ floatingWindowEnabled: enabled })
      if (enabled) await this.ensureWindow()
      else this.destroyWindow()
      this.broadcastState()
    }).then(() => this.getState())
  }

  setRenderer(rendererId: string): Promise<FloatingWindowState> {
    return this.enqueue(async () => {
      await this.ensureInitialized()
      if (!this.registry.find(rendererId)) return
      if (rendererId === this.selectedRendererId && this.window) return
      this.selectedRendererId = rendererId
      this.activeError = null
      await persistMainPrefs({ floatingRendererId: rendererId })
      if (this.enabled) await this.recreateWindow()
      this.broadcastState()
    }).then(() => this.getState())
  }

  setAttentionEffectEnabled(enabled: boolean): Promise<FloatingWindowState> {
    return this.enqueue(async () => {
      if (enabled === this.attentionEffectEnabled) return
      this.attentionEffectEnabled = enabled
      await persistMainPrefs({ floatingAttentionEffectEnabled: enabled })
      this.broadcastSnapshot()
      this.broadcastState()
    }).then(() => this.getState())
  }

  setScale(scale: number): Promise<FloatingWindowState> {
    return this.enqueue(async () => {
      const next = Math.max(
        FLOATING_WINDOW_SCALE_MIN,
        Math.min(FLOATING_WINDOW_SCALE_MAX, Math.round(scale * 100) / 100)
      )
      if (!Number.isFinite(next) || next === this.scale) return
      this.scale = next
      await persistMainPrefs({ floatingWindowScale: next })
      this.applyScale()
      this.broadcastState()
    }).then(() => this.getState())
  }

  async openRenderersDirectory(): Promise<void> {
    await this.ensureInitialized()
    const error = await shell.openPath(this.deps.renderersDirectory)
    if (error) throw new Error(error)
  }

  refreshRenderers(): Promise<FloatingWindowState> {
    return this.enqueue(async () => {
      await this.ensureInitialized()
      await this.registry.refresh()
    }).then(() => this.getState())
  }

  setAppearance(appearance: FloatingAppearance): void {
    this.appearance = appearance
    this.broadcastSnapshot()
  }

  publishProjection(projection: AgentSessionProjection): void {
    const previous = this.sessions.get(projection.sessionId)
    if (previous && projection.lastSeq <= previous.lastSeq) return
    if (projection.status === 'exited') this.sessions.delete(projection.sessionId)
    else this.sessions.set(projection.sessionId, projection)

    const kind = attentionKind(projection.status)
    if (kind && previous?.status !== projection.status) {
      this.attention = {
        sequence: ++this.attentionSequence,
        sessionId: projection.sessionId,
        kind,
        occurredAt: Date.now()
      }
    }
    this.broadcastSnapshot()
  }

  getSnapshot(): FloatingRendererSnapshot {
    return {
      schemaVersion: 1,
      sessions: [...this.sessions.values()]
        .filter((projection) => projection.status !== 'exited')
        .sort(
          (left, right) =>
            right.lastActivityAt - left.lastActivityAt ||
            left.sessionId.localeCompare(right.sessionId)
        )
        .map(toFloatingSession),
      attention: this.attention,
      appearance: this.appearance,
      attentionEffectEnabled: this.attentionEffectEnabled
    }
  }

  resizeToContent(height: number): void {
    const win = this.window
    const definition = this.activeDefinition
    if (
      !win ||
      win.isDestroyed() ||
      !definition ||
      !Number.isFinite(height)
    ) {
      return
    }
    this.lastContentHeight = Math.ceil(height)
    const bounds = win.getBounds()
    const workArea = screen.getDisplayMatching(bounds).workArea
    const scaledMinHeight = Math.round(definition.minHeight * this.scale)
    const nextHeight = Math.max(
      scaledMinHeight,
      Math.min(
        Math.round(definition.maxHeight * this.scale),
        workArea.height,
        Math.ceil(height * this.scale)
      )
    )
    const scaledWidth = Math.round(definition.width * this.scale)
    const boundedHeight = nextHeight
    if (boundedHeight === bounds.height && scaledWidth === bounds.width) return
    const bottom = this.anchorBottom ?? (bounds.y + bounds.height)
    this.setBoundsKeepingBottom(win, bounds.x, scaledWidth, boundedHeight, bottom)
  }

  setShape(rects: FloatingShapeRect[]): void {
    this.lastShapeRects = rects.map((rect) => ({ ...rect }))
    const win = this.window
    if (!win || win.isDestroyed()) return
    if (process.platform !== 'win32' && process.platform !== 'linux') return
    const bounds = win.getContentBounds()
    const normalized = rects
      .slice(0, 1_024)
      .map((rect) => {
        const x = Math.max(0, Math.min(bounds.width - 1, Math.round(rect.x * this.scale)))
        const y = Math.max(0, Math.min(bounds.height - 1, Math.round(rect.y * this.scale)))
        return {
          x,
          y,
          width: Math.max(
            1,
            Math.min(bounds.width - x, Math.round(rect.width * this.scale))
          ),
          height: Math.max(
            1,
            Math.min(bounds.height - y, Math.round(rect.height * this.scale))
          )
        }
      })
      .filter((rect) => rect.width > 0 && rect.height > 0)
    const shape = normalized.length > 0
      ? normalized
      : [{ x: 0, y: 0, width: bounds.width, height: bounds.height }]
    try {
      win.setShape(shape)
      this.shapeRectCount = shape.length
    } catch (error) {
      console.warn('[floating-window] failed to apply native shape:', error)
    }
  }

  focusSession(sessionId: string): boolean {
    const projection = this.sessions.get(sessionId)
    const mainWindow = this.deps.getMainWindow()
    if (!projection || !mainWindow || mainWindow.isDestroyed()) return false
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
    if (!mainWindow.webContents.isDestroyed()) {
      mainWindow.webContents.send(AppEventChannel.FocusSession, {
        sessionId: projection.sessionId,
        terminalId: projection.terminalId
      })
    }
    return true
  }

  isRendererSender(sender: WebContents): boolean {
    return Boolean(
      this.window &&
        !this.window.isDestroyed() &&
        this.window.webContents.id === sender.id
    )
  }

  inspect(): unknown {
    const win = this.window
    return {
      state: this.getState(),
      snapshot: this.getSnapshot(),
      window:
        win && !win.isDestroyed()
          ? {
              id: win.id,
              visible: win.isVisible(),
              bounds: win.getBounds(),
              preferences: {
                partition: FLOATING_PARTITION,
                contextIsolation: true,
                nodeIntegration: false,
                sandbox: true,
                webSecurity: true
              },
              shapeRectCount: this.shapeRectCount,
              scale: this.scale,
              url: win.webContents.getURL()
            }
          : null
    }
  }

  dispose(): void {
    this.disposed = true
    if (this.moveTimer) clearTimeout(this.moveTimer)
    this.moveTimer = null
    if (this.topmostTimer) clearInterval(this.topmostTimer)
    this.topmostTimer = null
    screen.removeListener('display-removed', this.handleDisplayChange)
    screen.removeListener('display-metrics-changed', this.handleDisplayChange)
    this.registry.dispose()
    this.uninstallProtocol?.()
    this.uninstallProtocol = null
    this.destroyWindow()
  }

  private enqueue(action: () => Promise<void>): Promise<void> {
    const result = this.operation.catch(() => undefined).then(action)
    this.operation = result.catch(() => undefined)
    return result
  }

  private async ensureInitialized(): Promise<void> {
    if (this.initialized || this.disposed) return
    await this.registry.start()
    const isolatedSession = session.fromPartition(FLOATING_PARTITION, {
      cache: false
    })
    isolatedSession.setPermissionRequestHandler(
      (_webContents, _permission, callback) => callback(false)
    )
    isolatedSession.setPermissionCheckHandler(() => false)
    this.uninstallProtocol = installFloatingRendererProtocol(
      isolatedSession,
      this.registry
    )
    this.initialized = true
  }

  private async ensureWindow(): Promise<void> {
    if (this.window && !this.window.isDestroyed()) return
    const selected = this.registry.find(this.selectedRendererId)
    const definition =
      selected ?? this.registry.find(BUILTIN_FLOATING_RENDERER_ID)
    if (!definition) throw new Error('built-in floating renderer is unavailable')
    if (!selected) {
      this.activeError = `悬浮窗实现 ${this.selectedRendererId} 不可用，已回退默认实现`
    }
    await this.createWindowWithFallback(definition)
  }

  private async recreateWindow(): Promise<void> {
    this.destroyWindow()
    if (this.enabled) await this.ensureWindow()
  }

  private async createWindowWithFallback(
    definition: FloatingRendererDefinition
  ): Promise<void> {
    try {
      await this.createWindow(definition)
      if (definition.id === this.selectedRendererId) this.activeError = null
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (definition.id === BUILTIN_FLOATING_RENDERER_ID) {
        this.activeError = `默认悬浮窗加载失败：${message}`
        throw error
      }
      this.activeError = `${definition.name} 加载失败，已回退默认实现：${message}`
      this.destroyWindow()
      const fallback = this.registry.find(BUILTIN_FLOATING_RENDERER_ID)
      if (!fallback) throw error
      await this.createWindow(fallback)
    } finally {
      this.broadcastState()
    }
  }

  private async createWindow(definition: FloatingRendererDefinition): Promise<void> {
    const width = Math.round(definition.width * this.scale)
    const minHeight = Math.round(definition.minHeight * this.scale)
    const maxHeight = Math.round(definition.maxHeight * this.scale)
    const saved = getMainPrefs().floatingWindowPosition
    const display =
      (saved
        ? screen.getAllDisplays().find((candidate) => candidate.id === saved.displayId)
        : undefined) ?? screen.getPrimaryDisplay()
    const workArea = display.workArea
    const x = saved
      ? Math.max(
          workArea.x,
          Math.min(saved.x, workArea.x + workArea.width - width)
        )
      : workArea.x + workArea.width - width - EDGE_GAP
    const y = saved
      ? Math.max(
          workArea.y,
          Math.min(saved.y, workArea.y + workArea.height - minHeight)
        )
      : workArea.y + workArea.height - minHeight - EDGE_GAP
    const win = new BrowserWindow({
      width,
      height: minHeight,
      x,
      y,
      minWidth: width,
      maxWidth: width,
      minHeight,
      maxHeight,
      show: false,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      alwaysOnTop: true,
      skipTaskbar: true,
      resizable: false,
      maximizable: false,
      minimizable: false,
      fullscreenable: false,
      hasShadow: true,
      webPreferences: {
        preload: join(__dirname, '../preload/floating.js'),
        partition: FLOATING_PARTITION,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true
      }
    })
    this.window = win
    this.activeDefinition = definition
    this.shapeRectCount = 0
    this.lastContentHeight = definition.minHeight
    this.lastShapeRects = []
    this.suppressWindowRecovery = false
    this.anchorBottom = win.getBounds().y + win.getBounds().height
    win.on('closed', () => {
      if (this.window === win) {
        this.window = null
        this.activeDefinition = null
      }
      if (this.moveTimer) clearTimeout(this.moveTimer)
      this.moveTimer = null
      if (this.topmostTimer) clearInterval(this.topmostTimer)
      this.topmostTimer = null
    })
    win.on('move', () => {
      if (!this.suppressAnchorUpdate && !win.isDestroyed()) {
        const bounds = win.getBounds()
        this.anchorBottom = bounds.y + bounds.height
      }
      this.schedulePositionSave(win)
    })
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    win.webContents.on('will-navigate', (event, nextUrl) => {
      if (!this.isAllowedNavigation(definition, nextUrl)) event.preventDefault()
    })
    win.webContents.on('render-process-gone', (_event, details) => {
      if (
        this.suppressWindowRecovery ||
        this.window !== win ||
        !this.enabled ||
        this.disposed
      ) {
        return
      }
      void this.enqueue(() =>
        this.handleRendererFailure(
          definition,
          `渲染进程退出：${details.reason}`
        )
      )
    })
    win.setAlwaysOnTop(true, FLOATING_ALWAYS_ON_TOP_LEVEL)
    win.webContents.setZoomFactor(this.scale)

    if (definition.id === BUILTIN_FLOATING_RENDERER_ID) {
      if (process.env['ELECTRON_RENDERER_URL']) {
        const url = new URL(process.env['ELECTRON_RENDERER_URL'])
        url.searchParams.set('surface', 'floating')
        url.searchParams.set('renderer', definition.id)
        await win.loadURL(url.toString())
      } else {
        await win.loadFile(join(definition.root, definition.entry), {
          query: { surface: 'floating', renderer: definition.id }
        })
      }
    } else {
      if (definition.source === 'builtin') {
        await win.loadFile(join(definition.root, definition.entry))
      } else {
        const id = definition.id.slice('user/'.length)
        const url = new URL(`${FLOATING_RENDERER_SCHEME}://${id}/`)
        url.pathname = `/${definition.entry}`
        await win.loadURL(url.toString())
      }
    }

    if (!this.enabled || this.disposed || win.isDestroyed()) {
      if (!win.isDestroyed()) win.destroy()
      return
    }
    this.broadcastSnapshot()
    win.showInactive()
    this.ensureTopmost(win)
    this.topmostTimer = setInterval(
      () => this.ensureTopmost(win),
      FLOATING_TOPMOST_REFRESH_MS
    )
  }

  private async handleRendererFailure(
    definition: FloatingRendererDefinition,
    reason: string
  ): Promise<void> {
    if (definition.id === BUILTIN_FLOATING_RENDERER_ID) {
      this.activeError = `默认悬浮窗失败：${reason}`
      this.broadcastState()
      return
    }
    this.activeError = `${definition.name} 失败，已回退默认实现：${reason}`
    this.destroyWindow()
    const fallback = this.registry.find(BUILTIN_FLOATING_RENDERER_ID)
    if (fallback) await this.createWindow(fallback)
    this.broadcastState()
  }

  private isAllowedNavigation(
    definition: FloatingRendererDefinition,
    nextUrl: string
  ): boolean {
    try {
      const url = new URL(nextUrl)
      if (definition.source === 'user') {
        return (
          url.protocol === `${FLOATING_RENDERER_SCHEME}:` &&
          `user/${url.hostname}` === definition.id
        )
      }
      if (process.env['ELECTRON_RENDERER_URL']) {
        return url.origin === new URL(process.env['ELECTRON_RENDERER_URL']).origin
      }
      if (url.protocol !== 'file:') return false
      const path = relative(definition.root, fileURLToPath(url))
      return path === '' || (!path.startsWith('..') && !isAbsolute(path))
    } catch {
      return false
    }
  }

  private handleRegistryChanged(_snapshot: FloatingRendererRegistrySnapshot): void {
    if (this.disposed) return
    this.broadcastState()
    if (!this.initialized || !this.enabled) return
    void this.enqueue(async () => {
      if (!this.enabled || this.disposed) return
      await this.recreateWindow()
    })
  }

  private destroyWindow(): void {
    const win = this.window
    this.window = null
    this.activeDefinition = null
    this.shapeRectCount = 0
    this.lastContentHeight = null
    this.lastShapeRects = []
    this.suppressWindowRecovery = true
    if (this.topmostTimer) clearInterval(this.topmostTimer)
    this.topmostTimer = null
    if (win && !win.isDestroyed()) win.destroy()
  }

  private applyScale(): void {
    const win = this.window
    const definition = this.activeDefinition
    if (!win || win.isDestroyed() || !definition) return
    const bounds = win.getBounds()
    const workArea = screen.getDisplayMatching(bounds).workArea
    const width = Math.min(workArea.width, Math.round(definition.width * this.scale))
    const minHeight = Math.min(workArea.height, Math.round(definition.minHeight * this.scale))
    const maxHeight = Math.min(workArea.height, Math.round(definition.maxHeight * this.scale))
    const contentHeight = this.lastContentHeight ?? definition.minHeight
    const height = Math.max(minHeight, Math.min(maxHeight, Math.round(contentHeight * this.scale)))
    const right = bounds.x + bounds.width
    const bottom = this.anchorBottom ?? (bounds.y + bounds.height)
    const x = Math.max(workArea.x, Math.min(right - width, workArea.x + workArea.width - width))
    win.setMinimumSize(1, 1)
    win.setMaximumSize(workArea.width, workArea.height)
    this.setBoundsKeepingBottom(win, x, width, height, bottom)
    win.setMinimumSize(width, minHeight)
    win.setMaximumSize(width, maxHeight)
    win.webContents.setZoomFactor(this.scale)
    if (this.lastShapeRects.length > 0) this.setShape(this.lastShapeRects)
  }

  /** Re-assert the floating window's topmost z-order. */
  private ensureTopmost(win: BrowserWindow): void {
    if (!win || win.isDestroyed() || !this.enabled || this.disposed) return
    try {
      win.setAlwaysOnTop(true, FLOATING_ALWAYS_ON_TOP_LEVEL)
      win.moveTop()
    } catch {
      // Topmost re-assertion is best-effort; ignore platform-specific failures.
    }
  }

  /**
   * Resize/move the window while keeping `bottom` as the stable anchor.
   *
   * On scaled displays Electron may quantize the resulting window height (e.g.
   * a 150% display turns a requested height of 109 DIP into 110 DIP). Reading
   * the actual bounds and correcting y prevents the bottom edge from drifting
   * downward on every content-height update.
   */
  private setBoundsKeepingBottom(
    win: BrowserWindow,
    x: number,
    width: number,
    height: number,
    bottom: number
  ): void {
    const workArea = screen.getDisplayMatching(win.getBounds()).workArea
    const requestedY = Math.max(
      workArea.y,
      Math.min(bottom - height, workArea.y + workArea.height - height)
    )
    this.suppressAnchorUpdate = true
    try {
      win.setBounds({ x, y: requestedY, width, height })
      const actual = win.getBounds()
      const actualBottom = actual.y + actual.height
      if (actualBottom !== bottom) {
        const correctedY = Math.max(
          workArea.y,
          Math.min(
            bottom - actual.height,
            workArea.y + workArea.height - actual.height
          )
        )
        if (correctedY !== actual.y) win.setPosition(actual.x, correctedY)
      }
    } finally {
      this.suppressAnchorUpdate = false
    }
  }

  private schedulePositionSave(win: BrowserWindow): void {
    if (this.moveTimer) clearTimeout(this.moveTimer)
    this.moveTimer = setTimeout(() => {
      this.moveTimer = null
      if (win.isDestroyed() || this.window !== win) return
      const bounds = win.getBounds()
      const display = screen.getDisplayMatching(bounds)
      void persistMainPrefs({
        floatingWindowPosition: {
          x: bounds.x,
          y: bounds.y,
          displayId: display.id
        }
      })
    }, 150)
  }

  private clampToVisibleArea(): void {
    const win = this.window
    if (!win || win.isDestroyed()) return
    const bounds = win.getBounds()
    const workArea = screen.getDisplayMatching(bounds).workArea
    const x = Math.max(
      workArea.x,
      Math.min(bounds.x, workArea.x + workArea.width - bounds.width)
    )
    const y = Math.max(
      workArea.y,
      Math.min(bounds.y, workArea.y + workArea.height - bounds.height)
    )
    if (x !== bounds.x || y !== bounds.y) win.setPosition(x, y)
  }

  private broadcastState(): void {
    const state = this.getState()
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.webContents.isDestroyed()) {
        win.webContents.send(FloatingWindowEventChannel.StateChanged, state)
      }
    }
  }

  private broadcastSnapshot(): void {
    const win = this.window
    if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return
    win.webContents.send(
      FloatingWindowEventChannel.SnapshotChanged,
      this.getSnapshot()
    )
  }
}

export function isAgentProjectionChannel(
  channel: string,
  payload: unknown
): payload is AgentSessionProjection {
  return (
    channel === AgentEventChannel.Projection &&
    Boolean(payload) &&
    typeof payload === 'object' &&
    typeof (payload as AgentSessionProjection).sessionId === 'string'
  )
}
