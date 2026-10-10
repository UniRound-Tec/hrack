const { copyFileSync, existsSync, mkdirSync } = require('node:fs')
const { dirname, join } = require('node:path')

const CONPTY_FILES = ['conpty.dll', 'OpenConsole.exe']

function prepareConpty(destination, arch = process.arch) {
  const packageDir = dirname(require.resolve('node-pty/package.json'))
  const source = join(packageDir, 'prebuilds', `win32-${arch}`, 'conpty')
  for (const name of CONPTY_FILES) {
    if (!existsSync(join(source, name))) {
      throw new Error(`Bundled ConPTY runtime is missing: ${join(source, name)}`)
    }
  }
  mkdirSync(destination, { recursive: true })
  for (const name of CONPTY_FILES) {
    copyFileSync(join(source, name), join(destination, name))
  }
}

function prepareDevelopmentConpty() {
  if (process.platform !== 'win32') return
  const packageDir = dirname(require.resolve('node-pty/package.json'))
  // electron-rebuild recreates build/Release after node-pty's own postinstall
  // copied these files. Restore them next to the rebuilt native binding.
  prepareConpty(join(packageDir, 'build', 'Release', 'conpty'))
}

function preparePackagedConpty(context) {
  if (context.electronPlatformName !== 'win32') return
  const arch = require('builder-util').Arch[context.arch]
  const packageDir = join(
    context.appOutDir,
    'resources',
    'app.asar.unpacked',
    'node_modules',
    'node-pty'
  )
  const bindings = ['build/Release', 'build/Debug', `prebuilds/win32-${arch}`]
  let prepared = false
  for (const directory of bindings) {
    const bindingDir = join(packageDir, directory)
    if (!existsSync(join(bindingDir, 'conpty.node'))) continue
    // electron-builder may rebuild once more during packaging. Put the DLL
    // and its console host beside every binding the runtime loader can select.
    prepareConpty(join(bindingDir, 'conpty'), arch)
    prepared = true
  }
  if (!prepared) throw new Error('Packaged ConPTY native binding was not found')
}

module.exports = { prepareDevelopmentConpty, preparePackagedConpty }
if (require.main === module) prepareDevelopmentConpty()
