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
import {
  AppEventChannel,
  RemoteEventChannel,
  UpdateEventChannel,
  type BridgeLaunchAck,
  type BridgeLaunchRequest
} from '../shared/ipc-contract'
import {
  ElectronFloatingWindowController,
  isAgentProjectionChannel,
  type FloatingWindowController
} from './floating/FloatingWindowController'
import { registerFloatingRendererScheme } from './floating/FloatingRendererProtocol'
import { AiCliDiscoveryService } from './ai-cli-discovery'
import { AgentSessionRuntime } from './agents/AgentSessionRuntime'
import { ObserverRegistry } from './agents/ObserverRegistry'
import { FixtureObserverAdapter } from './agents/adapters/fixture'
import { ClaudeObserverAdapter } from './agents/adapters/claude/ClaudeObserverAdapter'
import { OpenCodeObserverAdapter } from './agents/adapters/opencode'
import { CodexObserverAdapter } from './agents/adapters/codex'
import { PiObserverAdapter } from './agents/adapters/pi'
import { KimiObserverAdapter } from './agents/adapters/kimi'
import { GrokObserverAdapter } from './agents/adapters/grok'
import { HookIngress } from './hooks/HookIngress'
import { WorkspaceReader } from './workspace/WorkspaceReader'
import { WorkspaceReaderEventChannel } from '../shared/workspace-reader'
import { DshHostManager } from './dsh-host/DshHostManager'
import { DshWireProxy } from './dsh-host/DshWireProxy'
import { DshProjectionBridge } from './dsh-host/DshProjectionBridge'
import { DshSessionProjector } from './dsh-host/DshSessionProjector'
import { DshWebSurfaceController } from './dsh-surface/DshWebSurfaceController'
import { ElectronUpdaterDriver } from './update/UpdateDriver'
import { UpdateService } from './update/UpdateService'
import packageMetadata from '../package.json'
import { registerWindowsAppUserModelId } from './app-icons'
import { resolveHrackUserDataDir } from './app-paths'
import { extractHrackCliArgv, runHrackCli } from './cli/hrackCli'
import { BridgeServer } from './bridge/BridgeServer'
import { OpenCodeControlPlane } from './bridge/OpenCodeControlPlane'
import { BridgeStateStore } from './bridge/state'
import { BridgeError } from './bridge/errors'
import { RemoteDesktopClient } from './remote/RemoteDesktopClient'
import { runtimeSessionSource } from './remote/runtimeSessionSource'
import { runtimeRemotePtyHost } from './remote/runtimeRemotePtyHost'
import { runtimeRemoteLaunchHost } from './remote/runtimeRemoteLaunchHost'
import { runtimeRemoteWorkspaceHost } from './remote/runtimeRemoteWorkspaceHost'


// E2E/开发：隔离 userData，保证 stats/主题等持久化断言从干净状态出发。
// 必须在 app ready 之前调用。
registerWindowsAppUserModelId()
const userDataOverride = process.env['HRACK_USER_DATA_DIR']
if (userDataOverride) {
  app.setPath('userData', userDataOverride)
} else {
  const userDataDir = resolveHrackUserDataDir(
    app.getPath('appData'),
    app.isPackaged
  )
  mkdirSync(userDataDir, { recursive: true })
  app.setPath('userData', userDataDir)
}
registerFloatingRendererScheme()
// 事件提示音在后台/非聚焦时也可能触发；允许无手势自动播放。
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')

const cliArgv = extractHrackCliArgv(process.argv)
if (cliArgv) {
  void runHrackCli(cliArgv, {
    stdout: process.stdout,
    stderr: process.stderr,
    userDataDir: app.getPath('userData')
  }).then((code) => app.exit(code))
}

const isPrimaryInstance = cliArgv ? false : app.requestSingleInstanceLock()

