export type DiagnosticLogLevel = 'debug' | 'info' | 'warn' | 'error'

export interface DiagnosticLogEntry {
  id: number
  occurredAt: number
  level: DiagnosticLogLevel
  source: string
  message: string
}

export interface DiagnosticLogSnapshot {
  entries: DiagnosticLogEntry[]
  droppedEntries: number
  capacity: number
}

export type DiagnosticLogChange =
  | { kind: 'append'; entry: DiagnosticLogEntry; droppedEntries: number }
  | { kind: 'clear' }

export const DiagnosticLogInvokeChannel = {
  GetSnapshot: 'diagnostic-log:get-snapshot',
  Clear: 'diagnostic-log:clear'
} as const

export const DiagnosticLogEventChannel = {
  Changed: 'diagnostic-log:changed'
} as const

export interface DiagnosticLogApi {
  getSnapshot: () => Promise<DiagnosticLogSnapshot>
  clear: () => Promise<void>
  onChanged: (cb: (change: DiagnosticLogChange) => void) => () => void
}
