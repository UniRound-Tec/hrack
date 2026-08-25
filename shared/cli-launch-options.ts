import type { CliSkipApprovalLaunch } from './ipc-contract'

export function skipApprovalTokens(skip: CliSkipApprovalLaunch): string[] {
  return [...skip.args, ...(skip.alreadyPresent ?? [])]
}

export function hasSkipApprovalArgs(
  parsedArgs: readonly string[],
  skip: CliSkipApprovalLaunch
): boolean {
  const tokens = new Set(
    skipApprovalTokens(skip).map((token) => token.toLowerCase())
  )
  return parsedArgs.some((arg) => tokens.has(arg.toLowerCase()))
}

/** Skip-approval tokens go first so subcommands like Devin `bypass` stay positional. */
export function mergeSkipApprovalArgs(
  parsedArgs: readonly string[],
  skip: CliSkipApprovalLaunch | undefined,
  enabled: boolean
): string[] {
  if (!enabled || !skip || skip.args.length === 0) return [...parsedArgs]
  if (hasSkipApprovalArgs(parsedArgs, skip)) return [...parsedArgs]
  return [...skip.args, ...parsedArgs]
}