const manager = new PTYManager()
const cliDiscovery = new AiCliDiscoveryService(
  join(app.getPath('userData'), 'ai-cli-scan.json')
)
const eventLog = new EventLog()
let floatingController: FloatingWindowController | null = null
const broadcastToAllWindows = (channel: string, payload: unknown): void => {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.webContents.isDestroyed()) {
      win.webContents.send(channel, payload)
    }
  }
}
const broadcastAgentChannel = (channel: string, payload: unknown): void => {
  if (isAgentProjectionChannel(channel, payload)) {
    floatingController?.publishProjection(payload)
  }
  broadcastToAllWindows(channel, payload)
}
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
observerRegistry.register(new GrokObserverAdapter())
observerRegistry.register(new FixtureObserverAdapter())
const agentRuntime = new AgentSessionRuntime({
  pty: manager,
  discovery: cliDiscovery,
  history: eventLog,
  registry: observerRegistry,
  workspace: workspaceReader,
  options: {
    runDirRoot: join(app.getPath('userData'), 'observer-runs'),
    broadcast: broadcastAgentChannel
  }
})
// DSH host：只启动扫描到的本机 / WSL 安装；懒启动并随 app 退出回收。
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
  broadcast: broadcastAgentChannel
})
const dshProjector = new DshSessionProjector(dshHost, dshProjections)
const dshWire = new DshWireProxy(dshHost, broadcastToAllWindows)
let shutdownStarted = false
let winRef: BrowserWindow | null = null
let shutdownPromise: Promise<void> | null = null
const pendingBridgeLaunches = new Map<string, (error: string | null) => void>()
const bridgeState = BridgeStateStore.inUserData(app.getPath('userData'))
const controlPlane = new OpenCodeControlPlane({
  discovery: cliDiscovery,
  runtime: agentRuntime,
  state: bridgeState,
  requireForegroundWindow: () => {
    const win = winRef && !winRef.isDestroyed() ? winRef : null
    if (!win) {
      throw BridgeError.unavailable('HRack window is not available')
    }
    if (!raiseMainWindow(win)) {
      throw BridgeError.unavailable(
        'Open the HRack window first (tray-only is not enough)'
      )
    }
  },
  launchVisible: async (request: BridgeLaunchRequest) => {
    const win = winRef && !winRef.isDestroyed() ? winRef : null
    if (!win || win.webContents.isDestroyed()) {
      return 'HRack window is not available'
    }
    if (!raiseMainWindow(win)) {
      return 'Open the HRack window first (tray-only is not enough)'
    }
    try {
      const started = await agentRuntime.start({
        terminalId: request.terminalId,
        selection: request.selection,
        name: request.name,
        ...estimateTerminalSize(win)
      })
      win.webContents.send(AppEventChannel.BridgeLaunch, {
        ...request,
        ptyId: started.ptyId
      })
      return null
    } catch (error) {
      return error instanceof Error ? error.message : String(error)
    }
  }
})
const bridgeServer = new BridgeServer({
  userDataDir: app.getPath('userData'),
  plane: controlPlane
})

function completeBridgeLaunch(ack: BridgeLaunchAck): void {
  const pending = pendingBridgeLaunches.get(ack.requestId)
  if (!pending) return
  pendingBridgeLaunches.delete(ack.requestId)
  pending(ack.error)
}

const remoteClient = new RemoteDesktopClient({
  sessions: runtimeSessionSource(agentRuntime),
  broadcast: (state) =>
    broadcastToAllWindows(RemoteEventChannel.StateChanged, state),
  pty: runtimeRemotePtyHost(agentRuntime, manager),
  launch: runtimeRemoteLaunchHost(cliDiscovery, agentRuntime, (request) => {
    const win = winRef && !winRef.isDestroyed() ? winRef : null
    if (!win || win.webContents.isDestroyed()) return
    win.webContents.send(AppEventChannel.RemoteLaunch, request)
  }),
  workspace: runtimeRemoteWorkspaceHost(cliDiscovery),
  broadcastDrive: (state) =>
    broadcastToAllWindows(RemoteEventChannel.DriveChanged, state)
})

const updateService = new UpdateService({
  enabled: app.isPackaged && process.env['HRACK_DISABLE_UPDATES'] !== '1',
  currentVersion: packageMetadata.version,
  driver: new ElectronUpdaterDriver(),
  autoDownload: false,
  initialCheckDelayMs: 0,
  broadcast: (snapshot) =>
    broadcastToAllWindows(UpdateEventChannel.StateChanged, snapshot),
  beforeInstall: () => prepareShutdown()
})

function prepareShutdown(): Promise<void> {
  if (shutdownPromise) return shutdownPromise
  shutdownStarted = true
  markQuitting()
  updateService.dispose()
  shutdownPromise = (async () => {
    // Agent Runtime 先写入退出事实并回收 observer；随后兜底关闭普通终端。
    controlPlane.dispose()
    remoteClient.dispose()
    await bridgeServer.stop()
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
  })()
  return shutdownPromise
}

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
  raiseMainWindow(winRef)
}

function estimateTerminalSize(win: BrowserWindow): { cols: number; rows: number } {
  const [width, height] = win.getContentSize()
  const scale = win.webContents.getZoomFactor() || 1
  const innerWidth = Math.max(480, width - 248)
  const innerHeight = Math.max(320, height - 96)
  return {
    cols: Math.max(80, Math.min(320, Math.floor(innerWidth / (8.5 * scale)))),
    rows: Math.max(24, Math.min(90, Math.floor(innerHeight / (17.5 * scale))))
  }
}

