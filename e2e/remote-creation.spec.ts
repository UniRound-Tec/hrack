import { resolve } from 'node:path'
import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { launchApp } from './helpers'
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
  await new Promise<void>((resolveOpen, reject) => {
    ws.addEventListener('open', () => resolveOpen(), { once: true })
    ws.addEventListener(
      'error',
      () => reject(new Error('phone socket failed')),
      { once: true }
    )
  })
  ws.send(JSON.stringify({ v: 1, type: 'hello', role: 'phone', roomId }))
  return { ws, messages }
}

function decodedOutput(
  messages: readonly RemoteMessage[],
  sessionId: string
): string {
  return Buffer.concat(
    messages
      .filter(
        (message): message is Extract<RemoteMessage, { type: 'pty-out' }> =>
          message.type === 'pty-out' && message.sessionId === sessionId
      )
      .map((message) => Buffer.from(message.data, 'base64'))
  ).toString('utf8')
}

test.describe('remote P5 creation with real Electron PTY', () => {
  let app: ElectronApplication
  let page: Page
  let relay: RemoteTestRelay
  let phone: PhoneFixture | undefined

  test.beforeEach(async () => {
    test.skip(
      process.platform !== 'win32',
      'interactive P5 CLI fixture uses cmd.exe'
    )
    relay = await RemoteTestRelay.listen(0, '/remote')
    relay.openRoom('p5-room')
    ;({ app, window: page } = await launchApp({
      createDefaultTerminal: false,
      env: {
        HRACK_FIXTURE_OBSERVER: '1',
        HRACK_FIXTURE_OBSERVER_HOLD: '1',
        HRACK_E2E_CLI_EXECUTABLE: resolve(
          __dirname,
          'fixtures/remote/interactive-cli.cmd'
        )
      }
    }))
  })

  test.afterEach(async () => {
    phone?.ws.close()
    await app?.close()
    await relay?.close()
  })

  test('creates, shows, drives, and deduplicates one real agent session', async () => {
    await page.evaluate(
      (joinUrl) => window.remoteApi.connect(joinUrl),
      relay.joinUrl('p5-room')
    )
    phone = await openPhone(relay, 'p5-room')

    const catalog = await expect
      .poll(
        () => phone?.messages.find((message) => message.type === 'catalog'),
        { timeout: 30_000 }
      )
      .toBeTruthy()
    void catalog
    const catalogMessage = phone.messages.find(
      (message): message is Extract<RemoteMessage, { type: 'catalog' }> =>
        message.type === 'catalog'
    )
    if (!catalogMessage) throw new Error('missing real launch catalog')
    expect(JSON.stringify(catalogMessage)).not.toContain('resolvedExecutable')
    const installation = catalogMessage.launchable
      .flatMap((launchable) => launchable.installations)
      .find((candidate) => candidate.runtime.kind === 'host')
    if (!installation) throw new Error('missing host CLI installation')

    const request = {
      v: 1,
      type: 'create',
      requestId: 'p5-real-create',
      installationId: installation.id,
      workspace: process.cwd(),
      cols: 52,
      rows: 20,
      skipApproval: true,
      args: ['--model', 'o3']
    }
    phone.ws.send(JSON.stringify(request))

    await expect
      .poll(
        () =>
          phone?.messages
            .filter(
              (message) =>
                'requestId' in message &&
                message.requestId === request.requestId
            )
            .map((message) => message.type),
        { timeout: 30_000 }
      )
      .toEqual(['create-ok', 'drive-ok'])
    const created = phone.messages.find(
      (message): message is Extract<RemoteMessage, { type: 'create-ok' }> =>
        message.type === 'create-ok' && message.requestId === request.requestId
    )
    if (!created) throw new Error('missing create-ok')

    const runtime = await expect
      .poll(
        () =>
          page.evaluate(async (sessionId) => {
            const session = (await window.agentApi.listActive()).find(
              (candidate) => candidate.sessionId === sessionId
            )
            if (!session) return null
            const pty = (await window.ptyApi.listRecoverable()).find(
              (candidate) => candidate.terminalId === session.terminalId
            )
            return pty
              ? {
                  terminalId: session.terminalId,
                  ptyId: pty.ptyId,
                  args: pty.agentSelection?.args ?? []
                }
              : null
          }, created.sessionId),
        { timeout: 30_000 }
      )
      .not.toBeNull()
    void runtime
    const real = await page.evaluate(async (sessionId) => {
      const session = (await window.agentApi.listActive()).find(
        (candidate) => candidate.sessionId === sessionId
      )
      if (!session) throw new Error('created session disappeared')
      const pty = (await window.ptyApi.listRecoverable()).find(
        (candidate) => candidate.terminalId === session.terminalId
      )
      if (!pty) throw new Error('created PTY disappeared')
      return {
        terminalId: session.terminalId,
        ptyId: pty.ptyId,
        args: pty.agentSelection?.args ?? []
      }
    }, created.sessionId)
    expect(real.args).toEqual(['--yolo', '--model', 'o3'])
    const latestSize = await page.evaluate(async (ptyId) => {
      const events = (await window.ptyApi.getHistory(ptyId))?.events ?? []
      return events.filter((event) => event.kind === 'resize').at(-1) ?? null
    }, real.ptyId)
    expect(latestSize).toMatchObject({ cols: 52, rows: 20 })
    await expect
      .poll(
        () =>
          phone?.messages
            .filter(
              (message): message is Extract<RemoteMessage, { type: 'catalog' }> =>
                message.type === 'catalog'
            )
            .at(-1)?.recentWorkspaces[0]
      )
      .toBe(process.cwd())
    await expect(
      page
        .getByTestId('sidebar-session-item')
        .filter({ hasText: 'Codex' })
    ).toHaveAttribute('data-remote-driven', 'true')

    const marker = `HRACK_P5_REAL_${Date.now()}`
    phone.ws.send(
      JSON.stringify({
        v: 1,
        type: 'pty-in',
        sessionId: created.sessionId,
        data: `echo ${marker}\r`
      })
    )
    await expect
      .poll(() => decodedOutput(phone?.messages ?? [], created.sessionId), {
        timeout: 15_000
      })
      .toContain(marker)
    const parsedBytes = phone.messages
      .filter(
        (message): message is Extract<RemoteMessage, { type: 'pty-out' }> =>
          message.type === 'pty-out' && message.sessionId === created.sessionId
      )
      .reduce((total, message) => total + message.byteLength, 0)
    phone.ws.send(
      JSON.stringify({
        v: 1,
        type: 'pty-ack',
        sessionId: created.sessionId,
        bytes: parsedBytes
      })
    )

    phone.ws.send(JSON.stringify(request))
    await expect
      .poll(
        () =>
          phone?.messages.filter(
            (message) =>
              message.type === 'drive-ok' &&
              message.requestId === request.requestId
          ).length
      )
      .toBe(2)
    expect(
      await page.evaluate(
        async (sessionId) =>
          (await window.agentApi.listActive()).filter(
            (session) => session.sessionId === sessionId
          ).length,
        created.sessionId
      )
    ).toBe(1)

    phone.ws.send(
      JSON.stringify({
        v: 1,
        type: 'undrive',
        sessionId: created.sessionId
      })
    )
    await expect
      .poll(() => page.evaluate(() => window.remoteApi.getDriveState()))
      .toMatchObject({ phase: 'idle', sessionId: null })
  })

  test('rejects invalid workspaces and installations before spawning', async () => {
    await page.evaluate(
      (joinUrl) => window.remoteApi.connect(joinUrl),
      relay.joinUrl('p5-room')
    )
    phone = await openPhone(relay, 'p5-room')
    await expect
      .poll(
        () => phone?.messages.find((message) => message.type === 'catalog'),
        { timeout: 30_000 }
      )
      .toBeTruthy()
    const catalog = phone.messages.find(
      (message): message is Extract<RemoteMessage, { type: 'catalog' }> =>
        message.type === 'catalog'
    )
    const installation = catalog?.launchable
      .flatMap((launchable) => launchable.installations)
      .find((candidate) => candidate.runtime.kind === 'host')
    if (!installation) throw new Error('missing host CLI installation')

    const attempts = [
      {
        requestId: 'p5-empty-workspace',
        installationId: installation.id,
        workspace: '',
        reason: 'invalid-workspace'
      },
      {
        requestId: 'p5-missing-workspace',
        installationId: installation.id,
        workspace: resolve(process.cwd(), 'definitely-missing-p5-workspace'),
        reason: 'invalid-workspace'
      },
      {
        requestId: 'p5-missing-installation',
        installationId: 'missing:installation',
        workspace: process.cwd(),
        reason: 'installation-not-found'
      }
    ] as const
    for (const attempt of attempts) {
      phone.ws.send(
        JSON.stringify({
          v: 1,
          type: 'create',
          requestId: attempt.requestId,
          installationId: attempt.installationId,
          workspace: attempt.workspace,
          cols: 52,
          rows: 20
        })
      )
      await expect
        .poll(() =>
          phone?.messages.find(
            (message) =>
              message.type === 'create-reject' &&
              message.requestId === attempt.requestId
          )
        )
        .toMatchObject({
          type: 'create-reject',
          requestId: attempt.requestId,
          reason: attempt.reason
        })
    }

    expect(
      await page.evaluate(() => window.agentApi.listActive())
    ).toHaveLength(0)
    expect(
      await page.evaluate(() => window.ptyApi.listRecoverable())
    ).toHaveLength(0)
    await expect(page.getByTestId('sidebar-session-item')).toHaveCount(0)
  })
})
