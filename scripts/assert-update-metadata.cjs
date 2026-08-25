const { existsSync, readFileSync } = require('node:fs')
const { basename, resolve } = require('node:path')

function scalar(value) {
  const trimmed = value.trim()
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return JSON.parse(trimmed)
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1).replace(/''/g, "'")
  }
  return trimmed
}

function artifactName(url) {
  const pathname = new URL(url, 'https://updates.invalid/').pathname
  return basename(decodeURIComponent(pathname))
}

const [metadataPath, artifactDirectory, expectedVersion, ...expectedFiles] =
  process.argv.slice(2)

if (!metadataPath || !artifactDirectory || !expectedVersion || expectedFiles.length === 0) {
  throw new Error(
    'Usage: node assert-update-metadata.cjs <metadata> <artifact-dir> <version> <expected-file...>'
  )
}
if (!existsSync(metadataPath)) {
  throw new Error(`Update metadata is missing: ${metadataPath}`)
}

const source = readFileSync(metadataPath, 'utf8')
const versionMatch = source.match(/^version:\s*(.+?)\s*$/m)
if (!versionMatch || scalar(versionMatch[1]) !== expectedVersion) {
  throw new Error(
    `Update metadata version does not match ${expectedVersion}: ${metadataPath}`
  )
}

const urls = [...source.matchAll(/^\s*-\s+url:\s*(.+?)\s*$/gm)].map((match) =>
  artifactName(scalar(match[1]))
)
if (urls.length === 0) {
  throw new Error(`Update metadata has no files: ${metadataPath}`)
}

for (const expected of expectedFiles) {
  if (!urls.includes(expected)) {
    throw new Error(
      `Update metadata does not reference ${expected}: ${metadataPath}`
    )
  }
}
for (const filename of urls) {
  const artifactPath = resolve(artifactDirectory, filename)
  if (!existsSync(artifactPath)) {
    throw new Error(
      `Update metadata references a missing artifact: ${artifactPath}`
    )
  }
}

const sha512Count = [...source.matchAll(/^\s+sha512:\s*\S+/gm)].length
if (sha512Count < urls.length) {
  throw new Error(`Update metadata is missing SHA-512 entries: ${metadataPath}`)
}

const releaseNotesMatch = source.match(
  /^releaseNotes:\s*\|-\s*\r?\n((?:(?: {2}.*)?\r?\n?)*)/m
)
if (!releaseNotesMatch) {
  throw new Error(`Update metadata is missing Markdown release notes: ${metadataPath}`)
}
const releaseNotes = releaseNotesMatch[1]
  .split(/\r?\n/)
  .map((line) => line.startsWith('  ') ? line.slice(2) : line)
  .join('\n')
  .trim()
if (!releaseNotes.startsWith(`## [${expectedVersion}]`)) {
  throw new Error(
    `Update metadata release notes do not match ${expectedVersion}: ${metadataPath}`
  )
}

console.log(
  `Verified ${basename(metadataPath)} with Markdown release notes for ${expectedVersion}: ${urls.join(', ')}`
)

