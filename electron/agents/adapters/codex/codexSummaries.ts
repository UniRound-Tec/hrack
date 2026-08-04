import { basename } from 'node:path'

const MAX_LABEL = 64

export function sanitizeCodexLabel(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const clean = value.replace(/[\r\n\t]+/g, ' ').trim().slice(0, MAX_LABEL)
  return clean || undefined
}

function commandName(command: unknown): string | undefined {
  if (typeof command !== 'string') return undefined
  const first = command.trim().match(/^(?:["']([^"']+)["']|(\S+))/)
  const raw = first?.[1] ?? first?.[2]
  if (!raw || raw.includes('$') || raw.includes('%')) return undefined
  return sanitizeCodexLabel(basename(raw.replaceAll('\\', '/')))
}

export function summarizeCodexTool(
  toolNameValue: unknown,
  toolInput: Record<string, unknown>
): { toolName: string; summary?: string } {
  const toolName = sanitizeCodexLabel(toolNameValue) ?? 'Tool'
  if (toolName.toLowerCase() === 'bash') {
    return { toolName, summary: commandName(toolInput.command) }
  }
  return { toolName }
}
