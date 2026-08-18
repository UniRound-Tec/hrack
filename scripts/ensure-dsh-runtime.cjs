'use strict'

/**
 * 确保 dsh-runtime/ 隔离依赖树存在。
 *
 * 这棵树只给 e2e 当作「本机已安装的 DSH」夹具，不再打进发行包。
 * 体积约 254 MiB 且被 gitignore；已存在时是毫秒级 no-op。
 */

const { existsSync } = require('node:fs')
const { join, resolve } = require('node:path')
const { spawnSync } = require('node:child_process')

const repoRoot = resolve(__dirname, '..')
const runtimeDir = join(repoRoot, 'dsh-runtime')
const marker = join(
  runtimeDir,
  'node_modules',
  '@deepseek-ai',
  'dsh',
  'lib',
  'bin.js'
)

if (existsSync(marker)) {
  process.exit(0)
}

console.log('[dsh-runtime] isolated dependency tree missing, installing (first run)...')
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
// node-pty does not ship Linux prebuilds in the DSH dependency tree. Its
// install script must compile build/Release/pty.node and spawn-helper there.
// Windows/macOS use the packaged prebuilds and keep lifecycle scripts disabled.
const installArgs = ['ci', '--no-audit', '--no-fund']
if (process.platform !== 'linux') installArgs.splice(1, 0, '--ignore-scripts')
const result = spawnSync(
  npm,
  installArgs,
  {
    cwd: runtimeDir,
    stdio: 'inherit',
    shell: process.platform === 'win32'
  }
)
if (result.error) {
  console.error('[dsh-runtime] failed to launch npm:', result.error.message)
  process.exit(1)
}
if (result.status !== 0) {
  console.error(`[dsh-runtime] npm ci exited with ${result.status}`)
  process.exit(result.status ?? 1)
}
if (!existsSync(marker)) {
  console.error('[dsh-runtime] install finished but bin.js is still missing:')
  console.error(`  ${marker}`)
  process.exit(1)
}
