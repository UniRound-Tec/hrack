import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { launchApp, typeInTerminal } from './helpers'
import { RemoteTestRelay } from './helpers/remoteTestRelay'
import {
  parseRemoteFrame,
  type RemoteMessage
} from '../shared/remote-protocol'

interface PhoneFixture {
  ws: WebSocket
  messages: RemoteMessage[]
}

async function openPhone(
  relay: RemoteTestRelay,
  roomId: string
): Promise<PhoneFixture> {
  const messages: RemoteMessage[] = []
  const ws = new WebSocket(`${relay.origin}${relay.base}/v1/ws`)
  ws.addEventListener('message', (event) => {
    const parsed = parseRemoteFrame(String(event.data))
    if (parsed.ok) messages.push(parsed.value)
  })
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener('open', () => resolve(), { once: true })
    ws.addEventListener(
      'error',
      () => reject(new Error('phone socket failed')),
      { once: true }
    )
  })
  ws.send(JSON.stringify({ v: 1, type: 'hello', role: 'phone', roomId }))
  return { ws, messages }
}

async function createRealAgent(page: Page, name: string): Promise<{
  sessionId: string
  terminalId: string
  ptyId: string
}> {
  await page.evaluate(() => window.__hrackDebugShell?.navigate('home'))
  await page.getByTestId('home-quick-codex').click()
  await page.getByTestId('cli-session-name').fill(name)
  await page.getByTestId('cli-workspace').fill(process.cwd())
  await page.getByTestId('cli-launch').click()
  await expect
    .poll(
      () =>
        page.evaluate(async (sessionName) => {
          const session = (await window.agentApi.listActive()).find(
            (item) => item.name === sessionName
          )
          return session?.sessionId ?? null
        }, name),
      { timeout: 30_000 }
    )
    .not.toBeNull()
  return page.evaluate(async (sessionName) => {
    const session = (await window.agentApi.listActive()).find(
      (item) => item.name === sessionName
    )
    if (!session) throw new Error('real agent session disappeared')
    const pty = (await window.ptyApi.listRecoverable()).find(
      (item) => item.terminalId === session.terminalId
    )
    if (!pty) throw new Error('real agent PTY disappeared')
    return {
      sessionId: session.sessionId,
      terminalId: session.terminalId,
      ptyId: pty.ptyId
    }
  }, name)
}

