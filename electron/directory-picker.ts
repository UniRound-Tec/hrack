import type { CliRuntime, DirectoryPickerRequest } from '../shared/ipc-contract'

export interface ParsedWslUncPath {
  distro: string
  linuxPath: string
}
const WSL_UNC_PATTERN = /^\\\\(?:wsl\.localhost|wsl\$)\\([^\\]+)(?:\\(.*))?$/i

export function parseWslUncPath(value: string): ParsedWslUncPath | null {
  const match = value.match(WSL_UNC_PATTERN)
  if (!match) return null
  return {
    distro: match[1],
    linuxPath: match[2] ? `/${match[2].replace(/\\/g, '/')}` : '/'
  }
}

function wslUncRoot(distro: string): string {
  return `\\\\wsl.localhost\\${distro}\\`
}

function wslDefaultPath(distro: string, current?: string): string {
  const root = wslUncRoot(distro)
  if (!current) return root

  if (current.startsWith('/')) {
    return current === '/'
      ? root
      : `${root}${current.slice(1).replace(/\//g, '\\')}`
  }

  const unc = parseWslUncPath(current)
  if (!unc || unc.distro.toLowerCase() !== distro.toLowerCase()) return root
  return unc.linuxPath === '/'
    ? root
    : `${root}${unc.linuxPath.slice(1).replace(/\//g, '\\')}`
}

export function directoryPickerDefaultPath(
  request: DirectoryPickerRequest
): string | undefined {
  if (request.runtime.kind === 'wsl') {
    return wslDefaultPath(request.runtime.distro, request.defaultPath)
  }

  if (
    request.runtime.platform === 'windows' &&
    (request.defaultPath?.startsWith('/') ||
      (request.defaultPath && parseWslUncPath(request.defaultPath)))
  ) {
    return undefined
  }
  return request.defaultPath
}

export function normalizePickedDirectory(
  selectedPath: string,
  runtime: CliRuntime
): string {
  if (runtime.kind !== 'wsl') return selectedPath
  const unc = parseWslUncPath(selectedPath)
  return unc && unc.distro.toLowerCase() === runtime.distro.toLowerCase()
    ? unc.linuxPath
    : selectedPath
}
