import {
  OpenCodeTransportError,
  type OpenCodeTransport
} from './OpenCodeTransport'

function missingEndpoint(error: unknown): boolean {
  return error instanceof OpenCodeTransportError && error.status === 404
}

/**
 * 可见 TUI 与 HTTP session 不是同一条渲染路径：
 * POST /session/:id/prompt_async 会跑模型，但 OpenTUI 不画这些消息。
 * 先走 /tui/append-prompt + /tui/submit-prompt，人才能在 tab 里看见。
 */
export async function submitOpenCodePrompt(
  transport: Pick<OpenCodeTransport, 'request'>,
  pickNativeSessionId: () => Promise<string>,
  text: string,
  agent?: string
): Promise<void> {
  try {
    await transport.request('POST', '/tui/clear-prompt', {})
    await transport.request('POST', '/tui/append-prompt', { text })
    await transport.request('POST', '/tui/submit-prompt', {})
    return
  } catch (error) {
    if (!missingEndpoint(error)) throw error
  }

  const nativeId = await pickNativeSessionId()
  const encoded = encodeURIComponent(nativeId)
  const body = {
    parts: [{ type: 'text' as const, text }],
    ...(agent ? { agent } : {})
  }
  try {
    await transport.request('POST', `/session/${encoded}/prompt_async`, body)
  } catch (error) {
    if (!missingEndpoint(error)) throw error
    await transport.request('POST', `/session/${encoded}/message`, {
      ...body,
      noReply: true
    })
  }
}
