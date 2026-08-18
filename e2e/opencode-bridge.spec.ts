import { createServer } from 'node:http'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import {
  extractLastClosedTurn,
  extractSinceCursor,
  parseOpenCodeMessages
} from '../electron/agents/adapters/opencode/OpenCodeMessages'
import { OpenCodeEventProjector } from '../electron/agents/adapters/opencode/OpenCodeEventProjector'
import { submitOpenCodePrompt } from '../electron/agents/adapters/opencode/OpenCodePrompt'
import {
  answerOpenCodeQuestion,
  listOpenCodeQuestions,
  rejectOpenCodeQuestion,
  respondOpenCodePermission,
  setOpenCodeAgent,
  setOpenCodeTitle
} from '../electron/agents/adapters/opencode/OpenCodeControl'
import {
  HostOpenCodeTransport,
  OpenCodeTransportError
} from '../electron/agents/adapters/opencode/OpenCodeTransport'
import type {
  AgentSessionPhase,
  AgentSessionRecord
} from '../electron/agents/AgentSessionRuntime'
import type { ObserverControl } from '../electron/agents/adapters/types'
import { BridgeServer } from '../electron/bridge/BridgeServer'
import { truncateDelta } from '../electron/bridge/delta'
import { parseOpenCodeModelsOutput } from '../electron/bridge/models'
import {
  OpenCodeControlPlane,
  type ControlPlaneDiscovery,
  type ControlPlaneRuntime
} from '../electron/bridge/OpenCodeControlPlane'
import { BridgeStateStore } from '../electron/bridge/state'
import { runHrackCli } from '../electron/cli/hrackCli'
import { parseHrackCli } from '../electron/cli/parseHrackCli'
import type { AgentSessionProjection } from '../shared/agent-events'
import type {
  BridgeLaunchRequest,
  CliInstallation,
  CliScanReport
} from '../shared/ipc-contract'
import { createInitialAgentProjection } from '../electron/agents/AgentEventReducer'
import { OPENCODE_CAPABILITIES } from '../electron/agents/adapters/opencode/types'

const hostInstall = (id: string): CliInstallation => ({
  id,
  definitionId: 'opencode',
  runtime: { kind: 'host', platform: 'windows' },
  resolvedExecutable: 'C:\\bin\\opencode.exe',
  detectedVia: 'path',
  verification: 'verified'
})

const wslInstall = (id: string, distro: string): CliInstallation => ({
  id,
  definitionId: 'opencode',
  runtime: { kind: 'wsl', distro },
  resolvedExecutable: '/home/u/.opencode/bin/opencode',
  detectedVia: 'path',
  verification: 'verified'
})

function projection(
  overrides: Partial<AgentSessionProjection> &
    Pick<AgentSessionProjection, 'sessionId' | 'terminalId' | 'installationId'>
): AgentSessionProjection {
  return {
    ...createInitialAgentProjection({
      sessionId: overrides.sessionId,
      terminalId: overrides.terminalId,
      installationId: overrides.installationId,
      adapterId: 'opencode',
      name: 'OpenCode',
      capabilities: OPENCODE_CAPABILITIES,
      lastActivityAt: 1
    }),
    ...overrides
  }
}

function record(
  overrides: Partial<AgentSessionRecord> &
    Pick<AgentSessionRecord, 'sessionId' | 'terminalId' | 'installationId'>
): AgentSessionRecord {
  const proj =
    overrides.projection ??
    projection({
      sessionId: overrides.sessionId,
      terminalId: overrides.terminalId,
      installationId: overrides.installationId
    })
  return {
    sessionId: overrides.sessionId,
    terminalId: overrides.terminalId,
    installationId: overrides.installationId,
    adapterId: 'opencode',
    name: 'OpenCode',
    workspace: 'C:\\work',
    runtime: { kind: 'host', platform: 'windows' },
    model: 'anthropic/claude-sonnet-4-5',
    agent: 'build',
    projection: proj,
    ...overrides
  }
}

class FakeRuntime implements ControlPlaneRuntime {
  records = new Map<string, AgentSessionRecord>()
  control: ObserverControl | undefined
  listeners = new Set<
    (item: AgentSessionRecord, phase: AgentSessionPhase) => void
  >()

  getRecord(sessionId: string): AgentSessionRecord | null {
    return this.records.get(sessionId) ?? null
  }

  listRecords(): AgentSessionRecord[] {
    return [...this.records.values()]
  }

  subscribe(
    listener: (item: AgentSessionRecord, phase: AgentSessionPhase) => void
  ): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  observerControl(): ObserverControl | undefined {
    return this.control
  }

  rename(sessionId: string, rawName: string): AgentSessionRecord | null {
    const item = this.records.get(sessionId)
    const name = rawName.trim().slice(0, 128)
    if (!item || !name) return null
    const next = {
      ...item,
      name,
      projection: { ...item.projection, name }
    }
    this.upsert(next)
    return next
  }

  setAgent(sessionId: string, agent: 'plan' | 'build'): void {
    const item = this.records.get(sessionId)
    if (!item) return
    this.upsert({ ...item, agent })
  }

  upsert(item: AgentSessionRecord, phase: AgentSessionPhase = 'updated'): void {
    this.records.set(item.sessionId, item)
    for (const listener of this.listeners) listener(item, phase)
  }

  async stop(sessionId: string): Promise<void> {
    const item = this.records.get(sessionId)
    if (!item) return
    this.records.delete(sessionId)
    for (const listener of this.listeners) listener(item, 'finalized')
  }
}

function scanOf(installations: CliInstallation[]): CliScanReport {
  return {
    startedAt: 1,
    finishedAt: 2,
    launchable: [
      {
        definition: {
          id: 'opencode',
          adapterId: 'opencode',
          displayName: 'OpenCode',
          hint: '',
          iconId: 'opencode'
        },
        installations
      }
    ],
    runtimeErrors: []
  }
}

