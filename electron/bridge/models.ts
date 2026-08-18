import { MODEL_ID_PATTERN, type BridgeModel } from '../../shared/bridge-protocol'

export function parseOpenCodeModelsOutput(stdout: string): BridgeModel[] {
  const models: BridgeModel[] = []
  const seen = new Set<string>()
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#') || /^models?\b/i.test(line)) continue
    const match = line.match(
      /([a-z0-9][a-z0-9._-]*\/[a-zA-Z0-9][a-zA-Z0-9._:+-]*)/
    )
    const id = match?.[1]
    if (!id || !MODEL_ID_PATTERN.test(id) || seen.has(id)) continue
    seen.add(id)
    const slash = id.indexOf('/')
    models.push({
      id,
      provider: id.slice(0, slash),
      model: id.slice(slash + 1)
    })
  }
  return models
}

export function splitModelId(
  id: string
): { provider: string; model: string } | null {
  if (!MODEL_ID_PATTERN.test(id)) return null
  const slash = id.indexOf('/')
  return { provider: id.slice(0, slash), model: id.slice(slash + 1) }
}
