import { execFile } from 'node:child_process'
import { access } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { promisify } from 'node:util'
import type { ShellOption } from '../shared/ipc-contract'

const execFileAsync = promisify(execFile)

async function existingPath(path: string | undefined): Promise<string | null> {
  if (!path) return null
  try {
    await access(path)
    return path
  } catch {
    return null
  }
}

async function resolveCommand(command: string): Promise<string | null> {
  try {
    const resolver = process.platform === 'win32' ? 'where.exe' : 'which'
    const { stdout } = await execFileAsync(resolver, [command], {
      timeout: 1_500,
      windowsHide: true
    })
    return stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) ?? null
  } catch {
    return null
  }
}

function dedupe(options: ShellOption[]): ShellOption[] {
  const seen = new Set<string>()
  return options.filter((option) => {
    const key = option.shell.toLowerCase()
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

async function windowsShells(): Promise<ShellOption[]> {
  const windowsDirectory = process.env.WINDIR ?? 'C:\\Windows'
  const programFiles = process.env.ProgramFiles ?? 'C:\\Program Files'
  const localAppData = process.env.LOCALAPPDATA
  const [powershell, pwsh, gitBash, localGitBash, wsl] = await Promise.all([
    existingPath(
      join(
        windowsDirectory,
        'System32',
        'WindowsPowerShell',
        'v1.0',
        'powershell.exe'
      )
    ),
    resolveCommand('pwsh.exe'),
    existingPath(join(programFiles, 'Git', 'bin', 'bash.exe')),
    existingPath(
      localAppData
        ? join(localAppData, 'Programs', 'Git', 'bin', 'bash.exe')
        : undefined
    ),
    resolveCommand('wsl.exe')
  ])

  const options: ShellOption[] = [
    {
      id: 'cmd',
      name: 'Command Prompt',
      hint: 'cmd.exe',
      shell: process.env.COMSPEC ?? 'cmd.exe'
    }
  ]
  if (powershell) {
    options.push({
      id: 'powershell',
      name: 'Windows PowerShell',
      hint: 'powershell.exe',
      shell: powershell
    })
  }
  if (pwsh) {
    options.push({
      id: 'pwsh',
      name: 'PowerShell 7',
      hint: 'pwsh.exe',
      shell: pwsh
    })
  }
  const bash = gitBash ?? localGitBash
  if (bash) {
    options.push({
      id: 'git-bash',
      name: 'Git Bash',
      hint: 'Git\\bin\\bash.exe',
      shell: bash,
      args: ['--login', '-i']
    })
  }
  if (wsl) {
    options.push({
      id: 'wsl',
      name: 'WSL',
      hint: 'Ubuntu / Linux shell',
      shell: wsl
    })
  }
  return dedupe(options)
}

async function unixShells(): Promise<ShellOption[]> {
  const candidates = [
    process.env.SHELL,
    await resolveCommand('zsh'),
    await resolveCommand('bash'),
    await resolveCommand('fish')
  ]
  const options = candidates
    .filter((shell): shell is string => Boolean(shell))
    .map((shell) => {
      const name = basename(shell)
      return {
        id: name,
        name,
        hint: shell,
        shell
      }
    })
  if (options.length === 0) {
    options.push({ id: 'sh', name: 'sh', hint: '/bin/sh', shell: '/bin/sh' })
  }
  return dedupe(options)
}

export async function listAvailableShells(): Promise<ShellOption[]> {
  return process.platform === 'win32' ? windowsShells() : unixShells()
}
