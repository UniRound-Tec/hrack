import {
  expect,
  test,
  type ElectronApplication,
  type Page
} from '@playwright/test'
import { spawn } from 'child_process'
import { writeFileSync } from 'fs'
import { join, resolve } from 'path'
import { PNG } from 'pngjs'
import { UI_COLOR_TOKENS, uiTokenToCssVariable } from '../shared/theme-schema'
import { launchApp } from './helpers'

let app: ElectronApplication
let page: Page
let userDataDir: string

test.beforeEach(async () => {
  ;({ app, window: page, userDataDir } = await launchApp())
})

test.afterEach(async () => {
  await app?.close().catch(() => {})
})

test('renders platform-appropriate title-bar controls and applies every GUI token', async () => {
  await expect(page.getByTestId('titlebar')).toBeVisible()
  await expect(page.getByTestId('titlebar-new')).toBeEnabled()

  const platform = await page.evaluate(() => window.windowApi.platform)
  if (platform === 'darwin') {
    await expect(page.getByTestId('window-controls')).toHaveCount(0)
  } else {
    await expect(page.getByTestId('window-controls')).toBeVisible()
  }

  const themeState = await page.evaluate((tokens) => {
    const styles = getComputedStyle(document.documentElement)
    return {
      id: document.documentElement.dataset.uiTheme,
      missing: tokens.filter(
        (token) =>
          styles
            .getPropertyValue(`--hrack-${token.replaceAll('.', '-')}`)
            .trim().length === 0
      )
    }
  }, UI_COLOR_TOKENS)
  expect(themeState).toEqual({ id: 'light', missing: [] })
  expect(uiTokenToCssVariable('bg.app')).toBe('--hrack-bg-app')
})

test('keeps the italic brand ink inside the shiny text paint box', async () => {
  const paintBox = await page.evaluate(async () => {
    await document.fonts.ready
    const source = document.querySelector<HTMLElement>(
      '[data-testid="sidebar"] .font-brand'
    )
    if (!source) throw new Error('Sidebar brand wordmark is unavailable')

    const fixture = document.createElement('div')
    fixture.dataset.brandClipFixture = 'true'
    Object.assign(fixture.style, {
      position: 'fixed',
      inset: '0 auto auto 0',
      zIndex: '99999',
      display: 'flex',
      padding: '16px',
      background: '#fff'
    })

    const frame = document.createElement('div')
    frame.dataset.brandClipMode = 'shiny'
    Object.assign(frame.style, {
      display: 'flex',
      width: '180px',
      height: '80px',
      alignItems: 'center',
      justifyContent: 'center',
      background: '#fff'
    })
    const clone = source.cloneNode(true) as HTMLElement
    clone.style.animation = 'none'
    clone.style.backgroundImage = 'linear-gradient(#000, #000)'
    clone.style.backgroundPosition = 'center'
    clone.style.webkitTextFillColor = 'transparent'
    clone.style.color = '#000'
    frame.append(clone)
    fixture.append(frame)
    document.body.append(fixture)

    const frameBounds = frame.getBoundingClientRect()
    const paintBounds = clone.getBoundingClientRect()
    return {
      left: paintBounds.left - frameBounds.left,
      top: paintBounds.top - frameBounds.top,
      right: paintBounds.right - frameBounds.left - 1,
      bottom: paintBounds.bottom - frameBounds.top - 1
    }
  })

  const ink = (buffer: Buffer) => {
    const image = PNG.sync.read(buffer)
    const points: Array<[number, number]> = []
    for (let y = 0; y < image.height; y++) {
      for (let x = 0; x < image.width; x++) {
        const offset = (y * image.width + x) * 4
        if (
          image.data[offset + 3] > 0 &&
          image.data[offset] < 180 &&
          image.data[offset + 1] < 180 &&
          image.data[offset + 2] < 180
        ) {
          points.push([x, y])
        }
      }
    }
    return {
      count: points.length,
      left: Math.min(...points.map(([x]) => x)),
      top: Math.min(...points.map(([, y]) => y)),
      right: Math.max(...points.map(([x]) => x)),
      bottom: Math.max(...points.map(([, y]) => y))
    }
  }

  const shinyBuffer = await page
    .locator('[data-brand-clip-mode="shiny"]')
    .screenshot()
  const shiny = ink(shinyBuffer)
  await page.locator('[data-brand-clip-fixture="true"]').evaluate((fixture) =>
    fixture.remove()
  )

  expect(shiny.left - paintBox.left).toBeGreaterThanOrEqual(3)
  expect(shiny.top - paintBox.top).toBeGreaterThanOrEqual(3)
  expect(paintBox.right - shiny.right).toBeGreaterThanOrEqual(3)
  expect(paintBox.bottom - shiny.bottom).toBeGreaterThanOrEqual(3)
})

