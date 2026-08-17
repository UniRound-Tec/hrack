import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, X } from 'lucide-react'
import type { FloatingRendererSnapshot } from '../../shared/floating-window'
import { getAdapterIcon } from '../app/adapterIcons'
import { renderAgentDetail } from '../app/agentDetail'
import { statusDot, statusTone } from '../app/sessionStatus'
import { useStrings } from '../app/i18n'
import { applyFloatingAppearance } from './appearance'

const COLLAPSED_COUNT = 3

export default function FloatingApp({
  initialSnapshot
}: {
  initialSnapshot: FloatingRendererSnapshot
}) {
  const strings = useStrings()
  const [expanded, setExpanded] = useState(false)
  const [snapshot, setSnapshot] = useState(initialSnapshot)
  const [completionPulse, setCompletionPulse] = useState(false)
  const rootRef = useRef<HTMLElement>(null)
  const seenAttentionSequence = useRef(
    initialSnapshot.attention?.sequence ?? 0
  )

  useEffect(() => {
    let cancelled = false
    let pulseFrame = 0
    let pulseTimer = 0
    const applySnapshot = (next: FloatingRendererSnapshot): void => {
      if (cancelled) return
      applyFloatingAppearance(next.appearance)
      const signal = next.attention
      if (signal && signal.sequence > seenAttentionSequence.current) {
        seenAttentionSequence.current = signal.sequence
        if (next.attentionEffectEnabled && signal.kind === 'done') {
          window.cancelAnimationFrame(pulseFrame)
          window.clearTimeout(pulseTimer)
          setCompletionPulse(false)
          pulseFrame = window.requestAnimationFrame(() => {
            setCompletionPulse(true)
            pulseTimer = window.setTimeout(
              () => setCompletionPulse(false),
              2_600
            )
          })
        }
      }
      if (!next.attentionEffectEnabled) setCompletionPulse(false)
      setSnapshot(next)
    }

    const unsubscribe = window.hrackFloating.onSnapshot(applySnapshot)
    void window.hrackFloating.getSnapshot().then(applySnapshot)
    return () => {
      cancelled = true
      window.cancelAnimationFrame(pulseFrame)
      window.clearTimeout(pulseTimer)
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
        void window.hrackFloating.resizeToContent(height)
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
      [...snapshot.sessions].sort(
        (left, right) =>
          right.lastActivityAt - left.lastActivityAt ||
          left.sessionId.localeCompare(right.sessionId)
      ),
    [snapshot.sessions]
  )
  const attentionCount = active.filter(
    (session) => session.status === 'needs-you' || session.status === 'error'
  ).length
  const visible = expanded ? active : active.slice(0, COLLAPSED_COUNT)
  const hasMore = active.length > COLLAPSED_COUNT
  const persistentAttention =
    snapshot.attentionEffectEnabled && attentionCount > 0
  const attentionMode = persistentAttention
    ? 'persistent'
    : completionPulse && snapshot.attentionEffectEnabled
      ? 'complete'
      : 'none'

  return (
    <main ref={rootRef} className="box-border w-full p-2">
      <aside
        data-testid="floating-window"
        data-attention={attentionMode}
        className={`w-full select-none overflow-hidden rounded-xl border border-border-default bg-overlay shadow-[0_3px_8px_-4px_rgba(0,0,0,0.28)] ${
          attentionMode === 'persistent'
            ? 'floating-attention-persistent'
            : attentionMode === 'complete'
              ? 'floating-attention-complete'
              : ''
        }`}
      >
        <header className="app-drag-region flex h-8 shrink-0 items-center gap-2 px-2.5">
          <span className="font-brand text-[13px] leading-none text-brand-logo-muted">
            hrack
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
            onClick={() => void window.hrackFloating.disable()}
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
                      void window.hrackFloating.focusSession(
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
