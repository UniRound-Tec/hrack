import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from 'react'
import { Check, Copy } from 'lucide-react'
import { motion, useReducedMotion } from 'motion/react'
import DeepSeekText from '@lobehub/icons/es/DeepSeek/components/Text'
import type {
  DshSurfaceBounds,
  DshSurfaceSnapshot
} from '../../shared/dsh-ipc'
import { useSettingsStore } from '../state/settingsStore'
import { useStrings } from './i18n'

interface DshPageProps {
  /** Stable HRack identity created only from Home. */
  slotId: string | null
  /** Official DSH session currently bound to this slot. */
  adapterSessionId?: string
  active: boolean
  /** Native child views sit above renderer portals, so dialogs explicitly hide it. */
  obscured: boolean
  /** Host restart is in flight; keep the loading overlay above the empty native view. */
  hostRestarting?: boolean
  /** Snapshot returned after a host kill-and-relaunch finishes. */
  restartSnapshot?: DshSurfaceSnapshot | null
}

function sameBounds(
  left: DshSurfaceBounds | null,
  right: DshSurfaceBounds
): boolean {
  return (
    left?.x === right.x &&
    left.y === right.y &&
    left.width === right.width &&
    left.height === right.height &&
    left.cornerRadius === right.cornerRadius
  )
}

interface DshBootScreenProps {
  label: string
  detail: string
}

function DshBootScreen({ label, detail }: DshBootScreenProps) {
  const reducedMotion = useReducedMotion()
  const progress = reducedMotion
    ? 0.72
    : [0.06, 0.24, 0.45, 0.64, 0.78, 0.88, 0.92]

  return (
    <div
      data-testid="dsh-surface-loading"
      aria-busy="true"
      aria-live="polite"
      className="flex flex-col items-center"
    >
      <div
        data-testid="dsh-surface-brand"
        role="img"
        aria-label="DeepSeek"
        className="relative h-10 w-[218px] text-brand-logo select-none"
      >
        <DeepSeekText
          aria-hidden="true"
          size="100%"
          className="h-full w-full"
        />
        <motion.span
          aria-hidden="true"
          className="absolute inset-0 block text-brand-logo-shine blur-[0.35px]"
          initial={false}
          animate={
            reducedMotion
              ? { opacity: 0 }
              : {
                  opacity: 1,
                  clipPath: [
                    'polygon(-32% 0, -8% 0, -18% 100%, -42% 100%)',
                    'polygon(142% 0, 166% 0, 156% 100%, 132% 100%)'
                  ]
                }
          }
          transition={
            reducedMotion
              ? { duration: 0 }
              : { duration: 3.2, ease: 'linear', repeat: Infinity }
          }
        >
          <DeepSeekText size="100%" className="h-full w-full" />
        </motion.span>
      </div>
      <span className="mt-5 text-sm text-text-secondary">{label}</span>
      <div
        data-testid="dsh-surface-progress"
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuetext={detail}
        className="mt-3 h-1 w-64 max-w-[55vw] overflow-hidden rounded-full bg-surface-strong"
      >
        <motion.span
          data-testid="dsh-surface-progress-fill"
          className="block h-full w-full origin-left rounded-full"
          initial={{ scaleX: reducedMotion ? 0.72 : 0.06 }}
          animate={{ scaleX: progress }}
          transition={
            reducedMotion
              ? { duration: 0 }
              : {
                  duration: 18,
                  ease: 'easeOut',
                  times: [0, 0.08, 0.2, 0.38, 0.58, 0.78, 1]
                }
          }
          style={{
            background:
              'linear-gradient(90deg, var(--hrack-brand-logoMuted), var(--hrack-brand-logoShine) 72%, var(--hrack-brand-logo))',
            boxShadow:
              '0 0 12px color-mix(in srgb, var(--hrack-brand-logoShine) 40%, transparent)'
          }}
        />
      </div>
      <span className="mt-2 text-xs text-text-faint">{detail}</span>
    </div>
  )
}

/**
 * Renderer half of the official-page adapter. This component owns only a
 * measured rectangle plus loading/error UI. DSH's DOM, styles and portals live
 * in the main-process WebContentsView and are controlled through semantic IPC.
 */
