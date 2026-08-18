import { expect, test } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { WorkspaceReader } from '../electron/workspace/WorkspaceReader'
import { useWorkspaceReaderStore } from '../src/workspace-reader/workspaceReaderStore'

test('decodes supported text while rejecting binary content', async () => {
  const root = mkdtempSync(join(tmpdir(), 'hrack-workspace-reader-'))
  try {
    writeFileSync(join(root, 'utf16.txt'), Buffer.concat([
      Buffer.from([0xff, 0xfe]),
      Buffer.from('hello\r\nworkspace', 'utf16le')
    ]))
    writeFileSync(join(root, 'binary.bin'), Buffer.from([0, 1, 2, 3]))
    mkdirSync(join(root, '空 格'))
    writeFileSync(join(root, '空 格', '.hidden.ts'), 'export const unicode = true\n')
    const reader = new WorkspaceReader()
    await reader.mount('terminal', { kind: 'host', platform: 'windows' }, root)

    await expect(reader.read({ terminalId: 'terminal', path: 'utf16.txt' }))
      .resolves.toMatchObject({ text: 'hello\r\nworkspace', eol: 'crlf' })
    await expect(reader.read({ terminalId: 'terminal', path: 'binary.bin' }))
      .rejects.toThrow('workspace-reader:binary-file')
    await expect(reader.list({ terminalId: 'terminal', path: '空 格' }))
      .resolves.toContainEqual({
        name: '.hidden.ts',
        path: '空 格/.hidden.ts',
        kind: 'file'
      })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('rejects a junction whose real target escapes the mounted root', async () => {
  const parent = mkdtempSync(join(tmpdir(), 'hrack-workspace-boundary-'))
  try {
    const root = join(parent, 'root')
    const outside = join(parent, 'outside')
    mkdirSync(root)
    mkdirSync(outside)
    writeFileSync(join(outside, 'secret.txt'), 'outside')
    symlinkSync(outside, join(root, 'escape'), 'junction')
    const reader = new WorkspaceReader()
    await reader.mount('terminal', { kind: 'host', platform: 'windows' }, root)

    await expect(
      reader.read({ terminalId: 'terminal', path: 'escape/secret.txt' })
    ).rejects.toThrow('workspace-reader:outside-root')
  } finally {
    rmSync(parent, { recursive: true, force: true })
  }
})

test('reads through a real WSL runtime using one-time wslpath translation', async () => {
  test.skip(process.platform !== 'win32', 'WSL is only available on Windows')
  let distro = ''
  try {
    const output = execFileSync('wsl.exe', ['--list', '--quiet'], {
      encoding: 'utf8',
      timeout: 5_000
    }).replaceAll('\0', '')
    distro = output
      .split(/\r?\n/)
      .map((value) => value.trim())
      .find((value) => value && value !== 'docker-desktop') ?? ''
  } catch {
    test.skip(true, 'No WSL distro is available')
  }
  test.skip(!distro, 'No WSL distro is available')

  const nativeWorkspace = resolve(__dirname, 'fixtures/workspace-reader')
  const wslWorkspace = execFileSync(
    'wsl.exe',
    ['--distribution', distro, '--exec', 'wslpath', '-u', nativeWorkspace],
    { encoding: 'utf8', timeout: 5_000 }
  ).replaceAll('\0', '').trim()
  const reader = new WorkspaceReader()
  await reader.mount('wsl-terminal', { kind: 'wsl', distro }, wslWorkspace)

  await expect(
    reader.read({ terminalId: 'wsl-terminal', path: 'src/example.ts' })
  ).resolves.toMatchObject({
    text: expect.stringContaining('workspaceReaderFixture')
  })

  const wslHome = execFileSync(
    'wsl.exe',
    ['--distribution', distro, '--exec', 'printenv', 'HOME'],
    { encoding: 'utf8', timeout: 5_000 }
  ).replaceAll('\0', '').trim()
  await reader.mount('wsl-home', { kind: 'wsl', distro }, wslHome)
  await expect(
    reader.list({ terminalId: 'wsl-home', path: '' })
  ).resolves.toEqual(expect.any(Array))
})

test('directory listings keep cache identity when the watch refresh matches', () => {
  const terminalId = `tree-refresh-${Date.now()}`
  const entries = [
    { name: 'src', path: 'src', kind: 'directory' as const },
    { name: 'README.md', path: 'README.md', kind: 'file' as const }
  ]
  useWorkspaceReaderStore.getState().ensure(terminalId)
  useWorkspaceReaderStore.getState().setDirectory(terminalId, '', entries)
  const first = useWorkspaceReaderStore.getState().sessions[terminalId].directories
  useWorkspaceReaderStore.getState().setDirectory(terminalId, '', [
    { name: 'src', path: 'src', kind: 'directory' },
    { name: 'README.md', path: 'README.md', kind: 'file' }
  ])
  expect(useWorkspaceReaderStore.getState().sessions[terminalId].directories).toBe(
    first
  )
  useWorkspaceReaderStore.getState().setDirectory(terminalId, '', [
    { name: 'src', path: 'src', kind: 'directory' }
  ])
  expect(
    useWorkspaceReaderStore.getState().sessions[terminalId].directories
  ).not.toBe(first)
})
