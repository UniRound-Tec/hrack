import type {
  CliRuntime,
  ShellOption,
  SpawnOptions
} from '../../shared/ipc-contract'
import { findDefaultShell } from './launchOptions'

export interface ChildTerminalPlan {
  shellId: string
  cwd: string
  shell: Omit<SpawnOptions, 'cols' | 'rows'>
}

interface ChildTerminalPlanInput {
  runtime: CliRuntime
  workspace: string
  shells: readonly ShellOption[]
  defaultShellId: string
}

export function planChildTerminal({
  runtime,
  workspace,
  shells,
  defaultShellId
}: ChildTerminalPlanInput): ChildTerminalPlan | null {
  const cwd = workspace.trim()
  if (!cwd) return null

  if (runtime.kind === 'wsl') {
    const wsl = shells.find((shell) => shell.id === 'wsl')
    if (!wsl) return null
    return {
      shellId: `wsl:${runtime.distro}`,
      cwd,
      shell: {
        shell: wsl.shell,
        args: [
          ...(wsl.args ?? []),
          '--distribution',
          runtime.distro,
          '--cd',
          cwd
        ]
      }
    }
  }

  const selected = findDefaultShell(shells, defaultShellId)
  if (!selected) return null
  return {
    shellId: selected.id,
    cwd,
    shell: {
      shell: selected.shell,
      args: selected.args,
      cwd
    }
  }
}
