export const WorkspaceReaderInvokeChannel = {
  Describe: 'workspace-reader:describe',
  List: 'workspace-reader:list',
  Read: 'workspace-reader:read'
} as const

export const WorkspaceReaderEventChannel = {
  Changed: 'workspace-reader:changed'
} as const

export type WorkspaceEntryKind = 'directory' | 'file' | 'symlink'

export interface WorkspaceDescription {
  terminalId: string
  label: string
  name: string
  runtime: 'windows' | 'macos' | 'linux' | 'wsl'
}

export interface WorkspaceEntry {
  name: string
  path: string
  kind: WorkspaceEntryKind
}

export interface WorkspaceTextFile {
  path: string
  text: string
  byteLength: number
  size: number
  languageHint?: string
  eol: 'lf' | 'crlf' | 'mixed' | 'none'
  truncated: false
}

export interface WorkspacePathRequest {
  terminalId: string
  path: string
}

export interface WorkspaceChange {
  terminalId: string
  /** Relative path when the platform watcher provides one; null means rescan. */
  path: string | null
}

export interface WorkspaceReaderApi {
  describe(terminalId: string): Promise<WorkspaceDescription | null>
  list(input: WorkspacePathRequest): Promise<WorkspaceEntry[]>
  read(input: WorkspacePathRequest): Promise<WorkspaceTextFile>
  onChanged(callback: (change: WorkspaceChange) => void): () => void
}
