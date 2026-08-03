import type {
  CliLaunchSelection,
  LaunchableCli,
  ShellOption
} from '../../shared/ipc-contract'

export type CliOption = LaunchableCli

export interface CliLaunchDraft {
  option: CliOption
  installationId: string
  name: string
  workspace: string
  args: string
}

/** Shell-like argument splitting without invoking a command interpreter. */
export function parseCommandLine(source: string): string[] {
  const args: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null
  let escaped = false

  const normalized = source.trim()
  for (let index = 0; index < normalized.length; index++) {
    const character = normalized[index]
    if (escaped) {
      current += character
      escaped = false
      continue
    }
    if (character === '\\' && quote !== "'") {
      const next = normalized[index + 1]
      if (next && (next === '\\' || next === '"' || /\s/.test(next))) {
        escaped = true
      } else {
        current += character
      }
      continue
    }
    if (character === '"' || character === "'") {
      if (quote === character) quote = null
      else if (!quote) quote = character
      else current += character
      continue
    }
    if (/\s/.test(character) && !quote) {
      if (current) {
        args.push(current)
        current = ''
      }
      continue
    }
    current += character
  }
  if (escaped) current += '\\'
  if (current) args.push(current)
  return args
}

export function buildCliLaunchSelection(
  draft: CliLaunchDraft
): CliLaunchSelection {
  return {
    installationId: draft.installationId,
    workspace: draft.workspace.trim(),
    args: parseCommandLine(draft.args)
  }
}

export function findDefaultShell(
  shells: readonly ShellOption[],
  shellId: string
): ShellOption | undefined {
  return shells.find((shell) => shell.id === shellId) ?? shells[0]
}
