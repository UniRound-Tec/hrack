import {
  expect,
  test,
  type ElectronApplication,
  type Page
} from '@playwright/test'
import { resolve } from 'node:path'
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { launchApp } from './helpers'

const workspace = resolve(__dirname, 'fixtures/workspace-reader')

async function launchWorkspaceAgent(
  page: Page,
  workspacePath = workspace
): Promise<string> {
  await page.getByTestId('home-quick-codex').click()
  await expect(page.getByTestId('cli-config')).toBeVisible()
  await page.getByTestId('cli-workspace').fill(workspacePath)
  await page.getByTestId('cli-installation-windows').click()
  await page.getByTestId('cli-launch').click()
  await expect(page.getByTestId('sidebar-session-item')).toBeVisible({
    timeout: 15_000
  })
  return page.evaluate(() => {
    const debug = window as unknown as {
      __vibingDebugTabs: { list(): string[] }
    }
    const [terminalId] = debug.__vibingDebugTabs.list()
    if (!terminalId) throw new Error('workspace agent terminal was not created')
    return terminalId
  })
}

async function showWorkspaceReader(page: Page): Promise<void> {
  const codeButton = page.getByTestId('titlebar-code')
  await expect(codeButton).toBeVisible()
  await codeButton.click()
  await expect(page.getByTestId('workspace-reader')).toBeVisible()
}