test('removes the macOS traffic-light inset while native fullscreen', async () => {
  const platform = await page.evaluate(() => window.windowApi.platform)
  test.skip(platform !== 'darwin', 'only macOS uses the traffic-light inset')

  const actions = page.locator('.titlebar-actions')
  await expect(actions).toHaveCSS('padding-left', '78px')

  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setFullScreen(true)
  )
  await expect
    .poll(() =>
      app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0].isFullScreen()
      )
    )
    .toBe(true)
  await expect(actions).toHaveCSS('padding-left', '12px')

  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].setFullScreen(false)
  })
  await expect(actions).toHaveCSS('padding-left', '78px')
})

test('toggles maximize from the custom control', async () => {
  const platform = await page.evaluate(() => window.windowApi.platform)
  test.skip(platform === 'darwin', 'macOS uses the native traffic lights')

  const toggle = page.getByTestId('window-toggle-maximize')
  const before = await toggle.getAttribute('aria-label')
  await toggle.click()
  await expect(toggle).not.toHaveAttribute('aria-label', before)
  await expect
    .poll(() =>
      app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0].isMaximized()
      )
    )
    .toBe(true)
})

test('marks the title-bar center draggable and keeps controls clickable', async () => {
  const platform = await page.evaluate(() => window.windowApi.platform)
  test.skip(platform === 'darwin', 'macOS keeps its native hidden-inset title bar')

  const regions = await page.evaluate(() => ({
    drag: getComputedStyle(
      document.querySelector('[data-testid="titlebar-drag-region"]')!
    ).getPropertyValue('-webkit-app-region'),
    action: getComputedStyle(
      document.querySelector('[data-testid="titlebar-new"]')!
    ).getPropertyValue('-webkit-app-region'),
    control: getComputedStyle(
      document.querySelector('[data-testid="window-minimize"]')!
    ).getPropertyValue('-webkit-app-region')
  }))
  expect(regions).toEqual({ drag: 'drag', action: 'no-drag', control: 'no-drag' })
})

test('minimizes and hides to tray through the narrowed window API', async () => {
  const platform = await page.evaluate(() => window.windowApi.platform)
  test.skip(platform === 'darwin', 'macOS uses the native traffic lights')

  await page.getByTestId('window-minimize').click()
  await expect
    .poll(() =>
      app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0].isMinimized()
      )
    )
    .toBe(true)
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].restore())
  await expect
    .poll(() =>
      app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0].isVisible()
      )
    )
    .toBe(true)

  // M5.c：标题栏 X = 隐藏到托盘，窗口不销毁，PTY 保活。
  // 主进程 win.close() 与 X 按钮的 IPC 路径走同一条 close 事件（preventDefault + hide），
  // 避免 Playwright 输入管线与窗口隐藏竞态（CDP ack 丢失 / target 关闭）。
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].close()
  )
  await expect
    .poll(() =>
      app.evaluate(({ BrowserWindow }) => {
        const win = BrowserWindow.getAllWindows()[0]
        return { visible: win.isVisible(), destroyed: win.isDestroyed() }
      })
    )
    .toEqual({ visible: false, destroyed: false })
  // 重新显示后终端 buffer 完整（PTY 未被杀）。
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].show()
  )
  await expect(page.locator('.xterm:visible')).toHaveCount(1)
  await expect
    .poll(() =>
      page.evaluate(() =>
        (window as unknown as { __hrackDebug: { snapshot(): unknown } })
          .__hrackDebug.snapshot()
      )
    )
    .not.toBeNull()
})

test('reopens the hidden primary window instead of starting another instance', async () => {
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].hide()
  )
  await expect
    .poll(() =>
      app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0].isVisible()
      )
    )
    .toBe(false)

  const executablePath = await app.evaluate(({ app: electronApp }) =>
    electronApp.getPath('exe')
  )
  const second = spawn(
    executablePath,
    [resolve(__dirname, '../out/main/index.js')],
    {
      env: {
        ...process.env,
        HRACK_E2E: '1',
        HRACK_E2E_CLI_FIXTURE: '1',
        HRACK_USER_DATA_DIR: userDataDir
      },
      stdio: 'ignore'
    }
  )

  try {
    await expect
      .poll(() =>
        app.evaluate(({ BrowserWindow }) => ({
          count: BrowserWindow.getAllWindows().length,
          visible: BrowserWindow.getAllWindows()[0].isVisible()
        }))
      )
      .toEqual({ count: 1, visible: true })
    await expect.poll(() => second.exitCode).not.toBeNull()
    expect(second.exitCode).toBe(0)
  } finally {
    if (second.exitCode === null) second.kill()
  }
})

