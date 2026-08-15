export interface PiExtensionSourceOptions {
  supportsAgentSettled: boolean
}

/**
 * Build a self-contained Pi extension. The generated source deliberately uses
 * only Node built-ins and never serializes native event/message/tool objects.
 */
export function buildPiExtensionSource(
  options: PiExtensionSourceOptions
): string {
  const settleRegistration = options.supportsAgentSettled
    ? `pi.on('agent_settled', (_event, ctx) => settle(ctx))`
    : ''
  const compatibilitySettle = options.supportsAgentSettled
    ? ''
    : `setTimeout(() => compatibilitySettle(ctx, epoch, 0), 25)`

  return `import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'

const MAX_EVENT_BYTES = 64 * 1024
const MAX_TEXT = 128
const MAX_SETTLE_ATTEMPTS = 40

function safeText(value, max = MAX_TEXT) {
  if (typeof value !== 'string') return undefined
  const text = value.replace(/[\\u0000-\\u001f\\u007f]/g, '').trim()
  return text && text.length <= max ? text : undefined
}

function safeNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : undefined
}

export default function hrackPiObserver(pi) {
  const dropDir = process.env.HRACK_PI_DROP_DIR
  const sessionId = safeText(process.env.HRACK_PI_SESSION_ID)
  if (!dropDir || !sessionId) return
  try {
    mkdirSync(dropDir, { recursive: true, mode: 0o700 })
  } catch {
    return
  }

  const generation = randomBytes(12).toString('hex')
  let seq = 0
  let thinking = false
  let compacting = false
  let runOutcome = 'completed'
  let runEpoch = 0
  let awaitingRetry = false
  let lastUsageAt = 0
  const activeTools = new Map()
  const progressAt = new Map()

  function emit(type, payload = {}) {
    const envelope = {
      schema: 1,
      sessionId,
      generation,
      seq: ++seq,
      emittedAt: Date.now(),
      type,
      payload
    }
    let json
    try {
      json = JSON.stringify(envelope)
    } catch {
      return
    }
    if (!json || Buffer.byteLength(json, 'utf8') > MAX_EVENT_BYTES) return
    const nonce = randomBytes(8).toString('hex')
    const prefix = String(envelope.seq).padStart(12, '0')
    const temp = join(dropDir, \`.\${prefix}.\${nonce}.partial\`)
    const finalPath = join(dropDir, \`\${prefix}.\${nonce}.json\`)
    try {
      writeFileSync(temp, json, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
      renameSync(temp, finalPath)
    } catch {
      try { rmSync(temp, { force: true }) } catch {}
    }
  }

  function usagePayload(message, scope = 'turn') {
    const usage = message && typeof message === 'object' ? message.usage : undefined
    if (!usage || typeof usage !== 'object') return undefined
    const inputTokens = safeNumber(usage.input)
    const outputTokens = safeNumber(usage.output)
    const cachedInputTokens = safeNumber(usage.cacheRead)
    const cost = usage.cost && typeof usage.cost === 'object' ? usage.cost : undefined
    const costUsd = safeNumber(cost && cost.total)
    if (
      inputTokens === undefined &&
      outputTokens === undefined &&
      cachedInputTokens === undefined &&
      costUsd === undefined
    ) return undefined
    return { inputTokens, outputTokens, cachedInputTokens, costUsd, scope }
  }

  function emitContextUsage(ctx) {
    let usage
    try { usage = ctx.getContextUsage && ctx.getContextUsage() } catch { return }
    if (!usage || typeof usage !== 'object') return
    const contextTokens = safeNumber(usage.tokens)
    const contextWindow = safeNumber(usage.contextWindow)
    if (contextTokens === undefined && contextWindow === undefined) return
    emit('usage', { contextTokens, contextWindow, scope: 'turn' })
  }

  function endThinking() {
    if (!thinking) return
    thinking = false
    emit('thinking-end')
  }

  function settle(ctx) {
    endThinking()
    emitContextUsage(ctx)
    emit('run-settled')
  }

  function compatibilitySettle(ctx, epoch, attempt) {
    if (epoch !== runEpoch) return
    let idle = false
    let pending = true
    try {
      idle = ctx.isIdle()
      pending = ctx.hasPendingMessages()
    } catch {
      return
    }
    if (idle && !pending && activeTools.size === 0 && !compacting) {
      settle(ctx)
      return
    }
    if (attempt + 1 >= MAX_SETTLE_ATTEMPTS) {
      emit('observer-degraded', { reason: 'settle-ambiguous' })
      return
    }
    setTimeout(() => compatibilitySettle(ctx, epoch, attempt + 1), 50)
  }

  pi.on('session_start', (event) => {
    runEpoch++
    awaitingRetry = false
    thinking = false
    compacting = false
    activeTools.clear()
    progressAt.clear()
    const reason = safeText(event && event.reason, 16)
    emit('session-start', { reason: reason || 'startup' })
  })

  pi.on('session_shutdown', (event) => {
    runEpoch++
    awaitingRetry = false
    endThinking()
    activeTools.clear()
    progressAt.clear()
    const reason = safeText(event && event.reason, 16)
    emit('session-shutdown', { reason: reason || 'quit' })
  })

  pi.on('agent_start', () => {
    const continuingRetry = awaitingRetry
    awaitingRetry = false
    runEpoch++
    runOutcome = 'completed'
    thinking = false
    compacting = false
    activeTools.clear()
    progressAt.clear()
    if (!continuingRetry) emit('run-start')
  })

  pi.on('agent_end', (event, ctx) => {
    const epoch = runEpoch
    awaitingRetry = event && event.willRetry === true
    emit('run-end', { outcome: runOutcome })
    if (!awaitingRetry) ${compatibilitySettle || '{}'}
  })

  ${settleRegistration}

  pi.on('message_update', (event) => {
    const update = event && event.assistantMessageEvent
    const type = safeText(update && update.type, 32)
    if (type === 'thinking_start') {
      if (!thinking) {
        thinking = true
        emit('thinking-start')
      }
    } else if (type === 'thinking_end') {
      endThinking()
    } else if (type === 'text_start') {
      endThinking()
      emit('responding')
    } else if (type === 'done') {
      endThinking()
      const usage = usagePayload(update && update.message)
      if (usage) emit('usage', usage)
    } else if (type === 'error') {
      endThinking()
      runOutcome = update && update.reason === 'aborted' ? 'cancelled' : 'failed'
    }

    const now = Date.now()
    if (now - lastUsageAt >= 1000) {
      const usage = usagePayload(event && event.message)
      if (usage && usage.outputTokens !== undefined) {
        lastUsageAt = now
        emit('usage', usage)
      }
    }
  })

  pi.on('turn_end', (event) => {
    const usage = usagePayload(event && event.message)
    if (usage) emit('usage', usage)
  })

  pi.on('tool_execution_start', (event) => {
    const callId = safeText(event && event.toolCallId)
    const toolName = safeText(event && event.toolName, 64)
    if (!callId || !toolName || activeTools.has(callId)) return
    endThinking()
    activeTools.set(callId, Date.now())
    emit('tool-start', { callId, toolName })
  })

  pi.on('tool_execution_update', (event) => {
    const callId = safeText(event && event.toolCallId)
    const toolName = safeText(event && event.toolName, 64)
    if (!callId || !toolName || !activeTools.has(callId)) return
    const now = Date.now()
    if (now - (progressAt.get(callId) || 0) < 250) return
    progressAt.set(callId, now)
    emit('tool-progress', { callId, toolName })
  })

  pi.on('tool_execution_end', (event) => {
    const callId = safeText(event && event.toolCallId)
    const toolName = safeText(event && event.toolName, 64)
    if (!callId || !toolName) return
    const startedAt = activeTools.get(callId)
    activeTools.delete(callId)
    progressAt.delete(callId)
    const durationMs = typeof startedAt === 'number'
      ? Math.max(0, Date.now() - startedAt)
      : undefined
    emit('tool-end', {
      callId,
      toolName,
      isError: event && event.isError === true,
      durationMs
    })
  })

  pi.on('session_before_compact', (event) => {
    compacting = true
    const reason = safeText(event && event.reason, 16)
    emit('compact-start', {
      reason: reason || 'manual',
      willRetry: event && event.willRetry === true
    })
  })

  pi.on('session_compact', (event) => {
    compacting = false
    const reason = safeText(event && event.reason, 16)
    emit('compact-end', {
      reason: reason || 'manual',
      willRetry: event && event.willRetry === true
    })
  })
}
`
}
