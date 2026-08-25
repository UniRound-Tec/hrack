import { execFile } from 'node:child_process'
import { homedir } from 'node:os'
import { opendir, stat } from 'node:fs/promises'
import { posix, win32 } from 'node:path'
import { promisify } from 'node:util'
import type {
  CliInstallation,
  CliRuntime,
  CliScanReport
} from '../../shared/ipc-contract'
import {
  REMOTE_PROTOCOL_LIMITS,
  type RemoteWorkspaceEntry,
  type RemoteWorkspaceListRejectReason
} from '../../shared/remote-protocol'
import type {
  RemoteWorkspaceHost,
  RemoteWorkspaceListResult
} from './RemoteDesktopClient'

const MAX_DIRECTORY_ENTRIES = REMOTE_PROTOCOL_LIMITS.workspaceOffset
const execute = promisify(execFile)

interface RemoteWorkspaceDiscovery {
  scan(force?: boolean): Promise<CliScanReport>
  resolveWorkspace(installationId: string, workspace: string): Promise<string>
}

class RemoteWorkspaceError extends Error {
  constructor(readonly reason: RemoteWorkspaceListRejectReason) {
    super(`remote-workspace:${reason}`)
    this.name = 'RemoteWorkspaceError'
  }
}

function installationIn(
  report: CliScanReport,
  installationId: string
): CliInstallation | null {
  return (
    report.launchable
      .flatMap((launchable) => launchable.installations)
      .find((installation) => installation.id === installationId) ?? null
  )
}

function normalizedError(error: unknown): RemoteWorkspaceListRejectReason {
  if (error instanceof RemoteWorkspaceError) return error.reason
  const code =
    error && typeof error === 'object' && 'code' in error
      ? String((error as { code?: unknown }).code)
      : ''
  if (code === 'ENOENT') return 'not-found'
  if (code === 'ENOTDIR') return 'not-directory'
  if (code === 'EACCES' || code === 'EPERM') return 'denied'
  return 'unavailable'
}

function runtimePath(runtime: CliRuntime): typeof posix | typeof win32 {
  return runtime.kind === 'host' && runtime.platform === 'windows' ? win32 : posix
}

function validRuntimePath(runtime: CliRuntime, value: string): boolean {
  if (
    !value ||
    value.length > REMOTE_PROTOCOL_LIMITS.workspaceChars ||
    value.includes('\0')
  ) {
    return false
  }
  if (runtime.kind === 'wsl') return posix.isAbsolute(value)
  return runtimePath(runtime).isAbsolute(value)
}

async function wslNativePath(path: string, distro: string): Promise<string> {
  if (process.platform !== 'win32') {
    throw new RemoteWorkspaceError('unavailable')
  }
  if (!distro || distro.length > 128 || /[\u0000\r\n]/.test(distro)) {
    throw new RemoteWorkspaceError('invalid-path')
  }
  const result = await execute(
    'wsl.exe',
    ['--distribution', distro, '--exec', 'wslpath', '-w', path],
    { timeout: 5_000, windowsHide: true, maxBuffer: 32 * 1024 }
  )
  const translated = result.stdout.replaceAll('\0', '').trim()
  if (!translated) throw new RemoteWorkspaceError('unavailable')
  return translated
}

async function nativePath(runtime: CliRuntime, path: string): Promise<string> {
  return runtime.kind === 'wsl' ? wslNativePath(path, runtime.distro) : path
}

function rootEntry(name: string, path: string): RemoteWorkspaceEntry {
  return { name, path, kind: 'directory' }
}

