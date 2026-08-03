import { expect, test } from '@playwright/test'
import {
  parseOpenCodeEvent,
  parseOpenCodeSnapshot
} from '../electron/agents/adapters/opencode/OpenCodeEventParser'
import { OpenCodeEventProjector } from '../electron/agents/adapters/opencode/OpenCodeEventProjector'
import {
  OpenCodeSseError,
  OpenCodeSseParser
} from '../electron/agents/adapters/opencode/OpenCodeSseParser'
import type { AdapterEvent } from '../electron/agents/adapters/types'
import type { OpenCodeNativeFact } from '../electron/agents/adapters/opencode/types'

function project(
  projector: OpenCodeEventProjector,
  facts: OpenCodeNativeFact[]
): AdapterEvent[] {
  return facts.flatMap((fact, index) => projector.project(fact, 1_000 + index))
}

test.describe('OpenCode observer adapter', () => {
  test('SSE parser handles chunk boundaries, CRLF, comments and multi-line data', () => {
    const values: unknown[] = []
    const parser = new OpenCodeSseParser((value) => values.push(value))
    const bytes = Buffer.from(
      ': keepalive\r\ndata: {"type":"server.connected",\r\ndata: "properties":{}}\r\n\r\n' +
        'event: ignored\ndata: {"type":"session.idle","properties":{"sessionID":"s1"}}\n\n'
    )
    for (let index = 0; index < bytes.length; index += 3) {
      parser.push(bytes.subarray(index, index + 3))
    }
    parser.end()
    expect(values).toEqual([
      { type: 'server.connected', properties: {} },
      { type: 'session.idle', properties: { sessionID: 's1' } }
    ])
  })

  test('SSE parser rejects unbounded frames', () => {
    const parser = new OpenCodeSseParser(() => {}, { maxEventBytes: 16 })
    expect(() =>
      parser.push(`data: ${JSON.stringify({ value: 'x'.repeat(40) })}\n\n`)
    ).toThrow(OpenCodeSseError)
  })

  test('SSE parser does not misreport consumer failures as invalid JSON', () => {
    const parser = new OpenCodeSseParser(() => {
      throw new Error('projector failed')
    })
    expect(() => parser.push('data: {"type":"server.connected"}\n\n')).toThrow(
      'projector failed'
    )
  })

  test('parser accepts permission schema aliases and drops sensitive bodies', () => {
    const canary = 'SECRET_TOOL_BODY_CANARY'
    const asked = parseOpenCodeEvent({
      type: 'permission.updated',
      properties: {
        id: 'req-1',
        sessionID: 's1',
        callID: 'c1',
        type: 'bash',
        title: 'Run command',
        metadata: { command: canary }
      }
    })
    expect(asked).toEqual({
      type: 'permission-asked',
      nativeType: 'permission.updated',
      sessionId: 's1',
      requestId: 'req-1',
      callId: 'c1',
      permission: 'bash',
      title: 'Run command'
    })

    const tool = parseOpenCodeEvent({
      type: 'message.part.updated',
      properties: {
        delta: canary,
        part: {
          id: 'p1',
          sessionID: 's1',
          messageID: 'm1',
          type: 'tool',
          callID: 'c1',
          tool: 'bash',
          state: {
            status: 'running',
            input: { command: canary },
            title: 'Run tests',
            time: { start: 10 }
          }
        }
      }
    })
    expect(JSON.stringify(tool)).not.toContain(canary)
    expect(tool).toMatchObject({
      type: 'tool',
      state: 'running',
      title: 'Run tests'
    })

    const reasoning = parseOpenCodeEvent({
      type: 'message.part.updated',
      properties: {
        delta: canary,
        part: {
          id: 'r1',
          sessionID: 's1',
          messageID: 'm1',
          type: 'reasoning',
          text: canary,
          time: { start: 10 }
        }
      }
    })
    expect(JSON.stringify(reasoning)).not.toContain(canary)
    expect(reasoning).toMatchObject({ type: 'reasoning', completed: false })
  })

  test('parser unwraps the global event envelope used by real OpenCode TUI', () => {
    expect(
      parseOpenCodeEvent({
        directory: 'C:/workspace',
        payload: {
          type: 'session.status',
          properties: { sessionID: 's1', status: { type: 'busy' } }
        }
      })
    ).toEqual({
      type: 'session-status',
      nativeType: 'session.status',
      sessionId: 's1',
      status: 'busy',
      attempt: undefined,
      message: undefined
    })
  })

  test('snapshot parser narrows sessions and statuses', () => {
    const snapshot = parseOpenCodeSnapshot(
      [
        { id: 'root', directory: 'C:/work', time: { created: 10, updated: 20 } }
      ],
      { root: { type: 'busy' } }
    )
    expect(snapshot?.sessions).toEqual([
      {
        id: 'root',
        directory: 'C:/work',
        parentId: undefined,
        createdAt: 10,
        updatedAt: 20
      }
    ])
    expect(snapshot?.statuses.get('root')).toBe('busy')
  })

  test('projects a real turn lifecycle without reasoning or tool body leakage', () => {
    const projector = new OpenCodeEventProjector()
    const events = project(projector, [
      {
        type: 'session-status',
        nativeType: 'session.status',
        sessionId: 's1',
        status: 'busy'
      },
      {
        type: 'reasoning',
        nativeType: 'message.part.updated',
        sessionId: 's1',
        messageId: 'm1',
        partId: 'r1',
        completed: false
      },
      {
        type: 'tool',
        nativeType: 'message.part.updated',
        sessionId: 's1',
        messageId: 'm1',
        partId: 't1',
        callId: 'c1',
        name: 'bash',
        state: 'running',
        title: 'Run tests',
        startedAt: 20
      },
      {
        type: 'permission-asked',
        nativeType: 'permission.asked',
        sessionId: 's1',
        requestId: 'q1',
        callId: 'c1',
        permission: 'bash',
        title: 'Run tests'
      },
      {
        type: 'permission-replied',
        nativeType: 'permission.replied',
        sessionId: 's1',
        requestId: 'q1',
        response: 'once'
      },
      {
        type: 'tool',
        nativeType: 'message.part.updated',
        sessionId: 's1',
        messageId: 'm1',
        partId: 't1',
        callId: 'c1',
        name: 'bash',
        state: 'completed',
        title: 'Run tests',
        startedAt: 20,
        endedAt: 40
      },
      {
        type: 'step-finished',
        nativeType: 'message.part.updated',
        sessionId: 's1',
        messageId: 'm1',
        partId: 'step1',
        inputTokens: 100,
        outputTokens: 25,
        costUsd: 0.01
      },
      { type: 'session-idle', nativeType: 'session.idle', sessionId: 's1' }
    ])
    expect(events.map((item) => item.kind)).toEqual([
      'turn.started',
      'thinking.started',
      'thinking.completed',
      'tool.started',
      'approval.requested',
      'approval.resolved',
      'tool.completed',
      'usage.updated',
      'turn.completed'
    ])
    expect(events.find((item) => item.kind === 'tool.started')).toMatchObject({
      payload: { name: 'bash', category: 'shell' }
    })
    expect(events.find((item) => item.kind === 'usage.updated')).toMatchObject({
      payload: {
        inputTokens: 100,
        outputTokens: 25,
        costUsd: 0.01,
        scope: 'turn'
      }
    })
  })

  test('aggregates multiple native sessions before completing the pane turn', () => {
    const projector = new OpenCodeEventProjector()
    const started = project(projector, [
      {
        type: 'session-status',
        nativeType: 'session.status',
        sessionId: 'root-a',
        status: 'busy'
      },
      {
        type: 'session-status',
        nativeType: 'session.status',
        sessionId: 'root-b',
        status: 'busy'
      }
    ])
    expect(started.filter((item) => item.kind === 'turn.started')).toHaveLength(
      1
    )

    const firstIdle = project(projector, [
      { type: 'session-idle', nativeType: 'session.idle', sessionId: 'root-a' }
    ])
    expect(firstIdle.some((item) => item.kind === 'turn.completed')).toBe(false)

    const secondIdle = project(projector, [
      { type: 'session-idle', nativeType: 'session.idle', sessionId: 'root-b' }
    ])
    expect(
      secondIdle.filter((item) => item.kind === 'turn.completed')
    ).toHaveLength(1)
  })

  test('keeps the pane working until parallel tools are both terminal', () => {
    const projector = new OpenCodeEventProjector()
    project(projector, [
      {
        type: 'session-status',
        nativeType: 'session.status',
        sessionId: 's1',
        status: 'busy'
      },
      {
        type: 'tool',
        nativeType: 'message.part.updated',
        sessionId: 's1',
        messageId: 'm1',
        partId: 't1',
        callId: 'c1',
        name: 'read',
        state: 'running'
      },
      {
        type: 'tool',
        nativeType: 'message.part.updated',
        sessionId: 's1',
        messageId: 'm1',
        partId: 't2',
        callId: 'c2',
        name: 'bash',
        state: 'running'
      }
    ])
    const partial = project(projector, [
      {
        type: 'tool',
        nativeType: 'message.part.updated',
        sessionId: 's1',
        messageId: 'm1',
        partId: 't1',
        callId: 'c1',
        name: 'read',
        state: 'completed'
      }
    ])
    expect(partial.some((item) => item.kind === 'turn.completed')).toBe(false)
    const final = project(projector, [
      {
        type: 'tool',
        nativeType: 'message.part.updated',
        sessionId: 's1',
        messageId: 'm1',
        partId: 't2',
        callId: 'c2',
        name: 'bash',
        state: 'completed'
      },
      { type: 'session-idle', nativeType: 'session.idle', sessionId: 's1' }
    ])
    expect(final.filter((item) => item.kind === 'turn.completed')).toHaveLength(
      1
    )
  })

  test('keeps attention until every permission and question is resolved', () => {
    const projector = new OpenCodeEventProjector()
    project(projector, [
      {
        type: 'session-status',
        nativeType: 'session.status',
        sessionId: 's1',
        status: 'busy'
      },
      {
        type: 'permission-asked',
        nativeType: 'permission.asked',
        sessionId: 's1',
        requestId: 'p1',
        permission: 'bash'
      },
      {
        type: 'permission-asked',
        nativeType: 'permission.asked',
        sessionId: 's1',
        requestId: 'p2',
        permission: 'edit'
      },
      {
        type: 'question-asked',
        nativeType: 'question.asked',
        sessionId: 's1',
        requestId: 'q1',
        prompt: 'Choose one'
      }
    ])
    const partial = project(projector, [
      {
        type: 'permission-replied',
        nativeType: 'permission.replied',
        sessionId: 's1',
        requestId: 'p1',
        response: 'once'
      },
      { type: 'session-idle', nativeType: 'session.idle', sessionId: 's1' }
    ])
    expect(partial.some((item) => item.kind === 'turn.completed')).toBe(false)
    const final = project(projector, [
      {
        type: 'permission-replied',
        nativeType: 'permission.replied',
        sessionId: 's1',
        requestId: 'p2',
        response: 'reject'
      },
      {
        type: 'question-resolved',
        nativeType: 'question.replied',
        sessionId: 's1',
        requestId: 'q1'
      },
      { type: 'session-idle', nativeType: 'session.idle', sessionId: 's1' }
    ])
    expect(final.filter((item) => item.kind === 'turn.completed')).toHaveLength(
      1
    )
  })

  test('projects a non-retryable native failure as one failed turn', () => {
    const projector = new OpenCodeEventProjector()
    const events = project(projector, [
      {
        type: 'session-status',
        nativeType: 'session.status',
        sessionId: 's1',
        status: 'busy'
      },
      {
        type: 'session-error',
        nativeType: 'session.error',
        sessionId: 's1',
        message: 'Provider unavailable',
        retryable: false,
        cancelled: false
      }
    ])
    expect(events.map((item) => item.kind)).toEqual([
      'turn.started',
      'turn.failed'
    ])
  })

  test('deduplicates the OpenCode 1.17.9 user-message replay', () => {
    const projector = new OpenCodeEventProjector()
    const fact: OpenCodeNativeFact = {
      type: 'message-user',
      nativeType: 'message.updated',
      sessionId: 's1',
      messageId: 'm-user'
    }
    expect(
      projector.project(fact).filter((item) => item.kind === 'turn.started')
    ).toHaveLength(1)
    expect(projector.project(fact)).toEqual([])
  })

  test('reconciliation hydrates busy state before live replay', () => {
    const projector = new OpenCodeEventProjector()
    const snapshot = parseOpenCodeSnapshot(
      [
        { id: 'root', directory: 'C:/work' },
        { id: 'child', directory: 'C:/work', parentID: 'root' }
      ],
      { root: { type: 'idle' }, child: { type: 'busy' } }
    )!
    const reconciled = projector.reconcile(snapshot, 100)
    expect(reconciled.map((item) => item.kind)).toEqual(['turn.started'])
    const idleRoot = projector.project(
      {
        type: 'session-idle',
        nativeType: 'session.idle',
        sessionId: 'root'
      },
      101
    )
    expect(idleRoot.some((item) => item.kind === 'turn.completed')).toBe(false)
    const idleChild = projector.project(
      {
        type: 'session-idle',
        nativeType: 'session.idle',
        sessionId: 'child'
      },
      102
    )
    expect(idleChild.some((item) => item.kind === 'turn.completed')).toBe(true)
  })
})
