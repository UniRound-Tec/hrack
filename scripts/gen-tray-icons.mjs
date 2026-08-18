/**
 * 生成托盘图标静态资产（提交产物，本脚本仅用于再生成）。
 * HRack 品牌 H 图形单色 PNG：黑/白 16/32/256px，以及 macOS Template。
 * macOS template image 走黑色 + alpha（系统按菜单栏深浅自动反色）。
 * hrack-master.png 是独立维护的 256px 透明 alpha 品牌母版；这里只做整数倍
 * 面积缩采样，保证小尺寸稳定。
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PNG } from 'pngjs'

const outputRoot = join(
  resolve(dirname(fileURLToPath(import.meta.url)), '..'),
  'resources',
  'tray'
)

const master = PNG.sync.read(
  await readFile(join(outputRoot, 'hrack-master.png'))
)

function renderMark(size, color) {
  if (master.width % size !== 0 || master.height !== master.width) {
    throw new Error('hrack-master.png must be a square integer multiple of the target size')
  }
  const png = new PNG({ width: size, height: size })
  const scale = master.width / size
  const samples = scale * scale
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const offset = (y * size + x) * 4
      let alpha = 0
      for (let sourceY = y * scale; sourceY < (y + 1) * scale; sourceY++) {
        for (let sourceX = x * scale; sourceX < (x + 1) * scale; sourceX++) {
          alpha += master.data[(sourceY * master.width + sourceX) * 4 + 3]
        }
      }
      png.data[offset] = color
      png.data[offset + 1] = color
      png.data[offset + 2] = color
      png.data[offset + 3] = Math.round(alpha / samples)
    }
  }
  return PNG.sync.write(png)
}

await mkdir(outputRoot, { recursive: true })
const outputs = [
  ['hrack-16.png', renderMark(16, 0)],
  ['hrack-32.png', renderMark(32, 0)],
  ['hrack-256.png', renderMark(256, 0)],
  ['hrack-white-16.png', renderMark(16, 255)],
  ['hrack-white-32.png', renderMark(32, 255)],
  ['hrack-white-256.png', renderMark(256, 255)],
  ['hrackTemplate-16.png', renderMark(16, 0)],
  ['hrackTemplate-32.png', renderMark(32, 0)]
]
for (const [filename, buffer] of outputs) {
  await writeFile(join(outputRoot, filename), buffer)
  console.log(`wrote resources/tray/${filename} (${buffer.byteLength} bytes)`)
}
