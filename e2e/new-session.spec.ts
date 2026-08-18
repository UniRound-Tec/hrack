import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { cliDefinitions } from '../electron/ai-cli-discovery'
import {
  buildCliLaunchSelection,
  mergeSkipApprovalArgs,
  parseCommandLine
} from '../src/app/launchOptions'
import type { LaunchableCli } from '../shared/ipc-contract'
import {
  parseSkipApprovalPrefs,
  readSkipApprovalPref,
  saveSkipApprovalPref,
  SKIP_APPROVAL_PREFS_KEY
} from '../src/app/skipApprovalPrefs'
import {
  LAST_WORKSPACE_KEY,
  LEGACY_LAST_WORKSPACE_KEY,
  WORKSPACE_HISTORY_KEY,
  lastWorkspace,
  parseWorkspaceHistory,
  readWorkspaceHistory,
  rememberWorkspace,
  saveWorkspace
} from '../src/app/workspaceHistory'
import { launchApp } from './helpers'

class MemoryStorage {
  private readonly values = new Map<string, string>()

  getItem(key: string): string | null {
    return this.values.get(key) ?? null
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value)
  }
}

test('splits quoted CLI arguments and builds an installation-bound selection', () => {
  expect(parseCommandLine('--flag "two words" C:\\work\\demo')).toEqual([
    '--flag',
    'two words',
    'C:\\work\\demo'
  ])
  const option = {
    definition: {
      id: 'codex', adapterId: 'codex', displayName: 'Codex',
      hint: 'OpenAI coding agent', iconId: 'codex'
    },
    installations: [{
      id: 'codex:windows', definitionId: 'codex',
      runtime: { kind: 'host', platform: 'windows' },
      resolvedExecutable: 'C:\\bin\\codex.exe', detectedVia: 'path',
      verification: 'verified'
    }]
  } satisfies LaunchableCli
  expect(buildCliLaunchSelection({
    option,
    installationId: 'codex:windows',
    name: 'Codex',
    workspace: 'C:\\repo',
    args: '--flag "two words"'
  })).toEqual({
    installationId: 'codex:windows',
    args: ['--flag', 'two words'],
    workspace: 'C:\\repo'
  })
})

test('maps skip-approval launch flags for CLIs that accept them', () => {
  const flags = Object.fromEntries(
    cliDefinitions.flatMap((definition) =>
      definition.skipApproval
        ? [[definition.id, definition.skipApproval.args]]
        : []
    )
  )
  expect(flags).toEqual({
    claude: ['--dangerously-skip-permissions'],
    codex: ['--yolo'],
    antigravity: ['--dangerously-skip-permissions'],
    opencode: ['--auto'],
    cursor: ['--force'],
    cline: ['--yolo'],
    qwen: ['--yolo'],
    kimi: ['--yolo'],
    grok: ['--always-approve'],
    copilot: ['--yolo'],
    crush: ['--yolo'],
    devin: ['bypass'],
    kiro: ['--trust-all-tools'],
    aider: ['--yes-always'],
    'factory-droid': ['--skip-permissions-unsafe'],
    'mistral-vibe': ['--yolo'],
    qoder: ['--yolo'],
    'codebuddy-code': ['--dangerously-skip-permissions'],
    kilo: ['--auto']
  })
  expect(cliDefinitions.find((item) => item.id === 'pi')?.skipApproval).toBeUndefined()
  expect(cliDefinitions.find((item) => item.id === 'amp')?.skipApproval).toBeUndefined()
})

