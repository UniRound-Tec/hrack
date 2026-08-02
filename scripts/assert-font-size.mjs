import { readdir, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const assets = join(repositoryRoot, 'out', 'renderer', 'assets')
const MAX_PINGFANG_BYTES = 1024 * 1024
const entries = await readdir(assets)
const pingfang = entries.filter((name) => /^PingFangSC-.*\.woff2$/i.test(name))
const ammonite = entries.filter((name) => /^Ammonite-.*\.woff2$/i.test(name))
const forbiddenFullFonts = entries.filter((name) =>
  /PingFangSC-(?:Light|Thin|Ultralight).*\.woff2$|Ammonite-.*\.otf$/i.test(name)
)

if (pingfang.length !== 3) {
  throw new Error(`Expected 3 built PingFang subsets, found ${pingfang.length}`)
}
if (ammonite.length !== 1) {
  throw new Error(`Expected 1 built Ammonite subset, found ${ammonite.length}`)
}
if (forbiddenFullFonts.length > 0) {
  throw new Error(`Full or unused fonts reached the build: ${forbiddenFullFonts.join(', ')}`)
}

let bytes = 0
for (const filename of pingfang) bytes += (await stat(join(assets, filename))).size
if (bytes >= MAX_PINGFANG_BYTES) {
  throw new Error(
    `Built PingFang assets are ${bytes} bytes; expected less than ${MAX_PINGFANG_BYTES}`
  )
}
console.log(`Built PingFang size gate passed: ${bytes} bytes across 3 weights.`)
