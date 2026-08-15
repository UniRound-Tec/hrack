import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from 'react'
import type {
  DshSurfaceBounds,
  DshSurfaceSnapshot
} from '../../shared/dsh-ipc'
import { createDshSurfaceAppearance } from '../dsh/themeBridge'
import { useSettingsStore } from '../state/settingsStore'
import {
  builtInLightTheme,
  getUiThemeRegistry,
  useThemeRegistryVersion
} from './themeRuntime'
import { useStrings } from './i18n'

interface DshPageProps {
  /** Stable Vibing identity created only from Home. */
  slotId: string | null
  /** Official DSH session currently bound to this slot. */
  adapterSessionId?: string
  active: boolean
  /** Native child views sit above renderer portals, so dialogs explicitly hide it. */
  obscured: boolean
}

function sameBounds(
  left: DshSurfaceBounds | null,
  right: DshSurfaceBounds
): boolean {
  return (
    left?.x === right.x &&
    left.y === right.y &&
    left.width === right.width &&
    left.height === right.height
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
  obscured
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
  const uiThemeId = useSettingsStore((state) => state.uiThemeId)
  const language = useSettingsStore((state) => state.language)
  const dshScale = useSettingsStore((state) => state.dshScale)
  const themeVersion = useThemeRegistryVersion((state) => state.version)
  const appearance = useMemo(() => {
    const theme = getUiThemeRegistry().get(uiThemeId) ?? builtInLightTheme
    return createDshSurfaceAppearance(theme, language, dshScale)
  }, [uiThemeId, language, dshScale, themeVersion])
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
          height: rect.height
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
  }, [active])

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
  }, [shouldShow, slotId, adapterSessionId, hasBounds, appearance, retry])

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
      className="absolute inset-0 flex h-full flex-col overflow-hidden bg-content"
      style={{ display: active ? 'flex' : 'none' }}
    >
      <div ref={containerRef} className="min-h-0 flex-1 overflow-hidden" />
      {shouldShow && snapshot.phase !== 'ready' && (
        <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-content">
          {snapshot.phase === 'failed' ? (
            <>
              <span className="text-sm text-status-exited">
                {strings.dsh.bootFailed}
              </span>
              <pre className="max-w-2xl overflow-auto rounded-lg bg-surface-strong p-3 text-xs text-text-muted">
                {snapshot.error}
              </pre>
              <button
                type="button"
                data-testid="dsh-surface-retry"
                className="rounded-md bg-surface-strong px-3 py-1.5 text-xs text-text-primary"
                onClick={() => setRetry((value) => value + 1)}
              >
                {strings.dsh.refresh}
              </button>
            </>
          ) : (
            <>
              <span className="text-sm text-text-secondary">
                {strings.dsh.booting}
              </span>
              <span className="text-xs text-text-faint">
                {strings.dsh.bootHostInit}
              </span>
            </>
          )}
        </div>
      )}
    </section>
  )
}
