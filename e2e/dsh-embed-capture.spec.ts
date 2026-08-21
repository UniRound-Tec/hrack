import { expect, test } from '@playwright/test'
import {
  installOfficialRuntimeCapture,
  type HrackDshEmbedState
} from '../electron/dsh-surface/officialRuntimeCapture'

class FakeContext {
  extend(): this {
    return this
  }

  get(name: string): string {
    return name
  }
}

function embedState(): HrackDshEmbedState {
  return (
    globalThis as unknown as { __HRACK_DSH_EMBED__: HrackDshEmbedState }
  ).__HRACK_DSH_EMBED__
}

test.describe('official DSH runtime capture', () => {
  let language: PropertyDescriptor | undefined
  let languages: PropertyDescriptor | undefined

  test.beforeAll(() => {
    if (typeof Navigator === 'undefined') {
      class NavigatorStub {}
      Object.defineProperty(globalThis, 'Navigator', {
        configurable: true,
        value: NavigatorStub
      })
    }
    language = Object.getOwnPropertyDescriptor(
      Navigator.prototype,
      'language'
    )
    languages = Object.getOwnPropertyDescriptor(
      Navigator.prototype,
      'languages'
    )
    installOfficialRuntimeCapture('zh')
  })

  test.afterEach(() => {
    const state = embedState()
    state.ctx = undefined
    state.captureError = undefined
  })

  test.afterAll(() => {
    if (language) {
      Object.defineProperty(Navigator.prototype, 'language', language)
    }
    if (languages) {
      Object.defineProperty(Navigator.prototype, 'languages', languages)
    }
  })

  test('captures Cordis context from the rc.7+ ModuleLoader seed', () => {
    const loader = {
      create(options: { staticModules?: Record<string, unknown> }) {
        return options
      }
    }
    ;(globalThis as unknown as { __ModuleLoader__: typeof loader })
      .__ModuleLoader__ = loader
    loader.create({
      staticModules: {
        '@deepseek-ai/cordis': { Context: FakeContext }
      }
    })
    const ctx = new FakeContext()
    ctx.extend()
    expect(embedState().ctx).toBe(ctx)
    expect(embedState().captureError).toBeUndefined()
  })

  test('still captures Cordis context from the rc.6 module table', () => {
    ;(
      globalThis as unknown as {
        __DSH_MODULES__: { seed: { get(name: string): unknown } }
      }
    ).__DSH_MODULES__ = {
      seed: {
        get: () => ({ Context: FakeContext })
      }
    }
    const ctx = new FakeContext()
    ctx.extend()
    expect(embedState().ctx).toBe(ctx)
    expect(embedState().captureError).toBeUndefined()
  })
})
