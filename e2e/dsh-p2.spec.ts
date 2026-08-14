import { expect, test, type Page } from '@playwright/test'
import { mkdirSync } from 'fs'
import { resolve } from 'path'
import { launchApp } from './helpers'

interface ContrastSample {
  menuBg: string
  itemColor: string
  contrast: number
  darkTheme: boolean
}

async function waitHostReady(window: Page): Promise<void> {
  await expect
    .poll(
      async () =>
        window.evaluate(async () => {
          const status = await window.dshApi.getStatus()
          return status.state
        }),
      { timeout: 120_000, intervals: [500, 1000, 2000] }
    )
    .toBe('ready')
}

async function navigate(window: Page, page: string): Promise<void> {
  await window.evaluate((next) => {
    ;(
      window as unknown as { __vibingDebugShell: { navigate(page: string): void } }
    ).__vibingDebugShell.navigate(next)
  }, page)
}

async function dshRpc<T>(
  window: Page,
  method: string,
  payload: unknown
): Promise<T> {
  const envelope = await window.evaluate(
    async ({ method, payload }) => {
      const rpcId = crypto.randomUUID()
      const response = await window.dshWireApi.fetch({
        requestId: rpcId,
        method: 'POST',
        path: `/api/${method}`,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          type: 'client-request',
          rpcId,
          method,
          payload
        })
      })
      return JSON.parse(response.body) as {
        result?: { ok?: boolean; value?: unknown; error?: { message?: string } }
      }
    },
    { method, payload }
  )
  if (!envelope.result?.ok) {
    throw new Error(envelope.result?.error?.message ?? `${method} failed`)
  }
  return envelope.result.value as T
}

function measureContrast(): ContrastSample {
  const menu = document.createElement('div')
  menu.setAttribute('role', 'menu')
  menu.style.position = 'fixed'
  menu.style.left = '80px'
  menu.style.top = '120px'
  const item = document.createElement('button')
  item.setAttribute('role', 'menuitem')
  item.textContent = '标准模式'
  const desc = document.createElement('span')
  desc.className = 'itemDesc'
  desc.textContent = '功能完整的编码 Agent'
  item.append(desc)
  menu.append(item)
  document.body.append(menu)
  const menuStyle = getComputedStyle(menu)
  const itemStyle = getComputedStyle(item)
  const parse = (value: string): [number, number, number] => {
    const match = value.match(/(\d+),\s*(\d+),\s*(\d+)/)
    if (!match) return [0, 0, 0]
    return [Number(match[1]), Number(match[2]), Number(match[3])]
  }
  const luminance = ([r, g, b]: [number, number, number]): number => {
    const lin = [r, g, b].map((channel) => {
      const value = channel / 255
      return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
    })
    return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2]
  }
  const bg = parse(menuStyle.backgroundColor)
  const fg = parse(itemStyle.color)
  const light = luminance(bg)
  const dark = luminance(fg)
  return {
    menuBg: menuStyle.backgroundColor,
    itemColor: itemStyle.color,
    contrast: (Math.max(light, dark) + 0.05) / (Math.min(light, dark) + 0.05),
    darkTheme: document.body.hasAttribute('data-ds-dark-theme')
  }
}

test('dsh p2 chrome: lobby settings session and contrast', async () => {
  test.setTimeout(240_000)
  const { app, window, userDataDir } = await launchApp({
    createDefaultTerminal: false
  })
  try {
    await expect(window.getByTestId('home-page')).toBeVisible({ timeout: 20_000 })
    await window.screenshot({ path: '.dev-shots/dsh-p2-home.png' })

    await navigate(window, 'dsh:home')
    await expect(window.getByTestId('dsh-lobby')).toBeVisible({ timeout: 20_000 })
    await waitHostReady(window)
    await expect(window.getByTestId('dsh-lobby-new')).toBeVisible({ timeout: 30_000 })
    await expect(window.getByTestId('dsh-lobby-error')).toHaveCount(0)
    await window.screenshot({ path: '.dev-shots/dsh-p2-lobby.png' })

    await window.getByTestId('dsh-lobby-settings').click()
    await expect(window.getByTestId('dsh-settings')).toBeVisible({ timeout: 60_000 })
    await expect(window.getByTestId('dsh-settings-back')).toBeVisible()
    await expect(window.getByTestId('dsh-host-settings')).toBeVisible({
      timeout: 30_000
    })
    await window.screenshot({ path: '.dev-shots/dsh-p2-settings.png' })

    await window.getByTestId('dsh-settings-back').click()
    await expect(window.getByTestId('dsh-lobby')).toBeVisible({ timeout: 20_000 })
    await navigate(window, 'home')
    await expect(window.getByTestId('home-page')).toBeVisible({ timeout: 20_000 })
    const homeCovered = await window.evaluate(() => {
      const dialog = document.querySelector(
        'body > [role="presentation"] > [role="dialog"][aria-modal="true"]'
      )
      if (!dialog) return false
      return getComputedStyle(dialog.parentElement!).display !== 'none'
    })
    expect(homeCovered).toBe(false)
    await window.screenshot({ path: '.dev-shots/dsh-p2-home-after-settings.png' })

    const workspaceDir = resolve(userDataDir, 'e2e-workspace')
    mkdirSync(workspaceDir, { recursive: true })
    await navigate(window, 'dsh:home')
    await expect(window.getByTestId('dsh-lobby')).toBeVisible({ timeout: 20_000 })
    const workspace = await dshRpc<{ workspace?: { workspaceId?: string } }>(
      window,
      'workspace.create',
      { path: workspaceDir }
    )
    const workspaceId = workspace.workspace?.workspaceId
    expect(workspaceId).toBeTruthy()
    const created = await dshRpc<{ sessionId: string }>(window, 'session.create', {
      workspaceId
    })
    expect(created.sessionId).toBeTruthy()

    await navigate(window, `dsh:${created.sessionId}`)
    await expect(window.getByTestId('dsh-page')).toBeVisible({ timeout: 60_000 })
    await expect
      .poll(
        async () =>
          window.evaluate(() => {
            const host = document.querySelector('[data-dsh-surface-host]')
            if (!host) return 'no-host'
            const sidebar = host.querySelector<HTMLElement>('[class*="_sidebarCol"]')
            const style = sidebar ? getComputedStyle(sidebar) : null
            return JSON.stringify({
              mode: host.getAttribute('data-dsh-mode'),
              sidebar: style?.visibility,
              width: host.getBoundingClientRect().width
            })
          }),
        { timeout: 60_000 }
      )
      .toContain('"mode":"session"')
    for (const name of ['继续', '稍后配置']) {
      const button = window.getByRole('button', { name })
      if (await button.isVisible().catch(() => false)) {
        await button.click()
        await window.waitForTimeout(300)
      }
    }
    await window.screenshot({ path: '.dev-shots/dsh-p2-session.png' })

    const sample = await window.evaluate(measureContrast)
    await window.screenshot({ path: '.dev-shots/dsh-p2-menu.png' })
    console.log('[contrast]', sample)
    expect(sample.contrast).toBeGreaterThan(4.5)
    expect(sample.menuBg).not.toMatch(/rgba\(0,\s*0,\s*0,\s*0\)/)
  } finally {
    await app.close()
  }
})
