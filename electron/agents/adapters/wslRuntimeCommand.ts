import type { ObserverPreparationContext } from './types'

export interface WslRuntimeCommand {
  file: 'wsl.exe'
  args: readonly string[]
}

/**
 * 在 WSL 中执行已扫描到的 CLI，且严格复用正式启动时的 PATH。
 *
 * NVM、Volta、asdf 等安装出来的可执行文件经常是
 * `#!/usr/bin/env node` 包装器。只有绝对路径还不够：若裸执行，env 会
 * 从 WSL 的非登录环境找到系统旧 Node，造成 capability probe 假失败。
 * 缺少扫描环境时以 executable 所在目录作为保守兜底。
 */
export function wslRuntimeCommand(
  context: ObserverPreparationContext,
  commandArgs: readonly string[],
  argv0 = 'vibing-adapter-probe'
): WslRuntimeCommand {
  if (context.installation.runtime.kind !== 'wsl') {
    throw new Error('wslRuntimeCommand requires a WSL installation')
  }

  const prefix = [
    '--distribution',
    context.installation.runtime.distro,
    '--exec'
  ]
  const runtimePath = context.runtimeEnvironment?.PATH
  if (runtimePath) {
    return {
      file: 'wsl.exe',
      args: [
        ...prefix,
        'env',
        `PATH=${runtimePath}`,
        context.installation.resolvedExecutable,
        ...commandArgs
      ]
    }
  }

  return {
    file: 'wsl.exe',
    args: [
      ...prefix,
      '/bin/sh',
      '-lc',
      'p="$1"; shift; PATH="$(dirname "$p"):$PATH" exec "$p" "$@"',
      argv0,
      context.installation.resolvedExecutable,
      ...commandArgs
    ]
  }
}
