import { expect, test } from '@playwright/test'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runtimeRemoteWorkspaceHost } from '../electron/remote/runtimeRemoteWorkspaceHost'
import type { CliScanReport } from '../shared/ipc-contract'

test.describe('remote workspace host', () => {
  let workspace = ''

  test.beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), 'hrack-remote-workspace-'))
  })

  test.afterEach(async () => {
    await rm(workspace, { recursive: true, force: true })
  })

  function fixture() {
    const runtime = {
      kind: 'host' as const,
      platform:
        process.platform === 'win32'
          ? ('windows' as const)
          : process.platform === 'darwin'
            ? ('macos' as const)
            : ('linux' as const)
    }
    const report: CliScanReport = {
      startedAt: 1,
      finishedAt: 2,
      runtimeErrors: [],
      launchable: [
        {
          definition: {
            id: 'codex',
            adapterId: 'codex',
            displayName: 'Codex',
            hint: 'fixture',
            iconId: 'codex'
          },
          installations: [
            {
              id: 'codex:fixture',
              definitionId: 'codex',
              runtime,
              resolvedExecutable: 'codex',
              detectedVia: 'path',
              verification: 'verified'
            }
          ]
        }
      ]
    }
    return runtimeRemoteWorkspaceHost({
      scan: async () => report,
      resolveWorkspace: async (installationId, requested) => {
        if (installationId !== 'codex:fixture') throw new Error('missing')
        return requested || workspace
      }
    })
  }

  test('lists runtime roots and lazily shows computer folders and files', async () => {
    await mkdir(join(workspace, 'project'))
    await writeFile(join(workspace, 'README.md'), 'fixture')
    const host = fixture()

    const roots = await host.list({
      installationId: 'codex:fixture',
      offset: 0
    })
    expect(roots).toMatchObject({ ok: true, path: null })
    if (!roots.ok) throw new Error(roots.reason)
    expect(roots.entries).toContainEqual({
      name: 'Home',
      path: workspace,
      kind: 'directory'
    })

    const listed = await host.list({
      installationId: 'codex:fixture',
      path: workspace,
      offset: 0
    })
    expect(listed).toMatchObject({
      ok: true,
      path: workspace,
      entries: [
        { name: 'project', kind: 'directory' },
        { name: 'README.md', kind: 'file' }
      ]
    })
  })

  test('rejects relative paths and unknown installations without touching disk', async () => {
    const host = fixture()
    await expect(
      host.list({
        installationId: 'codex:fixture',
        path: '..',
        offset: 0
      })
    ).resolves.toEqual({ ok: false, reason: 'invalid-path' })
    await expect(
      host.list({ installationId: 'missing', offset: 0 })
    ).resolves.toEqual({ ok: false, reason: 'installation-not-found' })
  })

  test('paginates a large directory with stable directory-first ordering', async () => {
    await Promise.all(
      Array.from({ length: 258 }, (_, index) =>
        mkdir(join(workspace, `folder-${String(index).padStart(3, '0')}`))
      )
    )
    const host = fixture()
    const first = await host.list({
      installationId: 'codex:fixture',
      path: workspace,
      offset: 0
    })
    expect(first).toMatchObject({ ok: true, nextOffset: 256 })
    if (!first.ok) throw new Error(first.reason)
    expect(first.entries).toHaveLength(256)

    const second = await host.list({
      installationId: 'codex:fixture',
      path: workspace,
      offset: first.nextOffset ?? 0
    })
    expect(second).toMatchObject({ ok: true })
    if (!second.ok) throw new Error(second.reason)
    expect(second.entries.map((entry) => entry.name)).toEqual([
      'folder-256',
      'folder-257'
    ])
    expect(second.nextOffset).toBeUndefined()
  })
})
