import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { PNG } from 'pngjs'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const brandRoot = join(projectRoot, 'resources', 'brand')
const trayRoot = join(projectRoot, 'resources', 'tray')
const buildRoot = join(projectRoot, 'build')
const scratchRoot = join(projectRoot, '.dev-shots')
const markSvg = await readFile(join(brandRoot, 'hrack-mark.svg'), 'utf8')
const whiteMarkSvg = await readFile(join(brandRoot, 'hrack-mark-white.svg'), 'utf8')
const appSvg = await readFile(join(brandRoot, 'hrack-app.svg'), 'utf8')

const MASTER_SIZE = 1024

function svgDocument(body) {
  return `<!doctype html><html><head><style>
    * { box-sizing: border-box; }
    html, body { margin: 0; width: 100%; height: 100%; overflow: hidden; background: transparent; }
    svg { display: block; }
  </style></head><body>${body}</body></html>`
}

function nestedMark({ x, y, width, height, color, source = markSvg }) {
  return `<svg x="${x}" y="${y}" width="${width}" height="${height}" viewBox="0 0 47 57" preserveAspectRatio="xMidYMid meet" fill="${color}">
    ${source
      .replace(/^<svg[^>]*>|<\/svg>\s*$/g, '')
      .replace(/fill="(?:black|white)"/g, `fill="${color}"`)}
  </svg>`
}

function nestedAppIcon() {
  return `<svg width="${MASTER_SIZE}" height="${MASTER_SIZE}" viewBox="0 0 96 96" preserveAspectRatio="xMidYMid meet">
    ${appSvg.replace(/^<svg[^>]*>|<\/svg>\s*$/g, '')}
  </svg>`
}

async function renderMaster(page, path, body) {
  await page.setContent(
    svgDocument(`<svg width="${MASTER_SIZE}" height="${MASTER_SIZE}" viewBox="0 0 ${MASTER_SIZE} ${MASTER_SIZE}" xmlns="http://www.w3.org/2000/svg">${body}</svg>`)
  )
  await page.screenshot({ path, omitBackground: true })
  return PNG.sync.read(await readFile(path))
}

function resizeBox(master, size) {
  if (master.width !== MASTER_SIZE || master.height !== MASTER_SIZE || MASTER_SIZE % size !== 0) {
    throw new Error(`Icon master must be ${MASTER_SIZE}px and divide evenly into ${size}px`)
  }
  const output = new PNG({ width: size, height: size })
  const scale = MASTER_SIZE / size
  const samples = scale * scale
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let alpha = 0
      let red = 0
      let green = 0
      let blue = 0
      for (let sourceY = y * scale; sourceY < (y + 1) * scale; sourceY += 1) {
        for (let sourceX = x * scale; sourceX < (x + 1) * scale; sourceX += 1) {
          const offset = (sourceY * MASTER_SIZE + sourceX) * 4
          const sourceAlpha = master.data[offset + 3]
          alpha += sourceAlpha
          red += master.data[offset] * sourceAlpha
          green += master.data[offset + 1] * sourceAlpha
          blue += master.data[offset + 2] * sourceAlpha
        }
      }
      const target = (y * size + x) * 4
      output.data[target + 3] = Math.round(alpha / samples)
      if (alpha > 0) {
        output.data[target] = Math.round(red / alpha)
        output.data[target + 1] = Math.round(green / alpha)
        output.data[target + 2] = Math.round(blue / alpha)
      }
    }
  }
  return PNG.sync.write(output)
}

function recolorAlpha(master, size, color) {
  const resized = PNG.sync.read(resizeBox(master, size))
  for (let offset = 0; offset < resized.data.length; offset += 4) {
    resized.data[offset] = color
    resized.data[offset + 1] = color
    resized.data[offset + 2] = color
  }
  return PNG.sync.write(resized)
}

