const { existsSync, readdirSync } = require('node:fs')
const { join } = require('node:path')

const REQUIRED_TRAY_ASSETS = [
  'hrack-16.png',
  'hrack-32.png',
  'hrack-256.png',
  'hrack-white-16.png',
  'hrack-white-32.png',
  'hrack-white-256.png',
  'hrackTemplate-16.png',
  'hrackTemplate-32.png',
  'hrack.ico',
  'hrack-white.ico'
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

exports.default = async function assertPackagedTrayAssets(context) {
  const trayDir = join(packagedResourcesDir(context), 'tray')
  const missing = REQUIRED_TRAY_ASSETS.filter(
    (filename) => !existsSync(join(trayDir, filename))
  )
  if (missing.length > 0) {
    throw new Error(`Packaged tray assets are missing: ${missing.join(', ')}`)
  }
}
