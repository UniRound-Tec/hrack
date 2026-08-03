import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState
} from 'react'
import { AnimatePresence, motion } from 'motion/react'
import type { CliScanReport, ShellOption } from '../../shared/ipc-contract'
import TitleBar from './TitleBar'
import Sidebar from './Sidebar'
import IconRail from './IconRail'
import TopTabBar from './TopTabBar'
import TerminalPage from './TerminalPage'
import HomePage from './HomePage'
import SettingsPage from './SettingsPage'
import NewSessionFlow from './NewSessionFlow'
import TargetCursor from './effects/TargetCursor'
import SidebarTint from './SidebarTint'
import {
  isPageId,
  terminalIdFromPage,
  terminalPage,
  type PageId
} from './pages'
import {
  handleShellShortcut,
  registerShellShortcutActions
} from './shellShortcuts'
import { useStrings } from './i18n'
import {
  buildCliLaunchSelection,
  findDefaultShell,
  type CliLaunchDraft,
  type CliOption
} from './launchOptions'
import { useSettingsStore, type NavMode } from '../state/settingsStore'
import {
  useSessionsStore,
  type SessionEntry
} from '../state/sessionsStore'
import { useAgentEventsStore } from '../state/agentEventsStore'
import { useTerminalsStore } from '../state/terminalsStore'

export interface VibingDebugShellApi {
  navigate(pageId: PageId): void
  openNewSession(): void
  setNavMode(mode: NavMode): void
}

interface PendingCliLaunch {
  draft: CliLaunchDraft
  previousPage: PageId
  resolve: (error: string | null) => void
}

