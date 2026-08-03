import { expect, test } from '@playwright/test'
import { dumpViewport, launchApp } from './helpers'

test('rendered Claude token status reaches the sidebar latest detail', async () => {
  test.setTimeout(180_000)
  const { app, window } = await launchApp({ cliFixture: false })
  try {
    await window.evaluate(() => {
      window.__vibingDebugShell?.setNavMode('sidebar')
      window.__vibingDebugShell?.navigate('home')
    })

    const claude = window.getByTestId('home-quick-claude')
    await expect(claude).toBeVisible({ timeout: 90_000 })
    await claude.click()
    await expect(window.getByTestId('cli-config')).toBeVisible()
    const windowsInstallation = window.getByTestId('cli-installation-windows')
    if (await windowsInstallation.count()) await windowsInstallation.click()
    await window.getByTestId('cli-session-name').fill('Claude caption E2E')
    await window.getByTestId('cli-launch').click()

    const session = window.getByTestId('sidebar-session-item').filter({
      hasText: 'Claude caption E2E'
    })
    await expect(session).toBeVisible({ timeout: 30_000 })
    await expect(session).toContainText('等待你的下一条指令', {
      timeout: 30_000
    })

    try {
      await window.evaluate(async () => {
        window.__vibingDebug?.setPtyRenderingSuspended(true)
        await window.__vibingDebug?.writeRenderFixture(
          '\x1b[999;1H✢ Photosynthesizing… (15s · still thinking)'
        )
      })
      await expect(session).toContainText('正在思考 · 15秒', {
        timeout: 10_000
      })
      await window.evaluate(async () => {
        await window.__vibingDebug?.writeRenderFixture(
          '\r\x1b[2K· Connecting… (3s · ↓ 1.2k tokens · thought for 1s)'
        )
      })
      await expect(session).toContainText('正在思考 · 3秒 · 1,200 tokens', {
        timeout: 10_000
      })
    } catch (error) {
      console.log('CLAUDE_VIEWPORT_JSON', JSON.stringify(await dumpViewport(window)))
      console.log('CLAUDE_SIDEBAR_TEXT', JSON.stringify(await session.innerText()))
      throw error
    }
  } finally {
    await app.close()
  }
})
