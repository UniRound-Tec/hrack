import {
  DELTA_PACKET_LIMIT_BYTES,
  DELTA_TEXT_LIMIT_BYTES,
  DELTA_TOOL_JSON_LIMIT_BYTES,
  DELTA_TOOL_LIMIT,
  type BridgeDelta,
  type BridgeToolDelta
} from '../../shared/bridge-protocol'

export function byteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8')
}

function sliceUtf8(value: string, maxBytes: number): string {
  if (byteLength(value) <= maxBytes) return value
  let end = Math.min(value.length, maxBytes)
  while (end > 0 && byteLength(value.slice(0, end)) > maxBytes) end--
  return value.slice(0, end)
}

export function headTailUtf8(value: string, maxBytes: number): string {
  if (byteLength(value) <= maxBytes) return value
  const marker = '\n…\n'
  const markerBytes = byteLength(marker)
  const budget = Math.max(0, maxBytes - markerBytes)
  const headBudget = Math.floor(budget / 2)
  const tailBudget = budget - headBudget
  const head = sliceUtf8(value, headBudget)
  let tailStart = value.length
  while (
    tailStart > 0 &&
    byteLength(value.slice(tailStart)) < tailBudget
  ) {
    tailStart--
  }
  while (
    tailStart < value.length &&
    byteLength(value.slice(tailStart)) > tailBudget
  ) {
    tailStart++
  }
  return `${head}${marker}${value.slice(tailStart)}`
}

function clipJson(value: unknown, limit: number): { value: unknown; truncated: boolean } {
  if (value === undefined) return { value, truncated: false }
  let encoded: string
  try {
    encoded = JSON.stringify(value) ?? 'null'
  } catch {
    return { value: '[unserializable]', truncated: true }
  }
  if (byteLength(encoded) <= limit) return { value, truncated: false }
  return { value: headTailUtf8(encoded, limit), truncated: true }
}

export function emptyDelta(): BridgeDelta {
  return { text: '', tools: [] }
}

export function isEmptyDelta(delta: BridgeDelta): boolean {
  return delta.text.length === 0 && delta.tools.length === 0
}

export function truncateDelta(delta: BridgeDelta): BridgeDelta {
  let truncated = Boolean(delta.truncated)
  let text = delta.text
  if (byteLength(text) > DELTA_TEXT_LIMIT_BYTES) {
    text = headTailUtf8(text, DELTA_TEXT_LIMIT_BYTES)
    truncated = true
  }

  let tools = delta.tools
  if (tools.length > DELTA_TOOL_LIMIT) {
    tools = tools.slice(0, DELTA_TOOL_LIMIT)
    truncated = true
  }

  const clippedTools: BridgeToolDelta[] = tools.map((tool) => {
    const input = clipJson(tool.input, DELTA_TOOL_JSON_LIMIT_BYTES)
    const output = clipJson(tool.output, DELTA_TOOL_JSON_LIMIT_BYTES)
    let error = tool.error
    if (error && byteLength(error) > DELTA_TOOL_JSON_LIMIT_BYTES) {
      error = headTailUtf8(error, DELTA_TOOL_JSON_LIMIT_BYTES)
      truncated = true
    }
    if (input.truncated || output.truncated) truncated = true
    return {
      name: tool.name,
      callId: tool.callId,
      ...(input.value !== undefined ? { input: input.value } : {}),
      ...(output.value !== undefined ? { output: output.value } : {}),
      ...(error ? { error } : {})
    }
  })

  const next: BridgeDelta = {
    text,
    tools: clippedTools,
    ...(truncated ? { truncated: true } : {})
  }

  while (byteLength(JSON.stringify(next)) > DELTA_PACKET_LIMIT_BYTES) {
    if (next.tools.length > 1) {
      next.tools = next.tools.slice(0, Math.max(1, next.tools.length - 1))
      next.truncated = true
      continue
    }
    if (next.text.length > 0) {
      const smaller = Math.max(64, Math.floor(byteLength(next.text) / 2))
      next.text = headTailUtf8(next.text, smaller)
      next.truncated = true
      continue
    }
    break
  }
  return next
}

export function mergeDeltas(base: BridgeDelta, extra: BridgeDelta): BridgeDelta {
  const tools = [...base.tools]
  const seen = new Map(tools.map((tool, index) => [tool.callId, index]))
  for (const tool of extra.tools) {
    const existing = seen.get(tool.callId)
    if (existing === undefined) {
      seen.set(tool.callId, tools.length)
      tools.push(tool)
    } else {
      tools[existing] = { ...tools[existing], ...tool }
    }
  }
  const text = [base.text, extra.text].filter(Boolean).join(base.text && extra.text ? '\n' : '')
  return truncateDelta({
    text,
    tools,
    truncated: base.truncated || extra.truncated
  })
}
