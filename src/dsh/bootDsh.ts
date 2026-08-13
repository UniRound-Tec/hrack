/**
 * dsh web surface 的装配启动。
 *
 * 官方 ClientModuleSystem 会把 window.__ModuleLoader__ 装到 page 上，
 * 且 AppWebEntry.dispose() 只卸 React 根、不拆 loader。因此 surface
 * 必须是 renderer 进程单例：第一次 boot，之后只 attach 到当前容器，
 * 用 ctx.sessions.open 切会话。绝不能按 DshPage 挂载次数重跑 run()。
 *
 * 流程（对齐上游 apps/web/tests/assembled-boot.ts 的自装配形态）：
 * 1. 确保 host 就绪，经主进程取回 host 注入的 __DSH_BOOT__ 清单
 * 2. loadBundle：经 wire 通道从 host 取回 /plugins/<id>/client.js。
 *    dsh-client-connection 走 IPC 替换件；其余 bundle eval 注册 factory
 * 3. AppWebEntry 跑 two-stage boot，渲染完整 dsh GUI 到稳定 host 节点
 */

import { AppWebEntry } from '@deepseek-ai/dsh-client-web'
import { installIpcConnectionBundle, isDshConnectionBundle } from './ipcConnection'

export interface DshSurfaceHandle {
  openSession(sessionId: string): Promise<void>
  dispose(): void
}

interface SessionsFace {
  open(id: string): void
  list?: {
    getSnapshot(): unknown
    subscribe(fn: () => void): () => void
  }
}

interface EntryInternals {
  ctx?: { get(name: string): unknown }
}

interface SurfaceRuntime {
  host: HTMLDivElement
  entry: AppWebEntry
}

const SURFACE_KEY = '__VIBING_DSH_SURFACE__'
const OPEN_WAIT_MS = 15_000

type SurfaceWindow = Window & {
  [SURFACE_KEY]?: SurfaceRuntime
  __ModuleLoader__?: unknown
}

const holding = document.createDocumentFragment()
let bootPromise: Promise<DshSurfaceHandle> | null = null
let openGeneration = 0

function surfaceWindow(): SurfaceWindow {
  return window as SurfaceWindow
}

function readRuntime(): SurfaceRuntime | undefined {
  return surfaceWindow()[SURFACE_KEY]
}

function writeRuntime(runtime: SurfaceRuntime): void {
  surfaceWindow()[SURFACE_KEY] = runtime
}

function surfaceHost(): HTMLDivElement {
  const existing = readRuntime()?.host
  if (existing) return existing
  const host = document.createElement('div')
  host.dataset.dshSurfaceHost = ''
  host.className = 'h-full w-full min-h-0 overflow-hidden'
  return host
}

/** 把官方 GUI 的稳定 host 挪进当前 React 容器；不销毁也不重 boot。 */
export function attachDshSurface(container: HTMLElement): HTMLDivElement {
  const host = surfaceHost()
  if (host.parentElement !== container) container.appendChild(host)
  return host
}

function detachDshSurface(): void {
  const host = readRuntime()?.host
  if (host && host.parentElement) holding.appendChild(host)
}

function sessionsFace(entry: AppWebEntry): SessionsFace {
  const ctx = (entry as unknown as EntryInternals).ctx
  const sessions = ctx?.get('sessions') as SessionsFace | undefined
  if (!sessions || typeof sessions.open !== 'function') {
    throw new Error('dsh surface: sessions service unavailable')
  }
  return sessions
}

function listHasSession(snapshot: unknown, sessionId: string): boolean {
  if (snapshot === null || typeof snapshot !== 'object') return false
  const record = snapshot as {
    ids?: unknown
    byId?: unknown
    items?: unknown
    current?: unknown
  }
  if (record.current === sessionId) return true
  if (Array.isArray(record.ids) && record.ids.includes(sessionId)) return true
  if (
    record.byId !== null &&
    typeof record.byId === 'object' &&
    Object.prototype.hasOwnProperty.call(record.byId, sessionId)
  ) {
    return true
  }
  if (Array.isArray(record.items)) {
    return record.items.some((item) => {
      if (item === null || typeof item !== 'object') return false
      const row = item as { sessionId?: unknown; id?: unknown }
      return row.sessionId === sessionId || row.id === sessionId
    })
  }
  return false
}

function waitForListedSession(
  sessions: SessionsFace,
  sessionId: string
): Promise<void> {
  const snapshot = sessions.list?.getSnapshot()
  if (listHasSession(snapshot, sessionId)) return Promise.resolve()
  if (!sessions.list) {
    return Promise.reject(
      new Error(`dsh surface: session ${sessionId} is not listed`)
    )
  }
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      unsubscribe()
      reject(
        new Error(`dsh surface: session ${sessionId} did not appear in time`)
      )
    }, OPEN_WAIT_MS)
    const unsubscribe = sessions.list!.subscribe(() => {
      if (!listHasSession(sessions.list!.getSnapshot(), sessionId)) return
      window.clearTimeout(timer)
      unsubscribe()
      resolve()
    })
  })
}

async function openListedSession(sessionId: string): Promise<void> {
  const runtime = readRuntime()
  if (!runtime) throw new Error('dsh surface is not booted')
  const generation = ++openGeneration
  const sessions = sessionsFace(runtime.entry)
  await waitForListedSession(sessions, sessionId)
  if (generation !== openGeneration) return
  sessions.open(sessionId)
}

function createHandle(): DshSurfaceHandle {
  return {
    openSession: openListedSession,
    dispose: detachDshSurface
  }
}

async function startSurface(container: HTMLElement): Promise<DshSurfaceHandle> {
  const existing = readRuntime()
  if (existing) {
    attachDshSurface(container)
    return createHandle()
  }

  if (surfaceWindow().__ModuleLoader__ !== undefined) {
    throw new Error(
      'DSH official GUI is already booted in this window (double boot). Reload the app to recover.'
    )
  }

  const status = await window.dshApi.ensureStarted()
  if (status.state !== 'ready') {
    throw new Error(status.error ?? 'dsh host is not ready')
  }

  const manifest = await window.dshApi.getBootManifest()
  ;(window as unknown as Record<string, unknown>)['__DSH_BOOT__'] = manifest

  const host = attachDshSurface(container)
  const entry = new AppWebEntry(host, {
    loadBundle: async (url: string) => {
      const response = await window.dshWireApi.fetch({
        requestId: crypto.randomUUID(),
        method: 'GET',
        // url 形如 /plugins/<id>/client.js?rev=<rev>
        path: url
      })
      if (response.status !== 200 || response.body.length === 0) {
        throw new Error(`dsh client bundle ${url} responded ${response.status}`)
      }
      if (isDshConnectionBundle(url)) {
        installIpcConnectionBundle(response.body)
        return
      }
      // 其余 bundle 仍是带 __ModuleLoader__.load banner 的 CJS 包装。
      ;(0, eval)(response.body)
    }
  })
  await entry.run()
  writeRuntime({ host, entry })
  return createHandle()
}

export async function bootDshSurface(
  container: HTMLElement
): Promise<DshSurfaceHandle> {
  if (!bootPromise) {
    bootPromise = startSurface(container).catch((error) => {
      bootPromise = null
      throw error
    })
  } else {
    attachDshSurface(container)
  }
  return bootPromise
}
