import {
  useCallback,
  useEffect,
  useMemo,
  useState
} from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { Settings2, Terminal as TerminalIcon, X } from 'lucide-react'
import TitleBar from './TitleBar'
import Sidebar from './Sidebar'
import IconRail from './IconRail'
import TopTabBar from './TopTabBar'
import TerminalPage from './TerminalPage'
import TargetCursor from './effects/TargetCursor'
import ShinyText from './effects/ShinyText'
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
  const navMode = useSettingsStore((state) => state.navMode)
  const setNavMode = useSettingsStore((state) => state.setNavMode)
  const sessions = useSessionsStore((state) => state.sessions)
  const removeSession = useSessionsStore((state) => state.removeSession)
  const terminals = useTerminalsStore((state) => state.terminals)
  const addTerminal = useTerminalsStore((state) => state.addTerminal)
  const activateTerminal = useTerminalsStore(
    (state) => state.activateTerminal
  )
  const closeTerminal = useTerminalsStore((state) => state.closeTerminal)

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
    setNewSessionOpen(true)
  }, [])

  const openDefaultTerminal = useCallback((): void => {
    const terminal = addTerminal()
    setNewSessionOpen(false)
    setPageId(terminalPage(terminal.id))
  }, [addTerminal])

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

  const sideNavigation =
    navMode === 'sidebar' ? (
      <motion.div
        key="sidebar"
        className="flex shrink-0 overflow-hidden"
        initial={{ width: 48, opacity: 0.6 }}
        animate={{ width: 280, opacity: 1 }}
        exit={{ width: 48, opacity: 0.6 }}
        transition={{ type: 'spring', stiffness: 420, damping: 38 }}
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
    ) : navMode === 'rail' ? (
      <motion.div
        key="rail"
        className="flex shrink-0 overflow-hidden"
        initial={{ width: 48, opacity: 0.6 }}
        animate={{ width: 48, opacity: 1 }}
        exit={{ width: 48, opacity: 0.6 }}
        transition={{ duration: 0.16 }}
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
    ) : null

  return (
    <div className="app-shell relative flex h-full w-full flex-col overflow-hidden">
      <TitleBar
        onNew={openNewSession}
        onSettings={() => navigate('settings')}
        settingsActive={pageId === 'settings'}
      />

      <div className="relative flex min-h-0 flex-1">
        <AnimatePresence initial={false} mode="popLayout">
          {sideNavigation}
        </AnimatePresence>

        <main
          data-testid="app-content"
          className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-tl-[20px] bg-content"
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
            {pageId === 'home' && <HomeShellPage />}
            {pageId === 'settings' && (
              <SettingsShellPage navMode={navMode} onChange={setNavMode} />
            )}
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
          cursorColorOnTarget="var(--vib-accent-cursor)"
        />
      )}

      <AnimatePresence>
        {newSessionOpen && (
          <NewSessionShell
            onClose={() => setNewSessionOpen(false)}
            onOpenTerminal={openDefaultTerminal}
          />
        )}
      </AnimatePresence>
    </div>
  )
}

function HomeShellPage() {
  return (
    <section
      data-testid="home-page"
      className="flex h-full flex-col items-center justify-center px-8 py-14"
    >
      <p className="font-maple text-[10px] tracking-[0.28em] text-text-faint uppercase">
        {strings.shell.homeLabel}
      </p>
      <div className="mt-5">
        <ShinyText
          text="vibing"
          color="var(--vib-brand-logo)"
          shineColor="var(--vib-brand-logoShine)"
          speed={3.2}
          spread={100}
          className="font-ammonite text-[54px] leading-none tracking-[0.08em]"
        />
      </div>
      <h1 className="mt-6 font-pingfang text-[24px] font-semibold tracking-wide text-text-primary">
        {strings.shell.homeTitle}
      </h1>
      <p className="mt-2 max-w-md text-center font-pingfang text-[12px] text-text-muted">
        {strings.shell.homeHint}
      </p>
    </section>
  )
}

