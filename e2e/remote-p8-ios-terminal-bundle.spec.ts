import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, test } from '@playwright/test'

const appRoot = process.env.HRACK_REMOTE_APP_ROOT

interface TerminalReadyMessage {
  type: 'ready'
  fontReady: boolean
  blockFixture: boolean
  cjkDoubleWidth: boolean
  renderer: 'webgl' | 'dom' | 'unknown'
  cols: number
  rows: number
}

test.describe('remote P8 iOS single-file terminal bundle', () => {
  test.skip(
    !appRoot,
    'set HRACK_REMOTE_APP_ROOT to verify the generated iOS terminal asset'
  )

  test('loads offline, measures glyphs and survives renderer fallback', async ({
    page
  }, testInfo) => {
    if (!appRoot) throw new Error('missing remote App root')
    const indexPath = resolve(
      appRoot,
      'assets',
      'hrack-terminal-ios',
      'index.html'
    )
    expect(existsSync(indexPath)).toBe(true)

    const networkRequests: string[] = []
    page.on('request', (request) => {
      if (!request.url().startsWith('file:')) networkRequests.push(request.url())
    })
    await page.addInitScript(() => {
      const messages: unknown[] = []
      Object.defineProperty(window, '__hrackNativeMessages', {
        configurable: false,
        value: messages
      })
      Object.defineProperty(window, 'ReactNativeWebView', {
        configurable: false,
        value: {
          postMessage(value: string) {
            try {
              messages.push(JSON.parse(value))
            } catch {
              messages.push(value)
            }
          }
        }
      })
    })

    await page.goto(pathToFileURL(indexPath).href)
    await expect
      .poll(
        () =>
          page.evaluate(() => {
            const messages = (
              window as typeof window & { __hrackNativeMessages?: unknown[] }
            ).__hrackNativeMessages
            return (
              messages?.find(
                (message): message is TerminalReadyMessage =>
                  !!message &&
                  typeof message === 'object' &&
                  (message as { type?: unknown }).type === 'ready'
              ) ?? null
            )
          }),
        { timeout: 20_000 }
      )
      .not.toBeNull()

    const report = (await page.evaluate(() => {
      const messages = (
        window as typeof window & { __hrackNativeMessages?: unknown[] }
      ).__hrackNativeMessages
      return messages?.find(
        (message) =>
          !!message &&
          typeof message === 'object' &&
          (message as { type?: unknown }).type === 'ready'
      )
    })) as TerminalReadyMessage
    expect(report).toMatchObject({
      type: 'ready',
      fontReady: true,
      blockFixture: true,
      cjkDoubleWidth: true
    })
    expect(['webgl', 'dom']).toContain(report.renderer)
    expect(report.cols).toBeGreaterThan(20)
    expect(report.rows).toBeGreaterThan(10)
    expect(networkRequests).toEqual([])
    await page.screenshot({
      path: testInfo.outputPath('p8-ios-single-file-terminal.png')
    })

    await page.evaluate(() => {
      ;(
        window as typeof window & {
          hrackPreflight?: { receive(command: unknown): void }
        }
      ).hrackPreflight?.receive({ type: 'force-fallback' })
    })
    await expect
      .poll(() =>
        page.evaluate(() => {
          const messages = (
            window as typeof window & { __hrackNativeMessages?: unknown[] }
          ).__hrackNativeMessages
          return messages?.some(
            (message) =>
              !!message &&
              typeof message === 'object' &&
              (message as { type?: unknown }).type === 'renderer' &&
              (message as { kind?: unknown }).kind === 'dom'
          )
        })
      )
      .toBe(true)
    expect(networkRequests).toEqual([])
  })
})