test('injects skip-approval args once, and skips when the user already passed them', () => {
  const skip = {
    args: ['--yolo'],
    alreadyPresent: ['--dangerously-bypass-approvals-and-sandbox'],
    label: 'YOLO'
  }
  expect(mergeSkipApprovalArgs(['--model', 'o3'], skip, true)).toEqual([
    '--yolo',
    '--model',
    'o3'
  ])
  expect(mergeSkipApprovalArgs(['--model', 'o3'], skip, false)).toEqual([
    '--model',
    'o3'
  ])
  expect(mergeSkipApprovalArgs(['--yolo', '--model', 'o3'], skip, true)).toEqual([
    '--yolo',
    '--model',
    'o3'
  ])
  expect(
    mergeSkipApprovalArgs(
      ['--dangerously-bypass-approvals-and-sandbox'],
      skip,
      true
    )
  ).toEqual(['--dangerously-bypass-approvals-and-sandbox'])
  expect(mergeSkipApprovalArgs(['prompt text'], {
    args: ['bypass'],
    alreadyPresent: ['yolo'],
    label: 'Bypass'
  }, true)).toEqual(['bypass', 'prompt text'])
})

test('remembers skip-approval per CLI definition', () => {
  const storage = new MemoryStorage()
  expect(parseSkipApprovalPrefs('not-json')).toEqual({})
  expect(readSkipApprovalPref('codex', storage)).toBe(false)
  expect(saveSkipApprovalPref('codex', true, storage)).toEqual({ codex: true })
  expect(readSkipApprovalPref('codex', storage)).toBe(true)
  expect(readSkipApprovalPref('claude', storage)).toBe(false)
  expect(saveSkipApprovalPref('codex', false, storage)).toEqual({ codex: false })
  expect(readSkipApprovalPref('codex', storage)).toBe(false)
  expect(JSON.parse(storage.getItem(SKIP_APPROVAL_PREFS_KEY) ?? '{}')).toEqual({
    codex: false
  })
})

test('buildCliLaunchSelection prepends skip-approval flags when checked', () => {
  const option = {
    definition: {
      id: 'codex', adapterId: 'codex', displayName: 'Codex',
      hint: 'OpenAI coding agent', iconId: 'codex',
      skipApproval: {
        args: ['--yolo'],
        alreadyPresent: ['--dangerously-bypass-approvals-and-sandbox'],
        label: 'YOLO'
      }
    },
    installations: [{
      id: 'codex:windows', definitionId: 'codex',
      runtime: { kind: 'host', platform: 'windows' },
      resolvedExecutable: 'C:\\bin\\codex.exe', detectedVia: 'path',
      verification: 'verified'
    }]
  } satisfies LaunchableCli
  expect(buildCliLaunchSelection({
    option,
    installationId: 'codex:windows',
    name: 'Codex',
    workspace: 'C:\\repo',
    args: '--model o3',
    skipApproval: true
  }).args).toEqual(['--yolo', '--model', 'o3'])
  expect(buildCliLaunchSelection({
    option,
    installationId: 'codex:windows',
    name: 'Codex',
    workspace: 'C:\\repo',
    args: '--yolo --model o3',
    skipApproval: true
  }).args).toEqual(['--yolo', '--model', 'o3'])
})

test('keeps five recent workspaces in recency order', () => {
  expect(rememberWorkspace('  C:\\alpha\\  ', [])).toEqual(['C:\\alpha'])
  expect(rememberWorkspace('C:\\beta', ['C:\\alpha'])).toEqual([
    'C:\\beta',
    'C:\\alpha'
  ])
  expect(rememberWorkspace('C:\\alpha', ['C:\\beta', 'C:\\alpha'])).toEqual([
    'C:\\alpha',
    'C:\\beta'
  ])
  expect(
    rememberWorkspace('C:\\six', [
      'C:\\one',
      'C:\\two',
      'C:\\three',
      'C:\\four',
      'C:\\five'
    ])
  ).toEqual(['C:\\six', 'C:\\one', 'C:\\two', 'C:\\three', 'C:\\four'])
  expect(parseWorkspaceHistory('not-json')).toEqual([])
  expect(
    parseWorkspaceHistory(JSON.stringify(['C:\\a', 1, 'C:\\a', '']))
  ).toEqual(['C:\\a'])
})

