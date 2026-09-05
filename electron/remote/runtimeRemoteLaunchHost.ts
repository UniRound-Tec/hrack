import { randomUUID } from 'node:crypto'
import { posix, win32 } from 'node:path'
import { mergeSkipApprovalArgs } from '../../shared/cli-launch-options'
import type {
  CliLaunchSelection,
  CliScanReport,
  RemoteVisibleLaunchRequest
} from '../../shared/ipc-contract'
import type { StartedAgentSession } from '../../shared/agent-events'
import type { RemoteLaunchable } from '../../shared/remote-protocol'
import type {
  RemoteLaunchHost,
  RemoteLaunchRequest,
  RemoteLaunchResult
} from './RemoteDesktopClient'

interface RemoteLaunchDiscovery {
  scan(force?: boolean): Promise<CliScanReport>
  resolveWorkspace(installationId: string, workspace: string): Promise<string>
}

interface RemoteLaunchRuntime {
  start(input: {
    terminalId: string
    selection: CliLaunchSelection
    name: string
    cols: number
    rows: number
  }): Promise<StartedAgentSession>
}

function safeCatalog(report: CliScanReport): RemoteLaunchable[] {
  return report.launchable.map((launchable) => ({
    definition: {
      id: launchable.definition.id,
      adapterId: launchable.definition.adapterId,
      displayName: launchable.definition.displayName,
      iconId: launchable.definition.iconId
    },
    ...(launchable.definition.skipApproval
      ? { skipApproval: { label: launchable.definition.skipApproval.label } }
      : {}),
    installations: launchable.installations.map((installation) => ({
      id: installation.id,
      runtime: { ...installation.runtime },
      ...(installation.version ? { version: installation.version } : {})
    }))
  }))
}

export function runtimeRemoteLaunchHost(
  discovery: RemoteLaunchDiscovery,
  runtime: RemoteLaunchRuntime,
  show: (request: RemoteVisibleLaunchRequest) => void
): RemoteLaunchHost {
  return {
    async catalog() {
      return safeCatalog(await discovery.scan(false))
    },

    async create(input: RemoteLaunchRequest): Promise<RemoteLaunchResult> {
      const workspace = input.workspace.trim()
      if (!workspace) return { ok: false, reason: 'invalid-workspace' }

      const report = await discovery.scan(false)
      const launchable = report.launchable.find((candidate) =>
        candidate.installations.some(
          (installation) => installation.id === input.installationId
        )
      )
      if (!launchable) {
        return { ok: false, reason: 'installation-not-found' }
      }
      const installation = launchable.installations.find(
        (candidate) => candidate.id === input.installationId
      )
      if (!installation) {
        return { ok: false, reason: 'installation-not-found' }
      }
      // 相对路径会被 CLI 静默解析到主进程 CWD；与 workspace 浏览一致，
      // 远程启动只接受目标运行环境的绝对路径。
      const pathApi =
        installation.runtime.kind === 'wsl' ||
        installation.runtime.platform !== 'windows'
          ? posix
          : win32
      if (!pathApi.isAbsolute(workspace)) {
        return { ok: false, reason: 'invalid-workspace' }
      }

      let resolvedWorkspace: string
      try {
        resolvedWorkspace = await discovery.resolveWorkspace(
          input.installationId,
          workspace
        )
      } catch {
        return { ok: false, reason: 'invalid-workspace' }
      }

      const selection: CliLaunchSelection = {
        installationId: input.installationId,
        workspace: resolvedWorkspace,
        args: mergeSkipApprovalArgs(
          input.args,
          launchable.definition.skipApproval,
          input.skipApproval
        )
      }
      const terminalId = randomUUID()
      let started: StartedAgentSession
      try {
        started = await runtime.start({
          terminalId,
          selection,
          name: launchable.definition.displayName,
          cols: input.cols,
          rows: input.rows
        })
      } catch {
        return { ok: false, reason: 'launch-failed' }
      }

      try {
        show({
          terminalId,
          name: launchable.definition.displayName,
          adapterId: launchable.definition.adapterId,
          workspace: resolvedWorkspace,
          selection,
          ptyId: started.ptyId
        })
      } catch {
        // The main-process session remains authoritative and remotely drivable;
        // renderer recovery can attach it from listRecoverable later.
      }
      return {
        ok: true,
        sessionId: started.sessionId,
        workspace: resolvedWorkspace
      }
    }
  }
}
