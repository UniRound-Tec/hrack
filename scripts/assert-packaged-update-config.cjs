const { existsSync, readFileSync } = require('node:fs')
const { load } = require('js-yaml')

const [configPath] = process.argv.slice(2)
if (!configPath || !existsSync(configPath)) {
  throw new Error(`Packaged update config is missing: ${configPath || '<unset>'}`)
}

const config = load(readFileSync(configPath, 'utf8'))
if (!config || typeof config !== 'object') {
  throw new Error(`Packaged update config is invalid: ${configPath}`)
}
if (
  config.provider !== 'github' ||
  config.owner !== 'UniRound-Tec' ||
  config.repo !== 'hrack'
) {
  throw new Error(
    `Unexpected packaged update provider: ${JSON.stringify(config)}`
  )
}
if (typeof config.updaterCacheDirName !== 'string' || !config.updaterCacheDirName) {
  throw new Error('Packaged update config is missing updaterCacheDirName')
}
if ('token' in config || 'private' in config) {
  throw new Error('Packaged public update config must not contain credentials')
}

console.log(
  `Verified packaged update provider: ${config.owner}/${config.repo}`
)

