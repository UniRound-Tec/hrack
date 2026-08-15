const EVENTS = [
  'SessionStart',
  'SessionEnd',
  'SubagentStart',
  'PreToolUse',
  'PermissionRequest',
  'PostToolUse',
  'PreCompact',
  'PostCompact',
  'UserPromptSubmit',
  'SubagentStop',
  'Stop'
] as const

const POSIX_COMMAND = '/bin/sh "$HRACK_CODEX_HOOK_BRIDGE"'
const WINDOWS_COMMAND =
  'powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "& $env:HRACK_CODEX_HOOK_BRIDGE_WINDOWS"'

function tomlString(value: string): string {
  return JSON.stringify(value)
}

/** Byte-stable dotted overrides: runtime/session values only travel in env. */
export function buildCodexInlineHookConfig(): readonly string[] {
  const handler = `{type="command",command=${tomlString(POSIX_COMMAND)},commandWindows=${tomlString(WINDOWS_COMMAND)},timeout=3}`
  return EVENTS.map(
    (event) => `hooks.${event}=[{matcher=".*",hooks=[${handler}]}]`
  )
}

export function codexPosixBridgeScript(): string {
  return `#!/bin/sh
set -eu
umask 077
drop="\${HRACK_CODEX_HOOK_DROP:-}"
[ -n "$drop" ] && [ -d "$drop" ] || exit 0
tmp="$(mktemp "$drop/.hrack-codex.XXXXXX.partial")" || exit 0
trap 'rm -f "$tmp"' EXIT HUP INT TERM
dd bs=1048577 count=1 of="$tmp" 2>/dev/null || true
size="$(wc -c < "$tmp" | tr -d ' ')"
[ "$size" -gt 0 ] || exit 0
[ "$size" -le 1048576 ] || exit 0
final="$drop/$(date +%s).$$.$(basename "$tmp" .partial).json"
mv "$tmp" "$final"
trap - EXIT HUP INT TERM
`
}

export function codexWindowsBridgeScript(): string {
  return `$ErrorActionPreference = 'Stop'
try {
  $drop = $env:HRACK_CODEX_HOOK_DROP
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
