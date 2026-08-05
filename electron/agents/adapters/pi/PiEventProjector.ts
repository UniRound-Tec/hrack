import type { AdapterEvent } from '../types'
import { PI_OBSERVER_CAPABILITIES, type PiNativeFact } from './types'

export interface PiEventProjectorOptions {
  supportsAgentSettled: boolean
}

interface ToolState {
  name: string
  turnId: string
  terminal: boolean
}

function categoryFor(
  name: string
): 'read' | 'edit' | 'shell' | 'search' | 'network' | 'mcp' | 'other' {
  const normalized = name.toLowerCase()
  if (normalized === 'bash' || normalized === 'shell') return 'shell'
  if (normalized === 'read') return 'read'
  if (normalized === 'edit' || normalized === 'write') return 'edit'
  if (normalized === 'grep' || normalized === 'find' || normalized === 'ls') {
    return 'search'
  }
  if (normalized.startsWith('mcp__')) return 'mcp'
  return 'other'
}

export class PiEventProjector {
  private generation: string | undefined
  private lastWireSeq = 0
  private runCounter = 0
  private activeTurnId: string | undefined
  private thinking = false
  private runOutcome: 'completed' | 'cancelled' | 'failed' = 'completed'
  private compacting = false
  private readonly tools = new Map<string, ToolState>()

  constructor(_options: PiEventProjectorOptions) {}

  project(fact: PiNativeFact, now = Date.now()): AdapterEvent[] {
    if (fact.type === 'session-start') {
      if (fact.generation === this.generation && fact.seq <= this.lastWireSeq) {
        return []
      }
      this.generation = fact.generation
      this.lastWireSeq = fact.seq
      this.resetRun()
      return [
        this.event(
          {
            kind: 'session.idle',
            payload: {
              since: now,
              reason: 'protocol-idle',
              confidence: 'high'
            }
          },
          fact
        )
      ]
    }
    if (
      fact.generation !== this.generation ||
      fact.seq <= this.lastWireSeq
    ) {
      return []
    }
    this.lastWireSeq = fact.seq

    if (fact.type === 'run-start') {
      this.closeRunCorrelation()
      this.activeTurnId = `pi:${fact.generation}:${++this.runCounter}`
      this.runOutcome = 'completed'
      return [
        this.event(
          { kind: 'turn.started', payload: { turnId: this.activeTurnId } },
          fact
        )
      ]
    }
    if (fact.type === 'thinking-start') {
      if (!this.activeTurnId || this.thinking) return []
      this.thinking = true
      return [
        this.event(
          { kind: 'thinking.started', payload: { turnId: this.activeTurnId } },
          fact
        )
      ]
    }
    if (fact.type === 'thinking-end') {
      if (!this.activeTurnId || !this.thinking) return []
      this.thinking = false
      return [
        this.event(
          { kind: 'thinking.completed', payload: { turnId: this.activeTurnId } },
          fact
        )
      ]
    }
    if (fact.type === 'responding') {
      if (!this.activeTurnId) return []
      return [
        this.event(
          {
            kind: 'activity.caption',
            payload: { text: '@agent:responding', confidence: 'low' }
          },
          fact
        )
      ]
    }
    if (fact.type === 'tool-start') {
      if (!this.activeTurnId || this.tools.has(fact.callId)) return []
      if (this.thinking) this.thinking = false
      this.tools.set(fact.callId, {
        name: fact.toolName,
        turnId: this.activeTurnId,
        terminal: false
      })
      return [
        this.event(
          {
            kind: 'tool.started',
            payload: {
              callId: fact.callId,
              turnId: this.activeTurnId,
              name: fact.toolName,
              category: categoryFor(fact.toolName)
            }
          },
          fact
        )
      ]
    }
    if (fact.type === 'tool-progress') {
      const tool = this.tools.get(fact.callId)
      if (!tool || tool.terminal) return []
      return [
        this.event(
          { kind: 'tool.progress', payload: { callId: fact.callId } },
          fact
        )
      ]
    }
    if (fact.type === 'tool-end') {
      const tool = this.tools.get(fact.callId)
      if (!tool || tool.terminal) return []
      tool.terminal = true
      return [
        this.event(
          fact.isError
            ? {
                kind: 'tool.failed',
                payload: {
                  callId: fact.callId,
                  durationMs: fact.durationMs,
                  message: 'Pi tool failed'
                }
              }
            : {
                kind: 'tool.completed',
                payload: { callId: fact.callId, durationMs: fact.durationMs }
              },
          fact
        )
      ]
    }
    if (fact.type === 'usage') {
      return [
        this.event(
          {
            kind: 'usage.updated',
            payload: {
              inputTokens: fact.inputTokens,
              outputTokens: fact.outputTokens,
              cachedInputTokens: fact.cachedInputTokens,
              contextTokens: fact.contextTokens,
              contextWindow: fact.contextWindow,
              costUsd: fact.costUsd,
              scope: fact.scope
            }
          },
          fact
        )
      ]
    }
    if (fact.type === 'compact-start' || fact.type === 'compact-end') {
      this.compacting = fact.type === 'compact-start'
      return []
    }
    if (fact.type === 'run-end') {
      this.runOutcome = fact.outcome
      return []
    }
    if (fact.type === 'observer-degraded') {
      return [
        this.event(
          {
            kind: 'observer.degraded',
            payload: {
              reason: `pi-${fact.reason}`,
              remaining: PI_OBSERVER_CAPABILITIES
            }
          },
          fact
        )
      ]
    }
    if (fact.type === 'run-settled') return this.settle(fact)
    if (fact.type === 'session-shutdown') {
      this.resetRun()
      return []
    }
    return []
  }

  private settle(fact: PiNativeFact): AdapterEvent[] {
    if (!this.activeTurnId || this.compacting) return []
    const turnId = this.activeTurnId
    const events: AdapterEvent[] = []
    if (this.thinking) {
      events.push(
        this.event(
          { kind: 'thinking.completed', payload: { turnId } },
          fact,
          'thinking-completed'
        )
      )
    }
    for (const [callId, tool] of this.tools) {
      if (tool.terminal) continue
      events.push(
        this.event(
          {
            kind: 'tool.failed',
            payload: { callId, message: 'Pi tool ended without a result' }
          },
          fact,
          `tool-${callId}-closed`
        )
      )
    }
    events.push(
      this.event(
        this.runOutcome === 'failed'
          ? {
              kind: 'turn.failed',
              payload: { turnId, message: 'Pi run failed' }
            }
          : {
              kind: 'turn.completed',
              payload: {
                turnId,
                outcome:
                  this.runOutcome === 'cancelled' ? 'cancelled' : 'completed'
              }
            },
        fact,
        'settled'
      )
    )
    this.resetRun()
    return events
  }

  private event(
    event: AdapterEvent,
    fact: PiNativeFact,
    suffix?: string
  ): AdapterEvent {
    return {
      ...event,
      nativeId: `pi:${fact.generation}:${fact.seq}${suffix ? `:${suffix}` : ''}`,
      nativeType: fact.nativeType
    }
  }

  private closeRunCorrelation(): void {
    this.activeTurnId = undefined
    this.thinking = false
    this.runOutcome = 'completed'
    this.compacting = false
    this.tools.clear()
  }

  private resetRun(): void {
    this.closeRunCorrelation()
    this.runCounter = 0
  }
}