test.describe('remote driving with real Electron PTY', () => {
  let app: ElectronApplication
  let page: Page
  let relay: RemoteTestRelay
  let phone: PhoneFixture | undefined

  test.beforeEach(async () => {
    test.skip(process.platform !== 'win32', 'interactive CLI fixture uses cmd.exe')
    relay = await RemoteTestRelay.listen(0, '/remote')
    relay.openRoom('p4-room')
    ;({ app, window: page } = await launchApp({
      createDefaultTerminal: false,
      env: {
        HRACK_FIXTURE_OBSERVER: '1',
        HRACK_FIXTURE_OBSERVER_HOLD: '1'
      }
    }))
  })

  test.afterEach(async () => {
    phone?.ws.close()
    await app?.close()
    await relay?.close()
  })

  test('drives a real agent PTY at phone size and returns real history', async () => {
    const agent = await createRealAgent(page, 'Remote P4 drive fixture')
    const other = await createRealAgent(page, 'Remote P4 untouched fixture')
    const otherSizeBefore = await page.evaluate(async (ptyId) => {
      const resize = (await window.ptyApi.getHistory(ptyId))?.events
        .filter((event) => event.kind === 'resize')
        .at(-1)
      return resize?.kind === 'resize'
        ? { cols: resize.cols, rows: resize.rows }
        : null
    }, other.ptyId)

    await page.evaluate(() => window.__hrackDebugShell?.navigate('settings'))
    await page.getByTestId('settings-category-remote').click()
    await page
      .getByTestId('settings-remote-url')
      .fill(relay.joinUrl('p4-room'))
    await page.getByTestId('settings-remote-connect').click()
    await page.getByTestId('settings-remote-confirm-accept').click()
    await expect(page.getByTestId('settings-remote-status')).toHaveAttribute(
      'data-remote-phase',
      'waiting-phone'
    )

    phone = await openPhone(relay, 'p4-room')
    await expect
      .poll(() => phone?.messages.some((message) => message.type === 'hello-ok'))
      .toBe(true)
    phone.ws.send(
      JSON.stringify({
        v: 1,
        type: 'drive',
        requestId: 'real-drive-1',
        sessionId: agent.sessionId,
        cols: 40,
        rows: 18
      })
    )

    const drive = await expect
      .poll(() =>
        phone?.messages.find(
          (message) =>
            message.type === 'drive-ok' && message.requestId === 'real-drive-1'
        )
      )
      .toBeTruthy()
    void drive
    const driveOk = phone.messages.find(
      (message) =>
        message.type === 'drive-ok' && message.requestId === 'real-drive-1'
    )
    if (!driveOk || driveOk.type !== 'drive-ok') {
      throw new Error('missing correlated drive-ok')
    }
    expect(
      driveOk.history.events.some(
        (event) => event.kind === 'output' && event.byteLength > 0
      )
    ).toBe(true)

    await expect
      .poll(() =>
        page.evaluate(async (ptyId) => {
          const history = await window.ptyApi.getHistory(ptyId)
          const resize = history?.events
            .filter((event) => event.kind === 'resize')
            .at(-1)
          return resize?.kind === 'resize'
            ? { cols: resize.cols, rows: resize.rows }
            : null
        }, agent.ptyId)
      )
      .toEqual({ cols: 40, rows: 18 })

    phone.ws.send(
      JSON.stringify({
        v: 1,
        type: 'pty-in',
        sessionId: agent.sessionId,
        data: 'echo HRACK_P4_PHONE_INPUT\r'
      })
    )
    await expect
      .poll(() =>
        phone?.messages
          .filter(
            (message) =>
              message.type === 'pty-out' &&
              message.sessionId === agent.sessionId
          )
          .map((message) =>
            message.type === 'pty-out'
              ? Buffer.from(message.data, 'base64').toString('utf8')
              : ''
          )
          .join('')
      )
      .toContain('HRACK_P4_PHONE_INPUT')

    for (const message of phone.messages) {
      if (message.type !== 'pty-out') continue
      phone.ws.send(
        JSON.stringify({
          v: 1,
          type: 'pty-ack',
          sessionId: agent.sessionId,
          bytes: message.byteLength
        })
      )
    }
    phone.ws.send(
      JSON.stringify({
        v: 1,
        type: 'pty-resize',
        sessionId: agent.sessionId,
        cols: 52,
        rows: 20
      })
    )
    await expect
      .poll(() =>
        page.evaluate(async (ptyId) => {
          const history = await window.ptyApi.getHistory(ptyId)
          const resize = history?.events
            .filter((event) => event.kind === 'resize')
            .at(-1)
          return resize?.kind === 'resize'
            ? { cols: resize.cols, rows: resize.rows }
            : null
        }, agent.ptyId)
      )
      .toEqual({ cols: 52, rows: 20 })

    expect(
      await page.evaluate(async (ptyId) => {
        const resize = (await window.ptyApi.getHistory(ptyId))?.events
          .filter((event) => event.kind === 'resize')
          .at(-1)
        return resize?.kind === 'resize'
          ? { cols: resize.cols, rows: resize.rows }
          : null
      }, other.ptyId)
    ).toEqual(otherSizeBefore)

    await page.evaluate((terminalId) => {
      window.__hrackDebugShell?.navigate(`terminal:${terminalId}`)
    }, agent.terminalId)
    await expect(page.getByTestId('terminal-remote-overlay')).toBeVisible()
    await expect(
      page
        .getByTestId('sidebar-session-item')
        .filter({ hasText: 'Remote P4 drive fixture' })
    ).toHaveAttribute('data-remote-driven', 'true')

    const blockedMarker = `HRACK_P4_LOCAL_BLOCKED_${Date.now()}`
    await page.locator('.xterm-helper-textarea:visible').focus()
    await page.keyboard.type(`echo ${blockedMarker}`)
    await page.keyboard.press('Enter')
    await new Promise((resolve) => setTimeout(resolve, 350))
    expect(
      await page.evaluate(async (ptyId) =>
        (await window.ptyApi.getHistory(ptyId))?.events
          .filter((event) => event.kind === 'output')
          .map((event) => (event.kind === 'output' ? event.data : ''))
          .join('') ?? '', agent.ptyId)
    ).not.toContain(blockedMarker)

    await page.getByTestId('terminal-remote-reclaim').click()
    await expect(page.getByTestId('terminal-remote-overlay')).toBeHidden()
    await expect
      .poll(() =>
        phone?.messages.find(
          (message) =>
            message.type === 'undriven' && message.sessionId === agent.sessionId
        )
      )
      .toMatchObject({ type: 'undriven', reason: 'reclaim' })
    await expect
      .poll(() =>
        page.evaluate(async (ptyId) => {
          const resize = (await window.ptyApi.getHistory(ptyId))?.events
            .filter((event) => event.kind === 'resize')
            .at(-1)
          return resize?.kind === 'resize'
            ? `${resize.cols}x${resize.rows}`
            : null
        }, agent.ptyId)
      )
      .not.toBe('52x20')

    const reclaimedMarker = `HRACK_P4_LOCAL_RECLAIMED_${Date.now()}`
    await typeInTerminal(page, `echo ${reclaimedMarker}`)
    await page.keyboard.press('Enter')
    await expect
      .poll(() =>
        page.evaluate(async (ptyId) =>
          (await window.ptyApi.getHistory(ptyId))?.events
            .filter((event) => event.kind === 'output')
            .map((event) => (event.kind === 'output' ? event.data : ''))
            .join('') ?? '', agent.ptyId)
      )
      .toContain(reclaimedMarker)

    phone.ws.send(
      JSON.stringify({
        v: 1,
        type: 'drive',
        requestId: 'real-drive-exit',
        sessionId: agent.sessionId,
        cols: 44,
        rows: 19
      })
    )
    await expect
      .poll(() =>
        phone?.messages.some(
          (message) =>
            message.type === 'drive-ok' &&
            message.requestId === 'real-drive-exit'
        )
      )
      .toBe(true)
    phone.ws.send(
      JSON.stringify({
        v: 1,
        type: 'pty-in',
        sessionId: agent.sessionId,
        data: 'exit\r'
      })
    )
    await expect
      .poll(() =>
        phone?.messages
          .filter(
            (message) =>
              (message.type === 'pty-exit' || message.type === 'undriven') &&
              message.sessionId === agent.sessionId
          )
          .slice(-2)
          .map((message) => message.type)
      )
      .toEqual(['pty-exit', 'undriven'])
    expect(
      phone.messages.find(
        (message) =>
          message.type === 'undriven' &&
          message.sessionId === agent.sessionId &&
          message.reason === 'session-exit'
      )
    ).toBeTruthy()
  })

  test('releases a real PTY after the 15 second phone grace expires', async () => {
    test.setTimeout(45_000)
    const agent = await createRealAgent(page, 'Remote P4 timeout fixture')
    await page.evaluate(() => window.__hrackDebugShell?.navigate('settings'))
    await page.getByTestId('settings-category-remote').click()
    await page.getByTestId('settings-remote-url').fill(relay.joinUrl('p4-room'))
    await page.getByTestId('settings-remote-connect').click()
    await page.getByTestId('settings-remote-confirm-accept').click()
    await expect(page.getByTestId('settings-remote-status')).toHaveAttribute(
      'data-remote-phase',
      'waiting-phone'
    )
    phone = await openPhone(relay, 'p4-room')
    await expect.poll(() => phone?.messages.some((message) => message.type === 'hello-ok')).toBe(true)
    phone.ws.send(
      JSON.stringify({
        v: 1,
        type: 'drive',
        requestId: 'real-drive-timeout',
        sessionId: agent.sessionId,
        cols: 40,
        rows: 18
      })
    )
    await expect.poll(() => page.evaluate(() => window.remoteApi.getDriveState())).toMatchObject({
      phase: 'driven',
      sessionId: agent.sessionId
    })

    phone.ws.close()
    phone = undefined
    await new Promise((resolve) => setTimeout(resolve, 1_000))
    expect(await page.evaluate(() => window.remoteApi.getDriveState())).toMatchObject({
      phase: 'driven',
      sessionId: agent.sessionId
    })
    await expect
      .poll(() => page.evaluate(() => window.remoteApi.getDriveState()), {
        timeout: 20_000
      })
      .toMatchObject({ phase: 'idle', sessionId: null })
  })
})
