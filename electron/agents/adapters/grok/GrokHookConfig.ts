import { Buffer } from 'node:buffer'
import { GROK_HOOK_FILE_NAME } from './types'

export type GrokHookPlatform = 'windows' | 'posix'

const EVENTS = [
  'SessionStart',
  'SessionEnd',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'PermissionDenied',
  'Stop',
  'StopFailure',
  'StopCancelled',
  'SubagentStart',
  'SubagentStop'
] as const

const POSIX_COMMAND =
  'if [ -n "${HRACK_GROK_HOOK_BRIDGE:-}" ] && [ -f "$HRACK_GROK_HOOK_BRIDGE" ]; then /bin/sh "$HRACK_GROK_HOOK_BRIDGE" >/dev/null 2>&1 || :; fi'
const WINDOWS_SCRIPT =
  "$p=[Environment]::GetEnvironmentVariable('HRACK_GROK_HOOK_BRIDGE_WINDOWS'); if ($p -and (Test-Path -LiteralPath $p -PathType Leaf)) { & $p }; exit 0"
const WINDOWS_COMMAND = `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ${Buffer.from(WINDOWS_SCRIPT, 'utf16le').toString('base64')}`

export function grokWindowsHookCommand(): string {
  return WINDOWS_COMMAND
}

export function grokPosixHookCommand(): string {
  return POSIX_COMMAND
}

function handler(platform: GrokHookPlatform): {
  type: 'command'
  command: string
  timeout: number
} {
  return {
    type: 'command',
    command: platform === 'windows' ? WINDOWS_COMMAND : POSIX_COMMAND,
    timeout: 3
  }
}

export function buildGrokManagedHookFile(platform: GrokHookPlatform): string {
  const command = handler(platform)
  const hooks: Record<string, unknown> = {}
  for (const event of EVENTS) {
    hooks[event] = [{ hooks: [command] }]
  }
  hooks.Notification = [
    { matcher: 'permission_prompt', hooks: [command] }
  ]
  return `${JSON.stringify({ hooks }, null, 2)}\n`
}

function decodedHookCommands(serialized: string): string {
  const encoded = [
    ...serialized.matchAll(/-EncodedCommand\s+([A-Za-z0-9+/=]+)/g)
  ]
  if (encoded.length === 0) return serialized
  const decoded = encoded
    .map((match) => {
      try {
        return Buffer.from(match[1], 'base64').toString('utf16le')
      } catch {
        return ''
      }
    })
    .join('\n')
  return `${serialized}\n${decoded}`
}

export function isHrackGrokHookFile(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const hooks = (value as { hooks?: unknown }).hooks
  if (!hooks || typeof hooks !== 'object' || Array.isArray(hooks)) return false
  const start = (hooks as { SessionStart?: unknown }).SessionStart
  const haystack = decodedHookCommands(JSON.stringify(start ?? ''))
  return (
    haystack.includes('HRACK_GROK_HOOK_BRIDGE') ||
    haystack.includes('HRACK_GROK_HOOK_BRIDGE_WINDOWS')
  )
}

export function grokHookFileName(): string {
  return GROK_HOOK_FILE_NAME
}

export function grokWindowsBridgeScript(): string {
  return `$ErrorActionPreference = 'Stop'
try {
  $drop = $env:HRACK_GROK_HOOK_DROP
  if ([string]::IsNullOrWhiteSpace($drop) -or -not [IO.Directory]::Exists($drop)) { exit 0 }
  $inputStream = [Console]::OpenStandardInput()
  $memory = [IO.MemoryStream]::new()
  $buffer = [byte[]]::new(8192)
  while (($read = $inputStream.Read($buffer, 0, $buffer.Length)) -gt 0) {
    $memory.Write($buffer, 0, $read)
    if ($memory.Length -gt 1048576) { exit 0 }
  }
  if ($memory.Length -le 0) { exit 0 }
  $nonce = [IO.Path]::GetRandomFileName()
  $temp = [IO.Path]::Combine($drop, ".$nonce.partial")
  $final = [IO.Path]::Combine($drop, "$([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()).$PID.$nonce.json")
  [IO.File]::WriteAllBytes($temp, $memory.ToArray())
  [IO.File]::Move($temp, $final)
} catch {
  exit 0
}
exit 0
`
}

export function grokPosixBridgeScript(): string {
  return `#!/bin/sh
set -eu
umask 077
drop="\${HRACK_GROK_HOOK_DROP:-}"
[ -n "$drop" ] && [ -d "$drop" ] || exit 0
tmp="$(mktemp "$drop/.hrack-grok.XXXXXX.partial")" || exit 0
trap 'rm -f "$tmp"' EXIT HUP INT TERM
dd bs=1048577 count=1 of="$tmp" 2>/dev/null || true
size="$(wc -c < "$tmp" | tr -d ' ')"
[ "$size" -gt 0 ] || exit 0
[ "$size" -le 1048576 ] || exit 0
final="$drop/$(date +%s).$$.$(basename "$tmp" .partial).json"
mv "$tmp" "$final"
trap - EXIT HUP INT TERM
exit 0
`
}
