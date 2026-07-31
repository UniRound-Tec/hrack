import { expect, test } from '@playwright/test'
import { PtyDataQueue } from '../electron/pty/PtyDataQueue'

function bytes(length: number): Uint8Array {
  return new Uint8Array(length)
}

test('pauses at the high-water mark and resumes after acknowledgements reach the low-water mark', () => {
  const sent: Uint8Array[] = []
  let pauseCount = 0
  let resumeCount = 0
  const queue = new PtyDataQueue({
    highWaterMarkBytes: 8,
    lowWaterMarkBytes: 2,
    maxBufferedBytes: 16,
    send: (data) => sent.push(data),
    pause: () => pauseCount++,
    resume: () => resumeCount++
  })

  queue.push(bytes(4))
  queue.push(bytes(4))
  queue.push(bytes(4))

  expect(sent.map((chunk) => chunk.byteLength)).toEqual([4, 4])
  expect(queue.snapshot()).toMatchObject({
    unackedBytes: 8,
    queuedBytes: 4,
    paused: true
  })
  expect(pauseCount).toBe(1)

  queue.ack(6)

  expect(sent.map((chunk) => chunk.byteLength)).toEqual([4, 4, 4])
  expect(queue.snapshot()).toMatchObject({
    unackedBytes: 6,
    queuedBytes: 0,
    paused: false
  })
  expect(resumeCount).toBe(1)
})

test('never retains output beyond the configured memory limit', () => {
  const queue = new PtyDataQueue({
    highWaterMarkBytes: 8,
    lowWaterMarkBytes: 2,
    maxBufferedBytes: 12,
    send: () => {},
    pause: () => {},
    resume: () => {}
  })

  expect(queue.push(bytes(8))).toBe(true)
  expect(queue.push(bytes(4))).toBe(true)
  expect(queue.push(bytes(1))).toBe(false)

  expect(queue.snapshot()).toMatchObject({
    bufferedBytes: 12,
    maxObservedBufferedBytes: 12,
    overflowed: true,
    rejectedBytes: 1,
    paused: true
  })
})

test('stays paused when draining one queued chunk crosses the high-water mark', () => {
  let resumeCount = 0
  const queue = new PtyDataQueue({
    highWaterMarkBytes: 8,
    lowWaterMarkBytes: 2,
    maxBufferedBytes: 16,
    send: () => {},
    pause: () => {},
    resume: () => resumeCount++
  })

  queue.push(bytes(8))
  queue.push(bytes(8))
  queue.ack(6)

  expect(queue.snapshot()).toMatchObject({
    unackedBytes: 10,
    queuedBytes: 0,
    paused: true
  })
  expect(resumeCount).toBe(0)

  queue.ack(8)
  expect(queue.snapshot().paused).toBe(false)
  expect(resumeCount).toBe(1)
})
