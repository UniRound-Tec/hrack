import { expect, test } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { cliDefinitions } from '../electron/ai-cli-discovery'

function explicitIconAssignments(): Map<string, string> {
  const path = resolve(process.cwd(), 'src/app/adapterIcons.ts')
  const source = readFileSync(path, 'utf8')
  const objectBody = source.match(
    /const adapterIcons:[^{]+\{([\s\S]*?)\n\}/
  )?.[1]
  if (!objectBody) throw new Error('adapterIcons object was not found')
  const assignments = new Map<string, string>()
  const propertyPattern =
    /^\s*(?:'([^']+)'|([A-Za-z][\w]*)):\s*([A-Za-z][\w]*)/gm
  for (const match of objectBody.matchAll(propertyPattern)) {
    assignments.set(match[1] ?? match[2], match[3])
  }
  return assignments
}

test('every registered CLI has an explicit lobby icon', () => {
  const assignments = explicitIconAssignments()
  const missing = cliDefinitions
    .filter((definition) => {
      const icon = assignments.get(definition.iconId)
      return !icon || icon === 'LobeHub'
    })
    .map((definition) => definition.iconId)

  expect(missing).toEqual([])
})

test('the built-in DSH adapter uses the DeepSeek brand icon', () => {
  expect(explicitIconAssignments().get('dsh')).toBe('DeepSeek')
})
