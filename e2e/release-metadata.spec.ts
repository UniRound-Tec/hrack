import { expect, test } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { parseUpdateInfo } from 'electron-updater/out/providers/Provider'

test('embeds raw changelog Markdown in updater metadata', () => {
  const directory = mkdtempSync(join(tmpdir(), 'hrack-release-notes-test-'))
  const metadataPath = join(directory, 'latest.yml')
  const changelogPath = join(directory, 'CHANGELOG.md')
  const artifactPath = join(directory, 'HRack-Setup-0.4.1.exe')

  try {
    writeFileSync(
      metadataPath,
      [
        'version: 0.4.1',
        'files:',
        '  - url: HRack-Setup-0.4.1.exe',
        '    sha512: test-sha512',
        'path: HRack-Setup-0.4.1.exe',
        'sha512: test-sha512',
        "releaseDate: '2026-08-25T00:00:00.000Z'",
        ''
      ].join('\n')
    )
    writeFileSync(
      changelogPath,
      [
        '# Changelog',
        '',
        '## [Unreleased]',
        '',
        '### 修复',
        '',
        '- Future release only.',
        '',
        '## [0.4.1] - 2026-08-25',
        '',
        '### 修复',
        '',
        '- **修复** 更新说明 Markdown。',
        '',
        '## [0.4.0] - 2026-08-24',
        '',
        '- Previous release.',
        ''
      ].join('\n')
    )
    writeFileSync(artifactPath, '')

    execFileSync(
      process.execPath,
      [resolve('scripts/inject-release-notes.cjs'), metadataPath, changelogPath, '0.4.1'],
      { stdio: 'pipe' }
    )
    execFileSync(
      process.execPath,
      [
        resolve('scripts/assert-update-metadata.cjs'),
        metadataPath,
        directory,
        '0.4.1',
        'HRack-Setup-0.4.1.exe'
      ],
      { stdio: 'pipe' }
    )

    const updateInfo = parseUpdateInfo(
      readFileSync(metadataPath, 'utf8'),
      'latest.yml',
      new URL('https://github.com/UniRound-Tec/hrack/releases/download/v0.4.1/latest.yml')
    )

    expect(updateInfo.releaseNotes).toBe(
      [
        '## [0.4.1] - 2026-08-25',
        '',
        '### 修复',
        '',
        '- **修复** 更新说明 Markdown。'
      ].join('\n')
    )
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