function SettingsShellPage({
  navMode,
  onChange
}: {
  navMode: NavMode
  onChange: (mode: NavMode) => void
}) {
  const options: readonly { id: NavMode; label: string }[] = [
    { id: 'sidebar', label: strings.settings.sidebar },
    { id: 'rail', label: strings.settings.rail },
    { id: 'tabs', label: strings.settings.tabs }
  ]
  return (
    <section
      data-testid="settings-page"
      className="sidebar-scroll h-full overflow-y-auto px-8 py-7"
    >
      <div className="mx-auto max-w-2xl">
        <div className="flex items-center gap-2">
          <Settings2 className="size-4 text-text-muted" strokeWidth={1.75} />
          <h1 className="font-pingfang text-[16px] font-semibold text-text-primary">
            {strings.settings.title}
          </h1>
        </div>
        <p className="mt-2 font-pingfang text-[11px] text-text-faint">
          {strings.shell.settingsHint}
        </p>
        <div className="mt-8 border-b border-border-subtle pb-2">
          <p className="font-maple text-[10px] tracking-[0.22em] text-text-faint uppercase">
            layout
          </p>
          <h2 className="mt-0.5 font-pingfang text-[13px] font-semibold text-text-secondary">
            {strings.settings.sections.layout}
          </h2>
        </div>
        <div className="flex items-center justify-between gap-6 py-4">
          <div>
            <p className="font-pingfang text-[12px] font-medium text-text-secondary">
              {strings.settings.navigationMode}
            </p>
            <p className="mt-0.5 font-pingfang text-[11px] text-text-faint">
              {strings.settings.navigationModeHint}
            </p>
          </div>
          <div className="flex items-center gap-0.5 rounded-lg bg-control p-0.5">
            {options.map((option) => (
              <button
                key={option.id}
                type="button"
                data-testid={`settings-nav-${option.id}`}
                aria-pressed={navMode === option.id}
                onClick={() => onChange(option.id)}
                className={`cursor-target rounded-md px-2.5 py-1 font-pingfang text-[11px] font-medium transition-colors ${
                  navMode === option.id
                    ? 'bg-control-active text-text-primary shadow-sm'
                    : 'text-text-muted hover:text-text-secondary'
                }`}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>
      </div>
    </section>
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

function NewSessionShell({
  onClose,
  onOpenTerminal
}: {
  onClose: () => void
  onOpenTerminal: () => void
}) {
  return (
    <motion.div
      data-testid="new-session-overlay"
      className="absolute inset-0 z-50 flex items-end bg-backdrop"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.16 }}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <motion.section
        className="shell-sheet w-full rounded-t-[20px] border border-border-default bg-surface px-6 py-5"
        initial={{ y: 56, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        exit={{ y: 56, opacity: 0 }}
        transition={{ type: 'spring', stiffness: 420, damping: 38 }}
      >
        <div className="mx-auto flex max-w-3xl items-start justify-between gap-4">
          <div>
            <h2 className="font-pingfang text-[15px] font-semibold text-text-primary">
              {strings.newSession.title}
            </h2>
            <p className="mt-1 font-pingfang text-[11px] text-text-faint">
              {strings.newSession.p2Placeholder}
            </p>
            <button
              type="button"
              data-testid="new-session-terminal"
              onClick={onOpenTerminal}
              className="cursor-target mt-4 flex w-64 items-center gap-3 rounded-xl border border-border-subtle bg-surface px-3 py-2.5 text-left transition-colors hover:bg-surface-hover"
            >
              <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-control text-text-secondary">
                <TerminalIcon className="size-4" strokeWidth={1.75} />
              </span>
              <span className="min-w-0">
                <span className="block font-pingfang text-[12px] font-semibold text-text-primary">
                  {strings.newSession.terminal}
                </span>
                <span className="mt-0.5 block font-pingfang text-[10px] text-text-faint">
                  {strings.newSession.quickTerminalHint}
                </span>
              </span>
            </button>
          </div>
          <button
            type="button"
            data-testid="new-session-close"
            aria-label={strings.common.close}
            title={strings.common.close}
            onClick={onClose}
            className="cursor-target flex size-8 items-center justify-center rounded-lg text-text-faint transition-colors hover:bg-control hover:text-text-secondary"
          >
            <X className="size-4" strokeWidth={1.75} />
          </button>
        </div>
      </motion.section>
    </motion.div>
  )
}
