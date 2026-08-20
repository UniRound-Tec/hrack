import type { AgentSessionRuntime } from '../agents/AgentSessionRuntime'
import type { PTYManager } from '../pty/PTYManager'
import {
  PTY_DATA_HIGH_WATER_MARK_BYTES,
  PTY_DATA_LOW_WATER_MARK_BYTES,
  PTY_DATA_MAX_BUFFERED_BYTES,
  PtyDataQueue
} from '../pty/PtyDataQueue'
import type {
  RemoteDrivenPty,
  RemotePtyHost
} from './RemoteDesktopClient'
import {
  REMOTE_PROTOCOL_LIMITS,
  type RemotePtyHistoryEvent,
  type RemotePtyHistorySnapshot
} from '../../shared/remote-protocol'

const REMOTE_HISTORY_SOURCE_BYTES = 768 * 1024
const REMOTE_HISTORY_SOURCE_EVENTS = 8_000

function splitUtf8Text(text: string, maxBytes: number): string[] {
  const chunks: string[] = []
  let chunk = ''
  let bytes = 0
  for (const codePoint of text) {
    const size = Buffer.byteLength(codePoint)
    if (chunk && bytes + size > maxBytes) {
      chunks.push(chunk)
      chunk = ''
      bytes = 0
    }
    chunk += codePoint
    bytes += size
  }
  if (chunk) chunks.push(chunk)
  return chunks
}

function remoteHistory(
  history: ReturnType<PTYManager['history']>
): RemotePtyHistorySnapshot {
  if (!history) {
    return {
      complete: true,
      retainedOutputBytes: 0,
      droppedOutputBytes: 0,
      droppedEvents: 0,
      events: []
    }
  }
  const sourceEvents = [] as typeof history.events
  let retainedOutputBytes = 0
  for (let index = history.events.length - 1; index >= 0; index--) {
    if (sourceEvents.length >= REMOTE_HISTORY_SOURCE_EVENTS) break
    const event = history.events[index]
    if (!event) continue
    if (
      event.kind === 'output' &&
      retainedOutputBytes + event.byteLength > REMOTE_HISTORY_SOURCE_BYTES
    ) {
      break
    }
    sourceEvents.push(event)
    if (event.kind === 'output') retainedOutputBytes += event.byteLength
  }
  sourceEvents.reverse()
  const omittedCount = history.events.length - sourceEvents.length
  const omittedOutputBytes = history.events
    .slice(0, omittedCount)
    .reduce(
      (total, event) =>
        total + (event.kind === 'output' ? event.byteLength : 0),
      0
    )
  const events: RemotePtyHistoryEvent[] = []
  let sequence = 1
  for (const event of sourceEvents) {
    if (event.kind === 'resize') {
      events.push({
        sequence: sequence++,
        kind: 'resize',
        cols: event.cols,
        rows: event.rows
      })
      continue
    }
    for (const data of splitUtf8Text(
      event.data,
      REMOTE_PROTOCOL_LIMITS.ptyChunkBytes
    )) {
      events.push({
        sequence: sequence++,
        kind: 'output',
        data,
        byteLength: Buffer.byteLength(data)
      })
    }
  }
  return {
    complete: history.complete && omittedCount === 0,
    retainedOutputBytes,
    droppedOutputBytes: history.droppedOutputBytes + omittedOutputBytes,
    droppedEvents: history.droppedEvents + omittedCount,
    events
  }
}

export function runtimeRemotePtyHost(
  runtime: AgentSessionRuntime,
  manager: PTYManager
): RemotePtyHost {
  return {
    open(input, observer) {
      const record = runtime.getRecord(input.sessionId)
      if (!record) {
        const exited = runtime
          .listRecords({ includeExited: true })
          .some((candidate) => candidate.sessionId === input.sessionId)
        return { ok: false, reason: exited ? 'exited' : 'not-found' }
      }
      const ptyId = manager.ptyIdForTerminal(record.terminalId)
      if (!ptyId || !manager.isRunning(ptyId)) {
        return { ok: false, reason: 'exited' }
      }
      const owner = Symbol(`remote-drive:${input.sessionId}`)
      if (
        !manager.acquireRemoteResize(
          ptyId,
          owner,
          input.cols,
          input.rows
        )
      ) {
        return { ok: false, reason: 'busy' }
      }
      let released = false
      let ready = false
      let exitedDuringOpen = false
      let unsubscribeOutput = (): void => {}
      let unsubscribeExit = (): void => {}
      const outputQueue = new PtyDataQueue({
        highWaterMarkBytes: PTY_DATA_HIGH_WATER_MARK_BYTES,
        lowWaterMarkBytes: PTY_DATA_LOW_WATER_MARK_BYTES,
        maxBufferedBytes: PTY_DATA_MAX_BUFFERED_BYTES,
        send: observer.onOutput,
        pause: () => manager.pauseOutput(ptyId, owner),
        resume: () => manager.resumeOutput(ptyId, owner)
      })
      const release = (): void => {
        if (released) return
        released = true
        unsubscribeOutput()
        unsubscribeExit()
        outputQueue.dispose()
        manager.releaseRemoteResize(ptyId, owner)
      }
      unsubscribeOutput = manager.onOutput(ptyId, (data) => {
        for (
          let offset = 0;
          offset < data.byteLength;
          offset += REMOTE_PROTOCOL_LIMITS.ptyChunkBytes
        ) {
          const accepted = outputQueue.push(
            data.slice(
              offset,
              offset + REMOTE_PROTOCOL_LIMITS.ptyChunkBytes
            )
          )
          if (accepted) continue
          observer.onOverflow()
          release()
          return
        }
      })
      unsubscribeExit = manager.onExit(ptyId, (payload) => {
        if (!ready) {
          exitedDuringOpen = true
          release()
          return
        }
        observer.onExit(payload)
        release()
      })
      if (exitedDuringOpen) return { ok: false, reason: 'exited' }
      const target: RemoteDrivenPty = {
        sessionId: input.sessionId,
        terminalId: record.terminalId,
        history: remoteHistory(manager.history(ptyId)),
        write: (data) => manager.write(ptyId, data),
        resize: (cols, rows) =>
          manager.resizeRemote(ptyId, owner, cols, rows),
        acknowledge: (bytes) => outputQueue.ack(bytes),
        release
      }
      ready = true
      return { ok: true, target }
    }
  }
}
