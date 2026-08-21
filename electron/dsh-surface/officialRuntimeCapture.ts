/**
 * Official DSH page document-start capture. Serialized into the page world via
 * `executeInMainWorld`, so `installOfficialRuntimeCapture` must close over
 * nothing and call no other module functions.
 *
 * DSH 0.1.0-rc.6 writes the module table to `__DSH_MODULES__` before creating
 * the Cordis root. 0.1.0-rc.7+ installs `window.__ModuleLoader__` and seeds
 * Cordis through `create({ staticModules })`. Both paths patch
 * `Context.prototype.extend` once so HRack can drive sessions/layout/theme.
 */

export interface HrackDshEmbedState {
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
}

/** Installed in the official DSH page world at document-start. */
export function installOfficialRuntimeCapture(
  requested: 'zh' | 'en'
): HrackDshEmbedState {
  const state: HrackDshEmbedState = {
    sidebarDefaultApplied: false
  }
  Object.defineProperty(globalThis, '__HRACK_DSH_EMBED__', {
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

  const patchContextExtend = (cordis: {
    Context?: { prototype?: Record<string, unknown> }
  } | undefined): void => {
    const proto = cordis?.Context?.prototype
    const original = proto?.['extend'] as
      | ((...args: unknown[]) => unknown)
      | undefined
    if (typeof original !== 'function') {
      throw new Error('Cordis Context.extend is unavailable')
    }
    if (
      (original as unknown as { __hrackDshCapture?: boolean })
        .__hrackDshCapture === true
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
    Object.defineProperty(capture, '__hrackDshCapture', { value: true })
    proto!['extend'] = capture
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
        patchContextExtend(
          seed?.get?.('@deepseek-ai/cordis') as
            | { Context?: { prototype?: Record<string, unknown> } }
            | undefined
        )
      } catch (error) {
        state.captureError = `runtime bridge: ${String(error)}`
      }
    }
  })

  let moduleLoader: unknown
  Object.defineProperty(globalThis, '__ModuleLoader__', {
    configurable: true,
    enumerable: false,
    get: () => moduleLoader,
    set: (value: unknown) => {
      moduleLoader = value
      try {
        if (typeof value !== 'object' || value === null) {
          throw new Error('window.__ModuleLoader__ is unavailable')
        }
        const loader = value as {
          create?: (
            this: unknown,
            options: { staticModules?: Record<string, unknown> },
            ...rest: unknown[]
          ) => unknown
        }
        const originalCreate = loader.create
        if (typeof originalCreate !== 'function') {
          throw new Error('window.__ModuleLoader__.create is unavailable')
        }
        if (
          (originalCreate as unknown as { __hrackDshCapture?: boolean })
            .__hrackDshCapture === true
        ) {
          return
        }
        const captureCreate = function (
          this: unknown,
          options: { staticModules?: Record<string, unknown> },
          ...rest: unknown[]
        ): unknown {
          try {
            patchContextExtend(
              options?.staticModules?.['@deepseek-ai/cordis'] as
                | { Context?: { prototype?: Record<string, unknown> } }
                | undefined
            )
          } catch (error) {
            state.captureError = `runtime bridge: ${String(error)}`
          }
          return originalCreate.apply(this, [options, ...rest])
        }
        Object.defineProperty(captureCreate, '__hrackDshCapture', {
          value: true
        })
        loader.create = captureCreate
      } catch (error) {
        state.captureError = `runtime bridge: ${String(error)}`
      }
    }
  })

  return state
}
