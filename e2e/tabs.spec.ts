import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import type {
  PtyFlowControlSnapshot,
  PtyHistorySnapshot
} from '../shared/ipc-contract'
import {
  closeTerminalAt,
  dumpBuffer,
  launchApp,
  openDefaultTerminal,
  typeInTerminal
} from './helpers'

let app: ElectronApplication
let page: Page

test.setTimeout(120_000)

async function tabIds(): Promise<string[]> {
  return page.evaluate(
    () =>
      (
        window as unknown as {
          __vibingDebugTabs: { list(): string[] }
        }
      ).__vibingDebugTabs.list()
  )
}

async function tabBuffer(tabId: string): Promise<string[]> {
  return page.evaluate(
    (id) =>
      (
        window as unknown as {
          __vibingDebugTabs: {
            forTab(tabId: string): { dumpBuffer(): string[] }
          }
        }
      ).__vibingDebugTabs.forTab(id).dumpBuffer(),
    tabId
  )
}

async function tabLogicalBuffer(tabId: string): Promise<string[]> {
  return page.evaluate(
    (id) =>
      (
        window as unknown as {
          __vibingDebugTabs: {
            forTab(tabId: string): { dumpLogicalBuffer(): string[] }
          }
        }
      ).__vibingDebugTabs.forTab(id).dumpLogicalBuffer(),
    tabId
  )
}

async function tabSnapshot(tabId: string): Promise<{
  cols: number
  rows: number
  bufferType: 'normal' | 'alternate'
  baseY: number
  viewportY: number
} | null> {
  return page.evaluate(
    (id) =>
      (
        window as unknown as {
          __vibingDebugTabs: {
            forTab(tabId: string): {
              snapshot(): {
                cols: number
                rows: number
                bufferType: 'normal' | 'alternate'
                baseY: number
                viewportY: number
              } | null
            }
          }
        }
      ).__vibingDebugTabs.forTab(id).snapshot(),
    tabId
  )
}

async function tabHistory(
  tabId: string
): Promise<PtyHistorySnapshot | null> {
  return page.evaluate(
    (id) =>
      (
        window as unknown as {
          __vibingDebugTabs: {
            forTab(tabId: string): {
              dumpAuthoritativeHistory(): Promise<PtyHistorySnapshot | null>
            }
          }
        }
      ).__vibingDebugTabs.forTab(id).dumpAuthoritativeHistory(),
    tabId
  )
}

async function tabFlowControl(
  tabId: string
): Promise<PtyFlowControlSnapshot | null> {
  return page.evaluate(
    (id) =>
      (
        window as unknown as {
          __vibingDebugTabs: {
            forTab(tabId: string): {
              flowControl(): Promise<PtyFlowControlSnapshot | null>
            }
          }
        }
      ).__vibingDebugTabs.forTab(id).flowControl(),
    tabId
  )
}

async function setTabAckDelay(
  tabId: string,
  milliseconds: number
): Promise<void> {
  await page.evaluate(
    ({ id, delay }) =>
      (
        window as unknown as {
          __vibingDebugTabs: {
            forTab(tabId: string): {
              setPtyAckDelay(milliseconds: number): void
            }
          }
        }
      ).__vibingDebugTabs.forTab(id).setPtyAckDelay(delay),
    { id: tabId, delay: milliseconds }
  )
}

async function tabRendererKind(tabId: string): Promise<'webgl' | 'dom'> {
  return page.evaluate(
    (id) =>
      (
        window as unknown as {
          __vibingDebugTabs: {
            forTab(tabId: string): {
              rendererKind(): 'webgl' | 'dom'
            }
          }
        }
      ).__vibingDebugTabs.forTab(id).rendererKind(),
    tabId
  )
}

test.beforeEach(async () => {
  ;({ app, window: page } = await launchApp())
})

test.afterEach(async () => {
  await app?.close()
})

