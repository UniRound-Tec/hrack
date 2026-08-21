import { access, readdir, readFile } from 'node:fs/promises'
import { dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

async function filesBelow(directory) {
  const result = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) result.push(...(await filesBelow(path)))
    else result.push(path)
  }
  return result
}

// Architectural gate: renderer code must never import the official DSH UI
// runtime. It belongs in the isolated page served by `dsh web`.
for (const path of await filesBelow(join(root, 'src'))) {
  if (!['.ts', '.tsx', '.css'].includes(extname(path))) continue
  const source = await readFile(path, 'utf8')
  if (
    source.includes('@deepseek-ai/') ||
    source.includes('dsh-runtime/') ||
    source.includes("'./dsh/bootDsh'") ||
    source.includes('"./dsh/bootDsh"')
  ) {
    throw new Error(`Official DSH UI leaked into the HRack renderer: ${path}`)
  }
}

const rendererAssets = join(root, 'out', 'renderer', 'assets')
const rendererBundle = (
  await Promise.all(
    (await filesBelow(rendererAssets))
      .filter((path) => ['.js', '.css'].includes(extname(path)))
      .map((path) => readFile(path, 'utf8'))
  )
).join('\n')

for (const marker of [
  '__DSH_MODULES__',
  'AppWebEntry',
  'data-dsh-surface-host',
  'Cordis Context.extend is unavailable'
]) {
  if (rendererBundle.includes(marker)) {
    throw new Error(`Same-DOM DSH marker reached the renderer build: ${marker}`)
  }
}

const surfacePreload = join(root, 'out', 'preload', 'dsh-surface.js')
const mainBundle = join(root, 'out', 'main', 'index.js')
await Promise.all([access(surfacePreload), access(mainBundle)])
const [preloadSource, mainSource] = await Promise.all([
  readFile(surfacePreload, 'utf8'),
  readFile(mainBundle, 'utf8')
])
if (!preloadSource.includes('__HRACK_DSH_EMBED__')) {
  throw new Error('Official DSH surface preload bridge is missing from the build')
}
if (!preloadSource.includes('__ModuleLoader__')) {
  throw new Error('Official DSH surface preload is missing the rc.7+ module-loader capture')
}
if (!preloadSource.includes('--no-open') && !mainSource.includes('--no-open')) {
  throw new Error('DSH host spawn is missing --no-open for official web embedding')
}
if (!mainSource.includes('persist:hrack-dsh-surface')) {
  throw new Error('Official DSH WebContentsView controller is missing from the build')
}

console.log('Official DSH Web surface isolation gate passed.')
