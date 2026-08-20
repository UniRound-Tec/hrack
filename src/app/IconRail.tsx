import {
  Home,
  PanelLeftOpen,
  Smartphone,
  SquarePen,
  Terminal as TerminalIcon
} from 'lucide-react'
import { getAdapterIcon } from './adapterIcons'
import {
  dshSlotIdFromPage,
  sessionPage,
  terminalIdFromPage,
  terminalPage,
  type PageId
} from './pages'
import { statusDot } from './sessionStatus'
import { useStrings } from './i18n'
import type { SessionEntry } from '../state/sessionsStore'
import type { TerminalEntry } from '../state/terminalsStore'

interface IconRailProps {
  pageId: PageId
  sessions: readonly SessionEntry[]
  terminals: readonly TerminalEntry[]
  drivenSessionId: string | null
  onNavigate: (pageId: PageId) => void
  onOpenNewSession: () => void
  onExpand: () => void
}

const railButtonClass = (active: boolean): string =>
  [
    'cursor-target flex size-9 items-center justify-center rounded-lg transition-colors',
    active
      ? 'bg-surface-strong text-text-primary'
      : 'text-text-faint hover:bg-surface-hover hover:text-text-secondary'
  ].join(' ')

export default function IconRail({
  pageId,
  sessions,
  terminals,
  drivenSessionId,
  onNavigate,
  onOpenNewSession,
  onExpand
}: IconRailProps) {
  const strings = useStrings()
  const activeTerminalId = terminalIdFromPage(pageId)
  const activeDshSlotId = dshSlotIdFromPage(pageId)
  const visibleSessions = sessions.slice(0, 6)
  const visibleTerminals = terminals.slice(0, 3)

  return (
    <aside
      data-testid="icon-rail"
      className="flex w-12 shrink-0 flex-col items-center pt-3 pb-2"
    >
      <span className="font-brand text-[20px] leading-none text-brand-logo-muted select-none">
        h
      </span>

      <nav className="mt-3 flex flex-col gap-0.5">
        <button
          type="button"
          data-testid="rail-home"
          title={strings.navigation.home}
          onClick={() => onNavigate('home')}
          className={railButtonClass(pageId === 'home')}
        >
          <Home className="size-4" strokeWidth={1.75} />
        </button>
        <button
          type="button"
          data-testid="rail-new-session"
          title={strings.navigation.newSession}
          onClick={onOpenNewSession}
          className={railButtonClass(false)}
        >
          <SquarePen className="size-4" strokeWidth={1.75} />
        </button>
      </nav>

      <span className="my-2.5 h-px w-6 shrink-0 bg-border-subtle" />

      <div className="sidebar-scroll flex min-h-0 flex-1 flex-col items-center gap-1 overflow-y-auto">
        {visibleSessions.map((session) => {
          const Icon = getAdapterIcon(session.adapterId)
          return (
            <button
              key={session.sessionId}
              type="button"
              data-testid="rail-session-item"
              data-remote-driven={
                drivenSessionId === session.sessionId ? 'true' : 'false'
              }
              title={`${session.name} · ${session.detail ?? ''}`}
              onClick={() => onNavigate(sessionPage(session))}
              className={`cursor-target relative flex size-9 shrink-0 items-center justify-center rounded-lg transition-colors ${
                session.kind === 'dsh'
                  ? activeDshSlotId === session.sessionId
                    ? 'bg-surface-strong'
                    : 'hover:bg-surface-hover'
                  : activeTerminalId === session.terminalId
                    ? 'bg-surface-strong'
                    : 'hover:bg-surface-hover'
              }`}
            >
              <Icon size={15} className="size-[15px]" />
              <span
                className={`absolute top-1 right-1 size-1.5 rounded-full ring-2 ring-app ${statusDot[session.status]}`}
              />
              {drivenSessionId === session.sessionId && (
                <Smartphone
                  aria-label={strings.terminal.remoteDriven}
                  className="absolute right-0.5 bottom-0.5 size-3 rounded bg-app text-brand"
                  strokeWidth={2}
                />
              )}
            </button>
          )
        })}
        {sessions.length > visibleSessions.length && (
          <span className="shrink-0 font-maple text-[10px] text-text-faint">
            +{sessions.length - visibleSessions.length}
          </span>
        )}

        <span className="my-1.5 h-px w-6 shrink-0 bg-border-subtle" />

        {visibleTerminals.map((terminal) => (
          <button
            key={terminal.id}
            type="button"
            data-testid="rail-terminal-item"
            title={`${terminal.name} · ${terminal.cwd || terminal.shellId}`}
            onClick={() => onNavigate(terminalPage(terminal.id))}
            className={`cursor-target flex size-9 shrink-0 items-center justify-center rounded-lg transition-colors ${
              activeTerminalId === terminal.id
                ? 'bg-surface-strong text-text-primary'
                : 'text-text-muted hover:bg-surface-hover hover:text-text-secondary'
            }`}
          >
            <TerminalIcon className="size-[15px]" strokeWidth={1.75} />
          </button>
        ))}
        {terminals.length > visibleTerminals.length && (
          <span className="shrink-0 font-maple text-[10px] text-text-faint">
            +{terminals.length - visibleTerminals.length}
          </span>
        )}
      </div>

      <div className="mt-1 flex flex-col items-center border-t border-border-faint pt-1.5">
        <button
          type="button"
          data-testid="rail-expand"
          title={strings.navigation.expandSidebar}
          aria-label={strings.navigation.expandSidebar}
          onClick={onExpand}
          className={railButtonClass(false)}
        >
          <PanelLeftOpen className="size-4" strokeWidth={1.75} />
        </button>
      </div>
    </aside>
  )
}
