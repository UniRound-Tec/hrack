import { expect, test } from '@playwright/test'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { resolve } from 'path'
import { _electron as electron } from '@playwright/test'

/**
 * P0 验证：DSH 页能 boot 出官方 web GUI。
 * 链路：rail 按钮 → DshPage → ensureStarted（utilityProcess fork bin.js）
 * → getBootManifest → loadBundle（wire 取回 client.js）→ AppWebEntry 渲染。
 */

const userDataDir = mkdtempSync(resolve(tmpdir(), 'vibing-dsh-p0-'))

test('dsh surface boots end to end', async () => {
  test.setTimeout(180_000)
  const main = resolve(__dirname, '../out/main/index.js')
  const app = await electron.launch({
    args: [main],
    env: {
      ...process.env,
      VIBING_E2E: '1',
      VIBING_E2E_CLI_FIXTURE: '0',
      VIBING_USER_DATA_DIR: userDataDir
    }
  })
  try {
    const window = await app.firstWindow()
    window.on('console', (msg) => {
      console.log('[renderer]', msg.type(), msg.text().slice(0, 500))
    })
    window.on('pageerror', (error) => {
      console.log('[pageerror]', String(error).slice(0, 800))
    })
    // onboarding 直过
    const onboarding = window.getByTestId('first-run-onboarding')
    await window.waitForFunction(
      () =>
        Boolean(document.querySelector('[data-testid="first-run-onboarding"]')) ||
        Boolean(document.querySelector('[data-testid="icon-rail"]')),
      null,
      { polling: 100, timeout: 30_000 }
    )
    if (await onboarding.isVisible()) {
      const complete = window.getByTestId('onboarding-complete')
      await expect(complete).toBeEnabled({ timeout: 30_000 })
      await complete.click()
    }
    // rail 按钮仅在 rail 导航模式渲染；测试沿用 sidebar 模式，改走调试桥导航
    await window.evaluate(() => {
      ;(window as unknown as { __vibingDebugShell: { navigate(page: string): void } })
        .__vibingDebugShell.navigate('dsh:home')
    })
    await expect(window.getByTestId('dsh-page')).toBeVisible({ timeout: 10_000 })
    // host 首次 boot 要初始化 profile（离线符号链接），放宽等待
    try {
      await expect
      .poll(
        async () =>
          window.evaluate(async () => {
            const status = await (
              window as unknown as {
                dshApi: { getStatus(): Promise<{ state: string; error?: string }> }
              }
            ).dshApi.getStatus()
            return status.state
          }),
        { timeout: 120_000, intervals: [500, 1000, 2000] }
      )
        .toBe('ready')
    } catch (error) {
      const pageText = await window.evaluate(() =>
        document.querySelector('[data-testid="dsh-page"]')?.textContent ?? '(no dsh-page)'
      )
      const status = await window.evaluate(async () =>
        JSON.stringify(await (window as unknown as { dshApi: { getStatus(): Promise<unknown> } }).dshApi.getStatus())
      )
      console.log('[diag] dsh-page text:', pageText)
      console.log('[diag] host status:', status)
      throw error
    }

    // dsh GUI 真实渲染出 DOM
    await window.waitForFunction(
      () => {
        const root = document.querySelector('[data-testid="dsh-page"] > div:last-child')
        return root !== null && root.children.length > 0
      },
      null,
      { polling: 200, timeout: 60_000 }
    )
    // wire 直连自检：主进程代理 host.describe
    const description = await window.evaluate(async () => {
      const api = (window as unknown as {
        dshWireApi: {
          fetch(req: {
            requestId: string; method: string; path: string;
            headers?: Record<string, string>; body?: string
          }): Promise<{ status: number; body: string }>
        }
      }).dshWireApi
      const response = await api.fetch({
        requestId: 'e2e-1',
        method: 'POST',
        path: '/api/host.describe',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          type: 'client-request',
          rpcId: 'e2e-1',
          method: 'host.describe',
          payload: {}
        })
      })
      return { status: response.status, body: JSON.parse(response.body) as unknown }
    })
    expect(description.status).toBe(200)
    await window.screenshot({ path: '.dev-shots/dsh-p0-surface.png' })
  } finally {
    await app.close()
  }
})