test('registers and unregisters the global shortcut with the settings toggle', async () => {
  // 默认 E2E 使用内存注册器，避免 Ctrl+Alt+V 被宿主机其他应用占用；
  // HRACK_E2E_REAL_GLOBAL_SHORTCUT=1 可切换到真实 OS smoke。
  const shortcut = () =>
    app.evaluate(() =>
      (globalThis as unknown as {
        __hrackMainDebug: { isShortcutRegistered(): boolean }
      }).__hrackMainDebug.isShortcutRegistered()
    )
  await expect.poll(shortcut).toBe(true)

  await page.getByTestId('titlebar-settings').click()
  const toggle = page.getByTestId('settings-global-shortcut')
  await toggle.click()
  await expect.poll(shortcut).toBe(false)
  await toggle.click()
  await expect.poll(shortcut).toBe(true)
})

test('tray menu items drive hide-toggle, new session, and quit callbacks', async () => {
  // 注意：electronApp.evaluate 的第一个参数始终是 electron 模块，
  // 真正的入参在第二个位置（index）。
  const clickTrayItem = (index: number) =>
    app.evaluate((_electron, value) => {
      return (globalThis as unknown as {
        __hrackMainDebug: {
          clickTrayItem(index: number): {
            invoked: boolean
            visible: boolean
            focused: boolean
          }
        }
      }).__hrackMainDebug.clickTrayItem(value)
    }, index)

  // 显示/隐藏：菜单项 0 在可见且聚焦时隐藏窗口（quake 语义）。
  await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0]
    win.show()
    win.focus()
  })
  await expect
    .poll(() =>
      app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0].isFocused()
      )
    )
    .toBe(true)
  const toggled = await clickTrayItem(0)
  expect(toggled).toMatchObject({ invoked: true })
  await expect
    .poll(() =>
      app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0].isVisible()
      )
    )
    .toBe(false)
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].show())

  // 新建会话：菜单项 1 → renderer 打开 new-session 面板。
  await clickTrayItem(1)
  await expect(page.getByTestId('new-session-overlay')).toBeVisible()

  // 退出：菜单项 3 触发 quitting 路径，应用真正退出。
  await clickTrayItem(3)
  await app.waitForEvent('close', { timeout: 10_000 })
})

test('hot-reloads the theme registry and CSS variables when themes change on disk', async () => {
  const themesDir = join(userDataDir, 'themes')
  const themePath = join(themesDir, 'm5c-test.json')
  writeFileSync(
    themePath,
    JSON.stringify({
      id: 'm5c-test',
      name: 'M5C Test',
      type: 'dark',
      colors: { 'bg.app': '#123456' }
    })
  )

  // 主进程 watch 推送 → 注册表出现新主题，设置页可选中。
  await page.getByTestId('titlebar-settings').click()
  const themePicker = page.getByTestId('settings-ui-theme')
  await expect
    .poll(async () => {
      await themePicker.click()
      const option = page.getByTestId('settings-ui-theme-option-m5c-test')
      const visible = await option.isVisible()
      if (!visible) await page.keyboard.press('Escape')
      return visible
    }, { timeout: 15_000 })
    .toBe(true)
  await page.getByTestId('settings-ui-theme-option-m5c-test').click()

  // 应用后 bg.app 生效为磁盘上的色值。
  await expect
    .poll(() =>
      page.evaluate(() =>
        getComputedStyle(document.documentElement)
          .getPropertyValue('--hrack-bg-app')
          .trim()
      )
    )
    .toBe('#123456')

  // 修改色值 → 不重启即热更。
  writeFileSync(
    themePath,
    JSON.stringify({
      id: 'm5c-test',
      name: 'M5C Test',
      type: 'dark',
      colors: { 'bg.app': '#654321' }
    })
  )
  await expect
    .poll(() =>
      page.evaluate(() =>
        getComputedStyle(document.documentElement)
          .getPropertyValue('--hrack-bg-app')
          .trim()
      )
    )
    .toBe('#654321')
})
