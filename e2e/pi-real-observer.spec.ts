import { expect, test } from '@playwright/test'
import { resolve } from 'node:path'
import { launchApp } from './helpers'

const enabled = process.env.VIBING_E2E_REAL_PI === '1'

function extensionPath(runtime: 'windows' | 'wsl-Ubuntu-22.04'): string {
  const hostPath = resolve('e2e/fixtures/pi/pi-faux-provider.ts')
  if (runtime === 'windows') return hostPath
  return hostPath
    .replace(/^([A-Za-z]):/, (_match, drive: string) => `/mnt/${drive.toLowerCase()}`)
    .replace(/\\/g, '/')
}

test.describe('real Pi observer', () => {
  test.setTimeout(180_000)
  test.skip(!enabled, 'Set VIBING_E2E_REAL_PI=1 to run installed Pi')

  for (const runtime of ['windows', 'wsl-Ubuntu-22.04'] as const) {
    test(`${runtime} emits thinking, tool, usage and settled events through the real Pi extension API`, async () => {
      const { app, window } = await launchApp({
        cliFixture: false,
        createDefaultTerminal: false
      })
      try {
        await window.evaluate(() => {
          window.__vibingDebugShell?.setNavMode('sidebar')
          window.__vibingDebugShell?.navigate('home')
        })
        const quick = window.getByTestId('home-quick-pi')
        await expect(quick).toBeVisible({ timeout: 60_000 })
        await quick.click()
        const installation = window.getByTestId(`cli-installation-${runtime}`)
        await expect(installation).toBeVisible({ timeout: 30_000 })
        await installation.click()
        await window.getByTestId('cli-session-name').fill(`Pi real ${runtime}`)
        await window.getByTestId('cli-arguments').fill(
          [
            '--approve',
            '--no-session',
            '--no-extensions',
            '--no-skills',
            '--no-prompt-templates',
            '--no-themes',
            '--no-context-files',
            '--extension',
            extensionPath(runtime),
            '--provider',
            'vibing-e2e',
            '--model',
            'trace'
          ].join(' ')
        )
        await window.getByTestId('cli-launch').click()

        const sessionItem = window
          .getByTestId('sidebar-session-item')
          .filter({ hasText: `Pi real ${runtime}` })
        await expect(sessionItem).toBeVisible({ timeout: 30_000 })
        await expect
          .poll(
            () =>
              window.evaluate(async () => {
                const [projection] = await window.agentApi.listActive()
                return projection
                  ? {
                      adapterId: projection.adapterId,
                      status: projection.status,
                      health: projection.observerHealth,
                      thinking: projection.capabilities.thinking,
                      tools: projection.capabilities.tools,
                      usage: projection.capabilities.usage
                    }
                  : null
              }),
            { timeout: 45_000, message: 'Pi extension 应报告真实 session_start' }
          )
          .toEqual({
            adapterId: 'pi',
            status: 'idle',
            health: 'healthy',
            thinking: 'phase',
            tools: 'progress',
            usage: 'tokens-and-context'
          })

        const sessionId = await sessionItem.getAttribute('data-session-id')
        expect(sessionId).toBeTruthy()
        await window.evaluate((id) => {
          const target = window as unknown as {
            __piSidebarTrace?: string[]
            __piSidebarObserver?: MutationObserver
          }
          target.__piSidebarTrace = []
          const sample = (): void => {
            const item = document.querySelector(
              `[data-testid="sidebar-session-item"][data-session-id="${id}"]`
            )
            const text = item?.textContent?.replace(/\s+/g, ' ').trim()
            if (text && target.__piSidebarTrace?.at(-1) !== text) {
              target.__piSidebarTrace?.push(text)
            }
          }
          target.__piSidebarObserver?.disconnect()
          target.__piSidebarObserver = new MutationObserver(sample)
          target.__piSidebarObserver.observe(document.body, {
            childList: true,
            characterData: true,
            subtree: true
          })
          sample()
        }, sessionId)

        const afterSeq = await window.evaluate(() =>
          Math.max(
            0,
            ...(window.__vibingDebugShell?.agentEvents() ?? []).map(
              (event) => event.seq
            )
          )
        )
        await window.evaluate(() =>
          window.__vibingDebug?.sendInput('Run the deterministic trace.\r')
        )

        const semanticKinds = async (): Promise<string[]> =>
          window.evaluate(
            (seq) =>
              (window.__vibingDebugShell?.agentEvents() ?? [])
                .filter((event) => event.seq > seq)
                .map((event) => event.kind),
            afterSeq
          )
        await expect.poll(semanticKinds, { timeout: 45_000 }).toContain(
          'thinking.started'
        )
        await expect.poll(semanticKinds, { timeout: 45_000 }).toContain(
          'tool.started'
        )
        await expect.poll(semanticKinds, { timeout: 45_000 }).toContain(
          'tool.completed'
        )
        await expect.poll(semanticKinds, { timeout: 45_000 }).toContain(
          'usage.updated'
        )
        await expect.poll(semanticKinds, { timeout: 60_000 }).toContain(
          'turn.completed'
        )
        await expect(sessionItem).toContainText(
          /本轮任务已完成(?: · [\d,]+ tokens)?/
        )
        const sidebarTrace = await window.evaluate(
          () =>
            (
              window as unknown as { __piSidebarTrace?: string[] }
            ).__piSidebarTrace ?? []
        )
        expect(sidebarTrace).toContainEqual(expect.stringMatching(/正在思考/))
        expect(sidebarTrace).toContainEqual(
          expect.stringMatching(/正在执行 bash/i)
        )
        expect(sidebarTrace).toContainEqual(
          expect.stringMatching(/正在整理回复/)
        )
        expect(sidebarTrace).toContainEqual(
          expect.stringMatching(/本轮任务已完成/)
        )
        expect(await semanticKinds()).toEqual(
          expect.arrayContaining([
            'turn.started',
            'thinking.started',
            'thinking.completed',
            'tool.started',
            'tool.completed',
            'usage.updated',
            'turn.completed'
          ])
        )

        const failureAfterSeq = await window.evaluate(() =>
          Math.max(
            0,
            ...(window.__vibingDebugShell?.agentEvents() ?? []).map(
              (event) => event.seq
            )
          )
        )
        await window.evaluate(() =>
          window.__vibingDebug?.sendInput('Run the failing trace.\r')
        )
        const failureKinds = async (): Promise<string[]> =>
          window.evaluate(
            (seq) =>
              (window.__vibingDebugShell?.agentEvents() ?? [])
                .filter((event) => event.seq > seq)
                .map((event) => event.kind),
            failureAfterSeq
          )
        await expect.poll(failureKinds, { timeout: 45_000 }).toContain(
          'tool.failed'
        )
        await expect.poll(failureKinds, { timeout: 60_000 }).toContain(
          'turn.completed'
        )

        const retryAfterSeq = await window.evaluate(() =>
          Math.max(
            0,
            ...(window.__vibingDebugShell?.agentEvents() ?? []).map(
              (event) => event.seq
            )
          )
        )
        await window.evaluate(() =>
          window.__vibingDebug?.sendInput('Run the retry trace.\r')
        )
        const retryKinds = async (): Promise<string[]> =>
          window.evaluate(
            (seq) =>
              (window.__vibingDebugShell?.agentEvents() ?? [])
                .filter((event) => event.seq > seq)
                .map((event) => event.kind),
            retryAfterSeq
          )
        await expect.poll(retryKinds, { timeout: 90_000 }).toContain(
          'turn.completed'
        )
        const retryTrace = await retryKinds()
        expect(retryTrace.filter((kind) => kind === 'turn.started')).toHaveLength(
          1
        )
        expect(retryTrace).not.toContain('turn.failed')

        await window.evaluate(async () => {
          const [projection] = await window.agentApi.listActive()
          if (projection) await window.agentApi.stop(projection.sessionId)
        })
        await expect
          .poll(
            () =>
              window.evaluate(
                async () => (await window.agentApi.listActive()).length
              ),
            { timeout: 20_000 }
          )
          .toBe(0)
      } finally {
        await app.close()
      }
    })
  }
})
