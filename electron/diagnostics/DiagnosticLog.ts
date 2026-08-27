import type { WebContents } from 'electron'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync
} from 'node:fs'
import { dirname } from 'node:path'
import { inspect } from 'node:util'
import type {
  DiagnosticLogChange,
  DiagnosticLogEntry,
  DiagnosticLogLevel,
  DiagnosticLogSnapshot
} from '../../shared/diagnostic-log'

const ENTRY_CAPACITY = 2_000
const ENTRY_MESSAGE_LIMIT = 12 * 1024
const FILE_SIZE_LIMIT = 2 * 1024 * 1024

type ConsoleMethod = 'debug' | 'info' | 'log' | 'warn' | 'error'

function redact(value: string): string {
  return value
    .replace(/(\/remote\/)[A-Za-z0-9_-]{8,}/gi, '$1[redacted]')
    .replace(
      /((?:https?|wss?):\/\/[^\s"'<>]+\/remote\/)[^\s/?#"'<>]+/gi,
      '$1[redacted]'
    )
    .replace(
      /((?:https?|wss?):\/\/[^\s"'<>]+\/(?:_connect|connect)\/)[^\s/?#"'<>]+/gi,
      '$1[redacted]'
    )
    .replace(
      /([?&](?:token|ticket|key|secret|password|seatToken|dshSeatToken|api[_-]?key)=)[^&#\s"'<>]+/gi,
      '$1[redacted]'
    )
    .replace(/((?:authorization)\s*[:=]\s*)(?:bearer\s+)?[^\s,;]+/gi, '$1[redacted]')
    .replace(/((?:cookie|set-cookie)\s*[:=]\s*)[^\r\n]+/gi, '$1[redacted]')
    .replace(
      /(["']?(?:seatToken|dshSeatToken|roomKey|password|apiKey|api_key)["']?\s*[:=]\s*["'])[^"']+/gi,
      '$1[redacted]'
    )
    .replace(/\bre_[A-Za-z0-9_-]{16,}\b/g, 're_[redacted]')
}

function formatValue(value: unknown): string {
  if (typeof value === 'string') return value
  if (value instanceof Error) return value.stack || `${value.name}: ${value.message}`
  return inspect(value, {
    depth: 5,
    maxArrayLength: 80,
    maxStringLength: ENTRY_MESSAGE_LIMIT,
    breakLength: 160,
    compact: true
  })
}

function safeEntry(value: unknown): DiagnosticLogEntry | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Record<string, unknown>
  if (
    typeof raw.id !== 'number' ||
    !Number.isSafeInteger(raw.id) ||
    typeof raw.occurredAt !== 'number' ||
    !Number.isFinite(raw.occurredAt) ||
    (raw.level !== 'debug' &&
      raw.level !== 'info' &&
      raw.level !== 'warn' &&
      raw.level !== 'error') ||
    typeof raw.source !== 'string' ||
    typeof raw.message !== 'string'
  ) {
    return null
  }
  return {
    id: raw.id,
    occurredAt: raw.occurredAt,
    level: raw.level,
    source: raw.source.slice(0, 80),
    message: redact(raw.message).slice(0, ENTRY_MESSAGE_LIMIT)
  }
}

/**
 * Local-only bounded diagnostics used by the Settings log panel.
 * Console output is retained, but terminal/remote payload bodies are never
 * sampled here. Pairing credentials and common secret fields are redacted.
 */
export class DiagnosticLog {
  private readonly archivePath: string
  private readonly entries: DiagnosticLogEntry[] = []
  private readonly listeners = new Set<(change: DiagnosticLogChange) => void>()
  private nextId = 1
  private droppedEntries = 0
  private fileBytes = 0
  private consoleInstalled = false
  private readonly capturedWebContents = new WeakSet<WebContents>()

  constructor(private readonly logPath: string) {
    this.archivePath = `${logPath}.1`
    this.load()
  }

  installConsoleCapture(): void {
    if (this.consoleInstalled) return
    this.consoleInstalled = true
    const levels: Record<ConsoleMethod, DiagnosticLogLevel> = {
      debug: 'debug',
      info: 'info',
      log: 'info',
      warn: 'warn',
      error: 'error'
    }
    for (const method of Object.keys(levels) as ConsoleMethod[]) {
      const original = console[method].bind(console)
      console[method] = (...values: unknown[]): void => {
        original(...values)
        this.append(levels[method], 'main', ...values)
      }
    }
  }

  captureWebContents(contents: WebContents): void {
    if (this.capturedWebContents.has(contents)) return
    this.capturedWebContents.add(contents)
    const source = `renderer:${contents.getType()}#${contents.id}`
    contents.on('console-message', (details) => {
      const level = details.level === 'warning' ? 'warn' : details.level
      const location = details.lineNumber > 0 ? ` (line ${details.lineNumber})` : ''
      this.append(level, source, `${details.message}${location}`)
    })
    contents.on('render-process-gone', (_event, details) => {
      this.append(
        'error',
        source,
        `render process gone: ${details.reason} (exit ${details.exitCode})`
      )
    })
    contents.on(
      'did-fail-load',
      (_event, errorCode, errorDescription, _validatedUrl, isMainFrame) => {
        if (!isMainFrame || errorCode === -3) return
        this.append(
          'error',
          source,
          `page load failed: ${errorDescription} (${errorCode})`
        )
      }
    )
    contents.on('preload-error', (_event, _preloadPath, error) => {
      this.append('error', source, 'preload failed', error)
    })
  }

  append(
    level: DiagnosticLogLevel,
    source: string,
    ...values: unknown[]
  ): DiagnosticLogEntry {
    const message = redact(values.map(formatValue).join(' ')).slice(
      0,
      ENTRY_MESSAGE_LIMIT
    )
    const entry: DiagnosticLogEntry = {
      id: this.nextId++,
      occurredAt: Date.now(),
      level,
      source: redact(source).slice(0, 80),
      message
    }
    this.entries.push(entry)
    if (this.entries.length > ENTRY_CAPACITY) {
      this.entries.splice(0, this.entries.length - ENTRY_CAPACITY)
      this.droppedEntries += 1
    }
    this.persist(entry)
    this.publish({ kind: 'append', entry: { ...entry }, droppedEntries: this.droppedEntries })
    return entry
  }

  snapshot(): DiagnosticLogSnapshot {
    return {
      entries: this.entries.map((entry) => ({ ...entry })),
      droppedEntries: this.droppedEntries,
      capacity: ENTRY_CAPACITY
    }
  }

  clear(): void {
    this.entries.length = 0
    this.droppedEntries = 0
    this.fileBytes = 0
    for (const path of [this.logPath, this.archivePath]) {
      try {
        rmSync(path, { force: true })
      } catch {
        // A locked diagnostics file must not break Settings.
      }
    }
    this.publish({ kind: 'clear' })
  }

  onChanged(listener: (change: DiagnosticLogChange) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private load(): void {
    try {
      mkdirSync(dirname(this.logPath), { recursive: true })
    } catch {
      return
    }
    for (const path of [this.archivePath, this.logPath]) {
      if (!existsSync(path)) continue
      try {
        for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
          if (!line) continue
          try {
            const entry = safeEntry(JSON.parse(line))
            if (entry) this.entries.push(entry)
          } catch {
            // Ignore a partial final line left by an interrupted append.
          }
        }
      } catch {
        // Diagnostics are best effort and may be unavailable on a locked volume.
      }
    }
    if (this.entries.length > ENTRY_CAPACITY) {
      const removed = this.entries.length - ENTRY_CAPACITY
      this.entries.splice(0, removed)
      this.droppedEntries += removed
    }
    this.nextId = Math.max(0, ...this.entries.map((entry) => entry.id)) + 1
    try {
      this.fileBytes = statSync(this.logPath).size
    } catch {
      this.fileBytes = 0
    }
  }

  private persist(entry: DiagnosticLogEntry): void {
    const line = `${JSON.stringify(entry)}\n`
    try {
      if (this.fileBytes + Buffer.byteLength(line) > FILE_SIZE_LIMIT) {
        rmSync(this.archivePath, { force: true })
        if (existsSync(this.logPath)) renameSync(this.logPath, this.archivePath)
        this.fileBytes = 0
      }
      appendFileSync(this.logPath, line, 'utf8')
      this.fileBytes += Buffer.byteLength(line)
    } catch {
      // Logging must never take down the application.
    }
  }

  private publish(change: DiagnosticLogChange): void {
    for (const listener of this.listeners) {
      try {
        listener(change)
      } catch {
        // A diagnostics observer must not affect the application.
      }
    }
  }
}