test.describe('read-only workspace reader', () => {
  let app: ElectronApplication
  let page: Page
  const temporaryRoots: string[] = []

  test.beforeEach(async () => {
    ;({ app, window: page } = await launchApp({
      createDefaultTerminal: false,
      env: {
        VIBING_FIXTURE_OBSERVER: '1',
        VIBING_FIXTURE_OBSERVER_HOLD: '1'
      }
    }))
  })

  test.afterEach(async () => {
    await app?.close()
    for (const root of temporaryRoots.splice(0)) {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('reads a launched agent workspace through the root-scoped public interface', async () => {
    const terminalId = await launchWorkspaceAgent(page)

    const result = await page.evaluate(async (id) => {
      const workspaceReader = (
        window as unknown as {
          workspaceReader: {
            describe(terminalId: string): Promise<{ name: string } | null>
            list(input: {
              terminalId: string
              path: string
            }): Promise<
              Array<{ name: string; path: string; kind: 'directory' | 'file' }>
            >
            read(input: { terminalId: string; path: string }): Promise<{
              path: string
              text: string
            }>
          }
        }
      ).workspaceReader
      return {
        description: await workspaceReader.describe(id),
        root: await workspaceReader.list({ terminalId: id, path: '' }),
        file: await workspaceReader.read({
          terminalId: id,
          path: 'src/example.ts'
        })
      }
    }, terminalId)

    expect(result.description?.name).toBe('workspace-reader')
    expect(result.root).toContainEqual({
      name: 'src',
      path: 'src',
      kind: 'directory'
    })
    expect(result.file).toMatchObject({
      path: 'src/example.ts',
      text: expect.stringContaining(
        "workspaceReaderFixture = 'read-only workspace content'"
      )
    })
  })

  test('rejects absolute paths and traversal outside the mounted root', async () => {
    const terminalId = await launchWorkspaceAgent(page)

    const errors = await page.evaluate(
      async ({ id, absolutePath }) => {
        const reader = (
          window as unknown as {
            workspaceReader: {
              read(input: {
                terminalId: string
                path: string
              }): Promise<unknown>
            }
          }
        ).workspaceReader
        const messageOf = async (path: string): Promise<string> => {
          try {
            await reader.read({ terminalId: id, path })
            return 'unexpected-success'
          } catch (error) {
            return String(error)
          }
        }
        return {
          traversal: await messageOf('../package.json'),
          absolute: await messageOf(absolutePath)
        }
      },
      { id: terminalId, absolutePath: resolve(workspace, 'README.md') }
    )

    expect(errors.traversal).toContain('workspace-reader:outside-root')
    expect(errors.absolute).toContain('workspace-reader:outside-root')
  })

  test('shows the lazy file tree and a strictly read-only highlighted code view', async () => {
    await launchWorkspaceAgent(page)
    await expect(page.getByTestId('workspace-reader')).toHaveCount(0)
    await showWorkspaceReader(page)

    await expect(
      page.getByTestId('workspace-reader-outer-separator')
    ).toBeVisible()
    await expect(
      page.getByTestId('workspace-reader-inner-separator')
    ).toBeVisible()
    await expect(page.getByTestId('workspace-reader').locator('header')).toHaveCount(0)

    await page
      .getByTestId('workspace-tree-entry')
      .filter({ hasText: 'src' })
      .click()
    await page
      .getByTestId('workspace-tree-entry')
      .filter({ hasText: 'example.ts' })
      .click()

    const code = page.getByTestId('workspace-code-view')
    await expect(code).toContainText('workspaceReaderFixture')
    await expect(code.locator('.cm-content')).toHaveAttribute(
      'contenteditable',
      'false'
    )
    await expect(code.locator('.cm-lineNumbers')).toBeVisible()
    const before = await code.locator('.cm-content').textContent()
    await code.locator('.cm-content').click()
    await page.keyboard.type('MUTATION_SHOULD_NOT_APPEAR')
    await expect(code.locator('.cm-content')).toHaveText(before ?? '')

    const codeBox = await code.boundingBox()
    const treeBox = await page.getByTestId('workspace-reader-tree').boundingBox()
    if (!codeBox || !treeBox) throw new Error('reader layout was not measurable')
    expect(treeBox.x).toBeGreaterThan(codeBox.x)
  })

  test('automatically follows changes to the current file', async () => {
    const root = mkdtempSync(resolve(tmpdir(), 'vibing-reader-refresh-'))
    temporaryRoots.push(root)
    cpSync(workspace, root, { recursive: true })
    await launchWorkspaceAgent(page, root)
    await showWorkspaceReader(page)
    await page
      .getByTestId('workspace-tree-entry')
      .filter({ hasText: 'src' })
      .click()
    await page
      .getByTestId('workspace-tree-entry')
      .filter({ hasText: 'example.ts' })
      .click()
    const code = page.getByTestId('workspace-code-view')
    await expect(code).toContainText('workspaceReaderFixture')

    writeFileSync(
      resolve(root, 'src/example.ts'),
      "export const refreshed = 'latest-on-disk'\n"
    )
    await expect(code).toContainText('latest-on-disk', { timeout: 5_000 })
  })

  test('renders Markdown by default and can switch to its read-only source', async () => {
    await launchWorkspaceAgent(page)
    await showWorkspaceReader(page)
    await page
      .getByTestId('workspace-tree-entry')
      .filter({ hasText: 'README.md' })
      .click()

    const preview = page.getByTestId('workspace-markdown-preview')
    await expect(preview).toBeVisible()
    await expect(preview.locator('h1')).toHaveText('Workspace reader fixture')
    await expect(
      page.getByTestId('workspace-markdown-preview-toggle')
    ).toHaveAttribute('aria-pressed', 'true')

    await page.getByTestId('workspace-markdown-source-toggle').click()
    const source = page.getByTestId('workspace-code-view')
    await expect(source).toContainText('# Workspace reader fixture')
    await expect(source.locator('.cm-content')).toHaveAttribute(
      'contenteditable',
      'false'
    )
  })

  test('supports keyboard resizing and collapsing without unmounting the terminal', async () => {
    await launchWorkspaceAgent(page)
    await showWorkspaceReader(page)
    const outer = page.getByTestId('workspace-reader-outer-separator')
    const inner = page.getByTestId('workspace-reader-inner-separator')
    const outerBefore = Number(await outer.getAttribute('aria-valuenow'))
    const innerBefore = Number(await inner.getAttribute('aria-valuenow'))

    await outer.focus()
    await page.keyboard.press('ArrowLeft')
    await inner.focus()
    await page.keyboard.press('ArrowRight')
    expect(Number(await outer.getAttribute('aria-valuenow'))).toBeLessThan(
      outerBefore
    )
    expect(Number(await inner.getAttribute('aria-valuenow'))).toBeGreaterThan(innerBefore)

    const readerBeforeDrag = await page
      .getByTestId('workspace-reader')
      .boundingBox()
    const outerBox = await outer.boundingBox()
    if (!readerBeforeDrag || !outerBox)
      throw new Error('split layout was not measurable')
    await page.mouse.move(outerBox.x + outerBox.width / 2, outerBox.y + 80)
    await page.mouse.down()
    await page.mouse.move(outerBox.x - 48, outerBox.y + 80, { steps: 4 })
    await page.mouse.up()
    await expect
      .poll(
        async () =>
          (await page.getByTestId('workspace-reader').boundingBox())?.width ?? 0
      )
      .toBeGreaterThan(readerBeforeDrag.width + 30)

    await page.getByTestId('titlebar-code').click()
    await expect(page.getByTestId('workspace-reader')).toBeHidden()
    await page.getByTestId('titlebar-code').click()
    await expect(page.getByTestId('workspace-reader')).toBeVisible()
    await expect(page.getByTestId('terminal-page')).toBeVisible()
  })

  test('unmounts the workspace only when the terminal is explicitly closed', async () => {
    const terminalId = await launchWorkspaceAgent(page)
    const session = page.getByTestId('sidebar-session-item')
    await session.hover()
    await page.getByTestId('sidebar-session-close').click()

    await expect
      .poll(() =>
        page.evaluate((id) => window.workspaceReader.describe(id), terminalId)
      )
      .toBeNull()
  })

  test('recovers the reader and persisted widths after a renderer reload', async () => {
    const terminalId = await launchWorkspaceAgent(page)
    await showWorkspaceReader(page)
    const outer = page.getByTestId('workspace-reader-outer-separator')
    await outer.focus()
    await page.keyboard.press('ArrowLeft')
    const resized = Number(await outer.getAttribute('aria-valuenow'))

    await page.reload()
    await page.waitForFunction(() =>
      Boolean(
        (window as unknown as Record<string, unknown>)['__vibingDebugTabs']
      )
    )
    await page.evaluate((id) => {
      const debug = window as unknown as {
        __vibingDebugShell: { navigate(pageId: `terminal:${string}`): void }
      }
      debug.__vibingDebugShell.navigate(`terminal:${id}`)
    }, terminalId)

    await expect(page.getByTestId('workspace-reader')).toHaveCount(0)
    await showWorkspaceReader(page)
    await expect
      .poll(async () =>
        Number(
          await page
            .getByTestId('workspace-reader-outer-separator')
            .getAttribute('aria-valuenow')
        )
      )
      .toBeCloseTo(resized, -1)
  })

  test('uses reader focus mode without destroying the terminal in a narrow window', async () => {
    await launchWorkspaceAgent(page)
    await showWorkspaceReader(page)
    const original = await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].getSize()
    )
    await app.evaluate(
      ({ BrowserWindow }, size) =>
        BrowserWindow.getAllWindows()[0].setSize(760, size[1]),
      original
    )

    await expect(page.getByTestId('workspace-reader')).toBeVisible()
    await expect(
      page.getByTestId('workspace-reader-outer-separator')
    ).toHaveCount(0)
    await expect(
      page.getByTestId('terminal-page').locator('.xterm')
    ).toBeHidden()
    await page.getByTestId('workspace-reader-back').click()
    await expect(page.getByTestId('workspace-reader')).toBeHidden()
    await expect(
      page.getByTestId('terminal-page').locator('.xterm')
    ).toBeVisible()
  })
})

test('keeps the workspace mounted after the CLI process exits', async () => {
  const { app, window } = await launchApp({
    createDefaultTerminal: false,
    env: { VIBING_FIXTURE_OBSERVER: '1' }
  })
  try {
    const terminalId = await launchWorkspaceAgent(window)
    await expect(
      window
        .getByTestId('sidebar-session-item')
        .locator('.border-status-exited')
    ).toBeVisible({ timeout: 15_000 })
    await expect(
      window.evaluate(
        (id) =>
          window.workspaceReader.read({ terminalId: id, path: 'README.md' }),
        terminalId
      )
    ).resolves.toMatchObject({ path: 'README.md' })
  } finally {
    await app.close()
  }
})

test('does not expose a workspace reader for an ordinary terminal', async () => {
  const { app, window } = await launchApp()
  try {
    await expect(window.getByTestId('workspace-reader')).toHaveCount(0)
    await expect(window.getByTestId('titlebar-code')).toHaveCount(0)
  } finally {
    await app.close()
  }
})
