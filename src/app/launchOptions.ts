import type { ShellOption } from '../../shared/ipc-contract'

export const cliOptions = [
  {
    id: 'codex',
    adapterId: 'codex',
    name: 'Codex',
    hint: 'OpenAI coding agent',
    executable: 'codex',
    defaultArgs: '--full-auto'
  },
  {
    id: 'claude',
    adapterId: 'claude-code',
    name: 'Claude Code',
    hint: 'Anthropic CLI',
    executable: 'claude',
    defaultArgs: '--dangerously-skip-permissions'
  },
  {
    id: 'cursor',
    adapterId: 'cursor-agent',
    name: 'Cursor Agent',
    hint: 'In-editor agent',
    executable: 'cursor-agent',
    defaultArgs: ''
  },
  {
    id: 'gemini',
    adapterId: 'gemini',
    name: 'Gemini CLI',
    hint: 'Google AI CLI',
    executable: 'gemini',
    defaultArgs: '--yolo'
  },
  {
    id: 'opencode',
    adapterId: 'opencode',
    name: 'OpenCode',
    hint: 'Open-source agent',
    executable: 'opencode',
    defaultArgs: ''
  },
  {
    id: 'aider',
    adapterId: 'aider',
    name: 'Aider',
    hint: 'Pair programming CLI',
    executable: 'aider',
    defaultArgs: '--yes'
  }
] as const

export type CliOption = (typeof cliOptions)[number]
export type CliRuntime = 'windows' | 'wsl'

export interface CliLaunchDraft {
  option: CliOption
  name: string
  workspace: string
  args: string
  runtime: CliRuntime
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

export function buildCliLaunch(draft: CliLaunchDraft) {
  const userArgs = parseCommandLine(draft.args)
  const cwd = draft.workspace.trim() || undefined
  return draft.runtime === 'wsl'
    ? {
        shell: 'wsl.exe',
        args: ['-e', draft.option.executable, ...userArgs],
        cwd
      }
    : {
        shell: draft.option.executable,
        args: userArgs,
        cwd
      }
}

export function findDefaultShell(
  shells: readonly ShellOption[],
  shellId: string
): ShellOption | undefined {
  return shells.find((shell) => shell.id === shellId) ?? shells[0]
}
