import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import type { CliScanReport, ShellOption } from '../../shared/ipc-contract'
import type { AgentEvent } from '../../shared/agent-events'
import TitleBar from './TitleBar'
import Sidebar from './Sidebar'
import IconRail from './IconRail'
import TopTabBar from './TopTabBar'
import TerminalPage from './TerminalPage'
import HomePage from './HomePage'
import SettingsPage from './SettingsPage'
import DshPage from './DshPage'
import DshLobbyPage from './DshLobbyPage'
import NewSessionFlow from './NewSessionFlow'
import CloseSessionDialog from './CloseSessionDialog'
import TargetCursor from './effects/TargetCursor'
import SidebarTint from './SidebarTint'
import {
  dshSessionIdFromPage,
  dshSessionPage,
  isPageId,
  sessionPage,
  terminalIdFromPage,
  terminalPage,
  type PageId
} from './pages'
import { closeVisibleDshSession, refreshDshSessions, renameVisibleDshSession } from '../dsh/sessionSync'
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
import { useSessionsStore, type SessionEntry } from '../state/sessionsStore'
import { useAgentEventsStore } from '../state/agentEventsStore'
import { useTerminalsStore } from '../state/terminalsStore'
import { useWorkspaceReaderStore } from '../workspace-reader/workspaceReaderStore'
import { planChildTerminal } from './childTerminal'
import { projectSessionNavigation } from '../session-navigation/sessionNavigation'
import { useSessionNavigationStore } from '../session-navigation/sessionNavigationStore'

export interface VibingDebugShellApi {
  navigate(pageId: PageId): void
  openNewSession(): void
  setNavMode(mode: NavMode): void
  agentEvents(): AgentEvent[]
  agentSessions(): SessionEntry[]
}

interface PendingCliLaunch {
  draft: CliLaunchDraft
  previousPage: PageId
  resolve: (error: string | null) => void
}

