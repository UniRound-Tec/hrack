import { randomBytes } from 'node:crypto'
import { chmod, open, rm } from 'node:fs/promises'
import { join, posix } from 'node:path'
import type { ObserverPreparationContext } from '../types'
import { buildGrokManagedHookFile, grokHookFileName } from './GrokHookConfig'
import type { EnsureGrokManagedHooksResult } from './GrokHookStore'

interface CommandResult {
  code: number | null
  stdout: string
}

export type GrokCommandRunner = (
  file: string,
  args: readonly string[]
) => Promise<CommandResult>

const inProcessWslTails = new Map<string, Promise<void>>()

async function withWslMutex<T>(
  distro: string,
  action: () => Promise<T>
): Promise<T> {
  const key = distro.toLowerCase()
  const previous = (
    inProcessWslTails.get(key) ?? Promise.resolve()
  ).catch(() => {})
  let release!: () => void
  const gate = new Promise<void>((resolveGate) => (release = resolveGate))
  const tail = previous.then(() => gate)
  inProcessWslTails.set(key, tail)
  await previous
  try {
    return await action()
  } finally {
    release()
    if (inProcessWslTails.get(key) === tail) inProcessWslTails.delete(key)
  }
}

function wslShellArgs(
  distro: string,
  script: string,
  argv0: string,
  args: readonly string[] = []
): readonly string[] {
  return [
    '--distribution',
    distro,
    '--exec',
    '/bin/sh',
    '-c',
    script,
    argv0,
    ...args
  ]
}

function loginEnvironmentValue(output: string, key: string): string | undefined {
  const prefix = `${key}=`
  for (const entry of output.split('\0')) {
    const line = entry
      .split(/\r?\n/)
      .reverse()
      .find((candidate) => candidate.startsWith(prefix))
    if (line) return line.slice(prefix.length)
  }
  return undefined
}

async function writePrivateFile(path: string, content: string): Promise<void> {
  const file = await open(path, 'wx', 0o600)
  try {
    await file.writeFile(content, 'utf8')
    await file.sync()
  } finally {
    await file.close()
  }
  if (process.platform !== 'win32') await chmod(path, 0o600)
}

async function ensureWslGrokManagedHooksUnlocked(
  context: ObserverPreparationContext,
  runtimeRunDir: string,
  runCommand: GrokCommandRunner
): Promise<EnsureGrokManagedHooksResult> {
  if (context.installation.runtime.kind !== 'wsl') {
    return { ok: false, reason: 'grok-hook-path-unavailable' }
  }
  const distro = context.installation.runtime.distro
  const shellResult = await runCommand(
    'wsl.exe',
    wslShellArgs(
      distro,
      'printf "%s\\n" "${SHELL:-/bin/sh}"',
      'hrack-grok-hook-shell'
    )
  )
  const shell = shellResult.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .reverse()
    .find((line) => line.startsWith('/') && line.length <= 4_096)
  if (shellResult.code !== 0 || !shell) {
    return { ok: false, reason: 'grok-hook-path-unavailable' }
  }
  const loginEnvironment = await runCommand('wsl.exe', [
    '--distribution',
    distro,
    '--exec',
    shell,
    '-lic',
    'env -0',
    'hrack-grok-hook-home'
  ])
  const configuredHome = loginEnvironmentValue(
    loginEnvironment.stdout,
    'GROK_HOME'
  )
  const userHome = loginEnvironmentValue(loginEnvironment.stdout, 'HOME')
  const grokHome =
    configuredHome || (userHome ? posix.join(userHome, '.grok') : '')
  if (
    loginEnvironment.code !== 0 ||
    !grokHome.startsWith('/') ||
    grokHome.length > 4_080 ||
    /[\r\n]/.test(grokHome)
  ) {
    return { ok: false, reason: 'grok-hook-path-unavailable' }
  }
  const hookPath = posix.join(grokHome, 'hooks', grokHookFileName())
  const candidateName = `grok-hook-candidate-${randomBytes(6).toString('hex')}.json`
  const hostCandidate = join(context.runDir, candidateName)
  const runtimeCandidate = posix.join(runtimeRunDir, candidateName)
  try {
    await writePrivateFile(hostCandidate, buildGrokManagedHookFile('posix'))
    const install = await runCommand(
      'wsl.exe',
      wslShellArgs(
        distro,
        [
          'set -eu',
          'hook="$1"',
          'candidate="$2"',
          'nonce="$3"',
          'dir="$(dirname "$hook")"',
          'mkdir -p "$dir"',
          'if [ -f "$hook" ]; then',
          '  if ! grep -q HRACK_GROK_HOOK_BRIDGE "$hook"; then exit 17; fi',
          '  if cmp -s "$hook" "$candidate"; then exit 0; fi',
          'fi',
          'tmp="$dir/.hrack-observer.json.$nonce.tmp"',
          'trap \'rm -f "$tmp"\' EXIT HUP INT TERM',
          'cp -- "$candidate" "$tmp"',
          'chmod 600 "$tmp"',
          'mv -f -- "$tmp" "$hook"',
          'trap - EXIT HUP INT TERM'
        ].join('\n'),
        'hrack-grok-hook-install',
        [
          hookPath,
          runtimeCandidate,
          context.sessionId.replaceAll(/[^a-zA-Z0-9_-]/g, '_')
        ]
      )
    )
    if (install.code === 17) {
      return { ok: false, reason: 'grok-hook-file-conflict' }
    }
    return install.code === 0
      ? { ok: true, changed: true, path: hookPath }
      : { ok: false, reason: 'grok-hook-write-failed' }
  } catch {
    return { ok: false, reason: 'grok-hook-write-failed' }
  } finally {
    await rm(hostCandidate, { force: true }).catch(() => {})
  }
}

export function ensureWslGrokManagedHooks(
  context: ObserverPreparationContext,
  runtimeRunDir: string,
  runCommand: GrokCommandRunner
): Promise<EnsureGrokManagedHooksResult> {
  if (context.installation.runtime.kind !== 'wsl') {
    return Promise.resolve({ ok: false, reason: 'grok-hook-path-unavailable' })
  }
  return withWslMutex(context.installation.runtime.distro, () =>
    ensureWslGrokManagedHooksUnlocked(context, runtimeRunDir, runCommand)
  )
}
