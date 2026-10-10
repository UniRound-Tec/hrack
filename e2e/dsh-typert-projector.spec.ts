import { expect, test } from '@playwright/test'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { WebSocket, WebSocketServer } from 'ws'
import { DshProjectionBridge } from '../electron/dsh-host/DshProjectionBridge'
import { DshSessionProjector } from '../electron/dsh-host/DshSessionProjector'

test('Typert observer restores live sessions, passes approvals through and reconciles reconnects', async () => {
  type Summary = { sessionId: string; cwd: string; running: boolean }
  let catalog: Summary[] = []
  let listCalls = 0
  let deferredList: (() => void) | undefined
  let deferNextList = false
  const results: unknown[] = []
  const opens: Array<{ socket: WebSocket; streamId: string; endpoint: string; payload: unknown }> = []
  const cancelled: string[] = []
  const connections: WebSocket[] = []
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks).toString())
    expect(request.headers.cookie).toBe('dsh-auth-test=observer')
    let value: unknown = {}
    if (request.url === '/api/session/list') {
      expect(body.payload).toEqual({ args: { _request: {} } })
      listCalls++
      value = { items: catalog.map((item) => ({ ...item })) }
      if (deferNextList) {
        deferNextList = false
        await new Promise<void>((resolve) => { deferredList = resolve })
      }
    } else if (request.url === '/api/$events/result') {
      results.push(body.payload.args)
    } else {
      response.writeHead(404).end()
      return
    }
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify({ result: { ok: true, value } }))
  })
  const wss = new WebSocketServer({ server, path: '/api/remote.mux' })
  const item = (socket: WebSocket, streamId: string, value: unknown) =>
    socket.send(JSON.stringify({ type: 'item', streamId, value }))
  wss.on('connection', (socket, request) => {
    expect(request.headers.cookie).toBe('dsh-auth-test=observer')
    connections.push(socket)
    socket.on('message', (raw) => {
      const frame = JSON.parse(raw.toString())
      if (frame.type === 'cancel') { cancelled.push(frame.streamId); return }
      opens.push({ socket, ...frame })
      if (frame.endpoint === '$events') {
        item(socket, frame.streamId, { type: 'ready', clientId: 'observer', host: { home: '/test' } })
      } else if (frame.endpoint === 'session/control') {
        item(socket, frame.streamId, { type: 'baseline', value: { projections: {}, jobs: {}, queues: {} } })
      } else if (frame.endpoint === 'session/follow') {
        item(socket, frame.streamId, { type: 'snapshot', records: [], cursor: -1 })
      }
    })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address() as { port: number }
  const bridge = new DshProjectionBridge({ broadcast: () => {} })
  const projector = new DshSessionProjector({
    getStatus: () => ({ state: 'ready', baseUrl: `http://127.0.0.1:${address.port}` }),
    rpcConvention: () => 'typert',
    loopbackSessionCookie: () => 'dsh-auth-test=observer'
  } as never, bridge)
  const emit = (event: string, ...args: unknown[]) =>
    item(connections.at(-1)!, 'events', { type: 'emit', event, args })
  try {
    projector.activateSlot('home')
    projector.start()
    await expect.poll(() => listCalls).toBe(2)
    const first = { sessionId: 'first', cwd: '/workspace/first', running: false }
    catalog.push(first)
    emit('api-session/added', first)
    await expect.poll(() => bridge.find('home')?.adapterSessionId).toBe('first')
    emit('api-session/status', 'first', true)
    await expect.poll(() => bridge.find('home')?.status).toBe('working')
    await expect.poll(() => opens.some((frame) => frame.endpoint === 'session/follow')).toBe(true)
    const follow = opens.find((frame) => frame.endpoint === 'session/follow')!
    expect(follow.payload).toEqual({ args: { request: {
      address: { kind: 'session', sessionId: 'first' }, maxMessages: 1
    } } })
    item(follow.socket, follow.streamId, { event: {
      type: 'tool/call', data: { callId: 'tool-1', name: 'bash' }
    } })
    await expect.poll(() => bridge.find('home')?.activeToolCount).toBe(1)
    item(connections.at(-1)!, 'control', { type: 'projection', sessionId: 'first', key: 'title', value: 'Renamed' })
    await expect.poll(() => bridge.find('home')?.name).toBe('Renamed')
    item(connections.at(-1)!, 'events', {
      type: 'waterfall', event: 'approval/request', eventId: 'approval-1', agentId: 'first', request: {}
    })
    await expect.poll(() => results).toEqual([
      { clientId: 'observer', eventId: 'approval-1', outcome: { kind: 'next' } }
    ])
    emit('api-session/status', 'first', false)
    await expect.poll(() => bridge.find('home')?.status).toBe('done')

    // A concurrent title frame must not hide fresh running state in the list.
    first.running = true
    deferNextList = true
    connections.at(-1)!.terminate()
    await expect.poll(() => connections.length).toBe(2)
    await expect.poll(() => Boolean(deferredList)).toBe(true)
    item(connections.at(-1)!, 'control', { type: 'projection', sessionId: 'first', key: 'title', value: 'Live title' })
    await expect.poll(() => bridge.find('home')?.name).toBe('Live title')
    deferredList!()
    deferredList = undefined
    await expect.poll(() => bridge.find('home')?.status).toBe('working')
    expect(bridge.find('home')?.name).toBe('Live title')

    // A stale list response must not erase additions or resurrect removals
    // that arrive after this connection's ready barrier.
    deferNextList = true
    connections.at(-1)!.terminate()
    await expect.poll(() => connections.length).toBe(3)
    await expect.poll(() => Boolean(deferredList)).toBe(true)
    emit('api-session/removed', 'first')
    emit('api-session/added', { sessionId: 'second', cwd: '/workspace/second', running: false })
    deferredList!()
    await expect.poll(() => bridge.find('home')?.adapterSessionId).toBe('second')
    expect(bridge.listActive().some((projection) => projection.adapterSessionId === 'first')).toBe(false)

    // A logical stream ending must reconnect even if its socket stays open.
    catalog = [{ sessionId: 'second', cwd: '/workspace/second', running: false }]
    connections.at(-1)!.send(JSON.stringify({ type: 'end', streamId: 'control' }))
    await expect.poll(() => connections.length).toBe(4)
    await expect.poll(() => listCalls).toBe(5)
    projector.unfollow('home')
    await expect.poll(() => cancelled.length).toBeGreaterThan(0)
    expect(bridge.listActive()).toEqual([])
  } finally {
    deferredList?.()
    projector.stop()
    for (const socket of connections) socket.terminate()
    wss.close()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})
