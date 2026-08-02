import type { SpawnOptions } from '../../shared/ipc-contract'

export type TerminalLaunchOptions = Omit<SpawnOptions, 'cols' | 'rows'>

const launches = new Map<string, TerminalLaunchOptions>()

export function setTerminalLaunch(
  terminalId: string,
  options: TerminalLaunchOptions | undefined
): void {
  if (options) launches.set(terminalId, options)
}

export function getTerminalLaunch(
  terminalId: string
): TerminalLaunchOptions | undefined {
  return launches.get(terminalId)
}

export function removeTerminalLaunch(terminalId: string): void {
  launches.delete(terminalId)
}
