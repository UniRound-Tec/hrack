import { expect, test } from '@playwright/test'
import { existsSync, readFileSync } from 'fs'
import { resolve } from 'path'
import { launchApp } from './helpers'

const repoRoot = resolve(__dirname, '..')
const dshBin = resolve(
  repoRoot,
  'dsh-runtime/node_modules/@deepseek-ai/dsh/lib/bin.js'
)

test('dsh p4 packages the isolated runtime next to the host', async () => {
  test.setTimeout(180_000)
  expect(existsSync(dshBin)).toBe(true)

  const pack = JSON.parse(
    readFileSync(resolve(repoRoot, 'package.json'), 'utf8')
  ) as {
    build: {
      afterPack: string
      files: string[]
      extraResources: Array<{ from: string; to: string }>
    }
  }
  expect(pack.build.files).toContain('!dsh-runtime{,/**/*}')
  expect(pack.build.afterPack).toBe('scripts/assert-packaged-resources.cjs')
  expect(
    pack.build.extraResources.some(
      (item) => item.from === 'dsh-runtime' && item.to === 'dsh-runtime'
    )
  ).toBe(true)
  // node_modules 必须以独立 fileset 提供：electron-builder 会对 from 根下的
  // 顶层 node_modules 目录硬性剪枝，`node_modules/**/*` include 无法覆盖。
  expect(
    pack.build.extraResources.some(
      (item) =>
        item.from === 'dsh-runtime/node_modules' &&
        item.to === 'dsh-runtime/node_modules'
    )
  ).toBe(true)

  const { app, window } = await launchApp({ createDefaultTerminal: false })
  try {
    await expect(window.getByTestId('home-page')).toBeVisible({ timeout: 20_000 })
    await window.getByTestId('home-quick-dsh').click()
    await expect(window.getByTestId('dsh-page')).toBeVisible({ timeout: 20_000 })
    await expect
      .poll(
        async () =>
          window.evaluate(async () => (await window.dshApi.getStatus()).state),
        { timeout: 120_000, intervals: [500, 1000, 2000] }
      )
      .toBe('ready')
    const config = await window.evaluate(() => window.dshApi.getConfig())
    expect(config.homeMode).toBe('isolated')
    expect(config.runtimePreference).toEqual({ kind: 'auto' })
    expect(config.activeRuntime).toMatchObject({
      id: 'bundled',
      kind: 'bundled'
    })
    await expect(window.getByTestId('dsh-page')).toHaveAttribute(
      'data-dsh-surface-phase',
      'ready',
      { timeout: 30_000 }
    )
    await window.screenshot({ path: '.dev-shots/dsh-p4-official-web.png' })
  } finally {
    await app.close()
  }
})
