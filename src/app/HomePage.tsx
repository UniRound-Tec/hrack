import { useMemo, useState } from 'react'
import { motion } from 'motion/react'
import { Settings2, Terminal as TerminalIcon } from 'lucide-react'
import type { ShellOption } from '../../shared/ipc-contract'
import type { SessionEntry } from '../state/sessionsStore'
import type { TerminalEntry } from '../state/terminalsStore'
import { getAdapterIcon } from './adapterIcons'
import ClickSpark from './effects/ClickSpark'
import CountUp from './effects/CountUp'
import ShinyText from './effects/ShinyText'
import TextType from './effects/TextType'
import { cliOptions, findDefaultShell, type CliOption } from './launchOptions'
import { createMockHistoryEvents, mockAllTimeStats } from './mockSessions'
import { statusDot, statusLabel, statusTone, type SessionStatus } from './sessionStatus'
import { strings } from './strings'

const ATTENTION_COLLAPSED_ROWS = 8

interface HomePageProps {
  sessions: readonly SessionEntry[]
  terminals: readonly TerminalEntry[]
  shells: readonly ShellOption[]
  defaultTerminal: string
  onLaunchDefaultTerminal: () => void
  onChooseTerminal: () => void
  onConfigureCli: (option: CliOption) => void
  onViewSession: (session: SessionEntry) => void
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

function LaunchIcon({ option }: { option: CliOption }) {
  const Icon = getAdapterIcon(option.adapterId)
  return <Icon size={16} className="size-4" />
}

export default function HomePage({
  sessions,
  terminals,
  shells,
  defaultTerminal,
  onLaunchDefaultTerminal,
  onChooseTerminal,
  onConfigureCli,
  onViewSession
}: HomePageProps) {
  const [attentionFilter, setAttentionFilter] = useState<
    'all' | Extract<SessionStatus, 'needs-you' | 'error'>
  >('all')
  const [attentionExpanded, setAttentionExpanded] = useState(false)
  const greeting = useMemo(
    () => strings.home.greetings[Math.floor(Math.random() * strings.home.greetings.length)],
    []
  )
  const history = useMemo(() => createMockHistoryEvents(), [])
  const fresh = sessions.length === 0 && terminals.length === 0
  const attention = sessions.filter(
    (session) => session.status === 'needs-you' || session.status === 'error'
  )
  const needsYou = attention.filter((session) => session.status === 'needs-you').length
  const errors = attention.length - needsYou
  const live = sessions.filter((session) => session.status !== 'exited').length
  const filtered = attentionFilter === 'all'
    ? attention
    : attention.filter((session) => session.status === attentionFilter)
  const visible = attentionExpanded
    ? filtered
    : filtered.slice(0, ATTENTION_COLLAPSED_ROWS)
  const defaultShell = findDefaultShell(shells, defaultTerminal)

  const launchers = (
    <>
      <div className="cursor-target group relative w-[142px]">
        <button
          type="button"
          data-testid="home-quick-terminal"
          onClick={onLaunchDefaultTerminal}
          className="flex w-full flex-col items-start gap-2.5 rounded-xl border border-border-default bg-surface p-3 text-left font-pingfang transition-colors hover:bg-surface-hover"
        >
          <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-control">
            <TerminalIcon className="size-4" strokeWidth={1.75} />
          </span>
          <span className="min-w-0">
            <span className="block text-[12px] font-semibold text-text-primary">
              {strings.home.terminal}
            </span>
            <span className="block truncate text-[10px] text-text-faint">
              {strings.home.defaultTerminal(defaultShell?.name ?? strings.newSession.terminalFallback)}
            </span>
          </span>
        </button>
        <button
          type="button"
          data-testid="home-terminal-options"
          aria-label={strings.home.terminalOptions}
          title={strings.home.terminalOptions}
          onClick={onChooseTerminal}
          className="absolute top-2 right-2 flex size-6 items-center justify-center rounded-md text-text-faint opacity-0 transition-all hover:bg-control hover:text-text-secondary group-hover:opacity-100 focus:opacity-100"
        >
          <Settings2 className="size-3" strokeWidth={1.75} />
        </button>
      </div>
      {cliOptions.map((option) => (
        <button
          key={option.id}
          type="button"
          data-testid={`home-quick-${option.id}`}
          onClick={() => onConfigureCli(option)}
          className="cursor-target flex w-[142px] flex-col items-start gap-2.5 rounded-xl border border-border-default bg-surface p-3 text-left font-pingfang transition-colors hover:bg-surface-hover"
        >
          <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-control">
            <LaunchIcon option={option} />
          </span>
          <span className="min-w-0">
            <span className="block text-[12px] font-semibold text-text-primary">{option.name}</span>
            <span className="block truncate text-[10px] text-text-faint">{option.hint}</span>
          </span>
        </button>
      ))}
    </>
  )

  const denseLaunchers = (
    <>
      <div className="group flex shrink-0 items-center rounded-full border border-border-default bg-surface transition-colors hover:bg-surface-hover">
        <button type="button" data-testid="home-quick-terminal" onClick={onLaunchDefaultTerminal} className="flex items-center gap-2 py-1.5 pr-1 pl-1.5">
          <span className="flex size-6 items-center justify-center rounded-full bg-control"><TerminalIcon className="size-[13px]" strokeWidth={1.75} /></span>
          <span className="text-[12px] font-medium text-text-secondary">{strings.home.terminal}</span>
          <span className="font-maple text-[10px] text-text-faint">{defaultShell?.name ?? strings.newSession.terminalFallback}</span>
        </button>
        <button type="button" data-testid="home-terminal-options" aria-label={strings.home.terminalOptions} onClick={onChooseTerminal} className="mr-1 flex size-6 items-center justify-center rounded-full text-text-faint hover:bg-control hover:text-text-secondary"><Settings2 className="size-3" strokeWidth={1.75} /></button>
      </div>
      {cliOptions.map((option) => (
        <button key={option.id} type="button" data-testid={`home-quick-${option.id}`} onClick={() => onConfigureCli(option)} className="flex shrink-0 items-center gap-2 rounded-full border border-border-default bg-surface py-1.5 pr-3 pl-1.5 transition-colors hover:bg-surface-hover">
          <span className="flex size-6 items-center justify-center rounded-full bg-control"><LaunchIcon option={option} /></span>
          <span className="text-[12px] font-medium text-text-secondary">{option.name}</span>
        </button>
      ))}
    </>
  )

  if (fresh) {
    return (
      <ClickSpark sparkColor="var(--vib-accent-flame)" sparkSize={6} sparkRadius={16}>
        <section data-testid="home-page" data-home-state="fresh" className="flex h-full flex-col items-center justify-center overflow-y-auto px-8 py-14">
          <p className="font-maple text-[10px] tracking-[0.28em] text-text-faint uppercase">
            {strings.home.freshLabel}
          </p>
          <div className="mt-5">
            <ShinyText text="vibing" color="var(--vib-brand-logo)" shineColor="var(--vib-brand-logoShine)" speed={3.2} spread={100} className="font-ammonite text-[54px] leading-none tracking-[0.08em]" />
          </div>
          <TextType
            as="h1"
            text={strings.home.freshTitle}
            keywords={['CLI']}
            keywordColor="var(--vib-accent-flame)"
            typingSpeed={42}
            initialDelay={160}
            loop={false}
            className="mt-6 text-center font-pingfang text-[24px] font-semibold text-text-primary"
          />
          <p className="mt-3 text-center font-pingfang text-[13px] text-text-muted">{strings.home.freshHint}</p>
          <div className="mt-9 flex w-full max-w-[620px] flex-wrap justify-center gap-2">
            {launchers}
          </div>
          <p className="mt-10 flex flex-wrap items-center justify-center gap-x-3 gap-y-1.5 font-maple text-[10px] text-text-faint">
            <span>{strings.home.freshCollect}</span>
            <span className="flex items-center gap-1.5"><span className="size-1.5 rounded-full bg-status-needs-you-dot" />{strings.sessionStatus.needsYou}</span>
            <span className="flex items-center gap-1.5"><span className="size-1.5 rounded-full bg-status-error-dot" />{strings.sessionStatus.error}</span>
            <span className="flex items-center gap-1.5"><span className="size-1.5 rounded-full bg-status-working-dot" />{strings.sessionStatus.working}</span>
            <span>{strings.home.historyStats}</span>
          </p>
        </section>
      </ClickSpark>
    )
  }

  const filterOptions = [
    { id: 'all' as const, label: strings.home.allStatuses, count: attention.length },
    { id: 'needs-you' as const, label: strings.sessionStatus.needsYou, count: needsYou },
    { id: 'error' as const, label: strings.sessionStatus.error, count: errors }
  ]
  const stats = [
    { id: 'sessions', label: strings.home.stats.sessions, hint: 'sessions', value: mockAllTimeStats.sessions },
    { id: 'tools', label: strings.home.stats.tools, hint: 'tool_call', value: mockAllTimeStats.toolCalls },
    { id: 'alerts', label: strings.home.stats.alerts, hint: 'blocked', value: mockAllTimeStats.blocked },
    { id: 'approvals', label: strings.home.stats.approvals, hint: 'approved', value: mockAllTimeStats.approvals }
  ]

  return (
    <ClickSpark sparkColor="var(--vib-accent-flame)" sparkSize={6} sparkRadius={16}>
      <section data-testid="home-page" data-home-state="dense" className="sidebar-scroll h-full overflow-y-auto">
        <header className="px-8 pt-10 pb-8">
          <p className="mb-3 font-maple text-[10px] tracking-[0.28em] text-text-faint uppercase">{strings.home.deskLabel}</p>
          <TextType as="h1" text={greeting.text} keywords={[...greeting.keywords]} keywordColor="var(--vib-accent-flame)" typingSpeed={42} initialDelay={120} loop={false} className="font-pingfang text-[32px] font-semibold text-text-primary" />
          <p className="mt-4 flex gap-2.5 font-maple text-[12px]">
            <span className="text-status-needs-you">{strings.home.waitingApproval(needsYou)}</span>
            <span className="text-text-disabled">·</span>
            <span className="text-status-error">{strings.home.errors(errors)}</span>
            <span className="text-text-disabled">·</span>
            <span className="text-status-done">{strings.home.live(live)}</span>
          </p>
        </header>

        <section className="px-8 pb-8">
          <p className="mb-2.5 font-maple text-[10px] tracking-[0.22em] text-text-faint uppercase">{strings.home.quickLaunch}</p>
          <div className="flex flex-wrap items-center gap-2">{denseLaunchers}</div>
        </section>

        <section className="px-8 pb-8">
          <div className="flex items-end justify-between gap-3 border-b border-border-subtle pb-2.5">
            <div>
              <p className="font-maple text-[10px] tracking-[0.22em] text-text-faint uppercase">attn</p>
              <h2 className="mt-0.5 font-pingfang text-[13px] font-semibold text-text-secondary">{strings.home.attention}</h2>
            </div>
            <div className="flex rounded-lg bg-control p-0.5">
              {filterOptions.map((option) => (
                <button key={option.id} type="button" data-testid={`home-filter-${option.id}`} onClick={() => { setAttentionFilter(option.id); setAttentionExpanded(false) }} className={`rounded-md px-2.5 py-1 font-pingfang text-[11px] ${attentionFilter === option.id ? 'bg-control-active text-text-primary' : 'text-text-muted'}`}>
                  {option.label} <span className="font-maple text-[10px]">{option.count}</span>
                </button>
              ))}
            </div>
          </div>
          {visible.length === 0 && <p className="py-4 font-pingfang text-[11px] text-text-faint">{strings.home.emptyAttention}</p>}
          <ul>
            {visible.map((session) => {
              const Icon = getAdapterIcon(session.adapterId)
              return (
                <li key={session.sessionId} className="border-b border-border-faint">
                  <button type="button" onClick={() => onViewSession(session)} className="cursor-target flex w-full items-center gap-3 py-3 text-left hover:bg-surface-hover">
                    <span className={`size-1.5 shrink-0 rounded-full ${statusDot[session.status]}`} />
                    <Icon size={15} className="size-[15px]" />
                    <span className="min-w-0 flex-1 truncate font-pingfang text-[13px] text-text-secondary">{session.detail ?? session.name}</span>
                    <span className="hidden font-maple text-[10px] text-text-muted sm:inline">{session.name}</span>
                    <span className={`font-maple text-[10px] ${statusTone[session.status]}`}>{statusLabel[session.status]}</span>
                    <span className="font-maple text-[10px] text-text-faint">{relativeTime(session.lastActivityAt)}</span>
                  </button>
                </li>
              )
            })}
          </ul>
          {filtered.length > ATTENTION_COLLAPSED_ROWS && (
            <button type="button" data-testid="home-attention-expand" onClick={() => setAttentionExpanded((value) => !value)} className="mt-2.5 font-maple text-[11px] text-text-muted hover:text-text-primary">
              {attentionExpanded ? strings.home.showLess : strings.home.showAll(filtered.length)}
            </button>
          )}
        </section>

        <section className="grid grid-cols-1 gap-10 px-8 pb-10 lg:grid-cols-5">
          <div className="lg:col-span-3">
            <div className="border-b border-border-subtle pb-2.5">
              <p className="font-maple text-[10px] tracking-[0.22em] text-text-faint uppercase">log</p>
              <h2 className="font-pingfang text-[13px] font-semibold text-text-secondary">{strings.home.recentHistory}</h2>
            </div>
            <ul>{history.map((event) => { const Icon = getAdapterIcon(event.adapterId); return (
              <li key={event.id} className="flex items-start gap-3 border-b border-border-faint py-2.5">
                <Icon size={14} className="mt-0.5 size-3.5 opacity-80" />
                <span className="min-w-0 flex-1"><span className="block font-pingfang text-[12px] font-semibold text-text-primary">{event.title}</span><span className="block truncate font-maple text-[11px] text-text-muted">{event.detail}</span></span>
                <span className="font-maple text-[10px] text-text-faint">{relativeTime(event.occurredAt)}</span>
              </li>
            ) })}</ul>
          </div>
          <div className="lg:col-span-2">
            <div className="border-b border-border-subtle pb-2.5"><p className="font-maple text-[10px] tracking-[0.22em] text-text-faint uppercase">metrics</p><h2 className="font-pingfang text-[13px] font-semibold text-text-secondary">{strings.home.allTime}</h2></div>
            <ul>{stats.map((stat, index) => <li key={stat.id} className="flex items-baseline justify-between border-b border-border-faint py-3"><span className="font-pingfang text-[12px] text-text-muted">{stat.label} <span className="font-maple text-[10px] text-text-faint">{stat.hint}</span></span><span className="font-maple text-[20px] text-text-primary"><CountUp to={stat.value} duration={1.2} delay={index * 0.06} separator="," /></span></li>)}</ul>
          </div>
        </section>
      </section>
    </ClickSpark>
  )
}
