import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  Check,
  Copy,
  Home,
  Pencil,
  Plus,
  SquareTerminal,
  Smartphone,
  Terminal as TerminalIcon,
  X
} from 'lucide-react'
import { getAdapterIcon } from './adapterIcons'
import {
  dshSlotIdFromPage,
  sessionPage,
  terminalIdFromPage,
  terminalPage,
  type PageId
} from './pages'
import { statusDot, statusLabel, statusTone } from './sessionStatus'
import { useStrings } from './i18n'
import type { SessionEntry } from '../state/sessionsStore'
import type { TerminalEntry } from '../state/terminalsStore'

interface TopTabBarProps {
  pageId: PageId
  sessions: readonly SessionEntry[]
  terminals: readonly TerminalEntry[]
  drivenSessionId: string | null
  onNavigate: (pageId: PageId) => void
  onOpenNewSession: () => void
  onRenameSession: (sessionId: string, name: string) => void
  onCloneSession: (session: SessionEntry) => void
  onCreateChildTerminal: (session: SessionEntry) => void
  onCloseSession: (session: SessionEntry) => void
  onCloseTerminal: (terminalId: string) => void
}

type HoveredTab =
  | { kind: 'session'; item: SessionEntry; left: number }
  | { kind: 'terminal'; item: TerminalEntry; left: number }

const tabButtonClass = (active: boolean): string =>
  [
    'cursor-target flex h-7 items-center gap-1.5 rounded-lg py-1 pl-2.5 font-pingfang text-[12px] transition-colors',
    active
      ? 'bg-surface text-text-primary shadow-sm'
      : 'text-text-muted hover:bg-control hover:text-text-secondary'
  ].join(' ')

const iconButtonClass = (active: boolean): string =>
  [
    'cursor-target flex size-7 shrink-0 items-center justify-center rounded-lg transition-colors',
    active
      ? 'bg-surface text-text-primary shadow-sm'
      : 'text-text-faint hover:bg-control hover:text-text-secondary'
  ].join(' ')

