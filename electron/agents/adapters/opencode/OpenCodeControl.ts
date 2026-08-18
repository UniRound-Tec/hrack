import {
  OpenCodeTransportError,
  type OpenCodeTransport
} from './OpenCodeTransport'

type Transport = Pick<OpenCodeTransport, 'request'>
type PickNative = () => Promise<string>

function missingEndpoint(error: unknown): boolean {
  return (
    error instanceof OpenCodeTransportError &&
    (error.status === 404 || error.code === 'not-api')
  )
}

function recordOf(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function encode(id: string): string {
  return encodeURIComponent(id)
}

async function firstOk<T>(
  attempts: Array<() => Promise<T>>
): Promise<T> {
  let lastError: unknown
  for (const attempt of attempts) {
    try {
      return await attempt()
    } catch (error) {
      if (!missingEndpoint(error)) throw error
      lastError = error
    }
  }
  throw lastError ?? new OpenCodeTransportError('http-status', 'missing', 404)
}

function unwrapList(value: unknown): unknown[] {
  if (Array.isArray(value)) return value
  const record = recordOf(value)
  if (Array.isArray(record?.data)) return record.data
  if (Array.isArray(record?.questions)) return record.questions
  return []
}

function sessionAgent(value: unknown): string | undefined {
  const record = recordOf(value)
  const nested = recordOf(record?.data)
  const agent = record?.agent ?? nested?.agent
  return typeof agent === 'string' && agent.trim() ? agent.trim() : undefined
}

function discoverAgentWrite(
  doc: unknown
): { method: 'POST' | 'PATCH'; path: string } | null {
  const record = recordOf(doc)
  const paths = recordOf(record?.paths)
  if (!paths) return null
  for (const [rawPath, spec] of Object.entries(paths)) {
    if (!/session\/\{[^}]+}\/agent$/i.test(rawPath)) continue
    const methods = recordOf(spec)
    if (!methods) continue
    if (recordOf(methods.post)) return { method: 'POST', path: rawPath }
    if (recordOf(methods.patch)) return { method: 'PATCH', path: rawPath }
  }
  return null
}

function bindPath(template: string, nativeId: string): string {
  return template.replace(/\{[^}]+\}/, encode(nativeId))
}

async function readSessionAgent(
  transport: Transport,
  nativeId: string
): Promise<string | undefined> {
  const encoded = encode(nativeId)
  try {
    return sessionAgent(
      await firstOk([
        () => transport.request('GET', `/session/${encoded}`),
        () => transport.request('GET', `/api/session/${encoded}`)
      ])
    )
  } catch {
    return undefined
  }
}

export async function setOpenCodeTitle(
  transport: Transport,
  pickNativeSessionId: PickNative,
  title: string
): Promise<void> {
  const nativeId = await pickNativeSessionId()
  const encoded = encode(nativeId)
  await firstOk([
    () => transport.request('PATCH', `/session/${encoded}`, { title }),
    () => transport.request('POST', `/session/${encoded}/rename`, { title })
  ])
}

export async function setOpenCodeAgent(
  transport: Transport,
  pickNativeSessionId: PickNative,
  agent: 'plan' | 'build'
): Promise<void> {
  const nativeId = await pickNativeSessionId()
  const encoded = encode(nativeId)

  try {
    const doc = await transport.request('GET', '/doc')
    const discovered = discoverAgentWrite(doc)
    if (discovered) {
      await transport.request(
        discovered.method,
        bindPath(discovered.path, nativeId),
        { agent }
      )
      return
    }
  } catch (error) {
    if (!missingEndpoint(error)) {
      // /doc is optional discovery; keep trying known write paths.
    }
  }

  try {
    await firstOk([
      () =>
        transport.request('POST', `/api/session/${encoded}/agent`, { agent }),
      () => transport.request('POST', `/session/${encoded}/agent`, { agent })
    ])
    return
  } catch (error) {
    if (!missingEndpoint(error)) throw error
  }

  const before = await readSessionAgent(transport, nativeId)
  if (before?.toLowerCase() === agent) return

  let last = before
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      await transport.request('POST', '/tui/execute-command', {
        command: 'agent_cycle'
      })
    } catch (error) {
      if (missingEndpoint(error)) {
        throw new Error(
          'OpenCode has no write API to set plan/build; TUI is still available'
        )
      }
      throw error
    }
    last = await readSessionAgent(transport, nativeId)
    if (last?.toLowerCase() === agent) return
  }

  throw new Error(
    last
      ? `OpenCode TUI agent stayed ${last}; could not switch to ${agent}`
      : 'OpenCode has no write API to set plan/build; TUI is still available'
  )
}

export async function respondOpenCodePermission(
  transport: Transport,
  pickNativeSessionId: PickNative,
  nativePermissionId: string,
  response: 'once' | 'always' | 'reject'
): Promise<void> {
  const nativeId = await pickNativeSessionId()
  const session = encode(nativeId)
  const permission = encode(nativePermissionId)
  await firstOk([
    () =>
      transport.request(
        'POST',
        `/session/${session}/permissions/${permission}`,
        { response }
      ),
    () =>
      transport.request('POST', `/permission/${permission}/reply`, {
        reply: response
      }),
    () =>
      transport.request(
        'POST',
        `/api/session/${session}/permission/${permission}/reply`,
        { reply: response }
      )
  ])
}

export async function listOpenCodeQuestions(
  transport: Transport,
  pickNativeSessionId: PickNative
): Promise<unknown[]> {
  const nativeId = await pickNativeSessionId()
  const encoded = encode(nativeId)
  let lastError: unknown
  let empty: unknown[] = []
  for (const attempt of [
    () => transport.request('GET', '/question'),
    () => transport.request('GET', `/session/${encoded}/question`),
    () => transport.request('GET', `/api/session/${encoded}/question`)
  ]) {
    try {
      const items = unwrapList(await attempt())
      if (items.length > 0) {
        return items.filter((item) => {
          const sessionId = recordOf(item)?.sessionID
          return typeof sessionId !== 'string' || sessionId === nativeId
        })
      }
      empty = items
    } catch (error) {
      if (!missingEndpoint(error)) throw error
      lastError = error
    }
  }
  if (empty.length === 0 && lastError) throw lastError
  return empty
}

export async function answerOpenCodeQuestion(
  transport: Transport,
  pickNativeSessionId: PickNative,
  nativeQuestionId: string,
  answers: unknown
): Promise<void> {
  const nativeId = await pickNativeSessionId()
  const session = encode(nativeId)
  const question = encode(nativeQuestionId)
  await firstOk([
    () => transport.request('POST', `/question/${question}/reply`, answers),
    () =>
      transport.request(
        'POST',
        `/session/${session}/question/${question}/reply`,
        answers
      ),
    () =>
      transport.request(
        'POST',
        `/api/session/${session}/question/${question}/reply`,
        answers
      )
  ])
}

export async function rejectOpenCodeQuestion(
  transport: Transport,
  pickNativeSessionId: PickNative,
  nativeQuestionId: string
): Promise<void> {
  const nativeId = await pickNativeSessionId()
  const session = encode(nativeId)
  const question = encode(nativeQuestionId)
  await firstOk([
    () => transport.request('POST', `/question/${question}/reject`),
    () =>
      transport.request(
        'POST',
        `/session/${session}/question/${question}/reject`
      ),
    () =>
      transport.request(
        'POST',
        `/api/session/${session}/question/${question}/reject`
      )
  ])
}
