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

    // Full access 警告弹窗：应用内 Dialog 必须出现且在窗口内居中（回归：
    // 旧实现用 window.confirm，Electron 原生框不做窗口内定位，明显错位）。
    await window.getByTestId('dsh-default-permission').click({ timeout: 30_000 })
    const fullAccessOption = window.getByTestId(
      'dsh-default-permission-option-danger-full-access'
    )
    if (await fullAccessOption.isVisible().catch(() => false)) {
      await fullAccessOption.click()
      const confirm = window.getByTestId('dsh-permission-confirm')
      await expect(confirm).toBeVisible({ timeout: 10_000 })
      const geometry = await confirm.evaluate((node) => {
        const box = node.getBoundingClientRect()
        return {
          left: box.left,
          top: box.top,
          width: box.width,
          height: box.height,
          innerWidth: window.innerWidth,
          innerHeight: window.innerHeight
        }
      })
      const centerX = geometry.left + geometry.width / 2
      const centerY = geometry.top + geometry.height / 2
      expect(Math.abs(centerX - geometry.innerWidth / 2)).toBeLessThan(
        geometry.innerWidth * 0.1
      )
      expect(Math.abs(centerY - geometry.innerHeight / 2)).toBeLessThan(
        geometry.innerHeight * 0.1
      )
      await window.screenshot({ path: '.dev-shots/dsh-p2-permission-confirm.png' })
      // 取消：弹窗关闭，权限保持原值。
      const before = await window
        .getByTestId('dsh-default-permission')
        .getAttribute('data-value')
      await window.getByTestId('dsh-permission-confirm-cancel').click()
      await expect(confirm).toHaveCount(0)
      await expect(
        window.getByTestId('dsh-default-permission')
      ).toHaveAttribute('data-value', before ?? '')
    } else {
      console.log('[p2] permission schema has no danger-full-access option; skip')
    }

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

    // 官方 RiskConfirmation（Full access 确认）回归：fallback CSS 必须把
    // 弹窗约束成常规尺寸并窗口内居中（曾退化为 1054px 宽的横条）。
    const accessTrigger = window.locator('button[aria-label^="访问模式"]')
    if (await accessTrigger.isVisible().catch(() => false)) {
      await accessTrigger.click()
      const fullAccessItem = window
        .getByRole('menu')
        .getByRole('menuitem', { name: /full access/i })
      if (await fullAccessItem.isVisible().catch(() => false)) {
        await fullAccessItem.click()
        const confirmDialog = window.getByRole('dialog', { name: /full access/i })
        await expect(confirmDialog).toBeVisible({ timeout: 10_000 })
        const geometry = await confirmDialog.evaluate((node) => {
          const box = node.getBoundingClientRect()
          return {
            width: box.width,
            offsetX: Math.abs(box.left + box.width / 2 - window.innerWidth / 2),
            offsetY: Math.abs(box.top + box.height / 2 - window.innerHeight / 2),
            vw: window.innerWidth,
            vh: window.innerHeight
          }
        })
        expect(geometry.width).toBeLessThanOrEqual(700)
        expect(geometry.offsetX).toBeLessThan(geometry.vw * 0.1)
        expect(geometry.offsetY).toBeLessThan(geometry.vh * 0.1)
        // 内部排版：footer 按钮同行右对齐；警告图标与文本同行横排。
        const internals = await confirmDialog.evaluate((node) => {
          const dialog = (node.closest('[role="dialog"]') ?? node) as HTMLElement
          const footer = [...dialog.querySelectorAll(':scope > div')].find(
            (d) => d.querySelector(':scope > button') && !d.querySelector('h2')
          )
          const buttons = footer
            ? ([...footer.querySelectorAll(':scope > button')] as HTMLElement[])
            : []
          const dialogRight = dialog.getBoundingClientRect().right
          const last = buttons[buttons.length - 1]?.getBoundingClientRect()
          const warning = [...dialog.querySelectorAll('div')].find(
            (d) => d.querySelector(':scope > svg') && d.querySelector(':scope > p')
          )
          const svg = warning?.querySelector(':scope > svg')?.getBoundingClientRect()
          const text = warning?.querySelector(':scope > p')?.getBoundingClientRect()
          return {
            footerButtonCount: buttons.length,
            footerSameRow:
              buttons.length >= 2 &&
              new Set(buttons.map((b) => Math.round(b.getBoundingClientRect().top)))
                .size === 1,
            footerRightGap: last ? Math.round(dialogRight - last.right) : -1,
            warningSameRow: Boolean(
              svg &&
                text &&
                text.left > svg.left &&
                svg.top >= text.top - 4 &&
                svg.top <= text.bottom
            )
          }
        })
        expect(internals.footerButtonCount).toBeGreaterThanOrEqual(2)
        expect(internals.footerSameRow).toBe(true)
        expect(internals.footerRightGap).toBeGreaterThanOrEqual(0)
        expect(internals.footerRightGap).toBeLessThanOrEqual(48)
        expect(internals.warningSameRow).toBe(true)
        await window.screenshot({ path: '.dev-shots/dsh-p2-full-access.png' })
        await confirmDialog.getByRole('button', { name: '取消' }).click()
        await expect(confirmDialog).toHaveCount(0)
      } else {
        console.log('[p2] permission menu lacks Full access option; skip')
      }
      await window.keyboard.press('Escape')
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
