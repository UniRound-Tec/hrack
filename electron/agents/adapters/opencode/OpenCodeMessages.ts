import type { BridgeDelta, BridgeToolDelta } from '../../../../shared/bridge-protocol'
import { emptyDelta, truncateDelta } from '../../../bridge/delta'

function recordOf(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function textOf(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function unwrapList(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw
  const record = recordOf(raw)
  if (!record) return []
  if (Array.isArray(record.data)) return record.data
  if (Array.isArray(record.messages)) return record.messages
  return []
}

export interface SnapshotTextPart {
  key: string
  messageId: string
  text: string
}

export interface SnapshotToolPart {
  key: string
  callId: string
  name: string
  state: string
  input?: unknown
  output?: unknown
  error?: string
}

export interface SnapshotMessage {
  id: string
  role: 'user' | 'assistant' | 'unknown'
  texts: SnapshotTextPart[]
  tools: SnapshotToolPart[]
}

export interface MessageCursor {
  keys: string[]
}

function roleOf(value: unknown): SnapshotMessage['role'] {
  const role = textOf(value)?.toLowerCase()
  if (role === 'user' || role === 'assistant') return role
  return 'unknown'
}

function toolState(raw: Record<string, unknown> | null): {
  state: string
  input?: unknown
  output?: unknown
  error?: string
} {
  if (!raw) return { state: 'unknown' }
  const nested = recordOf(raw.state) ?? raw
  const status = textOf(nested.status ?? nested.state)?.toLowerCase() ?? 'unknown'
  const error =
    textOf(nested.error) ??
    textOf(recordOf(nested.error)?.message) ??
    textOf(nested.errorText)
  return {
    state: status,
    input: nested.input ?? nested.args,
    output: nested.output ?? nested.result,
    ...(error ? { error } : {})
  }
}

function parsePart(
  messageId: string,
  part: unknown,
  index: number
): { text?: SnapshotTextPart; tool?: SnapshotToolPart } | null {
  const raw = recordOf(part)
  if (!raw) return null
  const type = textOf(raw.type ?? raw.kind)?.toLowerCase()
  if (
    type === 'reasoning' ||
    type === 'thinking' ||
    type === 'step-start' ||
    type === 'step-finish' ||
    type === 'step_start' ||
    type === 'step_finish'
  ) {
    return null
  }
  if (type === 'text' || type === 'output-text' || raw.text) {
    const text = textOf(raw.text) ?? textOf(raw.content) ?? ''
    if (!text) return null
    const partId = textOf(raw.id) ?? String(index)
    return {
      text: {
        key: `text:${messageId}:${partId}`,
        messageId,
        text
      }
    }
  }
  if (type === 'tool' || raw.tool || raw.callID || raw.callId) {
    const callId =
      textOf(raw.callID) ?? textOf(raw.callId) ?? textOf(raw.id) ?? `${messageId}:${index}`
    const name =
      textOf(raw.tool) ?? textOf(raw.name) ?? textOf(raw.toolName) ?? 'tool'
    const state = toolState(raw)
    return {
      tool: {
        key: `tool:${callId}:${state.state}:${state.error ?? ''}:${JSON.stringify(state.output) ?? ''}`,
        callId,
        name,
        state: state.state,
        input: state.input,
        output: state.output,
        ...(state.error ? { error: state.error } : {})
      }
    }
  }
  return null
}

export function parseOpenCodeMessages(raw: unknown): SnapshotMessage[] {
  const messages: SnapshotMessage[] = []
  for (const item of unwrapList(raw)) {
    const record = recordOf(item)
    if (!record) continue
    const info = recordOf(record.info) ?? record
    const id = textOf(info.id) ?? textOf(record.id)
    if (!id) continue
    const partsRaw = Array.isArray(record.parts)
      ? record.parts
      : Array.isArray(info.parts)
        ? info.parts
        : []
    const message: SnapshotMessage = {
      id,
      role: roleOf(info.role ?? record.role),
      texts: [],
      tools: []
    }
    for (let index = 0; index < partsRaw.length; index++) {
      const parsed = parsePart(id, partsRaw[index], index)
      if (!parsed) continue
      if (parsed.text) message.texts.push(parsed.text)
      if (parsed.tool) message.tools.push(parsed.tool)
    }
    messages.push(message)
  }
  return messages
}

function toolsFrom(
  messages: readonly SnapshotMessage[]
): BridgeToolDelta[] {
  const tools: BridgeToolDelta[] = []
  const seen = new Map<string, number>()
  for (const message of messages) {
    for (const tool of message.tools) {
      const entry: BridgeToolDelta = {
        name: tool.name,
        callId: tool.callId,
        ...(tool.input !== undefined ? { input: tool.input } : {}),
        ...(tool.output !== undefined ? { output: tool.output } : {}),
        ...(tool.error ? { error: tool.error } : {})
      }
      const existing = seen.get(tool.callId)
      if (existing === undefined) {
        seen.set(tool.callId, tools.length)
        tools.push(entry)
      } else {
        tools[existing] = { ...tools[existing], ...entry }
      }
    }
  }
  return tools
}

function textsFrom(messages: readonly SnapshotMessage[]): string {
  return messages
    .filter((message) => message.role === 'assistant')
    .flatMap((message) => message.texts.map((part) => part.text))
    .join('')
}

function toDelta(messages: readonly SnapshotMessage[]): BridgeDelta {
  return truncateDelta({
    text: textsFrom(messages),
    tools: toolsFrom(messages)
  })
}

function lastUserIndex(messages: readonly SnapshotMessage[]): number {
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index].role === 'user') return index
  }
  return -1
}