test('starts with one terminal tab and lets the user create and activate another', async () => {
  const tabs = page.getByTestId('sidebar-terminal-item')

  await expect(tabs).toHaveCount(1)
  await expect(tabs.first()).toHaveAttribute('aria-current', 'page')

  await openDefaultTerminal(page)

  await expect(tabs).toHaveCount(2)
  await expect(tabs.nth(0)).not.toHaveAttribute('aria-current', 'page')
  await expect(tabs.nth(1)).toHaveAttribute('aria-current', 'page')
  await expect(page.locator('.xterm')).toHaveCount(2)
})

test('keeps terminal output and authoritative history isolated per tab', async () => {
  const firstToken = `TAB_A_${Date.now()}`
  const secondToken = `TAB_B_${Date.now()}`

  await expect
    .poll(async () => (await dumpBuffer(page)).join('\n'))
    .toContain('PS ')
  await typeInTerminal(page, 'Set-PSReadLineOption -PredictionSource None')
  await page.keyboard.press('Enter')
  await typeInTerminal(page, `Write-Output "${firstToken}"`)
  await page.keyboard.press('Enter')
  await expect
    .poll(async () => (await dumpBuffer(page)).join('\n'))
    .toContain(firstToken)

  await openDefaultTerminal(page)
  await expect(page.getByTestId('sidebar-terminal-item')).toHaveCount(2)
  await expect
    .poll(async () => {
      return page.evaluate(
        () =>
          (
            window as unknown as {
              __vibingDebugTabs?: { list(): string[] }
            }
          ).__vibingDebugTabs?.list().length ?? 0
      )
    })
    .toBe(2)

  await expect
    .poll(async () => (await dumpBuffer(page)).join('\n'))
    .toContain('PS ')
  await typeInTerminal(page, 'Set-PSReadLineOption -PredictionSource None')
  await page.keyboard.press('Enter')
  await typeInTerminal(page, `Write-Output "${secondToken}"`)
  await page.keyboard.press('Enter')
  await expect
    .poll(async () => (await dumpBuffer(page)).join('\n'))
    .toContain(secondToken)

  const evidence = await page.evaluate(async () => {
    const tabs = (
      window as unknown as {
        __vibingDebugTabs: {
          list(): string[]
          forTab(id: string): {
            dumpBuffer(): string[]
            dumpAuthoritativeHistory(): Promise<{
              events: Array<{ kind: string; data?: string }>
            } | null>
          }
        }
      }
    ).__vibingDebugTabs
    const [firstId, secondId] = tabs.list()
    const collect = async (id: string) => {
      const api = tabs.forTab(id)
      const history = await api.dumpAuthoritativeHistory()
      return {
        renderer: api.dumpBuffer().join('\n'),
        history:
          history?.events
            .filter((event) => event.kind === 'output')
            .map((event) => event.data ?? '')
            .join('') ?? ''
      }
    }
    return {
      first: await collect(firstId),
      second: await collect(secondId)
    }
  })

  expect(evidence.first.renderer).toContain(firstToken)
  expect(evidence.first.renderer).not.toContain(secondToken)
  expect(evidence.first.history).toContain(firstToken)
  expect(evidence.first.history).not.toContain(secondToken)
  expect(evidence.second.renderer).toContain(secondToken)
  expect(evidence.second.renderer).not.toContain(firstToken)
  expect(evidence.second.history).toContain(secondToken)
  expect(evidence.second.history).not.toContain(firstToken)
})

test('closing a tab releases its terminal session and activates its neighbor', async () => {
  await openDefaultTerminal(page)
  await expect(page.getByTestId('sidebar-terminal-item')).toHaveCount(2)

  await page.evaluate(() => {
    const debugWindow = window as unknown as Record<string, unknown> & {
      __vibingDebugTabs: {
        list(): string[]
        forTab(id: string): {
          dumpAuthoritativeHistory(): Promise<unknown>
        }
      }
    }
    const closingId = debugWindow.__vibingDebugTabs.list()[1]
    debugWindow['__closingTabDebug'] =
      debugWindow.__vibingDebugTabs.forTab(closingId)
  })

  await closeTerminalAt(page, 1)

  await expect(page.getByTestId('sidebar-terminal-item')).toHaveCount(1)
  await expect(page.getByTestId('sidebar-terminal-item')).toHaveAttribute(
    'aria-current',
    'page'
  )
  await expect(page.locator('.xterm')).toHaveCount(1)
  await expect
    .poll(() =>
      page.evaluate(() =>
        (
          window as unknown as {
            __closingTabDebug: {
              dumpAuthoritativeHistory(): Promise<unknown>
            }
          }
        ).__closingTabDebug.dumpAuthoritativeHistory()
      )
    )
    .toBeNull()
})

