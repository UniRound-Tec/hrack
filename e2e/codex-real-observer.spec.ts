import { expect, test } from '@playwright/test'
import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildCodexInlineHookConfig } from '../electron/agents/adapters/codex/CodexHookConfig'
import { launchApp } from './helpers'

const enabled = process.env.VIBING_E2E_REAL_CODEX === '1'
const allowHookTrust = process.env.VIBING_E2E_TRUST_CODEX_HOOKS === '1'

test.describe('real Codex observer', () => {
  test.setTimeout(240_000)
  test.skip(
    !enabled,
    'Set VIBING_E2E_REAL_CODEX=1 after trusting the Vibing source in /hooks'
  )

  test('Windows Codex strictly accepts the generated inline Hook table', async () => {
    const result = await new Promise<{ code: number | null; output: string }>(
      (resolve) => {
        execFile(
          'codex.exe',
          [
            '--strict-config',
            ...buildCodexInlineHookConfig().map(
              (config) => `--config=${config}`
            ),
            'doctor',
            '--summary'
          ],
          { encoding: 'utf8', timeout: 30_000, windowsHide: true },
          (error, stdout, stderr) =>
            resolve({
              code:
                typeof (error as NodeJS.ErrnoException | null)?.code ===
                'number'
                  ? ((error as { code: number }).code ?? null)
                  : error
                    ? null
                    : 0,
              output: `${stdout ?? ''}${stderr ?? ''}`
            })
        )
      }
    )
    expect(result.code, result.output).toBe(0)
    expect(result.output).toContain('config')
    expect(result.output).toContain('0 fail')
  })

  for (const runtime of ['windows', 'wsl-Ubuntu-22.04'] as const) {
    test(`${runtime} reports a real turn and completion through stable hooks`, async () => {
      const workspace = await mkdtemp(join(tmpdir(), 'vibing-codex-real-'))
      const { app, window } = await launchApp({
        cliFixture: false,
        createDefaultTerminal: false
      })
      let completed = false
      try {
        await window.evaluate(() => {
          window.__vibingDebugShell?.setNavMode('sidebar')
          window.__vibingDebugShell?.navigate('home')
        })
        const quick = window.getByTestId('home-quick-codex')
        await expect(quick).toBeVisible({ timeout: 90_000 })
        await quick.click()
        const installation = window.getByTestId(`cli-installation-${runtime}`)
        await expect(installation).toBeVisible({ timeout: 30_000 })
        await installation.click()
        await window.getByTestId('cli-session-name').fill(`Codex ${runtime}`)
        await window.getByTestId('cli-workspace').fill(workspace)
        await window
          .getByTestId('cli-arguments')
          .fill('--config=check_for_update_on_startup=false')
        await window.getByTestId('cli-launch').click()

        const sessionItem = window
          .getByTestId('sidebar-session-item')
          .filter({ hasText: `Codex ${runtime}` })
        await expect(sessionItem).toBeVisible({ timeout: 30_000 })
        await expect
          .poll(
            () =>
              window.evaluate(async () => {
                const [projection] = await window.agentApi.listActive()
                return projection
                  ? {
                      adapterId: projection.adapterId,
                      health: projection.observerHealth,
                      status: projection.status,
                      tools: projection.capabilities.tools
                    }
                  : null
              }),
            { timeout: 45_000, message: 'Codex Session 应完成启动' }
          )
          .toMatchObject({
            adapterId: 'codex',
            status: 'idle',
            tools: 'lifecycle'
          })
        let workspaceTrustHandled = false
        let hookTrustHandled = false
        const preflightInput = window.locator(
          '.xterm:visible .xterm-helper-textarea'
        )
        await expect
          .poll(
            async () => {
              const buffer = await window.evaluate(() =>
                (window.__vibingDebug?.dumpBuffer() ?? []).join('\n')
              )
              if (
                !workspaceTrustHandled &&
                buffer.includes('Do you trust the contents of this directory?')
              ) {
                workspaceTrustHandled = true
                await preflightInput.focus()
                await preflightInput.press('Enter')
                return false
              }
              if (!hookTrustHandled && buffer.includes('Hooks need review')) {
                if (!allowHookTrust) {
                  throw new Error(
                    'Codex is waiting for Hook trust. Re-run this opt-in real E2E with VIBING_E2E_TRUST_CODEX_HOOKS=1 to trust the 11 reviewed Vibing hooks through the native Codex flow.'
                  )
                }
                expect(buffer).toContain('11 hooks are new or changed.')
                hookTrustHandled = true
                await preflightInput.focus()
                await preflightInput.press('ArrowDown')
                await preflightInput.press('Enter')
                return false
              }
              return buffer.includes('OpenAI Codex') &&
                !buffer.includes('model:     loading')
            },
            { timeout: 60_000, message: 'Codex TUI 应完成模型初始化' }
          )
          .toBe(true)

        const afterSeq = await window.evaluate(() =>
          Math.max(
            0,
            ...(window.__vibingDebugShell?.agentEvents() ?? []).map(
              (event) => event.seq
            )
          )
        )
        const terminalInput = window.locator(
          '.xterm:visible .xterm-helper-textarea'
        )
        await terminalInput.focus()
        await window.keyboard.type(
          'Reply with exactly VIBING_CODEX_HOOK_OK.',
          { delay: 1 }
        )
        await window.waitForTimeout(750)
        await terminalInput.press('Enter')
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
            { timeout: 45_000, message: '真实 prompt 应触发 turn.started' }
          )
          .toContain('turn.started')
        await expect
          .poll(
            () =>
              window.evaluate(async () => {
                const [projection] = await window.agentApi.listActive()
                return projection?.observerHealth
              }),
            { timeout: 30_000, message: '首轮 Hook 到达后 observer 应确认健康' }
          )
          .toBe('healthy')
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
            { timeout: 120_000, message: '真实回复结束应触发 turn.completed' }
          )
          .toContain('turn.completed')
        await expect(sessionItem).toContainText(/本轮任务已完成/)

        const toolAfterSeq = await window.evaluate(() =>
          Math.max(
            0,
            ...(window.__vibingDebugShell?.agentEvents() ?? []).map(
              (event) => event.seq
            )
          )
        )
        await terminalInput.focus()
        await window.keyboard.type(
          'Use the shell tool to run node -e "console.log(\'VIBING_CODEX_TOOL_OK\')", then reply exactly VIBING_CODEX_TOOL_DONE.',
          { delay: 1 }
        )
        await window.waitForTimeout(750)
        await terminalInput.press('Enter')
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
                await terminalInput.focus()
                await terminalInput.press('Enter')
              }
              return kinds
            },
            { timeout: 120_000, message: '真实工具轮应触发 tool.completed' }
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
            { timeout: 120_000, message: '真实工具轮应以 turn.completed 收敛' }
          )
          .toContain('turn.completed')
        await expect(sessionItem).toContainText(/本轮任务已完成/)
        completed = true
      } finally {
        if (!completed) {
          const diagnostics = await window
            .evaluate(async () => ({
              buffer: window.__vibingDebug?.dumpBuffer() ?? [],
              events: window.__vibingDebugShell?.agentEvents() ?? [],
              sessions: await window.agentApi.listActive()
            }))
            .catch(() => null)
          if (diagnostics) {
            console.log('CODEX_REAL_DIAGNOSTICS', JSON.stringify(diagnostics))
          }
        }
        await app.close()
        await rm(workspace, { recursive: true, force: true })
      }
    })
  }
})
