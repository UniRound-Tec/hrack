'use strict'

/**
 * 确保 dsh-runtime/ 隔离依赖树存在（fresh clone 后首次构建/开发前自动安装）。
 *
 * electron.vite.config.ts 在 config 加载期就 resolve dsh-runtime/node_modules 里的
 * 包；tsconfig.web.json 的路径映射、主进程 unpackaged 的 bin.js 解析、e2e 断言
 * 也都依赖这棵树。它被 gitignore（254 MiB），因此根 postinstall / predev /
 * pretypecheck / build 都先跑本脚本；已存在时是毫秒级 no-op。
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
