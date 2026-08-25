const { readFileSync, writeFileSync } = require('node:fs')
const { basename } = require('node:path')

const [metadataPath, changelogPath, version] = process.argv.slice(2)

if (!metadataPath || !changelogPath || !version) {
  throw new Error(
    'Usage: node inject-release-notes.cjs <metadata> <changelog> <version>'
  )
}

const changelog = readFileSync(changelogPath, 'utf8').replace(/\r\n/g, '\n')
const escapedVersion = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const lines = changelog.split('\n')
const sectionStart = lines.findIndex((line) =>
  new RegExp(`^## \\[${escapedVersion}\\](?:\\s|$)`).test(line)
)
const nextSection = lines.findIndex(
  (line, index) => index > sectionStart && /^## \[/.test(line)
)
const section = sectionStart === -1
  ? ''
  : lines.slice(sectionStart, nextSection === -1 ? lines.length : nextSection).join('\n').trim()

if (!section) {
  throw new Error(`CHANGELOG section is missing for version ${version}: ${changelogPath}`)
}

let metadata = readFileSync(metadataPath, 'utf8').replace(/\r\n/g, '\n').trimEnd()
if (/^releaseNotes:\s*/m.test(metadata)) {
  throw new Error(`Update metadata already contains releaseNotes: ${metadataPath}`)
}

const indentedNotes = section
  .split('\n')
  .map((line) => `  ${line}`)
  .join('\n')

metadata += `\nreleaseNotes: |-\n${indentedNotes}\n`
writeFileSync(metadataPath, metadata, 'utf8')

console.log(
  `Embedded Markdown release notes for ${version} in ${basename(metadataPath)}`
)
