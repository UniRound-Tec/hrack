import { expect, test } from '@playwright/test'
import { PtyOutputBatcher } from '../src/terminal/PtyOutputBatcher'

test('keeps split synchronized repaints atomic and commits them on one paint', () => {
  const writes: Uint8Array[] = []
  const parsedCallbacks: Array<() => void> = []
  const acknowledgements: number[] = []
  const paintCallbacks: Array<() => void> = []
  const encoder = new TextEncoder()
  const batcher = new PtyOutputBatcher({
    quietPeriodMs: 1_000,
    maxPeriodMs: 2_000,
    write(data, onParsed) {
      writes.push(data)
      parsedCallbacks.push(onParsed)
    },
    acknowledge(bytes) {
      acknowledgements.push(bytes)
    },
    scheduleFlush(callback) {
      paintCallbacks.push(callback)
      return () => {
        const index = paintCallbacks.indexOf(callback)
        if (index >= 0) paintCallbacks.splice(index, 1)
      }
    }
  })

  batcher.push(encoder.encode('\x1b[?2026hfirst'))
  expect(paintCallbacks).toHaveLength(0)
  batcher.push(encoder.encode(' frame\x1b[?2026l'))
  expect(paintCallbacks).toHaveLength(1)
  batcher.push(encoder.encode('\x1b[?2026hsecond frame\x1b[?2026l'))

  expect(writes).toHaveLength(0)
  expect(paintCallbacks).toHaveLength(1)
  paintCallbacks.shift()?.()
  expect(writes).toHaveLength(1)
  const expected =
    '\x1b[?2026hfirst frame\x1b[?2026l\x1b[?2026hsecond frame\x1b[?2026l'
  expect(new TextDecoder().decode(writes[0])).toBe(expected)
  expect(acknowledgements).toEqual([])

  parsedCallbacks[0]()
  expect(acknowledgements).toEqual([encoder.encode(expected).byteLength])
  batcher.dispose()
})

test('dispose releases pending backpressure without writing into a dead terminal', () => {
  const writes: Uint8Array[] = []
  const acknowledgements: number[] = []
  const batcher = new PtyOutputBatcher({
    quietPeriodMs: 1_000,
    maxPeriodMs: 2_000,
    write(data) {
      writes.push(data)
    },
    acknowledge(bytes) {
      acknowledgements.push(bytes)
    }
  })

  batcher.push(new Uint8Array([1, 2, 3]))
  batcher.dispose()

  expect(writes).toEqual([])
  expect(acknowledgements).toEqual([3])
})
