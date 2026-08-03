import { expect, test, type Page } from '@playwright/test'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { AgentEvent, AgentSessionProjection } from '../shared/agent-events'
import { dumpViewport, launchApp } from './helpers'

test.skip(
  process.env.VIBING_REAL_CLAUDE_TRACE !== '1',
  'Set VIBING_REAL_CLAUDE_TRACE=1 to run the metered real-Claude trace.'
)

interface TraceFrame {
  at: number
  lines: string[]
}

async function debugState(page: Page): Promise<{
  events: AgentEvent[]
  sessions: AgentSessionProjection[]
}> {
  return page.evaluate(() => {
    const debug = window.__vibingDebugShell
    return {
      events: debug?.agentEvents() ?? [],
      sessions: debug?.agentSessions() ?? []
    }
  }) as Promise<{
    events: AgentEvent[]
    sessions: AgentSessionProjection[]
  }>
}

test('capture a real multi-turn Claude hook and rendered-status trace', async () => {
  test.setTimeout(300_000)
  const frames: TraceFrame[] = []
  let lastFrame = ''
  let approvalHandled = false
  let state: Awaited<ReturnType<typeof debugState>> = { events: [], sessions: [] }
  const startedAt = Date.now()
  const artifactPath = resolve('test-results/claude-real-trace.json')
  const { app, window, userDataDir } = await launchApp({ cliFixture: false })
  const claudeDebugPath = join(userDataDir, 'claude-hooks-debug.log')

  const capture = async (): Promise<void> => {
    const lines = (await dumpViewport(window))
      .filter((line) => line.trim().length > 0)
      .slice(-16)
    const signature = lines.join('\n')
    if (signature !== lastFrame) {
      lastFrame = signature
      frames.push({ at: Date.now() - startedAt, lines })
    }
    state = await debugState(window)
  }

  const waitForEvent = async (
    kind: AgentEvent['kind'],
    afterSeq: number,
    timeoutMs: number
  ): Promise<AgentEvent> => {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      await capture()
      const event = state.events.find(
        (candidate) => candidate.kind === kind && candidate.seq > afterSeq
      )
      if (event) return event
      if (
        !approvalHandled &&
        state.events.some(
          (candidate) =>
            candidate.kind === 'approval.requested' && candidate.seq > afterSeq
        )
      ) {
        approvalHandled = true
        await window.locator('.xterm:visible').click()
        await window.keyboard.press('Enter')
      }
      await window.waitForTimeout(250)
    }
    throw new Error(`Timed out waiting for ${kind}`)
  }

  const submit = async (prompt: string): Promise<number> => {
    await capture()
    const afterSeq = Math.max(0, ...state.events.map((event) => event.seq))
    const textarea = window.locator('.xterm:visible .xterm-helper-textarea')
    await textarea.focus()
    await window.keyboard.type(prompt, { delay: 1 })
    await window.waitForTimeout(750)
    await textarea.press('Enter')
    await waitForEvent('turn.started', afterSeq, 30_000)
    return afterSeq
  }

  try {
    await window.evaluate(() => {
      window.__vibingDebugShell?.setNavMode('sidebar')
      window.__vibingDebugShell?.navigate('home')
    })
    const claude = window.getByTestId('home-quick-claude')
    await expect(claude).toBeVisible({ timeout: 90_000 })
    await claude.click()
    const windowsInstallation = window.getByTestId('cli-installation-windows')
    if (await windowsInstallation.count()) await windowsInstallation.click()
    await window.getByTestId('cli-session-name').fill('Claude real trace')
    await window
      .getByTestId('cli-arguments')
      .fill(`--debug hooks --debug-file "${claudeDebugPath}"`)
    await window.getByTestId('cli-launch').click()
    await expect(
      window.getByTestId('sidebar-session-item').filter({ hasText: 'Claude real trace' })
    ).toBeVisible({ timeout: 30_000 })

    const firstStart = await submit('Reply with exactly TRACE_ONE.')
    await waitForEvent('turn.completed', firstStart, 90_000)

    const secondStart = await submit(
      'Use the Bash tool to run node -e "console.log(\'VIBING_TRACE_TOOL\')", then reply with its output.'
    )
    await waitForEvent('tool.started', secondStart, 90_000)
    await waitForEvent('tool.completed', secondStart, 90_000)
    await waitForEvent('turn.completed', secondStart, 90_000)
    await capture()
    await expect(
      window.getByTestId('sidebar-session-item').filter({ hasText: 'Claude real trace' })
    ).toContainText(/本轮任务已完成(?: · [\d,]+ tokens)?/)
  } finally {
    mkdirSync(resolve('test-results'), { recursive: true })
    writeFileSync(
      artifactPath,
      JSON.stringify(
        {
          frames,
          events: state.events,
          sessions: state.sessions,
          claudeDebug: existsSync(claudeDebugPath)
            ? readFileSync(claudeDebugPath, 'utf8')
            : null
        },
        null,
        2
      )
    )
    console.log('CLAUDE_REAL_TRACE', artifactPath)
    await app.close()
  }
})