export default function DshPage({
  slotId,
  adapterSessionId,
  active,
  obscured,
  hostRestarting = false,
  restartSnapshot = null
}: DshPageProps) {
  const strings = useStrings()
  const containerRef = useRef<HTMLDivElement | null>(null)
  const requestRef = useRef(0)
  const [bounds, setBounds] = useState<DshSurfaceBounds | null>(null)
  const [snapshot, setSnapshot] = useState<DshSurfaceSnapshot>({
    phase: 'hidden',
    visible: false
  })
  const [retry, setRetry] = useState(0)
  const [errorCopied, setErrorCopied] = useState(false)
  const language = useSettingsStore((state) => state.language)
  const dshScale = useSettingsStore((state) => state.dshScale)
  const rounded = useSettingsStore((state) => state.terminalRounded)
  const appearance = useMemo(
    () => ({
      locale: language.startsWith('zh') ? ('zh' as const) : ('en' as const),
      scale: dshScale
    }),
    [language, dshScale]
  )
  const mode = active && slotId ? 'slot' : 'hidden'
  const shouldShow = active && slotId !== null && !obscured
  const hasBounds = bounds !== null

  useEffect(() => {
    document.documentElement.dataset.dshSurface = mode
    return () => {
      if (document.documentElement.dataset.dshSurface === mode) {
        document.documentElement.dataset.dshSurface = 'hidden'
      }
    }
  }, [mode])

  useLayoutEffect(() => {
    const element = containerRef.current
    if (!element) return
    let frame: number | null = null
    const measure = (): void => {
      if (frame !== null) return
      frame = requestAnimationFrame(() => {
        frame = null
        const rect = element.getBoundingClientRect()
        if (rect.width < 1 || rect.height < 1) return
        const next = {
          x: Math.max(0, rect.left),
          y: Math.max(0, rect.top),
          width: rect.width,
          height: rect.height,
          cornerRadius: rounded ? 20 : 0
        }
        setBounds((current) => (sameBounds(current, next) ? current : next))
      })
    }
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    window.addEventListener('resize', measure)
    measure()
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', measure)
      if (frame !== null) cancelAnimationFrame(frame)
    }
  }, [active, rounded])

  // Semantic changes rebuild/show the official surface. Bounds changes use the
  // separate high-frequency channel below and intentionally do not retrigger it.
  useEffect(() => {
    if (!shouldShow || !hasBounds) return
    const request = ++requestRef.current
    setSnapshot({
      phase: 'loading',
      visible: false,
      slotId: slotId ?? undefined,
      sessionId: adapterSessionId,
      bounds: bounds ?? undefined
    })
    void window.dshSurfaceApi
      .show({
        slotId: slotId!,
        intent: adapterSessionId ? 'resume' : 'new',
        ...(adapterSessionId ? { sessionId: adapterSessionId } : {}),
        bounds: bounds!,
        appearance
      })
      .then((next) => {
        if (request === requestRef.current) setSnapshot(next)
      })
      .catch((error) => {
        if (request !== requestRef.current) return
        setSnapshot({
          phase: 'failed',
          visible: false,
          slotId: slotId ?? undefined,
          sessionId: adapterSessionId,
          error: error instanceof Error ? error.message : String(error)
        })
      })
    // `bounds` is deliberately represented by hasBounds here; later geometry
    // updates flow through setBounds without reopening the DSH session.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    shouldShow,
    slotId,
    adapterSessionId,
    hasBounds,
    appearance,
    retry
  ])

  useEffect(() => {
    if (!shouldShow || !bounds) return
    void window.dshSurfaceApi.setBounds(bounds)
  }, [shouldShow, bounds])

  useEffect(() => {
    if (shouldShow) return
    ++requestRef.current
    setSnapshot({ phase: 'hidden', visible: false })
    void window.dshSurfaceApi.hide()
  }, [shouldShow])

  useEffect(() => {
    if (!hostRestarting || !shouldShow) return
    setSnapshot({
      phase: 'loading',
      visible: false,
      slotId: slotId ?? undefined,
      sessionId: adapterSessionId
    })
  }, [hostRestarting, shouldShow, slotId, adapterSessionId])

  useEffect(() => {
    if (restartSnapshot) setSnapshot(restartSnapshot)
  }, [restartSnapshot])

  useEffect(
    () => () => {
      ++requestRef.current
      void window.dshSurfaceApi.hide()
    },
    []
  )

  return (
    <section
      data-testid="dsh-page"
      data-dsh-slot={slotId ?? ''}
      data-dsh-session={adapterSessionId ?? ''}
      data-dsh-mode={mode}
      data-dsh-surface-phase={snapshot.phase}
      className={`absolute inset-0 flex h-full flex-col overflow-hidden bg-content ${
        rounded ? 'rounded-tl-[20px]' : ''
      }`}
      style={{ display: active ? 'flex' : 'none' }}
    >
      <div
        ref={containerRef}
        data-testid="dsh-surface-frame"
        className="min-h-0 flex-1 overflow-hidden"
      />
      {shouldShow && (hostRestarting || snapshot.phase !== 'ready') && (
        <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-content">
          {snapshot.phase === 'failed' && !hostRestarting ? (
            <>
              <span className="text-sm text-status-exited">
                {strings.dsh.bootFailed}
              </span>
              <pre
                data-testid="dsh-surface-error"
                className="app-no-drag max-h-64 max-w-2xl overflow-auto rounded-lg bg-surface-strong p-3 text-left text-xs text-text-muted whitespace-pre-wrap break-all select-text cursor-text"
              >
                {snapshot.error}
              </pre>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  data-testid="dsh-surface-copy-error"
                  disabled={!snapshot.error}
                  className="inline-flex items-center gap-1.5 rounded-md bg-surface-strong px-3 py-1.5 text-xs text-text-primary disabled:opacity-50"
                  onClick={() => {
                    if (!snapshot.error) return
                    void window.clipboardApi.writeText(snapshot.error).then(() => {
                      setErrorCopied(true)
                      window.setTimeout(() => setErrorCopied(false), 1_500)
                    })
                  }}
                >
                  {errorCopied ? (
                    <Check className="size-3 text-status-done" strokeWidth={1.75} />
                  ) : (
                    <Copy className="size-3" strokeWidth={1.75} />
                  )}
                  {errorCopied ? strings.dsh.errorCopied : strings.dsh.copyError}
                </button>
                <button
                  type="button"
                  data-testid="dsh-surface-retry"
                  className="rounded-md bg-surface-strong px-3 py-1.5 text-xs text-text-primary"
                  onClick={() => setRetry((value) => value + 1)}
                >
                  {strings.dsh.refresh}
                </button>
              </div>
            </>
          ) : (
            <DshBootScreen
              label={
                hostRestarting ? strings.dsh.restarting : strings.dsh.booting
              }
              detail={strings.dsh.bootHostInit}
            />
          )}
        </div>
      )}
    </section>
  )
}
