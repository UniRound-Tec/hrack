import { expect, test } from '@playwright/test'
import { launchApp } from './helpers'

test('dsh fallback menu contrast is readable', async () => {
  test.setTimeout(180_000)
  const { app, window } = await launchApp({ createDefaultTerminal: false })
  try {
    await expect(window.getByTestId('home-page')).toBeVisible({ timeout: 20_000 })
    await window.evaluate(() => {
      ;(
        window as unknown as { __vibingDebugShell: { navigate(page: string): void } }
      ).__vibingDebugShell.navigate('dsh:home')
    })
    await expect(window.getByTestId('dsh-lobby')).toBeVisible({ timeout: 20_000 })
    const sample = await window.evaluate(() => {
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
        contrast: (Math.max(light, dark) + 0.05) / (Math.min(light, dark) + 0.05)
      }
    })
    await window.screenshot({ path: '.dev-shots/dsh-contrast-menu.png' })
    console.log('[contrast]', sample)
    expect(sample.contrast).toBeGreaterThan(4.5)
    expect(sample.menuBg).not.toMatch(/rgba\(0,\s*0,\s*0,\s*0\)/)
  } finally {
    await app.close()
  }
})
