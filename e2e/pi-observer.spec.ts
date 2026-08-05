import { expect, test } from '@playwright/test'
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parsePiHook } from '../electron/agents/adapters/pi/PiHookParser'
import { PiEventProjector } from '../electron/agents/adapters/pi/PiEventProjector'
import { buildPiExtensionSource } from '../electron/agents/adapters/pi/PiExtensionSource'
import { PiObserverAdapter } from '../electron/agents/adapters/pi/PiObserverAdapter'
import type { PiNativeFact } from '../electron/agents/adapters/pi/types'
import type { AdapterEvent } from '../electron/agents/adapters/types'

test.describe('Pi observer adapter', () => {
  test('accepts a scoped wire fact and rejects malformed or cross-session input', () => {
    const expectedSessionId = 'vibing-session-1'
    expect(
      parsePiHook(
        {
          schema: 1,
          sessionId: expectedSessionId,
          generation: 'generation-1',
          seq: 1,
          emittedAt: 1_755_000_000_000,
          type: 'session-start',
          payload: { reason: 'startup' }
        },
        expectedSessionId
      )
    ).toEqual({
      type: 'session-start',
      sessionId: expectedSessionId,
      generation: 'generation-1',
      seq: 1,
      emittedAt: 1_755_000_000_000,
      nativeType: 'session-start',
      reason: 'startup'
    })

    expect(
      parsePiHook(
        {
          schema: 1,
          sessionId: 'another-session',
          generation: 'generation-1',
          seq: 2,
          emittedAt: 1_755_000_000_001,
          type: 'session-start',
          payload: { reason: 'startup' }
        },
        expectedSessionId
      )
    ).toBeNull()
    expect(
      parsePiHook(
        {
          schema: 2,
          sessionId: expectedSessionId,
          generation: 'generation-1',
          seq: 2,
          emittedAt: 1_755_000_000_001,
          type: 'session-start',
          payload: { reason: 'startup' }
        },
        expectedSessionId
      )
    ).toBeNull()
  })

  test('keeps tool, thinking, and usage facts low-sensitivity', () => {
    const base = {
      schema: 1,
      sessionId: 'vibing-session-1',
      generation: 'generation-1',
      emittedAt: 1_755_000_000_000
    }
    expect(
      parsePiHook(
        {
          ...base,
          seq: 2,
          type: 'tool-start',
          payload: {
            callId: 'call-1',
            toolName: 'bash',
            args: { command: 'echo super-secret' }
          }
        },
        base.sessionId
      )
    ).toEqual({
      type: 'tool-start',
      sessionId: base.sessionId,
      generation: base.generation,
      seq: 2,
      emittedAt: base.emittedAt,
      nativeType: 'tool-start',
      callId: 'call-1',
      toolName: 'bash'
    })
    expect(
      parsePiHook(
        {
          ...base,
          seq: 3,
          type: 'thinking-start',
          payload: { text: 'private reasoning must not cross' }
        },
        base.sessionId
      )
    ).toEqual({
      type: 'thinking-start',
      sessionId: base.sessionId,
      generation: base.generation,
      seq: 3,
      emittedAt: base.emittedAt,
      nativeType: 'thinking-start'
    })
    expect(
      parsePiHook(
        {
          ...base,
          seq: 4,
          type: 'usage',
          payload: {
            inputTokens: 120,
            outputTokens: 30,
            cachedInputTokens: 10,
            contextTokens: 640,
            contextWindow: 128_000,
            costUsd: 0.004,
            assistantText: 'must be dropped'
          }
        },
        base.sessionId
      )
    ).toEqual({
      type: 'usage',
      sessionId: base.sessionId,
      generation: base.generation,
      seq: 4,
      emittedAt: base.emittedAt,
      nativeType: 'usage',
      inputTokens: 120,
      outputTokens: 30,
      cachedInputTokens: 10,
      contextTokens: 640,
      contextWindow: 128_000,
      costUsd: 0.004,
      scope: 'turn'
    })
  })

  test('uses agent_settled as the 0.82 completion boundary', () => {
    const projector = new PiEventProjector({ supportsAgentSettled: true })
    const base = {
      sessionId: 'vibing-session-1',
      generation: 'generation-1',
      emittedAt: 1_755_000_000_000
    }
    const fact = (seq: number, value: Record<string, unknown>): PiNativeFact =>
      ({ ...base, seq, nativeType: value.type, ...value }) as PiNativeFact

    expect(
      projector.project(
        fact(1, { type: 'session-start', reason: 'startup' }),
        100
      ).map((event) => event.kind)
    ).toEqual(['session.idle'])
    expect(
      projector.project(fact(2, { type: 'run-start' }), 110).map((event) => event.kind)
    ).toEqual(['turn.started'])
    expect(
      projector.project(fact(3, { type: 'thinking-start' }), 120).map((event) => event.kind)
    ).toEqual(['thinking.started'])
    expect(
      projector.project(fact(4, { type: 'thinking-end' }), 130).map((event) => event.kind)
    ).toEqual(['thinking.completed'])
    expect(
      projector.project(fact(5, { type: 'responding' }), 140).map((event) => event.kind)
    ).toEqual(['activity.caption'])
    expect(
      projector.project(
        fact(6, {
          type: 'tool-start',
          callId: 'call-1',
          toolName: 'bash'
        }),
        150
      ).map((event) => event.kind)
    ).toEqual(['tool.started'])
    expect(
      projector.project(
        fact(7, {
          type: 'tool-end',
          callId: 'call-1',
          toolName: 'bash',
          isError: false,
          durationMs: 20
        }),
        170
      ).map((event) => event.kind)
    ).toEqual(['tool.completed'])
    expect(
      projector.project(
        fact(8, {
          type: 'usage',
          inputTokens: 120,
          outputTokens: 30,
          scope: 'turn'
        }),
        180
      ).map((event) => event.kind)
    ).toEqual(['usage.updated'])
    expect(
      projector.project(fact(9, { type: 'run-end', outcome: 'completed' }), 190)
    ).toEqual([])
    expect(
      projector.project(fact(10, { type: 'run-settled' }), 200).map((event) => event.kind)
    ).toEqual(['turn.completed'])
  })

  for (const fixture of ['080', '082'] as const) {
    test(`replays the sanitized ${fixture} extension fixture to completion`, async () => {
      const raw = JSON.parse(
        await readFile(
          resolve(`e2e/fixtures/pi/extension-events-${fixture}.json`),
          'utf8'
        )
      ) as Array<{ type: string; payload: Record<string, unknown> }>
      const projector = new PiEventProjector({
        supportsAgentSettled: fixture === '082'
      })
      const kinds = raw.flatMap((entry, index) => {
        const fact = parsePiHook(
          {
            schema: 1,
            sessionId: `fixture-${fixture}`,
            generation: `generation-${fixture}`,
            seq: index + 1,
            emittedAt: 1_755_000_000_000 + index,
            ...entry
          },
          `fixture-${fixture}`,
          1_755_000_100_000
        )
        expect(fact).not.toBeNull()
        return fact ? projector.project(fact).map((event) => event.kind) : []
      })
      expect(kinds).toEqual(
        expect.arrayContaining([
          'session.idle',
          'turn.started',
          'thinking.started',
          'tool.started',
          'usage.updated',
          'turn.completed'
        ])
      )
      const serialized = JSON.stringify(raw)
      expect(serialized).not.toMatch(
        /"(?:reasoning|prompt|arguments|result|text|args|output)"\s*:/i
      )
    })
  }

  test('waits for compatibility settle on 0.80 and treats session replacement as idle', () => {
    const projector = new PiEventProjector({ supportsAgentSettled: false })
    const make = (
      generation: string,
      seq: number,
      value: Record<string, unknown>
    ): PiNativeFact =>
      ({
        sessionId: 'vibing-session-1',
        generation,
        seq,
        emittedAt: 1_755_000_000_000 + seq,
        nativeType: value.type,
        ...value
      }) as PiNativeFact

    projector.project(make('generation-1', 1, { type: 'session-start', reason: 'startup' }))
    projector.project(make('generation-1', 2, { type: 'run-start' }))
    expect(
      projector.project(
        make('generation-1', 3, { type: 'run-end', outcome: 'completed' })
      )
    ).toEqual([])
    expect(
      projector.project(make('generation-1', 4, { type: 'run-settled' })).map(
        (event) => event.kind
      )
    ).toEqual(['turn.completed'])

    projector.project(make('generation-1', 5, { type: 'run-start' }))
    expect(
      projector.project(
        make('generation-1', 6, {
          type: 'session-shutdown',
          reason: 'resume'
        })
      )
    ).toEqual([])
    expect(
      projector.project(
        make('generation-2', 1, { type: 'session-start', reason: 'resume' }),
        250
      ).map((event) => event.kind)
    ).toEqual(['session.idle'])
    expect(
      projector.project(
        make('generation-1', 7, { type: 'run-settled' })
      )
    ).toEqual([])
  })

  test('parses the complete read-only Pi fact vocabulary', () => {
    const base = {
      schema: 1,
      sessionId: 'vibing-session-1',
      generation: 'generation-1',
      emittedAt: 1_755_000_000_000
    }
    const rawFacts = [
      { type: 'run-start', payload: {} },
      { type: 'thinking-end', payload: {} },
      { type: 'responding', payload: {} },
      {
        type: 'tool-progress',
        payload: { callId: 'call-1', toolName: 'bash', output: 'private' }
      },
      {
        type: 'tool-end',
        payload: {
          callId: 'call-1',
          toolName: 'bash',
          isError: true,
          durationMs: 25,
          result: 'private'
        }
      },
      { type: 'compact-start', payload: { reason: 'overflow', willRetry: true } },
      { type: 'compact-end', payload: { reason: 'overflow', willRetry: true } },
      { type: 'run-end', payload: { outcome: 'failed', error: 'private' } },
      { type: 'run-settled', payload: {} },
      {
        type: 'observer-degraded',
        payload: { reason: 'settle-ambiguous', error: 'private' }
      },
      { type: 'session-shutdown', payload: { reason: 'resume' } }
    ]
    const parsed = rawFacts.map((raw, index) =>
      parsePiHook(
        { ...base, seq: index + 1, ...raw },
        base.sessionId
      )
    )
    expect(parsed.map((fact) => fact?.type)).toEqual(rawFacts.map((fact) => fact.type))
    expect(parsed[3]).not.toHaveProperty('output')
    expect(parsed[4]).not.toHaveProperty('result')
    expect(parsed[7]).not.toHaveProperty('error')
  })

  test('generated extension emits low-sensitivity facts without mutation hooks', async () => {
    const root = await mkdtemp(join(tmpdir(), 'vibing-pi-source-'))
    const dropDir = join(root, 'drop')
    const extensionPath = join(root, 'observer.ts')
    const previousDrop = process.env.VIBING_PI_DROP_DIR
    const previousSession = process.env.VIBING_PI_SESSION_ID
    try {
      await writeFile(
        extensionPath,
        buildPiExtensionSource({ supportsAgentSettled: true }),
        'utf8'
      )
      process.env.VIBING_PI_DROP_DIR = dropDir
      process.env.VIBING_PI_SESSION_ID = 'vibing-session-1'

      type Handler = (
        event: Record<string, unknown>,
        context: Record<string, unknown>
      ) => unknown | Promise<unknown>
      const handlers = new Map<string, Handler>()
      const loaded = (await import(
        `${pathToFileURL(extensionPath).href}?test=${Date.now()}`
      )) as {
        default:
          | ((pi: { on: (name: string, handler: Handler) => void }) => void)
          | { default: (pi: { on: (name: string, handler: Handler) => void }) => void }
      }
      const factory =
        typeof loaded.default === 'function'
          ? loaded.default
          : loaded.default.default
      factory({ on: (name, handler) => handlers.set(name, handler) })

      expect([...handlers.keys()]).not.toEqual(
        expect.arrayContaining(['input', 'tool_call', 'tool_result', 'project_trust'])
      )
      const context = {
        isIdle: () => true,
        hasPendingMessages: () => false,
        getContextUsage: () => ({ tokens: 640, contextWindow: 128_000 })
      }
      await handlers.get('session_start')?.({ reason: 'startup' }, context)
      await handlers.get('agent_start')?.({}, context)
      await handlers.get('message_update')?.(
        {
          message: { usage: { output: 12 } },
          assistantMessageEvent: {
            type: 'thinking_start',
            delta: 'PRIVATE_REASONING'
          }
        },
        context
      )
      await handlers.get('message_update')?.(
        { assistantMessageEvent: { type: 'thinking_end', content: 'PRIVATE_REASONING' } },
        context
      )
      await handlers.get('tool_execution_start')?.(
        {
          toolCallId: 'call-1',
          toolName: 'bash',
          args: { command: 'echo PRIVATE_COMMAND' }
        },
        context
      )
      await handlers.get('tool_execution_end')?.(
        {
          toolCallId: 'call-1',
          toolName: 'bash',
          result: { content: [{ text: 'PRIVATE_OUTPUT' }] },
          isError: false
        },
        context
      )
      await handlers.get('turn_end')?.(
        {
          message: {
            usage: {
              input: 120,
              output: 30,
              cacheRead: 10,
              cost: { total: 0.004 }
            }
          }
        },
        context
      )
      await handlers.get('agent_end')?.({ messages: [] }, context)
      await handlers.get('agent_settled')?.({}, context)

      const payloads = await Promise.all(
        (await readdir(dropDir))
          .filter((name) => name.endsWith('.json'))
          .sort()
          .map((name) => readFile(join(dropDir, name), 'utf8'))
      )
      const joined = payloads.join('\n')
      expect(payloads.map((payload) => JSON.parse(payload).type)).toEqual(
        expect.arrayContaining([
          'session-start',
          'run-start',
          'thinking-start',
          'thinking-end',
          'tool-start',
          'tool-end',
          'usage',
          'run-end',
          'run-settled'
        ])
      )
      expect(joined).not.toContain('PRIVATE_REASONING')
      expect(joined).not.toContain('PRIVATE_COMMAND')
      expect(joined).not.toContain('PRIVATE_OUTPUT')
    } finally {
      if (previousDrop === undefined) delete process.env.VIBING_PI_DROP_DIR
      else process.env.VIBING_PI_DROP_DIR = previousDrop
      if (previousSession === undefined) delete process.env.VIBING_PI_SESSION_ID
      else process.env.VIBING_PI_SESSION_ID = previousSession
      await rm(root, { recursive: true, force: true })
    }
  })

  test('0.80 compatibility mode keeps retries in one run and settles only after stable idle', async () => {
    const root = await mkdtemp(join(tmpdir(), 'vibing-pi-080-'))
    const dropDir = join(root, 'drop')
    const extensionPath = join(root, 'observer.ts')
    const previousDrop = process.env.VIBING_PI_DROP_DIR
    const previousSession = process.env.VIBING_PI_SESSION_ID
    try {
      await writeFile(
        extensionPath,
        buildPiExtensionSource({ supportsAgentSettled: false }),
        'utf8'
      )
      process.env.VIBING_PI_DROP_DIR = dropDir
      process.env.VIBING_PI_SESSION_ID = 'vibing-session-080'
      type Handler = (
        event: Record<string, unknown>,
        context: Record<string, unknown>
      ) => unknown | Promise<unknown>
      const handlers = new Map<string, Handler>()
      const loaded = (await import(
        `${pathToFileURL(extensionPath).href}?test=${Date.now()}`
      )) as {
        default:
          | ((pi: { on: (name: string, handler: Handler) => void }) => void)
          | { default: (pi: { on: (name: string, handler: Handler) => void }) => void }
      }
      const factory =
        typeof loaded.default === 'function'
          ? loaded.default
          : loaded.default.default
      factory({ on: (name, handler) => handlers.set(name, handler) })

      const context = {
        isIdle: () => true,
        hasPendingMessages: () => false,
        getContextUsage: () => ({ tokens: 50, contextWindow: 1_000 })
      }
      await handlers.get('session_start')?.({ reason: 'startup' }, context)
      await handlers.get('agent_start')?.({}, context)
      await handlers.get('agent_end')?.({ willRetry: true }, context)
      await new Promise((resolve) => setTimeout(resolve, 80))
      await handlers.get('agent_start')?.({}, context)
      await handlers.get('agent_end')?.({ willRetry: false }, context)
      await new Promise((resolve) => setTimeout(resolve, 100))

      const types = await Promise.all(
        (await readdir(dropDir))
          .filter((name) => name.endsWith('.json'))
          .sort()
          .map(async (name) =>
            JSON.parse(await readFile(join(dropDir, name), 'utf8')).type
          )
      )
      expect(types.filter((type) => type === 'run-start')).toHaveLength(1)
      expect(types.filter((type) => type === 'run-settled')).toHaveLength(1)
      expect(types.indexOf('run-settled')).toBeGreaterThan(
        types.lastIndexOf('run-end')
      )
    } finally {
      if (previousDrop === undefined) delete process.env.VIBING_PI_DROP_DIR
      else process.env.VIBING_PI_DROP_DIR = previousDrop
      if (previousSession === undefined) delete process.env.VIBING_PI_SESSION_ID
      else process.env.VIBING_PI_SESSION_ID = previousSession
      await rm(root, { recursive: true, force: true })
    }
  })

  test('prepares, attaches, and disposes a host Pi observer through the adapter seam', async () => {
    const root = await mkdtemp(join(tmpdir(), 'vibing-pi-adapter-'))
    const runDir = join(root, 'run')
    await mkdir(runDir)
    const probeCalls: Array<{ file: string; args: readonly string[] }> = []
    const adapter = new PiObserverAdapter({
      pollIntervalMs: 10,
      runCommand: async (file, args) => {
        probeCalls.push({ file, args })
        return { code: 0, stdout: '0.82.1\n' }
      }
    })
    try {
      const prepared = await adapter.prepare({
        sessionId: 'vibing-session-1',
        adapterId: 'pi',
        platform: 'win32',
        workspace: root,
        args: [],
        runDir,
        installation: {
          id: 'pi:windows:test',
          definitionId: 'pi',
          runtime: { kind: 'host', platform: 'windows' },
          resolvedExecutable: 'C:\\mock\\pi.cmd',
          detectedVia: 'path',
          version: '0.82.1',
          verification: 'verified'
        }
      })
      expect(probeCalls[0]).toEqual({
        file: 'C:\\mock\\pi.cmd',
        args: ['--version']
      })
      expect(prepared.capabilities).toMatchObject({
        thinking: 'phase',
        tools: 'progress',
        usage: 'tokens-and-context'
      })
      expect(prepared.launch.prependArgs?.slice(0, 1)).toEqual(['--extension'])
      const extensionPath = prepared.launch.prependArgs?.[1]
      const dropDir = prepared.launch.env?.VIBING_PI_DROP_DIR
      expect(extensionPath).toBeTruthy()
      expect(dropDir).toBeTruthy()
      await expect(stat(extensionPath!)).resolves.toMatchObject({})
      await expect(stat(dropDir!)).resolves.toMatchObject({})

      const events: AdapterEvent[] = []
      const handle = await prepared.attach(
        {
          sessionId: 'vibing-session-1',
          installationId: 'pi:windows:test',
          adapterId: 'pi',
          ptyId: 'pty-1',
          runDir,
          cols: 100,
          rows: 30
        },
        (event) => events.push(event)
      )
      await writeFile(
        join(dropDir!, '000000000001.fixture.json'),
        JSON.stringify({
          schema: 1,
          sessionId: 'vibing-session-1',
          generation: 'generation-1',
          seq: 1,
          emittedAt: Date.now(),
          type: 'session-start',
          payload: { reason: 'startup' }
        }),
        'utf8'
      )
      await expect.poll(() => events.map((event) => event.kind)).toEqual(['session.idle'])
      await handle.dispose()
      await prepared.dispose()
      await prepared.dispose()
      await expect(stat(extensionPath!)).rejects.toThrow()
      await expect(stat(dropDir!)).rejects.toThrow()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('uses the selected native WSL Pi and proves the atomic drop bridge before launch', async () => {
    const runDir = await mkdtemp(join(tmpdir(), 'vibing-pi-wsl-'))
    const calls: Array<{ file: string; args: readonly string[] }> = []
    const adapter = new PiObserverAdapter({
      runCommand: async (file, args) => {
        calls.push({ file, args })
        if (args.some((arg) => arg.includes('--version'))) {
          return { code: 0, stdout: '0.80.3\n' }
        }
        if (args.includes('wslpath')) {
          return { code: 0, stdout: '/mnt/c/vibing-pi-run\n' }
        }
        const nonce = args.at(-1)
        if (args.includes('vibing-pi-probe') && nonce) {
          await writeFile(join(runDir, 'pi-drop', `${nonce}.probe`), nonce)
          return { code: 0, stdout: '' }
        }
        return { code: 1, stdout: '' }
      }
    })
    try {
      const prepared = await adapter.prepare({
        sessionId: 'session-wsl',
        adapterId: 'pi',
        platform: 'win32',
        workspace: 'C:/workspace',
        args: [],
        runDir,
        installation: {
          id: 'pi:wsl:ubuntu',
          definitionId: 'pi',
          runtime: { kind: 'wsl', distro: 'Ubuntu-22.04' },
          resolvedExecutable:
            '/home/jesse/.local/share/pi-node/node-v22.22.3-linux-x64/bin/pi',
          detectedVia: 'path',
          verification: 'verified'
        }
      })

      expect(calls[0]).toEqual({
        file: 'wsl.exe',
        args: [
          '--distribution',
          'Ubuntu-22.04',
          '--exec',
          '/bin/sh',
          '-lc',
          'p="$1"; PATH="$(dirname "$p"):$PATH" exec "$p" --version',
          'vibing-pi-version',
          '/home/jesse/.local/share/pi-node/node-v22.22.3-linux-x64/bin/pi'
        ]
      })
      expect(calls.some((call) => call.args.includes('vibing-pi-probe'))).toBe(
        true
      )
      expect(prepared.launch.prependArgs).toEqual([
        '--extension',
        '/mnt/c/vibing-pi-run/pi-observer.ts'
      ])
      expect(prepared.launch.env?.VIBING_PI_DROP_DIR).toBe(
        '/mnt/c/vibing-pi-run/pi-drop'
      )
      expect(
        await readdir(join(runDir, 'pi-drop'))
      ).not.toEqual(expect.arrayContaining([expect.stringMatching(/\.probe$/)]))
      await prepared.dispose()
    } finally {
      await rm(runDir, { recursive: true, force: true })
    }
  })

  test('degrades honestly and removes prepared files when the WSL drop bridge is unavailable', async () => {
    const runDir = await mkdtemp(join(tmpdir(), 'vibing-pi-wsl-degraded-'))
    const adapter = new PiObserverAdapter({
      runCommand: async (_file, args) =>
        args.some((arg) => arg.includes('--version'))
          ? { code: 0, stdout: '0.80.3\n' }
          : { code: 1, stdout: '' }
    })
    try {
      const prepared = await adapter.prepare({
        sessionId: 'session-wsl-degraded',
        adapterId: 'pi',
        platform: 'win32',
        workspace: '',
        args: [],
        runDir,
        installation: {
          id: 'pi:wsl:degraded',
          definitionId: 'pi',
          runtime: { kind: 'wsl', distro: 'Ubuntu-22.04' },
          resolvedExecutable: '/home/jesse/bin/pi',
          detectedVia: 'path',
          verification: 'verified'
        }
      })
      expect(prepared.launch).toEqual({})
      expect(prepared.capabilities?.thinking).toBe('none')
      const events: AdapterEvent[] = []
      await prepared.attach(
        {
          sessionId: 'session-wsl-degraded',
          installationId: 'pi:wsl:degraded',
          adapterId: 'pi',
          ptyId: 'pty-degraded',
          runDir,
          cols: 80,
          rows: 24
        },
        (event) => events.push(event)
      )
      expect(events).toContainEqual(
        expect.objectContaining({
          kind: 'observer.degraded',
          payload: expect.objectContaining({
            reason: 'pi-wsl-drop-unavailable'
          })
        })
      )
      expect(await readdir(runDir)).toEqual([])
    } finally {
      await rm(runDir, { recursive: true, force: true })
    }
  })

  test('uses the same direct host extension path on Linux and macOS code paths', async () => {
    for (const platform of ['linux', 'darwin'] as const) {
      const runDir = await mkdtemp(join(tmpdir(), `vibing-pi-${platform}-`))
      const calls: Array<{ file: string; args: readonly string[] }> = []
      const adapter = new PiObserverAdapter({
        runCommand: async (file, args) => {
          calls.push({ file, args })
          return { code: 0, stdout: '0.82.1\n' }
        }
      })
      try {
        const prepared = await adapter.prepare({
          sessionId: `session-${platform}`,
          adapterId: 'pi',
          platform,
          workspace: '',
          args: [],
          runDir,
          installation: {
            id: `pi:${platform}`,
            definitionId: 'pi',
            runtime: {
              kind: 'host',
              platform: platform === 'darwin' ? 'macos' : 'linux'
            },
            resolvedExecutable: '/usr/local/bin/pi',
            detectedVia: 'path',
            verification: 'verified'
          }
        })
        expect(calls[0]).toEqual({
          file: '/usr/local/bin/pi',
          args: ['--version']
        })
        expect(prepared.launch.prependArgs?.[0]).toBe('--extension')
        expect(prepared.launch.prependArgs?.[1]).toBe(
          join(runDir, 'pi-observer.ts')
        )
        await prepared.dispose()
      } finally {
        await rm(runDir, { recursive: true, force: true })
      }
    }
  })
})
