import {
  Home,
  PanelLeftClose,
  SquarePen,
  X
} from 'lucide-react'
import ShinyText from './effects/ShinyText'
import { getAdapterIcon } from './adapterIcons'
import { terminalIdFromPage, terminalPage, type PageId } from './pages'
import { statusDot, statusTone } from './sessionStatus'
import { strings } from './strings'
import type { SessionEntry } from '../state/sessionsStore'
import type { TerminalEntry } from '../state/terminalsStore'

interface SidebarProps {
  pageId: PageId
  sessions: readonly SessionEntry[]
  terminals: readonly TerminalEntry[]
  onNavigate: (pageId: PageId) => void
  onOpenNewSession: () => void
  onCollapse: () => void
  onCloseSession: (session: SessionEntry) => void
  onCloseTerminal: (terminalId: string) => void
}

function relativeTime(timestamp: number): string {
  const elapsed = Math.max(0, Date.now() - timestamp)
  const minutes = Math.floor(elapsed / 60_000)
  if (minutes < 1) return strings.common.justNow
  if (minutes < 60) return strings.common.minutesAgo(minutes)
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return strings.common.hoursAgo(hours)
  return strings.common.daysAgo(Math.floor(hours / 24))
}

const navButtonClass = (active: boolean): string =>
  [
    'cursor-target flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left font-pingfang transition-colors',
    active
      ? 'bg-surface-strong text-text-primary'
      : 'text-text-muted hover:bg-surface-hover hover:text-text-secondary'
  ].join(' ')

