import { useEffect, useRef, useState } from 'react'
import { Home, Plus, Terminal as TerminalIcon, X } from 'lucide-react'
import { getAdapterIcon } from './adapterIcons'
import { terminalIdFromPage, terminalPage, type PageId } from './pages'
import { statusDot, statusLabel, statusTone } from './sessionStatus'
import { strings } from './strings'
import type { SessionEntry } from '../state/sessionsStore'
import type { TerminalEntry } from '../state/terminalsStore'

interface TopTabBarProps {
  pageId: PageId
  sessions: readonly SessionEntry[]
  terminals: readonly TerminalEntry[]
  onNavigate: (pageId: PageId) => void
  onOpenNewSession: () => void
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
  onNavigate,
  onOpenNewSession,
  onCloseSession,
  onCloseTerminal
}: TopTabBarProps) {
  const barRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const [hovered, setHovered] = useState<HoveredTab | null>(null)
  const activeTerminalId = terminalIdFromPage(pageId)

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
            const active = activeTerminalId === session.terminalId
            return (
              <div
                key={session.sessionId}
                className="group flex shrink-0 items-center rounded-lg"
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
                  aria-current={active ? 'page' : undefined}
                  onClick={() => onNavigate(terminalPage(session.terminalId))}
                  className={`${tabButtonClass(active)} pr-1`}
                >
                  <span
                    className={`size-1.5 shrink-0 rounded-full ${statusDot[session.status]}`}
                  />
                  <Icon size={13} className="size-[13px] shrink-0" />
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

      {hovered && (
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
          {statusLabel[session.status]}
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
