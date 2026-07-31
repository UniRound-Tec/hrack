import { WebglAddon } from '@xterm/addon-webgl'
import type { Terminal } from '@xterm/xterm'

export type RendererKind = 'webgl' | 'dom'

export interface RendererEvent {
  kind: RendererKind
  reason: string
  at: number
}

export interface RendererController {
  kind(): RendererKind
  events(): RendererEvent[]
  activate(): void
  deactivate(reason?: string): void
  forceContextLoss(): boolean
  dispose(): void
}

export function createRendererController(
  term: Terminal
): RendererController {
  let addon: WebglAddon | null = null
  let disposed = false
  const rendererEvents: RendererEvent[] = []

  const record = (kind: RendererKind, reason: string): void => {
    rendererEvents.push({ kind, reason, at: performance.now() })
    if (rendererEvents.length > 100) rendererEvents.shift()
  }

  const release = (reason: string): void => {
    if (!addon) return
    const current = addon
    addon = null
    current.dispose()
    record('dom', reason)
  }

  return {
    kind: () => (addon ? 'webgl' : 'dom'),
    events: () => rendererEvents.map((event) => ({ ...event })),
    activate() {
      if (disposed || addon) return
      let candidate: WebglAddon | null = null
      try {
        candidate = new WebglAddon()
        candidate.onContextLoss(() => {
          if (addon !== candidate) return
          release('context-loss')
        })
        term.loadAddon(candidate)
        addon = candidate
        record('webgl', 'tab-active')
      } catch (error) {
        candidate?.dispose()
        record(
          'dom',
          `webgl-unavailable: ${error instanceof Error ? error.message : String(error)}`
        )
      }
    },
    deactivate(reason = 'tab-inactive') {
      release(reason)
    },
    forceContextLoss() {
      if (!addon || !term.element) return false
      const canvases = term.element.querySelectorAll('canvas')
      for (const canvas of canvases) {
        const context = canvas.getContext('webgl2')
        const extension = context?.getExtension('WEBGL_lose_context')
        if (!extension) continue
        extension.loseContext()
        return true
      }
      return false
    },
    dispose() {
      disposed = true
      release('terminal-disposed')
    }
  }
}
