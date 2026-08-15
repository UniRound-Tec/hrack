/**
 * 官方 DSH 页面 document-start bridge。
 *
 * DSH 0.1 没有公开 embedder handle，但完整 Web entry 在创建 Cordis root 前
 * 会把 module table 写到 `__DSH_MODULES__`。这里在页面脚本运行前捕获一次
 * Context root，之后主进程只通过官方 sessions/layout/theme interface 控制。
 * 捕获失败会由 Controller 超时并显式报错，不做 DOM 猜测式降级。
 */

import { contextBridge, ipcRenderer } from 'electron'
import { DSH_SURFACE_ACTIVE_SESSION_REPORT_CHANNEL } from '../../shared/dsh-ipc'

const requestedLocale = process.argv
  .find((arg) => arg.startsWith('--vibing-dsh-locale='))
  ?.slice('--vibing-dsh-locale='.length)
const locale = requestedLocale === 'en' ? 'en' : 'zh'

contextBridge.exposeInMainWorld('__VIBING_DSH_HOST_BRIDGE__', {
  reportActiveSession: (value: unknown): void => {
    ipcRenderer.send(
      DSH_SURFACE_ACTIVE_SESSION_REPORT_CHANNEL,
      typeof value === 'string' ? value : null
    )
  }
})

function installMainWorldBridge(): void {
  contextBridge.executeInMainWorld({
    args: [locale],
    func: (requested: 'zh' | 'en') => {
      const state: {
        ctx?: { get(name: string): unknown }
        captureError?: string
        sidebarDefaultApplied: boolean
        themeDisposer?: () => void
        themeObserver?: unknown
        colorScheme?: 'light' | 'dark'
        activeSessionDisposer?: () => void
        reportActiveSession?: () => void
        activeSessionReported?: boolean
        lastReportedActiveSession?: string | null
      } = {
        sidebarDefaultApplied: false
      }
      Object.defineProperty(globalThis, '__VIBING_DSH_EMBED__', {
        configurable: false,
        enumerable: false,
        value: state
      })

      try {
        Object.defineProperty(Navigator.prototype, 'language', {
          configurable: true,
          get: () => requested
        })
        Object.defineProperty(Navigator.prototype, 'languages', {
          configurable: true,
          get: () => [requested]
        })
      } catch (error) {
        state.captureError = `locale bridge: ${String(error)}`
      }

      let modules: unknown
      Object.defineProperty(globalThis, '__DSH_MODULES__', {
        configurable: true,
        enumerable: false,
        get: () => modules,
        set: (value: unknown) => {
          modules = value
          try {
            const seed = (
              value as {
                seed?: { get?: (name: string) => unknown }
              }
            )?.seed
            const cordis = seed?.get?.('@deepseek-ai/cordis') as
              | { Context?: { prototype?: Record<string, unknown> } }
              | undefined
            const proto = cordis?.Context?.prototype
            const original = proto?.['extend'] as
              | ((...args: unknown[]) => unknown)
              | undefined
            if (typeof original !== 'function') {
              throw new Error('Cordis Context.extend is unavailable')
            }
            if (
              (original as unknown as { __vibingDshCapture?: boolean })
                .__vibingDshCapture === true
            ) {
              return
            }
            const capture = function (
              this: { get(name: string): unknown },
              ...args: unknown[]
            ): unknown {
              state.ctx ??= this
              return original.apply(this, args)
            }
            Object.defineProperty(capture, '__vibingDshCapture', {
              value: true
            })
            proto!['extend'] = capture
          } catch (error) {
            state.captureError = `runtime bridge: ${String(error)}`
          }
        }
      })
    }
  })
}

try {
  installMainWorldBridge()
} catch (error) {
  console.error('[dsh-surface-preload] bridge install failed', error)
}
