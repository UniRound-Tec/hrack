import { expect, test } from '@playwright/test'
import { launchApp } from './helpers'

const enabled = process.env.VIBING_E2E_REAL_OPENCODE === '1'

test.describe('real OpenCode observer', () => {
  test.setTimeout(180_000)
  test.skip(
    !enabled,
    'Set VIBING_E2E_REAL_OPENCODE=1 to run installed OpenCode'
  )

  for (const runtime of ['windows', 'wsl-Ubuntu-22.04'] as const) {
    test(`${runtime} TUI reaches a healthy idle projection and exits cleanly`, async () => {
      const { app, window } = await launchApp({ cliFixture: false })
      try {
        await window.evaluate(() => {
          window.__vibingDebugShell?.setNavMode('sidebar')
          window.__vibingDebugShell?.navigate('home')
          const target = window as unknown as {
            __opencodeObserverEvents?: unknown[]
          }
          target.__opencodeObserverEvents = []
          window.agentApi.onEvents((events) =>
            target.__opencodeObserverEvents?.push(...events)
          )
        })
        const quick = window.getByTestId('home-quick-opencode')
        await expect(quick).toBeVisible({ timeout: 45_000 })
        await quick.click()
        await expect(window.getByTestId('cli-config')).toBeVisible()
        const installation = window.getByTestId(`cli-installation-${runtime}`)
        if (await installation.count()) await installation.click()
        await window.getByTestId('cli-launch').click()

        await expect(window.getByTestId('sidebar-session-item')).toBeVisible({
          timeout: 30_000
        })
        await expect
          .poll(
            async () =>
              window.evaluate(async () => {
                const [projection] = await window.agentApi.listActive()
                return projection
                  ? {
                      adapterId: projection.adapterId,
                      status: projection.status,
                      health: projection.observerHealth,
                      tools: projection.capabilities.tools,
                      thinking: projection.capabilities.thinking,
                      degraded: (
                        (
                          window as unknown as {
                            __opencodeObserverEvents?: Array<{
                              kind: string
                              payload?: { reason?: string }
                            }>
                          }
                        ).__opencodeObserverEvents ?? []
                      )
                        .filter((event) => event.kind === 'observer.degraded')
                        .map((event) => event.payload?.reason)
                    }
                  : null
              }),
            { timeout: 30_000 }
          )
          .toEqual({
            adapterId: 'opencode',
            status: 'idle',
            health: 'healthy',
            tools: 'progress',
            thinking: 'phase',
            degraded: []
          })

        await window.evaluate(async () => {
          const [projection] = await window.agentApi.listActive()
          if (projection) await window.agentApi.stop(projection.sessionId)
        })
        await expect
          .poll(
            async () =>
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

  for (const runtime of ['windows', 'wsl-Ubuntu-22.04'] as const) {
    test(`${runtime} real prompt drives thinking, tool and completed sidebar states`, async () => {
      const { app, window } = await launchApp({ cliFixture: false })
      try {
        await window.evaluate(() => {
          window.__vibingDebugShell?.setNavMode('sidebar')
          window.__vibingDebugShell?.navigate('home')
        })
        await window.getByTestId('home-quick-opencode').click()
        const installation = window.getByTestId(`cli-installation-${runtime}`)
        if (await installation.count()) await installation.click()
        await window.getByTestId('cli-session-name').fill('OpenCode real trace')
        await window.getByTestId('cli-launch').click()
        const sessionItem = window
          .getByTestId('sidebar-session-item')
          .filter({ hasText: 'OpenCode real trace' })
        await expect(sessionItem).toBeVisible({ timeout: 30_000 })
        await expect
          .poll(
            () =>
              window.evaluate(async () => {
                const [projection] = await window.agentApi.listActive()
                return projection?.observerHealth
              }),
            { timeout: 30_000 }
          )
          .toBe('healthy')
        await expect
          .poll(
            () =>
              window.evaluate(() =>
                (window.__vibingDebug?.dumpBuffer() ?? []).join('\n')
              ),
            {
              timeout: 60_000,
              message: 'OpenCode TUI 应进入可交互状态'
            }
          )
          .toContain('Ask anything')

        const afterSeq = await window.evaluate(() =>
          Math.max(
            0,
            ...(window.__vibingDebugShell?.agentEvents() ?? []).map(
              (event) => event.seq
            )
          )
        )
        const sessionId = await sessionItem.getAttribute('data-session-id')
        expect(sessionId).toBeTruthy()
        await window.evaluate((id) => {
          const target = window as unknown as {
            __opencodeSidebarTrace?: string[]
            __opencodeSidebarObserver?: MutationObserver
          }
          target.__opencodeSidebarTrace = []
          const sample = (): void => {
            const item = document.querySelector(
              `[data-testid="sidebar-session-item"][data-session-id="${id}"]`
            )
            const text = item?.textContent?.replace(/\s+/g, ' ').trim()
            if (
              text &&
              target.__opencodeSidebarTrace?.at(-1) !== text
            ) {
              target.__opencodeSidebarTrace?.push(text)
            }
          }
          target.__opencodeSidebarObserver?.disconnect()
          target.__opencodeSidebarObserver = new MutationObserver(sample)
          target.__opencodeSidebarObserver.observe(document.body, {
            childList: true,
            characterData: true,
            subtree: true
          })
          sample()
        }, sessionId)
        await window.evaluate(() =>
          window.__vibingDebug?.sendInput(
            'Reply with exactly OPENCODE_TRACE_OK.\r'
          )
        )

        await expect
          .poll(
            () =>
              window.evaluate(
                (seq) =>
                  (window.__vibingDebugShell?.agentEvents() ?? [])
                    .filter((event) => event.seq > seq)
                    .map((event) => event.kind),
                afterSeq
              ),
            {
              timeout: 30_000,
              message: '真实 prompt 应触发 OpenCode turn.started'
            }
          )
          .toContain('turn.started')
        await expect
          .poll(
            () =>
              window.evaluate(
                (seq) =>
                  (window.__vibingDebugShell?.agentEvents() ?? [])
                    .filter((event) => event.seq > seq)
                    .map((event) => event.kind),
                afterSeq
              ),
            {
              timeout: 30_000,
              message: '真实 SSE reasoning 应触发 OpenCode thinking.started'
            }
          )
          .toContain('thinking.started')
        await expect
          .poll(
            () =>
              window.evaluate(
                () =>
                  (
                    window as unknown as {
                      __opencodeSidebarTrace?: string[]
                    }
                  ).__opencodeSidebarTrace ?? []
              ),
            {
              timeout: 30_000,
              message: '侧栏卡片必须真实渲染过“正在思考”'
            }
          )
          .toContainEqual(expect.stringMatching(/正在思考 · \d+秒/))
        await expect
          .poll(
            () =>
              window.evaluate(
                (seq) =>
                  (window.__vibingDebugShell?.agentEvents() ?? [])
                    .filter((event) => event.seq > seq)
                    .map((event) => event.kind),
                afterSeq
              ),
            {
              timeout: 90_000,
              message: '真实回复结束应触发 OpenCode turn.completed'
            }
          )
          .toContain('turn.completed')
        await expect(sessionItem).toContainText(
          /本轮任务已完成(?: · [\d,]+ tokens)?/
        )

        const toolAfterSeq = await window.evaluate(() =>
          Math.max(
            0,
            ...(window.__vibingDebugShell?.agentEvents() ?? []).map(
              (event) => event.seq
            )
          )
        )
        await window.evaluate(() =>
          window.__vibingDebug?.sendInput(
            'Use the Bash tool to run node -e "console.log(\'OPENCODE_TOOL_OK\')", then reply exactly OPENCODE_TOOL_DONE.\r'
          )
        )
        await expect
          .poll(
            () =>
              window.evaluate(
                (seq) =>
                  (window.__vibingDebugShell?.agentEvents() ?? [])
                    .filter((event) => event.seq > seq)
                    .map((event) => event.kind),
                toolAfterSeq
              ),
            { timeout: 90_000, message: '真实工具轮应触发 tool.started' }
          )
          .toContain('tool.started')
        let approvalHandled = false
        await expect
          .poll(
            async () => {
              const kinds = await window.evaluate(
                (seq) =>
                  (window.__vibingDebugShell?.agentEvents() ?? [])
                    .filter((event) => event.seq > seq)
                    .map((event) => event.kind),
                toolAfterSeq
              )
              if (!approvalHandled && kinds.includes('approval.requested')) {
                approvalHandled = true
                await window.evaluate(() =>
                  window.__vibingDebug?.sendInput('\r')
                )
              }
              return kinds
            },
            { timeout: 90_000, message: '真实工具轮应触发 tool.completed' }
          )
          .toContain('tool.completed')
        await expect
          .poll(
            () =>
              window.evaluate(
                (seq) =>
                  (window.__vibingDebugShell?.agentEvents() ?? [])
                    .filter((event) => event.seq > seq)
                    .map((event) => event.kind),
                toolAfterSeq
              ),
            { timeout: 90_000, message: '真实工具轮应以 turn.completed 收敛' }
          )
          .toContain('turn.completed')
        await expect(sessionItem).toContainText(
          /本轮任务已完成(?: · [\d,]+ tokens)?/
        )
        const settledSeq = await window.evaluate(() =>
          Math.max(
            0,
            ...(window.__vibingDebugShell?.agentEvents() ?? []).map(
              (event) => event.seq
            )
          )
        )
        await window.waitForTimeout(1_500)
        expect(
          await window.evaluate(
            (seq) =>
              (window.__vibingDebugShell?.agentEvents() ?? []).filter(
                (event) =>
                  event.seq > seq &&
                  event.kind === 'activity.caption' &&
                  event.nativeType === 'OpenCodeThinkingTimer'
              ),
            settledSeq
          )
        ).toEqual([])
      } finally {
        await app.close()
      }
    })
  }
})
