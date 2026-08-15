import { app, BrowserWindow } from 'electron'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { createWindow } from './window'
import { registerIpc, type IpcContext } from './ipc'
import { PTYManager } from './pty/PTYManager'
import { EventLog } from './events/EventLog'
import { loadMainPrefs, getMainPrefs } from './main-prefs'
import { markQuitting } from './quitting'
import {
  registerGlobalShortcut,
  unregisterGlobalShortcut,
  isGlobalShortcutRegistered
} from './shortcuts'
import {
  createTray,
  rebuildTrayMenu,
  toggleWindowVisibility,
  clickTrayMenuItem,
  trayMenuState,
  type Tray,
  type TrayCallbacks
} from './tray'
import { startThemeWatcher, stopThemeWatcher } from './themes-watch'
import { AppEventChannel } from '../shared/ipc-contract'
import {
  ElectronFloatingWindowController,
  type FloatingWindowController
} from './floating/FloatingWindowController'
import { AiCliDiscoveryService } from './ai-cli-discovery'
import { AgentSessionRuntime } from './agents/AgentSessionRuntime'
import { ObserverRegistry } from './agents/ObserverRegistry'
import { FixtureObserverAdapter } from './agents/adapters/fixture'
import { ClaudeObserverAdapter } from './agents/adapters/claude/ClaudeObserverAdapter'
import { OpenCodeObserverAdapter } from './agents/adapters/opencode'
import { CodexObserverAdapter } from './agents/adapters/codex'
import { PiObserverAdapter } from './agents/adapters/pi'
import { KimiObserverAdapter } from './agents/adapters/kimi'
import { HookIngress } from './hooks/HookIngress'
import { WorkspaceReader } from './workspace/WorkspaceReader'
import { WorkspaceReaderEventChannel } from '../shared/workspace-reader'
import { DshHostManager } from './dsh-host/DshHostManager'
import { DshWireProxy } from './dsh-host/DshWireProxy'
import { DshProjectionBridge } from './dsh-host/DshProjectionBridge'
import { DshSessionProjector } from './dsh-host/DshSessionProjector'
import { DshWebSurfaceController } from './dsh-surface/DshWebSurfaceController'

// E2E/开发：隔离 userData，保证 stats/主题等持久化断言从干净状态出发。
// 必须在 app ready 之前调用。
const userDataOverride = process.env['VIBING_USER_DATA_DIR']
if (userDataOverride) {
  app.setPath('userData', userDataOverride)
} else if (!app.isPackaged) {
  // 开发版与已安装的 Stable 版必须使用不同的进程锁和持久化目录，
  // 否则本地调试可能唤醒 Stable，或读写它的设置与缓存。
  const devUserDataDir = join(app.getPath('appData'), 'Vibing Dev')
  mkdirSync(devUserDataDir, { recursive: true })
  app.setPath('userData', devUserDataDir)
}

const isPrimaryInstance = app.requestSingleInstanceLock()

const manager = new PTYManager()
const cliDiscovery = new AiCliDiscoveryService(
  join(app.getPath('userData'), 'ai-cli-scan.json')
)
const eventLog = new EventLog()
// S1：Agent Observer 基础设施。fixture adapter 仅在 E2E 环境变量下启用。
const observerRegistry = new ObserverRegistry()
const hookIngress = new HookIngress()
const workspaceReader = new WorkspaceReader()
workspaceReader.onChanged((change) => {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.webContents.isDestroyed()) {
      win.webContents.send(WorkspaceReaderEventChannel.Changed, change)
    }
  }
})
manager.onTerminalRemoved((terminalId) => workspaceReader.unmount(terminalId))
observerRegistry.register(new ClaudeObserverAdapter(hookIngress))
observerRegistry.register(new OpenCodeObserverAdapter())
observerRegistry.register(new CodexObserverAdapter())
observerRegistry.register(new PiObserverAdapter())
observerRegistry.register(new KimiObserverAdapter())
observerRegistry.register(new FixtureObserverAdapter())
const agentRuntime = new AgentSessionRuntime({
  pty: manager,
  discovery: cliDiscovery,
  history: eventLog,
  registry: observerRegistry,
  workspace: workspaceReader,
  options: {
    runDirRoot: join(app.getPath('userData'), 'observer-runs'),
    broadcast: (channel, payload) => {
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.webContents.isDestroyed()) {
          win.webContents.send(channel, payload)
        }
      }
    }
  }
})
// DSH 内置 agent 运行时：懒启动（renderer 首次 ensureStarted），随 app 退出回收。
const broadcastToAllWindows = (channel: string, payload: unknown): void => {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.webContents.isDestroyed()) {
      win.webContents.send(channel, payload)
    }
  }
}
let dshSurfaceController: DshWebSurfaceController | null = null
const dshHost = new DshHostManager({
  defaultDshHome: join(app.getPath('userData'), 'dsh-home'),
  discovery: cliDiscovery,
  broadcast: broadcastToAllWindows,
  onBecameReady: () => dshProjector.start(),
  onLeftReady: () => {
    dshProjector.stop()
    dshSurfaceController?.hostStopped()
  }
})
const dshProjections = new DshProjectionBridge({
  broadcast: broadcastToAllWindows
})
const dshProjector = new DshSessionProjector(dshHost, dshProjections)
const dshWire = new DshWireProxy(dshHost, broadcastToAllWindows)
let shutdownStarted = false
let floatingController: FloatingWindowController | null = null
let winRef: BrowserWindow | null = null

