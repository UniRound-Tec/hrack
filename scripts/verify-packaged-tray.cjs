const { _electron: electron } = require('@playwright/test')
const { existsSync, mkdtempSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')

async function main() {
  const executablePath = resolve(process.argv[2] ?? '')
  if (!existsSync(executablePath)) {
    throw new Error(`Packaged executable was not found: ${executablePath}`)
  }

  const app = await electron.launch({
    executablePath,
    env: {
      ...process.env,
      VIBING_E2E: '1',
      VIBING_USER_DATA_DIR: mkdtempSync(join(tmpdir(), 'vibing-release-tray-'))
    }
  })
  try {
    await app.firstWindow({ timeout: 30_000 })
    const result = await app.evaluate(({ nativeImage }) => {
      const separator = process.platform === 'win32' ? '\\' : '/'
      const iconPath = [process.resourcesPath, 'tray', 'vibing-16.png'].join(
        separator
      )
      const image = nativeImage.createFromPath(iconPath)
      const debug = globalThis.__vibingMainDebug
      return {
        iconPath,
        iconEmpty: image.isEmpty(),
        iconSize: image.getSize(),
        trayCreated: debug?.hasTray() ?? false
      }
    })
    if (
      result.iconEmpty ||
      !result.trayCreated ||
      result.iconSize.width !== 16 ||
      result.iconSize.height !== 16
    ) {
      throw new Error(`Packaged tray verification failed: ${JSON.stringify(result)}`)
    }
    process.stdout.write(`Packaged tray verified: ${JSON.stringify(result)}\n`)
  } finally {
    await app.close()
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
