import {
  useCallback,
  useEffect,
  useMemo,
  useState
} from 'react'
import { AnimatePresence, motion } from 'motion/react'
import type { ShellOption } from '../../shared/ipc-contract'
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
import {
  setRuntimeMockSessions
} from './mockSessions'
import { strings } from './strings'
import {
  buildCliLaunch,
  findDefaultShell,
  type CliLaunchDraft,
  type CliOption
} from './launchOptions'
import { useSettingsStore, type NavMode } from '../state/settingsStore'
import {
  useSessionsStore,
  type SessionEntry
} from '../state/sessionsStore'
import { useTerminalsStore } from '../state/terminalsStore'

export interface VibingDebugShellApi {
  navigate(pageId: PageId): void
  openNewSession(): void
  setNavMode(mode: NavMode): void
  setMockSessions(enabled: boolean): void
}

export default function AppShell() {
  const [pageId, setPageId] = useState<PageId>('home')
  const [newSessionOpen, setNewSessionOpen] = useState(false)
  const [newSessionIntent, setNewSessionIntent] = useState<
    'sheet' | 'terminal' | CliOption
  >('sheet')
  const [shells, setShells] = useState<readonly ShellOption[]>([])
  const navMode = useSettingsStore((state) => state.navMode)
  const setNavMode = useSettingsStore((state) => state.setNavMode)
  const terminalRounded = useSettingsStore((state) => state.terminalRounded)
  const defaultTerminal = useSettingsStore((state) => state.defaultTerminal)
  const setDefaultTerminal = useSettingsStore(
    (state) => state.setDefaultTerminal
  )
  const sessions = useSessionsStore((state) => state.sessions)
  const addSession = useSessionsStore((state) => state.addSession)
  const removeSession = useSessionsStore((state) => state.removeSession)
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

  const terminalIds = useMemo(
    () => new Set(terminals.map((terminal) => terminal.id)),
    [terminals]
  )
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

  const launchTerminal = useCallback(
    (shell: ShellOption, remember = false): void => {
      if (remember) setDefaultTerminal(shell.id)
      const terminal = addTerminal({
        shellId: shell.id,
        launch: {
          shell: shell.shell,
          args: shell.args
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

  const launchCli = useCallback(
    (draft: CliLaunchDraft): void => {
      const launch = buildCliLaunch(draft)
      const terminal = addTerminal({
        shellId: draft.option.adapterId,
        cwd: draft.workspace.trim(),
        launch
      })
      addSession({
        sessionId: crypto.randomUUID(),
        terminalId: terminal.id,
        adapterId: draft.option.adapterId,
        name: draft.name.trim() || draft.option.name,
        status: 'working',
        lastActivityAt: Date.now()
      })
      setNewSessionOpen(false)
      setPageId(terminalPage(terminal.id))
    },
    [addSession, addTerminal]
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
      setNavMode,
      setMockSessions: setRuntimeMockSessions
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
                terminals={terminals}
                onNavigate={navigate}
                onOpenNewSession={openNewSession}
                onCollapse={() => setNavMode('rail')}
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
                terminals={terminals}
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
              terminals={terminals}
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
                terminals={terminals}
                shells={shells}
                defaultTerminal={defaultTerminal}
                onLaunchDefaultTerminal={launchDefaultTerminal}
                onChooseTerminal={() => {
                  setNewSessionIntent('terminal')
                  setNewSessionOpen(true)
                }}
                onConfigureCli={configureCli}
                onViewSession={(session) =>
                  navigate(terminalPage(session.terminalId))
                }
              />
            )}
            {pageId === 'settings' && <SettingsPage shells={shells} />}
            {activeTerminalId && !terminalIds.has(activeTerminalId) && (
              <UnavailableTerminalPage />
            )}
            {terminals.map((terminal) => (
              <TerminalPage
                key={terminal.id}
                terminal={terminal}
                active={activeTerminalId === terminal.id}
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
  return (
    <section
      data-testid="unavailable-terminal-page"
      className="flex h-full items-center justify-center px-8 text-center font-pingfang text-[12px] text-text-muted"
    >
      {strings.shell.unavailableTerminal}
    </section>
  )
}