function discovery(options: {
  installations: CliInstallation[]
  modelsStdout?: string
  timedOut?: boolean
  code?: number | null
}): ControlPlaneDiscovery {
  return {
    async scan() {
      return scanOf(options.installations)
    },
    async resolveInstallation(id) {
      return options.installations.find((item) => item.id === id) ?? null
    },
    async resolveWorkspace(_id, workspace) {
      return workspace
    },
    async runInstallationCommand() {
      return {
        stdout: options.modelsStdout ?? 'anthropic/claude-sonnet-4-5\n',
        stderr: '',
        timedOut: Boolean(options.timedOut),
        code: options.code ?? 0
      }
    }
  }
}

function planeHarness(options: {
  installations?: CliInstallation[]
  modelsStdout?: string
  runtime?: FakeRuntime
  windowError?: string
}) {
  const runtime = options.runtime ?? new FakeRuntime()
  const launched: BridgeLaunchRequest[] = []
  const dir = mkdtempSync(join(tmpdir(), 'hrack-bridge-'))
  const plane = new OpenCodeControlPlane({
    discovery: discovery({
      installations: options.installations ?? [hostInstall('opencode:win')],
      modelsStdout: options.modelsStdout
    }),
    runtime,
    state: new BridgeStateStore(join(dir, 'bridge-state.json')),
    requireForegroundWindow: () => {
      if (options.windowError) throw new Error(options.windowError)
    },
    launchVisible: async (request) => {
      launched.push(request)
      runtime.upsert(
        record({
          sessionId: 'sess-1',
          terminalId: request.terminalId,
          installationId: request.selection.installationId,
          name: request.name,
          workspace: request.workspace,
          model:
            request.selection.args[
              request.selection.args.indexOf('-m') + 1
            ],
          agent:
            request.selection.args[
              request.selection.args.indexOf('--agent') + 1
            ] === 'plan'
              ? 'plan'
              : 'build'
        })
      )
      return null
    }
  })
  return { plane, runtime, launched, dispose: () => plane.dispose() }
}

