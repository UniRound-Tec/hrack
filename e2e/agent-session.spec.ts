import { expect, test } from '@playwright/test'
import { mkdtempSync, existsSync, readdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type {
  AgentEvent,
  AgentEventKind,
  AgentEventPayload,
  AgentSessionProjection,
  ObserverCapabilities
} from '../shared/agent-events'
import type {
  CliInstallation,
  CliLaunchSelection,
  ExitPayload,
  HistoryEvent,
  SpawnOptions
} from '../shared/ipc-contract'
import {
  createInitialAgentProjection,
  reduceAgentSession
} from '../electron/agents/AgentEventReducer'
import { AgentEventQueue } from '../electron/agents/AgentEventQueue'
import { AgentSessionRuntime } from '../electron/agents/AgentSessionRuntime'
import { ObserverRegistry } from '../electron/agents/ObserverRegistry'
import type {
  AdapterEvent,
  AgentObserverAdapter,
  ObserverHandle,
  PreparedObserver
} from '../electron/agents/adapters/types'

// ───── 测试工具 ─────

function makeEvent(
  seq: number,
  kind: AgentEventKind,
  payload: AgentEventPayload,
  occurredAt = 1_000 + seq
): AgentEvent {
  return {
    id: `evt-${seq}`,
    sessionId: 's1',
    adapterId: 'scripted',
    installationId: 'i1',
    seq,
    occurredAt,
    source: 'fixture',
    kind,
    payload
  } as AgentEvent
}

const FULL_CAPABILITIES: ObserverCapabilities = {
  thinking: 'phase',
  tools: 'progress',
  approvals: 'structured',
  inputRequests: 'structured',
  usage: 'tokens-and-context',
  messages: 'summary'
}

function initialProjection(): AgentSessionProjection {
  return createInitialAgentProjection({
    sessionId: 's1',
    terminalId: 't1',
    installationId: 'i1',
    adapterId: 'scripted',
    name: 'Fixture',
    capabilities: FULL_CAPABILITIES,
    lastActivityAt: 1_000
  })
}

function fixtureSequence(): AgentEvent[] {
  return [
    makeEvent(1, 'session.started', { cwd: 'C:\\repo' }),
    makeEvent(2, 'turn.started', { turnId: 'turn-1' }),
    makeEvent(3, 'thinking.started', { turnId: 'turn-1' }),
    makeEvent(4, 'thinking.completed', { turnId: 'turn-1' }),
    makeEvent(5, 'tool.started', {
      callId: 'tool-1',
      turnId: 'turn-1',
      name: 'fixture-read',
      category: 'read'
    }),
    makeEvent(6, 'approval.requested', {
      requestId: 'req-1',
      callId: 'tool-1',
      category: 'file-change',
      summary: 'Fixture approval request'
    }),
    makeEvent(7, 'approval.resolved', {
      requestId: 'req-1',
      decision: 'approved'
    }),
    makeEvent(8, 'tool.completed', { callId: 'tool-1', durationMs: 42 }),
    makeEvent(9, 'usage.updated', {
      inputTokens: 120,
      outputTokens: 80,
      scope: 'turn'
    }),
    makeEvent(10, 'turn.completed', {
      turnId: 'turn-1',
      outcome: 'completed'
    }),
    makeEvent(11, 'session.exited', { exitCode: 0 })
  ]
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

// ───── P0：纯归约器 ─────

test.describe('AgentEventReducer', () => {
  test('replays the fixture sequence into the six-state walk', () => {
    const statuses: string[] = []
    let projection = initialProjection()
    for (const event of fixtureSequence()) {
      projection = reduceAgentSession(projection, event)
      statuses.push(projection.status)
    }
    // session.started(idle) → working → … → needs-you → working → done → exited
    expect(statuses).toEqual([
      'idle', // session.started
      'working', // turn.started
      'working', // thinking.started
      'working', // thinking.completed
      'working', // tool.started
      'needs-you', // approval.requested
      'working', // approval.resolved
      'working', // tool.completed
      'working', // usage.updated
      'done', // turn.completed
      'exited' // session.exited
    ])
    expect(projection.activeToolCount).toBe(0)
    expect(projection.pendingAttentionCount).toBe(0)
    expect(projection.lastSeq).toBe(11)
    expect(projection.correlation.exited).toBe(true)
    expect(projection.detail).toBe('@agent:exited:0')
  })

  test('resolving one approval keeps needs-you while another request is pending', () => {
    let projection = initialProjection()
    projection = reduceAgentSession(
      projection,
      makeEvent(1, 'approval.requested', { requestId: 'a1' })
    )
    projection = reduceAgentSession(
      projection,
      makeEvent(2, 'approval.requested', { requestId: 'a2' })
    )
    expect(projection.status).toBe('needs-you')
    expect(projection.pendingAttentionCount).toBe(2)
    projection = reduceAgentSession(
      projection,
      makeEvent(3, 'approval.resolved', {
        requestId: 'a1',
        decision: 'approved'
      })
    )
    expect(projection.status).toBe('needs-you')
    expect(projection.pendingAttentionCount).toBe(1)
    projection = reduceAgentSession(
      projection,
      makeEvent(4, 'approval.resolved', {
        requestId: 'a2',
        decision: 'denied'
      })
    )
    expect(projection.status).not.toBe('needs-you')
    expect(projection.pendingAttentionCount).toBe(0)
  })

  test('parallel tools keep working until every call settles', () => {
    let projection = initialProjection()
    projection = reduceAgentSession(
      projection,
      makeEvent(1, 'tool.started', { callId: 't1', name: 'read' })
    )
    projection = reduceAgentSession(
      projection,
      makeEvent(2, 'tool.started', { callId: 't2', name: 'edit' })
    )
    expect(projection.activeToolCount).toBe(2)
    projection = reduceAgentSession(
      projection,
      makeEvent(3, 'tool.completed', { callId: 't1' })
    )
    expect(projection.status).toBe('working')
    expect(projection.activeToolCount).toBe(1)
    projection = reduceAgentSession(
      projection,
      makeEvent(4, 'tool.failed', { callId: 't2', message: 'boom' })
    )
    expect(projection.activeToolCount).toBe(0)
    expect(projection.status).not.toBe('error')
  })

  test('out-of-order and unknown correlation events are ignored', () => {
    let projection = initialProjection()
    // 未开过的 turn/tool/request 的终结事件：不改状态。
    projection = reduceAgentSession(
      projection,
      makeEvent(1, 'tool.completed', { callId: 'ghost' })
    )
    projection = reduceAgentSession(
      projection,
      makeEvent(2, 'approval.resolved', {
        requestId: 'ghost',
        decision: 'approved'
      })
    )
    projection = reduceAgentSession(
      projection,
      makeEvent(3, 'turn.completed', { turnId: 'ghost' })
    )
    expect(projection.status).toBe('working')
    expect(projection.activeToolCount).toBe(0)
    expect(projection.pendingAttentionCount).toBe(0)

    // 迟到的 tool.completed 不会把未开过的 call 变成负数。
    projection = reduceAgentSession(
      projection,
      makeEvent(4, 'tool.started', { callId: 't1', name: 'read' })
    )
    projection = reduceAgentSession(
      projection,
      makeEvent(5, 'tool.completed', { callId: 't1' })
    )
    projection = reduceAgentSession(
      projection,
      makeEvent(6, 'tool.completed', { callId: 't1' })
    )
    expect(projection.activeToolCount).toBe(0)
  })

  test('rejects stale sequence numbers before changing correlation', () => {
    let projection = initialProjection()
    projection = reduceAgentSession(
      projection,
      makeEvent(2, 'turn.started', { turnId: 'current' })
    )
    const current = projection
    projection = reduceAgentSession(
      projection,
      makeEvent(1, 'approval.requested', { requestId: 'stale' })
    )
    expect(projection).toBe(current)
    expect(projection.lastSeq).toBe(2)
    expect(projection.pendingAttentionCount).toBe(0)
  })

  test('exited is terminal: late events never alter the projection', () => {
    let projection = initialProjection()
    projection = reduceAgentSession(
      projection,
      makeEvent(1, 'session.exited', { exitCode: 7 })
    )
    const frozen = projection
    projection = reduceAgentSession(
      projection,
      makeEvent(2, 'turn.started', { turnId: 'late' })
    )
    expect(projection).toBe(frozen)
    expect(projection.status).toBe('exited')
    expect(projection.lastSeq).toBe(1)
  })

  test('low-confidence observer silence idle is reversible and never beats needs-you', () => {
    let projection = initialProjection()
    projection = reduceAgentSession(
      projection,
      makeEvent(1, 'turn.started', { turnId: 'turn-1' })
    )
    projection = reduceAgentSession(
      projection,
      makeEvent(2, 'session.idle', {
        since: 1_000,
        reason: 'observer-silence',
        confidence: 'low'
      })
    )
    expect(projection.status).toBe('idle')
    expect(projection.statusConfidence).toBe('low')

    // 高置信度语义事件清除覆盖并恢复。
    projection = reduceAgentSession(
      projection,
      makeEvent(3, 'tool.started', { callId: 't1', name: 'read' })
    )
    expect(projection.status).toBe('working')
    expect(projection.correlation.lowConfidenceIdle).toBe(false)

    // needs-you 不能被低置信度 idle 覆盖。
    projection = reduceAgentSession(
      projection,
      makeEvent(4, 'approval.requested', { requestId: 'a1' })
    )
    projection = reduceAgentSession(
      projection,
      makeEvent(5, 'session.idle', {
        since: 1_000,
        reason: 'observer-silence',
        confidence: 'low'
      })
    )
    expect(projection.status).toBe('needs-you')
  })

  test('explicit high-confidence idle follows turn.completed', () => {
    let projection = initialProjection()
    projection = reduceAgentSession(
      projection,
      makeEvent(1, 'turn.started', { turnId: 'turn-1' })
    )
    projection = reduceAgentSession(
      projection,
      makeEvent(2, 'turn.completed', { turnId: 'turn-1' })
    )
    expect(projection.status).toBe('done')
    projection = reduceAgentSession(
      projection,
      makeEvent(3, 'session.idle', {
        since: 1_000,
        reason: 'protocol-idle',
        confidence: 'high'
      })
    )
    expect(projection.status).toBe('idle')
    expect(projection.statusConfidence).toBe('high')
  })

  test('turn.failed produces error until the next turn starts', () => {
    let projection = initialProjection()
    projection = reduceAgentSession(
      projection,
      makeEvent(1, 'turn.started', { turnId: 'turn-1' })
    )
    projection = reduceAgentSession(
      projection,
      makeEvent(2, 'turn.failed', { turnId: 'turn-1', message: 'context overflow' })
    )
    expect(projection.status).toBe('error')
    expect(projection.detail).toBe('@agent:error:context overflow')
    projection = reduceAgentSession(
      projection,
      makeEvent(3, 'turn.started', { turnId: 'turn-2' })
    )
    expect(projection.status).toBe('working')
  })

  test('thinking summary is never persisted into the projection', () => {
    let projection = initialProjection()
    projection = reduceAgentSession(
      projection,
      makeEvent(1, 'turn.started', { turnId: 'turn-1' })
    )
    projection = reduceAgentSession(
      projection,
      makeEvent(2, 'thinking.started', { turnId: 'turn-1' })
    )
    projection = reduceAgentSession(
      projection,
      makeEvent(3, 'thinking.completed', {
        turnId: 'turn-1',
        summary: 'secret chain of thought'
      })
    )
    expect(projection.status).toBe('working')
    expect(JSON.stringify(projection)).not.toContain('secret chain of thought')
    expect(JSON.stringify(projection)).not.toContain('chain of thought')
  })

  test('observer.degraded never changes status but records remaining capabilities', () => {
    let projection = initialProjection()
    projection = reduceAgentSession(
      projection,
      makeEvent(1, 'turn.started', { turnId: 'turn-1' })
    )
    projection = reduceAgentSession(
      projection,
      makeEvent(2, 'observer.degraded', {
        reason: 'queue overflow',
        remaining: {
          thinking: 'none',
          tools: 'lifecycle',
          approvals: 'none',
          inputRequests: 'none',
          usage: 'none',
          messages: 'none'
        }
      })
    )
    expect(projection.status).toBe('working')
    expect(projection.capabilities.tools).toBe('lifecycle')
    expect(projection.observerHealth).toBe('stale')
  })

  test('completed detail overrides the live thinking caption and keeps token context', () => {
    let projection = initialProjection()
    projection = reduceAgentSession(
      projection,
      makeEvent(1, 'turn.started', { turnId: 'turn-1' })
    )
    projection = reduceAgentSession(
      projection,
      makeEvent(2, 'activity.caption', {
        text: '@agent:live-thinking:15:844',
        confidence: 'low',
        outputTokens: 844
      })
    )
    expect(projection.detail).toBe('@agent:live-thinking:15:844')
    projection = reduceAgentSession(
      projection,
      makeEvent(3, 'turn.completed', {
        turnId: 'turn-1',
        outcome: 'completed'
      })
    )
    expect(projection.status).toBe('done')
    expect(projection.detail).toBe('@agent:completed:844')
  })
})

// ───── P2：有界队列 ─────

test.describe('AgentEventQueue', () => {
  const seqEvents = (count: number): AgentEvent[] =>
    Array.from({ length: count }, (_, index) =>
      makeEvent(index + 1, 'tool.started', {
        callId: `tool-${index}`,
        name: 'read'
      })
    )

  test('bounded under a flood and never drops terminal events silently', () => {
    const queue = new AgentEventQueue({
      maxEvents: 50,
      maxBytes: 10_000,
      maxSeenNativeIds: 1_000
    })
    for (const event of seqEvents(2_000)) queue.push(event)
    expect(queue.length).toBeLessThanOrEqual(50)
    expect(queue.hasOverflowed()).toBe(true)

    // 全是不可丢事实时，Queue 要求 Runtime 先 flush，不能假装已接收。
    expect(queue.push(
      makeEvent(9_999, 'approval.requested', { requestId: 'req-live' })
    )).toBe('requires-flush')
    queue.flush()
    expect(queue.push(
      makeEvent(9_999, 'approval.requested', { requestId: 'req-live' })
    )).toBe('accepted')
  })

  test('coalesces progress and usage updates to the latest value', () => {
    const queue = new AgentEventQueue({ maxEvents: 100, maxBytes: 100_000, maxSeenNativeIds: 100 })
    queue.push(makeEvent(1, 'tool.started', { callId: 't1', name: 'read' }))
    queue.push(
      makeEvent(2, 'tool.progress', { callId: 't1', summary: 'old' })
    )
    queue.push(
      makeEvent(3, 'tool.progress', { callId: 't1', summary: 'new' })
    )
    queue.push(
      makeEvent(4, 'usage.updated', { inputTokens: 1, scope: 'turn' })
    )
    queue.push(
      makeEvent(5, 'usage.updated', { inputTokens: 2, scope: 'turn' })
    )
    const batch = queue.flush()
    const progresses = batch.filter((event) => event.kind === 'tool.progress')
    const usages = batch.filter((event) => event.kind === 'usage.updated')
    expect(progresses).toHaveLength(1)
    expect(progresses[0].payload).toMatchObject({ summary: 'new' })
    expect(usages).toHaveLength(1)
    expect(usages[0].payload).toMatchObject({ inputTokens: 2 })
  })

  test('drops replay duplicates by native id', () => {
    const queue = new AgentEventQueue()
    const first = makeEvent(1, 'tool.started', { callId: 't1', name: 'read' })
    first.nativeId = 'native:1'
    const replay = makeEvent(2, 'tool.started', { callId: 't1', name: 'read' })
    replay.nativeId = 'native:1'
    expect(queue.push(first)).toBe('accepted')
    expect(queue.push(replay)).toBe('dropped-duplicate')
    expect(queue.flush()).toHaveLength(1)
  })

  test('rolls the native-id window without clearing recent ids', () => {
    const queue = new AgentEventQueue({
      maxEvents: 20,
      maxBytes: 20_000,
      maxSeenNativeIds: 2
    })
    for (let seq = 1; seq <= 3; seq++) {
      const event = makeEvent(seq, 'tool.started', {
        callId: `t${seq}`,
        name: 'read'
      })
      event.nativeId = `native:${seq}`
      expect(queue.push(event)).toBe('accepted')
    }
    const recentReplay = makeEvent(4, 'tool.started', {
      callId: 't2',
      name: 'read'
    })
    recentReplay.nativeId = 'native:2'
    expect(queue.push(recentReplay)).toBe('dropped-duplicate')
  })

  test('coalescing keeps the latest event in monotonic seq order', () => {
    const queue = new AgentEventQueue()
    queue.push(makeEvent(1, 'tool.progress', { callId: 't1', summary: 'old' }))
    queue.push(makeEvent(2, 'turn.started', { turnId: 'turn-1' }))
    queue.push(makeEvent(3, 'tool.progress', { callId: 't1', summary: 'new' }))
    expect(queue.flush().map((event) => event.seq)).toEqual([2, 3])
  })
})

// ───── P1/P2/P4：Runtime interface 级门禁 ─────

interface FakePtyHost {
  spawn: (opts: SpawnOptions) => Promise<{ ptyId: string }>
  kill: (ptyId: string) => void
  onExit: (ptyId: string, cb: (payload: ExitPayload) => void) => () => void
}

function createRuntimeHarness(options: {
  scripted?: ScriptedAdapter
  failSpawn?: boolean
  failPrepareLaunch?: boolean
  adapterId?: string
  verbatimLaunch?: boolean
}) {
  const spawned: Array<{ opts: SpawnOptions; ptyId: string }> = []
  const killed: string[] = []
  const exitCbs = new Map<string, Set<(payload: ExitPayload) => void>>()
  const exited = new Map<string, ExitPayload>()
  let spawnCount = 0

  const triggerExit = (ptyId: string, payload: ExitPayload): void => {
    if (exited.has(ptyId)) return
    exited.set(ptyId, payload)
    for (const cb of exitCbs.get(ptyId) ?? []) cb(payload)
  }

  const pty: FakePtyHost = {
    async spawn(opts) {
      if (options.failSpawn) throw new Error('spawn failed')
      const ptyId = `pty-${++spawnCount}`
      spawned.push({ opts, ptyId })
      return { ptyId }
    },
    kill(ptyId) {
      killed.push(ptyId)
      triggerExit(ptyId, { code: 0 })
    },
    onExit(ptyId, cb) {
      const listeners = exitCbs.get(ptyId) ?? new Set()
      listeners.add(cb)
      exitCbs.set(ptyId, listeners)
      const cached = exited.get(ptyId)
      if (cached) queueMicrotask(() => cb(cached))
      return () => listeners.delete(cb)
    }
  }

  const installation: CliInstallation = {
    id: 'codex:test',
    definitionId: 'codex',
    runtime: { kind: 'host', platform: 'windows' },
    resolvedExecutable: 'codex.exe',
    detectedVia: 'path',
    version: 'test',
    verification: 'verified'
  }
  const discovery = {
    async resolveInstallation(installationId: string) {
      return installationId === installation.id ? installation : null
    },
    async resolveWorkspace(_installationId: string, workspace: string) {
      return workspace.trim() || 'C:\\Users\\fixture'
    },
    definitionAdapterId() {
      return options.adapterId ?? 'scripted'
    },
    async prepareLaunch(
      selection: CliLaunchSelection,
      augmentation: {
        prependArgs?: readonly string[]
        appendArgs?: readonly string[]
      } = {}
    ) {
      if (options.failPrepareLaunch) throw new Error('workspace unavailable')
      const args = [
        ...(augmentation.prependArgs ?? []),
        ...selection.args,
        ...(augmentation.appendArgs ?? [])
      ]
      return options.verbatimLaunch
        ? { shell: 'cmd.exe', args: `/d /c call codex.cmd ${args.join(' ')}` }
        : { shell: installation.resolvedExecutable, args }
    }
  }

  const historyEvents: HistoryEvent[] = []
  const history = {
    async record(event: HistoryEvent) {
      historyEvents.push(event)
    }
  }

  const broadcasts: Array<[string, unknown]> = []
  const registry = new ObserverRegistry()
  const scripted = options.scripted ?? new ScriptedAdapter()
  registry.register(scripted)

  const runDirRoot = mkdtempSync(join(tmpdir(), 'vibing-agent-run-'))
  const runtime = new AgentSessionRuntime({
    pty,
    discovery,
    history,
    registry,
    options: {
      runDirRoot,
      broadcast: (channel, payload) => broadcasts.push([channel, payload]),
      silenceAfterMs: 0,
      idleCheckMs: 0
    }
  })

  return {
    runtime,
    scripted,
    pty,
    triggerExit,
    spawned,
    killed,
    historyEvents,
    broadcasts,
    installation,
    runDirRoot
  }
}

class ScriptedAdapter implements AgentObserverAdapter {
  readonly id = 'scripted'
  readonly source = 'fixture' as const
  readonly capabilities: ObserverCapabilities = FULL_CAPABILITIES
  failPrepare = false
  failAttach = false
  failDispose = false
  prepared = false
  disposed = false
  attached = false
  reconnectCalls = 0
  private emitFn: ((event: AdapterEvent) => void) | null = null
  private disconnectListener: ((reason: string) => void) | null = null

  supports(): boolean {
    return true
  }

  async prepare(): Promise<PreparedObserver> {
    if (this.failPrepare) throw new Error('prepare boom')
    this.prepared = true
    return {
      launch: {
        env: { VIBING_FIXTURE: '1' },
        prependArgs: ['--non-interactive']
      },
      capabilities: this.capabilities,
      attach: async (_context, emit) => {
        this.attached = true
        this.emitFn = emit
        if (this.failAttach) throw new Error('attach boom')
        return this.createHandle()
      },
      dispose: async () => {
        this.disposed = true
        if (this.failDispose) throw new Error('prepared dispose boom')
      }
    }
  }

  emit(event: AdapterEvent): void {
    this.emitFn?.(event)
  }

  disconnect(reason = 'fixture disconnect'): void {
    this.disconnectListener?.(reason)
  }

  private createHandle(): ObserverHandle {
    return {
      capabilities: this.capabilities,
      onDisconnect: (listener) => {
        this.disconnectListener = listener
        return () => {
          if (this.disconnectListener === listener) {
            this.disconnectListener = null
          }
        }
      },
      reconnect: async () => {
        this.reconnectCalls++
        return this.createHandle()
      },
      dispose: async () => {
        this.disposed = true
        if (this.failDispose) throw new Error('handle dispose boom')
      }
    }
  }

  async emitSequence(): Promise<void> {
    for (const item of fixtureSequence()) {
      this.emit({
        kind: item.kind,
        payload: item.payload,
        nativeId: `native:${item.seq}`
      })
      // 逐条跨 flush 广播，让每个中间状态都可见（对应真实 adapter 的节奏）。
      await settle()
    }
  }
}

function projectionsOf(
  harness: ReturnType<typeof createRuntimeHarness>
): AgentSessionProjection[] {
  return harness.broadcasts
    .filter(([channel]) => channel === 'agent:projection')
    .map(([, payload]) => payload as AgentSessionProjection)
}

test.describe('AgentSessionRuntime (interface gates)', () => {
  test('start→fixture script→exit walks statuses and projects low-sensitivity history', async () => {
    const harness = createRuntimeHarness({})
    const started = await harness.runtime.start({
      terminalId: 't1',
      selection: {
        installationId: 'codex:test',
        workspace: 'C:\\repo',
        args: []
      },
      name: 'Fixture session',
      cols: 100,
      rows: 30
    })

    expect(started.ptyId).toBe('pty-1')
    expect(started.projection.status).toBe('idle')
    expect(harness.spawned[0].opts).toMatchObject({
      shell: 'codex.exe',
      cols: 100,
      rows: 30,
      env: { VIBING_FIXTURE: '1' },
      args: ['--non-interactive']
    })
    expect(harness.scripted.prepared).toBe(true)
    expect(harness.scripted.attached).toBe(true)

    await harness.scripted.emitSequence()

    const statuses = projectionsOf(harness).map((projection) => projection.status)
    expect(statuses).toContain('needs-you')
    expect(statuses.at(-1)).toBe('exited')
    // 自然退出只清理 Observer；PTY 历史由 Terminal Page 保留到用户显式关闭。
    expect(harness.killed).not.toContain('pty-1')
    // finalize 内含真实 I/O（rm），需要轮询等待。
    await expect.poll(() => harness.runtime.listActive().length).toBe(0)

    // 低敏历史投影：每个稳定键只计一次。
    const kinds = harness.historyEvents.map((event) => event.kind)
    expect(kinds).toEqual([
      'session_start',
      'tool_call',
      'blocked',
      'approved',
      'completed',
      'session_exit'
    ])
    const start = harness.historyEvents.find(
      (event) => event.kind === 'session_start'
    )
    expect(start).toMatchObject({
      adapterId: 'scripted',
      title: 'Fixture session',
      detail: 'C:\\repo'
    })
    // observer-runs/<sessionId> 已被清理。
    const leftovers = join(harness.runDirRoot, started.sessionId)
    await expect.poll(() => existsSync(leftovers)).toBe(false)
  })

  test('passes adapter args into the provider before a Windows verbatim command is serialized', async () => {
    const harness = createRuntimeHarness({ verbatimLaunch: true })
    await harness.runtime.start({
      terminalId: 't1',
      selection: {
        installationId: 'codex:test',
        workspace: '',
        args: ['user-arg']
      },
      cols: 80,
      rows: 24
    })
    expect(harness.spawned[0].opts.args).toBe(
      '/d /c call codex.cmd --non-interactive user-arg'
    )
  })

  test('stop is idempotent and finalizes exactly once', async () => {
    const harness = createRuntimeHarness({})
    const started = await harness.runtime.start({
      terminalId: 't1',
      selection: { installationId: 'codex:test', workspace: '', args: [] },
      cols: 80,
      rows: 24
    })
    await harness.runtime.stop(started.sessionId)
    await harness.runtime.stop(started.sessionId)
    await harness.runtime.stop('unknown-session')
    expect(harness.killed.filter((id) => id === started.ptyId)).toHaveLength(1)
    expect(harness.runtime.listActive()).toHaveLength(0)
    expect(existsSync(join(harness.runDirRoot, started.sessionId))).toBe(false)
    expect(
      harness.historyEvents.filter((event) => event.kind === 'session_exit')
    ).toHaveLength(1)
    expect(
      projectionsOf(harness).filter((projection) => projection.status === 'exited')
    ).toHaveLength(1)
  })

  test('natural pty exit produces a single exited projection', async () => {
    const harness = createRuntimeHarness({})
    const started = await harness.runtime.start({
      terminalId: 't1',
      selection: { installationId: 'codex:test', workspace: '', args: [] },
      cols: 80,
      rows: 24
    })
    // 模拟 CLI 自行退出（不经过 Runtime.kill）。
    harness.triggerExit(started.ptyId, { code: 5 })
    await settle()
    const exited = projectionsOf(harness).filter(
      (projection) => projection.status === 'exited'
    )
    expect(exited).toHaveLength(1)
    expect(exited[0].detail).toBe('@agent:exited:5')
    expect(
      harness.historyEvents.some(
        (event) =>
          event.kind === 'session_exit' && event.detail === 'exit code 5'
      )
    ).toBe(true)
    expect(harness.killed).not.toContain(started.ptyId)
    // finalize 内含真实 I/O（rm），需要轮询等待。
    await expect.poll(() => harness.runtime.listActive().length).toBe(0)
  })

  test('adapter prepare failure degrades to lifecycle without killing the CLI', async () => {
    const scripted = new ScriptedAdapter()
    scripted.failPrepare = true
    const harness = createRuntimeHarness({ scripted })
    const started = await harness.runtime.start({
      terminalId: 't1',
      selection: { installationId: 'codex:test', workspace: '', args: [] },
      cols: 80,
      rows: 24
    })
    await settle()
    expect(started.projection.capabilities.tools).toBe('none')
    const final = projectionsOf(harness).at(-1)
    expect(final?.observerHealth).toBe('lifecycle-only')
    expect(harness.killed).toHaveLength(0)
    expect(harness.runtime.listActive()).toHaveLength(1)
  })

  test('adapter attach failure degrades but keeps the CLI running', async () => {
    const scripted = new ScriptedAdapter()
    scripted.failAttach = true
    const harness = createRuntimeHarness({ scripted })
    const started = await harness.runtime.start({
      terminalId: 't1',
      selection: { installationId: 'codex:test', workspace: '', args: [] },
      cols: 80,
      rows: 24
    })
    await settle()
    expect(started.projection.capabilities.approvals).toBe('none')
    expect(harness.killed).toHaveLength(0)
    expect(harness.historyEvents.some((event) => event.kind === 'session_start')).toBe(true)
  })

  test('observer disconnect gets one bounded reconnect before lifecycle degradation', async () => {
    const scripted = new ScriptedAdapter()
    const harness = createRuntimeHarness({ scripted })
    const started = await harness.runtime.start({
      terminalId: 't1',
      selection: { installationId: 'codex:test', workspace: '', args: [] },
      cols: 80,
      rows: 24
    })

    scripted.disconnect('first drop')
    await settle()
    await settle()
    expect(scripted.reconnectCalls).toBe(1)
    expect(harness.killed).toHaveLength(0)

    scripted.disconnect('second drop')
    await settle()
    await settle()
    expect(scripted.reconnectCalls).toBe(1)
    expect(harness.killed).toHaveLength(0)
    expect(harness.runtime.listActive()[0].capabilities.tools).toBe('none')
    await harness.runtime.stop(started.sessionId)
  })

  test('spawn failure rolls back: no session, no history, no temp leak', async () => {
    const scripted = new ScriptedAdapter()
    const harness = createRuntimeHarness({ scripted, failSpawn: true })
    await expect(
      harness.runtime.start({
        terminalId: 't1',
        selection: { installationId: 'codex:test', workspace: '', args: [] },
        cols: 80,
        rows: 24
      })
    ).rejects.toThrow(/Failed to start CLI/)
    expect(scripted.disposed).toBe(true)
    expect(harness.runtime.listActive()).toHaveLength(0)
    expect(harness.historyEvents).toHaveLength(0)
  })

  test('prepareLaunch failure rolls back the prepared observer and temp dir', async () => {
    const scripted = new ScriptedAdapter()
    const harness = createRuntimeHarness({ scripted, failPrepareLaunch: true })
    await expect(
      harness.runtime.start({
        terminalId: 't1',
        selection: { installationId: 'codex:test', workspace: '', args: [] },
        cols: 80,
        rows: 24
      })
    ).rejects.toThrow(/workspace unavailable/)
    expect(scripted.disposed).toBe(true)
    expect(harness.historyEvents).toHaveLength(0)
    expect(harness.runtime.listActive()).toHaveLength(0)
  })

  test('dispose failures cannot strand a session or observer run directory', async () => {
    const scripted = new ScriptedAdapter()
    scripted.failDispose = true
    const harness = createRuntimeHarness({ scripted })
    const started = await harness.runtime.start({
      terminalId: 't1',
      selection: { installationId: 'codex:test', workspace: '', args: [] },
      cols: 80,
      rows: 24
    })
    await harness.runtime.stop(started.sessionId)
    expect(harness.runtime.listActive()).toHaveLength(0)
    expect(readdirSync(harness.runDirRoot)).toHaveLength(0)
  })

  test('stale installation is rejected before any PTY is created', async () => {
    const harness = createRuntimeHarness({})
    await expect(
      harness.runtime.start({
        terminalId: 't1',
        selection: { installationId: 'gone', workspace: '', args: [] },
        cols: 80,
        rows: 24
      })
    ).rejects.toThrow(/no longer available/)
    expect(harness.spawned).toHaveLength(0)
  })

  test('duplicate native delivery projects tool/approval stats only once', async () => {
    const scripted = new ScriptedAdapter()
    const harness = createRuntimeHarness({ scripted })
    await harness.runtime.start({
      terminalId: 't1',
      selection: { installationId: 'codex:test', workspace: '', args: [] },
      cols: 80,
      rows: 24
    })
    // 同一原生事件投递两次（hook 重放 / reconnect replay）。
    for (let round = 0; round < 2; round++) {
      scripted.emit({ kind: 'tool.started', payload: { callId: 'tool-x', name: 'read' }, nativeId: 'native:tool-x' })
      scripted.emit({ kind: 'approval.requested', payload: { requestId: 'req-x' }, nativeId: 'native:req-x' })
      scripted.emit({ kind: 'approval.resolved', payload: { requestId: 'req-x', decision: 'approved' }, nativeId: 'native:req-approved' })
    }
    await settle()
    const toolCalls = harness.historyEvents.filter((event) => event.kind === 'tool_call')
    const blocked = harness.historyEvents.filter((event) => event.kind === 'blocked')
    const approved = harness.historyEvents.filter((event) => event.kind === 'approved')
    expect(toolCalls).toHaveLength(1)
    expect(blocked).toHaveLength(1)
    expect(approved).toHaveLength(1)
  })

  test('event flood stays bounded and never touches the PTY data path', async () => {
    const scripted = new ScriptedAdapter()
    const harness = createRuntimeHarness({ scripted })
    await harness.runtime.start({
      terminalId: 't1',
      selection: { installationId: 'codex:test', workspace: '', args: [] },
      cols: 80,
      rows: 24
    })
    for (let index = 0; index < 5_000; index++) {
      scripted.emit({
        kind: 'tool.progress',
        payload: { callId: `flood-${index}`, summary: 'x'.repeat(200) },
        nativeId: `native:flood:${index}`
      })
    }
    // 终态事件在洪峰后仍能入队。
    scripted.emit({ kind: 'turn.started', payload: { turnId: 'turn-live' }, nativeId: 'native:turn-live' })
    scripted.emit({ kind: 'turn.completed', payload: { turnId: 'turn-live' }, nativeId: 'native:turn-done' })
    await settle()
    expect(harness.killed).toHaveLength(0)
    const degradedBroadcasts = harness.broadcasts.filter(
      ([channel]) => channel === 'agent:events'
    )
    const degradedEvents = degradedBroadcasts.flatMap(([, payload]) =>
      Array.isArray(payload)
        ? payload.filter(
            (event: AgentEvent) => event.kind === 'observer.degraded'
          )
        : []
    )
    // 超限只发一个去重的 observer.degraded。
    expect(degradedEvents).toHaveLength(1)
    const finalProjection = projectionsOf(harness).at(-1)
    expect(finalProjection?.status).toBe('done')
  })
})
