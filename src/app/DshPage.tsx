import { useEffect, useRef, useState } from 'react'
import { useStrings } from './i18n'
import type { DshSurfaceHandle, DshSurfaceMode } from '../dsh/bootDsh'
import type { DshHostStatus } from '../../shared/dsh-ipc'

type BootPhase =
  | { kind: 'idle' }
  | { kind: 'booting' }
  | { kind: 'ready' }
  | { kind: 'failed'; message: string }

interface DshPageProps {
  sessionId: string | null
  mode: Exclude<DshSurfaceMode, 'settings'>
}

function isRecoverableDoubleBoot(message: string): boolean {
  return message.includes('double boot') || message.includes('already installed')
}

/**
 * DSH 域内页：官方 GUI 单例常驻，用 mode 切会话 / 设置。
 * 大厅仍由 DshLobbyPage 承担；本页不再露出官方侧栏。
 *
 * 懒启动：首次可见（mode !== 'hidden'）才 boot，之后不再重入——官方 surface
 * 是 renderer 进程单例。sessionId 变化只调 openSession，mode 变化只调
 * setMode；openSession 失败要在覆盖层可见，不能只 console.error 后停在
 * 上一个会话。
 */
export default function DshPage({
  sessionId,
  mode
}: DshPageProps) {
  const strings = useStrings()
  const containerRef = useRef<HTMLDivElement | null>(null)
  const bootStartedRef = useRef(false)
  const handleRef = useRef<DshSurfaceHandle | null>(null)
  /** 最近一次发起 openSession 的目标，用于丢弃过期 rejection。 */
  const openSessionIdRef = useRef<string | null>(null)
  const [phase, setPhase] = useState<BootPhase>({ kind: 'idle' })
  const [openError, setOpenError] = useState<string | null>(null)
  const [hostStatus, setHostStatus] = useState<DshHostStatus | null>(null)
  const visible = mode !== 'hidden'

  useEffect(() => {
    document.documentElement.dataset.dshSurface = mode
    return () => {
      if (document.documentElement.dataset.dshSurface === mode) {
        document.documentElement.dataset.dshSurface = 'hidden'
      }
    }
  }, [mode])

  // 懒启动 + 一次性 boot：不随 sessionId/mode 重入。
  useEffect(() => {
    if (!visible || bootStartedRef.current) return
    bootStartedRef.current = true
    let disposed = false
    const unsubscribe = window.dshApi.onStatusChanged((status) => {
      if (!disposed) setHostStatus(status)
    })
    void (async () => {
      try {
        setPhase({ kind: 'booting' })
        const { bootDshSurface } = await import('../dsh/bootDsh')
        if (disposed) return
        const handle = await bootDshSurface(containerRef.current!)
        if (disposed) return
        handleRef.current = handle
        setPhase({ kind: 'ready' })
      } catch (error) {
        if (disposed) return
        setPhase({
          kind: 'failed',
          message: error instanceof Error ? error.message : String(error)
        })
        console.error('dsh surface boot failed', error)
      }
    })()
    return () => {
      disposed = true
      unsubscribe()
    }
  }, [visible])

  // sessionId / mode 变化：boot 完成后分别驱动 setMode 与 openSession。
  useEffect(() => {
    if (phase.kind !== 'ready') return
    const handle = handleRef.current
    if (!handle) return
    setOpenError(null)
    handle.setMode(mode)
    if (mode === 'session' && sessionId) {
      // A 会话的迟到 rejection 不应给 B 会话的界面报错。
      openSessionIdRef.current = sessionId
      const requested = sessionId
      handle
        .openSession(requested)
        .catch((error) => {
          if (openSessionIdRef.current !== requested) return
          console.error('dsh surface openSession failed', error)
          setOpenError(
            error instanceof Error ? error.message : String(error)
          )
        })
    }
  }, [mode, sessionId, phase.kind])

  return (
    <section
      data-testid="dsh-page"
      data-dsh-session={sessionId ?? ''}
      data-dsh-mode={mode}
      className="absolute inset-0 flex h-full flex-col overflow-hidden"
      style={{ display: visible ? 'flex' : 'none' }}
    >
      {phase.kind !== 'ready' && visible && (
        <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-app">
          {phase.kind === 'failed' ? (
            <>
              <span className="text-sm text-status-exited">
                {strings.dsh.bootFailed}
              </span>
              <pre className="max-w-2xl overflow-auto rounded-lg bg-surface-strong p-3 text-xs text-text-muted">
                {phase.message}
              </pre>
              {isRecoverableDoubleBoot(phase.message) && (
                <button
                  type="button"
                  data-testid="dsh-reload"
                  className="rounded-md bg-surface-strong px-3 py-1.5 text-xs text-text-primary"
                  onClick={() => window.location.reload()}
                >
                  {strings.dsh.bootReload}
                </button>
              )}
            </>
          ) : (
            <>
              <span className="text-sm text-text-secondary">
                {strings.dsh.booting}
              </span>
              <span className="text-xs text-text-faint">
                {hostStatus?.state === 'starting'
                  ? strings.dsh.bootHostInit
                  : hostStatus?.state ?? 'stopped'}
              </span>
            </>
          )}
        </div>
      )}
      {openError && visible && phase.kind === 'ready' && (
        <div className="absolute inset-x-0 top-0 z-10 flex items-center justify-between gap-3 border-b border-border-subtle bg-surface px-4 py-2">
          <span className="truncate font-pingfang text-[12px] text-status-error">
            {openError}
          </span>
          <button
            type="button"
            className="shrink-0 rounded-md px-2 py-1 font-pingfang text-[11px] text-text-muted hover:bg-surface-strong"
            onClick={() => setOpenError(null)}
          >
            {strings.common.close}
          </button>
        </div>
      )}
      <div ref={containerRef} className="min-h-0 flex-1 overflow-hidden" />
    </section>
  )
}
