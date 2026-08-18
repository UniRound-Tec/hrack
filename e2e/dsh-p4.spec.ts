import { expect, test } from '@playwright/test'
import { existsSync, readFileSync } from 'fs'
import { resolve } from 'path'
import { launchApp } from './helpers'

const repoRoot = resolve(__dirname, '..')
const dshBin = resolve(
  repoRoot,
  'dsh-runtime/node_modules/@deepseek-ai/dsh/lib/bin.js'
)

test('dsh p4 does not package a bundled DSH runtime', () => {
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
    pack.build.extraResources.some((item) => item.from.startsWith('dsh-runtime'))
  ).toBe(false)
})

test('dsh p4 official web surface starts from a discovered local DSH', async () => {
  test.setTimeout(180_000)
  expect(existsSync(dshBin)).toBe(true)

  const { app, window } = await launchApp({
    createDefaultTerminal: false,
    localDsh: true
  })
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
    expect(config.homeMode).toBe('shared')
    expect(config.runtimePreference).toEqual({ kind: 'auto' })
    expect(config.activeRuntime).toMatchObject({
      kind: 'installation',
      resolvedExecutable: expect.stringContaining('dsh')
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
