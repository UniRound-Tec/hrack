import { BrowserWindow, screen } from 'electron'
import { join } from 'node:path'
import {
  AppEventChannel,
  FloatingWindowEventChannel,
  type FloatingWindowState
} from '../../shared/ipc-contract'
import { getMainPrefs, persistMainPrefs } from '../main-prefs'
import type { AgentSessionProjection } from '../../shared/agent-events'

const FLOATING_WIDTH = 248
const FLOATING_HEIGHT = 92
const FLOATING_MAX_HEIGHT = 360
const EDGE_GAP = 20

export interface FloatingWindowController {
  getState(): FloatingWindowState
  setEnabled(enabled: boolean): Promise<FloatingWindowState>
  resizeToContent(height: number): void
  focusSession(sessionId: string): boolean
  dispose(): void
}

interface FloatingWindowControllerDeps {
  getMainWindow(): BrowserWindow | null
  findActiveSession(sessionId: string): AgentSessionProjection | undefined
}

/**
 * 第二 BrowserWindow 的唯一所有者。调用方只表达 enabled/resize/focus 意图，
 * 不参与窗口是否已创建、正在加载或正在退出的竞态。
 */
export class ElectronFloatingWindowController
  implements FloatingWindowController
{
  private window: BrowserWindow | null = null
  private enabled = false
  private disposed = false
  private operation: Promise<void> = Promise.resolve()
  private moveTimer: NodeJS.Timeout | null = null
  private readonly handleDisplayChange = (): void => this.clampToVisibleArea()

  constructor(private readonly deps: FloatingWindowControllerDeps) {
    screen.on('display-removed', this.handleDisplayChange)
    screen.on('display-metrics-changed', this.handleDisplayChange)
  }

  getState(): FloatingWindowState {
    return { enabled: this.enabled }
  }

  setEnabled(enabled: boolean): Promise<FloatingWindowState> {
    this.operation = this.operation.then(() => this.applyEnabled(enabled))
    return this.operation.then(() => this.getState())
  }

  resizeToContent(height: number): void {
    const win = this.window
    if (!win || win.isDestroyed() || !Number.isFinite(height)) return
    const bounds = win.getBounds()
    const workArea = screen.getDisplayMatching(bounds).workArea
    const nextHeight = Math.max(
      FLOATING_HEIGHT,
      Math.min(FLOATING_MAX_HEIGHT, workArea.height, Math.ceil(height))
    )
    if (nextHeight === bounds.height) return
    const bottom = bounds.y + bounds.height
    const nextY = Math.max(
      workArea.y,
      Math.min(bottom - nextHeight, workArea.y + workArea.height - nextHeight)
    )
    win.setBounds({
      x: bounds.x,
      y: nextY,
      width: FLOATING_WIDTH,
      height: nextHeight
    })
  }

  focusSession(sessionId: string): boolean {
    const projection = this.deps.findActiveSession(sessionId)
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

  dispose(): void {
    this.disposed = true
    const win = this.window
    this.window = null
    if (this.moveTimer) clearTimeout(this.moveTimer)
    this.moveTimer = null
    screen.removeListener('display-removed', this.handleDisplayChange)
    screen.removeListener('display-metrics-changed', this.handleDisplayChange)
    if (win && !win.isDestroyed()) win.destroy()
  }

  private async applyEnabled(enabled: boolean): Promise<void> {
    if (this.disposed) return
    if (enabled === this.enabled) {
      if (enabled) await this.ensureWindow()
      return
    }

    this.enabled = enabled
    await persistMainPrefs({ floatingWindowEnabled: enabled })
    if (enabled) {
      try {
        await this.ensureWindow()
      } catch (error) {
        console.error('[floating-window] failed to create:', error)
        this.enabled = false
        await persistMainPrefs({ floatingWindowEnabled: false })
      }
    } else {
      const win = this.window
      this.window = null
      if (win && !win.isDestroyed()) win.destroy()
    }
    this.broadcastState()
  }

  private async ensureWindow(): Promise<void> {
    if (this.window && !this.window.isDestroyed()) return
    const saved = getMainPrefs().floatingWindowPosition
    const display =
      (saved
        ? screen.getAllDisplays().find((candidate) => candidate.id === saved.displayId)
        : undefined) ?? screen.getPrimaryDisplay()
    const workArea = display.workArea
    const x = saved
      ? Math.max(
          workArea.x,
          Math.min(saved.x, workArea.x + workArea.width - FLOATING_WIDTH)
        )
      : workArea.x + workArea.width - FLOATING_WIDTH - EDGE_GAP
    const y = saved
      ? Math.max(
          workArea.y,
          Math.min(saved.y, workArea.y + workArea.height - FLOATING_HEIGHT)
        )
      : workArea.y + workArea.height - FLOATING_HEIGHT - EDGE_GAP
    const win = new BrowserWindow({
      width: FLOATING_WIDTH,
      height: FLOATING_HEIGHT,
      x,
      y,
      minWidth: FLOATING_WIDTH,
      maxWidth: FLOATING_WIDTH,
      minHeight: FLOATING_HEIGHT,
      maxHeight: FLOATING_MAX_HEIGHT,
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
        preload: join(__dirname, '../preload/index.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false
      }
    })
    this.window = win
    win.on('closed', () => {
      if (this.window === win) this.window = null
      if (this.moveTimer) clearTimeout(this.moveTimer)
      this.moveTimer = null
    })
    win.on('move', () => this.schedulePositionSave(win))
    win.setAlwaysOnTop(true, 'floating')

    if (process.env['ELECTRON_RENDERER_URL']) {
      const url = new URL(process.env['ELECTRON_RENDERER_URL'])
      url.searchParams.set('surface', 'floating')
      await win.loadURL(url.toString())
    } else {
      await win.loadFile(join(__dirname, '../renderer/index.html'), {
        query: { surface: 'floating' }
      })
    }

    if (!this.enabled || this.disposed || win.isDestroyed()) {
      if (!win.isDestroyed()) win.destroy()
      return
    }
    win.showInactive()
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
    if (x !== bounds.x || y !== bounds.y) {
      win.setPosition(x, y)
    }
  }

  private broadcastState(): void {
    const state = this.getState()
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.webContents.isDestroyed()) {
        win.webContents.send(FloatingWindowEventChannel.StateChanged, state)
      }
    }
  }
}