test('closing the final terminal returns Home and keeps the window open', async () => {
  await closeTerminalAt(page, 0)
  await expect(page.getByTestId('home-page')).toBeVisible()
  await expect(page.getByTestId('sidebar-terminal-item')).toHaveCount(0)
  await expect(page.locator('.xterm')).toHaveCount(0)
  expect(page.isClosed()).toBe(false)
})

test('updates the tab title from the terminal OSC title sequence', async () => {
  const title = `M3_TITLE_${Date.now()}`

  await expect
    .poll(async () => (await dumpBuffer(page)).join('\n'))
    .toContain('PS ')
  await typeInTerminal(
    page,
    `[Console]::Write("$([char]27)]0;${title}$([char]7)")`
  )
  await page.keyboard.press('Enter')

  await expect(page.getByTestId('sidebar-terminal-item')).toContainText(title)

  await typeInTerminal(
    page,
    '[Console]::Write("$([char]27)]0;$([char]7)")'
  )
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('sidebar-terminal-item')).toContainText('Terminal 1')
})

test('keeps an exited session visible until the user closes its tab', async () => {
  await expect
    .poll(async () => (await dumpBuffer(page)).join('\n'))
    .toContain('PS ')

  await typeInTerminal(page, 'exit')
  await page.keyboard.press('Enter')

  await expect(page.getByTestId('sidebar-terminal-item')).toHaveAttribute(
    'data-exited',
    'true'
  )
  await expect(page.getByTestId('sidebar-terminal-item')).toHaveCount(1)
  await expect
    .poll(async () => (await dumpBuffer(page)).join('\n'))
    .toContain('[process exited with code 0]')
  await expect
    .poll(async () =>
      page.evaluate(() =>
        (
          window as unknown as {
            __vibingDebug: {
              dumpAuthoritativeHistory(): Promise<unknown>
            }
          }
        ).__vibingDebug.dumpAuthoritativeHistory()
      )
    )
    .not.toBeNull()
})

test('handles tab shortcuts while terminal input is focused', async () => {
  await expect
    .poll(async () => (await dumpBuffer(page)).join('\n'))
    .toContain('PS ')
  await page.locator('.xterm:visible').click()

  await openDefaultTerminal(page)
  const tabs = page.getByTestId('sidebar-terminal-item')
  await expect(tabs).toHaveCount(2)
  await expect(tabs.nth(1)).toHaveAttribute('aria-current', 'page')

  await page.keyboard.press('Control+Shift+Tab')
  await expect(tabs.nth(0)).toHaveAttribute('aria-current', 'page')
  await page.keyboard.press('Control+Tab')
  await expect(tabs.nth(1)).toHaveAttribute('aria-current', 'page')

  await page.keyboard.press('Control+Shift+W')
  await expect(tabs).toHaveCount(1)
  await expect(tabs.first()).toHaveAttribute('aria-current', 'page')

  const token = `SHORTCUT_INPUT_OK_${Date.now()}`
  await typeInTerminal(page, `Write-Output "${token}"`)
  await page.keyboard.press('Enter')
  await expect
    .poll(async () => (await dumpBuffer(page)).join('\n'))
    .toContain(token)
})

