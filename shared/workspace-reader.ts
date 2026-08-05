export const WorkspaceReaderInvokeChannel = {
  Describe: 'workspace-reader:describe',
  List: 'workspace-reader:list',
  Read: 'workspace-reader:read'
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

export interface WorkspaceReaderApi {
  describe(terminalId: string): Promise<WorkspaceDescription | null>
  list(input: WorkspacePathRequest): Promise<WorkspaceEntry[]>
  read(input: WorkspacePathRequest): Promise<WorkspaceTextFile>
}