export default function Sidebar({
  pageId,
  sessions,
  terminals,
  onNavigate,
  onOpenNewSession,
  onCollapse,
  onCloseSession,
  onCloseTerminal
}: SidebarProps) {
  const activeTerminalId = terminalIdFromPage(pageId)

  return (
    <aside
      data-testid="sidebar"
      className="flex w-[280px] shrink-0 flex-col px-3 pt-3"
    >
      <div className="flex justify-center">
        <ShinyText
          text="vibing"
          color="var(--vib-brand-logo)"
          shineColor="var(--vib-brand-logoShine)"
          speed={3.2}
          spread={100}
          className="font-ammonite text-[26px] leading-none tracking-[0.08em]"
        />
      </div>

      <nav className="mt-4 flex flex-col gap-0.5">
        <button
          type="button"
          data-testid="nav-home"
          onClick={() => onNavigate('home')}
          className={navButtonClass(pageId === 'home')}
        >
          <Home className="size-3.5 shrink-0 opacity-80" strokeWidth={1.75} />
          <span className="text-[12px] font-medium tracking-wide">
            {strings.navigation.home}
          </span>
        </button>
        <button
          type="button"
          data-testid="nav-new-session"
          onClick={onOpenNewSession}
          className={navButtonClass(false)}
        >
          <SquarePen
            className="size-3.5 shrink-0 opacity-80"
            strokeWidth={1.75}
          />
          <span className="text-[12px] font-medium tracking-wide">
            {strings.navigation.newSession}
          </span>
        </button>
      </nav>

      <div className="sidebar-scroll mt-4 min-h-0 flex-1 overflow-y-auto pb-3">
        <p className="mb-1.5 px-1 font-pingfang text-[11px] font-medium tracking-wide text-text-faint">
          {strings.navigation.sessions}
        </p>
        {sessions.length === 0 && (
          <p className="px-1 py-0.5 font-pingfang text-[11px] text-text-disabled">
            {strings.navigation.emptySessions}
          </p>
        )}
        <ul className="flex flex-col gap-1.5">
          {sessions.map((session) => {
            const Icon = getAdapterIcon(session.adapterId)
            const active = activeTerminalId === session.terminalId
            return (
              <li
                key={session.sessionId}
                className="group relative rounded-lg border border-border-subtle bg-surface transition-colors hover:bg-surface-hover"
              >
                <button
                  type="button"
                  data-testid="sidebar-session-item"
                  data-session-id={session.sessionId}
                  aria-current={active ? 'page' : undefined}
                  onClick={() => onNavigate(terminalPage(session.terminalId))}
                  className="cursor-target w-full px-2.5 py-1.5 text-left font-pingfang"
                >
                  <div className="flex items-center gap-1.5">
                    <span className="inline-flex size-3.5 shrink-0 items-center justify-center">
                      <Icon size={14} className="size-3.5" />
                    </span>
                    <span className="truncate text-[12px] font-semibold text-text-primary">
                      {session.name}
                    </span>
                    <span
                      className={`size-1.5 shrink-0 rounded-full ${statusDot[session.status]}`}
                    />
                    <span className="ml-auto shrink-0 text-[11px] text-text-faint transition-opacity group-hover:opacity-0">
                      {relativeTime(session.lastActivityAt)}
                    </span>
                  </div>
                  {session.detail && (
                    <p
                      className={`mt-0.5 truncate text-[11px] leading-snug font-medium ${statusTone[session.status]}`}
                    >
                      {session.detail}
                    </p>
                  )}
                </button>
                <button
                  type="button"
                  data-testid="sidebar-session-close"
                  aria-label={`${strings.navigation.closeSession}: ${session.name}`}
                  title={`${strings.navigation.closeSession}: ${session.name}`}
                  onClick={() => onCloseSession(session)}
                  className="cursor-target absolute top-1 right-1 flex size-6 items-center justify-center rounded-md text-text-faint opacity-0 transition-all group-hover:opacity-100 hover:bg-control hover:text-text-secondary focus:opacity-100"
                >
                  <X className="size-3" strokeWidth={1.75} />
                </button>
              </li>
            )
          })}
        </ul>

        <p className="mt-4 mb-1.5 px-1 font-pingfang text-[11px] font-medium tracking-wide text-text-faint">
          {strings.navigation.terminals}
        </p>
        {terminals.length === 0 && (
          <p className="px-1 py-0.5 font-pingfang text-[11px] text-text-disabled">
            {strings.navigation.emptyTerminals}
          </p>
        )}
        <ul className="flex flex-col gap-1">
          {terminals.map((terminal) => {
            const active = activeTerminalId === terminal.id
            return (
              <li
                key={terminal.id}
                className={`group relative flex items-center rounded-lg border transition-colors ${
                  active
                    ? 'border-border-default bg-surface-strong'
                    : 'border-border-subtle bg-surface hover:bg-surface-hover'
                }`}
              >
                <button
                  type="button"
                  data-testid="sidebar-terminal-item"
                  data-terminal-id={terminal.id}
                  data-exited={terminal.exited}
                  aria-current={active ? 'page' : undefined}
                  onClick={() => onNavigate(terminalPage(terminal.id))}
                  className="cursor-target flex min-w-0 flex-1 items-center gap-2 px-2.5 py-1.5 text-left font-pingfang"
                >
                  <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-text-secondary">
                    {terminal.name}
                  </span>
                  <span className="max-w-[40%] shrink-0 truncate text-[10px] text-text-faint transition-opacity group-hover:opacity-0">
                    {terminal.exited
                      ? strings.sessionStatus.exited
                      : terminal.cwd || terminal.shellId}
                  </span>
                </button>
                <button
                  type="button"
                  data-testid="sidebar-terminal-close"
                  aria-label={`${strings.navigation.closeTerminal}: ${terminal.name}`}
                  title={`${strings.navigation.closeTerminal}: ${terminal.name}`}
                  onClick={() => onCloseTerminal(terminal.id)}
                  className="cursor-target absolute right-1 flex size-6 items-center justify-center rounded-md text-text-faint opacity-0 transition-all group-hover:opacity-100 hover:bg-control hover:text-text-secondary focus:opacity-100"
                >
                  <X className="size-3" strokeWidth={1.75} />
                </button>
              </li>
            )
          })}
        </ul>
      </div>

      <div className="flex items-center justify-end border-t border-border-faint py-2">
        <button
          type="button"
          data-testid="sidebar-collapse"
          title={strings.navigation.collapseSidebar}
          aria-label={strings.navigation.collapseSidebar}
          onClick={onCollapse}
          className="cursor-target flex size-8 items-center justify-center rounded-lg text-text-faint transition-colors hover:bg-surface-hover hover:text-text-secondary"
        >
          <PanelLeftClose className="size-4" strokeWidth={1.75} />
        </button>
      </div>
    </aside>
  )
}
