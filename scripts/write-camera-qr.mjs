import fs from 'node:fs'
import path from 'node:path'
import { PNG } from 'pngjs'
import { encode } from 'uqr'

const joinUrl = process.env.HRACK_CAMERA_JOIN_URL
const outputPath = process.env.HRACK_CAMERA_QR_OUTPUT

if (!joinUrl || !outputPath) {
  throw new Error('HRACK_CAMERA_JOIN_URL and HRACK_CAMERA_QR_OUTPUT are required')
}

const matrix = encode(joinUrl).data
const canvasSize = 2_048
const gridSize = 4
const cellSize = canvasSize / gridSize
const moduleScale = Math.max(5, Math.floor(300 / matrix.length))
const qrSize = matrix.length * moduleScale
if (qrSize > cellSize - 96) throw new Error('join URL QR is unexpectedly large')

const png = new PNG({ width: canvasSize, height: canvasSize })
png.data.fill(255)

for (let cellY = 0; cellY < gridSize; cellY += 1) {
  for (let cellX = 0; cellX < gridSize; cellX += 1) {
    const originX = cellX * cellSize + Math.floor((cellSize - qrSize) / 2)
    const originY = cellY * cellSize + Math.floor((cellSize - qrSize) / 2)
    for (let moduleY = 0; moduleY < matrix.length; moduleY += 1) {
      for (let moduleX = 0; moduleX < matrix.length; moduleX += 1) {
        if (!matrix[moduleY][moduleX]) continue
        for (let y = 0; y < moduleScale; y += 1) {
          for (let x = 0; x < moduleScale; x += 1) {
            const pixelX = originX + moduleX * moduleScale + x
            const pixelY = originY + moduleY * moduleScale + y
            const offset = (pixelY * canvasSize + pixelX) * 4
            png.data[offset] = 0
            png.data[offset + 1] = 0
            png.data[offset + 2] = 0
            png.data[offset + 3] = 255
          }
        }
      }
    }
  }
}

fs.mkdirSync(path.dirname(outputPath), { recursive: true })
fs.writeFileSync(outputPath, PNG.sync.write(png))