export default function AppShell() {
  const [pageId, setPageId] = useState<PageId>('home')
  const [newSessionOpen, setNewSessionOpen] = useState(false)
  const [pendingCloseSession, setPendingCloseSession] =
    useState<SessionEntry | null>(null)
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
  const sessionNavigation = useSessionNavigationStore(
    (state) => state.snapshot
  )
  const sessionNavigationRecoveryComplete = useSessionNavigationStore(
    (state) => state.recoveryComplete
  )
  const navigationSessions = useMemo(
    () => projectSessionNavigation(sessionNavigation, sessions),
    [sessionNavigation, sessions]
  )
  const removeSession = useSessionsStore((state) => state.removeSession)
  const updateSession = useSessionsStore((state) => state.updateSession)
  const terminals = useTerminalsStore((state) => state.terminals)
  const addTerminal = useTerminalsStore((state) => state.addTerminal)
  const restoreTerminals = useTerminalsStore((state) => state.restoreTerminals)
  const activateTerminal = useTerminalsStore((state) => state.activateTerminal)
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
  const nonSessionTerminals = useMemo(() => {
    const sessionTerminalIds = new Set(
      sessions.map((session) => session.terminalId)
    )
    return terminals.filter((terminal) => !sessionTerminalIds.has(terminal.id))
  }, [sessions, terminals])
  const standaloneTerminals = useMemo(
    () => nonSessionTerminals.filter((terminal) => !terminal.parentSessionId),
    [nonSessionTerminals]
  )
  const childTerminals = useMemo(
    () => nonSessionTerminals.filter((terminal) => terminal.parentSessionId),
    [nonSessionTerminals]
  )
  const activeTerminalId = terminalIdFromPage(pageId)
  const activeDshSessionId = dshSessionIdFromPage(pageId)
  const activeReaderTerminal = activeTerminalId
    ? (terminals.find((terminal) => terminal.id === activeTerminalId) ?? null)
    : null
  const activeHasWorkspace =
    Boolean(activeReaderTerminal?.cwd) &&
    sessions.some((session) => session.terminalId === activeTerminalId)
  const activeReaderOpen = useWorkspaceReaderStore((state) =>
    activeTerminalId ? (state.sessions[activeTerminalId]?.open ?? false) : false
  )
  const setReaderOpen = useWorkspaceReaderStore((state) => state.setOpen)

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

  useEffect(() => {
    return window.appApi.onFocusSession(({ sessionId, terminalId }) => {
      const session = useSessionsStore
        .getState()
        .sessions.find((item) => item.sessionId === sessionId)
      if (session) {
        navigate(sessionPage(session))
        return
      }
      if (
        useTerminalsStore
          .getState()
          .terminals.some((terminal) => terminal.id === terminalId)
      ) {
        navigate(terminalPage(terminalId))
      } else {
        navigate('home')
      }
    })
  }, [navigate])

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

  const renameSession = useCallback(
    (sessionId: string, name: string): void => {
      const session = useSessionsStore
        .getState()
        .sessions.find((item) => item.sessionId === sessionId)
      if (session?.kind === 'dsh') {
        void renameVisibleDshSession(sessionId, name).catch(() => {
          updateSession(sessionId, { name })
        })
        return
      }
      updateSession(sessionId, { name })
      void window.agentApi.rename(sessionId, name).then((projection) => {
        if (projection) {
          useSessionsStore.getState().applyProjection(projection)
        }
      })
    },
    [updateSession]
  )

  const cloneSession = useCallback(
    (session: SessionEntry): void => {
      if (session.kind === 'dsh') return
      const source = useTerminalsStore
        .getState()
        .terminals.find((terminal) => terminal.id === session.terminalId)
      if (!source?.agentSelection) return

      const selection = {
        ...source.agentSelection,
        args: [...source.agentSelection.args]
      }
      const terminal = addTerminal({
        shellId: source.shellId,
        cwd: selection.workspace,
        launch: {
          kind: 'agent',
          selection,
          name: session.name
        }
      })
      setPageId(terminalPage(terminal.id))
    },
    [addTerminal]
  )

  const createChildTerminal = useCallback(
    async (session: SessionEntry): Promise<void> => {
      if (session.kind === 'dsh' || !session.installationId) return
      try {
        const report = cliReport ?? (await window.cliApi.scan(false))
        if (!cliReport) setCliReport(report)
        const installation = report.launchable
          .flatMap((cli) => cli.installations)
          .find((candidate) => candidate.id === session.installationId)
        if (!installation) return

        const parent = useTerminalsStore
          .getState()
          .terminals.find((terminal) => terminal.id === session.terminalId)
        const workspace = parent?.cwd.trim()
        if (!workspace) return

        const availableShells =
          shells.length > 0 ? shells : await window.shellApi.listAvailable()
        const plan = planChildTerminal({
          runtime: installation.runtime,
          workspace,
          shells: availableShells,
          defaultShellId: defaultTerminal
        })
        if (!plan) return

        const terminal = addTerminal({
          shellId: plan.shellId,
          cwd: plan.cwd,
          parentSessionId: session.sessionId,
          launch: { kind: 'shell', shell: plan.shell }
        })
        setPageId(terminalPage(terminal.id))
      } catch {
        // Losing a runtime while creating the terminal leaves the session intact.
      }
    },
    [addTerminal, cliReport, defaultTerminal, shells]
  )

  // S1：AI CLI 启动编排在主进程 AgentSessionRuntime 完成；renderer 只建立
  // provisional terminal 并保存 CliLaunchSelection，TerminalView fit 后调用
  // agent:start。会话展示副本由主进程 projection 广播 upsert，不再本地推导。
  const launchCli = useCallback(
    async (draft: CliLaunchDraft): Promise<string | null> => {
      let workspace: string
      try {
        workspace = await window.cliApi.resolveWorkspace(
          draft.installationId,
          draft.workspace
        )
      } catch (error) {
        return error instanceof Error ? error.message : String(error)
      }
      const effectiveDraft = { ...draft, workspace }
      const name = draft.name.trim() || draft.option.definition.displayName
      const terminal = addTerminal({
        shellId: draft.option.definition.adapterId,
        cwd: workspace,
        launch: {
          kind: 'agent',
          selection: buildCliLaunchSelection(effectiveDraft),
          name
        }
      })
      setPageId(terminalPage(terminal.id))
      return new Promise<string | null>((resolve) => {
        pendingCliLaunches.current.set(terminal.id, {
          draft: effectiveDraft,
          previousPage: pageId,
          resolve
        })
      })
    },
    [addTerminal, pageId]
  )

  // 主进程同时持有 PTY 与 Agent projection。renderer reload 时先订阅
  // 增量，再恢复稳定 terminalId 和展示投影。没有可恢复 PTY 时保持
  // 真正的零实例空态；只有用户明确点击入口才创建进程。
  useEffect(() => {
    let cancelled = false
    const unsubscribeProjection = window.agentApi.onProjection((projection) => {
      const sessionsStore = useSessionsStore.getState()
      const previous = sessionsStore.sessions.find(
        (session) => session.sessionId === projection.sessionId
      )
      sessionsStore.applyProjection(projection)

      const navigation = useSessionNavigationStore.getState()
      if (!navigation.recoveryComplete) return
      const currentSessions = useSessionsStore.getState().sessions
      navigation.reconcile(
        currentSessions.map((session) => session.terminalId),
        true
      )
      if (
        !previous ||
        projection.lastSeq > (previous.projectionSeq ?? -1) ||
        projection.lastActivityAt > previous.lastActivityAt
      ) {
        useSessionNavigationStore.getState().dispatch(
          { kind: 'activity', terminalId: projection.terminalId },
          useSettingsStore.getState().attentionPriorityEnabled
        )
      }
    })
    const unsubscribeEvents = window.agentApi.onEvents((events) => {
      useAgentEventsStore.getState().record(events)
    })
    const unsubscribeDsh = window.dshApi.onStatusChanged((status) => {
      if (status.state === 'ready') void refreshDshSessions()
    })
    void Promise.all([
      window.ptyApi.listRecoverable(),
      window.agentApi.listActive(),
      window.dshApi.getStatus()
    ])
      .then(([recoverable, projections, dshStatus]) => {
        if (cancelled) return
        restoreTerminals(recoverable)
        for (const projection of projections) {
          useSessionsStore.getState().applyProjection(projection)
        }
        if (dshStatus.state === 'ready') void refreshDshSessions()
        useSessionNavigationStore.getState().reconcile(
          useSessionsStore
            .getState()
            .sessions.map((session) => session.terminalId),
          true
        )
      })
      .catch(() => {
        // 恢复失败也不能擅自创建进程；用户仍可从 Home / New Session 启动。
        useSessionNavigationStore.getState().reconcile(
          useSessionsStore
            .getState()
            .sessions.map((session) => session.terminalId),
          true
        )
      })
    return () => {
      cancelled = true
      unsubscribeProjection()
      unsubscribeEvents()
      unsubscribeDsh()
    }
  }, [restoreTerminals])

  useEffect(() => {
    if (!sessionNavigationRecoveryComplete) return
    useSessionNavigationStore
      .getState()
      .reconcile(
        sessions.map((session) => session.terminalId),
        true
      )
  }, [sessionNavigationRecoveryComplete, sessions])

  const handleInitialTerminalSpawn = useCallback(
    (terminalId: string, error: string | null): void => {
      const pending = pendingCliLaunches.current.get(terminalId)
      if (!pending) return
      pendingCliLaunches.current.delete(terminalId)

      if (error) {
        closeTerminal(terminalId)
        const previousTerminalId = terminalIdFromPage(pending.previousPage)
        const previousPageStillExists =
          !previousTerminalId ||
          useTerminalsStore
            .getState()
            .terminals.some((terminal) => terminal.id === previousTerminalId)
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
      const linkedSessionIds = useSessionsStore
        .getState()
        .sessions.filter((session) => session.terminalId === terminalId)
        .map((session) => session.sessionId)
      if (linkedSessionIds.length > 0) {
        void Promise.all(
          linkedSessionIds.map((sessionId) => window.agentApi.stop(sessionId))
        ).finally(() => window.ptyApi.killTerminal(terminalId))
      } else {
        void window.ptyApi.killTerminal(terminalId)
      }

      closeTerminal(terminalId)
      useSessionsStore.getState().removeSessions(linkedSessionIds)

      if (!wasActive) return
      const nextTerminalId = useTerminalsStore.getState().activeTerminalId
      setPageId(nextTerminalId ? terminalPage(nextTerminalId) : 'home')
    },
    [closeTerminal, pageId]
  )

  const closeSessionAndTerminal = useCallback(
    (session: SessionEntry): void => {
      if (session.kind === 'dsh') {
        const wasActive = dshSessionIdFromPage(pageId) === session.sessionId
        void closeVisibleDshSession(session.sessionId)
        if (wasActive) navigate('dsh:home')
        return
      }
      const children = useTerminalsStore
        .getState()
        .terminals.filter(
          (terminal) => terminal.parentSessionId === session.sessionId
        )
      const wasActive =
        activeTerminalId === session.terminalId ||
        children.some((terminal) => terminal.id === activeTerminalId)
      for (const child of children) {
        void window.ptyApi.killTerminal(child.id)
        closeTerminal(child.id)
      }

      if (terminalIds.has(session.terminalId)) {
        void window.agentApi
          .stop(session.sessionId)
          .finally(() => window.ptyApi.killTerminal(session.terminalId))
        closeTerminal(session.terminalId)
        removeSession(session.sessionId)
        if (wasActive) {
          const nextTerminalId = useTerminalsStore.getState().activeTerminalId
          setPageId(nextTerminalId ? terminalPage(nextTerminalId) : 'home')
        }
        return
      }

      // 极端竞态：Session projection 已到达，PTY 描述符尚未恢复。
      // 没有 TerminalEntry 时仍必须显式 stop，不能只删 UI。
      void window.agentApi.stop(session.sessionId)
      removeSession(session.sessionId)
      if (wasActive) {
        setPageId('home')
      }
    },
    [activeTerminalId, closeTerminal, navigate, pageId, removeSession, terminalIds]
  )

  const handleTerminalExit = useCallback(
    (terminalId: string): void => {
      const terminalsState = useTerminalsStore.getState()
      const terminal = terminalsState.terminals.find(
        (item) => item.id === terminalId
      )
      const linkedSessions = useSessionsStore
        .getState()
        .sessions.filter((session) => session.terminalId === terminalId)
      if (!terminal?.agentSelection && linkedSessions.length === 0) return

      pendingCliLaunches.current.delete(terminalId)
      const children = terminalsState.terminals.filter((item) =>
        linkedSessions.some(
          (session) => item.parentSessionId === session.sessionId
        )
      )
      const activePageTerminalId = terminalIdFromPage(pageId)
      const wasActive =
        activePageTerminalId === terminalId ||
        children.some((child) => child.id === activePageTerminalId)
      for (const child of children) {
        void window.ptyApi.killTerminal(child.id)
        closeTerminal(child.id)
      }

      // 进程已经自行退出，不再调用 agent:stop。这里只释放 PTYManager
      // 为回看输出保留的描述符，并用墓碑阻止迟到投影复活卡片。
      void window.ptyApi.killTerminal(terminalId)
      closeTerminal(terminalId)
      useSessionsStore
        .getState()
        .removeSessions(linkedSessions.map((session) => session.sessionId))
      setPendingCloseSession((pending) =>
        linkedSessions.some(
          (session) => session.sessionId === pending?.sessionId
        )
          ? null
          : pending
      )

      if (wasActive) {
        const nextTerminalId = useTerminalsStore.getState().activeTerminalId
        setPageId(nextTerminalId ? terminalPage(nextTerminalId) : 'home')
      }
    },
    [closeTerminal, pageId]
  )

  const requestCloseSession = useCallback((session: SessionEntry): void => {
    setPendingCloseSession(session)
  }, [])

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
  }, [closeTerminalAndRoute, navigate, openNewSession, pageId, terminalIds])

  useEffect(() => {
    if (!import.meta.env.DEV && !window.__VIBING_E2E__) return
    const api: VibingDebugShellApi = {
      navigate: (nextPage) => {
        if (isPageId(nextPage)) navigate(nextPage)
      },
      openNewSession,
      setNavMode,
      agentEvents: () => [...useAgentEventsStore.getState().events],
      agentSessions: () => [...useSessionsStore.getState().sessions]
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
                sessions={navigationSessions}
                terminals={standaloneTerminals}
                childTerminals={childTerminals}
                onNavigate={navigate}
                onOpenNewSession={openNewSession}
                onCollapse={() => setNavMode('rail')}
                onRenameSession={renameSession}
                onCloneSession={cloneSession}
                onCreateChildTerminal={(session) => {
                  void createChildTerminal(session)
                }}
                onCloseSession={requestCloseSession}
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
                sessions={navigationSessions}
                terminals={nonSessionTerminals}
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
    <div className="app-shell isolate relative flex h-full w-full select-none flex-col overflow-hidden">
      {/* 环境渐变垫在全部镶边（标题栏/侧栏/圆角缺口）下面；内容面板不透明底色自然盖住自己的区域 */}
      <SidebarTint />
      <TitleBar
        onNew={openNewSession}
        onSettings={() => navigate('settings')}
        settingsActive={pageId === 'settings'}
        onToggleCode={
          activeHasWorkspace && activeTerminalId
            ? () => setReaderOpen(activeTerminalId, !activeReaderOpen)
            : undefined
        }
        codeOpen={activeReaderOpen}
      />

      <div className="relative flex min-h-0 flex-1">
        {/* 默认 sync 模式：退出的侧栏容器留在文档流里收缩到 0，主内容跟随过渡 */}
        <AnimatePresence initial={false}>{sideNavigation}</AnimatePresence>

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
              sessions={navigationSessions}
              terminals={nonSessionTerminals}
              onNavigate={navigate}
              onOpenNewSession={openNewSession}
              onRenameSession={renameSession}
              onCloneSession={cloneSession}
              onCreateChildTerminal={(session) => {
                void createChildTerminal(session)
              }}
              onCloseSession={requestCloseSession}
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
                onViewSession={(session) => navigate(sessionPage(session))}
                onOpenDsh={() => navigate('dsh:home')}
              />
            )}
            {pageId === 'dsh:home' && (
              <DshLobbyPage
                onOpenSession={(sessionId) => navigate(dshSessionPage(sessionId))}
                onOpenSettings={() => navigate('settings')}
              />
            )}
            <DshPage
              sessionId={activeDshSessionId}
              visible={activeDshSessionId !== null}
            />
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
                onExit={handleTerminalExit}
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

      <AnimatePresence>
        {pendingCloseSession && (
          <CloseSessionDialog
            key={pendingCloseSession.sessionId}
            session={pendingCloseSession}
            onCancel={() => setPendingCloseSession(null)}
            onConfirm={() => {
              const session = pendingCloseSession
              setPendingCloseSession(null)
              closeSessionAndTerminal(session)
            }}
          />
        )}
      </AnimatePresence>
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
