import { useEffect, useRef, useState } from 'react'
import type { DshSurfaceHandle } from '../dsh/bootDsh'
import type { DshHostStatus } from '../../shared/dsh-ipc'

type BootPhase =
  | { kind: 'idle' }
  | { kind: 'booting' }
  | { kind: 'ready' }
  | { kind: 'failed'; message: string }

interface DshPageProps {
  sessionId: string | null
  visible: boolean
}

function isRecoverableDoubleBoot(message: string): boolean {
  return message.includes('double boot') || message.includes('already installed')
}

/**
 * DSH 会话页：host 就绪后挂载官方 web GUI。
 * lobby 由 DshLobbyPage 承担；本组件只负责 surface 与生命周期门控。
 *
 * 官方 GUI 是 page 级单例。本页必须常驻（用 visible 切显示），切会话只
 * 调 sessions.open，绝不能卸掉再 boot。
 */
export default function DshPage({ sessionId, visible }: DshPageProps) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const readyRef = useRef(false)
  const [phase, setPhase] = useState<BootPhase>({ kind: 'idle' })
  const [hostStatus, setHostStatus] = useState<DshHostStatus | null>(null)

  useEffect(() => {
    if (!sessionId) return
    const container = containerRef.current
    if (!container) return
    let disposed = false
    let handle: DshSurfaceHandle | null = null
    const unsubscribe = window.dshApi.onStatusChanged((status) => {
      if (!disposed) setHostStatus(status)
    })
    void (async () => {
      try {
        if (!readyRef.current) setPhase({ kind: 'booting' })
        const { bootDshSurface } = await import('../dsh/bootDsh')
        if (disposed) return
        handle = await bootDshSurface(container)
        if (disposed) return
        await handle.openSession(sessionId)
        if (disposed) return
        readyRef.current = true
        setPhase({ kind: 'ready' })
      } catch (error) {
        if (disposed) return
        if (readyRef.current) {
          console.error('dsh session switch failed', error)
          return
        }
        setPhase({
          kind: 'failed',
          message:
            error instanceof Error
              ? `${error.message}\n${error.stack ?? ''}`
              : String(error)
        })
      }
    })()
    return () => {
      disposed = true
      unsubscribe()
    }
  }, [sessionId])

  return (
    <section
      data-testid="dsh-page"
      data-dsh-session={sessionId ?? ''}
      className="absolute inset-0 flex h-full flex-col overflow-hidden"
      style={{ display: visible ? 'flex' : 'none' }}
    >
      {phase.kind !== 'ready' && visible && (
        <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-app">
          {phase.kind === 'failed' ? (
            <>
              <span className="text-sm text-status-exited">
                DSH 启动失败
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
                  重新加载窗口
                </button>
              )}
            </>
          ) : (
            <>
              <span className="text-sm text-text-secondary">
                正在启动 DeepSeek Harness…
              </span>
              <span className="text-xs text-text-faint">
                {hostStatus?.state === 'starting'
                  ? 'dsh host 首次启动需要初始化 profile'
                  : hostStatus?.state ?? 'stopped'}
              </span>
            </>
          )}
        </div>
      )}
      <div ref={containerRef} className="min-h-0 flex-1 overflow-hidden" />
    </section>
  )
}
