import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, X } from 'lucide-react'
import type { AgentSessionProjection } from '../../shared/agent-events'
import { getAdapterIcon } from '../app/adapterIcons'
import { renderAgentDetail } from '../app/agentDetail'
import { statusDot, statusTone } from '../app/sessionStatus'
import { useStrings } from '../app/i18n'

const COLLAPSED_COUNT = 3

export default function FloatingApp() {
  const strings = useStrings()
  const [expanded, setExpanded] = useState(false)
  const [sessions, setSessions] = useState<AgentSessionProjection[]>([])
  const rootRef = useRef<HTMLElement>(null)
  const seenSeq = useRef(new Map<string, number>())

  useEffect(() => {
    let cancelled = false
    const applyProjection = (projection: AgentSessionProjection): void => {
      if (cancelled) return
      const previousSeq = seenSeq.current.get(projection.sessionId) ?? -1
      if (projection.lastSeq <= previousSeq) return
      seenSeq.current.set(projection.sessionId, projection.lastSeq)
      setSessions((current) => {
        const withoutCurrent = current.filter(
          (session) => session.sessionId !== projection.sessionId
        )
        if (projection.status === 'exited') return withoutCurrent
        return [...withoutCurrent, projection]
      })
    }

    // 与主窗口相同：先订阅增量，再取快照；lastSeq 防止迟到快照回滚。
    const unsubscribe = window.agentApi.onProjection(applyProjection)
    void window.agentApi.listActive().then((active) => {
      for (const projection of active) applyProjection(projection)
    })
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [])

  useLayoutEffect(() => {
    const root = rootRef.current
    if (!root) return
    let frame = 0
    let lastHeight = 0
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        const height = Math.ceil(root.scrollHeight)
        if (height === lastHeight) return
        lastHeight = height
        void window.floatingWindowApi.resizeToContent(height)
      })
    })
    observer.observe(root)
    return () => {
      cancelAnimationFrame(frame)
      observer.disconnect()
    }
  })

  const active = useMemo(
    () =>
      [...sessions].sort(
        (left, right) =>
          right.lastActivityAt - left.lastActivityAt ||
          left.sessionId.localeCompare(right.sessionId)
      ),
    [sessions]
  )
  const attentionCount = active.filter(
    (session) => session.status === 'needs-you' || session.status === 'error'
  ).length
  const visible = expanded ? active : active.slice(0, COLLAPSED_COUNT)
  const hasMore = active.length > COLLAPSED_COUNT

  return (
    <main ref={rootRef} className="box-border w-full p-2">
      <aside
        data-testid="floating-window"
        className="w-full select-none overflow-hidden rounded-xl border border-border-default bg-overlay shadow-[0_3px_8px_-4px_rgba(0,0,0,0.28)]"
      >
        <header className="app-drag-region flex h-8 shrink-0 items-center gap-2 px-2.5">
          <span className="font-brand text-[13px] leading-none text-brand-logo-muted">
            vibing
          </span>
          {attentionCount > 0 && (
            <span className="font-pingfang text-[9px] text-status-needs-you">
              <span data-testid="floating-attention-count">
                {attentionCount}
              </span>{' '}
              {strings.floating.attention}
            </span>
          )}
          <button
            type="button"
            data-testid="floating-close"
            aria-label={strings.common.close}
            onClick={() => void window.floatingWindowApi.setEnabled(false)}
            className="app-no-drag ml-auto flex size-5 items-center justify-center rounded-md text-text-faint transition-colors hover:bg-surface-hover hover:text-text-secondary"
          >
            <X className="size-3" strokeWidth={1.75} />
          </button>
        </header>

        {visible.length > 0 ? (
          <ul
            data-testid="floating-session-list"
            className={`app-no-drag px-1 pb-1 ${
              expanded ? 'sidebar-scroll max-h-[264px] overflow-y-auto' : ''
            }`}
          >
            {visible.map((session) => {
              const Icon = getAdapterIcon(session.adapterId)
              const detail =
                renderAgentDetail(session.detail, strings) ?? session.name ?? ''
              return (
                <li key={session.sessionId}>
                  <button
                    type="button"
                    data-testid="floating-session-item"
                    data-session-id={session.sessionId}
                    onClick={() =>
                      void window.floatingWindowApi.focusSession(
                        session.sessionId
                      )
                    }
                    className="flex w-full items-center gap-1.5 rounded-lg px-1.5 py-[5px] text-left transition-colors hover:bg-surface-hover"
                  >
                    <span
                      className={`size-1.5 shrink-0 rounded-full ${statusDot[session.status]}`}
                    />
                    <span className="inline-flex size-4 shrink-0 items-center justify-center text-text-muted">
                      <Icon size={12} className="size-3" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-pingfang text-[10px] font-medium text-text-secondary">
                        {session.name ?? session.adapterId}
                      </span>
                      <span
                        className={`block truncate font-pingfang text-[10px] leading-snug ${statusTone[session.status]}`}
                      >
                        {detail}
                      </span>
                    </span>
                    <RelativeTime timestamp={session.lastActivityAt} />
                  </button>
                </li>
              )
            })}
          </ul>
        ) : (
          <div
            data-testid="floating-empty"
            className="flex h-[58px] items-center px-3 pb-2 font-pingfang text-[10px] text-text-faint"
          >
            {strings.floating.empty}
          </div>
        )}

        {hasMore && (
          <button
            type="button"
            data-testid="floating-expand"
            onClick={() => setExpanded((value) => !value)}
            className="app-no-drag flex w-full items-center justify-center gap-1 border-t border-border-faint py-1.5 font-pingfang text-[10px] text-text-faint transition-colors hover:bg-surface-hover hover:text-text-secondary"
          >
            <ChevronDown
              className={`size-3 transition-transform ${expanded ? 'rotate-180' : ''}`}
              strokeWidth={1.75}
            />
            {expanded
              ? strings.floating.collapse
              : strings.floating.expand(active.length)}
          </button>
        )}
      </aside>
    </main>
  )
}

function RelativeTime({ timestamp }: { timestamp: number }) {
  const strings = useStrings()
  const [, refresh] = useState(0)
  useEffect(() => {
    const timer = window.setInterval(() => refresh((value) => value + 1), 30_000)
    return () => window.clearInterval(timer)
  }, [])
  const elapsed = Math.max(0, Date.now() - timestamp)
  const minutes = Math.floor(elapsed / 60_000)
  const label =
    minutes < 1
      ? strings.common.justNow
      : minutes < 60
        ? strings.common.minutesAgo(minutes)
        : strings.common.hoursAgo(Math.floor(minutes / 60))
  return (
    <span className="shrink-0 font-maple text-[8px] text-text-faint">
      {label}
    </span>
  )
}