export function extractLastClosedTurn(
  messages: readonly SnapshotMessage[]
): BridgeDelta {
  const start = lastUserIndex(messages)
  if (start < 0) return emptyDelta()
  const slice = messages.slice(start)
  const hasAssistant = slice.some((message) => message.role === 'assistant')
  const running = slice.some((message) =>
    message.tools.some(
      (tool) => tool.state === 'pending' || tool.state === 'running'
    )
  )
  if (!hasAssistant || running) return emptyDelta()
  return toDelta(slice)
}

export function extractTurnSoFar(
  messages: readonly SnapshotMessage[]
): BridgeDelta {
  const start = lastUserIndex(messages)
  if (start < 0) return toDelta(messages.filter((message) => message.role === 'assistant'))
  return toDelta(messages.slice(start))
}

export function collectKeys(messages: readonly SnapshotMessage[]): string[] {
  return messages.flatMap((message) => [
    ...message.texts.map((part) => part.key),
    ...message.tools.map((part) => part.key)
  ])
}

/** Keys of every part before the latest user turn, so an in-flight turn stays visible. */
export function cursorBeforeLastTurn(
  messages: readonly SnapshotMessage[]
): MessageCursor {
  const start = lastUserIndex(messages)
  if (start < 0) return { keys: collectKeys(messages) }
  return { keys: collectKeys(messages.slice(0, start)) }
}

export function extractSinceCursor(
  messages: readonly SnapshotMessage[],
  cursor: MessageCursor | undefined
): { delta: BridgeDelta; cursor: MessageCursor } {
  const seen = new Set(cursor?.keys ?? [])
  const fresh: SnapshotMessage[] = []
  for (const message of messages) {
    const texts = message.texts.filter((part) => !seen.has(part.key))
    const tools = message.tools.filter((part) => !seen.has(part.key))
    if (texts.length === 0 && tools.length === 0) continue
    fresh.push({ ...message, texts, tools })
  }
  return {
    delta: toDelta(fresh),
    cursor: { keys: collectKeys(messages) }
  }
}

export function emptyCursor(): MessageCursor {
  return { keys: [] }
}
