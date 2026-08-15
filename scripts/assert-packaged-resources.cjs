const { existsSync, readdirSync, statSync } = require('node:fs')
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

function assertDirectory(path, label) {
  if (!existsSync(path) || readdirSync(path).length === 0) {
    throw new Error(`Packaged dsh runtime part is missing or empty (${label}): ${path}`)
  }
}

function findNodePtyNativeDir(runtimeRoot, platform, archName) {
  const nodePtyRoot = join(runtimeRoot, 'node_modules', 'node-pty')
  const candidates = [
    join(nodePtyRoot, 'build', 'Release'),
    join(nodePtyRoot, 'prebuilds', `${platform}-${archName}`)
  ]
  return candidates.find((candidate) =>
    existsSync(join(candidate, 'pty.node'))
  )
}

function archNamesOf(context) {
  if (Array.isArray(context.archNames)) return context.archNames
  if (context.arch === undefined) return []
  let archEnum
  try {
    // afterPack 上下文里的 arch 是 builder-util 的 Arch 数字枚举。
    archEnum = require('builder-util').Arch
  } catch {
    archEnum = { 0: 'ia32', 1: 'x64', 2: 'armv7l', 3: 'arm64', 4: 'universal' }
  }
  const name = archEnum[context.arch]
  return name ? [name] : []
}

function assertDshRuntime(context) {
  const resources = packagedResourcesDir(context)
  const runtimeRoot = join(resources, 'dsh-runtime')

  // 1. host 入口：utilityProcess.fork 的目标（resolveDshBinPath 的打包分支）。
  //    DSH_BIN_SEGMENTS 已含 dsh-runtime 前缀，直接挂在 resources 下。
  const bin = join(resources, ...DSH_BIN_SEGMENTS)
  if (!existsSync(bin)) {
    throw new Error(`Packaged dsh runtime is missing: ${bin}`)
  }

  // 2. dsh 自带配置目录（package.json files 字段声明，host 启动要读）。
  assertDirectory(join(runtimeRoot, 'node_modules', '@deepseek-ai', 'dsh', 'config'), 'dsh config')

  // 3. 当前平台的 node-pty prebuilds：PTY spawn 的原生二进制。
  //    只验当前打包平台，不要求跨平台 prebuilds 全数在场。
  const archNames = archNamesOf(context)
  for (const archName of archNames) {
    const nativeDir = findNodePtyNativeDir(
      runtimeRoot,
      context.electronPlatformName,
      archName
    )
    if (!nativeDir) {
      throw new Error(
        `Packaged node-pty native runtime is missing (${context.electronPlatformName}-${archName})`
      )
    }
  }

  // 4. macOS：node-pty 通过 spawn-helper 启动子进程，因此 helper 必须存在
  //    且带执行位。Linux 的原生实现直接使用 forkpty，不会生成或使用 helper。
  if (context.electronPlatformName === 'darwin') {
    for (const archName of archNames) {
      const nativeDir = findNodePtyNativeDir(
        runtimeRoot,
        context.electronPlatformName,
        archName
      )
      const helper = nativeDir ? join(nativeDir, 'spawn-helper') : ''
      if (!existsSync(helper)) {
        throw new Error(`Packaged ${context.electronPlatformName} spawn-helper is missing: ${helper}`)
      }
      if (process.platform !== 'win32' && (statSync(helper).mode & 0o111) === 0) {
        throw new Error(`Packaged ${context.electronPlatformName} spawn-helper is not executable: ${helper}`)
      }
    }
  }
}

exports.default = async function assertPackagedResources(context) {
  await assertPackagedTrayAssets.default(context)
  assertDshRuntime(context)
}