test('preserves normal scrollback and viewport when switching tabs', async () => {
  const [firstId] = await tabIds()
  const lastToken = 'TAB_SCROLLBACK_72'

  await expect
    .poll(async () => (await tabLogicalBuffer(firstId)).join('\n'))
    .toContain('PS ')
  await typeInTerminal(
    page,
    '1..72 | % { "TAB_SCROLLBACK_$($_)_" + ("s" * 72) }'
  )
  await page.keyboard.press('Enter')
  await expect
    .poll(async () => (await tabLogicalBuffer(firstId)).join('\n'))
    .toContain(lastToken)
  await page.evaluate((id) => {
    ;(
      window as unknown as {
        __vibingDebugTabs: {
          forTab(tabId: string): { scrollToTop(): void }
        }
      }
    ).__vibingDebugTabs.forTab(id).scrollToTop()
  }, firstId)

  const before = await tabSnapshot(firstId)
  expect(before?.baseY).toBeGreaterThan(0)
  expect(before?.viewportY).toBe(0)

  await openDefaultTerminal(page)
  await expect(page.getByTestId('sidebar-terminal-item')).toHaveCount(2)
  await page.getByTestId('sidebar-terminal-item').first().click()

  const after = await tabSnapshot(firstId)
  expect(after?.baseY).toBe(before?.baseY)
  expect(after?.viewportY).toBe(before?.viewportY)
  const text = (await tabLogicalBuffer(firstId)).join('\n')
  expect(text).toContain('TAB_SCROLLBACK_1_')
  expect(text).toContain(lastToken)
})

test('keeps an alternate buffer alive while another tab is active', async () => {
  const [firstId] = await tabIds()
  const enterAlternate =
    '$e=[char]27; [Console]::Write("${e}[?1049h${e}[HTAB_ALT_READY"); ' +
    '[Console]::ReadKey($true) | Out-Null; [Console]::Write("${e}[?1049l")'

  await typeInTerminal(page, enterAlternate)
  await page.keyboard.press('Enter')
  await expect
    .poll(async () => (await tabSnapshot(firstId))?.bufferType)
    .toBe('alternate')
  await expect
    .poll(async () => (await tabBuffer(firstId)).join('\n'))
    .toContain('TAB_ALT_READY')

  await openDefaultTerminal(page)
  await expect.poll(() => tabRendererKind(firstId)).toBe('dom')
  await page.getByTestId('sidebar-terminal-item').first().click()

  await expect.poll(() => tabRendererKind(firstId)).toBe('webgl')
  expect((await tabSnapshot(firstId))?.bufferType).toBe('alternate')
  expect((await tabBuffer(firstId)).join('\n')).toContain('TAB_ALT_READY')
  await typeInTerminal(page, 'x')
  await expect
    .poll(async () => (await tabSnapshot(firstId))?.bufferType)
    .toBe('normal')
})