function uniqueRoots(
  runtime: CliRuntime,
  roots: readonly RemoteWorkspaceEntry[]
): RemoteWorkspaceEntry[] {
  const windows = runtime.kind === 'host' && runtime.platform === 'windows'
  const seen = new Set<string>()
  return roots.filter((entry) => {
    const key = windows ? entry.path.toLocaleLowerCase() : entry.path
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

async function windowsRoots(home: string): Promise<string[]> {
  const fallback = win32.parse(home).root
  if (process.platform !== 'win32') return fallback ? [fallback] : []
  try {
    const result = await execute(
      'powershell.exe',
      [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        'Get-PSDrive -PSProvider FileSystem | ForEach-Object { $_.Root }'
      ],
      { timeout: 3_000, windowsHide: true, maxBuffer: 32 * 1024 }
    )
    return [fallback, ...result.stdout.split(/\r?\n/)]
      .map((value) => value.trim())
      .filter((value) => value && win32.isAbsolute(value))
  } catch {
    return fallback ? [fallback] : []
  }
}

async function listRoots(
  discovery: RemoteWorkspaceDiscovery,
  installation: CliInstallation
): Promise<RemoteWorkspaceEntry[]> {
  const home = await discovery.resolveWorkspace(installation.id, '')
  if (!validRuntimePath(installation.runtime, home)) {
    throw new RemoteWorkspaceError('unavailable')
  }
  if (installation.runtime.kind === 'wsl') {
    return uniqueRoots(installation.runtime, [
      rootEntry('Home', home),
      rootEntry('文件系统', '/')
    ])
  }
  if (installation.runtime.platform === 'windows') {
    const drives = await windowsRoots(home)
    return uniqueRoots(installation.runtime, [
      rootEntry('Home', home),
      ...drives.map((drive) => rootEntry(drive, drive))
    ])
  }
  return uniqueRoots(installation.runtime, [
    rootEntry('Home', home || homedir()),
    rootEntry('文件系统', '/')
  ])
}

function entryRank(entry: RemoteWorkspaceEntry): number {
  if (entry.kind === 'directory') return 0
  if (entry.kind === 'file') return 1
  return 2
}

async function listDirectory(
  installation: CliInstallation,
  requestedPath: string,
  offset: number
): Promise<RemoteWorkspaceListResult> {
  const runtime = installation.runtime
  if (!validRuntimePath(runtime, requestedPath)) {
    return { ok: false, reason: 'invalid-path' }
  }
  const pathApi = runtimePath(runtime)
  const currentPath = pathApi.normalize(requestedPath)
  const localPath = await nativePath(runtime, currentPath)
  const metadata = await stat(localPath)
  if (!metadata.isDirectory()) return { ok: false, reason: 'not-directory' }

  const entries: RemoteWorkspaceEntry[] = []
  const handle = await opendir(localPath)
  for await (const entry of handle) {
    if (entry.name === '.' || entry.name === '..') continue
    if (
      entry.name.length > REMOTE_PROTOCOL_LIMITS.workspaceEntryNameChars ||
      entry.name.includes('\0')
    ) {
      continue
    }
    const path = pathApi.join(currentPath, entry.name)
    if (path.length > REMOTE_PROTOCOL_LIMITS.workspaceChars) continue
    entries.push({
      name: entry.name,
      path,
      kind: entry.isSymbolicLink()
        ? 'symlink'
        : entry.isDirectory()
          ? 'directory'
          : 'file'
    })
    if (entries.length > MAX_DIRECTORY_ENTRIES) {
      throw new RemoteWorkspaceError('too-many-entries')
    }
  }
  entries.sort((left, right) => {
    const rank = entryRank(left) - entryRank(right)
    return rank || left.name.localeCompare(right.name, undefined, { sensitivity: 'base' })
  })

  const end = Math.min(
    entries.length,
    offset + REMOTE_PROTOCOL_LIMITS.workspaceEntries
  )
  const root = pathApi.parse(currentPath).root
  const parentPath = currentPath === root ? undefined : pathApi.dirname(currentPath)
  return {
    ok: true,
    path: currentPath,
    ...(parentPath && parentPath !== currentPath ? { parentPath } : {}),
    entries: entries.slice(offset, end),
    ...(end < entries.length ? { nextOffset: end } : {})
  }
}

export function runtimeRemoteWorkspaceHost(
  discovery: RemoteWorkspaceDiscovery
): RemoteWorkspaceHost {
  return {
    async list(input): Promise<RemoteWorkspaceListResult> {
      try {
        const report = await discovery.scan(false)
        const installation = installationIn(report, input.installationId)
        if (!installation) {
          return { ok: false, reason: 'installation-not-found' }
        }
        if (input.path === undefined) {
          return {
            ok: true,
            path: null,
            entries: await listRoots(discovery, installation)
          }
        }
        if (
          !Number.isInteger(input.offset) ||
          input.offset < 0 ||
          input.offset > REMOTE_PROTOCOL_LIMITS.workspaceOffset
        ) {
          return { ok: false, reason: 'invalid-path' }
        }
        return await listDirectory(installation, input.path, input.offset)
      } catch (error) {
        return { ok: false, reason: normalizedError(error) }
      }
    }
  }
}
