import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import subsetFont from 'subset-font'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const sourceRoot = join(repositoryRoot, 'src')
const fontRoot = join(sourceRoot, 'assets', 'fonts')
const outputRoot = join(fontRoot, '.subset')
const MAX_PINGFANG_BYTES = 1024 * 1024
const PRINTABLE_ASCII = Array.from(
  { length: 95 },
  (_, index) => String.fromCharCode(index + 32)
).join('')

const textSources = [
  join(sourceRoot, 'app'),
  join(sourceRoot, 'App.tsx'),
  join(sourceRoot, 'i18n.ts'),
  join(sourceRoot, 'main.tsx'),
  join(sourceRoot, 'terminal', 'TerminalView.tsx'),
  join(repositoryRoot, 'shared', 'theme-schema.ts')
]

async function sourceFiles(path) {
  if (['.ts', '.tsx'].includes(extname(path))) return [path]
  const entries = await readdir(path, { withFileTypes: true })
  const nested = await Promise.all(
    entries.map((entry) =>
      entry.isDirectory()
        ? sourceFiles(join(path, entry.name))
        : ['.ts', '.tsx'].includes(extname(entry.name))
          ? [join(path, entry.name)]
          : []
    )
  )
  return nested.flat()
}

function collectLiteralText(source, filename, characters) {
  // UI copy is centralized, but modal/status error strings also live beside
  // their components. Strip comments, then retain every non-ASCII character;
  // printable ASCII is already included as a stable UI baseline.
  const withoutComments = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
  for (const character of withoutComments) {
    if (character.codePointAt(0) > 126) characters.add(character)
  }
}

async function uiText() {
  const characters = new Set(PRINTABLE_ASCII)
  const files = (await Promise.all(textSources.map(sourceFiles))).flat()
  for (const filename of files) {
    collectLiteralText(await readFile(filename, 'utf8'), filename, characters)
  }
  return [...characters].sort().join('')
}

async function subset(input, output, text) {
  const buffer = await subsetFont(await readFile(input), text, {
    targetFormat: 'woff2'
  })
  await writeFile(output, buffer)
  return buffer.byteLength
}

await mkdir(outputRoot, { recursive: true })
const characters = await uiText()
const pingfangFiles = [
  'PingFangSC-Regular.woff2',
  'PingFangSC-Medium.woff2',
  'PingFangSC-Semibold.woff2'
]
let pingfangBytes = 0
for (const filename of pingfangFiles) {
  pingfangBytes += await subset(
    join(fontRoot, 'pingfang', filename),
    join(outputRoot, filename),
    characters
  )
}
const ammoniteBytes = await subset(
  join(fontRoot, 'ammonite', 'Ammonite-2.otf'),
  join(outputRoot, 'Ammonite-vibing.woff2'),
  'vibing'
)

if (pingfangBytes >= MAX_PINGFANG_BYTES) {
  throw new Error(
    `PingFang subsets are ${pingfangBytes} bytes; expected less than ${MAX_PINGFANG_BYTES}`
  )
}

console.log(
  `Font subsets ready: PingFang ${pingfangBytes} bytes, Ammonite ${ammoniteBytes} bytes, ${characters.length} UI characters.`
)
