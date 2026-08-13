import { useEffect, useRef, useState } from 'react'
import type { DshSurfaceHandle } from '../dsh/bootDsh'
import type { DshHostStatus } from '../../shared/dsh-ipc'

type BootPhase =
  | { kind: 'booting' }
  | { kind: 'ready' }
  | { kind: 'failed'; message: string }

/**
 * DSH 页（P0 验证形态）：整页挂载官方 dsh web GUI。
 *
 * P1 将替换为 vibing 原生壳层：lobby（历史会话/新建/设置入口）+ 侧边栏
 * 会话卡片 + 页内按 sessionId 打开对话视图；本组件届时只保留容器与
 * host 生命周期门控。
 */
export default function DshPage() {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const [phase, setPhase] = useState<BootPhase>({ kind: 'booting' })
  const [hostStatus, setHostStatus] = useState<DshHostStatus | null>(null)

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    let disposed = false
    let handle: DshSurfaceHandle | null = null
    const unsubscribe = window.dshApi.onStatusChanged((status) => {
      if (!disposed) setHostStatus(status)
    })
    void (async () => {
      try {
        const { bootDshSurface } = await import('../dsh/bootDsh')
        if (disposed) return
        handle = await bootDshSurface(container)
        if (disposed) {
          handle.dispose()
          return
        }
        setPhase({ kind: 'ready' })
      } catch (error) {
        if (!disposed) {
          setPhase({
            kind: 'failed',
            message:
              error instanceof Error
                ? `${error.message}\n${error.stack ?? ''}`
                : String(error)
          })
        }
      }
    })()
    return () => {
      disposed = true
      unsubscribe()
      handle?.dispose()
    }
  }, [])

  return (
    <section
      data-testid="dsh-page"
      className="relative flex h-full flex-col overflow-hidden"
    >
      {phase.kind !== 'ready' && (
        <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-app">
          {phase.kind === 'booting' ? (
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
          ) : (
            <>
              <span className="text-sm text-status-exited">
                DSH 启动失败
              </span>
              <pre className="max-w-2xl overflow-auto rounded-lg bg-surface-strong p-3 text-xs text-text-muted">
                {phase.message}
              </pre>
            </>
          )}
        </div>
      )}
      <div ref={containerRef} className="min-h-0 flex-1 overflow-hidden" />
    </section>
  )
}