export default function AppShell() {
  const [pageId, setPageId] = useState<PageId>('home')
  const [newSessionOpen, setNewSessionOpen] = useState(false)
  const [newSessionIntent, setNewSessionIntent] = useState<
    'sheet' | 'terminal' | CliOption
  >('sheet')
  const [shells, setShells] = useState<readonly ShellOption[]>([])
  const [cliReport, setCliReport] = useState<CliScanReport | null>(null)
  const [cliScanning, setCliScanning] = useState(true)
  const [cliScanError, setCliScanError] = useState<string | null>(null)
  const pendingCliLaunches = useRef(new Map<string, PendingCliLaunch>())
  const navMode = useSettingsStore((state) => state.navMode)
  const setNavMode = useSettingsStore((state) => state.setNavMode)
  const terminalRounded = useSettingsStore((state) => state.terminalRounded)
  const defaultTerminal = useSettingsStore((state) => state.defaultTerminal)
  const setDefaultTerminal = useSettingsStore(
    (state) => state.setDefaultTerminal
  )
  const sessions = useSessionsStore((state) => state.sessions)
  const removeSession = useSessionsStore((state) => state.removeSession)
  const updateSession = useSessionsStore((state) => state.updateSession)
  const terminals = useTerminalsStore((state) => state.terminals)
  const addTerminal = useTerminalsStore((state) => state.addTerminal)
  const activateTerminal = useTerminalsStore(
    (state) => state.activateTerminal
  )
  const closeTerminal = useTerminalsStore((state) => state.closeTerminal)

  useEffect(() => {
    let cancelled = false
    void window.shellApi.listAvailable().then((available) => {
      if (!cancelled) setShells(available)
    })
    return () => {
      cancelled = true
    }
  }, [])

  const scanClis = useCallback(async (force = false): Promise<void> => {
    setCliScanning(true)
    setCliScanError(null)
    try {
      setCliReport(await window.cliApi.scan(force))
    } catch (error) {
      setCliScanError(error instanceof Error ? error.message : String(error))
    } finally {
      setCliScanning(false)
    }
  }, [])

  useEffect(() => {
    void scanClis(false)
  }, [scanClis])

  const terminalIds = useMemo(
    () => new Set(terminals.map((terminal) => terminal.id)),
    [terminals]
  )
  const standaloneTerminals = useMemo(() => {
    const sessionTerminalIds = new Set(
      sessions.map((session) => session.terminalId)
    )
    return terminals.filter(
      (terminal) => !sessionTerminalIds.has(terminal.id)
    )
  }, [sessions, terminals])
  const activeTerminalId = terminalIdFromPage(pageId)

  const navigate = useCallback(
    (nextPage: PageId): void => {
      const terminalId = terminalIdFromPage(nextPage)
      if (terminalId && terminalIds.has(terminalId)) {
        activateTerminal(terminalId)
      }
      setPageId(nextPage)
    },
    [activateTerminal, terminalIds]
  )

  const openNewSession = useCallback((): void => {
    setNewSessionIntent('sheet')
    setNewSessionOpen(true)
  }, [])

  // 托盘「新建会话」菜单：与 Ctrl+Shift+T 同路径。
  useEffect(() => {
    return window.appApi.onOpenNewSession(openNewSession)
  }, [openNewSession])

  const launchTerminal = useCallback(
    (shell: ShellOption, remember = false): void => {
      if (remember) setDefaultTerminal(shell.id)
      const terminal = addTerminal({
        shellId: shell.id,
        launch: {
          kind: 'shell',
          shell: {
            shell: shell.shell,
            args: shell.args
          }
        }
      })
      setNewSessionOpen(false)
      setPageId(terminalPage(terminal.id))
    },
    [addTerminal, setDefaultTerminal]
  )

  const launchDefaultTerminal = useCallback((): void => {
    const shell = findDefaultShell(shells, defaultTerminal)
    if (shell) launchTerminal(shell)
  }, [defaultTerminal, launchTerminal, shells])

  // S1：AI CLI 启动编排在主进程 AgentSessionRuntime 完成；renderer 只建立
  // provisional terminal 并保存 CliLaunchSelection，TerminalView fit 后调用
  // agent:start。会话展示副本由主进程 projection 广播 upsert，不再本地推导。
  const launchCli = useCallback(
    async (draft: CliLaunchDraft): Promise<string | null> => {
      const name = draft.name.trim() || draft.option.definition.displayName
      const terminal = addTerminal({
        shellId: draft.option.definition.adapterId,
        cwd: draft.workspace.trim(),
        launch: {
          kind: 'agent',
          selection: buildCliLaunchSelection(draft),
          name
        }
      })
      setPageId(terminalPage(terminal.id))
      return new Promise<string | null>((resolve) => {
        pendingCliLaunches.current.set(terminal.id, {
          draft,
          previousPage: pageId,
          resolve
        })
      })
    },
    [addTerminal, pageId]
  )

  // S1：主进程投影是权威状态；renderer 只 upsert 展示副本。
  // reload 后先 listActive 恢复，再订阅增量；Runtime 保持权威状态。
  useEffect(() => {
    let cancelled = false
    const unsubscribeProjection = window.agentApi.onProjection((projection) => {
      useSessionsStore.getState().applyProjection(projection)
    })
    const unsubscribeEvents = window.agentApi.onEvents((events) => {
      useAgentEventsStore.getState().record(events)
    })
    void window.agentApi.listActive().then((projections) => {
      if (cancelled) return
      for (const projection of projections) {
        useSessionsStore.getState().applyProjection(projection)
      }
    })
    return () => {
      cancelled = true
      unsubscribeProjection()
      unsubscribeEvents()
    }
  }, [])

  const handleInitialTerminalSpawn = useCallback(
    (terminalId: string, error: string | null): void => {
      const pending = pendingCliLaunches.current.get(terminalId)
      if (!pending) return
      pendingCliLaunches.current.delete(terminalId)

      if (error) {
        closeTerminal(terminalId)
        const previousTerminalId = terminalIdFromPage(pending.previousPage)
        const previousPageStillExists = !previousTerminalId ||
          useTerminalsStore.getState().terminals.some(
            (terminal) => terminal.id === previousTerminalId
          )
        setPageId(previousPageStillExists ? pending.previousPage : 'home')
        pending.resolve(error)
        return
      }

      // 成功路径：会话条目由主进程 session.started 投影创建，无需本地 addSession。
      setNewSessionOpen(false)
      setPageId(terminalPage(terminalId))
      pending.resolve(null)
    },
    [closeTerminal]
  )

  const configureCli = useCallback((option: CliOption): void => {
    setNewSessionIntent(option)
    setNewSessionOpen(true)
  }, [])

  const closeTerminalAndRoute = useCallback(
    (terminalId: string): void => {
      const wasActive = terminalIdFromPage(pageId) === terminalId
      closeTerminal(terminalId)

      const linkedSessionIds = useSessionsStore
        .getState()
        .sessions.filter((session) => session.terminalId === terminalId)
        .map((session) => session.sessionId)
      useSessionsStore.getState().removeSessions(linkedSessionIds)

      if (!wasActive) return
      const nextTerminalId = useTerminalsStore.getState().activeTerminalId
      setPageId(nextTerminalId ? terminalPage(nextTerminalId) : 'home')
    },
    [closeTerminal, pageId]
  )

  const closeSessionAndTerminal = useCallback(
    (session: SessionEntry): void => {
      // 主进程权威清理（幂等）；renderer 墓碑保证迟到的退出投影不复活会话。
      void window.agentApi.stop(session.sessionId)
      removeSession(session.sessionId)
      if (terminalIds.has(session.terminalId)) {
        closeTerminalAndRoute(session.terminalId)
      } else if (activeTerminalId === session.terminalId) {
        setPageId('home')
      }
    },
    [
      activeTerminalId,
      closeTerminalAndRoute,
      removeSession,
      terminalIds
    ]
  )

  useEffect(() => {
    const unregister = registerShellShortcutActions({
      openNewSession,
      closeActiveTerminal: () => {
        const terminalId = terminalIdFromPage(pageId)
        if (!terminalId || !terminalIds.has(terminalId)) return false
        closeTerminalAndRoute(terminalId)
        return true
      },
      activateRelativeTerminal: (delta) => {
        const state = useTerminalsStore.getState()
        if (state.terminals.length < 2) return false
        const currentId = terminalIdFromPage(pageId)
        const currentIndex = state.terminals.findIndex(
          (terminal) => terminal.id === currentId
        )
        if (currentIndex < 0) return false
        const nextIndex =
          (currentIndex + delta + state.terminals.length) %
          state.terminals.length
        navigate(terminalPage(state.terminals[nextIndex].id))
        return true
      }
    })

    const handleWindowKeyDown = (event: KeyboardEvent): void => {
      const target = event.target
      if (target instanceof Element && target.closest('.xterm')) return
      handleShellShortcut(event)
    }
    window.addEventListener('keydown', handleWindowKeyDown)
    return () => {
      unregister()
      window.removeEventListener('keydown', handleWindowKeyDown)
    }
  }, [
    closeTerminalAndRoute,
    navigate,
    openNewSession,
    pageId,
    terminalIds
  ])

  useEffect(() => {
    if (!import.meta.env.DEV && !window.__VIBING_E2E__) return
    const api: VibingDebugShellApi = {
      navigate: (nextPage) => {
        if (isPageId(nextPage)) navigate(nextPage)
      },
      openNewSession,
      setNavMode
    }
    window.__vibingDebugShell = api
    return () => {
      if (window.__vibingDebugShell === api) {
        delete window.__vibingDebugShell
      }
    }
  }, [navigate, openNewSession, setNavMode])

  // 侧栏 ↔ 图标栏共用一个容器：容器只动宽度，内容层交叉淡入淡出。
  // 不能给两种形态各建一个带退出动画的元素——退出层会叠在进入层上产生重影。
  const sideNavigation =
    navMode !== 'tabs' ? (
      <motion.div
        key="sidenav"
        className="relative shrink-0 overflow-hidden"
        initial={{ width: 0 }}
        animate={{ width: navMode === 'sidebar' ? 280 : 48 }}
        exit={{ width: 0 }}
        transition={{ type: 'spring', stiffness: 420, damping: 38 }}
      >
        <AnimatePresence initial={false} mode="wait">
          {navMode === 'sidebar' ? (
            <motion.div
              key="sidebar"
              className="absolute inset-y-0 left-0 flex"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.12 }}
            >
              <Sidebar
                pageId={pageId}
                sessions={sessions}
                terminals={standaloneTerminals}
                onNavigate={navigate}
                onOpenNewSession={openNewSession}
                onCollapse={() => setNavMode('rail')}
                onRenameSession={(sessionId, name) =>
                  updateSession(sessionId, { name })
                }
                onCloseSession={closeSessionAndTerminal}
                onCloseTerminal={closeTerminalAndRoute}
              />
            </motion.div>
          ) : (
            <motion.div
              key="rail"
              className="absolute inset-y-0 left-0 flex"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.12 }}
            >
              <IconRail
                pageId={pageId}
                sessions={sessions}
                terminals={standaloneTerminals}
                onNavigate={navigate}
                onOpenNewSession={openNewSession}
                onExpand={() => setNavMode('sidebar')}
              />
            </motion.div>
          )}
        </AnimatePresence>
      </motion.div>
    ) : null

  return (
    <div className="app-shell isolate relative flex h-full w-full flex-col overflow-hidden">
      {/* 环境渐变垫在全部镶边（标题栏/侧栏/圆角缺口）下面；内容面板不透明底色自然盖住自己的区域 */}
      <SidebarTint />
      <TitleBar
        onNew={openNewSession}
        onSettings={() => navigate('settings')}
        settingsActive={pageId === 'settings'}
      />

      <div className="relative flex min-h-0 flex-1">
        {/* 默认 sync 模式：退出的侧栏容器留在文档流里收缩到 0，主内容跟随过渡 */}
        <AnimatePresence initial={false}>
          {sideNavigation}
        </AnimatePresence>

        <main
          data-testid="app-content"
          className={`relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-content ${
            // 圆角开关关闭时，终端页贴边直角显示；其余页面保留内容区圆角
            terminalRounded || !activeTerminalId ? 'rounded-tl-[20px]' : ''
          }`}
        >
          {navMode === 'tabs' && (
            <TopTabBar
              pageId={pageId}
              sessions={sessions}
              terminals={standaloneTerminals}
              onNavigate={navigate}
              onOpenNewSession={openNewSession}
              onCloseSession={closeSessionAndTerminal}
              onCloseTerminal={closeTerminalAndRoute}
            />
          )}

          <div className="relative min-h-0 flex-1 overflow-hidden">
            {pageId === 'home' && (
              <HomePage
                sessions={sessions}
                shells={shells}
                clis={cliReport?.launchable ?? []}
                cliScanning={cliScanning}
                defaultTerminal={defaultTerminal}
                onLaunchDefaultTerminal={launchDefaultTerminal}
                onChooseTerminal={() => {
                  setNewSessionIntent('terminal')
                  setNewSessionOpen(true)
                }}
                onConfigureCli={configureCli}
                onRefreshClis={() => void scanClis(true)}
                onViewSession={(session) =>
                  navigate(terminalPage(session.terminalId))
                }
              />
            )}
            {pageId === 'settings' && (
              <SettingsPage
                shells={shells}
                cliCount={cliReport?.launchable.length ?? 0}
                cliScanning={cliScanning}
                cliScanError={cliScanError}
                cliRuntimeErrors={cliReport?.runtimeErrors ?? []}
                onRefreshClis={() => void scanClis(true)}
              />
            )}
            {activeTerminalId && !terminalIds.has(activeTerminalId) && (
              <UnavailableTerminalPage />
            )}
            {terminals.map((terminal) => (
              <TerminalPage
                key={terminal.id}
                terminal={terminal}
                active={activeTerminalId === terminal.id}
                onInitialSpawn={handleInitialTerminalSpawn}
              />
            ))}
          </div>
        </main>
      </div>

      {!activeTerminalId && (
        <TargetCursor
          showCursor={false}
          hideDefaultCursor={false}
          spinDuration={2}
          parallaxOn
          hoverDuration={0.2}
          cursorColor="var(--vib-accent-cursor)"
          cursorColorOnTarget="var(--vib-accent-target)"
        />
      )}

      <NewSessionFlow
        open={newSessionOpen}
        shells={shells}
        clis={cliReport?.launchable ?? []}
        defaultTerminal={defaultTerminal}
        initialCli={
          typeof newSessionIntent === 'object' ? newSessionIntent : undefined
        }
        initialTerminalPicker={newSessionIntent === 'terminal'}
        onClose={() => {
          setNewSessionOpen(false)
          setNewSessionIntent('sheet')
        }}
        onLaunchTerminal={launchTerminal}
        onLaunchCli={launchCli}
      />
    </div>
  )
}

function UnavailableTerminalPage() {
  const strings = useStrings()
  return (
    <section
      data-testid="unavailable-terminal-page"
      className="flex h-full items-center justify-center px-8 text-center font-pingfang text-[12px] text-text-muted"
    >
      {strings.shell.unavailableTerminal}
    </section>
  )
}
