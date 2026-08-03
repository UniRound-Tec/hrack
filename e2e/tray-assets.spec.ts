import { expect, test } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { PNG } from 'pngjs'

const trayRoot = resolve(__dirname, '../resources/tray')

function readPng(name: string): PNG {
  return PNG.sync.read(readFileSync(resolve(trayRoot, name)))
}

test('Ammonite V tray assets keep identical black/white alpha at 1x and 2x', () => {
  for (const size of [16, 32]) {
    const black = readPng(`vibing-${size}.png`)
    const white = readPng(`vibing-white-${size}.png`)
    const template = readPng(`vibingTemplate-${size}.png`)

    expect([black.width, black.height]).toEqual([size, size])
    expect([white.width, white.height]).toEqual([size, size])
    expect([template.width, template.height]).toEqual([size, size])

    let opaquePixels = 0
    for (let offset = 0; offset < black.data.length; offset += 4) {
      const alpha = black.data[offset + 3]
      expect(white.data[offset + 3]).toBe(alpha)
      expect(template.data[offset + 3]).toBe(alpha)
      if (alpha === 0) continue
      opaquePixels++
      expect([...black.data.subarray(offset, offset + 3)]).toEqual([0, 0, 0])
      expect([...white.data.subarray(offset, offset + 3)]).toEqual([
        255, 255, 255
      ])
    }
    expect(opaquePixels).toBeGreaterThan(size * 2)
  }
})
