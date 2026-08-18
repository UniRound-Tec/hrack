const { existsSync, readdirSync } = require('node:fs')
const { join } = require('node:path')
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

exports.default = async function assertPackagedResources(context) {
  await assertPackagedTrayAssets.default(context)
  assertNoBundledDshRuntime(context)
}
