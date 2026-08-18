import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const trayDir = join(dirname(fileURLToPath(import.meta.url)), '../resources/tray')

function writeIco(name, pngNames) {
  const images = pngNames.map((file) => readFileSync(join(trayDir, file)))
  const headerSize = 6
  const entrySize = 16
  const directorySize = headerSize + entrySize * images.length
  const offsets = []
  let cursor = directorySize
  for (const image of images) {
    offsets.push(cursor)
    cursor += image.length
  }
  const buffer = Buffer.alloc(cursor)
  buffer.writeUInt16LE(0, 0)
  buffer.writeUInt16LE(1, 2)
  buffer.writeUInt16LE(images.length, 4)
  images.forEach((image, index) => {
    const size = pngSize(image)
    const entry = headerSize + entrySize * index
    buffer.writeUInt8(size === 256 ? 0 : size, entry)
    buffer.writeUInt8(size === 256 ? 0 : size, entry + 1)
    buffer.writeUInt8(0, entry + 2)
    buffer.writeUInt8(0, entry + 3)
    buffer.writeUInt16LE(1, entry + 4)
    buffer.writeUInt16LE(32, entry + 6)
    buffer.writeUInt32LE(image.length, entry + 8)
    buffer.writeUInt32LE(offsets[index], entry + 12)
    image.copy(buffer, offsets[index])
  })
  writeFileSync(join(trayDir, name), buffer)
}

function pngSize(image) {
  if (image.length < 24 || image.toString('ascii', 1, 4) !== 'PNG') {
    throw new Error('expected a PNG payload')
  }
  return image.readUInt32BE(16)
}

writeIco('hrack.ico', ['hrack-16.png', 'hrack-32.png', 'hrack-256.png'])
writeIco('hrack-white.ico', [
  'hrack-white-16.png',
  'hrack-white-32.png',
  'hrack-white-256.png'
])
