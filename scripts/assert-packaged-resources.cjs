const { existsSync, readdirSync } = require('node:fs')
const { join } = require('node:path')
const assertPackagedTrayAssets = require('./assert-packaged-tray-assets.cjs')

const DSH_BIN_SEGMENTS = [
  'dsh-runtime',
  'node_modules',
  '@deepseek-ai',
  'dsh',
  'lib',
  'bin.js'
]

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

exports.default = async function assertPackagedResources(context) {
  await assertPackagedTrayAssets.default(context)
  const bin = join(packagedResourcesDir(context), ...DSH_BIN_SEGMENTS)
  if (!existsSync(bin)) {
    throw new Error(`Packaged dsh runtime is missing: ${bin}`)
  }
}