function encodeIco(frames) {
  const headerSize = 6 + frames.length * 16
  const header = Buffer.alloc(headerSize)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(frames.length, 4)
  let dataOffset = headerSize
  frames.forEach(({ size, buffer }, index) => {
    const entry = 6 + index * 16
    header[entry] = size === 256 ? 0 : size
    header[entry + 1] = size === 256 ? 0 : size
    header[entry + 2] = 0
    header[entry + 3] = 0
    header.writeUInt16LE(1, entry + 4)
    header.writeUInt16LE(32, entry + 6)
    header.writeUInt32LE(buffer.length, entry + 8)
    header.writeUInt32LE(dataOffset, entry + 12)
    dataOffset += buffer.length
  })
  return Buffer.concat([header, ...frames.map(({ buffer }) => buffer)])
}

await Promise.all([brandRoot, trayRoot, buildRoot, scratchRoot].map((path) => mkdir(path, { recursive: true })))
const appMasterPath = join(scratchRoot, 'hrack-app-icon-master.png')
const markMasterPath = join(scratchRoot, 'hrack-mark-master.png')
const whiteMarkMasterPath = join(scratchRoot, 'hrack-mark-white-master.png')
const browser = await chromium.launch({ headless: true })
const page = await browser.newPage({ viewport: { width: MASTER_SIZE, height: MASTER_SIZE } })

try {
  const appMaster = await renderMaster(
    page,
    appMasterPath,
    nestedAppIcon()
  )
  const markMaster = await renderMaster(
    page,
    markMasterPath,
    nestedMark({ x: 72, y: 72, width: 880, height: 880, color: '#000000' })
  )
  const whiteMarkMaster = await renderMaster(
    page,
    whiteMarkMasterPath,
    nestedMark({ x: 72, y: 72, width: 880, height: 880, color: '#ffffff', source: whiteMarkSvg })
  )

  const appFrames = [16, 32, 64, 128, 256].map((size) => ({
    size,
    buffer: resizeBox(appMaster, size)
  }))
  const blackTrayFrames = [16, 32, 256].map((size) => ({
    size,
    buffer: recolorAlpha(markMaster, size, 0)
  }))
  const whiteTrayFrames = [16, 32, 256].map((size) => ({
    size,
    buffer: recolorAlpha(whiteMarkMaster, size, 255)
  }))
  const outputs = [
    [join(buildRoot, 'icon.png'), PNG.sync.write(appMaster)],
    [join(trayRoot, 'hrack-master.png'), resizeBox(markMaster, 256)],
    [join(trayRoot, 'hrack-16.png'), recolorAlpha(markMaster, 16, 0)],
    [join(trayRoot, 'hrack-32.png'), recolorAlpha(markMaster, 32, 0)],
    [join(trayRoot, 'hrack-white-16.png'), recolorAlpha(whiteMarkMaster, 16, 255)],
    [join(trayRoot, 'hrack-white-32.png'), recolorAlpha(whiteMarkMaster, 32, 255)],
    [join(trayRoot, 'hrackTemplate-16.png'), recolorAlpha(markMaster, 16, 0)],
    [join(trayRoot, 'hrackTemplate-32.png'), recolorAlpha(markMaster, 32, 0)],
    [join(trayRoot, 'hrack-256.png'), recolorAlpha(markMaster, 256, 0)],
    [join(trayRoot, 'hrack-white-256.png'), recolorAlpha(whiteMarkMaster, 256, 255)],
    [join(trayRoot, 'hrack-app-16.png'), appFrames[0].buffer],
    [join(trayRoot, 'hrack-app-32.png'), appFrames[1].buffer],
    [join(trayRoot, 'hrack-app.ico'), encodeIco(appFrames)],
    [join(trayRoot, 'hrack.ico'), encodeIco(blackTrayFrames)],
    [join(trayRoot, 'hrack-white.ico'), encodeIco(whiteTrayFrames)]
  ]
  await Promise.all(outputs.map(([path, buffer]) => writeFile(path, buffer)))
  for (const [path] of outputs) console.log(`wrote ${path.slice(projectRoot.length + 1)}`)
} finally {
  await browser.close()
  await Promise.all([appMasterPath, markMasterPath, whiteMarkMasterPath].map((path) => unlink(path).catch(() => {})))
}
