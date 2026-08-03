import {
  expect,
  test,
  type ElectronApplication,
  type Page
} from '@playwright/test'
import { existsSync, readdirSync } from 'fs'
import { join } from 'path'
import type { HistoryEvent, HistoryQuery } from '../shared/ipc-contract'
import { launchApp } from './helpers'

async function history(
  page: Page,
  query: HistoryQuery
): Promise<HistoryEvent[]> {
  return page.evaluate(
    (value) => window.statsApi.historyEvents(value),
    query
  )
}

test.describe('agent observer (fixture adapter, app level)', () => {
  let app: ElectronApplication
  let page: Page
  let userDataDir: string

  test.beforeEach(async () => {
    ;({ app, window: page, userDataDir } = await launchApp({
      env: { VIBING_FIXTURE_OBSERVER: '1' }
    }))
    await page.evaluate(() => {
      window.__vibingDebugShell?.setNavMode('sidebar')
      window.__vibingDebugShell?.navigate('home')
    })
  })

  test.afterEach(async () => app?.close())

  test('fixture script drives the six-state walk in the real UI', async () => {
    // 启动 codex（fixture 扫描 → cmd.exe 保持存活），fixture adapter 重放脚本。
    await page.getByTestId('home-quick-codex').click()
    await expect(page.getByTestId('cli-config')).toBeVisible()
    await page.getByTestId('cli-session-name').fill('Fixture walk')
    await page.getByTestId('cli-launch').click()

    const sessionItem = page.getByTestId('sidebar-session-item')
    await expect(sessionItem).toBeVisible({ timeout: 15_000 })
    await expect(sessionItem.locator('.bg-status-working-dot')).toBeVisible({
      timeout: 15_000
    })

    // working → needs-you → working；done 是持久化事件事实，最终 UI 为 exited。
    // 不在 DOM 上等待瞬时 done：当 CLI 紧接着退出时，renderer 可能在两次
    // paint 之间直接收到 exited。下面的 history 断言会验证 completed 没有丢失。
    await expect(sessionItem.locator('.bg-status-needs-you-dot')).toBeVisible({
      timeout: 15_000
    })
    await expect(sessionItem.locator('.bg-status-working-dot')).toBeVisible({
      timeout: 15_000
    })
    await expect(sessionItem.locator('.border-status-exited')).toBeVisible({
      timeout: 15_000
    })

    // 详情：approval 期间显示 bounded summary（低敏历史投影的 detail 字段）。
    const blocked = (await history(page, { limit: 50 })).find(
      (event) => event.kind === 'blocked'
    )
    expect(blocked?.detail).toBe('Fixture approval request')

    // 低敏历史投影与 all-time 去重计数。
    await expect
      .poll(
        async () => {
          const events = await history(page, { limit: 50 })
          return {
            start: events.filter((event) => event.kind === 'session_start').length,
            toolCalls: events.filter((event) => event.kind === 'tool_call').length,
            blocked: events.filter((event) => event.kind === 'blocked').length,
            approved: events.filter((event) => event.kind === 'approved').length,
            completed: events.filter((event) => event.kind === 'completed').length,
            exit: events.filter((event) => event.kind === 'session_exit').length
          }
        },
        { timeout: 15_000 }
      )
      .toEqual({
        start: 1,
        toolCalls: 1,
        blocked: 1,
        approved: 1,
        completed: 1,
        exit: 1
      })
    expect(
      await page.evaluate(() => window.statsApi.allTime())
    ).toMatchObject({
      sessions: 1,
      toolCalls: 1,
      blocked: 1,
      approvals: 1
    })

    const start = (await history(page, { limit: 50 })).find(
      (event) => event.kind === 'session_start'
    )
    expect(start).toMatchObject({
      adapterId: 'codex',
      title: 'Fixture walk',
      detail: ''
    })
  })

  test('observer-runs temp directories are cleaned after session exit', async () => {
    await page.getByTestId('home-quick-codex').click()
    await expect(page.getByTestId('cli-config')).toBeVisible()
    await page.getByTestId('cli-launch').click()

    const sessionItem = page.getByTestId('sidebar-session-item')
    await expect(sessionItem).toBeVisible({ timeout: 15_000 })
    // 会话期间存在临时目录。
    const runDir = join(userDataDir, 'observer-runs')
    await expect
      .poll(() => existsSync(runDir) && readdirSync(runDir).length > 0)
      .toBe(true)
    // 会话退出后目录被清理。
    await expect(sessionItem.locator('.border-status-exited')).toBeVisible({
      timeout: 15_000
    })
    await expect
      .poll(() => (existsSync(runDir) ? readdirSync(runDir).length : 0))
      .toBe(0)
  })
})