test.describe('OpenCode bridge P1', () => {
  test('parses the P1 CLI surface', () => {
    expect(parseHrackCli(['opencode', 'models', '--installation', 'oc:win'])).toEqual({
      kind: 'request',
      method: 'opencode.models',
      params: { installationId: 'oc:win' }
    })
    expect(
      parseHrackCli([
        'opencode',
        'create',
        '--workspace',
        'C:\\repo',
        '--model',
        'anthropic/claude-sonnet-4-5',
        '--agent',
        'plan',
        '--name',
        '补测试'
      ])
    ).toEqual({
      kind: 'request',
      method: 'opencode.create',
      params: {
        workspace: 'C:\\repo',
        model: 'anthropic/claude-sonnet-4-5',
        agent: 'plan',
        name: '补测试'
      }
    })
    expect(parseHrackCli(['sessions'])).toEqual({
      kind: 'request',
      method: 'sessions.list',
      params: {}
    })
    expect(parseHrackCli(['session', 'send', 'sess-1', 'keep', 'going'])).toEqual({
      kind: 'request',
      method: 'session.send',
      params: { sessionId: 'sess-1', text: 'keep going' }
    })
    expect(parseHrackCli(['session', 'watch', 'sess-1'])).toEqual({
      kind: 'request',
      method: 'session.watch',
      params: { sessionId: 'sess-1' },
      watch: true
    })
    expect(parseHrackCli(['session', 'close', 'sess-1'])).toEqual({
      kind: 'request',
      method: 'session.close',
      params: { sessionId: 'sess-1' }
    })
    expect(parseHrackCli(['session', 'delete', 'sess-1'])).toEqual({
      kind: 'request',
      method: 'session.close',
      params: { sessionId: 'sess-1' }
    })
    expect(parseHrackCli(['session', 'rename', 'sess-1', 'New', 'title'])).toEqual({
      kind: 'request',
      method: 'session.rename',
      params: { sessionId: 'sess-1', name: 'New title' }
    })
    expect(parseHrackCli(['session', 'mode', 'sess-1', 'plan'])).toEqual({
      kind: 'request',
      method: 'session.mode',
      params: { sessionId: 'sess-1', agent: 'plan' }
    })
    expect(
      parseHrackCli(['session', 'approve', 'sess-1', 'req-1', '--remember'])
    ).toEqual({
      kind: 'request',
      method: 'session.approve',
      params: { sessionId: 'sess-1', requestId: 'req-1', remember: true }
    })
    expect(parseHrackCli(['session', 'deny', 'sess-1', 'req-1'])).toEqual({
      kind: 'request',
      method: 'session.deny',
      params: { sessionId: 'sess-1', requestId: 'req-1' }
    })
    expect(parseHrackCli(['session', 'questions', 'sess-1'])).toEqual({
      kind: 'request',
      method: 'session.questions',
      params: { sessionId: 'sess-1' }
    })
    expect(
      parseHrackCli([
        'session',
        'answer',
        'sess-1',
        'req-1',
        '--json',
        '{"answers":[["a"]]}'
      ])
    ).toEqual({
      kind: 'request',
      method: 'session.answer',
      params: {
        sessionId: 'sess-1',
        requestId: 'req-1',
        json: '{"answers":[["a"]]}'
      }
    })
    expect(
      parseHrackCli(['session', 'reject-question', 'sess-1', 'req-1'])
    ).toEqual({
      kind: 'request',
      method: 'session.reject-question',
      params: { sessionId: 'sess-1', requestId: 'req-1' }
    })
    expect(
      parseHrackCli(['session', 'wait', 'sess-1', '--until', 'turn'])
    ).toEqual({
      kind: 'request',
      method: 'session.wait',
      params: { sessionId: 'sess-1', until: 'turn' }
    })
  })

  test('parses provider/model lines and treats empty output as success', () => {
    expect(
      parseOpenCodeModelsOutput(
        'Models\nanthropic/claude-sonnet-4-5\nopenai/gpt-4.1\nanthropic/claude-sonnet-4-5\n'
      )
    ).toEqual([
      {
        id: 'anthropic/claude-sonnet-4-5',
        provider: 'anthropic',
        model: 'claude-sonnet-4-5'
      },
      { id: 'openai/gpt-4.1', provider: 'openai', model: 'gpt-4.1' }
    ])
    expect(parseOpenCodeModelsOutput('')).toEqual([])
  })

  test('models includes runtime and surfaces timeouts', async () => {
    const ok = planeHarness({})
    await expect(ok.plane.models({})).resolves.toMatchObject({
      installationId: 'opencode:win',
      runtime: { kind: 'host', platform: 'windows' },
      models: [{ id: 'anthropic/claude-sonnet-4-5' }]
    })
    ok.dispose()

    const timed = new OpenCodeControlPlane({
      discovery: discovery({
        installations: [hostInstall('opencode:win')],
        timedOut: true
      }),
      runtime: new FakeRuntime(),
      state: new BridgeStateStore(join(mkdtempSync(join(tmpdir(), 'hrack-bridge-')), 's.json')),
      requireForegroundWindow: () => {},
      launchVisible: async () => 'unused'
    })
    await expect(timed.models({})).rejects.toThrow(/timed out/)
    timed.dispose()
  })

  test('create synthesizes workspace, -m and --agent and opens a visible tab', async () => {
    const { plane, launched, dispose } = planeHarness({})
    const created = await plane.create({
      workspace: 'C:\\repo',
      model: 'anthropic/claude-sonnet-4-5',
      agent: 'plan',
      name: '补测试'
    })
    expect(launched).toHaveLength(1)
    expect(launched[0].selection.args).toEqual([
      'C:\\repo',
      '-m',
      'anthropic/claude-sonnet-4-5',
      '--agent',
      'plan'
    ])
    expect(created).toMatchObject({
      sessionId: 'sess-1',
      name: '补测试',
      model: 'anthropic/claude-sonnet-4-5',
      agent: 'plan',
      workspace: 'C:\\repo',
      installationId: 'opencode:win',
      runtime: { kind: 'host', platform: 'windows' }
    })
    expect(created.terminalId).toBe(launched[0].terminalId)
    dispose()
  })

  test('refuses to guess among Windows and WSL installations', async () => {
    const { plane, dispose } = planeHarness({
      installations: [
        hostInstall('opencode:win'),
        wslInstall('opencode:wsl', 'Ubuntu-22.04')
      ]
    })
    await expect(
      plane.create({
        workspace: 'C:\\repo',
        model: 'anthropic/claude-sonnet-4-5'
      })
    ).rejects.toThrow(/Multiple OpenCode installations/)
    dispose()
  })

  test('send accepts idle and rejects working / needs-you', async () => {
    const runtime = new FakeRuntime()
    const sent: Array<{ text: string; agent?: string }> = []
    runtime.control = {
      async submitPrompt(text, agent) {
        sent.push({ text, agent })
      },
      async snapshotMessages() {
        return []
      }
    }
    runtime.upsert(
      record({
        sessionId: 'sess-1',
        terminalId: 'term-1',
        installationId: 'opencode:win'
      })
    )
    const { plane, dispose } = planeHarness({ runtime })
    await expect(
      plane.send({ sessionId: 'sess-1', text: 'hello' })
    ).resolves.toEqual({ accepted: true })
    expect(sent).toEqual([{ text: 'hello', agent: undefined }])

    runtime.upsert(
      record({
        sessionId: 'sess-1',
        terminalId: 'term-1',
        installationId: 'opencode:win',
        projection: projection({
          sessionId: 'sess-1',
          terminalId: 'term-1',
          installationId: 'opencode:win',
          status: 'working'
        })
      })
    )
    await expect(
      plane.send({ sessionId: 'sess-1', text: 'again' })
    ).rejects.toThrow(/working/)

    runtime.upsert(
      record({
        sessionId: 'sess-1',
        terminalId: 'term-1',
        installationId: 'opencode:win',
        projection: projection({
          sessionId: 'sess-1',
          terminalId: 'term-1',
          installationId: 'opencode:win',
          status: 'needs-you'
        })
      })
    )
    await expect(
      plane.send({ sessionId: 'sess-1', text: 'again' })
    ).rejects.toThrow(/needs-you/)
    dispose()
  })

  test('watch stays silent on working and emits one snapshot turn', async () => {
    const runtime = new FakeRuntime()
    let snapshot: unknown[] = []
    runtime.control = {
      async submitPrompt() {},
      async snapshotMessages() {
        return snapshot
      }
    }
    const item = record({
      sessionId: 'sess-1',
      terminalId: 'term-1',
      installationId: 'opencode:win'
    })
    runtime.upsert(item)
    const { plane, dispose } = planeHarness({ runtime })
    const events: Array<{ type: string; text?: string; tools?: number }> = []
    const stop = plane.watch(
      'sess-1',
      (event) => {
        events.push({
          type: event.type,
          text: event.delta.text,
          tools: event.delta.tools.length
        })
      },
      () => {}
    )
    await new Promise((resolve) => setTimeout(resolve, 20))
    snapshot = [
      {
        info: { id: 'u1', role: 'user' },
        parts: [{ type: 'text', text: 'do it' }]
      },
      {
        info: { id: 'a1', role: 'assistant' },
        parts: [
          { type: 'reasoning', text: 'secret-thought' },
          { type: 'text', id: 't1', text: 'I ran the suite.' },
          {
            type: 'tool',
            callID: 'c1',
            tool: 'bash',
            state: {
              status: 'completed',
              input: { command: 'npm test' },
              output: { stdout: 'ok' }
            }
          },
          {
            type: 'tool',
            callID: 'c2',
            tool: 'read',
            state: {
              status: 'completed',
              input: { path: 'a.ts' },
              output: { content: 'export {}' }
            }
          }
        ]
      }
    ]
    runtime.upsert({
      ...item,
      projection: { ...item.projection, status: 'working' }
    })
    runtime.upsert({
      ...item,
      projection: { ...item.projection, status: 'working', detail: 'thinking' }
    })
    runtime.upsert({
      ...item,
      projection: { ...item.projection, status: 'done', statusConfidence: 'high' }
    })
    await expect.poll(() => events.map((event) => event.type)).toEqual(['turn'])
    expect(events[0].text).toBe('I ran the suite.')
    expect(events[0].tools).toBe(2)
    expect(JSON.stringify(events)).not.toContain('secret-thought')
    const pulled = await plane.turn({ sessionId: 'sess-1' })
    expect(pulled.delta.text).toBe('I ran the suite.')
    expect(pulled.runtime).toEqual({ kind: 'host', platform: 'windows' })
    stop()
    dispose()
  })

  test('blocked permission and question fire once and keep prior assistant text', async () => {
    const runtime = new FakeRuntime()
    let snapshot: unknown[] = []
    runtime.control = {
      async submitPrompt() {},
      async snapshotMessages() {
        return snapshot
      }
    }
    const base = record({
      sessionId: 'sess-1',
      terminalId: 'term-1',
      installationId: 'opencode:win'
    })
    runtime.upsert(base)
    const { plane, dispose } = planeHarness({ runtime })
    const events: Array<{ type: string; kind?: string; requestId?: string; text?: string }> =
      []
    plane.watch(
      'sess-1',
      (event) => {
        events.push({
          type: event.type,
          kind: event.blocked?.kind,
          requestId: event.blocked?.requestId,
          text: event.delta.text
        })
      },
      () => {}
    )
    await new Promise((resolve) => setTimeout(resolve, 20))
    snapshot = [
      {
        info: { id: 'u1', role: 'user' },
        parts: [{ type: 'text', text: 'edit it' }]
      },
      {
        info: { id: 'a1', role: 'assistant' },
        parts: [{ type: 'text', id: 't1', text: 'I will patch the file.' }]
      }
    ]
    const approvalId = 'opencode:native:approval:p1'
    runtime.upsert({
      ...base,
      projection: {
        ...base.projection,
        status: 'needs-you',
        pendingAttentionCount: 1,
        correlation: {
          ...base.projection.correlation,
          pendingApprovals: {
            [approvalId]: {
              category: 'file-change',
              summary: 'Edit file',
              turnId: 't'
            }
          }
        }
      }
    })
    runtime.upsert({
      ...base,
      projection: {
        ...base.projection,
        status: 'needs-you',
        pendingAttentionCount: 1,
        correlation: {
          ...base.projection.correlation,
          pendingApprovals: {
            [approvalId]: {
              category: 'file-change',
              summary: 'Edit file',
              turnId: 't'
            }
          }
        }
      }
    })
    await expect.poll(() => events.length).toBe(1)
    expect(events[0]).toMatchObject({
      type: 'blocked',
      kind: 'permission',
      requestId: approvalId,
      text: 'I will patch the file.'
    })

    const questionId = 'opencode:native:input:q1'
    runtime.upsert({
      ...base,
      projection: {
        ...base.projection,
        status: 'working',
        pendingAttentionCount: 0
      }
    })
    runtime.upsert({
      ...base,
      projection: {
        ...base.projection,
        status: 'needs-you',
        pendingAttentionCount: 1,
        correlation: {
          ...base.projection.correlation,
          pendingApprovals: {},
          pendingInputs: {
            [questionId]: { prompt: 'Which file?', turnId: 't' }
          }
        }
      }
    })
    await expect.poll(() => events.length).toBe(2)
    expect(events[1]).toMatchObject({
      type: 'blocked',
      kind: 'question',
      requestId: questionId
    })
    dispose()
  })

  test('rename updates the sidebar and OpenCode title, and keeps HRack name on title failure', async () => {
    const runtime = new FakeRuntime()
    const titles: string[] = []
    runtime.control = {
      async submitPrompt() {},
      async snapshotMessages() {
        return []
      },
      async setTitle(title) {
        titles.push(title)
      }
    }
    runtime.upsert(
      record({
        sessionId: 'sess-1',
        terminalId: 'term-1',
        installationId: 'opencode:win'
      })
    )
    const { plane, dispose } = planeHarness({ runtime })
    await expect(
      plane.handle('session.rename', { sessionId: 'sess-1', name: '补测试' })
    ).resolves.toEqual({
      kind: 'json',
      value: { sessionId: 'sess-1', name: '补测试', titleUpdated: true }
    })
    expect(runtime.getRecord('sess-1')?.name).toBe('补测试')
    expect(titles).toEqual(['补测试'])

    runtime.control.setTitle = async () => {
      throw new Error('OpenCode HTTP 500')
    }
    await expect(
      plane.handle('session.rename', { sessionId: 'sess-1', name: 'Still HRack' })
    ).resolves.toEqual({
      kind: 'json',
      value: {
        sessionId: 'sess-1',
        name: 'Still HRack',
        titleUpdated: false,
        error: { message: 'OpenCode HTTP 500' }
      }
    })
    expect(runtime.getRecord('sess-1')?.name).toBe('Still HRack')
    dispose()
  })

  test('mode writes the OpenCode agent and refuses to keep only a HRack shadow', async () => {
    const runtime = new FakeRuntime()
    const seen: string[] = []
    runtime.control = {
      async submitPrompt() {},
      async snapshotMessages() {
        return []
      },
      async setAgent(agent) {
        seen.push(agent)
      }
    }
    runtime.upsert(
      record({
        sessionId: 'sess-1',
        terminalId: 'term-1',
        installationId: 'opencode:win',
        agent: 'build'
      })
    )
    const { plane, dispose } = planeHarness({ runtime })
    await expect(
      plane.handle('session.mode', { sessionId: 'sess-1', agent: 'plan' })
    ).resolves.toEqual({
      kind: 'json',
      value: { sessionId: 'sess-1', agent: 'plan' }
    })
    expect(seen).toEqual(['plan'])
    expect(runtime.getRecord('sess-1')?.agent).toBe('plan')

    runtime.control.setAgent = async () => {
      throw new Error('no agent write API')
    }
    await expect(
      plane.handle('session.mode', { sessionId: 'sess-1', agent: 'build' })
    ).rejects.toThrow(/no agent write API/)
    expect(runtime.getRecord('sess-1')?.agent).toBe('plan')
    dispose()
  })

  test('approve maps to once by default and always only when remember is explicit', async () => {
    const runtime = new FakeRuntime()
    const replies: Array<{ id: string; response: string }> = []
    runtime.control = {
      async submitPrompt() {},
      async snapshotMessages() {
        return []
      },
      async respondPermission(nativeId, response) {
        replies.push({ id: nativeId, response })
      }
    }
    const requestId = 'opencode:native-1:approval:perm-9'
    runtime.upsert(
      record({
        sessionId: 'sess-1',
        terminalId: 'term-1',
        installationId: 'opencode:win',
        projection: projection({
          sessionId: 'sess-1',
          terminalId: 'term-1',
          installationId: 'opencode:win',
          status: 'needs-you',
          pendingAttentionCount: 1,
          correlation: {
            ...projection({
              sessionId: 'sess-1',
              terminalId: 'term-1',
              installationId: 'opencode:win'
            }).correlation,
            pendingApprovals: {
              [requestId]: {
                category: 'file-change',
                summary: 'Edit file',
                turnId: 't'
              }
            }
          }
        })
      })
    )
    const { plane, dispose } = planeHarness({ runtime })
    await expect(
      plane.handle('session.approve', { sessionId: 'sess-1', requestId })
    ).resolves.toEqual({
      kind: 'json',
      value: {
        sessionId: 'sess-1',
        requestId,
        decision: 'approved',
        remember: false
      }
    })
    expect(replies).toEqual([{ id: 'perm-9', response: 'once' }])

    runtime.upsert({
      ...runtime.getRecord('sess-1')!,
      projection: {
        ...runtime.getRecord('sess-1')!.projection,
        correlation: {
          ...runtime.getRecord('sess-1')!.projection.correlation,
          pendingApprovals: {
            [requestId]: {
              category: 'file-change',
              summary: 'Edit file',
              turnId: 't'
            }
          }
        }
      }
    })
    await expect(
      plane.handle('session.approve', {
        sessionId: 'sess-1',
        requestId,
        remember: true
      })
    ).resolves.toMatchObject({
      kind: 'json',
      value: { decision: 'approved', remember: true }
    })
    expect(replies[1]).toEqual({ id: 'perm-9', response: 'always' })
    dispose()
  })

  test('deny replies reject and a later approve is idempotent once TUI already decided', async () => {
    const runtime = new FakeRuntime()
    const replies: string[] = []
    runtime.control = {
      async submitPrompt() {},
      async snapshotMessages() {
        return []
      },
      async respondPermission(_id, response) {
        replies.push(response)
      }
    }
    const requestId = 'opencode:native-1:approval:perm-9'
    const base = record({
      sessionId: 'sess-1',
      terminalId: 'term-1',
      installationId: 'opencode:win',
      projection: projection({
        sessionId: 'sess-1',
        terminalId: 'term-1',
        installationId: 'opencode:win',
        status: 'needs-you',
        pendingAttentionCount: 1,
        correlation: {
          ...projection({
            sessionId: 'sess-1',
            terminalId: 'term-1',
            installationId: 'opencode:win'
          }).correlation,
          pendingApprovals: {
            [requestId]: {
              category: 'file-change',
              summary: 'Edit file',
              turnId: 't'
            }
          }
        }
      })
    })
    runtime.upsert(base)
    const { plane, dispose } = planeHarness({ runtime })
    await expect(
      plane.handle('session.deny', { sessionId: 'sess-1', requestId })
    ).resolves.toMatchObject({
      kind: 'json',
      value: { decision: 'denied', remember: false }
    })
    expect(replies).toEqual(['reject'])

    runtime.upsert(
      record({
        sessionId: 'sess-1',
        terminalId: 'term-1',
        installationId: 'opencode:win'
      })
    )
    await expect(
      plane.handle('session.approve', { sessionId: 'sess-1', requestId })
    ).resolves.toEqual({
      kind: 'json',
      value: {
        sessionId: 'sess-1',
        requestId,
        decision: 'approved',
        already: true,
        remember: false
      }
    })
    expect(replies).toEqual(['reject'])
    dispose()
  })

  test('questions list and answer/reject forward the official payload', async () => {
    const runtime = new FakeRuntime()
    const answers: unknown[] = []
    const rejected: string[] = []
    runtime.control = {
      async submitPrompt() {},
      async snapshotMessages() {
        return []
      },
      async listQuestions() {
        return [
          {
            id: 'q1',
            sessionID: 'native-1',
            questions: [
              {
                header: 'Which file?',
                question: 'Pick a file',
                options: [{ label: 'a.ts' }]
              }
            ]
          }
        ]
      },
      async answerQuestion(nativeId, payload) {
        answers.push({ nativeId, payload })
      },
      async rejectQuestion(nativeId) {
        rejected.push(nativeId)
      }
    }
    const requestId = 'opencode:native-1:input:q1'
    runtime.upsert(
      record({
        sessionId: 'sess-1',
        terminalId: 'term-1',
        installationId: 'opencode:win',
        projection: projection({
          sessionId: 'sess-1',
          terminalId: 'term-1',
          installationId: 'opencode:win',
          status: 'needs-you',
          pendingAttentionCount: 1,
          correlation: {
            ...projection({
              sessionId: 'sess-1',
              terminalId: 'term-1',
              installationId: 'opencode:win'
            }).correlation,
            pendingInputs: {
              [requestId]: { prompt: 'Which file?', turnId: 't' }
            }
          }
        })
      })
    )
    const { plane, dispose } = planeHarness({ runtime })
    await expect(
      plane.handle('session.questions', { sessionId: 'sess-1' })
    ).resolves.toEqual({
      kind: 'json',
      value: {
        sessionId: 'sess-1',
        questions: [
          expect.objectContaining({
            requestId,
            summary: 'Which file?'
          })
        ]
      }
    })
    await expect(
      plane.handle('session.answer', {
        sessionId: 'sess-1',
        requestId,
        json: '{"answers":[["a.ts"]]}'
      })
    ).resolves.toMatchObject({
      kind: 'json',
      value: { sessionId: 'sess-1', requestId, answered: true }
    })
    expect(answers).toEqual([
      { nativeId: 'q1', payload: { answers: [['a.ts']] } }
    ])
    await expect(
      plane.handle('session.reject-question', { sessionId: 'sess-1', requestId })
    ).resolves.toMatchObject({
      kind: 'json',
      value: { rejected: true }
    })
    expect(rejected).toEqual(['q1'])
    dispose()
  })

  test('wait returns the first matching watch event then completes', async () => {
    const runtime = new FakeRuntime()
    let snapshot: unknown[] = []
    runtime.control = {
      async submitPrompt() {},
      async snapshotMessages() {
        return snapshot
      }
    }
    const item = record({
      sessionId: 'sess-1',
      terminalId: 'term-1',
      installationId: 'opencode:win'
    })
    runtime.upsert(item)
    const { plane, dispose } = planeHarness({ runtime })
    const waiting = plane.handle('session.wait', {
      sessionId: 'sess-1',
      until: 'turn'
    })
    await new Promise((resolve) => setTimeout(resolve, 20))
    snapshot = [
      {
        info: { id: 'u1', role: 'user' },
        parts: [{ type: 'text', text: 'go' }]
      },
      {
        info: { id: 'a1', role: 'assistant' },
        parts: [{ type: 'text', id: 't1', text: 'done' }]
      }
    ]
    runtime.upsert({
      ...item,
      projection: { ...item.projection, status: 'working' }
    })
    runtime.upsert({
      ...item,
      projection: {
        ...item.projection,
        status: 'done',
        statusConfidence: 'high'
      }
    })
    await expect(waiting).resolves.toEqual({
      kind: 'json',
      value: expect.objectContaining({
        type: 'turn',
        sessionId: 'sess-1',
        delta: expect.objectContaining({ text: 'done' })
      })
    })
    dispose()
  })

  test('wait does not treat an idle empty snapshot as a turn', async () => {
    const runtime = new FakeRuntime()
    let snapshot: unknown[] = []
    runtime.control = {
      async submitPrompt() {},
      async snapshotMessages() {
        return snapshot
      }
    }
    const item = record({
      sessionId: 'sess-1',
      terminalId: 'term-1',
      installationId: 'opencode:win',
      projection: projection({
        sessionId: 'sess-1',
        terminalId: 'term-1',
        installationId: 'opencode:win',
        status: 'working'
      })
    })
    runtime.upsert(item)
    const { plane, dispose } = planeHarness({ runtime })
    const waiting = plane.handle('session.wait', {
      sessionId: 'sess-1',
      until: 'turn'
    })
    runtime.upsert({
      ...item,
      projection: {
        ...item.projection,
        status: 'idle',
        statusConfidence: 'high'
      }
    })
    await new Promise((resolve) => setTimeout(resolve, 40))
    snapshot = [
      {
        info: { id: 'u1', role: 'user' },
        parts: [{ type: 'text', text: 'go' }]
      },
      {
        info: { id: 'a1', role: 'assistant' },
        parts: [{ type: 'text', id: 't1', text: 'pong' }]
      }
    ]
    runtime.upsert({
      ...item,
      projection: { ...item.projection, status: 'working' }
    })
    runtime.upsert({
      ...item,
      projection: {
        ...item.projection,
        status: 'done',
        statusConfidence: 'high'
      }
    })
    await expect(waiting).resolves.toEqual({
      kind: 'json',
      value: expect.objectContaining({
        type: 'turn',
        delta: expect.objectContaining({ text: 'pong' })
      })
    })
    dispose()
  })

  test('wait still sees a turn that finished while the subscriber was priming', async () => {
    const runtime = new FakeRuntime()
    const snapshot = [
      {
        info: { id: 'u1', role: 'user' },
        parts: [{ type: 'text', text: 'go' }]
      },
      {
        info: { id: 'a1', role: 'assistant' },
        parts: [{ type: 'text', id: 't1', text: 'pong' }]
      }
    ]
    runtime.control = {
      async submitPrompt() {},
      async snapshotMessages() {
        return snapshot
      }
    }
    const item = record({
      sessionId: 'sess-1',
      terminalId: 'term-1',
      installationId: 'opencode:win',
      projection: projection({
        sessionId: 'sess-1',
        terminalId: 'term-1',
        installationId: 'opencode:win',
        status: 'working'
      })
    })
    runtime.upsert(item)
    const { plane, dispose } = planeHarness({ runtime })
    const waiting = plane.handle('session.wait', {
      sessionId: 'sess-1',
      until: 'turn'
    })
    runtime.upsert({
      ...item,
      projection: {
        ...item.projection,
        status: 'idle',
        statusConfidence: 'high'
      }
    })
    await expect(waiting).resolves.toEqual({
      kind: 'json',
      value: expect.objectContaining({
        type: 'turn',
        delta: expect.objectContaining({ text: 'pong' })
      })
    })
    dispose()
  })

  test('CLI prints JSON and fails closed without HRack or token', async () => {
    const stdout: string[] = []
    const stderr: string[] = []
    const missing = await runHrackCli(['sessions'], {
      stdout: { write: (chunk) => stdout.push(chunk) },
      stderr: { write: (chunk) => stderr.push(chunk) },
      socketPath: join(tmpdir(), `hrack-missing-${Date.now()}.sock`),
      userDataDir: mkdtempSync(join(tmpdir(), 'hrack-empty-'))
    })
    expect(missing).toBe(2)
    expect(stderr.join('')).toMatch(/HRack is not running/)

    const dir = mkdtempSync(join(tmpdir(), 'hrack-token-'))
    writeFileSync(join(dir, 'bridge.token'), `${'ab'.repeat(32)}\n`)
    const { plane, runtime } = planeHarness({})
    runtime.upsert(
      record({
        sessionId: 'sess-1',
        terminalId: 'term-1',
        installationId: 'opencode:win'
      })
    )
    const server = new BridgeServer({
      userDataDir: dir,
      plane,
      socketPath:
        process.platform === 'win32'
          ? `\\\\.\\pipe\\hrack-bridge-test-${Date.now()}`
          : join(dir, 'bridge.sock')
    })
    const socketPath = await server.start()
    stdout.length = 0
    stderr.length = 0
    const denied = await runHrackCli(['sessions'], {
      stdout: { write: (chunk) => stdout.push(chunk) },
      stderr: { write: (chunk) => stderr.push(chunk) },
      socketPath,
      token: '00'.repeat(32),
      userDataDir: dir
    })
    expect(denied).toBe(2)
    expect(stdout.join('')).toMatch(/unauthorized|Invalid bridge token/)

    stdout.length = 0
    const renamed = await runHrackCli(['session', 'rename', 'sess-1', 'x'], {
      stdout: { write: (chunk) => stdout.push(chunk) },
      stderr: { write: (chunk) => stderr.push(chunk) },
      socketPath,
      userDataDir: dir
    })
    expect(renamed).toBe(0)
    expect(stdout.join('')).toMatch(/"name": "x"/)
    await server.stop()
    plane.dispose()
  })

  test('message snapshot prefers last closed turn and ignores reasoning', () => {
    const messages = parseOpenCodeMessages([
      {
        info: { id: 'u1', role: 'user' },
        parts: [{ type: 'text', text: 'hi' }]
      },
      {
        info: { id: 'a1', role: 'assistant' },
        parts: [
          { type: 'reasoning', text: 'hidden' },
          { type: 'text', id: 'p1', text: 'hello' },
          {
            type: 'tool',
            callID: 'c1',
            tool: 'bash',
            state: { status: 'completed', input: { command: 'ls' }, output: 'a' }
          }
        ]
      }
    ])
    const delta = extractLastClosedTurn(messages)
    expect(delta.text).toBe('hello')
    expect(delta.tools).toEqual([
      { name: 'bash', callId: 'c1', input: { command: 'ls' }, output: 'a' }
    ])
    expect(JSON.stringify(delta)).not.toContain('hidden')
    const first = extractSinceCursor(messages, undefined)
    const again = extractSinceCursor(messages, first.cursor)
    expect(again.delta.text).toBe('')
    expect(again.delta.tools).toEqual([])
  })

  test('truncates oversized deltas and keeps a request id out of band', () => {
    const huge = 'x'.repeat(80 * 1024)
    const delta = truncateDelta({
      text: huge,
      tools: Array.from({ length: 80 }, (_, index) => ({
        name: 'bash',
        callId: `c${index}`,
        input: { blob: 'y'.repeat(40 * 1024) }
      }))
    })
    expect(delta.truncated).toBe(true)
    expect(delta.tools.length).toBeLessThanOrEqual(64)
    expect(Buffer.byteLength(JSON.stringify(delta), 'utf8')).toBeLessThanOrEqual(
      256 * 1024
    )
  })

  test('projector locks writes to the current root native session', () => {
    const projector = new OpenCodeEventProjector()
    projector.project({
      type: 'session-created',
      nativeType: 'session.created',
      info: { id: 'root-1' }
    })
    projector.project({
      type: 'session-created',
      nativeType: 'session.created',
      info: { id: 'child-1', parentId: 'root-1' }
    })
    expect(projector.currentRootSessionId()).toBe('root-1')
    projector.project({
      type: 'session-created',
      nativeType: 'session.created',
      info: { id: 'root-2' }
    })
    expect(projector.currentRootSessionId()).toBe('root-2')
  })

  test('submit prefers TUI append/submit so the visible pane updates', async () => {
    const seen: string[] = []
    const transport = {
      async request(method: 'GET' | 'POST' | 'PATCH', path: string) {
        seen.push(`${method} ${path}`)
        return null
      }
    }
    await submitOpenCodePrompt(transport, async () => 'native-1', 'hello')
    expect(seen).toEqual([
      'POST /tui/clear-prompt',
      'POST /tui/append-prompt',
      'POST /tui/submit-prompt'
    ])
  })

  test('submit falls back to session prompt when TUI routes are missing', async () => {
    const seen: string[] = []
    const transport = {
      async request(method: 'GET' | 'POST' | 'PATCH', path: string) {
        seen.push(`${method} ${path}`)
        if (path.startsWith('/tui/')) {
          throw new OpenCodeTransportError('http-status', 'missing', 404)
        }
        return null
      }
    }
    await submitOpenCodePrompt(transport, async () => 'native-1', 'hello', 'plan')
    expect(seen).toEqual([
      'POST /tui/clear-prompt',
      'POST /session/native-1/prompt_async'
    ])
  })

  test('host transport POST/GET talk to the TUI loopback server', async () => {
    const seen: Array<{ method?: string; url?: string; body: string }> = []
    const server = createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (chunk) => chunks.push(chunk as Buffer))
      req.on('end', () => {
        seen.push({
          method: req.method,
          url: req.url,
          body: Buffer.concat(chunks).toString('utf8')
        })
        if (req.url === '/session/abc/prompt_async') {
          res.statusCode = 204
          res.end()
          return
        }
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify([{ info: { id: 'm1', role: 'assistant' }, parts: [] }]))
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    const port = address && typeof address === 'object' ? address.port : 0
    const transport = new HostOpenCodeTransport(`http://127.0.0.1:${port}`)
    await expect(
      transport.request('POST', '/session/abc/prompt_async', {
        parts: [{ type: 'text', text: 'hi' }]
      })
    ).resolves.toBeNull()
    await expect(transport.request('GET', '/session/abc/message')).resolves.toEqual([
      { info: { id: 'm1', role: 'assistant' }, parts: [] }
    ])
    expect(seen[0]).toMatchObject({
      method: 'POST',
      url: '/session/abc/prompt_async'
    })
    expect(seen[0].body).toContain('hi')
    await transport.dispose()
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    )
  })

  test('New Session UI was not given model or plan/build pickers', () => {
    const source = readFileSync(
      join(__dirname, '../src/app/NewSessionFlow.tsx'),
      'utf8'
    )
    expect(source).not.toMatch(/plan\s*\|\s*build|model picker|--agent|provider\/model/)
    expect(source).toContain('onLaunchCli')
  })

  test('close stops an OpenCode session and drops it from the list', async () => {
    const runtime = new FakeRuntime()
    runtime.upsert(
      record({
        sessionId: 'sess-1',
        terminalId: 'term-1',
        installationId: 'opencode:win'
      })
    )
    const { plane, dispose } = planeHarness({ runtime })
    await expect(plane.close({ sessionId: 'sess-1' })).resolves.toEqual({
      sessionId: 'sess-1',
      closed: true
    })
    await expect(plane.sessions()).resolves.toEqual([])
    await expect(plane.close({ sessionId: 'sess-1' })).rejects.toThrow(
      /not found/
    )
    dispose()
  })

  test('sessions lists only OpenCode records with runtime', async () => {
    const runtime = new FakeRuntime()
    runtime.upsert(
      record({
        sessionId: 'oc-1',
        terminalId: 't1',
        installationId: 'opencode:win'
      })
    )
    runtime.upsert({
      ...record({
        sessionId: 'codex-1',
        terminalId: 't2',
        installationId: 'codex:win'
      }),
      adapterId: 'codex'
    })
    const { plane, dispose } = planeHarness({ runtime })
    await expect(plane.sessions()).resolves.toEqual([
      expect.objectContaining({
        sessionId: 'oc-1',
        installationId: 'opencode:win',
        runtime: { kind: 'host', platform: 'windows' }
      })
    ])
    dispose()
  })

  test('title, permission and question helpers hit official OpenCode write paths', async () => {
    const seen: Array<{ method: string; path: string; body?: unknown }> = []
    const transport = {
      async request(method: 'GET' | 'POST' | 'PATCH', path: string, body?: unknown) {
        seen.push({ method, path, body })
        if (path === '/session/native-1') return { id: 'native-1', agent: 'plan' }
        if (path === '/question') {
          return [{ id: 'q1', sessionID: 'native-1', questions: [{ header: 'Pick' }] }]
        }
        return null
      }
    }
    await setOpenCodeTitle(transport, async () => 'native-1', '补测试')
    await respondOpenCodePermission(transport, async () => 'native-1', 'perm-9', 'once')
    await setOpenCodeAgent(transport, async () => 'native-1', 'plan')
    await expect(listOpenCodeQuestions(transport, async () => 'native-1')).resolves.toEqual([
      { id: 'q1', sessionID: 'native-1', questions: [{ header: 'Pick' }] }
    ])
    await answerOpenCodeQuestion(transport, async () => 'native-1', 'q1', {
      answers: [['a']]
    })
    await rejectOpenCodeQuestion(transport, async () => 'native-1', 'q1')
    expect(seen).toEqual(
      expect.arrayContaining([
        {
          method: 'PATCH',
          path: '/session/native-1',
          body: { title: '补测试' }
        },
        {
          method: 'POST',
          path: '/session/native-1/permissions/perm-9',
          body: { response: 'once' }
        },
        {
          method: 'POST',
          path: '/question/q1/reply',
          body: { answers: [['a']] }
        },
        {
          method: 'POST',
          path: '/question/q1/reject',
          body: undefined
        }
      ])
    )
    expect(
      seen.some(
        (item) =>
          item.path.includes('/agent') || item.path === '/tui/execute-command'
      )
    ).toBe(true)
  })

  test('question helpers skip SPA HTML and use /question routes', async () => {
    const seen: string[] = []
    const transport = {
      async request(method: 'GET' | 'POST' | 'PATCH', path: string, body?: unknown) {
        seen.push(`${method} ${path}`)
        if (path.startsWith('/session/')) {
          throw new OpenCodeTransportError(
            'not-api',
            'OpenCode returned HTML instead of an API payload',
            404
          )
        }
        if (path === '/question') {
          return [
            {
              id: 'q1',
              sessionID: 'native-1',
              questions: [{ header: 'fruit', question: 'Which fruit?' }]
            }
          ]
        }
        return body ?? true
      }
    }
    await expect(
      listOpenCodeQuestions(transport, async () => 'native-1')
    ).resolves.toEqual([
      {
        id: 'q1',
        sessionID: 'native-1',
        questions: [{ header: 'fruit', question: 'Which fruit?' }]
      }
    ])
    await answerOpenCodeQuestion(transport, async () => 'native-1', 'q1', {
      answers: [['apple']]
    })
    expect(seen).toContain('GET /question')
    expect(seen).toContain('POST /question/q1/reply')
    expect(seen).not.toContain('POST /session/native-1/question/q1/reply')
  })
})
