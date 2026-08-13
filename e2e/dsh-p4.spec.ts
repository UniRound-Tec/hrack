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

  const { app, window } = await launchApp({ createDefaultTerminal: false })
  try {
    await window.evaluate(() => {
      ;(
        window as unknown as { __vibingDebugShell: { navigate(page: string): void } }
      ).__vibingDebugShell.navigate('dsh:home')
    })
    await expect(window.getByTestId('dsh-lobby')).toBeVisible({ timeout: 20_000 })
    await expect
      .poll(
        async () =>
          window.evaluate(async () => (await window.dshApi.getStatus()).state),
        { timeout: 120_000, intervals: [500, 1000, 2000] }
      )
      .toBe('ready')
    const config = await window.evaluate(() => window.dshApi.getConfig())
    expect(config.homeMode).toBe('isolated')
    await window.screenshot({ path: '.dev-shots/dsh-p4-lobby.png' })
  } finally {
    await app.close()
  }
})