const attachDshSurface = (window: BrowserWindow): void => {
  dshSurfaceController?.dispose()
  const controller = new DshWebSurfaceController(window, dshHost, {
    activateSlot: (slotId, sessionId) =>
      dshProjector.activateSlot(slotId, sessionId),
    setActiveSession: (sessionId) => dshProjector.setActiveSession(sessionId),
    unfollow: (slotId) => dshProjector.unfollow(slotId)
  })
  dshSurfaceController = controller
  window.once('closed', () => {
    controller.dispose()
    if (dshSurfaceController === controller) dshSurfaceController = null
  })
}

const showWindow = (): void => {
  if (!winRef || winRef.isDestroyed()) return
  if (winRef.isMinimized()) winRef.restore()
  winRef.show()
  winRef.focus()
}

if (!isPrimaryInstance) {
  app.quit()
} else {
  app.on('second-instance', showWindow)
}

if (isPrimaryInstance) app.whenReady().then(async () => {
  // M0 验收：抵达此行即证明 node-pty 已按 Electron ABI 成功加载
  console.log('[vibing] app ready; node-pty loaded against Electron ABI OK')
  // 诊断日志目录
  try {
    mkdirSync(join(process.cwd(), 'logs'), { recursive: true })
  } catch {
    /* ignore */
  }

  const prefs = await loadMainPrefs()
  await eventLog.init()

  let trayRef: Tray | null = null

  const trayCallbacks: TrayCallbacks = {
    toggleWindow: () => {
      if (winRef && !winRef.isDestroyed()) toggleWindowVisibility(winRef)
    },
    showWindow,
    openNewSession: () => {
      if (winRef && !winRef.isDestroyed() && !winRef.webContents.isDestroyed()) {
        winRef.webContents.send(AppEventChannel.OpenNewSession)
      }
    },
    quit: () => {
      markQuitting()
      app.quit()
    }
  }

  const ctx: IpcContext = {
    eventLog,
    cliDiscovery,
    agentRuntime,
    workspaceReader,
    dshHost,
    dshWire,
    dshProjections,
    getDshSurfaceController: () => dshSurfaceController,
    getWindow: () => (winRef && !winRef.isDestroyed() ? winRef : null),
    getTray: () => trayRef,
    getFloatingWindowController: () => floatingController,
    rebuildTrayMenu: () => {
      if (trayRef) rebuildTrayMenu(trayRef, getMainPrefs().language, trayCallbacks)
    }
  }

  registerIpc(manager, ctx)
  winRef = createWindow(prefs)
  attachDshSurface(winRef)
  floatingController = new ElectronFloatingWindowController({
    getMainWindow: () =>
      winRef && !winRef.isDestroyed() ? winRef : null,
    findActiveSession: (sessionId) =>
      agentRuntime
        .listActive()
        .find((projection) => projection.sessionId === sessionId) ??
      dshProjections.find(sessionId)
  })
  await floatingController.setEnabled(prefs.floatingWindowEnabled)
  trayRef = createTray(prefs.language, trayCallbacks)
  if (prefs.globalShortcutEnabled) {
    registerGlobalShortcut(winRef)
  }
  startThemeWatcher()

  // E2E：主进程调试钩子（托盘菜单点击 / 快捷键注册状态无法从 renderer 注入）。
  if (process.env['VIBING_E2E']) {
    ;(globalThis as Record<string, unknown>)['__vibingMainDebug'] = {
      hasTray: () => Boolean(trayRef),
      isWindowVisible: () => Boolean(winRef && !winRef.isDestroyed() && winRef.isVisible()),
      isWindowDestroyed: () => Boolean(winRef?.isDestroyed()),
      isShortcutRegistered: () => isGlobalShortcutRegistered(),
      toggleWindow: () => {
        if (winRef && !winRef.isDestroyed()) toggleWindowVisibility(winRef)
      },
      clickTrayItem: (index: number) => {
        const result = clickTrayMenuItem(index)
        return {
          ...trayMenuState(),
          invoked: result,
          visible: Boolean(winRef && !winRef.isDestroyed() && winRef.isVisible()),
          focused: Boolean(winRef && !winRef.isDestroyed() && winRef.isFocused())
        }
      },
      openNewSession: () => {
        if (winRef && !winRef.isDestroyed() && !winRef.webContents.isDestroyed()) {
          winRef.webContents.send(AppEventChannel.OpenNewSession)
        }
      },
      dshSurfaceSnapshot: () => dshSurfaceController?.snapshot() ?? null,
      dshSurfaceInspect: () => dshSurfaceController?.inspect() ?? null,
      dshSurfaceDismissOnboarding: () =>
        dshSurfaceController?.dismissOnboardingForTest() ?? false,
      dshSurfaceSelectSession: (sessionId: unknown) =>
        dshSurfaceController?.selectSessionForTest(sessionId) ?? false
    }
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      winRef = createWindow(prefs)
      attachDshSurface(winRef)
    } else {
      showWindow()
    }
  })
})

if (isPrimaryInstance) app.on('before-quit', (event) => {
  if (shutdownStarted) return
  event.preventDefault()
  shutdownStarted = true
  markQuitting()
  void (async () => {
    // Agent Runtime 先写入退出事实并回收 observer；随后兜底关闭普通终端。
    await agentRuntime.disposeAll()
    await hookIngress.dispose()
    dshProjector.stop()
    dshWire.dispose()
    dshSurfaceController?.dispose()
    dshSurfaceController = null
    await dshHost.dispose()
    floatingController?.dispose()
    workspaceReader.clear()
    manager.killAll()
    unregisterGlobalShortcut()
    stopThemeWatcher()
    app.quit()
  })()
})
