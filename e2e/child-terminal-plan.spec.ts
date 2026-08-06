import { expect, test } from '@playwright/test'
import { planChildTerminal } from '../src/app/childTerminal'

const shells = [
  {
    id: 'pwsh',
    name: 'PowerShell 7',
    hint: 'pwsh.exe',
    shell: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe'
  },
  {
    id: 'wsl',
    name: 'WSL',
    hint: 'Ubuntu / Linux shell',
    shell: 'C:\\Windows\\System32\\wsl.exe'
  }
]

test('starts a native child terminal in the selected host directory', () => {
  expect(
    planChildTerminal({
      runtime: { kind: 'host', platform: 'windows' },
      workspace: 'C:\\repo\\packages\\app',
      shells,
      defaultShellId: 'pwsh'
    })
  ).toMatchObject({
    shellId: 'pwsh',
    cwd: 'C:\\repo\\packages\\app',
    shell: {
      shell: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
      cwd: 'C:\\repo\\packages\\app'
    }
  })
})

test('starts a WSL child terminal in the same distro without a Windows cwd', () => {
  expect(
    planChildTerminal({
      runtime: { kind: 'wsl', distro: 'Ubuntu-22.04' },
      workspace: '/home/jesse/repo/packages/app',
      shells,
      defaultShellId: 'pwsh'
    })
  ).toEqual({
    shellId: 'wsl:Ubuntu-22.04',
    cwd: '/home/jesse/repo/packages/app',
    shell: {
      shell: 'C:\\Windows\\System32\\wsl.exe',
      args: [
        '--distribution',
        'Ubuntu-22.04',
        '--cd',
        '/home/jesse/repo/packages/app'
      ]
    }
  })
})
