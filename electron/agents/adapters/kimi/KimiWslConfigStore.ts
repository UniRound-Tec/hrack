import { randomBytes } from 'node:crypto'
import { chmod, open, rm } from 'node:fs/promises'
import { join, posix } from 'node:path'
import type { ObserverPreparationContext } from '../types'
import { wslRuntimeCommand } from '../wslRuntimeCommand'
import { mergeKimiManagedHooks } from './KimiHookConfig'
import type { EnsureKimiManagedHooksResult } from './KimiConfigStore'

interface CommandResult {
  code: number | null
  stdout: string
}

type CommandRunner = (
  file: string,
  args: readonly string[]
) => Promise<CommandResult>

const inProcessWslConfigTails = new Map<string, Promise<void>>()

async function withWslConfigMutex<T>(
  distro: string,
  action: () => Promise<T>
): Promise<T> {
  const key = distro.toLowerCase()
  const previous = (
    inProcessWslConfigTails.get(key) ?? Promise.resolve()
  ).catch(() => {})
  let release!: () => void
  const gate = new Promise<void>((resolveGate) => (release = resolveGate))
  const tail = previous.then(() => gate)
  inProcessWslConfigTails.set(key, tail)
  await previous
  try {
    return await action()
  } finally {
    release()
    if (inProcessWslConfigTails.get(key) === tail) {
      inProcessWslConfigTails.delete(key)
    }
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

async function ensureWslKimiManagedHooksUnlocked(
  context: ObserverPreparationContext,
  runtimeRunDir: string,
  runCommand: CommandRunner
): Promise<EnsureKimiManagedHooksResult> {
  if (context.installation.runtime.kind !== 'wsl') {
    return { ok: false, reason: 'kimi-config-read-failed' }
  }
  const distro = context.installation.runtime.distro
  const shellResult = await runCommand(
    'wsl.exe',
    wslShellArgs(
      distro,
      'printf "%s\\n" "${SHELL:-/bin/sh}"',
      'hrack-kimi-config-shell'
    )
  )
  const shell = shellResult.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .reverse()
    .find((line) => line.startsWith('/') && line.length <= 4_096)
  if (shellResult.code !== 0 || !shell) {
    return { ok: false, reason: 'kimi-config-read-failed' }
  }
  const loginEnvironment = await runCommand(
    'wsl.exe',
    [
      '--distribution',
      distro,
      '--exec',
      shell,
      '-lic',
      'env -0',
      'hrack-kimi-config-home'
    ]
  )
  const configuredHome = loginEnvironmentValue(
    loginEnvironment.stdout,
    'KIMI_CODE_HOME'
  )
  const userHome = loginEnvironmentValue(loginEnvironment.stdout, 'HOME')
  const kimiHome = configuredHome || (userHome ? posix.join(userHome, '.kimi-code') : '')
  if (
    loginEnvironment.code !== 0 ||
    !kimiHome.startsWith('/') ||
    kimiHome.length > 4_080 ||
    /[\r\n]/.test(kimiHome)
  ) {
    return { ok: false, reason: 'kimi-config-read-failed' }
  }
  const configPath = posix.join(kimiHome, 'config.toml')

  // Stable across the rebrand so an older process cannot edit concurrently.
  const lockPath = `${configPath}.vibing.lock`
  const lockToken = randomBytes(16).toString('hex')
  const lock = await runCommand(
    'wsl.exe',
    wslShellArgs(
      distro,
      [
        'set -eu',
        'p="$1"; token="$2"; tries="$3"; stale="$4"',
        'mkdir -p "$(dirname "$p")"',
        'i=0',
        'while ! mkdir "$p" 2>/dev/null; do',
        '  now="$(date +%s)"; created=""',
        '  if [ -f "$p/owner" ]; then read -r _owner created < "$p/owner" || created=""; fi',
        '  case "$created" in ""|*[!0-9]*) created="$(stat -c %Y "$p" 2>/dev/null || printf "%s" "$now")" ;; esac',
        '  if [ "$((now - created))" -ge "$stale" ]; then',
        '    old="$p.stale.$token"',
        '    if mv -- "$p" "$old" 2>/dev/null; then rm -f -- "$old/owner"; rmdir -- "$old" 2>/dev/null || true; continue; fi',
        '  fi',
        '  i="$((i + 1))"; [ "$i" -lt "$tries" ] || exit 73',
        '  sleep 0.05',
        'done',
        'trap \'rm -f -- "$p/owner"; rmdir -- "$p" 2>/dev/null || true\' EXIT HUP INT TERM',
        'chmod 700 "$p"',
        'printf "%s %s\\n" "$token" "$(date +%s)" > "$p/owner"',
        'chmod 600 "$p/owner"',
        'trap - EXIT HUP INT TERM'
      ].join('\n'),
      'hrack-kimi-config-lock',
      [lockPath, lockToken, '40', '30']
    )
  )
  if (lock.code !== 0) {
    return {
      ok: false,
      reason:
        lock.code === 73
          ? 'kimi-config-lock-timeout'
          : 'kimi-config-write-failed'
    }
  }

  try {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const candidateName = `kimi-config-candidate-${attempt}.toml`
      const expectedName = `kimi-config-expected-${attempt}.toml`
      const hostCandidate = join(context.runDir, candidateName)
      const hostExpected = join(context.runDir, expectedName)
      try {
        const read = await runCommand(
          'wsl.exe',
          wslShellArgs(
            distro,
            'p="$1"; if [ -f "$p" ]; then cat -- "$p"; elif [ ! -e "$p" ]; then exit 3; else exit 4; fi',
            'hrack-kimi-config-read',
            [configPath]
          )
        )
        const existed = read.code === 0
        if (!existed && read.code !== 3) {
          return { ok: false, reason: 'kimi-config-read-failed' }
        }
        const source = existed ? read.stdout : ''
        const merged = mergeKimiManagedHooks(source, 'posix')
        if (!merged.ok) return merged
        if (!merged.changed) return { ok: true, changed: false }

        await writePrivateFile(hostCandidate, merged.content)
        await writePrivateFile(hostExpected, source)

        const runtimeCandidate = posix.join(runtimeRunDir, candidateName)
        const runtimeExpected = posix.join(runtimeRunDir, expectedName)
        const doctor = wslRuntimeCommand(
          context,
          ['doctor', 'config', runtimeCandidate],
          'hrack-kimi-config-doctor'
        )
        const validated = await runCommand(doctor.file, doctor.args)
        if (validated.code !== 0) {
          return { ok: false, reason: 'kimi-config-validation-failed' }
        }

        const install = await runCommand(
          'wsl.exe',
          wslShellArgs(
            distro,
            [
              'set -eu',
              'config="$1"',
              'candidate="$2"',
              'expected="$3"',
              'existed="$4"',
              'nonce="$5"',
              'dir="$(dirname "$config")"',
              'mkdir -p "$dir"',
              'if [ "$existed" = 1 ]; then cmp -s "$config" "$expected" || exit 42; else [ ! -e "$config" ] || exit 42; fi',
              'tmp="$dir/.config.toml.hrack.$nonce.tmp"',
              'trap \'rm -f "$tmp"\' EXIT HUP INT TERM',
              'cp -- "$candidate" "$tmp"',
              'chmod 600 "$tmp"',
              'mv -f -- "$tmp" "$config"',
              'trap - EXIT HUP INT TERM'
            ].join('; '),
            'hrack-kimi-config-install',
            [
              configPath,
              runtimeCandidate,
              runtimeExpected,
              existed ? '1' : '0',
              `${context.sessionId.replaceAll(/[^a-zA-Z0-9_-]/g, '_')}-${attempt}`
            ]
          )
        )
        if (install.code === 42) {
          if (attempt < 2) continue
          return { ok: false, reason: 'kimi-config-concurrent-change' }
        }
        return install.code === 0
          ? { ok: true, changed: true }
          : { ok: false, reason: 'kimi-config-write-failed' }
      } finally {
        await Promise.allSettled([
          rm(hostCandidate, { force: true }),
          rm(hostExpected, { force: true })
        ])
      }
    }
    return { ok: false, reason: 'kimi-config-concurrent-change' }
  } catch {
    return { ok: false, reason: 'kimi-config-write-failed' }
  } finally {
    await runCommand(
      'wsl.exe',
      wslShellArgs(
        distro,
        'p="$1"; token="$2"; if [ -f "$p/owner" ]; then read -r owner _created < "$p/owner" || exit 0; [ "$owner" = "$token" ] || exit 0; rm -f -- "$p/owner"; rmdir -- "$p" 2>/dev/null || true; fi',
        'hrack-kimi-config-unlock',
        [lockPath, lockToken]
      )
    ).catch(() => {})
  }
}

export function ensureWslKimiManagedHooks(
  context: ObserverPreparationContext,
  runtimeRunDir: string,
  runCommand: CommandRunner
): Promise<EnsureKimiManagedHooksResult> {
  if (context.installation.runtime.kind !== 'wsl') {
    return Promise.resolve({ ok: false, reason: 'kimi-config-read-failed' })
  }
  return withWslConfigMutex(context.installation.runtime.distro, () =>
    ensureWslKimiManagedHooksUnlocked(context, runtimeRunDir, runCommand)
  )
}
