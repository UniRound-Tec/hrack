import { extname } from 'node:path'
import type { CliInstallation } from '../../shared/ipc-contract'
import type {
  DshRuntimeCandidate,
  DshRuntimePreference
} from '../../shared/dsh-ipc'

export function dshCandidateFromInstallation(
  installation: CliInstallation
): DshRuntimeCandidate {
  return {
    id: installation.id,
    kind: 'installation',
    runtime: installation.runtime,
    resolvedExecutable: installation.resolvedExecutable,
    version: installation.version
  }
}

/**
 * auto 的稳定优先级：当前主机 > WSL（发行版名排序）。
 * 找不到安装时返回空列表；显式选择不静默改选其它安装。
 */
export function selectDshRuntimeCandidates(
  preference: DshRuntimePreference,
  localCandidates: readonly DshRuntimeCandidate[]
): DshRuntimeCandidate[] {
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
  return [...localCandidates].sort((left, right) => {
    const leftRank = left.runtime.kind === 'host' ? 0 : 1
    const rightRank = right.runtime.kind === 'host' ? 0 : 1
    if (leftRank !== rightRank) return leftRank - rightRank
    const leftName = left.runtime.kind === 'wsl' ? left.runtime.distro : ''
    const rightName = right.runtime.kind === 'wsl' ? right.runtime.distro : ''
    return leftName.localeCompare(rightName) || left.id.localeCompare(right.id)
  })
}

export interface DshExternalSpawnSpec {
  file: string
  args: string[]
  env: NodeJS.ProcessEnv
  windowsVerbatimArguments?: boolean
}

export const DSH_WSL_PID_MARKER = '__HRACK_DSH_PID__='

/**
 * DSH opens the OS browser when `openBrowser` is true and SSH_CONNECTION /
 * SSH_TTY are unset. HRack embeds the official page, so the spawned host
 * always carries this marker — including first profile boot, before `--no-open`
 * is parsed, and WSL installs that reject the flag.
 */
export const DSH_EMBED_SSH_CONNECTION = 'hrack-embed'

function quoteCmdArg(value: string): string {
  return `"${value.replace(/"/g, '""')}"`
}

/**
 * `dsh web` started opening the OS browser in 0.1.0-rc.7. HRack embeds the
 * official page in a WebContentsView, so those versions need `--no-open`.
 * Older web CLIs reject the flag.
 */
export function dshWebOpensBrowserByDefault(version?: string): boolean {
  if (!version) return false
  const parts = dshVersionParts(version)
  if (!parts) return false
  const minimum: [number, number, number, number] = [0, 1, 0, 7]
  for (let index = 0; index < 4; index += 1) {
    if (parts[index] > minimum[index]) return true
    if (parts[index] < minimum[index]) return false
  }
  return true
}

function dshVersionParts(
  version: string
): [number, number, number, number] | null {
  const rcMatch = version.match(/(\d+)\.(\d+)\.(\d+)-rc\.(\d+)/i)
  if (rcMatch) {
    return [
      Number(rcMatch[1]),
      Number(rcMatch[2]),
      Number(rcMatch[3]),
      Number(rcMatch[4])
    ]
  }
  const stable = version.match(/(\d+)\.(\d+)\.(\d+)/)
  if (!stable) return null
  return [
    Number(stable[1]),
    Number(stable[2]),
    Number(stable[3]),
    Number.POSITIVE_INFINITY
  ]
}

export function dshWebRuntimeArgs(
  port: number,
  version?: string,
  noOpen?: boolean
): string[] {
  const args = [
    'web',
    '--host', '127.0.0.1',
    '--port', String(port)
  ]
  if (noOpen ?? true) args.push('--no-open')
  return args
}

/** CLI version is not the web-app flag set; WSL rc.7 still rejects `--no-open`. */
export function dshRejectedNoOpenOption(output: string): boolean {
  return /unknown option ['"]?--no-open['"]?/i.test(output)
}

/** 只负责把已验证安装变成精确 argv；不做路径搜索或 shell 字符串插值。 */
export function buildDshExternalSpawnSpec(options: {
  candidate: DshRuntimeCandidate
  port: number
  dshHome: string
  environmentPath?: string
  commandInterpreter?: string
  inheritedEnv?: NodeJS.ProcessEnv
  /** When set, overrides the version heuristic for `--no-open`. */
  noOpen?: boolean
}): DshExternalSpawnSpec {
  const { candidate, port, dshHome } = options
  const runtimeArgs = dshWebRuntimeArgs(port, candidate.version, options.noOpen)
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
        'hrack-dsh',
        ...(options.environmentPath
          ? [`PATH=${options.environmentPath}`]
          : []),
        `DSH_HOME=${dshHome}`,
        `DSH_TELEMETRY_DISABLED=${telemetry}`,
        `SSH_CONNECTION=${DSH_EMBED_SSH_CONNECTION}`,
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
    DSH_TELEMETRY_DISABLED: telemetry,
    SSH_CONNECTION: DSH_EMBED_SSH_CONNECTION
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
