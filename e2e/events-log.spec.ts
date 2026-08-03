import {
  expect,
  test,
  type ElectronApplication,
  type Page
} from '@playwright/test'
import { readFileSync } from 'fs'
import { join } from 'path'
import type { HistoryEvent, HistoryQuery } from '../shared/ipc-contract'
import { launchApp } from './helpers'

async function allTime(page: Page) {
  return page.evaluate(() => window.statsApi.allTime())
}

async function history(
  page: Page,
  query: HistoryQuery
): Promise<HistoryEvent[]> {
  return page.evaluate(
    (value) => window.statsApi.historyEvents(value),
    query
  )
}

test.describe('events log and all-time stats (real persistence)', () => {
  let app: ElectronApplication
  let page: Page
  let userDataDir: string

  test.beforeEach(async () => {
    ;({ app, window: page, userDataDir } = await launchApp())
    await page.evaluate(() => {
      window.__vibingDebugShell?.setNavMode('sidebar')
      window.__vibingDebugShell?.navigate('home')
    })
  })

  test.afterEach(async () => app?.close())

  test('records session lifecycle events from a real quick-exit CLI session', async () => {
    // 独立 userData：统计从 0 起。
    expect(await allTime(page)).toEqual({
      sessions: 0,
      toolCalls: 0,
      blocked: 0,
      approvals: 0
    })

    // Codex 快速退出会话：codex --version 打印版本后立即退出，覆盖 start+exit 全链路。
    await page.getByTestId('home-quick-codex').click()
    await expect(page.getByTestId('cli-config')).toBeVisible()
    await page.getByTestId('cli-session-name').fill('Quick exit')
    await page.getByTestId('cli-arguments').fill('--version')
    await page.getByTestId('cli-launch').click()

    // session_start 由 launchCli 立即记录。
    await expect
      .poll(async () => {
        const events = await history(page, { limit: 50 })
        return events.some((event) => event.kind === 'session_start')
      }, { timeout: 15_000 })
      .toBe(true)

    // pty 退出后 session_exit 记录，sessions 计数递增。
    await expect
      .poll(async () => {
        const events = await history(page, { limit: 50 })
        return (
          events.some((event) => event.kind === 'session_exit') &&
          (await allTime(page)).sessions >= 1
        )
      }, { timeout: 30_000 })
      .toBe(true)

    const events = await history(page, { limit: 50 })
    const start = events.find((event) => event.kind === 'session_start')
    const exit = events.find((event) => event.kind === 'session_exit')
    expect(start).toMatchObject({
      adapterId: 'codex',
      title: 'Quick exit',
      detail: ''
    })
    expect(typeof start?.id).toBe('string')
    expect(exit?.detail).toMatch(/^exit( code \d+)?$/)
    expect(exit?.occurredAt).toBeGreaterThanOrEqual(start?.occurredAt ?? 0)
  })

  test('before cursor paginates newest-first without duplicates', async () => {
    for (let index = 0; index < 8; index++) {
      await page.evaluate(
        (title) =>
          window.statsApi.recordEvent({
            kind: 'session_start',
            adapterId: 'codex',
            title,
            detail: ''
          }),
        `Session ${index}`
      )
    }
    const firstPage = await history(page, { limit: 3 })
    expect(firstPage).toHaveLength(3)
    const secondPage = await history(page, {
      limit: 3,
      before: firstPage[firstPage.length - 1].occurredAt
    })
    expect(secondPage).toHaveLength(3)
    const ids = new Set([...firstPage, ...secondPage].map((event) => event.id))
    expect(ids.size).toBe(6)
    // 降序时间轴：第一页整体不晚于第二页。
    expect(firstPage[0].occurredAt).toBeGreaterThanOrEqual(
      secondPage[secondPage.length - 1].occurredAt
    )
  })

  test('rejects invalid payloads and keeps counters untouched', async () => {
    await page.evaluate(() =>
      window.statsApi.recordEvent({
        // @ts-expect-error E2E 校验非法 kind
        kind: 'not-a-kind',
        adapterId: 'codex',
        title: 'Bad',
        detail: ''
      })
    )
    await page.evaluate(() =>
      window.statsApi.recordEvent({
        // @ts-expect-error E2E 校验非对象载荷
        kind: undefined
      })
    )
    expect(await history(page, { limit: 50 })).toHaveLength(0)
    expect(await allTime(page)).toEqual({
      sessions: 0,
      toolCalls: 0,
      blocked: 0,
      approvals: 0
    })
  })

  test('accumulates stats across restarts with the same userData', async () => {
    await page.evaluate(() =>
      window.statsApi.recordEvent({
        kind: 'session_start',
        adapterId: 'codex',
        title: 'Persist me',
        detail: ''
      })
    )
    await expect
      .poll(async () => (await allTime(page)).sessions)
      .toBe(1)
    await app.close()

    // 同一 userData 二次启动：计数与历史跨启动保留。
    ;({ app, window: page } = await launchApp({ userDataDir }))
    expect(await allTime(page)).toMatchObject({ sessions: 1 })
    const events = await history(page, { limit: 50 })
    expect(events.some((event) => event.title === 'Persist me')).toBe(true)
  })
})

test('overwrites main-prefs background color and uses it on the next launch', async () => {
  // 深色主题应用后 bg.app 进入 main-prefs.json，重启建窗首帧用同一色值。
  const { app, window: page, userDataDir } = await launchApp()
  try {
    await page.evaluate(() => window.__vibingDebugShell?.setNavMode('sidebar'))
    await page.getByTestId('titlebar-settings').click()
    await page.getByTestId('settings-ui-theme-dark').click()
    await expect(page.getByTestId('settings-ui-theme-dark')).toHaveAttribute(
      'aria-pressed',
      'true'
    )
    const prefsPath = join(userDataDir, 'main-prefs.json')
    await expect.poll(() => readFileSync(prefsPath, 'utf8')).toContain(
      '"backgroundColor"'
    )
    await app.close()

    const second = await launchApp({ userDataDir })
    try {
      const background = await second.app.evaluate(
        ({ BrowserWindow }) =>
          BrowserWindow.getAllWindows()[0].getBackgroundColor()
      )
      expect(background).toMatch(/^#[0-9a-fA-F]{6}$/)
      expect(background).not.toBe('#ffffff')
    } finally {
      await second.app.close()
    }
  } finally {
    await app.close().catch(() => {})
  }
})
