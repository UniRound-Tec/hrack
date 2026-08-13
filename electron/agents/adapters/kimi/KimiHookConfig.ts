export type KimiHookPlatform = 'windows' | 'posix'

export type KimiManagedHookMerge =
  | { ok: true; changed: boolean; content: string }
  | { ok: false; reason: 'kimi-config-marker-conflict' }

const MANAGED_START = '# >>> vibing:kimi-observer:v1'
const MANAGED_END = '# <<< vibing:kimi-observer:v1'

const EVENTS = [
  'SessionStart',
  'SessionEnd',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'PermissionRequest',
  'PermissionResult',
  'Stop',
  'StopFailure',
  'Interrupt',
  'SubagentStart',
  'SubagentStop'
] as const

const POSIX_COMMAND =
  'if [ -n "${VIBING_KIMI_HOOK_BRIDGE:-}" ] && [ -f "$VIBING_KIMI_HOOK_BRIDGE" ]; then /bin/sh "$VIBING_KIMI_HOOK_BRIDGE" >/dev/null 2>&1 || :; fi'
const WINDOWS_COMMAND =
  'powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "if ($env:VIBING_KIMI_HOOK_BRIDGE_WINDOWS -and (Test-Path -LiteralPath $env:VIBING_KIMI_HOOK_BRIDGE_WINDOWS -PathType Leaf)) { & $env:VIBING_KIMI_HOOK_BRIDGE_WINDOWS }; exit 0"'

function lineEnding(source: string): '\r\n' | '\n' {
  return source.includes('\r\n') ? '\r\n' : '\n'
}

function tomlString(value: string): string {
  return JSON.stringify(value)
}

interface ManagedMarker {
  offset: number
  length: number
  version: string
}

function managedMarkers(
  source: string,
  boundary: 'start' | 'end'
): ManagedMarker[] {
  const pattern =
    boundary === 'start'
      ? /(^|\n)(# >>> vibing:kimi-observer:v([0-9]+))(?=\r?\n|$)/g
      : /(^|\n)(# <<< vibing:kimi-observer:v([0-9]+))(?=\r?\n|$)/g
  const markers: ManagedMarker[] = []
  for (const match of source.matchAll(pattern)) {
    markers.push({
      offset: match.index + match[1].length,
      length: match[2].length,
      version: match[3]
    })
  }
  return markers
}

export function buildKimiManagedHookBlock(
  platform: KimiHookPlatform,
  eol: '\r\n' | '\n' = '\n'
): string {
  const command = platform === 'windows' ? WINDOWS_COMMAND : POSIX_COMMAND
  const hooks = EVENTS.map((event) =>
    [
      '[[hooks]]',
      `event = ${tomlString(event)}`,
      `command = ${tomlString(command)}`,
      'timeout = 3'
    ].join(eol)
  ).join(`${eol}${eol}`)
  return [MANAGED_START, hooks, MANAGED_END].join(eol)
}

export function kimiWindowsBridgeScript(): string {
  return `$ErrorActionPreference = 'Stop'
try {
  $drop = $env:VIBING_KIMI_HOOK_DROP
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

export function kimiPosixBridgeScript(): string {
  return `#!/bin/sh
set -eu
umask 077
drop="\${VIBING_KIMI_HOOK_DROP:-}"
[ -n "$drop" ] && [ -d "$drop" ] || exit 0
tmp="$(mktemp "$drop/.vibing-kimi.XXXXXX.partial")" || exit 0
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

export function mergeKimiManagedHooks(
  source: string,
  platform: KimiHookPlatform
): KimiManagedHookMerge {
  const eol = lineEnding(source)
  const block = buildKimiManagedHookBlock(platform, eol)
  const starts = managedMarkers(source, 'start')
  const ends = managedMarkers(source, 'end')
  if (starts.length > 0 || ends.length > 0) {
    if (
      starts.length !== 1 ||
      ends.length !== 1 ||
      starts[0].version !== ends[0].version ||
      starts[0].offset >= ends[0].offset
    ) {
      return { ok: false, reason: 'kimi-config-marker-conflict' }
    }
    const content =
      source.slice(0, starts[0].offset) +
      block +
      source.slice(ends[0].offset + ends[0].length)
    return { ok: true, changed: content !== source, content }
  }
  if (source.length === 0) {
    return { ok: true, changed: true, content: `${block}${eol}` }
  }
  const separator = source.endsWith(`${eol}${eol}`)
    ? ''
    : source.endsWith(eol)
      ? eol
      : `${eol}${eol}`
  return {
    ok: true,
    changed: true,
    content: `${source}${separator}${block}${eol}`
  }
}
