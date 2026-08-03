/**
 * 生成托盘图标静态资产（提交产物，本脚本仅用于再生成）。
 * 品牌 v 字形单色 PNG：resources/tray/{vibing-16,vibing-32,vibingTemplate-16,vibingTemplate-32}.png
 * macOS template image 走黑色 + alpha（系统按菜单栏深浅自动反色）。
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PNG } from 'pngjs'

const outputRoot = join(
  resolve(dirname(fileURLToPath(import.meta.url)), '..'),
  'resources',
  'tray'
)

/** 点到折线（两段 v）的距离。 */
function distanceToPolyline(x, y, points) {
  let best = Infinity
  for (let i = 0; i < points.length - 1; i++) {
    const [ax, ay] = points[i]
    const [bx, by] = points[i + 1]
    const dx = bx - ax
    const dy = by - ay
    const lengthSquared = dx * dx + dy * dy
    let t = ((x - ax) * dx + (y - ay) * dy) / lengthSquared
    t = Math.max(0, Math.min(1, t))
    const px = ax + t * dx
    const py = ay + t * dy
    best = Math.min(best, Math.hypot(x - px, y - py))
  }
  return best
}

function renderV(size, thickness) {
  const png = new PNG({ width: size, height: size })
  const points = [
    [size * 0.22, size * 0.28],
    [size * 0.5, size * 0.76],
    [size * 0.78, size * 0.28]
  ]
  const half = thickness / 2
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const offset = (y * size + x) * 4
      const distance = distanceToPolyline(x + 0.5, y + 0.5, points)
      const alpha = Math.max(0, Math.min(255, Math.round((half - distance) * 6)))
      png.data[offset] = 0
      png.data[offset + 1] = 0
      png.data[offset + 2] = 0
      png.data[offset + 3] = alpha
    }
  }
  return PNG.sync.write(png)
}

await mkdir(outputRoot, { recursive: true })
const outputs = [
  ['vibing-16.png', renderV(16, 2.6)],
  ['vibing-32.png', renderV(32, 5.2)],
  ['vibingTemplate-16.png', renderV(16, 2.6)],
  ['vibingTemplate-32.png', renderV(32, 5.2)]
]
for (const [filename, buffer] of outputs) {
  await writeFile(join(outputRoot, filename), buffer)
  console.log(`wrote resources/tray/${filename} (${buffer.byteLength} bytes)`)
}