export default function TopTabBar({
  pageId,
  sessions,
  terminals,
  drivenSessionId,
  onNavigate,
  onOpenNewSession,
  onRenameSession,
  onCloneSession,
  onCreateChildTerminal,
  onCloseSession,
  onCloseTerminal
}: TopTabBarProps) {
  const strings = useStrings()
  const activeTerminalId = terminalIdFromPage(pageId)
  const activeDshSlotId = dshSlotIdFromPage(pageId)
  const barRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const [hovered, setHovered] = useState<HoveredTab | null>(null)
  const [sessionMenu, setSessionMenu] = useState<{
    sessionId: string
    top: number
    left: number
    mode: 'actions' | 'rename'
  } | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [renameError, setRenameError] = useState(false)
  const menuSession = sessions.find(
    (session) => session.sessionId === sessionMenu?.sessionId
  )

  const closeOrSaveSessionMenu = (): void => {
    if (sessionMenu?.mode !== 'rename' || !menuSession) {
      setSessionMenu(null)
      return
    }
    const name = renameValue.trim()
    if (!name) {
      setRenameError(true)
      return
    }
    onRenameSession(menuSession.sessionId, name)
    setRenameError(false)
    setSessionMenu(null)
  }

  useEffect(() => {
    if (!sessionMenu) return
    const handlePointerDown = (event: PointerEvent): void => {
      const target = event.target
      if (
        target instanceof Element &&
        target.closest('[data-toptab-session-actions-popover]')
      ) {
        return
      }
      closeOrSaveSessionMenu()
    }
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setSessionMenu(null)
    }
    window.addEventListener('pointerdown', handlePointerDown)
    window.addEventListener('keydown', handleKeyDown)
    return () => {
      window.removeEventListener('pointerdown', handlePointerDown)
      window.removeEventListener('keydown', handleKeyDown)
    }
  })

  const openSessionMenu = (
    session: SessionEntry,
    clientX: number,
    clientY: number
  ): void => {
    setHovered(null)
    setRenameError(false)
    setSessionMenu({
      sessionId: session.sessionId,
      top: Math.max(8, Math.min(clientY, window.innerHeight - 180)),
      left: Math.max(8, Math.min(clientX, window.innerWidth - 184)),
      mode: 'actions'
    })
  }

  // 纵向滚轮转横向滚动。React 在根节点上以 passive 注册 wheel，
  // preventDefault 会失效，所以这里直接挂原生非 passive 监听。
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const onWheel = (event: WheelEvent): void => {
      if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return
      if (el.scrollWidth <= el.clientWidth) return
      el.scrollLeft += event.deltaY
      event.preventDefault()
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  const popoverLeft = (target: HTMLElement): number => {
    const bar = barRef.current?.getBoundingClientRect()
    const rect = target.getBoundingClientRect()
    if (!bar) return 0
    return Math.max(8, Math.min(rect.left - bar.left, bar.width - 248))
  }

  return (
    <div
      ref={barRef}
      data-testid="top-tab-bar"
      className="relative z-30 flex shrink-0 items-center gap-1 border-b border-border-subtle bg-content px-3 py-1.5"
    >
      <button
        type="button"
        data-testid="toptab-home"
        title={strings.navigation.home}
        onClick={() => onNavigate('home')}
        className={iconButtonClass(pageId === 'home')}
      >
        <Home className="size-3.5" strokeWidth={1.75} />
      </button>

      <span className="mx-1 h-4 w-px shrink-0 bg-border-default" />

      <div className="top-tab-viewport min-w-0 flex-1">
        <div
          ref={scrollRef}
          data-testid="toptab-scroll"
          className="scrollbar-hidden flex min-w-0 items-center gap-1 overflow-x-auto py-0.5"
        >
          {sessions.map((session) => {
            const Icon = getAdapterIcon(session.adapterId)
            const active =
              session.kind === 'dsh'
                ? activeDshSlotId === session.sessionId
                : activeTerminalId === session.terminalId
            return (
              <div
                key={session.sessionId}
                className="group flex shrink-0 items-center rounded-lg"
                onContextMenu={(event) => {
                  event.preventDefault()
                  openSessionMenu(session, event.clientX, event.clientY)
                }}
                onMouseEnter={(event) =>
                  setHovered({
                    kind: 'session',
                    item: session,
                    left: popoverLeft(event.currentTarget)
                  })
                }
                onMouseLeave={() => setHovered(null)}
              >
                <button
                  type="button"
                  data-testid="toptab-session-item"
                  data-session-id={session.sessionId}
                  data-remote-driven={
                    drivenSessionId === session.sessionId ? 'true' : 'false'
                  }
                  aria-current={active ? 'page' : undefined}
                  onClick={() => onNavigate(sessionPage(session))}
                  className={`${tabButtonClass(active)} pr-1`}
                >
                  <span
                    className={`size-1.5 shrink-0 rounded-full ${statusDot[session.status]}`}
                  />
                  <Icon size={13} className="size-[13px] shrink-0" />
                  {drivenSessionId === session.sessionId && (
                    <Smartphone
                      aria-label={strings.terminal.remoteDriven}
                      className="size-3 shrink-0 text-brand"
                      strokeWidth={1.75}
                    />
                  )}
                  <span className="max-w-[96px] truncate">{session.name}</span>
                </button>
                <button
                  type="button"
                  data-testid="toptab-session-close"
                  aria-label={`${strings.navigation.closeSession}: ${session.name}`}
                  onClick={() => onCloseSession(session)}
                  className="cursor-target mr-1 flex size-5 items-center justify-center rounded text-text-faint opacity-0 transition-all group-hover:opacity-100 hover:bg-control hover:text-text-secondary focus:opacity-100"
                >
                  <X className="size-3" strokeWidth={1.75} />
                </button>
              </div>
            )
          })}

          {sessions.length > 0 && terminals.length > 0 && (
            <span className="mx-1 h-4 w-px shrink-0 bg-border-default" />
          )}

          {terminals.map((terminal) => {
            const active = activeTerminalId === terminal.id
            return (
              <div
                key={terminal.id}
                className="group flex shrink-0 items-center rounded-lg"
                onMouseEnter={(event) =>
                  setHovered({
                    kind: 'terminal',
                    item: terminal,
                    left: popoverLeft(event.currentTarget)
                  })
                }
                onMouseLeave={() => setHovered(null)}
              >
                <button
                  type="button"
                  data-testid="toptab-terminal-item"
                  data-terminal-id={terminal.id}
                  data-exited={terminal.exited}
                  aria-current={active ? 'page' : undefined}
                  onClick={() => onNavigate(terminalPage(terminal.id))}
                  className={`${tabButtonClass(active)} pr-1`}
                >
                  <TerminalIcon
                    className="size-3 shrink-0 text-text-muted"
                    strokeWidth={1.75}
                  />
                  <span className="max-w-[110px] truncate">
                    {terminal.name}
                  </span>
                </button>
                <button
                  type="button"
                  data-testid="toptab-terminal-close"
                  aria-label={`${strings.navigation.closeTerminal}: ${terminal.name}`}
                  onClick={() => onCloseTerminal(terminal.id)}
                  className="cursor-target mr-1 flex size-5 items-center justify-center rounded text-text-faint opacity-0 transition-all group-hover:opacity-100 hover:bg-control hover:text-text-secondary focus:opacity-100"
                >
                  <X className="size-3" strokeWidth={1.75} />
                </button>
              </div>
            )
          })}
        </div>
      </div>

      <button
        type="button"
        data-testid="toptab-new-session"
        aria-label={strings.navigation.newSession}
        title={`${strings.navigation.newSession} (Ctrl+Shift+T)`}
        onClick={onOpenNewSession}
        className={iconButtonClass(false)}
      >
        <Plus className="size-3.5" strokeWidth={1.75} />
      </button>

      {hovered && !sessionMenu && (
        <div
          data-testid="toptab-hover-card"
          className="shell-popover hover-card-delayed pointer-events-none absolute top-full z-40 mt-1.5 w-60 rounded-xl border border-border-default bg-surface p-3"
          style={{ left: hovered.left }}
        >
          {hovered.kind === 'session' ? (
            <SessionHoverCard session={hovered.item} />
          ) : (
            <TerminalHoverCard terminal={hovered.item} />
          )}
        </div>
      )}
      {sessionMenu && menuSession && createPortal(
        <div
          role={sessionMenu.mode === 'actions' ? 'menu' : undefined}
          data-toptab-session-actions-popover
          data-testid="toptab-session-actions-popover"
          style={{ top: sessionMenu.top, left: sessionMenu.left }}
          className="shell-popover fixed z-[100] max-h-52 w-44 overflow-y-auto rounded-lg border border-border-default bg-surface p-1"
        >
          {sessionMenu.mode === 'actions' ? (
            <>
              {menuSession.kind !== 'dsh' && (
                <>
                  <button
                    type="button"
                    role="menuitem"
                    data-testid="toptab-session-child-terminal"
                    onClick={() => {
                      setSessionMenu(null)
                      onCreateChildTerminal(menuSession)
                    }}
                    className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left font-pingfang text-[11px] text-text-secondary transition-colors hover:bg-surface-hover hover:text-text-primary"
                  >
                    <SquareTerminal className="size-3" strokeWidth={1.75} />
                    {strings.navigation.createChildTerminal}
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    data-testid="toptab-session-clone"
                    onClick={() => {
                      setSessionMenu(null)
                      onCloneSession(menuSession)
                    }}
                    className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left font-pingfang text-[11px] text-text-secondary transition-colors hover:bg-surface-hover hover:text-text-primary"
                  >
                    <Copy className="size-3" strokeWidth={1.75} />
                    {strings.navigation.cloneSession}
                  </button>
                </>
              )}
              <button
                type="button"
                role="menuitem"
                data-testid="toptab-session-rename"
                onClick={() => {
                  setRenameValue(menuSession.name)
                  setRenameError(false)
                  setSessionMenu((current) =>
                    current ? { ...current, mode: 'rename' } : current
                  )
                }}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left font-pingfang text-[11px] text-text-secondary transition-colors hover:bg-surface-hover hover:text-text-primary"
              >
                <Pencil className="size-3" strokeWidth={1.75} />
                {strings.navigation.renameSession}
              </button>
            </>
          ) : (
            <form
              data-testid="toptab-session-rename-form"
              onSubmit={(event) => {
                event.preventDefault()
                closeOrSaveSessionMenu()
              }}
              className="flex flex-col gap-1"
            >
              <div className="flex items-center gap-1">
                <input
                  autoFocus
                  data-testid="toptab-session-rename-input"
                  value={renameValue}
                  aria-label={strings.navigation.renameSession}
                  aria-invalid={renameError}
                  onChange={(event) => {
                    setRenameValue(event.target.value)
                    if (event.target.value.trim()) setRenameError(false)
                  }}
                  className={`min-w-0 flex-1 rounded-md border bg-content px-2 py-1 font-pingfang text-[11px] text-text-primary outline-none ${renameError ? 'border-status-error' : 'border-border-default focus:border-border-strong'}`}
                />
                <button
                  type="submit"
                  aria-label={strings.common.confirm}
                  title={strings.common.confirm}
                  className="flex size-6 shrink-0 items-center justify-center rounded-md text-text-muted hover:bg-control hover:text-text-primary"
                >
                  <Check className="size-3" strokeWidth={1.75} />
                </button>
              </div>
              {renameError && (
                <p
                  role="alert"
                  className="px-1 font-pingfang text-[10px] text-status-error"
                >
                  {strings.navigation.sessionNameRequired}
                </p>
              )}
            </form>
          )}
        </div>,
        document.body
      )}
    </div>
  )
}

function SessionHoverCard({ session }: { session: SessionEntry }) {
  const Icon = getAdapterIcon(session.adapterId)
  return (
    <>
      <div className="flex items-center gap-1.5">
        <Icon size={13} className="size-[13px]" />
        <span className="truncate font-pingfang text-[12px] font-semibold text-text-primary">
          {session.name}
        </span>
        <span
          className={`ml-auto shrink-0 font-maple text-[10px] ${statusTone[session.status]}`}
        >
          {statusLabel(session.status)}
        </span>
      </div>
      {session.detail && (
        <p className="mt-1.5 font-pingfang text-[11px] leading-snug text-text-muted">
          {session.detail}
        </p>
      )}
    </>
  )
}

function TerminalHoverCard({ terminal }: { terminal: TerminalEntry }) {
  return (
    <>
      <p className="font-pingfang text-[12px] font-semibold text-text-primary">
        {terminal.name}
      </p>
      <p className="mt-1 truncate font-maple text-[10px] text-text-faint">
        {terminal.cwd || terminal.shellId}
      </p>
    </>
  )
}
