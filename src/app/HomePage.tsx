import { useEffect, useMemo, useState } from 'react'
import { motion } from 'motion/react'
import {
  ChevronLeft,
  ChevronRight,
  RefreshCw,
  Settings2,
  Terminal as TerminalIcon
} from 'lucide-react'
import type {
  AllTimeStats,
  HistoryEvent,
  HistoryEventKind,
  LaunchableCli,
  ShellOption
} from '../../shared/ipc-contract'
import type { DshRuntimeScanReport } from '../../shared/dsh-ipc'
import type { SessionEntry } from '../state/sessionsStore'
import { getAdapterIcon, getAdapterName } from './adapterIcons'
import ClickSpark from './effects/ClickSpark'
import CountUp from './effects/CountUp'
import ShinyText from './effects/ShinyText'
import TextType from './effects/TextType'
import { findDefaultShell, type CliOption } from './launchOptions'
import { statusDot, statusLabel, statusTone, type SessionStatus } from './sessionStatus'
import { useStrings } from './i18n'

const WELCOME_LAUNCH_PAGE_SIZE = 8

const EMPTY_STATS: AllTimeStats = {
  sessions: 0,
  toolCalls: 0,
  blocked: 0,
  approvals: 0
}

/** 原型全局 ClickSpark 参数（App.tsx：#1a1a1a / 8 / 18 / 10 / 450）。 */
const clickSparkProps = {
  sparkColor: 'var(--vib-accent-spark)',
  sparkSize: 8,
  sparkRadius: 18,
  sparkCount: 10,
  duration: 450
} as const

/** 原型 historyKindTone / historyKindDot 的 token 版。 */
const historyKindTone: Record<HistoryEventKind, string> = {
  tool_call: 'text-text-strong',
  completed: 'text-status-done',
  approved: 'text-status-needs-you',
  blocked: 'text-status-needs-you',
  message: 'text-text-muted',
  session_start: 'text-status-working',
  session_exit: 'text-status-exited'
}

const historyKindDot: Record<HistoryEventKind, string> = {
  tool_call: 'bg-text-faint',
  completed: 'bg-status-done-dot',
  approved: 'bg-status-needs-you-dot',
  blocked: 'bg-status-needs-you-dot',
  message: 'bg-status-idle-dot',
  session_start: 'bg-status-working-dot',
  session_exit: 'bg-status-exited-dot'
}

type AttentionFilter = 'all' | Extract<SessionStatus, 'needs-you' | 'error'>

const sessionAttentionPriority: Record<SessionStatus, number> = {
  'needs-you': 0,
  error: 1,
  working: 2,
  idle: 3,
  done: 4,
  exited: 5
}

interface HomePageProps {
  sessions: readonly SessionEntry[]
  shells: readonly ShellOption[]
  clis: readonly LaunchableCli[]
  cliScanning: boolean
  dshRuntimeReport: DshRuntimeScanReport | null
  dshRuntimeScanning: boolean
  defaultTerminal: string
  onLaunchDefaultTerminal: () => void
  onChooseTerminal: () => void
  onConfigureCli: (option: CliOption) => void
  onRefreshRuntimes: () => void
  onViewSession: (session: SessionEntry) => void
  onOpenDsh: () => void
}

function relativeTime(
  strings: ReturnType<typeof useStrings>,
  timestamp: number
): string {
  const elapsed = Math.max(0, Date.now() - timestamp)
  const minutes = Math.floor(elapsed / 60_000)
  if (minutes < 1) return strings.common.justNow
  if (minutes < 60) return strings.common.minutesAgo(minutes)
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return strings.common.hoursAgo(hours)
  return strings.common.daysAgo(Math.floor(hours / 24))
}

function LaunchIcon({ option }: { option: CliOption }) {
  const Icon = getAdapterIcon(option.definition.adapterId)
  return <Icon size={16} className="size-4" />
}

function DshLaunchIcon(): React.ReactNode {
  const Icon = getAdapterIcon('dsh')
  return (
    <Icon
      size={16}
      className="size-4"
      data-testid="home-dsh-brand-icon"
    />
  )
}

function runtimeSummary(option: CliOption): string {
  return option.installations
    .map((installation) =>
      installation.runtime.kind === 'wsl'
        ? `WSL · ${installation.runtime.distro}`
        : installation.runtime.platform === 'windows'
          ? 'Windows'
          : installation.runtime.platform === 'macos'
            ? 'macOS'
            : 'Linux'
    )
    .join(' · ')
}

