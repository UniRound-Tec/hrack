import type {
  CliLaunchSelection,
  SpawnOptions
} from '../../shared/ipc-contract'

export type TerminalLaunch =
  | { kind: 'shell'; shell: Omit<SpawnOptions, 'cols' | 'rows'> }
  | { kind: 'agent'; selection: CliLaunchSelection; name: string }
  | { kind: 'attach'; ptyId: string; agent: boolean }

export type TerminalLaunchOptions = TerminalLaunch

const launches = new Map<string, TerminalLaunch>()

export function setTerminalLaunch(
  terminalId: string,
  options: TerminalLaunch | undefined
): void {
  if (options) launches.set(terminalId, options)
}

export function getTerminalLaunch(
  terminalId: string
): TerminalLaunch | undefined {
  return launches.get(terminalId)
}

export function removeTerminalLaunch(terminalId: string): void {
  launches.delete(terminalId)
}
