import { resolve } from 'node:path'
import {
  expect,
  test,
  type ElectronApplication,
  type Page
} from '@playwright/test'
import { launchApp } from './helpers'
import {
  parseJoinUrl,
  parseRemoteFrame,
  type RemoteMessage
} from '../shared/remote-protocol'

interface PhoneFixture {
  ws: WebSocket
  messages: RemoteMessage[]
}

async function openPhone(joinUrl: string): Promise<PhoneFixture> {
  const parsed = parseJoinUrl(joinUrl)
  if (!parsed.ok) throw new Error('relay generated an invalid join URL')
  const messages: RemoteMessage[] = []
  const ws = new WebSocket(parsed.value.wsUrl)
  ws.addEventListener('message', (event) => {
    const frame = parseRemoteFrame(String(event.data))
    if (frame.ok) messages.push(frame.value)
  })
  await new Promise<void>((resolveOpen, reject) => {
    ws.addEventListener('open', () => resolveOpen(), { once: true })
    ws.addEventListener(
      'error',
      () => reject(new Error('phone WSS connection failed')),
      { once: true }
    )
  })
  ws.send(
    JSON.stringify({
      v: 1,
      type: 'hello',
      role: 'phone',
      roomId: parsed.value.roomId
    })
  )
  return { ws, messages }
}

async function connectHrack(page: Page, joinUrl: string): Promise<void> {
  await page.evaluate(() => window.__hrackDebugShell?.navigate('settings'))
  await page.getByTestId('settings-category-remote').click()
  await page.getByTestId('settings-remote-url').fill(joinUrl)
  await page.getByTestId('settings-remote-connect').click()
  await page.getByTestId('settings-remote-confirm-accept').click()
  await expect(page.getByTestId('settings-remote-status')).toHaveAttribute(
    'data-remote-phase',
    'waiting-phone'
  )
}

const targetUrl = process.env.HRACK_REMOTE_P5_URL

