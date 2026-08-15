import { extname } from 'node:path'
import type { CliInstallation } from '../../shared/ipc-contract'
import type {
  DshRuntimeCandidate,
  DshRuntimePreference
} from '../../shared/dsh-ipc'
import { DSH_COMPATIBLE_VERSION } from '../ai-cli-discovery'

export const bundledDshRuntime: DshRuntimeCandidate = {
  id: 'bundled',
  kind: 'bundled',
  version: DSH_COMPATIBLE_VERSION
}

export function dshCandidateFromInstallation(
  installation: CliInstallation
): Extract<DshRuntimeCandidate, { kind: 'installation' }> {
  return {
    id: installation.id,
    kind: 'installation',
    runtime: installation.runtime,
    resolvedExecutable: installation.resolvedExecutable,
    version: installation.version
  }
}

/**
 * auto 的稳定优先级：当前主机 > WSL（发行版名排序）> 内置兜底。
 * 显式选择不静默回退，避免用户以为正在使用 WSL，实际却落到内置版。
 */
export function selectDshRuntimeCandidates(
  preference: DshRuntimePreference,
  localCandidates: readonly Extract<
    DshRuntimeCandidate,
    { kind: 'installation' }
  >[]
): DshRuntimeCandidate[] {
  if (preference.kind === 'bundled') return [bundledDshRuntime]
  if (preference.kind === 'installation') {
    const selected = localCandidates.find(
      (candidate) => candidate.id === preference.installationId
    )
    if (!selected) {
      throw new Error(
        'Selected local DSH is no longer available; refresh the runtime scan'
      )
    }
    return [selected]
  }
  const sorted = [...localCandidates].sort((left, right) => {
    const leftRank = left.runtime.kind === 'host' ? 0 : 1
    const rightRank = right.runtime.kind === 'host' ? 0 : 1
    if (leftRank !== rightRank) return leftRank - rightRank
    const leftName = left.runtime.kind === 'wsl' ? left.runtime.distro : ''
    const rightName = right.runtime.kind === 'wsl' ? right.runtime.distro : ''
    return leftName.localeCompare(rightName) || left.id.localeCompare(right.id)
  })
  return [...sorted, bundledDshRuntime]
}

export interface DshExternalSpawnSpec {
  file: string
  args: string[]
  env: NodeJS.ProcessEnv
  windowsVerbatimArguments?: boolean
}

export const DSH_WSL_PID_MARKER = '__VIBING_DSH_PID__='

function quoteCmdArg(value: string): string {
  return `"${value.replace(/"/g, '""')}"`
}

/** 只负责把已验证安装变成精确 argv；不做路径搜索或 shell 字符串插值。 */
export function buildDshExternalSpawnSpec(options: {
  candidate: Extract<DshRuntimeCandidate, { kind: 'installation' }>
  port: number
  dshHome: string
  environmentPath?: string
  commandInterpreter?: string
  inheritedEnv?: NodeJS.ProcessEnv
}): DshExternalSpawnSpec {
  const { candidate, port, dshHome } = options
  const runtimeArgs = [
    'web',
    '--host', '127.0.0.1',
    '--port', String(port)
  ]
  const telemetry = options.inheritedEnv?.['DSH_TELEMETRY_DISABLED'] ?? '1'

  if (candidate.runtime.kind === 'wsl') {
    return {
      file: 'wsl.exe',
      args: [
        '--distribution', candidate.runtime.distro,
        '--exec',
        'sh',
        '-c',
        `printf '${DSH_WSL_PID_MARKER}%s\\n' "$$" >&2; exec env "$@"`,
        'vibing-dsh',
        ...(options.environmentPath
          ? [`PATH=${options.environmentPath}`]
          : []),
        `DSH_HOME=${dshHome}`,
        `DSH_TELEMETRY_DISABLED=${telemetry}`,
        candidate.resolvedExecutable,
        ...runtimeArgs
      ],
      // 环境必须进入 Linux 进程；这里只给 wsl.exe 保留宿主环境。
      env: { ...options.inheritedEnv }
    }
  }

  const env: NodeJS.ProcessEnv = {
    ...options.inheritedEnv,
    DSH_HOME: dshHome,
    DSH_TELEMETRY_DISABLED: telemetry
  }
  if (
    candidate.runtime.platform === 'windows' &&
    ['.cmd', '.bat'].includes(
      extname(candidate.resolvedExecutable).toLowerCase()
    )
  ) {
    const command = [candidate.resolvedExecutable, ...runtimeArgs]
      .map(quoteCmdArg)
      .join(' ')
    return {
      file: options.commandInterpreter ?? 'cmd.exe',
      args: ['/d', '/v:off', '/c', `call ${command}`],
      env,
      windowsVerbatimArguments: true
    }
  }
  return {
    file: candidate.resolvedExecutable,
    args: runtimeArgs,
    env
  }
}
