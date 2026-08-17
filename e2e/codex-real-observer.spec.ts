import { expect, test } from '@playwright/test'
import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildCodexInlineHookConfig } from '../electron/agents/adapters/codex/CodexHookConfig'
import { launchApp } from './helpers'

const enabled = process.env.HRACK_E2E_REAL_CODEX === '1'
const allowHookTrust = process.env.HRACK_E2E_TRUST_CODEX_HOOKS === '1'
const wslEnabled = process.env.HRACK_E2E_REAL_CODEX_WSL === '1'

/**
 * 真 Codex 回归（opt-in）：唯一覆盖「Codex hook 信任」这一外部契约的 seam。
 * 任何改动 hooks.* 命令串的提交（改名、加守卫、改超时）都会使
 * ~/.codex/config.toml 的 trusted_hash 失配，Codex TUI 将阻塞在
 * "Hooks need review" 且本轮 hook 静默不投递——seam 级用例无法发现。
 *
 * 运行：
 *   HRACK_E2E_REAL_CODEX=1 npx playwright test e2e/codex-real-observer.spec.ts
 * 首次或 hook 内容变化后需追加 HRACK_E2E_TRUST_CODEX_HOOKS=1，
 * 通过 Codex 原生流程完成一次性重信任。
 */
test.describe('real Codex observer', () => {
  test.setTimeout(240_000)
  test.skip(
    !enabled,
    'Set HRACK_E2E_REAL_CODEX=1 after trusting the HRack source in /hooks'
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

  const runtimes: string[] = ['windows']
  if (wslEnabled) runtimes.push('wsl-Ubuntu-22.04')
  for (const runtime of runtimes) {
    test(`${runtime} reports a real turn and completion through stable hooks`, async () => {
      const workspace = await mkdtemp(join(tmpdir(), 'hrack-codex-real-'))
      const { app, window } = await launchApp({
        cliFixture: false,
        createDefaultTerminal: false
      })
      let completed = false
      try {
        await window.evaluate(() => {
          window.__hrackDebugShell?.setNavMode('sidebar')
          window.__hrackDebugShell?.navigate('home')
        })
        const quick = window.getByTestId('home-quick-codex')
        await expect(quick).toBeVisible({ timeout: 90_000 })
        await quick.click()
        const installation = window.getByTestId(`cli-installation-${runtime}`)
        await expect(installation).toBeVisible({ timeout: 30_000 })
        await installation.click()
        await window.getByTestId('cli-session-name').fill(`Codex ${runtime}`)
        await window.getByTestId('cli-workspace').fill(workspace)
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
        let updatePromptHandled = false
        const preflightInput = window.locator(
          '.xterm:visible .xterm-helper-textarea'
        )
        await expect
          .poll(
            async () => {
              const buffer = await window.evaluate(() =>
                (window.__hrackDebug?.dumpBuffer() ?? []).join('\n')
              )
              if (
                !updatePromptHandled &&
                buffer.includes('Update available!') &&
                buffer.includes('Skip until next version')
              ) {
                updatePromptHandled = true
                await preflightInput.focus()
                await preflightInput.press('ArrowDown')
                await preflightInput.press('ArrowDown')
                await preflightInput.press('Enter')
                return false
              }
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
                    'Codex is waiting for Hook trust. Re-run this opt-in real E2E with HRACK_E2E_TRUST_CODEX_HOOKS=1 to trust the reviewed HRack hooks through the native Codex flow.'
                  )
                }
                expect(buffer).toMatch(/hooks are new or changed/i)
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
            ...(window.__hrackDebugShell?.agentEvents() ?? []).map(
              (event) => event.seq
            )
          )
        )
        const terminalInput = window.locator(
          '.xterm:visible .xterm-helper-textarea'
        )
        await terminalInput.focus()
        await window.keyboard.type(
          'Reply with exactly HRACK_CODEX_HOOK_OK.',
          { delay: 1 }
        )
        await window.waitForTimeout(750)
        await terminalInput.press('Enter')
        await expect
          .poll(
            () =>
              window.evaluate(
                (seq) =>
                  (window.__hrackDebugShell?.agentEvents() ?? [])
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
                  (window.__hrackDebugShell?.agentEvents() ?? [])
                    .filter((event) => event.seq > seq)
                    .map((event) => event.kind),
                afterSeq
              ),
            { timeout: 120_000, message: '真实回复结束应触发 turn.completed' }
          )
          .toContain('turn.completed')
        await expect(sessionItem).toContainText(/本轮任务已完成|[Cc]ompleted/)

        const toolAfterSeq = await window.evaluate(() =>
          Math.max(
            0,
            ...(window.__hrackDebugShell?.agentEvents() ?? []).map(
              (event) => event.seq
            )
          )
        )
        await terminalInput.focus()
        await window.keyboard.type(
          'Use the shell tool to run node -e "console.log(\'HRACK_CODEX_TOOL_OK\')", then reply exactly HRACK_CODEX_TOOL_DONE.',
          { delay: 1 }
        )
        await window.waitForTimeout(750)
        await terminalInput.press('Enter')
        await expect
          .poll(
            () =>
              window.evaluate(
                (seq) =>
                  (window.__hrackDebugShell?.agentEvents() ?? [])
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
                  (window.__hrackDebugShell?.agentEvents() ?? [])
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
                  (window.__hrackDebugShell?.agentEvents() ?? [])
                    .filter((event) => event.seq > seq)
                    .map((event) => event.kind),
                toolAfterSeq
              ),
            { timeout: 120_000, message: '真实工具轮应以 turn.completed 收敛' }
          )
          .toContain('turn.completed')
        await expect(sessionItem).toContainText(/本轮任务已完成|[Cc]ompleted/)
        completed = true
      } finally {
        if (!completed) {
          const diagnostics = await window
            .evaluate(async () => ({
              buffer: window.__hrackDebug?.dumpBuffer() ?? [],
              events: window.__hrackDebugShell?.agentEvents() ?? [],
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
