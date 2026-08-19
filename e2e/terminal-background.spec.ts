import { expect, test } from '@playwright/test'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TerminalBackgroundStore } from '../electron/terminal-background'
import {
  hasTerminalBackground,
  terminalBackgroundLayerCss,
  terminalBackgroundUrl
} from '../shared/terminal-background'

const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
)

test('maps fit modes to CSS background values', () => {
  expect(terminalBackgroundLayerCss('cover')).toMatchObject({
    backgroundSize: 'cover',
    backgroundRepeat: 'no-repeat'
  })
  expect(terminalBackgroundLayerCss('fill')).toMatchObject({
    backgroundSize: '100% 100%'
  })
  expect(terminalBackgroundLayerCss('tile')).toMatchObject({
    backgroundRepeat: 'repeat'
  })
  expect(hasTerminalBackground('', 1)).toBe(false)
  expect(hasTerminalBackground('wall.png', 0)).toBe(false)
  expect(hasTerminalBackground('wall.png', 3)).toBe(true)
  expect(terminalBackgroundUrl(3)).toContain('v=3')
})

test('copies a picked image into userData and can clear it', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hrack-bg-'))
  const source = join(directory, 'wallpaper.png')
  await writeFile(source, PNG_1X1)
  const store = new TerminalBackgroundStore(join(directory, 'store'))

  const imported = await store.importFile(source)
  expect(imported.name).toBe('wallpaper.png')
  expect(imported.revision).toBeGreaterThan(0)
  expect(await store.currentFile()).toMatchObject({
    mime: 'image/png'
  })

  await store.clear()
  expect(await store.currentFile()).toBeNull()
})

test('rejects unsupported files and oversized images', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hrack-bg-'))
  const store = new TerminalBackgroundStore(join(directory, 'store'))
  const textFile = join(directory, 'notes.txt')
  await writeFile(textFile, 'not an image')
  await expect(store.importFile(textFile)).rejects.toThrow('unsupported-image-type')

  const huge = join(directory, 'huge.png')
  await writeFile(huge, Buffer.alloc(16 * 1024 * 1024 + 1))
  await expect(store.importFile(huge)).rejects.toThrow('image-too-large')
})