test('backpressures sustained output in a background tab without blocking the active tab', async () => {
  await openDefaultTerminal(page)
  const [backgroundId, foregroundId] = await tabIds()
  await page.getByTestId('sidebar-terminal-item').first().click()
  await setTabAckDelay(backgroundId, 75)

  const lineCount = 1024
  const payloadBytes = 2048
  const doneToken = 'TAB_BACKGROUND_DONE'
  await typeInTerminal(
    page,
    `$payload="b"*${payloadBytes}; 1..${lineCount} | % { ` +
      '[Console]::WriteLine("TAB_BACKGROUND_$($_)_$payload") }; ' +
      `[Console]::WriteLine("${doneToken}")`
  )
  await page.keyboard.press('Enter')
  await page.getByTestId('sidebar-terminal-item').nth(1).click()
  await expect.poll(() => tabRendererKind(backgroundId)).toBe('dom')
  await expect.poll(() => tabRendererKind(foregroundId)).toBe('webgl')

  await expect
    .poll(async () => (await tabFlowControl(backgroundId))?.pauseCount ?? 0, {
      timeout: 15_000
    })
    .toBeGreaterThan(0)

  const frameStartedAt = Date.now()
  await page.evaluate(
    () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
  )
  expect(Date.now() - frameStartedAt).toBeLessThan(1_000)

  const foregroundToken = `TAB_FOREGROUND_OK_${Date.now()}`
  await expect
    .poll(async () => (await tabBuffer(foregroundId)).join('\n'))
    .toContain('PS ')
  await typeInTerminal(page, `Write-Output "${foregroundToken}"`)
  await page.keyboard.press('Enter')
  await expect
    .poll(async () => (await tabBuffer(foregroundId)).join('\n'))
    .toContain(foregroundToken)

  await setTabAckDelay(backgroundId, 0)
  await expect
    .poll(async () => (await tabBuffer(backgroundId)).join('\n'), {
      timeout: 30_000
    })
    .toContain(doneToken)
  await expect
    .poll(async () => (await tabFlowControl(backgroundId))?.bufferedBytes ?? -1)
    .toBe(0)

  const flow = await tabFlowControl(backgroundId)
  expect(flow?.pauseCount).toBeGreaterThan(0)
  expect(flow?.resumeCount).toBeGreaterThan(0)
  expect(flow?.maxObservedBufferedBytes).toBeLessThanOrEqual(1024 * 1024)
  expect(flow?.overflowed).toBe(false)
  expect(flow?.rejectedBytes).toBe(0)

  const history = await tabHistory(backgroundId)
  const raw =
    history?.events
      .filter((event) => event.kind === 'output')
      .map((event) => event.data)
      .join('') ?? ''
  expect(raw).toContain('TAB_BACKGROUND_1_')
  expect(raw).toContain(`TAB_BACKGROUND_${lineCount}_`)
  expect(raw).toContain(doneToken)
})

test('defers resize for a hidden tab until it becomes active again', async () => {
  await openDefaultTerminal(page)
  const [hiddenId, visibleId] = await tabIds()
  await page.waitForTimeout(700)

  const resizeEvents = async (tabId: string) =>
    (await tabHistory(tabId))?.events.filter(
      (event) => event.kind === 'resize'
    ) ?? []
  const before = await resizeEvents(hiddenId)

  await app.evaluate(({ BrowserWindow }) => {
    const terminalWindow = BrowserWindow.getAllWindows()[0]
    const [width, height] = terminalWindow.getSize()
    terminalWindow.setSize(width - 180, height - 90)
  })
  await page.waitForTimeout(400)

  const whileHidden = await resizeEvents(hiddenId)
  expect(whileHidden).toHaveLength(before.length)
  expect(
    whileHidden.every((event) => event.cols > 0 && event.rows > 0)
  ).toBe(true)
  const visibleSize = await tabSnapshot(visibleId)

  await page.getByTestId('sidebar-terminal-item').first().click()
  await expect
    .poll(async () => (await resizeEvents(hiddenId)).length)
    .toBe(before.length + 1)
  await page.waitForTimeout(250)

  const after = await resizeEvents(hiddenId)
  expect(after).toHaveLength(before.length + 1)
  expect(after.every((event) => event.cols > 0 && event.rows > 0)).toBe(true)
  const reactivatedSize = await tabSnapshot(hiddenId)
  expect(reactivatedSize?.cols).toBe(visibleSize?.cols)
  expect(reactivatedSize?.rows).toBe(visibleSize?.rows)
})

test('opens five independently bounded terminal sessions without phantom instances', async () => {
  for (let index = 1; index < 5; index++) {
    await openDefaultTerminal(page)
  }

  await expect(page.getByTestId('sidebar-terminal-item')).toHaveCount(5)
  await expect(page.locator('.xterm')).toHaveCount(5)
  await expect.poll(async () => (await tabIds()).length).toBe(5)

  const ids = await tabIds()
  await expect
    .poll(async () => {
      const kinds = await Promise.all(ids.map(tabRendererKind))
      return kinds.filter((kind) => kind === 'webgl').length
    })
    .toBe(1)
  await expect
    .poll(async () => {
      const snapshots = await Promise.all(ids.map(tabFlowControl))
      return snapshots.every(
        (snapshot) =>
          snapshot?.maxBufferedBytes === 1024 * 1024 &&
          snapshot.bufferedBytes === 0
      )
    })
    .toBe(true)
})
