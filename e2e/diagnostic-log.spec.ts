import { expect, test } from '@playwright/test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DiagnosticLog } from '../electron/diagnostics/DiagnosticLog'

test('clearing during log rotation removes old writes and preserves new writes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hrack-log-clear-'))
  const path = join(directory, 'diagnostics.jsonl')
  // Force the next append into real asynchronous rotation, with no mocked I/O.
  await writeFile(path, ' '.repeat(2 * 1024 * 1024))
  const log = new DiagnosticLog(path)
  const pending = log as unknown as { writeQueue: Promise<void> }
  try {
    log.append('info', 'test', 'before clear')
    await Promise.resolve()
    const cleared = log.clear()
    log.append('info', 'test', 'after clear')
    await cleared
    await pending.writeQueue
    expect(log.snapshot().entries.map((entry) => entry.message)).toEqual(['after clear'])
    expect(new DiagnosticLog(path).snapshot().entries.map((entry) => entry.message))
      .toEqual(['after clear'])
  } finally {
    await pending.writeQueue
    await rm(path, { force: true })
    await rm(`${path}.1`, { force: true })
    const { rmdir } = await import('node:fs/promises')
    await rmdir(directory)
  }
})
