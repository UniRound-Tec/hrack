import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import subsetFont from 'subset-font'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const sourceRoot = join(repositoryRoot, 'src')
const fontRoot = join(sourceRoot, 'assets', 'fonts')
const outputRoot = join(fontRoot, '.subset')
const MAX_PINGFANG_BYTES = 1024 * 1024
const brandFont = {
  label: 'Ammonite',
  source: join(
    fontRoot,
    'ammonite',
    'Ammonite-2.otf'
  ),
  subset: join(outputRoot, 'HRack-brand.woff2')
}
const PRINTABLE_ASCII = Array.from(
  { length: 95 },
  (_, index) => String.fromCharCode(index + 32)
).join('')

const textSources = [
  join(sourceRoot, 'app'),
  join(sourceRoot, 'App.tsx'),
  join(sourceRoot, 'main.tsx'),
  join(sourceRoot, 'terminal', 'TerminalView.tsx'),
  join(repositoryRoot, 'shared', 'theme-schema.ts')
]

/** 扫描文本源中的文件；mock 演示文案不参与子集化（不进产物字体）。 */
const excludedFiles = new Set([
  join(sourceRoot, 'app', 'mockSessions.ts')
])

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
  return nested.flat().filter((filename) => !excludedFiles.has(filename))
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

// Keep the current generated files available while their replacements are
// prepared. Deleting the directory first makes a running dev renderer cache a
// failed webfont request and fall back to the system font until it restarts.
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
const brandBytes = await subset(
  brandFont.source,
  brandFont.subset,
  'hrack'
)

// Remove obsolete generated artifacts only after every expected replacement is
// ready, so renames cannot leave stale fonts behind without creating a gap.
const expectedFiles = new Set([...pingfangFiles, 'HRack-brand.woff2'])
for (const entry of await readdir(outputRoot, { withFileTypes: true })) {
  if (!expectedFiles.has(entry.name)) {
    await rm(join(outputRoot, entry.name), {
      recursive: entry.isDirectory(),
      force: true
    })
  }
}

if (pingfangBytes >= MAX_PINGFANG_BYTES) {
  throw new Error(
    `PingFang subsets are ${pingfangBytes} bytes; expected less than ${MAX_PINGFANG_BYTES}`
  )
}

console.log(
  `Font subsets ready: PingFang ${pingfangBytes} bytes, ${brandFont.label} ${brandBytes} bytes, ${characters.length} UI characters.`
)