function raiseMainWindow(win: BrowserWindow): boolean {
  if (win.isDestroyed()) return false
  if (win.isMinimized()) win.restore()
  win.show()
  if (process.platform === 'win32') {
    try {
      win.setAlwaysOnTop(true)
      win.moveTop()
      win.focus()
      win.setAlwaysOnTop(false)
    } catch {
      win.focus()
    }
    app.focus({ steal: true })
  } else {
    win.focus()
  }
  return win.isVisible()
}

if (!cliArgv && !isPrimaryInstance) {
  app.quit()
} else if (isPrimaryInstance) {
  app.on('second-instance', showWindow)
}

if (isPrimaryInstance) app.whenReady().then(async () => {
  // M0 验收：抵达此行即证明 node-pty 已按 Electron ABI 成功加载
  console.log('[hrack] app ready; node-pty loaded against Electron ABI OK')
  try {
    mkdirSync(join(app.getPath('userData'), 'logs'), { recursive: true })
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
    updateService,
    remoteClient,
    getDshSurfaceController: () => dshSurfaceController,
    getWindow: () => (winRef && !winRef.isDestroyed() ? winRef : null),
    getTray: () => trayRef,
    getFloatingWindowController: () => floatingController,
    rebuildTrayMenu: () => {
      if (trayRef) rebuildTrayMenu(trayRef, getMainPrefs().language, trayCallbacks)
    },
    completeBridgeLaunch
  }

  registerIpc(manager, ctx)
  // 启动即开始自动检查更新，不依赖窗口/设置页/托盘初始化完成。
  updateService.startAutomaticChecks()
  try {
    await bridgeServer.start()
  } catch (error) {
    // Official and Dev share \\.\pipe\hrack-bridge-<user>. A busy pipe must
    // not block the window — skip-approval / TUI still work without the bridge.
    console.warn('[hrack] bridge listen failed; continuing without it', error)
  }
  winRef = createWindow(prefs)
  attachDshSurface(winRef)
  floatingController = new ElectronFloatingWindowController({
    getMainWindow: () =>
      winRef && !winRef.isDestroyed() ? winRef : null,
    listActiveSessions: () => [
      ...agentRuntime.listActive(),
      ...dshProjections.listActive()
    ],
    renderersDirectory: join(
      app.getPath('userData'),
      'floating-renderers'
    ),
    builtinRendererRoot: join(__dirname, '../renderer'),
    builtinLive2dRoot: join(
      __dirname,
      '../../resources/floating-renderers/live2d-mao'
    )
  })
  await floatingController.setEnabled(prefs.floatingWindowEnabled)
  trayRef = createTray(prefs.language, trayCallbacks)
  if (prefs.globalShortcutEnabled) {
    registerGlobalShortcut(winRef)
  }
  startThemeWatcher()

  // E2E：主进程调试钩子（托盘菜单点击 / 快捷键注册状态无法从 renderer 注入）。
  if (process.env['HRACK_E2E']) {
    ;(globalThis as Record<string, unknown>)['__hrackMainDebug'] = {
      hasTray: () => Boolean(trayRef),
      isWindowVisible: () => Boolean(winRef && !winRef.isDestroyed() && winRef.isVisible()),
      isWindowDestroyed: () => Boolean(winRef?.isDestroyed()),
      isShortcutRegistered: () => isGlobalShortcutRegistered(),
      forceUpdateAvailable: (version: unknown, releaseNotes: unknown) => {
        if (typeof version !== 'string' || !version.trim()) return false
        updateService.debugSetAvailable(
          version.trim(),
          typeof releaseNotes === 'string' ? releaseNotes : null
        )
        return true
      },
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
        dshSurfaceController?.selectSessionForTest(sessionId) ?? false,
      floatingWindowInspect: () => floatingController?.inspect() ?? null,
      floatingWindowSetEnabled: (enabled: unknown) =>
        typeof enabled === 'boolean'
          ? floatingController?.setEnabled(enabled) ?? null
          : null,
      floatingWindowSetRenderer: (rendererId: unknown) =>
        typeof rendererId === 'string'
          ? floatingController?.setRenderer(rendererId) ?? null
          : null,
      floatingWindowRefreshRenderers: () =>
        floatingController?.refreshRenderers() ?? null,
      floatingWindowPublishProjection: (projection: unknown) => {
        if (
          projection &&
          typeof projection === 'object' &&
          typeof (projection as { sessionId?: unknown }).sessionId === 'string'
        ) {
          floatingController?.publishProjection(
            projection as Parameters<
              FloatingWindowController['publishProjection']
            >[0]
          )
          return true
        }
        return false
      }
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
  void prepareShutdown().then(() => app.quit())
})