test('seeds workspace history from the last-used path', () => {
  const storage = new MemoryStorage()
  storage.setItem(LEGACY_LAST_WORKSPACE_KEY, 'C:\\legacy\\project')
  expect(readWorkspaceHistory(storage)).toEqual(['C:\\legacy\\project'])
  expect(storage.getItem(LAST_WORKSPACE_KEY)).toBe('C:\\legacy\\project')
  expect(JSON.parse(storage.getItem(WORKSPACE_HISTORY_KEY) ?? '[]')).toEqual([
    'C:\\legacy\\project'
  ])

  expect(saveWorkspace('C:\\next', storage)).toEqual([
    'C:\\next',
    'C:\\legacy\\project'
  ])
  expect(lastWorkspace(storage)).toBe('C:\\next')
})

test.describe('new session flow', () => {
  let app: ElectronApplication
  let page: Page

  test.beforeEach(async () => {
    ;({ app, window: page } = await launchApp())
    await page.evaluate(() => {
      window.__hrackDebugShell?.setNavMode('sidebar')
      window.__hrackDebugShell?.navigate('home')
    })
  })

  test.afterEach(async () => app?.close())

  test('opens terminal picker and starts the selected real shell', async () => {
    const terminals = page.getByTestId('sidebar-terminal-item')
    await page.keyboard.press('Control+Shift+T')
    await page.getByTestId('new-session-terminal-options').click()
    await expect(page.getByTestId('terminal-picker')).toBeVisible()
    const choices = page.locator('[data-testid^="terminal-option-"]')
    await expect(choices).not.toHaveCount(0)
    await choices.first().click()
    await expect(terminals).toHaveCount(2)
    await expect(page.locator('.xterm:visible')).toHaveCount(1)
  })

  test('opens a new DeepSeek Harness slot from the quick launcher', async () => {
    await page.getByTestId('titlebar-new').click()
    const dshLauncher = page.getByTestId('new-session-dsh')
    await expect(dshLauncher).toBeVisible()
    await expect(dshLauncher).toContainText(
      /本机优先|本機優先|local preferred|ローカル優先|로컬 우선/
    )
    await dshLauncher.click()

    await expect(page.getByTestId('new-session-overlay')).toHaveCount(0)
    await expect(page.getByTestId('dsh-page')).toHaveAttribute(
      'data-dsh-mode',
      'slot'
    )
  })

  test('opens CLI configuration from Home and binds all draft fields', async () => {
    await page.getByTestId('home-quick-codex').click()
    await expect(page.getByTestId('cli-config')).toBeVisible()
    await expect(page.getByTestId('new-session-overlay')).toHaveCount(0)
    await expect(page.getByTestId('cli-session-name')).toHaveValue('Codex')
    await page.getByTestId('cli-session-name').fill('Repo agent')
    await page.getByTestId('cli-workspace').fill('C:\\repo')
    await page.getByTestId('cli-arguments').fill('--model "two words"')
    await page.getByTestId('cli-installation-wsl-Ubuntu-Test').click()
    await expect(page.getByTestId('cli-installation-wsl-Ubuntu-Test')).toHaveClass(/bg-button-primary/)
    const exitStayedMounted = await page.evaluate(() => {
      const backdrop = document.querySelector<HTMLElement>('[data-testid="cli-config-backdrop"]')
      backdrop?.click()
      return Boolean(document.querySelector('[data-testid="cli-config"]'))
    })
    expect(exitStayedMounted).toBe(true)
    await expect(page.getByTestId('cli-config')).toHaveCount(0)
    await expect(page.getByTestId('new-session-overlay')).toHaveCount(0)
  })

  test('uses the selected WSL installation when picking a CLI workspace', async () => {
    await page.getByTestId('home-quick-codex').click()
    await page.getByTestId('cli-workspace').fill('C:\\previous-windows-repo')
    await page.getByTestId('cli-installation-wsl-Ubuntu-Test').click()

    await app.evaluate(({ dialog }) => {
      dialog.showOpenDialog = async (...args) => {
        const options = args.at(-1)
        ;(globalThis as Record<string, unknown>).__pickedDirectoryOptions = options
        return {
          canceled: false,
          filePaths: ['\\\\wsl.localhost\\Ubuntu-Test\\home\\jesse\\project'],
          bookmarks: []
        }
      }
    })

    await page.getByTestId('cli-pick-workspace').click()

    await expect(page.getByTestId('cli-workspace')).toHaveValue('/home/jesse/project')
    expect(
      await app.evaluate(() =>
        (globalThis as Record<string, unknown>).__pickedDirectoryOptions
      )
    ).toMatchObject({
      defaultPath: '\\\\wsl.localhost\\Ubuntu-Test\\',
      properties: ['openDirectory']
    })
  })

  test('restores the last workspace and lists recent folders in the themed dropdown', async () => {
    await page.evaluate(() => {
      localStorage.setItem('hrack.lastWorkspace', 'C:\\last-repo')
      localStorage.setItem(
        'hrack.workspaceHistory',
        JSON.stringify([
          'C:\\last-repo',
          'C:\\older-repo',
          '/home/jesse/wsl-repo'
        ])
      )
    })

    await page.getByTestId('home-quick-codex').click()
    await expect(page.getByTestId('cli-workspace')).toHaveValue('C:\\last-repo')

    await page.getByTestId('cli-workspace-history').hover()
    await expect(page.getByTestId('cli-workspace-history-list')).toBeVisible()
    await expect(page.getByTestId('cli-workspace-history-option-0')).toHaveText(
      'C:\\last-repo'
    )
    await expect(page.getByTestId('cli-workspace-history-option-1')).toHaveText(
      'C:\\older-repo'
    )
    await expect(page.getByTestId('cli-workspace-history-option-2')).toHaveText(
      '/home/jesse/wsl-repo'
    )

    await page.getByTestId('cli-workspace-history-option-1').click()
    await expect(page.getByTestId('cli-workspace')).toHaveValue('C:\\older-repo')
    await expect(page.getByTestId('cli-workspace-history-list')).toHaveCount(0)
  })

  test('caps remembered workspaces at five and puts the latest first', async () => {
    await page.evaluate(() => {
      localStorage.setItem(
        'hrack.workspaceHistory',
        JSON.stringify([
          'C:\\one',
          'C:\\two',
          'C:\\three',
          'C:\\four',
          'C:\\five'
        ])
      )
      localStorage.setItem('hrack.lastWorkspace', 'C:\\one')
    })

    await page.getByTestId('home-quick-codex').click()
    await expect(page.getByTestId('cli-workspace')).toHaveValue('C:\\one')

    await app.evaluate(({ dialog }) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: ['C:\\six'],
        bookmarks: []
      })
    })
    await page.getByTestId('cli-pick-workspace').click()
    await expect(page.getByTestId('cli-workspace')).toHaveValue('C:\\six')

    await page.getByTestId('cli-workspace-history').hover()
    const options = page.locator('[data-testid^="cli-workspace-history-option-"]')
    await expect(options).toHaveCount(5)
    await expect(options.nth(0)).toHaveText('C:\\six')
    await expect(options.nth(1)).toHaveText('C:\\one')
    await expect(options.nth(4)).toHaveText('C:\\four')
    await expect(page.getByTestId('cli-workspace-history-option-5')).toHaveCount(
      0
    )
  })

  test('shows the skip-approval checkbox for Codex and restores last preference', async () => {
    await page.getByTestId('home-quick-codex').click()
    const checkbox = page.getByTestId('cli-skip-approval')
    await expect(checkbox).toBeVisible()
    await expect(checkbox).not.toBeChecked()
    await expect(page.getByTestId('cli-config')).toContainText(/YOLO/)
    await checkbox.check()
    await page.evaluate(() => {
      document.querySelector<HTMLElement>('[data-testid="cli-config-backdrop"]')
        ?.click()
    })
    await expect(page.getByTestId('cli-config')).toHaveCount(0)

    await page.getByTestId('home-quick-codex').click()
    await expect(page.getByTestId('cli-skip-approval')).toBeChecked()
  })
})