function dshRuntimeSummary(
  report: DshRuntimeScanReport | null,
  scanning: boolean,
  strings: ReturnType<typeof useStrings>
): string {
  const locations = report?.candidates.flatMap((candidate): string[] => {
    if (candidate.kind !== 'installation') return []
    if (candidate.runtime.kind === 'wsl') {
      return [`WSL · ${candidate.runtime.distro}`]
    }
    return [candidate.runtime.platform === 'windows'
      ? 'Windows'
      : candidate.runtime.platform === 'macos'
        ? 'macOS'
        : 'Linux']
  }) ?? []
  const uniqueLocations = [...new Set(locations)]
  if (uniqueLocations.length > 0) return uniqueLocations.join(' · ')
  return scanning ? strings.dsh.runtimeScanning : strings.dsh.homeHint
}

export default function HomePage({
  sessions,
  shells,
  clis,
  cliScanning,
  dshRuntimeReport,
  dshRuntimeScanning,
  defaultTerminal,
  onLaunchDefaultTerminal,
  onChooseTerminal,
  onConfigureCli,
  onRefreshRuntimes,
  onViewSession,
  onOpenDsh
}: HomePageProps) {
  const [attentionFilter, setAttentionFilter] = useState<AttentionFilter>('all')
  const [launchPage, setLaunchPage] = useState(0)
  const [realHistory, setRealHistory] = useState<readonly HistoryEvent[] | null>(null)
  const [realStats, setRealStats] = useState<AllTimeStats | null>(null)
  const strings = useStrings()
  const dshSummary = dshRuntimeSummary(
    dshRuntimeReport,
    dshRuntimeScanning,
    strings
  )

  // 所有环境都通过 IPC 读取真实的历史与累计统计。
  useEffect(() => {
    let cancelled = false
    void Promise.all([
      window.statsApi.historyEvents({ limit: 50 }),
      window.statsApi.allTime()
    ])
      .then(([history, stats]) => {
        if (cancelled) return
        setRealHistory(history)
        setRealStats(stats)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])

  const greeting = useMemo(
    () => strings.home.greetings[Math.floor(Math.random() * strings.home.greetings.length)],
    []
  )
  const history = realHistory ?? []
  // 普通终端不属于 AI 会话；只有真实 AI CLI session 才进入信息密度布局。
  const fresh = sessions.length === 0
  const attention = useMemo(
    () => [...sessions].sort((left, right) => {
      const priority =
        sessionAttentionPriority[left.status] -
        sessionAttentionPriority[right.status]
      return priority || right.lastActivityAt - left.lastActivityAt
    }),
    [sessions]
  )
  const needsYou = sessions.filter((session) => session.status === 'needs-you').length
  const errors = sessions.filter((session) => session.status === 'error').length
  const live = sessions.filter((session) => session.status !== 'exited').length
  const filtered = attentionFilter === 'all'
    ? attention
    : attention.filter((session) => session.status === attentionFilter)
  const defaultShell = findDefaultShell(shells, defaultTerminal)

  const pickAttentionFilter = (id: AttentionFilter): void => {
    setAttentionFilter(id)
  }

  const launchCardClass =
    'flex w-full flex-col items-start gap-2.5 rounded-xl border border-border-default bg-surface p-3 text-left font-pingfang transition-colors hover:border-border-strong hover:bg-surface-hover'

  /** 空态启动卡：原型带 0.3s 起步、每张 +0.05s 的 spring 入场。 */
  const launchers = [
    {
      key: 'terminal',
      body: (
        <>
          <button
            type="button"
            data-testid="home-quick-terminal"
            onClick={onLaunchDefaultTerminal}
            className={launchCardClass}
          >
            <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-surface-strong">
              <TerminalIcon className="size-4" strokeWidth={1.75} />
            </span>
            <span className="w-full min-w-0">
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
        </>
      )
    },
    {
      key: 'dsh',
      body: (
        <button
          type="button"
          data-testid="home-quick-dsh"
          onClick={onOpenDsh}
          className={launchCardClass}
        >
          <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-surface-strong">
            <DshLaunchIcon />
          </span>
          <span className="w-full min-w-0">
            <span className="block text-[12px] font-semibold text-text-primary">
              {strings.navigation.dsh}
            </span>
            <span className="block truncate text-[10px] text-text-faint">
              {dshSummary}
            </span>
          </span>
        </button>
      )
    },
    ...clis.map((option) => ({
      key: option.definition.id,
      body: (
        <button
          type="button"
          data-testid={`home-quick-${option.definition.id}`}
          onClick={() => onConfigureCli(option)}
          className={launchCardClass}
        >
          <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-surface-strong">
            <LaunchIcon option={option} />
          </span>
          <span className="w-full min-w-0">
            <span className="block text-[12px] font-semibold text-text-primary">{option.definition.displayName}</span>
            <span className="block truncate text-[10px] text-text-faint">{runtimeSummary(option)}</span>
          </span>
        </button>
      )
    }))
  ]
  const launchPageCount = Math.max(
    1,
    Math.ceil(launchers.length / WELCOME_LAUNCH_PAGE_SIZE)
  )
  const visibleLaunchers = launchers.slice(
    launchPage * WELCOME_LAUNCH_PAGE_SIZE,
    (launchPage + 1) * WELCOME_LAUNCH_PAGE_SIZE
  )

  useEffect(() => {
    setLaunchPage((page) => Math.min(page, launchPageCount - 1))
  }, [launchPageCount])

  const denseLaunchers = (
    <>
      <div className="cursor-target group flex shrink-0 items-center rounded-full border border-border-default bg-surface transition-colors hover:border-border-strong hover:bg-surface-hover">
        <button
          type="button"
          data-testid="home-quick-terminal"
          onClick={onLaunchDefaultTerminal}
          className="flex items-center gap-2 py-1.5 pr-1 pl-1.5 font-pingfang"
        >
          <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-surface-strong">
            <TerminalIcon className="size-[13px]" strokeWidth={1.75} />
          </span>
          <span className="text-[12px] font-medium whitespace-nowrap text-text-secondary">{strings.home.terminal}</span>
          <span className="font-maple text-[10px] whitespace-nowrap text-text-faint">
            {defaultShell?.name ?? strings.newSession.terminalFallback}
          </span>
        </button>
        <button
          type="button"
          data-testid="home-terminal-options"
          aria-label={strings.home.terminalOptions}
          title={strings.home.terminalOptions}
          onClick={onChooseTerminal}
          className="mr-1 flex size-6 shrink-0 items-center justify-center rounded-full text-text-faint opacity-70 transition-all hover:bg-control hover:text-text-secondary group-hover:opacity-100"
        >
          <Settings2 className="size-3" strokeWidth={1.75} />
        </button>
      </div>
      <button
        type="button"
        data-testid="home-quick-dsh"
        onClick={onOpenDsh}
        className="cursor-target flex shrink-0 items-center gap-2 rounded-full border border-border-default bg-surface py-1.5 pr-3 pl-1.5 font-pingfang transition-colors hover:border-border-strong hover:bg-surface-hover"
      >
        <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-surface-strong">
          <DshLaunchIcon />
        </span>
        <span className="text-[12px] font-medium whitespace-nowrap text-text-secondary">
          {strings.navigation.dsh}
        </span>
      </button>
      {clis.map((option) => (
        <button
          key={option.definition.id}
          type="button"
          data-testid={`home-quick-${option.definition.id}`}
          onClick={() => onConfigureCli(option)}
          className="cursor-target flex shrink-0 items-center gap-2 rounded-full border border-border-default bg-surface py-1.5 pr-3 pl-1.5 font-pingfang transition-colors hover:border-border-strong hover:bg-surface-hover"
        >
          <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-surface-strong">
            <LaunchIcon option={option} />
          </span>
          <span className="text-[12px] font-medium whitespace-nowrap text-text-secondary">{option.definition.displayName}</span>
        </button>
      ))}
    </>
  )

  if (fresh) {
    return (
      <ClickSpark {...clickSparkProps}>
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
            showCursor
            cursorCharacter="|"
            cursorClassName="text-text-faint"
            className="mt-6 text-center font-pingfang text-[24px] font-semibold leading-tight tracking-wide text-text-primary"
          />
          <p className="mt-3 text-center font-pingfang text-[13px] text-text-muted">{strings.home.freshHint}</p>
          <div className="mt-8 flex w-full max-w-[620px] justify-end">
            <button
              type="button"
              data-testid="cli-scan-refresh"
              onClick={onRefreshRuntimes}
              disabled={cliScanning || dshRuntimeScanning}
              aria-busy={cliScanning || dshRuntimeScanning}
              className="inline-flex items-center gap-1 rounded-md px-1.5 py-1 font-pingfang text-[10px] text-text-faint transition-colors hover:bg-surface-strong hover:text-text-secondary disabled:cursor-wait disabled:opacity-70"
            >
              <RefreshCw
                className={`size-3 ${cliScanning || dshRuntimeScanning ? 'animate-spin' : ''}`}
                strokeWidth={1.75}
              />
              {strings.newSession.refreshClis}
            </button>
          </div>
          <div className="mt-2 flex w-full max-w-[620px] flex-wrap justify-center gap-2">
            {visibleLaunchers.map(({ key, body }, index) => (
              <motion.div
                key={key}
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{
                  delay: 0.3 + index * 0.05,
                  type: 'spring',
                  stiffness: 380,
                  damping: 30
                }}
                className="cursor-target group relative w-[142px]"
              >
                {body}
              </motion.div>
            ))}
          </div>
          {launchPageCount > 1 && (
            <nav
              data-testid="home-launch-pagination"
              aria-label={`${launchPage + 1} / ${launchPageCount}`}
              className="mt-4 flex items-center justify-center gap-2"
            >
              <button
                type="button"
                data-testid="home-launch-previous"
                aria-label={strings.home.previousLaunchPage}
                title={strings.home.previousLaunchPage}
                disabled={launchPage === 0}
                onClick={() => setLaunchPage((page) => Math.max(0, page - 1))}
                className="flex size-7 items-center justify-center rounded-md border border-border-default text-text-muted transition-colors hover:bg-surface-strong hover:text-text-secondary disabled:cursor-default disabled:opacity-30"
              >
                <ChevronLeft className="size-3.5" strokeWidth={1.75} />
              </button>
              <span className="min-w-10 text-center font-maple text-[10px] text-text-faint">
                {launchPage + 1} / {launchPageCount}
              </span>
              <button
                type="button"
                data-testid="home-launch-next"
                aria-label={strings.home.nextLaunchPage}
                title={strings.home.nextLaunchPage}
                disabled={launchPage === launchPageCount - 1}
                onClick={() => setLaunchPage((page) => Math.min(launchPageCount - 1, page + 1))}
                className="flex size-7 items-center justify-center rounded-md border border-border-default text-text-muted transition-colors hover:bg-surface-strong hover:text-text-secondary disabled:cursor-default disabled:opacity-30"
              >
                <ChevronRight className="size-3.5" strokeWidth={1.75} />
              </button>
            </nav>
          )}
          <p className={`${launchPageCount > 1 ? 'mt-7' : 'mt-11'} flex flex-wrap items-center justify-center gap-x-3 gap-y-1.5 font-maple text-[10px] text-text-faint`}>
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
  const statsSource = realStats ?? EMPTY_STATS
  const stats = [
    { id: 'sessions', label: strings.home.stats.sessions, hint: 'sessions', value: statsSource.sessions },
    { id: 'tools', label: strings.home.stats.tools, hint: 'tool_call', value: statsSource.toolCalls },
    { id: 'alerts', label: strings.home.stats.alerts, hint: 'blocked', value: statsSource.blocked },
    { id: 'approvals', label: strings.home.stats.approvals, hint: 'approved', value: statsSource.approvals }
  ]

  return (
    <ClickSpark {...clickSparkProps}>
      <section data-testid="home-page" data-home-state="dense" className="sidebar-scroll h-full overflow-y-auto">
        <header className="px-8 pt-10 pb-8">
          <div className="min-w-0">
            <p className="mb-3 font-maple text-[10px] tracking-[0.28em] text-text-faint uppercase">{strings.home.deskLabel}</p>
            <TextType
              as="h1"
              text={greeting.text}
              keywords={[...greeting.keywords]}
              keywordColor="var(--vib-accent-flame)"
              typingSpeed={42}
              initialDelay={120}
              loop={false}
              showCursor
              cursorCharacter="|"
              cursorClassName="text-text-faint"
              className="font-pingfang text-[32px] font-semibold leading-tight tracking-wide text-text-primary"
            />
            <p className="mt-4 flex flex-wrap items-center gap-x-2.5 gap-y-1.5 font-maple text-[12px] leading-none">
              <span aria-hidden className="select-none text-text-disabled">$</span>
              <button
                type="button"
                data-testid="home-prompt-needs-you"
                onClick={() => pickAttentionFilter('needs-you')}
                className="cursor-target text-status-needs-you decoration-dotted underline-offset-4 hover:underline"
              >
                {strings.home.waitingApproval(needsYou)}
              </button>
              <span className="select-none text-text-disabled">·</span>
              <button
                type="button"
                data-testid="home-prompt-error"
                onClick={() => pickAttentionFilter('error')}
                className="cursor-target text-status-error decoration-dotted underline-offset-4 hover:underline"
              >
                {strings.home.errors(errors)}
              </button>
              <span className="select-none text-text-disabled">·</span>
              <button
                type="button"
                data-testid="home-prompt-live"
                onClick={() => pickAttentionFilter('all')}
                className="cursor-target text-status-done decoration-dotted underline-offset-4 hover:underline"
              >
                {strings.home.live(live)}
              </button>
            </p>
          </div>
        </header>

        <section className="px-8 pb-8">
          <div className="mb-2.5 flex items-center gap-2">
            <p className="font-maple text-[10px] tracking-[0.22em] text-text-faint uppercase">{strings.home.quickLaunch}</p>
            <button
              type="button"
              data-testid="cli-scan-refresh"
              onClick={onRefreshRuntimes}
              disabled={cliScanning || dshRuntimeScanning}
              aria-busy={cliScanning || dshRuntimeScanning}
              className="inline-flex items-center gap-1 rounded-md px-1.5 py-1 font-pingfang text-[10px] text-text-faint transition-colors hover:bg-surface-strong hover:text-text-secondary disabled:cursor-wait disabled:opacity-70"
            >
              <RefreshCw
                className={`size-3 ${cliScanning || dshRuntimeScanning ? 'animate-spin' : ''}`}
                strokeWidth={1.75}
              />
              {strings.newSession.refreshClis}
            </button>
          </div>
          <div className="flex flex-wrap items-center gap-2">{denseLaunchers}</div>
        </section>

        <section className="px-8 pb-8">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border-subtle pb-2.5">
            <div>
              <p className="font-maple text-[10px] tracking-[0.22em] text-text-faint uppercase">attn</p>
              <h2 className="mt-0.5 font-pingfang text-[13px] font-semibold text-text-secondary">{strings.home.attention}</h2>
            </div>
            <div className="flex items-center gap-0.5 rounded-lg bg-control p-0.5">
              {filterOptions.map((option) => {
                const selected = attentionFilter === option.id
                return (
                  <button
                    key={option.id}
                    type="button"
                    data-testid={`home-filter-${option.id}`}
                    onClick={() => pickAttentionFilter(option.id)}
                    className={[
                      'cursor-target flex items-baseline gap-1.5 rounded-md px-2.5 py-1 font-pingfang text-[11px] font-medium transition-colors',
                      selected
                        ? 'bg-control-active text-text-primary shadow-sm'
                        : 'text-text-muted hover:text-text-secondary'
                    ].join(' ')}
                  >
                    {option.label}
                    <span className={`font-maple text-[10px] ${selected ? 'text-text-muted' : 'text-text-faint'}`}>
                      {option.count}
                    </span>
                  </button>
                )
              })}
            </div>
          </div>
          <ul className="sidebar-scroll flex min-h-36 max-h-72 flex-col overflow-x-hidden overflow-y-auto pr-1">
            {filtered.length === 0 && (
              <li className="py-4 font-pingfang text-[11px] text-text-faint">
                {strings.home.emptyAttention}
              </li>
            )}
            {filtered.map((session) => {
              const Icon = getAdapterIcon(session.adapterId)
              return (
                <li key={session.sessionId} className="group relative border-b border-border-faint last:border-b-0">
                  <button
                    type="button"
                    onClick={() => onViewSession(session)}
                    className="cursor-target flex w-full items-center gap-3 rounded-lg px-3 py-3 text-left font-pingfang transition-colors hover:bg-surface-strong"
                  >
                    <span className={`size-1.5 shrink-0 rounded-full ${statusDot[session.status]}`} />
                    <span className="inline-flex size-6 shrink-0 items-center justify-center">
                      <Icon size={15} className="size-[15px]" />
                    </span>
                    <span className="min-w-0 flex-1 truncate text-[13px] text-text-secondary">{session.detail ?? session.name}</span>
                    <span className="ml-auto hidden shrink-0 items-baseline gap-2 font-maple text-[10px] text-text-faint transition-opacity group-hover:opacity-0 sm:flex">
                      <span className="text-text-muted">{session.name}</span>
                      <span className={statusTone[session.status]}>{statusLabel(session.status)}</span>
                      <span>{relativeTime(strings, session.lastActivityAt)}</span>
                    </span>
                  </button>
                  {/* v1 只看不操作：hover 仅提供「查看」跳转到对应终端 */}
                  <div className="pointer-events-none absolute inset-y-0 right-0 flex items-center opacity-0 transition-opacity group-focus-within:pointer-events-auto group-focus-within:opacity-100 group-hover:pointer-events-auto group-hover:opacity-100">
                    <button
                      type="button"
                      data-testid="home-attention-view"
                      onClick={() => onViewSession(session)}
                      className="cursor-target rounded-md border border-border-default bg-surface px-2.5 py-1 font-pingfang text-[11px] font-medium text-text-strong transition-colors hover:bg-surface-strong hover:text-text-primary"
                    >
                      {strings.common.view}
                    </button>
                  </div>
                </li>
              )
            })}
          </ul>
        </section>

        <section className="grid grid-cols-1 gap-x-10 gap-y-8 px-8 pb-10 lg:grid-cols-5">
          <div className="min-w-0 lg:col-span-3">
            <div className="flex items-end justify-between gap-3 border-b border-border-subtle pb-2.5">
              <div>
                <p className="font-maple text-[10px] tracking-[0.22em] text-text-faint uppercase">log</p>
                <h2 className="mt-0.5 font-pingfang text-[13px] font-semibold text-text-secondary">{strings.home.recentHistory}</h2>
              </div>
              <span className="font-maple text-[10px] tracking-wide text-text-faint">tools · sessions</span>
            </div>
            <ul className="sidebar-scroll flex min-h-36 max-h-72 flex-col overflow-x-hidden overflow-y-auto pr-1">
              {history.length === 0 && (
                <li className="border-b border-border-faint py-3 font-pingfang text-[11px] text-text-faint last:border-b-0">
                  {strings.home.emptyHistory}
                </li>
              )}
              {history.map((event) => {
                const Icon = getAdapterIcon(event.adapterId)
                return (
                  <li key={event.id} className="border-b border-border-faint last:border-b-0">
                    <button
                      type="button"
                      className="cursor-target flex w-full items-start gap-3 rounded-lg px-3 py-2.5 text-left font-pingfang transition-colors hover:bg-surface-strong"
                    >
                      <span className={`mt-1.5 size-1.5 shrink-0 rounded-full ${historyKindDot[event.kind]}`} />
                      <span className="mt-0.5 inline-flex size-6 shrink-0 items-center justify-center opacity-80">
                        <Icon size={14} className="size-3.5" />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="flex items-baseline gap-2">
                          <span className="text-[12px] font-semibold text-text-primary">{getAdapterName(event.adapterId)}</span>
                          <span className={`truncate font-maple text-[10px] ${historyKindTone[event.kind]}`}>{event.title}</span>
                          <span className="ml-auto shrink-0 font-maple text-[10px] text-text-faint">{relativeTime(strings, event.occurredAt)}</span>
                        </span>
                        <span className="mt-0.5 block truncate font-maple text-[11px] leading-snug text-text-muted">{event.detail}</span>
                      </span>
                    </button>
                  </li>
                )
              })}
            </ul>
          </div>
          <div className="min-w-0 lg:col-span-2">
            <div className="flex items-end justify-between gap-3 border-b border-border-subtle pb-2.5">
              <div>
                <p className="font-maple text-[10px] tracking-[0.22em] text-text-faint uppercase">metrics</p>
                <h2 className="mt-0.5 font-pingfang text-[13px] font-semibold text-text-secondary">{strings.home.allTime}</h2>
              </div>
              <span className="font-maple text-[10px] tracking-wide text-text-faint">all time</span>
            </div>
            <ul className="flex flex-col">
              {stats.map((stat, index) => (
                <li key={stat.id} className="flex items-baseline justify-between gap-3 border-b border-border-faint py-3 last:border-b-0">
                  <p className="flex items-baseline gap-2">
                    <span className="font-pingfang text-[12px] text-text-strong">{stat.label}</span>
                    <span className="font-maple text-[10px] tracking-wide text-text-faint uppercase">{stat.hint}</span>
                  </p>
                  <p className="font-maple text-[20px] font-medium leading-none tracking-tight text-text-primary">
                    <CountUp to={stat.value} from={0} duration={1.2} delay={0.06 * index} separator="," />
                  </p>
                </li>
              ))}
            </ul>
          </div>
        </section>
      </section>
    </ClickSpark>
  )
}
