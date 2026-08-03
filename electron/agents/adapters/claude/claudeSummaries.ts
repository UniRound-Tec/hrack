import { basename, relative, resolve } from 'node:path'

const MAX_SUMMARY_LENGTH = 48
const ANSI_ESCAPE = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001b\\))/g
const SECRET_LIKE = /(?:api[_-]?key|token|secret|password|authorization)\s*[:=]\s*\S+/gi

function clean(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const sanitized = value
    .replace(ANSI_ESCAPE, '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(SECRET_LIKE, '$1=[redacted]')
    .replace(/\s+/g, ' ')
    .trim()
  return sanitized ? sanitized.slice(0, MAX_SUMMARY_LENGTH) : undefined
}

function recordOf(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function safePath(value: unknown, cwd?: string): string | undefined {
  const path = clean(value)
  if (!path) return undefined
  if (!cwd) return basename(path).slice(0, MAX_SUMMARY_LENGTH)
  try {
    const root = resolve(cwd)
    const absolute = resolve(root, path)
    const inside = relative(root, absolute)
    if (inside && !inside.startsWith('..') && !inside.includes(':')) {
      return inside.slice(0, MAX_SUMMARY_LENGTH)
    }
  } catch {
    /* malformed path falls back to basename */
  }
  return basename(path).slice(0, MAX_SUMMARY_LENGTH)
}

function commandExecutable(value: unknown): string | undefined {
  const command = clean(value)
  if (!command) return undefined
  const first = command.match(/^\s*(?:["']([^"']+)["']|(\S+))/)?.slice(1).find(Boolean)
  return first ? basename(first).slice(0, MAX_SUMMARY_LENGTH) : undefined
}

function safeDomain(value: unknown): string | undefined {
  const raw = clean(value)
  if (!raw) return undefined
  try {
    const url = new URL(raw)
    return url.hostname.slice(0, MAX_SUMMARY_LENGTH)
  } catch {
    return undefined
  }
}

export function sanitizeClaudeLabel(value: unknown): string | undefined {
  return clean(value)
}

export function summarizeClaudeTool(
  toolNameValue: unknown,
  toolInputValue: unknown,
  cwd?: string
): { toolName: string; summary?: string } {
  const toolName = clean(toolNameValue) ?? 'Tool'
  const input = recordOf(toolInputValue)
  if (!input) return { toolName }
  const lower = toolName.toLowerCase()

  if (['read', 'write', 'edit', 'multiedit', 'notebookedit'].includes(lower)) {
    return {
      toolName,
      summary: safePath(input.file_path ?? input.path ?? input.notebook_path, cwd)
    }
  }
  if (lower === 'bash' || lower === 'shell' || lower === 'command') {
    return {
      toolName,
      summary: clean(input.description) ?? commandExecutable(input.command)
    }
  }
  if (lower === 'webfetch' || lower === 'web_fetch') {
    return { toolName, summary: safeDomain(input.url) }
  }
  if (lower === 'websearch' || lower === 'web_search') {
    return { toolName, summary: 'Web search' }
  }
  if (lower === 'glob' || lower === 'grep') {
    return { toolName, summary: toolName }
  }
  if (lower === 'agent' || lower === 'task') {
    return { toolName, summary: clean(input.subagent_type ?? input.agent_type) ?? 'Subtask' }
  }
  if (lower.startsWith('mcp__')) {
    return { toolName, summary: toolName.replace(/^mcp__/, '').slice(0, MAX_SUMMARY_LENGTH) }
  }
  return { toolName }
}
