const { existsSync, readdirSync } = require('node:fs')
const { join } = require('node:path')
const { listPackage } = require('@electron/asar')
const assertPackagedTrayAssets = require('./assert-packaged-tray-assets.cjs')

function packagedResourcesDir(context) {
  if (context.electronPlatformName !== 'darwin') {
    return join(context.appOutDir, 'resources')
  }
  const appBundle = readdirSync(context.appOutDir).find((name) =>
    name.endsWith('.app')
  )
  if (!appBundle) throw new Error('Packaged macOS app bundle was not found')
  return join(context.appOutDir, appBundle, 'Contents', 'Resources')
}

function assertNoBundledDshRuntime(context) {
  const runtimeRoot = join(packagedResourcesDir(context), 'dsh-runtime')
  if (existsSync(runtimeRoot)) {
    throw new Error(`Packaged app must not include a bundled DSH runtime: ${runtimeRoot}`)
  }
}

function assertNoDevelopmentTrees(context) {
  const archivePath = join(packagedResourcesDir(context), 'app.asar')
  if (!existsSync(archivePath)) {
    throw new Error(`Packaged app archive was not found: ${archivePath}`)
  }
  const forbidden = listPackage(archivePath).filter((entry) => {
    const normalized = entry.replaceAll('\\', '/').replace(/^\/+/, '')
    const root = normalized.split('/')[0]
    return (
      root === 'remotes' ||
      root === '.dev-run' ||
      root === '.dev-shots' ||
      root === '.theme-check' ||
      root === '.claude' ||
      root === 'dist' ||
      root === 'logs' ||
      root.startsWith('release-') ||
      root.toLowerCase().endsWith('.dsh')
    )
  })
  if (forbidden.length > 0) {
    throw new Error(
      `Packaged app contains development or local-data trees: ${forbidden
        .slice(0, 5)
        .join(', ')}`
    )
  }
}

exports.default = async function assertPackagedResources(context) {
  await assertPackagedTrayAssets.default(context)
  assertNoBundledDshRuntime(context)
  assertNoDevelopmentTrees(context)
}
