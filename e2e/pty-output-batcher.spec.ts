import { expect, test } from '@playwright/test'
import { PtyOutputBatcher } from '../src/terminal/PtyOutputBatcher'

test('coalesces split PTY repaint chunks and acknowledges after one parse', () => {
  const writes: Uint8Array[] = []
  const parsedCallbacks: Array<() => void> = []
  const acknowledgements: number[] = []
  const batcher = new PtyOutputBatcher({
    quietPeriodMs: 1_000,
    maxPeriodMs: 2_000,
    write(data, onParsed) {
      writes.push(data)
      parsedCallbacks.push(onParsed)
    },
    acknowledge(bytes) {
      acknowledgements.push(bytes)
    }
  })

  batcher.push(new Uint8Array([0x1b, 0x5b, 0x48]))
  batcher.push(new Uint8Array([0x1b, 0x5b, 0x4a]))

  expect(writes).toHaveLength(0)
  batcher.flush()
  expect(writes).toHaveLength(1)
  expect([...writes[0]]).toEqual([0x1b, 0x5b, 0x48, 0x1b, 0x5b, 0x4a])
  expect(acknowledgements).toEqual([])

  parsedCallbacks[0]()
  expect(acknowledgements).toEqual([6])
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