test.describe('remote P5 live relay', () => {
  test.skip(
    !targetUrl,
    'set HRACK_REMOTE_P5_URL to a real relay generate page to run this gate'
  )

  test('creates and drives one real Electron PTY through the deployed relay', async ({
    page: relayPage
  }) => {
    test.skip(
      process.platform !== 'win32',
      'interactive P5 CLI fixture uses cmd.exe'
    )
    test.setTimeout(60_000)
    if (!targetUrl) throw new Error('missing live relay target')

    let app: ElectronApplication | undefined
    let phone: PhoneFixture | undefined
    let roomCreated = false
    let roomRevoked = false
    try {
      const response = await relayPage.goto(targetUrl)
      if (!response?.ok()) throw new Error('relay generate page did not load')
      await relayPage.getByTestId('create-room').click()
      await expect(relayPage.getByTestId('join-url')).toBeVisible()
      roomCreated = true
      const joinUrl = await relayPage.getByTestId('join-url').innerText()

      const launched = await launchApp({
        createDefaultTerminal: false,
        env: {
          HRACK_FIXTURE_OBSERVER: '1',
          HRACK_FIXTURE_OBSERVER_HOLD: '1',
          HRACK_E2E_CLI_EXECUTABLE: resolve(
            __dirname,
            'fixtures/remote/interactive-cli.cmd'
          )
        }
      })
      app = launched.app
      const hrackPage = launched.window
      await connectHrack(hrackPage, joinUrl)

      phone = await openPhone(joinUrl)
      const catalog = await expect
        .poll(
          () => phone?.messages.find((message) => message.type === 'catalog'),
          { timeout: 30_000 }
        )
        .toBeTruthy()
      void catalog
      const launchCatalog = phone.messages.find(
        (message): message is Extract<RemoteMessage, { type: 'catalog' }> =>
          message.type === 'catalog'
      )
      expect(JSON.stringify(launchCatalog)).not.toContain('resolvedExecutable')
      const installation = launchCatalog?.launchable
        .flatMap((launchable) => launchable.installations)
        .find((candidate) => candidate.runtime.kind === 'host')
      if (!installation) throw new Error('live catalog has no host installation')

      const create = {
        v: 1,
        type: 'create',
        requestId: 'p5-live-create',
        installationId: installation.id,
        workspace: process.cwd(),
        cols: 44,
        rows: 19,
        skipApproval: true,
        args: ['--model', 'p5-live-model']
      }
      phone.ws.send(JSON.stringify(create))
      await expect
        .poll(
          () =>
            phone?.messages
              .filter(
                (message) =>
                  'requestId' in message &&
                  message.requestId === create.requestId
              )
              .map((message) => message.type),
          { timeout: 30_000 }
        )
        .toEqual(['create-ok', 'drive-ok'])
      const created = phone.messages.find(
        (message): message is Extract<RemoteMessage, { type: 'create-ok' }> =>
          message.type === 'create-ok' &&
          message.requestId === create.requestId
      )
      if (!created) throw new Error('missing live create-ok')

      const session = await expect
        .poll(
          () =>
            hrackPage.evaluate(async (sessionId) => {
              const found = (await window.agentApi.listActive()).find(
                (candidate) => candidate.sessionId === sessionId
              )
              return found
                ? { terminalId: found.terminalId, name: found.name }
                : null
            }, created.sessionId),
          { timeout: 30_000 }
        )
        .not.toBeNull()
      void session
      const real = await hrackPage.evaluate(async (sessionId) => {
        const active = (await window.agentApi.listActive()).find(
          (candidate) => candidate.sessionId === sessionId
        )
        if (!active) throw new Error('created session disappeared')
        const pty = (await window.ptyApi.listRecoverable()).find(
          (candidate) => candidate.terminalId === active.terminalId
        )
        if (!pty) throw new Error('created PTY disappeared')
        return {
          ptyId: pty.ptyId,
          args: pty.agentSelection?.args ?? []
        }
      }, created.sessionId)
      expect(real.args).toEqual(['--yolo', '--model', 'p5-live-model'])
      const latestSize = await hrackPage.evaluate(async (ptyId) => {
        const events = (await window.ptyApi.getHistory(ptyId))?.events ?? []
        return events.filter((event) => event.kind === 'resize').at(-1) ?? null
      }, real.ptyId)
      expect(latestSize).toMatchObject({ cols: 44, rows: 19 })
      await expect(
        hrackPage
          .getByTestId('sidebar-session-item')
          .filter({ hasText: 'Codex' })
      ).toHaveAttribute('data-remote-driven', 'true')

      const marker = `HRACK_P5_LIVE_${Date.now()}`
      phone.ws.send(
        JSON.stringify({
          v: 1,
          type: 'pty-in',
          sessionId: created.sessionId,
          data: `echo ${marker}\r`
        })
      )
      await expect
        .poll(() =>
          phone?.messages
            .filter(
              (message): message is Extract<
                RemoteMessage,
                { type: 'pty-out' }
              > =>
                message.type === 'pty-out' &&
                message.sessionId === created.sessionId
            )
            .map((message) => Buffer.from(message.data, 'base64'))
            .reduce(
              (output, chunk) => Buffer.concat([output, chunk]),
              Buffer.alloc(0)
            )
            .toString('utf8')
        )
        .toContain(marker)
      for (const message of phone.messages) {
        if (message.type !== 'pty-out' || message.sessionId !== created.sessionId) {
          continue
        }
        phone.ws.send(
          JSON.stringify({
            v: 1,
            type: 'pty-ack',
            sessionId: created.sessionId,
            bytes: message.byteLength
          })
        )
      }

      phone.ws.send(JSON.stringify(create))
      await expect
        .poll(
          () =>
            phone?.messages.filter(
              (message) =>
                message.type === 'drive-ok' &&
                message.requestId === create.requestId
            ).length
        )
        .toBe(2)
      expect(await hrackPage.evaluate(
        async (sessionId) =>
          (await window.agentApi.listActive()).filter(
            (candidate) => candidate.sessionId === sessionId
          ).length,
        created.sessionId
      )).toBe(1)

      phone.ws.send(
        JSON.stringify({
          v: 1,
          type: 'undrive',
          sessionId: created.sessionId
        })
      )
      await expect
        .poll(() => hrackPage.evaluate(() => window.remoteApi.getDriveState()))
        .toMatchObject({ phase: 'idle', sessionId: null })

      await relayPage.getByTestId('revoke-room').click()
      await expect(relayPage.getByTestId('status')).toHaveText('Room revoked.')
      roomRevoked = true
    } finally {
      if (roomCreated && !roomRevoked) {
        const revoke = relayPage.getByTestId('revoke-room')
        if (await revoke.isVisible().catch(() => false)) {
          await revoke.click().catch(() => {})
        }
      }
      phone?.ws.close()
      await app?.close().catch(() => {})
    }
  })
})
